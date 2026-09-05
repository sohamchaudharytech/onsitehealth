import express from 'express';
import {
  contentHashOf,
  HashChainLedger,
  type AlertResult,
  type LiveEvent,
  type ReferenceRuleVersion,
} from '@hc/shared';
import { CentralStore, type SiteRecord } from './store.js';
import { pushToSite } from './pusher.js';

const PORT = Number(process.env.PORT ?? 4001);
const SITE_HOSTS = (process.env.SITE_HOSTS ?? 'localhost:4101,localhost:4102,localhost:4103')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? 'http://localhost:4002';

const store = new CentralStore();
const ledger = new HashChainLedger();

// ── Live event fan-out (dashboard WebSocket clients) ─────────────────────────
const liveClients = new Set<import('ws').WebSocket>();
function broadcast(e: LiveEvent): void {
  const msg = JSON.stringify(e);
  for (const c of liveClients) if (c.readyState === 1) c.send(msg);
}

/** Barrier read: fetch the current global active epoch from the coordinator. */
async function currentEpoch(): Promise<number> {
  try {
    const res = await fetch(`${COORDINATOR_URL}/api/epoch`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const { epochSeq } = (await res.json()) as { epochSeq: number };
      return epochSeq;
    }
  } catch {
    /* coordinator unreachable — fall back to 0 (most conservative) */
  }
  return 0;
}

// ── Seed default sites ───────────────────────────────────────────────────────
const DEFAULT_PROFILES: Array<{ siteId: string; baseLatencyMs: number; jitterMs: number; dropRate: number }> = [
  { siteId: 'site-a', baseLatencyMs: 120, jitterMs: 40, dropRate: 0 },
  { siteId: 'site-b', baseLatencyMs: 120, jitterMs: 40, dropRate: 0 },
  { siteId: 'site-c', baseLatencyMs: 120, jitterMs: 40, dropRate: 0 },
];
for (const [i, p] of DEFAULT_PROFILES.entries()) {
  const host = SITE_HOSTS[i] ?? `localhost:${4101 + i}`;
  const [h, port] = host.split(':');
  store.registerSite({ ...p, host: h, port: Number(port) });
}

const app = express();
app.use(express.json({ limit: '256kb' }));

// ── Reference rules ──────────────────────────────────────────────────────────
app.post('/api/reference/rules', (req, res) => {
  const { ruleId, payload } = req.body ?? {};
  if (typeof ruleId !== 'string' || !ruleId.trim() || typeof payload !== 'object' || payload === null) {
    res.status(400).json({ error: 'ruleId (string) and payload (object) required' });
    return;
  }
  const rec = store.publish(ruleId, payload);
  rec.contentHash = contentHashOf(payload);
  ledger.append('REFDATA_PUBLISHED', {
    ruleId,
    version: rec.version,
    globalSeq: rec.globalSeq,
    contentHash: rec.contentHash,
    payload,
  });
  broadcast({ type: 'PUBLISH', data: { ruleId, version: rec.version, globalSeq: rec.globalSeq }, ts: new Date().toISOString() });

  // fire-and-forget fan-out to all sites through the simulated network
  for (const site of store.listSites()) {
    void pushToSite({ store, ledger, broadcast }, site, rec).then((outcome) => {
      if (outcome.delivered) {
        ledger.append('REFDATA_RECEIVED', {
          siteId: site.siteId,
          ruleId: rec.ruleId,
          globalSeq: rec.globalSeq,
          attempts: outcome.attempts,
        });
      }
    });
  }
  res.status(201).json(rec);
});

app.get('/api/reference/rules', (_req, res) => {
  res.json(store.allRules());
});

app.get('/api/reference/rules/:ruleId/history', (req, res) => {
  res.json(store.allVersions(req.params.ruleId));
});

// ── Sites & chaos controls ───────────────────────────────────────────────────
app.post('/api/sites', (req, res) => {
  const { siteId, baseLatencyMs, jitterMs, dropRate } = req.body ?? {};
  if (typeof siteId !== 'string' || !siteId.trim()) {
    res.status(400).json({ error: 'siteId required' });
    return;
  }
  const host = SITE_HOSTS[store.listSites().length] ?? `localhost:${4101 + store.listSites().length}`;
  const [h, port] = host.split(':');
  const profile: SiteRecord = {
    siteId,
    baseLatencyMs: Number(baseLatencyMs ?? 120),
    jitterMs: Number(jitterMs ?? 40),
    dropRate: Number(dropRate ?? 0),
    host: h,
    port: Number(port),
  };
  store.registerSite(profile);
  res.status(201).json(profile);
});

