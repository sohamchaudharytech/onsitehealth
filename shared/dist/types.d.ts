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
    /** who published this version (attribution) */
    publishedBy?: RulePublisher;
}
/** Attribution stamped on every rule version at publish time. */
export interface RulePublisher {
    userId: string;
    username: string;
    role: string;
    /** hospital the publishing doctor is affiliated with, if any */
    hospitalId?: string | null;
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
/** Core demographics of a patient (immutable fields are versioned via PatientRecord). */
export interface PatientData {
    patientRef: string;
    firstName: string;
    lastName: string;
    dob: string;
    gender: string;
    disease: string;
    drugs: string[];
}
export interface PatientRecord {
    patientId: string;
    email: string;
    data: PatientData;
    createdAt: string;
    createdBy: {
        userId: string;
        username: string;
        role: string;
    } | null;
    /** linked portal account (mirrored for display) */
    linkedUserIds: string[];
    status: 'active' | 'deactivated';
}
/** One history block — a change to a patient. Old values are kept, never hard-deleted. */
export interface PatientChangeBlock {
    seq: number;
    patientId: string;
    changedBy: {
        userId: string;
        username: string;
        role: string;
    } | null;
    changedAt: string;
    reason: string;
    /** field -> {before, after} */
    changes: Record<string, {
        before: unknown;
        after: unknown;
    }>;
}
/** A hospital visit recorded on a patient. */
export interface PatientVisit {
    visitId: string;
    patientId: string;
    hospitalId: string;
    visitedAt: string;
    reason: string;
    recordedBy: {
        userId: string;
        username: string;
        role: string;
    } | null;
}
export type LedgerEventType = 'REFDATA_PUBLISHED' | 'REFDATA_RECEIVED' | 'EPOCH_ADVANCED' | 'ORDER_EVALUATED' | 'SITE_CHAOS_INJECTED' | 'SITE_UNREACHABLE' | 'HOSPITAL_ADDED' | 'HOSPITAL_REMOVED' | 'SIM_HOSPITALS_GENERATED' | 'DOCTOR_ADDED' | 'USER_REMOVED' | 'DRUG_ADDED_TO_HOSPITAL' | 'DRUG_REMOVED_FROM_HOSPITAL' | 'PATIENT_CREATED' | 'PATIENT_UPDATED' | 'PATIENT_VISIT_RECORDED';
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
    type: 'WATERMARK' | 'EPOCH' | 'ALERT_RESULT' | 'CHAOS' | 'PUBLISH' | 'RETRY' | 'UNREACHABLE' | 'LEDGER' | 'HOSPITAL' | 'DOCTOR' | 'DRUG' | 'PATIENT';
    data: Record<string, unknown>;
    ts: string;
}
/** A drug stocked/provisioned at a specific hospital. */
export interface HospitalDrug {
    id: string;
    drugName: string;
    hospitalId: string;
    /** who provisioned this drug at this hospital */
    addedBy: {
        userId: string;
        username: string;
        role: string;
    } | null;
    addedAt: string;
}
//# sourceMappingURL=types.d.ts.map