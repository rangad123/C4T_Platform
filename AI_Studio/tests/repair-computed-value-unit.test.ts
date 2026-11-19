/**
 * Row 229 (1c): a failing check of a stated source is an app defect (repair-web-guard-unit), except when triage says the TEST is wrong
 * (its data or its expected result) and the check expects an amount or a record id that its stated source does not give. Then the value
 * is the test's own (row 227: WEB-060 hard-coded $664.99 from what the account's cart held, WEB-055 "Order ord-1023", C1e's WEB-028
 * $95.99): triage's verdict stands and the test is repaired like any other. Fast tier, no browser, no model.
 */
import { describe, expect, it, vi } from "vitest";

const authoring = vi.hoisted(() => ({ calls: 0, steps: [] as unknown[] }));
vi.mock("../src/engine/web/author.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/engine/web/author.js")>()),
    authorWebSpec: async () => {
        authoring.calls++;
        return { status: "complete", steps: authoring.steps, testData: {}, explanation: "re-written" };
    },
}));

import type { EngineContext } from "../src/engine/context.js";
import type { KnowledgeRule } from "../src/engine/planning/planner.js";
import { ScenarioSchema, type Step, type TestSpec } from "../src/engine/spec/schema.js";
import { statedSourceText } from "../src/engine/web/author.js";
import { repairWeb, unstatedComputedValue } from "../src/engine/validation/repair.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";

type Assert = Extract<Step, { action: "assert" }>;
const role = (r: string, value: string) => ({ by: "role" as const, role: r, value, exact: true });
const rule = (ref: string, description: string, expected = ""): KnowledgeRule => ({ ref, kind: "calculation" as KnowledgeRule["kind"], description, expected, explicitness: "explicit", status: "unverified", workflows: [] });
const TOTAL_RULE = rule("R-9ce8c0e32a7d", "The cart total is the subtotal minus the discount plus shipping");
const SHIPPING_RULE = rule("R-5ship", "Shipping costs $5.00 when the subtotal is below 50.00", "Shipping: $5.00");
const ORDER_RULE = rule("R-order", "After placing an order the confirmation page names the new order");

const open: Step = { action: "navigate", url: "/cart" } as Step;
const add: Step = { action: "click", locator: role("button", "Add to cart") } as Step;
const check = (s: Partial<Assert>): Assert => ({ action: "assert", check: "text", locator: role("status", "Total"), ...s }) as Assert;
const specWith = (c: Assert) => ({ testId: "WEB-060", title: "Cart total", kind: "web", steps: [open, add, c], expectedResults: ["The total follows the rule (source: R-9ce8c0e32a7d)"], testData: {} }) as unknown as TestSpec;

const scenario = ScenarioSchema.parse({ scenarioId: "S-060", title: "Cart total", description: "Cart total", category: "Cart", expectedResults: ["The total follows the rule (source: R-9ce8c0e32a7d)"] });
const ctxWith = (answer: object, events: Array<{ kind: string; data?: unknown }> = []) => ({ emit: (e: { kind: string }) => void events.push(e), llm: { object: async () => answer } }) as unknown as EngineContext;
const failedAt = (i: number) => ({ testId: "WEB-060", status: "failed", durationMs: 1, failedStepIndex: i, steps: [], artifacts: [], responses: [], error: "expected text" }) as ScriptRun;
const testData = { category: "test_data", fixable: true, reason: "The assertion hard-codes $664.99, but this cart's total is $17.50; the app computes it correctly" };
const repair = (ctx: EngineContext, c: Assert, rules: KnowledgeRule[], sc = scenario) =>
    repairWeb({ ctx, browser: {} as never, baseUrl: "http://shop.test", model: {} as never, scenario: sc, spec: specWith(c), run: failedAt(2), rules });

describe("unstatedComputedValue", () => {
    it("names an amount or a record id the check expects that the stated words do not give", () => {
        expect(unstatedComputedValue(check({ expected: "$664.99" }), TOTAL_RULE.description)).toBe("$664.99");
        expect(unstatedComputedValue(check({ check: "exactText", expected: "−$59.27" }), "10% off the subtotal")).toBe("$59.27");
        expect(unstatedComputedValue(check({ locator: role("heading", "Order"), expected: "Order ord-1023" }), ORDER_RULE.description)).toBe("ord-1023");
        // The text a visible check looks for is what it expects.
        expect(unstatedComputedValue(check({ check: "visible", locator: { by: "text", value: "$664.99" } as Assert["locator"] }), "the total")).toBe("$664.99");
        expect(unstatedComputedValue(check({ check: "visible", locator: { ...role("row", "Line"), filter: { hasText: "1,234.50" } } as Assert["locator"] }), "a line")).toBe("1,234.50");
    });

    it("is undefined when every amount and id is stated, however it is written, or the check expects none", () => {
        expect(unstatedComputedValue(check({ expected: "Shipping: $5.00" }), `${SHIPPING_RULE.description} ${SHIPPING_RULE.expected}`)).toBeUndefined();
        expect(unstatedComputedValue(check({ expected: "Free from $50" }), SHIPPING_RULE.description)).toBeUndefined();
        expect(unstatedComputedValue(check({ expected: "1234.50" }), "The limit is $1,234.50")).toBeUndefined();
        expect(unstatedComputedValue(check({ expected: "Order ord-1000 is Shipped" }), "Order ord-1000 is shown as Shipped")).toBeUndefined();
        expect(unstatedComputedValue(check({ expected: "Your cart is empty" }), "")).toBeUndefined();
        expect(unstatedComputedValue(check({ check: "count", expected: 3 as unknown as string }), "")).toBeUndefined();
        // A check that something is absent expects no value.
        expect(unstatedComputedValue(check({ check: "notText", expected: "$0.00" }), "")).toBeUndefined();
    });
});

