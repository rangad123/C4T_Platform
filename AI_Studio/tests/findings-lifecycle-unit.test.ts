/**
 * Phase 5 F1: the finding lifecycle and the finding view. The owner's path (Detected → Candidate → Verification pending → Reproduced →
 * Confirmed or Unconfirmed → Classified → Reported) and side states (Duplicate, Flaky, Environment issue, Automation issue, Needs manual
 * review, plus a person's Not a bug): every move in the table is allowed for its actor, every other is refused with a sentence; a reason
 * is required for Unconfirmed, Not a bug and Duplicate; a failure that is the test's own step never becomes a Candidate; the engine
 * confirms only at high confidence. The view parses Phase 3 rows (the W0-1 corpus) and Phase 4–shaped rows, and refuses unknown fields.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkTransition, FINDING_STATES, moversOf, type Actor, type FindingState } from "../src/engine/findings/lifecycle.js";
import { FindingViewSchema, type FindingViewInput } from "../src/engine/findings/view.js";

/** The table as the spec states it: `from>to` → who may. Duplicate (both) and Not a bug (person) from every open state are added below. */
const TABLE: Record<string, "E" | "P" | "EP"> = {
    "detected>candidate": "E",
    "detected>automation_issue": "E",
    "detected>environment_issue": "E",
    "detected>needs_manual_review": "E",
    "candidate>verification_pending": "E",
    "candidate>needs_manual_review": "EP",
    "verification_pending>reproduced": "E",
    "verification_pending>unconfirmed": "E",
    "verification_pending>flaky": "E",
    "verification_pending>automation_issue": "E",
    "verification_pending>environment_issue": "E",
    "verification_pending>needs_manual_review": "E",
    "reproduced>confirmed": "EP",
    "reproduced>unconfirmed": "EP",
    "reproduced>needs_manual_review": "E",
    "confirmed>classified": "EP",
    "confirmed>needs_manual_review": "P",
    "unconfirmed>verification_pending": "EP",
    "unconfirmed>flaky": "E",
    "unconfirmed>automation_issue": "E",
    "unconfirmed>environment_issue": "E",
    "unconfirmed>needs_manual_review": "EP",
    "unconfirmed>confirmed": "P",
    "classified>reported": "EP",
    "flaky>verification_pending": "EP",
    "flaky>needs_manual_review": "P",
    "flaky>confirmed": "P",
    "environment_issue>verification_pending": "EP",
    "environment_issue>needs_manual_review": "P",
    "environment_issue>confirmed": "P",
    "automation_issue>verification_pending": "EP",
    "automation_issue>needs_manual_review": "P",
    "automation_issue>confirmed": "P",
    "needs_manual_review>verification_pending": "EP",
    "needs_manual_review>confirmed": "P",
    "needs_manual_review>unconfirmed": "P",
    "duplicate>candidate": "P",
    "not_a_bug>candidate": "P",
    "confirmed>accepted_risk": "P",
    "classified>accepted_risk": "P",
    "reported>accepted_risk": "P",
    "fixed>verification_pending": "EP",
    // Phase 6 X1: only the engine, after the finding's test passed on the fixed build (regression-service.ts).
    "confirmed>fixed": "E",
    "classified>fixed": "E",
    "reported>fixed": "E",
    "needs_manual_review>fixed": "E",
    "accepted_risk>verification_pending": "P",
};
for (const s of FINDING_STATES) {
    if (s === "duplicate" || s === "not_a_bug" || s === "fixed" || s === "accepted_risk") continue;
    TABLE[`${s}>duplicate`] = s === "reported" ? "P" : "EP";
    TABLE[`${s}>not_a_bug`] = "P";
}

const ok = { reason: "checked by hand", confidence: "high" as const };

