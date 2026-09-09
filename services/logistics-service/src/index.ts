import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import {
  defaultRateLimitRules,
  errorHandler,
  internalKeyGuard,
  jwtAuth,
  requestLogger,
  requirePermission,
  sanitizeBody,
  signJwt,
  SlidingWindowLimiter,
  verifyJwt,
} from '@hc/shared';
import { ShipmentStore, haversine } from './store.js';
import { UserStore } from './users.js';
import { HashChainLedger } from './ledger.js';
import { loadLogisticsState, persistLogisticsState } from './persistence.js';
import { advanceProgress, etaMinutes, fractionAlong, interpolate } from './sim.js';
import type { GeoPoint, LogisticsLiveEvent, Shipment, ShipmentStatus } from './types.js';

const PORT = Number(process.env.PORT ?? 4301);
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';
const INTERNAL_KEY = process.env.INTERNAL_KEY ?? 'dev-internal-key';
const ACCESS_TOKEN_TTL_SEC = 15 * 60;
const SIM_TICK_MS = Number(process.env.SIM_TICK_MS ?? 2000);
const SIM_SPEED = Number(process.env.SIM_SPEED ?? 0.035); // ~3.5% of route per tick

// ── Stores ───────────────────────────────────────────────────────────────────
const shipments = new ShipmentStore();
const users = new UserStore([
  { userId: 'u-admin', username: 'admin', password: 'admin123', role: 'admin', fullName: 'Logistics Admin' },
  { userId: 'u-dispatch', username: 'dispatcher', password: 'dispatcher123', role: 'operator', fullName: 'Dispatch Operator' },
  { userId: 'u-driver', username: 'driver', password: 'driver123', role: 'operator', fullName: 'Courier' },
  { userId: 'u-audit', username: 'auditor', password: 'auditor123', role: 'auditor', fullName: 'Compliance Auditor' },
  { userId: 'u-view', username: 'viewer', password: 'viewer123', role: 'viewer', fullName: 'Hospital Pharmacist' },
]);
const ledger = new HashChainLedger();
let demoSeq = 0;

function saveState(): void {
  persistLogisticsState({
    shipments: shipments.snapshot(),
    users: users.snapshot(),
    ledger: ledger.snapshot(),
    demoSeq,
  });
}

// ── Live event fan-out (WebSocket) ────────────────────────────────────────────
const liveClients = new Set<import('ws').WebSocket>();
function broadcast(e: LogisticsLiveEvent): void {
  const msg = JSON.stringify(e);
  for (const c of liveClients) if (c.readyState === 1) c.send(msg);
}

// ── Seed demo shipments so the dashboard is alive on first load ──────────────
function seedShipments(): void {
  const now = Date.now();
  const mk = (
    orderCode: string,
    drugName: string,
    quantity: number,
    coldChain: boolean,
    origin: [string, number, number],
    destination: [string, number, number],
    status: ShipmentStatus,
    minutesAgo: number,
  ) => {
    const s = shipments.create({
      orderCode,
      drugName,
      quantity,
      coldChain,
      origin: { name: origin[0], lat: origin[1], lng: origin[2] },
      destination: { name: destination[0], lat: destination[1], lng: destination[2] },
      createdBy: { userId: 'u-admin', username: 'admin', role: 'admin' },
    });
    // backdate creation so the trail looks organic
    s.createdAt = new Date(now - minutesAgo * 60_000).toISOString();
    if (status !== 'NOT_SENT') {
      const from = shipments.transition(s.shipmentId, 'IN_TRANSIT', null);
      if (from) from.shipment.lastEvent = null; // seed quietly
      if (status === 'DELIVERED') {
        const d = shipments.transition(s.shipmentId, 'DELIVERED', null);
        if (d) d.shipment.lastEvent = null;
      }
    }
    return s;
  };

  mk('RX-2026-0001', 'Insulin (cold chain)', 40, true, ['Central Pharmacy, Mumbai', 19.076, 72.8777], ['Fortis Hospital, Mulund', 19.172, 72.957], 'IN_TRANSIT', 42);
  mk('RX-2026-0002', 'Warfarin 5mg', 200, false, ['Central Pharmacy, Mumbai', 19.076, 72.8777], ['Lilavati Hospital, Bandra', 19.050, 72.830], 'IN_TRANSIT', 25);
  mk('RX-2026-0003', 'COVID-19 Vaccine', 500, true, ['Airport Cold Hub', 19.089, 72.8656], ['KEM Hospital, Parel', 18.997, 72.842], 'IN_TRANSIT', 8);
  mk('RX-2026-0004', 'Morphine 10mg', 60, false, ['Central Pharmacy, Mumbai', 19.076, 72.8777], ['Tata Memorial, Parel', 18.997, 72.842], 'NOT_SENT', 3);
  mk('RX-2026-0005', 'Amoxicillin 500mg', 1000, false, ['Central Pharmacy, Mumbai', 19.076, 72.8777], ['Nanavati Hospital, Vile Parle', 19.102, 72.840], 'DELIVERED', 120);
  // Stagger the three in-transit seeds at different points of their routes
  // so the map shows movement at different stages immediately.
  for (const [code, fraction] of [['RX-2026-0001', 0.15], ['RX-2026-0002', 0.45], ['RX-2026-0003', 0.75]] as const) {
    const s = shipments.getByOrderCode(code);
    if (s) {
      const p = interpolate(s, fraction, new Date().toISOString());
      shipments.appendLocation(s.shipmentId, p);
    }
  }
  ledger.append('SHIPMENT_SEEDED', { count: 5 });
}
const restoredState = loadLogisticsState(shipments, users, ledger);
if (restoredState) {
  demoSeq = restoredState.demoSeq;
  console.log(`[logistics-service] restored ${restoredState.shipments.shipments.length} shipments and ${restoredState.ledger.length} ledger blocks from disk`);
} else {
  seedShipments();
  saveState();
}

