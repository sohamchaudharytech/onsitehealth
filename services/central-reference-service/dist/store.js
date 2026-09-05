/**
 * In-memory store for the central service (Phase 0-4 scope: minimal store;
 * MongoDB persistence is Phase 7 per PRD §13). Single-process authoritative
 * owner of the global sequence.
 */
export class CentralStore {
    /** all versions of all rules, keyed ruleId -> version -> record */
    rules = new Map();
    bySeq = new Map();
    nextGlobalSeq = 1;
    sites = new Map();
    hospitals = new Map();
    /** sim-N slot allocation (siteId -> N) so successive sim batches never collide */
    nextSimNumber = new Map();
    publish(ruleId, payload) {
        const versions = this.rules.get(ruleId) ?? new Map();
        const version = versions.size + 1;
        const globalSeq = this.nextGlobalSeq++;
        const rec = {
            ruleId,
            version,
            globalSeq,
            payload,
            contentHash: '',
            createdAt: new Date().toISOString(),
        };
        // contentHash computed by caller (avoids import cycle in store)
        versions.set(version, rec);
        this.rules.set(ruleId, versions);
        this.bySeq.set(globalSeq, rec);
        return rec;
    }
    setHash(rec, contentHash) {
        rec.contentHash = contentHash;
    }
    allVersions(ruleId) {
        const m = this.rules.get(ruleId);
        return m ? [...m.values()].sort((a, b) => a.version - b.version) : [];
    }
    allRules() {
        return [...this.bySeq.values()].sort((a, b) => a.globalSeq - b.globalSeq);
    }
    latestSeq() {
        return this.nextGlobalSeq - 1;
    }
    registerSite(profile) {
        this.sites.set(profile.siteId, profile);
    }
    unregisterSite(siteId) {
        const rec = this.sites.get(siteId) ?? null;
        if (rec)
            this.sites.delete(siteId);
        this.hospitals.delete(siteId);
        this.nextSimNumber.delete(siteId);
        return rec;
    }
    // ── Hospitals (domain records layered on sites) ───────────────────────────
    registerHospital(rec) {
        this.hospitals.set(rec.siteId, rec);
    }
    getHospital(siteId) {
        return this.hospitals.get(siteId) ?? null;
    }
    listHospitals() {
        return [...this.hospitals.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    /**
     * Allocate `sim-N` ids for a batch of simulated hospitals. Deterministic
     * next-slot: resumes from the highest previously used N, so successive
     * batches get sim-4..sim-6, sim-7..sim-9, etc. without collisions (skips
     * any id that already exists as a site).
     */
    allocateSimSiteIds(count) {
        const ids = [];
        let n = [...this.nextSimNumber.values()].reduce((m, x) => Math.max(m, x), 0);
        while (ids.length < count) {
            n++;
            const siteId = `sim-${n}`;
            if (this.sites.has(siteId))
                continue;
            this.nextSimNumber.set(siteId, n);
            ids.push(siteId);
        }
        return ids;
    }
    updateSiteNetwork(siteId, patch) {
        const cur = this.sites.get(siteId);
        if (!cur)
            return null;
        const next = { ...cur, ...patch, siteId };
        this.sites.set(siteId, next);
        return next;
    }
    getSite(siteId) {
        return this.sites.get(siteId) ?? null;
    }
    listSites() {
        return [...this.sites.values()];
    }
}
//# sourceMappingURL=store.js.map