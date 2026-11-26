/**
 * Test Case Generation, sheet items 31-33: every generated test case carries test data (valid, invalid, boundary; a value that cannot be
 * known is marked missing, never made up), numbered steps and the requirement it checks. The AI's answer schemas ask for all three, the
 * answer is read back without inventing anything, and a deterministic check after generation flags a case that lacks one of them.
 *
 *   npx vitest run -c vitest.fast.config.ts tests/tcg-case-checks-unit.test.ts
 */
import { describe, expect, it } from "vitest";
import { AnswerSchema, casesFromAnswer } from "../src/engine/manual/generate.js";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { PlanSchema, planScenarios } from "../src/engine/planning/planner.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { caseDataOf } from "../src/engine/spec/schema.js";
import { CASE_FLAGS, caseFlags, uncoveredRequirements } from "../src/platform/case-outcome.js";
import type { CaseOutcomeCase } from "../src/platform/case-outcome-types.js";

const req = { id: "r1", ref: "REQ-1", title: "Coupons", description: "A coupon takes 10% off", acceptanceCriteria: "Codes are 4 to 12 letters" };

function tc(over: Partial<CaseOutcomeCase> = {}): CaseOutcomeCase {
    return { id: "TC-001", title: "Apply a coupon", type: "automated", priority: "high", page: "/cart", preconditions: [], steps: [{ action: "Open the cart", expected: "The cart shows" }], expected: [], requirement: "REQ-1", testData: [], ...over };
}

describe("the AI is asked for test data, steps and the requirement (schemas)", () => {
    it("the requirements generator's answer has steps, test data (field, kind, value, missing) and the requirement", () => {
        const one = AnswerSchema.shape.cases.element;
        expect(Object.keys(one.shape)).toEqual(expect.arrayContaining(["requirement", "steps", "testData"]));
        const parsed = AnswerSchema.safeParse({ cases: [{ requirement: "REQ-1", title: "t", priority: "high", type: "automated", steps: [], testData: [{ field: "Coupon", kind: "valid", value: "", missing: true }] }] });
        expect(parsed.success).toBe(true);
        // A test data row needs all four parts, so "missing" is always said, never assumed.
        expect(AnswerSchema.safeParse({ cases: [{ requirement: "REQ-1", title: "t", priority: "high", type: "automated", steps: [], testData: [{ field: "Coupon", kind: "valid", value: "" }] }] }).success).toBe(false);
        expect(AnswerSchema.safeParse({ cases: [{ title: "t", priority: "high", type: "automated", steps: [] }] }).success).toBe(false);
    });

    it("the exploration planner's scenarios may carry written steps and test data", () => {
        const s = PlanSchema.shape.scenarios.element;
        const ok = s.safeParse({
            title: "t",
            description: "d",
            category: "Cart",
            expectedResults: ["The total drops by 10%"],
            caseSteps: [{ action: "Type the code", expected: "It is accepted" }],
            caseData: [{ field: "Coupon", kind: "boundary", value: "ABCD", missing: false }],
        });
        expect(ok.success).toBe(true);
        expect(ok.success && ok.data.caseSteps?.length).toBe(1);
        expect(ok.success && ok.data.caseData?.[0]?.kind).toBe("boundary");
    });
});

describe("reading the answer back invents nothing", () => {
    it("keeps steps on an automated case too, and test data as written, missing values left empty", () => {
        const [c] = casesFromAnswer(
            {
                cases: [
                    {
                        requirement: "req-1",
                        title: "Apply a real coupon",
                        priority: "high",
                        type: "automated",
                        steps: [{ action: "Type the coupon code", expected: "The discount shows" }],
                        testData: [
                            { field: "Coupon code", kind: "Valid", value: "", missing: true },
                            { field: "Coupon code", kind: "boundary", value: "ABCDEFGHIJKLM", missing: false },
                            { field: "Coupon code", kind: "invalid", value: "!!", missing: false },
                        ],
                    },
                ],
            },
            [req],
        );
        expect(c!.input.automation).toBe("automated");
        expect(c!.input.steps).toEqual([{ action: "Type the coupon code", expected: "The discount shows" }]);
        expect(c!.testData).toEqual([
            { field: "Coupon code", kind: "valid", value: "", missing: true },
            { field: "Coupon code", kind: "boundary", value: "ABCDEFGHIJKLM", missing: false },
            { field: "Coupon code", kind: "invalid", value: "!!", missing: false },
        ]);
        expect(c!.requirementId).toBe("r1");
    });

    it("drops a test data row with no field or an unknown kind, and never fills a value", () => {
        expect(caseDataOf([{ field: "", kind: "valid", value: "x", missing: false }, { field: "Email", kind: "random", value: "a@b.c", missing: false }, { field: "Email", kind: "valid", value: "", missing: false }, "junk", null])).toEqual([
            { field: "Email", kind: "valid", value: "", missing: false },
        ]);
        expect(caseDataOf(undefined)).toEqual([]);
    });
});

