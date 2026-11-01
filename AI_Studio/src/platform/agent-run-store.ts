/**
 * Agent runs (migration slot 44; the tables are named objective_runs, as `agent_runs` holds the authoring agents' work): a person gives an objective, the AI pursues it in a real browser, and the run keeps what happened: every
 * step, every approval, the result. The work happens in a job of mode "agent" (agent-run.ts); these tables are its record.
 *
 * A step holds stand-ins, never a secret, and its text is scrubbed before it gets here. An approval row is the only way a waiting run goes on:
 * the job polls it, so a person's answer works whichever process serves the page.
 */
import { randomUUID } from "node:crypto";
import type { AgentVerdict, FailureCategory, ObjectiveLimits, StepStatus } from "../engine/agent/objective.js";
import type { HighImpactKind } from "../engine/agent/high-impact.js";
import type { Step } from "../engine/spec/schema.js";
import type { Row } from "./db.js";
import type { Sql } from "./sql.js";

export const AGENT_RUNS_MIGRATION = `
CREATE TABLE objective_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    success_criteria TEXT,
    environment TEXT,                     -- the project environment it ran on; null: the project's own address
    start_address TEXT NOT NULL,
    max_steps INTEGER NOT NULL,
    max_minutes INTEGER NOT NULL,
    max_tokens INTEGER NOT NULL,
    approval_seconds INTEGER NOT NULL,
    state TEXT NOT NULL,                  -- queued | running | waiting_approval | finished | stopped
    verdict TEXT,                         -- passed | failed | blocked | inconclusive
    reasoning TEXT,                       -- the agent's own words: a suggestion
    stop_reason TEXT,
    failure_category TEXT,                -- application | agent | environment | runner
    steps_taken INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    started_by_id TEXT,
    started_by_name TEXT NOT NULL,
    draft_test_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_objective_runs_project ON objective_runs(project_id, created_at);
CREATE INDEX idx_objective_runs_job ON objective_runs(job_id);
CREATE TABLE objective_run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES objective_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,                 -- done | failed | refused
    detail TEXT,
    url TEXT NOT NULL,
    step_json TEXT,                       -- the step, with stand-ins, when it worked: what a draft test is made from
    screenshot_id TEXT,                   -- the artifact holding the picture
    created_at TEXT NOT NULL,
    UNIQUE (run_id, seq)
);
CREATE TABLE objective_run_approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES objective_runs(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    kind TEXT NOT NULL,                   -- delete | pay | send | submit
    why TEXT NOT NULL,
    url TEXT NOT NULL,
    state TEXT NOT NULL,                  -- pending | approved | refused | timed_out | stopped
    expires_at TEXT NOT NULL,
    decided_by_id TEXT,
    decided_by_name TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_objective_run_approvals_run ON objective_run_approvals(run_id, state);
`;

export type AgentRunState = "queued" | "running" | "waiting_approval" | "finished" | "stopped";
export type ApprovalState = "pending" | "approved" | "refused" | "timed_out" | "stopped";

