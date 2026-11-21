/**
 * Applies a retention policy: works out what may go (preview), removes it (run), and does the daily pass from the scheduler.
 *
 * Safety, in the order it matters:
 *  - nothing is removed unless the project's policy is enabled (on by default: failed runs' files after 7 days, passed runs' records
 *    after 30, passed runs' traces and recordings at the next pass); a manual run also needs the caller to say `confirm`;
 *  - a project with a job in flight is never pruned (the job is writing the very files and rows this reads);
 *  - preview and run call the same `planFor`, so they cannot disagree about which files are involved;
 *  - only files named by artifact rows of the project are touched, each resolved inside the artifact folder, as a plain file
 *    (a link or a folder is skipped), one by one; a file that cannot be removed is logged and skipped, never fatal;
 *  - the artifact row stays, marked pruned, and so do the execution rows: run history, trends and flaky detection do not change;
 *  - what the run rows say about the application expires with the files, in the same pass: see
 *    RUN_DETAILS below for every column of the run-history tables and what happens to it;
 *  - findings, their history, issues, releases and tests are never changed or deleted here (a finding whose run's files expired keeps
 *    every field and says the evidence expired).
 *
 * RUN_DETAILS: the run-history tables, column by column, at a run's expiry (passed: keepDays, any other outcome: keepFailedDays).
 *   test_executions       kept: id, test_case_id, script_id, job_id, attempt, status, duration_ms, started_at, finished_at, variant,
 *                         environment (a name), test_version_id. Cleared: error (the failure message quotes page text, addresses, requests),
 *                         except a skipped variant or environment row's reason: the platform's own words for why it did not run, which
 *                         the next run compares with to avoid writing the same skipped row again (skipReason).
 *   first deploy          for GRACE_DAYS after the first start of a version with retention (recorded once in auth_settings, key
 *                         RETENTION_START_KEY, never moved by a restart or a later deployment), files stored before that start are kept
 *                         (rules.ts `graceFrom`), and so is the text of every record dated before it (run and step errors, run
 *                         summaries, job errors and events, test reasons, agent runs: `graceHolds`); the preview counts both
 *                         (`grace`, `graceRecords`) and says when the grace ends (`graceUntil`).
 *   unknown times         a run whose start cannot be read keeps its files and details (rules.ts `undated`); the preview says so.
 *   test_execution_steps  kept: id, execution_id, idx, title (the test's own step wording), status. Cleared: error.
 *   artifacts             kept: the row (id, kind, size, run, test, the store key), marked pruned_at / pruned_reason; the file is deleted.
 *                         An agent run's screenshots (vision-shot, no test run) expire as a failed run's files, counted from their job.
 *                         The evidence file is where requests, console text, the passing-run footprint (pages and endpoints touched) and so
 *                         the coverage facts of selection live: those readers skip a pruned row, so nothing derived from it survives.
 *   run_summaries         kept: counts, pass rate, timing, test keys and titles, statuses. Cleared after keepFailedDays: each result's
 *                         "why", each change's "reason" and the job error (failure text). Results older than the latest runs were
 *                         already emptied by trends.ts.
 *   perf_metrics          kept: numbers only (metric, value, unit, budget), the speed trend; nothing about page content.
 *   in memory             the related-issue cache (sentry/related.ts) is dropped for the project after a pass that changed anything.
 *
 * OTHER_RECORDS: the same pass and the same age rules (passed: keepDays, any other outcome: keepFailedDays)
 * replace the failure text other records hold with "Details expired." (clearOtherRecords); the rows stay:
 *   agent_events          of a finished job (COMPLETED counts as passed), warn and error level only: message -> "Details expired.",
 *                         every error and url field removed from data_json; stage, kind, level, time and counts stay.
 *   generation_jobs       of such a job: error -> "Details expired.", except the fixed errors code reads (keptJobError: "Cancelled", which
 *                         flaky detection, quarantine, the CI status and the job page read; the "Nothing ran: " prefix the dashboard and
 *                         the run summaries read): those say nothing about the application and stay as they are.
 *   test_cases            validation_reason, aged by the later of the test's latest base run (no variant, no environment) and the
 *                         reason's own last change (a reason written without a run is as young as that write; no run counts as failed,
 *                         else the run's outcome decides the period): cut to the step title
 *                         and the head code parses (family prefixes, severity tags; rules.ts expiredReason), else "Details expired.".
 *                         Not for a test that needs review: that reason is the finding itself, kept until someone decides on it.
 *   agent_runs            of such a job (the authoring agents' work): summary -> "Details expired."; role, subject, status and times stay.
 *   objective_runs        a finished or stopped agent run (verdict passed counts as passed): reasoning and stop_reason -> "Details
 *                         expired." (stop_reason "A person stopped this run." stays: agent-run.ts reads it); objective, verdict, state,
 *                         approvals, counts and times stay. The preview counts these (`agentRuns`) with the same code the pass runs.
 *   objective_run_steps   of a finished or stopped agent run (verdict passed counts as passed): detail -> "Details expired.", url cut to
 *                         origin and path. The step's wording, its saved step (drafts are made from it) and the run's verdict stay.
 * Never touched: security findings and their history, Activity, quarantine and healing decisions, approvals, releases, issues.
 */
