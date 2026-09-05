/**
 * Minimal fetch wrapper with timeout — used for service-to-service HTTP.
 */
export declare function fetchJson<T>(url: string, init?: RequestInit & {
    timeoutMs?: number;
}): Promise<T>;
export declare function postJson<T>(url: string, body: unknown, timeoutMs?: number): Promise<T>;
export declare function getJson<T>(url: string, timeoutMs?: number): Promise<T>;
//# sourceMappingURL=net.d.ts.map