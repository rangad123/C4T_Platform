/**
 * A bug report stands on its own (fresh review of the L4 reports, gaps common to all 10): the title says what went wrong, not the
 * test's name; Expected and Actual hold no engine text (a settings blob, "(undefined)", the error printed twice); Evidence carries the
 * answers verification kept; a request step names the body it sends (the discount code); the account names its sign-in. The cases are
 * the reviewed reports' own shapes (shop S1/S3/S5, rbac R3). Browser-free.
 */
import { describe, expect, it } from "vitest";
import { FindingViewSchema, type FindingView, type FindingViewInput } from "../src/engine/findings/view.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { buildFindingReport, findingIssueDraft } from "../src/platform/issues/content.js";

const view = (over: Partial<FindingViewInput>): FindingView =>
    FindingViewSchema.parse({
        id: "f-1",
        projectId: "p-1",
        source: { kind: "execution", id: "f-1" },
        state: "confirmed",
        title: "x",
        testId: "t-1",
        detectedAt: "2026-11-25T10:00:00.000Z",
        expected: { text: "x", source: null, stated: "explicit" },
        observed: "x",
        steps: [],
        attempts: [],
        ...over,
    });
const failedThrice = (a: Record<string, unknown>) => [1, 2, 3].map(() => ({ outcome: "failed" as const, ...a }));
const apiSpec = (title: string, steps: unknown[]) => TestSpecSchema.parse({ testId: "API-001", title, kind: "api", category: "Security", priority: "high", steps, expectedResults: ["x"] });

// shop-4 #12 (S5): the answer holds the password.
const s5spec = apiSpec("GET /api/profile returns no password or other sign-in secret", [
    { action: "request", method: "GET", path: "/api/profile", description: "Read /api/profile signed in" },
    { action: "assertResponse", check: "statusClass", expected: 2, description: "/api/profile answers" },
    { action: "assertResponse", check: "jsonType", path: "password", expected: "undefined", source: "8.6", description: "The answer holds no “password”" },
]);
const s5 = view({
    title: s5spec.title,
    expected: { text: "No API response contains a password or other sign-in secret (requirement 8.6) (undefined)", source: "8.6", stated: "explicit" },
    observed: 'Expected "undefined", got "string"',
    account: "the project's test account",
    attempts: failedThrice({ failedStep: 3, check: "jsonType", target: "password", value: "undefined", error: 'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "undefined"\nReceived: "string"', requests: [{ method: "GET", path: "/api/profile", status: 200, own: true }] }),
});

describe("the title says what went wrong, not the test's name", () => {
    it("an access check's title is its own sentence about the defect, first clause only (S1)", () => {
        const r = buildFindingReport({
            members: [view({ title: "“bob” account: cannot open a record of “alice” (/orders/ord-1000)", observed: "A signed-in “bob” user can open /orders/ord-1000 and see “Order ord-1000”, which belongs to the “alice” account (each account reaches its own records at addresses like /orders/{}), so this is possible broken access control between accounts: check that one account cannot open another account's records" })],
            environment: {},
        });
        expect(r.title).toEqual(["A signed-in “bob” user can open /orders/ord-1000 and see “Order ord-1000”, which belongs to the “alice” account"]);
    });

    it("a refused-write check names what failed: the write was not refused (R3), and the filed issue's title is the same", () => {
        const spec = apiSpec('Backend: a refused write changes nothing (POST /api/notes, "title" broken)', [
            { action: "request", method: "POST", path: "/api/notes", body: { title: "" }, description: 'Send it again with "title" breaking a documented rule' },
            { action: "assertResponse", check: "status", expected: 400, description: "Refused with the documented HTTP 400" },
        ]);
        const r = buildFindingReport({ members: [view({ title: spec.title, observed: "Expected 400, got 201", attempts: failedThrice({ failedStep: 2, error: "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 400\nReceived: 201", requests: [{ method: "POST", path: "/api/notes", status: 201, own: true }] }) })], spec, environment: {} });
        expect(r.title).toEqual(["Failed: Refused with the documented HTTP 400 on POST /api/notes (got 201, expected 400)"]);
        expect(r.title[0]).not.toMatch(/changes nothing/);
        expect(findingIssueDraft(r).title).toBe(`[${r.severity[0]!.split(":")[0]}] Failed: Refused with the documented HTTP 400 on POST /api/notes (got 201, expected 400)`);
        // The broken value is in the step that sends it.
        expect(r.steps[0]).toBe('Send it again with "title" breaking a documented rule with {"title":""}');
    });

    it("a field the answer must not hold is named in the title and in Actual (S5), with no engine text", () => {
        const r = buildFindingReport({ members: [s5], spec: s5spec, environment: {} });
        expect(r.title).toEqual(["Failed: The answer holds no “password” on GET /api/profile (the answer has “password”)"]);
        expect(r.actual).toEqual(["The answer has a “password” field; it should have none."]);
        expect(r.expected).toEqual(["No API response contains a password or other sign-in secret (requirement 8.6) (source: 8.6)"]);
    });

    it("a rule-id title reads as the rule's text", () => {
        const r = buildFindingReport({ members: [view({ title: 'As stated: rule "R-e05b76a68e8f"', expected: { text: 'Anyone else sees "Not allowed" (403)', source: "R-e05b76a68e8f", stated: "explicit" }, observed: "I registered a new account and opened /people. The page showed Page not found." })], environment: {} });
        expect(r.title).toEqual(['Failed: Anyone else sees "Not allowed" (403)']);
    });

    it("an exploration's one-sentence observation is the title, as the filed issue's (a14)", () => {
        const r = buildFindingReport({ members: [view({ title: "Cart subtotal adds the item prices", observed: "Two items of 15.00 show a subtotal of 15.00." })], environment: {} });
        expect(r.title).toEqual(["Two items of 15.00 show a subtotal of 15.00"]);
        expect(findingIssueDraft(r).title).toMatch(/^\[\w+\] Two items of 15\.00 show a subtotal of 15\.00$/);
    });
});

