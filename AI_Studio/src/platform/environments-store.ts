/**
 * Storage of the environments feature (migration slot 11): a project's named environments (staging, production...), its test
 * data sets, and the per-environment results of runs.
 *
 * The `environments` table created by migration 1 hangs off an application row and is only ever filled with a "default" row that
 * nothing reads; applications are recreated for every run, so it cannot hold a project's environments. This feature deliberately
 * uses its own project-level table instead and leaves that one alone.
 *
 * Secrets (sign-in, token, authenticator secret) are encrypted with the platform's SecretBox and are write-only: the API only
 * ever says whether one is saved. Results live in test_executions next to the main runs, tagged by `environment` (NULL = the
 * main run), exactly like browser variants, so a test's own history and status are untouched.
 */
import { randomUUID } from "node:crypto";
import type { EnvStatus } from "../engine/environments/env.js";
import { checkDataSet, type DataSet } from "../engine/testdata/dataset.js";
import type { Db, Row } from "./db.js";
import type { SecretBox } from "./secrets.js";

export const ENVIRONMENTS_MIGRATION = `
CREATE TABLE project_environments (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, base_url TEXT NOT NULL, api_base_url TEXT,
    production INTEGER NOT NULL DEFAULT 0,        -- read-only: tests that change data are never run there
    is_default INTEGER NOT NULL DEFAULT 0,        -- preselected in the "run against" picker (never a production one)
    use_project_accounts INTEGER NOT NULL DEFAULT 1,
    variables_json TEXT NOT NULL DEFAULT '{}',    -- non-secret {{env.NAME}} values
    secrets_enc TEXT,                             -- SecretBox-encrypted {username,password,totpSecret,apiToken,apiAuthHeader}; never returned by the API
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (project_id, name)
);
CREATE TABLE test_data_sets (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, columns_json TEXT NOT NULL, rows_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (project_id, name)
);
-- Which named environment a run targeted. NULL = the main run, so everything written before this feature keeps its meaning.
ALTER TABLE test_executions ADD COLUMN environment TEXT;
CREATE INDEX idx_exec_environment ON test_executions(test_case_id, environment);
-- A schedule may run against an environment (a production one only when its owner confirmed it).
ALTER TABLE schedules ADD COLUMN environment TEXT;
ALTER TABLE schedules ADD COLUMN confirm_production INTEGER NOT NULL DEFAULT 0;
`;

export interface EnvironmentSecrets {
    username?: string;
    password?: string;
    totpSecret?: string;
    apiToken?: string;
    apiAuthHeader?: string;
}

export interface Environment {
    id: string;
    projectId: string;
    name: string;
    baseUrl: string;
    apiBaseUrl: string | null;
    production: boolean;
    isDefault: boolean;
    useProjectAccounts: boolean;
    variables: Record<string, string>;
}

/** What the API may show: everything except the secrets, which appear only as "is one saved". */
export interface PublicEnvironment extends Omit<Environment, "projectId"> {
    username: string | null;
    hasPassword: boolean;
    hasTotp: boolean;
    hasApiToken: boolean;
    hasApiAuthHeader: boolean;
}

const now = () => new Date().toISOString();

const toEnv = (r: Row): Environment => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    baseUrl: r.base_url,
    apiBaseUrl: r.api_base_url,
    production: Boolean(r.production),
    isDefault: Boolean(r.is_default),
    useProjectAccounts: Boolean(r.use_project_accounts),
    variables: JSON.parse(r.variables_json || "{}"),
});

export class EnvironmentStore {
    constructor(
        private readonly db: Db,
        private readonly secrets: SecretBox,
    ) {}

    list(projectId: string): Environment[] {
        return this.db.all<Row>("SELECT * FROM project_environments WHERE project_id = ? ORDER BY is_default DESC, name", projectId).map(toEnv);
    }

