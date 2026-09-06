import { createConnection } from 'node:net';
export class MiniRedis {
    opts;
    sockets = [];
    inflight = new Map();
    closed = false;
    constructor(opts = {}) {
        this.opts = opts;
    }
    get host() { return this.opts.host ?? '127.0.0.1'; }
    get port() { return this.opts.port ?? 6379; }
    /** Serialize args to RESP2 and run through a pooled connection. */
    async command(args) {
        const sock = this.takeSocket();
        const payload = MiniRedis.encodeCommand(args);
        return new Promise((resolve, reject) => {
            this.inflight.set(sock, { resolve, reject, buffer: '' });
            sock.write(payload);
        });
    }
    ping() {
        return this.command(['PING']);
    }
    /** EVAL a script; hashes the source for EVALSHA semantics are skipped —
     *  EVAL is fine for a limiter (script source is tiny and local). */
    eval(script, keys, argv) {
        return this.command(['EVAL', script, keys.length, ...keys, ...argv]);
    }
    // ── pooling ───────────────────────────────────────────────────────────────
    takeSocket() {
        const idle = this.sockets.pop();
        if (idle && !idle.destroyed && idle.writable)
            return idle;
        return this.connect();
    }
    connect() {
        const sock = createConnection(this.port, this.host);
        sock.setNoDelay(true);
        sock.on('data', (chunk) => this.onData(sock, chunk.toString('utf8')));
        sock.on('error', () => this.failSocket(sock, new Error('redis connection error')));
        sock.on('close', () => this.failSocket(sock, new Error('redis connection closed')));
        return sock;
    }
    onData(sock, text) {
        const pending = this.inflight.get(sock);
        if (!pending)
            return;
        pending.buffer += text;
        const parsed = MiniRedis.tryParseReply(pending.buffer);
        if (parsed === null)
            return; // incomplete — wait for more data
        this.inflight.delete(sock);
        this.recycle(sock);
        const { value, rest, error } = parsed;
        if (rest !== '') {
            // More bytes than one reply (shouldn't happen with 1:1 pipelining) —
            // drop the remainder; the limiter never pipelines.
            void rest;
        }
        if (error)
            pending.reject(new Error(error));
        else
            pending.resolve(value);
    }
    recycle(sock) {
        if (this.closed || this.sockets.length >= 4) {
            sock.destroy();
            return;
        }
        this.sockets.push(sock);
    }
    failSocket(sock, err) {
        const pending = this.inflight.get(sock);
        this.inflight.delete(sock);
        if (pending)
            pending.reject(err);
        if (this.sockets.includes(sock))
            this.sockets.splice(this.sockets.indexOf(sock), 1);
    }
    /** Hard close everything (service shutdown). */
    quit() {
        this.closed = true;
        for (const s of this.sockets)
            s.destroy();
        this.sockets = [];
        for (const [s, p] of this.inflight) {
            p.reject(new Error('client closed'));
            this.inflight.delete(s);
        }
    }
    // ── RESP2 codec ────────────────────────────────────────────────────────────
    static encodeCommand(args) {
        const parts = [`*${args.length}\r\n`];
        for (const a of args) {
            const s = String(a);
            parts.push(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
        }
        return parts.join('');
    }
    /** Parse one reply off the buffer; null when incomplete. */
    static tryParseReply(buf) {
        if (buf === '')
            return null;
        const type = buf[0];
        const lineEnd = buf.indexOf('\r\n');
        if (lineEnd === -1)
            return null;
        const line = buf.slice(1, lineEnd);
        const rest = buf.slice(lineEnd + 2);
        switch (type) {
            case '+': // status
                return { value: line, rest, error: null };
            case ':': // integer
                return { value: Number(line), rest, error: null };
            case '-': // error
                return { value: null, rest, error: line };
            case '$': { // bulk string; -1 = null
                const len = Number(line);
                if (len === -1)
                    return { value: null, rest, error: null };
                if (buf.length < lineEnd + 2 + len + 2)
                    return null; // incomplete payload
                return { value: buf.slice(lineEnd + 2, lineEnd + 2 + len), rest: buf.slice(lineEnd + 2 + len + 2), error: null };
            }
            case '*': { // array of bulk replies
                const n = Number(line);
                if (n === -1 || n === 0)
                    return { value: null, rest, error: null };
                // Recursively parse n elements; bail (null) until all are buffered.
                let cursor = rest;
                const items = [];
                for (let i = 0; i < n; i++) {
                    const el = MiniRedis.tryParseReply(cursor);
                    if (el === null)
                        return null; // incomplete array
                    items.push(String(el.value));
                    cursor = el.rest;
                }
                return { value: items.join(','), rest: cursor, error: null };
            }
            default:
                return null;
        }
    }
}
//# sourceMappingURL=redis.js.map