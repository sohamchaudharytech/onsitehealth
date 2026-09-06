import type { NextFunction, Request, Response } from 'express';
import { type RateLimitRule } from './ratelimit.js';
export declare class RedisSlidingWindowLimiter {
    private redis;
    private fallback;
    /** Fallback stays permanent once Redis has failed N times in a row. */
    private consecutiveFailures;
    private redisDown;
    /** offense counts for escalating windows (mirrors in-memory behavior) */
    private offenses;
    private rules;
    constructor(rules?: RateLimitRule[], opts?: {
        host?: string;
        port?: number;
    });
    /** Longest prefix match, identical to the in-memory limiter. */
    private ruleFor;
    private escalatedWindow;
    private redisCheck;
    private noteFailure;
    private noteSuccess;
    middleware(): (req: Request, res: Response, next: NextFunction) => void;
}
//# sourceMappingURL=redislimit.d.ts.map