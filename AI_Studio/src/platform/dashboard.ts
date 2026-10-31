/**
 * Cross-project dashboard: which of my applications is healthy right now, and is it fit to release?
 *
 * Read-only and computed on read from rows the platform already keeps (jobs, tests, run summaries, schedules, API
 * snapshots): no tables of its own, no job started, no model called, no target contacted. The queries run once for ALL
 * projects (never one per project), so the cost does not grow with the number of queries a project needs.
 *
 * `assessReadiness` is a pure function with the rules written down in `READINESS_RULES`; the API returns those rules
 * next to the answer so a person can always see why a project got its state.
 */
import { diffSnapshots, type ApiSnapshot, type OpObservation } from "../engine/contracts/drift.js";
import { assessSeverity, type Severity } from "../engine/validation/severity.js";
import { describeRun } from "../engine/summary/pass-rate.js";
import type { Db, Row } from "./db.js";
import { notCountedText } from "../engine/quarantine/rules.js";
import { quarantineGate } from "./quarantine-store.js";
import { flakyCountsByProject, type TestResult } from "./trends.js";

export type Readiness = "ready" | "needs-attention" | "blocked" | "unknown";
export const READINESS_STATES: Readiness[] = ["blocked", "needs-attention", "unknown", "ready"];
const LABEL: Record<Readiness, string> = { ready: "Ready", "needs-attention": "Needs attention", blocked: "Blocked", unknown: "Unknown" };

/** A run older than this many days makes a project stale. */
export const STALE_DAYS = 7;
const DAY_MS = 86_400_000;
/** Points in a project's trend. */
export const TREND_RUNS = 10;

export type ReasonCode =
    | "data-unreadable"
    | "never-analysed"
    | "analysis-running"
    | "never-run"
    | "no-tests"
    | "critical-findings"
    | "high-findings"
    | "job-failed"
    | "failing-tests"
    | "medium-findings"
    | "low-findings"
    | "unreliable-tests"
    | "breaking-api-change"
    | "unvalidated-tests"
    | "stale"
    /** Information only: tests in quarantine are left out of every other reason. */
    | "quarantined-tests";

export interface Reason {
    code: ReasonCode;
    text: string;
}

export interface ReadinessInput {
    /** Set when the project's stored data could not be read: the project is `unknown` and says so. */
    problem?: string;
    /** The newest job is still working (analysis or run). */
    activeJob: boolean;
    /** The newest job that finished (cancelled jobs ignored), or null when none has. */
    latestJob: { status: string; mode: string } | null;
    tests: { total: number; validated: number; needsReview: number; failedValidation: number; waiting: number };
    /** Open findings (tests needing review) by severity. */
    findings: Record<Severity, number>;
    /** The newest run summary, if any. */
    latestRun: { failed: number; needsReview: number; total: number } | null;
    flaky: number;
    breakingChanges: number;
    /** Tests in quarantine: already left out of everything above, mentioned as information. */
    quarantined?: number;
    /** When the newest finished job ended. */
    lastRunAt: string | null;
}

