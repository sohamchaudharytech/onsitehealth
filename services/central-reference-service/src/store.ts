import type { HospitalDrug, ReferenceRuleVersion, RulePublisher, SiteNetworkProfile } from '@hc/shared';

/** Extended profile with network location of the site agent process. */
export interface SiteRecord extends SiteNetworkProfile {
  host: string;
  port: number;
}

/** Human domain attributes of a hospital (site = clinical system). */
export interface HospitalRecord {
  siteId: string;
  name: string;
  region: string;
  simulated: boolean;
  createdAt: string;
}

/**
 * In-memory store for the central service (Phase 0-4 scope: minimal store;
 * MongoDB persistence is Phase 7 per PRD §13). Single-process authoritative
 * owner of the global sequence.
 */
export class CentralStore {
  /** all versions of all rules, keyed ruleId -> version -> record */
  private rules = new Map<string, Map<number, ReferenceRuleVersion>>();
  private bySeq = new Map<number, ReferenceRuleVersion>();
  private nextGlobalSeq = 1;
  private sites = new Map<string, SiteRecord>();
  private hospitals = new Map<string, HospitalRecord>();
  /** sim-N slot allocation (siteId -> N) so successive sim batches never collide */
  private nextSimNumber = new Map<string, number>();
  /** hospital formulary: drug id -> record */
  private drugs = new Map<string, HospitalDrug>();

  snapshot() {
    return {
      rules: [...this.bySeq.values()],
      nextGlobalSeq: this.nextGlobalSeq,
      sites: [...this.sites.values()],
      hospitals: [...this.hospitals.values()],
      nextSimNumber: [...this.nextSimNumber.entries()],
      drugs: [...this.drugs.values()],
    };
  }

  restore(snapshot: ReturnType<CentralStore['snapshot']>): void {
    this.rules.clear();
    this.bySeq.clear();
    this.sites.clear();
    this.hospitals.clear();
    this.nextSimNumber.clear();
    this.drugs.clear();

    for (const rec of snapshot.rules) {
      const versions = this.rules.get(rec.ruleId) ?? new Map<number, ReferenceRuleVersion>();
      versions.set(rec.version, rec);
      this.rules.set(rec.ruleId, versions);
      this.bySeq.set(rec.globalSeq, rec);
    }
    this.nextGlobalSeq = Math.max(1, snapshot.nextGlobalSeq);
    for (const rec of snapshot.sites) this.registerSite(rec);
    for (const rec of snapshot.hospitals) this.registerHospital(rec);
    for (const [key, value] of snapshot.nextSimNumber) this.nextSimNumber.set(key, value);
    for (const rec of snapshot.drugs) this.addDrugToHospital(rec);
  }

  publish(ruleId: string, payload: Record<string, unknown>, publishedBy?: RulePublisher): ReferenceRuleVersion {
    const versions = this.rules.get(ruleId) ?? new Map<number, ReferenceRuleVersion>();
    const version = versions.size + 1;
    const globalSeq = this.nextGlobalSeq++;
    const rec: ReferenceRuleVersion = {
      ruleId,
      version,
      globalSeq,
      payload,
      contentHash: '',
      createdAt: new Date().toISOString(),
      ...(publishedBy ? { publishedBy } : {}),
    };
    // contentHash computed by caller (avoids import cycle in store)
    versions.set(version, rec);
    this.rules.set(ruleId, versions);
    this.bySeq.set(globalSeq, rec);
    return rec;
  }

  setHash(rec: ReferenceRuleVersion, contentHash: string): void {
    rec.contentHash = contentHash;
  }

  allVersions(ruleId: string): ReferenceRuleVersion[] {
    const m = this.rules.get(ruleId);
    return m ? [...m.values()].sort((a, b) => a.version - b.version) : [];
  }

  allRules(): ReferenceRuleVersion[] {
    return [...this.bySeq.values()].sort((a, b) => a.globalSeq - b.globalSeq);
  }