    get(projectId: string, name: string): Environment | undefined {
        const r = this.db.get<Row>("SELECT * FROM project_environments WHERE project_id = ? AND name = ?", projectId, name);
        return r ? toEnv(r) : undefined;
    }

    /** Decrypted secrets, for the run only. An unreadable blob (the encryption key changed) is treated as "none saved". */
    secretsOf(env: Pick<Environment, "id">): EnvironmentSecrets {
        const r = this.db.get<Row>("SELECT secrets_enc FROM project_environments WHERE id = ?", env.id);
        if (!r?.secrets_enc) return {};
        try {
            return this.secrets.decrypt<EnvironmentSecrets>(r.secrets_enc);
        } catch {
            return {};
        }
    }

    toPublic(env: Environment): PublicEnvironment {
        const { projectId: _projectId, ...rest } = env;
        const s = this.secretsOf(env);
        return { ...rest, username: s.username ?? null, hasPassword: Boolean(s.password), hasTotp: Boolean(s.totpSecret), hasApiToken: Boolean(s.apiToken), hasApiAuthHeader: Boolean(s.apiAuthHeader) };
    }

    create(projectId: string, v: { name: string; baseUrl: string; apiBaseUrl?: string | null; production: boolean; useProjectAccounts: boolean; variables: Record<string, string> }): Environment {
        const id = randomUUID();
        const t = now();
        this.db.tx(() => {
            this.db.run(
                "INSERT INTO project_environments (id, project_id, name, base_url, api_base_url, production, is_default, use_project_accounts, variables_json, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?,?,?)",
                id, projectId, v.name, v.baseUrl, v.apiBaseUrl ?? null, v.production ? 1 : 0, v.useProjectAccounts ? 1 : 0, JSON.stringify(v.variables), t, t,
            );
            // The first environment of a project is its default (unless it is production, which never is).
            if (!v.production && this.list(projectId).length === 1) this.db.run("UPDATE project_environments SET is_default = 1 WHERE id = ?", id);
        });
        return this.get(projectId, v.name)!;
    }

    update(env: Environment, v: { baseUrl?: string; apiBaseUrl?: string | null; production?: boolean; useProjectAccounts?: boolean; variables?: Record<string, string> }): Environment {
        const next = {
            baseUrl: v.baseUrl ?? env.baseUrl,
            apiBaseUrl: v.apiBaseUrl === undefined ? env.apiBaseUrl : v.apiBaseUrl,
            production: v.production ?? env.production,
            useProjectAccounts: v.useProjectAccounts ?? env.useProjectAccounts,
            variables: v.variables ?? env.variables,
        };
        this.db.run(
            "UPDATE project_environments SET base_url = ?, api_base_url = ?, production = ?, use_project_accounts = ?, variables_json = ?, is_default = CASE WHEN ? THEN 0 ELSE is_default END, updated_at = ? WHERE id = ?",
            next.baseUrl, next.apiBaseUrl, next.production ? 1 : 0, next.useProjectAccounts ? 1 : 0, JSON.stringify(next.variables), next.production ? 1 : 0, now(), env.id,
        );
        return this.get(env.projectId, env.name)!;
    }

    /** Merge write-only secrets: a field left out keeps what is saved, an empty string removes it. */
    patchSecrets(env: Environment, patch: EnvironmentSecrets): void {
        const merged: EnvironmentSecrets = { ...this.secretsOf(env) };
        for (const [k, v] of Object.entries(patch) as Array<[keyof EnvironmentSecrets, string | undefined]>) {
            if (v === undefined) continue;
            if (v === "") delete merged[k];
            else merged[k] = v;
        }
        const has = Object.values(merged).some(Boolean);
        this.db.run("UPDATE project_environments SET secrets_enc = ?, updated_at = ? WHERE id = ?", has ? this.secrets.encrypt(merged) : null, now(), env.id);
    }

