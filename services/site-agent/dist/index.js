import express from 'express';
import helmet from 'helmet';
import { errorHandler, internalKeyGuard, requestLogger, sanitizeBody, } from '@hc/shared';
import { retryWithBackoff, SiteCache, EpochGatedEvaluator } from '@hc/shared';
import { loadSiteAgentState, persistSiteAgentState } from './persistence.js';
const SITE_ID = process.env.SITE_ID ?? 'site-a';
const PORT = Number(process.env.PORT ?? 4101);
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? 'http://localhost:4002';
const CENTRAL_URL = process.env.CENTRAL_URL ?? 'http://localhost:4001';
const INTERNAL_KEY = process.env.INTERNAL_KEY ?? 'dev-internal-key';
const cache = new SiteCache();
const evaluator = new EpochGatedEvaluator();
const results = new Map();
loadSiteAgentState(cache, evaluator);
// ── Live event fan-out ────────────────────────────────────────────────────────
const liveClients = new Set();
function broadcast(e) {
    const msg = JSON.stringify(e);
    for (const c of liveClients)
        if (c.readyState === 1)
            c.send(msg);
}
/** ACK watermark to coordinator with backoff+jitter (PRD §7.1). */
async function ackWatermark() {
    const outcome = await retryWithBackoff(() => fetch(`${COORDINATOR_URL}/internal/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
        body: JSON.stringify({ siteId: SITE_ID, watermarkSeq: cache.getWatermark() }),
        signal: AbortSignal.timeout(3000),
    }).then((r) => {
        if (!r.ok)
            throw new Error(`coordinator HTTP ${r.status}`);
        return r.json();
    }), { maxAttempts: 6, baseMs: 300, maxDelayMs: 5000 });
    if (outcome.ok) {
        const { epoch } = outcome.value;
        if (evaluator.setEpoch(epoch.epochSeq))
            persistSiteAgentState(cache, evaluator);
    }
}
// ── HTTP API ──────────────────────────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(express.json({ limit: '64kb' }));
app.use(requestLogger());
app.use(sanitizeBody);
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'site-agent', siteId: SITE_ID }));
// All /internal routes are service-to-service: guarded by the shared internal key.
app.use('/internal', internalKeyGuard(INTERNAL_KEY));
// Central service pushes new rule versions here (through simulated network).
app.post('/internal/push', (req, res) => {
    const { ruleVersion } = req.body ?? {};
    if (!ruleVersion?.ruleId || typeof ruleVersion.globalSeq !== 'number') {
        res.status(400).json({ error: 'ruleVersion required' });
        return;
    }
    const { isNew, watermark } = cache.ingest(ruleVersion);
    if (isNew) {
        persistSiteAgentState(cache, evaluator);
        broadcast({ type: 'WATERMARK', data: { siteId: SITE_ID, watermarkSeq: watermark }, ts: new Date().toISOString() });
        void ackWatermark();
    }
    res.json({ ok: true, watermark });
});
// Evaluate an order (called by the demo driver / dashboard via central proxy).
// orderEpoch is the barrier-read epoch stamped at submission — all sites
// evaluate this order at exactly that epoch.
app.post('/internal/evaluate', (req, res) => {
    const { order, orderEpoch, siteId } = req.body ?? {};
    if (!order?.orderCode || !Array.isArray(order?.details?.drugs)) {
        res.status(400).json({ error: 'order.orderCode and order.details.drugs[] required' });
        return;
    }
    const clinicalOrder = {
        orderId: String(order.orderId ?? `ord-${Date.now()}`),
        siteId: typeof siteId === 'string' && siteId ? siteId : SITE_ID,
        orderCode: String(order.orderCode),
        patientRef: String(order.patientRef ?? 'patient-unknown'),
        submittedAt: new Date().toISOString(),
        details: order.details,
    };
    const result = evaluator.evaluate(clinicalOrder, cache, Number(orderEpoch ?? 0));
    const list = results.get(clinicalOrder.orderId) ?? [];
    list.push(result);
    results.set(clinicalOrder.orderId, list);
    broadcast({ type: 'ALERT_RESULT', data: { ...result }, ts: new Date().toISOString() });
    res.json(result);
});
app.get('/internal/state', (_req, res) => {
    res.json({
        siteId: SITE_ID,
        watermark: cache.getWatermark(),
        knownEpoch: evaluator.getKnownEpoch(),
    });
});
app.get('/internal/results/:orderId', (req, res) => {
    res.json(results.get(req.params.orderId) ?? []);
});
app.use(errorHandler(`site-agent ${SITE_ID}`));
const server = app.listen(PORT, () => {
    console.log(`[site-agent] ${SITE_ID} listening on :${PORT}`);
});
// ── WebSocket: subscribe to coordinator epoch updates ─────────────────────────
const { WebSocket } = await import('ws');
let epochWs = null;
function connectEpochSubscription() {
    const url = `${COORDINATOR_URL.replace(/^http/, 'ws')}/ws/epoch?key=${encodeURIComponent(INTERNAL_KEY)}`;
    epochWs = new WebSocket(url);
    epochWs.on('open', () => console.log(`[site-agent ${SITE_ID}] subscribed to epoch updates`));
    epochWs.on('message', (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            if (msg.kind === 'EPOCH_UPDATE' && typeof msg.epochSeq === 'number') {
                if (evaluator.setEpoch(msg.epochSeq))
                    persistSiteAgentState(cache, evaluator);
            }
        }
        catch {
            /* ignore malformed */
        }
    });
    epochWs.on('error', () => { });
    epochWs.on('close', () => {
        // Poll fallback with backoff+jitter when pub/sub is down (PRD §7.1)
        setTimeout(connectEpochSubscription, 2000 + Math.random() * 2000);
    });
}
connectEpochSubscription();
// Periodic epoch poll as defense-in-depth (catches missed pub/sub messages)
setInterval(() => {
    void (async () => {
        try {
            const res = await fetch(`${COORDINATOR_URL}/internal/epoch`, {
                headers: { 'x-internal-key': INTERNAL_KEY },
                signal: AbortSignal.timeout(2000),
            });
            if (res.ok) {
                const { epochSeq } = (await res.json());
                if (evaluator.setEpoch(epochSeq))
                    persistSiteAgentState(cache, evaluator);
            }
        }
        catch {
            /* coordinator unreachable — keep last known epoch */
        }
    })();
}, 1500);
// Initial ACK so the coordinator knows this site exists (watermark 0)
void ackWatermark();
// (Evaluations are ledgered by the central service at evaluation time —
// the old batched reporter here re-sent the same results every 2s, which
// duplicated ORDER_EVALUATED ledger entries.)
// ── WebSocket for dashboard ───────────────────────────────────────────────────
const { WebSocketServer } = await import('ws');
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
    liveClients.add(ws);
    ws.on('close', () => liveClients.delete(ws));
});
//# sourceMappingURL=index.js.map