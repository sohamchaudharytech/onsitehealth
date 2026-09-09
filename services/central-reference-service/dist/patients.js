import { newOpaqueToken } from '@hc/shared';
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
export class PatientStore {
    patients = new Map();
    byRef = new Map(); // patientRef -> patientId
    history = new Map(); // patientId -> blocks
    visits = new Map(); // patientId -> visits
    nextChangeSeq = 1;
    nextRefNum = 1;
    snapshot() {
        return {
            patients: [...this.patients.values()].map((patient) => ({ ...patient })),
            history: [...this.history.entries()].map(([patientId, blocks]) => ({ patientId, blocks })),
            visits: [...this.visits.entries()].map(([patientId, visits]) => ({ patientId, visits })),
            nextChangeSeq: this.nextChangeSeq,
            nextRefNum: this.nextRefNum,
        };
    }
    restore(snapshot) {
        this.patients.clear();
        this.byRef.clear();
        this.history.clear();
        this.visits.clear();
        for (const patient of snapshot.patients) {
            const record = { ...patient };
            this.patients.set(record.patientId, record);
            this.byRef.set(record.data.patientRef, record.patientId);
        }
        for (const entry of snapshot.history) {
            if (this.patients.has(entry.patientId))
                this.history.set(entry.patientId, [...entry.blocks]);
        }
        for (const entry of snapshot.visits) {
            if (this.patients.has(entry.patientId))
                this.visits.set(entry.patientId, [...entry.visits]);
        }
        this.nextChangeSeq = Math.max(1, snapshot.nextChangeSeq);
        this.nextRefNum = Math.max(1, snapshot.nextRefNum);
    }
    /** Allocate the next human-readable id: P-000123 style, zero-padded to 6. */
    allocatePatientRef() {
        let n = this.nextRefNum++;
        return `P-${String(n).padStart(6, '0')}`;
    }
    /** Seed a pre-allocated ref (e.g. demo data) — bumps the counter past it. */
    seedRef(ref) {
        const m = /^P-(\d+)$/.exec(ref);
        if (m)
            this.nextRefNum = Math.max(this.nextRefNum, Number(m[1]) + 1);
    }
    create(data, email, createdBy) {
        if (this.byRef.has(data.patientRef))
            throw new Error(`patientRef '${data.patientRef}' already exists`);
        const patientId = `pat-${newOpaqueToken().slice(0, 12)}`;
        const rec = {
            patientId,
            email,
            data,
            createdAt: new Date().toISOString(),
            createdBy,
            linkedUserIds: [],
            status: 'active',
        };
        this.patients.set(patientId, rec);
        this.byRef.set(data.patientRef, patientId);
        this.history.set(patientId, []);
        this.visits.set(patientId, []);
        return rec;
    }
    get(patientId) {
        return this.patients.get(patientId) ?? null;
    }
    getByRef(patientRef) {
        const id = this.byRef.get(patientRef);
        return id ? this.patients.get(id) ?? null : null;
    }
    getByEmail(email) {
        const needle = email.trim().toLowerCase();
        for (const p of this.patients.values()) {
            if (p.email.toLowerCase() === needle)
                return p;
        }
        return null;
    }
    list() {
        return [...this.patients.values()].sort((a, b) => a.data.patientRef.localeCompare(b.data.patientRef));
    }
    /**
     * Patch patient fields. Returns the change block, or null if nothing changed.
     * NEVER mutates without appending history.
     */
    applyChange(patientId, fields, changedBy, reason) {
        const rec = this.patients.get(patientId);
        if (!rec)
            return null;
        const changes = {};
        const next = { ...rec.data };
        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined)
                continue;
            const k = key;
            const before = rec.data[k];
            const after = value;
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                changes[key] = { before, after };
                next[k] = value;
            }
        }
        // status/email are handled through dedicated methods; only PatientData here
        if (Object.keys(changes).length === 0)
            return null;
        const block = {
            seq: this.nextChangeSeq++,
            patientId,
            changedBy,
            changedAt: new Date().toISOString(),
            reason,
            changes,
        };
        rec.data = next;
        this.history.get(patientId)?.push(block);
        return { rec, block };
    }
    /** Change portal login email (recorded as history). */
    setEmail(patientId, email, changedBy, reason) {
        const rec = this.patients.get(patientId);
        if (!rec || rec.email === email)
            return null;
        const block = this.block(patientId, changedBy, reason, { email: { before: rec.email, after: email } });
        rec.email = email;
        return block;
    }
    /** Deactivate — the only "delete": status flip, everything preserved. */
    deactivate(patientId, changedBy, reason) {
        const rec = this.patients.get(patientId);
        if (!rec || rec.status !== 'active')
            return null;
        const block = this.block(patientId, changedBy, reason, { status: { before: 'active', after: 'deactivated' } });
        rec.status = 'deactivated';
        return { rec, block };
    }
    reactivate(patientId, changedBy, reason) {
        const rec = this.patients.get(patientId);
        if (!rec || rec.status !== 'deactivated')
            return null;
        const block = this.block(patientId, changedBy, reason, { status: { before: 'deactivated', after: 'active' } });
        rec.status = 'active';
        return { rec, block };
    }
    linkUser(patientId, userId) {
        const rec = this.patients.get(patientId);
        if (rec && !rec.linkedUserIds.includes(userId))
            rec.linkedUserIds.push(userId);
    }
    /** Append a hospital visit. */
    addVisit(patientId, hospitalId, reason, recordedBy) {
        const rec = this.patients.get(patientId);
        if (!rec)
            return null;
        const visit = {
            visitId: `vis-${newOpaqueToken().slice(0, 12)}`,
            patientId,
            hospitalId,
            visitedAt: new Date().toISOString(),
            reason,
            recordedBy,
        };
        this.visits.get(patientId)?.push(visit);
        return visit;
    }
    visitsOf(patientId) {
        return [...(this.visits.get(patientId) ?? [])].sort((a, b) => b.visitedAt.localeCompare(a.visitedAt));
    }
    /** Full change history (oldest first). */
    historyOf(patientId) {
        return [...(this.history.get(patientId) ?? [])];
    }
    /** Patients who visited a hospital. */
    patientsAtHospital(hospitalId) {
        const out = [];
        for (const p of this.patients.values()) {
            const vs = (this.visits.get(p.patientId) ?? []).filter((v) => v.hospitalId === hospitalId);
            if (vs.length > 0) {
                out.push({ ...p, lastVisitAt: vs[vs.length - 1].visitedAt });
            }
        }
        return out;
    }
    block(patientId, changedBy, reason, changes) {
        const blk = {
            seq: this.nextChangeSeq++,
            patientId,
            changedBy,
            changedAt: new Date().toISOString(),
            reason,
            changes,
        };
        this.history.get(patientId)?.push(blk);
        return blk;
    }
}
//# sourceMappingURL=patients.js.map