    makeDefault(env: Environment): void {
        this.db.tx(() => {
            this.db.run("UPDATE project_environments SET is_default = 0 WHERE project_id = ?", env.projectId);
            this.db.run("UPDATE project_environments SET is_default = 1, updated_at = ? WHERE id = ?", now(), env.id);
        });
    }

    delete(env: Environment): void {
        this.db.tx(() => {
            this.db.run("DELETE FROM project_environments WHERE id = ?", env.id);
            // Its results go with it; the main runs (environment IS NULL) are never touched.
            const mine = "SELECT e.id FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE e.environment = ? AND t.project_id = ?";
            this.db.run(`DELETE FROM artifacts WHERE execution_id IN (${mine})`, env.name, env.projectId);
            this.db.run(`DELETE FROM test_executions WHERE id IN (${mine})`, env.name, env.projectId);
            if (env.isDefault) {
                const next = this.list(env.projectId).find((e) => !e.production);
                if (next) this.db.run("UPDATE project_environments SET is_default = 1 WHERE id = ?", next.id);
            }
        });
    }
}

// ── test data sets ──────────────────────────────────────────────────────────

export interface StoredDataSet extends DataSet {
    id: string;
    name: string;
    updatedAt: string;
}

export class DataSetStore {
    constructor(private readonly db: Db) {}

    list(projectId: string): StoredDataSet[] {
        return this.db.all<Row>("SELECT * FROM test_data_sets WHERE project_id = ? ORDER BY name", projectId).map((r) => ({ id: r.id, name: r.name, columns: JSON.parse(r.columns_json), rows: JSON.parse(r.rows_json), updatedAt: r.updated_at }));
    }

    get(projectId: string, name: string): StoredDataSet | undefined {
        return this.list(projectId).find((d) => d.name === name);
    }

    /** name → table, the shape the script generators take. */
    asMap(projectId: string): Record<string, DataSet> {
        return Object.fromEntries(this.list(projectId).map((d) => [d.name, { columns: d.columns, rows: d.rows }]));
    }

