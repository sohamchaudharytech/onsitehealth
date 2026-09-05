import type { AlertResult, ClinicalOrder } from './types.js';
import { type RuleEngine } from './engine.js';
import type { SiteCache } from './cache.js';
/**
 * Epoch-gated evaluation (PRD §6.3 + §6.4).
 *
 * Sites may RECEIVE and CACHE new data as fast as propagation delivers it.
 * They may not EVALUATE against it until the Coordinator says the epoch
 * advanced. The epoch is resolved ONCE per order, at submission time, by a
 * barrier read of the coordinator's globalActiveEpoch — exactly how a
 * snapshot transaction fixes its timestamp once. Every site then evaluates
 * the order against snapshotAsOf(stampedEpoch): identical inputs, pure rule
 * engine, identical outputs by construction.
 *
 * Why the stamped epoch (not each site's local subscription) is authoritative:
 * during a propagation gap, fast sites legitimately hold watermark > epoch.
 * That is by-design state, NOT uncertainty — escalating on it (the naive
 * reading of §6.4) would make fast sites diverge from the slow site and
 * violate the acceptance criteria. The §6.4 conservative fallback therefore
 * fires only on GENUINE uncertainty:
 *
 *   watermark < stampedEpoch — the site cannot satisfy the stamp (an
 *   invariant violation; defense-in-depth). It evaluates best-effort at
 *   its watermark, flags PROVISIONAL_PENDING_CONVERGENCE, and never
 *   suppresses: takes the most conservative of what it can see.
 *
 * A site's local epoch subscription still matters: it drives the live
 * dashboard view and the atomic-cutover visualization — but evaluation
 * reads the stamp, not the subscription.
 */
export declare class EpochGatedEvaluator {
    private engine;
    private knownEpoch;
    constructor(engine?: RuleEngine);
    setEpoch(epochSeq: number): void;
    getKnownEpoch(): number;
    /**
     * @param orderEpoch epoch stamped on the order at submission time by the
     *   central service (barrier read). All sites evaluate at this epoch.
     */
    evaluate(order: ClinicalOrder, cache: SiteCache, orderEpoch: number): AlertResult;
}
//# sourceMappingURL=evaluator.d.ts.map