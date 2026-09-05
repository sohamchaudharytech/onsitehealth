import type { ErrorRequestHandler, RequestHandler } from 'express';
import { type JwtPayload } from './auth.js';
declare global {
    namespace Express {
        interface Request {
            requestId?: string;
            user?: JwtPayload;
        }
    }
}
/** Request-id + structured logging with correlation (PRD §7.7). */
export declare function requestLogger(): RequestHandler;
/**
 * JWT auth middleware. Sets req.user on success; 401 on missing/invalid
 * token. Routes that need it apply it explicitly (public routes like
 * /healthz and /api/auth/login skip it).
 */
export declare function jwtAuth(secret: string): RequestHandler;
/**
 * Guard for service-to-service /internal routes. The internal key is a
 * shared secret provisioned to site agents and the coordinator — NOT a
 * substitute for JWT, which governs all human/dashboard traffic.
 */
export declare function internalKeyGuard(internalKey: string): RequestHandler;
/** Centralized error handler — never leaks stack traces to the client. */
export declare function errorHandler(serviceName: string): ErrorRequestHandler;
//# sourceMappingURL=http.d.ts.map