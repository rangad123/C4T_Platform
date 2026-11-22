/**
 * Candidate findings (testing-engine Phase 3, migration slot 67): one row per project and fingerprint, shaped like security_findings so
 * Phase 5 can merge the two into one finding model (H2). The finding itself (engine/explore/finding.ts) is parsed again here and kept
 * whole in finding_json; the columns are what lists and later lifecycle work filter on. `status` is only ever `candidate`; the lifecycle is `state` (slot 71).
 *
 * Every query names the project (the tenant boundary); a run or test of another project is refused before anything is written.
 * Slot 71 adds the Phase 5 lifecycle: the state, the verification facts, the history (`transition`, `history`) and duplicate groups.
 */
import { randomUUID } from "node:crypto";
import { CandidateFindingSchema, type CandidateFinding } from "../engine/explore/finding.js";
import { checkTransition, FINDING_STATES, type Actor, type FindingState } from "../engine/findings/lifecycle.js";
import type { ConfidenceScore } from "../engine/findings/score.js";
import { redactText } from "../shared/redact-text.js";
import type { Sql } from "./sql.js";

/** Migration slot 67. first/last run as security_findings has first/last assessment; a deleted run or test leaves the finding. */
export const CANDIDATE_FINDINGS_MIGRATION = `
CREATE TABLE candidate_findings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    first_job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
    last_job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
    test_id TEXT REFERENCES test_cases(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL,            -- engine/explore/finding.ts findingFingerprint
    status TEXT NOT NULL,                 -- candidate (Phase 3); the lifecycle is Phase 5
    confidence TEXT NOT NULL,             -- high medium low (Decision 9)
    capture TEXT NOT NULL,                -- captured observed_only
    finding_json TEXT NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_cand_find_fp ON candidate_findings (project_id, fingerprint);
CREATE INDEX idx_cand_find_last ON candidate_findings (project_id, last_seen_at);
CREATE INDEX idx_cand_find_first_job ON candidate_findings (first_job_id);
CREATE INDEX idx_cand_find_last_job ON candidate_findings (last_job_id);
`;

/**
 * Migration slot 71 (Phase 5): the lifecycle (engine/findings/lifecycle.ts). `status` stays `candidate` (slot 67's column); `state` is the
 * lifecycle state; its default makes every existing finding a candidate. The verification facts start empty. finding_events is the
 * history (as security_finding_history), seq numbering each finding's events; finding_groups holds duplicate groups (findings/dedupe.ts).
 */
export const FINDING_LIFECYCLE_MIGRATION = `
CREATE TABLE finding_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    finding_id TEXT NOT NULL REFERENCES candidate_findings(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,                 -- 1, 2, … per finding
    at TEXT NOT NULL,
    actor TEXT NOT NULL,                  -- "Name (user id)" or "Engine"
    actor_id TEXT,
    by_kind TEXT NOT NULL,                -- engine person
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason TEXT
);
CREATE UNIQUE INDEX idx_finding_events_seq ON finding_events (finding_id, seq);
CREATE INDEX idx_finding_events_project ON finding_events (project_id);
CREATE TABLE finding_groups (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    signature_json TEXT NOT NULL,         -- what the members share (findings/dedupe.ts)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_finding_groups_project ON finding_groups (project_id);
ALTER TABLE candidate_findings ADD COLUMN state TEXT NOT NULL DEFAULT 'candidate';
ALTER TABLE candidate_findings ADD COLUMN class TEXT;              -- findings/classify.ts, or null before classification
ALTER TABLE candidate_findings ADD COLUMN severity TEXT;           -- findings/score.ts
ALTER TABLE candidate_findings ADD COLUMN confidence_json TEXT;    -- findings/score.ts: the level with each factor and its reason
ALTER TABLE candidate_findings ADD COLUMN group_id TEXT REFERENCES finding_groups(id) ON DELETE SET NULL;
ALTER TABLE candidate_findings ADD COLUMN attempts_json TEXT NOT NULL DEFAULT '[]';   -- reproduction attempts (findings/reproduce.ts)
ALTER TABLE candidate_findings ADD COLUMN app_version TEXT;        -- the app version the attempts ran on, null when unknown
CREATE INDEX idx_cand_find_state ON candidate_findings (project_id, state);
CREATE INDEX idx_cand_find_group ON candidate_findings (group_id);
`;

export const CANDIDATE_STATUS = "candidate";