export interface ReadinessResult {
    state: Readiness;
    label: string;
    /** Most important first; the API returns all of them, the page shows the top two. */
    reasons: Reason[];
    stale: boolean;
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const reason = (code: ReasonCode, text: string): Reason => ({ code, text });

/** Whole days between two instants (rounded down). */
export const ageDays = (iso: string, nowMs: number): number => Math.floor((nowMs - new Date(iso).getTime()) / DAY_MS);

export function assessReadiness(i: ReadinessInput, nowMs = Date.now()): ReadinessResult {
    const info = i.quarantined ? [reason("quarantined-tests", notCountedText(i.quarantined))] : [];
    const done = (state: Readiness, reasons: Reason[], stale = false): ReadinessResult => ({ state, label: LABEL[state], reasons: [...reasons, ...info], stale });
    if (i.problem) return done("unknown", [reason("data-unreadable", i.problem)]);

    // Stale: strictly more than STALE_DAYS since the last finished run (exactly 7 days is still fresh).
    const lastMs = i.lastRunAt ? new Date(i.lastRunAt).getTime() : NaN;
    const stale = Number.isFinite(lastMs) && nowMs - lastMs > STALE_DAYS * DAY_MS;
    const staleReason = stale ? [reason("stale", `Last run ${n(ageDays(i.lastRunAt!, nowMs), "day")} ago`)] : [];

    // 1. Blocked: anything a release should not go out with.
    const blocked: Reason[] = [];
    if (i.findings.critical > 0) blocked.push(reason("critical-findings", n(i.findings.critical, "critical finding")));
    if (i.findings.high > 0) blocked.push(reason("high-findings", n(i.findings.high, "high-severity finding")));
    if (i.latestJob?.status === "FAILED") blocked.push(reason("job-failed", i.latestJob.mode === "generate" ? "The last analysis failed" : "The last run failed"));

    // 2. Needs attention: worth a look before releasing.
    const attention: Reason[] = [];
    const failing = i.latestRun && i.latestRun.failed > 0 ? i.latestRun.failed : i.tests.failedValidation;
    if (failing > 0) attention.push(reason("failing-tests", i.latestRun && i.latestRun.failed > 0 ? `${n(failing, "test")} failing in the last run` : `${n(failing, "test")} could not be run`));
    if (i.findings.medium > 0) attention.push(reason("medium-findings", n(i.findings.medium, "medium-severity finding")));
    if (i.findings.low > 0) attention.push(reason("low-findings", n(i.findings.low, "low-severity finding")));
    if (i.flaky > 0) attention.push(reason("unreliable-tests", n(i.flaky, "unreliable test")));
    if (i.breakingChanges > 0) attention.push(reason("breaking-api-change", `${n(i.breakingChanges, "breaking API change")} since the previous run`));
    if (i.tests.waiting > 0) attention.push(reason("unvalidated-tests", `${n(i.tests.waiting, "test")} not validated yet`));

    if (blocked.length) return done("blocked", [...blocked, ...attention, ...staleReason], stale);
    if (attention.length) return done("needs-attention", [...attention, ...staleReason], stale);

    // 3. Nothing to report. Without a finished run that is "unknown", not "ready".
    if (!i.latestJob) {
        if (i.activeJob) return done("unknown", [reason("analysis-running", "The first analysis is still running")]);
        return done("unknown", [reason(i.tests.total > 0 ? "never-run" : "never-analysed", i.tests.total > 0 ? "Its tests have never been run" : "Not analyzed yet")]);
    }
    if (i.tests.total === 0 && !i.latestRun) return done("unknown", [reason("no-tests", "The analysis made no tests yet")]);

    // 4. Ready, unless the evidence is old.
    if (stale) return done("needs-attention", staleReason, true);
    return done("ready", []);
}

/** The rules in words, returned with every answer and written in the feature doc. */
export const READINESS_RULES: Array<{ state: Readiness; label: string; summary: string; when: string[] }> = [
    {
        state: "blocked",
        label: LABEL.blocked,
        summary: "Do not release until this is dealt with.",
        when: ["Any open critical or high-severity finding", "The last analysis or run failed (for example the application was unreachable)"],
    },
    {
        state: "needs-attention",
        label: LABEL["needs-attention"],
        summary: "Look at it before releasing.",
        when: [
            "Tests failing in the last run, or tests that could not be validated",
            "Open medium or low-severity findings",
            "Unreliable (flaky) tests",
            "A breaking API change since the previous run",
            "Tests that have not been validated yet",
            `The last run is more than ${STALE_DAYS} days old (shown as a stale reason on every state)`,
        ],
    },
    {
        state: "unknown",
        label: LABEL.unknown,
        summary: "There is not enough information to say.",
        when: ["The project was never analyzed or its tests never run", "The analysis made no tests", "The stored data could not be read"],
    },
    {
        state: "ready",
        label: LABEL.ready,
        summary: "Nothing needs attention.",
        when: [`Every test passes, no findings, no unreliable tests, no breaking API change, and the last run is at most ${STALE_DAYS} days old`],
    },
];

// ── pure helpers ───────────────────────────────────────────────────────────

export interface TrendPoint {
    at: string;
    /** Percent of executed tests that passed; null when the run executed nothing. */
    passRate: number | null;
}

/** The newest `limit` run summaries (any order in) as a trend, oldest first. */
export function trendOf(runs: Array<{ finishedAt: string; passRate: number | null }>, limit = TREND_RUNS): TrendPoint[] {
    return [...runs]
        .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
        .slice(-limit)
        .map((r) => ({ at: r.finishedAt, passRate: r.passRate }));
}

export interface FleetCounts {
    total: number;
    ready: number;
    needsAttention: number;
    blocked: number;
    unknown: number;
    /** "5 projects: 3 ready, 1 needs attention, 1 blocked" */
    sentence: string;
}

export function fleetCounts(states: Readiness[]): FleetCounts {
    const count = (s: Readiness) => states.filter((x) => x === s).length;
    const c = { ready: count("ready"), needsAttention: count("needs-attention"), blocked: count("blocked"), unknown: count("unknown") };
    const parts = [c.ready && `${c.ready} ready`, c.needsAttention && `${c.needsAttention} needs attention`, c.blocked && `${c.blocked} blocked`, c.unknown && `${c.unknown} unknown`].filter(Boolean);
    const sentence = states.length === 0 ? "No projects yet" : `${n(states.length, "project")}: ${parts.join(", ")}`;
    return { total: states.length, ...c, sentence };
}

export interface DashboardFilter {
    state?: Readiness;
    q?: string;
    /** Only these projects (a person limited to some projects); absent: every project. */
    projectIds?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}

/** Blocked first, then needs attention, unknown, ready; by name inside a group. Filters by state and by name or host. */
export function filterAndSort<T extends { name: string; host: string; readiness: { state: Readiness } }>(items: T[], f: DashboardFilter = {}): T[] {
    const needle = f.q?.trim().toLowerCase();
    return items
        .filter((p) => (!f.state || p.readiness.state === f.state) && (!needle || p.name.toLowerCase().includes(needle) || p.host.toLowerCase().includes(needle)))
        .sort((a, b) => READINESS_STATES.indexOf(a.readiness.state) - READINESS_STATES.indexOf(b.readiness.state) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name));
}

