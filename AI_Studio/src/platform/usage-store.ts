/**
 * AI usage, prices and budgets.
 *
 * Only counts and labels are stored: one row per job x purpose x model x day with sums and counts (never one row per call),
 * the user's price table, the budgets and the record of jobs a budget stopped. No prompt, answer, image or page text ever
 * reaches this file (a test greps the database for sentinel prompt text).
 *
 * Several processes share one database (the API and a separate worker): every write is a single SQL statement and every
 * read goes to the file, so two instances of this class always agree on the totals.
 */
import { BUDGET_TOKENS_SQL, DEFAULT_WARN_PERCENT, dayOf, decideBudget, monthBounds, monthOf, storedPurpose, type CapHit, type Caps, type Price, type UsageBilling, type UsageRow, type Used } from "../engine/llm/usage.js";
import type { Config } from "../config.js";
import type { EngineEvent } from "../engine/context.js";
import { JobMeter } from "../engine/llm/metered.js";
import type { Db } from "./db.js";
import { sqliteDialect } from "./sql-dialect.js";

/** Migration slot 17. */
export const USAGE_MIGRATION = `
CREATE TABLE ai_usage (
    job_id TEXT NOT NULL,
    project_id TEXT NOT NULL,          -- no foreign key on purpose: spend that happened stays counted if the project or job is deleted
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    day TEXT NOT NULL,                 -- UTC day, YYYY-MM-DD
    calls INTEGER NOT NULL DEFAULT 0,
    failed_calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    images INTEGER NOT NULL DEFAULT 0,
    estimated_calls INTEGER NOT NULL DEFAULT 0,   -- calls whose numbers are an estimate (characters / 4)
    PRIMARY KEY (job_id, purpose, model, day)
);
CREATE INDEX idx_ai_usage_day ON ai_usage(day, project_id);
CREATE INDEX idx_ai_usage_project ON ai_usage(project_id, day);
CREATE TABLE ai_prices (
    model TEXT PRIMARY KEY,
    input_per_mtok REAL NOT NULL,
    output_per_mtok REAL NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE ai_settings (
    key TEXT PRIMARY KEY,              -- currency | warn_percent | platform_month_tokens | platform_job_tokens
    value TEXT                         -- NULL = no limit (for the token limits)
);
CREATE TABLE ai_project_budgets (
    project_id TEXT PRIMARY KEY,
    month_tokens INTEGER,
    job_tokens INTEGER,
    updated_at TEXT NOT NULL
);
CREATE TABLE ai_budget_stops (
    job_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    cap TEXT NOT NULL,                 -- job | project | month
    used INTEGER NOT NULL,
    limit_tokens INTEGER NOT NULL,
    at TEXT NOT NULL
);
CREATE INDEX idx_ai_stops_project ON ai_budget_stops(project_id, at);
`;

/**
 * Prompt caching (engine/llm/prompt-cache.ts) adds two counts per usage row and two optional prices. Not a numbered migration: added
 * when missing, idempotently, every time the database opens (db.ts, after the numbered migrations), like the audit tables' `actor`.
 */
