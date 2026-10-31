/**
 * Runner agents: the tables behind them (migration slot 19) and the store that reads and writes them.
 *
 *  agent_tokens   one credential per agent installation, belonging to exactly one project. Only the SHA-256 hash is kept
 *                 (a token is 32 random bytes, so there is nothing to guess); the hint is the last 4 characters.
 *  agents         the registry: what each connected agent said about itself, and when it was last seen.
 *  runner_settings where a project's tests run ("platform" or "agent"), kept here and not in `projects`.
 *  agent_tasks    the queue: one row per batch of scripts handed to an agent. The payload (it holds credentials) and the
 *                 result are encrypted with SecretBox; the plaintext never reaches the database.
 *  agent_task_files  files a task refers to: baselines/APK the agent downloads ("in"), artifacts it uploaded ("out").
 *
 * Every state change that two parties could race for (claiming a task, finishing it) is a single conditional UPDATE.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AGENT_TOKEN_PREFIX, type Capabilities } from "../agent-protocol/schema.js";
import type { Db } from "./db.js";

export const AGENTS_MIGRATION = `
CREATE TABLE agent_tokens (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT,
    token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the token; the token itself is never stored
    hint TEXT NOT NULL,                   -- last 4 characters, to tell tokens apart in a list
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    last_used_ms INTEGER,
    revoked_at TEXT
);
CREATE INDEX idx_agent_tokens_project ON agent_tokens(project_id);
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    token_id TEXT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    os TEXT NOT NULL,
    arch TEXT NOT NULL,
    node TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    concurrency INTEGER NOT NULL,
    first_seen_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL,
    UNIQUE (token_id, name)
);
CREATE INDEX idx_agents_project ON agents(project_id, last_seen_ms);
CREATE TABLE runner_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    run_on TEXT NOT NULL,                 -- platform | agent
    agent_id TEXT,                        -- a specific agent, or NULL = any agent of the project
    updated_at TEXT NOT NULL
);
CREATE TABLE agent_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    status TEXT NOT NULL,                 -- queued | running | done | failed | cancelled
    agent_id TEXT,                        -- the agent that claimed it; only that agent may touch it
    payload_enc TEXT NOT NULL,            -- SecretBox: the TaskOffer (scripts, environment, credentials)
    result_enc TEXT,                      -- SecretBox: the agent's result
    error TEXT,
    offers INTEGER NOT NULL DEFAULT 0,    -- how many times it was handed to an agent (2 = one re-offer used)
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    last_beat_ms INTEGER,
    progress_done INTEGER,
    progress_total INTEGER,
    log_json TEXT NOT NULL DEFAULT '[]',
    created_ms INTEGER NOT NULL,
    claimed_ms INTEGER,
    finished_ms INTEGER
);
CREATE INDEX idx_agent_tasks_queue ON agent_tasks(project_id, status, created_ms);
CREATE INDEX idx_agent_tasks_job ON agent_tasks(job_id);
CREATE TABLE agent_task_files (
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,              -- in | out
    ref TEXT NOT NULL,
    path TEXT NOT NULL,                   -- relative to the artifact store, built by the platform
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (task_id, direction, ref)
);
`;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newAgentToken = (): string => AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");

/** An agent is online when it was seen this recently (it polls every ~25 s). */
export const ONLINE_MS = 45_000;

export interface AgentTokenRecord {
    id: string;
    projectId: string;
    label: string | null;
    hint: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
}

const toToken = (r: Record<string, any>): AgentTokenRecord => ({ id: r.id, projectId: r.project_id, label: r.label, hint: r.hint, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at });

export interface AgentRecord {
    id: string;
    projectId: string;
    tokenId: string;
    name: string;
    version: string;
    os: string;
    arch: string;
    node: string;
    capabilities: Capabilities;
    concurrency: number;
    firstSeenMs: number;
    lastSeenMs: number;
}

const toAgent = (r: Record<string, any>): AgentRecord => ({
    id: r.id,
    projectId: r.project_id,
    tokenId: r.token_id,
    name: r.name,
    version: r.version,
    os: r.os,
    arch: r.arch,
    node: r.node,
    capabilities: JSON.parse(r.capabilities_json),
    concurrency: r.concurrency,
    firstSeenMs: r.first_seen_ms,
    lastSeenMs: r.last_seen_ms,
});

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export const FINAL_TASK_STATUSES: TaskStatus[] = ["done", "failed", "cancelled"];

