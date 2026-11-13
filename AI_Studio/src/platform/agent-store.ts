/**
 * Runner agents: the tables behind them (migration slots 19, 42, 51, 53, rebuilt by 57) and the store that reads and writes them.
 *
 *  agent_tokens   runner credentials: at most one per person (owner_id is unique). Only the SHA-256 hash is kept (a token is 32 random
 *                 bytes, so there is nothing to guess); the hint is the last 4 characters. Removing a runner deletes its row.
 *  agents         the registry: what the computer that connected with a credential said about itself, and when it was last seen.
 *  runner_settings where a project's tests run ("platform" or "agent"), kept here and not in `projects`.
 *  agent_tasks    the queue: one row per batch of scripts handed to an agent. The payload (it holds credentials) and the
 *                 result are encrypted with SecretBox; the plaintext never reaches the database.
 *  agent_task_files  files a task refers to: baselines/APK the agent downloads ("in"), artifacts it uploaded ("out").
 *
 * Every state change that two parties could race for (claiming a task, finishing it) is a single conditional UPDATE.
 *
 * Migration 57 removed every runner made before it (team, shared, project and personal alike) and rebuilt the tables without the team-era
 * columns: everyone downloads the new runner from Settings, Your runner.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AGENT_TOKEN_PREFIX, ENROLLMENT_CODE_PREFIX, FINAL_TASK_PHASES, type AgentPhase, type Capabilities, type TaskPhase } from "../agent-protocol/schema.js";
import type { Db } from "./db.js";
import { ROLE_PERMISSIONS } from "./auth/permissions.js";

/** Does a role of this server include running tests? (Unknown values: no.) */
const runsTests = (role: string | null | undefined): boolean => (role === "owner" || role === "editor" || role === "viewer" ? ROLE_PERMISSIONS[role].has("ai_studio.tests.run") : false);

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

/**
 * Migration slot 51: personal and team runners, enrollment codes, the owner's switches, the project's "allow people's own computers".
 *
 *  agent_tokens.kind                 "team" (every existing row: a machine of an organisation or Crowd4Test's shared one, as before) or
 *                                    "personal" (one person's own computer: it takes only runs that person starts, see agent-services.ts).
 *  agent_tokens.owner_id             the person a personal runner belongs to (a users.id); NULL for team runners.
 *  agent_tokens.allow_code_scripts   1: code scripts (hand-written, imported, Git) may go to it. Personal runners start with 1, team runners with
 *                                    0, which is today's rule (only an agent started with --allow-custom-scripts, never a shared one).
 *  agent_tokens.allow_private_targets 1: runs against localhost, LAN and link-local addresses may go to it. Team runners keep 1 (today's
 *                                    behaviour); personal runners start with 0 and their owner may switch it on.
 *  agent_tokens.machine_id           the install id of the computer that first used the credential; another computer is refused. NULL for
 *                                    every existing row until a runner that sends one connects.
 *  agent_tokens.rotated_at, previous_hash, previous_until_ms   rotation: the credential before the latest rotation keeps working until the
 *                                    new one is first used, at most 24 h.
 *  agent_tokens.allow_real_phone     1: phone sessions and phone tests may use a real phone plugged into it (personal runners: their owner's
 *                                    switch, off by default, so only emulators; read by the record and phone-session branches).
 *  agents.os_version, agents.machine_id   what the machine said about itself (NULL for older runners).
 *  agent_tasks.owner_id              the person whose run the task is (who started the job, or made its schedule), set when it is queued;
 *                                    a personal runner claims only its owner's tasks, checked in the claim itself. NULL for existing rows.
 *  runner_settings.allow_personal    1 (the default, also for a project with no row): people's own computers may run its tests.
 *  runner_enrollments                single-use enrollment codes (aite_...), kept as a SHA-256 hash, valid 30 minutes, traded once for a credential.
 */
export const PERSONAL_RUNNERS_MIGRATION = `
ALTER TABLE agent_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'team';
ALTER TABLE agent_tokens ADD COLUMN owner_id TEXT;
ALTER TABLE agent_tokens ADD COLUMN allow_code_scripts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_tokens ADD COLUMN allow_private_targets INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_tokens ADD COLUMN machine_id TEXT;
ALTER TABLE agent_tokens ADD COLUMN rotated_at TEXT;
ALTER TABLE agent_tokens ADD COLUMN previous_hash TEXT;
ALTER TABLE agent_tokens ADD COLUMN previous_until_ms INTEGER;
CREATE INDEX idx_agent_tokens_owner ON agent_tokens(owner_id);
CREATE INDEX idx_agent_tokens_previous ON agent_tokens(previous_hash);
ALTER TABLE agent_tokens ADD COLUMN allow_real_phone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN os_version TEXT;
ALTER TABLE agents ADD COLUMN machine_id TEXT;
ALTER TABLE agent_tasks ADD COLUMN owner_id TEXT;
CREATE INDEX idx_agent_tasks_owner ON agent_tasks(owner_id, status);
ALTER TABLE runner_settings ADD COLUMN allow_personal INTEGER NOT NULL DEFAULT 1;
CREATE TABLE runner_enrollments (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,       -- SHA-256 of the code; the code itself is never stored
    hint TEXT NOT NULL,                   -- last 4 characters
    kind TEXT NOT NULL,                   -- personal | team
    owner_id TEXT,                        -- personal: the person whose computer it is
    organization_id TEXT,                 -- team: the owner organisation (NULL: Crowd4Test's shared machines)
    project_id TEXT,                      -- team: the project it was made from (the runner is "registered from" it), if any
    project_ids_json TEXT NOT NULL DEFAULT '[]',  -- team: the projects the runner gets access to
    label TEXT,
    created_by TEXT,
    created_by_id TEXT,
    created_at TEXT NOT NULL,
    expires_ms INTEGER NOT NULL,
    used_ms INTEGER,
    token_id TEXT
);
CREATE INDEX idx_runner_enrollments_creator ON runner_enrollments(created_by_id);
`;

/**
 * The person a job belongs to, whose runner takes it (round 45: every run is on its owner's own computer): who started it (a person, or
 * their own API token), the creator of the schedule or deploy trigger that did, or the open server (OPEN_OWNER_ID). Else null: the server's
 * shared access key, or a schedule or trigger with no recorded creator.
 */
export function jobOwnerId(options: { startedBy?: unknown }): string | null {
    const s = options.startedBy as { kind?: string; id?: string | null; ownerId?: string | null } | undefined;
    if (!s || typeof s !== "object") return null;
    if (s.kind === "user") return typeof s.id === "string" ? s.id : null;
    if (s.kind === "open") return OPEN_OWNER_ID;
    if (s.kind === "schedule" || s.kind === "trigger") return typeof s.ownerId === "string" ? s.ownerId : null;
    return null;
}

/** The owner a person acting now stands for: a person (session or own API token) by their id, the open server as OPEN_OWNER_ID; else null. */
export function ownerIdOfActor(actor: { kind: string; id?: string | undefined }): string | null {
    if (actor.kind === "user") return actor.id ? actor.id : null;
    if (actor.kind === "open") return OPEN_OWNER_ID;
    return null;
}

/** The owner of everything done on a server in open mode (no accounts): the open server acts as one person. */
export const OPEN_OWNER_ID = "open";

/** Enrollment codes: what the website makes, the agent trades once for its credential (POST /api/agent/enroll). */
export { ENROLLMENT_CODE_PREFIX };
export const ENROLLMENT_TTL_MS = 30 * 60_000;
export const newEnrollmentCode = (): string => ENROLLMENT_CODE_PREFIX + randomBytes(32).toString("base64url");
/** The credential before a rotation keeps working until the new one is first used, at most this long. */
export const ROTATION_GRACE_MS = 24 * 60 * 60_000;
/** A credential older than this is asked to rotate (the hello answer says `rotate: true`). */
export const ROTATE_AFTER_MS = 30 * 24 * 60 * 60_000;

