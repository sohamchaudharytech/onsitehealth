import type { ReferenceRuleVersion } from '@hc/shared';
import type { CentralStore, SiteRecord } from './store.js';
export interface PusherContext {
    store: CentralStore;
    ledger: {
        append: (t: import('@hc/shared').LedgerEventType, p: Record<string, unknown>) => import('@hc/shared').AuditBlock;
    };
    broadcast: (e: import('@hc/shared').LiveEvent) => void;
}
export interface PushOutcome {
    siteId: string;
    ruleVersion: ReferenceRuleVersion;
    delivered: boolean;
    attempts: number;
}
/**
 * Delivers a rule version to a site through the simulated network:
 * latency + jitter, then a Bernoulli drop decision, retried with
 * exponential backoff + equal jitter (PRD §7.1). On final failure,
 * surfaces SITE_UNREACHABLE instead of hanging silently.
 */
export declare function pushToSite(ctx: PusherContext, site: SiteRecord, ruleVersion: ReferenceRuleVersion): Promise<PushOutcome>;
//# sourceMappingURL=pusher.d.ts.map