export interface TaskRecord {
    id: string;
    projectId: string;
    jobId: string;
    adapterId: string;
    status: TaskStatus;
    agentId: string | null;
    payloadEnc: string;
    resultEnc: string | null;
    error: string | null;
    offers: number;
    cancelRequested: boolean;
    leaseUntil: number | null;
    progress: { done: number | null; total: number | null };
    log: string[];
    createdMs: number;
    claimedMs: number | null;
    finishedMs: number | null;
}

const toTask = (r: Record<string, any>): TaskRecord => ({
    id: r.id,
    projectId: r.project_id,
    jobId: r.job_id,
    adapterId: r.adapter_id,
    status: r.status,
    agentId: r.agent_id,
    payloadEnc: r.payload_enc,
    resultEnc: r.result_enc,
    error: r.error,
    offers: r.offers,
    cancelRequested: Boolean(r.cancel_requested),
    leaseUntil: r.lease_until,
    progress: { done: r.progress_done, total: r.progress_total },
    log: JSON.parse(r.log_json),
    createdMs: r.created_ms,
    claimedMs: r.claimed_ms,
    finishedMs: r.finished_ms,
});

export interface TaskFile {
    taskId: string;
    direction: "in" | "out";
    ref: string;
    path: string;
    size: number;
    sha256: string;
}

export interface RunnerSetting {
    runOn: "platform" | "agent";
    agentId: string | null;
}

/** A task is handed out at most this many times: the first claim plus one re-offer. */
export const MAX_OFFERS = 2;
/** A task nobody picked up in this long fails with a plain message. */
export const QUEUE_MAX_MS = 30 * 60_000;
/** Finished tasks, their payloads and files are removed after this long. */
export const TASK_KEEP_MS = 24 * 60 * 60_000;
/** Agents not seen for this long are forgotten. */
export const AGENT_KEEP_MS = 30 * 24 * 60 * 60_000;
const LOG_KEEP = 200;

const TERMINAL_JOB_SQL = "('COMPLETED','PARTIALLY_COMPLETED','FAILED')";

export class AgentStore {
    constructor(
        private readonly db: Db,
        private readonly clock: () => number = Date.now,
    ) {}

    // ── tokens ──────────────────────────────────────────────────────────────

    /** The only moment the plaintext token exists on the server side: it is returned here and never kept. */
    createToken(projectId: string, label?: string): { secret: string; record: AgentTokenRecord } {
        const secret = newAgentToken();
        const id = randomUUID();
        this.db.run("INSERT INTO agent_tokens (id, project_id, label, token_hash, hint, created_at) VALUES (?,?,?,?,?,?)", id, projectId, label?.trim() || null, hashToken(secret), secret.slice(-4), new Date(this.clock()).toISOString());
        return { secret, record: this.getToken(id)! };
    }

    getToken(id: string): AgentTokenRecord | undefined {
        const r = this.db.get("SELECT * FROM agent_tokens WHERE id = ?", id);
        return r ? toToken(r) : undefined;
    }

    listTokens(projectId: string): AgentTokenRecord[] {
        return this.db.all(`SELECT * FROM agent_tokens WHERE project_id = ? ORDER BY created_at DESC, ${this.db.dialect.insertionOrder()} DESC`, projectId).map(toToken);
    }

    /** Tokens of the project that still work (the runner kit download refuses to make more past a limit). */
    countActiveTokens(projectId: string): number {
        return Number(this.db.get("SELECT COUNT(*) AS n FROM agent_tokens WHERE project_id = ? AND revoked_at IS NULL", projectId)?.n ?? 0);
    }

    /** Revoking keeps the row; the token stops working at once. */
    revokeToken(projectId: string, id: string): boolean {
        return Number(this.db.run("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL", new Date(this.clock()).toISOString(), id, projectId).changes) === 1;
    }

    /** The live token for a presented one, or undefined (unknown and revoked look the same). Hash compared in constant time. */
    findToken(presented: string): AgentTokenRecord | undefined {
        const hash = hashToken(presented);
        const r = this.db.get("SELECT * FROM agent_tokens WHERE token_hash = ?", hash);
        if (!r) return undefined;
        const a = Buffer.from(hash, "hex");
        const b = Buffer.from(String(r.token_hash), "hex");
        if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
        return r.revoked_at ? undefined : toToken(r);
    }