describe("lifecycle table", () => {
    it("allows every move in the table for its actor and refuses every other move with a sentence", () => {
        const allowed: string[] = [];
        for (const from of FINDING_STATES)
            for (const to of FINDING_STATES)
                for (const by of ["engine", "person"] as Actor[]) {
                    const refusal = checkTransition({ from, to, by, ...ok });
                    const expected = (TABLE[`${from}>${to}`] ?? "").includes(by === "engine" ? "E" : "P");
                    if (expected) allowed.push(`${from}>${to}:${by}`);
                    expect(refusal === undefined, `${from} → ${to} by ${by}: ${refusal}`).toBe(expected);
                    if (refusal !== undefined) expect(refusal).toMatch(/^[A-Z].*\.$/);
                }
        expect(allowed).toContain("detected>candidate:engine");
        expect(allowed.length).toBeGreaterThan(60);
    });

    it("walks the owner's path by the engine", () => {
        const path: FindingState[] = ["detected", "candidate", "verification_pending", "reproduced", "confirmed", "classified", "reported"];
        for (let i = 1; i < path.length; i++) expect(checkTransition({ from: path[i - 1]!, to: path[i]!, by: "engine", confidence: "high" })).toBeUndefined();
    });

    it("never lets the engine reopen what a person closed, nor skip verification", () => {
        expect(checkTransition({ from: "not_a_bug", to: "candidate", by: "engine" })).toMatch(/Only a person/);
        expect(checkTransition({ from: "duplicate", to: "candidate", by: "engine" })).toMatch(/Only a person/);
        expect(checkTransition({ from: "candidate", to: "confirmed", by: "engine", confidence: "high" })).toMatch(/cannot move from Candidate to Confirmed/);
        expect(checkTransition({ from: "unconfirmed", to: "classified", by: "person" })).toMatch(/cannot move/);
        expect(moversOf("reported", "classified")).toEqual([]);
        // Only the engine (the regression service) moves a finding to Fixed, and only a bug someone stands behind; nobody accepts a risk that is not confirmed.
        for (const from of FINDING_STATES) expect(moversOf(from, "fixed"), from).toEqual(["confirmed", "classified", "reported", "needs_manual_review"].includes(from) ? ["engine"] : []);
        expect(checkTransition({ from: "unconfirmed", to: "accepted_risk", by: "person", reason: "low impact" })).toMatch(/cannot move from Unconfirmed to Accepted risk/);
    });

    it("requires a reason for Unconfirmed, Not a bug, Duplicate and Accepted risk", () => {
        for (const [from, to, by] of [
            ["confirmed", "accepted_risk", "person"],
            ["verification_pending", "unconfirmed", "engine"],
            ["reproduced", "not_a_bug", "person"],
            ["candidate", "duplicate", "engine"],
        ] as const) {
            expect(checkTransition({ from, to, by, reason: "  " })).toMatch(/add a reason/);
            expect(checkTransition({ from, to, by, reason: "Same endpoint and check as fg_1." })).toBeUndefined();
        }
        expect(checkTransition({ from: "verification_pending", to: "flaky", by: "engine" })).toBeUndefined();
    });

    it("keeps a failure that is the test's own step out of the defect path", () => {
        const stepFault = "The test needs fixing, not your application: Step 3 (Click Save) could not use its element.";
        expect(checkTransition({ from: "detected", to: "candidate", by: "engine", stepFault })).toMatch(/test's own step.*cannot become Candidate/);
        expect(checkTransition({ from: "not_a_bug", to: "candidate", by: "person", stepFault })).toMatch(/cannot become Candidate/);
        expect(checkTransition({ from: "automation_issue", to: "verification_pending", by: "engine", stepFault })).toMatch(/cannot become Verification pending/);
        expect(checkTransition({ from: "detected", to: "automation_issue", by: "engine", stepFault })).toBeUndefined();
        // A person may still confirm what they checked by hand.
        expect(checkTransition({ from: "automation_issue", to: "confirmed", by: "person", stepFault })).toBeUndefined();
    });

    it("lets the engine confirm only at high confidence; a person at any", () => {
        expect(checkTransition({ from: "reproduced", to: "confirmed", by: "engine", confidence: "medium" })).toMatch(/only at high confidence; this finding is medium/);
        expect(checkTransition({ from: "reproduced", to: "confirmed", by: "engine" })).toMatch(/not scored/);
        expect(checkTransition({ from: "reproduced", to: "confirmed", by: "person", confidence: "low" })).toBeUndefined();
    });
});

const corpus = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "p5-corpus-findings.json"), "utf8")) as Array<{ view: FindingViewInput }>;

const phase4: FindingViewInput = {
    id: "f-layer-1",
    projectId: "p1",
    source: { kind: "layer", id: "t-api-9" },
    state: "detected",
    title: "Order total shown differs from the API",
    testId: "t-api-9",
    detectedAt: "2026-11-21T10:00:00.000Z",
    expected: { text: "The order total equals the API's total", source: "R-12", stated: "explicit" },
    observed: "Page shows $10.00, GET /api/orders/7 answered total 12.00",
    steps: [{ action: "navigate", url: "/orders/7" }, { action: "assertResponse", target: "/api/orders/:id" }],
    attempts: [{ outcome: "failed", failedStep: 2, check: "relation", target: "total", requests: [{ method: "GET", path: "/api/orders/:id", status: 200, own: true }] }],
    layer: "storedData",
    origin: "network",
    correlated: { disagreed: ["page", "api"] },
};

describe("finding view", () => {
    it("parses the W0-1 corpus rows (Phase 3 shape) and a Phase 4–shaped row", () => {
        expect(corpus.length).toBeGreaterThan(20);
        for (const r of corpus) expect(FindingViewSchema.safeParse(r.view).success, r.view.id).toBe(true);
        const v = FindingViewSchema.parse(phase4);
        expect(v.correlated?.disagreed).toEqual(["page", "api"]);
        expect(v.requirements).toEqual([]);
        expect(v.attempts[0]!.stack).toEqual([]);
    });

    it("parses a security finding with its own state", () => {
        const v = FindingViewSchema.parse({
            ...phase4,
            id: "sec-1",
            source: { kind: "security", id: "sf-1" },
            sourceState: "probable",
            state: "needs_manual_review",
            attempts: [],
            security: { severity: "high", category: "access-control", confidence: "medium" },
        });
        expect(v.source.kind).toBe("security");
    });

    it("refuses unknown fields and unknown states, and redacts free text", () => {
        expect(FindingViewSchema.safeParse({ ...phase4, extra: 1 }).success).toBe(false);
        expect(FindingViewSchema.safeParse({ ...phase4, state: "solved" }).success).toBe(false);
        expect(FindingViewSchema.safeParse({ ...phase4, source: { kind: "crawler", id: "x" } }).success).toBe(false);
        const v = FindingViewSchema.parse({ ...phase4, observed: "Header was Authorization: Bearer abcdef0123456789xyz" });
        expect(v.observed).not.toContain("abcdef0123456789xyz");
    });
});
