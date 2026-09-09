# Project Progress Report

**Project:** Distributed Clinical Reference-Data Consistency for Alert Generation  
**Report date:** 2026-09-08  
**Report scope:** Product specification, implementation source, packages, TypeScript configuration, Docker Compose, start scripts, acceptance script, dashboards, runtime persistence files, Git history, and generated-artifact hygiene. No application source/config file was intentionally modified.

## Executive Summary

The core clinical consistency project is substantially complete and demoable. The epoch-gated convergence mechanism is implemented across the central rule publisher, site agents, and convergence coordinator: rule versions carry monotonic `globalSeq` values, sites retain version history, the coordinator advances only at the minimum acknowledged watermark, and the central service stamps a single epoch per order before fan-out. The acceptance script covers the required lag-gap scenario, atomic cutover, audit integrity, auth/RBAC denial, sanitization, and rate limiting.

The production-facing hospital workflows are also broad and operational at hackathon scope: authenticated role-specific dashboards, real hospitals, hundreds of simulated hospitals/doctors, doctor rule publishing with attribution, per-hospital formularies, patient accounts/history/visits, nurse masking/logins, dark/light mode, live events, and audit views. An independent real-time medicine logistics service and two dashboards are additionally implemented.

The initial audit identified four priority remediation areas. As of this report update, the broken seed command is fixed, deterministic core tests are present, both dashboards are included in aggregate build/type checks, Compose includes logistics and persistent volumes, and central rules/sites/hospitals/users/formularies/patients restore from an atomic JSON snapshot. Remaining limitations include site/coordinator/logistics durability, MongoDB, full integration tests, production packaging, and repository generated-file cleanup.

Overall status: **Core feature complete; supporting persistence, test automation, packaging, and deployment hardening incomplete.**

## Verification and Evidence

- **Backend TypeScript strict check:** Passed with zero diagnostics when compiling all hand-written backend sources from `shared/src`, central service, coordinator, site agents, and logistics service.
- **Core unit tests:** Six deterministic tests pass, covering cache snapshot/pruning, epoch evaluation/provisional fallback, coordinator minimum watermark, and ledger tamper detection.
- **Clinical dashboard build:** Passed.
- **Logistics dashboard build:** Passed.
- **Prebuilt artifacts:** `shared/dist` and all four backend service entry points under `dist/` exist.
- **End-to-end acceptance run:** Not verified in this sandbox. Services could not launch because `tsx` attempted to create an IPC pipe in the system temp directory and received `EPERM`; the six background processes exited before binding their HTTP ports. This is an execution-environment restriction observed during this audit, not evidence of application failure.
- **Working tree:** Clean before this report. Inspection/build fingerprint files touched during the audit were restored; this `progress.md` is the only intended difference.
- **Repository history:** Ten commits, from initial system implementation through admin workflows, patients/nurses, live events, logistics, and bug fixes.

## PRD Phase Status

