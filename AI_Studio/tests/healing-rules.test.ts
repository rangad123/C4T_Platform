/**
 * The rules of locator healing, with no browser: wording similarity, ranking, which failures may be healed at all, and how a
 * proposal changes a spec. (The same rules against a real page are exercised in healing.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { applyLocator } from "../src/engine/healing/apply.js";
import type { Candidate } from "../src/engine/healing/candidates.js";
import { eligibility, elementWasMissing, healableAssert } from "../src/engine/healing/failure.js";
import { locatorOptions } from "../src/engine/healing/heal.js";
import { confidenceLabel, cssTokens, describeLocator, rank, whyPicked } from "../src/engine/healing/rank.js";
import { nameSimilarity } from "../src/engine/healing/similarity.js";
import { TestSpecSchema, type Locator, type TestSpec } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";

const cand = (over: Partial<Candidate>): Candidate => ({
    key: 0, tag: "button", role: "button", name: "", text: "", ownsText: true, testId: null, label: null, placeholder: null, id: null, classes: [], nameAttr: null, type: null, container: "main", disabled: false, ...over,
});
const button = (name: string, key = 0, over: Partial<Candidate> = {}) => cand({ key, name, text: name, ...over });

describe("wording similarity", () => {
    it("treats synonyms and spelling variants as the same thing", () => {
        expect(nameSimilarity("Add to cart", "Add to basket")).toMatchObject({ kind: "synonym" });
        expect(nameSimilarity("Add to cart", "Add to basket").score).toBeGreaterThanOrEqual(0.9);
        expect(nameSimilarity("Sign in", "Log in").score).toBeGreaterThanOrEqual(0.9);
        expect(nameSimilarity("Check out", "Checkout").score).toBeGreaterThanOrEqual(0.9);
        expect(nameSimilarity("Add to cart", "add to cart!")).toEqual({ score: 1, kind: "same" });
        expect(nameSimilarity("Submit", "Submitt").score).toBeGreaterThanOrEqual(0.85);
        expect(nameSimilarity("addToCart", "add-to-basket").score).toBeGreaterThanOrEqual(0.9);
    });

    it("never treats opposites, negations or different numbers as alike", () => {
        expect(nameSimilarity("Add to cart", "Remove from cart").score).toBe(0);
        expect(nameSimilarity("Sign in", "Sign out").score).toBe(0);
        expect(nameSimilarity("Sign in", "Sign up").score).toBe(0);
        expect(nameSimilarity("Accept", "Decline").score).toBe(0);
        expect(nameSimilarity("Save", "Do not save").score).toBe(0);
        expect(nameSimilarity("Add item 1", "Add item 2").score).toBe(0);
        expect(nameSimilarity("Enable alerts", "Disable alerts").score).toBe(0);
    });

    it("scores unrelated or partly overlapping names below the proposal threshold", () => {
        expect(nameSimilarity("Add to cart", "Add to wishlist").score).toBeLessThan(0.75);
        expect(nameSimilarity("Save", "Save and continue").score).toBeLessThan(0.75);
        expect(nameSimilarity("Pay", "Cancel").score).toBe(0);
        expect(nameSimilarity("Pay now", "Pay later").score).toBeLessThan(0.75);
        expect(nameSimilarity("Delete account", "Delete all accounts").score).toBeLessThan(0.75);
        expect(nameSimilarity("", "Cancel").score).toBe(0);
    });
});

describe("ranking candidates", () => {
    const old: Locator = { by: "role", role: "button", value: "Add to cart", exact: true };

    it("proposes the one button whose name means the same", () => {
        const r = rank(old, "click", [button("Add to basket", 1), button("Add to wishlist", 2), button("Checkout", 3), cand({ key: 4, role: "link", name: "Add to basket", tag: "a" })]);
        expect(r.status).toBe("unique");
        if (r.status !== "unique") return;
        expect(r.best.cand.key).toBe(1);
        expect(confidenceLabel(r.best.score)).toBe("high");
        expect(whyPicked(old, r.best)).toBe("The “Add to cart” button is no longer on the page. The only close match is the button “Add to basket”, which means the same thing.");
    });

    it("refuses to guess between two equally good buttons", () => {
        const r = rank(old, "click", [button("Add to basket", 1), button("Add to basket", 2), button("Checkout", 3)]);
        expect(r.status).toBe("ambiguous");
    });

    it("finds nothing when only opposites or unrelated controls exist", () => {
        expect(rank(old, "click", [button("Remove from cart", 1), button("Checkout", 2)]).status).toBe("none");
        expect(rank({ by: "role", role: "button", value: "Add to cart" }, "click", []).status).toBe("none");
    });

    it("does not guess from a role locator that has no name, and keeps to the action's kind of element", () => {
        expect(rank({ by: "role", role: "button" }, "click", [button("Anything", 1)]).status).toBe("none");
        const field = cand({ key: 1, tag: "input", role: "textbox", name: "E-mail address", label: "E-mail address", type: "email" });
        expect(rank({ by: "label", value: "Email address" }, "fill", [field, button("Email address", 2)]).status).toBe("unique");
        // a fill step cannot mean a button, even if it is named alike
        expect(rank({ by: "label", value: "Email address" }, "fill", [button("Email address", 2)]).status).toBe("none");
    });

    it("matches by test id, label, placeholder, text and css attributes", () => {
        expect(rank({ by: "testId", value: "add-to-cart" }, "click", [button("x", 1, { testId: "add-to-basket" }), button("y", 2, { testId: "checkout" })]).status).toBe("unique");
        expect(rank({ by: "placeholder", value: "Search products" }, "fill", [cand({ key: 1, tag: "input", role: "searchbox", placeholder: "Search items" }), cand({ key: 2, tag: "input", role: "textbox", placeholder: "Your name" })]).status).toBe("none");
        expect(rank({ by: "placeholder", value: "Search products" }, "fill", [cand({ key: 1, tag: "input", role: "searchbox", placeholder: "Search products..." })]).status).toBe("unique");
        expect(rank({ by: "text", value: "Order summary" }, "click", [cand({ key: 1, tag: "span", role: null, text: "Order summary" }), cand({ key: 2, tag: "div", role: null, text: "Order summary", ownsText: false })]).status).toBe("unique");
        expect(cssTokens("#cart .btn-add-to-cart")).toEqual({ tag: undefined, words: ["btn-add-to-cart"] });
        expect(rank({ by: "css", value: "button.add-to-cart" }, "click", [button("Buy", 1, { classes: ["add-to-basket"] }), button("Pay", 2, { classes: ["pay"] })]).status).toBe("unique");
    });

    it("describes locators in plain words", () => {
        expect(describeLocator(old)).toBe("the “Add to cart” button");
        expect(describeLocator({ by: "label", value: "Email" })).toBe("the “Email” field");
        expect(describeLocator({ by: "testId", value: "buy" })).toBe("the element marked “buy”");
    });
});

describe("which failures may be healed", () => {
    const spec = (over: Partial<TestSpec> = {}, steps: unknown[] = [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } }]): TestSpec =>
        TestSpecSchema.parse({ testId: "WEB-001", title: "Add an item", kind: "web", steps, source: { origin: "imported" }, ...over });
    const run = (error: string, index = 1): ScriptRun => ({ testId: "WEB-001", status: "failed", durationMs: 1, failedStepIndex: index, steps: [{ index, title: "x", status: "failed", error }], artifacts: [], responses: [] });
    const MISSING = "locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Add to cart' })";

    it("recognises a missing element, and nothing else", () => {
        expect(elementWasMissing(MISSING)).toBe(true);
        expect(elementWasMissing("Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button')\nReceived: <element(s) not found>")).toBe(true);
        // found but not usable: renaming is not the problem
        expect(elementWasMissing(`${MISSING}\n  - locator resolved to <button disabled>Add to cart</button>\n  - element is not enabled`)).toBe(false);
        expect(elementWasMissing("Error: strict mode violation: getByRole('button') resolved to 2 elements")).toBe(false);
        expect(elementWasMissing("Error: expect(locator).toContainText(expected) failed\nExpected substring: \"Cart: 1\"\nReceived string: \"Cart: 0 items\"")).toBe(false);
        expect(elementWasMissing(undefined)).toBe(false);
    });

    it("accepts a click on a missing element in a journey test", () => {
        const r = eligibility(spec(), run(MISSING));
        expect(r.ok).toBe(true);
    });

    it("never heals the built-in check families, non-web tests or non-locator failures", () => {
        for (const origin of ["health-check", "security-check", "a11y-audit", "performance-check", "input-check", "access-check", "visual-baseline"] as const) {
            expect(eligibility(spec({ source: { origin } }), run(MISSING)).ok, origin).toBe(false);
        }
        expect(eligibility(spec({ type: "security" }), run(MISSING)).ok).toBe(false);
        expect(eligibility(spec(), run("Error: expect(locator).toContainText() failed\nReceived string: \"x\"")).ok).toBe(false);
        expect(eligibility(spec(), { ...run(MISSING), failedStepIndex: -1 }).ok).toBe(false);
        // the step that failed is a navigation: no locator to repair
        expect(eligibility(spec(), run(MISSING, 0)).ok).toBe(false);
        // a step that picks one of several matches by position is not a renamed control
        const nth = spec({}, [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "role", role: "button", value: "Add", nth: 1 } }]);
        expect(eligibility(nth, run(MISSING)).ok).toBe(false);
    });

    it("heals an assertion only when it is about a control's state; what a page says is the claim", () => {
        const assertStep = (check: string, locator: Locator, expected?: string) => spec({}, [{ action: "navigate", url: "/" }, { action: "assert", check, locator, expected }]);
        const miss = "Error: expect(locator).toBeVisible() failed\nReceived: <element(s) not found>";
        expect(eligibility(assertStep("visible", { by: "role", role: "button", value: "Add to cart" }), run(miss)).ok).toBe(true);
        expect(eligibility(assertStep("visible", { by: "role", role: "heading", value: "Welcome back" }), run(miss)).ok).toBe(false);
        expect(eligibility(assertStep("visible", { by: "text", value: "Order confirmed" }), run(miss)).ok).toBe(false);
        expect(eligibility(assertStep("count", { by: "role", role: "button", value: "Add" }, "3"), run(miss)).ok).toBe(false);
        expect(healableAssert({ action: "assert", check: "url", description: "", expected: "/done" })).toMatch(/not about finding an element/);
    });
});

describe("applying a proposal", () => {
    const spec = TestSpecSchema.parse({
        testId: "WEB-001", title: "Add an item", kind: "web",
        steps: [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "role", role: "button", value: "Add to cart", exact: true } }, { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected: "Cart: 1 item" }],
    });
    const oldLocator: Locator = { by: "role", role: "button", value: "Add to cart", exact: true };
    const newLocator: Locator = { by: "role", role: "button", value: "Add to basket", exact: true };

    it("changes only the locator of that step", () => {
        const r = applyLocator(spec, 1, oldLocator, newLocator);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.spec.steps[1]).toEqual({ ...spec.steps[1], locator: newLocator });
        expect(r.spec.steps[2]).toEqual(spec.steps[2]);
        expect(r.spec.steps[0]).toEqual(spec.steps[0]);
        // the original object is untouched
        expect((spec.steps[1] as { locator: Locator }).locator).toEqual(oldLocator);
    });

    it("refuses a stale proposal", () => {
        expect(applyLocator(spec, 1, { ...oldLocator, value: "Buy" }, newLocator)).toMatchObject({ ok: false });
        expect(applyLocator(spec, 0, oldLocator, newLocator)).toMatchObject({ ok: false });
        expect(applyLocator(spec, 9, oldLocator, newLocator)).toMatchObject({ ok: false });
    });

    it("describes a candidate by the same kind of locator, falling back to a test id", () => {
        const c = button("Add to basket", 5, { testId: "add" });
        expect(locatorOptions({ by: "role", role: "button", value: "Add to cart" }, c)).toEqual([{ by: "role", role: "button", value: "Add to basket", exact: true }, { by: "testId", value: "add" }]);
        expect(locatorOptions({ by: "css", value: "#add" }, c)[0]).toEqual({ by: "testId", value: "add" });
        // a name that looks like a runtime placeholder is never turned into a locator
        expect(locatorOptions({ by: "role", role: "button", value: "x" }, button("{{unique}}", 1))).toEqual([]);
    });
});
