/**
 * Where the Explorer view's pictures live: in this process's memory and nowhere else.
 *
 *   - One latest picture per active job, at most 8 jobs held (the oldest goes first), dropped when the job ends or is stopped, and after 30 seconds
 *     without a new one.
 *   - A job counts as "watched" for 10 seconds after each read of the picture route. The engine takes no picture for a job nobody watches.
 *   - At most 3 reads a second per job.
 *
 * Nothing here is written to disk, logged, put into an event or stored in the database. The long version is docs/features/ux-explorer-view.md.
 *
 * A picture reaches this hub only when the job runs in the same process as the API server (the normal case, and `npm run dev`). When the worker is a
 * separate program (`npm run worker`) the server never sees its memory: `canServe` is then false and the answer says so in words.
 */
import type { ExplorerFrame, FrameTarget } from "../engine/frames/sink.js";
import { ACTIVE_STATES, type JobRow } from "./repo.js";

export const WATCH_WINDOW_MS = 10_000;
export const FRAME_IDLE_MS = 30_000;
export const MAX_FRAME_JOBS = 8;
export const READS_PER_SECOND = 3;
/** Remembered watch marks and secret lists are bounded too. */
const MAX_MARKS = 64;

export interface HeldFrame extends ExplorerFrame {
    /** When the hub received it (the idle clock). */
    receivedAt: number;
}

export class FrameHub {
    private readonly frames = new Map<string, HeldFrame>();
    private readonly watched = new Map<string, number>();
    private readonly reads = new Map<string, number[]>();
    private readonly secrets = new Map<string, string[]>();
    private timer: NodeJS.Timeout | undefined;
    private local = false;
    private puts = 0;

    constructor(private readonly now: () => number = Date.now) {}

    /** True once a job of this process has run or a worker was started here: only then can this process show pictures. */
    get canServe(): boolean {
        return this.local;
    }
    /** How many pictures this hub has ever been given (a test reads it to show that none arrive while nobody watches). */
    get accepted(): number {
        return this.puts;
    }
    markLocal(): void {
        this.local = true;
    }

    /** A person (or tool) read the picture route for this job just now. */
    markWatched(jobId: string): void {
        const t = this.now();
        this.prune(t);
        if (!this.watched.has(jobId) && this.watched.size >= MAX_MARKS) this.watched.delete(this.watched.keys().next().value as string);
        this.watched.set(jobId, t);
    }

    isWatched(jobId: string): boolean {
        const at = this.watched.get(jobId);
        if (at === undefined) return false;
        if (this.now() - at > WATCH_WINDOW_MS) {
            this.watched.delete(jobId);
            return false;
        }
        return true;
    }

    /** Keeps the latest picture of a job. */
    put(jobId: string, frame: ExplorerFrame): void {
        this.local = true;
        this.puts++;
        const t = this.now();
        this.prune(t);
        this.frames.delete(jobId); // re-inserted last: Map order is age order
        this.frames.set(jobId, { ...frame, receivedAt: t });
        while (this.frames.size > MAX_FRAME_JOBS) this.frames.delete(this.frames.keys().next().value as string);
        this.sweepLater();
    }

    latest(jobId: string): HeldFrame | undefined {
        this.prune(this.now());
        return this.frames.get(jobId);
    }

    /** Forget everything about a job: its picture, its watch mark, its read counts and the secrets listed for it. */
    drop(jobId: string): void {
        this.frames.delete(jobId);
        this.watched.delete(jobId);
        this.reads.delete(jobId);
        this.secrets.delete(jobId);
    }

    /** True if this read is within the per-second allowance of the job (and counts it). */
    allowRead(jobId: string): boolean {
        const t = this.now();
        const recent = (this.reads.get(jobId) ?? []).filter((x) => t - x < 1000);
        if (recent.length >= READS_PER_SECOND) {
            this.reads.set(jobId, recent);
            return false;
        }
        recent.push(t);
        if (!this.reads.has(jobId) && this.reads.size >= MAX_MARKS) this.reads.delete(this.reads.keys().next().value as string);
        this.reads.set(jobId, recent);
        return true;
    }

