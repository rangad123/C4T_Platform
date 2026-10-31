/** Page-speed history: every measured value of every run, so a test's speed can be tracked over time. */
import type { Sql } from "./sql.js";

/** Migration slot 6. */
export const PERFORMANCE_MIGRATION = `
CREATE TABLE perf_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    execution_id TEXT,
    metric TEXT NOT NULL,       -- ttfb fcp lcp cls load weight requests
    value REAL NOT NULL,
    unit TEXT NOT NULL,         -- ms score bytes count
    budget REAL,
    at TEXT NOT NULL
);
CREATE INDEX idx_perf_test ON perf_metrics(test_case_id, at);
CREATE INDEX idx_perf_project ON perf_metrics(project_id, at);
`;

export interface Sample {
    metric: string;
    value: number;
    unit: string;
    budget?: number;
}

export async function recordMetrics(sql: Sql, args: { projectId: string; testId: string; executionId: string; samples: Sample[]; at?: string }): Promise<void> {
    const at = args.at ?? new Date().toISOString();
    // The body awaits only its handle `t` (sql.ts): one run's values land together or not at all.
    await sql.tx(async (t) => {
        for (const s of args.samples) {
            await t.run("INSERT INTO perf_metrics (project_id, test_case_id, execution_id, metric, value, unit, budget, at) VALUES (?,?,?,?,?,?,?,?)", args.projectId, args.testId, args.executionId, s.metric, s.value, s.unit, s.budget ?? null, at);
        }
    });
}

export interface PerfHistory {
    /** Newest run's values. */
    latest: Array<Sample & { at: string }>;
    /** Up to `runs` earlier runs, oldest first, each as { at, values by metric }. */
    history: Array<{ at: string; executionId: string; values: Record<string, number> }>;
}

export async function testHistory(sql: Sql, testId: string, runs = 20): Promise<PerfHistory> {
    const rows = await sql.all<{ execution_id: string; metric: string; value: number; unit: string; budget: number | null; at: string }>(
        "SELECT execution_id, metric, value, unit, budget, at FROM perf_metrics WHERE test_case_id = ? ORDER BY at DESC, id DESC LIMIT ?",
        testId,
        runs * 16, // a load check records 12 values per run
    );
    const byRun = new Map<string, { at: string; executionId: string; rows: typeof rows }>();
    for (const r of rows) {
        const run = byRun.get(r.execution_id) ?? { at: r.at, executionId: r.execution_id, rows: [] };
        run.rows.push(r);
        byRun.set(r.execution_id, run);
    }
    const ordered = [...byRun.values()].slice(0, runs);
    const newest = ordered[0];
    return {
        latest: (newest?.rows ?? []).map((r) => ({ metric: r.metric, value: r.value, unit: r.unit, ...(r.budget === null ? {} : { budget: r.budget }), at: r.at })),
        history: ordered.reverse().map((r) => ({ at: r.at, executionId: r.executionId, values: Object.fromEntries(r.rows.map((x) => [x.metric, x.value])) })),
    };
}

/** The slowest measured pages of a project, by the newest main-content time (falling back to load time). */
export async function projectSlowest(
    sql: Sql,
    projectId: string,
    limit = 5,
): Promise<Array<{ testId: string; title: string; testKey: string; metric: string; value: number; unit: string; budget: number | null; at: string }>> {
    const rows = await sql.all<{ test_case_id: string; title: string; test_key: string; metric: string; value: number; unit: string; budget: number | null; at: string }>(
        `SELECT m.test_case_id, t.title, t.test_key, m.metric, m.value, m.unit, m.budget, m.at
           FROM perf_metrics m
           JOIN test_cases t ON t.id = m.test_case_id
          WHERE m.project_id = ? AND m.metric IN ('lcp','load')
            AND m.at = (SELECT MAX(at) FROM perf_metrics x WHERE x.test_case_id = m.test_case_id)
          ORDER BY m.value DESC`,
        projectId,
    );
    // One row per test: prefer lcp over load.
    const best = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
        const have = best.get(r.test_case_id);
        if (!have || (r.metric === "lcp" && have.metric !== "lcp")) best.set(r.test_case_id, r);
    }
    return [...best.values()]
        .sort((a, b) => b.value - a.value)
        .slice(0, limit)
        .map((r) => ({ testId: r.test_case_id, title: r.title, testKey: r.test_key, metric: r.metric, value: r.value, unit: r.unit, budget: r.budget, at: r.at }));
}
