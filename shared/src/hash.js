import { createHash } from 'node:crypto';
/** Canonical JSON so hash computation is deterministic across services. */
export function canonicalJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    const obj = value;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
export function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
export function contentHashOf(payload) {
    return sha256(canonicalJson(payload));
}
//# sourceMappingURL=hash.js.map