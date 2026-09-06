#!/usr/bin/env node
/** Start all services locally (no Docker needed): central, coordinator, N site agents. */
import { spawn } from 'node:child_process';

const procs = [];
const start = (name, cmd, env = {}) => {
  const p = spawn(cmd[0], cmd.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    cwd: process.cwd(),
  });
  p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  p.on('exit', (code) => console.log(`[${name}] exited ${code}`));
  procs.push(p);
  return p;
};

// SITE_AGENT_COUNT=N spawns N real site-agent processes (site-a..site-z,
// then site-aa..). The central service registers the first 3 via SITE_HOSTS
// by default; pass SITE_HOSTS to register more.
const SITE_AGENT_COUNT = Math.max(1, Number(process.env.SITE_AGENT_COUNT ?? 3));
const SITE_HOSTS = process.env.SITE_HOSTS ??
  Array.from({ length: SITE_AGENT_COUNT }, (_, i) => `localhost:${4101 + i}`).join(',');

console.log('Starting services...');
// Redis backs the shared rate limiter (auto-falls back to in-memory if absent)
await new Promise((resolve) => {
  const p = spawn('node', ['scripts/ensure-redis.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() });
  p.stdout.on('data', (d) => process.stdout.write(`[redis] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[redis] ${d}`));
  p.on('exit', resolve);
});
start('central', ['npx', 'tsx', 'services/central-reference-service/src/index.ts'], { PORT: '4001', SITE_HOSTS });
start('coordinator', ['npx', 'tsx', 'services/convergence-coordinator/src/index.ts'], { PORT: '4002' });
await new Promise((r) => setTimeout(r, 1000));

const siteIdFor = (i) => {
  // 0→a … 25→z, 26→aa … so SITE_AGENT_COUNT can exceed 26
  let n = i;
  let s = '';
  do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `site-${s}`;
};
for (let i = 0; i < SITE_AGENT_COUNT; i++) {
  start(siteIdFor(i), ['npx', 'tsx', 'services/site-agent/src/index.ts'], { SITE_ID: siteIdFor(i), PORT: String(4101 + i) });
}

console.log(`\nAll services starting (${SITE_AGENT_COUNT} site agents). Dashboard: cd dashboard && npm run dev → http://localhost:5173`);
console.log('Run the acceptance demo: npm run demo\n');

const shutdown = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
