import { createHash } from 'node:crypto';

// ── Self-contained hash-chained audit ledger ─────────────────────────────────
// Deliberately local to this service (not @hc/shared): the logistics domain
// has its own event vocabulary, and the service must stay an independent
// bounded context. Same construction as the clinical ledger — sha256 over
// canonical JSON, chained via prevHash — so integrity verification works
// identically.

export type LogisticsEventType =
  | 'SHIPMENT_SEEDED'
  | 'SHIPMENT_CREATED'
  | 'SHIPMENT_DISPATCHED'
  | 'SHIPMENT_DELIVERED'
  | 'SHIPMENT_STATUS_CHANGED'
  | 'USER_LOGIN';

export interface AuditBlock {
  index: number;
  timestamp: string;
  eventType: LogisticsEventType;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface LedgerVerifyReport {
  valid: boolean;
  blocksChecked: number;
  firstBadIndex: number | null;
  reason: string | null;
}

const GENESIS_PREV_HASH = '0'.repeat(64);

/** Deterministic JSON for hashing (sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export class HashChainLedger {
  private blocks: AuditBlock[] = [];

  snapshot(): AuditBlock[] {
    return this.blocks;
  }

  restore(blocks: AuditBlock[]): void {
    this.blocks = blocks;
  }

  get length(): number {
    return this.blocks.length;
  }

  append(eventType: LogisticsEventType, payload: Record<string, unknown>): AuditBlock {
    const prev = this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
    const block: AuditBlock = {
      index: prev ? prev.index + 1 : 0,
      timestamp: new Date().toISOString(),
      eventType,
      payload,
      prevHash: prev ? prev.hash : GENESIS_PREV_HASH,
      hash: '',
    };
    block.hash = this.blockHash(block);
    this.blocks.push(block);
    return block;
  }

  private blockHash(block: Omit<AuditBlock, 'hash'>): string {
    return sha256(block.prevHash + canonicalJson(block.payload) + block.timestamp + block.eventType);
  }

  /** Walk the whole chain, recompute every hash, report the first bad block. */
  verify(): LedgerVerifyReport {
    let prevHash = GENESIS_PREV_HASH;
    for (const block of this.blocks) {
      if (block.prevHash !== prevHash) {
        return {
          valid: false,
          blocksChecked: block.index,
          firstBadIndex: block.index,
          reason: `block ${block.index} prevHash does not chain to block ${block.index - 1}`,
        };
      }
      const expected = this.blockHash(block);
      if (block.hash !== expected) {
        return {
          valid: false,
          blocksChecked: block.index,
          firstBadIndex: block.index,
          reason: `block ${block.index} hash mismatch: stored ${block.hash} != recomputed ${expected}`,
        };
      }
      prevHash = block.hash;
    }
    return { valid: true, blocksChecked: this.blocks.length, firstBadIndex: null, reason: null };
  }

  page(offset = 0, limit = 50): { blocks: AuditBlock[]; total: number } {
    return {
      blocks: this.blocks.slice(offset, offset + limit),
      total: this.blocks.length,
    };
  }
}
