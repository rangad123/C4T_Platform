/**
 * Review and approval of test versions (migration slot 40).
 *
 * A test's version is what it runs: its steps (`spec_json`) and, for a test whose code a person owns, that code. Every change to
 * either (written by the AI, edited by a person, or repaired after a failed run) becomes a new version. The project's review policy
 * says which of those start as a draft that a Project Admin must approve; the others are approved by the policy at once.
 *
 * States: draft → in review → approved, or rejected; a newer version supersedes the drafts before it, and a newer approval the
 * approval before it. Approved versions are never changed. Runs, schedules and suites run each test's latest approved version
 * (`pinRunVersions`); a test with none is skipped and reported as waiting for approval, and the run records the version it ran.
 *
 * Sync status of a version: whether its plain-English steps and its code agree. Code made from the steps is made again at every
 * run, so a person's code is the only code that can drift; a change to the steps of such a test is never written over it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CustomRunInputs } from "./custom-run.js";
import type { Db, Row } from "./db.js";
import { currentActor, SYSTEM_ACTOR, type Actor } from "./auth/actor.js";
import { retryOnUniqueViolation } from "./sql-dialect.js";

export const REVIEW_MIGRATION = `
CREATE TABLE test_versions (
    id TEXT PRIMARY KEY,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    state TEXT NOT NULL,                  -- draft | in_review | approved | rejected | superseded
    source TEXT NOT NULL,                 -- ai | person | healing | import | shared | takeover | upgrade
    spec_json TEXT NOT NULL,              -- the steps of this version; never changed once approved
    code TEXT,                            -- the script, when a person owns the code; null when the code is made from the steps
    framework TEXT NOT NULL,
    script_id TEXT,                       -- the script a run made from these steps (null until a run did)
    regen_note TEXT,                      -- a change to the steps that was not applied, because a person owns the code
    author_kind TEXT NOT NULL,            -- user | key | open | ai | system
    author_id TEXT,
    author_name TEXT NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,      -- 1: approved by the project's policy, not by a person
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    submitted_at TEXT,
    decided_by_id TEXT,
    decided_by_name TEXT,
    decided_at TEXT,
    decision_note TEXT,
    UNIQUE (test_case_id, version)
);
CREATE INDEX idx_test_versions_state ON test_versions(project_id, state);
CREATE TABLE test_version_comments (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES test_versions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                   -- comment | submitted | approved | rejected | changes
    body TEXT,
    author_id TEXT,
    author_name TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_test_version_comments ON test_version_comments(version_id, created_at);
CREATE TABLE review_policies (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    ai_generated INTEGER NOT NULL DEFAULT 1,
    edits INTEGER NOT NULL DEFAULT 1,
    healing INTEGER NOT NULL DEFAULT 1,
    sole_admin_self_approve INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by TEXT
);
CREATE TABLE test_run_versions (
    job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    version_id TEXT REFERENCES test_versions(id) ON DELETE SET NULL,
    version INTEGER,
    outcome TEXT NOT NULL,                -- ran | waiting
    PRIMARY KEY (job_id, test_case_id)
);
ALTER TABLE test_executions ADD COLUMN test_version_id TEXT REFERENCES test_versions(id) ON DELETE SET NULL;
-- The upgrade: every existing test starts with its current steps (and a person's code) as approved version 1, so nothing that ran
-- before stops running. Code made from the steps is in step with them; that script is recorded as made from this version.
INSERT INTO test_versions (id, test_case_id, project_id, version, state, source, spec_json, code, framework, script_id, author_kind, author_id, author_name, auto, created_at, updated_at, decided_by_name, decided_at, decision_note)
SELECT 'v1-' || t.id, t.id, t.project_id, 1, 'approved', 'upgrade', t.spec_json,
       CASE WHEN c.test_case_id IS NULL THEN NULL ELSE (SELECT s.content FROM generated_scripts s WHERE s.test_case_id = t.id AND s.is_current = 1 AND s.executable = 1 ORDER BY s.created_at DESC LIMIT 1) END,
       t.framework,
       CASE WHEN c.test_case_id IS NULL THEN (SELECT s.id FROM generated_scripts s WHERE s.test_case_id = t.id AND s.is_current = 1 AND s.executable = 1 ORDER BY s.created_at DESC LIMIT 1) ELSE NULL END,
       'system', NULL, 'Platform', 1, t.updated_at, t.updated_at, 'Platform', t.updated_at,
       'Approved when review and approval arrived, so tests that ran before keep running.'
  FROM test_cases t LEFT JOIN custom_tests c ON c.test_case_id = t.id;
`;

export type VersionState = "draft" | "in_review" | "approved" | "rejected" | "superseded";
export type VersionSource = "ai" | "person" | "healing" | "import" | "shared" | "takeover" | "upgrade";
export type SyncStatus = "in_sync" | "text_changed" | "code_changed" | "needs_regeneration" | "code_only";

export interface ReviewPolicy {
    /** Tests the AI writes or rewrites start as drafts. */
    aiGenerated: boolean;
    /** Changes people make (steps, code, imports) start as drafts. */
    edits: boolean;
    /** Repairs made after a failed run start as drafts. */
    healing: boolean;
    /** The only Project Admin of a project may approve their own change. */
    soleAdminSelfApprove: boolean;
}
export const DEFAULT_POLICY: ReviewPolicy = { aiGenerated: true, edits: true, healing: true, soleAdminSelfApprove: true };

