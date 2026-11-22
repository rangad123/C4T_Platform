/**
 * Reproduction (testing-engine Phase 5 V1, spec §5.1 item 2, Q4–Q6): a finding's test is run again `attempts` times (1–5, default 3),
 * each attempt in a fresh browser and, where the test signs in as the project's account and a new one can be registered
 * (explore/clean-account.ts), as a newly registered account, with no video. This module is the pure part: the budget, the attempts
 * setting, the reset hook's address rule and the verdict that moves a finding out of Verification pending. Running the attempts is
 * validation/runner.ts (`attempts` on a run, hook H1); platform/findings/verify-service.ts wires both to the stored findings.
 *
 * Only the verification attempts are judged, never the detection: the detection may have run on the shared account's leftovers. A
 * failure that comes back on clean state is Reproduced; one that does not come back is Unconfirmed with the reason (on a new account:
 * state-bound); one that comes back only on the shared account stays Unconfirmed until clean state reproduces it. No AI calls.
 */
import { classify, isReproduced, type Classification } from "./classify.js";
import type { FindingState } from "./lifecycle.js";
import type { Attempt, FindingView } from "./view.js";

/** Q4: at most this many findings are verified per run, each for at most this long. */
export const VERIFY_BUDGET = { findingsPerRun: 30, minutesEach: 10 } as const;
export type VerifyBudget = { findingsPerRun: number; minutesEach: number };
/** Q4: attempts per finding, a project setting (H5: confirmed at 2 of 3). */
export const VERIFY_ATTEMPTS = { min: 1, max: 5, default: 3 } as const;

/** The project's attempts setting as a whole number from 1 to 5; anything else is the default, 3. */
export function attemptsSetting(v: unknown): number {
    return typeof v === "number" && Number.isInteger(v) && v >= VERIFY_ATTEMPTS.min && v <= VERIFY_ATTEMPTS.max ? v : VERIFY_ATTEMPTS.default;
}

/**
 * Q5: the reset request a verification sends before each attempt goes only to the application's own origin, as a POST, with no sign-in
 * in the address (the token travels as a header, a run secret). Stricter than the run reset (test-data-reset-store.ts resetTarget): no
 * administrator allow-list, because it is sent once per attempt. Undefined when allowed, else the sentence.
 */
export function resetHookProblem(hook: { method: string; url: string }, appUrl: string): string | undefined {
    let own: string;
    let target: URL;
    try {
        own = new URL(appUrl).origin;
        target = new URL(hook.url, appUrl);
    } catch {
        return "The reset address is not a valid address, so verification does not reset the application.";
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return "The reset address is not an http(s) address, so verification does not reset the application.";
    if (hook.method.toUpperCase() !== "POST") return `Verification resets the application with a POST only; the reset is a ${hook.method.toUpperCase()}, so it is not sent.`;
    if (target.username || target.password) return "The reset address holds sign-in details; put the token in a header. It is not sent.";
    if (target.origin !== own) return `Verification sends the reset only to the application's own site (${own}), not to ${target.origin}. It is not sent.`;
    return undefined;
}

/** Who the attempts ran as: clean state (a new account, or a test that never signs in) or the shared account, and the sentence. */
export interface AttemptAccount {
    clean: boolean;
    note: string;
}

export interface Verdict {
    to: Extract<FindingState, "reproduced" | "unconfirmed" | "flaky" | "automation_issue" | "environment_issue" | "needs_manual_review">;
    reason: string;
    classification: Classification;
}

/** The move out of Verification pending that these attempts make. */
export function verdictOf(f: Pick<FindingView, "expected" | "layer">, attempts: readonly Attempt[], account: AttemptAccount): Verdict {
    const classification = classify({ attempts: [...attempts], expected: f.expected, layer: f.layer, independence: account.clean ? "independent" : "not_on_clean_state" });
    const n = attempts.length;
    const v = (to: Verdict["to"], reason: string): Verdict => ({ to, reason, classification });
    if (n === 0) return v("unconfirmed", "No verification attempt ran, so nothing shows the failure comes back.");
    if (attempts.every((a) => a.outcome === "passed")) {
        return v(
            "unconfirmed",
            account.clean && /newly registered/.test(account.note)
                ? `It passed in ${n} of ${n} attempts ${account.note}: the failure depends on what earlier tests left on the shared test account (state-bound), not on the application.`
                : `It passed in ${n} of ${n} attempts (${account.note}): the failure did not come back.`,
        );
    }
    const c = classification;
    if (c.class === "automation") return v("automation_issue", c.reason);
    if (c.class === "environment") return v("environment_issue", c.reason);
    if (c.class === "network" || c.class === "infrastructure") return v("unconfirmed", `It could not be verified: ${c.reason}`);
    if (c.class === "flaky") return v("flaky", c.reason);
    // Different causes in different attempts, none of them the application: a person tells them apart.
    if (c.class === "open" && !c.candidates.includes("app_defect")) return v("needs_manual_review", c.reason);
    if (!isReproduced(c.reproduced)) return v("unconfirmed", c.reason);
    const same = `The same check failed the same way in ${c.reproduced.same} of ${n} attempts`;
    if (!account.clean) return v("unconfirmed", `${same}, but only ${account.note}. It stays unconfirmed until clean state reproduces it.`);
    return v("reproduced", `${same}, ${account.note}.`);
}

export interface BudgetRun<T, R> {
    done: Array<{ item: T; result: R }>;
    /** Items whose attempts ran past the time each may take: `why` says so. */
    timedOut: Array<{ item: T; why: string }>;
    /** Items left for the next run. */
    left: T[];
    /** Why verification stopped before every item (the budget), else undefined. */
    stopped?: string;
}

/**
 * Verifies at most `budget.findingsPerRun` items, one at a time, each with a signal that ends it after `budget.minutesEach` minutes (or
 * when `signal` ends). The rest wait, and `stopped` says why.
 */
export async function withinBudget<T, R>(items: readonly T[], one: (item: T, signal: AbortSignal) => Promise<R>, budget: VerifyBudget = VERIFY_BUDGET, signal?: AbortSignal): Promise<BudgetRun<T, R>> {
    const out: BudgetRun<T, R> = { done: [], timedOut: [], left: [] };
    const cap = Math.max(0, Math.floor(budget.findingsPerRun));
    const ms = budget.minutesEach * 60_000;
    for (const [i, item] of items.entries()) {
        if (signal?.aborted) {
            out.left = items.slice(i);
            out.stopped = "Verification stopped before every finding was verified: the platform is shutting down or the run was stopped.";
            return out;
        }
        if (i >= cap) {
            out.left = items.slice(i);
            out.stopped = `The verification budget of ${cap} finding${cap === 1 ? "" : "s"} per run was used: ${out.left.length} more ${out.left.length === 1 ? "is" : "are"} not verified in this run.`;
            return out;
        }
        const timer = AbortSignal.timeout(ms);
        const each = signal ? AbortSignal.any([signal, timer]) : timer;
        // The limit holds even when the work does not listen to its signal.
        const late = new Promise<never>((_, reject) => each.addEventListener("abort", () => reject(each.reason), { once: true }));
        late.catch(() => undefined);
        try {
            out.done.push({ item, result: await Promise.race([one(item, each), late]) });
        } catch (e) {
            if (!timer.aborted) throw e;
            out.timedOut.push({ item, why: `Its attempts took longer than the ${budget.minutesEach} minute${budget.minutesEach === 1 ? "" : "s"} a finding may take, so they were stopped.` });
        }
    }
    return out;
}
