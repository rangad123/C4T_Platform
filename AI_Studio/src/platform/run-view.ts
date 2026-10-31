/**
 * One run, test by test: what the run meant to do, what each test did in it, and what changed since the tests last ran.
 *
 * Everything here is read from rows the run already wrote (the job, its test executions, its events); nothing is stored for it.
 * That keeps the answer true for a run that is still going (tests without a result are "waiting" or "running"), for one that was
 * stopped (tests that did not get to run say so, and keep the result they had before) and for one from long ago.
 *
 * What it can and cannot say, plainly:
 *   - A test is "running" or "waiting" only as far as the platform knows: scripts that run on this server or on a runner are
 *     executed together and their results are recorded when they finish, so while they run no test has a result yet.
 *   - The reason of a failing test is the test's current reason when this run is the latest run of that test, otherwise the first
 *     line of the error this run recorded.
 */
import { TERMINAL_STATES, type JobRow, type Repo, type TestRow } from "./repo.js";
import type { Db, Row } from "./db.js";

export type RunTestState = "waiting" | "running" | "passed" | "failed" | "finding" | "not_run";

export interface RunTestRow {
    id: string;
    testId: string;
    title: string;
    suite: string;
    state: RunTestState;
    /** Why a test failed, found something, or did not run. One short plain line. */
    reason?: string;
    durationMs?: number;
    /** Passed, but only on a re-run after failing in this run. */
    flaky?: true;
}

export interface RunCounts {
    /** Tests the run meant to run (or, for an exploration, the tests it created). */
    planned: number;
    /** Tests that produced a result in this run. */
    ran: number;
    passed: number;
    failed: number;
    findings: number;
    running: number;
    waiting: number;
    /** Tests that did not get to run (the run was stopped, or the test could not run here). */
    notRun: number;
}

export interface RunChange {
    id: string;
    testId: string;
    title: string;
    reason?: string;
}

export interface RunDetail {
    jobId: string;
    projectId: string;
    mode: string;
    active: boolean;
    counts: RunCounts;
    tests: RunTestRow[];
    /** Who started it: a person, a schedule, a deploy pipeline, or a run sequence. */
    startedBy: { kind: "person" | "schedule" | "deploy" | "sequence"; label?: string };
    /** Compared with the previous result of each test that ran. Null when nothing ran before or the run is not a plain re-run. */
    changes: { comparedWith: { jobId: string; at: string }; newlyFailing: RunChange[]; newlyPassing: RunChange[] } | null;
}

const MAX_REASON = 240;
const MAX_TESTS = 2000;

