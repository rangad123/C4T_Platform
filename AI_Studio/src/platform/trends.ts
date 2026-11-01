/**
 * What each finished run says, how it differs from what was known before, which tests are flaky, and the
 * pass-rate trend. Everything is derived from rows the pipeline already stores (jobs, test executions, test
 * status); only a compact per-run summary is persisted so trends stay cheap to read.
 */
import { assessSeverity, SEVERITIES, type Severity } from "../engine/validation/severity.js";
import type { Db, Row } from "./db.js";
import { quarantineGate } from "./quarantine-store.js";
import { NO_GATE, type QuarantineGate } from "../engine/quarantine/rules.js";
import type { JobRow, Repo } from "./repo.js";
import { NOT_FROM_CANCELLED_JOB } from "./cancel-summary.js";
import { isNothingRan } from "./review-store.js";
import { passRate } from "../engine/summary/pass-rate.js";

/** p = passed, f = the test failed validation (a broken or unreliable test), r = needs review (an application finding). */
export type ResultStatus = "p" | "f" | "r";

export interface TestResult {
    /** Identity across runs: the test key for re-runs, the title for fresh analyses (their keys are new every time). */
    k: string;
    id: string;
    key: string;
    title: string;
    s: ResultStatus;
    /** Passed, but only on a re-run after failing: unreliable, not broken. */
    flaky?: boolean;
    why?: string;
    sev?: Severity;
    /** In quarantine when the run was summarised: still run and shown, but it decides nothing (no failure, no alert). */
    q?: true;
}

export interface Change {
    key: string;
    title: string;
    id: string;
    status: ResultStatus;
    reason?: string;
    severity?: Severity;
    was?: ResultStatus | null;
}

export interface RunDiff {
    /** True when there was nothing earlier to compare with. */
    firstRun: boolean;
    newlyFailing: Change[];
    fixed: Change[];
    stillFailing: Change[];
    newFindings: Change[];
    flakyPasses: Change[];
}

export interface RunSummary {
    jobId: string;
    projectId: string;
    mode: string;
    trigger: "manual" | "schedule" | "deploy";
    scheduleId: string | null;
    jobStatus: string;
    finishedAt: string;
    total: number;
    validated: number;
    needsReview: number;
    failed: number;
    flaky: number;
    /** Percent of executed tests that passed; null when nothing ran. */
    passRate: number | null;
    durationMs: number | null;
    results: TestResult[];
    diff: RunDiff;
    /** Why a job that ran no tests failed (e.g. the application was unreachable). */
    jobError: string | null;
    /**
     * Present only when the run included quarantined tests. The counts above stay the real ones; the pass rate, the diff and
     * the alerts leave these tests out.
     */
    quarantined?: { tests: number; passed: number; failed: number; needsReview: number };
}

const MAX_REASON = 240;
/** Runs whose per-test results are kept (comparison looks at the latest 40). */
const KEEP_RESULTS_FOR_RUNS = 60;
export const severityAtLeast = (sev: Severity | undefined, min: Severity): boolean => sev !== undefined && SEVERITIES.indexOf(sev) <= SEVERITIES.indexOf(min);

/** Tests that count as failing for alerting: broken tests always, application findings from `min` severity up. */
export const isFailing = (r: TestResult, min: Severity): boolean => !r.q && (r.s === "f" || (r.s === "r" && (r.sev === undefined || severityAtLeast(r.sev, min))));

const clip = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_REASON) || undefined;

// ── per-run results ─────────────────────────────────────────────────────────

