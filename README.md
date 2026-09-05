# Distributed Clinical Reference-Data Consistency for Alert Generation

A simulated multi-site hospital network where reference data (drug-interaction
thresholds) propagates from a central source to each site with realistic,
independently-configurable lag — and where alert-evaluation logic is **never
allowed to see an inconsistent view of that data across sites**, even while
propagation is actively in progress.

## The core idea (epoch-gated convergence)

The bug in the brief isn't a rules bug, it's a **timing bug** — two sites can
legitimately have different data at the same instant. So instead of trying to
make propagation instantaneous, we **decouple *receiving* data from
*activating* it**:

1. Every rule update is an immutable version with a globally monotonic
   `globalSeq` assigned by the central service (a single total order).
2. Each site caches a short **version history** (MVCC), so it can reconstruct
   "the world as of globalSeq N" even after receiving N+1.
3. Sites ACK their watermark to the **Convergence Coordinator**, which computes
   `globalActiveEpoch = min(all watermarks)` — a quorum/barrier read (the same
   idea behind Spanner's TrueTime safe-time / CockroachDB closed timestamps).
4. The epoch is **stamped once per order at submission** (barrier read, like a
   snapshot transaction fixing its timestamp once). Every site evaluates the
   order against `snapshotAsOf(stampedEpoch)` — identical inputs, pure rule
   engine, identical outputs by construction.
5. **Conservative fallback (§6.4):** if a site ever cannot satisfy the stamped
   epoch (invariant violation, defense-in-depth), it fails toward firing —
   never suppressing — and flags `PROVISIONAL_PENDING_CONVERGENCE`. In a
   clinical safety system, a suppressed alert is worse than an extra one.

**Result:** two sites, one of which already has the new data cached and one of
which doesn't, still evaluate against the identical snapshot — because neither
uses its own local freshness to decide; both use the one shared epoch value.

## Quick start (local, no Docker)

```bash
npm install
node scripts/start-all.mjs        # central :4001, coordinator :4002, sites :4101-4103
```

In another terminal:

```bash
npm run demo                      # headless §12 acceptance test
```

Or with the live dashboard:

```bash
cd dashboard && npm install && npm run dev   # http://localhost:5173
```

With Docker Compose (one container per service — logically distributed):

```bash
docker compose up --build
```

## The demo (§12 acceptance script)

`npm run demo` executes and asserts:

1. Publish V1 (warfarin+aspirin → no interaction); all sites converge; epoch = 1.
2. Inject chaos: site-b latency = 4000ms (site-a stays fast).
3. Publish V2 (severe interaction). Fast sites' watermarks jump to 2; site-b
   lags at 1; **epoch stays at 1** — gated by the slowest site.
4. **During the gap**, submit the identical order to all sites:
   - all sites return `fires=false, severity=NONE, epochUsed=1` — identical,
   - even though site-a/c already have V2 cached (`watermarkAtEval=2`),
   - the caches are *demonstrably* out of sync at that exact moment.
5. Site-b catches up; epoch advances **atomically** 1 → 2 for everyone.
6. Re-submit the identical order: all sites return `SEVERE` @ epoch 2 together.
7. `/api/audit/verify` walks the hash chain — valid.

The dashboard shows the same story live: site cards flip to "cached ahead —
gated, not yet active", the epoch holds, and the side-by-side comparison shows
identical results with a **CONSISTENT** badge.

## Architecture

```
Central Reference Data Service (:4001)  — sole writer, assigns globalSeq,
                                          pushes via simulated network, owns ledger
        │ push (latency/jitter/drop + backoff)
        ▼
Site Agents (:4101-4103)                 — version-history cache, ACK watermark,
                                          epoch-gated evaluation
        │ ack(watermark)
        ▼
Convergence Coordinator (:4002)          — epoch = min(watermarks), pub/sub broadcast
        │ epoch:update
        ▼
Dashboard (:5173, React + WS)           — watermarks, epoch, chaos controls,
                                          side-by-side comparison, ledger viewer
```

## Repo layout

```
shared/                          # types, rule engine (pluggable black box),
                                 # hash-chained ledger, backoff+jitter utils
services/central-reference-service/
services/convergence-coordinator/
services/site-agent/             # started 3x with different env config
dashboard/                       # React + Vite live view
scripts/start-all.mjs            # local runner
scripts/demo.mjs                 # §12 acceptance test (headless)
docker-compose.yml               # one container per service
```

## API surface

```
POST /api/reference/rules              — publish new version (assigns globalSeq)
GET  /api/reference/rules
GET  /api/reference/rules/:ruleId/history
POST /api/sites                       — register site + network profile
PATCH /api/sites/:siteId/network      — live-tune latency/jitter/drop (chaos lever)
GET  /api/sites
GET  /api/epoch                       — current global active epoch (coordinator)
GET  /api/watermarks                  — all site watermarks + epoch (coordinator)
POST /api/orders                      — identical order → all sites (epoch-stamped)
GET  /api/orders/:orderId/results
GET  /api/audit                       — paginated hash-chained ledger
GET  /api/audit/verify                — walk chain, report integrity
WS   /ws/live                         — live events for the dashboard
WS   /ws/epoch                        — epoch pub/sub for site agents
```

## Honest caveats (say these if a judge pushes)

- The sites are **logically** distributed (separate processes/containers on one
  host), not multi-region infrastructure.
- The ledger is a **hash chain with a single trusted writer** — the data
  structure inside a blockchain, without decentralized consensus. That's the
  correct tool for tamper-evidence here; calling it "a blockchain" would be
  the overclaim.
- Storage is in-memory in this phase (MongoDB persistence is a later phase per
  the PRD's build plan); the consistency mechanism is unaffected.
- Auth/RBAC/rate-limiting (PRD §7.4–7.8) are later phases — the demoable core
  (Phases 0–4 + 10–11) is complete and passing.

## Phase status (PRD §13)

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Repo scaffold, health checks | ✅ |
| 1 | Central service: versioned rules + global sequence | ✅ |
| 2 | Site agents + simulated network (latency/jitter/drop) | ✅ |
| 3 | Convergence Coordinator + epoch computation + pub/sub | ✅ |
| 4 | Epoch-gated evaluation + conservative fallback | ✅ |
| 5 | Backoff+jitter on propagation/ACK/polling | ✅ |
| 6 | Hash-chained ledger + verify endpoint | ✅ |
| 10 | Dashboard (watermarks/epoch, order submit, chaos, ledger) | ✅ |
| 11 | Demo scenario scripting | ✅ |
| 7–9 | JWT auth, RBAC, sanitization, rate limiting | ⬜ next |