export interface TestVersion {
    id: string;
    testId: string;
    projectId: string;
    version: number;
    state: VersionState;
    source: VersionSource;
    spec: unknown;
    code: string | null;
    framework: string;
    scriptId: string | null;
    regenNote: string | null;
    author: { kind: string; id: string | null; name: string };
    auto: boolean;
    createdAt: string;
    updatedAt: string;
    submittedAt: string | null;
    decision: { byId: string | null; byName: string; at: string; note: string | null } | null;
}

export interface VersionComment {
    id: string;
    kind: "comment" | "submitted" | "approved" | "rejected" | "changes";
    body: string | null;
    authorId: string | null;
    authorName: string;
    createdAt: string;
}

const now = () => new Date().toISOString();

/** JSON text with object keys sorted: two specs that differ only in key order are the same version. */
export function canonicalJson(text: string): string {
    const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v);
    try {
        return JSON.stringify(sort(JSON.parse(text)));
    } catch {
        return text;
    }
}

const toVersion = (r: Row): TestVersion => ({
    id: r.id,
    testId: r.test_case_id,
    projectId: r.project_id,
    version: Number(r.version),
    state: r.state,
    source: r.source,
    spec: JSON.parse(r.spec_json as string),
    code: r.code ?? null,
    framework: r.framework,
    scriptId: r.script_id ?? null,
    regenNote: r.regen_note ?? null,
    author: { kind: r.author_kind, id: r.author_id ?? null, name: r.author_name },
    auto: Boolean(r.auto),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    submittedAt: r.submitted_at ?? null,
    decision: r.decided_at ? { byId: r.decided_by_id ?? null, byName: r.decided_by_name ?? "", at: r.decided_at, note: r.decision_note ?? null } : null,
});

/** Who a change is by: the person (or key) acting, or the AI for what a job writes. */
/**
 * The person who started the job that is writing now ("user:<id>", "key:<id>"), so the AI's work in it is theirs to have reviewed by someone else.
 * Set by the job runner around a job, and around turning an agent run into a draft.
 */
const jobStarter = new AsyncLocalStorage<string | null>();
export const starterKey = (a: { kind: string; id?: string | null }): string | null => (a.kind === "user" || a.kind === "key" || a.kind === "open" ? `${a.kind}:${a.id ?? ""}` : null);
export function withJobStarter<T>(starter: { kind: string; id?: string | null } | undefined, fn: () => T): T {
    return jobStarter.run(starter ? starterKey(starter) : null, fn);
}

