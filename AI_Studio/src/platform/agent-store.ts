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

/**
 * Migration slot 42: runners are machines of an organisation (NULL: Crowd4Test's shared machines, or an install without organisations),
 * not of one project. Projects are given access to runners (runner_access); a project may use several and a runner may serve several.
 *
 * agent_tokens and agents are rebuilt so that `project_id` (now: the project a runner was registered from, if any) may be empty and a
 * runner outlives that project (ON DELETE SET NULL). Every row keeps its id and its token hash, so a runner installed before keeps
 * connecting with the token it has; each existing token joins its project's organisation and gets access to that project.
 *
 * device_reservations: a phone, emulator or simulator of a runner is held by one running task at a time, whichever project it is for.
 * `device` is a serial, an emulator ("avd:<name>"), a simulator name, or "*" (whichever the runner picks: it holds them all).
 */
export const RUNNER_SHARING_MIGRATION = `
CREATE TABLE agent_tokens_r42 (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,   -- the project it was registered from; NULL when registered on the Runners page
    organization_id TEXT REFERENCES organizations(id),           -- the owner; NULL: Crowd4Test (shared machines) or an install without organisations
    label TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT,
    last_used_at TEXT,
    last_used_ms INTEGER,
    revoked_at TEXT                                               -- retired: the token stops working at once
);
INSERT INTO agent_tokens_r42 (id, project_id, organization_id, label, token_hash, hint, created_at, last_used_at, last_used_ms, revoked_at)
    SELECT t.id, t.project_id, p.organization_id, t.label, t.token_hash, t.hint, t.created_at, t.last_used_at, t.last_used_ms, t.revoked_at
    FROM agent_tokens t LEFT JOIN projects p ON p.id = t.project_id;
CREATE TABLE agents_r42 (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    token_id TEXT NOT NULL REFERENCES agent_tokens_r42(id) ON DELETE CASCADE,
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
INSERT INTO agents_r42 (id, project_id, token_id, name, version, os, arch, node, capabilities_json, concurrency, first_seen_ms, last_seen_ms)
    SELECT id, project_id, token_id, name, version, os, arch, node, capabilities_json, concurrency, first_seen_ms, last_seen_ms FROM agents;
DROP TABLE agents;
DROP TABLE agent_tokens;
ALTER TABLE agent_tokens_r42 RENAME TO agent_tokens;
ALTER TABLE agents_r42 RENAME TO agents;
CREATE INDEX idx_agent_tokens_project ON agent_tokens(project_id);
CREATE INDEX idx_agent_tokens_org ON agent_tokens(organization_id);
CREATE INDEX idx_agents_project ON agents(project_id, last_seen_ms);
CREATE INDEX idx_agents_token ON agents(token_id);
CREATE TABLE runner_access (
    token_id TEXT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    granted_by TEXT,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (token_id, project_id)
);
CREATE INDEX idx_runner_access_project ON runner_access(project_id);
INSERT INTO runner_access (token_id, project_id, granted_by, granted_at)
    SELECT id, project_id, 'Registered from the project', created_at FROM agent_tokens WHERE project_id IS NOT NULL;
CREATE TABLE device_reservations (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    family TEXT NOT NULL,                 -- android | ios
    device TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    reserved_ms INTEGER NOT NULL,
    PRIMARY KEY (agent_id, family, device)
);
CREATE INDEX idx_device_reservations_task ON device_reservations(task_id);
`;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newAgentToken = (): string => AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");

/** An agent is online when it was seen this recently (it polls every ~25 s). */
export const ONLINE_MS = 45_000;

export interface AgentTokenRecord {
    id: string;
    /** The project the runner was registered from (it has access to it from the start); null when registered on the Runners page. */
    projectId: string | null;
    /** The owner: an organisation, or null for Crowd4Test's shared machines (and installs without organisations). */
    organizationId: string | null;
    label: string | null;
    hint: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
}

const toToken = (r: Record<string, any>): AgentTokenRecord => ({ id: r.id, projectId: r.project_id ?? null, organizationId: r.organization_id ?? null, label: r.label, hint: r.hint, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at });

