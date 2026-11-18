/**
 * The coverage record of an exploration session (fast tier, pure): what the session exercised of the application model, counted from the
 * loop's action log and outcomes and from the saved tests, what it left out (unexplored items, highest priority first), and every operator
 * that did not run with the reason why (E9). The expected numbers below are counted by hand from the session built here.
 */
import { describe, expect, it } from "vitest";
import { coverageOf, pursuitKey, type CoverageInput } from "../src/engine/explore/coverage.js";
import type { ActionLogRow, ObjectiveOutcome } from "../src/engine/explore/loop.js";
import { objectivesFrom, type Objective } from "../src/engine/explore/objectives.js";
import type { KnowledgeRule, KnowledgeWorkflow } from "../src/engine/planning/planner.js";

const rule = (ref: string): KnowledgeRule => ({ ref, kind: "calculation", description: `Rule ${ref}`, expected: `Expected result of ${ref}`, explicitness: "explicit", workflows: [], status: "unverified" });

const steps = [
    { order: 0, action: "Open the cart", page: "P-cart" },
    { order: 1, action: "Check out", page: "P-cart", endpoint: "POST /api/orders" },
    { order: 2, action: "See the order", page: "P-order" },
];
const checkout: KnowledgeWorkflow = { id: "W-checkout", name: "Checkout", preconditions: [], postconditions: ["An order exists"], sourceType: "requirement", steps };

const model = {
    pages: [
        { id: "P-home", path: "/", elements: [{ role: "link", name: "Shop" }] },
        { id: "P-cart", path: "/cart", elements: [{ role: "button", name: "Checkout" }, { role: "button", name: "Remove" }], interactions: [{ control: "Checkout", method: "POST", path: "/api/orders" }] },
        { id: "P-order", path: "/orders/77", elements: [{ role: "button", name: "Cancel order" }] },
        { id: "P-admin", path: "/admin", elements: [{ role: "button", name: "Delete user" }] },
        { id: "P-register", path: "/register", elements: [{ role: "textbox", name: "Email" }], forms: [{ name: "register", fields: [{ name: "email", label: "Email", type: "email", required: true }] }] },
    ],
    workflows: [checkout],
    transitions: [
        { entity: "order", from: "pending", to: "paid", trigger: "Pay", sourceType: "requirement" as const, expectation: true, evidence: [{ ref: "REQ-9" }] },
        { entity: "order", from: "paid", to: "shipped", trigger: "", sourceType: "observed" as const, expectation: false, evidence: [{ ref: "/orders/1" }] },
    ],
    endpoints: [
        { method: "POST", path: "/api/orders" },
        { method: "GET", path: "/api/orders/{id}" },
        { method: "DELETE", path: "/api/users/{id}" },
    ],
};

const { objectives } = objectivesFrom(model, [rule("R-1"), rule("R-2"), rule("R-3")], [checkout], { maxObjectives: 50, budget: { steps: 30, minutes: 10, tokens: 300_000 } });
const find = (kind: Objective["kind"], ref: string) => {
    const o = objectives.find((x) => x.kind === kind && x.source.ref === ref);
    if (!o) throw new Error(`no ${kind} objective for ${ref}`);
    return o;
};
const W = find("workflow", "W-checkout");
const R1 = find("rule", "R-1");
const R2 = find("rule", "R-2");
const R3 = find("rule", "R-3");
const C = find("constraint", "P-register/register/email");
const T = find("transition", "transition:order:pending->paid");
const GAP = find("coverage-gap", "transition:order:paid->shipped");

let seq = 0;
const row = (objectiveId: string, state: string, action: string, result: ActionLogRow["result"] = "performed"): ActionLogRow => ({ seq: ++seq, objectiveId, state, action, atMs: seq * 10, result });
const outcome = (objectiveId: string, status: ObjectiveOutcome["status"], reason = "Pursued to the end.", actions = 1): ObjectiveOutcome => ({ objectiveId, status, reason, actions });

