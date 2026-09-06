import { hashPassword, newOpaqueToken, sha256Hex, verifyPassword, type Role } from '@hc/shared';

export interface UserRecord {
  userId: string;
  username: string;
  passwordHash: string;
  role: Role;
  /** doctors: affiliated hospital; nurses: assigned hospital */
  hospitalId?: string;
  /** doctors: display name; nurses: display name */
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
export class UserStore {
  private users = new Map<string, UserRecord>();
  private byUsername = new Map<string, string>();
  private refreshTokens = new Map<string, RefreshRecord>(); // key = tokenHash

  constructor(seed: Array<{ userId: string; username: string; password: string; role: Role; hospitalId?: string; fullName?: string }>) {
    for (const u of seed) {
      const rec: UserRecord = {
        userId: u.userId,
        username: u.username,
        passwordHash: hashPassword(u.password),
        role: u.role,
        ...(u.hospitalId ? { hospitalId: u.hospitalId } : {}),
        ...(u.fullName ? { fullName: u.fullName } : {}),
      };
      this.users.set(u.userId, rec);
      this.byUsername.set(u.username, u.userId);
    }
  }

  authenticate(username: string, password: string): UserRecord | null {
    const userId = this.byUsername.get(username);
    if (!userId) return null;
    const user = this.users.get(userId)!;
    if (!verifyPassword(password, user.passwordHash)) return null;
    return user;
  }

  get(userId: string): UserRecord | null {
    return this.users.get(userId) ?? null;
  }

  list(): Array<{ userId: string; username: string; role: Role; hospitalId?: string; fullName?: string }> {
    return [...this.users.values()].map(({ userId, username, role, hospitalId, fullName }) => ({ userId, username, role, hospitalId, fullName }));
  }

  /** Doctors only — with resolved hospital names for display. */
  listDoctors(): Array<{ userId: string; username: string; hospitalId?: string; fullName?: string }> {
    return this.list().filter((u) => u.role === 'doctor');
  }

  /** Delete a user (admin only). Returns the removed record, or null if absent. */
  deleteUser(userId: string): { userId: string; username: string; role: Role } | null {
    const rec = this.users.get(userId);
    if (!rec) return null;
    this.users.delete(userId);
    this.byUsername.delete(rec.username);
    this.revokeAllForUser(userId);
    return { userId: rec.userId, username: rec.username, role: rec.role };
  }

  /** True if any doctor is affiliated with the given hospital. */
  hasDoctorAtHospital(hospitalId: string): boolean {
    for (const u of this.users.values()) {
      if (u.role === 'doctor' && u.hospitalId === hospitalId) return true;
    }
    return false;
  }

  create(username: string, password: string, role: Role, hospitalId?: string, fullName?: string, userId?: string): UserRecord {
    const id = userId ?? `user-${newOpaqueToken().slice(0, 12)}`;
    const rec: UserRecord = {
      userId: id,
      username,
      passwordHash: hashPassword(password),
      role,
      ...(hospitalId ? { hospitalId } : {}),
      ...(fullName ? { fullName } : {}),
    };
    this.users.set(id, rec);
    this.byUsername.set(username, id);
    return rec;
  }

  /** Change login username (portal email). Old username is freed. */
  updateUsername(userId: string, newUsername: string): UserRecord | null {
    const rec = this.users.get(userId);
    if (!rec) return null;
    if (this.byUsername.has(newUsername) && this.byUsername.get(newUsername) !== userId) {
      throw new Error(`username '${newUsername}' already taken`);
    }
    this.byUsername.delete(rec.username);
    rec.username = newUsername;
    this.byUsername.set(newUsername, userId);
    return rec;
  }

  /** Change login password. */
  updatePassword(userId: string, newPassword: string): UserRecord | null {
    const rec = this.users.get(userId);
    if (!rec) return null;
    rec.passwordHash = hashPassword(newPassword);
    return rec;
  }

  /** Unique-username check (UserStore.create is otherwise silent on collision). */
  usernameTaken(username: string): boolean {
    return this.byUsername.has(username);
  }

  // ── Refresh tokens ────────────────────────────────────────────────────────

  issueRefreshToken(userId: string): string {
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
  rotateRefreshToken(token: string): { userId: string; newToken: string } | null {
    const hash = sha256Hex(token);
    const rec = this.refreshTokens.get(hash);
    if (!rec) return null;
    if (rec.revoked) {
      // Token reuse after rotation = theft signal → revoke everything for this user
      this.revokeAllForUser(rec.userId);
      return null;
    }
    rec.revoked = true;
    const newToken = this.issueRefreshToken(rec.userId);
    return { userId: rec.userId, newToken };
  }

  revokeAllForUser(userId: string): void {
    for (const rec of this.refreshTokens.values()) {
      if (rec.userId === userId) rec.revoked = true;
    }
  }

  /** Housekeeping: drop refresh records older than the max age. */
  prune(maxAgeMs = 30 * 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [hash, rec] of this.refreshTokens) {
      if (rec.issuedAt < cutoff) this.refreshTokens.delete(hash);
    }
  }
}
