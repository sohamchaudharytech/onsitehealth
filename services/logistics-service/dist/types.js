// ── Logistics domain types (self-contained; deliberately NOT in shared/) ──────
// This service is an independent bounded context: it must keep working even
// if the clinical reference-data services are down. Only the security
// primitives (JWT/RBAC/rate-limit/sanitize) come from @hc/shared.
export {};
//# sourceMappingURL=types.js.map