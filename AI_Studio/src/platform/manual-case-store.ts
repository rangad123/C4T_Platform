/**
 * Storage for manual test cases, releases, per-release manual results and the sign-off audit trail.
 *
 * Plain rows in, plain objects out; the rules (what blocks an approval, what a release looks like) live in
 * `engine/manual/*` and `manual-releases.ts`. The audit trail is append-only: there is no update or delete method, and
 * the database refuses to change a row once written (deleting a project still removes its trail).
 */
import { randomUUID } from "node:crypto";
import { caseKey, caseRef, type CaseAutomation, type CasePriority, type ManualCase, type ManualCaseInput, type ManualResult, MAX_CASES } from "../engine/manual/cases.js";
import type { Db, Row } from "./db.js";
import { retryOnUniqueViolation, sqliteDialect, type Dialect } from "./sql-dialect.js";
import { actorLabel } from "./auth/actor.js";

/** Migration slot 15. */
export const MANUAL_MIGRATION = `
CREATE TABLE manual_cases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    area TEXT NOT NULL,
    priority TEXT NOT NULL,
    requirement TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL,
    linked_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_manual_cases_project ON manual_cases(project_id);
CREATE TABLE releases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,              -- open approved rejected
    snapshot_json TEXT,                -- the automated state when the release was opened or last refreshed
    snapshot_at TEXT,
    frozen_json TEXT,                  -- set while signed: the automated state and every manual check as they were
    signed_at TEXT,
    signed_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_releases_project ON releases(project_id, created_at);
CREATE TABLE release_results (
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    case_id TEXT NOT NULL REFERENCES manual_cases(id) ON DELETE CASCADE,
    result TEXT NOT NULL,              -- not_run passed failed blocked skipped
    note TEXT NOT NULL DEFAULT '',
    by_name TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    issue_provider TEXT,
    issue_external_id TEXT,
    issue_url TEXT,
    PRIMARY KEY (release_id, case_id)
);
CREATE TABLE release_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,                -- approved rejected reopened
    by_name TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    override INTEGER NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL           -- what the release looked like at that moment
);
CREATE INDEX idx_release_audit ON release_audit(release_id, id);
CREATE TRIGGER release_audit_no_update BEFORE UPDATE ON release_audit BEGIN SELECT RAISE(ABORT, 'audit entries cannot be changed'); END;
`;

/**
 * Migration slot 49: what a written test case says about itself. `automation` is whether a tool can check it (automated) or a
 * person must (manual); every case written before it is manual. `number` is the case's place in its project (TC-001), given to the
 * existing cases in the order they were added, which is the order the list showed them in; no two cases of a project share one (the
 * unique index makes a concurrent writer that took the same number try again). `requirement_id` is the requirement record the case
 * comes from; the free-text `requirement` stays as it was.
 */
export const caseTypesMigration = (d: Dialect = sqliteDialect): string => `
ALTER TABLE manual_cases ADD COLUMN automation TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE manual_cases ADD COLUMN number INTEGER;
ALTER TABLE manual_cases ADD COLUMN requirement_id TEXT REFERENCES requirements(id) ON DELETE SET NULL;
UPDATE manual_cases SET number = (SELECT COUNT(*) FROM manual_cases m2 WHERE m2.project_id = manual_cases.project_id AND ${d.insertionOrder("m2")} <= ${d.insertionOrder("manual_cases")});
CREATE INDEX idx_manual_cases_requirement ON manual_cases(requirement_id);
CREATE UNIQUE INDEX idx_manual_cases_number ON manual_cases(project_id, number);
`;

export const MAX_RELEASES = 200;

export type ReleaseStatus = "open" | "approved" | "rejected";