export interface CandidateFindingRecord {
    id: string;
    projectId: string;
    status: typeof CANDIDATE_STATUS;
    firstJobId: string | null;
    lastJobId: string | null;
    testId: string | null;
    fingerprint: string;
    confidence: CandidateFinding["confidence"];
    capture: CandidateFinding["capture"];
    seenCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    finding: CandidateFinding;
    /** Slot 71: the lifecycle state and the verification facts (null or empty until the engine records them). */
    state: FindingState;
    findingClass: string | null;
    severity: string | null;
    confidenceDetail: ConfidenceScore | null;
    groupId: string | null;
    attempts: unknown[];
    appVersion: string | null;
}

/** What a transition may record with the move (each left out keeps its value). */
export interface FindingFacts {
    findingClass?: string | null;
    severity?: string | null;
    confidence?: ConfidenceScore;
    attempts?: unknown[];
    appVersion?: string | null;
}

export interface FindingEvent {
    seq: number;
    at: string;
    actor: string;
    actorId: string | null;
    by: Actor;
    from: FindingState | null;
    to: FindingState;
    reason: string | null;
}

export interface FindingGroup {
    id: string;
    projectId: string;
    signature: unknown;
    findingIds: string[];
    createdAt: string;
    updatedAt: string;
}

const REASON_MAX = 2000;

interface FindingRow {
    id: string;
    project_id: string;
    first_job_id: string | null;
    last_job_id: string | null;
    test_id: string | null;
    fingerprint: string;
    confidence: string;
    capture: string;
    finding_json: string;
    seen_count: number | string;
    first_seen_at: string;
    last_seen_at: string;
    state: string;
    class: string | null;
    severity: string | null;
    confidence_json: string | null;
    group_id: string | null;
    attempts_json: string;
    app_version: string | null;
}

const toRecord = (r: FindingRow): CandidateFindingRecord => {
    const finding = JSON.parse(r.finding_json) as CandidateFinding;
    return {
        id: r.id,
        projectId: r.project_id,
        status: CANDIDATE_STATUS,
        firstJobId: r.first_job_id,
        lastJobId: r.last_job_id,
        testId: r.test_id,
        fingerprint: r.fingerprint,
        confidence: finding.confidence,
        capture: finding.capture,
        seenCount: Number(r.seen_count),
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        finding,
        state: r.state as FindingState,
        findingClass: r.class,
        severity: r.severity,
        confidenceDetail: r.confidence_json === null ? null : JSON.parse(r.confidence_json),
        groupId: r.group_id,
        attempts: JSON.parse(r.attempts_json) as unknown[],
        appVersion: r.app_version,
    };
};

/** The most findings one list answers (newest seen first). */
export const CANDIDATE_FINDINGS_LIST_MAX = 500;

export class CandidateFindingStore {
    constructor(
        private readonly sql: Sql,
        private readonly now: () => string = () => new Date().toISOString(),
    ) {}

    /**
     * Adds the finding, or, when the project already has its fingerprint, counts it seen again: last seen, last run, test and the
     * finding's content become the latest; the first run and first seen stay. `status` other than `candidate` is refused.
     */
    async upsert(input: { projectId: string; jobId?: string | null; testId?: string | null; status?: string; finding: unknown }): Promise<{ finding: CandidateFindingRecord; created: boolean }> {
        if (input.status !== undefined && input.status !== CANDIDATE_STATUS) throw new Error(`A finding is stored as a ${CANDIDATE_STATUS} only; it is confirmed in a later phase.`);
        const finding = CandidateFindingSchema.parse(input.finding);
        const json = JSON.stringify(finding);
        const at = this.now();
        const jobId = input.jobId ?? null;
        const testId = input.testId ?? null;
        return this.sql.tx(async (t) => {
            if (jobId && !(await t.get("SELECT 1 AS ok FROM generation_jobs WHERE id = ? AND project_id = ?", jobId, input.projectId))) throw new Error("That run is not in this project.");
            if (testId && !(await t.get("SELECT 1 AS ok FROM test_cases WHERE id = ? AND project_id = ?", testId, input.projectId))) throw new Error("That test is not in this project.");
            const existing = await t.get<{ id: string }>("SELECT id FROM candidate_findings WHERE project_id = ? AND fingerprint = ?", input.projectId, finding.fingerprint);
            let id: string;
            if (existing) {
                id = existing.id;
                await t.run(
                    "UPDATE candidate_findings SET last_job_id = COALESCE(?, last_job_id), test_id = COALESCE(?, test_id), confidence = ?, capture = ?, finding_json = ?, seen_count = seen_count + 1, last_seen_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
                    jobId, testId, finding.confidence, finding.capture, json, at, at, id, input.projectId,
                );
            } else {
                id = randomUUID();
                await t.run(
                    "INSERT INTO candidate_findings (id, project_id, first_job_id, last_job_id, test_id, fingerprint, status, confidence, capture, finding_json, seen_count, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)",
                    id, input.projectId, jobId, jobId, testId, finding.fingerprint, CANDIDATE_STATUS, finding.confidence, finding.capture, json, at, at, at, at,
                );
            }
            const row = await t.get<FindingRow>("SELECT * FROM candidate_findings WHERE id = ? AND project_id = ?", id, input.projectId);
            return { finding: toRecord(row!), created: !existing };
        });
    }

