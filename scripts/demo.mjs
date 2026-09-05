#!/usr/bin/env node
/**
 * Demo scenario — PRD §12 acceptance test (headless version).
 *
 * 1. Start 3 sites (A/B/C), all on rule version V1 (no interaction).
 * 2. Set Site B's network profile to high latency. Leave Site A fast.
 * 3. Publish V2 (severe interaction) — Site A's watermark jumps ahead,
 *    Site B's lags, global epoch STAYS at V1 (gated by slowest site).
 * 4. DURING the gap, submit the identical order to A and B simultaneously.
 *    Both must return the SAME result (V1 behavior) — same epochUsed.
 * 5. Wait for Site B to catch up; epoch advances atomically.
 * 6. Re-submit the identical order — both sites return the NEW (V2) result together.
 * 7. Verify the audit ledger chain.
 *
 * Usage: node scripts/demo.mjs [centralUrl coordinatorUrl]
 */
const CENTRAL = process.argv[2] ?? 'http://localhost:4001';
const COORD = process.argv[3] ?? 'http://localhost:4002';

const log = (...a) => console.log(...a);
const ok = (...a) => console.log('  ✅', ...a);
const fail = (...a) => {
  console.error('  ❌', ...a);
  process.exitCode = 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jfetch(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

// ── Auth helper: login, keep token refreshed, attach Authorization ──────────
let accessToken = null;
let refreshToken = null;

async function login(username, password) {
  const body = await jfetch(`${CENTRAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return body;
}

async function authedFetch(url, init = {}) {
  const headers = { ...(init.headers ?? {}), authorization: `Bearer ${accessToken}` };
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) throw new Error('token expired mid-demo (unexpected — TTL is 15min)');
  return res;
}

async function authedJson(url, init = {}) {
  const res = await authedFetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitUntil(desc, fn, timeoutMs = 30000, intervalMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  fail(`${desc} — timed out after ${timeoutMs}ms`);
  return false;
}

async function main() {
  log('\n══════════════════════════════════════════════════════════════');
  log('  Distributed Clinical Reference-Data Consistency — Demo');
  log('══════════════════════════════════════════════════════════════\n');

  // ── 0. Health checks + auth ────────────────────────────────────────────────────
  log('[0] Waiting for services to be healthy...');
  const healthy = await waitUntil('services healthy', async () => {
    try {
      const c = await fetch(`${CENTRAL}/healthz`).then((r) => r.ok);
      const k = await fetch(`${COORD}/healthz`).then((r) => r.ok);
      return c && k;
    } catch { return false; }
  }, 20000);
  if (!healthy) return;
  ok('central + coordinator healthy');

  log('    logging in as admin (JWT + refresh token)...');
  const session = await login('admin', 'admin123');
  accessToken = session.accessToken;
  refreshToken = session.refreshToken;
  ok(`authenticated as ${session.username} (role=${session.role}, access TTL=${session.expiresInSec}s)`);

  // RBAC: viewer must NOT be able to publish
  const viewerSession = await login('viewer', 'viewer123');
  const viewerAttempt = await fetch(`${CENTRAL}/api/reference/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${viewerSession.accessToken}` },
    body: JSON.stringify({ ruleId: 'x', payload: {} }),
  });
  if (viewerAttempt.status === 403) ok('RBAC enforced: viewer denied reference:publish (403)');
  else fail(`RBAC FAILED: viewer got ${viewerAttempt.status} on publish`);

  // Unauthenticated request must be rejected
  const anonAttempt = await fetch(`${CENTRAL}/api/reference/rules`);
  if (anonAttempt.status === 401) ok('JWT enforced: unauthenticated request rejected (401)');
  else fail(`JWT FAILED: anonymous got ${anonAttempt.status}`);

  const sites = await authedJson(`${CENTRAL}/api/sites`);
  const siteIds = sites.map((s) => s.siteId);
  log(`    sites: ${siteIds.join(', ')}`);
  if (siteIds.length < 2) { fail('need at least 2 sites'); return; }

  // ── 1. Baseline: publish V1 (no interaction) ────────────────────────────────
  log('\n[1] Publishing V1: warfarin+aspirin → NO interaction (baseline)...');
  const v1 = await authedJson(`${CENTRAL}/api/reference/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ruleId: 'drug-interaction-warfarin-aspirin',
      payload: { drugA: 'warfarin', drugB: 'aspirin', severity: 'NONE', note: 'V1: no known interaction' },
    }),
  });
  log(`    published globalSeq=${v1.globalSeq} (V1)`);
  const convergedOnV1 = await waitUntil('all sites cached V1', async () => {
    const wms = await authedJson(`${COORD}/api/sites`);
    return wms.watermarks.length >= siteIds.length &&
      wms.watermarks.every((w) => w.watermarkSeq >= v1.globalSeq);
  });
  if (!convergedOnV1) return;
  const epoch1 = await authedJson(`${COORD}/api/epoch`);
  ok(`all sites cached V1; epoch=${epoch1.epochSeq}`);
  if (epoch1.epochSeq < v1.globalSeq) fail(`epoch should be >= ${v1.globalSeq}`);

  // ── 2. Chaos: slow down Site B ──────────────────────────────────────────────
  const slowSite = siteIds[1];
  log(`\n[2] Injecting chaos: ${slowSite} baseLatency=4000ms (Site A stays fast)...`);
  await authedJson(`${CENTRAL}/api/sites/${slowSite}/network`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseLatencyMs: 4000, jitterMs: 200, dropRate: 0 }),
  });
  ok(`${slowSite} now slow`);

  // ── 3. Publish V2 — watch epoch stay at V1 ──────────────────────────────────
  log('\n[3] Publishing V2: warfarin+aspirin → SEVERE interaction...');
  const v2 = await authedJson(`${CENTRAL}/api/reference/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ruleId: 'drug-interaction-warfarin-aspirin',
      payload: { drugA: 'warfarin', drugB: 'aspirin', severity: 'SEVERE', note: 'V2: major bleeding risk' },
    }),
  });
  log(`    published globalSeq=${v2.globalSeq} (V2)`);

  // Wait for the FAST site to have V2 cached while the SLOW site doesn't.
  const gapAchieved = await waitUntil('fast site ahead, slow site behind', async () => {
    const wms = await authedJson(`${COORD}/api/sites`);
    const fast = wms.watermarks.find((w) => w.siteId === siteIds[0]);
    const slow = wms.watermarks.find((w) => w.siteId === slowSite);
    return fast && slow && fast.watermarkSeq >= v2.globalSeq && slow.watermarkSeq < v2.globalSeq;
  }, 15000);
  if (!gapAchieved) return;

  const wmsDuringGap = await authedJson(`${COORD}/api/sites`);
  const epochDuringGap = await authedJson(`${COORD}/api/epoch`);
  log('    watermarks during gap:', wmsDuringGap.watermarks.map((w) => `${w.siteId}=${w.watermarkSeq}`).join(' '));
  ok(`DEMONSTRABLY OUT OF SYNC: fast site has V2 (seq ${v2.globalSeq}), slow site still at ${wmsDuringGap.watermarks.find((w) => w.siteId === slowSite)?.watermarkSeq}`);
  if (epochDuringGap.epochSeq >= v2.globalSeq) {
    fail(`epoch should still be < ${v2.globalSeq} during the gap (got ${epochDuringGap.epochSeq})`);
  } else {
    ok(`epoch correctly HELD at ${epochDuringGap.epochSeq} — gated by slowest site`);
  }

  // ── 4. THE TEST: identical order during the gap ──────────────────────────────
  log('\n[4] Submitting IDENTICAL order to ALL sites DURING the propagation gap...');
  const order1 = await authedJson(`${CENTRAL}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderCode: 'RX-WARFARIN-ASPIRIN',
      patientRef: 'patient-042',
      details: { drugs: ['warfarin', 'aspirin'] },
    }),
  });
  log(`    order ${order1.orderId} (epoch stamped: ${order1.orderEpoch})`);
  for (const r of order1.results) {
    log(`    ${r.siteId}: fires=${r.fires} severity=${r.severity} epochUsed=${r.epochUsed} watermarkAtEval=${r.watermarkAtEval}${r.provisional ? ' [PROVISIONAL]' : ''}`);
  }

  const sameOutcome = order1.results.every((r) => r.fires === order1.results[0].fires && r.severity === order1.results[0].severity);
  const sameEpoch = order1.results.every((r) => r.epochUsed === order1.results[0].epochUsed);
  const fastResult = order1.results.find((r) => r.siteId === siteIds[0]);
  const slowResult = order1.results.find((r) => r.siteId === slowSite);
  const fastHadV2 = fastResult && fastResult.watermarkAtEval >= v2.globalSeq;
  const slowLackedV2 = slowResult && slowResult.watermarkAtEval < v2.globalSeq;

  if (sameOutcome && sameEpoch) ok('ACCEPTANCE: identical alert output at all sites (same fire/no-fire, same severity, same epochUsed)');
  else fail(`ACCEPTANCE FAILED: outcomeMatch=${sameOutcome} epochMatch=${sameEpoch}`);
  if (fastHadV2 && slowLackedV2) ok(`caches demonstrably diverged during eval: fast@${fastResult.watermarkAtEval} vs slow@${slowResult.watermarkAtEval} — yet results identical`);
  else log(`    (cache divergence at eval: fast@${fastResult?.watermarkAtEval} slow@${slowResult?.watermarkAtEval})`);
  if (fastResult && !fastResult.fires && fastResult.severity === 'NONE') ok('fast site correctly evaluated against V1 (NONE) despite having V2 cached');

  // ── 5. Wait for convergence; epoch advances atomically ───────────────────────
  log('\n[5] Waiting for slow site to catch up (epoch should advance atomically)...');
  const converged = await waitUntil('epoch advanced to V2', async () => {
    const e = await authedJson(`${COORD}/api/epoch`);
    return e.epochSeq >= v2.globalSeq;
  }, 30000);
  if (!converged) return;
  const epoch2 = await authedJson(`${COORD}/api/epoch`);
  ok(`epoch advanced ${epoch1.epochSeq} → ${epoch2.epochSeq} for ALL sites at once`);

  // ── 6. Re-submit: both sites flip to V2 together ─────────────────────────────
  log('\n[6] Re-submitting the IDENTICAL order after convergence...');
  const order2 = await authedJson(`${CENTRAL}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderCode: 'RX-WARFARIN-ASPIRIN',
      patientRef: 'patient-042',
      details: { drugs: ['warfarin', 'aspirin'] },
    }),
  });
  log(`    order ${order2.orderId} (epoch stamped: ${order2.orderEpoch})`);
  for (const r of order2.results) {
    log(`    ${r.siteId}: fires=${r.fires} severity=${r.severity} epochUsed=${r.epochUsed} watermarkAtEval=${r.watermarkAtEval}${r.provisional ? ' [PROVISIONAL]' : ''}`);
  }
  const flippedTogether = order2.results.every((r) => r.fires && r.severity === 'SEVERE' && r.epochUsed === v2.globalSeq);
  if (flippedTogether) ok('ACCEPTANCE: all sites switched to V2 behavior TOGETHER (fires=SEVERE, same epochUsed)');
  else fail('sites did not switch to V2 together');

  // ── 7. Ledger integrity ──────────────────────────────────────────────────────
  log('\n[7] Verifying audit ledger chain...');
  const verify = await authedJson(`${CENTRAL}/api/audit/verify`);
  if (verify.valid) ok(`ledger valid — ${verify.blocksChecked} blocks, hash chain intact`);
  else fail(`ledger TAMPERED at block ${verify.firstBadIndex}: ${verify.reason}`);

  const audit = await authedJson(`${CENTRAL}/api/audit?limit=200`);
  const counts = {};
  for (const b of audit.blocks) counts[b.eventType] = (counts[b.eventType] ?? 0) + 1;
  log('    ledger event counts:', JSON.stringify(counts));

  // ── 8. Input sanitization + rate limiting + abuse detection ─────────────────
  log('\n[8] Security: NoSQL operator injection, then rate limiting...');

  // NoSQL operator injection must be neutralized by the sanitizer (run FIRST —
  // before the rate-limit hammering trips the per-IP limit on /api/auth/login)
  const injection = await fetch(`${CENTRAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: { $ne: null }, password: { $gt: '' } }),
  });
  const injBody = await injection.json().catch(() => ({}));
  if (injection.status === 400 && typeof injBody.error === 'string') {
    ok('NoSQL operator injection neutralized: $-keys stripped, request rejected');
  } else if (injection.status === 401) {
    ok('NoSQL operator injection neutralized: sanitized to invalid credentials (401)');
  } else {
    fail(`sanitizer FAILED: injection got ${injection.status}`);
  }

  log('    hammering /api/auth/login (limit 10/min per IP)...');
  let got429 = false;
  let retryAfter = null;
  for (let i = 0; i < 14; i++) {
    const r = await fetch(`${CENTRAL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'wrong' }),
    });
    if (r.status === 429) {
      got429 = true;
      retryAfter = r.headers.get('retry-after');
      break;
    }
  }
  if (got429) ok(`rate limiter engaged: 429 with Retry-After=${retryAfter}s (per-IP sliding window)`);
  else fail('rate limiter did not engage on /api/auth/login');

  // ── Summary ──────────────────────────────────────────────────────────────────
  log('\n══════════════════════════════════════════════════════════════');
  if (process.exitCode === 1) {
    log('  RESULT: ❌ DEMO FAILED — see failures above');
  } else {
    log('  RESULT: ✅ ALL ACCEPTANCE CRITERIA PASSED');
    log('  - identical order during lag window → identical output at all sites');
    log('  - caches demonstrably out of sync at that moment (watermarks differ)');
    log('  - epoch held at V1 during gap, advanced atomically after convergence');
    log('  - deterministic switch to V2 at all sites together');
    log('  - hash-chained ledger verified');
    log('  - JWT auth + RBAC enforced (viewer denied publish, anonymous rejected)');
    log('  - rate limiter engaged with Retry-After; operator injection neutralized');
  }
  log('══════════════════════════════════════════════════════════════\n');
}

main().catch((e) => { console.error('demo crashed:', e); process.exit(1); });