export interface AgentRun {
    id: string;
    projectId: string;
    jobId: string;
    objective: string;
    successCriteria: string | null;
    environment: string | null;
    startAddress: string;
    limits: { maxSteps: number; maxMinutes: number; budgetTokens: number; approvalSeconds: number };
    state: AgentRunState;
    verdict: AgentVerdict | null;
    reasoning: string | null;
    stopReason: string | null;
    failureCategory: FailureCategory | null;
    stepsTaken: number;
    /** Hidden from anyone without ai_studio.usage.view (auth/cost-hiding.ts, by these names). */
    inputTokens: number;
    outputTokens: number;
    startedBy: { id: string | null; name: string };
    draftTestId: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

export interface AgentRunStep {
    seq: number;
    tool: string;
    summary: string;
    status: StepStatus;
    detail: string | null;
    url: string;
    screenshotId: string | null;
    at: string;
}

export interface AgentApproval {
    id: string;
    runId: string;
    action: string;
    kind: HighImpactKind;
    why: string;
    url: string;
    state: ApprovalState;
    expiresAt: string;
    decidedBy: string | null;
    decidedAt: string | null;
    createdAt: string;
}

export const isActiveRun = (r: Pick<AgentRun, "state">): boolean => r.state === "queued" || r.state === "running" || r.state === "waiting_approval";

const now = () => new Date().toISOString();

const toRun = (r: Row): AgentRun => ({
    id: r.id,
    projectId: r.project_id,
    jobId: r.job_id,
    objective: r.objective,
    successCriteria: r.success_criteria ?? null,
    environment: r.environment ?? null,
    startAddress: r.start_address,
    limits: { maxSteps: Number(r.max_steps), maxMinutes: Number(r.max_minutes), budgetTokens: Number(r.max_tokens), approvalSeconds: Number(r.approval_seconds) },
    state: r.state,
    verdict: r.verdict ?? null,
    reasoning: r.reasoning ?? null,
    stopReason: r.stop_reason ?? null,
    failureCategory: r.failure_category ?? null,
    stepsTaken: Number(r.steps_taken),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    startedBy: { id: r.started_by_id ?? null, name: r.started_by_name },
    draftTestId: r.draft_test_id ?? null,
    createdAt: r.created_at,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
});

const toStep = (r: Row): AgentRunStep => ({ seq: Number(r.seq), tool: r.tool, summary: r.summary, status: r.status, detail: r.detail ?? null, url: r.url, screenshotId: r.screenshot_id ?? null, at: r.created_at });

const toApproval = (r: Row): AgentApproval => ({ id: r.id, runId: r.run_id, action: r.action, kind: r.kind, why: r.why, url: r.url, state: r.state, expiresAt: r.expires_at, decidedBy: r.decided_by_name ?? null, decidedAt: r.decided_at ?? null, createdAt: r.created_at });

export interface RunResult {
    state: "finished" | "stopped";
    verdict: AgentVerdict;
    reasoning?: string;
    stopReason?: string;
    failureCategory?: FailureCategory;
}

export class AgentRunStore {
    constructor(private readonly sql: Sql) {}