export interface AgentRecord {
    id: string;
    /** The project its token was registered from, or null (see AgentTokenRecord.projectId). Which projects it serves is runner_access. */
    projectId: string | null;
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
    projectId: r.project_id ?? null,
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

/** The phone, emulator or simulator a task needs on its runner ("*": whichever the runner picks, so all of that kind). */
export interface DeviceNeed {
    family: "android" | "ios";
    device: string;
}

export interface HealthTask {
    id: string;
    projectId: string;
    adapterId: string;
    status: TaskStatus;
    agentId: string | null;
    error: string | null;
    done: number | null;
    total: number | null;
    createdMs: number;
    claimedMs: number | null;
    finishedMs: number | null;
}

export interface DeviceReservation extends DeviceNeed {
    agentId: string;
    taskId: string;
    projectId: string;
    reservedMs: number;
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
    createToken(projectId: string, label?: string, createdBy?: string): { secret: string; record: AgentTokenRecord } {
        const secret = newAgentToken();
        const id = randomUUID();
        const at = new Date(this.clock()).toISOString();
        this.db.tx(() => {
            // Registered from a project: it belongs to the project's organisation and may run that project's tests.
            const org = this.db.get<{ o: string | null }>("SELECT organization_id AS o FROM projects WHERE id = ?", projectId)?.o ?? null;
            this.db.run("INSERT INTO agent_tokens (id, project_id, organization_id, label, token_hash, hint, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)", id, projectId, org, label?.trim() || null, hashToken(secret), secret.slice(-4), at, createdBy ?? null);
            this.db.run("INSERT INTO runner_access (token_id, project_id, granted_by, granted_at) VALUES (?,?,?,?)", id, projectId, "Registered from the project", at);
        });
        return { secret, record: this.getToken(id)! };
    }

    /** A runner registered on the Runners page: it belongs to an organisation (or to Crowd4Test) and serves no project until given access. */
    createRunnerToken(o: { organizationId: string | null; label: string; createdBy: string }): { secret: string; record: AgentTokenRecord } {
        const secret = newAgentToken();
        const id = randomUUID();
        this.db.run("INSERT INTO agent_tokens (id, project_id, organization_id, label, token_hash, hint, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)", id, null, o.organizationId, o.label.trim() || null, hashToken(secret), secret.slice(-4), new Date(this.clock()).toISOString(), o.createdBy);
        return { secret, record: this.getToken(id)! };
    }

    getToken(id: string): AgentTokenRecord | undefined {
        const r = this.db.get("SELECT * FROM agent_tokens WHERE id = ?", id);
        return r ? toToken(r) : undefined;
    }

    /** The runners a project may use (its own and those it was given access to), retired ones included. */
    listTokens(projectId: string): AgentTokenRecord[] {
        return this.db
            .all(`SELECT t.* FROM agent_tokens t JOIN runner_access a ON a.token_id = t.id WHERE a.project_id = ? ORDER BY t.created_at DESC, ${this.db.dialect.insertionOrder("t")} DESC`, projectId)
            .map(toToken);
    }

    /** Every runner (registration), retired ones included: the Runners page narrows it to what a person may see. */
    allTokens(): AgentTokenRecord[] {
        return this.db.all(`SELECT * FROM agent_tokens ORDER BY created_at DESC, ${this.db.dialect.insertionOrder()} DESC`).map(toToken);
    }

    renameToken(id: string, label: string): boolean {
        return Number(this.db.run("UPDATE agent_tokens SET label = ? WHERE id = ? AND revoked_at IS NULL", label.trim() || null, id).changes) === 1;
    }

    /** Retire a runner: its token stops working at once, for every project. The rows stay (history, Activity). */
    retireToken(id: string): boolean {
        return Number(this.db.run("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", new Date(this.clock()).toISOString(), id).changes) === 1;
    }

    // ── which projects a runner serves ──────────────────────────────────────

    projectsOf(tokenId: string): Array<{ projectId: string; grantedBy: string | null; grantedAt: string }> {
        return this.db
            .all<{ project_id: string; granted_by: string | null; granted_at: string }>("SELECT project_id, granted_by, granted_at FROM runner_access WHERE token_id = ? ORDER BY granted_at", tokenId)
            .map((r) => ({ projectId: r.project_id, grantedBy: r.granted_by, grantedAt: r.granted_at }));
    }

    hasAccess(tokenId: string, projectId: string): boolean {
        return Boolean(this.db.get("SELECT 1 AS x FROM runner_access WHERE token_id = ? AND project_id = ?", tokenId, projectId));
    }