export function addCacheColumns(db: import("node:sqlite").DatabaseSync): void {
    const add = (table: string, column: string, type: string) => {
        if (!sqliteDialect.tableExists(db, table)) return;
        if (!sqliteDialect.columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    };
    add("ai_usage", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
    add("ai_usage", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0");
    add("ai_prices", "cached_input_per_mtok", "REAL");
    add("ai_prices", "cache_write_per_mtok", "REAL");
}

/** Limits taken from the environment when nobody has set them in the app. */
export interface UsageDefaults {
    monthlyTokens?: number;
    jobTokens?: number;
}

/** The store for a platform: the server settings (.env) supply the limits nobody has set in the app. */
export function usageStoreFor(db: Db, config: Pick<Config, "AI_MONTHLY_TOKEN_LIMIT" | "AI_JOB_TOKEN_LIMIT">, clock?: () => number): UsageStore {
    return new UsageStore(db, { monthlyTokens: config.AI_MONTHLY_TOKEN_LIMIT, jobTokens: config.AI_JOB_TOKEN_LIMIT }, clock);
}

/** Counts added to the row of one job x purpose x model x day. */
export interface UsageDelta {
    jobId: string;
    projectId: string;
    purpose: string;
    model: string;
    at: Date;
    calls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    images: number;
    estimatedCalls: number;
    /** Of the input tokens: prompt-cache reads and writes (missing = none). */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** Who pays (slot 43); missing = Crowd4Test. A job has one owner, so its rows never mix two. */
    billing?: UsageBilling;
}

export interface PlatformBudget {
    monthlyTokens: number | null;
    jobTokens: number | null;
    warnPercent: number;
    /** "app" = set in the app, "environment" = default from the server's settings, "none" = no limit. */
    monthlySource: "app" | "environment" | "none";
    jobSource: "app" | "environment" | "none";
}
export interface ProjectBudget {
    monthlyTokens: number | null;
    jobTokens: number | null;
}
export interface StopRecord {
    jobId: string;
    projectId: string;
    cap: string;
    used: number;
    limit: number;
    at: string;
}

const SETTING = { currency: "currency", warn: "warn_percent", month: "platform_month_tokens", job: "platform_job_tokens" } as const;

export class UsageStore {
    constructor(
        readonly db: Db,
        private readonly defaults: UsageDefaults = {},
        private readonly clock: () => number = Date.now,
    ) {}

    // ── writing usage ────────────────────────────────────────────────────────

    /** Add counts to the job's row for the day of `at` (created on first use). One statement, so processes never lose an update. */
    addUsage(d: UsageDelta): void {
        this.db.run(
            `INSERT INTO ai_usage (job_id, project_id, purpose, model, day, calls, failed_calls, input_tokens, output_tokens, images, estimated_calls, cache_read_tokens, cache_write_tokens, billing_owner, billing_organization_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(job_id, purpose, model, day) DO UPDATE SET
                calls = calls + excluded.calls, failed_calls = failed_calls + excluded.failed_calls,
                input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
                images = images + excluded.images, estimated_calls = estimated_calls + excluded.estimated_calls,
                cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
            d.jobId,
            d.projectId,
            // The escalation label (routing.ts) is kept as it is; any other unknown label is "other".
            storedPurpose(d.purpose),
            d.model.slice(0, 200),
            dayOf(d.at),
            d.calls,
            d.failedCalls,
            Math.round(d.inputTokens),
            Math.round(d.outputTokens),
            d.images,
            d.estimatedCalls,
            Math.round(d.cacheReadTokens ?? 0),
            Math.round(d.cacheWriteTokens ?? 0),
            d.billing?.owner ?? "crowd4test",
            d.billing?.organizationId ?? null,
        );
    }

    // ── reading usage ────────────────────────────────────────────────────────

    /**
     * Tokens (input + output) a job has used so far, over every process and every day, as the limits count them: prompt-cache reads and
     * writes at their weight (`BUDGET_TOKENS_SQL`, the same rule as the meter's `budgetTokens`). Without caching, exactly input + output.
     */
    jobTokens(jobId: string): number {
        return this.db.get<{ t: number }>(`SELECT COALESCE(SUM(${BUDGET_TOKENS_SQL}), 0) AS t FROM ai_usage WHERE job_id = ?`, jobId)?.t ?? 0;
    }

    /**
     * Tokens used in a calendar month (UTC), for one project, or across projects (counted like `jobTokens`). Across projects means what
     * Crowd4Test pays for: that total is what the platform's monthly limit protects, and a customer's own key is not part of it.
     */
    monthTokens(month: string, projectId?: string): number {
        const { from, to } = monthBounds(month);
        const row = projectId
            ? this.db.get<{ t: number }>(`SELECT COALESCE(SUM(${BUDGET_TOKENS_SQL}), 0) AS t FROM ai_usage WHERE project_id = ? AND day >= ? AND day < ?`, projectId, from, to)
            : this.db.get<{ t: number }>(`SELECT COALESCE(SUM(${BUDGET_TOKENS_SQL}), 0) AS t FROM ai_usage WHERE day >= ? AND day < ? AND billing_owner = 'crowd4test'`, from, to);
        return row?.t ?? 0;
    }

    totalsFor(jobId: string, projectId: string, month: string): Used {
        return { job: this.jobTokens(jobId), project: this.monthTokens(month, projectId), month: this.monthTokens(month) };
    }

    /** Rows summed per day, project, purpose and model in a day range (inclusive), optionally for one project. */
    rows(from: string, to: string, projectId?: string): UsageRow[] {
        const sql = `SELECT day, project_id, purpose, model, billing_owner, SUM(calls) AS calls, SUM(failed_calls) AS failed, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(images) AS img, SUM(estimated_calls) AS est, SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw
                     FROM ai_usage WHERE day >= ? AND day <= ? ${projectId ? "AND project_id = ?" : ""} GROUP BY day, project_id, purpose, model, billing_owner`;
        const found = projectId ? this.db.all(sql, from, to, projectId) : this.db.all(sql, from, to);
        return found.map(usageRowOf);
    }

    /** One job's rows summed per purpose and model. */
    jobRows(jobId: string): UsageRow[] {
        return this.db
            .all(
                `SELECT day, project_id, purpose, model, billing_owner, SUM(calls) AS calls, SUM(failed_calls) AS failed, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(images) AS img, SUM(estimated_calls) AS est, SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw
                 FROM ai_usage WHERE job_id = ? GROUP BY day, project_id, purpose, model, billing_owner`,
                jobId,
            )
            .map(usageRowOf);
    }

    /** Which project a job's usage belongs to (the job may no longer exist), or undefined when it used no AI. */
    projectOfJob(jobId: string): string | undefined {
        return this.db.get<{ project_id: string }>("SELECT project_id FROM ai_usage WHERE job_id = ? LIMIT 1", jobId)?.project_id;
    }

    // ── prices (non-secret, set by the user) ─────────────────────────────────

    /** The cache prices appear only when set, so a price without them keeps its two-number shape. */
    prices(): Map<string, Price> {
        return new Map(
            this.db.all("SELECT model, input_per_mtok, output_per_mtok, cached_input_per_mtok, cache_write_per_mtok FROM ai_prices").map((r) => [
                r.model as string,
                {
                    inputPerMTok: r.input_per_mtok as number,
                    outputPerMTok: r.output_per_mtok as number,
                    ...(r.cached_input_per_mtok !== null ? { cachedInputPerMTok: r.cached_input_per_mtok as number } : {}),
                    ...(r.cache_write_per_mtok !== null ? { cacheWritePerMTok: r.cache_write_per_mtok as number } : {}),
                },
            ]),
        );
    }
    /** Saving a price without cache prices clears them (the form always sends what it shows). */
    setPrice(model: string, price: Price): void {
        this.db.run(
            "INSERT INTO ai_prices (model, input_per_mtok, output_per_mtok, cached_input_per_mtok, cache_write_per_mtok, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(model) DO UPDATE SET input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok, cached_input_per_mtok = excluded.cached_input_per_mtok, cache_write_per_mtok = excluded.cache_write_per_mtok, updated_at = excluded.updated_at",
            model,
            price.inputPerMTok,
            price.outputPerMTok,
            price.cachedInputPerMTok ?? null,
            price.cacheWritePerMTok ?? null,
            new Date(this.clock()).toISOString(),
        );
    }
    deletePrice(model: string): boolean {
        return Number(this.db.run("DELETE FROM ai_prices WHERE model = ?", model).changes) > 0;
    }
    /** The label the user picked for money amounts ("USD", "$", ...). Empty = none: cost is shown as a bare number. */
    currency(): string {
        return this.setting(SETTING.currency) ?? "";
    }
    setCurrency(label: string): void {
        this.putSetting(SETTING.currency, label);
    }

    // ── budgets ──────────────────────────────────────────────────────────────

    private setting(key: string): string | null | undefined {
        const row = this.db.get<{ value: string | null }>("SELECT value FROM ai_settings WHERE key = ?", key);
        return row ? row.value : undefined;
    }
    private putSetting(key: string, value: string | null): void {
        this.db.run("INSERT INTO ai_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    }
    private tokenSetting(key: string, fallback: number | undefined): { value: number | null; source: "app" | "environment" | "none" } {
        const stored = this.setting(key);
        if (stored !== undefined) return { value: stored === null ? null : Number(stored), source: stored === null ? "none" : "app" };
        return fallback !== undefined ? { value: fallback, source: "environment" } : { value: null, source: "none" };
    }

    platformBudget(): PlatformBudget {
        const month = this.tokenSetting(SETTING.month, this.defaults.monthlyTokens);
        const job = this.tokenSetting(SETTING.job, this.defaults.jobTokens);
        const warn = Number(this.setting(SETTING.warn) ?? DEFAULT_WARN_PERCENT);
        return { monthlyTokens: month.value, jobTokens: job.value, warnPercent: Number.isFinite(warn) && warn > 0 ? warn : DEFAULT_WARN_PERCENT, monthlySource: month.source, jobSource: job.source };
    }
    /** `undefined` leaves a value as it is, `null` removes the limit. */
    setPlatformBudget(b: { monthlyTokens?: number | null; jobTokens?: number | null; warnPercent?: number }): void {
        this.db.tx(() => {
            if (b.monthlyTokens !== undefined) this.putSetting(SETTING.month, b.monthlyTokens === null ? null : String(b.monthlyTokens));
            if (b.jobTokens !== undefined) this.putSetting(SETTING.job, b.jobTokens === null ? null : String(b.jobTokens));
            if (b.warnPercent !== undefined) this.putSetting(SETTING.warn, String(b.warnPercent));
        });
    }

    projectBudget(projectId: string): ProjectBudget {
        const r = this.db.get<{ month_tokens: number | null; job_tokens: number | null }>("SELECT month_tokens, job_tokens FROM ai_project_budgets WHERE project_id = ?", projectId);
        return { monthlyTokens: r?.month_tokens ?? null, jobTokens: r?.job_tokens ?? null };
    }
    setProjectBudget(projectId: string, b: { monthlyTokens?: number | null; jobTokens?: number | null }): ProjectBudget {
        const cur = this.projectBudget(projectId);
        const next = { monthlyTokens: b.monthlyTokens === undefined ? cur.monthlyTokens : b.monthlyTokens, jobTokens: b.jobTokens === undefined ? cur.jobTokens : b.jobTokens };
        this.db.run(
            "INSERT INTO ai_project_budgets (project_id, month_tokens, job_tokens, updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET month_tokens = excluded.month_tokens, job_tokens = excluded.job_tokens, updated_at = excluded.updated_at",
            projectId,
            next.monthlyTokens,
            next.jobTokens,
            new Date(this.clock()).toISOString(),
        );
        return next;
    }
    /** Projects that have a limit of their own. */
    projectBudgets(): Array<ProjectBudget & { projectId: string }> {
        return this.db.all("SELECT project_id, month_tokens, job_tokens FROM ai_project_budgets WHERE month_tokens IS NOT NULL OR job_tokens IS NOT NULL").map((r) => ({ projectId: r.project_id, monthlyTokens: r.month_tokens, jobTokens: r.job_tokens }));
    }

    /**
     * The limits that apply to a project's jobs: the platform's monthly cap, the project's monthly cap, and the lower of the two per-job caps.
     * A project on its own key spends its organisation's money, so only its own limits apply (ai-config-store.ts).
     */
    capsFor(projectId: string): { caps: Caps; warnPercent: number } {
        const platform = this.platformBudget();
        const project = this.projectBudget(projectId);
        if (this.onOwnKey(projectId)) return { caps: { month: null, project: project.monthlyTokens, job: project.jobTokens }, warnPercent: platform.warnPercent };
        const jobs = [platform.jobTokens, project.jobTokens].filter((v): v is number => v !== null);
        return { caps: { month: platform.monthlyTokens, project: project.monthlyTokens, job: jobs.length ? Math.min(...jobs) : null }, warnPercent: platform.warnPercent };
    }

    private onOwnKey(projectId: string): boolean {
        return this.db.get("SELECT 1 AS x FROM project_ai_settings WHERE project_id = ? AND mode = 'own'", projectId) !== undefined;
    }

    /**
     * Is AI work for this project already barred for the rest of the month? (Used by schedules, which must not create jobs that
     * cannot run.) Only the monthly caps count here; a per-job cap never bars a whole job from starting.
     */
    monthlyBlock(projectId: string, now: number = this.clock()): CapHit | null {
        const month = monthOf(now);
        const { caps, warnPercent } = this.capsFor(projectId);
        const used: Used = { job: 0, project: this.monthTokens(month, projectId), month: this.monthTokens(month) };
        const d = decideBudget(used, { project: caps.project, month: caps.month }, { warnPercent });
        return d.blocked ?? null;
    }

    // ── jobs a budget stopped ────────────────────────────────────────────────

    recordStop(s: StopRecord): void {
        this.db.run(
            "INSERT INTO ai_budget_stops (job_id, project_id, cap, used, limit_tokens, at) VALUES (?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING",
            s.jobId,
            s.projectId,
            s.cap,
            Math.round(s.used),
            Math.round(s.limit),
            s.at,
        );
    }
    stopOf(jobId: string): StopRecord | null {
        const r = this.db.get("SELECT job_id, project_id, cap, used, limit_tokens, at FROM ai_budget_stops WHERE job_id = ?", jobId);
        return r ? { jobId: r.job_id, projectId: r.project_id, cap: r.cap, used: r.used, limit: r.limit_tokens, at: r.at } : null;
    }
}

/** One summed row; the cache counts are left out when zero, so rows without caching look as they did. */
function usageRowOf(r: Record<string, any>): UsageRow {
    const row: UsageRow = { day: r.day, projectId: r.project_id, purpose: r.purpose, model: r.model, calls: r.calls, failedCalls: r.failed, inputTokens: r.i, outputTokens: r.o, images: r.img, estimatedCalls: r.est };
    if (r.cr) row.cacheReadTokens = r.cr;
    if (r.cw) row.cacheWriteTokens = r.cw;
    if (r.billing_owner === "organization") row.billingOwner = "organization";
    return row;
}

/** The meter for one job (null if the store cannot be opened: a job must never fail because its usage could not be counted). */
export function meterFor(repo: { db: Db; addEvent(jobId: string, e: EngineEvent): void }, config: Pick<Config, "AI_MONTHLY_TOKEN_LIMIT" | "AI_JOB_TOKEN_LIMIT">, job: { id: string; projectId: string }, refreshEvery?: number, billing?: UsageBilling): JobMeter | null {
    try {
        return new JobMeter({ backend: usageStoreFor(repo.db, config), jobId: job.id, projectId: job.projectId, emit: (e) => repo.addEvent(job.id, e), refreshEvery, billing });
    } catch (e) {
        console.error("[usage] AI usage is not being counted for this job:", e instanceof Error ? e.message : e);
        return null;
    }
}

/**
 * The plain reason a run that needs the AI model should not start, or null when it may. Only the monthly limits bar a whole run
 * (a per-job limit only bounds one job), and runs that only re-run existing tests never ask.
 */
export function aiSkipReason(store: UsageStore, projectId: string): string | null {
    const hit = store.monthlyBlock(projectId);
    if (!hit) return null;
    const scope = hit.cap === "project" ? "this project" : "this month";
    return `Skipped: the AI token limit for ${scope} was reached, so a new analysis could not run. Raise the limit in Settings or wait until next month. Runs that only re-run existing tests are not affected.`;
}