| Phase | Scope | Status | Notes |
|---|---|---|---|
| 0 | Scaffold, Docker Compose, health checks | **Complete** | Compose runs central/coordinator/3 sites/Mongo/Redis/dashboard, though it omits logistics. All services expose health checks. |
| 1 | Central versioned rules + global sequence | **Complete** | Immutable versions, per-rule versioning, and monotonic `globalSeq` are implemented. |
| 2 | Site agents + latency/jitter/drop simulation | **Complete** | Real site-agent processes and in-process scale-test hospital agents implement push/evaluate/ACK. |
| 3 | Coordinator, epoch calculation, pub/sub | **Complete** | Minimum-watermark epoch, epoch-only advancement, dashboard JWT WebSocket, and internal-key agent WebSocket are implemented. |
| 4 | Epoch-gated evaluation + fallback | **Complete** | Orders are stamped once; sites evaluate `snapshotAsOf(orderEpoch)`. Uncertainty yields conservative severity and provisional marking. |
| 5 | Backoff/jitter on propagation/ACK/polling | **Complete** | Retries have exponential backoff/jitter; ACK and epoch subscription have retry/fallback; epoch polling is defense-in-depth. |
| 6 | Hash-chained ledger + verification | **Complete for central; partial elsewhere** | Clinical ledger and refresh events can persist to JSONL. Logistics has an in-memory hash chain but does not persist it. |
| 7 | JWT auth + refresh rotation + theft detection | **Complete at runtime; partial persistence** | 15-minute JWTs, hashed rotating refresh tokens, family revocation on reuse, and logout are implemented. Central refresh events persist; users/rules/domain records do not. |
| 8 | RBAC + sanitization pipeline | **Complete** | Shared middleware applies Helmet, JSON limits, request IDs/logging, rate limiting, sanitization, JWT, and RBAC. |
| 9 | Rate limiting + abuse detection | **Complete for central; partial for logistics** | Central uses Redis-backed cross-instance limiter with in-memory fallback. Coordinator and logistics use per-process in-memory limits. |
| 10 | Dashboard, orders, chaos, ledger | **Complete** | Main React dashboard covers live watermarks/epoch, submissions, chaos, event log, audit, role pages, and embedded logistics. |
| 11 | Demo scenario and seed data | **Complete** | `npm run demo` is comprehensive. Startup seeds defaults, and `npm run seed` now safely publishes only a missing V1 demo rule. |
| Stretch: patient management | Extended product feature | **Complete for demo scope** | Patient portal, create/change/deactivate/reactivate, history, visits, and medication interaction recomputation are implemented. |
| Stretch: nurse management | Extended product feature | **Complete for demo scope** | Admin/doctor nurse CRUD and masked patient lookup are implemented. |
| Stretch: logistics tracking | Independent feature | **Complete for demo scope** | Service and both standalone/embedded dashboards are implemented; persistent storage remains incomplete. |
| Stretch: MongoDB storage | Remaining work | **Not implemented** | Mongo is in Compose but no application code connects to it. |
| Stretch: physical multi-region/decentralized trust | Explicit non-goal | **Not implemented** | This remains logically distributed on one host, as documented. |

## Feature Progress

### Core Consistency Mechanism

**Status: Complete**

- The central service publishes an immutable rule version for every rule update and assigns a single monotonic `globalSeq`. Each rule has its own sequential version, while all rules share the global order.
- The central store retains all versions and can export history or the latest versions for UI and attribution.
- Site caches retain full rule history by default and provide a `prune(keep = 20)` method, but no site currently calls it. `snapshotAsOf(n)` reconstructs the exact rules active at a global sequence.
- Site agents expose internal push, evaluate, state, and result endpoints. They ingest pushed versions, ACK their watermark, broadcast live events, and retain results in memory.
- The coordinator keeps a watermark per known site, computes `epochSeq = min(watermarkSeq)`, and only advances. Removing a hospital also removes its coordinator watermark.
- Central order submission fetches the coordinator epoch once, stamps that epoch on the order, and fans the identical payload to all selected sites. Every evaluation response records `epochUsed` and the site’s local `watermarkAtEval`.
- A site that cannot satisfy the stamped epoch evaluates the most conservative result it can derive, marks the result provisional, and does not silently suppress the alert.
- Epoch updates are broadcast to subscribers, with a 1.5-second polling fallback if a WebSocket message is missed.
- The acceptance scenario explicitly creates divergent local watermarks and checks that all site outputs remain identical during the propagation gap, then switch together after convergence.
- **Residual limitation:** Sites and coordinator do not persist cache/version/watermark state, so a process restart begins at watermark/epoch zero even though the central ledger retains historical events. Rule history grows without pruning in long-running sites.

### Simulated Network and Scalability

**Status: Complete for current demo/scale-testing scope**

- Site profiles include base latency, jitter, and packet drop rate and are configurable per registered site.
- Propagation has bounded retries, exponential backoff, and jitter. Failed attempts and eventual receipt are broadcast and ledgered.
- `start-all.mjs` can launch any number of real site-agent processes via `SITE_AGENT_COUNT`, with generated IDs and ports.
- Admin-generated simulated hospitals run as real HTTP servers inside the central process, implementing the same internal push/evaluate contract and initial watermark ACK.
- Generated hospital names, regions, doctors, and doctor passwords are deterministic enough for dashboards and generated credential display. Rule history is replayed to newly attached hospitals.
- Simulated hospital ports are allocated from 4501 upward. Statistics and code demonstrate support for 50–500 hospitals.
- **Residual limitation:** Simulated hospitals disappear on central restart, and the scale limit is not covered by an automated benchmark.

### Central Reference Service

**Status: Feature-complete; storage partially durable**

Implemented surfaces and workflows:

