/**
 * Plain-English authoring, the parts that need no browser and no model: what is refused, web or API, title / expected results,
 * how a model's API plan becomes steps (and what it can never become), and the "passed but checks almost nothing" verdict.
 */
import { describe, expect, it } from "vitest";
import { buildApiSteps, operationList, type ApiPlan } from "../src/engine/authoring/api.js";
import { detectKind, expectedOf, namesPath, refusalFor, scenarioFor, startPathOf, titleOf } from "../src/engine/authoring/describe.js";
import { finalVerdict, weakNote } from "../src/engine/authoring/plain.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ApiEndpointModel } from "../src/engine/understanding/app-model.js";
import type { ValidationOutcome } from "../src/engine/validation/validator.js";

const ep = (method: string, path: string, extra: Partial<ApiEndpointModel> = {}): ApiEndpointModel => ({ method, path, origin: "http://x", statuses: [200], queryParams: [], source: "openapi", usedIn: [], ...extra });
const APIS = [
    ep("GET", "/api/products"),
    ep("GET", "/api/products/{id}", { spec: { parameters: [{ name: "id", location: "path", required: true, type: "integer", example: 1 }], responses: [], tags: [] } as never }),
    ep("POST", "/api/products"),
    ep("GET", "/api/search", { spec: { parameters: [{ name: "q", location: "query", required: true, type: "string" }], responses: [], tags: [] } as never }),
];
const plan = (p: Partial<ApiPlan>): ApiPlan => ({ operation: "GET /api/products", explanation: "ok", pathValues: {}, query: {}, expect: { fields: [], bodyContains: [] }, ...p });

describe("what is refused", () => {
    const off = { allowChanges: false };
    it.each([
        ["Add a product to the cart and pay with my card", "pay for something"],
        ["Enter the credit card number 4242 and submit", "pay for something"],
        ["Place the order and check the confirmation", "pay for something"],
        ["Use someone else's password to log in", "someone else"],
        ["Take over an account by guessing the password", "break in"],
        ["Delete my account and check I am logged out", "delete data"],
        ["Erase all the data and check the list is empty", "delete data"],
        ["DELETE /api/products/1 and check it is gone", "sends data"],
    ])("refuses %s", (text, part) => {
        expect(refusalFor(text, off)).toContain(part);
    });

    it.each([
        "Add a product to the cart and check the total is shown",
        "Remove an item from the cart and check the total drops",
        "Open the payment page and check the card form is shown",
        "Log in with the test account and check the welcome message",
        "Check that another user cannot see my orders",
        "GET /api/products/1 should return the Blue Mug",
    ])("allows %s", (text) => {
        expect(refusalFor(text, off)).toBeUndefined();
    });

    it("lets data-changing descriptions through when the project allows tests that change data, but still never payments or attacks", () => {
        const on = { allowChanges: true };
        expect(refusalFor("Delete my account and check I am logged out", on)).toBeUndefined();
        expect(refusalFor("POST /api/products with name Fork", on)).toBeUndefined();
        expect(refusalFor("Pay for the order with the credit card", on)).toBeDefined();
        expect(refusalFor("Try to brute force the login", on)).toBeDefined();
    });
});

describe("reading the sentence", () => {
    it("tells an API call from a page", () => {
        expect(detectKind("GET /api/products/1 should return the Blue Mug", APIS)).toBe("api");
        expect(detectKind("Check that the API endpoint /api/products returns a list", APIS)).toBe("api");
        expect(detectKind("The /api/products endpoint answers", [])).toBe("web");
        expect(detectKind("Add a product to the cart and check the total", APIS)).toBe("web");
        expect(detectKind("Open /products and look at the api docs", APIS)).toBe("web");
    });

    it("matches paths with or without concrete ids", () => {
        expect(namesPath("/api/products/42", "/api/products/{id}")).toBe(true);
        expect(namesPath("/api/products", "/api/products/{id}")).toBe(false);
        expect(namesPath("/api/products?x=1", "/api/products")).toBe(true);
    });

    it("builds title, expected results and start page from the words", () => {
        expect(titleOf("Add a product to the cart and check the total is shown.")).toBe("Add a product to the cart and check the total is shown");
        expect(expectedOf("Add a product to the cart and check the total is shown")).toEqual(["The total is shown"]);
        expect(expectedOf("Open the list.\nAdd one.\nThe cart shows 1 item")).toEqual(["The cart shows 1 item"]);
        expect(expectedOf("Log in. Verify the welcome message appears. Make sure the logout link is visible.")).toEqual(["The welcome message appears", "The logout link is visible"]);
        expect(startPathOf("Open /pricing and check the plans are listed")).toBe("/pricing");
        expect(startPathOf("Open the pricing page")).toBeUndefined();
        const s = scenarioFor("Open the cart and check the total", { startPath: "/", requiresAuth: false });
        expect(s.expectedResults).toEqual(["The total"]);
        expect(s.description).toBe("Open the cart and check the total");
    });
});