export interface EnrollmentRecord {
    id: string;
    hint: string;
    /** The person whose computer the code sets up. */
    ownerId: string;
    label: string | null;
    createdBy: string | null;
    createdAt: string;
    expiresMs: number;
    usedMs: number | null;
    tokenId: string | null;
}

const toEnrollment = (r: Record<string, any>): EnrollmentRecord => ({ id: r.id, hint: r.hint, ownerId: r.owner_id, label: r.label ?? null, createdBy: r.created_by ?? null, createdAt: r.created_at, expiresMs: Number(r.expires_ms), usedMs: r.used_ms ?? null, tokenId: r.token_id ?? null });

export type RedeemOutcome = { ok: true; secret: string; token: AgentTokenRecord; enrollment: EnrollmentRecord; again?: true; replaced?: boolean } | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Migration slot 53: a runner task's phases and attempts, and its live events (protocol 2; docs/features/runner-protocol-2.md).
 *
 *  agent_tasks.phase        what the task is doing, written only by the platform (TASK_PHASES in agent-protocol/schema.ts). Existing rows
 *                           get it from their status: queued, running, completed, failed or cancelled.
 *  agent_tasks.attempt      how many times it was handed out (existing rows: their offers); attempt_id is the current hand-out's random id
 *                           (stored for every hand-out, protocol 1 included, though a protocol-1 agent never sends it back; NULL only
 *                           for rows that existed before this migration).
 *  agent_tasks.accepted_ms  when the runner accepted the current attempt (protocol 1: the claim itself).
 *  agent_tasks.rejections_json  the runners that said no to this task, with their reason ('[]' for existing rows).
 *  agent_tasks.result_attempt_id  the attempt whose result was stored, so the same result posted again is answered 200, not 409.
 *  agents.protocol          the protocol the runner speaks (every existing runner: 1, until it says hello again).
 *  generation_jobs.ran_on_json  where the job's scripts ran (runner, attempt, final phase): kept with the job, so it outlives the 24 h task prune.
 *  agent_task_events        one row per live event received, so a batch sent twice is stored once; removed with its task.
 */
export const RUNNER_LIFECYCLE_MIGRATION = `
ALTER TABLE agent_tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE agent_tasks ADD COLUMN phase_ms INTEGER;
ALTER TABLE agent_tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN attempt_id TEXT;
ALTER TABLE agent_tasks ADD COLUMN accepted_ms INTEGER;
ALTER TABLE agent_tasks ADD COLUMN rejections_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_tasks ADD COLUMN result_attempt_id TEXT;
UPDATE agent_tasks SET attempt = offers, accepted_ms = claimed_ms, phase_ms = COALESCE(finished_ms, claimed_ms, created_ms),
    phase = CASE status WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running' WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END;
ALTER TABLE agents ADD COLUMN protocol INTEGER NOT NULL DEFAULT 1;
ALTER TABLE generation_jobs ADD COLUMN ran_on_json TEXT;
CREATE TABLE agent_task_events (
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    received_ms INTEGER NOT NULL,
    PRIMARY KEY (task_id, attempt_id, seq)
);
`;

/** What a run that was on a runner removed by migration 57 says (its task ends with it). */
export const RUNNER_REMOVED_IN_UPDATE = "The runner this run was on was removed in an update. Download the new runner in Settings, Your runner, then start the run again.";

/** Now in epoch milliseconds, in SQLite (migration 57 runs as plain SQL). */
const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
/** 10 seconds apart or less, as the owner attribution below reads Activity (same rule as before, when it ran at every start). */
const near = (a: string, b: string): string => `abs(julianday(${a}) - julianday(${b})) * 86400000 <= 10000`;
/** An Activity row's person as a runner owner: a person by their id, the open server as OPEN_OWNER_ID ("open"), anyone else nobody. */
const actorOwner = (row: string): string => `CASE ${row}.actor_kind WHEN 'user' THEN ${row}.actor_id WHEN 'open' THEN 'open' END`;
/** Only an owner that exists: the open server, or a person still on this server. */
const knownOwner = (expr: string): string => `(SELECT x.id FROM (SELECT 'open' AS id UNION ALL SELECT id FROM users) x WHERE x.id = ${expr} LIMIT 1)`;

/**
 * Migration slot 57: every runner made before it is removed, and the runner tables are rebuilt without the team-era columns
 * (docs/runner-implementation/RUNNER_ARCHITECTURE.md, "The runner reset"). Everyone downloads the new runner from Settings, Your runner.
 *
 *  - A task claimed by or running on a removed runner (and a recording or phone session queued for one: only that computer could take it)
 *    ends as failed with RUNNER_REMOVED_IN_UPDATE, and its run gets the same sentence as an event. A queued task nobody claimed stays queued:
 *    it waits for its owner's new runner under the usual 30-minute rule.
 *  - A run that names no runner yet gets a snapshot of where it ran (generation_jobs.ran_on_json), so its history still names the runner.
 *  - Deleted: every credential, runner, enrollment code, device reservation and per-runner update setting; runner_access is dropped.
 *  - Rebuilt: agent_tokens (one per person: owner_id unique; no project, organisation, kind or revoked state: removing a runner deletes it),
 *    agents (no project), runner_enrollments (a person's code only), runner_settings (no runner pin, no "allow people's own computers"),
 *    runner_update_settings (no "update automatically").
 *  - Schedules and deploy trigger tokens with no recorded creator get one from Activity where that is certain, once (it ran at every
 *    start before): a schedule's latest successful change by a person names them (a change by anyone else: not certain); without one, the
 *    one successful create in its project within 10 seconds of it, by a person, when no other one of the project was made in that window.
 *    Everything else stays without an owner and is refused at its next run with a sentence.
 *
 * SQLite only (julianday, json_object): a PostgreSQL database starts from pg/baseline.sql, which already has this schema.
 */
/** Migration slot 60: agent_tokens.show_browser 1: explorations on that runner open a visible browser window (its owner's switch, off by default). */
export const RUNNER_SHOW_BROWSER_MIGRATION = `ALTER TABLE agent_tokens ADD COLUMN show_browser INTEGER NOT NULL DEFAULT 0;`;