import { formatBytes, previewSentence } from "../engine/retention/format.js";
import { retentionLimits, type RetentionPolicy } from "../engine/retention/policy.js";
import { DAY_MS, DETAILS_EXPIRED, GRACE_DAYS, graceHolds, expiredEventData, expiredReason, isExpired, originPath, planPrune, type PrunePlan, type RetentionArtifact, type RetentionExecution } from "../engine/retention/rules.js";
import type { FindingState } from "../engine/findings/lifecycle.js";
import type { Platform } from "./bootstrap.js";
import { wasCancelled } from "./cancel-summary.js";
import type { Db, Row } from "./db.js";
import { HttpError } from "./http-error.js";
import type { JobRow } from "./repo.js";
import { LocalDiskStore } from "./object-store.js";
import { RetentionStore } from "./retention-store.js";
import { isNothingRan } from "./review-store.js";
import { activeJobOf } from "./scheduler.js";
import { relatedCache } from "./sentry/related.js";
import { forgetUsage } from "./storage-usage.js";

const SAMPLE = 20;
/** At most one scheduled run per project in this long. */
export const SCHEDULED_EVERY_MS = 24 * 60 * 60 * 1000;

/** auth_settings key of the first start with retention (the start of the first-deploy grace). Written once, never moved. */
export const RETENTION_START_KEY = "retention.first_deploy";

/**
 * The recorded first start with retention (epoch ms), or undefined when none was recorded.
 * A row that is there but cannot be read as a time (damaged) must not mean "no grace": that would fail towards deleting. It is read as
 * "the grace starts now" and rewritten with that time, so the grace then runs its GRACE_DAYS from the repair and every later read agrees.
 */
export function retentionStart(db: Db): number | undefined {
    const r = db.get<Row>("SELECT value_json FROM auth_settings WHERE key = ?", RETENTION_START_KEY);
    if (!r) return undefined;
    let t = NaN;
    try {
        const v: unknown = JSON.parse(String(r.value_json));
        if (typeof v === "string") t = Date.parse(v);
    } catch {
        /* damaged: repaired below */
    }
    if (Number.isFinite(t) && t > 0) return t;
    const now = Date.now();
    const at = new Date(now).toISOString();
    // Only the damaged value is replaced: a second process that repaired it first keeps its time (read again below).
    db.run("UPDATE auth_settings SET value_json = ?, updated_at = ? WHERE key = ? AND (value_json = ? OR value_json IS NULL)", JSON.stringify(at), at, RETENTION_START_KEY, String(r.value_json ?? ""));
    const again = db.get<Row>("SELECT value_json FROM auth_settings WHERE key = ?", RETENTION_START_KEY);
    try {
        const v: unknown = JSON.parse(String(again?.value_json));
        const fixed = typeof v === "string" ? Date.parse(v) : NaN;
        if (Number.isFinite(fixed) && fixed > 0) return fixed;
    } catch {
        /* could not be rewritten: still held from now */
    }
    return now;
}

/**
 * Record the first start with retention, once: a restart, a later deployment or a second process finds the row and leaves it (INSERT ...
 * ON CONFLICT DO NOTHING; a damaged row is repaired by `retentionStart`, never left unread). Called when the platform starts and before each scheduled pass. Returns the recorded start.
 */
export function recordRetentionStart(db: Db, now = Date.now()): number {
    const at = new Date(now).toISOString();
    db.run("INSERT INTO auth_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING", RETENTION_START_KEY, JSON.stringify(at), at);
    return retentionStart(db) ?? now;
}

