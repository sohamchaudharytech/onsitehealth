#!/usr/bin/env node
/** Start the logistics service + dashboard (independent of the clinical network). */
import { spawn } from 'node:child_process';

const procs = [];
const start = (name, cmd, opts = {}) => {
  const p = spawn(cmd[0], cmd.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    cwd: opts.cwd ?? process.cwd(),
  });
  p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  p.on('exit', (code) => console.log(`[${name}] exited ${code}`));
  procs.push(p);
};

console.log('Starting logistics stack...');
start('logistics-service', ['npx', 'tsx', 'services/logistics-service/src/index.ts']);
await new Promise((r) => setTimeout(r, 1000));
start('logistics-dashboard', ['npm', 'run', 'dev'], { cwd: 'dashboard-logistics' });

console.log('\nLogistics service  → http://localhost:4201');
console.log('Logistics dashboard → http://localhost:5174');
console.log('Demo login: admin/admin123 (or dispatcher/dispatcher123, viewer/viewer123)\n');

const shutdown = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
