import { newOpaqueToken } from '@hc/shared';
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
export class PatientStore {
  private patients = new Map<string, PatientRecord>();
  private byRef = new Map<string, string>();           // patientRef -> patientId
  private history = new Map<string, PatientChangeBlock[]>(); // patientId -> blocks
  private visits = new Map<string, PatientVisit[]>();  // patientId -> visits
  private nextChangeSeq = 1;
  private nextRefNum = 1;

  snapshot() {
    return {
      patients: [...this.patients.values()].map((patient) => ({ ...patient })),
      history: [...this.history.entries()].map(([patientId, blocks]) => ({ patientId, blocks })),
      visits: [...this.visits.entries()].map(([patientId, visits]) => ({ patientId, visits })),
      nextChangeSeq: this.nextChangeSeq,
      nextRefNum: this.nextRefNum,
    };
  }

  restore(snapshot: ReturnType<PatientStore['snapshot']>): void {
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
      if (this.patients.has(entry.patientId)) this.history.set(entry.patientId, [...entry.blocks]);
    }
    for (const entry of snapshot.visits) {
      if (this.patients.has(entry.patientId)) this.visits.set(entry.patientId, [...entry.visits]);
    }
    this.nextChangeSeq = Math.max(1, snapshot.nextChangeSeq);
    this.nextRefNum = Math.max(1, snapshot.nextRefNum);
  }

  /** Allocate the next human-readable id: P-000123 style, zero-padded to 6. */
  allocatePatientRef(): string {
    let n = this.nextRefNum++;
    return `P-${String(n).padStart(6, '0')}`;
  }

  /** Seed a pre-allocated ref (e.g. demo data) — bumps the counter past it. */
  seedRef(ref: string): void {
    const m = /^P-(\d+)$/.exec(ref);
    if (m) this.nextRefNum = Math.max(this.nextRefNum, Number(m[1]) + 1);
  }

  create(
    data: PatientData,
    email: string,
    createdBy: { userId: string; username: string; role: string } | null,
  ): PatientRecord {
    if (this.byRef.has(data.patientRef)) throw new Error(`patientRef '${data.patientRef}' already exists`);
    const patientId = `pat-${newOpaqueToken().slice(0, 12)}`;
    const rec: PatientRecord = {
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

  get(patientId: string): PatientRecord | null {
    return this.patients.get(patientId) ?? null;
  }

  getByRef(patientRef: string): PatientRecord | null {
    const id = this.byRef.get(patientRef);
    return id ? this.patients.get(id) ?? null : null;
  }

  getByEmail(email: string): PatientRecord | null {
    const needle = email.trim().toLowerCase();
    for (const p of this.patients.values()) {
      if (p.email.toLowerCase() === needle) return p;
    }
    return null;
  }

  list(): PatientRecord[] {
    return [...this.patients.values()].sort((a, b) => a.data.patientRef.localeCompare(b.data.patientRef));
  }

  /**
   * Patch patient fields. Returns the change block, or null if nothing changed.
   * NEVER mutates without appending history.
   */
  applyChange(
    patientId: string,
    fields: Partial<Record<keyof PatientData, unknown>>,
    changedBy: { userId: string; username: string; role: string } | null,
    reason: string,
  ): { rec: PatientRecord; block: PatientChangeBlock } | null {
    const rec = this.patients.get(patientId);
    if (!rec) return null;
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const next: PatientData = { ...rec.data };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const k = key as keyof PatientData;
      const before = rec.data[k];
      const after = value as never;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes[key] = { before, after };
        (next[k] as unknown) = value;
      }
    }
    // status/email are handled through dedicated methods; only PatientData here
    if (Object.keys(changes).length === 0) return null;
    const block: PatientChangeBlock = {
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
  setEmail(patientId: string, email: string, changedBy: { userId: string; username: string; role: string } | null, reason: string): PatientChangeBlock | null {
    const rec = this.patients.get(patientId);
    if (!rec || rec.email === email) return null;
    const block = this.block(patientId, changedBy, reason, { email: { before: rec.email, after: email } });
    rec.email = email;
    return block;
  }

  /** Deactivate — the only "delete": status flip, everything preserved. */
  deactivate(patientId: string, changedBy: { userId: string; username: string; role: string } | null, reason: string): { rec: PatientRecord; block: PatientChangeBlock } | null {
    const rec = this.patients.get(patientId);
    if (!rec || rec.status !== 'active') return null;
    const block = this.block(patientId, changedBy, reason, { status: { before: 'active', after: 'deactivated' } });
    rec.status = 'deactivated';
    return { rec, block };
  }

  reactivate(patientId: string, changedBy: { userId: string; username: string; role: string } | null, reason: string): { rec: PatientRecord; block: PatientChangeBlock } | null {
    const rec = this.patients.get(patientId);
    if (!rec || rec.status !== 'deactivated') return null;
    const block = this.block(patientId, changedBy, reason, { status: { before: 'deactivated', after: 'active' } });
    rec.status = 'active';
    return { rec, block };
  }

  linkUser(patientId: string, userId: string): void {
    const rec = this.patients.get(patientId);
    if (rec && !rec.linkedUserIds.includes(userId)) rec.linkedUserIds.push(userId);
  }

  /** Append a hospital visit. */
  addVisit(
    patientId: string,
    hospitalId: string,
    reason: string,
    recordedBy: { userId: string; username: string; role: string } | null,
  ): PatientVisit | null {
    const rec = this.patients.get(patientId);
    if (!rec) return null;
    const visit: PatientVisit = {
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

  visitsOf(patientId: string): PatientVisit[] {
    return [...(this.visits.get(patientId) ?? [])].sort((a, b) => b.visitedAt.localeCompare(a.visitedAt));
  }

  /** Full change history (oldest first). */
  historyOf(patientId: string): PatientChangeBlock[] {
    return [...(this.history.get(patientId) ?? [])];
  }

  /** Patients who visited a hospital. */
  patientsAtHospital(hospitalId: string): Array<PatientRecord & { lastVisitAt: string }> {
    const out: Array<PatientRecord & { lastVisitAt: string }> = [];
    for (const p of this.patients.values()) {
      const vs = (this.visits.get(p.patientId) ?? []).filter((v) => v.hospitalId === hospitalId);
      if (vs.length > 0) {
        out.push({ ...p, lastVisitAt: vs[vs.length - 1].visitedAt });
      }
    }
    return out;
  }

  private block(
    patientId: string,
    changedBy: { userId: string; username: string; role: string } | null,
    reason: string,
    changes: Record<string, { before: unknown; after: unknown }>,
  ): PatientChangeBlock {
    const blk: PatientChangeBlock = {
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