const ms = (iso: string | null | undefined): number => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? 0 : t;
};

export const retentionStore = (p: Platform): RetentionStore => new RetentionStore(p.db, p.config.RETENTION_DEFAULT_DAYS, retentionLimits(p.config));

export interface PlannedFile {
    id: string;
    kind: string;
    size: number;
    path: string;
    reason: string;
    /** The test key (WEB-001...) the file belongs to, when it belongs to one. */
    test: string | null;
}

export interface FullPlan {
    plan: PrunePlan;
    /** The files to remove, with the paths the run needs (never sent to a client). */
    files: PlannedFile[];
    /** Run summaries (job ids) past the failed-run period that still hold failure text. */
    summaries: string[];
    /** Other records whose details the pass replaces (otherRecordWrites: the same code the pass runs). */
    records: number;
    /** Of those, agent runs (the authoring agents' summaries and agent runs' reasoning). */
    agentRuns: number;
    /** Records (runs, run summaries, other records) past their period whose text the first-deploy grace keeps for now. */
    graceRecords: number;
    /** When the first-deploy grace ends (epoch ms); null when it is over or was never recorded. */
    graceUntil: number | null;
}

/** "No grace" for the functions that default to the recorded start (0 is never a known time). */
const NO_GRACE = 0;

const DETAIL_KEYS = { results: "why", changes: "reason" } as const;

/**
 * Job errors that are fixed values code reads, never failure text (every reader of generation_jobs.error was checked): "Cancelled"
 * (cancel-summary.ts NOT_FROM_CANCELLED_JOB for flaky detection and quarantine, wasCancelled, trigger-services, runbook-runner,
 * schedule-services, routes/plans, dashboard, the web labels) and the "Nothing ran: " prefix (review-store isNothingRan, trends,
 * dashboard, the web labels). Expiry leaves them as they are.
 */
export const keptJobError = (status: string, error: string | null): boolean => error !== null && (wasCancelled({ status: status as JobRow["status"], error }) || isNothingRan({ status, error }));

/** A skipped variant or environment row's reason (the platform's words, compared on the next run): not cleared at expiry. SQL over a row alias. */
const skipReason = (e: string) => `(${e}.status = 'skipped' AND (${e}.variant IS NOT NULL OR ${e}.environment IS NOT NULL))`;
const hasText = (v: unknown) => typeof v === "string" && v.length > 0;

/** A run summary's JSON without its failure text; undefined when it has none. */
function strippedSummary(resultsJson: string, diffJson: string): { results: string; diff: string } | undefined {
    let results: unknown;
    let diff: unknown;
    try {
        results = JSON.parse(resultsJson);
        diff = JSON.parse(diffJson);
    } catch {
        return undefined;
    }
    let changed = false;
    const strip = (x: unknown, key: string) => {
        if (x && typeof x === "object" && key in (x as Record<string, unknown>)) {
            delete (x as Record<string, unknown>)[key];
            changed = true;
        }
    };
    if (Array.isArray(results)) for (const r of results) strip(r, DETAIL_KEYS.results);
    if (diff && typeof diff === "object") {
        const d = diff as Record<string, unknown>;
        for (const v of Object.values(d)) if (Array.isArray(v)) for (const c of v) strip(c, DETAIL_KEYS.changes);
        if (hasText(d.jobError)) {
            d.jobError = null;
            changed = true;
        }
    }
    return changed ? { results: JSON.stringify(results), diff: JSON.stringify(diff) } : undefined;
}

function expiredSummaries(p: Platform, projectId: string, policy: RetentionPolicy, now: number, graceFrom: number | undefined = retentionStart(p.db)): Array<{ jobId: string; results: string; diff: string }> {
    const cutoff = new Date(now - policy.keepFailedDays * DAY_MS).toISOString();
    return p.db
        .all<Row>("SELECT job_id, results_json, diff_json, finished_at FROM run_summaries WHERE project_id = ? AND finished_at < ?", projectId, cutoff)
        .filter((r) => !graceHolds(ms(r.finished_at), graceFrom, now))
        .flatMap((r) => {
            const s = strippedSummary(String(r.results_json ?? "[]"), String(r.diff_json ?? "{}"));
            return s ? [{ jobId: r.job_id as string, ...s }] : [];
        });
}

/** A finding in one of these states is closed: its evidence is kept keepFailedDays more, then expires as usual (rules.ts finding hold). */
export const CLOSED_FINDING_STATES: readonly FindingState[] = ["reported", "duplicate", "not_a_bug"];