    /**
     * A project's findings, newest seen first; with `jobId`, those that run found first or last. At most `limit` of them, and never more
     * than CANDIDATE_FINDINGS_LIST_MAX (a limit that is not a positive whole number is the cap).
     */
    async list(projectId: string, opts: { jobId?: string; limit?: number } = {}): Promise<CandidateFindingRecord[]> {
        const limit = Number.isInteger(opts.limit) && opts.limit! > 0 ? Math.min(opts.limit!, CANDIDATE_FINDINGS_LIST_MAX) : CANDIDATE_FINDINGS_LIST_MAX;
        const rows = opts.jobId
            ? await this.sql.all<FindingRow>("SELECT * FROM candidate_findings WHERE project_id = ? AND (first_job_id = ? OR last_job_id = ?) ORDER BY last_seen_at DESC, id LIMIT ?", projectId, opts.jobId, opts.jobId, limit)
            : await this.sql.all<FindingRow>("SELECT * FROM candidate_findings WHERE project_id = ? ORDER BY last_seen_at DESC, id LIMIT ?", projectId, limit);
        return rows.map(toRecord);
    }

    async get(projectId: string, id: string): Promise<CandidateFindingRecord | undefined> {
        const row = await this.sql.get<FindingRow>("SELECT * FROM candidate_findings WHERE id = ? AND project_id = ?", id, projectId);
        return row ? toRecord(row) : undefined;
    }

    /**
     * Moves the finding to `to` when the lifecycle table lets `by` do it (with the reason the state needs), recording the facts in `set`
     * and one history event, in one transaction. Undefined when the project has no such finding; a refused move throws its sentence and
     * changes nothing. The reason is redacted before it is stored. `stepFault` is validation/test-fault.ts's sentence when the failure is the
     * test's own step (the lifecycle then refuses the defect path).
     */
    async transition(
        projectId: string,
        id: string,
        input: { to: FindingState; by: Actor; actor?: { id?: string | null; label: string }; reason?: string | null; stepFault?: string | null; set?: FindingFacts },
    ): Promise<CandidateFindingRecord | undefined> {
        const reason = input.reason?.trim() ? redactText(input.reason, REASON_MAX) : null;
        const at = this.now();
        return this.sql.tx(async (t) => {
            const cur = await t.get<FindingRow>("SELECT * FROM candidate_findings WHERE id = ? AND project_id = ?", id, projectId);
            if (!cur) return undefined;
            if (!(FINDING_STATES as readonly string[]).includes(input.to)) throw new Error(`"${input.to}" is not a finding state.`);
            // The engine confirms only at high confidence: the level is the one this move sets, else the one already stored.
            const confidence = (input.set?.confidence ?? (cur.confidence_json === null ? null : (JSON.parse(cur.confidence_json) as ConfidenceScore)))?.confidence;
            const refusal = checkTransition({ from: cur.state as FindingState, to: input.to, by: input.by, reason, stepFault: input.stepFault, confidence });
            if (refusal) throw new Error(refusal);
            const f = input.set ?? {};
            await t.run(
                "UPDATE candidate_findings SET state = ?, class = ?, severity = ?, confidence_json = ?, attempts_json = ?, app_version = ?, updated_at = ? WHERE id = ? AND project_id = ?",
                input.to,
                f.findingClass !== undefined ? f.findingClass : cur.class,
                f.severity !== undefined ? f.severity : cur.severity,
                f.confidence !== undefined ? JSON.stringify(f.confidence) : cur.confidence_json,
                f.attempts !== undefined ? JSON.stringify(f.attempts) : cur.attempts_json,
                f.appVersion !== undefined ? f.appVersion : cur.app_version,
                at, id, projectId,
            );
            const last = await t.get<{ n: number | string | null }>("SELECT MAX(seq) AS n FROM finding_events WHERE finding_id = ?", id);
            await t.run(
                "INSERT INTO finding_events (id, project_id, finding_id, seq, at, actor, actor_id, by_kind, from_state, to_state, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                randomUUID(), projectId, id, Number(last?.n ?? 0) + 1, at, input.actor?.label ?? "Engine", input.actor?.id ?? null, input.by, cur.state, input.to, reason,
            );
            return toRecord((await t.get<FindingRow>("SELECT * FROM candidate_findings WHERE id = ? AND project_id = ?", id, projectId))!);
        });
    }

