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
  newOpaqueToken,
  EpochGatedEvaluator,
  SiteCache,
  type AlertResult,
  type ClinicalOrder,
  type HospitalDrug,
  type LiveEvent,
  type ReferenceRuleVersion,
} from '@hc/shared';
import { CentralStore, type SiteRecord } from './store.js';
import { pushToSite } from './pusher.js';
import { UserStore } from './users.js';
import {
  generateHospitalName,
  generateRegion,
  generateDoctorName,
  generateDoctorPassword,
  simPortFor,
  startSimSite,
  type SimSite,
} from './simulate.js';

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

// ── Small helpers ────────────────────────────────────────────────────────────
function clampNum(input: unknown, fallback: number, min: number, max: number): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `hospital-${Date.now()}`;
}

function pickNetwork(s: SiteRecord): { baseLatencyMs: number; jitterMs: number; dropRate: number } {
  return { baseLatencyMs: s.baseLatencyMs, jitterMs: s.jitterMs, dropRate: s.dropRate };
}

// Demo users — one per RBAC role so every permission row is demonstrable.
const users = new UserStore([
  { userId: 'user-admin', username: 'admin', password: 'admin123', role: 'admin' },
  { userId: 'user-operator', username: 'operator', password: 'operator123', role: 'operator' },
  { userId: 'user-auditor', username: 'auditor', password: 'auditor123', role: 'auditor' },
  { userId: 'user-viewer', username: 'viewer', password: 'viewer123', role: 'viewer' },
  { userId: 'user-doctor', username: 'doctor', password: 'doctor123', role: 'doctor', hospitalId: 'site-a', fullName: 'Dr. Demo Physician' },
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

// Default hospitals match the seeded demo sites so the dashboard has real
// records to show from the start.
const seededHospitalNames = ['Central General Hospital', 'Northside Medical Center', 'Riverside Clinic'];
for (const [i, p] of DEFAULT_PROFILES.entries()) {
  store.registerHospital({
    siteId: p.siteId,
    name: seededHospitalNames[i] ?? p.siteId,
    region: generateRegion(i),
    simulated: false,
    createdAt: new Date().toISOString(),
  });
}

// ── Simulated hospital agents (in-process, for scalability testing) ──────────
// Each sim hospital gets a real HTTP server inside this process with the
// same /internal/push + /internal/evaluate contract as a site-agent, so
// fan-out, watermark ACKs, and epoch gating treat it identically.
const simSites = new Map<string, SimSite>();
const simCaches = new Map<string, SiteCache>();
const simEvaluators = new Map<string, EpochGatedEvaluator>();
const simResults = new Map<string, Map<string, AlertResult[]>>();
let nextSimPortOffset = 0;

async function hostSimulatedHospital(siteId: string): Promise<SimSite> {
  const existing = simSites.get(siteId);
  if (existing) return existing;
  const cache = new SiteCache();
  const evaluator = new EpochGatedEvaluator();
  simCaches.set(siteId, cache);
  simEvaluators.set(siteId, evaluator);
  simResults.set(siteId, new Map());
  const port = simPortFor(nextSimPortOffset++);
  const sim = await startSimSite(siteId, port, {
    push: (ruleVersion) => simCaches.get(siteId)!.ingest(ruleVersion as unknown as ReferenceRuleVersion),
    evaluate: (order, orderEpoch) => {
      const cache = simCaches.get(siteId)!;
      const evaluator = simEvaluators.get(siteId)!;
      const clinicalOrder: ClinicalOrder = {
        orderId: String(order.orderId ?? `ord-${Date.now()}`),
        siteId,
        orderCode: String(order.orderCode),
        patientRef: String(order.patientRef ?? 'patient-unknown'),
        submittedAt: new Date().toISOString(),
        details: order.details as Record<string, unknown>,
      };
      const result = evaluator.evaluate(clinicalOrder, cache, orderEpoch);
      const byOrder = simResults.get(siteId)!;
      const list = byOrder.get(clinicalOrder.orderId) ?? [];
      list.push(result);
      byOrder.set(clinicalOrder.orderId, list);
      broadcast({ type: 'ALERT_RESULT', data: { ...result }, ts: new Date().toISOString() });
      return result;
    },
  });
  simSites.set(siteId, sim);

  // Initial watermark ACK so the coordinator counts the sim site from the
  // start (epoch = min over known sites; watermark 0 is a valid floor).
  void fetch(`${COORDINATOR_URL}/internal/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
    body: JSON.stringify({ siteId, watermarkSeq: 0 }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
  return sim;
}

async function teardownSimulatedHospital(siteId: string): Promise<void> {
  const sim = simSites.get(siteId);
  if (sim) {
    await new Promise<void>((resolve) => sim.handle.close(() => resolve()));
    simSites.delete(siteId);
  }
  simCaches.delete(siteId);
  simEvaluators.delete(siteId);
  simResults.delete(siteId);
}

/** Replay all published rule versions into a newly attached hospital so it can evaluate. */
async function replayHistoryToSite(site: SiteRecord): Promise<void> {
  const rules = store.allRules();
  await Promise.all(
    rules.map((rec) =>
      pushToSite({ store, ledger, broadcast }, site, rec).then((outcome) => {
        if (outcome.delivered) {
          ledger.append('REFDATA_RECEIVED', { siteId: site.siteId, ruleId: rec.ruleId, globalSeq: rec.globalSeq, attempts: outcome.attempts, replay: true });
        }
      }),
    ),
  );
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
  res.json({
    accessToken,
    refreshToken,
    expiresInSec: ACCESS_TOKEN_TTL_SEC,
    role: user.role,
    username: user.username,
    ...(user.role === 'doctor' ? { hospitalId: user.hospitalId ?? null } : {}),
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
  // Attribution: who published this version (admin or doctor + affiliation).
  const user = users.get(req.user!.userId);
  const publishedBy = {
    userId: req.user!.userId,
    username: req.user!.username,
    role: req.user!.role,
    hospitalId: user?.hospitalId ?? null,
  };
  const rec = store.publish(ruleId, payload, publishedBy);
  rec.contentHash = contentHashOf(payload);
  ledger.append('REFDATA_PUBLISHED', {
    ruleId,
    version: rec.version,
    globalSeq: rec.globalSeq,
    contentHash: rec.contentHash,
    payload,
    publishedBy,
  });
  broadcast({ type: 'PUBLISH', data: { ruleId, version: rec.version, globalSeq: rec.globalSeq, publishedBy: { username: publishedBy.username, role: publishedBy.role } }, ts: new Date().toISOString() });

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

app.get('/api/reference/rules', (req, res) => {
  if (req.query.latest === '1' || req.query.latest === 'true') {
    res.json(store.latestVersions());
    return;
  }
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

// ── Hospitals (admin) ────────────────────────────────────────────────────────
// A hospital = domain record (name/region) + a site registration (network
// profile + agent location). GET /api/hospitals joins both for the dashboard.

app.get('/api/hospitals', (_req, res) => {
  const sites = new Map(store.listSites().map((s) => [s.siteId, s]));
  const doctorCountByHospital = new Map<string, number>();
  for (const d of users.listDoctors()) {
    if (d.hospitalId) doctorCountByHospital.set(d.hospitalId, (doctorCountByHospital.get(d.hospitalId) ?? 0) + 1);
  }
  res.json(store.listHospitals().map((h) => {
    const site = sites.get(h.siteId);
    return {
      ...h,
      baseLatencyMs: site?.baseLatencyMs ?? 0,
      jitterMs: site?.jitterMs ?? 0,
      dropRate: site?.dropRate ?? 0,
      doctorCount: doctorCountByHospital.get(h.siteId) ?? 0,
    };
  }));
});

app.post('/api/hospitals', requirePermission('hospitals:manage'), async (req, res) => {
  const { name, siteId, region, baseLatencyMs, jitterMs, dropRate } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name required' });
    return;
  }
  const id = typeof siteId === 'string' && siteId.trim() ? siteId.trim() : slugify(name);
  if (store.getSite(id)) {
    res.status(409).json({ error: `hospital/site '${id}' already exists` });
    return;
  }
  const profile: SiteRecord = {
    siteId: id,
    baseLatencyMs: clampNum(baseLatencyMs, 120, 0, 60_000),
    jitterMs: clampNum(jitterMs, 40, 0, 5_000),
    dropRate: clampNum(dropRate, 0, 0, 1),
    host: 'localhost',
    port: 0, // assigned when the in-process agent is hosted
  };
  const hospital = {
    siteId: id,
    name: name.trim(),
    region: typeof region === 'string' && region.trim() ? region.trim() : 'Unassigned',
    simulated: false,
    createdAt: new Date().toISOString(),
  };
  store.registerSite(profile);
  store.registerHospital(hospital);
  const sim = await hostSimulatedHospital(id);
  store.registerSite({ ...profile, port: sim.port });
  ledger.append('HOSPITAL_ADDED', { siteId: id, name: hospital.name, region: hospital.region });
  broadcast({ type: 'HOSPITAL', data: { action: 'added', ...hospital }, ts: new Date().toISOString() });
  await replayHistoryToSite(store.getSite(id)!);
  res.status(201).json({ ...hospital, ...pickNetwork(store.getSite(id)!) });
});

app.delete('/api/hospitals/:siteId', requirePermission('hospitals:manage'), async (req, res) => {
  const siteId = req.params.siteId;
  const site = store.getSite(siteId);
  if (!site) {
    res.status(404).json({ error: 'hospital not found' });
    return;
  }
  const hospital = store.getHospital(siteId);
  const removed = store.unregisterSite(siteId);
  await teardownSimulatedHospital(siteId);
  // Drop the watermark so a removed hospital stops gating the global epoch.
  await fetch(`${COORDINATOR_URL}/internal/sites/remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
    body: JSON.stringify({ siteId }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
  ledger.append('HOSPITAL_REMOVED', { siteId, name: hospital?.name ?? siteId, hadSite: !!removed });
  broadcast({ type: 'HOSPITAL', data: { action: 'removed', siteId }, ts: new Date().toISOString() });
  res.json({ ok: true, siteId });
});

// ── Simulated hospital generation (scalability testing) ─────────────────────
// POST /api/hospitals/simulated { count: N } spins up N simulated hospitals,
// each a real HTTP agent inside this process with realistic name/region and
// randomized network profiles so fan-out/epoch behavior is observable at scale.

app.post('/api/hospitals/simulated', requirePermission('hospitals:manage'), async (req, res) => {
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    res.status(400).json({ error: 'count must be an integer between 1 and 1000' });
    return;
  }
  const siteIds = store.allocateSimSiteIds(count);
  const created: Array<{ siteId: string; name: string; region: string; simulated: boolean; createdAt: string; baseLatencyMs: number; jitterMs: number; dropRate: number }> = [];
  for (const [i, id] of siteIds.entries()) {
    const profile: SiteRecord = {
      siteId: id,
      baseLatencyMs: 40 + Math.floor(Math.random() * 200),
      jitterMs: Math.floor(Math.random() * 60),
      dropRate: Math.random() < 0.15 ? Math.random() * 0.05 : 0,
      host: 'localhost',
      port: 0, // assigned by hostSimulatedHospital
    };
    const hospital = {
      siteId: id,
      name: generateHospitalName(i),
      region: generateRegion(i),
      simulated: true,
      createdAt: new Date().toISOString(),
    };
    store.registerSite(profile);
    store.registerHospital(hospital);
    const sim = await hostSimulatedHospital(id);
    store.registerSite({ ...profile, port: sim.port });
    created.push({ ...hospital, ...pickNetwork(store.getSite(id)!) });
  }
  // Bring the new fleet up to the current rule set (replay history).
  const t0 = Date.now();
  await Promise.all(created.map((h) => replayHistoryToSite(store.getSite(h.siteId)!)));
  const elapsedMs = Date.now() - t0;
  ledger.append('SIM_HOSPITALS_GENERATED', { count, siteIds, replayMs: elapsedMs });
  broadcast({ type: 'HOSPITAL', data: { action: 'simulated-batch', count, siteIds }, ts: new Date().toISOString() });
  res.status(201).json({ count, created, replayMs: elapsedMs });
});

// ── Doctors (admin) ──────────────────────────────────────────────────────────
// Doctors are users with role='doctor' + hospital affiliation. They log into
// the doctor portal and publish reference rules.

app.get('/api/doctors', requirePermission('users:manage'), (_req, res) => {
  const hospitals = new Map(store.listHospitals().map((h) => [h.siteId, h.name]));
  res.json(users.listDoctors().map((d) => ({
    ...d,
    hospitalName: d.hospitalId ? hospitals.get(d.hospitalId) ?? null : null,
  })));
});

app.post('/api/doctors', requirePermission('users:manage'), (req, res) => {
  const { username, password, fullName, hospitalId } = req.body ?? {};
  if (typeof username !== 'string' || !/^[a-z0-9]([a-z0-9.-]{1,30}[a-z0-9])?$/.test(username.trim())) {
    res.status(400).json({ error: 'username required (3-32 chars: lowercase letters, numbers, dots, dashes)' });
    return;
  }
  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'password (min 8 chars) required' });
    return;
  }
  if (users.usernameTaken(username.trim())) {
    res.status(409).json({ error: `username '${username.trim()}' already taken` });
    return;
  }
  if (typeof hospitalId !== 'string' || !hospitalId.trim() || !store.getHospital(hospitalId.trim())) {
    res.status(400).json({ error: 'hospitalId must reference an existing hospital' });
    return;
  }
  const user = users.create(username.trim(), password, 'doctor', hospitalId.trim(), typeof fullName === 'string' && fullName.trim() ? fullName.trim() : undefined);
  ledger.append('DOCTOR_ADDED', { userId: user.userId, username: user.username, hospitalId: user.hospitalId, fullName: user.fullName });
  broadcast({ type: 'DOCTOR', data: { action: 'added', userId: user.userId, username: user.username, hospitalId: user.hospitalId }, ts: new Date().toISOString() });
  res.status(201).json({ userId: user.userId, username: user.username, role: user.role, hospitalId: user.hospitalId, fullName: user.fullName });
});

