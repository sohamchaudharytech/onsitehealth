import type { PatientChangeBlock, PatientData, PatientRecord, PatientVisit } from '@hc/shared';
/**
 * In-memory patient registry with an append-only change history.
 *
 * Tamper-evidence contract (mirrors the hash-chain philosophy):
 *   - No hard delete: deactivation only (status flip), history survives.
 *   - Every mutation (field patch, credential change, status flip, visit)
 *     appends a PatientChangeBlock capturing before/after values.
 *   - Every mutation is ALSO mirrored into the central hash-chained ledger by
 *     the service layer, so the two records corroborate each other.
 */
export declare class PatientStore {
    private patients;
    private byRef;
    private history;
    private visits;
    private nextChangeSeq;
    private nextRefNum;
    snapshot(): {
        patients: {
            patientId: string;
            email: string;
            data: PatientData;
            createdAt: string;
            createdBy: {
                userId: string;
                username: string;
                role: string;
            } | null;
            linkedUserIds: string[];
            status: "active" | "deactivated";
        }[];
        history: {
            patientId: string;
            blocks: PatientChangeBlock[];
        }[];
        visits: {
            patientId: string;
            visits: PatientVisit[];
        }[];
        nextChangeSeq: number;
        nextRefNum: number;
    };
    restore(snapshot: ReturnType<PatientStore['snapshot']>): void;
    /** Allocate the next human-readable id: P-000123 style, zero-padded to 6. */
    allocatePatientRef(): string;
    /** Seed a pre-allocated ref (e.g. demo data) — bumps the counter past it. */
    seedRef(ref: string): void;
    create(data: PatientData, email: string, createdBy: {
        userId: string;
        username: string;
        role: string;
    } | null): PatientRecord;
    get(patientId: string): PatientRecord | null;
    getByRef(patientRef: string): PatientRecord | null;
    getByEmail(email: string): PatientRecord | null;
    list(): PatientRecord[];
    /**
     * Patch patient fields. Returns the change block, or null if nothing changed.
     * NEVER mutates without appending history.
     */
    applyChange(patientId: string, fields: Partial<Record<keyof PatientData, unknown>>, changedBy: {
        userId: string;
        username: string;
        role: string;
    } | null, reason: string): {
        rec: PatientRecord;
        block: PatientChangeBlock;
    } | null;
    /** Change portal login email (recorded as history). */
    setEmail(patientId: string, email: string, changedBy: {
        userId: string;
        username: string;
        role: string;
    } | null, reason: string): PatientChangeBlock | null;
    /** Deactivate — the only "delete": status flip, everything preserved. */
    deactivate(patientId: string, changedBy: {
        userId: string;
        username: string;
        role: string;
    } | null, reason: string): {
        rec: PatientRecord;
        block: PatientChangeBlock;
    } | null;
    reactivate(patientId: string, changedBy: {
        userId: string;
        username: string;
        role: string;
    } | null, reason: string): {
        rec: PatientRecord;
        block: PatientChangeBlock;
    } | null;
    linkUser(patientId: string, userId: string): void;
    /** Append a hospital visit. */
    addVisit(patientId: string, hospitalId: string, reason: string, recordedBy: {
        userId: string;
        username: string;
        role: string;
    } | null): PatientVisit | null;
    visitsOf(patientId: string): PatientVisit[];
    /** Full change history (oldest first). */
    historyOf(patientId: string): PatientChangeBlock[];
    /** Patients who visited a hospital. */
    patientsAtHospital(hospitalId: string): Array<PatientRecord & {
        lastVisitAt: string;
    }>;
    private block;
}
//# sourceMappingURL=patients.d.ts.map