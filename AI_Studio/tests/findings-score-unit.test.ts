/**
 * Phase 5 F4: severity and confidence, kept apart. Severity is the worst of business, security, data integrity, scope and
 * availability; confidence is the weakest of evidence, reproduction and expectation, and an AI-chosen class caps it at medium. Pairs of
 * fixtures move one and not the other. V6 rules: nothing below high confidence is labelled "Confirmed"; a critical or high security
 * finding without H5 reproduction is "possible …, needs review".
 */
import { describe, expect, it } from "vitest";
import { confidenceScore, label, severityOf } from "../src/engine/findings/score.js";
import { FindingViewSchema, type FindingView, type FindingViewInput } from "../src/engine/findings/view.js";
import { FINDING_STATES } from "../src/engine/findings/lifecycle.js";

type AttemptIn = NonNullable<FindingViewInput["attempts"]>[number];
const fail = (o: Partial<AttemptIn> = {}): AttemptIn => ({ outcome: "failed", failedStep: 3, check: "text", target: "Name", ...o });

function view(extra: Partial<FindingViewInput> = {}): FindingView {
    return FindingViewSchema.parse({
        id: "f1",
        projectId: "p1",
        source: { kind: "execution", id: "t1" },
        state: "confirmed",
        title: "Profile name is saved",
        testId: "t1",
        detectedAt: "2026-11-21T10:00:00.000Z",
        expected: { text: "The new name is shown after saving", source: "R-1", stated: "explicit" },
        observed: "The old name was shown",
        steps: [],
        attempts: [fail(), fail(), fail()],
        priority: "medium",
        ...extra,
    });
}

describe("severity", () => {
    it("is the business factor alone for a plain functional failure, one step higher for money words", () => {
        const s = severityOf(view());
        expect(s.severity).toBe("medium");
        expect(s.factors.security.value).toBe("none");
        expect(s.basis).toMatch(/^business: a medium-priority journey/);
        const money = severityOf(view({ title: "Order total includes the discount" }));
        expect(money.severity).toBe("high");
        expect(money.factors.business.reason).toMatch(/mentions money and order/);
        expect(severityOf(view({ baseSeverity: { severity: "low", basis: "visual change from the approved baseline" } })).basis).toMatch(/visual change/);
    });

    it("takes the worst of the five factors, each with its reason", () => {
        expect(severityOf(view({ attempts: [fail({ requests: [{ method: "POST", path: "/api/profile", status: 500, own: true }] })] })).factors.availability).toEqual({
            value: "high",
            reason: "a server error (5xx) or crash",
        });
        expect(severityOf(view({ priority: "critical", attempts: [fail({ error: "page crashed" })] })).severity).toBe("critical");
        expect(severityOf(view({ layer: "storedData" })).basis).toMatch(/^data integrity: the storedData layer/);
        expect(severityOf(view({ scope: { roles: 0, public: true } })).factors.scope.value).toBe("high");
        expect(severityOf(view({ scope: { roles: 1, public: false } })).factors.scope.value).toBe("medium");
        expect(severityOf(view({ security: { severity: "critical", category: "access-control", confidence: "low" } })).severity).toBe("critical");
        expect(severityOf(view({ origin: "access-check" })).factors.security.value).toBe("high");
        // Another origin's 5xx is not the application being down.
        expect(severityOf(view({ attempts: [fail({ requests: [{ method: "GET", path: "/cdn.js", status: 503, own: false }] })] })).factors.availability.value).toBe("none");
    });
});

describe("confidence", () => {
    it("is high only for a sourced, captured check reproduced at H5", () => {
        const c = confidenceScore(view());
        expect(c.confidence).toBe("high");
        expect(c.factors.reproduction.reason).toBe("the same failure in 3 of 3 attempts");
        expect(confidenceScore(view({ attempts: [fail(), fail({ outcome: "passed" }), fail({ outcome: "passed" })] })).confidence).toBe("low");
        expect(confidenceScore(view({ attempts: [fail()] })).factors.reproduction.value).toBe("medium");
        expect(confidenceScore(view({ expected: { text: "x", source: null, stated: "inferred" } })).confidence).toBe("low");
        expect(confidenceScore(view({ expected: { text: "x", source: "R-1", stated: "explicit", contradictedBy: "R-2" } })).basis).toBe("R-2 states otherwise");
        expect(confidenceScore(view({ independence: "not_on_clean_state" })).confidence).toBe("medium");
    });

    it("counts disagreeing Phase 4 layers as evidence, and caps an AI-chosen class at medium", () => {
        const described = view({ capture: "observed_only" });
        expect(confidenceScore(described).factors.evidence.value).toBe("low");
        expect(confidenceScore({ ...described, correlated: { disagreed: ["page", "api"] } }).factors.evidence.value).toBe("high");
        expect(confidenceScore({ ...described, correlated: { disagreed: ["api"] } }).factors.evidence.value).toBe("medium");
        expect(confidenceScore({ ...described, correlated: { disagreed: ["page", "api"] } }).factors.signals.value).toBe(2);
        const ai = confidenceScore(view(), { aiClass: true });
        expect(ai.confidence).toBe("medium");
        expect(ai.basis).toMatch(/AI's choice/);
    });

    it("moves independently of severity (fixture pairs)", () => {
        // Same evidence, worse impact: severity up, confidence unchanged.
        const [a, b] = [view(), view({ layer: "database", attempts: [fail({ requests: [{ method: "POST", path: "/api/p", status: 500, own: true }] }), fail(), fail()] })];
        expect(severityOf(b).severity).not.toBe(severityOf(a).severity);
        expect(confidenceScore(b).confidence).toBe(confidenceScore(a).confidence);
        // Same impact, weaker evidence: confidence down, severity unchanged.
        const c = view({ attempts: [fail(), fail({ outcome: "passed" }), fail({ outcome: "passed" })] });
        expect(confidenceScore(c).confidence).not.toBe(confidenceScore(a).confidence);
        expect(severityOf(c)).toEqual(severityOf(a));
    });
});

describe("label (V6)", () => {
    it("never says Confirmed below high confidence, in any state", () => {
        for (const state of FINDING_STATES)
            for (const confidence of ["low", "medium"] as const)
                for (const security of [false, true]) expect(label({ state, severity: "critical", confidence, security, reproduced: true })).not.toMatch(/Confirmed/);
        expect(label({ state: "confirmed", severity: "high", confidence: "high", security: false, reproduced: true })).toBe("Confirmed high bug");
        expect(label({ state: "confirmed", severity: "high", confidence: "medium", security: false, reproduced: true })).toBe("Possible high bug, needs review");
        expect(label({ state: "flaky", severity: "high", confidence: "high", security: false, reproduced: false })).toBe("Flaky");
    });

    it("never says confirmed critical or high for a security finding without H5 reproduction", () => {
        for (const severity of ["critical", "high"] as const)
            expect(label({ state: "confirmed", severity, confidence: "high", security: true, reproduced: false })).toBe(`Possible ${severity} security issue, needs review`);
        expect(label({ state: "confirmed", severity: "critical", confidence: "high", security: true, reproduced: true })).toBe("Confirmed critical security issue");
        expect(label({ state: "reported", severity: "medium", confidence: "high", security: true, reproduced: false })).toBe("Confirmed medium security issue");
    });
});
