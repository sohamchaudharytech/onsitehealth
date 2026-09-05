#!/usr/bin/env node
/** Start all services locally (no Docker needed): central, coordinator, 3 site agents. */
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

console.log('Starting services...');
start('central', ['npx', 'tsx', 'services/central-reference-service/src/index.ts'], { PORT: '4001' });
start('coordinator', ['npx', 'tsx', 'services/convergence-coordinator/src/index.ts'], { PORT: '4002' });
await new Promise((r) => setTimeout(r, 1000));
start('site-a', ['npx', 'tsx', 'services/site-agent/src/index.ts'], { SITE_ID: 'site-a', PORT: '4101' });
start('site-b', ['npx', 'tsx', 'services/site-agent/src/index.ts'], { SITE_ID: 'site-b', PORT: '4102' });
start('site-c', ['npx', 'tsx', 'services/site-agent/src/index.ts'], { SITE_ID: 'site-c', PORT: '4103' });

console.log('\nAll services starting. Dashboard: cd dashboard && npm run dev → http://localhost:5173');
console.log('Run the acceptance demo: npm run demo\n');

const shutdown = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