function authorOf(source: VersionSource, actor: Actor): { kind: string; id: string | null; name: string } {
    // The AI's versions carry, as their id, the person who started the job that made them (null when nobody did: a schedule, a trigger).
    if (source === "ai") return { kind: "ai", id: jobStarter.getStore() ?? null, name: "AI" };
    if (source === "healing") return { kind: "ai", id: jobStarter.getStore() ?? null, name: "Repair after a failed run" };
    if (actor.kind === "user" || actor.kind === "key" || actor.kind === "open") return { kind: actor.kind, id: actor.id ?? null, name: actor.name };
    return { kind: "system", id: null, name: actor.name };
}

/** Whether a change of this kind starts as a draft under the policy (shared renames and take-overs keep the state before them). */
function needsApproval(policy: ReviewPolicy, source: VersionSource): boolean {
    switch (source) {
        case "ai":
            return policy.aiGenerated;
        case "healing":
            return policy.healing;
        case "person":
        case "import":
            return policy.edits;
        default:
            return false;
    }
}

/** What a change written without a stated source is: a repair when a run's background work wrote it, else a person's (or the platform's own) edit. */
const inferredSource = (actor: Actor): VersionSource => (actor.kind === "runner" || actor.kind === "schedule" || actor.kind === "trigger" ? "healing" : "person");

/**
 * The source of what is written inside `fn`, for a route that saves the model's work through the ordinary path a person uses (an AI
 * script saved like "Write it as text"): the new test's first version is the AI's, so it is reviewed as AI work.
 */
const sourceOverride = new AsyncLocalStorage<VersionSource>();
export function withVersionSource<T>(source: VersionSource, fn: () => T): T {
    return sourceOverride.run(source, fn);
}

export class ReviewStore {
    constructor(readonly db: Db) {}

    // ── policy ──────────────────────────────────────────────────────────────
    policy(projectId: string): ReviewPolicy {
        const r = this.db.get("SELECT * FROM review_policies WHERE project_id = ?", projectId);
        if (!r) return { ...DEFAULT_POLICY };
        return { aiGenerated: Boolean(r.ai_generated), edits: Boolean(r.edits), healing: Boolean(r.healing), soleAdminSelfApprove: Boolean(r.sole_admin_self_approve) };
    }

    setPolicy(projectId: string, patch: Partial<ReviewPolicy>, by: string): ReviewPolicy {
        const next = { ...this.policy(projectId), ...patch };
        const vals = [next.aiGenerated ? 1 : 0, next.edits ? 1 : 0, next.healing ? 1 : 0, next.soleAdminSelfApprove ? 1 : 0, now(), by.slice(0, 200)];
        this.db.tx(() => {
            if (this.db.get("SELECT 1 AS x FROM review_policies WHERE project_id = ?", projectId)) {
                this.db.run("UPDATE review_policies SET ai_generated = ?, edits = ?, healing = ?, sole_admin_self_approve = ?, updated_at = ?, updated_by = ? WHERE project_id = ?", ...vals, projectId);
            } else {
                this.db.run("INSERT INTO review_policies (ai_generated, edits, healing, sole_admin_self_approve, updated_at, updated_by, project_id) VALUES (?,?,?,?,?,?,?)", ...vals, projectId);
            }
        });
        return next;
    }

    // ── reading ─────────────────────────────────────────────────────────────
    list(testId: string): TestVersion[] {
        return this.db.all("SELECT * FROM test_versions WHERE test_case_id = ? ORDER BY version DESC", testId).map(toVersion);
    }
    get(testId: string, version: number): TestVersion | undefined {
        const r = this.db.get("SELECT * FROM test_versions WHERE test_case_id = ? AND version = ?", testId, version);
        return r ? toVersion(r) : undefined;
    }
    latest(testId: string): TestVersion | undefined {
        const r = this.db.get("SELECT * FROM test_versions WHERE test_case_id = ? ORDER BY version DESC LIMIT 1", testId);
        return r ? toVersion(r) : undefined;
    }
    /** The version runs use: the latest approved one, or undefined while the test has none (it then waits for approval). */
    approved(testId: string): TestVersion | undefined {
        const r = this.db.get("SELECT * FROM test_versions WHERE test_case_id = ? AND state = 'approved' ORDER BY version DESC LIMIT 1", testId);
        return r ? toVersion(r) : undefined;
    }
    commentCount(versionId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM test_version_comments WHERE version_id = ?", versionId)?.n ?? 0);
    }
    comments(versionId: string): VersionComment[] {
        return this.db.all("SELECT * FROM test_version_comments WHERE version_id = ? ORDER BY created_at, id", versionId).map((r) => ({ id: r.id, kind: r.kind, body: r.body ?? null, authorId: r.author_id ?? null, authorName: r.author_name, createdAt: r.created_at }));
    }

