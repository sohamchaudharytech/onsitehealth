import type { NextFunction, Request, Response } from 'express';
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
export declare class SlidingWindowLimiter {
    private rules;
    private counters;
    private offenses;
    constructor(rules: RateLimitRule[]);
    private ruleFor;
    private hit;
    private check;
    /** Escalating penalty for repeat offenders: window grows with offense count. */
    private escalatedWindow;
    recordOffense(key: string): void;
    clearOffenses(key: string): void;
    /**
     * Express middleware factory. Applies both IP and identity layers.
     * Identity is derived from the JWT (unverified decode — attribution only;
     * authorization still happens later in the pipeline).
     */
    middleware(): (req: Request, res: Response, next: NextFunction) => void;
}
/** Default rules: tight on auth, looser elsewhere (PRD §7.8). */
export declare function defaultRateLimitRules(): RateLimitRule[];
//# sourceMappingURL=ratelimit.d.ts.map