describe("the check after generation", () => {
    const refs = new Set(["REQ-1"]);
    it("passes a case with steps, a requirement and data that is filled or marked missing", () => {
        expect(caseFlags(tc({ testData: [{ field: "Coupon", kind: "valid", value: "", missing: true }, { field: "Coupon", kind: "invalid", value: "!!", missing: false }] }), refs)).toEqual([]);
    });

    it("flags a case without steps", () => {
        expect(caseFlags(tc({ steps: [] }), refs)).toEqual([CASE_FLAGS.noSteps]);
    });

    it("flags a case without a requirement link when the project has requirements, and not when it has none", () => {
        expect(caseFlags(tc({ requirement: "" }), refs)).toEqual([CASE_FLAGS.noRequirement]);
        expect(caseFlags(tc({ requirement: "" }), new Set())).toEqual([]);
    });

    it("flags data with no value that is not marked missing, and a missing value that was filled", () => {
        expect(caseFlags(tc({ testData: [{ field: "Account", kind: "valid", value: " ", missing: false }] }), refs)).toEqual([CASE_FLAGS.unmarked("Account")]);
        expect(caseFlags(tc({ testData: [{ field: "Coupon", kind: "valid", value: "SAVE10", missing: true }] }), refs)).toEqual([CASE_FLAGS.filledMissing("Coupon")]);
    });

    it("changes nothing in the case", () => {
        const c = tc({ steps: [], requirement: "" });
        const before = JSON.stringify(c);
        caseFlags(c, refs);
        expect(JSON.stringify(c)).toBe(before);
    });
});

describe("requirement coverage", () => {
    it("names the active requirements no case links to, matching references without regard to case and in lists", () => {
        const reqs = [
            { ref: "REQ-1", title: "Coupons" },
            { ref: "REQ-2", title: "Cart" },
            { ref: "REQ-3", title: "Refunds" },
        ];
        expect(uncoveredRequirements(reqs, [tc({ requirement: "req-1, REQ-2" })])).toEqual([{ ref: "REQ-3", title: "Refunds" }]);
        expect(uncoveredRequirements(reqs, [])).toEqual(reqs);
    });
});

describe("a plan-only exploration writes its scenarios as test cases (planner writtenCases)", () => {
    const model: AppModel = {
        url: "http://shop.test", origin: "http://shop.test", siteType: "ecommerce", purpose: "Shop", features: ["cart"],
        pages: [{ url: "http://shop.test/cart", path: "/cart", title: "Cart", type: "content", depth: 1, status: 200, headings: [], forms: [], components: [{ role: "button", name: "Apply", locatorHint: "" }], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] }],
        navigation: [], apis: [], journeys: [], externalDependencies: [], documentedTestCases: [], authentication: { required: false, mechanisms: [], loggedIn: false },
        stats: { pagesVisited: 1, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
    };
    const scenario = {
        title: "A coupon of 13 letters is refused", description: "d", category: "Cart", priority: "high", startPath: "/cart", expectedResults: ["The message “Codes are 4 to 12 letters” shows"], requirements: ["REQ-1"],
        caseSteps: [{ action: "Type ABCDEFGHIJKLM in Coupon", expected: "It is typed" }, { action: "Press Apply", expected: "The message shows" }],
        caseData: [{ field: "Coupon", kind: "boundary", value: "ABCDEFGHIJKLM", missing: false }, { field: "A real coupon", kind: "valid", value: "", missing: true }],
    };
    async function plan(writtenCases: boolean) {
        const calls: Array<{ prompt: string; maxOutputTokens?: number }> = [];
        const events: EngineEvent[] = [];
        const llm = {
            modelName: "scripted", model: {} as never, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "",
            object: (async (a: { prompt: string; maxOutputTokens?: number }) => {
                calls.push(a);
                return PlanSchema.parse({ scenarios: [scenario] });
            }) as LlmClient["object"],
        } as LlmClient;
        const ctx: EngineContext = { config: loadConfig({}), llm, emit: (e) => void events.push(e) };
        const out = await planScenarios(ctx, model, { maxScenarios: 5, hasCredentials: false, requirements: [{ id: "REQ-1", text: "Codes are 4 to 12 letters", kind: "functional" }], writtenCases });
        return { calls, events, out };
    }

    it("asks for numbered steps, valid, invalid and boundary data with missing values marked, and the requirement ids", async () => {
        const { calls } = await plan(true);
        expect(calls[0]!.prompt).toContain('"caseSteps"');
        expect(calls[0]!.prompt).toMatch(/valid, invalid or boundary/);
        expect(calls[0]!.prompt).toMatch(/set missing true and leave value empty: never make one up/);
        expect(calls[0]!.prompt).toMatch(/name in "requirements" the id of every requirement/);
    });

    it("keeps the written case on the scenario and says it in the scenario_planned event, so a stopped run keeps it", async () => {
        const { out, events } = await plan(true);
        expect(out[0]!.caseSteps).toEqual(scenario.caseSteps);
        expect(out[0]!.caseData).toEqual(scenario.caseData);
        const ev = events.find((e) => e.kind === "scenario_planned")!;
        expect(ev.data).toMatchObject({ steps: scenario.caseSteps, testData: scenario.caseData, requirement: "REQ-1" });
    });

    it("an ordinary exploration's prompt and events are unchanged", async () => {
        const { calls, events } = await plan(false);
        expect(calls[0]!.prompt).not.toContain('"caseSteps"');
        expect(events.find((e) => e.kind === "scenario_planned")!.data).toEqual({ scenarioId: "S-001", title: scenario.title });
    });
});
