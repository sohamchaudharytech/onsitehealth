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
export declare class CentralStore {
    /** all versions of all rules, keyed ruleId -> version -> record */
    private rules;
    private bySeq;
    private nextGlobalSeq;
    private sites;
    private hospitals;
    /** sim-N slot allocation (siteId -> N) so successive sim batches never collide */
    private nextSimNumber;
    /** hospital formulary: drug id -> record */
    private drugs;
    publish(ruleId: string, payload: Record<string, unknown>, publishedBy?: RulePublisher): ReferenceRuleVersion;
    setHash(rec: ReferenceRuleVersion, contentHash: string): void;
    allVersions(ruleId: string): ReferenceRuleVersion[];
    allRules(): ReferenceRuleVersion[];
    /** Latest version of each rule (newest globalSeq wins), for dashboard views. */
    latestVersions(): ReferenceRuleVersion[];
    latestSeq(): number;
    registerSite(profile: SiteRecord): void;
    unregisterSite(siteId: string): SiteRecord | null;
    registerHospital(rec: HospitalRecord): void;
    getHospital(siteId: string): HospitalRecord | null;
    listHospitals(): HospitalRecord[];
    /**
     * Allocate `sim-N` ids for a batch of simulated hospitals. Deterministic
     * next-slot: resumes from the highest previously used N, so successive
     * batches get sim-4..sim-6, sim-7..sim-9, etc. without collisions (skips
     * any id that already exists as a site).
     */
    allocateSimSiteIds(count: number): string[];
    updateSiteNetwork(siteId: string, patch: Partial<SiteNetworkProfile>): SiteRecord | null;
    getSite(siteId: string): SiteRecord | null;
    listSites(): SiteRecord[];
    addDrugToHospital(drug: HospitalDrug): void;
    removeDrug(drugId: string): HospitalDrug | null;
    drugsAtHospital(hospitalId: string): HospitalDrug[];
    /** True if the hospital already stocks a drug with this name (case-insensitive). */
    hospitalHasDrug(hospitalId: string, drugName: string): boolean;
    /** Drug names stocked anywhere — for autocomplete/distinct lists. */
    allDrugNames(): string[];
    /** Drop all formulary rows for a removed hospital. */
    clearHospitalDrugs(hospitalId: string): void;
}
//# sourceMappingURL=store.d.ts.map