app.patch('/api/sites/:siteId/network', (req, res) => {
  const patch = req.body ?? {};
  const clean: Partial<SiteRecord> = {};
  if (patch.baseLatencyMs !== undefined) clean.baseLatencyMs = Math.max(0, Number(patch.baseLatencyMs));
  if (patch.jitterMs !== undefined) clean.jitterMs = Math.max(0, Number(patch.jitterMs));
  if (patch.dropRate !== undefined) clean.dropRate = Math.min(1, Math.max(0, Number(patch.dropRate)));
  const updated = store.updateSiteNetwork(req.params.siteId, clean);
  if (!updated) {
    res.status(404).json({ error: 'site not found' });
    return;
  }
  ledger.append('SITE_CHAOS_INJECTED', { siteId: updated.siteId, ...clean });
  broadcast({ type: 'CHAOS', data: { siteId: updated.siteId, ...clean }, ts: new Date().toISOString() });
  res.json(updated);
});

app.get('/api/sites', (_req, res) => {
  res.json(store.listSites());
});

// ── Audit ledger ─────────────────────────────────────────────────────────────
app.get('/api/audit', (req, res) => {
  const offset = Number(req.query.offset ?? 0);
  const limit = Math.min(200, Number(req.query.limit ?? 50));
  res.json(ledger.page(offset, limit));
});

app.get('/api/audit/verify', (_req, res) => {
  res.json(ledger.verify());
});

// ── Internal: coordinator notifies epoch advance (ledger entry) ─────────────
app.post('/internal/epoch-advanced', (req, res) => {
  const { epochSeq, updatedAt } = req.body ?? {};
  if (typeof epochSeq !== 'number') {
    res.status(400).json({ error: 'epochSeq required' });
    return;
  }
  ledger.append('EPOCH_ADVANCED', { epochSeq, updatedAt });
  broadcast({ type: 'EPOCH', data: { epochSeq, updatedAt }, ts: new Date().toISOString() });
  res.json({ ok: true });
});

// ── Internal: site agents report evaluations for the ledger ─────────────────
app.post('/internal/evaluations', (req, res) => {
  const { siteId, results } = req.body ?? {};
  if (typeof siteId !== 'string' || !Array.isArray(results)) {
    res.status(400).json({ error: 'siteId and results[] required' });
    return;
  }
  for (const r of results) {
    ledger.append('ORDER_EVALUATED', r as Record<string, unknown>);
  }
  res.json({ ok: true, recorded: results.length });
});

// ── Orders: barrier-read epoch once, fan out identical order ────────────────
app.post('/api/orders', async (req, res) => {
  const { orderCode, patientRef, details, siteIds } = req.body ?? {};
  if (typeof orderCode !== 'string' || !orderCode.trim() || !details || typeof details !== 'object') {
    res.status(400).json({ error: 'orderCode (string) and details (object) required' });
    return;
  }
  const sites = store.listSites().filter((s) => !siteIds || (siteIds as string[]).includes(s.siteId));
  if (sites.length === 0) {
    res.status(400).json({ error: 'no matching sites' });
    return;
  }

  // Barrier read: resolve the global active epoch ONCE for this order.
  // Every site evaluates this order at exactly this epoch — the snapshot
  // timestamp is fixed at submission, like a snapshot transaction.
  const orderEpoch = await currentEpoch();
  const orderId = `ord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const evaluations = await Promise.all(
    sites.map(async (site) => {
      try {
        const r = await fetch(`http://${site.host}:${site.port}/internal/evaluate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ order: { orderId, orderCode, patientRef, details }, orderEpoch }),
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) throw new Error(`site ${site.siteId} HTTP ${r.status}`);
        const result = (await r.json()) as AlertResult;
        ledger.append('ORDER_EVALUATED', { ...result });
        return result;
      } catch (err) {
        return {
          orderId,
          siteId: site.siteId,
          epochUsed: orderEpoch,
          watermarkAtEval: -1,
          fires: false,
          severity: 'NONE' as const,
          ruleId: null,
          provisional: false,
          evaluatedAt: new Date().toISOString(),
          error: String(err),
        };
      }
    }),
  );
  res.status(201).json({ orderId, orderEpoch, results: evaluations });
});

app.get('/api/orders/:orderId/results', async (req, res) => {
  const orderId = req.params.orderId;
  const sites = store.listSites();
  const perSite = await Promise.all(
    sites.map(async (site) => {
      try {
        const r = await fetch(`http://${site.host}:${site.port}/internal/results/${orderId}`, {
          signal: AbortSignal.timeout(2000),
        });
        return (await r.json()) as AlertResult[];
      } catch {
        return [];
      }
    }),
  );
  res.json(perSite.flat());
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'central-reference-service' }));

// ── Centralized error handler (never leaks stack traces) ─────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[central] unhandled error:', err.message);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(PORT, () => {
  console.log(`[central-reference-service] listening on :${PORT}`);
  console.log(`[central-reference-service] sites registered: ${store.listSites().map((s) => s.siteId).join(', ')}`);
});

// ── WebSocket for live dashboard events ───────────────────────────────────────
const { WebSocketServer } = await import('ws');
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  liveClients.add(ws);
  ws.on('close', () => liveClients.delete(ws));
});
