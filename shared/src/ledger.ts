import type { AuditBlock, LedgerEventType, LedgerVerifyReport } from './types.js';
import { canonicalJson, sha256 } from './hash.js';

export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * Append-only, hash-chained ledger. Single trusted writer (the central
 * service) — this is the data structure inside a blockchain, without
 * decentralized consensus, which is the correct tool for tamper-evidence
 * when you control the writer.
 */
export class HashChainLedger {
  private blocks: AuditBlock[] = [];

  get length(): number {
    return this.blocks.length;
  }

  get head(): AuditBlock | null {
    return this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
  }

  append(eventType: LedgerEventType, payload: Record<string, unknown>): AuditBlock {
    const prev = this.head;
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
    return sha256(
      block.prevHash + canonicalJson(block.payload) + block.timestamp + block.eventType,
    );
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

  /** Replace stored blocks (used when rehydrating from persistence). */
  load(blocks: AuditBlock[]): void {
    this.blocks = blocks.slice().sort((a, b) => a.index - b.index);
  }

  page(offset = 0, limit = 50): { blocks: AuditBlock[]; total: number } {
    return {
      blocks: this.blocks.slice(offset, offset + limit),
      total: this.blocks.length,
    };
  }

  all(): AuditBlock[] {
    return this.blocks;
  }
}