/**
 * The finding hold's input: each test with a finding -> null while any of its findings is open, else when the last one was closed (its
 * move into the closed state; a finding with no such event counts from its last update).
 */
function findingHolds(p: Platform, projectId: string): Map<string, number | null> {
    const closed = CLOSED_FINDING_STATES.map(() => "?").join(",");
    const rows = p.db.all<Row>(
        `SELECT f.test_id, f.state IN (${closed}) AS closed,
                COALESCE((SELECT MAX(e.at) FROM finding_events e WHERE e.finding_id = f.id AND e.to_state = f.state), f.updated_at) AS closed_at
           FROM candidate_findings f WHERE f.project_id = ? AND f.test_id IS NOT NULL`,
        ...CLOSED_FINDING_STATES,
        projectId,
    );
    const out = new Map<string, number | null>();
    for (const r of rows) {
        const test = r.test_id as string;
        const at = Number(r.closed) ? ms(r.closed_at as string) : null;
        const was = out.get(test);
        out.set(test, at === null || was === null ? null : Math.max(at, was ?? 0));
    }
    return out;
}

/** Everything the rules need, read from the database for one project. */
export function planFor(p: Platform, projectId: string, policy: RetentionPolicy, now: number): FullPlan {
    const execRows = p.db.all<Row>(
        `SELECT e.id, e.test_case_id, e.status, e.started_at,
                CASE WHEN (e.error IS NOT NULL AND NOT ${skipReason("e")}) OR EXISTS (SELECT 1 FROM test_execution_steps s WHERE s.execution_id = e.id AND s.error IS NOT NULL) THEN 1 ELSE 0 END AS details
           FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ?`,
        projectId,
    );
    const executions: RetentionExecution[] = execRows.map((r) => ({ id: r.id, startedAt: ms(r.started_at), passed: r.status === "passed", details: Number(r.details) === 1, testId: r.test_case_id ?? null }));
    const startedAt = new Map(executions.map((e) => [e.id, e.startedAt]));
    const testOf = new Map(executions.map((e) => [e.id, e.testId]));

    // An agent run's screenshots have no test run: their age counts from the job they belong to (rules.ts, rule 2).
    const rows = p.db.all<Row>(
        `SELECT a.id, a.kind, a.path, a.size, a.execution_id, a.test_case_id, a.created_at, COALESCE(j.started_at, j.created_at) AS job_at
           FROM artifacts a LEFT JOIN generation_jobs j ON j.id = a.job_id WHERE a.project_id = ? AND a.pruned_at IS NULL`,
        projectId,
    );
    const pathOf = new Map(rows.map((r) => [r.id as string, { path: r.path as string, test: (r.test_case_id as string | null) ?? null }]));
    const artifacts: RetentionArtifact[] = rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        size: Number(r.size ?? 0),
        executionId: r.execution_id ?? null,
        at: (r.execution_id ? startedAt.get(r.execution_id) : undefined) ?? (ms(r.job_at) || ms(r.created_at)),
        createdAt: ms(r.created_at),
        testId: (r.test_case_id as string | null) ?? (r.execution_id ? (testOf.get(r.execution_id) ?? null) : null),
    }));

    const graceFrom = retentionStart(p.db);
    const plan = planPrune({ now, policy, executions, artifacts, findingHolds: findingHolds(p, projectId), ...(graceFrom !== undefined ? { graceFrom } : {}) });
    const tests = new Map(p.db.all<Row>("SELECT id, test_key FROM test_cases WHERE project_id = ?", projectId).map((r) => [r.id as string, r.test_key as string]));
    const other = otherRecordWrites(p, projectId, policy, now, graceFrom);
    const summaries = expiredSummaries(p, projectId, policy, now, graceFrom).map((x) => x.jobId);
    // What the grace holds back: the same code with no grace, minus what it lists with it.
    const held = graceFrom === undefined ? 0 : plan.graceRuns + (expiredSummaries(p, projectId, policy, now, NO_GRACE).length - summaries.length) + (otherRecordWrites(p, projectId, policy, now, NO_GRACE).writes.length - other.writes.length);
    const graceUntil = graceFrom !== undefined && now - graceFrom <= GRACE_DAYS * DAY_MS ? graceFrom + GRACE_DAYS * DAY_MS : null;
    const files = plan.prune.map((x) => ({ id: x.id, kind: x.kind, size: x.size, path: pathOf.get(x.id)?.path ?? "", reason: x.reason, test: pathOf.get(x.id)?.test ? (tests.get(pathOf.get(x.id)!.test!) ?? null) : null }));
    return { plan, files, summaries, records: other.writes.length, agentRuns: other.agentRuns, graceRecords: held, graceUntil };
}

