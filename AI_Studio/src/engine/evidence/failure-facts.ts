/**
 * What a failed check expected and what it got, read from the error the test runner reported (Playwright prints "Expected: ..." and
 * "Received: ..." lines). Pure text work: nothing is run, nothing is fetched, and nothing is guessed. When the error has no such
 * lines there are no facts, and the caller shows the error as it is.
 *
 * The values are plain strings, one line each, capped. They come from the application's own answers and pages, so a caller treats
 * them as text to show, never as markup or as an instruction.
 */
import type { Step } from "../spec/schema.js";

/** Most characters of one value. */
export const FACT_MAX = 200;

export interface FailureFacts {
    /** What the test expected, as a short plain string ("HTTP 200", "2xx", "Added to the cart"). */
    expected?: string;
    /** What it got instead ("HTTP 401", "4xx", "Added"). */
    actual?: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const EXPECTED = /^[ \t]*Expected(?: (?:string|substring|pattern|value|result))?:[ \t]*(.+?)[ \t]*$/m;
const RECEIVED = /^[ \t]*Received(?: (?:string|value|result))?:[ \t]*(.+?)[ \t]*$/m;

function plain(raw: string): string {
    let v = raw.trim();
    // Playwright prints texts in double quotes and "not there" in angle brackets.
    if (/^<element\(s\) not found>$/i.test(v)) return "not found on the page";
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v.length > FACT_MAX ? `${v.slice(0, FACT_MAX - 1)}…` : v;
}

/**
 * The facts in an error message, or undefined when it names neither. `step` (the step of the test that failed) lets a status check say
 * "HTTP 200" and "2xx" instead of a bare number.
 */
export function failureFacts(message: string | null | undefined, step?: Step): FailureFacts | undefined {
    if (!message) return undefined;
    const text = message.replace(ANSI, "");
    const e = EXPECTED.exec(text)?.[1];
    const r = RECEIVED.exec(text)?.[1];
    if (e === undefined && r === undefined) return undefined;
    let expected = e === undefined ? undefined : plain(e);
    let actual = r === undefined ? undefined : plain(r);
    if (step?.action === "assertResponse") {
        // A status check compares numbers: say what the numbers are.
        if (step.check === "status") {
            if (expected !== undefined && /^\d{3}$/.test(expected)) expected = `HTTP ${expected}`;
            if (actual !== undefined && /^\d{3}$/.test(actual)) actual = `HTTP ${actual}`;
        } else if (step.check === "statusClass") {
            // The script compares the first digit of the status; the test says "2xx".
            if (expected !== undefined && /^\d$/.test(expected)) expected = `${expected}xx`;
            if (actual !== undefined && /^\d$/.test(actual)) actual = `${actual}xx`;
        } else if (step.check === "statusBelow") {
            if (expected !== undefined) expected = expected.replace(/^<\s*(\d+)$/, "below $1");
            if (actual !== undefined && /^\d{3}$/.test(actual)) actual = `HTTP ${actual}`;
        }
    }
    return { ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) };
}

/** The sentence that names a missing API token as the reason (the platform's wording; the UI shows it as it is). */
export const MISSING_API_TOKEN_REASON = "The test needs the project's API token, and none is saved. Add it where the project keeps it (API access in What the agents need, on the Requirements tab, or the environment the test runs against, under Settings), then run the test again.";

/** True for a stored reason that is the missing-token sentence. */
export const isMissingApiToken = (reason: string | null | undefined): boolean => !!reason && reason.startsWith("The test needs the project's API token, and none is saved.");

/**
 * The reason a failed API test failed when it asked for a protected answer without any credential: the step that failed followed a
 * request that sends the project's API credential, the application answered 401, and no token (or auth header) is set for this run.
 * Undefined when that is not what happened.
 */
export function missingApiTokenReason(
    spec: { kind: string; steps: Step[] },
    run: { status: string; steps: Array<{ index: number; status: string }>; responses: Array<{ status: number }> },
    credentials: { apiToken?: string; apiAuthHeader?: string },
): string | undefined {
    if (spec.kind !== "api" || run.status === "passed" || credentials.apiToken || credentials.apiAuthHeader) return undefined;
    const failed = run.steps.find((s) => s.status === "failed");
    if (!failed) return undefined;
    const requests = spec.steps.slice(0, failed.index + 1).filter((s): s is Extract<Step, { action: "request" }> => s.action === "request");
    const last = requests.at(-1);
    const answer = run.responses[requests.length - 1];
    if (!last || !answer || answer.status !== 401 || last.auth === "none") return undefined;
    return MISSING_API_TOKEN_REASON;
}
