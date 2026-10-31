/**
 * Storage of flaky-test quarantine (migration slot 18): the entries and an append-only history of what happened to them.
 *
 * `quarantineGate` is the ONE answer to "does this test decide anything right now?". Everything that gates on a test's result
 * (run summaries, alerts, readiness, runbook checks, sign-off, CI output, deploy status) asks it. It is computed on read:
 * an entry that has expired no longer gates, whether or not a sweep has recorded the expiry yet.
 */
import { randomUUID } from "node:crypto";
import { TestSpecSchema } from "../engine/spec/schema.js";
import { clampDays, expiryFrom, gateEntries, isExpired, latestExpiry, makeGate, NO_GATE, type GateEntry, type HistoryKind, type QuarantineGate, type QuarantineSource, type QuarantineStatus } from "../engine/quarantine/rules.js";
import type { Db, Row } from "./db.js";
import { HttpError } from "./http-error.js";
import { NOT_FROM_CANCELLED_JOB } from "./cancel-summary.js";

export const QUARANTINE_MIGRATION = `
CREATE TABLE quarantine_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    test_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,                 -- manual | suggested
    by_name TEXT NOT NULL,
    since TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,                 -- active | released | expired
    reviewed_at TEXT,
    reviewed_by TEXT,
    ended_at TEXT,
    ended_by TEXT
);
CREATE INDEX idx_quarantine_project ON quarantine_entries(project_id, status);
CREATE UNIQUE INDEX idx_quarantine_one_active ON quarantine_entries(test_id) WHERE status = 'active';
CREATE TABLE quarantine_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    test_id TEXT NOT NULL,                -- kept without a foreign key: the trail outlives the test
    test_key TEXT NOT NULL,
    title TEXT NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,                   -- quarantined | released | expired | reviewed
    by_name TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_quarantine_history ON quarantine_history(project_id, id);
CREATE INDEX idx_quarantine_history_test ON quarantine_history(test_id, id);
CREATE TRIGGER quarantine_history_no_update BEFORE UPDATE ON quarantine_history BEGIN SELECT RAISE(ABORT, 'quarantine history cannot be changed'); END;
`;

export interface QuarantineEntry {
    id: string;
    projectId: string;
    testId: string;
    testKey: string;
    title: string;
    reason: string;
    source: QuarantineSource;
    by: string;
    since: string;
    expiresAt: string;
    status: QuarantineStatus;
    reviewedAt: string | null;
    reviewedBy: string | null;
    endedAt: string | null;
    endedBy: string | null;
}

export interface HistoryRow {
    id: number;
    entryId: string;
    testId: string;
    testKey: string;
    title: string;
    at: string;
    kind: HistoryKind;
    by: string;
    reason: string;
    detail: Record<string, unknown>;
}

const ENTRY_SQL = `SELECT q.*, t.test_key, t.title FROM quarantine_entries q JOIN test_cases t ON t.id = q.test_id`;

const toEntry = (r: Row): QuarantineEntry => ({
    id: r.id,
    projectId: r.project_id,
    testId: r.test_id,
    testKey: r.test_key,
    title: r.title,
    reason: r.reason,
    source: r.source,
    by: r.by_name,
    since: r.since,
    expiresAt: r.expires_at,
    status: r.status,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by,
    endedAt: r.ended_at,
    endedBy: r.ended_by,
});

export interface NewEntry {
    projectId: string;
    testId: string;
    testKey: string;
    title: string;
    reason: string;
    source: QuarantineSource;
    by: string;
    days?: number;
}

/** Statuses (oldest to newest) of a test's latest executions of its CURRENT script, with the time of each. */
export interface ExecutionPoint {
    status: string;
    at: string;
}

const WINDOW = 20;

/** Latest executions per test (current script only, the base run only, skipped ones ignored). */
export function recentExecutions(db: Db, testIds: readonly string[]): Map<string, ExecutionPoint[]> {
    const out = new Map<string, ExecutionPoint[]>();
    if (testIds.length === 0) return out;
    const marks = testIds.map(() => "?").join(",");
    const rows = db.all<Row>(
        `SELECT * FROM (
            SELECT e.test_case_id AS test_id, e.status, COALESCE(e.finished_at, e.started_at) AS at, COALESCE(s.content_hash, e.script_id, '') AS hash,
                   ROW_NUMBER() OVER (PARTITION BY e.test_case_id ORDER BY COALESCE(e.finished_at, e.started_at) DESC, e.attempt DESC) AS rn
              FROM test_executions e LEFT JOIN generated_scripts s ON s.id = e.script_id
             WHERE e.test_case_id IN (${marks}) AND e.status != 'skipped' AND e.environment IS NULL AND ${NOT_FROM_CANCELLED_JOB}
         ) WHERE rn <= ${WINDOW} ORDER BY test_id, rn DESC`,
        ...testIds,
    );
    const byTest = new Map<string, Row[]>();
    for (const r of rows) (byTest.get(r.test_id) ?? byTest.set(r.test_id, []).get(r.test_id)!).push(r);
    for (const [id, list] of byTest) {
        const hash = list.at(-1)!.hash;
        out.set(id, list.filter((r) => r.hash === hash).map((r) => ({ status: r.status, at: r.at })));
    }
    return out;
}

