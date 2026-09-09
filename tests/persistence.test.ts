import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const tempDir = mkdtempSync(join(process.cwd(), '.tmp-persistence-'));
process.env.DATA_DIR = tempDir;

const { CentralStore } = await import('../services/central-reference-service/dist/store.js');
const { UserStore } = await import('../services/central-reference-service/dist/users.js');
const { PatientStore } = await import('../services/central-reference-service/dist/patients.js');
const { loadDomainSnapshot, persistDomainSnapshot } = await import('../services/central-reference-service/dist/persistence.js');

after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('central domain snapshot persistence', () => {
  it('round-trips central, user, and patient state atomically', () => {
    const central = new CentralStore();
    const users = new UserStore([]);
    const patients = new PatientStore();

    const rule = central.publish('interaction', { drugA: 'a', drugB: 'b', severity: 'SEVERE' });
    central.registerSite({ siteId: 'site-a', baseLatencyMs: 10, jitterMs: 2, dropRate: 0, host: 'localhost', port: 4101 });
    const user = users.create('user@example.test', 'password123', 'viewer');
    const patient = patients.create({
      patientRef: 'P-000001',
      firstName: 'A',
      lastName: 'B',
      dob: '2000-01-01',
      gender: 'female',
      disease: 'demo',
      drugs: [],
    }, 'patient@example.test', null);

    const snapshot = {
      version: 1 as const,
      savedAt: new Date().toISOString(),
      central: central.snapshot(),
      users: users.snapshot(),
      patients: patients.snapshot(),
    };
    persistDomainSnapshot(snapshot);
    const restored = loadDomainSnapshot();

    assert.ok(restored);
    const restoredCentral = new CentralStore();
    restoredCentral.restore(restored.central);
    const restoredUsers = new UserStore([]);
    restoredUsers.restoreUsers(restored.users);
    const restoredPatients = new PatientStore();
    restoredPatients.restore(restored.patients);

    assert.deepEqual(restoredCentral.allRules(), [rule]);
    assert.equal(restoredCentral.getSite('site-a')?.port, 4101);
    assert.equal(restoredUsers.authenticate('user@example.test', 'password123')?.userId, user.userId);
    assert.equal(restoredPatients.get(patient.patientId)?.data.patientRef, 'P-000001');
  });
});