/** The sentences that say what the last run's pass rate is made of, and what it leaves out (see engine/summary/pass-rate.ts). */
function runWords(run: Row, tests: { total: number; needsAttention: number; couldNotValidate: number; waiting: number }, unreliable: number, quarantined: number): { sentence: string; others: string } {
    const f = describeRun({ passed: run.validated, findings: run.needs_review, failed: run.failed }, { total: tests.total, couldNotValidate: tests.couldNotValidate, needsAttention: tests.needsAttention, waiting: tests.waiting, unreliable });
    // Quarantined tests stay in the run's counts but leave its pass rate: say so, so the sentence and the percentage agree.
    const held = quarantined ? `The pass rate leaves out ${quarantined} quarantined ${quarantined === 1 ? "test" : "tests"}.` : "";
    return { sentence: f.sentence, others: [f.others, held].filter(Boolean).join(" ") };
}

// ── gathering ──────────────────────────────────────────────────────────────

export interface DashboardProject {
    id: string;
    name: string;
    /** Host name of the application's address (never the full address, which may carry a path or a key). */
    host: string;
    readiness: ReadinessResult;
    /** The newest job (analysis or run), working or finished. */
    analysis: { status: string; at: string; active: boolean } | null;
    tests: { total: number; validated: number; needsAttention: number; couldNotValidate: number; waiting: number };
    latestRun: { jobId: string; finishedAt: string; trigger: string; mode: string; passRate: number | null; total: number; validated: number; failed: number; needsReview: number; /** What the pass rate is made of ("17 of 17 tests that ran passed."). Absent in releases signed before it existed. */ sentence?: string; /** The tests that did not take part in the run and the problems the project has right now: the other half of the picture. */ others?: string } | null;
    trend: TrendPoint[];
    schedule: { exists: boolean; enabled: number; total: number; lastRunOk: boolean | null; lastRunAt: string | null; note: string | null };
    findings: Record<Severity, number> & { highOrCritical: number };
    flaky: number;
    /** Present only while tests are in quarantine: they are not counted in the state above, and listed here so nobody misses them. */
    quarantine?: { count: number; tests: Array<{ id: string; testKey: string; title: string; reason: string; expiresAt: string }> };
    apiBreakingChanges: number;
    /** When the newest finished job ended (null = never run). */
    lastRunAt: string | null;
}