    /** What the test runs right now as text: its steps and, for a code test, its stored script. */
    private currentContent(testId: string): { projectId: string; specJson: string; code: string | null; framework: string } | undefined {
        const t = this.db.get<{ project_id: string; spec_json: string; framework: string }>("SELECT project_id, spec_json, framework FROM test_cases WHERE id = ?", testId);
        if (!t) return undefined;
        const custom = this.db.get("SELECT 1 AS x FROM custom_tests WHERE test_case_id = ?", testId);
        const code = custom ? (this.db.get<{ content: string }>("SELECT content FROM generated_scripts WHERE test_case_id = ? AND is_current = 1 AND executable = 1 ORDER BY created_at DESC LIMIT 1", testId)?.content ?? "") : null;
        return { projectId: t.project_id, specJson: t.spec_json, code, framework: t.framework };
    }

    // ── recording changes ───────────────────────────────────────────────────
    /**
     * Called after anything changes a test's steps or a person's code (Repo.insertTest, updateTest, addScript; a take-over). When
     * the content differs from the latest version, a new version is made: a draft or approved as the policy says. A draft nobody
     * has looked at yet, from the same source and author, is brought up to date instead of piling up (the AI repairs while it
     * writes). Unchanged content does nothing. Returns the latest version.
     *
     * `found`: the change was not reported by anyone, the run-time safety check came across it (`pinRun`). Nothing says who made it
     * or why, so it never gets past review: it is always a draft, whatever the policy or the actor.
     */
    track(testId: string, source?: VersionSource, actor: Actor = currentActor(), found = false): TestVersion | undefined {
        const cur = this.currentContent(testId);
        if (!cur) return undefined;
        const latest = this.latest(testId);
        const latestRow = latest ? this.db.get<{ spec_json: string; code: string | null }>("SELECT spec_json, code FROM test_versions WHERE id = ?", latest.id) : undefined;
        if (latestRow && (latestRow.code ?? null) === cur.code && (cur.code !== null || canonicalJson(latestRow.spec_json) === canonicalJson(cur.specJson))) return latest;
        const src = source ?? sourceOverride.getStore() ?? inferredSource(actor);
        const author = authorOf(src, actor);
        const t = now();
        const carry = src === "shared" || src === "takeover" || src === "upgrade";
        const policy = this.policy(cur.projectId);
        // An exception to "a new version starts as a draft": an explicit edit by the access key or open access, in a project with no
        // flagged Project Admin, is approved at once when the policy lets an only Project Admin approve their own change. Such edits
        // skip review: scripts and local installs keep running what they write. Signed-in people's edits, AI work and the platform's
        // own background work never do, and neither does anything the run-time check finds.
        const unreviewable = !found && (src === "person" || src === "import") && (author.kind === "key" || author.kind === "open") && policy.soleAdminSelfApprove && this.projectAdmins(cur.projectId) === 0;
        const approvedNow = !found && (carry ? !latest || latest.state === "approved" : unreviewable || !needsApproval(policy, src));

        if (latest && !approvedNow && latest.state === "draft" && latest.source === src && latest.author.kind === author.kind && (latest.author.id ?? "") === (author.id ?? "") && !this.hasComments(latest.id)) {
            this.db.run("UPDATE test_versions SET spec_json = ?, code = ?, framework = ?, script_id = NULL, regen_note = NULL, updated_at = ? WHERE id = ? AND state = 'draft'", cur.specJson, cur.code, cur.framework, t, latest.id);
            return this.get(testId, latest.version);
        }
        const id = randomUUID();
        retryOnUniqueViolation(this.db.dialect, () =>
            this.db.run(
                `INSERT INTO test_versions (id, test_case_id, project_id, version, state, source, spec_json, code, framework, author_kind, author_id, author_name, auto, created_at, updated_at, decided_by_name, decided_at, decision_note)
                 SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM test_versions WHERE test_case_id = ?`,
                id, testId, cur.projectId, approvedNow ? "approved" : "draft", src, cur.specJson, cur.code, cur.framework, author.kind, author.id, author.name.slice(0, 200),
                approvedNow ? 1 : 0, t, t, approvedNow ? "Platform" : null, approvedNow ? t : null,
                approvedNow ? (carry ? "Kept the approval: what the test does did not change." : unreviewable ? "Approved without review: made with the access key or open access, in a project with no Project Admin." : "The project's review policy does not ask for approval of this kind of change.") : null,
                testId,
            ),
        );
        // A newer version replaces the drafts before it, and a newer approval the approval before it.
        this.db.run(`UPDATE test_versions SET state = 'superseded' WHERE test_case_id = ? AND id <> ? AND state IN ('draft', 'in_review'${approvedNow ? ", 'approved'" : ""})`, testId, id);
        return toVersion(this.db.get("SELECT * FROM test_versions WHERE id = ?", id)!);
    }

