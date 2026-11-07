/**
 * Live event streaming, the parts that need no HTTP server: SSE framing, resume ids, stream tickets, stream caps and the
 * tailing loop. Everything here takes its clock, timers and data source as arguments so the unit tests can drive it
 * deterministically; `routes/stream.ts` wires it to Fastify and the database.
 *
 * Why server-sent events and not WebSocket: the traffic is one-way (server to browser), SSE works through ordinary proxies,
 * the browser reconnects by itself and needs no new dependency.
 */
import { createHash, randomBytes } from "node:crypto";

// ── settings ──────────────────────────────────────────────────────────────────

export interface StreamConfig {
    /** Poll interval of the tailing loop while something is happening, and its ceiling when idle. */
    pollMs: number;
    maxPollMs: number;
    /** A comment line is written when nothing else was for this long, to keep proxies from closing the connection. */
    heartbeatMs: number;
    /** A stream is closed after this long; the browser reconnects and resumes. */
    maxAgeMs: number;
    /** More than this many streams in the process, or on one job, is refused with 429. */
    maxStreams: number;
    maxPerKey: number;
    /** A client whose unsent bytes pass this limit (or that does not drain within `drainTimeoutMs`) is dropped; it resumes from Last-Event-ID. */
    maxBufferBytes: number;
    drainTimeoutMs: number;
    ticketTtlMs: number;
    maxTickets: number;
    /** Events written per database read. */
    pageSize: number;
    /** A new connection without Last-Event-ID is shown at most this many recent events. */
    initialEvents: number;
}

export function streamConfig(env: NodeJS.ProcessEnv = process.env): StreamConfig {
    const num = (name: string, def: number, min: number, max: number) => {
        const n = Number(env[name]);
        return Number.isFinite(n) && env[name] !== undefined && env[name] !== "" ? Math.min(max, Math.max(min, Math.round(n))) : def;
    };
    return {
        pollMs: num("STREAM_POLL_MS", 250, 10, 5_000),
        maxPollMs: num("STREAM_MAX_POLL_MS", 1_000, 10, 30_000),
        heartbeatMs: num("STREAM_HEARTBEAT_MS", 15_000, 50, 60_000),
        maxAgeMs: num("STREAM_MAX_AGE_MS", 2 * 3_600_000, 200, 24 * 3_600_000),
        maxStreams: num("STREAM_MAX_STREAMS", 100, 1, 10_000),
        maxPerKey: num("STREAM_MAX_PER_JOB", 20, 1, 1_000),
        maxBufferBytes: num("STREAM_MAX_BUFFER_BYTES", 512 * 1024, 1_024, 64 * 1024 * 1024),
        drainTimeoutMs: num("STREAM_DRAIN_TIMEOUT_MS", 10_000, 50, 120_000),
        ticketTtlMs: num("STREAM_TICKET_TTL_MS", 60_000, 50, 600_000),
        maxTickets: 1_000,
        pageSize: 200,
        initialEvents: 500,
    };
}

// ── SSE framing ───────────────────────────────────────────────────────────────

export interface SseFrame {
    event?: string;
    /** The resume position; set on `log` frames only (a snapshot must not move Last-Event-ID). */
    id?: number;
    data?: unknown;
    /** Milliseconds the browser waits before it reconnects by itself. */
    retry?: number;
    /** A comment line (`: text`): ignored by the browser, keeps the connection open. */
    comment?: string;
}

