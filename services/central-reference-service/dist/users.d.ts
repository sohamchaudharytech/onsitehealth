import { type Role } from '@hc/shared';
export interface UserRecord {
    userId: string;
    username: string;
    passwordHash: string;
    role: Role;
}
export interface RefreshRecord {
    userId: string;
    tokenHash: string;
    issuedAt: number;
    revoked: boolean;
}
/**
 * In-memory user + refresh-token store (Phase 7 scope; MongoDB persistence
 * is a later phase). Refresh tokens are stored HASHED server-side and
 * ROTATED on each use — a presented token is single-use; presenting a
 * rotated-out token revokes the whole family (theft detection).
 */
export declare class UserStore {
    private users;
    private byUsername;
    private refreshTokens;
    constructor(seed: Array<{
        userId: string;
        username: string;
        password: string;
        role: Role;
    }>);
    authenticate(username: string, password: string): UserRecord | null;
    get(userId: string): UserRecord | null;
    list(): Array<{
        userId: string;
        username: string;
        role: Role;
    }>;
    create(username: string, password: string, role: Role): UserRecord;
    issueRefreshToken(userId: string): string;
    /**
     * Rotate: consume a refresh token, return the userId it belongs to.
     * Returns null if unknown, already used (rotation → possible theft:
     * revoke family), or explicitly revoked.
     */
    rotateRefreshToken(token: string): {
        userId: string;
        newToken: string;
    } | null;
    revokeAllForUser(userId: string): void;
    /** Housekeeping: drop refresh records older than the max age. */
    prune(maxAgeMs?: number): void;
}
//# sourceMappingURL=users.d.ts.map