- Public health check and authenticated API.
- Login, refresh-token rotation, logout, JWT issue/verification.
- Rule publish/list/history with publisher attribution and content hashes.
- Rule fan-out and receipt/attempt audit.
- Site registration, list, network profile update, hospital registration/deletion, and simulated hospital generation.
- Doctor CRUD and simulated doctor generation.
- Hospital detail, per-hospital and multi-hospital drug provisioning.
- Patient CRUD, patient portal, history, visits, activation/deactivation, and nurse lookup.
- Nurse CRUD.
- Audit list and verification, recent events, user management.
- Internal epoch-advance and evaluation ingestion.
- Order barrier-read/stamp/fan-out and result retrieval.
- Dashboard live-event WebSocket with JWT query authentication.

Persistence:

- `.data/ledger.jsonl` records every clinical audit block and is rehydrated/verified on startup.
- `.data/refresh.jsonl` records refresh grants/revocations and is reduced on startup.
- Rules, sites, hospitals, users, patients, formularies, and visit/history state remain in memory. A restart therefore restores audit/token events but not the domain objects or rules those blocks describe.

### Convergence Coordinator

**Status: Feature-complete for demo scope; volatile state**

- Maintains site watermarks and global epoch.
- Publishes watermark and epoch updates.
- Guards internal ACK/epoch/remove endpoints with the internal key.
- Exposes authenticated read-only epoch, sites, and watermark APIs.
- Routes `/ws/epoch` separately from dashboard connections:
  - agent path uses an internal-key query parameter;
  - dashboard path uses a JWT query parameter.
- Notifies central of epoch advances so central can append an audit block.
- **Residual limitation:** All coordinator state is in memory and no durable state store is implemented.

### Site Agent Service

**Status: Feature-complete for demo scope; volatile state**

- Internal-key-guarded push/evaluate/state/results endpoints.
- Dynamic site ID, port, coordinator URL, central URL, and internal key via environment.
- Ingests rule versions, ACKs watermarks, and evaluates against the stamped epoch.
- Retries ACK delivery with bounded backoff and jitter.
- Subscribes to epoch updates and falls back to polling.
- Keeps the dashboard connection open without exposing human JWT/UI routes.
- **Residual limitations:** Rule history and evaluation results are in memory; no identity configuration beyond the assigned site ID is implemented.

### Shared Core and Domain Engine

**Status: Complete**

- `SiteCache`: rule version history, watermark, and snapshot reconstruction.
- `DrugInteractionEngine`: generic rule-engine interface with severity selection.
- `EpochGatedEvaluator`: per-order epoch stamping, strict snapshot evaluation, and conservative provisional fallback.
- `mostConservative` and `resultsEqual` helpers.
- Hash-chain ledger with append-only blocks, canonical JSON hashing, and integrity verification.
- Retry/backoff/jitter and network delay/drop simulation helpers.
- Auth primitives: HS256 JWT, scrypt password hashing, opaque refresh tokens, hashing, unverified attribution decode, and constant-time comparisons.
- HTTP middleware: request IDs/logging, JWT auth, internal-key guard, and safe error handling.
- Redis limit adapter with Lua sliding-window logic and degraded in-memory fallback.
- RBAC, sanitization, network utility helpers, and shared API types.
- **Generated-source issue:** Hand-written `.ts` files have older `.js`, `.d.ts`, and map files committed beside them in `shared/src`; the authoritative build output is also produced in `shared/dist`. These duplicate generated artifacts should be untracked in future cleanup.

### Authentication and Session Security

**Status: Complete for implementation scope; not production-hardened**

- Clinical access/login APIs issue a 15-minute JWT and an opaque refresh token.
- Refresh tokens are stored only by SHA-256 hash. Presentation rotates the token, creates a successor, and marks the current token consumed.
- Presenting a reused/rotated token revokes the entire user refresh-token family.
- Logout requires a JWT and revokes all refresh tokens for the user.
- Passwords are salted and hashed with scrypt; verification compares hashes in constant time.
- JWT verification checks HMAC signature and expiry.
- Dashboard sessions are persisted locally, boot-validated, and automatically refreshed on 401.
- A single-flight refresh lock prevents concurrent requests from racing token rotation.
- Logistics uses the same design with its own user store and token family, and therefore its own trust domain.
- Dashboards support explicit sign-out and avoid auto-logout after successful session recovery.
- Public endpoints are limited to health and auth login/refresh; internal service routes use a different shared-key trust domain.
- **Security caveats:** Access tokens and refresh tokens are stored in browser `localStorage`, which is XSS-sensitive. Dev defaults for JWT/internal secrets are intentionally insecure and must be overridden. Central request audit attempts IP/MAC attribution, but MAC is only reliable on a LAN and is best-effort behind NAT.

