/**
 * Computes the single global "safe to use" version:
 *   globalActiveEpoch = min(watermark_A, watermark_B, ...)
 * A quorum/barrier read — the slowest site defines what's safe for everyone,
 * the same idea behind Spanner's TrueTime safe-time / CockroachDB closed ts.
 */
export class CoordinatorState {
    watermarks = new Map();
    epoch = { epochSeq: 0, updatedAt: new Date().toISOString() };
    onChange = null;
    setOnChange(cb) {
        this.onChange = cb;
    }
    ack(watermark) {
        const cur = this.watermarks.get(watermark.siteId);
        if (!cur || watermark.watermarkSeq > cur.watermarkSeq) {
            this.watermarks.set(watermark.siteId, watermark);
        }
        return this.recompute();
    }
    /** Epoch can only advance — never regress — and only when ALL known sites acked. */
    recompute() {
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
    getEpoch() {
        return this.epoch;
    }
    getWatermarks() {
        return [...this.watermarks.values()];
    }
    /** For demo: simulate a site going away (its watermark stops counting). */
    removeSite(siteId) {
        this.watermarks.delete(siteId);
    }
}
//# sourceMappingURL=state.js.map