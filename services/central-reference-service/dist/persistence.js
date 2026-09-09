import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
function ensureDir() {
    if (!existsSync(DATA_DIR))
        mkdirSync(DATA_DIR, { recursive: true });
    return DATA_DIR;
}
function appendLine(file, obj) {
    appendFileSync(join(ensureDir(), file), `${JSON.stringify(obj)}\n`, 'utf8');
}
function readLines(file) {
    const p = join(DATA_DIR, file);
    if (!existsSync(p))
        return [];
    const out = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            out.push(JSON.parse(t));
        }
        catch { /* corrupt line: skip, chain verify reports */ }
    }
    return out;
}
// ── Ledger persistence ───────────────────────────────────────────────────────
export function persistLedgerBlock(block) {
    appendLine('ledger.jsonl', block);
}
/** Load all ledger blocks (boot). Caller loads them into the chain, then verifies. */
export function loadLedgerBlocks() {
    return readLines('ledger.jsonl').map((b) => b);
}
export function persistRefreshEvent(ev) {
    appendLine('refresh.jsonl', ev);
}
export function loadRefreshEvents() {
    return readLines('refresh.jsonl').map((e) => e);
}
function domainSnapshotPath() {
    return join(DATA_DIR, 'state.json');
}
export function loadDomainSnapshot() {
    const path = domainSnapshotPath();
    if (!existsSync(path))
        return null;
    try {
        const snapshot = JSON.parse(readFileSync(path, 'utf8'));
        if (snapshot.version !== 1) {
            console.error('[central] unsupported domain snapshot version:', snapshot.version);
            return null;
        }
        return snapshot;
    }
    catch (err) {
        console.error('[central] could not load domain snapshot:', err instanceof Error ? err.message : err);
        return null;
    }
}
export function persistDomainSnapshot(snapshot) {
    ensureDir();
    const path = domainSnapshotPath();
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
}
/** Wipe persisted state (used by tests / fresh-start script). */
export function resetPersistence() {
    ensureDir();
    writeFileSync(join(DATA_DIR, 'ledger.jsonl'), '', 'utf8');
    writeFileSync(join(DATA_DIR, 'refresh.jsonl'), '', 'utf8');
}
//# sourceMappingURL=persistence.js.map