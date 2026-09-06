import { createHash } from 'node:crypto';
const GENESIS_PREV_HASH = '0'.repeat(64);
/** Deterministic JSON for hashing (sorted keys, no whitespace). */
export function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
export function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
export class HashChainLedger {
    blocks = [];
    get length() {
        return this.blocks.length;
    }
    append(eventType, payload) {
        const prev = this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
        const block = {
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
    blockHash(block) {
        return sha256(block.prevHash + canonicalJson(block.payload) + block.timestamp + block.eventType);
    }
    /** Walk the whole chain, recompute every hash, report the first bad block. */
    verify() {
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
    page(offset = 0, limit = 50) {
        return {
            blocks: this.blocks.slice(offset, offset + limit),
            total: this.blocks.length,
        };
    }
}
//# sourceMappingURL=ledger.js.map