### RBAC and Sanitization

**Status: Complete**

- Roles include admin, operator, auditor, viewer, doctor, patient, and nurse.
- Permission maps cover dashboard view, rule publication, order submission, audit, formulary, hospitals, users, patient management/lookup, and nurse management.
- Route-level `requirePermission` is applied consistently across management operations.
- Patient-specific routes use role identity rather than a broad patient management permission.
- Sanitization recursively strips `$`-prefixed and dotted keys, trims strings, and caps lengths before auth/RBAC and handlers.
- All request bodies are size-capped (256 KB central, 64 KB agents/simplified services).
- The acceptance script verifies anonymous access is rejected, viewer publishing is forbidden, and operator-injection input is neutralized.

### Rate Limiting and Abuse Detection

**Status: Complete for central; simplified elsewhere**

- The central service uses `RedisSlidingWindowLimiter` from shared code.
- Rules include topic-specific sliding windows and repeat-offender escalation.
- Redis keys support cross-instance limits. Central startup/start scripts provide Redis discovery and AOF persistence.
- Redis failures first use a local request fallback, then degrade to per-process mode after repeated connection failures.
- Coordinator uses the in-memory shared limiter.
- Logistics uses the shared in-memory limiter, not Redis.
- The clinical acceptance script proves login abuse returns 429 with `Retry-After`.
- **Honest scope:** This is application-layer identity/IP abuse mitigation, not infrastructure DDoS protection.

### Audit Ledger and Event Log

**Status: Central implementation complete; logistics partial**

Clinical:

- Every significant action is appended to a SHA-256 hash chain: logins, rule publications, deliveries, chaos changes, hospital/user/patient/nurse/formulary operations, patient changes/visits, rule propagation effects, epoch advances, evaluations, and ledger events.
- Every audit block contains index, timestamp, event type, payload, previous hash, and current hash.
- `/api/audit` is paginated; `/api/audit/verify` walks all predecessor links and recalculates hashes.
- Ledger blocks persist to append-only JSONL and are reconstructed/verified at startup.
- The dashboard exposes an integrity check and recent live event feed. Live event and ledger payloads include actor and request-origin details where available.

Logistics:

- Shipment creation, dispatch, delivery, status changes, and logins have a hash-chained ledger.
- Audit and verification APIs are implemented with pagination.
- **Limitation:** Logistics ledger and users are in memory and reset on restart.

### Main Clinical Dashboard

**Status: Complete**

Implemented user experiences:

- Login and persistent session recovery.
- Theme toggle and reusable layout.
- Main epoch/watermark/order dashboard:
  - global active epoch and latest-sequence display;
  - publish V1 and V2 buttons for demo scenarios;
  - identical-order submission to all sites;
  - per-site latency chaos control;
  - lagging/ahead site cards;
  - side-by-side result comparison and consistent/mismatch badge;
  - live event log;
  - audit integrity check.
- Admin dashboard:
  - hospitals, doctors, rules, simulation, users, patients, nurses, and formularies;
  - real/simulated hospital and doctor creation;
  - hospital and doctor search/filter;
  - generated credential display and simulated hospital generation;
  - drug provisioning to selected hospitals.
- Doctor page:
  - hospitals/formularies, patient list, rule publication with attribution, and view of propagation/epoch status.
- Patient portal:
  - read-only demographic/condition/medication/interaction records;
  - visit trail and append-only history.
- Nurse page:
  - patient lookup by portal email and masked result only.
- Hospital page:
  - doctor/formulary/patient summaries and drug management.
- Embedded logistics page with its own auth domain and live tracking map.
- Vite proxies route central/coordinator APIs, main WebSocket, logistics API, and logistics WebSocket correctly.
- **Packaging note:** Dashboard is a root workspace and has its own Vite build, but root `npm run build` builds only backend TS references.

### Hospital, Doctor, Formulary, and Simulation Features

**Status: Complete for demo/operational scope**