    /** Insert a new set, or replace the one with this name. The caller decides which is allowed. */
    save(projectId: string, name: string, set: DataSet): StoredDataSet {
        checkDataSet(set);
        const t = now();
        const existing = this.get(projectId, name);
        if (existing) this.db.run("UPDATE test_data_sets SET columns_json = ?, rows_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(set.columns), JSON.stringify(set.rows), t, existing.id);
        else this.db.run("INSERT INTO test_data_sets (id, project_id, name, columns_json, rows_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", randomUUID(), projectId, name, JSON.stringify(set.columns), JSON.stringify(set.rows), t, t);
        return this.get(projectId, name)!;
    }

    delete(projectId: string, name: string): boolean {
        return Number(this.db.run("DELETE FROM test_data_sets WHERE project_id = ? AND name = ?", projectId, name).changes) > 0;
    }
}

// ── per-environment results ─────────────────────────────────────────────────

export interface EnvironmentExecutionInput {
    testId: string;
    scriptId: string | null;
    jobId: string | null;
    environment: string;
    status: EnvStatus;
    reason?: string;
    durationMs: number;
    startedAt: string;
    steps: Array<{ index: number; title: string; status: string; error?: string }>;
}

export function addEnvironmentExecution(db: Db, v: EnvironmentExecutionInput): string {
    const id = randomUUID();
    db.tx(() => {
        db.run(
            "INSERT INTO test_executions (id, test_case_id, script_id, job_id, attempt, status, duration_ms, error, started_at, finished_at, environment) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            id, v.testId, v.scriptId, v.jobId, 1, v.status, v.durationMs, v.reason ?? null, v.startedAt, new Date().toISOString(), v.environment,
        );
        for (const s of v.steps) db.run("INSERT INTO test_execution_steps (id, execution_id, idx, title, status, error) VALUES (?,?,?,?,?,?)", randomUUID(), id, s.index, s.title, s.status, s.error ?? null);
    });
    return id;
}

/** True when the newest record for this test and environment is already the same "skipped" explanation (no pile of identical rows). */
export function isRepeatedEnvironmentSkip(db: Db, testId: string, environment: string, reason: string): boolean {
    const last = db.get<Row>(`SELECT status, error FROM test_executions WHERE test_case_id = ? AND environment = ? ORDER BY started_at DESC, ${db.dialect.insertionOrder()} DESC LIMIT 1`, testId, environment);
    return last?.status === "skipped" && last.error === reason;
}

export interface EnvironmentEntry {
    status: EnvStatus;
    reason?: string;
    executionId: string;
    ranAt: string;
    durationMs: number | null;
    failedStep?: { index: number; title: string };
    artifacts: Array<{ id: string; kind: string }>;
}

const entryOf = (db: Db, e: Row): EnvironmentEntry => {
    const failed = e.status === "failed" || e.status === "finding" ? db.get<Row>("SELECT idx, title FROM test_execution_steps WHERE execution_id = ? AND status = 'failed' ORDER BY idx LIMIT 1", e.id) : undefined;
    return {
        status: e.status,
        ...(e.error ? { reason: e.error } : {}),
        executionId: e.id,
        ranAt: e.started_at,
        durationMs: e.duration_ms,
        ...(failed ? { failedStep: { index: failed.idx, title: failed.title } } : {}),
        artifacts: db.all<Row>("SELECT id, kind FROM artifacts WHERE execution_id = ? ORDER BY created_at", e.id).map((a) => ({ id: a.id, kind: a.kind })),
    };
};

/** The newest result per environment for one test. */
export function environmentResultsFor(db: Db, testId: string): Record<string, EnvironmentEntry> {
    const out: Record<string, EnvironmentEntry> = {};
    for (const e of db.all<Row>(`SELECT * FROM test_executions WHERE test_case_id = ? AND environment IS NOT NULL ORDER BY started_at DESC, ${db.dialect.insertionOrder()} DESC`, testId)) {
        if (!out[e.environment]) out[e.environment] = entryOf(db, e);
    }
    return out;
}

/** The newest result of every test of a project in one environment (tests never run there are absent). */
export function environmentResultsForProject(db: Db, projectId: string, environment: string): Map<string, EnvironmentEntry> {
    const out = new Map<string, EnvironmentEntry>();
    const rows = db.all<Row>(
        `SELECT e.* FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ? AND e.environment = ? ORDER BY e.started_at DESC, ${db.dialect.insertionOrder("e")} DESC`,
        projectId,
        environment,
    );
    for (const e of rows) if (!out.has(e.test_case_id)) out.set(e.test_case_id, entryOf(db, e));
    return out;
}

// ── schedules that run against an environment ───────────────────────────────

export interface ScheduleEnvironment {
    environment: string | null;
    confirmProduction: boolean;
}

/** The environment a schedule runs against (the columns this feature added to `schedules`); null = the main address. */
export function scheduleEnvironment(db: Db, scheduleId: string): ScheduleEnvironment {
    const r = db.get<Row>("SELECT environment, confirm_production FROM schedules WHERE id = ?", scheduleId);
    return { environment: r?.environment ?? null, confirmProduction: Boolean(r?.confirm_production) };
}

export function setScheduleEnvironment(db: Db, scheduleId: string, v: ScheduleEnvironment): void {
    db.run("UPDATE schedules SET environment = ?, confirm_production = ? WHERE id = ?", v.environment, v.environment && v.confirmProduction ? 1 : 0, scheduleId);
}

/** An environment by name, without touching its secrets (the scheduler has no key at hand and must not need one). */
export function findEnvironment(db: Db, projectId: string, name: string): Environment | undefined {
    const r = db.get<Row>("SELECT * FROM project_environments WHERE project_id = ? AND name = ?", projectId, name);
    return r ? toEnv(r) : undefined;
}
