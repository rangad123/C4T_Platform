/**
 * eng-fix3 (paid series PAID-SERIES-RESULT.md, targets V1–V4, V7 and shop detection): one regression test per fix, from the paid trials'
 * own saved steps and scenarios (c4t-scratch/eng-paid/trials). Fast tier: no browser, no model.
 */
import { describe, expect, it } from "vitest";
import { apiOnAmount, judgePageCheck } from "../src/engine/findings/expectation.js";
import { roleCredentials } from "../src/engine/identity/role-differences.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import type { ApiEndpointModel } from "../src/engine/understanding/app-model.js";
import { proposeInvariants } from "../src/engine/validation/invariants.js";
import { maskedExpectation, withStatedCheckKinds } from "../src/engine/web/author.js";
import { findLeftoverUse } from "../src/engine/web/leftovers.js";
import { catalogueRoles } from "../src/eval/bench/controller.js";
import { BENCH_SHOP_INVARIANTS } from "../src/eval/bench/layers-only.js";
import { loadCatalogueVersion } from "../src/eval/bench/catalogue.js";

const steps = (xs: unknown[]) => xs as Step[];

describe("a masked evidence value is never an expected value (shop-3 WEB-042, shop-5 WEB-033/046)", () => {
    it("refuses a check that expects [hidden], and lets the typed value through", () => {
        const web042 = { action: "assert", check: "notText", locator: { by: "text", value: "Deliver to" }, expected: "[hidden]", source: "expected:2" } as Step;
        expect(maskedExpectation(web042)).toMatch(/never expect it/);
        expect(maskedExpectation({ action: "assert", check: "visible", locator: { by: "text", value: "[hidden] qatflc" } } as Step)).toMatch(/never expect it/);
        expect(maskedExpectation({ ...web042, expected: "715 Harbor Lane" } as Step)).toBeUndefined();
        expect(maskedExpectation({ action: "fill", locator: { by: "label", value: "Password" }, value: "[hidden]" } as Step)).toBeUndefined();
    });
});

describe("an assertion kind the requirement does not state becomes the plain check (rbac-3 WEB-041, rbac-5 WEB-023)", () => {
    it("an accessible error message is the message shown; an accessibility requirement keeps it", () => {
        const web023 = { action: "assert", check: "accessibleErrorMessage", locator: { by: "label", value: "Email" }, expected: "Enter a valid email address.", source: "expected:2" } as Step;
        expect(withStatedCheckKinds(web023, "Registration refuses an invalid email address")).toMatchObject({ action: "assert", check: "visible", locator: { by: "text", value: "Enter a valid email address." }, source: "expected:2" });
        expect(withStatedCheckKinds(web023, "The error is announced to screen readers through aria-errormessage")).toEqual(web023);
        const named = { action: "assert", check: "accessibleName", locator: { by: "role", role: "button", value: "Save" }, expected: "Save note" } as Step;
        expect(withStatedCheckKinds(named, "Save a note")).toMatchObject({ check: "text" });
    });
});