/** The automated state of a project at a moment: what the dashboard says, kept as plain data. */
export interface AutomatedSnapshot {
    takenAt: string;
    readiness: { state: "ready" | "needs-attention" | "blocked" | "unknown"; label: string; reasons: Array<{ code: string; text: string }>; stale: boolean };
    tests: { total: number; validated: number; needsAttention: number; couldNotValidate: number; waiting: number };
    latestRun: { jobId: string; finishedAt: string; trigger: string; mode: string; passRate: number | null; total: number; validated: number; failed: number; needsReview: number; /** What the pass rate is made of ("17 of 17 tests that ran passed."). Absent in releases signed before it existed. */ sentence?: string; /** The tests that did not take part in the run and the problems the project has right now: the other half of the picture. */ others?: string } | null;
    findings: { critical: number; high: number; medium: number; low: number; highOrCritical: number };
    flaky: number;
    apiBreakingChanges: number;
    lastRunAt: string | null;
    /** Present only while tests are in quarantine: left out of the state above, listed so an approver sees them. */
    quarantine?: { count: number; tests: Array<{ id: string; testKey: string; title: string; reason: string; expiresAt: string }> };
}

export interface FrozenItem {
    id: string;
    title: string;
    area: string;
    priority: CasePriority;
    requirement: string;
    steps: Array<{ action: string; expected: string }>;
    result: ManualResult;
    note: string;
    by: string;
    at: string | null;
}

export interface FrozenState {
    automated: AutomatedSnapshot;
    items: FrozenItem[];
}

