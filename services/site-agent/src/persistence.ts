import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EpochGatedEvaluator, type SiteCacheSnapshot } from '@hc/shared';
import type { SiteCache } from '@hc/shared';

export interface SiteAgentSnapshot {
  version: 1;
  cache: SiteCacheSnapshot;
  evaluator: { knownEpoch: number };
}

function statePath(): string {
  return process.env.STATE_PATH ?? join(process.cwd(), '.data', `${process.env.SITE_ID ?? 'site-a'}.json`);
}

function ensureParentDir(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

export function loadSiteAgentState(cache: SiteCache, evaluator: EpochGatedEvaluator): void {
  const path = statePath();
  if (!existsSync(path)) return;
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as SiteAgentSnapshot;
    if (snapshot.version !== 1) throw new Error(`unsupported snapshot version: ${snapshot.version}`);
    cache.restore(snapshot.cache);
    evaluator.restore(snapshot.evaluator);
  } catch (err) {
    console.error('[site-agent] could not load state snapshot:', err instanceof Error ? err.message : err);
  }
}

export function persistSiteAgentState(cache: SiteCache, evaluator: EpochGatedEvaluator): void {
  try {
    const path = statePath();
    ensureParentDir(path);
    const snapshot: SiteAgentSnapshot = {
      version: 1,
      cache: cache.snapshot(),
      evaluator: evaluator.snapshot(),
    };
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8');
    renameSync(temporary, path);
  } catch (err) {
    console.error('[site-agent] state snapshot persistence failed:', err instanceof Error ? err.message : err);
  }
}
