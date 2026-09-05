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
export class CentralStore {
  /** all versions of all rules, keyed ruleId -> version -> record */
  private rules = new Map<string, Map<number, ReferenceRuleVersion>>();
  private bySeq = new Map<number, ReferenceRuleVersion>();
  private nextGlobalSeq = 1;
  private sites = new Map<string, SiteRecord>();

  publish(ruleId: string, payload: Record<string, unknown>): ReferenceRuleVersion {
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

  latestSeq(): number {
    return this.nextGlobalSeq - 1;
  }

  registerSite(profile: SiteRecord): void {
    this.sites.set(profile.siteId, profile);
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
}