- Three default real hospitals are seeded at startup.
- Admin can create real or simulated hospitals, remove hospitals with doctor-affiliation guardrails, and generate batches of simulated hospitals.
- Admin and doctors can add/remove doctors and generated doctors display editable random credentials.
- Hospital records include name, region, simulated flag, creation time, network profile, doctor count.
- Hospital details expose network profile, drugs, doctors, patients with recent visits, and clinical metrics.
- Formularies are per hospital and support add, remove, and provisioning to selected subsets with skipped/duplicate explanations.
- Rule publication records publisher identity, role, hospital affiliation, timestamps, hashes, and rule version/history.
- **Limitation:** All hospital/user/formulary state is in memory; only audit records persist.

### Patient Management

**Status: Complete for demo scope**

- Admin/doctor can create a patient along with a portal email/password.
- Human-readable patient IDs are allocated as `P-000123`.
- The portal login is linked to the patient record and stored as a scrypt-hashed user.
- Admin/doctor can update demographic/clinical fields and email; changes record before/after and reason.
- Admin/doctor can deactivate/reactivate without hard deletion.
- Admin/doctor can add hospital visit reason/time and the patient sees the visit trail.
- Patient portal is read-only, identity-scoped to the logged-in patient only, and returns history/visits for transparency.
- Medication changes recompute interaction labels in the same change block.
- Rule publication/reclassification automatically re-evaluates matching active patients, appends a before/after history block, and mirrors the change to the hash chain.
- Deactivated patients cannot access their portal.
- **Limitation:** Patient records, histories, visits, and their linked users are all in memory and not durable.

### Nurse Management and Masked Lookup

**Status: Complete**

- Admin/doctor can create and remove hospital-associated nurse accounts.
- Nurse creation produces credentials for the admin/doctor to hand off.
- Nurse role has only the masked lookup permission.
- Nurse supplies the patient portal email and receives only:
  - partially masked name;
  - age;
  - gender;
  - condition;
  - medicines;
  - last visit date/reason.
- Nurse lookup does not expose patient ID, email, DOB, contact details, full history, visits, drug IDs, or account state.
- **Limitation:** Nurses and lookup state are in memory.

### Central Persistence and Runtime State

**Status: Central domain state complete; site/coordinator/logistics still volatile**

Persisted:

- Clinical ledger blocks.
- Refresh-token event log.
- Central domain snapshot (`state.json`) for rules/global sequence, sites, hospitals, formularies, users, patients, patient history, and visits.

Volatile:

- Site agent rule history and evaluation results.
- Coordinator epoch/watermarks.
- Logistics state and ledger.
- Redis rate-limit counters persist only while the local Redis AOF directory survives; in-memory mode does not.

Consequences:

- A central restart restores its active domain objects and audit/token streams; simulated hospital agents are deliberately not restarted.
- A coordinator/site restart resets watermarks and epoch even if central still considers sites registered, causing an epoch-stability gap until fresh ACKs arrive.
- A logistics restart resets shipments and audit history to seeded demo data.

### Real-Time Medicine Logistics

**Status: Complete for demo scope; not durable**

Service:

- Independent Express service on port 4301 with volatile shipment and user stores.
- Dedicated users: admin, dispatcher, driver, auditor, viewer.
- Shipment lifecycle is strictly `NOT_SENT → IN_TRANSIT → DELIVERED`; repeated/same-state/terminal transitions return 409.
- Shipment creation accepts order code, medicine, quantity, cold-chain flag, origin, and destination.
- Shipment lookup supports shipment ID or order code.
- Shipment list supports status filtering.
- Dispatch and delivery are restricted to admin/operator.
- GPS movement simulation pushes a location every configurable tick and auto-delivers on arrival.
- Continuous demo loop is enabled by default and can be disabled with `DEMO_LOOP=0`.
- Dashboard events include creation/status updates and location pings.
- Audit and integrity check APIs are implemented.
- Internal shipment endpoint is guarded with the internal key.
- WebSocket is JWT-authenticated through a query token.

Dashboards:

- Standalone dashboard on port 5174:
  - SVG map with no external tiles;
  - breadcrumb/current/origin/destination display;
  - status cards and filter;
  - detail panel with distance, ETA, progress, and GPS count;
  - dispatch form and lifecycle actions;
  - live event log and shipment table;
  - audit verification;
  - theme toggle.
