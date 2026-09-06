/**
 * Minimal RESP2 Redis client on node:net — no external dependency.
 *
 * Scope: exactly what the shared rate limiter needs — PING, EVALSHA/EVAL,
 * EXPIRE, and simple status replies — over a small connection pool with
 * automatic reconnect. This is a deliberate subset, not a general client:
 * fire-and-forget friendly, one pending command per socket.
 *
 * Wire protocol notes (RESP2):
 *   command  → *N\r\n$len\r\narg\r\n…
 *   status   → +OK\r\n          (resolves as string)
 *   integer  → :42\r\n          (resolves as number)
 *   bulk     → $6\r\nPONG!\r\n  (resolves as string | null)
 *   error    → -ERR msg\r\n     (rejects)
 *   inline PONG from PING is handled as a status reply.
 */
export interface RedisClientOptions {
    host?: string;
    port?: number;
    /** max socket lifecycle before reconnect (ms); Redis may drop idle conns */
    idleTimeoutMs?: number;
}
type Reply = string | number | null;
export declare class MiniRedis {
    private opts;
    private sockets;
    private inflight;
    private closed;
    constructor(opts?: RedisClientOptions);
    get host(): string;
    get port(): number;
    /** Serialize args to RESP2 and run through a pooled connection. */
    command(args: Array<string | number>): Promise<Reply>;
    ping(): Promise<string | number | null>;
    /** EVAL a script; hashes the source for EVALSHA semantics are skipped —
     *  EVAL is fine for a limiter (script source is tiny and local). */
    eval(script: string, keys: string[], argv: Array<string | number>): Promise<Reply>;
    private takeSocket;
    private connect;
    private onData;
    private recycle;
    private failSocket;
    /** Hard close everything (service shutdown). */
    quit(): void;
    static encodeCommand(args: Array<string | number>): string;
    /** Parse one reply off the buffer; null when incomplete. */
    static tryParseReply(buf: string): {
        value: Reply;
        rest: string;
        error: string | null;
    } | null;
}
export {};
//# sourceMappingURL=redis.d.ts.map