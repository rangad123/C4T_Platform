import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { AGENTS_MIGRATION } from "./agent-store.js";
import { BLOCKS_MIGRATION } from "./block-store.js";
import { CLEANUP_MIGRATION } from "./cleanup-store.js";
import { CUSTOM_MIGRATION } from "./custom-script-store.js";
import { DEVICE_FARM_MIGRATION } from "./device-farm-store.js";
import { SPEC_VERSIONS_MIGRATION } from "./spec-version-store.js";
import { DRIFT_MIGRATION } from "./drift-store.js";
import { EVAL_MIGRATION } from "./eval-store.js";
import { ENVIRONMENTS_MIGRATION } from "./environments-store.js";
import { FRAMEWORK_SETTINGS_MIGRATION } from "./framework-settings-store.js";
import { HEALING_MIGRATION } from "./healing-store.js";
import { IDENTITY_MIGRATION } from "./identity-store.js";
import { LIVE_SESSION_MIGRATION } from "./live-session-store.js";
import { LOCATORS_MIGRATION } from "./locator-store.js";
import { MANUAL_MIGRATION } from "./manual-case-store.js";
import { MEMORY_MIGRATION } from "./memory-store.js";
import { PERFORMANCE_MIGRATION } from "./perf-store.js";
import { QUARANTINE_MIGRATION } from "./quarantine-store.js";
import { RETENTION_MIGRATION } from "./retention-store.js";
import { RUNBOOKS_MIGRATION } from "./runbook-store.js";
import { SESSIONS_MIGRATION } from "./session-store.js";
import { SCHEDULES_MIGRATION } from "./schedule-schema.js";
import { addCacheColumns, USAGE_MIGRATION } from "./usage-store.js";
import { WEB_PAGES_MIGRATION } from "./test-data-reset-store.js";
import { addActorColumns, USERS_MIGRATION } from "./user-store.js";
import { SECURITY_MIGRATION } from "../security/store.js";
import { MEMBERSHIP_MIGRATION, PROJECT_ACCESS_MIGRATION } from "./project-access-store.js";
import { SECURITY_SIGNIN_MIGRATION } from "../security/extras.js";
import { PROJECT_SETUP_MIGRATION } from "./project-setup.js";
import { SHARED_STATE_MIGRATION } from "./shared-state.js";
import { sqliteDialect, type Dialect } from "./sql-dialect.js";
import { sqliteSql, type Sql } from "./sql.js";

