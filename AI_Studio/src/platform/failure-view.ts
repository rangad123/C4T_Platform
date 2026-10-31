/**
 * The expected / actual facts of a test's runs, added to the test-detail answer. Read from the errors the runs stored (so older
 * runs have them too); nothing is stored twice. Additive: a step or a test with nothing to add is returned exactly as it was.
 */
import { failureFacts, isMissingApiToken, type FailureFacts } from "../engine/evidence/failure-facts.js";
import type { Step } from "../engine/spec/schema.js";

interface StepRow {
    index: number;
    title: string;
    status: string;
    error: string | null;
    [k: string]: unknown;
}
interface ExecutionRow {
    steps: StepRow[];
    [k: string]: unknown;
}
/** The rows the repo hands out are loosely typed; these are the fields this file reads. */
export const asExecutions = (rows: unknown[]): ExecutionRow[] => rows as ExecutionRow[];

/** Each failed step gets `expected` and `actual` when its error names them. `steps` is what really ran (reusable steps put in place), by index. */
export function withFailureFacts<E extends ExecutionRow>(executions: E[], steps: Step[]): E[] {
    return executions.map((e) => ({
        ...e,
        steps: e.steps.map((s) => {
            if (s.status !== "failed") return s;
            const facts = failureFacts(s.error, steps[s.index]);
            return facts ? { ...s, ...facts } : s;
        }),
    }));
}

export interface FailureSummary {
    /** "missing-api-token": the test needs a credential none is saved for. "mismatch": a check got something other than what it expected. */
    kind: "missing-api-token" | "mismatch";
    /** 0-based index of the step that failed, and its title. Absent for the missing token (the reason is about the project, not a step). */
    step?: { index: number; title: string };
    expected?: string;
    actual?: string;
}

/** What the test's latest failure comes down to, in fields; undefined when it has none (a passing test, or an error without facts). */
export function failureSummary(executions: ExecutionRow[], reason: string | null | undefined): FailureSummary | undefined {
    if (isMissingApiToken(reason)) return { kind: "missing-api-token" };
    const latest = executions[0];
    const failed = latest?.steps.find((s) => s.status === "failed") as (StepRow & Partial<FailureFacts>) | undefined;
    if (!failed || (failed.expected === undefined && failed.actual === undefined)) return undefined;
    return { kind: "mismatch", step: { index: failed.index, title: failed.title }, ...(failed.expected !== undefined ? { expected: failed.expected } : {}), ...(failed.actual !== undefined ? { actual: failed.actual } : {}) };
}