function session(): CoverageInput {
    const wAsStated = pursuitKey(W.id, "as_stated");
    const cInvalid = pursuitKey(C.id, "invalid_input");
    return {
        model,
        objectives,
        outcomes: [
            outcome(wAsStated, "completed"),
            outcome(R1.id, "completed"),
            outcome(cInvalid, "stopped", "The same action on the same state was tried again (fill Email); it is not repeated."),
            outcome(pursuitKey(C.id, "boundary_input"), "skipped", "The same objective was already done in this session or an earlier one.", 0),
            outcome(T.id, "environment_failure", "The browser closed."),
            outcome(pursuitKey(W.id, "repeat"), "not_reached", "The session stopped first: The session's limit of 40 actions was reached.", 0),
        ],
        actionLog: [
            row(wAsStated, "/cart|aaaaaaaaaaaaaaaa", "click button Checkout"),
            row(wAsStated, "/help|bbbbbbbbbbbbbbbb", "click link Back to shop"),
            row(R1.id, "/cart|aaaaaaaaaaaaaaaa", "click button Remove", "refused"),
            row(cInvalid, "/register|cccccccccccccccc", "fill Email"),
            row(T.id, "/orders/:id|dddddddddddddddd", "click button Cancel order", "refused"),
        ],
        tests: [
            {
                // No objective on it: R-2 is credited only through the check's source.
                steps: [
                    { action: "navigate", url: "http://shop.test/" },
                    { action: "request", method: "GET", path: "/api/orders/{{orderId}}" },
                    { action: "assert", source: "R-2" },
                ],
            },
        ],
        skipped: [
            { objectiveId: W.id, operator: "double_submit", reason: "not run: data changes off" },
            { objectiveId: R3.id, operator: "as_stated", reason: "needs a second account" },
        ],
    };
}

