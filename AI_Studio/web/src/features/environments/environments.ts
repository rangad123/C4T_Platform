/** Types and plain-language wording for named environments and test data sets (see src/platform/routes/environments.ts). */

export interface Environment {
    id: string;
    name: string;
    baseUrl: string;
    apiBaseUrl: string | null;
    production: boolean;
    isDefault: boolean;
    useProjectAccounts: boolean;
    variables: Record<string, string>;
    /** Sign-in details are write-only: only whether one is saved is ever sent back. */
    username: string | null;
    hasPassword: boolean;
    hasTotp: boolean;
    hasApiToken: boolean;
    hasApiAuthHeader: boolean;
}

export type EnvStatus = "passed" | "failed" | "finding" | "skipped";

export interface EnvironmentEntry {
    status: EnvStatus;
    reason?: string;
    executionId: string;
    ranAt: string;
    durationMs: number | null;
    failedStep?: { index: number; title: string };
    artifacts: Array<{ id: string; kind: string }>;
    severity?: { severity: "critical" | "high" | "medium" | "low"; basis: string } | null;
}

/** What a test's detail adds when the project uses environments or the test is data-driven. */
export interface EnvironmentDetail {
    environmentResults?: Record<string, EnvironmentEntry>;
    dataDriven?: { dataSet: string; found: boolean; rows: number; total: number; truncated: boolean; note?: string } | null;
}

export interface DataSetBrief {
    name: string;
    columns: string[];
    rowCount: number;
    testedRows: number;
    truncated: boolean;
    usedBy: number;
    updatedAt: string;
}

/** The result of one test in one environment, in words. */
export const ENV_STATUS: Record<EnvStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
    passed: { label: "Passed", tone: "success" },
    finding: { label: "Found a problem", tone: "warning" },
    failed: { label: "Failed", tone: "danger" },
    skipped: { label: "Not run", tone: "neutral" },
};

/** What each result means (src/engine/environments/env.ts: a test that cannot run on an environment is skipped with its reason). */
export const ENV_HELP: Record<EnvStatus, string> = {
    passed: "The test passed the last time it ran on this environment.",
    finding: "The test ran on this environment and found something in your application that may be a problem.",
    failed: "The test did not pass the last time it ran on this environment, or could not run there.",
    skipped: "The test was left out on this environment, for example because it changes data and the environment is production. The reason is shown.",
};

/** Address as a person says it: no protocol, no trailing slash. */
export const shortAddress = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export const PRODUCTION_WARNING = "Production is read-only here: tests that change data (create, update or delete something) are never run. Each run still needs your confirmation.";
