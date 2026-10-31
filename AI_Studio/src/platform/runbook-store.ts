/**
 * Runbooks and their runs (migration slot 14). A run keeps a snapshot of the definition it started with, so editing a runbook
 * never changes a run in progress, and one row per step so a person can watch the run advance.
 *
 * Which schedule or deploy token starts a runbook is kept in two small link tables of their own (not as columns on the
 * schedules / trigger tables), so those features and their migrations stay exactly as they were.
 */
import { randomUUID } from "node:crypto";
import type { RunStatus, StepStatus } from "../engine/runbook/flow.js";
import type { RunbookDefinition } from "../engine/runbook/schema.js";
import type { Db, Row } from "./db.js";

export const RUNBOOKS_MIGRATION = `
CREATE TABLE runbooks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    definition_json TEXT NOT NULL,        -- the validated RunbookDefinition (version 1)
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_runbooks_project ON runbooks(project_id);
CREATE TABLE runbook_runs (
    id TEXT PRIMARY KEY,
    runbook_id TEXT NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    runbook_name TEXT NOT NULL,
    status TEXT NOT NULL,                 -- running | passed | failed | stopped | timed_out | cancelled | interrupted
    reason TEXT,                          -- the outcome in plain words
    any_failure INTEGER NOT NULL DEFAULT 0,
    trigger_kind TEXT NOT NULL,           -- manual | schedule | deploy
    trigger_ref TEXT,                     -- schedule id, or deploy token id
    trigger_label TEXT,                   -- what the pipeline said about the deploy (commit, environment, token label)
    owner TEXT NOT NULL,                  -- the process that drives this run
    heartbeat_at INTEGER NOT NULL,        -- epoch ms; a run whose driver stopped beating is marked interrupted
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    definition_json TEXT NOT NULL,        -- snapshot: editing the runbook never changes a run in progress
    created_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX idx_runbook_runs_runbook ON runbook_runs(runbook_id, created_at);
-- At most one active run per project, enforced by the database (a runbook never runs two jobs at once).
CREATE UNIQUE INDEX idx_runbook_runs_one_active ON runbook_runs(project_id) WHERE status = 'running';
CREATE TABLE runbook_run_steps (
    run_id TEXT NOT NULL REFERENCES runbook_runs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    step_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL,                 -- pending | running | passed | failed | skipped | stopped | timed_out
    job_id TEXT,                          -- the job this step started
    reason TEXT,                          -- in plain words
    measured TEXT,                        -- what a check measured
    detail_json TEXT,                     -- structured numbers (pass rate, counts)
    started_at TEXT, finished_at TEXT,
    PRIMARY KEY (run_id, idx)
);
CREATE TABLE runbook_schedule_links (
    schedule_id TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
    runbook_id TEXT NOT NULL
);
CREATE TABLE runbook_token_links (
    token_id TEXT PRIMARY KEY REFERENCES trigger_tokens(id) ON DELETE CASCADE,
    runbook_id TEXT NOT NULL
);
`;

export interface Runbook {
    id: string;
    projectId: string;
    name: string;
    definition: RunbookDefinition;
    createdAt: string;
    updatedAt: string;
}

export type RunTrigger = "manual" | "schedule" | "deploy";

export interface RunStepRow {
    index: number;
    stepId: string;
    type: string;
    title: string;
    status: StepStatus;
    jobId: string | null;
    reason: string | null;
    measured: string | null;
    detail: Record<string, unknown> | null;
    startedAt: string | null;
    finishedAt: string | null;
}

export interface RunbookRun {
    id: string;
    runbookId: string;
    projectId: string;
    runbookName: string;
    status: RunStatus;
    reason: string | null;
    anyFailure: boolean;
    trigger: RunTrigger;
    triggerRef: string | null;
    triggerLabel: string | null;
    owner: string;
    heartbeatAt: number;
    cancelRequested: boolean;
    definition: RunbookDefinition;
    createdAt: string;
    finishedAt: string | null;
}