/** One plain line: no colour codes, no line breaks, not endless. */
const oneLine = (s: string | null | undefined): string | undefined => {
    const t = (s ?? "")
        .replace(/\u001b\[[0-9;]*m/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_REASON);
    return t || undefined;
};

/** The tests a run is about, in test-id order. */
function plannedTests(repo: Repo, job: JobRow): TestRow[] {
    const mode = job.options.mode ?? "generate";
    if (mode === "validate" || mode === "variants" || mode === "environment") {
        const seen = new Set<string>();
        const out: TestRow[] = [];
        for (const id of job.options.testIds ?? []) {
            if (seen.has(id)) continue;
            seen.add(id);
            const t = repo.getTest(id);
            if (t && t.projectId === job.projectId) out.push(t);
            if (out.length >= MAX_TESTS) break;
        }
        return out.sort((a, b) => a.testKey.localeCompare(b.testKey, undefined, { numeric: true }));
    }
    const made = repo.listTests(job.projectId, { jobId: job.id });
    const rewritten = job.options.rewriteTestId ? repo.getTest(job.options.rewriteTestId) : undefined;
    return (rewritten && rewritten.projectId === job.projectId && !made.some((t) => t.id === rewritten.id) ? [...made, rewritten] : made).slice(0, MAX_TESTS);
}

interface Verdict {
    state: "passed" | "failed" | "finding" | "not_run";
    reason?: string;
    durationMs?: number;
    flaky?: boolean;
}

/** The newest result of every test in this run, from the executions the run wrote. */
function verdicts(db: Db, job: JobRow, tests: TestRow[]): Map<string, Verdict> {
    const mode = job.options.mode ?? "generate";
    const rows = db.all<Row>(
        "SELECT test_case_id, attempt, status, duration_ms, error, started_at, variant, environment FROM test_executions WHERE job_id = ? ORDER BY test_case_id, COALESCE(finished_at, started_at), attempt",
        job.id,
    );
    const byTest = new Map<string, Row[]>();
    for (const r of rows) {
        const wanted = mode === "environment" ? r.environment != null : mode === "variants" ? r.variant != null : r.variant == null && r.environment == null;
        if (!wanted) continue;
        (byTest.get(r.test_case_id) ?? byTest.set(r.test_case_id, []).get(r.test_case_id)!).push(r);
    }
    const out = new Map<string, Verdict>();
    for (const t of tests) {
        const mine = byTest.get(t.id);
        if (!mine?.length) continue;
        if (mode === "environment") {
            const last = mine.at(-1)!;
            if (last.status === "passed") out.set(t.id, { state: "passed", durationMs: last.duration_ms ?? undefined });
            else if (last.status === "skipped") out.set(t.id, { state: "not_run", reason: oneLine(last.error) });
            else out.set(t.id, { state: last.status === "finding" ? "finding" : "failed", reason: oneLine(last.error), durationMs: last.duration_ms ?? undefined });
            continue;
        }
        if (mode === "variants") {
            const failed = mine.filter((r) => r.status === "failed");
            const passed = mine.filter((r) => r.status === "passed");
            if (failed.length) out.set(t.id, { state: "failed", reason: oneLine(`Fails on ${failed.map((r) => r.variant).join(", ")}`) });
            else if (passed.length) out.set(t.id, { state: "passed" });
            else out.set(t.id, { state: "not_run", reason: oneLine(mine.at(-1)!.error) });
            continue;
        }
        const ran = mine.filter((r) => r.status !== "skipped");
        const last = ran.at(-1);
        if (!last) continue;
        if (last.status === "passed") {
            out.set(t.id, { state: "passed", durationMs: last.duration_ms ?? undefined, ...(ran.some((r) => r.status !== "passed") ? { flaky: true } : {}) });
            continue;
        }
        // A failure is a finding when the test says so now and this run is the newest run of the test (an older run cannot know).
        const newest = db.get<Row>("SELECT job_id FROM test_executions WHERE test_case_id = ? AND variant IS NULL AND environment IS NULL ORDER BY COALESCE(finished_at, started_at) DESC, attempt DESC LIMIT 1", t.id);
        const latest = newest?.job_id === job.id;
        out.set(t.id, {
            state: latest && t.validationStatus === "NEEDS_REVIEW" ? "finding" : "failed",
            reason: oneLine(latest ? (t.validationReason ?? last.error) : last.error),
            durationMs: last.duration_ms ?? undefined,
        });
    }
    return out;
}

/** Why a test was left out, when the run said so ("API-007 was not run. ..."): the first such event that starts with the test's id. */
function notRunReasons(db: Db, job: JobRow, tests: TestRow[]): Map<string, string> {
    const out = new Map<string, string>();
    const events = db.all<Row>(
        "SELECT message FROM agent_events WHERE job_id = ? AND kind IN ('validation_not_executed','test_unrunnable','load_skipped','custom_skipped','plugin_skipped','test_missing') ORDER BY id LIMIT 500",
        job.id,
    );
    for (const t of tests) {
        const hit = events.find((e) => {
            const m = String(e.message);
            return m.startsWith(`${t.testKey} `) || m.startsWith(`${t.testKey}:`);
        });
        if (hit) out.set(t.id, oneLine(String(hit.message).slice(t.testKey.length).replace(/^[:\s]+/, ""))!);
    }
    return out;
}

const startedBy = (db: Db, job: JobRow): RunDetail["startedBy"] => {
    const o = job.options;
    if (o.runbookRunId) return { kind: "sequence" };
    if (o.trigger === "schedule") {
        const name = o.scheduleId ? db.get<Row>("SELECT name FROM schedules WHERE id = ?", o.scheduleId)?.name : undefined;
        return { kind: "schedule", ...(name ? { label: String(name) } : {}) };
    }
    if (o.trigger === "deploy") {
        const label = o.deploy?.label ?? o.deploy?.commit;
        return { kind: "deploy", ...(label ? { label: String(label).slice(0, 80) } : {}) };
    }
    return { kind: "person" };
};

/** What changed: each test that ran, against the result it had in an earlier run (any earlier plain run of that test). */
function changesSince(db: Db, job: JobRow, tests: TestRow[], now: Map<string, Verdict>): RunDetail["changes"] {
    const mode = job.options.mode ?? "generate";
    if (mode !== "validate") return null;
    const newlyFailing: RunChange[] = [];
    const newlyPassing: RunChange[] = [];
    let compared: { jobId: string; at: string } | null = null;
    for (const t of tests) {
        const v = now.get(t.id);
        if (!v || v.state === "not_run") continue;
        const first = db.get<Row>("SELECT MIN(COALESCE(finished_at, started_at)) AS at FROM test_executions WHERE job_id = ? AND test_case_id = ? AND variant IS NULL AND environment IS NULL", job.id, t.id)?.at;
        if (!first) continue;
        const before = db.get<Row>(
            `SELECT job_id, status, COALESCE(finished_at, started_at) AS at FROM test_executions
              WHERE test_case_id = ? AND variant IS NULL AND environment IS NULL AND status != 'skipped' AND (job_id IS NULL OR job_id != ?) AND COALESCE(finished_at, started_at) < ?
              ORDER BY COALESCE(finished_at, started_at) DESC, attempt DESC LIMIT 1`,
            t.id,
            job.id,
            first,
        );
        if (!before) continue;
        if (!compared || String(before.at) > compared.at) compared = { jobId: String(before.job_id ?? ""), at: String(before.at) };
        const wasPassing = before.status === "passed";
        const isPassing = v.state === "passed";
        const row: RunChange = { id: t.id, testId: t.testKey, title: t.title, ...(v.reason ? { reason: v.reason } : {}) };
        if (wasPassing && !isPassing) newlyFailing.push(row);
        else if (!wasPassing && isPassing) newlyPassing.push({ id: t.id, testId: t.testKey, title: t.title });
    }
    return compared ? { comparedWith: compared, newlyFailing, newlyPassing } : null;
}

export function buildRunDetail(repo: Repo, job: JobRow): RunDetail {
    const db = repo.db;
    const tests = plannedTests(repo, job);
    // Waiting in the queue counts as going: the run has not ended.
    const active = !TERMINAL_STATES.includes(job.status);
    const got = verdicts(db, job, tests);
    const why = active ? new Map<string, string>() : notRunReasons(db, job, tests);
    const mode = job.options.mode ?? "generate";
    const started = job.status !== "QUEUED";

    const rows: RunTestRow[] = tests.map((t) => {
        const v = got.get(t.id);
        const base = { id: t.id, testId: t.testKey, title: t.title, suite: t.suite };
        if (v) return { ...base, state: v.state, ...(v.reason ? { reason: v.reason } : {}), ...(v.durationMs !== undefined ? { durationMs: v.durationMs } : {}), ...(v.flaky ? { flaky: true as const } : {}) };
        if (active) {
            // Scripts run together and are recorded when they finish: before that a test is waiting for the run to begin, or part of the run in progress.
            const running = started && (mode === "environment" || mode === "variants" ? true : t.validationStatus === "VALIDATING");
            return { ...base, state: running ? "running" : "waiting" };
        }
        const reason = why.get(t.id);
        return { ...base, state: "not_run", ...(reason ? { reason } : {}) };
    });

    const n = (s: RunTestState) => rows.filter((r) => r.state === s).length;
    const counts: RunCounts = { planned: rows.length, ran: n("passed") + n("failed") + n("finding"), passed: n("passed"), failed: n("failed"), findings: n("finding"), running: n("running"), waiting: n("waiting"), notRun: n("not_run") };

    // Failures first, then findings, then what is still going, then the passes: what needs a person is at the top.
    const order: Record<RunTestState, number> = { failed: 0, finding: 1, running: 2, waiting: 3, not_run: 4, passed: 5 };
    rows.sort((a, b) => order[a.state] - order[b.state] || a.testId.localeCompare(b.testId, undefined, { numeric: true }));

    return { jobId: job.id, projectId: job.projectId, mode, active, counts, tests: rows, startedBy: startedBy(db, job), changes: changesSince(db, job, tests, got) };
}
