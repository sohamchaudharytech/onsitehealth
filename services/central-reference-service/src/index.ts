import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import {
  contentHashOf,
  HashChainLedger,
  jwtAuth,
  requestLogger,
  requirePermission,
  sanitizeBody,
  SlidingWindowLimiter,
  defaultRateLimitRules,
  internalKeyGuard,
  errorHandler,
  signJwt,
  verifyJwt,
  type AlertResult,
  type LiveEvent,
  type ReferenceRuleVersion,
} from '@hc/shared';
import { CentralStore, type SiteRecord } from './store.js';
import { pushToSite } from './pusher.js';
import { UserStore } from './users.js';

const PORT = Number(process.env.PORT ?? 4001);
const SITE_HOSTS = (process.env.SITE_HOSTS ?? 'localhost:4101,localhost:4102,localhost:4103')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? 'http://localhost:4002';

// Secrets: default to fixed dev values so the demo runs with zero setup;
// production would inject these via env/secret manager.
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';
const INTERNAL_KEY = process.env.INTERNAL_KEY ?? 'dev-internal-key';
const ACCESS_TOKEN_TTL_SEC = 15 * 60; // short-lived (PRD §7.4)

const store = new CentralStore();
const ledger = new HashChainLedger();

// Demo users — one per RBAC role so every permission row is demonstrable.
const users = new UserStore([
  { userId: 'user-admin', username: 'admin', password: 'admin123', role: 'admin' },
  { userId: 'user-operator', username: 'operator', password: 'operator123', role: 'operator' },
  { userId: 'user-auditor', username: 'auditor', password: 'auditor123', role: 'auditor' },
  { userId: 'user-viewer', username: 'viewer', password: 'viewer123', role: 'viewer' },
]);

// ── Live event fan-out (dashboard WebSocket clients) ─────────────────────────
const liveClients = new Set<import('ws').WebSocket>();
function broadcast(e: LiveEvent): void {
  const msg = JSON.stringify(e);
  for (const c of liveClients) if (c.readyState === 1) c.send(msg);
}

/** Barrier read: fetch the current global active epoch from the coordinator. */
async function currentEpoch(): Promise<number> {
  try {
    const res = await fetch(`${COORDINATOR_URL}/internal/epoch`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
      signal: AbortSignal.timeout(2000),
    });
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

// ── Middleware pipeline (PRD §7.7, fixed order) ───────────────────────────────
// helmet → cors → json body-parser (size-capped) → request-id/logger
//   → rate limiter → sanitize → [JWT auth → RBAC per route] → handler
//   → centralized error handler
const limiter = new SlidingWindowLimiter(defaultRateLimitRules());

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(requestLogger());
app.use(limiter.middleware());
app.use(sanitizeBody);

// ── Auth routes (public; rate-limited tightly) ────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'central-reference-service' }));
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'username and password required' });
    return;
  }
  const user = users.authenticate(username, password);
  if (!user) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  const accessToken = signJwt(
    { userId: user.userId, username: user.username, role: user.role },
    JWT_SECRET,
    ACCESS_TOKEN_TTL_SEC,
  );
  const refreshToken = users.issueRefreshToken(user.userId);
  res.json({ accessToken, refreshToken, expiresInSec: ACCESS_TOKEN_TTL_SEC, role: user.role, username: user.username });
});

app.post('/api/auth/refresh', (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'refreshToken required' });
    return;
  }
  const rotated = users.rotateRefreshToken(refreshToken);
  if (!rotated) {
    res.status(401).json({ error: 'refresh token invalid, expired, or reused (family revoked)' });
    return;
  }
  const user = users.get(rotated.userId);
  if (!user) {
    res.status(401).json({ error: 'user no longer exists' });
    return;
  }
  const accessToken = signJwt(
    { userId: user.userId, username: user.username, role: user.role },
    JWT_SECRET,
    ACCESS_TOKEN_TTL_SEC,
  );
  res.json({ accessToken, refreshToken: rotated.newToken, expiresInSec: ACCESS_TOKEN_TTL_SEC, role: user.role, username: user.username });
});

app.post('/api/auth/logout', jwtAuth(JWT_SECRET), (req, res) => {
  const userId = req.user!.userId;
  users.revokeAllForUser(userId);
  res.json({ ok: true, revoked: 'all refresh tokens for user' });
});

// ── Everything below requires a valid JWT ─────────────────────────────────────
// Exception: /internal/* service-to-service routes skip JWT and are guarded
// per-route by internalKeyGuard (shared secret provisioned to site agents
// and the coordinator — a different trust domain from dashboard users).
app.use((req, res, next) => {
  if (req.path.startsWith('/internal/')) {
    next();
    return;
  }
  jwtAuth(JWT_SECRET)(req, res, next);
});

// ── Reference rules ──────────────────────────────────────────────────────────
app.post('/api/reference/rules', requirePermission('reference:publish'), (req, res) => {
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

app.patch('/api/sites/:siteId/network', requirePermission('sites:manage'), (req, res) => {
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
app.get('/api/audit', requirePermission('audit:view'), (req, res) => {
  const offset = Number(req.query.offset ?? 0);
  const limit = Math.min(200, Number(req.query.limit ?? 50));
  res.json(ledger.page(offset, limit));
});

app.get('/api/audit/verify', requirePermission('audit:view'), (_req, res) => {
  res.json(ledger.verify());
});

// ── Users (admin only) ───────────────────────────────────────────────────────────────────────────────
app.get('/api/users', requirePermission('users:manage'), (_req, res) => {
  res.json(users.list());
});

app.post('/api/users', requirePermission('users:manage'), (req, res) => {
  const { username, password, role } = req.body ?? {};
  const ROLES = ['admin', 'operator', 'auditor', 'viewer'];
  if (
    typeof username !== 'string' || !username.trim() ||
    typeof password !== 'string' || password.length < 8 ||
    !ROLES.includes(role)
  ) {
    res.status(400).json({ error: `username, password (min 8 chars), role in ${ROLES.join('/')} required` });
    return;
  }
  const user = users.create(username.trim(), password, role);
  res.status(201).json({ userId: user.userId, username: user.username, role: user.role });
});

// ── Internal: coordinator notifies epoch advance (ledger entry) ─────────────────────────────────────
// Service-to-service routes use the shared internal key, not JWT.
app.post('/internal/epoch-advanced', internalKeyGuard(INTERNAL_KEY), (req, res) => {
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
app.post('/internal/evaluations', internalKeyGuard(INTERNAL_KEY), (req, res) => {
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
app.post('/api/orders', requirePermission('orders:submit'), async (req, res) => {
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
          headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
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
          headers: { 'x-internal-key': INTERNAL_KEY },
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

// ── Health (public — no auth, for orchestration probes) ───────────────────────
// (registered above, before jwtAuth)

// ── Centralized error handler (never leaks stack traces) ─────────────────────
app.use(errorHandler('central'));

const server = app.listen(PORT, () => {
  console.log(`[central-reference-service] listening on :${PORT}`);
  console.log(`[central-reference-service] sites registered: ${store.listSites().map((s) => s.siteId).join(', ')}`);
});

// ── WebSocket for live dashboard events (JWT via query param) ────────────────────
const { WebSocketServer } = await import('ws');
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const token = url.searchParams.get('token') ?? '';
  if (!verifyJwt(token, JWT_SECRET)) {
    ws.close(4001, 'invalid token');
    return;
  }
  liveClients.add(ws);
  ws.on('close', () => liveClients.delete(ws));
});
