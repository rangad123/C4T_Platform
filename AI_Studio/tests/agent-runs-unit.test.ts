/**
 * Agent runs, the decisions with no browser: which actions need a person, and the final word on a run (a verdict needs a check behind it).
 */
import { describe, expect, it } from "vitest";
import { highImpactOf, type ElementFacts } from "../src/engine/agent/high-impact.js";
import { settleRun } from "../src/engine/agent/objective.js";

const button = (text: string, more: Partial<ElementFacts> = {}): ElementFacts => ({ tag: "button", text, ...more });

describe("what needs a person", () => {
    it("pauses deleting, paying, sending and submitting, by what the element says", () => {
        expect(highImpactOf({ action: "click", element: button("Delete account") })?.kind).toBe("delete");
        expect(highImpactOf({ action: "click", element: { tag: "div", ariaLabel: "Remove this user" } })?.kind).toBe("delete");
        expect(highImpactOf({ action: "click", element: button("Pay now") })?.kind).toBe("pay");
        expect(highImpactOf({ action: "click", element: button("Place your order") })?.kind).toBe("pay");
        expect(highImpactOf({ action: "click", element: button("Send message") })?.kind).toBe("send");
        expect(highImpactOf({ action: "click", element: button("Create an account") })?.kind).toBe("submit");
    });

    it("reads the element, so a harmless locator cannot hide what the button does", () => {
        expect(highImpactOf({ action: "click", locatorWords: "#go", element: button("Delete account") })?.kind).toBe("delete");
        expect(highImpactOf({ action: "click", locatorWords: "#delete-all" })?.kind).toBe("delete");
    });

    it("pauses a real form, by a button or by Enter, and leaves reading forms and signing in alone", () => {
        const form = { inForm: true, formMethod: "post" };
        expect(highImpactOf({ action: "click", element: button("Save", form) })?.kind).toBe("submit");
        expect(highImpactOf({ action: "press", key: "Enter", element: { tag: "input", ...form } })?.kind).toBe("submit");
        expect(highImpactOf({ action: "press", key: "Enter", element: { tag: "button", type: "submit", ...form } })?.kind).toBe("submit");
        expect(highImpactOf({ action: "click", element: button("Search", { inForm: true, formMethod: "get" }) })).toBeUndefined();
        expect(highImpactOf({ action: "click", element: button("Go", { inForm: true, formMethod: "post", formIsSearch: true }) })).toBeUndefined();
        expect(highImpactOf({ action: "click", element: button("Sign in", { ...form, formHasPassword: true }) })).toBeUndefined();
        expect(highImpactOf({ action: "click", element: button("Register", { ...form, formHasPassword: true }) })?.kind).toBe("submit");
        // A script may send the form from any button, so a type="button" in a real form pauses too (fail closed).
        expect(highImpactOf({ action: "click", element: button("Open", { type: "button", ...form }) })?.kind).toBe("submit");
    });

    it("pauses an address that deletes or pays, and leaves ordinary pages and keys alone", () => {
        expect(highImpactOf({ action: "navigate", url: "/account/delete?id=1" })?.kind).toBe("delete");
        expect(highImpactOf({ action: "navigate", url: "https://shop.example/checkout" })?.kind).toBe("pay");
        expect(highImpactOf({ action: "navigate", url: "/products" })).toBeUndefined();
        expect(highImpactOf({ action: "click", element: { tag: "a", text: "Details", href: "https://shop.example/items/remove/4" } })?.kind).toBe("delete");
        expect(highImpactOf({ action: "press", key: "Tab", element: button("Delete account") })).toBeUndefined();
        expect(highImpactOf({ action: "click", element: button("Add Blue Mug to cart") })).toBeUndefined();
    });

    it("lets the model add a pause, never remove one", () => {
        expect(highImpactOf({ action: "click", element: button("Next"), modelSaysHighImpact: true })?.kind).toBe("submit");
        expect(highImpactOf({ action: "click", element: button("Delete account"), modelSaysHighImpact: false })?.kind).toBe("delete");
    });
});

describe("the final word on a run", () => {
    const finish = (result: "passed" | "failed" | "blocked" | "inconclusive", category?: "application" | "environment" | "agent") => ({ kind: "finish" as const, result, explanation: "why", ...(category ? { category } : {}) });

    it("needs a check behind passed and failed", () => {
        expect(settleRun(finish("passed"), { passed: 1, failed: 3 })).toMatchObject({ verdict: "passed", state: "finished" });
        expect(settleRun(finish("passed"), { passed: 0, failed: 0 })).toMatchObject({ verdict: "inconclusive", failureCategory: "agent", reasoning: "why" });
        expect(settleRun(finish("failed"), { passed: 2, failed: 1 })).toMatchObject({ verdict: "failed", failureCategory: "application" });
        expect(settleRun(finish("failed"), { passed: 2, failed: 0 })).toMatchObject({ verdict: "inconclusive", failureCategory: "agent" });
    });

    it("names where the trouble lies", () => {
        expect(settleRun(finish("blocked", "environment"), { passed: 0, failed: 0 })).toMatchObject({ verdict: "blocked", failureCategory: "environment" });
        expect(settleRun(finish("blocked"), { passed: 0, failed: 0 })).toMatchObject({ verdict: "blocked", failureCategory: "agent" });
        expect(settleRun({ kind: "limit", why: "limit" }, { passed: 5, failed: 0 })).toMatchObject({ state: "stopped", verdict: "inconclusive", stopReason: "limit", failureCategory: "agent" });
        expect(settleRun({ kind: "stopped", why: "A person stopped this run." }, { passed: 5, failed: 0 })).toMatchObject({ state: "stopped", verdict: "inconclusive" });
        expect(settleRun({ kind: "stopped", why: "gone", category: "runner" }, { passed: 0, failed: 0 })).toMatchObject({ failureCategory: "runner" });
        expect(settleRun(undefined, { passed: 1, failed: 0 })).toMatchObject({ verdict: "inconclusive", failureCategory: "agent" });
    });
});
