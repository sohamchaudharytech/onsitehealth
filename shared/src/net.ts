/**
 * Minimal fetch wrapper with timeout — used for service-to-service HTTP.
 */
export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 5000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status} from ${url}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function postJson<T>(url: string, body: unknown, timeoutMs?: number): Promise<T> {
  return fetchJson<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

export async function getJson<T>(url: string, timeoutMs?: number): Promise<T> {
  return fetchJson<T>(url, { method: 'GET', timeoutMs });
}