describe("a model's API plan becomes steps (and only steps for known operations)", () => {
    it("builds the request and the checks", () => {
        const b = buildApiSteps(plan({ operation: "GET /api/products/{id}", pathValues: { id: "1" }, expect: { status: 200, fields: [{ path: "name", equals: "Blue Mug" }, { path: "price", type: "number" }, { path: "id" }], bodyContains: ["Mug"] } }), APIS, { allowChanges: false });
        expect(b.ok).toBe(true);
        if (!b.ok) return;
        expect(b.steps[0]).toMatchObject({ action: "request", method: "GET", path: "/api/products/1" });
        expect(b.steps.slice(1).map((s) => (s as { check: string }).check)).toEqual(["status", "jsonPath", "jsonType", "jsonPath", "bodyContains"]);
        TestSpecSchema.parse({ testId: "API-001", title: "x y z", kind: "api", steps: b.steps });
    });

    it("uses the documented example for a placeholder the description leaves out, and asks when there is none", () => {
        const ok = buildApiSteps(plan({ operation: "GET /api/products/{id}" }), APIS, { allowChanges: false });
        expect(ok.ok && ok.steps[0]).toMatchObject({ path: "/api/products/1" });
        const noExample = buildApiSteps(plan({ operation: "GET /api/users/{name}" }), [ep("GET", "/api/users/{name}")], { allowChanges: false });
        expect(noExample.ok).toBe(false);
        expect(!noExample.ok && noExample.reason).toContain("needs a value for {name}");
    });

    it("sends required query parameters and refuses unsafe values", () => {
        const q = buildApiSteps(plan({ operation: "GET /api/search" }), APIS, { allowChanges: false });
        expect(q.ok && q.steps[0]).toMatchObject({ query: { q: "test" } });
        const bad = buildApiSteps(plan({ operation: "GET /api/products/{id}", pathValues: { id: "1/../../admin" } }), APIS, { allowChanges: false });
        expect(bad.ok).toBe(false);
        const badKey = buildApiSteps(plan({ query: { "a b;c": "x" } }), APIS, { allowChanges: false });
        expect(badKey.ok).toBe(false);
    });

    it("never invents an operation, and never builds a data-changing call unless allowed", () => {
        const none = buildApiSteps(plan({ operation: "GET /api/orders" }), APIS, { allowChanges: true });
        expect(none.ok).toBe(false);
        expect(!none.ok && none.reason).toContain("not one of the operations");
        const wrongMethod = buildApiSteps(plan({ operation: "DELETE /api/products" }), APIS, { allowChanges: true });
        expect(wrongMethod.ok).toBe(false);
        const nothingFits = buildApiSteps(plan({ operation: null, explanation: "No operation lists orders." }), APIS, { allowChanges: false });
        expect(!nothingFits.ok && nothingFits.reason).toBe("No operation lists orders.");
        const post = buildApiSteps(plan({ operation: "POST /api/products", body: { name: "Fork" } }), APIS, { allowChanges: false });
        expect(post.ok).toBe(false);
        expect(!post.ok && post.reason).toContain("changes data");
        const allowed = buildApiSteps(plan({ operation: "POST /api/products", body: { name: "Fork" } }), APIS, { allowChanges: true });
        expect(allowed.ok && allowed.steps[0]).toMatchObject({ method: "POST", body: { name: "Fork" } });
        // A GET never carries a body, whatever the model said.
        const get = buildApiSteps(plan({ operation: "GET /api/products", body: { sneaky: true } }), APIS, { allowChanges: false });
        expect(get.ok && (get.steps[0] as { body?: unknown }).body).toBeUndefined();
    });

    it("lists the operations for the model, with parameters", () => {
        const text = operationList(APIS);
        expect(text).toContain("GET /api/products/{id}");
        expect(text).toContain("id (path, required, e.g. 1)");
    });
});

describe("a pass of a test that checks almost nothing is not green", () => {
    const spec = (steps: unknown[]) => TestSpecSchema.parse({ testId: "WEB-001", title: "Plain test", kind: "web", steps });
    const outcome = (s: ReturnType<typeof spec>, status: ValidationOutcome["status"] = "VALIDATED", reason?: string): ValidationOutcome => ({ status, reason, spec: s, attempts: 1, script: {} as never, lastRun: {} as never });

    it("downgrades a validated test whose only check is the address", () => {
        const weak = spec([{ action: "navigate", url: "/products" }, { action: "assert", check: "url", expected: "/products" }]);
        const v = finalVerdict(outcome(weak));
        expect(v.status).toBe("NEEDS_REVIEW");
        expect(v.reason).toBe(weakNote(["This test only checks that a page loaded (its address, title or a container every page has) — it would still pass if the feature on the page were missing."]));
    });

    it("keeps a test that checks something real, and does not touch other outcomes", () => {
        const good = spec([{ action: "navigate", url: "/products" }, { action: "click", locator: { by: "role", role: "button", value: "Add" } }, { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected: "Total: $12.00" }]);
        expect(finalVerdict(outcome(good)).status).toBe("VALIDATED");
        expect(finalVerdict(outcome(good, "FAILED_VALIDATION", "x"))).toEqual({ status: "FAILED_VALIDATION", reason: "x" });
        const weak = spec([{ action: "navigate", url: "/" }]);
        expect(finalVerdict(outcome(weak, "NEEDS_REVIEW", "a finding"))).toEqual({ status: "NEEDS_REVIEW", reason: "a finding" });
    });
});
