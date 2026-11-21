/**
 * The outcome of a Test Case Generation project (founder 2026-11-19, PLAN.md "Outcome contract"): what `GET /api/projects/:id/outcome`
 * answers, and what the workbook (src/platform/case-workbook.ts) is built from. Fixed before wave 2; change it only with the lead.
 */

export type CaseOutcomeRunStatus = "running" | "completed" | "stopped" | "failed";
export type CaseOutcomeType = "automated" | "manual";
export type CaseOutcomePriority = "critical" | "high" | "medium" | "low";

export interface CaseOutcomeRun {
    jobId: string;
    startedAt: string;
    status: CaseOutcomeRunStatus;
    addedPages: number;
    addedCases: number;
}

export interface CaseOutcomePage {
    path: string;
    url: string;
    title: string;
    purpose: string;
}

/** One node of the tree; `node` is the page path. */
export interface CaseOutcomeTreeNode {
    node: string;
    parent: string | null;
    page: string;
    title: string;
    cases: number;
}

export interface CaseOutcomeStep {
    action: string;
    expected: string;
}

export interface CaseOutcomeCase {
    /** TC-001… by first appearance across runs, stable. */
    id: string;
    title: string;
    type: CaseOutcomeType;
    priority: CaseOutcomePriority;
    page: string;
    preconditions: string[];
    steps: CaseOutcomeStep[];
    expected: string[];
    requirement: string;
    /** A case written from the requirements alone (SPEC R16): the requirement-area tree node it hangs on (its page stays empty). */
    area?: string;
}

/** `GET /api/projects/:id/outcome?counts=1`: what a Projects row shows, without the test cases themselves (F3 L6). */
export interface CaseOutcomeCounts {
    caseAgent: boolean;
    runs: CaseOutcomeRun[];
    /** pages: tree nodes. */
    counts: { cases: number; pages: number };
}

export interface CaseOutcome {
    /** False: not a Test Case Generation project; the web keeps today's screens. */
    caseAgent: boolean;
    /** Newest first. */
    runs: CaseOutcomeRun[];
    pages: CaseOutcomePage[];
    tree: CaseOutcomeTreeNode[];
    cases: CaseOutcomeCase[];
    /** Addresses that failed to load (shown once, not as pages). */
    notOpened: number;
    /** The understanding's "what is missing" lines, if any. */
    missing: string[];
}
