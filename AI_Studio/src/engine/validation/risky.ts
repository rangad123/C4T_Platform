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
    return riskyKindOf(spec) ? `    test.skip(process.env.TEST_RISKY_CHECKS !== "1", ${JSON.stringify(RISKY_SKIPPED)});\n` : "";
}

/**
 * A call that ends a session or revokes a credential: sign-out, a revoke, a deleted token, session or API key, a password change (not a
 * reset request, which only sends mail). Sent with the shared credentials it signs out or locks out every other test (N2D API-016: the
 * store's logout revoked the project's saved token, and 22 later tests were refused).
 */
export function endsSession(method: string, path: string): boolean {
    const m = method.toUpperCase();
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
    const p = path.split("?")[0]!.toLowerCase();
    if (/\/(?:log-?out|sign-?out|revoke)(?:\/|$)/.test(p)) return true;
    if (m === "DELETE" && /\/(?:tokens?|sessions?|api-?keys?)(?:\/|$)/.test(p)) return true;
    return /\/(?:change-?)?password(?:\/|$)/.test(p) && !/forgot|reset/.test(p);
}

/** The sentence a test gives when it would end the shared session. */
export const SESSION_END_SKIPPED =
    "Not run: it signs out, revokes a credential or changes a password with the project's shared credentials, which would sign every other test out. Generate it again, so it signs up an account of its own.";

/** A saved test that sends a session-ending call with the shared credentials (the project's token or account). */
export const endsSharedSession = (spec: Pick<TestSpec, "steps">): boolean => spec.steps.some((s) => s.action === "request" && s.auth !== "none" && endsSession(s.method, s.path));

/** The first line of such a test's body: it never runs. Empty for any other test. */
export function sessionEndLine(spec: Pick<TestSpec, "steps">): string {
    return endsSharedSession(spec) ? `    test.skip(true, ${JSON.stringify(SESSION_END_SKIPPED)});\n` : "";
}
