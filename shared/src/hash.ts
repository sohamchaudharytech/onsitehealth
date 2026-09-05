import { createHash } from 'node:crypto';

/** Canonical JSON so hash computation is deterministic across services. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function contentHashOf(payload: Record<string, unknown>): string {
  return sha256(canonicalJson(payload));
}
