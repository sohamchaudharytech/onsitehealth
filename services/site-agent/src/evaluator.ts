import type { AlertResult, ClinicalOrder } from '@hc/shared';
import {
  DrugInteractionEngine,
  mostConservative,
  resultsEqual,
  type RuleEngine,
} from '@hc/shared';
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
export class EpochGatedEvaluator {
  private engine: RuleEngine;
  private knownEpoch = 0;

  constructor(engine: RuleEngine = new DrugInteractionEngine()) {
    this.engine = engine;
  }

  setEpoch(epochSeq: number): void {
    if (epochSeq > this.knownEpoch) this.knownEpoch = epochSeq;
  }

  getKnownEpoch(): number {
    return this.knownEpoch;
  }

  /**
   * @param orderEpoch epoch stamped on the order at submission time by the
   *   central service (barrier read). All sites evaluate at this epoch.
   */
  evaluate(order: ClinicalOrder, cache: SiteCache, orderEpoch: number): AlertResult {
    const watermark = cache.getWatermark();

    if (watermark >= orderEpoch) {
      // Normal path: the site holds all data up to the stamped epoch.
      // Evaluate strictly at the stamp — identical at every site.
      const snapshot = cache.snapshotAsOf(orderEpoch);
      const result = this.engine.evaluate(order, snapshot);
      return {
        orderId: order.orderId,
        siteId: order.siteId,
        epochUsed: orderEpoch,
        watermarkAtEval: watermark,
        fires: result.fires,
        severity: result.severity,
        ruleId: result.ruleId,
        provisional: false,
        evaluatedAt: new Date().toISOString(),
      };
    }

    // Defense-in-depth (§6.4): this site cannot satisfy the stamped epoch.
    // The coordinator's min-watermark invariant should make this impossible,
    // but if it happens, fail toward firing — never suppress — and flag it.
    const snapshotBestEffort = cache.snapshotAsOf(watermark);
    const resultBestEffort = this.engine.evaluate(order, snapshotBestEffort);
    const snapshotStamped = cache.snapshotAsOf(orderEpoch); // may be missing rules
    const resultStamped = this.engine.evaluate(order, snapshotStamped);
    const merged = resultsEqual(resultBestEffort, resultStamped)
      ? resultBestEffort
      : mostConservative(resultBestEffort, resultStamped);
    return {
      orderId: order.orderId,
      siteId: order.siteId,
      epochUsed: orderEpoch,
      watermarkAtEval: watermark,
      fires: merged.fires,
      severity: merged.severity,
      ruleId: merged.ruleId,
      provisional: true,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