    /** Whether this agent (through its token) may run the project's tests. */
    agentServes(agentId: string, projectId: string): boolean {
        return Boolean(this.db.get("SELECT 1 AS x FROM agents g JOIN runner_access a ON a.token_id = g.token_id WHERE g.id = ? AND a.project_id = ?", agentId, projectId));
    }

    grantAccess(tokenId: string, projectId: string, grantedBy: string): boolean {
        if (this.hasAccess(tokenId, projectId)) return false;
        this.db.run("INSERT INTO runner_access (token_id, project_id, granted_by, granted_at) VALUES (?,?,?,?)", tokenId, projectId, grantedBy, new Date(this.clock()).toISOString());
        return true;
    }

    /** The project stops using the runner. A project that pinned it goes back to "any runner it may use". Queued work stays queued for others. */
    removeAccess(tokenId: string, projectId: string): boolean {
        return this.db.tx(() => {
            const n = Number(this.db.run("DELETE FROM runner_access WHERE token_id = ? AND project_id = ?", tokenId, projectId).changes);
            if (n === 1) this.db.run("UPDATE runner_settings SET agent_id = NULL WHERE project_id = ? AND agent_id IN (SELECT id FROM agents WHERE token_id = ?)", projectId, tokenId);
            return n === 1;
        });
    }

    /** Whether a token still works: a retired runner's open poll stops at once (routes/agents.ts). */
    tokenLive(id: string): boolean {
        return Boolean(this.db.get("SELECT 1 AS x FROM agent_tokens WHERE id = ? AND revoked_at IS NULL", id));
    }

