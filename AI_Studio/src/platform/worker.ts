import { randomUUID } from "node:crypto";
import { frameHub } from "./frame-hub.js";
import { runJob, type RunnerDeps } from "./job-runner.js";
import { diskFreeBytes } from "./ops/health.js";
import { loadOpsSettings } from "./ops/settings.js";
import type { JobMode } from "./repo.js";
import { dispatching, RUNNER_JOB_MODES } from "./runner-only.js";

/** What kind of worker this is. The default is today's: one job at a time, every kind of job, run in this process. */
export interface WorkerOptions {
    /** Jobs looked after at once (the dispatch worker: DISPATCH_CONCURRENCY). Default 1. */
    concurrency?: number;
    /** Only these kinds of job are claimed (the dispatch worker: the ones a runner can do). Default: all. */
    modes?: readonly JobMode[];
    /** Jobs run in this process with a browser here (the Explorer view may show it). False for the dispatch worker. Default true. */
    local?: boolean;
}

/** Why a job that needs this server's browser, queued before the platform ran tests only on runners, is ended instead of waiting forever. */
export const NOT_ON_RUNNERS = "Not started: this platform now runs tests only on runners, and this job needed a browser on the server.";

/** Why a job is not started while the disk is nearly full. */
export const diskWait = (minFreeBytes: number) => `Waiting for free disk space: this server keeps at least ${Math.round(minFreeBytes / (1024 * 1024))} MB free (READY_MIN_FREE_MB), so this job has not started yet. It starts once space is freed.`;

/**
 * Queue worker: claims one job at a time (jobs parallelise internally) and recovers jobs
 * orphaned by a crashed worker. Safe to run as a separate process (`npm run worker`) or embedded.
 *
 * The dispatch worker (EXECUTION_MODE=runners, `Worker.dispatch`) is the same loop with several slots: it claims only jobs a runner can do,
 * and each one mostly waits for its runner, so one slow or busy runner never holds up the others' runs. One active job per project still
 * holds, because a job is refused when it is made while its project has one (scheduler.ts `activeJobOf`).
 */
export class Worker {
    private running = false;
    private timer?: NodeJS.Timeout;
    private wake?: () => void;
    private readonly active = new Set<Promise<void>>();
    private readonly slots: number;
    /** Identity recorded as the lease owner of every job this worker claims. */
    private readonly id = randomUUID();
    /** The job already told why it waits, so a poll every second or two does not repeat it. */
    private toldJob?: string;

    constructor(
        private readonly deps: RunnerDeps,
        private readonly pollMs: number,
        private readonly disk: { freeBytes: (dir: string) => number | undefined; minFreeBytes: number } = { freeBytes: diskFreeBytes, minFreeBytes: loadOpsSettings().minFreeBytes },
        private readonly opts: WorkerOptions = {},
    ) {
        this.slots = Math.max(1, Math.floor(opts.concurrency ?? 1));
    }

    /** The dispatch worker of EXECUTION_MODE=runners: DISPATCH_CONCURRENCY slots, runner jobs only, nothing run in this process. */
    static dispatch(deps: RunnerDeps, pollMs: number, disk?: ConstructorParameters<typeof Worker>[2]): Worker {
        return new Worker(deps, pollMs, disk, { concurrency: deps.config.DISPATCH_CONCURRENCY, modes: RUNNER_JOB_MODES, local: false });
    }

    /** Jobs this worker is looking after right now. */
    get busy(): number {
        return this.active.size;
    }

    /** A job fills the disk with screenshots and traces, so it waits while the disk is below the mark /readyz uses; the next job in line says why. */
    private diskIsLow(): boolean {
        const { freeBytes, minFreeBytes } = this.disk;
        const free = minFreeBytes > 0 ? freeBytes(this.deps.config.dataDir) : undefined;
        if (free === undefined || free >= minFreeBytes) {
            this.toldJob = undefined;
            return false;
        }
        const next = this.deps.repo.nextQueuedJobId();
        if (next && next !== this.toldJob) {
            this.toldJob = next;
            const message = diskWait(minFreeBytes);
            console.warn(`[worker] ${message}`);
            this.deps.repo.addEvent(next, { stage: "orchestration", kind: "job_waiting_for_disk", level: "warn", message });
        }
        return true;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        // Jobs run in this process, so the Explorer view can show their browser if this process also serves the API.
        if (this.opts.local !== false) frameHub.markLocal();
        if (this.opts.modes) {
            dispatching.add(this.deps.repo.db);
            const ended = this.deps.repo.failQueuedJobsExcept(this.opts.modes, NOT_ON_RUNNERS);
            if (ended) console.warn(`[worker] ended ${ended} queued job(s) that needed a browser on this server`);
        }
        const reclaimed = this.deps.repo.reclaimStaleJobs();
        if (reclaimed) console.warn(`[worker] re-queued ${reclaimed} orphaned job(s)`);
        void this.loop();
    }

    private async loop(): Promise<void> {
        while (this.running) {
            try {
                this.deps.repo.reclaimStaleJobs();
                // Fill the free slots (one for the plain worker); a slot that frees up wakes the loop at once.
                while (this.running && this.active.size < this.slots && !this.diskIsLow()) {
                    const job = this.deps.repo.claimNextJob(60_000, this.id, this.opts.modes);
                    if (!job) break;
                    const run: Promise<void> = runJob(this.deps, job, this.id)
                        .catch((err) => console.error("[worker] job error:", err))
                        .finally(() => {
                            this.active.delete(run);
                            this.wake?.();
                        });
                    this.active.add(run);
                }
            } catch (err) {
                console.error("[worker] loop error:", err);
            }
            await new Promise<void>((resolve) => {
                this.wake = resolve;
                this.timer = setTimeout(resolve, this.pollMs);
            });
            if (this.timer) clearTimeout(this.timer);
        }
    }

    /** The lease owner this worker writes on the jobs it claims (graceful shutdown finds its running job by it: platform/ops/shutdown.ts). */
    get leaseOwner(): string {
        return this.id;
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.wake?.();
        dispatching.delete(this.deps.repo.db);
        await Promise.allSettled([...this.active]);
    }
}
