import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const tempDir = mkdtempSync(join(process.cwd(), '.tmp-logistics-recovery-'));
process.env.STATE_PATH = join(tempDir, 'logistics.json');

const { HashChainLedger } = await import('../services/logistics-service/dist/ledger.js');
const { ShipmentStore } = await import('../services/logistics-service/dist/store.js');
const { UserStore } = await import('../services/logistics-service/dist/users.js');
const {
  loadLogisticsState,
  persistLogisticsState,
} = await import('../services/logistics-service/dist/persistence.js');

after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('logistics restart recovery', () => {
  it('restores shipments, users, refresh tokens, and the audit ledger', () => {
    const shipments = new ShipmentStore();
    const users = new UserStore([
      { userId: 'u-admin', username: 'admin', password: 'admin123', role: 'admin' },
    ]);
    const ledger = new HashChainLedger();
    const shipment = shipments.create({
      orderCode: 'RX-2026-0001',
      drugName: 'Insulin',
      quantity: 40,
      coldChain: true,
      origin: { name: 'Origin', lat: 19.076, lng: 72.8777 },
      destination: { name: 'Destination', lat: 19.172, lng: 72.957 },
      createdBy: { userId: 'u-admin', username: 'admin', role: 'admin' },
    });
    const refreshToken = users.issueRefreshToken('u-admin');
    ledger.append('SHIPMENT_CREATED', { shipmentId: shipment.shipmentId });

    persistLogisticsState({
      shipments: shipments.snapshot(),
      users: users.snapshot(),
      ledger: ledger.snapshot(),
      demoSeq: 7,
    });

    const restoredShipments = new ShipmentStore();
    const restoredUsers = new UserStore([]);
    const restoredLedger = new HashChainLedger();
    const snapshot = loadLogisticsState(restoredShipments, restoredUsers, restoredLedger);

    assert.ok(snapshot);
    assert.equal(snapshot.demoSeq, 7);
    assert.equal(restoredShipments.getByOrderCode('RX-2026-0001')?.drugName, 'Insulin');
    assert.equal(restoredUsers.get('u-admin')?.username, 'admin');
    assert.equal(restoredUsers.rotateRefreshToken(refreshToken)?.userId, 'u-admin');
    assert.equal(restoredLedger.verify().valid, true);
    assert.equal(restoredLedger.page(0, 1).blocks[0]?.eventType, 'SHIPMENT_CREATED');
  });
});
