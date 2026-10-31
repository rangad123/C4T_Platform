/**
 * Graceful shutdown (SIGTERM / SIGINT), used by both src/main.ts and src/worker-main.ts.
 *
 * 1. Mark the process as stopping: GET /readyz answers 503 from now on, so a load balancer stops sending new work.
 * 2. Stop taking work: the scheduler, run sequences, scheduled backups and the worker's loop stop claiming jobs.
 * 3. Let the running job finish, for up to SHUTDOWN_GRACE_SECONDS (default 60).
 * 4. If it is still running then, stop it the way a person's Stop does (its browsers and test processes are closed by the job's own stop path,
 *    the tests that did not run keep their earlier result), wait a little more, and record honestly what happened: the job ends as failed with
 *    "Interrupted: the platform was shut down…" and an event saying so. If even that does not finish, the job is marked interrupted directly
 *    (and its tests that were still running are put back to "not run yet") so nothing is left looking as if it were running.
 * 5. Close the HTTP server (which ends recordings and their browsers, and live streams), wait for alerts in flight (5 s at most), flush the
 *    log, close the database, exit.
 * A second signal while this runs exits at once.
 */
import type { Repo } from "../repo.js";
import type { Db } from "../db.js";

export const INTERRUPTED_MESSAGE = "Interrupted: the platform was shut down before this job finished. Start it again when the platform is back.";
/** After the grace period: how long the stop path of the job gets to close its browsers and record what ran. */
export const STOP_WAIT_MS = 20_000;

const ACTIVE = "('DISCOVERING','ANALYZING','PLANNING','GENERATING','VALIDATING')";

export interface ShutdownParts {
    repo: Repo;
    db: Db;
    worker?: { stop(): Promise<void>; readonly leaseOwner: string };
    /** Stop taking new work (scheduler, run sequences, backups, heartbeat). Run in order before the worker is waited for. */
    stopTakingWork: Array<() => Promise<void> | void>;
    closeServer?: () => Promise<void>;
    /** Wait for work that must not be lost (alerts in flight); capped at 5 s here. */
    flush?: () => Promise<void>;
    graceMs: number;
    stopWaitMs?: number;
    log: (level: "info" | "warn" | "error", msg: string) => void;
    exit: (code: number) => void;
    /** Shared with GET /readyz. */
    state: { shuttingDown: boolean };
}

const sleep = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms).unref());

function activeJobsOf(db: Db, owner: string): Array<{ id: string; mode: string | null; testIds: string | null }> {
    return db.all(`SELECT id, ${db.dialect.jsonText("options_json", "mode")} AS mode, ${db.dialect.jsonText("options_json", "testIds")} AS testIds FROM generation_jobs WHERE lease_owner = ? AND status IN ${ACTIVE}`, owner) as never;
}

/** Record that a job was ended by the shutdown (after its own stop path ran, or instead of it). */
export function markInterrupted(repo: Repo, db: Db, jobId: string, graceMs: number, stillRunning: boolean): void {
    if (stillRunning) {
        const row = db.get<{ mode: string | null; testIds: string | null }>(`SELECT ${db.dialect.jsonText("options_json", "mode")} AS mode, ${db.dialect.jsonText("options_json", "testIds")} AS testIds FROM generation_jobs WHERE id = ?`, jobId);
        if (row?.mode === "validate") {
            const ids: string[] = row.testIds ? (JSON.parse(row.testIds) as string[]) : [];
            repo.resetValidatingTests(ids, "PENDING", null);
        }
    }
    repo.setJobStatus(jobId, "FAILED", INTERRUPTED_MESSAGE);
    // The lease goes too, so a restarted worker does not pick the job up again on its own: a person decides to start it again.
    db.run("UPDATE generation_jobs SET lease_owner = NULL, lease_until = NULL WHERE id = ?", jobId);
    repo.addEvent(jobId, {
        stage: "orchestration",
        kind: "job_interrupted",
        level: "warn",
        message: `The platform was shut down while this job was running. It waited ${Math.round(graceMs / 1000)} s for the job to finish, then stopped it. ${stillRunning ? "The tests that were still running are back to not run yet." : "Tests that finished keep their result; the others keep the result they had before."}`,
    });
}

export function createShutdown(parts: ShutdownParts): (signal: string) => Promise<void> {
    let started = false;
    return async (signal: string) => {
        if (started) {
            parts.log("warn", `[shutdown] ${signal} again: stopping now.`);
            parts.exit(1);
            return;
        }
        started = true;
        parts.state.shuttingDown = true;
        parts.log("info", `[shutdown] ${signal} received: no new jobs are taken; waiting up to ${Math.round(parts.graceMs / 1000)} s for the running job.`);
        for (const stop of parts.stopTakingWork) {
            try {
                await stop();
            } catch (err) {
                parts.log("warn", `[shutdown] A part did not stop cleanly: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (parts.worker) {
            const owner = parts.worker.leaseOwner;
            const stopped = parts.worker.stop().then(() => "done" as const);
            if ((await Promise.race([stopped, sleep(parts.graceMs)])) === "timeout") {
                const jobs = activeJobsOf(parts.db, owner);
                for (const j of jobs) {
                    parts.log("warn", `[job ${j.id.slice(0, 8)}] still running after the grace period: stopping it.`);
                    parts.repo.requestCancel(j.id);
                }
                const finished = (await Promise.race([stopped, sleep(parts.stopWaitMs ?? STOP_WAIT_MS)])) === "done";
                for (const j of jobs) {
                    const stillActive = activeJobsOf(parts.db, owner).some((a) => a.id === j.id);
                    const now = parts.repo.getJob(j.id);
                    // Only the stop we asked for is relabelled: a job that reached its own end in the meantime keeps its real result.
                    if (stillActive || (now?.status === "FAILED" && now.error === "Cancelled")) markInterrupted(parts.repo, parts.db, j.id, parts.graceMs, stillActive);
                }
                if (!finished) parts.log("warn", "[shutdown] The running job did not stop in time; it was marked interrupted.");
            }
        }
        try {
            await parts.closeServer?.();
        } catch (err) {
            parts.log("warn", `[shutdown] The server did not close cleanly: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (parts.flush) await Promise.race([parts.flush().catch(() => undefined), sleep(5_000)]);
        parts.log("info", "[shutdown] Stopped cleanly.");
        try {
            parts.db.close();
        } catch {
            /* already closed */
        }
        await new Promise<void>((r) => process.stdout.write("", () => r()));
        parts.exit(0);
    };
}
