import type { AuditBlock, LedgerEventType, LedgerVerifyReport } from './types.js';
export declare const GENESIS_PREV_HASH: string;
/**
 * Append-only, hash-chained ledger. Single trusted writer (the central
 * service) — this is the data structure inside a blockchain, without
 * decentralized consensus, which is the correct tool for tamper-evidence
 * when you control the writer.
 */
export declare class HashChainLedger {
    private blocks;
    get length(): number;
    get head(): AuditBlock | null;
    append(eventType: LedgerEventType, payload: Record<string, unknown>): AuditBlock;
    private blockHash;
    /** Walk the whole chain, recompute every hash, report the first bad block. */
    verify(): LedgerVerifyReport;
    /** Replace stored blocks (used when rehydrating from persistence). */
    load(blocks: AuditBlock[]): void;
    page(offset?: number, limit?: number): {
        blocks: AuditBlock[];
        total: number;
    };
    all(): AuditBlock[];
}
//# sourceMappingURL=ledger.d.ts.map