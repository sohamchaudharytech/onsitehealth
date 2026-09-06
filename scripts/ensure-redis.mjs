#!/usr/bin/env node
/**
 * Ensure a Redis server is available for the rate limiter.
 *
 * Strategy (no brew / no docker needed):
 *   1. If something is already answering PING on the port — done.
 *   2. If .redis/bin/redis-server exists (compiled before) — start it as a daemon.
 *   3. Otherwise download + compile Redis from source into .redis/ once,
 *      then start it. Requires only curl/tar/make/cc.
 *
 * Persistence: AOF everysec into .redis/data/ so rate-limit counters and
 * repeat-offender windows survive restarts. All state lives in .redis/
 * (gitignored).
 *
 * If Redis ultimately can't be started, the services still run — the rate
 * limiter falls back to its in-memory implementation (single-process scope).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const REDIS_DIR = join(ROOT, '.redis');
const BIN = join(REDIS_DIR, 'bin');
const DATA = join(REDIS_DIR, 'data');
const PORT = Number(process.env.REDIS_PORT ?? 6379);
const REDIS_VERSION = '7.2.5';
const TARBALL = join(REDIS_DIR, `redis-${REDIS_VERSION}.tar.gz`);
const SRC = join(REDIS_DIR, `redis-${REDIS_VERSION}`);

/** Raw PING over the RESP protocol — true iff a redis answers PONG. */
function ping() {
  return new Promise((resolve) => {
    const s = createConnection(PORT, '127.0.0.1');
    let settled = false;
    const done = (v) => {
      if (!settled) { settled = true; s.destroy(); resolve(v); }
    };
    s.setTimeout(800, () => done(false));
    s.on('error', () => done(false));
    s.on('connect', () => s.write('*1\r\n$4\r\nPING\r\n'));
    // Redis answers inline; the connection stays open, so resolve on data.
    s.on('data', (d) => done(d.toString().includes('PONG')));
  });
}

function buildFromSource() {
  if (!existsSync(join(SRC, 'src', 'redis-server'))) {
    console.log(`[redis] downloading redis-${REDIS_VERSION} source…`);
    mkdirSync(REDIS_DIR, { recursive: true });
    if (!existsSync(TARBALL)) {
      execFileSync('curl', ['-fsSL', `https://download.redis.io/releases/redis-${REDIS_VERSION}.tar.gz`, '-o', TARBALL], { stdio: 'inherit' });
    }
    if (!existsSync(SRC)) {
      execFileSync('tar', ['-xzf', TARBALL, '-C', REDIS_DIR], { stdio: 'inherit' });
    }
    console.log('[redis] compiling from source (one-time, ~1-2 min)…');
    execFileSync('make', ['-C', SRC, '-j8', 'BUILD_TLS=no'], { stdio: 'inherit' });
  }
  mkdirSync(BIN, { recursive: true });
  execFileSync('cp', [join(SRC, 'src', 'redis-server'), join(SRC, 'src', 'redis-cli'), BIN + '/'], { stdio: 'inherit' });
}

async function main() {
  // 1. already running?
  if (await ping()) {
    console.log(`[redis] already running on :${PORT} — nothing to do`);
    return;
  }
  // 2. compile if the binary is missing
  if (!existsSync(join(BIN, 'redis-server'))) {
    buildFromSource();
  }
  if (!existsSync(join(BIN, 'redis-server'))) {
    console.warn('[redis] ⚠️ could not build redis — rate limiter will fall back to in-memory');
    return; // not fatal: services run with the in-memory limiter
  }
  // 3. start as a daemon with AOF persistence
  mkdirSync(DATA, { recursive: true });
  const conf = [
    `port ${PORT}`,
    'bind 127.0.0.1',
    'daemonize yes',
    `dir ${DATA}`,
    'appendonly yes',
    'appendfsync everysec',
    `pidfile ${join(DATA, 'redis.pid')}`,
    `logfile ${join(DATA, 'redis.log')}`,
    'save ""', // AOF only — no RDB snapshots needed
  ].join('\n');
  const confPath = join(REDIS_DIR, 'redis.conf');
  writeFileSync(confPath, conf);
  execFileSync(join(BIN, 'redis-server'), [confPath], { stdio: 'inherit' });
  for (let i = 0; i < 50; i++) {
    if (await ping()) {
      console.log(`[redis] started on :${PORT} (AOF persistence in .redis/data/)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.warn('[redis] ⚠️ started but not answering PING — rate limiter will fall back to in-memory');
}

main().catch((err) => {
  console.warn('[redis] ⚠️ ensure-redis failed:', err.message, '— rate limiter falls back to in-memory');
  // never fatal: the stack runs with the in-memory limiter
});
