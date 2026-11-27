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
import { testStepFault } from "../src/engine/validation/test-fault.js";

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

    it("never decides a state-bound failure as an application defect: it stays open until a fresh account reproduces it", () => {
        for (const independence of ["state_dependent", "not_on_clean_state"] as const) {
            const c = classify(view([fail(), fail(), fail()], { independence }));
            expect(c.class, independence).toBe("open");
            expect(c.candidates).toEqual(["app_defect", "environment", "automation"]);
            expect(c.reason).toMatch(/fresh account/);
        }
        expect(classify(view([fail(), fail(), fail()], { independence: "independent" })).class).toBe("app_defect");
        expect(classify(view([fail(), fail(), fail()], { independence: "not_run" })).class).toBe("app_defect");
        // A state-bound failure that is decided otherwise keeps that class.
        expect(classify(view([fail(), pass, pass], { independence: "state_dependent" })).class).toBe("flaky");
    });

    it("leaves a bare locator timeout with one attempt and no replay open between automation and an application defect", () => {
        const timeout = (verb: string) => fail({ error: `TimeoutError: locator.${verb}: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('#email')`, stepFault: "The test needs fixing, not your application: Step 4 could not use its element." });
        for (const verb of ["fill", "click"]) {
            const c = classify(view([timeout(verb)]));
            expect(c.class, verb).toBe("open");
            expect(c.candidates).toEqual(["automation", "app_defect"]);
        }
        // Replays that time out the same way, or an ambiguous element, are the test's own step.
        expect(classify(view([timeout("fill"), timeout("fill"), timeout("fill")])).class).toBe("automation");
        expect(classify(view([fail({ error: "Error: strict mode violation: getByLabel('Email') resolved to 2 elements", stepFault: "The test needs fixing." })])).class).toBe("automation");
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

    it("leaves open a single locator timeout, an AI-judged detection without replays and a described-only finding", () => {
        const timeouts = rows.filter((r) => /^TimeoutError: locator\./.test(r.v.attempts[0]?.error ?? ""));
        expect(timeouts.length).toBeGreaterThan(0);
        for (const r of timeouts) expect(classify(r.v).candidates, r.v.id).toEqual(["automation", "app_defect"]);
        const judged = rows.filter((r) => /^AI judgement/.test(r.v.attempts[0]?.error ?? ""));
        expect(judged.length).toBeGreaterThan(0);
        const described = rows.filter((r) => r.v.attempts.length > 0 && r.v.attempts.every((a) => a.outcome === "passed"));
        expect(described.length).toBeGreaterThan(0);
        for (const r of [...judged, ...described]) expect(classify(r.v).class, r.v.id).toBe("open");
    });

    // CP5-A examples (CP5A-RESULT.md observations 1 and 2).
    const byId = (id: string) => rows.find((r) => r.v.id.startsWith(id))!;
    it("keeps the state-bound replays of p3-m4-cand-1/01cd4c89 open, and a seed's lone locator timeout open (d1-haiku-p2)", () => {
        const stateBound = rows.filter((r) => r.v.independence === "state_dependent" || r.v.independence === "not_on_clean_state");
        expect(stateBound.map((r) => r.v.id)).toContain(byId("p3-m4-cand-1/01cd4c89").v.id);
        for (const r of stateBound) expect(classify(r.v).class, r.v.id).not.toBe("app_defect");
        for (const id of ["d1-haiku-p2/5491b0e3", "d1-haiku-p2/6ef7a5bf"]) {
            const r = byId(id);
            expect(r.truth.seed, id).toMatch(/^BS-/);
            expect(classify(r.v).candidates, id).toContain("app_defect");
        }
    });

    // CP5-A Observation 2: the same two seeds, with the call log the runner stores for each attempt. Playwright found the element but
    // the page would not let it be used: the application's state, never the test's own step, also when every attempt fails that way.
    it("does not call a seed's locator timeout automation when the call log shows the element was there (d1-haiku-p2 BS-06, BS-12)", () => {
        const logs: Record<string, string> = {
            "d1-haiku-p2/5491b0e3": "TimeoutError: locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByLabel('Name', { exact: true })\n    - locator resolved to <input id=\"name\" name=\"name\" readonly/>\n    - fill(\"Alice qawxzl 1\")\n  - attempting fill action\n    2 × waiting for element to be visible, enabled and editable\n      - element is not editable",
            "d1-haiku-p2/6ef7a5bf": "TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('link', { name: 'Check out' })\n    - locator resolved to <a href=\"/checkout\" aria-disabled=\"true\">Check out</a>\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is not enabled",
        };
        for (const [id, error] of Object.entries(logs)) {
            const r = byId(id);
            const run = { status: "failed" as const, error, steps: [{ index: 4, title: "Step", status: "failed" as const, error }] };
            expect(testStepFault(run), id).toBeUndefined();
            const attempt = { ...r.view.attempts![0]!, error, stepFault: testStepFault(run) };
            for (const n of [1, 2]) {
                const c = classify(FindingViewSchema.parse({ ...r.view, attempts: Array.from({ length: n }, () => attempt) }));
                expect(c.candidates, `${id} x${n}`).not.toContain("automation");
            }
            // The element never found stays the test's own step once replays agree.
            const missing = "TimeoutError: locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByLabel('Name', { exact: true })";
            expect(testStepFault({ ...run, error: missing, steps: [{ ...run.steps[0]!, error: missing }] }), id).toMatch(/^The test needs fixing/);
        }
    });

    it("still decides p3-m4-cand-1/d24222c6 as an application defect: the engine recorded it independent, so this rule does not reach it", () => {
        const r = byId("p3-m4-cand-1/d24222c6");
        expect(r.v.independence).toBe("independent");
        expect(classify(r.v).class).toBe("app_defect");
    });
});
