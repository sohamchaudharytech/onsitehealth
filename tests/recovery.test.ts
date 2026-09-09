import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const tempDir = mkdtempSync(join(process.cwd(), '.tmp-recovery-'));
const coordinatorStatePath = join(tempDir, 'coordinator-state.json');
const siteStatePath = join(tempDir, 'site-a-state.json');
process.env.STATE_PATH = coordinatorStatePath;

const { EpochGatedEvaluator, SiteCache } = await import('../shared/dist/index.js');
const { CoordinatorState } = await import('../services/convergence-coordinator/dist/state.js');
const {
  loadCoordinatorState,
  persistCoordinatorState,
} = await import('../services/convergence-coordinator/dist/persistence.js');
const {
  loadSiteAgentState,
  persistSiteAgentState,
} = await import('../services/site-agent/dist/persistence.js');

after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('coordinator and site restart recovery', () => {
  it('restores watermarks, epoch, rule history, and the last known epoch', async () => {
    const coordinator = new CoordinatorState();
    coordinator.ack({ siteId: 'site-b', watermarkSeq: 3, lastAckAt: '2026-09-09T00:00:01Z' });
    coordinator.ack({ siteId: 'site-a', watermarkSeq: 4, lastAckAt: '2026-09-09T00:00:00Z' });
    const coordinatorBefore = coordinator.snapshot();
    persistCoordinatorState(coordinator);

    const restoredCoordinator = new CoordinatorState();
    loadCoordinatorState(restoredCoordinator);
    assert.deepEqual(restoredCoordinator.snapshot(), coordinatorBefore);
    assert.equal(restoredCoordinator.getEpoch().epochSeq, 3);

    const siteCache = new SiteCache();
    siteCache.ingest({
      ruleId: 'interaction',
      version: 1,
      globalSeq: 1,
      payload: { drugA: 'warfarin', drugB: 'aspirin', severity: 'NONE' },
      contentHash: 'hash-1',
      createdAt: '2026-09-09T00:00:00Z',
    });
    siteCache.ingest({
      ruleId: 'interaction',
      version: 2,
      globalSeq: 4,
      payload: { drugA: 'warfarin', drugB: 'aspirin', severity: 'SEVERE' },
      contentHash: 'hash-4',
      createdAt: '2026-09-09T00:00:02Z',
    });
    const evaluator = new EpochGatedEvaluator();
    evaluator.setEpoch(3);

    process.env.STATE_PATH = siteStatePath;
    persistSiteAgentState(siteCache, evaluator);

    const restoredCache = new SiteCache();
    const restoredEvaluator = new EpochGatedEvaluator();
    loadSiteAgentState(restoredCache, restoredEvaluator);
    assert.equal(restoredCache.getWatermark(), 4);
    assert.equal(restoredEvaluator.getKnownEpoch(), 3);
    assert.equal(
      restoredCache.snapshotAsOf(3).rules.interaction?.payload.severity,
      'NONE',
    );
    assert.equal(
      restoredCache.snapshotAsOf(4).rules.interaction?.payload.severity,
      'SEVERE',
    );
  });
});
