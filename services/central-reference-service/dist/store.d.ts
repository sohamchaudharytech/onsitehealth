import type { ReferenceRuleVersion, SiteNetworkProfile } from '@hc/shared';
/** Extended profile with network location of the site agent process. */
export interface SiteRecord extends SiteNetworkProfile {
    host: string;
    port: number;
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
    publish(ruleId: string, payload: Record<string, unknown>): ReferenceRuleVersion;
    setHash(rec: ReferenceRuleVersion, contentHash: string): void;
    allVersions(ruleId: string): ReferenceRuleVersion[];
    allRules(): ReferenceRuleVersion[];
    latestSeq(): number;
    registerSite(profile: SiteRecord): void;
    updateSiteNetwork(siteId: string, patch: Partial<SiteNetworkProfile>): SiteRecord | null;
    getSite(siteId: string): SiteRecord | null;
    listSites(): SiteRecord[];
}
//# sourceMappingURL=store.d.ts.map