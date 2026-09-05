import { isDropped, networkDelay, retryWithBackoff, sleep } from '@hc/shared';
const INTERNAL_KEY = process.env.INTERNAL_KEY ?? 'dev-internal-key';
/**
 * Delivers a rule version to a site through the simulated network:
 * latency + jitter, then a Bernoulli drop decision, retried with
 * exponential backoff + equal jitter (PRD §7.1). On final failure,
 * surfaces SITE_UNREACHABLE instead of hanging silently.
 */
export async function pushToSite(ctx, site, ruleVersion) {
    const { store, ledger, broadcast } = ctx;
    const outcome = await retryWithBackoff(async () => {
        // simulated network transit
        await sleep(networkDelay(site));
        if (isDropped(site.dropRate)) {
            throw new Error(`simulated drop in transit to ${site.siteId}`);
        }
        const res = await fetch(`http://${site.host}:${site.port}/internal/push`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
            body: JSON.stringify({ kind: 'PUSH', ruleVersion }),
            signal: AbortSignal.timeout(4000),
        });
        if (!res.ok)
            throw new Error(`site ${site.siteId} HTTP ${res.status}`);
        return true;
    }, {
        maxAttempts: 8,
        baseMs: 400,
        maxDelayMs: 8000,
        onRetry: (attempt, delayMs) => {
            ledger.append('SITE_UNREACHABLE', {
                siteId: site.siteId,
                ruleId: ruleVersion.ruleId,
                globalSeq: ruleVersion.globalSeq,
                attempt: attempt + 1,
                nextRetryInMs: delayMs,
                reason: 'delivery failed, retrying with backoff+jitter',
            });
            broadcast({ type: 'RETRY', data: { siteId: site.siteId, attempt: attempt + 1, delayMs, globalSeq: ruleVersion.globalSeq }, ts: new Date().toISOString() });
        },
    });
    void store;
    return {
        siteId: site.siteId,
        ruleVersion,
        delivered: outcome.ok,
        attempts: outcome.attempts,
    };
}
//# sourceMappingURL=pusher.js.map