export const RUNNER_RESET_MIGRATION = `
UPDATE agent_tasks SET status = 'failed', error = '${RUNNER_REMOVED_IN_UPDATE}', finished_ms = ${NOW_MS_SQL}, lease_until = NULL, phase = 'failed', phase_ms = ${NOW_MS_SQL}
    WHERE status = 'running' OR (status = 'queued' AND (adapter_id LIKE 'record:%' OR adapter_id LIKE 'device:%'));
INSERT INTO agent_events (job_id, stage, kind, level, message, data_json, created_at)
    SELECT DISTINCT job_id, 'validation', 'runner_removed', 'warn', '${RUNNER_REMOVED_IN_UPDATE}', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM agent_tasks WHERE error = '${RUNNER_REMOVED_IN_UPDATE}' AND job_id IN (SELECT id FROM generation_jobs);
UPDATE generation_jobs SET ran_on_json = (
        SELECT json_object('agentId', a.id, 'tokenId', a.token_id, 'name', COALESCE(NULLIF(TRIM(k.label), ''), a.name), 'taskId', t.id, 'attempt', t.attempt, 'phase', t.phase)
        FROM agent_tasks t JOIN agents a ON a.id = t.agent_id LEFT JOIN agent_tokens k ON k.id = a.token_id
        WHERE t.job_id = generation_jobs.id ORDER BY t.created_ms DESC LIMIT 1)
    WHERE ran_on_json IS NULL AND EXISTS (SELECT 1 FROM agent_tasks t JOIN agents a ON a.id = t.agent_id WHERE t.job_id = generation_jobs.id);
DROP TABLE device_reservations;
DROP TABLE runner_access;
DROP TABLE agents;
DROP TABLE agent_tokens;
DROP TABLE runner_enrollments;
DROP TABLE runner_update_settings;
CREATE TABLE agent_tokens (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL UNIQUE,        -- the person (a users.id, or OPEN_OWNER_ID): one runner per person
    label TEXT,
    token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the token; the token itself is never stored
    hint TEXT NOT NULL,                   -- last 4 characters
    created_at TEXT NOT NULL,
    created_by TEXT,
    last_used_at TEXT,
    last_used_ms INTEGER,
    allow_code_scripts INTEGER NOT NULL DEFAULT 1,
    allow_private_targets INTEGER NOT NULL DEFAULT 0,
    allow_real_phone INTEGER NOT NULL DEFAULT 0,
    machine_id TEXT,                      -- the install id of the computer that first used it; another computer is refused
    rotated_at TEXT,
    previous_hash TEXT,                   -- the credential before the latest rotation, valid until previous_until_ms or the new one's first use
    previous_until_ms INTEGER
);
CREATE INDEX idx_agent_tokens_previous ON agent_tokens(previous_hash);
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
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
    os_version TEXT,
    machine_id TEXT,
    protocol INTEGER NOT NULL DEFAULT 1,
    UNIQUE (token_id, name)
);
CREATE INDEX idx_agents_token ON agents(token_id);
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
CREATE TABLE runner_enrollments (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,       -- SHA-256 of the code; the code itself is never stored
    hint TEXT NOT NULL,
    owner_id TEXT NOT NULL,               -- the person whose computer it sets up
    label TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_ms INTEGER NOT NULL,
    used_ms INTEGER,
    token_id TEXT
);
CREATE INDEX idx_runner_enrollments_owner ON runner_enrollments(owner_id);
CREATE TABLE runner_update_settings (
    agent_id TEXT PRIMARY KEY,
    requested_at BIGINT,
    reported TEXT,
    updated_at TEXT NOT NULL
);
CREATE TABLE runner_settings_r57 (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    run_on TEXT NOT NULL,                 -- platform | agent
    updated_at TEXT NOT NULL
);
INSERT INTO runner_settings_r57 (project_id, run_on, updated_at) SELECT project_id, run_on, updated_at FROM runner_settings;
DROP TABLE runner_settings;
ALTER TABLE runner_settings_r57 RENAME TO runner_settings;
UPDATE schedules SET created_by = ${knownOwner(`CASE
        WHEN EXISTS (SELECT 1 FROM activity e WHERE e.action = 'PATCH /api/projects/:id/schedules/:sid' AND e.path = '/api/projects/' || schedules.project_id || '/schedules/' || schedules.id AND e.status < 400)
        THEN (SELECT ${actorOwner("e")} FROM activity e WHERE e.action = 'PATCH /api/projects/:id/schedules/:sid' AND e.path = '/api/projects/' || schedules.project_id || '/schedules/' || schedules.id AND e.status < 400 ORDER BY e.id DESC LIMIT 1)
        WHEN (SELECT COUNT(*) FROM schedules s WHERE s.project_id = schedules.project_id AND ${near("s.created_at", "schedules.created_at")}) = 1
        THEN (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(${actorOwner("c")}) END FROM activity c WHERE c.action = 'POST /api/projects/:id/schedules' AND c.project_id = schedules.project_id AND c.status < 400 AND ${near("c.at", "schedules.created_at")})
    END`)}
    WHERE created_by IS NULL;
UPDATE trigger_tokens SET created_by = ${knownOwner(`CASE
        WHEN (SELECT COUNT(*) FROM trigger_tokens s WHERE s.project_id = trigger_tokens.project_id AND ${near("s.created_at", "trigger_tokens.created_at")}) = 1
        THEN (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(${actorOwner("c")}) END FROM activity c WHERE c.action = 'POST /api/projects/:id/triggers' AND c.project_id = trigger_tokens.project_id AND c.status < 400 AND ${near("c.at", "trigger_tokens.created_at")})
    END`)}
    WHERE created_by IS NULL;
`;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newAgentToken = (): string => AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");

/** An agent is online when it was seen this recently (it polls every ~25 s). */
export const ONLINE_MS = 45_000;

export interface AgentTokenRecord {
    id: string;
    /** The person the runner belongs to (OPEN_OWNER_ID on an open server). A person has at most one. */
    ownerId: string;
    label: string | null;
    hint: string;
    createdAt: string;
    lastUsedAt: string | null;
    /** Code scripts may go to it: its owner's switch, on by default. */
    allowCodeScripts: boolean;
    /** Runs against private and local addresses may go to it: its owner's switch, off by default. */
    allowPrivateTargets: boolean;
    /** Phone work may use a real phone plugged into it: its owner's switch, off by default. */
    allowRealPhone: boolean;
    /** Explorations open a visible browser window on that computer: its owner's switch, off by default. */
    showBrowser: boolean;
    /** The install id of the computer the credential is bound to (null until a runner that sends one connects). */
    machineId: string | null;
    createdBy: string | null;
    rotatedAt: string | null;
    /** Set by findToken when the presented credential is the one before the latest rotation (still inside its grace). */
    viaPrevious?: boolean;
}

const toToken = (r: Record<string, any>): AgentTokenRecord => ({
    id: r.id,
    ownerId: r.owner_id,
    label: r.label,
    hint: r.hint,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    allowCodeScripts: Number(r.allow_code_scripts ?? 0) === 1,
    allowPrivateTargets: Number(r.allow_private_targets ?? 0) === 1,
    allowRealPhone: Number(r.allow_real_phone ?? 0) === 1,
    showBrowser: Number(r.show_browser ?? 0) === 1,
    machineId: r.machine_id ?? null,
    createdBy: r.created_by ?? null,
    rotatedAt: r.rotated_at ?? null,
});

export interface AgentRecord {
    id: string;
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
    /** What the machine said about itself (migration 51; null or absent for an older runner). */
    osVersion?: string | null;
    machineId?: string | null;
}

const toAgent = (r: Record<string, any>): AgentRecord => ({
    id: r.id,
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
    osVersion: r.os_version ?? null,
    machineId: r.machine_id ?? null,
});

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

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
    /** What the task is doing (written only by the platform; see TASK_PHASES). */
    phase: TaskPhase;
    phaseMs: number | null;
    /** How many times it was handed out; `attemptId` is the current hand-out's id (fencing, protocol 2). */
    attempt: number;
    attemptId: string | null;
    acceptedMs: number | null;
    /** Runners that said no to it, oldest first (it is never offered to them again). */
    rejections: TaskRejection[];
    /** The attempt whose result was stored. */
    resultAttemptId: string | null;
}

export interface TaskRejection {
    agentId: string;
    reason: string;
    message: string;
    at: number;
}

/** A task the sweep moved: back to the queue (not accepted in time, or its runner stopped answering), lost, never picked up, or cancelled. */
export interface SweepChange {
    kind: "accept_timeout" | "never_accepted" | "requeued" | "lost" | "stale" | "cancelled";
    taskId: string;
    jobId: string;
    agentId: string | null;
    attempt: number;
}

const PHASE_OF_STATUS: Record<string, TaskPhase> = { queued: "queued", running: "running", done: "completed", failed: "failed", cancelled: "cancelled" };
const PHASE_RANK: Record<TaskPhase, number> = { queued: 0, assigned: 1, accepted: 2, preparing: 3, running: 4, uploading: 5, completed: 9, rejected: 9, failed: 9, cancelled: 9, timed_out: 9, lost_connection: 9 };

/** Can an attempt move from one phase to another? Only forward, and never out of a final phase (a re-offer starts a new attempt instead). */
export function canMovePhase(from: TaskPhase, to: TaskPhase): boolean {
    if (FINAL_TASK_PHASES.includes(from)) return false;
    return PHASE_RANK[to] > PHASE_RANK[from];
}