  /** Latest version of each rule (newest globalSeq wins), for dashboard views. */
  latestVersions(): ReferenceRuleVersion[] {
    const latest = new Map<string, ReferenceRuleVersion>();
    for (const rec of this.bySeq.values()) latest.set(rec.ruleId, rec);
    return [...latest.values()].sort((a, b) => b.globalSeq - a.globalSeq);
  }

  latestSeq(): number {
    return this.nextGlobalSeq - 1;
  }

  registerSite(profile: SiteRecord): void {
    this.sites.set(profile.siteId, profile);
  }

  unregisterSite(siteId: string): SiteRecord | null {
    const rec = this.sites.get(siteId) ?? null;
    if (rec) this.sites.delete(siteId);
    this.hospitals.delete(siteId);
    this.nextSimNumber.delete(siteId);
    this.clearHospitalDrugs(siteId);
    return rec;
  }

  // ── Hospitals (domain records layered on sites) ───────────────────────────

  registerHospital(rec: HospitalRecord): void {
    this.hospitals.set(rec.siteId, rec);
  }

  getHospital(siteId: string): HospitalRecord | null {
    return this.hospitals.get(siteId) ?? null;
  }

  listHospitals(): HospitalRecord[] {
    return [...this.hospitals.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Allocate `sim-N` ids for a batch of simulated hospitals. Deterministic
   * next-slot: resumes from the highest previously used N, so successive
   * batches get sim-4..sim-6, sim-7..sim-9, etc. without collisions (skips
   * any id that already exists as a site).
   */
  allocateSimSiteIds(count: number): string[] {
    const ids: string[] = [];
    let n = [...this.nextSimNumber.values()].reduce((m, x) => Math.max(m, x), 0);
    while (ids.length < count) {
      n++;
      const siteId = `sim-${n}`;
      if (this.sites.has(siteId)) continue;
      this.nextSimNumber.set(siteId, n);
      ids.push(siteId);
    }
    return ids;
  }

  updateSiteNetwork(siteId: string, patch: Partial<SiteNetworkProfile>): SiteRecord | null {
    const cur = this.sites.get(siteId);
    if (!cur) return null;
    const next = { ...cur, ...patch, siteId };
    this.sites.set(siteId, next);
    return next;
  }

  getSite(siteId: string): SiteRecord | null {
    return this.sites.get(siteId) ?? null;
  }

  listSites(): SiteRecord[] {
    return [...this.sites.values()];
  }

  // ── Hospital formulary (drugs provisioned per hospital) ─────────────────────

  addDrugToHospital(drug: HospitalDrug): void {
    this.drugs.set(drug.id, drug);
  }

  removeDrug(drugId: string): HospitalDrug | null {
    const rec = this.drugs.get(drugId) ?? null;
    if (rec) this.drugs.delete(drugId);
    return rec;
  }

  drugsAtHospital(hospitalId: string): HospitalDrug[] {
    return [...this.drugs.values()]
      .filter((d) => d.hospitalId === hospitalId)
      .sort((a, b) => a.drugName.localeCompare(b.drugName));
  }

  /** True if the hospital already stocks a drug with this name (case-insensitive). */
  hospitalHasDrug(hospitalId: string, drugName: string): boolean {
    const needle = drugName.trim().toLowerCase();
    return [...this.drugs.values()].some((d) => d.hospitalId === hospitalId && d.drugName.toLowerCase() === needle);
  }

  /** Drug names stocked anywhere — for autocomplete/distinct lists. */
  allDrugNames(): string[] {
    return [...new Set([...this.drugs.values()].map((d) => d.drugName))].sort((a, b) => a.localeCompare(b));
  }

  /** Drop all formulary rows for a removed hospital. */
  clearHospitalDrugs(hospitalId: string): void {
    for (const [id, d] of this.drugs) {
      if (d.hospitalId === hospitalId) this.drugs.delete(id);
    }
  }
}