/**
 * The tests that are quarantined right now and still allowed to be: stored as active, not past their expiry, not a check-family
 * test, not failing every run. Optionally for one project. One cheap read; call it once per request and reuse the answer.
 */
export function quarantineGate(db: Db, nowMs: number = Date.now(), projectId?: string): QuarantineGate {
    const rows = projectId
        ? db.all<Row>(`${ENTRY_SQL} WHERE q.status = 'active' AND q.expires_at > ? AND q.project_id = ?`, new Date(nowMs).toISOString(), projectId)
        : db.all<Row>(`${ENTRY_SQL} WHERE q.status = 'active' AND q.expires_at > ?`, new Date(nowMs).toISOString());
    if (rows.length === 0) return NO_GATE;
    const tests = new Map<string, Row>();
    for (const t of db.all<Row>(`SELECT id, spec_json, validation_status, validation_reason FROM test_cases WHERE id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.test_id))) tests.set(t.id, t);
    const recent = recentExecutions(db, rows.map((r) => r.test_id));
    const pairs = rows.flatMap((r) => {
        const t = tests.get(r.test_id);
        if (!t) return [];
        let spec;
        try {
            spec = TestSpecSchema.parse(JSON.parse(t.spec_json));
        } catch {
            return []; // a test whose definition cannot be read gates as usual
        }
        const entry: GateEntry = { id: r.id, projectId: r.project_id, testId: r.test_id, testKey: r.test_key, title: r.title, testStatus: t.validation_status, reason: r.reason, since: r.since, expiresAt: r.expires_at };
        return [{ entry, test: { spec, reason: t.validation_reason as string | null } }];
    });
    return makeGate(gateEntries(pairs, new Map([...recent].map(([id, pts]) => [id, pts.map((p) => p.status)]))));
}

export class QuarantineStore {
    constructor(
        private readonly db: Db,
        private readonly clock: () => number = Date.now,
    ) {}

    private nowIso = () => new Date(this.clock()).toISOString();

    private log(e: { projectId: string; entryId: string; testId: string; testKey: string; title: string }, kind: HistoryKind, by: string, reason = "", detail: Record<string, unknown> = {}, at = this.nowIso()): void {
        this.db.run("INSERT INTO quarantine_history (project_id, entry_id, test_id, test_key, title, at, kind, by_name, reason, detail_json) VALUES (?,?,?,?,?,?,?,?,?,?)", e.projectId, e.entryId, e.testId, e.testKey, e.title, at, kind, by, reason, JSON.stringify(detail));
    }

    /** Ends every entry whose time has passed and records it. Safe to call from any read; returns how many ended. */
    sweep(nowMs: number = this.clock()): number {
        const due = this.db.all<Row>(`${ENTRY_SQL} WHERE q.status = 'active' AND q.expires_at <= ?`, new Date(nowMs).toISOString());
        for (const r of due) {
            this.db.tx(() => {
                const res = this.db.run("UPDATE quarantine_entries SET status = 'expired', ended_at = ?, ended_by = 'system' WHERE id = ? AND status = 'active'", r.expires_at, r.id);
                if (Number(res.changes) > 0) this.log({ projectId: r.project_id, entryId: r.id, testId: r.test_id, testKey: r.test_key, title: r.title }, "expired", "system", "Quarantine ended; this test counts again.", {}, r.expires_at);
            });
        }
        return due.length;
    }

    get(id: string): QuarantineEntry | undefined {
        this.sweep();
        const r = this.db.get<Row>(`${ENTRY_SQL} WHERE q.id = ?`, id);
        return r ? toEntry(r) : undefined;
    }

    /** The test's quarantine in force right now, if any (it may still be dropped from gating by the gate's own checks). */
    activeFor(testId: string): QuarantineEntry | undefined {
        this.sweep();
        const r = this.db.get<Row>(`${ENTRY_SQL} WHERE q.test_id = ? AND q.status = 'active'`, testId);
        return r ? toEntry(r) : undefined;
    }

    /** Newest first. */
    list(projectId: string, status?: QuarantineStatus): QuarantineEntry[] {
        this.sweep();
        const rows = status
            ? this.db.all<Row>(`${ENTRY_SQL} WHERE q.project_id = ? AND q.status = ? ORDER BY q.since DESC, ${this.db.dialect.insertionOrder("q")} DESC`, projectId, status)
            : this.db.all<Row>(`${ENTRY_SQL} WHERE q.project_id = ? ORDER BY q.since DESC, ${this.db.dialect.insertionOrder("q")} DESC`, projectId);
        return rows.map(toEntry);
    }

    create(n: NewEntry, evidence?: Record<string, unknown>): QuarantineEntry {
        this.sweep();
        const now = this.clock();
        const id = randomUUID();
        try {
            this.db.tx(() => {
                this.db.run(
                    "INSERT INTO quarantine_entries (id, project_id, test_id, reason, source, by_name, since, expires_at, status) VALUES (?,?,?,?,?,?,?,?,?)",
                    id,
                    n.projectId,
                    n.testId,
                    n.reason,
                    n.source,
                    n.by,
                    new Date(now).toISOString(),
                    expiryFrom(now, clampDays(n.days)),
                    "active",
                );
                this.log({ projectId: n.projectId, entryId: id, testId: n.testId, testKey: n.testKey, title: n.title }, "quarantined", n.by, n.reason, { source: n.source, days: clampDays(n.days), ...(evidence ? { evidence } : {}) });
            });
        } catch (e) {
            if (/UNIQUE/i.test(String((e as Error).message))) throw new HttpError(409, "This test is already in quarantine.");
            throw e;
        }
        return this.get(id)!;
    }

    release(id: string, by: string, note = ""): QuarantineEntry {
        const e = this.get(id);
        if (!e) throw new HttpError(404, "Quarantine not found");
        if (e.status !== "active") throw new HttpError(409, e.status === "expired" ? "This quarantine has already ended: the test counts again." : "This quarantine was already released.");
        this.db.tx(() => {
            this.db.run("UPDATE quarantine_entries SET status = 'released', ended_at = ?, ended_by = ? WHERE id = ? AND status = 'active'", this.nowIso(), by, id);
            this.log({ ...e, entryId: e.id }, "released", by, note);
        });
        return this.get(id)!;
    }

    /** Records that a person looked at it again; may move the end date later, never beyond 60 days after it began. */
    review(id: string, by: string, extendDays?: number, note = ""): QuarantineEntry {
        const e = this.get(id);
        if (!e) throw new HttpError(404, "Quarantine not found");
        if (e.status !== "active") throw new HttpError(409, "This quarantine has ended, so there is nothing to review. Quarantine the test again if it is still unreliable.");
        const now = this.clock();
        let expires = e.expiresAt;
        if (extendDays) {
            const cap = latestExpiry(e.since);
            if (cap <= e.expiresAt) throw new HttpError(409, "This quarantine is already at its longest (60 days). Fix the test or release it.");
            const wanted = new Date(now + clampDays(extendDays) * 86_400_000).toISOString();
            // Reviewing never shortens it, and never goes past 60 days after it began.
            if (wanted > e.expiresAt) expires = wanted > cap ? cap : wanted;
        }
        this.db.tx(() => {
            this.db.run("UPDATE quarantine_entries SET reviewed_at = ?, reviewed_by = ?, expires_at = ? WHERE id = ?", this.nowIso(), by, expires, id);
            this.log({ ...e, entryId: e.id }, "reviewed", by, note, expires !== e.expiresAt ? { expiresAt: expires } : {});
        });
        return this.get(id)!;
    }

    /** Append-only: newest first. */
    history(projectId: string, opts: { testId?: string; limit?: number } = {}): HistoryRow[] {
        this.sweep();
        const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
        const rows = opts.testId
            ? this.db.all<Row>("SELECT * FROM quarantine_history WHERE project_id = ? AND test_id = ? ORDER BY id DESC LIMIT ?", projectId, opts.testId, limit)
            : this.db.all<Row>("SELECT * FROM quarantine_history WHERE project_id = ? ORDER BY id DESC LIMIT ?", projectId, limit);
        return rows.map((r) => ({ id: r.id, entryId: r.entry_id, testId: r.test_id, testKey: r.test_key, title: r.title, at: r.at, kind: r.kind, by: r.by_name, reason: r.reason, detail: JSON.parse(r.detail_json) }));
    }

    isExpiredNow(e: QuarantineEntry): boolean {
        return isExpired(e, this.clock());
    }
}
