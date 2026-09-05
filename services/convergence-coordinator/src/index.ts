import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import {
  errorHandler,
  internalKeyGuard,
  jwtAuth,
  requestLogger,
  sanitizeBody,
  SlidingWindowLimiter,
  defaultRateLimitRules,
  verifyJwt,
  type GlobalEpoch,
  type LiveEvent,
  type SiteWatermark,
} from '@hc/shared';
import { CoordinatorState } from './state.js';

const PORT = Number(process.env.PORT ?? 4002);
const CENTRAL_URL = process.env.CENTRAL_URL ?? 'http://localhost:4001';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';
const INTERNAL_KEY = process.env.INTERNAL_KEY ?? 'dev-internal-key';

const state = new CoordinatorState();

// ── Live event fan-out ────────────────────────────────────────────────────────
const liveClients = new Set<import('ws').WebSocket>();
function broadcast(e: LiveEvent): void {
  const msg = JSON.stringify(e);
  for (const c of liveClients) if (c.readyState === 1) c.send(msg);
}

/** Notify the central service so it can append EPOCH_ADVANCED to the ledger. */
async function notifyCentralOfEpoch(epoch: GlobalEpoch): Promise<void> {
  try {
    await fetch(`${CENTRAL_URL}/internal/epoch-advanced`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
      body: JSON.stringify(epoch),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // central down — epoch still advances locally; ledger entry will be missed
  }
}

state.setOnChange(async (epoch) => {
  broadcast({ type: 'EPOCH', data: { ...epoch }, ts: new Date().toISOString() });
  broadcastEpoch(epoch);
  await notifyCentralOfEpoch(epoch);
});

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(requestLogger());
app.use(new SlidingWindowLimiter(defaultRateLimitRules()).middleware());
app.use(sanitizeBody);

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'convergence-coordinator' }));

// Sites ACK their watermark here (with backoff+jitter on the site side).
// Service-to-service: guarded by the shared internal key, not JWT.
app.post('/internal/ack', internalKeyGuard(INTERNAL_KEY), (req, res) => {
  const { siteId, watermarkSeq } = req.body ?? {};
  if (typeof siteId !== 'string' || typeof watermarkSeq !== 'number') {
    res.status(400).json({ error: 'siteId and watermarkSeq required' });
    return;
  }
  const { advanced, epoch } = state.ack({
    siteId,
    watermarkSeq,
    lastAckAt: new Date().toISOString(),
  });
  broadcast({ type: 'WATERMARK', data: { siteId, watermarkSeq }, ts: new Date().toISOString() });
  res.json({ advanced, epoch });
});

// Service-to-service epoch read: central barrier-reads this before stamping
// orders; site agents poll it as a pub/sub fallback.
app.get('/internal/epoch', internalKeyGuard(INTERNAL_KEY), (_req, res) => {
  res.json(state.getEpoch());
});

// Public API: requires a valid JWT (dashboard users). Read-only state.
app.use(jwtAuth(JWT_SECRET));

app.get('/api/epoch', (_req, res) => {
  res.json(state.getEpoch());
});

app.get('/api/sites', (_req, res) => {
  res.json({ watermarks: state.getWatermarks(), epoch: state.getEpoch() });
});

// Dashboard-friendly alias: watermarks + epoch in one call.
app.get('/api/watermarks', (_req, res) => {
  res.json({ watermarks: state.getWatermarks(), epoch: state.getEpoch() });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'convergence-coordinator' }));

app.use(errorHandler('coordinator'));

const server = app.listen(PORT, () => {
  console.log(`[convergence-coordinator] listening on :${PORT}`);
});

// ── WebSocket: dashboard live events + epoch pub/sub (path-routed) ───────────
const { WebSocketServer } = await import('ws');
const wss = new WebSocketServer({ noServer: true });
const epochSubscribers = new Set<import('ws').WebSocket>();

wss.on('connection', (ws, req) => {
  if (req.url?.startsWith('/ws/epoch')) {
    // Site agents subscribe here — service-to-service, internal key via query param.
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.searchParams.get('key') !== INTERNAL_KEY) {
      ws.close(4001, 'invalid internal key');
      return;
    }
    epochSubscribers.add(ws);
    // Send current epoch immediately on subscribe
    ws.send(JSON.stringify({ kind: 'EPOCH_UPDATE', epochSeq: state.getEpoch().epochSeq, updatedAt: state.getEpoch().updatedAt }));
    ws.on('close', () => epochSubscribers.delete(ws));
  } else {
    // Dashboard live events — JWT via query param (browsers can't set WS headers).
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    if (!verifyJwt(token, JWT_SECRET)) {
      ws.close(4001, 'invalid token');
      return;
    }
    liveClients.add(ws);
    ws.on('close', () => liveClients.delete(ws));
  }
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function broadcastEpoch(epoch: GlobalEpoch): void {
  const msg = JSON.stringify({ kind: 'EPOCH_UPDATE', epochSeq: epoch.epochSeq, updatedAt: epoch.updatedAt });
  for (const c of epochSubscribers) if (c.readyState === 1) c.send(msg);
}