// ── Demo loop: keep the map alive ────────────────────────────────────────────
// When every shipment has arrived (or is waiting at the depot), dispatch a
// fresh batch so the dashboard always shows live movement. Disabled by
// DEMO_LOOP=0.
const DEMO_LOOP = process.env.DEMO_LOOP !== '0';
const DEMO_ROUTES: Array<[string, number, number, string, number, number]> = [
  ['Central Pharmacy, Mumbai', 19.076, 72.8777, 'Fortis Hospital, Mulund', 19.172, 72.957],
  ['Central Pharmacy, Mumbai', 19.076, 72.8777, 'Lilavati Hospital, Bandra', 19.050, 72.830],
  ['Airport Cold Hub', 19.089, 72.8656, 'KEM Hospital, Parel', 18.997, 72.842],
  ['Central Pharmacy, Mumbai', 19.076, 72.8777, 'Nanavati Hospital, Vile Parle', 19.102, 72.840],
  ['Central Pharmacy, Mumbai', 19.076, 72.8777, 'Tata Memorial, Parel', 18.997, 72.842],
];
const DEMO_DRUGS: Array<[string, boolean]> = [
  ['Insulin (cold chain)', true],
  ['Warfarin 5mg', false],
  ['COVID-19 Vaccine', true],
  ['Heparin 10mg', false],
  ['Morphine 10mg', false],
  ['Amoxicillin 500mg', false],
  ['Erythropoietin', true],
];
function dispatchDemoBatch(): void {
  const count = 2 + Math.floor(Math.random() * 2); // 2-3 new shipments
  for (let i = 0; i < count; i++) {
    const [oName, oLat, oLng, dName, dLat, dLng] = DEMO_ROUTES[(demoSeq + i) % DEMO_ROUTES.length];
    const [drug, cold] = DEMO_DRUGS[(demoSeq * 3 + i) % DEMO_DRUGS.length];
    const s = shipments.create({
      orderCode: `RX-2026-${String(1000 + ++demoSeq).padStart(4, '0')}`,
      drugName: drug,
      quantity: 50 + Math.floor(Math.random() * 450),
      coldChain: cold,
      origin: { name: oName, lat: oLat, lng: oLng },
      destination: { name: dName, lat: dLat, lng: dLng },
      createdBy: { userId: 'u-admin', username: 'admin', role: 'admin' },
    });
    // stagger starting positions so the map shows varied progress
    const start = Math.random() * 0.3;
    if (start > 0.01) {
      shipments.appendLocation(s.shipmentId, interpolate(s, start, new Date().toISOString()));
    }
    shipments.transition(s.shipmentId, 'IN_TRANSIT', null);
    ledger.append('SHIPMENT_DISPATCHED', { shipmentId: s.shipmentId, orderCode: s.orderCode, drugName: s.drugName, demo: true });
    broadcast({
      type: 'SHIPMENT_CREATED',
      data: { shipmentId: s.shipmentId, orderCode: s.orderCode, drugName: s.drugName, by: 'demo-loop' },
      ts: new Date().toISOString(),
    });
  }
  saveState();
}
if (DEMO_LOOP) {
  setInterval(() => {
    const all = shipments.list();
    const moving = all.filter((s) => s.status === 'IN_TRANSIT').length;
    if (moving === 0) dispatchDemoBatch();
  }, 15_000);
}

