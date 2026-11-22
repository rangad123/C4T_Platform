/**
 * Risky saved checks (Phase 4 Q4): requests sent several times at once (C8 `parallel`, generated or written by hand), writes as another
 * identity (C3e), and the bounded sign-in limit check (C11). Each run of such a test, whatever started it (a creation, Run, a schedule, CI,
 * a trigger, a runner), needs the gate at run time: data changes on, and a current authorization for the application's own origin or a
 * bench or fixture app on loopback. The job that runs it passes the gate to the script (RunEnv.riskyChecks); without it the script skips
 * itself with one sentence, and the test's result is left as it was.
 */
import type { TestSpec } from "../spec/schema.js";

export type RiskyKind = "concurrency" | "identity-write" | "rate-limit";

/** The sentence a skipped risky test gives. */
export const RISKY_SKIPPED =
    "Not run: it sends risky writes (several at once, as another account, or repeated sign-ins), which run only with data changes allowed and a current authorization for the application's own address, or on a benchmark or fixture app.";

/** What makes a saved test risky, read from its steps (so an edited test is judged by what it would send), or undefined. */
export function riskyKindOf(spec: Pick<TestSpec, "steps" | "tags">): RiskyKind | undefined {
    if (spec.steps.some((s) => s.action === "request" && s.parallel !== undefined)) return "concurrency";
    if (spec.steps.some((s) => s.action === "assert" && s.check === "accessDenied" && typeof s.expected === "string" && /"identityWrite"\s*:/.test(s.expected))) return "identity-write";
    if (spec.tags.includes("rate-limiting")) return "rate-limit";
    return undefined;
}

/** The first line of a risky test's body: it skips itself unless the run was given the gate. Empty for any other test. */
export function riskyGateLine(spec: Pick<TestSpec, "steps" | "tags">): string {
    return riskyKindOf(spec) ? `    test.skip(process.env.AITP_RISKY_CHECKS !== "1", ${JSON.stringify(RISKY_SKIPPED)});\n` : "";
}
