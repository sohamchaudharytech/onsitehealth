import type { NextFunction, Request, Response } from 'express';
/**
 * Recursively remove NoSQL/operator-injection keys (any key starting with
 * `$` or containing `.`), trim strings, and length-cap them. MongoDB is not
 * vulnerable to SQL injection — it is vulnerable to operator injection like
 * {"password": {"$ne": null}} — this neutralizes that class (PRD §7.6).
 */
export declare function sanitizeDeep(value: unknown, path?: string, removed?: string[]): {
    value: unknown;
    removed: string[];
};
/** Express middleware: sanitize req.body in place, log what was stripped. */
export declare function sanitizeBody(req: Request, _res: Response, next: NextFunction): void;
//# sourceMappingURL=sanitize.d.ts.map