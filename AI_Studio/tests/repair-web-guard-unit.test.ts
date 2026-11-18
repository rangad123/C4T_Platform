/**
 * A web repair fixes how a test checks, never what it must check (fast tier, no browser, no model):
 *   - weakensWebTest refuses a proposal that removes a sourced check, changes its source, loosens it (a weaker check, a widened or
 *     dropped expected value) or moves it before the step it depended on; an unsourced check may still change or go;
 *   - repairWeb refuses such a re-written test, and a failure *at* a check of a STATED source (author.ts statedSource: a usable rule
 *     given to the scenario, or an expected result tied to one, to an objective or to a requirement of the job) is a stated expectation
 *     not met (app_defect), never a re-authored test, even when triage calls it fixable. A check of the planner's own expected result is
 *     not stated: triage's verdict stands and a fixable failure is repaired (queue row 182, C1c's WEB-037).
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
import { repairWeb, weakensWebTest } from "../src/engine/validation/repair.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";

const role = (r: string, value: string) => ({ by: "role" as const, role: r, value, exact: true });
const open: Step = { action: "navigate", url: "/cart" } as Step;
const addItem: Step = { action: "click", locator: role("button", "Add to cart") } as Step;
const checkout: Step = { action: "click", locator: role("button", "Checkout") } as Step;
const total: Step = { action: "assert", check: "exactText", locator: role("status", "Total"), expected: "Total: 20.00", source: "R-1" } as Step;
const items: Step = { action: "assert", check: "count", locator: role("listitem", "Item"), expected: 2, source: "expected:1" } as Step;
const note: Step = { action: "assert", check: "text", locator: role("note", "Hint"), expected: "Free shipping" } as Step;
const original = { testId: "WEB-001", title: "Cart total", kind: "web", steps: [open, addItem, items, checkout, total, note], expectedResults: ["Two items"], testData: {} } as unknown as TestSpec;
const replace = (i: number, s: Step | undefined) => original.steps.flatMap((x, k) => (k === i ? (s ? [s] : []) : [x]));
const relocate = (s: Step, value: string) => ({ ...s, locator: role((s as { locator: { role: string } }).locator.role, value) }) as Step;

describe("weakensWebTest", () => {
    it("accepts the same test, a re-located sourced check, a stricter one, and any change to an unsourced check", () => {
        expect(weakensWebTest(original, original.steps)).toBeUndefined();
        expect(weakensWebTest(original, replace(4, relocate(total, "Order total")))).toBeUndefined();
        // A text check made exact is stricter, not looser.
        const looseOrig = { ...original, steps: replace(4, { ...total, check: "text", expected: "20.00" } as Step) } as TestSpec;
        expect(weakensWebTest(looseOrig, original.steps)).toBeUndefined();
        expect(weakensWebTest(original, replace(5, { ...note, check: "visible", expected: undefined } as Step))).toBeUndefined();
        expect(weakensWebTest(original, replace(5, undefined))).toBeUndefined();
        // Steps around the check may be re-authored (a fixed locator on the action it depends on).
        expect(weakensWebTest(original, replace(3, relocate(checkout, "Go to checkout")))).toBeUndefined();
    });

    it("refuses removing a sourced check", () => {
        expect(weakensWebTest(original, replace(4, undefined))).toMatch(/R-1.*removed/);
        expect(weakensWebTest(original, replace(2, undefined))).toMatch(/expected:1.*removed/);
    });

    it("refuses re-sourcing a sourced check, or dropping its source", () => {
        expect(weakensWebTest(original, replace(4, { ...total, source: "R-2" } as Step))).toMatch(/R-1.*source/);
        const { source: _s, ...unsourced } = total as Step & { source?: string };
        expect(weakensWebTest(original, replace(4, unsourced as Step))).toMatch(/R-1.*source/);
    });

    it("refuses loosening a sourced check: a weaker check, a widened or dropped expected value", () => {
        expect(weakensWebTest(original, replace(4, { ...total, check: "text" } as Step))).toMatch(/R-1.*loosened/);
        expect(weakensWebTest(original, replace(2, { ...items, check: "visible", expected: undefined } as Step))).toMatch(/expected:1.*loosened/);
        expect(weakensWebTest(original, replace(2, { ...items, expected: 1 } as Step))).toMatch(/expected:1.*loosened/);
        expect(weakensWebTest(original, replace(4, { ...total, expected: "Total" } as Step))).toMatch(/R-1.*loosened/);
        expect(weakensWebTest(original, replace(4, { ...total, expected: undefined } as Step))).toMatch(/R-1.*loosened.*dropped/);
        // A contains-check whose expected text shrinks matches more pages: widened.
        const textOrig = { ...original, steps: replace(4, { ...total, check: "text" } as Step) } as TestSpec;
        expect(weakensWebTest(textOrig, replace(4, { ...total, check: "text", expected: "20" } as Step))).toMatch(/R-1.*loosened/);
        // ...while a longer one is stricter.
        expect(weakensWebTest(textOrig, replace(4, { ...total, check: "text", expected: "Total: 20.00 EUR" } as Step))).toBeUndefined();
        // notText the other way round: a longer forbidden text matches fewer pages.
        const notOrig = { ...original, steps: replace(4, { ...total, check: "notText", expected: "Error" } as Step) } as TestSpec;
        expect(weakensWebTest(notOrig, replace(4, { ...total, check: "notText", expected: "Error 500" } as Step))).toMatch(/R-1.*loosened/);
        expect(weakensWebTest(notOrig, replace(4, { ...total, check: "notText", expected: "Err" } as Step))).toBeUndefined();
    });

    it("refuses moving a sourced check before the step it depended on", () => {
        // The total was checked after Checkout; now it is checked before.
        expect(weakensWebTest(original, [open, addItem, items, total, checkout, note])).toMatch(/R-1.*before/);
        // The item count was checked after adding the item.
        expect(weakensWebTest(original, [open, items, addItem, checkout, total, note])).toMatch(/expected:1.*before/);
    });
});

describe("repairWeb keeps sourced checks", () => {
    const scenario = ScenarioSchema.parse({ scenarioId: "S-001", title: "Cart", description: "Cart", category: "Cart", expectedResults: ["Two items"] });
    const fixable = { category: "assertion", fixable: true, reason: "The total reads differently" };
    const ctxWith = (answer: object, events: Array<{ kind: string }> = []) =>
        ({ emit: (e: { kind: string }) => void events.push(e), llm: { object: async () => answer } }) as unknown as EngineContext;
    const failedAt = (i: number) => ({ testId: "WEB-001", status: "failed", durationMs: 1, failedStepIndex: i, steps: [], artifacts: [], responses: [], error: "expected text" }) as ScriptRun;
    const RULE: KnowledgeRule = { ref: "R-1", kind: "constraint" as KnowledgeRule["kind"], description: "The total is the sum of the lines", expected: "Total: 20.00", explicitness: "explicit", status: "unverified", workflows: [] };
    // expected:1 is tied to the rule R-1 here, so it is stated too.
    const tied = { ...scenario, expectedResults: ["Two items (source: R-1)"] };
    const repair = (ctx: EngineContext, run: ScriptRun, extra: { scenario?: typeof scenario; rules?: KnowledgeRule[]; requirementIds?: string[]; spec?: TestSpec } = {}) =>
        repairWeb({ ctx, browser: {} as never, baseUrl: "http://shop.test", model: {} as never, scenario, spec: original, run, ...extra });

    it("a failure at a check of a stated source that triage calls fixable is an app defect, never a re-authored test", async () => {
        authoring.calls = 0;
        authoring.steps = original.steps;
        for (const i of [2, 4]) {
            const r = await repair(ctxWith(fixable), failedAt(i), { scenario: tied, rules: [RULE] });
            expect(r.verdict).toBe("app_defect");
            expect(r.reason).toMatch(/a stated expectation is not met/);
            expect(r.spec).toBeUndefined();
        }
        expect(authoring.calls).toBe(0);
    });

    it("a failure at an unsourced check or an action is still repaired", async () => {
        authoring.calls = 0;
        authoring.steps = replace(5, { ...note, expected: "Shipping" } as Step);
        expect((await repair(ctxWith(fixable), failedAt(5))).verdict).toBe("fixed");
        authoring.steps = replace(3, relocate(checkout, "Go to checkout"));
        expect((await repair(ctxWith({ ...fixable, category: "locator" }), failedAt(3))).verdict).toBe("fixed");
        expect(authoring.calls).toBe(2);
    });

    // C1c's WEB-037: a validation test whose check cites the planner's own expected result 1; the analyzer says the test's data is wrong.
    const field = role("textbox", "Quantity");
    const validation = {
        testId: "WEB-037", title: "Quantity is validated", kind: "web", expectedResults: ["An error says the quantity must be at most 99"], testData: {},
        steps: [{ action: "navigate", url: "/cart" }, { action: "fill", locator: field, value: "99" }, { action: "click", locator: role("button", "Update") }, { action: "assert", check: "text", locator: role("alert", "Error"), expected: "at most 99", source: "expected:1" }],
    } as unknown as TestSpec;
    const planned = ScenarioSchema.parse({ scenarioId: "S-037", title: "Quantity", description: "Quantity", category: "Cart", expectedResults: validation.expectedResults, requirements: ["REQ-9"] });
    const wrongData = { category: "test_data", fixable: true, reason: "99 is allowed; the test should enter 100 to see the error" };

    it("a failure at a check of the planner's own expected result is repaired when triage says the test data is wrong (WEB-037)", async () => {
        authoring.calls = 0;
        authoring.steps = validation.steps.map((s, i) => (i === 1 ? { ...s, value: "100" } : s));
        const r = await repair(ctxWith(wrongData), failedAt(3), { spec: validation, scenario: planned, rules: [RULE], requirementIds: ["REQ-9"] });
        expect(r.verdict).toBe("fixed");
        expect(authoring.calls).toBe(1);
        expect(r.spec?.steps[1]).toMatchObject({ action: "fill", value: "100" });
    });

    it("the same check is an app defect once its expected result is stated: by a rule's ref or a requirement of the job the scenario covers", async () => {
        authoring.calls = 0;
        const byRule = { ...planned, expectedResults: ["An error says the quantity must be at most 99 (R-1)"] };
        expect((await repair(ctxWith(wrongData), failedAt(3), { spec: validation, scenario: byRule, rules: [RULE] })).verdict).toBe("app_defect");
        const byRequirement = { ...planned, expectedResults: ["An error says the quantity must be at most 99 (REQ-9)"] };
        expect((await repair(ctxWith(wrongData), failedAt(3), { spec: validation, scenario: byRequirement, requirementIds: ["REQ-9"] })).verdict).toBe("app_defect");
        expect(authoring.calls).toBe(0);
        // Without the job's requirement ids (or the rule) it is the planner's own: repaired.
        authoring.steps = validation.steps;
        expect((await repair(ctxWith(wrongData), failedAt(3), { spec: validation, scenario: byRequirement })).verdict).toBe("fixed");
        expect((await repair(ctxWith(wrongData), failedAt(3), { spec: validation, scenario: byRule })).verdict).toBe("fixed");
    });

    it("a rule check names a rule only when that rule was given: R-1 without its rule is repaired", async () => {
        authoring.calls = 0;
        authoring.steps = original.steps;
        expect((await repair(ctxWith(fixable), failedAt(4))).verdict).toBe("fixed");
        expect((await repair(ctxWith(fixable), failedAt(4), { rules: [{ ...RULE, explicitness: "implicit" as KnowledgeRule["explicitness"] }] })).verdict).toBe("fixed");
        expect(authoring.calls).toBe(2);
    });

    it("a re-written test that weakens a sourced check is refused", async () => {
        const events: Array<{ kind: string }> = [];
        authoring.steps = replace(4, { ...total, check: "text", expected: "Total" } as Step);
        const r = await repair(ctxWith({ ...fixable, category: "locator" }, events), failedAt(3));
        expect(r.verdict).toBe("unfixable");
        expect(r.reason).toMatch(/proposed fix rejected/);
        expect(r.spec).toBeUndefined();
        expect(events.some((e) => e.kind === "repair_rejected")).toBe(true);
        authoring.steps = replace(2, undefined);
        expect((await repair(ctxWith({ ...fixable, category: "locator" }), failedAt(1))).verdict).toBe("unfixable");
    });
});
