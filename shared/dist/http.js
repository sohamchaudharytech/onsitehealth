import { randomUUID } from 'node:crypto';
import { sha256Hex, verifyJwt } from './auth.js';
/** Request-id + structured logging with correlation (PRD §7.7). */
export function requestLogger() {
    return (req, res, next) => {
        req.requestId = randomUUID();
        const start = Date.now();
        res.setHeader('X-Request-Id', req.requestId);
        res.on('finish', () => {
            const line = `[${req.requestId}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms ip=${req.ip}`;
            if (res.statusCode >= 500)
                console.error(line);
            else if (res.statusCode >= 400)
                console.warn(line);
            else
                console.log(line);
        });
        next();
    };
}
/**
 * JWT auth middleware. Sets req.user on success; 401 on missing/invalid
 * token. Routes that need it apply it explicitly (public routes like
 * /healthz and /api/auth/login skip it).
 */
export function jwtAuth(secret) {
    return (req, res, next) => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
            res.status(401).json({ error: 'missing bearer token' });
            return;
        }
        const payload = verifyJwt(header.slice(7), secret);
        if (!payload) {
            res.status(401).json({ error: 'invalid or expired token' });
            return;
        }
        req.user = payload;
        next();
    };
}
/**
 * Guard for service-to-service /internal routes. The internal key is a
 * shared secret provisioned to site agents and the coordinator — NOT a
 * substitute for JWT, which governs all human/dashboard traffic.
 */
export function internalKeyGuard(internalKey) {
    return (req, res, next) => {
        const provided = req.headers['x-internal-key'];
        if (typeof provided !== 'string' || sha256Hex(provided) !== sha256Hex(internalKey)) {
            res.status(401).json({ error: 'invalid internal key' });
            return;
        }
        next();
    };
}
/** Centralized error handler — never leaks stack traces to the client. */
export function errorHandler(serviceName) {
    return (err, _req, res, _next) => {
        console.error(`[${serviceName}] unhandled error:`, err.message);
        res.status(500).json({ error: 'internal error' });
    };
}
//# sourceMappingURL=http.js.map