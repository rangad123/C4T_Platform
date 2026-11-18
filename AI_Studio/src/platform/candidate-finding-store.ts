/**
 * Candidate findings (testing-engine Phase 3, migration slot 67): one row per project and fingerprint, shaped like security_findings so
 * Phase 5 can merge the two into one finding model (H2). The finding itself (engine/explore/finding.ts) is parsed again here and kept
 * whole in finding_json; the columns are what lists and later lifecycle work filter on. Status is only `candidate` in Phase 3.
 *
 * Every query names the project (the tenant boundary); a run or test of another project is refused before anything is written.
 */
import { randomUUID } from "node:crypto";
import { CandidateFindingSchema, type CandidateFinding } from "../engine/explore/finding.js";
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
}

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
}
