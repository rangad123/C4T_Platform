/**
 * Severity and confidence (testing-engine Phase 5, spec §5.1 item 5), kept apart: how bad it would be, and how sure we are. Pure; each
 * factor carries its value and the reason, which are shown beside the score.
 *
 * Severity, the most severe of 5 factors: business (validation/severity.ts's assessment or the journey's priority, one step higher
 * for the criticality words of explore/priority.ts), security, data integrity (a stored-data, database or concurrency layer), scope of
 * affected users (a public page, several roles) and availability (the application's own 5xx, a crash).
 * Confidence, the weakest of: evidence (explore/finding.ts's confidenceOf over source and capture; disagreeing Phase 4 layers count as
 * evidence), reproduction (H5: 2 of 3), and how reliable the expectation is. A class only the AI chose caps it at medium.
 *
 * Display rule: nothing below high confidence is shown as "Confirmed", and a critical or high security finding without H5 reproduction
 * is "possible …, needs review".
 */
import { confidenceOf, type FindingConfidence } from "../explore/finding.js";
import { priorityOf } from "../explore/priority.js";
import { parseAccessReason } from "../identity/access.js";
import { SEVERITIES, type Severity } from "../validation/severity.js";
import { isReproduced, reproduction } from "./classify.js";
import { STATE_LABEL, type FindingState } from "./lifecycle.js";
import type { FindingView } from "./view.js";

export interface Factor<V> {
    value: V;
    reason: string;
}
export type SeverityFactor = Factor<Severity | "none">;
export interface SeverityScore {
    severity: Severity;
    basis: string;
    factors: { business: SeverityFactor; security: SeverityFactor; dataIntegrity: SeverityFactor; scope: SeverityFactor; availability: SeverityFactor };
}
export interface ConfidenceScore {
    confidence: FindingConfidence;
    basis: string;
    factors: {
        evidence: Factor<FindingConfidence>;
        reproduction: Factor<FindingConfidence>;
        expectation: Factor<FindingConfidence>;
        /** Phase 4 layers that disagreed; 0 until Phase 4 lands (spec §8). */
        signals: Factor<number>;
    };
}

const rank = (s: Severity) => SEVERITIES.indexOf(s);
const raise = (s: Severity): Severity => SEVERITIES[Math.max(0, rank(s) - 1)]!;
const CONF: readonly FindingConfidence[] = ["low", "medium", "high"];
const weakest = (xs: FindingConfidence[]) => CONF[Math.min(...xs.map((x) => CONF.indexOf(x)))]!;
const none = (reason: string): SeverityFactor => ({ value: "none", reason });

const DATA_LAYERS = ["storedData", "database", "concurrency"];
const CRASH = /page crashed|\bcrash(?:ed|es)?\b|service unavailable|\bunavailable\b/i;

type SeverityInput = Pick<FindingView, "title" | "expected" | "priority" | "baseSeverity" | "security" | "origin" | "layer" | "scope" | "attempts">;

export function severityOf(f: SeverityInput): SeverityScore {
    // An access check that rates its own failure below a broken access control (a refusal with another status than documented) keeps it.
    const own = f.origin === "access-check" ? parseAccessReason(f.attempts.find((a) => a.outcome === "failed" && a.error)?.error ?? "") : undefined;
    if (own === "medium" || own === "low") {
        const factor = { value: own, reason: "the access check rates it so (a refusal that differs from the API document)" };
        return { severity: own, basis: `security: ${factor.reason}`, factors: { business: none("rated by the access check"), security: factor, dataIntegrity: none("no stored-data check"), scope: none("rated by the access check"), availability: none("rated by the access check") } };
    }
    const base: Factor<Severity> = f.baseSeverity
        ? { value: f.baseSeverity.severity, reason: f.baseSeverity.basis }
        : { value: f.priority ?? "medium", reason: `a ${f.priority ?? "medium"}-priority journey${f.priority ? "" : " (priority not recorded)"}` };
    const words = /mentions (.+?), a rule check\.$/.exec(priorityOf({ kind: "rule", sourceText: `${f.title} ${f.expected.text}`, stated: "none" }).reason)?.[1];
    const business: SeverityFactor = words ? { value: raise(base.value), reason: `${base.reason}; mentions ${words}` } : base;

    const security: SeverityFactor = f.security
        ? { value: f.security.severity === "info" ? "low" : f.security.severity, reason: `security finding (${f.security.category})` }
        : f.origin === "security-check" || f.origin === "access-check" || f.layer === "security"
          ? { value: "high", reason: "a security or access check failed" }
          : none("not a security check");
    const dataIntegrity: SeverityFactor =
        f.layer && DATA_LAYERS.includes(f.layer) ? { value: "high", reason: `the ${f.layer} layer disagreed with what was expected` } : none("no stored-data check");
    const scope: SeverityFactor = !f.scope
        ? none("who it affects is not recorded")
        : f.scope.public
          ? { value: "high", reason: "a public page (signed out)" }
          : f.scope.roles >= 2
            ? { value: "high", reason: `${f.scope.roles} roles see it` }
            : f.scope.roles === 1
              ? { value: "medium", reason: "one role sees it" }
              : none("no role recorded");
    const failed = f.attempts.filter((a) => a.outcome !== "passed");
    const down = failed.some((a) => a.requests.some((r) => r.own && (r.status ?? 0) >= 500) || CRASH.test(a.error ?? ""));
    const availability: SeverityFactor = !down
        ? none("no server error or crash")
        : f.priority === "critical"
          ? { value: "critical", reason: "a server error or crash on a critical journey" }
          : { value: "high", reason: "a server error (5xx) or crash" };

    const factors = { business, security, dataIntegrity, scope, availability };
    const [name, worst] = Object.entries(factors)
        .filter((e): e is [string, Factor<Severity>] => e[1].value !== "none")
        .sort((a, b) => rank(a[1].value) - rank(b[1].value))[0]!;
    return { severity: worst.value, basis: `${name === "dataIntegrity" ? "data integrity" : name}: ${worst.reason}`, factors };
}

