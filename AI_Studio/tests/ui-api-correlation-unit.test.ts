/**
 * UI–API correlation, the pure part (Phase 4 C4, web/correlation.ts): which writes get a read-back, and the read-back check judged on
 * the real answers. A stored write holds; a write the read-back does not show is a disagreement whose saved check is the same relation.
 * Expected values come from bench-shop's requirements: 7.3 (saved details are the account's from then on) and 6.3 (the Orders page
 * lists all of the customer's orders).
 */
import { describe, expect, it } from "vitest";
import { CandidateFindingSchema, findingFingerprint } from "../src/engine/explore/finding.js";
import { parseDsl } from "../src/engine/dsl/parser.js";
import { comparableSpec, printSpec } from "../src/engine/dsl/printer.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { checkRelation } from "../src/engine/validation/relation.js";
import { errorShown, fitsTemplate, readBackCheck, readBackOf, type RawCall } from "../src/engine/web/correlation.js";

const apis = [
    { method: "GET", path: "/api/profile" },
    { method: "GET", path: "/api/orders" },
    { method: "GET", path: "/api/orders/{id}" },
];
const put: RawCall = { step: 3, method: "PUT", path: "/api/profile", status: 200, sent: { name: "Alice", address: "1 New Road" }, json: { name: "Alice", email: "a@x.test", address: "1 New Road" }, text: "" };
const post: RawCall = { step: 5, method: "POST", path: "/api/orders", status: 201, json: { id: "ord-1002", total: 925 }, text: "" };

describe("which writes are read back", () => {
    it("a successful PUT, PATCH or POST with an id, when a GET of the same path is documented", () => {
        expect(readBackOf(put, apis)).toEqual({ path: "/api/profile" });
        expect(readBackOf({ ...put, method: "PATCH" }, apis)).toEqual({ path: "/api/profile" });
        expect(readBackOf(post, apis)).toEqual({ path: "/api/orders" });
        expect(readBackOf({ ...put, path: "/api/orders/ord-1002" }, apis)).toEqual({ path: "/api/orders/ord-1002" });
    });
    it("not a failed write, a POST without an id, a DELETE, a non-JSON answer, or a path without a documented GET", () => {
        expect(readBackOf({ ...put, status: 400 }, apis)).toBeUndefined();
        expect(readBackOf({ ...post, json: { lines: [] } }, apis)).toBeUndefined();
        expect(readBackOf({ ...put, method: "DELETE" }, apis)).toBeUndefined();
        expect(readBackOf({ ...put, json: undefined }, apis)).toBeUndefined();
        expect(readBackOf({ ...post, path: "/api/orders/ord-1/pay" }, apis)).toBeUndefined();
    });
    it("templates match one whole segment each", () => {
        expect(fitsTemplate("/api/orders/{id}", "/api/orders/ord-1")).toBe(true);
        expect(fitsTemplate("/api/orders/{id}", "/api/orders/ord-1/pay")).toBe(false);
        expect(fitsTemplate("/api/orders/{id}", "/api/orders/")).toBe(false);
        expect(fitsTemplate("/api/profile", "/api/profile?x=1")).toBe(true);
    });
});

