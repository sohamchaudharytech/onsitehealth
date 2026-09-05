/**
 * Exponential backoff with equal jitter:
 *   delay(attempt) = min(maxDelay, base * 2^attempt) * (0.5 + random(0, 0.5))
 * Used for central→site pushes, site→coordinator ACKs, and epoch polling.
 */
export declare function backoffDelayMs(attempt: number, baseMs?: number, maxDelayMs?: number): number;
export interface RetryOutcome<T> {
    ok: boolean;
    value?: T;
    attempts: number;
    gaveUp: boolean;
}
/** Retry with backoff+jitter until success or maxAttempts. */
export declare function retryWithBackoff<T>(fn: () => Promise<T>, opts?: {
    maxAttempts?: number;
    baseMs?: number;
    maxDelayMs?: number;
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}): Promise<RetryOutcome<T>>;
export declare function sleep(ms: number): Promise<void>;
/** Simulated network characteristics for a site. */
export declare function networkDelay(profile: {
    baseLatencyMs: number;
    jitterMs: number;
}): number;
/** Bernoulli drop decision. */
export declare function isDropped(dropRate: number): boolean;
//# sourceMappingURL=backoff.d.ts.map