// Loaded via require so bundlers/test runners that strip the `node:` prefix don't break `node:sqlite`.
const { DatabaseSync: DatabaseSyncImpl } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const MIGRATIONS: string[] = [
    /* 1 */ `
CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL
);
CREATE TABLE projects (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, description TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE applications (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url TEXT NOT NULL, origin TEXT NOT NULL,
    config_json TEXT NOT NULL,            -- non-secret generation settings (scope, limits, targets...)
    credentials_enc TEXT,                 -- AES-256-GCM encrypted JSON {username,password,apiToken,apiAuthHeader}
    app_model_json TEXT,                  -- latest discovered ApplicationModel
    model_updated_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE environments (
    id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    name TEXT NOT NULL, base_url TEXT NOT NULL, api_base_url TEXT, variables_json TEXT, is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE test_suites (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, slug TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_id, slug)
);
CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    status TEXT NOT NULL,                 -- QUEUED DISCOVERING ANALYZING PLANNING GENERATING VALIDATING COMPLETED PARTIALLY_COMPLETED FAILED
    options_json TEXT NOT NULL, progress_json TEXT NOT NULL, counters_json TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON generation_jobs(status, created_at);
CREATE TABLE test_cases (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    suite_id TEXT NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE, job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
    test_key TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL, priority TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    validation_status TEXT NOT NULL,      -- PENDING VALIDATING VALIDATED FAILED_VALIDATION NEEDS_REVIEW
    validation_reason TEXT, framework TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    spec_json TEXT NOT NULL,              -- canonical TestSpecification (source of truth)
    generation_meta_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (project_id, test_key)
);
CREATE INDEX idx_tests_project ON test_cases(project_id, validation_status);
CREATE TABLE generated_scripts (
    id TEXT PRIMARY KEY, test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    framework TEXT NOT NULL, filename TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
    storage_path TEXT, version INTEGER NOT NULL, is_current INTEGER NOT NULL DEFAULT 1, executable INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_scripts_test ON generated_scripts(test_case_id, is_current);
CREATE TABLE test_executions (
    id TEXT PRIMARY KEY, test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    script_id TEXT REFERENCES generated_scripts(id) ON DELETE SET NULL, job_id TEXT,
    attempt INTEGER NOT NULL, status TEXT NOT NULL, duration_ms INTEGER, error TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE test_execution_steps (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES test_executions(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, error TEXT
);
CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    role TEXT NOT NULL, subject TEXT, status TEXT NOT NULL, summary TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE agent_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    tool TEXT NOT NULL, args_json TEXT, ok INTEGER NOT NULL, observation TEXT, created_at TEXT NOT NULL
);
CREATE TABLE agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_events_job ON agent_events(job_id, id);
CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, job_id TEXT, test_case_id TEXT, execution_id TEXT,
    kind TEXT NOT NULL, path TEXT NOT NULL, size INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_test ON artifacts(test_case_id);
`,
    /* 2 */ `
-- Worker identity holding the lease; guards against a stalled worker writing to a reclaimed job.
ALTER TABLE generation_jobs ADD COLUMN lease_owner TEXT;
`,
    // Slots 3-5 are owned by feature modules (one each) so parallel work never edits the same entry.
    /* 3: cross-browser / responsive variants */ `
-- Which browser / screen size a run used. NULL = the base validation run (desktop Chrome), so everything
-- written before this feature keeps its meaning. Variant rows carry status passed | failed | unavailable | skipped.
ALTER TABLE test_executions ADD COLUMN variant TEXT;
CREATE INDEX idx_exec_variant ON test_executions(test_case_id, variant);
`,
    /* 4: schedules, alert channels, alert log, run summaries (schema lives in schedule-schema.ts) */ SCHEDULES_MIGRATION,
    /* 5: issue-tracker integrations and issue links */ `
CREATE TABLE integrations (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                   -- github | jira
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,            -- non-secret settings (owner/repo, base URL, project key, account email...)
    secret_enc TEXT NOT NULL,             -- AES-256-GCM encrypted JSON {token}; never returned by the API
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_integrations_project ON integrations(project_id);
CREATE TABLE issue_links (
    id TEXT PRIMARY KEY, test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    -- Kept (set to NULL) when an integration is removed: the issue still exists in the tracker.
    integration_id TEXT REFERENCES integrations(id) ON DELETE SET NULL,
    provider TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_issue_links_test ON issue_links(test_case_id);
CREATE UNIQUE INDEX idx_issue_links_once ON issue_links(test_case_id, integration_id) WHERE integration_id IS NOT NULL;
`,
    /* 6: page-speed metrics (schema lives in perf-store.ts) */ PERFORMANCE_MIGRATION,
    /* 7: API surface snapshots and contract findings */ `-- reserved`,
    /* 8: named test accounts, encrypted (schema lives in identity-store.ts) */ IDENTITY_MIGRATION,
    /* 9: API shape snapshots for drift detection (schema lives in drift-store.ts) */ DRIFT_MIGRATION,
    /* 10: site memory, structural notes per project and application (schema lives in memory-store.ts) */ MEMORY_MIGRATION,
    /* 11: named environments, test data sets, per-environment results (schema lives in environments-store.ts) */ ENVIRONMENTS_MIGRATION,
    /* 12: locator-healing proposals and deploy trigger tokens (schema lives in healing-store.ts / trigger-store.ts) */ HEALING_MIGRATION,
    /* 13: created-record ledger for test-data cleanup (schema lives in cleanup-store.ts) */ CLEANUP_MIGRATION,
    /* 14: runbooks and their runs (schema lives in runbook-store.ts) */ RUNBOOKS_MIGRATION,
    /* 15: manual test cases, case runs and release sign-offs (schema lives in manual-case-store.ts) */ MANUAL_MIGRATION,
    /* 16: retention policy and pruning log (schema lives in retention-store.ts) */ RETENTION_MIGRATION,
    /* 17: AI usage, prices and budgets (schema lives in usage-store.ts) */ USAGE_MIGRATION,
    /* 18: flaky-test quarantine and its history (schema lives in quarantine-store.ts) */ QUARANTINE_MIGRATION,
    /* 19: runner agents: tokens, registry, task queue, uploaded files (schema lives in agent-store.ts) */ AGENTS_MIGRATION,
    /* 20: object repository: named locators and their uses (schema lives in locator-store.ts) */ LOCATORS_MIGRATION,
    /* 21: per-project framework settings (schema lives in framework-settings-store.ts) */ FRAMEWORK_SETTINGS_MIGRATION,
    /* 22: custom scripts: take-over state, script versions, helper modules (schema lives in custom-script-store.ts) */ CUSTOM_MIGRATION,
    /* 23: earlier versions of a test's steps from the step editor (schema lives in spec-version-store.ts) */ SPEC_VERSIONS_MIGRATION,
    /* 24: audit trail of sessions driven step by step (schema lives in live-session-store.ts) */ LIVE_SESSION_MIGRATION,
    /* 25: reusable step groups ("blocks") per project (schema lives in block-store.ts) */ BLOCKS_MIGRATION,
    /* 26: people and access: accounts, sessions, personal tokens, invites, activity, SSO settings (schema lives in user-store.ts) */ USERS_MIGRATION,
    /* 27: device farms: provider connections, where phone tests run, farm sessions (schema lives in device-farm-store.ts) */ DEVICE_FARM_MIGRATION,
    /* 28: hard sign-ins: saved signed-in sessions, the test mailbox, forwarded mail (schema lives in session-store.ts) */ SESSIONS_MIGRATION,
    /* 29: evaluation runs of the AI tester (schema lives in eval-store.ts) */ EVAL_MIGRATION,
    /* 30: test files for upload steps and test data reset hooks (schema lives in test-data-reset-store.ts) */ WEB_PAGES_MIGRATION,
    /* 31: security assessment: applications, authorizations, assessments, findings, history, audit (schema lives in src/security/store.ts) */ SECURITY_MIGRATION,
    /* 32: per-project access: "all projects" or "only these projects" with a role in each (schema lives in project-access-store.ts) */ PROJECT_ACCESS_MIGRATION,
    /* 33: security assessment: saved sign-in used, sensitive workflows, uploaded API documents (schema lives in src/security/extras.ts) */ SECURITY_SIGNIN_MIGRATION,
    /* 34: project members with the Project Admin flag, Crowd4Test accounts and organizations (schema lives in project-access-store.ts) */ MEMBERSHIP_MIGRATION,
    /* 35: project platforms, testing modes, code engines and the linked Crowd4Test project (schema lives in project-setup.ts) */ PROJECT_SETUP_MIGRATION,
    /* 36: one version number per test and framework, so a concurrent writer fails and retries instead of duplicating it (Repo.addScript) */ `
-- Versions are counted per framework (Repo.addScript, backup restore), so (test_case_id, version) alone repeats for a test with two
-- frameworks. Both writers take MAX + 1 under SQLite's single writer, so existing data has no duplicates.
CREATE UNIQUE INDEX idx_scripts_version ON generated_scripts(test_case_id, framework, version);
`,
    /* 37: state every process must see, out of DATA_DIR: the worker heartbeat and the runner update settings (schema lives in shared-state.ts) */ SHARED_STATE_MIGRATION,
];

