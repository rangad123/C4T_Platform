/**
 * Release sign-off rules: pure functions, no database, no clock. The same rules are returned by the API (`SIGNOFF_RULES`)
 * and written in the feature doc, so a person can always see why a release cannot be approved.
 *
 * A "manual check left" is one that was not run or is blocked. Skipped counts as done: skipping is a decision someone made.
 */
import type { CasePriority, ManualResult } from "./cases.js";

export type AutomatedState = "ready" | "needs-attention" | "blocked" | "unknown";

export interface RollupItem {
    priority: CasePriority;
    result: ManualResult;
}

export interface Rollup {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    notRun: number;
    /** Not run, or blocked: still to be done. */
    left: number;
    /** Checks that are done (passed, failed or skipped). */
    done: number;
}

export function rollup(items: RollupItem[]): Rollup {
    const count = (r: ManualResult) => items.filter((i) => i.result === r).length;
    const r = { passed: count("passed"), failed: count("failed"), blocked: count("blocked"), skipped: count("skipped"), notRun: count("not_run") };
    return { total: items.length, ...r, left: r.notRun + r.blocked, done: r.passed + r.failed + r.skipped };
}

export type SignoffCode = "automated-blocked" | "manual-failed" | "important-unfinished" | "automated-attention" | "automated-unknown" | "other-unfinished" | "quarantined-tests";

export interface SignoffReason {
    code: SignoffCode;
    text: string;
}

export interface SignoffInput {
    /** The automated readiness, or null when it could not be worked out. */
    automated: { state: AutomatedState; reasons: Array<{ text: string }> } | null;
    items: RollupItem[];
    /** Tests in quarantine: left out of the automated state, but an approver must know about them. */
    quarantined?: number;
}

export interface SignoffEvaluation {
    /** Approving needs an override while any of these holds. */
    blocking: SignoffReason[];
    /** Worth knowing, never stops an approval. */
    warnings: SignoffReason[];
    canApprove: boolean;
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const isLeft = (r: ManualResult) => r === "not_run" || r === "blocked";

export function evaluateSignoff(i: SignoffInput): SignoffEvaluation {
    const blocking: SignoffReason[] = [];
    const warnings: SignoffReason[] = [];

    if (i.automated?.state === "blocked") {
        const why = i.automated.reasons.slice(0, 2).map((r) => r.text).join("; ");
        blocking.push({ code: "automated-blocked", text: `The automated tests are blocked${why ? `: ${why}` : ""}` });
    }
    const failed = i.items.filter((x) => x.result === "failed").length;
    if (failed > 0) blocking.push({ code: "manual-failed", text: `${n(failed, "manual check")} failed` });
    const important = i.items.filter((x) => (x.priority === "critical" || x.priority === "high") && isLeft(x.result)).length;
    if (important > 0) blocking.push({ code: "important-unfinished", text: `${n(important, "critical or high-priority manual check")} not finished (not run or blocked)` });

    if (i.automated?.state === "needs-attention") {
        const why = i.automated.reasons.slice(0, 2).map((r) => r.text).join("; ");
        warnings.push({ code: "automated-attention", text: `The automated tests need attention${why ? `: ${why}` : ""}` });
    }
    if (!i.automated || i.automated.state === "unknown") warnings.push({ code: "automated-unknown", text: "There is not enough automated test information to judge this release" });
    if (i.quarantined) warnings.push({ code: "quarantined-tests", text: `${n(i.quarantined, "quarantined test")} ${i.quarantined === 1 ? "was" : "were"} not counted; ${i.quarantined === 1 ? "it is" : "they are"} listed below` });
    const other = i.items.filter((x) => (x.priority === "medium" || x.priority === "low") && isLeft(x.result)).length;
    if (other > 0) warnings.push({ code: "other-unfinished", text: `${n(other, "medium or low-priority manual check")} not finished` });

    return { blocking, warnings, canApprove: blocking.length === 0 };
}

export const OVERRIDE_MIN_COMMENT = 10;

/** The comment that goes with an override: trimmed, and long enough to say something. */
export const overrideCommentOk = (comment: string | undefined | null): boolean => (comment ?? "").trim().length >= OVERRIDE_MIN_COMMENT;

export const SIGNOFF_RULES: { blocking: string[]; warnings: string[]; override: string; immutable: string } = {
    blocking: [
        "The automated tests are blocked (an open critical or high-severity finding, or the last run failed)",
        "Any manual check has failed",
        "Any critical or high-priority manual check is not run or blocked",
    ],
    warnings: [
        "The automated tests need attention",
        "The automated tests have no result yet, so the release cannot be judged",
        "Medium or low-priority manual checks are not run or blocked",
    ],
    override: `Approving while something blocks it needs “override” and a comment of at least ${OVERRIDE_MIN_COMMENT} characters saying why. Rejecting never needs a reason.`,
    immutable: "A signed release cannot be changed. Reopening it needs a name and a comment, and is recorded.",
};

const READINESS_WORDS: Record<AutomatedState, string> = { ready: "automated tests ready", "needs-attention": "automated tests need attention", blocked: "automated tests blocked", unknown: "automated state unknown" };

/** "Release 2.4: 3 of 14 manual checks left, automated tests ready" */
export function releaseSentence(name: string, r: Rollup, state: AutomatedState | null): string {
    const manual = r.total === 0 ? "no manual checks" : r.left === 0 ? (r.total === 1 ? "the manual check is done" : `all ${r.total} manual checks done`) : `${r.left} of ${n(r.total, "manual check")} left`;
    return `Release ${name}: ${manual}, ${READINESS_WORDS[state ?? "unknown"]}`;
}