    /** A change to the steps of a test whose code a person owns was not applied : the latest version says so. */
    noteRefusedTextChange(testId: string, refusedSpecJson: string): void {
        const stored = this.db.get<{ spec_json: string }>("SELECT spec_json FROM test_cases WHERE id = ?", testId);
        if (!stored || canonicalJson(stored.spec_json) === canonicalJson(refusedSpecJson)) return;
        const latest = this.latest(testId);
        if (!latest) return;
        this.db.run("UPDATE test_versions SET regen_note = ? WHERE id = ?", "A change to the steps was not applied, because a person owns this code. Update the code by hand, or go back to the generated version.", latest.id);
    }

    private projectAdmins(projectId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_projects WHERE project_id = ? AND project_admin = 1", projectId)?.n ?? 0);
    }

    private hasComments(versionId: string): boolean {
        return Boolean(this.db.get("SELECT 1 AS x FROM test_version_comments WHERE version_id = ? LIMIT 1", versionId));
    }

    // ── review actions (who may act is checked by reviewProblem first) ───────
    addComment(versionId: string, kind: VersionComment["kind"], body: string | null, actor: Actor): void {
        this.db.run("INSERT INTO test_version_comments (id, version_id, kind, body, author_id, author_name, created_at) VALUES (?,?,?,?,?,?,?)", randomUUID(), versionId, kind, body?.slice(0, 4000) ?? null, actor.id ?? null, actor.name.slice(0, 200), now());
    }

    submit(v: TestVersion, actor: Actor, note: string | null): void {
        this.db.tx(() => {
            this.db.run("UPDATE test_versions SET state = 'in_review', submitted_at = ? WHERE id = ? AND state = 'draft'", now(), v.id);
            this.addComment(v.id, "submitted", note, actor);
        });
    }

    approve(v: TestVersion, actor: Actor, note: string | null): void {
        this.db.tx(() => {
            this.db.run("UPDATE test_versions SET state = 'approved', auto = 0, decided_by_id = ?, decided_by_name = ?, decided_at = ?, decision_note = ? WHERE id = ?", actor.id ?? null, actor.name.slice(0, 200), now(), note?.slice(0, 2000) ?? null, v.id);
            // The approval before it, and any older draft, are replaced by this one.
            this.db.run("UPDATE test_versions SET state = 'superseded' WHERE test_case_id = ? AND version < ? AND state IN ('approved', 'draft', 'in_review')", v.testId, v.version);
            this.addComment(v.id, "approved", note, actor);
        });
    }

    reject(v: TestVersion, actor: Actor, reason: string): void {
        this.db.tx(() => {
            this.db.run("UPDATE test_versions SET state = 'rejected', decided_by_id = ?, decided_by_name = ?, decided_at = ?, decision_note = ? WHERE id = ?", actor.id ?? null, actor.name.slice(0, 200), now(), reason.slice(0, 2000), v.id);
            this.addComment(v.id, "rejected", reason, actor);
        });
    }

