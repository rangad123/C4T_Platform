/** Requirements as records (routes/requirements.ts): the shapes the API answers with, and their words. */
export type RequirementStatus = "draft" | "active" | "retired";
export type RequirementPriority = "critical" | "high" | "medium" | "low";
export type RequirementSource = "typed" | "imported" | "ai";
export type Coverage = "not_covered" | "covered" | "passing" | "failing";
export type TestResult = "passed" | "failed" | "not_run";

export interface Requirement {
    id: string;
    projectId: string;
    ref: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    priority: RequirementPriority;
    status: RequirementStatus;
    source: RequirementSource;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    updatedBy: string;
}

export interface CoverageCounts {
    linked: number;
    passed: number;
    failed: number;
    notRun: number;
}

export interface RequirementRow extends Requirement {
    coverage: Coverage;
    tests: CoverageCounts;
    /** Written test cases that come from this requirement (absent from older servers). */
    caseCount?: number;
}

/** What POST /requirements/generate-cases answers. */
export interface GenerateCasesResult {
    created: number;
    cases: Array<{ id: string; ref: string; title: string }>;
    perRequirement: Array<{ id: string; ref: string; created: number; failed: boolean }>;
    duplicates: number;
    limited: boolean;
    failed: string[];
    note: string | null;
    total: number;
}

export interface CoverageSummary {
    total: number;
    notCovered: number;
    covered: number;
    passing: number;
    failing: number;
    retired: number;
}

export interface RequirementList {
    requirements: RequirementRow[];
    total: number;
    max: number;
    summary: CoverageSummary;
}

export interface LinkedTest {
    kind: "automated" | "manual";
    id: string;
    key: string;
    title: string;
    result: TestResult;
    resultAt: string | null;
    detail: string | null;
    origin: "person" | "generated";
    linkedAt: string;
}

export interface RequirementDetailData extends Requirement {
    coverage: Coverage;
    counts: CoverageCounts;
    tests: LinkedTest[];
}

export interface ImportCandidate {
    ref: string;
    title: string;
    description: string;
    section: string | null;
    kind: string;
    exists: boolean;
}

export interface ImportPreview {
    candidates: ImportCandidate[];
    total: number;
    existing: number;
    usedAi: boolean;
    /** Said when the AI was asked and the list came from the rules instead. */
    note: string | null;
    max: number;
}

export interface RequirementLink {
    requirementId: string;
    ref: string;
    title: string;
    kind: "automated" | "manual";
    testId: string;
}

export const STATUSES: RequirementStatus[] = ["active", "draft", "retired"];
export const PRIORITIES: RequirementPriority[] = ["critical", "high", "medium", "low"];
export const COVERAGES: Coverage[] = ["not_covered", "failing", "covered", "passing"];

export const STATUS_WORDS: Record<RequirementStatus, string> = { draft: "Draft", active: "Active", retired: "Retired" };
export const STATUS_HINT: Record<RequirementStatus, string> = {
    draft: "Still being written. It is counted in coverage.",
    active: "The application must do this. It is counted in coverage.",
    retired: "No longer needed. It is kept, but left out of coverage.",
};
export const PRIORITY_WORDS: Record<RequirementPriority, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export const SOURCE_WORDS: Record<RequirementSource, string> = { typed: "Written here", imported: "Imported", ai: "Imported with AI" };
export const COVERAGE_WORDS: Record<Coverage, string> = { not_covered: "Not covered", covered: "Covered", passing: "Passing", failing: "Failing" };
export const COVERAGE_HINT: Record<Coverage, string> = {
    not_covered: "No test case is linked to it.",
    covered: "Test cases are linked to it, and some have no result yet.",
    passing: "Every linked test case passed at its latest result.",
    failing: "A linked test case failed at its latest result.",
};
export const COVERAGE_TONE: Record<Coverage, "warning" | "neutral" | "success" | "danger"> = { not_covered: "warning", covered: "neutral", passing: "success", failing: "danger" };
export const RESULT_WORDS: Record<TestResult, string> = { passed: "Passed", failed: "Failed", not_run: "No result yet" };
export const RESULT_TONE: Record<TestResult, "success" | "danger" | "neutral"> = { passed: "success", failed: "danger", not_run: "neutral" };

/** The file types the import reads (engine/requirements/extract.ts). */
export const IMPORT_ACCEPT = ".txt,.md,.markdown,.pdf,.docx";
