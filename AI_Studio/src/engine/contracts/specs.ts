/** Classifies a failed API run as a contract finding (the response differs from its documentation). */
import type { Step, TestSpec } from "../spec/schema.js";
import type { ScriptRun } from "../validation/runner.js";
import { CONTRACT_ADVICE, CONTRACT_FAILURE_PREFIX, worstContractTag } from "./check.js";

/** The failure text of the contract step, minus any call log Playwright appended. */
function ownMessage(text: string): string | undefined {
    const at = text.indexOf(CONTRACT_FAILURE_PREFIX);
    if (at < 0) return undefined;
    const lines = text.slice(at).split("\n");
    const end = lines.findIndex((l, i) => i > 0 && !l.startsWith("- "));
    return lines
        .slice(0, end < 0 ? lines.length : end)
        .join("\n")
        .trim();
}

/**
 * A run is a contract finding only when the failing step is the schema check and its error is the check's own
 * message — e.g. not when the request itself failed or an earlier assertion did.
 */
export function contractFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    const isStep = (s: Step | undefined) => s?.action === "assertResponse" && s.check === "matchesSchema";
    let message: string | undefined;
    for (const st of run.steps) if (st.status === "failed" && isStep(spec.steps[st.index])) message = ownMessage(st.error ?? "") ?? message;
    if (!message && run.steps.length === 0 && spec.steps.some(isStep)) message = ownMessage(run.error ?? "");
    return message ? `${message}\nHow to fix: ${CONTRACT_ADVICE}`.slice(0, 2500) : undefined;
}

/** Worst severity of a contract finding reason (undefined if it is not one). */
export function parseContractReason(reason: string): "high" | "medium" | "low" | undefined {
    if (!reason.includes(CONTRACT_FAILURE_PREFIX)) return undefined;
    return worstContractTag(reason.split(/^how to fix:/im)[0] ?? "") ?? "low";
}
