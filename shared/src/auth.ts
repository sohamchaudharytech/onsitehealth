import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export type Role = 'admin' | 'operator' | 'auditor' | 'viewer';

export interface JwtPayload {
  userId: string;
  username: string;
  role: Role;
  iat: number;
  exp: number;
}

// ── JWT (HS256), implemented on node:crypto — no external dependency ──────────

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** Sign a short-lived access token: { userId, username, role } + exp. */
export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSec: number,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body: JwtPayload = { ...payload, iat: now, exp: now + ttlSec };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}

/** Verify signature + expiry. Returns null on any failure. */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: JwtPayload;
  try {
    payload = JSON.parse(fromB64url(p).toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

/**
 * UNVERIFIED decode — attribution only, never authorization. Used by the
 * rate limiter to key requests to an identity before auth runs (§7.7 order
 * keeps the limiter ahead of JWT auth; the identity layer still works).
 */
export function decodeJwtUnverified(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(fromB64url(parts[1]).toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }
}

// ── Password hashing (scrypt KDF) ─────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const test = scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(test);
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Refresh tokens (opaque, stored hashed server-side, rotated on use) ──────

export function newOpaqueToken(): string {
  return randomBytes(48).toString('hex');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
