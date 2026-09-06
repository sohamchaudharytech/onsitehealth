import { hashPassword, newOpaqueToken, sha256Hex, verifyPassword } from '@hc/shared';
/**
 * In-memory user + refresh-token store for the logistics service. Mirrors
 * the clinical central service's UserStore: refresh tokens stored HASHED,
 * rotated on every use, reuse of a rotated token revokes the family
 * (theft detection).
 */
export class UserStore {
    users = new Map();
    byUsername = new Map();
    refreshTokens = new Map(); // key = tokenHash
    constructor(seed) {
        for (const u of seed) {
            const rec = {
                userId: u.userId,
                username: u.username,
                passwordHash: hashPassword(u.password),
                role: u.role,
                ...(u.fullName ? { fullName: u.fullName } : {}),
            };
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
     * Rotate: consume a refresh token, mint the next in its family. Reuse of
     * an already-rotated token = theft signal → revoke the whole family.
     */
    rotateRefreshToken(token) {
        const hash = sha256Hex(token);
        const rec = this.refreshTokens.get(hash);
        if (!rec)
            return null;
        if (rec.revoked) {
            this.revokeAllForUser(rec.userId);
            return null;
        }
        rec.revoked = true; // single-use
        const newToken = newOpaqueToken();
        this.refreshTokens.set(sha256Hex(newToken), {
            userId: rec.userId,
            tokenHash: sha256Hex(newToken),
            issuedAt: Date.now(),
            revoked: false,
        });
        return { userId: rec.userId, newToken };
    }
    revokeRefreshToken(token) {
        const hash = sha256Hex(token);
        const rec = this.refreshTokens.get(hash);
        if (!rec)
            return false;
        rec.revoked = true;
        return true;
    }
    revokeAllForUser(userId) {
        for (const rec of this.refreshTokens.values()) {
            if (rec.userId === userId)
                rec.revoked = true;
        }
    }
}
//# sourceMappingURL=users.js.map