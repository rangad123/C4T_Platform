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

/** One node of the tree; `node` is the page path, or the name of a requirement area (SPEC R16), whose `page` is empty. */
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

/** One value a test case uses (sheet item 31); `missing` when it cannot be known, and then `value` is empty. Same shape as engine/spec/schema.ts CaseData. */
export interface CaseOutcomeData {
    field: string;
    kind: "valid" | "invalid" | "boundary";
    value: string;
    missing: boolean;
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
    /** The requirement reference(s) the case checks, comma-separated (sheet item 33). */
    requirement: string;
    /** Its valid, invalid and boundary test data (sheet item 31). */
    testData?: CaseOutcomeData[];
    /** What the check after generation found missing (case-outcome.ts caseFlags): no steps, no requirement, unmarked missing data. */
    flags?: string[];
    /** A case written from the requirements alone (SPEC R16): the requirement-area tree node it hangs on (its page stays empty). */
    area?: string;
    /** The case's own start page, when it is not a page of the tree (`page` is then the nearest page; F3 round 2 L10). */
    start?: string;
}

/** `GET /api/projects/:id/outcome?counts=1`: what a Projects row shows, without the test cases themselves (F3 L6). */
export interface CaseOutcomeCounts {
    caseAgent: boolean;
    runs: CaseOutcomeRun[];
    /** By `outcomeCounts`. */
    counts: { cases: number; pages: number; areas: number };
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
    /** The project's active requirements no test case links to (sheet item 33). */
    uncovered?: Array<{ ref: string; title: string }>;
}

/**
 * The one count rule (F3 round 2 M5, SPEC P3.2), used by every screen and the Projects row: pages are the tree's real pages; requirement
 * areas (nodes with no page) group test cases but are counted apart, never as pages.
 */
export const outcomeCounts = (o: Pick<CaseOutcome, "tree" | "cases">): CaseOutcomeCounts["counts"] => ({ cases: o.cases.length, pages: o.tree.filter((n) => n.page).length, areas: o.tree.filter((n) => !n.page).length });