// ── Movement simulator: advance every IN_TRANSIT shipment each tick ─────────
const simOpts = { tickMs: SIM_TICK_MS, speedPerTick: SIM_SPEED };
setInterval(() => {
  for (const s of shipments.list({ status: 'IN_TRANSIT' })) {
    const progress = advanceProgress(s, simOpts);
    const point = interpolate(s, progress, new Date().toISOString());
    shipments.appendLocation(s.shipmentId, point);
    broadcast({
      type: 'SHIPMENT_LOCATION',
      data: {
        shipmentId: s.shipmentId,
        orderCode: s.orderCode,
        drugName: s.drugName,
        status: s.status,
        lat: point.lat,
        lng: point.lng,
        progress: Math.round(progress * 100),
      },
      ts: new Date().toISOString(),
    });
    if (progress >= 1) {
      // courier scan at the destination — auto-deliver
      const t = shipments.transition(s.shipmentId, 'DELIVERED', null);
      if (t) {
        ledger.append('SHIPMENT_DELIVERED', {
          shipmentId: s.shipmentId,
          orderCode: s.orderCode,
          drugName: s.drugName,
          auto: true,
        });
        broadcast({
          type: 'SHIPMENT_STATUS',
          data: {
            shipmentId: s.shipmentId,
            orderCode: s.orderCode,
            drugName: s.drugName,
            from: 'IN_TRANSIT',
            to: 'DELIVERED',
            at: t.shipment.deliveredAt,
            by: 'courier-scan',
          },
          ts: new Date().toISOString(),
        });
      }
    }
  }
  saveState();
}, SIM_TICK_MS);

// ── Middleware pipeline (same order as the clinical services) ─────────────────
const limiter = new SlidingWindowLimiter(defaultRateLimitRules());

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(requestLogger());
app.use(limiter.middleware());
app.use(sanitizeBody);

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'logistics-service' }));

// ── Auth routes (public, tightly rate-limited) ───────────────────────────────
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
  ledger.append('USER_LOGIN', { username: user.username, role: user.role });
  saveState();
  res.json({
    accessToken,
    refreshToken,
    expiresInSec: ACCESS_TOKEN_TTL_SEC,
    role: user.role,
    username: user.username,
  });
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
  saveState();
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
  res.json({
    accessToken,
    refreshToken: rotated.newToken,
    expiresInSec: ACCESS_TOKEN_TTL_SEC,
    role: user.role,
    username: user.username,
  });
});

app.post('/api/auth/logout', jwtAuth(JWT_SECRET), (req, res) => {
  users.revokeAllForUser(req.user!.userId);
  saveState();
  res.json({ ok: true, revoked: 'all refresh tokens for user' });
});

// ── Everything below requires a valid JWT ────────────────────────────────────
app.use(jwtAuth(JWT_SECRET));

// ── Shipments ────────────────────────────────────────────────────────────────
app.get('/api/shipments', (req, res) => {
  const status = req.query.status as ShipmentStatus | undefined;
  if (status && !['NOT_SENT', 'IN_TRANSIT', 'DELIVERED'].includes(status)) {
    res.status(400).json({ error: 'status must be NOT_SENT | IN_TRANSIT | DELIVERED' });
    return;
  }
  res.json({ shipments: shipments.list(status ? { status } : undefined).map(view) });
});

app.get('/api/shipments/:shipmentId', (req, res) => {
  const s = shipments.get(req.params.shipmentId) ?? shipments.getByOrderCode(req.params.shipmentId);
  if (!s) {
    res.status(404).json({ error: 'shipment not found' });
    return;
  }
  res.json({ shipment: view(s) });
});

app.post('/api/shipments', requirePermission('orders:submit'), (req, res) => {
  const { orderCode, drugName, quantity, coldChain, origin, destination } = req.body ?? {};
  if (
    typeof orderCode !== 'string' || !orderCode.trim() ||
    typeof drugName !== 'string' || !drugName.trim() ||
    typeof quantity !== 'number' || quantity <= 0 ||
    !isPlace(origin) || !isPlace(destination)
  ) {
    res.status(400).json({
      error: 'orderCode, drugName, quantity>0, origin{name,lat,lng}, destination{name,lat,lng} required',
    });
    return;
  }
  if (shipments.getByOrderCode(orderCode.trim())) {
    res.status(409).json({ error: `orderCode '${orderCode}' already tracked` });
    return;
  }
  const s = shipments.create({
    orderCode: orderCode.trim(),
    drugName: drugName.trim(),
    quantity,
    coldChain: coldChain === true,
    origin: origin as { name: string; lat: number; lng: number },
    destination: destination as { name: string; lat: number; lng: number },
    createdBy: { userId: req.user!.userId, username: req.user!.username, role: req.user!.role },
  });
  ledger.append('SHIPMENT_CREATED', {
    shipmentId: s.shipmentId,
    orderCode: s.orderCode,
    drugName: s.drugName,
    quantity: s.quantity,
    coldChain: s.coldChain,
    by: req.user!.username,
  });  broadcast({
    type: 'SHIPMENT_CREATED',
    data: { shipmentId: s.shipmentId, orderCode: s.orderCode, drugName: s.drugName, by: req.user!.username },
    ts: new Date().toISOString(),
  });
  res.status(201).json({ shipment: view(s) });
  saveState();
});