/** Per-test results of one job, from the executions it recorded and the tests' resulting status. */
export function collectResults(repo: Repo, job: JobRow, gate: QuarantineGate = NO_GATE): TestResult[] {
    const mode = job.options.mode ?? "generate";
    const execs = repo.db.all<Row>("SELECT test_case_id, attempt, status, script_id FROM test_executions WHERE job_id = ? ORDER BY test_case_id, COALESCE(finished_at, started_at), attempt", job.id);
    const byTest = new Map<string, Row[]>();
    for (const e of execs) (byTest.get(e.test_case_id) ?? byTest.set(e.test_case_id, []).get(e.test_case_id)!).push(e);

    const ids = new Set(byTest.keys());
    // A fresh analysis can also end with findings the authoring agent made without running a script.
    if (mode === "generate") {
        for (const r of repo.db.all<Row>("SELECT id FROM test_cases WHERE job_id = ? AND validation_status = 'NEEDS_REVIEW'", job.id)) ids.add(r.id);
    }

    const out: TestResult[] = [];
    for (const id of ids) {
        const t = repo.getTest(id);
        if (!t || t.projectId !== job.projectId) continue;
        const rows = (byTest.get(id) ?? []).filter((r) => r.status !== "skipped");
        const last = rows.at(-1);
        const base = { k: mode === "generate" ? t.title : t.testKey, id: t.id, key: t.testKey, title: t.title, ...(gate.has(t.id) ? { q: true as const } : {}) };
        if (last?.status === "passed") {
            const flaky = rows.some((r) => r.status !== "passed" && r.script_id === last.script_id);
            out.push({ ...base, s: "p", ...(flaky ? { flaky: true } : {}) });
        } else if (t.validationStatus === "NEEDS_REVIEW") {
            const sev = assessSeverity(t.spec, t.validationStatus, t.validationReason)?.severity;
            out.push({ ...base, s: "r", why: clip(t.validationReason), ...(sev ? { sev } : {}) });
        } else if (last) {
            out.push({ ...base, s: "f", why: clip(t.validationReason) });
        }
        // else: never executed (e.g. not runnable on this machine) — not a result
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** What was last known about each test, from the most recent earlier runs of the same kind. */
function knownBefore(db: Db, job: JobRow, finishedAt: string): Map<string, TestResult> {
    const mode = job.options.mode ?? "generate";
    const rows = db.all<Row>("SELECT results_json FROM run_summaries WHERE project_id = ? AND mode = ? AND job_id != ? AND finished_at < ? ORDER BY finished_at DESC LIMIT 40", job.projectId, mode, job.id, finishedAt);
    const known = new Map<string, TestResult>();
    for (const r of rows) for (const t of JSON.parse(r.results_json) as TestResult[]) if (!known.has(t.k)) known.set(t.k, t);
    return known;
}

const change = (r: TestResult, was: TestResult | undefined): Change => ({ key: r.key, title: r.title, id: r.id, status: r.s, ...(r.why ? { reason: r.why } : {}), ...(r.sev ? { severity: r.sev } : {}), was: was?.s ?? null });

/**
 * Compare a run with what was known before it. A test is compared with its own latest earlier result, even
 * if that came from a smaller run (e.g. re-running one test by hand), so one test's history is never lost.
 */
export function diffRuns(results: TestResult[], known: Map<string, TestResult>, min: Severity, hadEarlierRuns: boolean): RunDiff {
    const diff: RunDiff = { firstRun: !hadEarlierRuns, newlyFailing: [], fixed: [], stillFailing: [], newFindings: [], flakyPasses: [] };
    for (const r of results) {
        const was = known.get(r.k);
        const failing = isFailing(r, min);
        // A test that was in quarantine before counts as having been fine: if it fails now, that is news.
        const wasFailing = was !== undefined && was.s !== "p" && !was.q;
        if (failing && (was?.s === "p" || was?.q)) diff.newlyFailing.push(change(r, was));
        else if (failing && wasFailing) diff.stillFailing.push(change(r, was));
        if (r.s === "p" && wasFailing && !r.q) diff.fixed.push(change(r, was));
        if (r.s === "r" && isFailing(r, min) && (was?.s !== "r" || was.why !== r.why)) diff.newFindings.push(change(r, was));
        if (r.s === "p" && r.flaky && !r.q) diff.flakyPasses.push(change(r, was));
    }
    return diff;
}

const jobDuration = (job: JobRow) => (job.startedAt && job.finishedAt ? Math.max(0, new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) : null);

/** Build the summary of a finished job (without saving it). */
export function summarizeJob(repo: Repo, job: JobRow, min: Severity, gate: QuarantineGate = quarantineGate(repo.db, Date.now(), job.projectId)): RunSummary {
    const finishedAt = job.finishedAt ?? new Date().toISOString();
    const mode = job.options.mode ?? "generate";
    const results = collectResults(repo, job, gate);
    const earlier = repo.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_summaries WHERE project_id = ? AND mode = ? AND job_id != ? AND finished_at < ?", job.projectId, mode, job.id, finishedAt);
    const total = results.length;
    const validated = results.filter((r) => r.s === "p").length;
    // Quarantined tests stay in the counts above but leave the pass rate: they decide nothing.
    const held = results.filter((r) => r.q);
    const counted = held.length ? results.filter((r) => !r.q) : results;
    const countedPassed = held.length ? counted.filter((r) => r.s === "p").length : validated;
    return {
        jobId: job.id,
        projectId: job.projectId,
        mode,
        trigger: job.options.trigger ?? "manual",
        scheduleId: job.options.scheduleId ?? null,
        jobStatus: job.status,
        finishedAt,
        total,
        validated,
        needsReview: results.filter((r) => r.s === "r").length,
        failed: results.filter((r) => r.s === "f").length,
        flaky: results.filter((r) => r.flaky).length,
        passRate: passRate(countedPassed, counted.length),
        durationMs: jobDuration(job),
        results,
        diff: diffRuns(results, knownBefore(repo.db, job, finishedAt), min, (earlier?.n ?? 0) > 0),
        // A run of only drafts did not go wrong: there is nothing to alert about.
        jobError: total === 0 && job.status === "FAILED" && !isNothingRan(job) ? (job.error ?? "The run failed") : null,
        ...(held.length ? { quarantined: { tests: held.length, passed: held.filter((r) => r.s === "p").length, failed: held.filter((r) => r.s === "f").length, needsReview: held.filter((r) => r.s === "r").length } } : {}),
    };
}

export function saveRunSummary(db: Db, s: RunSummary): void {
    db.run(
        `INSERT INTO run_summaries (job_id, project_id, mode, trigger_kind, schedule_id, job_status, finished_at, total, validated, needs_review, failed, flaky, pass_rate, duration_ms, results_json, diff_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (job_id) DO UPDATE SET project_id = excluded.project_id, mode = excluded.mode, trigger_kind = excluded.trigger_kind, schedule_id = excluded.schedule_id,
             job_status = excluded.job_status, finished_at = excluded.finished_at, total = excluded.total, validated = excluded.validated, needs_review = excluded.needs_review,
             failed = excluded.failed, flaky = excluded.flaky, pass_rate = excluded.pass_rate, duration_ms = excluded.duration_ms, results_json = excluded.results_json, diff_json = excluded.diff_json`,
        s.jobId,
        s.projectId,
        s.mode,
        s.trigger,
        s.scheduleId,
        s.jobStatus,
        s.finishedAt,
        s.total,
        s.validated,
        s.needsReview,
        s.failed,
        s.flaky,
        s.passRate,
        s.durationMs,
        JSON.stringify(s.results),
        JSON.stringify({ ...s.diff, jobError: s.jobError, ...(s.quarantined ? { quarantined: s.quarantined } : {}) }),
    );
    // Per-test results are only read to compare the next runs with; old runs keep their counts for trends.
    db.run(
        `UPDATE run_summaries SET results_json = '[]' WHERE project_id = ? AND results_json != '[]'
           AND job_id NOT IN (SELECT job_id FROM run_summaries WHERE project_id = ? ORDER BY finished_at DESC LIMIT ${KEEP_RESULTS_FOR_RUNS})`,
        s.projectId,
        s.projectId,
    );
}

export function getRunSummary(db: Db, jobId: string): RunSummary | undefined {
    const r = db.get("SELECT * FROM run_summaries WHERE job_id = ?", jobId);
    if (!r) return undefined;
    const { jobError, quarantined, ...diff } = JSON.parse(r.diff_json);
    return {
        jobId: r.job_id,
        projectId: r.project_id,
        mode: r.mode,
        trigger: r.trigger_kind,
        scheduleId: r.schedule_id,
        jobStatus: r.job_status,
        finishedAt: r.finished_at,
        total: r.total,
        validated: r.validated,
        needsReview: r.needs_review,
        failed: r.failed,
        flaky: r.flaky,
        passRate: r.pass_rate,
        durationMs: r.duration_ms,
        results: JSON.parse(r.results_json),
        diff,
        jobError: jobError ?? null,
        ...(quarantined ? { quarantined } : {}),
    };
}

// ── trends ──────────────────────────────────────────────────────────────────

export interface TrendRun {
    jobId: string;
    finishedAt: string;
    mode: string;
    trigger: string;
    jobStatus: string;
    total: number;
    validated: number;
    needsReview: number;
    failed: number;
    flaky: number;
    passRate: number | null;
    durationMs: number | null;
}

export interface Trends {
    days: number;
    runs: TrendRun[];
    summary: { runs: number; firstPassRate: number | null; latestPassRate: number | null; averagePassRate: number | null; passRateDelta: number | null };
}

/** Pass rate / test counts per finished run over the last `days` days, oldest first. */
export function trendsFor(db: Db, projectId: string, days: number, nowMs = Date.now()): Trends {
    const since = new Date(nowMs - days * 86_400_000).toISOString();
    const rows = db.all<Row>(
        "SELECT job_id, finished_at, mode, trigger_kind, job_status, total, validated, needs_review, failed, flaky, pass_rate, duration_ms FROM run_summaries WHERE project_id = ? AND finished_at >= ? ORDER BY finished_at",
        projectId,
        since,
    );
    const runs: TrendRun[] = rows.map((r) => ({
        jobId: r.job_id,
        finishedAt: r.finished_at,
        mode: r.mode,
        trigger: r.trigger_kind,
        jobStatus: r.job_status,
        total: r.total,
        validated: r.validated,
        needsReview: r.needs_review,
        failed: r.failed,
        flaky: r.flaky,
        passRate: r.pass_rate,
        durationMs: r.duration_ms,
    }));
    const rated = runs.filter((r) => r.passRate !== null);
    const first = rated[0]?.passRate ?? null;
    const latest = rated.at(-1)?.passRate ?? null;
    const avg = rated.length ? Math.round((rated.reduce((a, r) => a + r.passRate!, 0) / rated.length) * 10) / 10 : null;
    return {
        days,
        runs,
        summary: { runs: runs.length, firstPassRate: first, latestPassRate: latest, averagePassRate: avg, passRateDelta: rated.length >= 2 ? Math.round((latest! - first!) * 10) / 10 : null },
    };
}

// ── flaky tests ─────────────────────────────────────────────────────────────

export interface FlakyTest {
    id: string;
    testKey: string;
    title: string;
    /** Executions considered: the latest ones of the test's current script. */
    executions: number;
    passes: number;
    fails: number;
    /** How many times consecutive executions disagreed (pass→fail or fail→pass). */
    flips: number;
    /** flips / (executions - 1). */
    flipRate: number;
    /** Times it passed on an immediate re-run after failing. */
    flakyPasses: number;
    lastStatus: string;
    lastRunAt: string;
}

export const FLAKY_WINDOW = 20;

/**
 * Tests whose recent executions flip between pass and fail although nothing about them changed. Only
 * executions of the test's current script count — a repaired or edited test starts a fresh history. A test
 * that failed once and stayed failed is a regression, not a flaky test: it needs at least two flips, or a
 * pass on an immediate re-run after a failure.
 */
/** The latest executions per test; `scope` is a WHERE condition on the tests' project. Newest first within each test. */
const FLAKY_SQL = (scope: string) => `SELECT * FROM (
            SELECT e.test_case_id AS test_id, t.project_id, e.status, e.job_id, e.script_id, COALESCE(e.finished_at, e.started_at) AS at, e.attempt,
                   COALESCE(s.content_hash, e.script_id, '') AS hash, t.test_key, t.title,
                   ROW_NUMBER() OVER (PARTITION BY e.test_case_id ORDER BY COALESCE(e.finished_at, e.started_at) DESC, e.attempt DESC) AS rn
              FROM test_executions e
              JOIN test_cases t ON t.id = e.test_case_id
              LEFT JOIN generated_scripts s ON s.id = e.script_id
             WHERE ${scope} AND e.status != 'skipped' AND e.environment IS NULL AND ${NOT_FROM_CANCELLED_JOB}
         ) WHERE rn <= ? ORDER BY test_id, rn DESC`;

function flakyFromRows(rows: Row[], limit: number): FlakyTest[] {
    const byTest = new Map<string, Row[]>();
    for (const r of rows) (byTest.get(r.test_id) ?? byTest.set(r.test_id, []).get(r.test_id)!).push(r);

    const out: FlakyTest[] = [];
    for (const [id, all] of byTest) {
        const latestHash = all.at(-1)!.hash;
        const seq = all.filter((r) => r.hash === latestHash); // oldest → newest, current script only
        if (seq.length < 2) continue;
        let flips = 0;
        let flakyPasses = 0;
        for (let i = 1; i < seq.length; i++) {
            const a = seq[i - 1]!.status === "passed";
            const b = seq[i]!.status === "passed";
            if (a !== b) flips++;
            if (!a && b && seq[i]!.job_id === seq[i - 1]!.job_id) flakyPasses++;
        }
        if (flips < 2 && flakyPasses < 1) continue;
        const passes = seq.filter((r) => r.status === "passed").length;
        const last = seq.at(-1)!;
        out.push({
            id,
            testKey: last.test_key,
            title: last.title,
            executions: seq.length,
            passes,
            fails: seq.length - passes,
            flips,
            flipRate: Math.round((flips / (seq.length - 1)) * 100) / 100,
            flakyPasses,
            lastStatus: last.status,
            lastRunAt: last.at,
        });
    }
    return out.sort((a, b) => b.flipRate - a.flipRate || b.flips - a.flips || b.executions - a.executions).slice(0, limit);
}

export function detectFlaky(db: Db, projectId: string, limit = 50): FlakyTest[] {
    return flakyFromRows(db.all<Row>(FLAKY_SQL("t.project_id = ?"), projectId, FLAKY_WINDOW), limit);
}

/** Unreliable tests per project for every project in one query (the dashboard; same rules as `detectFlaky`). */
export function flakyCountsByProject(db: Db, skip?: (testId: string) => boolean): Map<string, number> {
    const rows = db.all<Row>(FLAKY_SQL("1 = 1"), FLAKY_WINDOW);
    const byProject = new Map<string, Row[]>();
    for (const r of rows) (byProject.get(r.project_id) ?? byProject.set(r.project_id, []).get(r.project_id)!).push(r);
    const out = new Map<string, number>();
    for (const [id, list] of byProject) out.set(id, flakyFromRows(list, Number.MAX_SAFE_INTEGER).filter((f) => !skip?.(f.id)).length);
    return out;
}
