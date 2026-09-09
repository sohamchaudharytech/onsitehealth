import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HashChainLedger } from './ledger.js';
import type { ShipmentStore } from './store.js';
import type { UserStore } from './users.js';

export interface LogisticsSnapshot {
  version: 1;
  savedAt: string;
  shipments: ReturnType<ShipmentStore['snapshot']>;
  users: ReturnType<UserStore['snapshot']>;
  ledger: ReturnType<HashChainLedger['snapshot']>;
  demoSeq: number;
}

function statePath(): string {
  return process.env.STATE_PATH ?? join(process.cwd(), '.data', 'logistics.json');
}

function ensureParentDir(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

export function loadLogisticsState(
  shipments: ShipmentStore,
  users: UserStore,
  ledger: HashChainLedger,
): LogisticsSnapshot | null {
  const path = statePath();
  if (!existsSync(path)) return null;
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as LogisticsSnapshot;
    if (snapshot.version !== 1) throw new Error(`unsupported snapshot version: ${snapshot.version}`);
    shipments.restore(snapshot.shipments);
    users.restore(snapshot.users);
    ledger.restore(snapshot.ledger);
    return snapshot;
  } catch (err) {
    console.error('[logistics-service] could not load state snapshot:', err instanceof Error ? err.message : err);
    return null;
  }
}

export function persistLogisticsState(snapshot: Omit<LogisticsSnapshot, 'version' | 'savedAt'>): void {
  try {
    const path = statePath();
    ensureParentDir(path);
    const fullSnapshot: LogisticsSnapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      ...snapshot,
    };
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(fullSnapshot)}\n`, 'utf8');
    renameSync(temporary, path);
  } catch (err) {
    console.error('[logistics-service] state snapshot persistence failed:', err instanceof Error ? err.message : err);
  }
}