    /** Stored values (a password, an authenticator secret) whose appearance in a picture is to be prevented, for one job. */
    addSecrets(jobId: string, values: ReadonlyArray<string | undefined | null>): void {
        const list = this.secrets.get(jobId) ?? [];
        for (const v of values) if (typeof v === "string" && v.length > 0 && !list.includes(v) && list.length < 50) list.push(v);
        if (!this.secrets.has(jobId) && this.secrets.size >= MAX_MARKS) this.secrets.delete(this.secrets.keys().next().value as string);
        this.secrets.set(jobId, list);
    }
    secretsOf(jobId: string): readonly string[] {
        return this.secrets.get(jobId) ?? [];
    }

    /** The picture sink of one job: wanted while watched, and pictures replace the held one. */
    targetFor(jobId: string): FrameTarget {
        return { wanted: () => this.isWatched(jobId), accept: (f) => this.put(jobId, f) };
    }

    get heldJobs(): number {
        this.prune(this.now());
        return this.frames.size;
    }

    private prune(t: number): void {
        for (const [id, f] of this.frames) if (t - f.receivedAt > FRAME_IDLE_MS) this.frames.delete(id);
        for (const [id, at] of this.watched) if (t - at > WATCH_WINDOW_MS) this.watched.delete(id);
    }

    /** A background sweep so an idle picture is let go even when nobody asks; it stops itself when nothing is held and never keeps the process alive. */
    private sweepLater(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.prune(this.now());
            if (this.frames.size === 0) {
                clearInterval(this.timer);
                this.timer = undefined;
            }
        }, 5_000);
        this.timer.unref();
    }
}

/** The platform's hub (one per process). */
export const frameHub = new FrameHub();

// ── what can be shown for a job ─────────────────────────────────────────────

export type WatchWhy = "waiting" | "nothing" | "elsewhere" | "finished" | "stopping" | "unavailable";
export interface WatchState {
    canWatch: boolean;
    why?: WatchWhy;
    reason?: string;
}

export const REASONS = {
    elsewhere: "This part runs on another computer and cannot be shown.",
    nothing: "Nothing to show right now.",
    waiting: "Waiting for the first picture.",
    finished: "This has finished, so there is nothing more to show.",
    stopping: "Stopping, so there is nothing more to show.",
    unavailable: "The jobs of this platform run in a separate worker program, so its browser cannot be shown here.",
} as const;

/**
 * Can a person watch this job's browser right now? True only while a browser-driven part that is wired to the Explorer view runs on this platform's
 * computer: the exploration itself (not creating tests from a plan) and the browser work of a test built from a sentence.
 * `ranOnAgent` is whether the job's scripts run on a runner agent (only the run part ever does).
 */
export function watchState(job: Pick<JobRow, "status" | "options" | "cancelRequested">, o: { ranOnAgent?: boolean; hub?: FrameHub } = {}): WatchState {
    const hub = o.hub ?? frameHub;
    if (!ACTIVE_STATES.includes(job.status) && job.status !== "QUEUED") return { canWatch: false, why: "finished", reason: REASONS.finished };
    if (job.cancelRequested) return { canWatch: false, why: "stopping", reason: REASONS.stopping };
    const mode = job.options.mode ?? "generate";
    const browserPart = (mode === "generate" && !job.options.fromPlan && job.status === "DISCOVERING") || (mode === "plain" && (job.options.plainKind ?? "web") === "web" && job.status === "GENERATING");
    if (browserPart) {
        if (!hub.canServe) return { canWatch: false, why: "unavailable", reason: REASONS.unavailable };
        return { canWatch: true };
    }
    if (o.ranOnAgent && job.status === "VALIDATING") return { canWatch: false, why: "elsewhere", reason: REASONS.elsewhere };
    return { canWatch: false, why: "nothing", reason: REASONS.nothing };
}
