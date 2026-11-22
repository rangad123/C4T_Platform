/**
 * Deterministic failure classification (testing-engine Phase 5, spec §5.1 item 3). Pure: a rule table over the finding's attempts →
 * one of the owner's 8 classes, or `open` with the classes the evidence leaves (at least two). The AI (explain.ts) may only pick among
 * an open result's candidates and never overrides a decided class.
 *
 * Order: each failed attempt gets a cause (the test's own step = automation; a transport error = network; a runner error or a 5xx from
 * another origin = infrastructure; the environment not usable = environment; anything else is about the application). Different
 * causes leave it open. An application cause is reproduced when the same check failed with the same value in at least 2 attempts and
 * at least two thirds of them (H5: 2 of 3); not reproduced with passes = flaky. A reproduced failure is an application defect only
 * against a stated expectation (unstated or the planner's guess, or contradicted by a stated source = incorrect expectation; a
 * documented "not supported" = unsupported behaviour). Two cases stay open (CP5-A): a failure that replayed only on the shared, dirty
 * state (independence state_dependent / not_on_clean_state) until a fresh account reproduces it, and a lone locator timeout with no
 * replay (a seed can make an element never appear).
 */
import type { Attempt, FindingView } from "./view.js";

export const FINDING_CLASSES = [
    "app_defect",
    "incorrect_expectation",
    "automation",
    "infrastructure",
    "network",
    "environment",
    "flaky",
    "unsupported",
] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];

export interface Classification {
    class: FindingClass | "open";
    /** The decided class alone, or (open) the classes the rules could not tell apart. */
    candidates: FindingClass[];
    reason: string;
    /** Attempts that failed the same check the same way, of all attempts. */
    reproduced: { same: number; of: number };
}

const NETWORK = /net::ERR_|\bENOTFOUND\b|\bEAI_AGAIN\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|getaddrinfo|\bDNS\b|\bTLS\b|\bSSL\b|certificate/i;
const INFRASTRUCTURE = /browser has (?:been )?(?:closed|disconnected)|Target (?:page, context or browser|closed)|page crashed|out of memory|\bENOSPC\b|runner (?:lost|stopped|went away)/i;
const ENVIRONMENT = /could not sign in|sign-in (?:failed|was refused)|missing (?:run )?secret|environment variable|is not configured|no test account/i;

type Cause = Exclude<FindingClass, "app_defect" | "incorrect_expectation" | "flaky" | "unsupported"> | "app";

function causeOf(a: Attempt): Cause {
    const texts = [a.error ?? "", ...a.requests.map((r) => r.error ?? "")].join("\n");
    if (a.stepFault) return "automation";
    if (NETWORK.test(texts)) return "network";
    if (a.environment || ENVIRONMENT.test(texts)) return "environment";
    if (a.outcome === "error" || INFRASTRUCTURE.test(texts)) return "infrastructure";
    const ownServerError = a.requests.some((r) => r.own && (r.status ?? 0) >= 500);
    if (!ownServerError && a.requests.some((r) => !r.own && (r.status ?? 0) >= 500)) return "infrastructure";
    return "app";
}

/** Playwright's own sentence for a locator action that waited out its timeout, and nothing more specific. */
const BARE_LOCATOR_TIMEOUT = /^(?:TimeoutError: )?locator\.\w+: Timeout \d+ms exceeded\.?$/;

const CAUSE_WORDS: Record<Cause, string> = {
    automation: "the test's own step",
    network: "a network error",
    environment: "the environment",
    infrastructure: "the infrastructure (the runner, the browser or another service)",
    app: "the application's answer",
};