- Embedded logistics page in the main dashboard:
  - same map, status, event, form, and audit functions;
  - separate logistics auth domain and localStorage session key;
  - proxies via `/logistics-api` and `/logistics-ws`.

Limitations:

- All logistics state is in memory.
- No shipment deletion is needed because lifecycle is terminal; there is also no archive/import.
- The logistics ledger does not persist.

### Start Scripts and Local Orchestration

**Status: Mostly complete**

- `scripts/start-all.mjs` boots Redis, central, coordinator, logistics, and N configured site agents.
- Redis bootstrap:
  - uses an existing server if one answers;
  - starts a previously compiled build;
  - downloads and compiles Redis once if absent;
  - enables AOF persistence;
  - does not treat Redis failure as fatal because app services fall back.
- `scripts/start-logistics.mjs` boots only the logistics service and standalone dashboard.
- `scripts/demo.mjs` executes the full acceptance workflow and security checks.
- **Broken task:** `package.json` contains `npm run seed`, but `scripts/seed.mjs` does not exist. The command fails. Startup users/rules/shipments currently seed internally, so the script is redundant unless intended as a dedicated reset/reseed command.
- **Sandbox limitation:** `start-all` depends on `npx tsx`, which creates a sandboxed IPC pipe and failed in the restricted execution environment with `EPERM`; it can still work normally on the user’s workstation/Docker.

### Docker and Compose

**Status: Core Compose complete; full-stack packaging partial**

Implemented:

- `Dockerfile.service` for central/coordinator/site backend files.
- `Dockerfile.dashboard` for the clinical dev dashboard.
- Compose contains Mongo, Redis, central, coordinator, three site agents, and the dashboard.
- Services use separate logical containers and service DNS names.
- Mongo and Redis images are configured.

Gaps:

- Compose omits `logistics-service` and `dashboard-logistics`.
- Root dashboard Compose service does not run alongside its own build step; it runs Vite in development mode.
- No production static-serve/build image is provided.
- Compose runs backend sources through `npx tsx`; the production start scripts expect prebuilt `dist` files but Compose does not invoke a prior build.
- Mongo’s health/readiness is configured, but no application uses Mongo.
- Compose does not define environment persistence volumes for `.data` or Redis AOF.
- Compose validation in this environment returned no service list, so container execution was not verified.

### Build, TypeScript, and Workspace Configuration

**Status: Functional but inconsistent**

- Root `npm run typecheck` and `npm run build` use project references for shared, central, coordinator, site agent, and logistics backend.
- Backend strict type checking passes.
- Both dashboards have separate strict TypeScript projects and type checks pass.
- Root workspaces include `services/*`, `shared`, and `dashboard`.
- `dashboard-logistics` is intentionally installed as its own package, not a root workspace; this works but means root workspace commands do not manage it.
- Root build does not build dashboards; each dashboard has its own `build`.
- Backend package/build process rewrites tracked `.tsbuildinfo` files, creating noisy diffs even for semantic no-op checks.
- `Dockerfile.service` copies package manifests, installs dependencies, then copies source and services, but does not explicitly build TypeScript because Compose chooses `tsx`.

### Documentation

**Status: Complete and generally accurate**

- `README.md` covers architecture, core idea, quick start, acceptance narrative, security, API, users, phase status, honest caveats, and logistics integration.
- `prd.md` defines the problem, goals/non-goals, architecture, resilience, security/storage requirements, API, demo, phases, risks, and stretch goals.
- `services/logistics-service/README.md` separately documents the API, roles, lifecycle, map, simulation, caveats, and configuration.
- Documentation honestly distinguishes logical distribution from multi-region and a hash chain from decentralized blockchain.
- Documentation says storage is in memory in this phase; this report further clarifies that clinical ledger and refresh events are the only JSONL-durable parts.

Gaps:

- `README.md` still claims “storage is in-memory” broadly; it should clarify ledger/refresh persistence while the domain remains volatile.
- Docker/Compose documentation omits the fact that logistics is not represented in Compose.
- README quick start does not mention that `npm run seed` is currently broken/missing.
- Root README could state dashboards are built separately when everyone is expected to run typecheck/build.

## Broken / Defects Found

