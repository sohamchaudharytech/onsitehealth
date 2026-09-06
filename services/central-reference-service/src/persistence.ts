import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditBlock } from '@hc/shared';

/**
 * File-backed durability for the central service (Phase 7-lite).
 *
 * Two artifacts, both append-only JSONL under DATA_DIR (default .data):
 *
 *   ledger.jsonl    — every hash-chain block, one JSON object per line.
 *                     Append-only by design: the chain's whole point is
 *                     tamper-evidence, so blocks are never rewritten. On
 *                     boot the chain is rehydrated and RE-VERIFIED; a
 *                     mismatch is logged loudly (and surfaces via
 *                     /api/audit/verify).
 *
 *   refresh.jsonl   — refresh-token grants/revocations. Current live state
 *                     is reduced from the log on boot. Long-lived (180d),
 *                     rotation keeps the window small if one leaks.
 *
 * Writes are synchronous-append — tiny lines, safe at demo scale; a real
 * deployment swaps this for MongoDB with the same log-shaped access pattern.
 */

export const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), '.data');

function ensureDir(): string {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

function appendLine(file: string, obj: unknown): void {
  appendFileSync(join(ensureDir(), file), `${JSON.stringify(obj)}\n`, 'utf8');
}

function readLines(file: string): Array<Record<string, unknown>> {
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as Record<string, unknown>); } catch { /* corrupt line: skip, chain verify reports */ }
  }
  return out;
}

// ── Ledger persistence ───────────────────────────────────────────────────────

export function persistLedgerBlock(block: AuditBlock): void {
  appendLine('ledger.jsonl', block);
}

/** Load all ledger blocks (boot). Caller loads them into the chain, then verifies. */
export function loadLedgerBlocks(): AuditBlock[] {
  return readLines('ledger.jsonl').map((b) => b as unknown as AuditBlock);
}

// ── Refresh-token persistence (event-sourced) ────────────────────────────────

export type RefreshEvent =
  | { kind: 'grant'; tokenHash: string; userId: string; issuedAt: number }
  | { kind: 'revoke'; tokenHash: string }
  | { kind: 'revoke-all'; userId: string };

export function persistRefreshEvent(ev: RefreshEvent): void {
  appendLine('refresh.jsonl', ev);
}

export function loadRefreshEvents(): RefreshEvent[] {
  return readLines('refresh.jsonl').map((e) => e as unknown as RefreshEvent);
}

/** Wipe persisted state (used by tests / fresh-start script). */
export function resetPersistence(): void {
  ensureDir();
  writeFileSync(join(DATA_DIR, 'ledger.jsonl'), '', 'utf8');
  writeFileSync(join(DATA_DIR, 'refresh.jsonl'), '', 'utf8');
}