/** Slots that were reserved before their SQL existed: the slot number and a table only that slot creates. */
const LATE_FILLED_SLOTS: ReadonlyArray<{ slot: number; table: string }> = [
    { slot: 14, table: "runbooks" },
    { slot: 22, table: "custom_tests" },
    { slot: 23, table: "spec_versions" },
];

export type Row = Record<string, any>;

export class Db {
    readonly raw: DatabaseSync;
    /** The SQL that differs between SQLite and PostgreSQL (sql-dialect.ts). */
    readonly dialect: Dialect = sqliteDialect;
    /** The asynchronous interface on this same connection (sql.ts): stores move to it one group at a time, beside these methods. */
    get sql(): Sql {
        return sqliteSql(this);
    }

    constructor(file: string) {
        if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
        this.raw = new DatabaseSyncImpl(file);
        this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        this.migrate();
    }

    private migrate(): void {
        this.raw.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
        const row = this.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
        let current = row.v ?? 0;
        while (current < MIGRATIONS.length) {
            this.raw.exec("BEGIN");
            try {
                this.raw.exec(MIGRATIONS[current]!);
                this.raw.prepare("INSERT INTO schema_version (version) VALUES (?)").run(current + 1);
                this.raw.exec("COMMIT");
            } catch (e) {
                this.raw.exec("ROLLBACK");
                throw e;
            }
            current++;
        }
        this.repairSkippedMigrations();
        // Older audit tables say who acted (people and access, user-store.ts); after the repair, so a repaired table gets it too.
        addActorColumns(this.raw);
        // Prompt-cache counts and prices on the AI usage tables (usage-store.ts); idempotent, no numbered migration.
        addCacheColumns(this.raw);
    }

    /**
     * A database that was opened while a slot was still a reserved placeholder has that slot's version recorded, so its real SQL
     * never ran when it was written later (slots 14, 22 and 23 were filled in after reservation). For those slots, when the
     * slot's main table is missing, none of its tables exist (each slot ran in one transaction), so the SQL runs now.
     */
    private repairSkippedMigrations(): void {
        for (const { slot, table } of LATE_FILLED_SLOTS) {
            if (this.dialect.tableExists(this.raw, table)) continue;
            this.raw.exec("BEGIN");
            try {
                this.raw.exec(MIGRATIONS[slot - 1]!);
                this.raw.exec("COMMIT");
            } catch (e) {
                this.raw.exec("ROLLBACK");
                throw e;
            }
        }
    }

    run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint } {
        return this.raw.prepare(sql).run(...params);
    }
    get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
        return this.raw.prepare(sql).get(...params) as T | undefined;
    }
    all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
        return this.raw.prepare(sql).all(...params) as T[];
    }
    tx<T>(fn: () => T): T {
        this.raw.exec("BEGIN IMMEDIATE");
        try {
            const out = fn();
            this.raw.exec("COMMIT");
            return out;
        } catch (e) {
            this.raw.exec("ROLLBACK");
            throw e;
        }
    }
    close(): void {
        this.raw.close();
    }
}

/** How many migrations this code knows: GET /readyz compares the database's recorded version with it (platform/ops/health.ts). */
export const knownSchemaVersion = (): number => MIGRATIONS.length;
