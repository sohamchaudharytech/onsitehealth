import type { ReferenceRuleVersion, ReferenceSnapshot } from '@hc/shared';
export interface SiteCacheSnapshot {
    version: 1;
    rules: Record<string, ReferenceRuleVersion[]>;
    watermark: number;
}
/**
 * Local site cache with a short version history per rule — NOT just the
 * latest — so it can reconstruct "the world as of globalSeq N" even after
 * receiving N+1. Small-scale MVCC snapshot read.
 */
export declare class SiteCache {
    /** ruleId -> array of versions sorted ascending by globalSeq */
    private history;
    /** highest globalSeq durably stored locally */
    private watermark;
    snapshot(): SiteCacheSnapshot;
    restore(snapshot: SiteCacheSnapshot): void;
    ingest(rec: ReferenceRuleVersion): {
        isNew: boolean;
        watermark: number;
    };
    getWatermark(): number;
    /**
     * Snapshot as of a globalSeq: for each rule, the latest version whose
     * globalSeq <= N. Rules that didn't exist yet at N are absent.
     */
    snapshotAsOf(n: number): ReferenceSnapshot;
    /** Prune history to keep memory bounded (keep last K versions per rule). */
    prune(keep?: number): void;
}
//# sourceMappingURL=cache.d.ts.map