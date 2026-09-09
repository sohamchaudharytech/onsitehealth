export type LogisticsEventType = 'SHIPMENT_SEEDED' | 'SHIPMENT_CREATED' | 'SHIPMENT_DISPATCHED' | 'SHIPMENT_DELIVERED' | 'SHIPMENT_STATUS_CHANGED' | 'USER_LOGIN';
export interface AuditBlock {
    index: number;
    timestamp: string;
    eventType: LogisticsEventType;
    payload: Record<string, unknown>;
    prevHash: string;
    hash: string;
}
export interface LedgerVerifyReport {
    valid: boolean;
    blocksChecked: number;
    firstBadIndex: number | null;
    reason: string | null;
}
/** Deterministic JSON for hashing (sorted keys, no whitespace). */
export declare function canonicalJson(value: unknown): string;
export declare function sha256(input: string): string;
export declare class HashChainLedger {
    private blocks;
    snapshot(): AuditBlock[];
    restore(blocks: AuditBlock[]): void;
    get length(): number;
    append(eventType: LogisticsEventType, payload: Record<string, unknown>): AuditBlock;
    private blockHash;
    /** Walk the whole chain, recompute every hash, report the first bad block. */
    verify(): LedgerVerifyReport;
    page(offset?: number, limit?: number): {
        blocks: AuditBlock[];
        total: number;
    };
}
//# sourceMappingURL=ledger.d.ts.map