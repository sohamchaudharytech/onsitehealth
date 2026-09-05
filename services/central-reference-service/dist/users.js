import { hashPassword, newOpaqueToken, sha256Hex, verifyPassword } from '@hc/shared';
/**
 * In-memory user + refresh-token store (Phase 7 scope; MongoDB persistence
 * is a later phase). Refresh tokens are stored HASHED server-side and
 * ROTATED on each use — a presented token is single-use; presenting a
 * rotated-out token revokes the whole family (theft detection).
 */
export class UserStore {
    users = new Map();
    byUsername = new Map();
    refreshTokens = new Map(); // key = tokenHash
    constructor(seed) {
        for (const u of seed) {
            const rec = { userId: u.userId, username: u.username, passwordHash: hashPassword(u.password), role: u.role };
            this.users.set(u.userId, rec);
            this.byUsername.set(u.username, u.userId);
        }
    }
    authenticate(username, password) {
        const userId = this.byUsername.get(username);
        if (!userId)
            return null;
        const user = this.users.get(userId);
        if (!verifyPassword(password, user.passwordHash))
            return null;
        return user;
    }
    get(userId) {
        return this.users.get(userId) ?? null;
    }
    list() {
        return [...this.users.values()].map(({ userId, username, role }) => ({ userId, username, role }));
    }
    create(username, password, role) {
        const userId = `user-${newOpaqueToken().slice(0, 12)}`;
        const rec = { userId, username, passwordHash: hashPassword(password), role };
        this.users.set(userId, rec);
        this.byUsername.set(username, userId);
        return rec;
    }
    // ── Refresh tokens ────────────────────────────────────────────────────────
    issueRefreshToken(userId) {
        const token = newOpaqueToken();
        this.refreshTokens.set(sha256Hex(token), {
            userId,
            tokenHash: sha256Hex(token),
            issuedAt: Date.now(),
            revoked: false,
        });
        return token;
    }
    /**
     * Rotate: consume a refresh token, return the userId it belongs to.
     * Returns null if unknown, already used (rotation → possible theft:
     * revoke family), or explicitly revoked.
     */
    rotateRefreshToken(token) {
        const hash = sha256Hex(token);
        const rec = this.refreshTokens.get(hash);
        if (!rec)
            return null;
        if (rec.revoked) {
            // Token reuse after rotation = theft signal → revoke everything for this user
            this.revokeAllForUser(rec.userId);
            return null;
        }
        rec.revoked = true;
        const newToken = this.issueRefreshToken(rec.userId);
        return { userId: rec.userId, newToken };
    }
    revokeAllForUser(userId) {
        for (const rec of this.refreshTokens.values()) {
            if (rec.userId === userId)
                rec.revoked = true;
        }
    }
    /** Housekeeping: drop refresh records older than the max age. */
    prune(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
        const cutoff = Date.now() - maxAgeMs;
        for (const [hash, rec] of this.refreshTokens) {
            if (rec.issuedAt < cutoff)
                this.refreshTokens.delete(hash);
        }
    }
}
//# sourceMappingURL=users.js.map