describe("the read-back check (7.3 and 6.3)", () => {
    it("PUT: the written fields read back as written hold; a field read back with its old value fails, and the saved check is that relation", () => {
        expect(readBackCheck(put, { status: 200, json: { name: "Alice", email: "a@x.test", address: "1 New Road" } })).toEqual({ held: true });
        const r = readBackCheck(put, { status: 200, json: { name: "Alice", email: "a@x.test", address: "12 Harbour Street, Leeds" } });
        expect(r?.held).toBe(false);
        const steps = r!.disagreement!.steps("7.3");
        expect(steps).toEqual([
            expect.objectContaining({ action: "wait", until: "response", value: "/api/profile", extract: { sent_name: "name", sent_address: "address" } }),
            expect.objectContaining({ action: "request", method: "GET", path: "/api/profile" }),
            expect.objectContaining({ action: "assertResponse", check: "relation", expression: "name == $sent_name and address == $sent_address", source: "7.3" }),
        ]);
        expect(r!.disagreement!.observed).toMatch(/Relation check failed: name == \$sent_name and address == \$sent_address\..*address = "12 Harbour Street, Leeds"/);
        expect(r!.disagreement!.layers.map((l) => l.layer)).toEqual(["api", "stored data"]);
        expect(r!.disagreement!.requests).toEqual(["PUT /api/profile answered 200", "GET /api/profile answered 200"]);
    });
    it("PUT: only fields the request sent and the answer echoes are compared (the email it did not send may differ)", () => {
        expect(readBackCheck(put, { status: 200, json: { name: "Alice", email: "other@x.test", address: "1 New Road" } })).toEqual({ held: true });
        expect(readBackCheck({ ...put, sent: { nickname: "A" } }, { status: 200, json: { name: "B" } })).toBeUndefined();
    });
    it("a number-like text that would not read back as itself is not compared", () => {
        const zip: RawCall = { ...put, sent: { zip: "01234" }, json: { zip: "01234" } };
        expect(readBackCheck(zip, { status: 200, json: { zip: "99999" } })).toBeUndefined();
    });
    it("POST: the list holding the new id holds; a list without it fails, with the saved relation over the list", () => {
        expect(readBackCheck(post, { status: 200, json: { orders: [{ id: "ord-1002" }, { id: "ord-1000" }] } })).toEqual({ held: true });
        const r = readBackCheck(post, { status: 200, json: { orders: [{ id: "ord-1000" }] } });
        expect(r?.held).toBe(false);
        const check = r!.disagreement!.steps("6.3").at(-1) as { expression: string };
        expect(check.expression).toBe("contains(orders[*].id, $created_id)");
        // The saved relation is the one judged: it fails on that list and holds on one with the id.
        expect(checkRelation(check.expression, { body: { orders: [{ id: "ord-1000" }] }, vars: { created_id: "ord-1002" } }).held).toBe(false);
        expect(readBackCheck(post, { status: 200, json: [{ id: "ord-1002" }] })).toEqual({ held: true });
        expect(readBackCheck(post, { status: 200, json: { total: 3 } })).toBeUndefined();
    });
});

it("the error check: the saved step is that the success message is not shown", () => {
    const d = errorShown({ ...put, status: 500 }, "Saved.");
    expect(d.steps("7.4")).toEqual([expect.objectContaining({ action: "assert", check: "hidden", locator: { by: "text", value: "Saved.", exact: true }, source: "7.4" })]);
    expect(d.layers).toEqual([
        { layer: "page", observed: 'shows "Saved." (a status message)' },
        { layer: "api", observed: "PUT /api/profile answered 500" },
    ]);
});

it("the saved tests these checks make read back as themselves in text", () => {
    const act: Step[] = [
        { action: "navigate", url: "/account", description: "" },
        { action: "click", locator: { by: "role", role: "button", value: "Save" }, description: "" },
    ];
    const ends = [
        readBackCheck(put, { status: 200, json: { name: "Bob", address: "old" } })!.disagreement!.steps("expected:1"),
        readBackCheck(post, { status: 200, json: { orders: [] } })!.disagreement!.steps("6.3"),
        errorShown({ ...put, status: 500 }, "Saved.").steps("expected:2"),
    ];
    for (const end of ends) {
        const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Correlation check", kind: "web", steps: [...act, ...end] });
        const printed = printSpec(spec);
        expect(printed.reasons, printed.text).toEqual([]);
        const back = parseDsl(printed.text);
        expect(back.diagnostics, printed.text).toEqual([]);
        expect(comparableSpec(back.spec!)).toBe(comparableSpec(spec));
    }
});

it("a finding carries the layers that disagreed, masked like its other evidence; an unknown layer is refused", () => {
    const finding = (layers: unknown) => ({
        objective: null, actions: { stepCount: 3 }, expected: { text: "Saved details are kept", source: "7.3" }, observed: "The stored data does not hold it",
        evidence: { screenshots: [], requests: ["PUT /api/profile answered 200"], console: [], layers },
        capture: "captured", independence: "not_run", confidence: "medium", fingerprint: findingFingerprint({ source: "7.3", expected: "x", scenario: "y" }), modelVersion: null, replays: [],
    });
    const ok = CandidateFindingSchema.safeParse(finding([{ layer: "stored data", observed: "GET /api/profile reads ann@x.test" }]));
    expect(ok.success && ok.data.evidence.layers).toEqual([{ layer: "stored data", observed: "GET /api/profile reads [email hidden]" }]);
    expect(CandidateFindingSchema.safeParse(finding([{ layer: "database", observed: "x" }])).success).toBe(false);
    expect(CandidateFindingSchema.safeParse(finding(undefined)).success).toBe(true);
});