export interface Dashboard {
    generatedAt: string;
    summary: FleetCounts;
    projects: DashboardProject[];
    rules: typeof READINESS_RULES;
    staleDays: number;
}

const TERMINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

const hostOf = (url: string | null | undefined): string => {
    try {
        return url ? new URL(url).host : "";
    } catch {
        return "";
    }
};

function groupBy<T extends Row>(rows: T[], key = "project_id"): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const r of rows) (out.get(r[key]) ?? out.set(r[key], []).get(r[key])!).push(r);
    return out;
}

const modeOf = (optionsJson: string): string => {
    const m = (JSON.parse(optionsJson) as { mode?: string }).mode;
    return m ?? "generate";
};

/**
 * Everything the dashboard shows, for all projects, with a fixed number of queries.
 * A project whose stored data is unreadable becomes `unknown` with a plain reason; the others are unaffected.
 */
export function buildDashboard(db: Db, opts: DashboardFilter & { now?: number } = {}): Dashboard {
    const now = opts.now ?? Date.now();

    // A person limited to some projects (auth/project-scope.ts) sees only those, and the fleet counts are of those only.
    const projects = db.all<Row>(`SELECT p.id, p.name, (SELECT url FROM applications a WHERE a.project_id = p.id ORDER BY created_at DESC LIMIT 1) AS url FROM projects p`).filter((r) => !opts.projectIds || opts.projectIds.has(r.id as string));
    const latestJob = groupBy(
        db.all<Row>(`SELECT * FROM (SELECT project_id, status, created_at, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC, ${db.dialect.insertionOrder()} DESC) AS rn FROM generation_jobs) AS j WHERE rn = 1`),
    );
    // The newest job that actually finished; a cancelled one says nothing about the application.
    const finishedJob = groupBy(
        db.all<Row>(
            `SELECT * FROM (SELECT project_id, status, options_json, COALESCE(finished_at, created_at) AS at,
                    ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY COALESCE(finished_at, created_at) DESC, ${db.dialect.insertionOrder()} DESC) AS rn
               FROM generation_jobs WHERE status IN ('COMPLETED','PARTIALLY_COMPLETED','FAILED') AND COALESCE(error, '') != 'Cancelled') AS j WHERE rn = 1`,
        ),
    );
    const testCounts = groupBy(db.all<Row>("SELECT project_id, validation_status, COUNT(*) AS c FROM test_cases GROUP BY project_id, validation_status"));
    const reviews = groupBy(db.all<Row>("SELECT id, project_id, validation_reason, spec_json FROM test_cases WHERE validation_status = 'NEEDS_REVIEW'"));
    const runs = groupBy(
        db.all<Row>(
            `SELECT * FROM (SELECT job_id, project_id, mode, trigger_kind, finished_at, total, validated, needs_review, failed, pass_rate,
                    ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY finished_at DESC, ${db.dialect.insertionOrder()} DESC) AS rn FROM run_summaries) AS r WHERE rn <= ?`,
            TREND_RUNS,
        ),
    );
    const schedules = groupBy(
        db.all<Row>(
            `SELECT s.project_id, s.enabled, s.last_outcome, s.last_run_at, s.last_note, j.status AS job_status
               FROM schedules s LEFT JOIN generation_jobs j ON j.id = s.last_job_id`,
        ),
    );
    // Tests in quarantine are left out of what decides readiness (one read for all projects; empty when nobody uses quarantine).
    const gate = quarantineGate(db, now);
    const flaky = flakyCountsByProject(db);
    const gatedFlaky = gate.size ? flakyCountsByProject(db, (id) => gate.has(id)) : flaky;
    const latestResults = new Map<string, TestResult[]>();
    if (gate.size) {
        const jobs = [...new Set(projects.filter((p) => gate.forProject(p.id).length).map((p) => (runs.get(p.id) ?? []).find((r) => r.rn === 1)?.job_id as string | undefined))].filter(Boolean) as string[];
        if (jobs.length) for (const r of db.all<Row>(`SELECT job_id, results_json FROM run_summaries WHERE job_id IN (${jobs.map(() => "?").join(",")})`, ...jobs)) latestResults.set(r.job_id, JSON.parse(r.results_json) as TestResult[]);
    }
    const snapshots = groupBy(
        db.all<Row>(`SELECT * FROM (SELECT project_id, job_id, at, complete, operations_json, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY id DESC) AS rn FROM api_snapshots) AS s WHERE rn <= 2 ORDER BY project_id, rn DESC`),
    );

    const out: DashboardProject[] = projects.map((p) => {
        const host = hostOf(p.url);
        const base = { id: p.id as string, name: p.name as string, host };
        try {
            const counts: Record<string, number> = {};
            for (const r of testCounts.get(p.id) ?? []) counts[r.validation_status] = r.c;
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            const tests = {
                total,
                validated: counts.VALIDATED ?? 0,
                needsAttention: counts.NEEDS_REVIEW ?? 0,
                couldNotValidate: counts.FAILED_VALIDATION ?? 0,
                waiting: (counts.PENDING ?? 0) + (counts.VALIDATING ?? 0),
            };

            const findings: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
            for (const r of reviews.get(p.id) ?? []) {
                if (gate.has(r.id)) continue;
                const sev = assessSeverity(JSON.parse(r.spec_json), "NEEDS_REVIEW", r.validation_reason)?.severity ?? "low";
                findings[sev]++;
            }

            const newest = latestJob.get(p.id)?.[0];
            const fin = finishedJob.get(p.id)?.[0];
            const runRows = runs.get(p.id) ?? [];
            const latest = runRows.find((r) => r.rn === 1);
            const sched = schedules.get(p.id) ?? [];
            const ranOk = ((): boolean | null => {
                const ran = sched.filter((s) => s.last_run_at).sort((a, b) => String(b.last_run_at).localeCompare(String(a.last_run_at)))[0];
                if (!ran) return sched.some((s) => s.last_outcome === "error") ? false : null;
                return ran.last_outcome !== "error" && ran.job_status !== "FAILED";
            })();
            const lastSched = sched.map((s) => s.last_run_at as string | null).filter(Boolean).sort().at(-1) ?? null;

            let breaking = 0;
            const snaps = snapshots.get(p.id) ?? [];
            if (snaps.length === 2) {
                const toSnap = (r: Row): ApiSnapshot => ({ jobId: r.job_id, at: r.at, complete: Boolean(r.complete), operations: JSON.parse(r.operations_json) as Record<string, OpObservation> });
                breaking = diffSnapshots(toSnap(snaps[0]!), toSnap(snaps[1]!)).breaking.length;
            }

            // The latest run's failures without the quarantined tests (judged by what is in quarantine now).
            const held = gate.forProject(p.id);
            const results = latest ? latestResults.get(latest.job_id) : undefined;
            const gatedRun = latest && held.length && results?.length ? { failed: results.filter((r) => r.s === "f" && !gate.has(r.id)).length, needsReview: results.filter((r) => r.s === "r" && !gate.has(r.id)).length, total: latest.total } : undefined;
            const heldFailedValidation = held.filter((e) => e.testStatus === "FAILED_VALIDATION").length;
            const active = Boolean(newest && !TERMINAL.includes(newest.status));
            const lastRunAt = (fin?.at as string | undefined) ?? null;
            const readiness = assessReadiness(
                {
                    activeJob: active,
                    latestJob: fin ? { status: fin.status, mode: modeOf(fin.options_json) } : null,
                    tests: { total, validated: tests.validated, needsReview: tests.needsAttention, failedValidation: tests.couldNotValidate - heldFailedValidation, waiting: tests.waiting },
                    findings,
                    latestRun: latest ? (gatedRun ?? { failed: latest.failed, needsReview: latest.needs_review, total: latest.total }) : null,
                    flaky: gatedFlaky.get(p.id) ?? 0,
                    breakingChanges: breaking,
                    ...(held.length ? { quarantined: held.length } : {}),
                    lastRunAt,
                },
                now,
            );
            return {
                ...base,
                readiness,
                analysis: newest ? { status: newest.status, at: newest.created_at, active } : null,
                tests,
                latestRun: latest
                    ? { jobId: latest.job_id, finishedAt: latest.finished_at, trigger: latest.trigger_kind, mode: latest.mode, passRate: latest.pass_rate ?? null, total: latest.total, validated: latest.validated, failed: latest.failed, needsReview: latest.needs_review, ...runWords(latest, tests, gatedFlaky.get(p.id) ?? 0, held.length) }
                    : null,
                trend: trendOf(runRows.map((r) => ({ finishedAt: r.finished_at, passRate: r.pass_rate ?? null }))),
                schedule: { exists: sched.length > 0, enabled: sched.filter((s) => s.enabled).length, total: sched.length, lastRunOk: ranOk, lastRunAt: lastSched, note: sched.find((s) => s.last_note)?.last_note ?? null },
                findings: { ...findings, highOrCritical: findings.critical + findings.high },
                flaky: flaky.get(p.id) ?? 0,
                ...(held.length ? { quarantine: { count: held.length, tests: held.slice(0, 20).map((e) => ({ id: e.testId, testKey: e.testKey, title: e.title, reason: e.reason, expiresAt: e.expiresAt })) } } : {}),
                apiBreakingChanges: breaking,
                lastRunAt,
            };
        } catch {
            // Corrupt or missing data in one project must not take the whole dashboard down.
            return {
                ...base,
                readiness: assessReadiness({ problem: "Some of this project’s data could not be read", activeJob: false, latestJob: null, tests: { total: 0, validated: 0, needsReview: 0, failedValidation: 0, waiting: 0 }, findings: { critical: 0, high: 0, medium: 0, low: 0 }, latestRun: null, flaky: 0, breakingChanges: 0, lastRunAt: null }, now),
                analysis: null,
                tests: { total: 0, validated: 0, needsAttention: 0, couldNotValidate: 0, waiting: 0 },
                latestRun: null,
                trend: [],
                schedule: { exists: false, enabled: 0, total: 0, lastRunOk: null, lastRunAt: null, note: null },
                findings: { critical: 0, high: 0, medium: 0, low: 0, highOrCritical: 0 },
                flaky: 0,
                apiBreakingChanges: 0,
                lastRunAt: null,
            };
        }
    });

    return {
        generatedAt: new Date(now).toISOString(),
        summary: fleetCounts(out.map((p) => p.readiness.state)),
        projects: filterAndSort(out, { state: opts.state, q: opts.q }),
        rules: READINESS_RULES,
        staleDays: STALE_DAYS,
    };
}
