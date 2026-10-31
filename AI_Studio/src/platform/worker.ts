import { randomUUID } from "node:crypto";
import { frameHub } from "./frame-hub.js";
import { runJob, type RunnerDeps } from "./job-runner.js";
import { diskFreeBytes } from "./ops/health.js";
import { loadOpsSettings } from "./ops/settings.js";

/** Why a job is not started while the disk is nearly full. */
export const diskWait = (minFreeBytes: number) => `Waiting for free disk space: this server keeps at least ${Math.round(minFreeBytes / (1024 * 1024))} MB free (READY_MIN_FREE_MB), so this job has not started yet. It starts once space is freed.`;

/**
 * Queue worker: claims one job at a time (jobs parallelise internally) and recovers jobs
 * orphaned by a crashed worker. Safe to run as a separate process (`npm run worker`) or embedded.
 */
export class Worker {
    private running = false;
    private timer?: NodeJS.Timeout;
    private current?: Promise<void>;
    /** Identity recorded as the lease owner of every job this worker claims. */
    private readonly id = randomUUID();
    /** The job already told why it waits, so a poll every second or two does not repeat it. */
    private toldJob?: string;

    constructor(
        private readonly deps: RunnerDeps,
        private readonly pollMs: number,
        private readonly disk: { freeBytes: (dir: string) => number | undefined; minFreeBytes: number } = { freeBytes: diskFreeBytes, minFreeBytes: loadOpsSettings().minFreeBytes },
    ) {}

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
        frameHub.markLocal();
        const reclaimed = this.deps.repo.reclaimStaleJobs();
        if (reclaimed) console.warn(`[worker] re-queued ${reclaimed} orphaned job(s)`);
        void this.loop();
    }

    private async loop(): Promise<void> {
        while (this.running) {
            try {
                this.deps.repo.reclaimStaleJobs();
                const job = this.diskIsLow() ? undefined : this.deps.repo.claimNextJob(60_000, this.id);
                if (job) {
                    this.current = runJob(this.deps, job, this.id);
                    await this.current;
                    continue; // look for more work immediately
                }
            } catch (err) {
                console.error("[worker] loop error:", err);
            }
            await new Promise<void>((resolve) => {
                this.timer = setTimeout(resolve, this.pollMs);
            });
        }
    }

    /** The lease owner this worker writes on the jobs it claims (graceful shutdown finds its running job by it: platform/ops/shutdown.ts). */
    get leaseOwner(): string {
        return this.id;
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        await this.current?.catch(() => undefined);
    }
}