/** The sentence about run details, or undefined when there are none to clear. */
export function detailsSentence(runs: number, summaries: number): string | undefined {
    if (runs === 0 && summaries === 0) return undefined;
    const what = [runs ? `${runs === 1 ? "1 run" : `${runs} runs`}` : "", summaries ? `${summaries === 1 ? "1 run summary" : `${summaries} run summaries`}` : ""].filter(Boolean).join(" and ");
    return `The failure details of ${what} past the retention period are cleared too. The runs stay in the history with their outcome and timing.`;
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

/** What the API shows for a plan: counts, sizes, dates and the first few files as ids (never a path on this computer). */
export function publicPlan(policy: RetentionPolicy, full: FullPlan) {
    const { plan } = full;
    return {
        enabled: policy.enabled,
        files: plan.files,
        bytes: plan.bytes,
        size: formatBytes(plan.bytes),
        oldest: iso(plan.oldest),
        newest: iso(plan.newest),
        byKind: plan.byKind,
        byReason: plan.byReason,
        kept: plan.protectedFiles,
        sentence: previewSentence(plan, policy),
        runs: plan.expiredRuns.length,
        summaries: full.summaries.length,
        details: detailsSentence(plan.expiredRuns.length, full.summaries.length) ?? null,
        sample: full.files.slice(0, SAMPLE).map((f) => ({ id: f.id, kind: f.kind, size: f.size, test: f.test })),
        sampleOf: Math.min(SAMPLE, plan.files),
        records: full.records,
        agentRuns: full.agentRuns,
        grace: plan.grace,
        graceNote: plan.grace ? `${plan.grace === 1 ? "1 file stored" : `${plan.grace} files stored`} before retention was first switched on ${plan.grace === 1 ? "is" : "are"} kept for the first ${GRACE_DAYS} days.` : null,
        graceRecords: full.graceRecords,
        graceRecordsNote: full.graceRecords ? `The details of ${full.graceRecords === 1 ? "1 record" : `${full.graceRecords} records`} from before retention was first switched on are kept for the first ${GRACE_DAYS} days too.` : null,
        graceUntil: iso(full.graceUntil),
        heldBytes: plan.heldBytes,
        sizeLimitNote: policy.maxArtifactMB && plan.heldBytes > 0 ? `The ${policy.maxArtifactMB} MB size limit does not count the ${formatBytes(plan.heldBytes)} of files kept ${plan.grace && plan.undated ? "for the first days or for an unreadable time" : plan.grace ? `for the first ${GRACE_DAYS} days` : plan.undated ? "for an unreadable time" : "as a finding's evidence"}, so they do not push newer files out.` : null,
        findingHeld: plan.findingHeld,
        findingHeldNote: plan.findingHeld ? `${plan.findingHeld === 1 ? "1 file is" : `${plan.findingHeld} files are`} kept as the evidence of a finding that is still open, or was closed less than ${policy.keepFailedDays} days ago.` : null,
        undated: plan.undated,
        undatedNote: plan.undated ? `${plan.undated === 1 ? "1 file is" : `${plan.undated} files are`} kept because the time of ${plan.undated === 1 ? "its run" : "their runs"} could not be read.` : null,
    };
}

export interface RunResult {
    files: number;
    bytes: number;
    errors: number;
    errorSample: string | null;
    /** Runs and run summaries whose failure details were cleared. */
    runs: number;
    summaries: number;
    /** Other records (job events, job errors, test reasons, agent runs and their steps) whose details were replaced. */
    records: number;
    /** Of those, agent runs (agent_runs summaries, objective_runs reasoning and stop reasons). */
    agentRuns: number;
}

/** Clear what the run rows say about the application, for the runs (and summaries) past their period. One transaction. */
function clearRunDetails(p: Platform, projectId: string, runIds: string[], policy: RetentionPolicy, now: number): { runs: number; summaries: number } {
    const summaries = expiredSummaries(p, projectId, policy, now);
    if (!runIds.length && !summaries.length) return { runs: 0, summaries: 0 };
    p.db.tx(() => {
        for (let i = 0; i < runIds.length; i += 400) {
            const chunk = runIds.slice(i, i + 400);
            const marks = chunk.map(() => "?").join(",");
            p.db.run(`UPDATE test_executions SET error = NULL WHERE id IN (${marks}) AND NOT ${skipReason("test_executions")}`, ...chunk);
            p.db.run(`UPDATE test_execution_steps SET error = NULL WHERE execution_id IN (${marks})`, ...chunk);
        }
        for (const s of summaries) p.db.run("UPDATE run_summaries SET results_json = ?, diff_json = ? WHERE job_id = ? AND project_id = ?", s.results, s.diff, s.jobId, projectId);
    });
    return { runs: runIds.length, summaries: summaries.length };
}

/** The writes that replace what the other records of the project say about the application, past their period (a no-op list the second time). */
function otherRecordWrites(p: Platform, projectId: string, policy: RetentionPolicy, now: number, graceFrom: number | undefined = retentionStart(p.db)): { writes: Array<[string, ...Array<string | number | null>]>; agentRuns: number } {
    const jobs = p.db
        .all<Row>("SELECT id, status, error, finished_at FROM generation_jobs WHERE project_id = ? AND finished_at IS NOT NULL AND status IN ('COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED')", projectId)
        .filter((j) => isExpired(ms(j.finished_at), j.status === "COMPLETED", policy, now) && !graceHolds(ms(j.finished_at), graceFrom, now));
    const writes: Array<[string, ...Array<string | number | null>]> = [];
    for (const j of jobs) if (j.error !== null && j.error !== DETAILS_EXPIRED && !keptJobError(j.status as string, j.error as string)) writes.push(["UPDATE generation_jobs SET error = ? WHERE id = ?", DETAILS_EXPIRED, j.id]);
    const jobIds = jobs.map((j) => j.id as string);
    let agentRuns = 0;
    for (let i = 0; i < jobIds.length; i += 400) {
        const chunk = jobIds.slice(i, i + 400);
        const authoring = p.db.all<Row>(`SELECT id FROM agent_runs WHERE summary IS NOT NULL AND summary <> ? AND job_id IN (${chunk.map(() => "?").join(",")})`, DETAILS_EXPIRED, ...chunk);
        for (const a of authoring) writes.push(["UPDATE agent_runs SET summary = ? WHERE id = ?", DETAILS_EXPIRED, a.id]);
        agentRuns += authoring.length;
        const events = p.db.all<Row>(`SELECT id, message, data_json FROM agent_events WHERE level IN ('warn', 'error') AND job_id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
        for (const e of events) {
            const data = expiredEventData((e.data_json as string | null) ?? null);
            if (e.message !== DETAILS_EXPIRED || data !== undefined) writes.push(["UPDATE agent_events SET message = ?, data_json = ? WHERE id = ?", DETAILS_EXPIRED, data === undefined ? e.data_json : data, e.id]);
        }
    }
    const tests = p.db.all<Row>(
        `SELECT t.id, t.validation_reason, t.updated_at, e.status, e.started_at FROM test_cases t
           LEFT JOIN test_executions e ON e.id = (SELECT x.id FROM test_executions x WHERE x.test_case_id = t.id AND x.variant IS NULL AND x.environment IS NULL ORDER BY x.started_at DESC, x.id DESC LIMIT 1)
          WHERE t.project_id = ? AND t.validation_reason IS NOT NULL AND t.validation_status <> 'NEEDS_REVIEW'`,
        projectId,
    );
    for (const t of tests) {
        // The later of the latest base run and the reason's own last write: a reason written without a run (a script that could not be
        // rendered, an interrupted validation) is as young as that write. An unreadable time counts as unknown: kept.
        const run = t.started_at ? ms(t.started_at) : 0;
        const changed = ms(t.updated_at);
        if ((t.started_at && !run) || !changed) continue;
        if (!isExpired(Math.max(run, changed), t.started_at ? t.status === "passed" : false, policy, now) || graceHolds(Math.max(run, changed), graceFrom, now)) continue;
        const cut = expiredReason(t.validation_reason as string);
        if (cut !== t.validation_reason) writes.push(["UPDATE test_cases SET validation_reason = ? WHERE id = ?", cut, t.id]); // updated_at stays: the test did not change
    }
    const steps = p.db.all<Row>(
        `SELECT s.id, s.detail, s.url, r.verdict, r.finished_at FROM objective_run_steps s JOIN objective_runs r ON r.id = s.run_id
          WHERE r.project_id = ? AND r.state IN ('finished', 'stopped') AND r.finished_at IS NOT NULL`,
        projectId,
    );
    for (const s of steps) {
        if (!isExpired(ms(s.finished_at), s.verdict === "passed", policy, now) || graceHolds(ms(s.finished_at), graceFrom, now)) continue;
        const detail = s.detail === null ? null : DETAILS_EXPIRED;
        const url = originPath(String(s.url ?? ""));
        if (detail !== s.detail || url !== s.url) writes.push(["UPDATE objective_run_steps SET detail = ?, url = ? WHERE id = ?", detail, url, s.id]);
    }
    const objectiveRuns = p.db.all<Row>("SELECT id, verdict, reasoning, stop_reason, finished_at FROM objective_runs WHERE project_id = ? AND state IN ('finished', 'stopped') AND finished_at IS NOT NULL", projectId);
    for (const r of objectiveRuns) {
        if (!isExpired(ms(r.finished_at), r.verdict === "passed", policy, now) || graceHolds(ms(r.finished_at), graceFrom, now)) continue;
        const reasoning = r.reasoning === null ? null : DETAILS_EXPIRED;
        const stopReason = r.stop_reason === null || r.stop_reason === PERSON_STOPPED ? r.stop_reason : DETAILS_EXPIRED;
        if (reasoning !== r.reasoning || stopReason !== r.stop_reason) {
            writes.push(["UPDATE objective_runs SET reasoning = ?, stop_reason = ? WHERE id = ?", reasoning, stopReason, r.id]);
            agentRuns++;
        }
    }
    return { writes, agentRuns };
}

/** The stop reason agent-run.ts reads (a run a person stopped maps its job to "Cancelled"): a fixed value, kept at expiry. */
const PERSON_STOPPED = "A person stopped this run.";

/** Apply otherRecordWrites in one transaction. */
function clearOtherRecords(p: Platform, projectId: string, policy: RetentionPolicy, now: number): { records: number; agentRuns: number } {
    const { writes, agentRuns } = otherRecordWrites(p, projectId, policy, now);
    if (writes.length) p.db.tx(() => { for (const [sql, ...args] of writes) p.db.run(sql, ...args); });
    return { records: writes.length, agentRuns };
}

const running = new Set<string>();

/**
 * Remove what the plan lists. Reads the plan fresh (never trusts an earlier preview), refuses while a job runs, and records
 * the run in the log. The caller has already decided that removing is allowed (enabled, confirmed or scheduled).
 */
export async function pruneProject(p: Platform, projectId: string, policy: RetentionPolicy, trigger: "manual" | "scheduled", now = Date.now()): Promise<RunResult> {
    if (running.has(projectId)) throw new HttpError(409, "Files for this project are already being removed. Wait a moment and try again.");
    const busy = await activeJobOf(p.repo, projectId);
    if (busy) throw new HttpError(409, "A run is still going for this project. Files are only removed when nothing is running; try again when it has finished.");
    running.add(projectId);
    try {
        const full = planFor(p, projectId, policy, now);
        const stamp = new Date(now).toISOString();
        let files = 0;
        let bytes = 0;
        const problems: string[] = [];
        let errors = 0;
        for (const f of full.files) {
            try {
                const outcome = await removeOne(p, f.path);
                if (outcome === "skipped") throw new Error("it is not a plain file");
                p.db.run("UPDATE artifacts SET pruned_at = ?, pruned_reason = ? WHERE id = ? AND pruned_at IS NULL", stamp, f.reason, f.id);
                files++;
                bytes += f.size;
            } catch (e) {
                errors++;
                if (problems.length < 3) problems.push(`A ${f.kind} file could not be removed: ${e instanceof Error ? e.message.replace(/['"]?[A-Za-z]:\\[^\s'"]*|['"]?\/[^\s'"]+/g, "(path hidden)") : "unknown problem"}`);
            }
            // Large runs must not starve the server of the event loop.
            if ((files + errors) % 200 === 0) await new Promise((r) => setImmediate(r));
        }
        // Empty folders left behind are tidied up, but only folders below a project's _artifacts folder.
        await tidyEmptyFolders(p, projectId, full.files);
        // The same pass: what the expired runs' rows say about the application goes with their files.
        const cleared = clearRunDetails(p, projectId, full.plan.expiredRuns, policy, now);
        const { records, agentRuns } = clearOtherRecords(p, projectId, policy, now);
        if (files > 0 || cleared.runs > 0 || cleared.summaries > 0 || records > 0) relatedCache.clearProject(projectId);
        const result: RunResult = { files, bytes, errors, errorSample: problems.length ? problems.join(" ") : null, ...cleared, records, agentRuns };
        retentionStore(p).log(projectId, { at: stamp, trigger, files, bytes, errors, errorSample: result.errorSample ?? undefined });
        forgetUsage(p);
        return result;
    } finally {
        running.delete(projectId);
    }
}

/** Remove one file below the artifact folder. A file that is already gone counts as removed. */
async function removeOne(p: Platform, rel: string): Promise<"removed" | "gone" | "skipped"> {
    if (!rel) return "skipped";
    // Throws when the key leaves the artifact folder, and for a link or a folder where a file should be.
    return (await p.store.delete(rel)) ? "removed" : "gone";
}

/** Empty folders left behind on local disk, only below the project's _artifacts folder. S3 has no folders, so nothing to do there. */
async function tidyEmptyFolders(p: Platform, projectId: string, files: PlannedFile[]): Promise<void> {
    if (!(p.store instanceof LocalDiskStore)) return;
    await p.store.removeEmptyFolders(
        files.flatMap((f) => (f.path ? [f.path] : [])),
        `${projectId}/_artifacts`,
    ).catch(() => undefined); // tidying is a nicety
}

/** A manual run: needs an enabled policy and an explicit confirm. */
export async function runNow(p: Platform, projectId: string, confirm: boolean): Promise<RunResult & { sentence: string; details: string | null }> {
    const policy = retentionStore(p).effective(projectId);
    if (!policy.enabled) throw new HttpError(409, "Retention is switched off for this project, so nothing is removed. Turn it on first.");
    if (confirm !== true) throw new HttpError(400, "Confirm that you want these files removed (send confirm: true).");
    const r = await pruneProject(p, projectId, policy, "manual");
    const base = r.files === 0 && r.errors === 0 ? "Nothing needed removing." : `Removed ${r.files} ${r.files === 1 ? "file" : "files"} (${formatBytes(r.bytes)}).`;
    const sentence = r.errors ? `${base} ${r.errors} could not be removed and ${r.errors === 1 ? "was" : "were"} left in place.` : base;
    const what = [r.runs ? (r.runs === 1 ? "1 run" : `${r.runs} runs`) : "", r.summaries ? (r.summaries === 1 ? "1 run summary" : `${r.summaries} run summaries`) : "", r.records ? (r.records === 1 ? "1 other record" : `${r.records} other records`) : ""].filter(Boolean);
    const details = what.length ? `Cleared the failure details of ${what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : what[0]}; the runs stay in the history.` : null;
    return { ...r, sentence, details };
}

/**
 * The daily pass, called from the scheduler's tick. For every project whose effective policy is enabled, at most once a day
 * and never while a job is running. Never throws: one project's problem must not stop the others.
 */
export async function runScheduledRetention(p: Platform, now = Date.now()): Promise<Array<{ projectId: string; result: "pruned" | "busy" | "recent" | "error"; files?: number }>> {
    const store = retentionStore(p);
    // The first-deploy grace starts at the first start with retention; recorded at start-up too (this is the fallback). Never moved.
    recordRetentionStart(p.db);
    const out: Array<{ projectId: string; result: "pruned" | "busy" | "recent" | "error"; files?: number }> = [];
    for (const project of p.repo.listProjects()) {
        const projectId = project.id as string;
        try {
            const policy = store.effective(projectId);
            if (!policy.enabled) continue;
            const last = store.lastScheduledAt(projectId);
            if (last !== undefined && now - last < SCHEDULED_EVERY_MS) {
                out.push({ projectId, result: "recent" });
                continue;
            }
            if (await activeJobOf(p.repo, projectId)) {
                out.push({ projectId, result: "busy" });
                continue;
            }
            const r = await pruneProject(p, projectId, policy, "scheduled", now);
            out.push({ projectId, result: "pruned", files: r.files });
        } catch (e) {
            out.push({ projectId, result: "error" });
            console.error(`[retention] project ${projectId.slice(0, 8)}:`, e instanceof Error ? e.message : e);
        }
    }
    return out;
}
