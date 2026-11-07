import { useCallback, useEffect, useRef, useState } from "react";
import { api, type EventRow, type Job } from "../api";

/**
 * Live updates (server-sent events). The page asks the platform for a single-use ticket (with the API key in a header), opens an
 * EventSource with it, and keeps the last event id it saw. If the connection drops it asks for a new ticket and resumes after that id,
 * so nothing is missed or repeated. While it is not connected the pages keep polling as before; this file only adds the fast path.
 *
 * The API key never appears in an address: the ticket is the only credential in the URL, it works once and expires in a minute.
 */
export type LiveState = "off" | "connecting" | "live" | "retrying" | "ended";

interface Handlers {
    onJob?: (job: Job) => void;
    onLog?: (e: EventRow, jobId: string) => void;
    onEnd?: (status: string) => void;
    onState?: (s: LiveState) => void;
}

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** Opens a stream at `path` (for example `/test-generation/<id>/stream`). Returns the function that closes it and cancels any retry. */
export function openStream(path: string, h: Handlers): () => void {
    if (typeof EventSource === "undefined") {
        h.onState?.("off");
        return () => undefined;
    }
    let closed = false;
    let es: EventSource | undefined;
    let timer: number | undefined;
    let lastId = 0;
    let attempt = 0;

    const fail = () => {
        es?.close();
        es = undefined;
        if (closed) return;
        h.onState?.("retrying");
        // Retries wait longer each time (1 s, 2 s, 4 s ... up to 30 s) so a platform that is down is not hammered.
        const wait = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt++);
        timer = window.setTimeout(() => void connect(), wait);
    };

    const connect = async () => {
        if (closed) return;
        h.onState?.(attempt === 0 ? "connecting" : "retrying");
        let ticket: string;
        try {
            ticket = (await api<{ ticket: string }>("/stream-tickets", { method: "POST", body: { path: `/api${path}` } })).ticket;
        } catch {
            return fail();
        }
        if (closed) return;
        const source = new EventSource(`/api${path}?ticket=${encodeURIComponent(ticket)}${lastId ? `&lastEventId=${lastId}` : ""}`);
        es = source;
        source.addEventListener("open", () => {
            attempt = 0;
            h.onState?.("live");
        });
        source.addEventListener("job", (e) => {
            try {
                h.onJob?.(JSON.parse((e as MessageEvent).data) as Job);
            } catch {
                /* a frame that does not parse is skipped */
            }
        });
        source.addEventListener("log", (e) => {
            try {
                const d = JSON.parse((e as MessageEvent).data) as { id: number; at: string; level: string; message: string; stage: string; kind: string; jobId: string; data?: unknown };
                if (d.id <= lastId) return; // never twice
                lastId = d.id;
                // A runner's live event also carries its facts (the test, the step, the screenshot); every other frame has none.
                h.onLog?.({ id: d.id, stage: d.stage, kind: d.kind, level: d.level, message: d.message, createdAt: d.at, ...(d.data !== undefined ? { data: d.data } : {}) }, d.jobId);
            } catch {
                /* skipped */
            }
        });
        source.addEventListener("end", (e) => {
            let status = "ended";
            try {
                status = String(JSON.parse((e as MessageEvent).data).status ?? "ended");
            } catch {
                /* the plain word will do */
            }
            closed = true;
            source.close();
            h.onState?.("ended");
            h.onEnd?.(status);
        });
        // A refused or dropped connection ends this EventSource for good (a used ticket cannot be reused): start again with a new ticket.
        source.addEventListener("error", () => {
            if (source === es) fail();
        });
    };

    void connect();
    return () => {
        closed = true;
        clearTimeout(timer);
        es?.close();
        es = undefined;
    };
}

/** Events keyed by id, in id order, from any number of sources (the first fetch, the stream). */
export function mergeEvents(...lists: Array<EventRow[] | undefined>): EventRow[] {
    const byId = new Map<number, EventRow>();
    for (const l of lists) for (const e of l ?? []) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.id - b.id);
}

export interface JobStream {
    state: LiveState;
    /** True while events are arriving by stream (pages then skip their polling). */
    live: boolean;
    job: Job | undefined;
    events: EventRow[];
    /** The text of the newest event, for the one status line that is announced to screen readers. */
    latest: string | undefined;
    paused: boolean;
    setPaused: (p: boolean) => void;
    /** Events that arrived while updates were paused. */
    held: number;
}

const MAX_KEPT = 2000;

/** The live view of one run: its job snapshots and events. Closed when `enabled` turns false or the page goes away. */
export function useJobStream(jobId: string | null, enabled: boolean, onEnd?: (status: string) => void): JobStream {
    const [state, setState] = useState<LiveState>("off");
    const [job, setJob] = useState<Job>();
    const [events, setEvents] = useState<EventRow[]>([]);
    const [frozen, setFrozen] = useState<EventRow[] | null>(null);
    const buffer = useRef<EventRow[]>([]);
    const flushTimer = useRef<number>();
    const endRef = useRef(onEnd);
    endRef.current = onEnd;

    useEffect(() => {
        if (!jobId || !enabled) {
            setState("off");
            return;
        }
        setEvents([]);
        setJob(undefined);
        // Events are batched for ~100 ms so a backlog of hundreds is one re-render, not hundreds.
        const flush = () => {
            flushTimer.current = undefined;
            const batch = buffer.current.splice(0);
            if (batch.length) setEvents((prev) => mergeEvents(prev, batch).slice(-MAX_KEPT));
        };
        const close = openStream(`/test-generation/${jobId}/stream`, {
            onState: setState,
            onJob: setJob,
            onLog: (e) => {
                buffer.current.push(e);
                flushTimer.current ??= window.setTimeout(flush, 100);
            },
            onEnd: (s) => {
                flush();
                endRef.current?.(s);
            },
        });
        return () => {
            close();
            clearTimeout(flushTimer.current);
            flushTimer.current = undefined;
            buffer.current = [];
        };
    }, [jobId, enabled]);

    const setPaused = useCallback(
        (p: boolean) => {
            setFrozen(p ? events : null);
        },
        [events],
    );
    const shown = frozen ?? events;
    return { state, live: state === "live", job, events: shown, latest: events.at(-1)?.message, paused: frozen !== null, setPaused, held: frozen ? Math.max(0, events.length - frozen.length) : 0 };
}

export interface ProjectStream {
    state: LiveState;
    live: boolean;
    /** The newest event text of each run. */
    latestByJob: Record<string, string>;
}

/** Live view of all runs of a project; `onChange` is called (at most about once a second) when any run's state changed. */
export function useProjectStream(projectId: string | null, enabled: boolean, onChange?: () => void): ProjectStream {
    const [state, setState] = useState<LiveState>("off");
    const [latestByJob, setLatest] = useState<Record<string, string>>({});
    const changeRef = useRef(onChange);
    changeRef.current = onChange;

    useEffect(() => {
        if (!projectId || !enabled) {
            setState("off");
            return;
        }
        let pending: number | undefined;
        const changed = () => {
            if (pending !== undefined) return;
            pending = window.setTimeout(() => {
                pending = undefined;
                changeRef.current?.();
            }, 800);
        };
        const close = openStream(`/projects/${projectId}/stream`, {
            onState: setState,
            onJob: changed,
            onLog: (e, jobId) => setLatest((m) => ({ ...m, [jobId]: e.message })),
            onEnd: () => changeRef.current?.(),
        });
        return () => {
            close();
            clearTimeout(pending);
        };
    }, [projectId, enabled]);

    return { state, live: state === "live", latestByJob };
}