const toRunbook = (r: Row): Runbook => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    definition: JSON.parse(r.definition_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

const toRun = (r: Row): RunbookRun => ({
    id: r.id,
    runbookId: r.runbook_id,
    projectId: r.project_id,
    runbookName: r.runbook_name,
    status: r.status,
    reason: r.reason,
    anyFailure: Boolean(r.any_failure),
    trigger: r.trigger_kind,
    triggerRef: r.trigger_ref,
    triggerLabel: r.trigger_label,
    owner: r.owner,
    heartbeatAt: r.heartbeat_at,
    cancelRequested: Boolean(r.cancel_requested),
    definition: JSON.parse(r.definition_json),
    createdAt: r.created_at,
    finishedAt: r.finished_at,
});

const toStep = (r: Row): RunStepRow => ({
    index: r.idx,
    stepId: r.step_id,
    type: r.type,
    title: r.title,
    status: r.status,
    jobId: r.job_id,
    reason: r.reason,
    measured: r.measured,
    detail: r.detail_json ? JSON.parse(r.detail_json) : null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
});

/** A second active run for the same project (the database refused it). */
export class RunbookBusy extends Error {
    constructor(readonly activeRunId: string) {
        super("A runbook is already running for this project");
    }
}

export class RunbookStore {
    constructor(
        private readonly db: Db,
        private readonly clock: () => number = Date.now,
    ) {}

    private iso = () => new Date(this.clock()).toISOString();

    // ── runbooks ────────────────────────────────────────────────────────────
    create(projectId: string, def: RunbookDefinition): Runbook {
        const id = randomUUID();
        const t = this.iso();
        this.db.run("INSERT INTO runbooks (id, project_id, name, definition_json, created_at, updated_at) VALUES (?,?,?,?,?,?)", id, projectId, def.name, JSON.stringify(def), t, t);
        return this.get(id)!;
    }

    get(id: string): Runbook | undefined {
        const r = this.db.get("SELECT * FROM runbooks WHERE id = ?", id);
        return r ? toRunbook(r) : undefined;
    }

    list(projectId: string): Runbook[] {
        return this.db.all(`SELECT * FROM runbooks WHERE project_id = ? ORDER BY created_at, ${this.db.dialect.insertionOrder()}`, projectId).map(toRunbook);
    }

    count(projectId: string): number {
        return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runbooks WHERE project_id = ?", projectId)?.n ?? 0;
    }

    update(id: string, def: RunbookDefinition): Runbook | undefined {
        this.db.run("UPDATE runbooks SET name = ?, definition_json = ?, updated_at = ? WHERE id = ?", def.name, JSON.stringify(def), this.iso(), id);
        return this.get(id);
    }

    delete(id: string): boolean {
        this.db.run("DELETE FROM runbook_schedule_links WHERE runbook_id = ?", id);
        this.db.run("DELETE FROM runbook_token_links WHERE runbook_id = ?", id);
        return Number(this.db.run("DELETE FROM runbooks WHERE id = ?", id).changes) > 0;
    }

    // ── what starts a runbook ───────────────────────────────────────────────
    scheduleLink(scheduleId: string): string | null {
        return this.db.get<{ runbook_id: string }>("SELECT runbook_id FROM runbook_schedule_links WHERE schedule_id = ?", scheduleId)?.runbook_id ?? null;
    }
    setScheduleLink(scheduleId: string, runbookId: string | null): void {
        if (runbookId === null) this.db.run("DELETE FROM runbook_schedule_links WHERE schedule_id = ?", scheduleId);
        else this.db.run("INSERT INTO runbook_schedule_links (schedule_id, runbook_id) VALUES (?,?) ON CONFLICT(schedule_id) DO UPDATE SET runbook_id = excluded.runbook_id", scheduleId, runbookId);
    }
    tokenLink(tokenId: string): string | null {
        return this.db.get<{ runbook_id: string }>("SELECT runbook_id FROM runbook_token_links WHERE token_id = ?", tokenId)?.runbook_id ?? null;
    }
    setTokenLink(tokenId: string, runbookId: string | null): void {
        if (runbookId === null) this.db.run("DELETE FROM runbook_token_links WHERE token_id = ?", tokenId);
        else this.db.run("INSERT INTO runbook_token_links (token_id, runbook_id) VALUES (?,?) ON CONFLICT(token_id) DO UPDATE SET runbook_id = excluded.runbook_id", tokenId, runbookId);
    }

    /** The schedules and (live) deploy tokens that start this runbook. */
    usedBy(runbookId: string): { schedules: Array<{ id: string; name: string }>; tokens: Array<{ id: string; label: string | null; hint: string }> } {
        return {
            schedules: this.db.all<Row>("SELECT s.id, s.name FROM runbook_schedule_links l JOIN schedules s ON s.id = l.schedule_id WHERE l.runbook_id = ? ORDER BY s.created_at", runbookId).map((r) => ({ id: r.id, name: r.name })),
            tokens: this.db.all<Row>("SELECT t.id, t.label, t.hint FROM runbook_token_links l JOIN trigger_tokens t ON t.id = l.token_id WHERE l.runbook_id = ? AND t.revoked_at IS NULL ORDER BY t.created_at", runbookId).map((r) => ({ id: r.id, label: r.label, hint: r.hint })),
        };
    }

    // ── runs ────────────────────────────────────────────────────────────────
    /** Start a run and its (pending) step rows in one transaction. Throws RunbookBusy if the project already has an active run. */
    createRun(input: { runbook: Runbook; trigger: RunTrigger; triggerRef?: string; triggerLabel?: string; owner: string; titles: string[] }): RunbookRun {
        const id = randomUUID();
        const t = this.iso();
        const def = input.runbook.definition;
        try {
            this.db.tx(() => {
                this.db.run(
                    `INSERT INTO runbook_runs (id, runbook_id, project_id, runbook_name, status, trigger_kind, trigger_ref, trigger_label, owner, heartbeat_at, definition_json, created_at)
                     VALUES (?,?,?,?,'running',?,?,?,?,?,?,?)`,
                    id, input.runbook.id, input.runbook.projectId, input.runbook.name, input.trigger, input.triggerRef ?? null, input.triggerLabel ?? null, input.owner, this.clock(), JSON.stringify(def), t,
                );
                def.steps.forEach((s, i) => this.db.run("INSERT INTO runbook_run_steps (run_id, idx, step_id, type, title, status) VALUES (?,?,?,?,?,'pending')", id, i, s.id, s.type, input.titles[i] ?? s.id));
            });
        } catch (e) {
            const active = this.activeRun(input.runbook.projectId);
            if (active && /UNIQUE/i.test(String((e as Error).message))) throw new RunbookBusy(active.id);
            throw e;
        }
        return this.getRun(id)!;
    }

    getRun(id: string): RunbookRun | undefined {
        const r = this.db.get("SELECT * FROM runbook_runs WHERE id = ?", id);
        return r ? toRun(r) : undefined;
    }

    runSteps(runId: string): RunStepRow[] {
        return this.db.all("SELECT * FROM runbook_run_steps WHERE run_id = ? ORDER BY idx", runId).map(toStep);
    }

    listRuns(runbookId: string, limit = 20): RunbookRun[] {
        return this.db.all(`SELECT * FROM runbook_runs WHERE runbook_id = ? ORDER BY created_at DESC, ${this.db.dialect.insertionOrder()} DESC LIMIT ?`, runbookId, limit).map(toRun);
    }

    lastRun(runbookId: string): RunbookRun | undefined {
        return this.listRuns(runbookId, 1)[0];
    }

    /** The project's run that is still going (there is at most one). */
    activeRun(projectId: string): RunbookRun | undefined {
        const r = this.db.get("SELECT * FROM runbook_runs WHERE project_id = ? AND status = 'running'", projectId);
        return r ? toRun(r) : undefined;
    }

    heartbeat(runId: string): void {
        this.db.run("UPDATE runbook_runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'", this.clock(), runId);
    }

    markAnyFailure(runId: string): void {
        this.db.run("UPDATE runbook_runs SET any_failure = 1 WHERE id = ?", runId);
    }

    isCancelRequested(runId: string): boolean {
        return Boolean(this.db.get<Row>("SELECT cancel_requested FROM runbook_runs WHERE id = ?", runId)?.cancel_requested);
    }

    /** Ask the run to stop. False when it is not running (nothing to cancel). */
    requestCancel(runId: string): boolean {
        return Number(this.db.run("UPDATE runbook_runs SET cancel_requested = 1 WHERE id = ? AND status = 'running'", runId).changes) > 0;
    }

    /** End a run. Only a run that is still "running" can end (the first ending wins). */
    finishRun(runId: string, status: Exclude<RunStatus, "running">, reason: string): boolean {
        return Number(this.db.run("UPDATE runbook_runs SET status = ?, reason = ?, finished_at = ? WHERE id = ? AND status = 'running'", status, reason.slice(0, 500), this.iso(), runId).changes) > 0;
    }

    /** Steps never reached are recorded as skipped, with the reason. */
    skipPending(runId: string, reason: string): void {
        this.db.run("UPDATE runbook_run_steps SET status = 'skipped', reason = ? WHERE run_id = ? AND status = 'pending'", reason, runId);
    }
    skipStep(runId: string, index: number, reason: string): void {
        this.db.run("UPDATE runbook_run_steps SET status = 'skipped', reason = ? WHERE run_id = ? AND idx = ? AND status = 'pending'", reason, runId, index);
    }

    startStep(runId: string, index: number): void {
        this.db.run("UPDATE runbook_run_steps SET status = 'running', started_at = ? WHERE run_id = ? AND idx = ?", this.iso(), runId, index);
    }
    setStepJob(runId: string, index: number, jobId: string): void {
        this.db.run("UPDATE runbook_run_steps SET job_id = ? WHERE run_id = ? AND idx = ?", jobId, runId, index);
    }
    finishStep(runId: string, index: number, v: { status: Exclude<StepStatus, "pending" | "running">; reason?: string; measured?: string; detail?: Record<string, unknown> }): void {
        this.db.run(
            "UPDATE runbook_run_steps SET status = ?, reason = ?, measured = ?, detail_json = ?, finished_at = ? WHERE run_id = ? AND idx = ?",
            v.status, v.reason?.slice(0, 500) ?? null, v.measured?.slice(0, 200) ?? null, v.detail ? JSON.stringify(v.detail) : null, this.iso(), runId, index,
        );
    }

    /**
     * Runs another process was driving whose driver stopped beating (it was restarted or crashed). They are marked
     * interrupted and never resumed: a half-done release gate must not carry on by itself. Returns the runs ended.
     */
    interruptStale(ownerNot: string, staleMs: number): RunbookRun[] {
        const cutoff = this.clock() - staleMs;
        const stale = this.db.all<Row>("SELECT * FROM runbook_runs WHERE status = 'running' AND owner != ? AND heartbeat_at <= ?", ownerNot, cutoff).map(toRun);
        const ended: RunbookRun[] = [];
        for (const run of stale) {
            if (this.finishRun(run.id, "interrupted", "The platform restarted while this run was going. It was not resumed; start it again if you still need it.")) {
                this.db.run("UPDATE runbook_run_steps SET status = 'stopped', reason = 'The run was interrupted here.', finished_at = ? WHERE run_id = ? AND status = 'running'", this.iso(), run.id);
                this.skipPending(run.id, "Not reached: the run was interrupted.");
                ended.push(run);
            }
        }
        return ended;
    }
}