type ConfidenceInput = Pick<FindingView, "expected" | "capture" | "independence" | "attempts" | "correlated">;

/** `aiClass`: the class was picked by the AI among the open ones (explain.ts), not by the rules. */
export function confidenceScore(f: ConfidenceInput, opts: { aiClass?: boolean } = {}): ConfidenceScore {
    const sourced = f.expected.source !== null;
    const capture = f.capture ?? (f.attempts.some((a) => a.outcome === "failed" && a.check) ? "captured" : "observed_only");
    // Reproduction is its own factor; only a replay that failed on the shared account (not clean state) weakens the evidence here.
    const independence = f.independence === "state_dependent" || f.independence === "not_on_clean_state" ? f.independence : "independent";
    const own = confidenceOf({ sourced, capture, independence });
    const layers = f.correlated?.disagreed.length ?? 0;
    const evidenceValue = layers >= 2 ? "high" : layers === 1 && own === "low" ? "medium" : own;
    const evidence: Factor<FindingConfidence> = {
        value: evidenceValue,
        reason: [
            capture === "captured" ? (sourced ? "a captured check of a sourced expectation" : "a captured check with no source") : "described, no failing check captured",
            independence !== "independent" ? "the replays ran on the shared account, not a clean one" : "",
            layers ? `${layers} layer${layers === 1 ? "" : "s"} disagreed` : "",
        ]
            .filter(Boolean)
            .join("; "),
    };
    const rep = reproduction(f.attempts);
    const reproductionFactor: Factor<FindingConfidence> = isReproduced(rep)
        ? { value: "high", reason: `the same failure in ${rep.same} of ${rep.of} attempts` }
        : rep.of < 2
          ? { value: "medium", reason: "not replayed yet" }
          : { value: "low", reason: `the same failure in only ${rep.same} of ${rep.of} attempts` };
    const e = f.expected;
    const expectation: Factor<FindingConfidence> = e.contradictedBy
        ? { value: "low", reason: `${e.contradictedBy} states otherwise` }
        : e.stated === "confirmed"
          ? { value: "high", reason: "a person confirmed the expectation" }
          : e.stated === "explicit"
            ? { value: "high", reason: "a source states the expectation" }
            : e.stated === "inferred"
              ? { value: "medium", reason: "the expectation is the planner's guess" }
              : { value: "low", reason: "nothing states the expectation" };
    const signals: Factor<number> = { value: layers, reason: layers ? `${layers} layers disagreed` : "no layer comparison recorded" };

    let confidence = weakest([evidence.value, reproductionFactor.value, expectation.value]);
    let basis = [evidence, reproductionFactor, expectation].find((x) => x.value === confidence)!.reason;
    if (opts.aiClass && confidence === "high") {
        confidence = "medium";
        basis = "the class was the AI's choice, not a rule's";
    }
    return { confidence, basis, factors: { evidence, reproduction: reproductionFactor, expectation, signals } };
}

const CONFIRMED_STATES: readonly FindingState[] = ["confirmed", "classified", "reported"];

/** What the card shows as the finding's status: never "Confirmed" below high confidence. */
export function label(f: { state: FindingState; severity: Severity; confidence: FindingConfidence; security: boolean; reproduced: boolean }): string {
    const kind = f.security ? "security issue" : "bug";
    if (!CONFIRMED_STATES.includes(f.state)) return STATE_LABEL[f.state];
    const unsure = f.confidence !== "high" || (f.security && (f.severity === "critical" || f.severity === "high") && !f.reproduced);
    return unsure ? `Possible ${f.severity} ${kind}, needs review` : `Confirmed ${f.severity} ${kind}`;
}