describe("statedSourceText", () => {
    it("gives a rule's words, and for expected:<n> the expected result with the rules it cites or its objective names", () => {
        expect(statedSourceText("R-5ship", scenario, [SHIPPING_RULE])).toContain("$5.00");
        expect(statedSourceText("expected:1", { expectedResults: ["Shipping is charged (R-5ship)"] }, [SHIPPING_RULE, TOTAL_RULE])).toMatch(/Shipping is charged.*\$5\.00/);
        expect(statedSourceText("expected:1", { expectedResults: ["Shipping is charged"], objective: { id: "o", kind: "rule", source: "R-5ship" } as never }, [SHIPPING_RULE])).toContain("$5.00");
        expect(statedSourceText("expected:1", { expectedResults: ["The total follows the rule"] }, [SHIPPING_RULE])).not.toContain("$5.00");
        expect(statedSourceText("expected:2", scenario, [SHIPPING_RULE])).toBe("");
        expect(statedSourceText("R-unknown", scenario, [SHIPPING_RULE])).toBe("");
    });
});

describe("repairWeb: a test-fault triage on a computed value is kept (row 229, 1c)", () => {
    it("WEB-060: the check of a stated rule expects $664.99, which the rule does not give; triage says test_data: repaired, not an app defect", async () => {
        authoring.calls = 0;
        const c = check({ expected: "$664.99", source: "expected:1" });
        authoring.steps = specWith(c).steps;
        const events: Array<{ kind: string; data?: unknown }> = [];
        const r = await repair(ctxWith(testData, events), c, [TOTAL_RULE]);
        expect(r.verdict).toBe("fixed");
        expect(authoring.calls).toBe(1);
        expect(events.find((e) => e.kind === "computed_value_test_fault")).toMatchObject({ data: { testId: "WEB-060", source: "expected:1", category: "test_data" } });
        // A re-written test that changes the literal is still refused by the guard (never a finding either).
        authoring.steps = specWith({ ...c, expected: "$17.50" }).steps;
        expect((await repair(ctxWith(testData), c, [TOTAL_RULE])).verdict).toBe("unfixable");
    });

    it("WEB-055: a record id the rule does not give, with triage 'assertion': repaired", async () => {
        authoring.calls = 0;
        const c = check({ locator: role("heading", "Order"), expected: "Order ord-1023", source: "R-order" });
        authoring.steps = specWith(c).steps;
        const r = await repair(ctxWith({ category: "assertion", fixable: true, reason: "The order number depends on how many orders exist" }), c, [ORDER_RULE]);
        expect(r.verdict).toBe("fixed");
        expect(authoring.calls).toBe(1);
    });

    it("an amount the stated source gives stays an app defect: the expectation is the source's, not the test's", async () => {
        authoring.calls = 0;
        const c = check({ expected: "Shipping: $5.00", source: "R-5ship" });
        const r = await repair(ctxWith(testData), c, [SHIPPING_RULE]);
        expect(r.verdict).toBe("app_defect");
        expect(r.reason).toMatch(/a stated expectation is not met \(R-5ship\)/);
        expect(authoring.calls).toBe(0);
    });

    it("only a test-fault triage keeps its verdict: a locator or timing triage on the same computed value stays an app defect", async () => {
        authoring.calls = 0;
        const c = check({ expected: "$664.99", source: "expected:1" });
        for (const category of ["locator", "timing", "other"]) expect((await repair(ctxWith({ ...testData, category }), c, [TOTAL_RULE])).verdict).toBe("app_defect");
        expect(authoring.calls).toBe(0);
    });

    it("a check with no amount or id stays an app defect under a test_data triage", async () => {
        authoring.calls = 0;
        const c = check({ expected: "Discount applied", source: "R-9ce8c0e32a7d" });
        expect((await repair(ctxWith(testData), c, [TOTAL_RULE])).verdict).toBe("app_defect");
        expect(authoring.calls).toBe(0);
    });
});
