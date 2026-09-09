import type { AuditBlock } from '@hc/shared';
import type { CentralStore } from './store.js';
import type { PatientStore } from './patients.js';
import type { UserStore } from './users.js';
/**
 * File-backed durability for the central service (Phase 7-lite).
 *
 * Two artifacts, both append-only JSONL under DATA_DIR (default .data):
 *
 *   ledger.jsonl    — every hash-chain block, one JSON object per line.
 *                     Append-only by design: the chain's whole point is
 *                     tamper-evidence, so blocks are never rewritten. On
 *                     boot the chain is rehydrated and RE-VERIFIED; a
 *                     mismatch is logged loudly (and surfaces via
 *                     /api/audit/verify).
 *
 *   refresh.jsonl   — refresh-token grants/revocations. Current live state
 *                     is reduced from the log on boot. Long-lived (180d),
 *                     rotation keeps the window small if one leaks.
 *
 * Writes are synchronous-append — tiny lines, safe at demo scale; a real
 * deployment swaps this for MongoDB with the same log-shaped access pattern.
 */
export declare const DATA_DIR: string;
export declare function persistLedgerBlock(block: AuditBlock): void;
/** Load all ledger blocks (boot). Caller loads them into the chain, then verifies. */
export declare function loadLedgerBlocks(): AuditBlock[];
export type RefreshEvent = {
    kind: 'grant';
    tokenHash: string;
    userId: string;
    issuedAt: number;
} | {
    kind: 'revoke';
    tokenHash: string;
} | {
    kind: 'revoke-all';
    userId: string;
};
export declare function persistRefreshEvent(ev: RefreshEvent): void;
export declare function loadRefreshEvents(): RefreshEvent[];
export interface DomainStateSnapshot {
    version: 1;
    savedAt: string;
    central: ReturnType<CentralStore['snapshot']>;
    users: ReturnType<UserStore['snapshot']>;
    patients: ReturnType<PatientStore['snapshot']>;
}
export declare function loadDomainSnapshot(): DomainStateSnapshot | null;
export declare function persistDomainSnapshot(snapshot: DomainStateSnapshot): void;
/** Wipe persisted state (used by tests / fresh-start script). */
export declare function resetPersistence(): void;
//# sourceMappingURL=persistence.d.ts.map