/**
 * Evaluation runs kept by the platform (Settings, Quality): the history of how well the AI tester did on the owner's corpus, so each run can
 * be compared with the one before it. Only the harness's own numbers are stored (counts, rates, test titles and one-line reasons): never a
 * sign-in detail, a page or a screenshot (those stay with the projects the run created).
 */
import { randomUUID } from "node:crypto";
import { compareMetrics, type MetricChange } from "../eval/metrics.js";
import type { EvalRun } from "../eval/run.js";
import type { Db, Row } from "./db.js";

/** Migration slot 30. `IF NOT EXISTS` because the store also makes sure of it on first use (see `ensureEvalTables`). */
export const EVAL_MIGRATION = `
CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    corpus TEXT NOT NULL,
    plan_only INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    overall_json TEXT NOT NULL,       -- the run's overall numbers (the list reads only this)
    run_json TEXT NOT NULL            -- the whole run as the harness wrote it (validated, at most MAX_RUN_BYTES)
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_corpus ON eval_runs(corpus, plan_only, started_at);
`;

/** Runs kept; the oldest go first. */
export const MAX_KEPT_RUNS = 500;

const ensured = new WeakSet<Db>();
/** The migration slot creates the table; this also covers a database opened before the slot was registered (slots were filled out of order this round). */
export function ensureEvalTables(db: Db): void {
    if (ensured.has(db)) return;
    db.raw.exec(EVAL_MIGRATION);
    ensured.add(db);
}

export interface EvalRunSummary {
    id: string;
    corpus: string;
    planOnly: boolean;
    startedAt: string;
    finishedAt: string;
    overall: EvalRun["overall"];
}

export interface Comparison {
    comparedWith: { id: string; startedAt: string };
    overall: MetricChange[];
    entries: Array<{ id: string; metrics: MetricChange[] }>;
}

const summaryOf = (r: Row): EvalRunSummary => ({ id: r.id, corpus: r.corpus, planOnly: r.plan_only === 1, startedAt: r.started_at, finishedAt: r.finished_at, overall: JSON.parse(r.overall_json) });

/** An entry's numbers and rates in one object, the shape `compareMetrics` reads. */
const entryView = (e: EvalRun["entries"][number]) => (e.metrics ? { ...e.metrics, rates: e.rates } : undefined);

export class EvalStore {
    constructor(private readonly db: Db) {
        ensureEvalTables(db);
    }

    add(run: EvalRun, json: string): string {
        const id = randomUUID();
        this.db.run(
            "INSERT INTO eval_runs (id, corpus, plan_only, started_at, finished_at, created_at, overall_json, run_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            id,
            run.corpus,
            run.planOnly ? 1 : 0,
            run.startedAt,
            run.finishedAt,
            new Date().toISOString(),
            JSON.stringify(run.overall),
            json,
        );
        this.db.run("DELETE FROM eval_runs WHERE id NOT IN (SELECT id FROM eval_runs ORDER BY started_at DESC, created_at DESC LIMIT ?)", MAX_KEPT_RUNS);
        return id;
    }

    list(limit = 50): EvalRunSummary[] {
        return this.db.all("SELECT id, corpus, plan_only, started_at, finished_at, overall_json FROM eval_runs ORDER BY started_at DESC, created_at DESC LIMIT ?", Math.max(1, Math.min(limit, 200))).map(summaryOf);
    }

    get(id: string): { summary: EvalRunSummary; run: EvalRun } | undefined {
        const r = this.db.get("SELECT * FROM eval_runs WHERE id = ?", id);
        return r ? { summary: summaryOf(r), run: JSON.parse(r.run_json) as EvalRun } : undefined;
    }

    delete(id: string): boolean {
        return Number(this.db.run("DELETE FROM eval_runs WHERE id = ?", id).changes) > 0;
    }

    /** The run before this one of the same corpus and the same kind (full, or plan only), if any. */
    previousOf(s: EvalRunSummary): EvalRunSummary | undefined {
        const r = this.db.get(
            "SELECT id, corpus, plan_only, started_at, finished_at, overall_json FROM eval_runs WHERE corpus = ? AND plan_only = ? AND id <> ? AND (started_at < ? OR (started_at = ? AND created_at < (SELECT created_at FROM eval_runs WHERE id = ?))) ORDER BY started_at DESC, created_at DESC LIMIT 1",
            s.corpus,
            s.planOnly ? 1 : 0,
            s.id,
            s.startedAt,
            s.startedAt,
            s.id,
        );
        return r ? summaryOf(r) : undefined;
    }

    /** Better or worse than the previous run, number by number, overall and for every entry both runs have. Null for the first run. */
    compare(s: EvalRunSummary, run?: EvalRun): Comparison | null {
        const prev = this.previousOf(s);
        if (!prev) return null;
        const out: Comparison = { comparedWith: { id: prev.id, startedAt: prev.startedAt }, overall: compareMetrics(prev.overall, s.overall), entries: [] };
        if (run) {
            const before = this.get(prev.id)?.run;
            for (const e of run.entries) {
                const p = before?.entries.find((x) => x.id === e.id);
                const cur = entryView(e);
                if (!cur) continue;
                out.entries.push({ id: e.id, metrics: compareMetrics(p ? entryView(p) : undefined, cur) });
            }
        }
        return out;
    }
}