1. **Broken seed command:** `npm run seed` executes `node scripts/seed.mjs`, but no file exists at `scripts/seed.mjs`. Status: **Broken**. Fix by adding the script or removing/updating the package command.
2. **Inconsistent persistence:** Central domain/rule state is volatile while audit blocks and refresh events persist. A restart yields historical audit data that cannot be explained by the active in-memory domain. Status: **Design mismatch/partially incomplete**.
3. **No automated tests:** No unit, route, convergence, or integration test runner is configured. Only `demo.mjs` covers live behavior and requires manually started services. Status: **Incomplete**.
4. **Root build excludes dashboards by default:** `npm run build` remains backend-only for compatibility, but `npm run build:all` and `npm run typecheck:all` now build both dashboards. Status: **Resolved with an explicit aggregate command**.
5. **Compose previously omitted logistics:** Compose now includes logistics, its dashboard, named Redis/Mongo volumes, and a central `.data` bind volume. Status: **Resolved**.
6. **Mongo unused:** Mongo is provisioned but never accessed. Status: **Config-only/remaining work**.
7. **Volatile coordinator/site state:** Epoch, watermark, rule cache, and results reset on restart. Status: **Remaining persistence work**.
8. **Logistics audit is not durable:** Its hash chain and users reset on restart. Status: **Remaining persistence work**.
9. **Cross-instance rate limiting incomplete:** Central only. Coordinator/logistics rely on in-memory, per-process limits. Status: **Partial**.
10. **Repository contains generated outputs:** 5,948 paths matching `node_modules`, `dist`, `.tsbuildinfo`, and generated shared/src JS/maps are tracked in Git. This bloats history and makes no-op builds dirty. Status: **Repository hygiene defect**.
11. **Runtime launch not verified in restricted sandbox:** `tsx` failed creating an IPC pipe before app HTTP listen, so local Docker/terminal verification remains outstanding under an unrestricted environment. This is **not established as a code defect**.
12. **Dev secrets:** Default JWT/internal keys and static demo credentials make local demos work but would be unsafe outside local development. Status: **Production hardening incomplete**.
13. **Browser token storage:** Access and refresh tokens persist in `localStorage`; this is convenient but not XSS-resistant. Status: **Production hardening incomplete**.
14. **Site history is not pruned:** `SiteCache.prune(20)` is implemented but never invoked, so long-running site agents retain every rule version indefinitely. Status: **Incomplete memory-bound policy**.

## Partial Work

- **Clinical persistence:** Central rules/users/hospitals/formularies/patients are snapshot-durable; site/coordinator state remains volatile.
- **End-to-end verification:** Core deterministic tests now pass. Full multi-process acceptance still requires an environment that permits local ports/IPC.
- **Deployment:** Compose now includes logistics and persistent volumes, but production images, build-only stages, health policy, and secret management remain incomplete.
- **Static analysis:** strict TS covers compile-time safety, but lint, formatting, dependency scanning, or audit CI is not configured.
- **Rate limiting:** Redis-backed central is strongest; coordinator/logistics remain per-process.
- **One-command build:** Backend is one command, UI projects are separate.

## Incomplete / Remaining Tasks

### Must Do Before Production
1. Add MongoDB or another durable store for:
   - rule versions and current global sequence;
   - hospitals, doctors, nurses, patients, formularies;
   - site registrations and profiles;
   - coordinator watermarks and epoch;
   - site rule history/results if post-restart history is required;
   - logistics shipments/users/audit.
2. Fix `npm run seed` by adding the missing script or removing the command.
3. Add service shutdown/restart recovery tests and run the acceptance demo against empty persisted state.
4. Add persistent volumes in Compose for `.data` and Redis AOF.
5. Keep token security but consider safer session storage and explicit CSRF/browser-hardening review.
6. Require production secrets and fail closed outside explicit demo mode.
7. Replace dev credentials with an environment-controlled seed process.
8. Complete production build/packaging:
   - build backend TypeScript in Docker or use prod dist only;
   - build and serve dashboards statically;
   - add health-based restart policy and image tagging;
   - include logistics in Compose or document it as standalone.
9. Add centralized request logging and metrics beyond localhost event display.

### Quality Tasks
10. Add unit tests for:
    - SiteCache, watermark, and snapshotAsOf behavior;
    - EpochGatedEvaluator normal and fallback behavior;
    - coordinator monotonicity, min watermark, and site removal;
    - auth rotation/family revocation;
    - ledger hash links/tamper detection;
    - patient history change and interaction recomputation.
