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
export class SiteCache {
  /** ruleId -> array of versions sorted ascending by globalSeq */
  private history = new Map<string, ReferenceRuleVersion[]>();
  /** highest globalSeq durably stored locally */
  private watermark = 0;

  snapshot(): SiteCacheSnapshot {
    return {
      version: 1,
      rules: Object.fromEntries([...this.history].map(([ruleId, versions]) => [ruleId, versions])),
      watermark: this.watermark,
    };
  }

  restore(snapshot: SiteCacheSnapshot): void {
    if (snapshot.version !== 1) throw new Error(`unsupported SiteCache snapshot version: ${snapshot.version}`);
    this.history.clear();
    for (const [ruleId, versions] of Object.entries(snapshot.rules)) {
      const sorted = [...versions].sort((a, b) => a.globalSeq - b.globalSeq);
      this.history.set(ruleId, sorted);
    }
    this.watermark = Math.max(0, snapshot.watermark);
  }

  ingest(rec: ReferenceRuleVersion): { isNew: boolean; watermark: number } {
    const arr = this.history.get(rec.ruleId) ?? [];
    if (arr.some((r) => r.globalSeq === rec.globalSeq)) {
      return { isNew: false, watermark: this.watermark };
    }
    arr.push(rec);
    arr.sort((a, b) => a.globalSeq - b.globalSeq);
    this.history.set(rec.ruleId, arr);
    if (rec.globalSeq > this.watermark) this.watermark = rec.globalSeq;
    return { isNew: true, watermark: this.watermark };
  }

  getWatermark(): number {
    return this.watermark;
  }

  /**
   * Snapshot as of a globalSeq: for each rule, the latest version whose
   * globalSeq <= N. Rules that didn't exist yet at N are absent.
   */
  snapshotAsOf(n: number): ReferenceSnapshot {
    const rules: Record<string, ReferenceRuleVersion> = {};
    for (const [ruleId, versions] of this.history) {
      let chosen: ReferenceRuleVersion | null = null;
      for (const v of versions) {
        if (v.globalSeq <= n) chosen = v;
        else break;
      }
      if (chosen) rules[ruleId] = chosen;
    }
    return { asOfGlobalSeq: n, rules };
  }

  /** Prune history to keep memory bounded (keep last K versions per rule). */
  prune(keep = 20): void {
    for (const [ruleId, versions] of this.history) {
      if (versions.length > keep) this.history.set(ruleId, versions.slice(-keep));
    }
  }
}