    async create(o: { projectId: string; objective: string; successCriteria?: string; environment?: string; startAddress: string; limits: ObjectiveLimits; startedBy: { id: string | null; name: string } }): Promise<AgentRun> {
        const id = randomUUID();
        const t = now();
        await this.sql.run(
            `INSERT INTO objective_runs (id, project_id, job_id, objective, success_criteria, environment, start_address, max_steps, max_minutes, max_tokens, approval_seconds, state, started_by_id, started_by_name, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id,
            o.projectId,
            "",
            o.objective,
            o.successCriteria ?? null,
            o.environment ?? null,
            o.startAddress,
            o.limits.maxSteps,
            o.limits.maxMinutes,
            o.limits.maxTokens,
            o.limits.approvalSeconds,
            "queued",
            o.startedBy.id,
            o.startedBy.name,
            t,
            t,
        );
        return (await this.get(id))!;
    }

    async get(id: string): Promise<AgentRun | undefined> {
        const r = await this.sql.get("SELECT * FROM objective_runs WHERE id = ?", id);
        return r ? toRun(r) : undefined;
    }

    async list(projectId: string, limit = 100): Promise<AgentRun[]> {
        return (await this.sql.all("SELECT * FROM objective_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", projectId, limit)).map(toRun);
    }

    async setJob(id: string, jobId: string): Promise<void> {
        await this.sql.run("UPDATE objective_runs SET job_id = ?, updated_at = ? WHERE id = ?", jobId, now(), id);
    }

    async remove(id: string): Promise<void> {
        await this.sql.run("DELETE FROM objective_runs WHERE id = ?", id);
    }

    async started(id: string): Promise<void> {
        const t = now();
        await this.sql.run("UPDATE objective_runs SET state = 'running', started_at = ?, updated_at = ? WHERE id = ?", t, t, id);
    }

    async addStep(runId: string, s: { seq: number; tool: string; summary: string; status: StepStatus; detail?: string; url: string; step?: Step; screenshotId?: string }): Promise<void> {
        await this.sql.tx(async (t) => {
            await t.run("INSERT INTO objective_run_steps (id, run_id, seq, tool, summary, status, detail, url, step_json, screenshot_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", randomUUID(), runId, s.seq, s.tool, s.summary, s.status, s.detail ?? null, s.url, s.step ? JSON.stringify(s.step) : null, s.screenshotId ?? null, now());
            await t.run("UPDATE objective_runs SET steps_taken = steps_taken + 1, updated_at = ? WHERE id = ?", now(), runId);
        });
    }

    async steps(runId: string): Promise<AgentRunStep[]> {
        return (await this.sql.all("SELECT * FROM objective_run_steps WHERE run_id = ? ORDER BY seq", runId)).map(toStep);
    }

    /** The steps that worked, in order: what a draft test is made from. */
    async workedSteps(runId: string): Promise<Step[]> {
        const rows = await this.sql.all<{ step_json: string }>("SELECT step_json FROM objective_run_steps WHERE run_id = ? AND step_json IS NOT NULL ORDER BY seq", runId);
        return rows.map((r) => JSON.parse(r.step_json) as Step);
    }

    async setTokens(id: string, used: { inputTokens: number; outputTokens: number }): Promise<void> {
        await this.sql.run("UPDATE objective_runs SET input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?", used.inputTokens, used.outputTokens, now(), id);
    }

    /** Writes the end of a run once: a run that has ended keeps its result. */
    async finish(id: string, r: RunResult): Promise<void> {
        const t = now();
        await this.sql.tx(async (tx) => {
            await tx.run("UPDATE objective_run_approvals SET state = 'stopped' WHERE run_id = ? AND state = 'pending'", id);
            await tx.run(
                "UPDATE objective_runs SET state = ?, verdict = ?, reasoning = ?, stop_reason = ?, failure_category = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state NOT IN ('finished', 'stopped')",
                r.state,
                r.verdict,
                r.reasoning || null,
                r.stopReason ?? null,
                r.failureCategory ?? null,
                t,
                t,
                id,
            );
        });
    }

    async setDraft(id: string, testId: string): Promise<void> {
        await this.sql.run("UPDATE objective_runs SET draft_test_id = ?, updated_at = ? WHERE id = ?", testId, now(), id);
    }

    /** Asks for a person's answer: the run shows as waiting until the approval is decided. */
    async openApproval(runId: string, a: { action: string; kind: HighImpactKind; why: string; url: string; seconds: number }): Promise<AgentApproval> {
        const id = randomUUID();
        const t = new Date();
        await this.sql.tx(async (tx) => {
            await tx.run("INSERT INTO objective_run_approvals (id, run_id, action, kind, why, url, state, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)", id, runId, a.action, a.kind, a.why, a.url, "pending", new Date(t.getTime() + a.seconds * 1000).toISOString(), t.toISOString());
            await tx.run("UPDATE objective_runs SET state = 'waiting_approval', updated_at = ? WHERE id = ? AND state = 'running'", now(), runId);
        });
        return (await this.approval(id))!;
    }

    async approval(id: string): Promise<AgentApproval | undefined> {
        const r = await this.sql.get("SELECT * FROM objective_run_approvals WHERE id = ?", id);
        return r ? toApproval(r) : undefined;
    }

    async approvals(runId: string): Promise<AgentApproval[]> {
        return (await this.sql.all("SELECT * FROM objective_run_approvals WHERE run_id = ? ORDER BY created_at", runId)).map(toApproval);
    }

    /** One answer only: whoever comes first (a person, the time limit, a stop) decides. False when it was already decided. */
    async decide(id: string, state: Exclude<ApprovalState, "pending">, by?: { id: string | null; name: string }): Promise<boolean> {
        const t = now();
        return this.sql.tx(async (tx) => {
            const r = await tx.run("UPDATE objective_run_approvals SET state = ?, decided_by_id = ?, decided_by_name = ?, decided_at = ? WHERE id = ? AND state = 'pending'", state, by?.id ?? null, by?.name ?? null, t, id);
            if (r.changes === 0) return false;
            const row = await tx.get<{ run_id: string }>("SELECT run_id FROM objective_run_approvals WHERE id = ?", id);
            await tx.run("UPDATE objective_runs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'waiting_approval'", t, row!.run_id);
            return true;
        });
    }
}