app.delete('/api/doctors/:userId', requirePermission('users:manage'), (req, res) => {
  const user = users.get(req.params.userId);
  if (!user || user.role !== 'doctor') {
    res.status(404).json({ error: 'doctor not found' });
    return;
  }
  const removed = users.deleteUser(req.params.userId)!;
  ledger.append('USER_REMOVED', { userId: removed.userId, username: removed.username, role: removed.role });
  broadcast({ type: 'DOCTOR', data: { action: 'removed', userId: removed.userId, username: removed.username }, ts: new Date().toISOString() });
  res.json({ ok: true, ...removed });
});

// Batch doctor generation — fills every hospital lacking a doctor with one
// generated doctor (name, username, random demo password). For scale testing.
app.post('/api/doctors/simulated', requirePermission('users:manage'), (req, res) => {
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    res.status(400).json({ error: 'count must be an integer between 1 and 1000' });
    return;
  }
  const hospitals = store.listHospitals();
  if (hospitals.length === 0) {
    res.status(400).json({ error: 'no hospitals exist — add hospitals first' });
    return;
  }
  // Distribute doctors across hospitals round-robin; skip taken usernames.
  const created: Array<{ userId: string; username: string; fullName: string; hospitalId: string; password: string }> = [];
  const existingDoctors = users.listDoctors().length;
  for (let i = 0; i < count; i++) {
    const hospital = hospitals[i % hospitals.length];
    const { fullName, first, last } = generateDoctorName(existingDoctors + i);
    let username = `${first}.${last}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (users.usernameTaken(username)) username = `${username}${i + 2}`;
    if (users.usernameTaken(username)) continue;
    const password = generateDoctorPassword();
    const user = users.create(username, password, 'doctor', hospital.siteId, fullName);
    created.push({ userId: user.userId, username, fullName, hospitalId: hospital.siteId, password });
  }
  ledger.append('DOCTOR_ADDED', { batch: true, count: created.length });
  broadcast({ type: 'DOCTOR', data: { action: 'simulated-batch', count: created.length }, ts: new Date().toISOString() });
  res.status(201).json({ count: created.length, created });
});

// ── Hospital formulary (drugs per hospital) ──────────────────────────────────
// Drugs can be provisioned to one hospital (its page) or a chosen subset of
// hospitals (multi-select provide) — so a doctor/admin controls exactly
// which hospitals stock which medicine.

/** Resolve the acting user for attribution. */
function actingUser(req: { user?: { userId: string; username: string; role: string } }): { userId: string; username: string; role: string } {
  return req.user ? { userId: req.user.userId, username: req.user.username, role: req.user.role } : null!;
}

// Hospital detail: domain record + site network profile + formulary + doctor roster.
app.get('/api/hospitals/:siteId', (req, res) => {
  const siteId = req.params.siteId;
  const hospital = store.getHospital(siteId);
  if (!hospital) {
    res.status(404).json({ error: 'hospital not found' });
    return;
  }
  const site = store.getSite(siteId);
  const doctors = users.listDoctors().filter((d) => d.hospitalId === siteId);
  res.json({
    ...hospital,
    network: site ? pickNetwork(site) : null,
    drugs: store.drugsAtHospital(siteId),
    doctors,
  });
});

// All distinct drug names stocked anywhere (autocomplete).
app.get('/api/drugs', (_req, res) => {
  res.json(store.allDrugNames());
});

// Provision a drug to one hospital (hospital page form).
app.post('/api/hospitals/:siteId/drugs', requirePermission('formulary:manage'), (req, res) => {
  const siteId = req.params.siteId;
  const { drugName } = req.body ?? {};
  if (!store.getHospital(siteId)) {
    res.status(404).json({ error: 'hospital not found' });
    return;
  }
  if (typeof drugName !== 'string' || !drugName.trim()) {
    res.status(400).json({ error: 'drugName required' });
    return;
  }
  const name = drugName.trim();
  if (store.hospitalHasDrug(siteId, name)) {
    res.status(409).json({ error: `${siteId} already stocks '${name}'` });
    return;
  }
  const drug: HospitalDrug = {
    id: `drug-${newOpaqueToken().slice(0, 12)}`,
    drugName: name,
    hospitalId: siteId,
    addedBy: actingUser(req),
    addedAt: new Date().toISOString(),
  };
  store.addDrugToHospital(drug);
  ledger.append('DRUG_ADDED_TO_HOSPITAL', { drugId: drug.id, drugName: name, hospitalId: siteId, addedBy: drug.addedBy });
  broadcast({ type: 'DRUG', data: { action: 'added', drugName: name, hospitalId: siteId, addedBy: drug.addedBy?.username }, ts: new Date().toISOString() });
  res.status(201).json(drug);
});

// Provision a drug to a chosen subset of hospitals (multi-provide form).
app.post('/api/drugs/provide', requirePermission('formulary:manage'), (req, res) => {
  const { drugName, hospitalIds } = req.body ?? {};
  if (typeof drugName !== 'string' || !drugName.trim()) {
    res.status(400).json({ error: 'drugName required' });
    return;
  }
  const name = drugName.trim();
  if (!Array.isArray(hospitalIds) || hospitalIds.length === 0 || !hospitalIds.every((h) => typeof h === 'string')) {
    res.status(400).json({ error: 'hospitalIds (non-empty string[]) required — pick at least one hospital' });
    return;
  }
  const addedBy = actingUser(req);
  const provided: HospitalDrug[] = [];
  const skipped: Array<{ hospitalId: string; reason: string }> = [];
  for (const hospitalId of hospitalIds as string[]) {
    if (!store.getHospital(hospitalId)) {
      skipped.push({ hospitalId, reason: 'not found' });
      continue;
    }
    if (store.hospitalHasDrug(hospitalId, name)) {
      skipped.push({ hospitalId, reason: 'already stocks it' });
      continue;
    }
    const drug: HospitalDrug = {
      id: `drug-${newOpaqueToken().slice(0, 12)}`,
      drugName: name,
      hospitalId,
      addedBy,
      addedAt: new Date().toISOString(),
    };
    store.addDrugToHospital(drug);
    provided.push(drug);
    ledger.append('DRUG_ADDED_TO_HOSPITAL', { drugId: drug.id, drugName: name, hospitalId, addedBy, provideAll: false });
    broadcast({ type: 'DRUG', data: { action: 'added', drugName: name, hospitalId, addedBy: addedBy.username }, ts: new Date().toISOString() });
  }
  res.status(201).json({ drugName: name, provided: provided.length, providedTo: provided.map((d) => d.hospitalId), skipped });
});

// Remove a drug from a hospital (hospital page remove button).
app.delete('/api/hospitals/:siteId/drugs/:drugId', requirePermission('formulary:manage'), (req, res) => {
  const drug = store.drugsAtHospital(req.params.siteId).find((d) => d.id === req.params.drugId);
  if (!drug) {
    res.status(404).json({ error: 'drug not found at this hospital' });
    return;
  }
  store.removeDrug(drug.id);
  ledger.append('DRUG_REMOVED_FROM_HOSPITAL', { drugId: drug.id, drugName: drug.drugName, hospitalId: drug.hospitalId });
  broadcast({ type: 'DRUG', data: { action: 'removed', drugName: drug.drugName, hospitalId: drug.hospitalId }, ts: new Date().toISOString() });
  res.json({ ok: true });
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
          body: JSON.stringify({
            order: { orderId, orderCode, patientRef, details },
            orderEpoch,
            siteId: site.siteId, // simulated agents stamp results with this id
          }),
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

// Tear down simulated hospital agents on shutdown.
const shutdown = () => {
  for (const sim of simSites.values()) sim.handle.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

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
