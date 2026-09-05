/**
 * Minimal fetch wrapper with timeout — used for service-to-service HTTP.
 */
export async function fetchJson(url, init = {}) {
    const { timeoutMs = 5000, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...rest, signal: controller.signal });
        const body = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(body?.error ?? `HTTP ${res.status} from ${url}`);
        return body;
    }
    finally {
        clearTimeout(timer);
    }
}
export async function postJson(url, body, timeoutMs) {
    return fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs,
    });
}
export async function getJson(url, timeoutMs) {
    return fetchJson(url, { method: 'GET', timeoutMs });
}
//# sourceMappingURL=net.js.map