    /** Back to draft with what should change: the author edits the test, which makes the next version. */
    requestChanges(v: TestVersion, actor: Actor, comment: string): void {
        this.db.tx(() => {
            this.db.run("UPDATE test_versions SET state = 'draft', submitted_at = NULL WHERE id = ?", v.id);
            this.addComment(v.id, "changes", comment, actor);
        });
    }

    // ── sync status ─────────────────────────────────────────────────────────
    /** Whether a version's steps and code agree. */
    sync(v: TestVersion): SyncStatus {
        if (v.code !== null) {
            const c = this.db.get<{ origin: string }>("SELECT origin FROM custom_tests WHERE test_case_id = ?", v.testId);
            const takenOver = this.db.get<{ content: string }>("SELECT content FROM custom_script_versions WHERE test_case_id = ? AND kind = 'taken-over' ORDER BY version DESC LIMIT 1", v.testId);
            if ((c && c.origin !== "taken-over") || !takenOver) return "code_only";
            if (v.regenNote) return "needs_regeneration";
            return v.code === takenOver.content ? "in_sync" : "code_changed";
        }
        return v.scriptId ? "in_sync" : "text_changed";
    }

    // ── runs ────────────────────────────────────────────────────────────────
    /**
     * The version of each test a run executes (the latest approved), recorded against the run. A test with no approved version is
     * left out and recorded as waiting. Content written since the latest version is tracked first, as a draft, so nothing escapes
     * review: this check never approves, and it acts as the platform whoever started the run.
     */
    pinRun(jobId: string, testIds: readonly string[]): { run: Map<string, TestVersion>; waiting: string[] } {
        const run = new Map<string, TestVersion>();
        const waiting: string[] = [];
        for (const id of testIds) {
            if (!this.db.get("SELECT 1 AS x FROM test_cases WHERE id = ?", id)) continue; // the run itself reports a missing test
            this.track(id, undefined, SYSTEM_ACTOR, true);
            const v = this.approved(id);
            if (v) run.set(id, v);
            else waiting.push(id);
            this.db.run("DELETE FROM test_run_versions WHERE job_id = ? AND test_case_id = ?", jobId, id);
            this.db.run("INSERT INTO test_run_versions (job_id, test_case_id, version_id, version, outcome) VALUES (?,?,?,?,?)", jobId, id, v?.id ?? null, v?.version ?? null, v ? "ran" : "waiting");
        }
        return { run, waiting };
    }

    /**
     * After a run: each execution names the version it ran, and code made from a version's steps is recorded as made from it (the
     * first attempt's script, before any repair). Safe to call more than once.
     */
    finishRun(jobId: string): void {
        for (const r of this.db.all<{ test_case_id: string; version_id: string }>("SELECT test_case_id, version_id FROM test_run_versions WHERE job_id = ? AND version_id IS NOT NULL", jobId)) {
            this.db.run("UPDATE test_executions SET test_version_id = ? WHERE job_id = ? AND test_case_id = ? AND test_version_id IS NULL", r.version_id, jobId, r.test_case_id);
            const first = this.db.get<{ script_id: string }>("SELECT script_id FROM test_executions WHERE job_id = ? AND test_case_id = ? AND script_id IS NOT NULL ORDER BY attempt, started_at LIMIT 1", jobId, r.test_case_id);
            if (first) this.db.run("UPDATE test_versions SET script_id = ? WHERE id = ? AND code IS NULL AND script_id IS NULL", first.script_id, r.version_id);
        }
    }

    /** What a run recorded: the version each test ran, and the tests it left out because they wait for approval. */
    runVersions(jobId: string): Array<{ testId: string; version: number | null; outcome: "ran" | "waiting" }> {
        return this.db.all("SELECT test_case_id, version, outcome FROM test_run_versions WHERE job_id = ? ORDER BY test_case_id", jobId).map((r) => ({ testId: r.test_case_id, version: r.version === null || r.version === undefined ? null : Number(r.version), outcome: r.outcome }));
    }
}