    /** At most one write per token per 30 s: a polling agent must not turn every request into a database write. */
    touchToken(id: string): void {
        const now = this.clock();
        this.db.run("UPDATE agent_tokens SET last_used_ms = ?, last_used_at = ? WHERE id = ? AND (last_used_ms IS NULL OR last_used_ms < ?)", now, new Date(now).toISOString(), id, now - 30_000);
    }

    // ── agents ──────────────────────────────────────────────────────────────

    /** `hello`: creates the agent the token + name stand for, or refreshes it. */
    upsertAgent(token: AgentTokenRecord, hello: { name: string; version: string; capabilities: Capabilities; concurrency: number }): AgentRecord {
        const now = this.clock();
        const caps = JSON.stringify(hello.capabilities);
        const existing = this.db.get<{ id: string }>("SELECT id FROM agents WHERE token_id = ? AND name = ?", token.id, hello.name);
        if (existing) {
            this.db.run("UPDATE agents SET version = ?, os = ?, arch = ?, node = ?, capabilities_json = ?, concurrency = ?, last_seen_ms = ? WHERE id = ?", hello.version, hello.capabilities.os, hello.capabilities.arch, hello.capabilities.node, caps, hello.concurrency, now, existing.id);
            return this.getAgent(existing.id)!;
        }
        const id = randomUUID();
        this.db.run("INSERT INTO agents (id, project_id, token_id, name, version, os, arch, node, capabilities_json, concurrency, first_seen_ms, last_seen_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", id, token.projectId, token.id, hello.name, hello.version, hello.capabilities.os, hello.capabilities.arch, hello.capabilities.node, caps, hello.concurrency, now, now);
        return this.getAgent(id)!;
    }

    getAgent(id: string): AgentRecord | undefined {
        const r = this.db.get("SELECT * FROM agents WHERE id = ?", id);
        return r ? toAgent(r) : undefined;
    }

    /** Liveness (poll, heartbeat), and fresh capabilities when the agent sent them. */
    touchAgent(id: string, capabilities?: Capabilities): void {
        if (capabilities) this.db.run("UPDATE agents SET last_seen_ms = ?, capabilities_json = ? WHERE id = ?", this.clock(), JSON.stringify(capabilities), id);
        else this.db.run("UPDATE agents SET last_seen_ms = ? WHERE id = ?", this.clock(), id);
    }

