import type { GlobalEpoch, SiteWatermark } from '@hc/shared';
export interface CoordinatorSnapshot {
    version: 1;
    watermarks: SiteWatermark[];
    epoch: GlobalEpoch;
}
/**
 * Computes the single global "safe to use" version:
 *   globalActiveEpoch = min(watermark_A, watermark_B, ...)
 * A quorum/barrier read — the slowest site defines what's safe for everyone,
 * the same idea behind Spanner's TrueTime safe-time / CockroachDB closed ts.
 */
export declare class CoordinatorState {
    private watermarks;
    private epoch;
    private onChange;
    snapshot(): CoordinatorSnapshot;
    restore(snapshot: CoordinatorSnapshot): void;
    setOnChange(cb: (epoch: GlobalEpoch) => void): void;
    ack(watermark: SiteWatermark): {
        advanced: boolean;
        epoch: GlobalEpoch;
    };
    /** Epoch can only advance — never regress — and only when ALL known sites acked. */
    recompute(): {
        advanced: boolean;
        epoch: GlobalEpoch;
    };
    getEpoch(): GlobalEpoch;
    getWatermarks(): SiteWatermark[];
    /** For demo: simulate a site going away (its watermark stops counting). */
    removeSite(siteId: string): void;
}
//# sourceMappingURL=state.d.ts.map