function parseRejections(text: unknown): TaskRejection[] {
    try {
        const v = JSON.parse(String(text ?? "[]")) as unknown;
        return Array.isArray(v) ? (v as TaskRejection[]).filter((x) => x && typeof x.agentId === "string") : [];
    } catch {
        return [];
    }
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
    phase: (r.phase as TaskPhase | undefined) ?? PHASE_OF_STATUS[r.status] ?? "queued",
    phaseMs: r.phase_ms ?? null,
    attempt: Number(r.attempt ?? r.offers ?? 0),
    attemptId: r.attempt_id ?? null,
    acceptedMs: r.accepted_ms ?? null,
    rejections: parseRejections(r.rejections_json),
    resultAttemptId: r.result_attempt_id ?? null,
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


export interface DeviceReservation extends DeviceNeed {
    agentId: string;
    taskId: string;
    projectId: string;
    reservedMs: number;
}

export interface RunnerSetting {
    runOn: "platform" | "agent";
    /** EXECUTION_MODE=runners: every project runs on runners whatever was stored, and nothing may be started on the server (runner-only.ts). */
    runnersOnly?: true;
}

/** A task is handed out at most this many times: the first claim plus one re-offer. */
export const MAX_OFFERS = 2;
/**
 * A protocol-2 hand-out not accepted in time goes back to the queue (it uses up no offer); the third such time for the same task, the task
 * fails with NEVER_ACCEPTED instead of being offered forever. Each is noted in rejections_json with this reason, which is not a "no": the
 * runner may be offered the task again.
 */
export const ACCEPT_TIMEOUT_REASON = "accept_timeout";
export const MAX_ACCEPT_TIMEOUTS = 3;
export const NEVER_ACCEPTED = `The run was offered to a runner ${MAX_ACCEPT_TIMEOUTS} times and never accepted. Check that the runner is connected and up to date, then run again.`;
/** The runners that really said no to a task (an accept timeout is not one). */
export const refusalsOf = (t: Pick<TaskRecord, "rejections">): TaskRejection[] => t.rejections.filter((r) => r.reason !== ACCEPT_TIMEOUT_REASON);
/** A task nobody picked up in this long fails with a plain message. */
export const QUEUE_MAX_MS = 30 * 60_000;
/** Finished tasks, their payloads and files are removed after this long. */
export const TASK_KEEP_MS = 24 * 60 * 60_000;
/** Agents not seen for this long are forgotten. */
export const AGENT_KEEP_MS = 30 * 24 * 60 * 60_000;
const LOG_KEEP = 200;

const TERMINAL_JOB_SQL = "('COMPLETED','PARTIALLY_COMPLETED','FAILED')";

export class AgentStore {
    /** EXECUTION_MODE=runners (set once by runner-only.ts): `getRunner` answers "on a runner" for every project, without rewriting what is stored. */
    runnersOnly = false;
    /** Is the server open (no accounts, no access key, no Crowd4Test sign-in)? Set by agent-services.ts; only then may OPEN_OWNER_ID's runner take runs. */
    openMode: () => boolean = () => false;

    constructor(
        private readonly db: Db,
        private readonly clock: () => number = Date.now,
    ) {}

    // ── tokens ──────────────────────────────────────────────────────────────

    /**
     * One person's own computer: what it may take follows its owner (their runs, in projects they may still run tests in). It replaces the
     * person's earlier credential, if any (one per person: owner_id is unique), and with it that computer's rows. redeemEnrollment calls it
     * inside its transaction.
     */
    createPersonalToken(o: { ownerId: string; label: string; createdBy: string; machineId?: string }): { secret: string; record: AgentTokenRecord; replaced: boolean } {
        const secret = newAgentToken();
        const id = randomUUID();
        const replaced = this.retire(o.ownerId);
        this.db.run(
            "INSERT INTO agent_tokens (id, owner_id, label, token_hash, hint, created_at, created_by, machine_id) VALUES (?,?,?,?,?,?,?,?)",
            id, o.ownerId, o.label.trim() || null, hashToken(secret), secret.slice(-4), new Date(this.clock()).toISOString(), o.createdBy, o.machineId ?? null,
        );
        return { secret, record: this.getToken(id)!, replaced };
    }

    getToken(id: string): AgentTokenRecord | undefined {
        const r = this.db.get("SELECT * FROM agent_tokens WHERE id = ?", id);
        return r ? toToken(r) : undefined;
    }

    /** "Remove this computer": the person's credential stops working at once, and its computer's rows go with it. False when they had none. */
    retire(ownerId: string): boolean {
        return Number(this.db.run("DELETE FROM agent_tokens WHERE owner_id = ?", ownerId).changes) > 0;
    }

    /** The person's runner, with the computer that last connected with it and whether it is online. Undefined: not set up. */
    runnerOf(ownerId: string): { token: AgentTokenRecord; agent: AgentRecord | undefined; online: boolean } | undefined {
        const r = this.db.get("SELECT * FROM agent_tokens WHERE owner_id = ?", ownerId);
        if (!r) return undefined;
        const token = toToken(r);
        const agent = this.agentsOfToken(token.id)[0];
        return { token, agent, online: Boolean(agent) && this.clock() - agent!.lastSeenMs <= ONLINE_MS };
    }

    /** The owner's switches. Only what is given changes. False when the runner is unknown (removed). */
    setTokenSwitches(id: string, s: { allowCodeScripts?: boolean; allowPrivateTargets?: boolean; allowRealPhone?: boolean; showBrowser?: boolean }): boolean {
        const bit = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
        const r = this.db.run(
            "UPDATE agent_tokens SET allow_code_scripts = COALESCE(?, allow_code_scripts), allow_private_targets = COALESCE(?, allow_private_targets), allow_real_phone = COALESCE(?, allow_real_phone), show_browser = COALESCE(?, show_browser) WHERE id = ?",
            bit(s.allowCodeScripts),
            bit(s.allowPrivateTargets),
            bit(s.allowRealPhone),
            bit(s.showBrowser),
            id,
        );
        return Number(r.changes) > 0;
    }

    /** Bind a credential to the computer that first used it (a no-op once bound). */
    bindMachine(id: string, machineId: string): void {
        this.db.run("UPDATE agent_tokens SET machine_id = ? WHERE id = ? AND machine_id IS NULL", machineId, id);
    }

    /**
     * A new credential for a runner. The one presented keeps working until the new one is first used, at most ROTATION_GRACE_MS: an agent
     * that never heard the answer still connects with what it has, and may ask again. Asking again with the old one replaces the unused new one.
     */
    rotateToken(id: string, presented: string): { secret: string; previousUntilMs: number } | undefined {
        const now = this.clock();
        const presentedHash = hashToken(presented);
        return this.db.tx(() => {
            const r = this.db.get<{ token_hash: string; previous_hash: string | null; previous_until_ms: number | null }>("SELECT token_hash, previous_hash, previous_until_ms FROM agent_tokens WHERE id = ?", id);
            if (!r) return undefined;
            const secret = newAgentToken();
            const at = new Date(now).toISOString();
            if (r.previous_hash && r.previous_hash === presentedHash && Number(r.previous_until_ms ?? 0) > now) {
                // The answer to the last rotation was lost: the old credential stays the grace one, the unused new one goes.
                this.db.run("UPDATE agent_tokens SET token_hash = ?, hint = ?, rotated_at = ? WHERE id = ?", hashToken(secret), secret.slice(-4), at, id);
                return { secret, previousUntilMs: Number(r.previous_until_ms) };
            }
            if (r.token_hash !== presentedHash) return undefined;
            const until = now + ROTATION_GRACE_MS;
            this.db.run("UPDATE agent_tokens SET previous_hash = token_hash, previous_until_ms = ?, token_hash = ?, hint = ?, rotated_at = ? WHERE id = ?", until, hashToken(secret), secret.slice(-4), at, id);
            return { secret, previousUntilMs: until };
        });
    }

    /** Should this runner ask for a new credential (older than ROTATE_AFTER_MS since it was made or last rotated)? */
    rotationDue(t: AgentTokenRecord): boolean {
        const since = Date.parse(t.rotatedAt ?? t.createdAt);
        return Number.isFinite(since) && this.clock() - since >= ROTATE_AFTER_MS;
    }

    // ── enrollment codes ────────────────────────────────────────────────────

    /**
     * A single-use code for the download from Settings; trading it makes the person's one runner credential, replacing the one they had
     * (redeemEnrollment). The plaintext is returned here once and never kept.
     */
    createPersonalEnrollment(o: { ownerId: string; createdBy: string; label?: string | null }): { code: string; record: EnrollmentRecord } {
        const code = newEnrollmentCode();
        const id = randomUUID();
        const now = this.clock();
        this.db.run(
            "INSERT INTO runner_enrollments (id, code_hash, hint, owner_id, label, created_by, created_at, expires_ms) VALUES (?,?,?,?,?,?,?,?)",
            id, hashToken(code), code.slice(-4), o.ownerId, o.label?.trim() || null, o.createdBy, new Date(now).toISOString(), now + ENROLLMENT_TTL_MS,
        );
        return { code, record: this.getEnrollment(id)! };
    }

    getEnrollment(id: string): EnrollmentRecord | undefined {
        const r = this.db.get("SELECT * FROM runner_enrollments WHERE id = ?", id);
        return r ? toEnrollment(r) : undefined;
    }

    /**
     * Trade a code for a runner credential, once. In one transaction: the code is checked (constant time, single use, not expired), the
     * person's runner is made and bound to the computer's install id, replacing the one they had (one runner per person), and the code is
     * marked used.
     */
    redeemEnrollment(code: string, machine: { name: string; machineId?: string }): RedeemOutcome {
        const hash = hashToken(code);
        return this.db.tx((): RedeemOutcome => {
            const r = this.db.get("SELECT * FROM runner_enrollments WHERE code_hash = ?", hash);
            if (!r) return { ok: false, reason: "unknown" };
            const a = Buffer.from(hash, "hex");
            const b = Buffer.from(String(r.code_hash), "hex");
            if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "unknown" };
            const e = toEnrollment(r);
            if (e.usedMs !== null) {
                // The answer was lost on the way: within the code's life, the same computer (same install id) asking again gets a fresh
                // credential for the same runner, and the one made before stops working. Only while that one was never used; anyone else: "used".
                const t = e.tokenId ? this.db.get<{ machine_id: string | null; last_used_ms: number | null }>("SELECT machine_id, last_used_ms FROM agent_tokens WHERE id = ?", e.tokenId) : undefined;
                const sameComputer = Boolean(machine.machineId) && t?.machine_id === machine.machineId;
                if (!t || !sameComputer || t.last_used_ms !== null || this.clock() >= e.expiresMs) return { ok: false, reason: "used" };
                const secret = newAgentToken();
                this.db.run("UPDATE agent_tokens SET token_hash = ?, hint = ?, previous_hash = NULL, previous_until_ms = NULL WHERE id = ?", hashToken(secret), secret.slice(-4), e.tokenId);
                return { ok: true, secret, token: this.getToken(e.tokenId!)!, enrollment: e, again: true };
            }
            if (this.clock() >= e.expiresMs) return { ok: false, reason: "expired" };
            const made = this.createPersonalToken({ ownerId: e.ownerId, label: e.label ?? machine.name, createdBy: e.createdBy ?? "Enrollment code", ...(machine.machineId ? { machineId: machine.machineId } : {}) });
            this.db.run("UPDATE runner_enrollments SET used_ms = ?, token_id = ? WHERE id = ?", this.clock(), made.record.id, e.id);
            return { ok: true, secret: made.secret, token: made.record, enrollment: this.getEnrollment(e.id)!, replaced: made.replaced };
        });
    }

    /** A code that was never handed out (its download could not be built) stops working at once. */
    expireEnrollment(id: string): void {
        this.db.run("UPDATE runner_enrollments SET expires_ms = ? WHERE id = ? AND used_ms IS NULL", this.clock() - 1, id);
    }

    /** Codes never used, a day past their life, are removed. A used code keeps its row (its status: connected or used). */
    pruneEnrollments(): number {
        return Number(this.db.run("DELETE FROM runner_enrollments WHERE used_ms IS NULL AND expires_ms < ?", this.clock() - 24 * 60 * 60_000).changes);
    }

    renameToken(id: string, label: string): boolean {
        return Number(this.db.run("UPDATE agent_tokens SET label = ? WHERE id = ?", label.trim() || null, id).changes) === 1;
    }

    /** Whether a token still works: a removed runner's open poll stops at once (routes/agents.ts). */
    tokenLive(id: string): boolean {
        return Boolean(this.db.get("SELECT 1 AS x FROM agent_tokens WHERE id = ?", id));
    }

    /**
     * The token for a presented one, or undefined. Hash compared in constant time. The credential
     * before the latest rotation still counts until its grace ends (`viaPrevious`); the first use of the new one ends that grace at once.
     */
    findToken(presented: string): AgentTokenRecord | undefined {
        const hash = hashToken(presented);
        const same = (stored: unknown): boolean => {
            const a = Buffer.from(hash, "hex");
            const b = Buffer.from(String(stored ?? ""), "hex");
            return a.length === b.length && timingSafeEqual(a, b);
        };
        const r = this.db.get("SELECT * FROM agent_tokens WHERE token_hash = ?", hash);
        if (r) {
            if (!same(r.token_hash)) return undefined;
            if (r.previous_hash) this.db.run("UPDATE agent_tokens SET previous_hash = NULL, previous_until_ms = NULL WHERE id = ? AND token_hash = ?", r.id, hash);
            return toToken(r);
        }
        const old = this.db.get("SELECT * FROM agent_tokens WHERE previous_hash = ? AND previous_until_ms > ?", hash, this.clock());
        if (!old || !same(old.previous_hash)) return undefined;
        return { ...toToken(old), viaPrevious: true };
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
    upsertAgent(token: AgentTokenRecord, hello: { name: string; version: string; capabilities: Capabilities; concurrency: number; machineId?: string }): AgentRecord {
        const now = this.clock();
        const caps = JSON.stringify(hello.capabilities);
        const osVersion = hello.capabilities.osVersion ?? null;
        // The same computer under a new name (its install id matches) keeps its row, so the runner's history stays.
        const existing =
            this.db.get<{ id: string }>("SELECT id FROM agents WHERE token_id = ? AND name = ?", token.id, hello.name) ??
            (hello.machineId ? this.db.get<{ id: string }>("SELECT id FROM agents WHERE token_id = ? AND machine_id = ? ORDER BY last_seen_ms DESC LIMIT 1", token.id, hello.machineId) : undefined);
        if (existing) {
            this.db.run(
                "UPDATE agents SET name = ?, version = ?, os = ?, arch = ?, node = ?, capabilities_json = ?, concurrency = ?, last_seen_ms = ?, os_version = ?, machine_id = COALESCE(?, machine_id) WHERE id = ?",
                hello.name, hello.version, hello.capabilities.os, hello.capabilities.arch, hello.capabilities.node, caps, hello.concurrency, now, osVersion, hello.machineId ?? null, existing.id,
            );
            return this.getAgent(existing.id)!;
        }
        const id = randomUUID();
        this.db.run("INSERT INTO agents (id, token_id, name, version, os, arch, node, capabilities_json, concurrency, first_seen_ms, last_seen_ms, os_version, machine_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", id, token.id, hello.name, hello.version, hello.capabilities.os, hello.capabilities.arch, hello.capabilities.node, caps, hello.concurrency, now, now, osVersion, hello.machineId ?? null);
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

    /** The oldest running task of a computer (its job and project), for "Running now" in Settings. Never the payload. */
    runningTaskOf(agentId: string): { jobId: string; projectId: string; adapterId: string } | undefined {
        const r = this.db.get<{ job_id: string; project_id: string; adapter_id: string }>("SELECT job_id, project_id, adapter_id FROM agent_tasks WHERE agent_id = ? AND status = 'running' ORDER BY claimed_ms LIMIT 1", agentId);
        return r ? { jobId: r.job_id, projectId: r.project_id, adapterId: r.adapter_id } : undefined;
    }

    runningCount(agentId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks WHERE agent_id = ? AND status = 'running'", agentId)?.n ?? 0);
    }

    // ── where a project's tests run ─────────────────────────────────────────

    getRunner(projectId: string): RunnerSetting {
        // Runners only: the effective setting is "on a runner". Every run goes to its owner's own runner.
        if (this.runnersOnly) return { runOn: "agent", runnersOnly: true };
        const r = this.db.get<{ run_on: string }>("SELECT run_on FROM runner_settings WHERE project_id = ?", projectId);
        return { runOn: r?.run_on === "agent" ? "agent" : "platform" };
    }

    /**
     * May this person still run this project's tests (a personal runner takes their runs only while they may)? Read from what this server
     * keeps: the person exists and is active, the project is in their reach (all projects, or a membership row), and for an account made
     * here their role there includes running tests. A Crowd4Test account's permissions come with each request; for them this checks their
     * status, reach and whether they held ai_studio.tests.run, as of their latest arrival or membership change (auth/crowd4test.ts personFor).
     */
    ownerMayRun(ownerId: string, projectId: string): boolean {
        // The open server acts as one person, with every project, while it is open (no accounts, no access key).
        if (ownerId === OPEN_OWNER_ID) return this.openMode() && Boolean(this.db.get("SELECT 1 AS x FROM projects WHERE id = ?", projectId));
        const u = this.db.get<{ status: string | null; role: string | null; project_access: string | null; c4t_role: string | null; organization_id: string | null; c4t_runs_tests: number | null }>(
            "SELECT status, role, project_access, c4t_role, organization_id, c4t_runs_tests FROM users WHERE id = ? AND role IS NOT NULL",
            ownerId,
        );
        if (!u || u.status !== "active") return false;
        const project = this.db.get<{ o: string | null }>("SELECT organization_id AS o FROM projects WHERE id = ?", projectId);
        if (!project) return false;
        const c4t = u.c4t_role !== null && u.c4t_role !== undefined;
        // A customer stays inside their organisation, whatever else they were given.
        if (c4t && u.c4t_role === "CUSTOMER" && (!u.organization_id || project.o !== u.organization_id)) return false;
        // Unknown (null: not arrived since this was kept) counts as yes, as before it was kept.
        if (c4t && u.c4t_runs_tests !== null && Number(u.c4t_runs_tests) === 0) return false;
        if (u.project_access !== "only") return c4t || runsTests(u.role);
        const member = this.db.get<{ role: string }>("SELECT role FROM user_projects WHERE user_id = ? AND project_id = ?", ownerId, projectId);
        if (!member) return false;
        return c4t || (runsTests(member.role) && runsTests(u.role));
    }

    setRunner(projectId: string, s: RunnerSetting): void {
        this.db.run(
            "INSERT INTO runner_settings (project_id, run_on, updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET run_on = excluded.run_on, updated_at = excluded.updated_at",
            projectId,
            s.runOn,
            new Date(this.clock()).toISOString(),
        );
    }

    // ── tasks ───────────────────────────────────────────────────────────────

    enqueue(t: { id: string; projectId: string; jobId: string; adapterId: string; payloadEnc: string; files: Array<Omit<TaskFile, "taskId">>; ownerId?: string | null }): void {
        this.db.tx(() => {
            // Whose run it is (migration 51): given, or read from the job; a personal runner claims only its owner's tasks.
            const owner = t.ownerId !== undefined ? t.ownerId : this.ownerOfJob(t.jobId);
            this.db.run("INSERT INTO agent_tasks (id, project_id, job_id, adapter_id, status, payload_enc, created_ms, owner_id) VALUES (?,?,?,?,?,?,?,?)", t.id, t.projectId, t.jobId, t.adapterId, "queued", t.payloadEnc, this.clock(), owner);
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

    /** Queued tasks of a project, oldest first (tests read it; a runner picks from its owner's queue, queuedOfOwner). */
    queued(projectId: string, limit = 25): TaskRecord[] {
        return this.db.all(`SELECT * FROM agent_tasks WHERE project_id = ? AND status = 'queued' ORDER BY created_ms, ${this.db.dialect.insertionOrder()} LIMIT ?`, projectId, limit).map(toTask);
    }

    /**
     * The oldest queued tasks of every project, without their payloads: a personal runner's candidates (its owner's runs, wherever they are;
     * agent-services.ts filters them by the job's owner and the project's switch before it claims one).
     */
    queuedOfOwner(ownerId: string, limit = 50): TaskRecord[] {
        return this.db.all(`SELECT * FROM agent_tasks WHERE status = 'queued' AND owner_id = ? ORDER BY created_ms, ${this.db.dialect.insertionOrder()} LIMIT ?`, ownerId, limit).map(toTask);
    }

    /** The person a job belongs to (jobOwnerId of its options), or null. */
    ownerOfJob(jobId: string): string | null {
        try {
            const r = this.db.get<{ options_json: string }>("SELECT options_json FROM generation_jobs WHERE id = ?", jobId);
            return r ? jobOwnerId(JSON.parse(r.options_json) as { startedBy?: unknown }) : null;
        } catch {
            return null;
        }
    }

    /**
     * Take a queued task for an agent, holding the device it needs, in one transaction: of two claims (or two tasks wanting the same phone)
     * exactly one wins; the other task stays queued. Round 45: only a person's own runner takes work, and only its owner's tasks
     * (agent_tasks.owner_id), while its credential is live and its owner is active and still reaches the project (for the open server: while
     * it is open). offerTo checks the same first, for its reasons; this is the guard.
     */
    claimFor(taskId: string, agent: { id: string; tokenId: string }, leaseMs: number, device?: DeviceNeed): TaskRecord | undefined {
        return this.db.tx(() => {
            this.releaseDevices();
            if (device && this.deviceHeld(agent.id, device)) return undefined;
            const now = this.clock();
            const open = this.openMode() ? 1 : 0;
            const r = this.db.get(
                "UPDATE agent_tasks SET status = 'running', agent_id = ?, claimed_ms = ?, lease_until = ?, last_beat_ms = ?, offers = offers + 1 WHERE id = ? AND status = 'queued' AND EXISTS (SELECT 1 FROM agent_tokens k WHERE k.id = ? AND k.owner_id = agent_tasks.owner_id AND ((k.owner_id = ? AND ? = 1) OR EXISTS (SELECT 1 FROM users u WHERE u.id = k.owner_id AND u.status = 'active' AND u.role IS NOT NULL AND (u.project_access IS DISTINCT FROM 'only' OR EXISTS (SELECT 1 FROM user_projects m WHERE m.user_id = u.id AND m.project_id = agent_tasks.project_id))))) RETURNING *",
                agent.id, now, now + leaseMs, now, taskId, agent.tokenId, OPEN_OWNER_ID, open,
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

    /**
     * Extend the lease and record progress. False unless this agent holds the running task. The caller scrubs the lines first. `phase`: what
     * the agent says it is doing (protocol 1 beats count as "running"); it only ever moves forward, and a beat for an attempt that was not
     * accepted yet accepts it.
     */
    heartbeat(taskId: string, agentId: string, leaseMs: number, beat: { done?: number; total?: number; log?: string[] }, phase?: AgentPhase): boolean {
        return this.db.tx(() => {
            const now = this.clock();
            const cur = this.db.get<{ log_json: string; phase: TaskPhase | null }>("SELECT log_json, phase FROM agent_tasks WHERE id = ? AND agent_id = ? AND status = 'running'", taskId, agentId);
            if (!cur) return false;
            const log = [...(JSON.parse(cur.log_json) as string[]), ...(beat.log ?? [])].slice(-LOG_KEEP);
            const from: TaskPhase = cur.phase ?? "running";
            const to: TaskPhase | undefined = phase && canMovePhase(from, phase) ? phase : from === "assigned" ? "accepted" : undefined;
            this.db.run(
                "UPDATE agent_tasks SET lease_until = ?, last_beat_ms = ?, progress_done = COALESCE(?, progress_done), progress_total = COALESCE(?, progress_total), log_json = ?, phase = COALESCE(?, phase), phase_ms = CASE WHEN ? IS NULL THEN phase_ms ELSE ? END, accepted_ms = COALESCE(accepted_ms, ?) WHERE id = ?",
                now + leaseMs, now, beat.done ?? null, beat.total ?? null, JSON.stringify(log), to ?? null, to ?? null, now, to ? now : null, taskId,
            );
            return true;
        });
    }

    /** Record the agent's result. Accepted once, and only from the claiming agent. `attemptId`: the attempt it is for (protocol 2), kept so a repeat is recognised. */
    finish(taskId: string, agentId: string, outcome: { status: "done" | "failed"; resultEnc?: string; error?: string; attemptId?: string }): boolean {
        const task = this.getTask(taskId);
        const status: TaskStatus = task?.cancelRequested ? "cancelled" : outcome.status;
        const phase: TaskPhase = status === "cancelled" ? "cancelled" : status === "done" ? "completed" : "failed";
        const now = this.clock();
        const ok =
            Number(
                this.db.run(
                    "UPDATE agent_tasks SET status = ?, result_enc = ?, error = ?, finished_ms = ?, lease_until = NULL, phase = ?, phase_ms = ?, result_attempt_id = COALESCE(?, attempt_id) WHERE id = ? AND agent_id = ? AND status = 'running'",
                    status, outcome.resultEnc ?? null, outcome.error ?? null, now, phase, now, outcome.attemptId ?? null, taskId, agentId,
                ).changes,
            ) === 1;
        if (ok) this.db.run("DELETE FROM device_reservations WHERE task_id = ?", taskId);
        return ok;
    }

    /** The platform gave the task up (job cancelled, no agent): queued ends now; a running one is stopped through the agent's next heartbeat. */
    requestCancel(taskId: string): void {
        const now = this.clock();
        this.db.run("UPDATE agent_tasks SET status = 'cancelled', finished_ms = ?, phase = 'cancelled', phase_ms = ? WHERE id = ? AND status = 'queued'", now, now, taskId);
        this.db.run("UPDATE agent_tasks SET cancel_requested = 1 WHERE id = ? AND status = 'running'", taskId);
    }

    /** The executor stopped waiting for a task (failure on the platform side). `phase`: why, for the run's details (failed, timed out, rejected by every runner). */
    failQueuedOrRunning(taskId: string, error: string, phase: TaskPhase = "failed"): void {
        const now = this.clock();
        this.db.run("UPDATE agent_tasks SET status = 'failed', error = ?, finished_ms = ?, lease_until = NULL, phase = ?, phase_ms = ? WHERE id = ? AND status IN ('queued','running')", error, now, phase, now, taskId);
        this.db.run("DELETE FROM device_reservations WHERE task_id = ?", taskId);
    }

    /**
     * When the platform process starts: runners could not report while it was away, so every running task gets at least one full lease
     * from now before the sweep may call it lost (a runner reconnects within its back-off, 30 s at most). Returns how many were extended.
     */
    extendRunningLeases(leaseMs: number): number {
        const until = this.clock() + leaseMs;
        return Number(this.db.run("UPDATE agent_tasks SET lease_until = ? WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)", until, until).changes);
    }

    // ── attempts (protocol 2; protocol-1 agents get an attempt too, they just never name it) ──

    /** The protocol a runner machine speaks (1 until it said hello with protocol 2). */
    agentProtocol(agentId: string): number {
        return Number(this.db.get<{ protocol: number | null }>("SELECT protocol FROM agents WHERE id = ?", agentId)?.protocol ?? 1);
    }

    setAgentProtocol(agentId: string, protocol: number): void {
        this.db.run("UPDATE agents SET protocol = ? WHERE id = ?", protocol, agentId);
    }

    /**
     * Start a new attempt of a task this agent has just claimed (claimFor): a new random attempt id, a clean slate for uploads (a re-offer
     * never sees the files of an earlier attempt), and its phase. Protocol 2: "assigned", and the agent has `acceptMs` to accept; protocol 1:
     * accepted by the claim itself.
     */
    beginAttempt(taskId: string, agentId: string, o: { protocol: number; acceptMs: number }): TaskRecord | undefined {
        return this.db.tx(() => {
            const now = this.clock();
            const v2 = o.protocol >= 2;
            const r = this.db.get(
                `UPDATE agent_tasks SET attempt = attempt + 1, attempt_id = ?, phase = ?, phase_ms = ?, accepted_ms = ?, result_attempt_id = NULL${v2 ? ", lease_until = ?" : ""} WHERE id = ? AND agent_id = ? AND status = 'running' RETURNING *`,
                ...([randomBytes(16).toString("base64url"), v2 ? "assigned" : "accepted", now, v2 ? null : now, ...(v2 ? [now + o.acceptMs] : []), taskId, agentId] as Array<string | number | null>),
            );
            if (!r) return undefined;
            this.db.run("DELETE FROM agent_task_files WHERE task_id = ? AND direction = 'out'", taskId);
            return toTask(r);
        });
    }

    /** The agent accepts its attempt. "already": it did before (a repeat is fine); "superseded": a newer attempt exists; "gone": not running for this agent. */
    accept(taskId: string, agentId: string, attemptId: string, leaseMs: number): "accepted" | "already" | "superseded" | "gone" {
        return this.db.tx(() => {
            const t = this.getTask(taskId);
            if (!t || t.agentId !== agentId || t.status !== "running") return t && t.attemptId !== attemptId ? "superseded" : "gone";
            if (t.attemptId !== attemptId) return "superseded";
            if (t.phase !== "assigned") return "already";
            const now = this.clock();
            this.db.run("UPDATE agent_tasks SET phase = 'accepted', phase_ms = ?, accepted_ms = ?, lease_until = ?, last_beat_ms = ? WHERE id = ? AND attempt_id = ? AND status = 'running'", now, now, now + leaseMs, now, taskId, attemptId);
            return "accepted";
        });
    }

    /**
     * The agent will not run its attempt. The task goes back to the queue without using up an offer and is never offered to this agent
     * again; a cancelled one ends as cancelled, and a recording or phone session (which only that agent can host) fails with the reason.
     */
    reject(taskId: string, agentId: string, attemptId: string, why: { reason: string; message: string }): { outcome: "requeued" | "failed" | "cancelled" | "superseded" | "gone"; task?: TaskRecord } {
        return this.db.tx(() => {
            const t = this.getTask(taskId);
            if (!t || t.agentId !== agentId || t.status !== "running") return { outcome: t && t.attemptId !== attemptId ? "superseded" : "gone" };
            if (t.attemptId !== attemptId) return { outcome: "superseded" };
            const now = this.clock();
            const rejections = [...t.rejections, { agentId, reason: why.reason, message: why.message.slice(0, 300), at: now }].slice(-50);
            this.db.run("DELETE FROM device_reservations WHERE task_id = ?", taskId);
            if (t.cancelRequested) {
                this.db.run("UPDATE agent_tasks SET status = 'cancelled', finished_ms = ?, lease_until = NULL, phase = 'cancelled', phase_ms = ?, rejections_json = ? WHERE id = ?", now, now, JSON.stringify(rejections), taskId);
                return { outcome: "cancelled", task: this.getTask(taskId) };
            }
            // Only one runner may explore for its person (round 51): a refusal ends the task, as for a recording or a phone session.
            if (t.adapterId.startsWith("record:") || t.adapterId.startsWith("device:") || t.adapterId === "explore") {
                this.db.run("UPDATE agent_tasks SET status = 'failed', error = ?, finished_ms = ?, lease_until = NULL, phase = 'rejected', phase_ms = ?, rejections_json = ? WHERE id = ?", why.message.slice(0, 500), now, now, JSON.stringify(rejections), taskId);
                return { outcome: "failed", task: this.getTask(taskId) };
            }
            this.db.run("UPDATE agent_tasks SET status = 'queued', agent_id = NULL, lease_until = NULL, phase = 'queued', phase_ms = ?, offers = CASE WHEN offers > 0 THEN offers - 1 ELSE 0 END, rejections_json = ? WHERE id = ?", now, JSON.stringify(rejections), taskId);
            return { outcome: "requeued", task: this.getTask(taskId) };
        });
    }

    /** How many live events of an attempt are kept (the per-attempt cap; seq -1 is the "truncated" note, not counted). */
    liveEventCount(taskId: string, attemptId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_task_events WHERE task_id = ? AND attempt_id = ? AND seq >= 0", taskId, attemptId)?.n ?? 0);
    }

    /** Keep one live event of an attempt: true the first time (task, attempt, seq) is seen, false for a repeat. */
    noteLiveEvent(taskId: string, attemptId: string, seq: number): boolean {
        return Number(this.db.run("INSERT INTO agent_task_events (task_id, attempt_id, seq, received_ms) VALUES (?,?,?,?) ON CONFLICT (task_id, attempt_id, seq) DO NOTHING", taskId, attemptId, seq, this.clock()).changes) === 1;
    }

    /** Where a job's scripts ran, kept with the job (it outlives the task). */
    setRanOn(jobId: string, ranOn: Record<string, unknown>): void {
        this.db.run("UPDATE generation_jobs SET ran_on_json = ? WHERE id = ?", JSON.stringify(ranOn), jobId);
    }

    ranOnOf(jobId: string): Record<string, unknown> | undefined {
        const r = this.db.get<{ ran_on_json: string | null }>("SELECT ran_on_json FROM generation_jobs WHERE id = ?", jobId);
        if (!r?.ran_on_json) return undefined;
        try {
            const v = JSON.parse(r.ran_on_json) as unknown;
            return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Housekeeping that is safe to run from anywhere, any number of times:
     *  - a protocol-2 attempt not accepted in time goes back to the queue without using up an offer;
     *  - a running task with no heartbeat past its lease goes back to the queue once; after that it fails (lost connection);
     *  - a task nobody picked up for 30 minutes fails (timed out);
     *  - a task whose job is over (cancelled, or the worker is gone) is cancelled.
     * `changes` names every task it moved, so the caller can say so in the run's events.
     */
    sweep(): { requeued: number; failed: number; cancelled: number; changes: SweepChange[] } {
        const now = this.clock();
        const changes: SweepChange[] = [];
        // The rows a rule is about to move (read first, inside the same transaction), then the move itself.
        const move = (kind: SweepChange["kind"], where: string, whereParams: Array<string | number>, set: string, setParams: Array<string | number>): number => {
            const rows = this.db.all<{ id: string; job_id: string; agent_id: string | null; attempt: number | null }>(`SELECT id, job_id, agent_id, attempt FROM agent_tasks WHERE ${where}`, ...whereParams);
            if (rows.length === 0) return 0;
            this.db.run(`UPDATE agent_tasks SET ${set} WHERE ${where}`, ...setParams, ...whereParams);
            for (const r of rows) changes.push({ kind, taskId: r.id, jobId: r.job_id, agentId: r.agent_id ?? null, attempt: Number(r.attempt ?? 0) });
            return rows.length;
        };
        return this.db.tx(() => {
            const cancelledLost = move("cancelled", "status = 'running' AND lease_until < ? AND cancel_requested = 1", [now], "status = 'cancelled', finished_ms = ?, lease_until = NULL, phase = 'cancelled', phase_ms = ?", [now, now]);
            // Not accepted in time: back to the queue, noted; the third time for the same task it fails with a sentence.
            let notAccepted = 0;
            let neverAccepted = 0;
            const unaccepted = this.db.all<{ id: string; job_id: string; agent_id: string | null; attempt: number | null; rejections_json: string | null }>("SELECT id, job_id, agent_id, attempt, rejections_json FROM agent_tasks WHERE status = 'running' AND phase = 'assigned' AND lease_until < ?", now);
            for (const r of unaccepted) {
                const before = parseRejections(r.rejections_json);
                const timeouts = before.filter((x) => x.reason === ACCEPT_TIMEOUT_REASON).length + 1;
                const noted = JSON.stringify([...before, { agentId: r.agent_id ?? "", reason: ACCEPT_TIMEOUT_REASON, message: "It did not accept the run in time.", at: now }].slice(-50));
                const last = timeouts >= MAX_ACCEPT_TIMEOUTS;
                const moved = last
                    ? this.db.run("UPDATE agent_tasks SET status = 'failed', error = ?, finished_ms = ?, lease_until = NULL, phase = 'failed', phase_ms = ?, rejections_json = ? WHERE id = ? AND status = 'running' AND phase = 'assigned'", NEVER_ACCEPTED, now, now, noted, r.id)
                    : this.db.run("UPDATE agent_tasks SET status = 'queued', agent_id = NULL, lease_until = NULL, phase = 'queued', phase_ms = ?, offers = CASE WHEN offers > 0 THEN offers - 1 ELSE 0 END, rejections_json = ? WHERE id = ? AND status = 'running' AND phase = 'assigned'", now, noted, r.id);
                if (Number(moved.changes) !== 1) continue;
                if (last) neverAccepted++;
                else notAccepted++;
                changes.push({ kind: last ? "never_accepted" : "accept_timeout", taskId: r.id, jobId: r.job_id, agentId: r.agent_id ?? null, attempt: Number(r.attempt ?? 0) });
            }
            // A record task is never re-offered: a recording cannot move to another computer (adapter_id "record:<agentId>"); the same holds for a phone session ("device:<agentId>") and an exploration ("explore", round 51: its browser is on that computer).
            const requeued = move("requeued", "status = 'running' AND lease_until < ? AND offers < ? AND adapter_id NOT LIKE 'record:%' AND adapter_id NOT LIKE 'device:%' AND adapter_id <> 'explore'", [now, MAX_OFFERS], "status = 'queued', agent_id = NULL, lease_until = NULL, phase = 'queued', phase_ms = ?", [now]);
            const lost = move("lost", "status = 'running' AND lease_until < ? AND (offers >= ? OR adapter_id LIKE 'record:%' OR adapter_id LIKE 'device:%' OR adapter_id = 'explore')", [now, MAX_OFFERS], "status = 'failed', error = 'The runner agent stopped responding while it was running these tests.', finished_ms = ?, lease_until = NULL, phase = 'lost_connection', phase_ms = ?", [now, now]);
            // Counted from when it last went into the queue (phase_ms, set by every re-queue), so a task re-offered after a long run still gets its wait.
            const stale = move("stale", "status = 'queued' AND COALESCE(phase_ms, created_ms) < ?", [now - QUEUE_MAX_MS], "status = 'failed', error = 'No runner took this run within 30 minutes.', finished_ms = ?, phase = 'timed_out', phase_ms = ?", [now, now]);
            const orphaned = move("cancelled", `status IN ('queued','running') AND job_id IN (SELECT id FROM generation_jobs WHERE status IN ${TERMINAL_JOB_SQL})`, [], "status = 'cancelled', finished_ms = ?, lease_until = NULL, phase = 'cancelled', phase_ms = ?", [now, now]);
            this.releaseDevices();
            return { requeued: requeued + notAccepted, failed: lost + stale + neverAccepted, cancelled: cancelledLost + orphaned, changes };
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
