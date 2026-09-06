import type { NextFunction, Request, Response } from 'express';
import { decodeJwtUnverified } from './auth.js';
import { MiniRedis } from './redis.js';
import { SlidingWindowLimiter, defaultRateLimitRules, type RateLimitDecision, type RateLimitRule } from './ratelimit.js';

/**
 * Redis-backed sliding-window rate limiter (multi-instance scope).
 *
 * The in-memory SlidingWindowLimiter (ratelimit.ts) is per-process — N
 * service instances each allowed their own full limit. This implementation
 * moves the SAME algorithm to Redis so every instance counts against ONE
 * shared window:
 *
 *   - one sorted set per key:  member = request timestamp (µs),
 *     scored by timestamp → ZREMRANGEBYSCORE trims the sliding window,
 *     ZCARD counts it — the classic Redis rate-limit pattern.
 *   - the whole check+trim+insert runs in ONE Lua script: atomic, so two
 *     instances hammering simultaneously cannot both squeeze past the limit.
 *   - repeat-offender escalation + a small TTL cache mirror the in-memory
 *     limiter's behavior.
 *
 * Degrade gracefully: if Redis is unreachable, every check transparently
 * falls back to the local in-memory limiter (single-process scope) — the
 * service keeps working, we just lose cross-instance sharing.
 */

/** One key per (subject × route-prefix), sliding window in Redis ZSETs. */
const CHECK_AND_HIT_LUA = `
local key        = KEYS[1]
local now_us     = tonumber(ARGV[1])
local window_us  = tonumber(ARGV[2])
local limit      = tonumber(ARGV[3])

-- trim everything older than the sliding window start
redis.call('ZREMRANGEBYSCORE', key, '-inf', now_us - window_us)
local count = redis.call('ZCARD', key)

if count >= limit then
  -- window full: rate limited. Compute retry-after from the oldest member.
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after_s = 1
  if oldest[2] then
    retry_after_s = math.ceil((tonumber(oldest[2]) + window_us - now_us) / 1000000)
    if retry_after_s < 1 then retry_after_s = 1 end
  end
  return {0, count, retry_after_s}
end

-- allowed: record this hit, expire the key after the window
redis.call('ZADD', key, now_us, now_us .. '-' .. math.random(1000000))
redis.call('PEXPIRE', key, math.ceil(window_us / 1000) + 1000)
return {1, count + 1, 0}
`;

/** Read-only check used to size the retry window without consuming budget. */
const PEEK_LUA = `
local key       = KEYS[1]
local now_us    = tonumber(ARGV[1])
local window_us = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now_us - window_us)
local count = redis.call('ZCARD', key)
if count == 0 then return {1, 0, 0} end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry_after_s = 1
if oldest[2] then
  retry_after_s = math.ceil((tonumber(oldest[2]) + window_us - now_us) / 1000000)
  if retry_after_s < 1 then retry_after_s = 1 end
end
return {0, count, retry_after_s}
`;

export class RedisSlidingWindowLimiter {
  private redis: MiniRedis;
  private fallback = new SlidingWindowLimiter(defaultRateLimitRules());
  /** Fallback stays permanent once Redis has failed N times in a row. */
  private consecutiveFailures = 0;
  private redisDown = false;
  /** offense counts for escalating windows (mirrors in-memory behavior) */
  private offenses = new Map<string, number>();
  private rules: RateLimitRule[];

  constructor(rules: RateLimitRule[] = defaultRateLimitRules(), opts: { host?: string; port?: number } = {}) {
    this.rules = rules;
    this.redis = new MiniRedis(opts);
  }

  /** Longest prefix match, identical to the in-memory limiter. */
  private ruleFor(path: string): RateLimitRule | null {
    let best: RateLimitRule | null = null;
    for (const r of this.rules) {
      if (path.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
    }
    return best;
  }

  private escalatedWindow(key: string, baseWindowMs: number): number {
    const n = this.offenses.get(key) ?? 0;
    return baseWindowMs * Math.min(8, 2 ** n);
  }

  private async redisCheck(key: string, windowMs: number, limit: number, hit: boolean): Promise<RateLimitDecision | null> {
    try {
      const nowUs = Date.now() * 1000;
      const windowUs = Math.round(windowMs * 1000);
      const res = await this.redis.eval(
        hit ? CHECK_AND_HIT_LUA : PEEK_LUA,
        [`rl:${key}`],
        [nowUs, windowUs, limit],
      );
      // Lua {0|1, count, retryAfter} comes back as a single bulk string
      // in our minimal client (RESP2 array reply) — parse defensively.
      if (res === null) return null;
      const parts = String(res).split(',');
      const allowed = Number(parts[0]) === 1;
      const retryAfterSec = Number(parts[2] ?? 0);
      return {
        allowed,
        remaining: Math.max(0, limit - Number(parts[1] ?? limit)),
        retryAfterSec: allowed ? 0 : Math.max(1, retryAfterSec),
      };
    } catch {
      this.noteFailure();
      return null;
    }
  }

  private noteFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3) {
      if (!this.redisDown) {
        console.warn('[rate-limit] redis unreachable 3× — degrading to in-memory limiter (single-process scope)');
        this.redisDown = true;
      }
      this.redis.quit();
    }
  }

  private noteSuccess(): void {
    this.consecutiveFailures = 0;
    this.redisDown = false;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const rule = this.ruleFor(req.path);
      if (!rule) {
        next();
        return;
      }

      const ip = req.ip ?? 'unknown';
      const auth = req.headers.authorization;
      const identity =
        auth?.startsWith('Bearer ')
          ? decodeJwtUnverified(auth.slice(7))?.userId ?? null
          : null;

      // degraded path → local limiter entirely
      if (this.redisDown) {
        this.fallback.middleware()(req, res, next);
        return;
      }

      // Layer 1: per (IP, route). Blocking decision may use the escalated window.
      const ipKey = `ip:${ip}:${rule.prefix}`;
      void this.redisCheck(ipKey, rule.windowMs, rule.limit, true).then((d) => {
        if (d === null) {
          // Redis hiccup on THIS request → in-memory fallback for it
          this.fallback.middleware()(req, res, next);
          return;
        }
        this.noteSuccess();
        if (!d.allowed) {
          // escalated window for repeat offenders (tracked locally)
          const windowMs = this.escalatedWindow(ipKey, rule.windowMs);
          this.offenses.set(ipKey, (this.offenses.get(ipKey) ?? 0) + 1);
          res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
          res.status(429).json({
            error: 'rate limit exceeded (per-IP)',
            retryAfterSec: Math.ceil(windowMs / 1000),
          });
          return;
        }
        // Layer 2: per (identity, route) — catches rotating-IP abuse.
        if (identity) {
          const idKey = `id:${identity}:${rule.prefix}`;
          void this.redisCheck(idKey, rule.windowMs, rule.limit, true).then((d2) => {
            if (d2 === null || d2.allowed) {
              next();
              return;
            }
            const windowMs = this.escalatedWindow(idKey, rule.windowMs);
            this.offenses.set(idKey, (this.offenses.get(idKey) ?? 0) + 1);
            res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
            res.status(429).json({
              error: 'rate limit exceeded (per-identity)',
              retryAfterSec: Math.ceil(windowMs / 1000),
            });
          });
          return;
        }
        res.setHeader('X-RateLimit-Remaining', String(d.remaining));
        next();
      });
    };
  }
}