    /** Online first, then most recently seen. */
    listAgents(projectId: string): Array<AgentRecord & { online: boolean; activeTasks: number }> {
        const now = this.clock();
        const rows = this.db.all("SELECT * FROM agents WHERE project_id = ?", projectId).map(toAgent);
        const counts = new Map(this.db.all<{ agent_id: string; n: number }>("SELECT agent_id, COUNT(*) AS n FROM agent_tasks WHERE project_id = ? AND status = 'running' GROUP BY agent_id", projectId).map((r) => [r.agent_id, Number(r.n)]));
        return rows
            .map((a) => ({ ...a, online: now - a.lastSeenMs <= ONLINE_MS, activeTasks: counts.get(a.id) ?? 0 }))
            .sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeenMs - a.lastSeenMs);
    }

    runningCount(agentId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks WHERE agent_id = ? AND status = 'running'", agentId)?.n ?? 0);
    }

    // ── where a project's tests run ─────────────────────────────────────────

    getRunner(projectId: string): RunnerSetting {
        const r = this.db.get<{ run_on: string; agent_id: string | null }>("SELECT run_on, agent_id FROM runner_settings WHERE project_id = ?", projectId);
        return r ? { runOn: r.run_on === "agent" ? "agent" : "platform", agentId: r.agent_id } : { runOn: "platform", agentId: null };
    }

    setRunner(projectId: string, s: RunnerSetting): void {
        this.db.run(
            "INSERT INTO runner_settings (project_id, run_on, agent_id, updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET run_on = excluded.run_on, agent_id = excluded.agent_id, updated_at = excluded.updated_at",
            projectId,
            s.runOn,
            s.runOn === "agent" ? s.agentId : null,
            new Date(this.clock()).toISOString(),
        );
    }

    // ── tasks ───────────────────────────────────────────────────────────────

    enqueue(t: { id: string; projectId: string; jobId: string; adapterId: string; payloadEnc: string; files: Array<Omit<TaskFile, "taskId">> }): void {
        this.db.tx(() => {
            this.db.run("INSERT INTO agent_tasks (id, project_id, job_id, adapter_id, status, payload_enc, created_ms) VALUES (?,?,?,?,?,?,?)", t.id, t.projectId, t.jobId, t.adapterId, "queued", t.payloadEnc, this.clock());
            for (const f of t.files) this.addFile({ ...f, taskId: t.id });
        });
    }

    getTask(id: string): TaskRecord | undefined {
        const r = this.db.get("SELECT * FROM agent_tasks WHERE id = ?", id);
        return r ? toTask(r) : undefined;
    }

    tasksOfJob(jobId: string): TaskRecord[] {
        return this.db.all(`SELECT * FROM agent_tasks WHERE job_id = ? ORDER BY created_ms, ${this.db.dialect.insertionOrder()}`, jobId).map(toTask);
    }

    /** Queued tasks of a project, oldest first: the FIFO an agent picks from. */
    queued(projectId: string, limit = 25): TaskRecord[] {
        return this.db.all(`SELECT * FROM agent_tasks WHERE project_id = ? AND status = 'queued' ORDER BY created_ms, ${this.db.dialect.insertionOrder()} LIMIT ?`, projectId, limit).map(toTask);
    }

    /** Take a queued task for an agent. Atomic: of two simultaneous claims exactly one gets the row. */
    claim(taskId: string, agentId: string, leaseMs: number): TaskRecord | undefined {
        const now = this.clock();
        const r = this.db.get("UPDATE agent_tasks SET status = 'running', agent_id = ?, claimed_ms = ?, lease_until = ?, last_beat_ms = ?, offers = offers + 1 WHERE id = ? AND status = 'queued' RETURNING *", agentId, now, now + leaseMs, now, taskId);
        return r ? toTask(r) : undefined;
    }

    /** Extend the lease and record progress. False unless this agent holds the running task. */
    heartbeat(taskId: string, agentId: string, leaseMs: number, beat: { done?: number; total?: number; log?: string[] }): boolean {
        return this.db.tx(() => {
            const now = this.clock();
            const cur = this.db.get<{ log_json: string }>("SELECT log_json FROM agent_tasks WHERE id = ? AND agent_id = ? AND status = 'running'", taskId, agentId);
            if (!cur) return false;
            const log = [...(JSON.parse(cur.log_json) as string[]), ...(beat.log ?? [])].slice(-LOG_KEEP);
            this.db.run("UPDATE agent_tasks SET lease_until = ?, last_beat_ms = ?, progress_done = COALESCE(?, progress_done), progress_total = COALESCE(?, progress_total), log_json = ? WHERE id = ?", now + leaseMs, now, beat.done ?? null, beat.total ?? null, JSON.stringify(log), taskId);
            return true;
        });
    }

    /** Record the agent's result. Accepted once, and only from the claiming agent. */
    finish(taskId: string, agentId: string, outcome: { status: "done" | "failed"; resultEnc?: string; error?: string }): boolean {
        const task = this.getTask(taskId);
        const status: TaskStatus = task?.cancelRequested ? "cancelled" : outcome.status;
        return Number(this.db.run("UPDATE agent_tasks SET status = ?, result_enc = ?, error = ?, finished_ms = ?, lease_until = NULL WHERE id = ? AND agent_id = ? AND status = 'running'", status, outcome.resultEnc ?? null, outcome.error ?? null, this.clock(), taskId, agentId).changes) === 1;
    }

    /** The platform gave the task up (job cancelled, no agent): queued ends now; a running one is stopped through the agent's next heartbeat. */
    requestCancel(taskId: string): void {
        this.db.run("UPDATE agent_tasks SET status = 'cancelled', finished_ms = ? WHERE id = ? AND status = 'queued'", this.clock(), taskId);
        this.db.run("UPDATE agent_tasks SET cancel_requested = 1 WHERE id = ? AND status = 'running'", taskId);
    }

    /** The executor stopped waiting for a task (failure on the platform side). */
    failQueuedOrRunning(taskId: string, error: string): void {
        this.db.run("UPDATE agent_tasks SET status = 'failed', error = ?, finished_ms = ?, lease_until = NULL WHERE id = ? AND status IN ('queued','running')", error, this.clock(), taskId);
    }

    /**
     * Housekeeping that is safe to run from anywhere, any number of times:
     *  - a running task with no heartbeat past its lease goes back to the queue once; after that it fails;
     *  - a task nobody picked up for 30 minutes fails;
     *  - a task whose job is over (cancelled, or the worker is gone) is cancelled.
     */
    sweep(): { requeued: number; failed: number; cancelled: number } {
        const now = this.clock();
        const n = (sql: string, ...p: any[]) => Number(this.db.run(sql, ...p).changes);
        return this.db.tx(() => {
            const cancelledLost = n("UPDATE agent_tasks SET status = 'cancelled', finished_ms = ?, lease_until = NULL WHERE status = 'running' AND lease_until < ? AND cancel_requested = 1", now, now);
            // A record task is never re-offered: a recording cannot move to another computer (adapter_id "record:<agentId>"); the same holds for a phone session ("device:<agentId>").
            const requeued = n("UPDATE agent_tasks SET status = 'queued', agent_id = NULL, lease_until = NULL WHERE status = 'running' AND lease_until < ? AND offers < ? AND adapter_id NOT LIKE 'record:%' AND adapter_id NOT LIKE 'device:%'", now, MAX_OFFERS);
            const lost = n("UPDATE agent_tasks SET status = 'failed', error = 'The runner agent stopped responding while it was running these tests.', finished_ms = ?, lease_until = NULL WHERE status = 'running' AND lease_until < ? AND (offers >= ? OR adapter_id LIKE 'record:%' OR adapter_id LIKE 'device:%')", now, now, MAX_OFFERS);
            const stale = n("UPDATE agent_tasks SET status = 'failed', error = 'No runner agent picked up this run within 30 minutes.', finished_ms = ? WHERE status = 'queued' AND created_ms < ?", now, now - QUEUE_MAX_MS);
            const orphaned = n(`UPDATE agent_tasks SET status = 'cancelled', finished_ms = ?, lease_until = NULL WHERE status IN ('queued','running') AND job_id IN (SELECT id FROM generation_jobs WHERE status IN ${TERMINAL_JOB_SQL})`, now);
            return { requeued, failed: lost + stale, cancelled: cancelledLost + orphaned };
        });
    }

    /** Finished tasks older than the retention are returned (the caller removes their files) and deleted; agents long gone are forgotten. */
    pruneTasks(): TaskRecord[] {
        const cutoff = this.clock() - TASK_KEEP_MS;
        const old = this.db.all("SELECT * FROM agent_tasks WHERE status IN ('done','failed','cancelled') AND finished_ms < ?", cutoff).map(toTask);
        for (const t of old) this.db.run("DELETE FROM agent_tasks WHERE id = ?", t.id);
        return old;
    }

    pruneAgents(): number {
        return Number(this.db.run("DELETE FROM agents WHERE last_seen_ms < ?", this.clock() - AGENT_KEEP_MS).changes);
    }

    // ── files ───────────────────────────────────────────────────────────────

    addFile(f: TaskFile): void {
        this.db.run(
            "INSERT INTO agent_task_files (task_id, direction, ref, path, size, sha256) VALUES (?,?,?,?,?,?) ON CONFLICT (task_id, direction, ref) DO UPDATE SET path = excluded.path, size = excluded.size, sha256 = excluded.sha256",
            f.taskId, f.direction, f.ref, f.path, f.size, f.sha256,
        );
    }

    getFile(taskId: string, direction: "in" | "out", ref: string): TaskFile | undefined {
        const r = this.db.get<Record<string, any>>("SELECT * FROM agent_task_files WHERE task_id = ? AND direction = ? AND ref = ?", taskId, direction, ref);
        return r ? { taskId: r.task_id, direction: r.direction, ref: r.ref, path: r.path, size: r.size, sha256: r.sha256 } : undefined;
    }

    filesOf(taskId: string, direction: "in" | "out"): TaskFile[] {
        return this.db.all<Record<string, any>>("SELECT * FROM agent_task_files WHERE task_id = ? AND direction = ?", taskId, direction).map((r) => ({ taskId: r.task_id, direction: r.direction, ref: r.ref, path: r.path, size: r.size, sha256: r.sha256 }));
    }

    uploadedTotals(taskId: string): { count: number; bytes: number } {
        const r = this.db.get<{ n: number; b: number | null }>("SELECT COUNT(*) AS n, SUM(size) AS b FROM agent_task_files WHERE task_id = ? AND direction = 'out'", taskId);
        return { count: Number(r?.n ?? 0), bytes: Number(r?.b ?? 0) };
    }
}
