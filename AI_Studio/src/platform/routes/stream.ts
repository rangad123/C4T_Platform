/**
 * Live event streaming (server-sent events). The long version is docs/features/live-stream.md.
 *
 *   POST /api/stream-tickets                     {path}  -> {ticket, expiresInSeconds}   (API key, in a header)
 *   GET  /api/test-generation/:jobId/stream      one job: `job` snapshots, `log` events, then `end`
 *   GET  /api/projects/:id/stream                every job of a project, until none is active
 *
 * The database is the source of truth: each stream tails the job-events table, so a worker in a separate process that only writes
 * to the database still streams. The in-process bell (event-bus.ts) just wakes the loop at once when this process wrote the event.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eventBus, ANY_JOB } from "../event-bus.js";
import { HttpError } from "../http-error.js";
import type { Platform } from "../bootstrap.js";
import { actorOf } from "../auth/access.js";
import { hidesCost, withoutCost } from "../auth/cost-hiding.js";
import { parseLastEventId, redactStreamUrl, sseFrame, streamConfig, StreamCaps, TailLoop, TicketStore, type SnapshotRead, type StopReason, type StreamConfig, type TailSource } from "../stream-core.js";
import { jobEventsAfter, PROJECT_STREAM_OVERLAP, projectEventsAfter, projectHead, recentJobStates, recentWindow, TERMINAL_STATUSES } from "../stream-store.js";
import type { RouteCtx } from "./types.js";

/** The two stream routes, as a ticket may name them (an exact, anchored match on the decoded path). */
const STREAM_PATH = /^\/api\/(?:test-generation|projects)\/[A-Za-z0-9_-]{1,64}\/stream$/;
export const isStreamPath = (decodedPath: string): boolean => STREAM_PATH.test(decodedPath);

/** What the API-key hook asks: a GET on a stream route that carries a ticket is checked by the route itself (ticket instead of key). */
export function isStreamTicketRequest(method: string, decodedPath: string, url: string): boolean {
    if (method !== "GET" || !isStreamPath(decodedPath)) return false;
    try {
        return Boolean(new URL(url, "http://x").searchParams.get("ticket"));
    } catch {
        return false;
    }
}

/** Counters tests read to prove nothing is left behind after streams close. */
export interface StreamStats {
    open: number;
    timers: number;
    busListeners: number;
    tickets: number;
}

export interface StreamHub {
    cfg: StreamConfig;
    stats(): StreamStats;
    /** Close every open stream now (shutdown). */
    closeAll(): void;
}

const hubs = new WeakMap<Platform, StreamHub>();
/** The stream hub of a platform instance (undefined until its routes were registered). */
export const getStreamHub = (p: Platform): StreamHub | undefined => hubs.get(p);

const TicketBody = z.object({ path: z.string().max(200) });