/** One frame, ending in the blank line that dispatches it. Newlines in any field can never start another field. */
export function sseFrame(f: SseFrame): string {
    const clean = (s: string) => s.replace(/[\r\n]+/g, " ");
    let out = "";
    if (f.comment !== undefined) out += `: ${clean(f.comment)}\n`;
    if (f.retry !== undefined) out += `retry: ${Math.max(0, Math.floor(f.retry))}\n`;
    if (f.event) out += `event: ${clean(f.event)}\n`;
    if (f.id !== undefined) out += `id: ${Math.floor(f.id)}\n`;
    if (f.data !== undefined) {
        const text = typeof f.data === "string" ? f.data : JSON.stringify(f.data);
        for (const line of text.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
    }
    return `${out}\n`;
}

/** The position to resume after: the `Last-Event-ID` header wins over `?lastEventId=` (what a hand-made reconnect sends). Anything that is not a plain non-negative integer is ignored. */
export function parseLastEventId(header: unknown, query?: unknown): number | undefined {
    for (const raw of [header, query]) {
        const v = Array.isArray(raw) ? raw[0] : raw;
        if (typeof v !== "string" || !/^\d{1,15}$/.test(v.trim())) continue;
        return Number(v.trim());
    }
    return undefined;
}

// ── the tailing loop's pace ───────────────────────────────────────────────────

/** Short while events flow, growing by half each quiet round up to a ceiling. */
export function nextDelay(prev: number, active: boolean, cfg: Pick<StreamConfig, "pollMs" | "maxPollMs">): number {
    if (active) return cfg.pollMs;
    return Math.min(cfg.maxPollMs, Math.max(cfg.pollMs, Math.round(prev * 1.5)));
}

// ── caps ──────────────────────────────────────────────────────────────────────

export class StreamCaps {
    private total = 0;
    private readonly byKey = new Map<string, number>();

    constructor(
        private readonly maxTotal: number,
        private readonly maxPerKey: number,
    ) {}

    /** A release function, or undefined when a limit is reached. Calling the release twice does nothing the second time. */
    acquire(key: string): (() => void) | undefined {
        if (this.total >= this.maxTotal || (this.byKey.get(key) ?? 0) >= this.maxPerKey) return undefined;
        this.total++;
        this.byKey.set(key, (this.byKey.get(key) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.total--;
            const left = (this.byKey.get(key) ?? 1) - 1;
            if (left <= 0) this.byKey.delete(key);
            else this.byKey.set(key, left);
        };
    }

    get open(): number {
        return this.total;
    }
    openFor(key: string): number {
        return this.byKey.get(key) ?? 0;
    }
}

// ── tickets ───────────────────────────────────────────────────────────────────

/**
 * A browser's EventSource cannot send headers, so the API key must not travel in the address. Instead the page asks (with the key, in
 * a header) for a ticket that opens exactly one stream path, once, within a minute. Only the SHA-256 of a ticket is kept in memory.
 * A ticket also remembers whether its asker may see AI cost (auth/cost-hiding.ts): the stream itself has no other way to know.
 */
export class TicketStore {
    private readonly tickets = new Map<string, { path: string; expires: number; hideCost: boolean }>();

    constructor(
        private readonly ttlMs: number,
        private readonly max: number,
        private readonly now: () => number = Date.now,
    ) {}

    private static key(ticket: string): string {
        return createHash("sha256").update(ticket).digest("hex");
    }

    private purge(): void {
        const t = this.now();
        for (const [k, v] of this.tickets) if (v.expires <= t) this.tickets.delete(k);
    }

    /** `undefined` when too many tickets are outstanding. */
    issue(path: string, opts: { hideCost?: boolean } = {}): string | undefined {
        this.purge();
        if (this.tickets.size >= this.max) return undefined;
        const ticket = `st_${randomBytes(24).toString("base64url")}`;
        this.tickets.set(TicketStore.key(ticket), { path, expires: this.now() + this.ttlMs, hideCost: opts.hideCost === true });
        return ticket;
    }

    /** Burns the ticket whatever the answer: a ticket that was tried for the wrong path or too late cannot be tried again. */
    consume(ticket: string, path: string): "ok" | "invalid" {
        return this.redeem(ticket, path) ? "ok" : "invalid";
    }

    /** `consume`, also saying what the ticket remembered; undefined when it is not valid for this path. */
    redeem(ticket: string, path: string): { hideCost: boolean } | undefined {
        const k = TicketStore.key(ticket);
        const hit = this.tickets.get(k);
        if (!hit) return undefined;
        this.tickets.delete(k);
        return hit.expires > this.now() && hit.path === path ? { hideCost: hit.hideCost } : undefined;
    }

    get size(): number {
        this.purge();
        return this.tickets.size;
    }
}

/** Replace a stream ticket in an address so logs never hold one. */
export function redactStreamUrl(url: string): string {
    return url.replace(/([?&](?:ticket|key)=)[^&#\s]*/gi, "$1[hidden]");
}

// ── the tailing loop ──────────────────────────────────────────────────────────

export interface StreamEvent {
    id: number;
    at: string;
    level: string;
    message: string;
    stage: string;
    kind: string;
    jobId: string;
    /** The structured part, only for a runner's live events (kinds `runner_*`: test, step, screenshot, phase); other events never carry it. */
    data?: unknown;
}

export interface SnapshotRead {
    /** Snapshots that exist now, keyed (a job id); a key is written again only when its text changed. */
    frames: Array<{ key: string; json: unknown }>;
    /** True when the stream has nothing more to say after the events read next: the job finished, or no job of the project is active. */
    done: boolean;
    /** Why it is done, for the `end` frame. */
    status?: string;
}

/** Where a stream reads from (the database in production). */
export interface TailSource {
    /** Events with id greater than `afterId`, ascending, at most `limit`. */
    readEvents(afterId: number, limit: number): StreamEvent[];
    /** Called BEFORE `readEvents` in every round: a terminal state seen here means every event of the job is already readable. */
    readSnapshots(): SnapshotRead;
    /**
     * How many ids below the newest one sent each round reads again (default 0), for a source whose ids can commit out of order
     * (several writers on PostgreSQL, where an id is handed out before its commit). An id in that window not yet sent goes out then.
     */
    overlap?: number;
}

export interface TailDeps extends TailSource {
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    /** Resolves false when the client is gone or too slow (the loop stops). */
    write(chunk: string): Promise<boolean>;
    /** Called once when the loop ends for any reason. */
    onStop(reason: StopReason): void;
}

export type StopReason = "ended" | "max-age" | "client" | "stopped" | "error";

/**
 * One stream's loop. Each round: read the snapshot, then the events after the last one sent (paged), write them in id order,
 * write the snapshot if it changed, then end if the snapshot said done, or schedule the next round. Rounds never overlap, there is
 * at most one timer alive, and `stop()` leaves none.
 *
 * No event is lost or repeated: the position advances only after a frame was written, ids come from one AUTOINCREMENT column
 * (SQLite assigns them under the single writer lock, so a larger id is never committed before a smaller one), and the snapshot is
 * read before the events, so a finished job's last events are always in the round that ends the stream. Where ids can commit out
 * of order (`overlap`), each round re-reads that many ids below the position and sends only those not sent yet; a log frame's
 * resume id is the position, never lower, so a reconnect does not replay what the browser already has.
 */
export class TailLoop {
    private last: number;
    private timer: unknown;
    private stopped = false;
    private running = false;
    private rerun = false;
    private delay: number;
    private lastWrite: number;
    private first = true;
    private readonly seen = new Map<string, string>();
    /** Ids sent inside the overlap window (only with `overlap`). */
    private readonly sent = new Set<number>();
    private readonly floor: number;
    private readonly startedAt: number;

    constructor(
        private readonly deps: TailDeps,
        private readonly cfg: StreamConfig,
        startAfter: number,
        private readonly opts: { earlierEvents?: number } = {},
    ) {
        this.last = startAfter;
        // A resume starts strictly after its position: what the browser had before reconnecting is never re-read.
        this.floor = startAfter;
        this.delay = cfg.pollMs;
        this.startedAt = deps.now();
        this.lastWrite = this.startedAt;
    }

    get position(): number {
        return this.last;
    }
    get hasTimer(): boolean {
        return this.timer !== undefined;
    }

    start(): void {
        void this.round();
    }

    /** Something may have changed: run a round now (or right after the one in progress). */
    wake(): void {
        if (this.stopped) return;
        if (this.running) {
            this.rerun = true;
            return;
        }
        this.clear();
        void this.round();
    }

    stop(reason: StopReason = "stopped"): void {
        if (this.stopped) return;
        this.stopped = true;
        this.clear();
        this.deps.onStop(reason);
    }

    private clear(): void {
        if (this.timer !== undefined) this.deps.clearTimer(this.timer);
        this.timer = undefined;
    }

    private async send(frame: string): Promise<boolean> {
        const ok = await this.deps.write(frame);
        if (ok) this.lastWrite = this.deps.now();
        else this.stop("client");
        return ok && !this.stopped;
    }

    private async writeSnapshots(snap: SnapshotRead): Promise<boolean> {
        let changed = false;
        for (const f of snap.frames) {
            const text = JSON.stringify(f.json);
            if (this.seen.get(f.key) === text) continue;
            this.seen.set(f.key, text);
            // Only the first frame of a connection says that older events exist but are not shown.
            const body = this.first && this.opts.earlierEvents ? { ...(f.json as object), earlierEvents: this.opts.earlierEvents } : f.json;
            if (!(await this.send(sseFrame({ event: "job", data: body })))) return false;
            changed = true;
        }
        this.activity = this.activity || changed;
        return true;
    }

    private activity = false;

    private async round(): Promise<void> {
        if (this.stopped || this.running) return;
        this.running = true;
        this.rerun = false;
        this.activity = false;
        try {
            const snap = this.deps.readSnapshots();
            if (this.first && !(await this.writeSnapshots(snap))) return;
            const overlap = Math.max(0, this.deps.overlap ?? 0);
            const low = Math.max(this.floor, this.last - overlap);
            let cursor = low;
            for (;;) {
                const page = this.deps.readEvents(cursor, this.cfg.pageSize);
                for (const e of page) {
                    if (e.id > cursor) cursor = e.id;
                    // Never twice, never backwards; within the overlap window, a late id not sent yet is the exception.
                    if (e.id <= this.last && (overlap === 0 || e.id <= low || this.sent.has(e.id))) continue;
                    const position = Math.max(this.last, e.id);
                    if (!(await this.send(sseFrame({ event: "log", id: position, data: { id: e.id, at: e.at, level: e.level, message: e.message, stage: e.stage, kind: e.kind, jobId: e.jobId, ...(e.data !== undefined ? { data: e.data } : {}) } })))) return;
                    this.last = position;
                    if (overlap > 0) this.sent.add(e.id);
                    this.activity = true;
                }
                if (page.length < this.cfg.pageSize) break;
            }
            // Ids at or below the next round's window are never re-read, so they need not be remembered.
            for (const id of this.sent) if (id <= this.last - overlap) this.sent.delete(id);
            if (!this.first && !(await this.writeSnapshots(snap))) return;
            this.first = false;
            if (snap.done) {
                await this.send(sseFrame({ event: "end", data: { status: snap.status ?? "ended" } }));
                this.stop("ended");
                return;
            }
            const t = this.deps.now();
            if (t - this.startedAt >= this.cfg.maxAgeMs) {
                // No end frame: the browser sees an ordinary disconnect, reconnects and resumes from the last id.
                this.stop("max-age");
                return;
            }
            if (t - this.lastWrite >= this.cfg.heartbeatMs && !(await this.send(sseFrame({ comment: "keep-alive" })))) return;
        } catch {
            this.stop("error");
            return;
        } finally {
            this.running = false;
        }
        if (this.stopped) return;
        this.delay = nextDelay(this.delay, this.activity, this.cfg);
        this.clear();
        if (this.rerun) void this.round();
        else this.timer = this.deps.setTimer(() => void this.round(), this.delay);
    }
}