11. Add integration tests for:
    - cluster startup and site registration;
    - epoch barrier read under high latency/drop;
    - out-of-sync watermark behavior;
    - new-site replay;
    - patient/nurse permission boundaries;
    - logistics lifecycle rules.
12. Add nightly/CI full-build stage covering:
    - root backend TS build;
    - dashboard TS build;
    - logistics dashboard TS build;
    - lint/format if added;
    - app acceptance run in an ephemeral environment.
13. Document and enforce Redis failure behavior.
14. Add scale benchmark script to verify 50/250/500 agent claims.
15. Add minimal product configuration validation for ports, URLs, secrets, and numeric simulation settings.

### Cleanup Tasks
16. Untrack all `node_modules`, `dist`, Vite build outputs, `.vite`, `.tsbuildinfo`, and duplicate `shared/src/*.js/*.d.ts/*.map` files.
17. Add matching ignore patterns for all generated directories if any remain after staging already-tracked files.
18. Re-factor monolithic central and dashboard modules into manageable domain files without changing API.
19. Add route-level OpenAPI/schema documentation after persistence/state/API stabilizes.
20. Clean up legacy imports, duplicate type declarations, and shared generated artifacts.
21. Verify Docker images and Compose service resolution on an unrestricted host.
22. Add README clarification for actual persistence now that ledger/refresh data is not in memory.

## Task-Level Checklist

| Area | Completed | Partial / In progress | Not started / remaining |
|---|---|---|---|
| Architecture | Central rule order, epoch coordinator, MVCC cache, barrier stamping, generic evaluator, fallback | Durable coordinator/site replay strategy after restart | Physical multi-region, consensus, production clustering |
| Clinical API | Auth, rules, hospitals, users, patients, nurses, formulary, audit, orders, events, internal routes | API docs/OpenAPI | Formal API versioning |
| Convergence | All acceptance sections in implementation | Prove behavior after full restart | Network partition beyond drop/latency |
| Storage | Clinical ledger JSONL, refresh JSONL, central domain snapshot, Redis AOF | Site/coordinator recovery | Logistics persistence |
| Security | JWT, scrypt, rotate + reuse detect, RBAC, sanitization, body limits, internal key, rate limit demo | Prod secrets, browser session review | Secret rotation/issue management |
| Observability | Request IDs/logs, audit chain, live events, WebSocket | In-memory event buffer and localhost log surfaces | Metrics/traces/external log sink |
| Dashboards | Clinical and logistics UI, auth, themes, role portals, mapping, filters, metrics | Component cleanup | Automated UI tests/access test |
| Logistics | Live service/map/lifecycle/audit/auth, embedded and standalone UI, starter script, Compose services | Persistence | Mongo and shipment archive |
| Testing | Strict TS, deterministic core/auth/persistence tests | Full service integration tests and CI | Automated acceptance run |
| Deployment | Docker clinical+logistics stack, persistent volumes, health probes, local starter scripts, aggregate UI builds | Production images, health policy, secret management | Production packaging and orchestrated config |
| Docs | Three detailed documents | Volatility distinctions need refinement | Deployment playbook |
| Cleaning | .data/.redis ignored going forward | Legacy generated files still tracked | Node module history purge/rewrite |
| Configuration | Ports/env for most services, UI proxies | Full validation | Compose and prod environment management |

## Recommended Next Iteration

1. Remove or fix the `seed` script to eliminate the known broken package command.
2. Build minimal unit/api tests first around core consistency and auth, then run them in CI.
3. Implement MongoDB for rules/users/hospital-domain objects and coordinator/site watermark recovery.
4. Add logistics to Compose and give clinical `.data` and Redis persistent volumes.
5. Untrack all generated/dependency directories without rewriting historical Git commits if bloat can be tolerated, using `git rm --cached`.
6. Add one root command that produces all backend and dashboard production builds, and document it.
7. Re-run `scripts/demo.mjs` on an unrestricted host, then add its success timeout/retry behavior to a status dashboard.

## Current Quality Summary

- **Implementation completeness:** High.
- **Demo/scale feature scope:** High and beyond the original core PRD.
- **Persistence:** Low/partial.
- **Testability:** Low (manual acceptance script only, though static type checks pass).
- **Deployment readiness:** Medium-low.
- **Repository cleanliness:** Poor due to tracked dependencies/generated outputs.
- **Production readiness:** Low; current target is clearly a polished hackathon/demo system.
