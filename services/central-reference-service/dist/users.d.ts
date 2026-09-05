import { type Role } from '@hc/shared';
export interface UserRecord {
    userId: string;
    username: string;
    passwordHash: string;
    role: Role;
    /** doctors only: hospital this doctor is affiliated with */
    hospitalId?: string;
    /** doctors only: display name */
    fullName?: string;
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
        hospitalId?: string;
        fullName?: string;
    }>);
    authenticate(username: string, password: string): UserRecord | null;
    get(userId: string): UserRecord | null;
    list(): Array<{
        userId: string;
        username: string;
        role: Role;
        hospitalId?: string;
        fullName?: string;
    }>;
    /** Doctors only — with resolved hospital names for display. */
    listDoctors(): Array<{
        userId: string;
        username: string;
        hospitalId?: string;
        fullName?: string;
    }>;
    /** Delete a user (admin only). Returns the removed record, or null if absent. */
    deleteUser(userId: string): {
        userId: string;
        username: string;
        role: Role;
    } | null;
    /** True if any doctor is affiliated with the given hospital. */
    hasDoctorAtHospital(hospitalId: string): boolean;
    create(username: string, password: string, role: Role, hospitalId?: string, fullName?: string): UserRecord;
    /** Unique-username check (UserStore.create is otherwise silent on collision). */
    usernameTaken(username: string): boolean;
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