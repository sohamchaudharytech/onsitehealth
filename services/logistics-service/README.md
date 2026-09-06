# Medicine Logistics — Real-Time Shipment Tracking

An **independent** service + dashboard that tracks the location of medicine/drug
deliveries in real time. Every shipment is in exactly one of three states:

| Status | Meaning |
|--------|---------|
| `NOT_SENT` | created, waiting at the depot |
| `IN_TRANSIT` | on the way — live GPS position streams to the dashboard |
| `DELIVERED` | arrived & signed |

This is a **separate bounded context** from the clinical reference-data
network: it runs as its own process, has its own users, ledger, and database
(in-memory), and keeps working even if the central/coordinator/site services
are down. It deliberately reuses only the **security primitives** from
`@hc/shared` (JWT auth, refresh rotation + theft detection, RBAC, NoSQL
sanitization, rate limiting, hash-chained ledger) so it follows the same
middleware pipeline and trust model.

## Quick start

```bash
npm install                      # workspace install (picks up services/logistics-service)

# terminal 1 — the logistics service
npm run dev -w services/logistics-service     # http://localhost:4301

# terminal 2 — the logistics dashboard (own deps, like the clinical dashboard)
cd dashboard-logistics && npm install && npm run dev   # http://localhost:5174
```

Or both at once:

```bash
node scripts/start-logistics.mjs
```

The existing clinical services are **not** required — but if they're running,
everything coexists (different ports).

## What you see

- **Live map** (SVG, no external tiles): every shipment's breadcrumb trail,
  current position, origin depot, and destination. Auto-zooms to fit active
  cargo. Click a shipment to select it.
- **Status cards**: not sent / on the way / delivered counts.
- **Shipment detail**: route, distance, remaining km, ETA, progress bar,
  GPS ping count, and (for dispatchers) buttons to advance the lifecycle.
- **Live event log**: streamed over WebSocket — creation, status changes,
  and every GPS ping.
- **All shipments table** with status filter and progress bars.
- **Dispatch form** (admin/operator): create a new shipment from a route
  preset; it starts `NOT_SENT` and can be dispatched.
- **Ledger integrity check** (admin/auditor): walks the hash chain.

A movement simulator advances every `IN_TRANSIT` shipment along its route
every 2s (configurable) and auto-delivers on arrival — so the dashboard is
alive immediately, no manual clicking needed. A **demo loop** dispatches a
fresh batch whenever everything has arrived, so the map never goes static
(set `DEMO_LOOP=0` to disable).

## Demo accounts

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin123` | admin — everything |
| `dispatcher` | `dispatcher123` | operator — create/dispatch shipments |
| `driver` | `driver123` | operator — mark delivered |
| `auditor` | `auditor123` | auditor — ledger + integrity check |
| `viewer` | `viewer123` | viewer — read-only tracking |

## API surface

```
POST /api/auth/login              — username+password → JWT + refresh token
POST /api/auth/refresh            — rotate refresh token (reuse = revoke family)
POST /api/auth/logout             — revoke refresh token family
GET  /api/shipments               — all shipments (?status=NOT_SENT|IN_TRANSIT|DELIVERED)
GET  /api/shipments/:id           — one shipment (by id or orderCode)
POST /api/shipments               — create (admin/operator) → starts NOT_SENT
POST /api/shipments/:id/status    — advance lifecycle (admin/operator)
GET  /api/audit                   — paginated hash-chained ledger (admin/auditor)
GET  /api/audit/verify            — walk chain, report integrity (admin/auditor)
GET  /internal/shipments          — service-to-service (x-internal-key)
WS   /ws/live                     — live events for the dashboard (?token=)
```

Lifecycle is strictly `NOT_SENT → IN_TRANSIT → DELIVERED`; illegal
transitions (e.g. back from `DELIVERED`) are rejected with 409.

## Configuration (env)

| Var | Default | |
|-----|---------|---|
| `PORT` | `4301` | service port |
| `SIM_TICK_MS` | `2000` | GPS ping interval per shipment |
| `SIM_SPEED` | `0.035` | fraction of route advanced per tick |
| `DEMO_LOOP` | `1` | set `0` to stop auto-dispatching demo batches |
| `JWT_SECRET` | dev default | override outside local dev |
| `INTERNAL_KEY` | dev default | for `/internal/*` routes |

## Design notes

- **Independent by design**: no imports from the clinical services, no shared
  runtime state, own port, own users. Only `@hc/shared`'s security layer is
  reused — the same trust model, so a JWT from this service is meaningless to
  the clinical services and vice-versa (different issuer context, same
  middleware discipline).
- **Same middleware pipeline** as the rest of the network:
  `helmet → cors → json (size-capped) → request-id/logger → rate limiter →
  sanitize → JWT auth → RBAC → handler → error handler`.
- **Hash-chained ledger** for tamper-evident audit of every shipment
  creation/status change (same honest caveat as the clinical ledger: single
  trusted writer, not decentralized consensus).
- **In-memory storage** — MongoDB persistence is a later phase, same as the
  clinical services.
