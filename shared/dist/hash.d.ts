/** Canonical JSON so hash computation is deterministic across services. */
export declare function canonicalJson(value: unknown): string;
export declare function sha256(input: string): string;
export declare function contentHashOf(payload: Record<string, unknown>): string;
//# sourceMappingURL=hash.d.ts.map