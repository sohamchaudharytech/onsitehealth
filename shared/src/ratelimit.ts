import type { NextFunction, Request, Response } from 'express';
import { decodeJwtUnverified } from './auth.js';

export interface RateLimitRule {
  /** route prefix this rule applies to, e.g. '/api/auth' */
  prefix: string;
  /** max requests per window per key */
  limit: number;
  /** sliding window in ms */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Redis-style sliding-window counter, in-memory (single-process scope —
 * honest caveat: a multi-instance deployment would back this with the
 * shared Redis; the algorithm is identical).
 *
 * Two layers (PRD §7.8):
 *   1. per (IP, route-prefix) — catches volumetric abuse from one source
 *   2. per (identity, route-prefix) — catches a rotating-IP client that
 *      still uses the same account, which per-IP limits alone would miss.
 */
export class SlidingWindowLimiter {
  private counters = new Map<string, number[]>();
  private offenses = new Map<string, number>(); // escalating repeat-offender tracking

  constructor(private rules: RateLimitRule[]) {}

  private ruleFor(path: string): RateLimitRule | null {
    // longest prefix wins (most specific rule)
    let best: RateLimitRule | null = null;
    for (const r of this.rules) {
      if (path.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
    }
    return best;
  }

  private hit(key: string, windowMs: number): number[] {
    const now = Date.now();
    const arr = (this.counters.get(key) ?? []).filter((t) => now - t < windowMs);
    arr.push(now);
    this.counters.set(key, arr);
    return arr;
  }

  private check(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = Date.now();
    const arr = (this.counters.get(key) ?? []).filter((t) => now - t < rule.windowMs);
    if (arr.length >= rule.limit) {
      const oldest = arr[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    return { allowed: true, remaining: rule.limit - arr.length - 1, retryAfterSec: 0 };
  }

  /** Escalating penalty for repeat offenders: window grows with offense count. */
  private escalatedWindow(key: string, baseWindowMs: number): number {
    const offenses = this.offenses.get(key) ?? 0;
    return baseWindowMs * Math.min(8, 2 ** offenses);
  }

  recordOffense(key: string): void {
    this.offenses.set(key, (this.offenses.get(key) ?? 0) + 1);
  }

  clearOffenses(key: string): void {
    this.offenses.delete(key);
  }

  /**
   * Express middleware factory. Applies both IP and identity layers.
   * Identity is derived from the JWT (unverified decode — attribution only;
   * authorization still happens later in the pipeline).
   */
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

      // Layer 1: per (IP, route)
      const ipKey = `ip:${ip}:${rule.prefix}`;
      const ipDecision = this.check(ipKey, rule);
      if (!ipDecision.allowed) {
        const windowMs = this.escalatedWindow(ipKey, rule.windowMs);
        this.recordOffense(ipKey);
        res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
        res.status(429).json({
          error: 'rate limit exceeded (per-IP)',
          retryAfterSec: Math.ceil(windowMs / 1000),
        });
        return;
      }

      // Layer 2: per (identity, route) — catches rotating-IP abuse
      if (identity) {
        const idKey = `id:${identity}:${rule.prefix}`;
        const idDecision = this.check(idKey, rule);
        if (!idDecision.allowed) {
          const windowMs = this.escalatedWindow(idKey, rule.windowMs);
          this.recordOffense(idKey);
          res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
          res.status(429).json({
            error: 'rate limit exceeded (per-identity)',
            retryAfterSec: Math.ceil(windowMs / 1000),
          });
          return;
        }
        this.hit(idKey, rule.windowMs);
      }

      this.hit(ipKey, rule.windowMs);
      res.setHeader('X-RateLimit-Remaining', String(ipDecision.remaining));
      next();
    };
  }
}

/** Default rules: tight on auth, looser elsewhere (PRD §7.8). */
export function defaultRateLimitRules(): RateLimitRule[] {
  return [
    { prefix: '/api/auth/login', limit: 10, windowMs: 60_000 },
    { prefix: '/api/auth', limit: 30, windowMs: 60_000 },
    { prefix: '/api', limit: 240, windowMs: 60_000 },
  ];
}
