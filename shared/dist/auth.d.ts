export type Role = 'admin' | 'operator' | 'auditor' | 'viewer' | 'doctor' | 'patient' | 'nurse';
export interface JwtPayload {
    userId: string;
    username: string;
    role: Role;
    iat: number;
    exp: number;
}
/** Sign a short-lived access token: { userId, username, role } + exp. */
export declare function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string, ttlSec: number): string;
/** Verify signature + expiry. Returns null on any failure. */
export declare function verifyJwt(token: string, secret: string): JwtPayload | null;
/**
 * UNVERIFIED decode — attribution only, never authorization. Used by the
 * rate limiter to key requests to an identity before auth runs (§7.7 order
 * keeps the limiter ahead of JWT auth; the identity layer still works).
 */
export declare function decodeJwtUnverified(token: string): JwtPayload | null;
export declare function hashPassword(password: string): string;
export declare function verifyPassword(password: string, stored: string): boolean;
export declare function newOpaqueToken(): string;
export declare function sha256Hex(input: string): string;
//# sourceMappingURL=auth.d.ts.map