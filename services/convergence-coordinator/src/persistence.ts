import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CoordinatorState, type CoordinatorSnapshot } from './state.js';

function statePath(): string {
  return process.env.STATE_PATH ?? join(process.cwd(), '.data', 'state.json');
}

function ensureParentDir(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

export function loadCoordinatorState(state: CoordinatorState): void {
  const path = statePath();
  if (!existsSync(path)) return;
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as CoordinatorSnapshot;
    state.restore(snapshot);
  } catch (err) {
    console.error('[coordinator] could not load state snapshot:', err instanceof Error ? err.message : err);
  }
}

export function persistCoordinatorState(state: CoordinatorState): void {
  try {
    const path = statePath();
    ensureParentDir(path);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state.snapshot())}\n`, 'utf8');
    renameSync(temporary, path);
  } catch (err) {
    console.error('[coordinator] state snapshot persistence failed:', err instanceof Error ? err.message : err);
  }
}
