import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EpochGatedEvaluator, HashChainLedger, SiteCache } from '../shared/dist/index.js';
import type { ClinicalOrder, ReferenceRuleVersion } from '../shared/dist/index.js';
import { CoordinatorState } from '../services/convergence-coordinator/dist/state.js';

function rule(ruleId: string, globalSeq: number, severity: string): ReferenceRuleVersion {
  return {
    ruleId,
    version: globalSeq,
    globalSeq,
    payload: { drugA: 'warfarin', drugB: 'aspirin', severity },
    contentHash: `hash-${globalSeq}`,
    createdAt: new Date(0).toISOString(),
  };
}

const order: ClinicalOrder = {
  orderId: 'order-1',
  siteId: 'site-a',
  orderCode: 'RX-1',
  patientRef: 'patient-1',
  submittedAt: new Date(0).toISOString(),
  details: { drugs: ['warfarin', 'aspirin'] },
};

describe('SiteCache', () => {
  it('reconstructs the exact snapshot at a stamped epoch', () => {
    const cache = new SiteCache();
    cache.ingest(rule('interaction', 1, 'NONE'));
    cache.ingest(rule('interaction', 2, 'SEVERE'));

    assert.equal(cache.getWatermark(), 2);
    const snapshot = cache.snapshotAsOf(1);
    assert.deepEqual(Object.keys(snapshot.rules), ['interaction']);
    assert.equal(snapshot.asOfGlobalSeq, 1);
    assert.equal(snapshot.rules.interaction!.payload.severity, 'NONE');
  });

  it('ingests each global sequence once and prunes old versions', () => {
    const cache = new SiteCache();
    cache.ingest(rule('interaction', 1, 'NONE'));
    assert.equal(cache.ingest(rule('interaction', 1, 'NONE')).isNew, false);
    cache.ingest(rule('interaction', 2, 'LOW'));
    cache.prune(1);
    assert.deepEqual(cache.snapshotAsOf(0), { asOfGlobalSeq: 0, rules: {} });
    assert.equal(cache.snapshotAsOf(2).rules.interaction!.payload.severity, 'LOW');
  });
});

describe('EpochGatedEvaluator', () => {
  it('evaluates the stamped epoch even when a site has cached ahead', () => {
    const cache = new SiteCache();
    cache.ingest(rule('interaction', 1, 'NONE'));
    const result = new EpochGatedEvaluator().evaluate(order, cache, 1);
    assert.equal(result.epochUsed, 1);
    assert.equal(result.watermarkAtEval, 1);
    assert.equal(result.fires, false);

    cache.ingest(rule('interaction', 2, 'SEVERE'));
    const gated = new EpochGatedEvaluator().evaluate(order, cache, 1);
    assert.equal(gated.epochUsed, 1);
    assert.equal(gated.watermarkAtEval, 2);
    assert.equal(gated.severity, 'NONE');
  });

  it('marks a missing stamped epoch provisional and never suppresses', () => {
    const cache = new SiteCache();
    cache.ingest(rule('interaction', 2, 'SEVERE'));
    const result = new EpochGatedEvaluator().evaluate(order, cache, 3);
    assert.equal(result.epochUsed, 3);
    assert.equal(result.watermarkAtEval, 2);
    assert.equal(result.provisional, true);
    assert.equal(result.severity, 'SEVERE');
  });
});

describe('CoordinatorState', () => {
  it('advances only at the minimum watermark and never regresses', () => {
    const state = new CoordinatorState();
    assert.equal(state.ack({ siteId: 'site-a', watermarkSeq: 2, lastAckAt: '1' }).epoch.epochSeq, 2);
    assert.equal(state.ack({ siteId: 'site-b', watermarkSeq: 1, lastAckAt: '1' }).advanced, false);
    assert.equal(state.getEpoch().epochSeq, 2);

    assert.equal(state.ack({ siteId: 'site-b', watermarkSeq: 3, lastAckAt: '1' }).advanced, false);
    const advanced = state.ack({ siteId: 'site-a', watermarkSeq: 3, lastAckAt: '1' });
    assert.equal(advanced.advanced, true);
    assert.equal(advanced.epoch.epochSeq, 3);

    state.removeSite('site-b');
    state.ack({ siteId: 'site-b', watermarkSeq: 1, lastAckAt: '1' });
    assert.equal(state.getEpoch().epochSeq, 3);
  });
});

describe('HashChainLedger', () => {
  it('detects a modified block', () => {
    const ledger = new HashChainLedger();
    ledger.append('REFDATA_PUBLISHED', { ruleId: 'x' });
    const first = ledger.page(0, 1).blocks[0];
    first.payload.ruleId = 'tampered';

    assert.equal(ledger.verify().valid, false);
  });
});
