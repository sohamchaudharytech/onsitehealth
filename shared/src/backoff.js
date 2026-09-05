/**
 * Exponential backoff with equal jitter:
 *   delay(attempt) = min(maxDelay, base * 2^attempt) * (0.5 + random(0, 0.5))
 * Used for central→site pushes, site→coordinator ACKs, and epoch polling.
 */
export function backoffDelayMs(attempt, baseMs = 500, maxDelayMs = 15_000) {
    const exp = Math.min(maxDelayMs, baseMs * 2 ** attempt);
    return Math.round(exp * (0.5 + Math.random() * 0.5));
}
/** Retry with backoff+jitter until success or maxAttempts. */
export async function retryWithBackoff(fn, opts = {}) {
    const maxAttempts = opts.maxAttempts ?? 6;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            const value = await fn();
            return { ok: true, value, attempts: attempt + 1, gaveUp: false };
        }
        catch (err) {
            if (attempt + 1 >= maxAttempts) {
                return { ok: false, attempts: attempt + 1, gaveUp: true };
            }
            const delay = backoffDelayMs(attempt, opts.baseMs, opts.maxDelayMs);
            opts.onRetry?.(attempt, delay, err);
            await sleep(delay);
            attempt += 1;
        }
    }
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Simulated network characteristics for a site. */
export function networkDelay(profile) {
    const jitter = profile.jitterMs > 0 ? (Math.random() * 2 - 1) * profile.jitterMs : 0;
    return Math.max(0, Math.round(profile.baseLatencyMs + jitter));
}
/** Bernoulli drop decision. */
export function isDropped(dropRate) {
    return dropRate > 0 && Math.random() < dropRate;
}
//# sourceMappingURL=backoff.js.map