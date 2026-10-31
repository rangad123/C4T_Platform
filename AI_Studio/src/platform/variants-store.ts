import { randomUUID } from "node:crypto";
import { EXTRA_VARIANT_IDS, variantLabel } from "../engine/validation/variants.js";
import type { Db, Row } from "./db.js";

/**
 * Storage for browser / screen-size compatibility results. They live in test_executions next to the base
 * runs, tagged by `variant` (NULL = the base run), so a test's own history and status stay exactly as they were.
 * Statuses stored for variant rows: passed | failed | unavailable | skipped (the reason is kept in `error`).
 */

export type CompatStatus = "passed" | "failed" | "unavailable" | "skipped";

export interface VariantExecutionInput {
    testId: string;
    scriptId: string | null;
    jobId: string | null;
    variant: string;
    status: CompatStatus;
    reason?: string;
    durationMs: number;
    startedAt: string;
    steps: Array<{ index: number; title: string; status: string; error?: string }>;
}

export function addVariantExecution(db: Db, v: VariantExecutionInput): string {
    const id = randomUUID();
    db.tx(() => {
        db.run(
            "INSERT INTO test_executions (id, test_case_id, script_id, job_id, attempt, status, duration_ms, error, started_at, finished_at, variant) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            id, v.testId, v.scriptId, v.jobId, 1, v.status, v.durationMs, v.reason ?? null, v.startedAt, new Date().toISOString(), v.variant,
        );
        for (const s of v.steps) db.run("INSERT INTO test_execution_steps (id, execution_id, idx, title, status, error) VALUES (?,?,?,?,?,?)", randomUUID(), id, s.index, s.title, s.status, s.error ?? null);
    });
    return id;
}

/** True when the newest record for this variant is already the same "skipped" explanation (avoids piling up identical rows). */
export function isRepeatedSkip(db: Db, testId: string, variant: string, reason: string): boolean {
    const last = db.get<Row>(`SELECT status, error FROM test_executions WHERE test_case_id = ? AND variant = ? ORDER BY started_at DESC, ${db.dialect.insertionOrder()} DESC LIMIT 1`, testId, variant);
    return last?.status === "skipped" && last.error === reason;
}

export interface CompatEntry {
    status: CompatStatus;
    reason?: string;
    executionId: string;
    ranAt: string;
    durationMs: number | null;
    /** Where it went wrong, for failed runs. */
    failedStep?: { index: number; title: string };
    /** Evidence of a failed run (screenshot, recording, trace). */
    artifacts: Array<{ id: string; kind: string }>;
}

const LATEST = (db: Db) => `SELECT * FROM test_executions WHERE test_case_id = ? AND variant IS NOT NULL ORDER BY started_at DESC, ${db.dialect.insertionOrder()} DESC`;

/** The newest result per variant for one test. */
export function compatibilityFor(db: Db, testId: string): Record<string, CompatEntry> {
    const out: Record<string, CompatEntry> = {};
    for (const e of db.all<Row>(LATEST(db), testId)) {
        if (out[e.variant]) continue;
        const failed = e.status === "failed" ? db.get<Row>("SELECT idx, title FROM test_execution_steps WHERE execution_id = ? AND status = 'failed' ORDER BY idx LIMIT 1", e.id) : undefined;
        out[e.variant] = {
            status: e.status,
            ...(e.error ? { reason: e.error } : {}),
            executionId: e.id,
            ranAt: e.started_at,
            durationMs: e.duration_ms,
            ...(failed ? { failedStep: { index: failed.idx, title: failed.title } } : {}),
            artifacts: db.all<Row>("SELECT id, kind FROM artifacts WHERE execution_id = ? ORDER BY created_at", e.id).map((a) => ({ id: a.id, kind: a.kind })),
        };
    }
    return out;
}

/** What the tests list needs per test: which variants failed, which could not run, which passed. */
export interface CompatBrief {
    failing: string[];
    unavailable: string[];
    passed: string[];
    /** A test that works on desktop Chrome but not elsewhere is a compatibility finding (medium). */
    severity: { severity: "medium"; basis: string } | null;
}

export function compatForProject(db: Db, projectId: string): Map<string, CompatBrief> {
    const rows = db.all<Row>(
        `SELECT e.test_case_id AS test, e.variant, e.status FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ? AND e.variant IS NOT NULL ORDER BY e.started_at DESC, ${db.dialect.insertionOrder("e")} DESC`,
        projectId,
    );
    const seen = new Set<string>();
    const out = new Map<string, CompatBrief>();
    for (const r of rows) {
        const key = `${r.test}|${r.variant}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (r.status === "skipped") continue;
        const b = out.get(r.test) ?? { failing: [], unavailable: [], passed: [], severity: null };
        (r.status === "failed" ? b.failing : r.status === "unavailable" ? b.unavailable : b.passed).push(r.variant);
        out.set(r.test, b);
    }
    const canonical = (a: string, b: string) => (EXTRA_VARIANT_IDS as readonly string[]).indexOf(a) - (EXTRA_VARIANT_IDS as readonly string[]).indexOf(b);
    for (const b of out.values()) {
        b.failing.sort(canonical);
        b.unavailable.sort(canonical);
        b.passed.sort(canonical);
        if (b.failing.length) b.severity = { severity: "medium", basis: `works on desktop Chrome but fails on ${b.failing.map(variantLabel).join(", ")}` };
    }
    return out;
}