describe("the leftover gate covers URL and heading checks with hard-coded ids (rbac-5 WEB-027, rbac-4 WEB-038)", () => {
    const signIn = [
        { action: "navigate", url: "/notes/new" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "fill", locator: { by: "label", value: "Title" }, value: "qa1x0y short" },
        { action: "click", locator: { by: "role", role: "button", value: "Save note" } },
    ];
    const starting = new Set(["/n1", "/n2", "/n3", "/p1"]);
    it("flags /notes/n17 and n25, not a starting record's address", () => {
        expect(findLeftoverUse(steps([...signIn, { action: "assert", check: "url", expected: "/notes/n17", source: "expected:1" }]), starting).map((u) => u.what)).toEqual([expect.stringMatching(/\/notes\/n17, a record number the test never made/)]);
        expect(findLeftoverUse(steps([...signIn, { action: "assert", check: "urlPattern", expected: "/notes/n25", source: "expected:1" }]), starting)).toHaveLength(1);
        expect(findLeftoverUse(steps([...signIn, { action: "assert", check: "url", expected: "/products/p1" }]), starting)).toEqual([]);
    });
    it("flags a heading with a record number the test never made, not its own typed title", () => {
        expect(findLeftoverUse(steps([...signIn, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Note n17" } }]), starting)).toHaveLength(1);
        const typed = [...signIn.slice(0, 2), { action: "fill", locator: { by: "label", value: "Title" }, value: "Plan v42" }, signIn[3]];
        expect(findLeftoverUse(steps([...typed, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Plan v42" } }]), starting)).toEqual([]);
        expect(findLeftoverUse(steps([...signIn, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Note n2" } }]), starting)).toEqual([]);
    });
});

describe("a role named only in a precondition binds the one account that holds it (rbac-5 WEB-029, WEB-035)", () => {
    it("the catalogue's only admin and only manager are named after their role, and the trial's scenarios bind them", () => {
        const roles = catalogueRoles(loadCatalogueVersion("2026-11-21.1").accounts!["bench-rbac"]!);
        const web035 = { title: "Admin sees People in the main navigation", description: "Sign in with the admin test account and read the main navigation. Click People and observe the page that opens.", preconditions: ["An admin test account exists"] };
        const web029 = { title: "Manager creates a note like any user", description: "Sign in with the manager test account and read the role on the Account page.", preconditions: ["A manager test account exists", "Signed in as a newly registered account with an empty cart and no orders"] };
        expect(roleCredentials(web035, roles, "ana@example.test")).toEqual({ name: "admin", credentials: { username: "ada@example.test", password: "Password1!" } });
        expect(roleCredentials(web029, roles, "ana@example.test")?.credentials.username).toBe("mia@example.test");
        // Two accounts hold "user": neither is named after it, and a "user test account" binds nobody.
        expect(roles.filter((r) => r.name === "user")).toEqual([]);
        expect(roleCredentials({ title: "x", preconditions: ["A user test account exists"] }, roles, "ana@example.test")).toBeUndefined();
    });
});

/** shop-5 WEB-053's saved steps (cut to what the judgement reads): a computed discount the rule does not state. */
const web053 = TestSpecSchema.parse({
    testId: "WEB-053",
    title: 'As stated: rule "R-a3777ab66902"',
    kind: "web",
    source: { origin: "browser-agent" },
    steps: [
        { action: "navigate", url: "/" },
        { action: "fill", locator: { by: "label", value: "Discount code" }, value: "SAVE10" },
        { action: "click", locator: { by: "role", role: "button", value: "Apply", exact: true } },
        { action: "assert", check: "text", locator: { by: "role", role: "term", value: "Discount (SAVE10)" }, expected: "$4.70", source: "expected:1" },
    ],
});
const cited053 = '"SAVE10 takes 10% off the order subtotal, rounded to the nearest cent" (source: R-a3777ab66902)';

describe("the expectation check before the vote (V1, V4)", () => {
    it("an amount the cited rule does not state: needs review, an incorrect expectation when the API lacks it, normal when the API holds it", () => {
        expect(judgePageCheck({ spec: web053, failedStep: 4, cited: cited053 })?.review).toMatch(/\$4\.70, an amount the cited expectation does not state/);
        expect(judgePageCheck({ spec: web053, failedStep: 4, cited: cited053, apiAmount: "lacks" })?.contradictedBy).toMatch(/API/);
        expect(judgePageCheck({ spec: web053, failedStep: 4, cited: cited053, apiAmount: "holds" })).toBeUndefined();
        // A correlation finding (the API layer disagreed), or an amount the requirement states, is not judged here.
        expect(judgePageCheck({ spec: web053, failedStep: 4, cited: cited053, correlated: true })).toBeUndefined();
        expect(judgePageCheck({ spec: web053, failedStep: 4, cited: "Shipping is $4.70 below the threshold" })).toBeUndefined();
    });
    it("a text the cited expectation does not state is unstated; a stated message or the test's own typed value is not (rbac-4 WEB-032, BR-08, BR-10)", () => {
        const page = (check: Record<string, unknown>, fills: string[] = []) =>
            TestSpecSchema.parse({ testId: "WEB-001", title: "A page check", kind: "web", source: { origin: "browser-agent" }, steps: [{ action: "navigate", url: "/" }, ...fills.map((v) => ({ action: "fill", locator: { by: "label", value: "Title" }, value: v })), { action: "assert", source: "expected:1", ...check }] });
        const web032 = page({ check: "visible", locator: { by: "text", value: "at least 8 characters" } });
        expect(judgePageCheck({ spec: web032, failedStep: 2, cited: "A message stating the minimum of 8 characters is shown (requirement 2.7)" })).toEqual({ unstated: true });
        const br08 = page({ check: "visible", locator: { by: "text", value: "Give the note a title." } });
        expect(judgePageCheck({ spec: br08, failedStep: 2, cited: "The message 'Give the note a title.' is shown (requirement 3.4)" })).toBeUndefined();
        const br10 = page({ check: "exactText", locator: { by: "role", role: "heading" }, expected: "<b>Bold {{unique}}</b>" }, ["<b>Bold {{unique}}</b>"]);
        expect(judgePageCheck({ spec: br10, failedStep: 3, cited: "A note's title and text are always shown as plain text, exactly as typed." })).toBeUndefined();
        // An API test is never judged here.
        expect(judgePageCheck({ spec: { ...web032, kind: "api" }, failedStep: 2, cited: "x" })).toBeUndefined();
    });
    it("apiOnAmount reads the captured answers in units or cents", () => {
        const cart = (discount: number) => [{ step: 2, method: "POST", path: "/api/cart/discount", status: 200, body: JSON.stringify({ subtotal: 1250, discount, shipping: 500, total: 1750 - discount }) }];
        expect(apiOnAmount(web053.steps, "expected:1", cart(125))).toBe("lacks");
        expect(apiOnAmount(web053.steps, "expected:1", cart(470))).toBe("holds");
        expect(apiOnAmount(web053.steps, "expected:1", [])).toBeUndefined();
        expect(apiOnAmount(web053.steps, "expected:9", cart(470))).toBeUndefined();
    });
});

describe("the deterministic invariant proposal joins the model's (shop BS-01 / BS-11, requirements 4.1 and 4.5)", () => {
    const O = "http://127.0.0.1:7600";
    const cart = { type: "object", properties: { lines: { type: "array", items: { type: "object", properties: { lineTotal: { type: "integer" } } } }, subtotal: { type: "integer" }, code: { type: "string" }, discount: { type: "integer" }, shipping: { type: "integer" }, total: { type: "integer" } } };
    const op = (method: string, path: string, body?: Record<string, unknown>): ApiEndpointModel => ({
        method, path, origin: O, statuses: [200], queryParams: [], source: "openapi", usedIn: [],
        spec: { tags: [], parameters: [], ...(body ? { requestBody: { required: true, contentType: "application/json", schema: { type: "object", properties: body } } } : {}), responses: [{ status: "200", description: "ok", schema: cart }], security: [] },
    });
    const apis = [op("GET", "/api/cart"), op("POST", "/api/cart/items", { productId: { type: "string" }, quantity: { type: "integer" } }), op("POST", "/api/cart/discount", { code: { type: "string" } }), op("POST", "/api/orders")];
    const requirements = [
        { id: "3.9", text: "The cart's subtotal is the sum of its line totals." },
        { id: "4.1", text: "The shop has one discount code, SAVE10, which takes 10% off the order subtotal, rounded to the nearest cent." },
        { id: "4.5", text: "Shipping is free when the subtotal after the discount is $50.00 or more." },
    ];
    const llm = (invariants: unknown[]): LlmClient => ({ modelName: "scripted", model: undefined as never, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: (async (a: { schema: { parse(v: unknown): unknown } }) => a.schema.parse({ invariants })) as LlmClient["object"] });

    it("a model that proposes only 3.9 still gets 4.1 and 4.5, as the scripted bench proposal has them", async () => {
        const r = await proposeInvariants({ llm: llm([BENCH_SHOP_INVARIANTS[0]]) }, { requirements, apis, origins: new Set([O]), dataChanges: true, secrets: [] });
        expect(r.report).toMatchObject({ proposed: 3, kept: 3, dropped: [] });
        expect(r.invariants.map((i) => [i.requirementId, i.expression])).toEqual([
            ["4.1", "discount == round(subtotal * 0.1)"],
            ["4.5", "(subtotal - discount >= 5000) implies shipping == 0"],
            ["3.9", "subtotal == sum(lines[*].lineTotal)"],
        ]);
        expect(r.invariants[0]).toMatchObject({ setup: ["POST /api/cart/discount"], setupBodies: [{ code: "SAVE10" }], write: "POST /api/cart/items" });
        // The model's own proposal for a requirement wins; a failed model call still leaves the stated ones.
        const own = await proposeInvariants({ llm: llm(BENCH_SHOP_INVARIANTS) }, { requirements, apis, origins: new Set([O]), dataChanges: true, secrets: [] });
        expect(own.invariants.map((i) => i.expression)).toEqual(BENCH_SHOP_INVARIANTS.map((i) => i.expression));
        const failing: LlmClient = { ...llm([]), object: (async () => { throw new Error("rate limited"); }) as LlmClient["object"] };
        const off = await proposeInvariants({ llm: failing }, { requirements, apis, origins: new Set([O]), dataChanges: true, secrets: [] });
        expect(off.invariants.map((i) => i.requirementId)).toEqual(["4.1", "4.5"]);
        expect(off.report.error).toMatch(/rate limited/);
    });
});

describe("a bench trial verifies every candidate (V2, V3)", () => {
    it("the bench budget leaves none of 42 waiting, where the product's leaves 12", async () => {
        const { BENCH_VERIFY_BUDGET } = await import("../src/eval/bench/cli.js");
        const { withinBudget, VERIFY_BUDGET } = await import("../src/engine/findings/reproduce.js");
        const items = Array.from({ length: 42 }, (_, i) => i);
        expect((await withinBudget(items, async (i) => i, BENCH_VERIFY_BUDGET)).left).toEqual([]);
        expect((await withinBudget(items, async (i) => i, VERIFY_BUDGET)).left).toHaveLength(12);
        expect(BENCH_VERIFY_BUDGET.minutesEach).toBe(VERIFY_BUDGET.minutesEach);
    });
});