export function registerStreamRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const cfg = streamConfig();
    const tickets = new TicketStore(cfg.ticketTtlMs, cfg.maxTickets);
    const caps = new StreamCaps(cfg.maxStreams, cfg.maxPerKey);
    const loops = new Set<TailLoop>();
    const apiKey = p.config.API_KEY;

    hubs.set(p, {
        cfg,
        stats: () => ({ open: caps.open, timers: [...loops].filter((l) => l.hasTimer).length, busListeners: eventBus.listenerCount(), tickets: tickets.size }),
        closeAll: () => {
            for (const l of [...loops]) l.stop("stopped");
        },
    });
    app.addHook("onClose", async () => {
        for (const l of [...loops]) l.stop("stopped");
    });

    const decodedPath = (req: FastifyRequest): string => {
        try {
            return decodeURIComponent(req.url.split("?")[0]!);
        } catch {
            throw new HttpError(400, "Malformed URL");
        }
    };

    /** The page-facing mask of anything that must never be sent: the API key (events are already scrubbed of run credentials). */
    const mask = (text: string): string => (apiKey && apiKey.length >= 4 && text.includes(apiKey) ? text.split(apiKey).join("[hidden]") : text);

    const subjectExists = (path: string): void => {
        const m = /^\/api\/(test-generation|projects)\/([^/]+)\/stream$/.exec(path)!;
        if (m[1] === "test-generation") {
            if (!repo.getJob(m[2]!)) throw new HttpError(404, "Job not found");
        } else if (!repo.getProject(m[2]!)) throw new HttpError(404, "Project not found");
    };

    // ── tickets ─────────────────────────────────────────────────────────────────
    app.post("/api/stream-tickets", async (req, reply) => {
        const { path } = TicketBody.parse(req.body);
        if (!isStreamPath(path)) throw new HttpError(400, "A live-update link can only be made for a run or a project's runs.");
        subjectExists(path);
        const ticket = tickets.issue(path, { hideCost: hidesCost(actorOf(req)) });
        if (!ticket) throw new HttpError(429, "Too many live-update links are waiting to be used. Try again in a minute.");
        return reply.code(201).send({ ticket, expiresInSeconds: Math.round(cfg.ticketTtlMs / 1000) });
    });

    // ── the streams ─────────────────────────────────────────────────────────────
    /**
     * Checks that happen before any byte is streamed: the credential (key was checked by the hook unless a ticket is used), the caps.
     * A ticket is always checked, also without an API key: the access hook lets every request with one through (a sign-in with
     * people or Crowd4Test has no key, and an unchecked ticket would open any stream to anyone). `hideCost`: what the asker may see.
     */
    const admit = (req: FastifyRequest, path: string, capKey: string): { release: () => void; hideCost: boolean } => {
        const ticket = String((req.query as { ticket?: string }).ticket ?? "");
        let hideCost = hidesCost(actorOf(req));
        if (ticket) {
            const t = tickets.redeem(ticket, path);
            if (!t) throw new HttpError(401, "This live-update link was already used or has expired. Reload the page to get a new one.");
            hideCost ||= t.hideCost;
        }
        const release = caps.acquire(capKey);
        if (!release) throw new HttpError(429, "Too many live views are open right now. Close one, or wait a moment; the page keeps updating by itself in the meantime.");
        return { release, hideCost };
    };

    /** Take over the response and turn it into an event stream. */
    const open = (req: FastifyRequest, reply: FastifyReply): { write(chunk: string): Promise<boolean>; end(destroy: boolean): void; closed(cb: () => void): void } => {
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
            ...reply.getHeaders(),
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        } as Record<string, string>);
        req.raw.socket?.setNoDelay(true);
        req.raw.socket?.setTimeout(0);
        let over = false;
        const waitDrain = (): Promise<boolean> =>
            new Promise((resolve) => {
                const done = (ok: boolean) => {
                    clearTimeout(timer);
                    raw.off("drain", onDrain);
                    raw.off("close", onClose);
                    resolve(ok);
                };
                const onDrain = () => done(true);
                const onClose = () => done(false);
                const timer = setTimeout(() => done(false), cfg.drainTimeoutMs);
                raw.once("drain", onDrain);
                raw.once("close", onClose);
            });
        return {
            async write(chunk) {
                if (over || raw.destroyed || raw.writableEnded) return false;
                const ok = raw.write(chunk);
                // A client that cannot keep up is dropped rather than buffered: it reconnects and resumes from Last-Event-ID.
                if (raw.writableLength > cfg.maxBufferBytes) return false;
                return ok ? true : waitDrain();
            },
            end(destroy) {
                over = true;
                if (destroy) raw.destroy();
                else if (!raw.writableEnded) raw.end();
            },
            closed(cb) {
                raw.once("close", cb);
                req.raw.once("close", cb);
                if (raw.destroyed) cb();
            },
        };
    };

    const begin = (req: FastifyRequest, reply: FastifyReply, release: () => void, hideCost: boolean, wakeKey: string, makeSource: () => TailSource, startAfter: number, earlier: number): void => {
        const out = open(req, reply);
        let loop: TailLoop;
        let unsubscribe: (() => void) | undefined;
        let cleaned = false;
        const cleanup = (reason: StopReason) => {
            if (cleaned) return;
            cleaned = true;
            unsubscribe?.();
            loops.delete(loop);
            release();
            out.end(reason === "client" || reason === "error");
        };
        const deps = makeSource();
        loop = new TailLoop(
            {
                now: Date.now,
                setTimer: (fn, ms) => setTimeout(fn, ms),
                clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
                readEvents: (after, limit) => deps.readEvents(after, limit).map((e) => (hideCost ? withoutCost({ ...e, message: mask(e.message) }) : { ...e, message: mask(e.message) })),
                readSnapshots: deps.readSnapshots,
                overlap: deps.overlap,
                write: out.write,
                onStop: cleanup,
            },
            cfg,
            startAfter,
            { earlierEvents: earlier },
        );
        loops.add(loop);
        unsubscribe = eventBus.subscribe(wakeKey, () => loop.wake());
        // A browser that went away, a proxy that cut the connection: stop at once, leave nothing behind.
        out.closed(() => loop.stop("client"));
        void out.write(sseFrame({ retry: 3000, comment: "live" })).then(() => loop.start());
    };

    app.get("/api/test-generation/:jobId/stream", async (req, reply) => {
        const { jobId } = req.params as { jobId: string };
        const q = req.query as { lastEventId?: string };
        if (!repo.getJob(jobId)) throw new HttpError(404, "Job not found");
        const { release, hideCost } = admit(req, decodedPath(req), `job:${jobId}`);
        const shown = (j: Parameters<typeof ctx.publicJob>[0]) => (hideCost ? withoutCost(ctx.publicJob(j)) : ctx.publicJob(j));
        const resume = parseLastEventId(req.headers["last-event-id"], q.lastEventId);
        // A first visit shows the most recent events; a resume replays every event missed (in pages), none twice.
        const window = resume === undefined ? recentWindow(p.db, jobId, cfg.initialEvents) : { after: resume, earlier: 0 };
        begin(
            req,
            reply,
            release,
            hideCost,
            jobId,
            () => ({
                readEvents: (after, limit) => jobEventsAfter(p.db, jobId, after, limit),
                readSnapshots: () => {
                    const job = repo.getJob(jobId);
                    if (!job) return { frames: [], done: true, status: "removed" };
                    return { frames: [{ key: jobId, json: shown(job) }], done: TERMINAL_STATUSES.includes(job.status), status: job.status };
                },
            }),
            window.after,
            window.earlier,
        );
    });

    app.get("/api/projects/:id/stream", async (req, reply) => {
        const { id } = req.params as { id: string };
        const q = req.query as { lastEventId?: string };
        ctx.project(id);
        const { release, hideCost } = admit(req, decodedPath(req), `project:${id}`);
        const resume = parseLastEventId(req.headers["last-event-id"], q.lastEventId);
        const startAfter = resume ?? projectHead(p.db, id);
        begin(
            req,
            reply,
            release,
            hideCost,
            ANY_JOB,
            () => {
                const sent = new Map<string, string>();
                return {
                    readEvents: (after, limit) => projectEventsAfter(p.db, id, after, limit),
                    overlap: PROJECT_STREAM_OVERLAP,
                    readSnapshots: () => {
                        const states = recentJobStates(p.db, id, 20);
                        const frames: SnapshotRead["frames"] = [];
                        states.forEach((s, i) => {
                            const stamp = `${s.status}|${s.updatedAt}`;
                            // First round: the newest job and every active one; afterwards only what changed.
                            const wanted = sent.size === 0 ? i === 0 || !TERMINAL_STATUSES.includes(s.status) : sent.has(s.id) || i === 0 || !TERMINAL_STATUSES.includes(s.status);
                            if (!wanted || sent.get(s.id) === stamp) return;
                            sent.set(s.id, stamp);
                            const job = repo.getJob(s.id);
                            if (job) frames.push({ key: s.id, json: hideCost ? withoutCost(ctx.publicJob(job)) : ctx.publicJob(job) });
                        });
                        const active = states.some((s) => !TERMINAL_STATUSES.includes(s.status));
                        return { frames, done: !active, status: active ? "active" : "idle" };
                    },
                };
            },
            startAfter,
            0,
        );
    });
}

export { redactStreamUrl };