/** The hook Repo calls after a test's content changes. Never throws: an untracked change is still caught before the next run. */
export function trackTestVersion(db: Db, testId: string, source?: VersionSource, refusedSpecJson?: string): void {
    try {
        const store = new ReviewStore(db);
        if (refusedSpecJson !== undefined) store.noteRefusedTextChange(testId, refusedSpecJson);
        store.track(testId, source);
    } catch (e) {
        console.warn(`[review] could not record a version of test ${testId}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * Which version of each test a run executes (drafts never run): called once per run job before any test is touched. The
 * job's test list becomes the tests that have an approved version; each one runs that version's steps (and a person's code as it
 * was approved), and the others are reported as waiting for approval.
 */
export interface RunPins {
    /** The tests left out, waiting for approval. */
    waiting: string[];
    /** Tests whose approved version is not what they hold now (a newer draft exists): the run must not write its steps back. */
    stale: Set<string>;
    /** The test as its approved version: its steps replaced. */
    test<T extends { id: string; spec: any }>(t: T): T;
    /** The approved code of the code tests among the run's tests, in place of their current script. */
    applyCustom(custom: Pick<CustomRunInputs, "byTest">): void;
}

export function pinRunVersions(db: Db, jobId: string, testIds: readonly string[]): RunPins {
    const store = new ReviewStore(db);
    const { run, waiting } = store.pinRun(jobId, testIds);
    const stale = new Set<string>();
    for (const [id, v] of run) {
        const latest = store.latest(id);
        if (latest && latest.id !== v.id) stale.add(id);
    }
    return {
        waiting,
        stale,
        test(t) {
            const v = run.get(t.id);
            return v && stale.has(t.id) ? { ...t, spec: v.spec } : t;
        },
        applyCustom(custom) {
            for (const [id, entry] of custom.byTest) {
                const v = run.get(id);
                if (!v || v.code === entry.content) continue;
                // Approved before a person took the code over: the code is only a draft, so the approved steps run instead.
                if (v.code === null) {
                    custom.byTest.delete(id);
                    continue;
                }
                const script = db.get<{ id: string }>("SELECT id FROM generated_scripts WHERE test_case_id = ? AND content = ? ORDER BY version DESC LIMIT 1", id, v.code);
                custom.byTest.set(id, { ...entry, content: v.code, scriptId: script?.id ?? null });
            }
        },
    };
}

/** How a run of only drafts ends. The job stays FAILED so no gate reads it as a pass; pages and alerts treat it as "held back", not as a failure. */
export const NOTHING_RAN = "Nothing ran: ";
export const nothingRanMessage = (waiting: number): string => `${NOTHING_RAN}${waiting === 1 ? "the test is waiting for approval." : `all ${waiting} tests are waiting for approval.`}`;
export const isNothingRan = (job: { status: string; error?: string | null }): boolean => job.status === "FAILED" && (job.error ?? "").startsWith(NOTHING_RAN);

/**
 * What a run just queued after an edit really runs, when that is not the edit: a draft never runs, so the run uses the approved
 * version or leaves the test out. Undefined when no test in `testIds` has a draft.
 */
export function draftRunNote(db: Db, testIds: readonly string[]): string | undefined {
    const store = new ReviewStore(db);
    const drafts = testIds.filter((id) => ["draft", "in_review"].includes(store.latest(id)?.state ?? ""));
    if (!drafts.length) return undefined;
    if (testIds.length > 1) return `${drafts.length} of these ${testIds.length} tests have a draft. The run uses their approved version, or leaves them out when they have none. A draft runs once a Project Admin approves it.`;
    const approved = store.approved(drafts[0]!);
    return approved ? `The run uses approved version ${approved.version}, not this draft. A draft runs once a Project Admin approves it.` : "The run leaves this test out: it has no approved version yet. A draft runs once a Project Admin approves it.";
}

/** The version a test runs, for code outside a run job (suites, schedules, previews): the latest approved, or none (it waits). */
export function versionToRun(db: Db, testId: string): TestVersion | undefined {
    return new ReviewStore(db).approved(testId);
}
