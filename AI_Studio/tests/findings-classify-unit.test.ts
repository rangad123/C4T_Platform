/**
 * Phase 5 F2: the deterministic classifier. Each of the 8 classes from its own attempts; mixed passes and failures = flaky; the test's
 * own step = automation; different causes, or too little evidence, leave it open with at least two classes. On the W0-1 corpus rows:
 * the 8 harness-confirmed seeds are application defects, a locator timeout is automation, an AI-judged detection without replays stays open.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify, FINDING_CLASSES, type FindingClass } from "../src/engine/findings/classify.js";
import { FindingViewSchema, type FindingView, type FindingViewInput } from "../src/engine/findings/view.js";

type AttemptIn = NonNullable<FindingViewInput["attempts"]>[number];
const fail = (o: Partial<AttemptIn> = {}): AttemptIn => ({ outcome: "failed", failedStep: 4, check: "value", target: "Delivery address", value: "1 Test Road", error: "Error: expect(locator).toHaveValue(expected) failed", ...o });
const pass: AttemptIn = { outcome: "passed" };

function view(attempts: AttemptIn[], extra: Partial<FindingViewInput> = {}): FindingView {
    return FindingViewSchema.parse({
        id: "f1",
        projectId: "p1",
        source: { kind: "execution", id: "t1" },
        state: "verification_pending",
        title: "Saved address is used at checkout",
        testId: "t1",
        detectedAt: "2026-11-21T10:00:00.000Z",
        expected: { text: "The saved address is pre-filled", source: "R-1", stated: "explicit" },
        observed: "The field was empty",
        steps: [],
        attempts,
        ...extra,
    });
}

const cases: Array<[FindingClass, FindingView]> = [
    ["app_defect", view([fail(), fail(), fail()])],
    ["app_defect", view([fail(), fail(), pass])],
    ["incorrect_expectation", view([fail(), fail(), fail()], { expected: { text: "x", source: null, stated: "inferred" } })],
    ["incorrect_expectation", view([fail(), fail(), fail()], { expected: { text: "x", source: "R-1", stated: "explicit", contradictedBy: "API doc: 404 for an unknown id" } })],
    ["unsupported", view([fail(), fail(), fail()], { expected: { text: "x", source: "R-1", stated: "explicit", unsupportedPer: "R-9 (bulk delete not offered)" } })],
    ["automation", view([fail({ stepFault: "The test needs fixing, not your application: Step 4 could not use its element." }), fail({ stepFault: "The test needs fixing…" })])],
    ["network", view([fail({ error: "page.goto: net::ERR_NAME_NOT_RESOLVED at http://shop.test/" }), fail({ error: "net::ERR_NAME_NOT_RESOLVED" }), pass])],
    ["infrastructure", view([{ outcome: "error", error: "The runner went away" }, { outcome: "error", error: "browser has been closed" }])],
    ["infrastructure", view([fail({ requests: [{ method: "GET", path: "/fonts.css", status: 503, own: false }] }), fail({ requests: [{ method: "GET", path: "/fonts.css", status: 503, own: false }] })])],
    ["environment", view([fail({ environment: "Could not sign in with the project's test account" }), fail({ error: "Error: could not sign in: the account was refused" })])],
    ["flaky", view([fail(), pass, pass])],
];

describe("classify", () => {
    it("decides each of the 8 classes from its own attempts", () => {
        for (const [want, v] of cases) {
            const c = classify(v);
            expect(c.class, c.reason).toBe(want);
            expect(c.candidates).toEqual([want]);
            expect(c.reason).toMatch(/\.$/);
        }
        expect(new Set(cases.map(([c]) => c))).toEqual(new Set(FINDING_CLASSES));
    });

    it("calls mixed attempts flaky, and two different failures without a pass open", () => {
        expect(classify(view([fail(), pass, fail({ failedStep: 7, target: "Total" })])).class).toBe("flaky");
        const c = classify(view([fail(), fail({ failedStep: 7, target: "Total" }), fail({ failedStep: 9, target: "Name" })]));
        expect(c.class).toBe("open");
        expect(c.candidates).toEqual(["app_defect", "flaky"]);
    });

    it("needs two thirds of the attempts for H5 (2 of 3, 4 of 5)", () => {
        expect(classify(view([fail(), fail(), pass, pass, pass])).class).toBe("flaky");
        expect(classify(view([fail(), fail(), fail(), fail(), pass])).class).toBe("app_defect");
        expect(classify(view([fail(), fail(), fail(), pass, pass])).class).toBe("flaky");
    });

    it("never decides a step fault as an application defect, even when the same step fails every time", () => {
        const c = classify(view([fail({ stepFault: "The test needs fixing." }), fail({ stepFault: "The test needs fixing." }), fail({ stepFault: "The test needs fixing." })]));
        expect(c.class).toBe("automation");
    });

    it("an application 5xx is about the application, not the infrastructure", () => {
        const own = { requests: [{ method: "POST", path: "/api/cart", status: 500, own: true }, { method: "GET", path: "/cdn.js", status: 502, own: false }] };
        expect(classify(view([fail(own), fail(own), fail(own)])).class).toBe("app_defect");
    });

    it("leaves open, listing at least two classes, when causes differ or nothing failed", () => {
        const mixed = classify(view([fail({ stepFault: "The test needs fixing." }), fail(), fail({ error: "net::ERR_CONNECTION_RESET" })]));
        expect(mixed.class).toBe("open");
        expect(mixed.candidates.sort()).toEqual(["app_defect", "automation", "network"]);
        for (const v of [view([]), view([pass, pass]), view([fail()])]) {
            const c = classify(v);
            expect(c.class).toBe("open");
            expect(c.candidates.length).toBeGreaterThanOrEqual(2);
        }
        expect(classify(view([fail(), pass, pass], { layer: "concurrency" })).candidates).toEqual(["app_defect", "flaky"]);
    });
});

describe("classify on the W0-1 corpus rows", () => {
    const corpus = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "p5-corpus-findings.json"), "utf8")) as Array<{
        truth: { category: string; seed: string | null };
        view: FindingViewInput;
    }>;
    const rows = corpus.map((r) => ({ ...r, v: FindingViewSchema.parse(r.view) }));

    it("decides every harness-confirmed seed as an application defect", () => {
        const confirmed = rows.filter((r) => r.truth.category === "confirmed");
        expect(confirmed).toHaveLength(8);
        for (const r of confirmed) expect(classify(r.v).class, r.v.id).toBe("app_defect");
    });

    it("decides a locator timeout as automation, and leaves open an AI-judged detection without replays and a described-only finding", () => {
        const timeouts = rows.filter((r) => /^TimeoutError: locator\./.test(r.v.attempts[0]?.error ?? ""));
        expect(timeouts.length).toBeGreaterThan(0);
        for (const r of timeouts) expect(classify(r.v).class, r.v.id).toBe("automation");
        const judged = rows.filter((r) => /^AI judgement/.test(r.v.attempts[0]?.error ?? ""));
        expect(judged.length).toBeGreaterThan(0);
        const described = rows.filter((r) => r.v.attempts.length > 0 && r.v.attempts.every((a) => a.outcome === "passed"));
        expect(described.length).toBeGreaterThan(0);
        for (const r of [...judged, ...described]) expect(classify(r.v).class, r.v.id).toBe("open");
    });
});