describe("coverageOf", () => {
    it("counts pages, elements, workflow steps, transitions, input classes, rules, endpoints and scenarios as in the hand count", () => {
        const c = coverageOf(session());
        // Visited: /cart and /register by performed actions, / by a saved test's navigate step; /orders/:id only by a refused action.
        expect([c.pages.total, c.pages.exercised]).toEqual([5, 3]);
        expect(c.pages.notExercised).toEqual(["/admin", "/orders/77"]);
        expect(c.pages.unknown).toEqual(["/help"]);
        expect(c.states).toBe(3);
        // Checkout (click on /cart) and Email (fill on /register); Remove was refused, Shop was never acted on.
        expect([c.elements.total, c.elements.exercised]).toEqual([6, 2]);
        // Steps 0 and 1 are on /cart, visited during the workflow's pursuit; step 2 is on /orders/77, never visited.
        expect([c.workflowSteps.total, c.workflowSteps.exercised]).toEqual([3, 2]);
        expect(c.workflowSteps.notExercised).toEqual(["W-checkout #2 See the order"]);
        // The stated transition failed (environment) and the coverage gap runs nothing.
        expect([c.transitions.total, c.transitions.exercised]).toEqual([2, 0]);
        // invalid_input ran; boundary_input was skipped.
        expect([c.inputClasses.total, c.inputClasses.exercised]).toEqual([2, 1]);
        expect(c.inputClasses.notExercised).toEqual(["P-register/register/email boundary_input"]);
        // R-1 by its pursuit, R-2 by a saved test's sourced check, R-3 needs a second account.
        expect([c.rules.total, c.rules.exercised]).toEqual([3, 2]);
        expect(c.rules.notExercised).toEqual(["R-3"]);
        // POST /api/orders by the Checkout click on /cart, GET /api/orders/{id} by the saved test's request.
        expect([c.endpoints.total, c.endpoints.exercised]).toEqual([3, 2]);
        expect(c.endpoints.notExercised).toEqual(["DELETE /api/users/{id}"]);
        // W as stated, R-1, C invalid_input, R-2 (saved test).
        expect(c.uniqueScenarios).toBe(4);
    });

    it("lists objectives nothing exercised, highest priority first, with their priority reason and what happened", () => {
        const c = coverageOf(session());
        expect(c.unexplored.map((u) => u.objectiveId).sort()).toEqual([R3.id, T.id, GAP.id].sort());
        const priorities = c.unexplored.map((u) => u.priority);
        expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
        expect(c.unexplored[c.unexplored.length - 1]!.objectiveId).toBe(GAP.id);
        const t = c.unexplored.find((u) => u.objectiveId === T.id)!;
        expect(t.reason).toBe(T.reason);
        expect(t.status).toContain("The browser closed.");
        expect(c.unexplored.find((u) => u.objectiveId === GAP.id)!.status).toMatch(/no source states/i);
    });

    it("lists every operator that did not run with its reason, including the skipped ones and history back (E9)", () => {
        const c = coverageOf(session());
        const reasonOf = (id: string, op: string) => c.notRun.find((n) => n.objectiveId === id && n.operator === op)?.reason;
        expect(reasonOf(W.id, "double_submit")).toBe("not run: data changes off");
        expect(reasonOf(R3.id, "as_stated")).toBe("needs a second account");
        expect(reasonOf(W.id, "repeat")).toMatch(/^not run: .*40 actions/);
        expect(reasonOf(W.id, "back")).toMatch(/^not run/);
        expect(reasonOf(C.id, "boundary_input")).toMatch(/^not run: .*already done/);
        expect(reasonOf(T.id, "as_stated")).toMatch(/^not finished: The browser closed\./);
        expect(c.notRun.find((n) => n.operator === "history_back")?.reason).toBe("history back not covered");
        // Every operator of every objective was either exercised or appears here with a reason.
        const ran = new Set([pursuitKey(W.id, "as_stated"), pursuitKey(C.id, "invalid_input"), ...R1.operators.map((op) => pursuitKey(R1.id, op)), ...R2.operators.map((op) => pursuitKey(R2.id, op))]);
        for (const o of objectives)
            for (const op of o.operators) {
                if (ran.has(pursuitKey(o.id, op))) continue;
                expect(reasonOf(o.id, op), `${o.kind} ${o.source.ref} ${op}`).toBeTruthy();
            }
        expect(c.notRun.filter((n) => ran.has(pursuitKey(n.objectiveId ?? "", n.operator)))).toEqual([]);
    });

    it("credits a workflow step only to its own workflow's pursuits, and an endpoint to an action on the control that calls it", () => {
        const pay = { id: "W-pay", name: "Pay", preconditions: [], postconditions: ["Paid"], sourceType: "requirement" as const, steps: [{ order: 0, action: "Pay", page: "P-cart" }] };
        const m = { pages: [{ id: "P-cart", path: "/cart", interactions: [{ control: "Pay now", method: "POST", path: "/api/pay" }] }], workflows: [pay], endpoints: [{ method: "post", path: "/api/pay" }] };
        const objs = objectivesFrom(m, [rule("R-9")], [pay], { maxObjectives: 10, budget: { steps: 30, minutes: 10, tokens: 300_000 } }).objectives;
        const r9 = objs.find((o) => o.kind === "rule")!;
        const c = coverageOf({ model: m, objectives: objs, outcomes: [outcome(r9.id, "completed")], actionLog: [row(r9.id, "/cart|eeeeeeeeeeeeeeee", "click button Pay now")] });
        expect([c.workflowSteps.total, c.workflowSteps.exercised]).toEqual([1, 0]);
        expect([c.endpoints.total, c.endpoints.exercised]).toEqual([1, 1]);
    });

    it("counts a rule pursued as stated and cited by a saved check's source as one scenario, not two", () => {
        const asStated = pursuitKey(R1.id, "as_stated");
        const c = coverageOf({
            model,
            objectives,
            outcomes: [outcome(asStated, "completed"), outcome(pursuitKey(C.id, "invalid_input"), "completed")],
            actionLog: [row(asStated, "/cart|aaaaaaaaaaaaaaaa", "click button Checkout")],
            tests: [{ objective: { id: R1.id, operator: "as_stated" }, steps: [{ action: "assert", source: "R-1" }] }],
        });
        // R-1 as stated and C invalid_input: the check citing R-1 is the same pursuit.
        expect(c.uniqueScenarios).toBe(2);
        expect([c.rules.total, c.rules.exercised]).toEqual([3, 1]);
        expect(c.unexplored.map((u) => u.objectiveId)).not.toContain(R1.id);
        expect(c.notRun.filter((n) => n.objectiveId === R1.id)).toEqual([]);
        // A check alone credits the rule's as-stated pursuit, the same key a pursuit of it would have.
        const checkOnly = coverageOf({ model, objectives, outcomes: [outcome(asStated, "completed")], actionLog: [], tests: [{ steps: [{ action: "assert", source: "R-1" }] }] });
        expect(checkOnly.uniqueScenarios).toBe(1);
        // An outcome for the whole objective next to a saved test of one of its operators is still one scenario.
        const bareAndTest = coverageOf({ model, objectives, outcomes: [outcome(R1.id, "completed")], actionLog: [], tests: [{ objective: { id: R1.id, operator: "as_stated" }, steps: [] }] });
        expect(bareAndTest.uniqueScenarios).toBe(1);
    });

    // Row 186: a pursuit whose test writer stopped before finishing exercised nothing of its objective; it is "not finished" with that reason.
    it("lists an objective whose test writer stopped as not finished, with that reason, and does not count it exercised", () => {
        const why = "The test writer stopped before finishing the test.";
        const c = coverageOf({ model: {}, objectives: [R1], outcomes: R1.operators.map((op) => outcome(pursuitKey(R1.id, op), "writer_stopped", why, 0)), actionLog: [] });
        expect([c.rules.total, c.rules.exercised]).toEqual([1, 0]);
        expect(c.uniqueScenarios).toBe(0);
        expect(c.unexplored.map((u) => [u.objectiveId, u.status])).toEqual([[R1.id, `not finished: ${why}`]]);
        for (const op of R1.operators) expect(c.notRun.find((n) => n.objectiveId === R1.id && n.operator === op)?.reason).toBe(`not finished: ${why}`);
    });

    it("keeps an explicitly skipped operator even when nothing else about the session is known", () => {
        const c = coverageOf({ model: {}, objectives: [W], outcomes: [], actionLog: [], skipped: [{ objectiveId: W.id, operator: "double_submit", reason: "not run: data changes off" }] });
        expect(c.notRun.filter((n) => n.operator === "double_submit")).toEqual([{ objectiveId: W.id, operator: "double_submit", reason: "not run: data changes off" }]);
        expect(c.unexplored.map((u) => u.objectiveId)).toEqual([W.id]);
    });

    it("does not depend on the order of its inputs and caps its lists with a count of the rest", () => {
        const s = session();
        const reversed: CoverageInput = { ...s, objectives: [...s.objectives].reverse(), outcomes: [...s.outcomes].reverse(), actionLog: [...s.actionLog].reverse(), skipped: [...(s.skipped ?? [])].reverse() };
        expect(coverageOf(reversed)).toEqual(coverageOf(s));

        const many = { pages: Array.from({ length: 150 }, (_, i) => ({ id: `P${i}`, path: `/p${String(i).padStart(3, "0")}` })) };
        const c = coverageOf({ model: many, objectives: [], outcomes: [], actionLog: [] });
        expect(c.pages.total).toBe(150);
        expect(c.pages.notExercised.length).toBe(100);
        expect(c.pages.more).toBe(50);
    });
});