const norm = (s: string | undefined) => (s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
/** The same failure: the same step, check, target and expected value; with none of them known, the same first error line. */
const failureKey = (a: Attempt) => {
    const key = [a.failedStep ?? "", norm(a.check), norm(a.target), norm(a.value)].join("|");
    return key === "|||" ? `error:${norm(a.error?.split("\n")[0])}` : key;
};

const decided = (c: FindingClass, reason: string, reproduced: Classification["reproduced"]): Classification => ({ class: c, candidates: [c], reason, reproduced });
const open = (candidates: FindingClass[], reason: string, reproduced: Classification["reproduced"]): Classification => ({
    class: "open",
    candidates,
    reason,
    reproduced,
});

/** The most attempts that failed the same way because of the application's answer, of all attempts. */
export function reproduction(attempts: readonly Attempt[]): Classification["reproduced"] {
    const counts = new Map<string, number>();
    for (const a of attempts) if (a.outcome === "failed" && causeOf(a) === "app") counts.set(failureKey(a), (counts.get(failureKey(a)) ?? 0) + 1);
    return { same: Math.max(0, ...counts.values()), of: attempts.length };
}

/** H5: at least 2 attempts and at least two thirds of them failed the same way (2 of 3, 3 of 4, 4 of 5). */
export const isReproduced = (r: Classification["reproduced"]) => r.same >= Math.max(2, Math.ceil((2 * r.of) / 3));

export function classify(f: Pick<FindingView, "attempts" | "expected" | "layer" | "independence">): Classification {
    const rep = reproduction(f.attempts);
    if (f.attempts.length === 0) return open(["app_defect", "incorrect_expectation"], "No attempt was recorded, so nothing shows what happened.", rep);
    const failing = f.attempts.filter((a) => a.outcome !== "passed");
    if (failing.length === 0)
        return open(["app_defect", "incorrect_expectation"], "No attempt failed: the problem was described, not shown by a failing check.", rep);

    const causes = [...new Set(failing.map(causeOf))];
    if (causes.length > 1) {
        const classes = causes.map((c) => (c === "app" ? "app_defect" : c)) as FindingClass[];
        return open(classes, `The attempts failed for different reasons: ${causes.map((c) => CAUSE_WORDS[c]).join("; ")}.`, rep);
    }
    const cause = causes[0]!;
    const n = f.attempts.length;
    if (cause === "automation" && n === 1 && BARE_LOCATOR_TIMEOUT.test(f.attempts[0]!.error?.split("\n")[0]?.trim() ?? ""))
        return open(["automation", "app_defect"], "One attempt timed out waiting for an element, with no replay: the step may be wrong, or the application never showed the element.", rep);
    if (cause !== "app") return decided(cause, `${failing.length} of ${n} attempts failed because of ${CAUSE_WORDS[cause]}.`, rep);

    if (!isReproduced(rep)) {
        const passed = n - failing.length;
        // A concurrency check is nondeterministic by design: failing some of the time can be the race it looks for.
        if (f.layer === "concurrency") return open(["app_defect", "flaky"], `A concurrency check failed the same way in ${rep.same} of ${n} attempts.`, rep);
        if (passed > 0) return decided("flaky", `The same failure came back in ${rep.same} of ${n} attempts; ${passed} passed.`, rep);
        return open(["app_defect", "flaky"], n < 2 ? "One attempt cannot show that the failure comes back." : `Every attempt failed, but not at the same check twice.`, rep);
    }
    const same = `The same check failed the same way in ${rep.same} of ${n} attempts`;
    if (f.expected.unsupportedPer) return decided("unsupported", `${same}, and ${f.expected.unsupportedPer} documents this as not supported.`, rep);
    if (f.expected.contradictedBy) return decided("incorrect_expectation", `${same}, but ${f.expected.contradictedBy} states otherwise than the check.`, rep);
    if (f.expected.stated === "none" || f.expected.stated === "inferred")
        return decided("incorrect_expectation", `${same}, but no source states what the check expects (${f.expected.stated === "none" ? "unstated" : "the planner's guess"}).`, rep);
    const stated = `against an expectation ${f.expected.stated === "confirmed" ? "a person confirmed" : "a source states"}`;
    if (f.independence === "state_dependent" || f.independence === "not_on_clean_state")
        return open(["app_defect", "environment", "automation"], `${same}, ${stated}, but only on the shared account's state: it stays open until a fresh account reproduces it.`, rep);
    return decided("app_defect", `${same}, ${stated}.`, rep);
}
