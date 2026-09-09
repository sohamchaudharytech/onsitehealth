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
export class CoordinatorState {
  private watermarks = new Map<string, SiteWatermark>();
  private epoch: GlobalEpoch = { epochSeq: 0, updatedAt: new Date().toISOString() };
  private onChange: ((epoch: GlobalEpoch) => void) | null = null;

  snapshot(): CoordinatorSnapshot {
    return {
      version: 1,
      watermarks: this.getWatermarks(),
      epoch: this.epoch,
    };
  }

  restore(snapshot: CoordinatorSnapshot): void {
    if (snapshot.version !== 1) throw new Error(`unsupported coordinator snapshot version: ${snapshot.version}`);
    this.watermarks.clear();
    for (const watermark of snapshot.watermarks) this.watermarks.set(watermark.siteId, watermark);
    this.epoch = snapshot.epoch;
  }

  setOnChange(cb: (epoch: GlobalEpoch) => void): void {
    this.onChange = cb;
  }

  ack(watermark: SiteWatermark): { advanced: boolean; epoch: GlobalEpoch } {
    const cur = this.watermarks.get(watermark.siteId);
    if (!cur || watermark.watermarkSeq > cur.watermarkSeq) {
      this.watermarks.set(watermark.siteId, watermark);
    }
    return this.recompute();
  }

  /** Epoch can only advance — never regress — and only when ALL known sites acked. */
  recompute(): { advanced: boolean; epoch: GlobalEpoch } {
    const before = this.epoch.epochSeq;
    if (this.watermarks.size > 0) {
      const min = Math.min(...[...this.watermarks.values()].map((w) => w.watermarkSeq));
      if (min > before) {
        this.epoch = { epochSeq: min, updatedAt: new Date().toISOString() };
        this.onChange?.(this.epoch);
        return { advanced: true, epoch: this.epoch };
      }
    }
    return { advanced: false, epoch: this.epoch };
  }

  getEpoch(): GlobalEpoch {
    return this.epoch;
  }

  getWatermarks(): SiteWatermark[] {
    return [...this.watermarks.values()];
  }

  /** For demo: simulate a site going away (its watermark stops counting). */
  removeSite(siteId: string): void {
    this.watermarks.delete(siteId);
  }
}