export interface ReleaseRow {
    id: string;
    projectId: string;
    name: string;
    notes: string;
    status: ReleaseStatus;
    snapshot: AutomatedSnapshot | null;
    snapshotAt: string | null;
    frozen: FrozenState | null;
    signedAt: string | null;
    signedBy: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ResultRow {
    caseId: string;
    result: ManualResult;
    note: string;
    by: string;
    at: string;
    issue: { provider: string; externalId: string; url: string } | null;
}

export type AuditKind = "approved" | "rejected" | "reopened";

export interface AuditEntry {
    id: number;
    releaseId: string;
    at: string;
    kind: AuditKind;
    by: string;
    comment: string;
    /** An approval that went ahead although something blocked it. */
    override: boolean;
    state: unknown;
}

const now = () => new Date().toISOString();
const parse = <T>(s: string | null): T | null => (s ? (JSON.parse(s) as T) : null);

const toCase = (r: Row): ManualCase => ({
    id: r.id,
    title: r.title,
    area: r.area,
    priority: r.priority,
    requirement: r.requirement,
    steps: JSON.parse(r.steps_json),
    linkedTestIds: JSON.parse(r.linked_json),
    number: Number(r.number ?? 0),
    ref: caseRef(Number(r.number ?? 0)),
    automation: r.automation === "automated" ? "automated" : "manual",
    requirementId: r.requirement_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

const toRelease = (r: Row): ReleaseRow => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    notes: r.notes,
    status: r.status,
    snapshot: parse<AutomatedSnapshot>(r.snapshot_json),
    snapshotAt: r.snapshot_at,
    frozen: parse<FrozenState>(r.frozen_json),
    signedAt: r.signed_at,
    signedBy: r.signed_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

const toResult = (r: Row): ResultRow => ({
    caseId: r.case_id,
    result: r.result,
    note: r.note,
    by: r.by_name,
    at: r.at,
    issue: r.issue_url ? { provider: r.issue_provider, externalId: r.issue_external_id, url: r.issue_url } : null,
});

const toAudit = (r: Row): AuditEntry => ({ id: r.id, releaseId: r.release_id, at: r.at, kind: r.kind, by: r.by_name, comment: r.comment, override: Boolean(r.override), state: JSON.parse(r.state_json) });

export class ManualCaseStore {
    constructor(private readonly db: Db) {}

    // ── cases ───────────────────────────────────────────────────────────────
    listCases(projectId: string): ManualCase[] {
        return this.db.all(`SELECT * FROM manual_cases WHERE project_id = ? ORDER BY ${this.db.dialect.insertionOrder()}`, projectId).map(toCase);
    }

    countCases(projectId: string): number {
        return this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM manual_cases WHERE project_id = ?", projectId)!.c;
    }

    getCase(projectId: string, id: string): ManualCase | undefined {
        const r = this.db.get("SELECT * FROM manual_cases WHERE id = ? AND project_id = ?", id, projectId);
        return r ? toCase(r) : undefined;
    }

    /** Throws `Error("limit")` when the project already has the most cases allowed. */
    createCase(projectId: string, input: ManualCaseInput): ManualCase {
        return retryOnUniqueViolation(this.db.dialect, () =>
            this.db.tx(() => {
                if (this.countCases(projectId) >= MAX_CASES) throw new Error("limit");
                return this.insert(projectId, input);
            }),
        );
    }

    /**
     * A new case takes the next number of its project (one more than the highest), in the same statement. A deleted case's number is
     * not kept back: deleting the highest lets the next case take it again, as test ids (WEB-001) are given. Two writers taking the same
     * number at once meet the unique index; callers run this inside `retryOnUniqueViolation`, which tries the whole transaction again.
     */
    private insert(projectId: string, input: ManualCaseInput): ManualCase {
        const id = randomUUID();
        const t = now();
        this.db.run(
            `INSERT INTO manual_cases (id, project_id, title, area, priority, requirement, steps_json, linked_json, automation, requirement_id, number, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(number), 0) + 1 FROM manual_cases WHERE project_id = ?),?,?)`,
            id,
            projectId,
            input.title,
            input.area,
            input.priority,
            input.requirement,
            JSON.stringify(input.steps),
            JSON.stringify(input.linkedTestIds),
            input.automation ?? "manual",
            input.requirementId ?? null,
            projectId,
            t,
            t,
        );
        return this.getCase(projectId, id)!;
    }

    /** `automation` and `requirementId` absent keep what the case has. */
    updateCase(projectId: string, id: string, input: ManualCaseInput): ManualCase | undefined {
        const before = this.getCase(projectId, id);
        if (!before) return undefined;
        const automation: CaseAutomation = input.automation ?? before.automation;
        const requirementId = input.requirementId === undefined ? before.requirementId : input.requirementId;
        this.db.run(
            "UPDATE manual_cases SET title = ?, area = ?, priority = ?, requirement = ?, steps_json = ?, linked_json = ?, automation = ?, requirement_id = ?, updated_at = ? WHERE id = ? AND project_id = ?",
            input.title,
            input.area,
            input.priority,
            input.requirement,
            JSON.stringify(input.steps),
            JSON.stringify(input.linkedTestIds),
            automation,
            requirementId,
            now(),
            id,
            projectId,
        );
        return this.getCase(projectId, id);
    }

    /** How many written cases each requirement record has (by the requirement the case comes from). */
    countByRequirement(projectId: string): Map<string, number> {
        return new Map(
            this.db
                .all<{ requirement_id: string; c: number }>("SELECT requirement_id, COUNT(*) AS c FROM manual_cases WHERE project_id = ? AND requirement_id IS NOT NULL GROUP BY requirement_id", projectId)
                .map((r) => [r.requirement_id, Number(r.c)]),
        );
    }

    deleteCase(projectId: string, id: string): boolean {
        return Number(this.db.run("DELETE FROM manual_cases WHERE id = ? AND project_id = ?", id, projectId).changes) > 0;
    }

    /**
     * Add many cases at once, all or nothing on the limit. A case whose title and area match one already there is left out
     * (importing the same file twice adds nothing). Returns what was added and what was left out.
     */
    importCases(projectId: string, inputs: ManualCaseInput[]): { created: ManualCase[]; duplicates: number } {
        return retryOnUniqueViolation(this.db.dialect, () =>
            this.db.tx(() => {
                const { fresh, duplicates } = this.withoutDuplicates(projectId, inputs);
                if (this.countCases(projectId) + fresh.length > MAX_CASES) throw new Error("limit");
                return { created: fresh.map((c) => this.insert(projectId, c)), duplicates };
            }),
        );
    }

    /**
     * Cases the AI wrote, saved as far as they fit, in one transaction (so nothing changes between the count and the save): first those
     * already there (same title and area) are left out, then those of a requirement deleted meanwhile, then the room the project has
     * left decides how many of the rest are kept. Never throws for the limit: `limited` says how many did not fit, `gone` names the
     * requirements whose cases were left out because the requirement no longer exists.
     */
    addGenerated(projectId: string, inputs: ManualCaseInput[]): { created: ManualCase[]; duplicates: number; limited: number; gone: string[] } {
        return retryOnUniqueViolation(this.db.dialect, () =>
            this.db.tx(() => {
                const { fresh, duplicates } = this.withoutDuplicates(projectId, inputs);
                const exists = new Map<string, boolean>();
                const stillThere = (rid: string) => {
                    if (!exists.has(rid)) exists.set(rid, Boolean(this.db.get("SELECT 1 AS x FROM requirements WHERE id = ? AND project_id = ?", rid, projectId)));
                    return exists.get(rid)!;
                };
                const live = fresh.filter((c) => !c.requirementId || stillThere(c.requirementId));
                const room = Math.max(0, MAX_CASES - this.countCases(projectId));
                const kept = live.slice(0, room);
                const gone = [...exists].filter(([, there]) => !there).map(([rid]) => rid);
                return { created: kept.map((c) => this.insert(projectId, c)), duplicates, limited: live.length - kept.length, gone };
            }),
        );
    }

    /** Those of `inputs` whose title and area match no case of the project nor an earlier input, and how many were left out. */
    private withoutDuplicates(projectId: string, inputs: ManualCaseInput[]): { fresh: ManualCaseInput[]; duplicates: number } {
        const seen = new Set(this.listCases(projectId).map(caseKey));
        const fresh: ManualCaseInput[] = [];
        let duplicates = 0;
        for (const c of inputs) {
            const k = caseKey(c);
            if (seen.has(k)) duplicates++;
            else (seen.add(k), fresh.push(c));
        }
        return { fresh, duplicates };
    }

    // ── releases ────────────────────────────────────────────────────────────
    countReleases(projectId: string): number {
        return this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM releases WHERE project_id = ?", projectId)!.c;
    }

    createRelease(projectId: string, a: { name: string; notes: string; snapshot: AutomatedSnapshot }): ReleaseRow {
        const id = randomUUID();
        const t = now();
        this.db.run(
            "INSERT INTO releases (id, project_id, name, notes, status, snapshot_json, snapshot_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            id,
            projectId,
            a.name,
            a.notes,
            "open",
            JSON.stringify(a.snapshot),
            a.snapshot.takenAt,
            t,
            t,
        );
        return this.getRelease(projectId, id)!;
    }

    listReleases(projectId: string): ReleaseRow[] {
        return this.db.all(`SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC, ${this.db.dialect.insertionOrder()} DESC`, projectId).map(toRelease);
    }

    getRelease(projectId: string, id: string): ReleaseRow | undefined {
        const r = this.db.get("SELECT * FROM releases WHERE id = ? AND project_id = ?", id, projectId);
        return r ? toRelease(r) : undefined;
    }

    saveSnapshot(releaseId: string, snapshot: AutomatedSnapshot): void {
        this.db.run("UPDATE releases SET snapshot_json = ?, snapshot_at = ?, updated_at = ? WHERE id = ?", JSON.stringify(snapshot), snapshot.takenAt, now(), releaseId);
    }

    // ── results ─────────────────────────────────────────────────────────────
    results(releaseId: string): Map<string, ResultRow> {
        return new Map(this.db.all("SELECT * FROM release_results WHERE release_id = ?", releaseId).map((r) => [r.case_id as string, toResult(r)]));
    }

    /** Record a result. `note` and `by` absent keep what is there; an empty string clears it. */
    setResult(releaseId: string, caseId: string, a: { result: ManualResult; note?: string; by?: string }): ResultRow {
        const prev = this.db.get("SELECT * FROM release_results WHERE release_id = ? AND case_id = ?", releaseId, caseId);
        const note = a.note ?? prev?.note ?? "";
        const by = a.by ?? prev?.by_name ?? "";
        if (prev) this.db.run("UPDATE release_results SET result = ?, note = ?, by_name = ?, at = ? WHERE release_id = ? AND case_id = ?", a.result, note, by, now(), releaseId, caseId);
        else this.db.run("INSERT INTO release_results (release_id, case_id, result, note, by_name, at) VALUES (?,?,?,?,?,?)", releaseId, caseId, a.result, note, by, now());
        this.touch(releaseId);
        return toResult(this.db.get("SELECT * FROM release_results WHERE release_id = ? AND case_id = ?", releaseId, caseId)!);
    }

    setIssue(releaseId: string, caseId: string, issue: { provider: string; externalId: string; url: string }): void {
        this.db.run("UPDATE release_results SET issue_provider = ?, issue_external_id = ?, issue_url = ? WHERE release_id = ? AND case_id = ?", issue.provider, issue.externalId, issue.url, releaseId, caseId);
    }

    private touch(releaseId: string): void {
        this.db.run("UPDATE releases SET updated_at = ? WHERE id = ?", now(), releaseId);
    }

    // ── decisions ───────────────────────────────────────────────────────────
    /** Sign a release: freeze it and append the audit entry in one step. */
    sign(releaseId: string, a: { status: "approved" | "rejected"; by: string; comment: string; override: boolean; frozen: FrozenState; state: unknown }): AuditEntry {
        return this.db.tx(() => {
            const t = now();
            this.db.run("UPDATE releases SET status = ?, frozen_json = ?, snapshot_json = ?, snapshot_at = ?, signed_at = ?, signed_by = ?, updated_at = ? WHERE id = ?", a.status, JSON.stringify(a.frozen), JSON.stringify(a.frozen.automated), a.frozen.automated.takenAt, t, a.by, t, releaseId);
            return this.appendAudit(releaseId, { kind: a.status, by: a.by, comment: a.comment, override: a.override, state: a.state, at: t });
        });
    }

    /** Open a signed release again. The decision stays in the audit trail. */
    reopen(releaseId: string, a: { by: string; comment: string; state: unknown }): AuditEntry {
        return this.db.tx(() => {
            const t = now();
            this.db.run("UPDATE releases SET status = 'open', frozen_json = NULL, signed_at = NULL, signed_by = NULL, updated_at = ? WHERE id = ?", t, releaseId);
            return this.appendAudit(releaseId, { kind: "reopened", by: a.by, comment: a.comment, override: false, state: a.state, at: t });
        });
    }

    private appendAudit(releaseId: string, a: { kind: AuditKind; by: string; comment: string; override: boolean; state: unknown; at: string }): AuditEntry {
        const projectId = this.db.get<{ project_id: string }>("SELECT project_id FROM releases WHERE id = ?", releaseId)!.project_id;
        // `by_name` is the name the person typed; `actor` is who was really signed in (or the access key), from the request (auth/actor.ts).
        return toAudit(this.db.get("INSERT INTO release_audit (release_id, project_id, at, kind, by_name, comment, override, state_json, actor) VALUES (?,?,?,?,?,?,?,?,?) RETURNING *", releaseId, projectId, a.at, a.kind, a.by, a.comment, a.override ? 1 : 0, JSON.stringify(a.state), actorLabel())!);
    }

    audit(releaseId: string): AuditEntry[] {
        return this.db.all("SELECT * FROM release_audit WHERE release_id = ? ORDER BY id", releaseId).map(toAudit);
    }
}