describe("Expected and Actual hold no raw engine text", () => {
    it("a check's settings blob is not in Expected, and an error that repeats the headline is said once", () => {
        const sentence = "A signed-in “ben” user can open /notes/n1 and see “Ana's travel plans”, which belongs to the “ana” account";
        const r = buildFindingReport({
            members: [view({ expected: { text: '/notes/n1 is not shown to the “ben” account ({"as":"ben","path":"/notes/n1","sev":"high"})', source: "standard rule", stated: "explicit" }, observed: sentence, attempts: failedThrice({ failedStep: 2, error: `Error: Access control check failed: 1 record may be open to another account - [high] ${sentence}` }) })],
            environment: {},
        });
        expect(r.expected).toEqual(["/notes/n1 is not shown to the “ben” account (source: standard rule)"]);
        expect(r.actual).toEqual([sentence]);
    });

    it("a raw error headline is replaced by the fuller error, once, without its 'Error:' prefix (S3)", () => {
        const e = "Error: Relation check failed (4.1): discount == round(subtotal * 0.1). Values: discount = 85, subtotal = 4300.";
        const r = buildFindingReport({ members: [view({ observed: e, attempts: failedThrice({ failedStep: 1, error: e }) })], environment: {} });
        expect(r.actual).toEqual(["Relation check failed (4.1): discount == round(subtotal * 0.1). Values: discount = 85, subtotal = 4300."]);
    });
});

describe("Evidence and setup stand on their own", () => {
    it("the answers verification kept are in Evidence, masked; the discount step names its code (S3)", () => {
        const spec = apiSpec("Requirement 4.1 holds after each write", [
            { action: "request", method: "POST", path: "/api/cart/discount", body: { code: "SAVE10" }, description: "Setup: POST /api/cart/discount" },
            { action: "assertResponse", check: "statusClass", expected: 2, description: "The setup is accepted" },
        ]);
        const r = buildFindingReport({
            members: [view({ observed: "x", attempts: failedThrice({ failedStep: 2, requests: [{ method: "POST", path: "/api/cart/items", status: 201, own: true }] }) })],
            spec,
            environment: {},
            answers: [{ request: "POST /api/cart/items -> 201", body: '{"subtotal":4300,"code":"SAVE10","discount":85,"email":"buyer@example.test"}' }],
        });
        expect(r.steps[0]).toBe('Setup: POST /api/cart/discount with {"code":"SAVE10"}');
        const answer = r.evidence.find((l) => l.startsWith("Answer to"));
        expect(answer).toMatch(/^Answer to POST \/api\/cart\/items → 201: \{"subtotal":4300,"code":"SAVE10","discount":85/);
        expect(answer).not.toContain("buyer@example.test");
    });

    it("the account names its sign-in, never a password", () => {
        const accounts = new Map([["bob", "bob@shop.example.test"], ["main", "qa@shop.example.test"]]);
        expect(buildFindingReport({ members: [view({ account: "the “bob” test account" })], environment: {}, accounts }).preconditions).toContain("Signed in as the “bob” test account (bob@shop.example.test).");
        expect(buildFindingReport({ members: [s5], spec: s5spec, environment: {}, accounts }).preconditions).toContain("Signed in as the project's test account (qa@shop.example.test).");
        expect(buildFindingReport({ members: [view({ account: "the “zed” test account" })], environment: {}, accounts }).preconditions).toContain("Signed in as the “zed” test account.");
    });
});
