import type { NextFunction, Request, Response } from 'express';

const MAX_STRING_LEN = 10_000;

/**
 * Recursively remove NoSQL/operator-injection keys (any key starting with
 * `$` or containing `.`), trim strings, and length-cap them. MongoDB is not
 * vulnerable to SQL injection — it is vulnerable to operator injection like
 * {"password": {"$ne": null}} — this neutralizes that class (PRD §7.6).
 */
export function sanitizeDeep(
  value: unknown,
  path = '',
  removed: string[] = [],
): { value: unknown; removed: string[] } {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return { value: trimmed.length > MAX_STRING_LEN ? trimmed.slice(0, MAX_STRING_LEN) : trimmed, removed };
  }
  if (Array.isArray(value)) {
    const out = value.map((v, i) => sanitizeDeep(v, path ? `${path}[${i}]` : `[${i}]`, removed).value);
    return { value: out, removed };
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyPath = path ? `${path}.${k}` : k;
      if (k.startsWith('$') || k.includes('.')) {
        removed.push(keyPath);
        continue;
      }
      out[k] = sanitizeDeep(v, keyPath, removed).value;
    }
    return { value: out, removed };
  }
  return { value, removed };
}

/** Express middleware: sanitize req.body in place, log what was stripped. */
export function sanitizeBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.body !== null && typeof req.body === 'object') {
    const { value, removed } = sanitizeDeep(req.body);
    if (removed.length > 0) {
      console.warn(
        `[sanitize] stripped operator-injection keys from ${req.method} ${req.path}: ${removed.join(', ')}`,
      );
    }
    req.body = value;
  }
  next();
}
