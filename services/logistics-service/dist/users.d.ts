import { type Role } from '@hc/shared';
export interface UserRecord {
    userId: string;
    username: string;
    passwordHash: string;
    role: Role;
    fullName?: string;
}
export interface RefreshRecord {
    userId: string;
    tokenHash: string;
    issuedAt: number;
    revoked: boolean;
}
/**
 * In-memory user + refresh-token store for the logistics service. Mirrors
 * the clinical central service's UserStore: refresh tokens stored HASHED,
 * rotated on every use, reuse of a rotated token revokes the family
 * (theft detection).
 */
export declare class UserStore {
    private users;
    private byUsername;
    private refreshTokens;
    snapshot(): {
        users: UserRecord[];
        refreshTokens: RefreshRecord[];
    };
    restore(snapshot: ReturnType<UserStore['snapshot']>): void;
    constructor(seed: Array<{
        userId: string;
        username: string;
        password: string;
        role: Role;
        fullName?: string;
    }>);
    authenticate(username: string, password: string): UserRecord | null;
    get(userId: string): UserRecord | null;
    issueRefreshToken(userId: string): string;
    /**
     * Rotate: consume a refresh token, mint the next in its family. Reuse of
     * an already-rotated token = theft signal → revoke the whole family.
     */
    rotateRefreshToken(token: string): {
        userId: string;
        newToken: string;
    } | null;
    revokeRefreshToken(token: string): boolean;
    revokeAllForUser(userId: string): void;
}
//# sourceMappingURL=users.d.ts.map