    /**
     * One history event that moves nothing (a fix claimed, a fix that still reproduces): from and to are the finding's state. False when the
     * project has no such finding. The reason is redacted before it is stored.
     */
    async note(projectId: string, id: string, input: { by: Actor; actor?: { id?: string | null; label: string }; reason: string }): Promise<boolean> {
        const reason = redactText(input.reason, REASON_MAX);
        return this.sql.tx(async (t) => {
            const cur = await t.get<{ state: string }>("SELECT state FROM candidate_findings WHERE id = ? AND project_id = ?", id, projectId);
            if (!cur) return false;
            const last = await t.get<{ n: number | string | null }>("SELECT MAX(seq) AS n FROM finding_events WHERE finding_id = ?", id);
            await t.run(
                "INSERT INTO finding_events (id, project_id, finding_id, seq, at, actor, actor_id, by_kind, from_state, to_state, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                randomUUID(), projectId, id, Number(last?.n ?? 0) + 1, this.now(), input.actor?.label ?? "Engine", input.actor?.id ?? null, input.by, cur.state, cur.state, reason,
            );
            return true;
        });
    }

    /** The finding's lifecycle events, oldest first; none when the project has no such finding. */
    async history(projectId: string, id: string): Promise<FindingEvent[]> {
        const rows = await this.sql.all<{ seq: number | string; at: string; actor: string; actor_id: string | null; by_kind: string; from_state: string | null; to_state: string; reason: string | null }>(
            "SELECT seq, at, actor, actor_id, by_kind, from_state, to_state, reason FROM finding_events WHERE project_id = ? AND finding_id = ? ORDER BY seq",
            projectId, id,
        );
        return rows.map((r) => ({ seq: Number(r.seq), at: r.at, actor: r.actor, actorId: r.actor_id, by: r.by_kind as Actor, from: r.from_state as FindingState | null, to: r.to_state as FindingState, reason: r.reason }));
    }

    /** A new duplicate group of these findings (each leaves the group it was in); every id must be a finding of the project. */
    async group(projectId: string, findingIds: string[], signature: unknown): Promise<FindingGroup> {
        const ids = [...new Set(findingIds)];
        if (ids.length === 0) throw new Error("A group needs at least one finding.");
        const at = this.now();
        const id = randomUUID();
        await this.sql.tx(async (t) => {
            for (const f of ids) if (!(await t.get("SELECT 1 AS ok FROM candidate_findings WHERE id = ? AND project_id = ?", f, projectId))) throw new Error("That finding is not in this project.");
            await t.run("INSERT INTO finding_groups (id, project_id, signature_json, created_at, updated_at) VALUES (?,?,?,?,?)", id, projectId, JSON.stringify(signature ?? null), at, at);
            for (const f of ids) await t.run("UPDATE candidate_findings SET group_id = ?, updated_at = ? WHERE id = ? AND project_id = ?", id, at, f, projectId);
        });
        return { id, projectId, signature: signature ?? null, findingIds: ids, createdAt: at, updatedAt: at };
    }

    /** The project's duplicate groups, newest first, each with its members (a group whose members all moved on has none). */
    async groups(projectId: string): Promise<FindingGroup[]> {
        const groups = await this.sql.all<{ id: string; signature_json: string; created_at: string; updated_at: string }>(
            "SELECT id, signature_json, created_at, updated_at FROM finding_groups WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ?",
            projectId, CANDIDATE_FINDINGS_LIST_MAX,
        );
        const members = await this.sql.all<{ id: string; group_id: string }>("SELECT id, group_id FROM candidate_findings WHERE project_id = ? AND group_id IS NOT NULL ORDER BY first_seen_at, id", projectId);
        return groups.map((g) => ({ id: g.id, projectId, signature: JSON.parse(g.signature_json), findingIds: members.filter((m) => m.group_id === g.id).map((m) => m.id), createdAt: g.created_at, updatedAt: g.updated_at }));
    }
}
