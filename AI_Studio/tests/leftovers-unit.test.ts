/**
 * The leftover check (queue row 181, second commit): a saved test that acts on or checks an item its own earlier steps never added or
 * opened is found, deterministically and without AI. The C1c trial's saved WEB-028 (empties the cart before adding anything) and
 * WEB-030 (clears a leftover Trail Mug, removes a Headphones line it never added) are found; tests that add an item and then remove
 * it, and tests on the starting data every fresh session sees (the catalogue, seeded orders), are not.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Step } from "../src/engine/spec/schema.js";
import { findLeftoverUse, leftoverReason, scenarioWords, startingIdsOf, withOwnUnique } from "../src/engine/web/leftovers.js";

const saved = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "c1c-leftover-specs.json"), "utf8")) as Record<string, { steps: Step[] }>;
const stepsOf = (key: string) => saved[key]!.steps;

const signIn: Step[] = [
    { action: "navigate", url: "/cart", description: "Open /cart" },
    { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}", description: "Enter the email" },
    { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}", description: "Enter the password" },
    { action: "click", locator: { by: "role", role: "button", value: "Sign in" }, description: "Sign in" },
];
const removeMug: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove", within: { by: "role", role: "row", value: "Trail Mug" } }, description: "Remove the Trail Mug line" };
const addMug: Step[] = [
    { action: "click", locator: { by: "role", role: "link", value: "Products" }, description: "Go to products" },
    { action: "click", locator: { by: "role", role: "link", value: "Trail Mug" }, description: "Open the product" },
    { action: "click", locator: { by: "role", role: "button", value: "Add to cart" }, description: "Add it to the cart" },
    { action: "navigate", url: "/cart", description: "Open /cart" },
];
const mugGone: Step = { action: "assert", check: "hidden", locator: { by: "role", role: "row", value: "Trail Mug" }, source: "expected:1", description: "The line is gone" };

describe("the leftover check", () => {
    it("finds the C1c WEB-028: it empties the cart before the test added anything", () => {
        const found = findLeftoverUse(stepsOf("WEB-028"));
        expect(found).toEqual([{ step: 7, what: 'presses "Remove" before the test added anything' }]);
    });

    it("finds the C1c WEB-030: a leftover cleared unnamed, then lines removed by name that the test never added", () => {
        const found = findLeftoverUse(stepsOf("WEB-030"));
        expect(found.map((f) => f.step)).toEqual([5, 14, 15]);
        expect(found[1]!.what).toBe('removes "Headphones"');
        expect(found[2]!.what).toBe('removes "Trail Mug"');
        expect(leftoverReason(found)).toMatch(/^The test depends on what the account held before it ran: step 5 .*step 14 removes "Headphones"; step 15 removes "Trail Mug"\./);
    });

    it("finds a check of a discount code the test never applied (C1c WEB-032), and of cart lines it never added (WEB-037)", () => {
        expect(findLeftoverUse(stepsOf("WEB-032"))).toEqual([{ step: 13, what: "checks the code SAVE10, which the test never applied" }]);
        // Row 228 adds what WEB-037 also does before adding anything: Check out, and checks of the cart's amounts.
        expect(findLeftoverUse(stepsOf("WEB-037")).map((f) => f.what)).toEqual([
            'presses "Check out" before the test added anything',
            "checks the amount $18.00 before the test added anything",
            'checks "Water Bottle", a line the account held',
            "checks the amount $12.50 before the test added anything",
            'checks "Trail Mug", a line the account held',
            "checks the amount $33.70 before the test added anything",
        ]);
    });

    it("finds a named removal with nothing before it, and a click on a row the test never added", () => {
        expect(findLeftoverUse([...signIn, removeMug, mugGone])).toEqual([{ step: 5, what: 'removes "Trail Mug"' }]);
        const clickRow: Step = { action: "click", locator: { by: "role", role: "row", value: "Desk Lamp" }, description: "Locate the Desk Lamp row" };
        expect(findLeftoverUse([...signIn, ...addMug, clickRow])).toEqual([{ step: 9, what: 'clicks the row "Desk Lamp"' }]);
    });

    it("does not flag a test that adds an item and then removes it, by name or unnamed", () => {
        expect(findLeftoverUse([...signIn, ...addMug, removeMug, mugGone])).toEqual([]);
        const unnamed: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove" }, description: "Remove the line" };
        expect(findLeftoverUse([...signIn, ...addMug, unnamed])).toEqual([]);
        // Added by its address, named in the step that adds it.
        const byUrl: Step[] = [{ action: "navigate", url: "/products/p5", description: "Open /products/p5" }, { action: "click", locator: { by: "role", role: "button", value: "Add to cart" }, description: "Add Water Bottle to cart" }];
        const removeBottle: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove", within: { by: "role", role: "row", value: "Water Bottle" } }, description: "Remove it" };
        expect(findLeftoverUse([...signIn, ...byUrl, removeBottle])).toEqual([]);
        // A discount code the test applied itself.
        const applied: Step[] = [
            { action: "fill", locator: { by: "label", value: "Discount code" }, value: "SAVE10", description: "Enter the code" },
            { action: "click", locator: { by: "role", role: "button", value: "Apply" }, description: "Apply it" },
            { action: "assert", check: "visible", locator: { by: "text", value: "Discount (SAVE10)" }, source: "expected:1", description: "The discount shows" },
        ];
        expect(findLeftoverUse([...signIn, ...addMug, ...applied])).toEqual([]);
    });

    it("a removal step does not make what it removes the test's own: describing the leftover it clears is not adding it", () => {
        const clearUnnamedAfterAdd: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove", nth: 0 }, description: "Clear the leftover Headphones" };
        const removeHeadphones: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove", within: { by: "role", role: "row", value: "Headphones" } }, description: "Remove the Headphones line" };
        expect(findLeftoverUse([...signIn, ...addMug, clearUnnamedAfterAdd, removeHeadphones]).map((f) => f.step)).toEqual([10]);
    });

    it("leaves the starting data alone: a catalogue card read before it is opened, a product page, seeded orders", () => {
        expect(findLeftoverUse(stepsOf("WEB-020"))).toEqual([]);
        expect(findLeftoverUse(stepsOf("WEB-021"))).toEqual([]);
        expect(findLeftoverUse(stepsOf("WEB-036"))).toEqual([]);
        const catalogueRow: Step[] = [
            { action: "navigate", url: "/", description: "Open the catalogue" },
            { action: "assert", check: "text", locator: { by: "role", role: "row", value: "Headphones $59.99" }, expected: "$59.99", source: "expected:1", description: "The catalogue lists Headphones" },
            { action: "click", locator: { by: "role", role: "button", value: "Add to cart", within: { by: "role", role: "listitem", value: "Headphones" } }, description: "Add from the catalogue card" },
        ];
        expect(findLeftoverUse(catalogueRow)).toEqual([]);
    });

    // Queue row 228 (row 227 triage, rule 1a): a record id the test never created, and a check of what only account state shows
    // (a cart's total, a discount, its Check out) before any step that adds to it.
    const seeded = new Set(["ord-1000", "ord-1001"]);
    const signInAt = (url: string): Step[] => [{ ...signIn[0]!, url, description: `Open ${url}` } as Step, ...signIn.slice(1)];

    it("finds a record id the test never created (smoke WEB-033's ord-1008, WEB-055's ord-1023), once per id", () => {
        const web033: Step[] = [
            ...signInAt("/orders"),
            { action: "click", locator: { by: "role", role: "link", value: "ord-1008" }, description: "Open order ord-1008 detail page" },
            { action: "navigate", url: "/orders/ord-1000", description: "Open /orders/ord-1000" },
            { action: "navigate", url: "/orders/ord-1008", description: "Open /orders/ord-1008" },
            { action: "assert", check: "exactText", locator: { by: "text", value: "Total: $213.75" }, expected: "Total: $213.75", source: "expected:2", description: "The total" },
        ];
        expect(findLeftoverUse(web033, seeded)).toEqual([{ step: 5, what: "uses the record ord-1008, which the test never created" }]);
        // The test placed an order itself, but its number is whatever the app gives it: a literal number is another run's.
        const web055: Step[] = [
            ...signIn,
            ...addMug,
            { action: "click", locator: { by: "role", role: "link", value: "Check out" }, description: "Check out" },
            { action: "click", locator: { by: "role", role: "button", value: "Place order" }, description: "Place the order" },
            { action: "assert", check: "text", locator: { by: "role", role: "heading", value: "Order ord-1023" }, expected: "Order ord-1023", source: "expected:1", description: "The order page" },
        ];
        expect(findLeftoverUse(web055, seeded)).toEqual([{ step: 11, what: "uses the record ord-1023, which the test never created" }]);
    });

    it("leaves records of the starting data alone, a test that checks an id is not found, and ids when no starting data is given", () => {
        const seededOrder: Step[] = [
            ...signInAt("/orders/ord-1000"),
            { action: "navigate", url: "/orders/ord-1000", description: "Open the order again" },
            { action: "assert", check: "text", locator: { by: "text", value: "Total:" }, expected: "$213.75", source: "expected:1", description: "The seeded order's total" },
        ];
        expect(findLeftoverUse(seededOrder, seeded)).toEqual([]);
        const notFound: Step[] = [
            ...signIn,
            { action: "navigate", url: "/orders/ord-9999", description: "Open an order that does not exist" },
            { action: "assert", check: "visible", locator: { by: "text", value: "Order not found" }, source: "expected:1", description: "Not found" },
        ];
        expect(findLeftoverUse(notFound, seeded)).toEqual([]);
        // Requirement and rule ids in descriptions and sources are not records.
        const cited: Step = { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Cart" }, source: "R-033", description: "requirement R-033 and rule r-1234" };
        expect(findLeftoverUse([...signIn, cited], seeded)).toEqual([]);
        expect(findLeftoverUse([...signIn, { action: "navigate", url: "/orders/ord-1008", description: "" }])).toEqual([]);
        // A typed value is no record (C1e WEB-005 typed the wrong password wrong-pass-123).
        expect(findLeftoverUse([...signIn.slice(0, 2), { action: "fill", locator: { by: "label", value: "Password" }, value: "wrong-pass-123", description: "" }, signIn[3]!], seeded)).toEqual([]);
    });

    it("finds a click on Check out, or a code applied, before the test added anything (smoke WEB-023, C1e WEB-029/031/032)", () => {
        const checkOut: Step = { action: "click", locator: { by: "role", role: "link", value: "Check out" }, description: "Start checkout to place an order" };
        expect(findLeftoverUse([...signIn, checkOut, ...addMug, checkOut], seeded)).toEqual([{ step: 5, what: 'presses "Check out" before the test added anything' }]);
        const waitCheckOut: Step = { action: "wait", ms: 0, until: "visible", locator: { by: "role", role: "link", value: "Check out" }, description: "Wait" };
        expect(findLeftoverUse([...signIn, waitCheckOut, checkOut], seeded).map((f) => f.step)).toEqual([5]);
        const code: Step[] = [
            { action: "fill", locator: { by: "label", value: "Discount code" }, value: " save10 ", description: "Type the code" },
            { action: "click", locator: { by: "role", role: "button", value: "Apply" }, description: "Apply the discount code" },
        ];
        expect(findLeftoverUse([...signIn, ...code], seeded)).toEqual([{ step: 6, what: 'presses "Apply" before the test added anything' }]);
        // After its own add, the same steps are the test's own.
        expect(findLeftoverUse([...signIn, ...addMug, ...code, checkOut], seeded)).toEqual([]);
        // An Apply on a filter form is not a code.
        const filter: Step[] = [{ action: "fill", locator: { by: "label", value: "Max price" }, value: "20", description: "" }, { action: "click", locator: { by: "role", role: "button", value: "Apply" }, description: "Apply the filter" }];
        expect(findLeftoverUse([...signIn, { action: "navigate", url: "/", description: "" }, ...filter], seeded)).toEqual([]);
    });

    it("finds a check of a cart amount before the test added anything (smoke WEB-062), not a catalogue price, a seeded order's or an empty cart's", () => {
        const web062: Step[] = [
            { action: "navigate", url: "/", description: "Open /" },
            { action: "click", locator: { by: "role", role: "link", value: "Trail Mug" }, description: "Open the Trail Mug product to add it to the cart" },
            ...signIn,
            { action: "assert", check: "exactText", locator: { by: "role", role: "definition", nth: 0 }, expected: "$738.73", source: "expected:1", description: "Subtotal must equal the sum of the line totals (738.73)" },
        ];
        expect(findLeftoverUse(web062, seeded)).toEqual([{ step: 7, what: "checks the amount $738.73 before the test added anything" }]);
        const discount: Step = { action: "assert", check: "text", locator: { by: "text", value: "−$3.60", exact: true }, expected: "−$3.60", source: "expected:1", description: "The discount" };
        expect(findLeftoverUse([...signIn, discount], seeded).map((f) => f.step)).toEqual([5]);
        expect(findLeftoverUse([...signIn, ...addMug, discount], seeded)).toEqual([]);
        // Signed out the browser is fresh: what its cart shows is the application's starting data (a shop with a seeded cart).
        expect(findLeftoverUse([{ action: "navigate", url: "/cart", description: "Open /cart" }, discount], seeded)).toEqual([]);
        const empty: Step = { action: "assert", check: "text", locator: { by: "role", role: "definition", nth: 0 }, expected: "$0.00", source: "expected:1", description: "An empty cart's subtotal is zero" };
        expect(findLeftoverUse([...signIn, empty], seeded)).toEqual([]);
    });

    it("reads the starting record ids from the discovery model, wherever they are", () => {
        const model = { pages: [{ path: "/orders/ord-1000", components: [{ role: "link", name: "ord-1001" }] }], purpose: "A shop\nord-12 is too short" };
        expect([...startingIdsOf(model)].sort()).toEqual(["ord-1000", "ord-1001"]);
    });
});

// Paid trial rbac-2 (fixtures/paid-rbac2-recorded-values.json: the saved steps and the scenario of each, from the trial's database).
const paid = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "paid-rbac2-recorded-values.json"), "utf8")) as Record<string, { steps: Step[]; scenario: Parameters<typeof scenarioWords>[0] }>;
// What the trial's discovery saw of bench-rbac as its account: the two notes ana can open.
const rbacStart = startingIdsOf({ pages: [{ path: "/notes/n1" }, { url: "http://127.0.0.1:8100/notes/n3" }, { path: "/notes/new" }] });

describe("values recorded from the authoring run (paid rbac-2)", () => {
    it("reads the record numbers of addresses in the discovery model", () => {
        expect([...rbacStart].sort()).toEqual(["/n1", "/n3"]);
    });

    it("WEB-059: its own {{unique}} title becomes {{unique}} again, and the note address it was given is found", () => {
        const { steps, scenario } = paid["WEB-059"]!;
        const own = withOwnUnique(steps);
        expect(own[13]).toMatchObject({ locator: { value: "Bench note {{unique}}" } });
        expect(own[15]).toMatchObject({ locator: { value: "Bench note {{unique}}" } });
        expect(own.filter((s, i) => JSON.stringify(s) !== JSON.stringify(steps[i])).length).toBe(2);
        expect(findLeftoverUse(own, rbacStart, scenarioWords(scenario))).toEqual([{ step: 15, what: "opens /notes/n52, a record number the test never made" }]);
        // As saved, the title is a generated value of another run.
        expect(findLeftoverUse(steps, rbacStart, scenarioWords(scenario)).map((u) => u.what)).toContain("uses 1795433813701, a generated value of an earlier run");
    });

    it("WEB-012 and WEB-046: counts of the shared list (5, 34) that no stated result gives, and WEB-012's note address", () => {
        const w012 = paid["WEB-012"]!;
        expect(findLeftoverUse(w012.steps, rbacStart, scenarioWords(w012.scenario))).toEqual([
            { step: 12, what: "opens /notes/n6, a record number the test never made" },
            { step: 21, what: "expects 5 items on the shared account, a count its stated results do not give" },
        ]);
        const w046 = paid["WEB-046"]!;
        expect(findLeftoverUse(w046.steps, rbacStart, scenarioWords(w046.scenario)).map((u) => u.step)).toEqual([10, 16]);
        expect(findLeftoverUse(w046.steps, rbacStart, scenarioWords(w046.scenario))[0]!.what).toBe("expects 34 items on the shared account, a count its stated results do not give");
    });

    it("leaves alone a stated count, a count signed out or in a fresh account, a starting record's address, and {{unique}} itself", () => {
        const count = (n: number): Step => ({ action: "assert", check: "count", locator: { by: "role", role: "listitem" }, expected: n, description: "" });
        expect(findLeftoverUse([...signIn, count(3)], rbacStart, "The list shows 3 notes")).toEqual([]);
        expect(findLeftoverUse([...signIn, count(1)], rbacStart, "")).toEqual([]);
        expect(findLeftoverUse([{ action: "navigate", url: "/products", description: "" }, count(6)], rbacStart, "")).toEqual([]);
        expect(findLeftoverUse([...signIn, { action: "navigate", url: "/notes/n3", description: "" }], rbacStart)).toEqual([]);
        expect(findLeftoverUse([...signIn, { action: "navigate", url: "/notes/n9", description: "" }])).toEqual([]);
        const fresh: Step[] = [{ action: "fill", locator: { by: "label", value: "Title" }, value: "Note {{unique}}", description: "" }, { action: "assert", check: "visible", locator: { by: "role", role: "link", value: "Note {{unique}}" }, description: "" }];
        expect(withOwnUnique(fresh)).toEqual(fresh);
        expect(findLeftoverUse(fresh, rbacStart)).toEqual([]);
    });
});

/**
 * eng-fix3 (paid series PAID-SERIES-RESULT.md, targets V1–V4, V7 and shop detection): one regression test per fix, from the paid trials'
 * own saved steps and scenarios (c4t-scratch/eng-paid/trials). Fast tier: no browser, no model.
 */
import { apiOnAmount, judgePageCheck } from "../src/engine/findings/expectation.js";
import { roleCredentials } from "../src/engine/identity/role-differences.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import type { ApiEndpointModel } from "../src/engine/understanding/app-model.js";
import { proposeInvariants } from "../src/engine/validation/invariants.js";
import { maskedExpectation, withStatedCheckKinds } from "../src/engine/web/author.js";
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
