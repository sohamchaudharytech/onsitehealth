/** Immutable version of a reference rule. Never mutated in place. */
export interface ReferenceRuleVersion {
    ruleId: string;
    /** per-rule version number */
    version: number;
    /** assigned centrally, strictly increasing across ALL rules */
    globalSeq: number;
    /** rule-specific fields — opaque to the consistency mechanism */
    payload: Record<string, unknown>;
    /** sha256(canonicalJson(payload)) */
    contentHash: string;
    createdAt: string;
}
/** The world as of globalSeq N: every rule resolved to its version at that seq. */
export interface ReferenceSnapshot {
    asOfGlobalSeq: number;
    rules: Record<string, ReferenceRuleVersion>;
}
export interface SiteNetworkProfile {
    siteId: string;
    baseLatencyMs: number;
    jitterMs: number;
    dropRate: number;
}
export interface SiteWatermark {
    siteId: string;
    watermarkSeq: number;
    lastAckAt: string;
}
export interface GlobalEpoch {
    epochSeq: number;
    updatedAt: string;
}
export interface ClinicalOrder {
    orderId: string;
    siteId: string;
    orderCode: string;
    patientRef: string;
    submittedAt: string;
    /** order-specific fields (opaque to the consistency mechanism) */
    details: Record<string, unknown>;
}
export type Severity = 'NONE' | 'LOW' | 'MODERATE' | 'SEVERE' | 'CRITICAL';
export interface AlertResult {
    orderId: string;
    siteId: string;
    epochUsed: number;
    watermarkAtEval: number;
    fires: boolean;
    severity: Severity;
    ruleId: string | null;
    provisional: boolean;
    evaluatedAt: string;
}
export type LedgerEventType = 'REFDATA_PUBLISHED' | 'REFDATA_RECEIVED' | 'EPOCH_ADVANCED' | 'ORDER_EVALUATED' | 'SITE_CHAOS_INJECTED' | 'SITE_UNREACHABLE' | 'HOSPITAL_ADDED' | 'HOSPITAL_REMOVED' | 'SIM_HOSPITALS_GENERATED' | 'DOCTOR_ADDED' | 'USER_REMOVED';
export interface AuditBlock {
    index: number;
    timestamp: string;
    eventType: LedgerEventType;
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
export interface PushMessage {
    kind: 'PUSH';
    ruleVersion: ReferenceRuleVersion;
}
export interface AckMessage {
    kind: 'ACK';
    siteId: string;
    watermarkSeq: number;
    at: string;
}
export interface EpochUpdateMessage {
    kind: 'EPOCH_UPDATE';
    epochSeq: number;
    updatedAt: string;
}
export type WireMessage = PushMessage | AckMessage | EpochUpdateMessage;
export interface LiveEvent {
    type: 'WATERMARK' | 'EPOCH' | 'ALERT_RESULT' | 'CHAOS' | 'PUBLISH' | 'RETRY' | 'UNREACHABLE' | 'LEDGER' | 'HOSPITAL' | 'DOCTOR';
    data: Record<string, unknown>;
    ts: string;
}
//# sourceMappingURL=types.d.ts.map