    /** Runners of an organisation that still work (NULL: Crowd4Test's shared machines, or an install without organisations). */
    countLiveRunnersOf(organizationId: string | null): number {
        const r = organizationId === null ? this.db.get("SELECT COUNT(*) AS n FROM agent_tokens WHERE revoked_at IS NULL AND organization_id IS NULL") : this.db.get("SELECT COUNT(*) AS n FROM agent_tokens WHERE revoked_at IS NULL AND organization_id = ?", organizationId);
        return Number(r?.n ?? 0);
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

    /** The machines that connected with a token (one is online at a time). */
    agentsOfToken(tokenId: string): AgentRecord[] {
        return this.db.all("SELECT * FROM agents WHERE token_id = ? ORDER BY last_seen_ms DESC", tokenId).map(toAgent);
    }

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

    /** The agents a project may use (through runner_access), online first, then most recently seen. `activeTasks` counts every project's work on it. */
    listAgents(projectId: string): Array<AgentRecord & { online: boolean; activeTasks: number }> {
        const now = this.clock();
        const rows = this.db.all("SELECT g.* FROM agents g JOIN runner_access a ON a.token_id = g.token_id WHERE a.project_id = ?", projectId).map(toAgent);
        const counts = new Map(
            this.db
                .all<{ agent_id: string; n: number }>("SELECT agent_id, COUNT(*) AS n FROM agent_tasks WHERE status = 'running' AND agent_id IN (SELECT g.id FROM agents g JOIN runner_access a ON a.token_id = g.token_id WHERE a.project_id = ?) GROUP BY agent_id", projectId)
                .map((r) => [r.agent_id, Number(r.n)]),
        );
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

    /** Queued tasks of every project this token may serve, oldest first: the FIFO a shared runner picks from. */
    queuedFor(tokenId: string, limit = 50): TaskRecord[] {
        return this.db
            .all(
                `SELECT t.* FROM agent_tasks t JOIN runner_access a ON a.project_id = t.project_id AND a.token_id = ? JOIN agent_tokens k ON k.id = a.token_id AND k.revoked_at IS NULL WHERE t.status = 'queued' ORDER BY t.created_ms, ${this.db.dialect.insertionOrder("t")} LIMIT ?`,
                tokenId,
                limit,
            )
            .map(toTask);
    }

    /**
     * Take a queued task for an agent of a project its token may serve, holding the device it needs, in one transaction: of two claims
     * (or two tasks wanting the same phone, from any projects) exactly one wins; the other task stays queued.
     */
    claimFor(taskId: string, agent: { id: string; tokenId: string }, leaseMs: number, device?: DeviceNeed): TaskRecord | undefined {
        return this.db.tx(() => {
            this.releaseDevices();
            if (device && this.deviceHeld(agent.id, device)) return undefined;
            const now = this.clock();
            const r = this.db.get(
                "UPDATE agent_tasks SET status = 'running', agent_id = ?, claimed_ms = ?, lease_until = ?, last_beat_ms = ?, offers = offers + 1 WHERE id = ? AND status = 'queued' AND project_id IN (SELECT a.project_id FROM runner_access a JOIN agent_tokens k ON k.id = a.token_id AND k.revoked_at IS NULL WHERE a.token_id = ?) RETURNING *",
                agent.id, now, now + leaseMs, now, taskId, agent.tokenId,
            );
            if (!r) return undefined;
            if (device) this.db.run("INSERT INTO device_reservations (agent_id, family, device, task_id, project_id, reserved_ms) VALUES (?,?,?,?,?,?)", agent.id, device.family, device.device, taskId, r.project_id, now);
            return toTask(r);
        });
    }

    // ── device reservations ─────────────────────────────────────────────────

    /** Whether a running task holds this device of the agent (or all its devices of that kind, or this one wants them all). */
    deviceHeld(agentId: string, d: DeviceNeed): boolean {
        return Boolean(this.db.get("SELECT 1 AS x FROM device_reservations WHERE agent_id = ? AND family = ? AND (device = ? OR device = '*' OR ? = '*')", agentId, d.family, d.device, d.device));
    }

    /** A reservation ends with its task (finished, cancelled, back in the queue) or when its runner is lost (not seen for ONLINE_MS). */
    releaseDevices(): number {
        return Number(
            this.db.run(
                "DELETE FROM device_reservations WHERE task_id NOT IN (SELECT id FROM agent_tasks WHERE status = 'running') OR agent_id IN (SELECT id FROM agents WHERE last_seen_ms < ?)",
                this.clock() - ONLINE_MS,
            ).changes,
        );
    }

    reservations(agentIds?: string[]): DeviceReservation[] {
        const rows = this.db.all<Record<string, any>>("SELECT * FROM device_reservations ORDER BY reserved_ms");
        return rows
            .filter((r) => !agentIds || agentIds.includes(r.agent_id))
            .map((r) => ({ agentId: r.agent_id, family: r.family, device: r.device, taskId: r.task_id, projectId: r.project_id, reservedMs: r.reserved_ms }));
    }

    /** Running and queued work, and how the recent work went, for the runners' health (tasks are kept TASK_KEEP_MS). Never the payload or the result. */
    tasksForHealth(): HealthTask[] {
        return this.db
            .all<Record<string, any>>("SELECT id, project_id, adapter_id, status, agent_id, error, progress_done, progress_total, created_ms, claimed_ms, finished_ms FROM agent_tasks ORDER BY created_ms DESC")
            .map((r) => ({ id: r.id, projectId: r.project_id, adapterId: r.adapter_id, status: r.status, agentId: r.agent_id ?? null, error: r.error ?? null, done: r.progress_done ?? null, total: r.progress_total ?? null, createdMs: r.created_ms, claimedMs: r.claimed_ms ?? null, finishedMs: r.finished_ms ?? null }));
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
        const ok = Number(this.db.run("UPDATE agent_tasks SET status = ?, result_enc = ?, error = ?, finished_ms = ?, lease_until = NULL WHERE id = ? AND agent_id = ? AND status = 'running'", status, outcome.resultEnc ?? null, outcome.error ?? null, this.clock(), taskId, agentId).changes) === 1;
        if (ok) this.db.run("DELETE FROM device_reservations WHERE task_id = ?", taskId);
        return ok;
    }

    /** The platform gave the task up (job cancelled, no agent): queued ends now; a running one is stopped through the agent's next heartbeat. */
    requestCancel(taskId: string): void {
        this.db.run("UPDATE agent_tasks SET status = 'cancelled', finished_ms = ? WHERE id = ? AND status = 'queued'", this.clock(), taskId);
        this.db.run("UPDATE agent_tasks SET cancel_requested = 1 WHERE id = ? AND status = 'running'", taskId);
    }

    /** The executor stopped waiting for a task (failure on the platform side). */
    failQueuedOrRunning(taskId: string, error: string): void {
        this.db.run("UPDATE agent_tasks SET status = 'failed', error = ?, finished_ms = ?, lease_until = NULL WHERE id = ? AND status IN ('queued','running')", error, this.clock(), taskId);
        this.db.run("DELETE FROM device_reservations WHERE task_id = ?", taskId);
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
            this.releaseDevices();
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