app.post('/api/shipments/:shipmentId/status', requirePermission('orders:submit'), (req, res) => {
  const { to } = req.body ?? {};
  if (typeof to !== 'string' || !['NOT_SENT', 'IN_TRANSIT', 'DELIVERED'].includes(to)) {
    res.status(400).json({ error: 'to must be NOT_SENT | IN_TRANSIT | DELIVERED' });
    return;
  }
  const s = shipments.get(req.params.shipmentId) ?? shipments.getByOrderCode(req.params.shipmentId);
  if (!s) {
    res.status(404).json({ error: 'shipment not found' });
    return;
  }
  const t = shipments.transition(s.shipmentId, to as ShipmentStatus, {
    userId: req.user!.userId,
    username: req.user!.username,
    role: req.user!.role,
  });
  if (!t) {
    res.status(409).json({ error: `illegal transition ${s.status} → ${to} (lifecycle is NOT_SENT → IN_TRANSIT → DELIVERED)` });
    return;
  }
  ledger.append('SHIPMENT_STATUS_CHANGED', {
    shipmentId: s.shipmentId,
    orderCode: s.orderCode,
    from: t.from,
    to,
    by: req.user!.username,
  });  broadcast({
    type: 'SHIPMENT_STATUS',
    data: {
      shipmentId: s.shipmentId,
      orderCode: s.orderCode,
      drugName: s.drugName,
      from: t.from,
      to,
      at: t.shipment.lastEvent?.at,
      by: req.user!.username,
    },
    ts: new Date().toISOString(),
  });
  res.json({ shipment: view(t.shipment) });
  saveState();
});

// ── Audit ledger ─────────────────────────────────────────────────────────────
app.get('/api/audit', requirePermission('audit:view'), (req, res) => {
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  res.json(ledger.page(offset, limit));
});

app.get('/api/audit/verify', requirePermission('audit:view'), (req, res) => {
  res.json(ledger.verify());
});

// ── Internal (service-to-service, separate trust domain) ─────────────────────
app.get('/internal/shipments', internalKeyGuard(INTERNAL_KEY), (_req, res) => {
  res.json({ shipments: shipments.list().map(view) });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function isPlace(p: unknown): p is { name: string; lat: number; lng: number } {
  return (
    typeof p === 'object' && p !== null &&
    typeof (p as Record<string, unknown>).name === 'string' &&
    typeof (p as Record<string, unknown>).lat === 'number' &&
    typeof (p as Record<string, unknown>).lng === 'number'
  );
}

/** API view of a shipment: adds derived fields the dashboard renders. */
function view(s: Shipment) {
  const pos = ShipmentStore.currentPosition(s);
  const last = s.route[s.route.length - 1];
  return {
    shipmentId: s.shipmentId,
    orderCode: s.orderCode,
    drugName: s.drugName,
    quantity: s.quantity,
    coldChain: s.coldChain,
    status: s.status,
    origin: s.origin,
    destination: s.destination,
    route: s.route,
    deliveredAt: s.deliveredAt,
    createdAt: s.createdAt,
    createdBy: s.createdBy,
    lastEvent: s.lastEvent,
    // derived
    current: pos ? { lat: pos.lat, lng: pos.lng, at: pos.at } : null,
    progress: Math.round(ShipmentStore.progress(s) * 100),
    etaMinutes: etaMinutes(s, simOpts),
    distanceKm: Math.round(haversine(s.origin, s.destination) * 10) / 10,
    remainingKm: last
      ? Math.round(haversine(last, s.destination) * 10) / 10
      : null,
    routeFraction: last ? Math.round(fractionAlong(s, last) * 100) : 0,
  };
}

// ── Error handler + listen ────────────────────────────────────────────────────
app.use(errorHandler('logistics-service'));

const server = app.listen(PORT, () => {
  console.log(`[logistics-service] listening on :${PORT}`);
  console.log(`[logistics-service] sim tick ${SIM_TICK_MS}ms, speed ${SIM_SPEED}/tick`);
});

// ── WebSocket for live dashboard events (JWT via query param) ─────────────────
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

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
