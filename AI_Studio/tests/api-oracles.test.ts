/**
 * C2 (Phase 4): documented cases. Each one breaks one rule the API document states and expects the status the document gives for it.
 * The documents are the bench apps' own (fetched from examples/bench-*). Expected values come from those documents and the
 * requirements, never from a run.
 */
import { describe, expect, it } from "vitest";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateApiSpecs, type DraftSpec } from "../src/engine/api/test-specs.js";
import { loadContractRuntime } from "../src/engine/contracts/check.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const SHOP = await benchOpenApi("bench-shop");
const RBAC = await benchOpenApi("bench-rbac");

const gen = (doc: object, allowMutating = true) => generateApiSpecs(parseOpenApi(doc, "http://127.0.0.1:9/openapi.json").operations, { allowMutating, maxPerEndpoint: 6 }).specs;
const find = (specs: DraftSpec[], title: string) => {
    const s = specs.find((x) => x.title === title);
    if (!s) throw new Error(`no test "${title}" among:\n${specs.map((x) => x.title).join("\n")}`);
    return s;
};
const requests = (s: DraftSpec) => s.steps.filter((x): x is Extract<Step, { action: "request" }> => x.action === "request");
const statusOf = (s: DraftSpec) => s.steps.find((x) => x.action === "assertResponse" && x.check === "status") as Extract<Step, { action: "assertResponse" }> | undefined;
const fresh = (s: DraftSpec) => requests(s)[0]?.method === "POST" && requests(s)[0]?.path === "/api/register";

describe("documented cases (C2)", () => {
    const shop = gen(SHOP);
    const rbac = gen(RBAC);

    it("BS-03: quantity 11 on a real product, on a fresh account, expects the documented 400", () => {
        const s = find(shop, 'POST /api/cart/items: rejects "quantity" above its maximum (10)');
        const r = requests(s);
        expect(fresh(s)).toBe(true);
        expect(r[1]).toMatchObject({ method: "GET", path: "/api/products", extract: { productId: "products.0.id" } });
        expect(r[2]).toMatchObject({ method: "POST", path: "/api/cart/items", body: { productId: "{{productId}}", quantity: 11 } });
        expect(statusOf(s)?.expected).toBe(400);
    });

    it("BS-04: an address that is not an email expects the documented 400, and the answer is checked against its schema", () => {
        const s = find(shop, 'POST /api/register: rejects "email" not an email address');
        expect(requests(s)).toHaveLength(1);
        expect(requests(s)[0]!.body).toMatchObject({ email: "not-an-email" });
        expect(statusOf(s)?.expected).toBe(400);
        expect(s.steps.at(-1)).toMatchObject({ check: "matchesSchema", schema: { required: ["error"] } });
    });

    it("BS-09: an unknown product expects the documented 404", () => {
        const s = find(shop, 'POST /api/cart/items: rejects an unknown "productId"');
        expect(requests(s).at(-1)!.body).toMatchObject({ productId: "does-not-exist-000" });
        expect(statusOf(s)?.expected).toBe(404);
    });

    it("the happy path adds a real product, not a made-up id", () => {
        const s = find(shop, "POST /api/cart/items: succeeds with a valid request");
        expect(requests(s).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/products", "POST /api/cart/items"]);
        expect(requests(s)[1]!.body).toMatchObject({ productId: "{{productId}}" });
    });

    it("BS-17: the same email in other letter case expects the documented 409; so does the exact duplicate", () => {
        const s = find(shop, 'POST /api/register: rejects an "email" already used, in other letter case');
        const [a, b] = requests(s);
        expect((a!.body as Record<string, string>).email).toBe("qa+{{unique}}@example.com");
        expect((b!.body as Record<string, string>).email).toBe("QA+{{unique}}@EXAMPLE.COM");
        expect(statusOf(s)?.expected).toBe(409);
        expect(statusOf(find(shop, "POST /api/register: rejects the same request twice (a duplicate)"))?.expected).toBe(409);
    });

    it("the case-folded email case is made only when a requirement or the API document says emails ignore letter case", () => {
        const title = 'POST /api/register: rejects an "email" already used, in other letter case';
        // bench-shop's document says so on its 409; bench-rbac's does not
        expect(shop.map((s) => s.title)).toContain(title);
        expect(rbac.map((s) => s.title)).not.toContain(title);
        const doc: any = structuredClone(SHOP);
        doc.paths["/api/register"].post.responses[409].description = "Email already used";
        const plain = gen(doc);
        expect(plain.map((s) => s.title)).not.toContain(title);
        expect(plain.map((s) => s.title)).toContain("POST /api/register: rejects the same request twice (a duplicate)");
        const stated = (text: string) => generateApiSpecs(parseOpenApi(doc, "http://127.0.0.1:9/openapi.json").operations, { allowMutating: true, maxPerEndpoint: 6, requirementsText: text }).specs.map((s) => s.title);
        expect(stated("- 1.9 Email addresses are not case-sensitive and spaces around them are ignored.")).toContain(title);
        // a case rule about something else is not a rule about emails
        expect(stated("- 4.2 Codes are accepted in any letter case.\n- 1.1 Register with an email address.")).not.toContain(title);
    });

    it("BS-19: an order read with a real id from the list is checked against the documented schema (total in integer cents)", () => {
        const s = find(shop, "GET /api/orders/{id}: succeeds with a valid request");
        expect(requests(s)).toMatchObject([{ method: "GET", path: "/api/orders", extract: { id: "orders.0.id" } }, { method: "GET", path: "/api/orders/{{id}}" }]);
        expect(s.steps.at(-1)).toMatchObject({ check: "matchesSchema", schema: { properties: { total: { type: "integer" } } } });
    });

    it("BR-07: a 7-character password expects the documented 400", () => {
        const s = find(rbac, 'POST /api/register: rejects "password" shorter than 8 characters');
        expect(requests(s)[0]!.body).toMatchObject({ password: "aaaaaaa" });
        expect(statusOf(s)?.expected).toBe(400);
    });

    it("BR-08: an empty title, on a fresh account, expects the documented 400; so does a 121-character one", () => {
        const s = find(rbac, 'POST /api/notes: rejects "title" empty');
        expect(fresh(s)).toBe(true);
        expect(requests(s).at(-1)!.body).toMatchObject({ title: "" });
        expect(statusOf(s)?.expected).toBe(400);
        expect(requests(find(rbac, 'POST /api/notes: rejects "title" longer than 120 characters')).at(-1)!.body).toMatchObject({ title: "a".repeat(121) });
    });

    it("none is generated with data changes off", () => {
        for (const specs of [gen(SHOP, false), gen(RBAC, false)]) expect(specs.filter((s) => s.tags.includes("documented"))).toEqual([]);
    });

    it("no documented status, no case: an endpoint that documents no 400 gets no constraint case", () => {
        const doc: any = structuredClone(RBAC);
        delete doc.paths["/api/notes"].post.responses[400];
        expect(gen(doc).filter((s) => s.title.startsWith("POST /api/notes") && s.tags.includes("documented"))).toEqual([]);
    });

    it("a reference with no real id to take: no case that a made-up id would turn into 404, but the unknown-reference case stays", () => {
        const doc: any = structuredClone(SHOP);
        delete doc.paths["/api/products"].get.responses[200].content;
        const cart = gen(doc).filter((s) => s.title.startsWith("POST /api/cart/items") && s.tags.includes("documented"));
        expect(cart.map((s) => s.title)).toEqual(['POST /api/cart/items: rejects an unknown "productId"']);
    });

    it("every case renders to an API script", () => {
        for (const [i, d] of [...shop, ...rbac].filter((s) => s.tags.includes("documented")).entries()) {
            const spec = TestSpecSchema.parse({ ...d, testId: `API-${String(i + 1).padStart(3, "0")}` });
            expect(renderScript(spec, "playwright-api", { baseUrl: "http://127.0.0.1:9" }).content).toContain("await call(request");
        }
    });
});

// ── Q6: the response-schema check judges every form the API document gives (JSON Schema oneOf / anyOf / allOf), in its own plain
// words, instead of skipping the node. Expected verdicts follow JSON Schema's meaning of the keywords.
const rt = loadContractRuntime();
/** The failure lines for a value, or [] when it conforms. */
function lines(value: unknown, schema: unknown): string[] {
    try {
        rt.contractAssert(value, schema);
        return [];
    } catch (e) {
        return String((e as Error).message).split("\n").slice(1);
    }
}
const either = { oneOf: [{ type: "object", required: ["a"], properties: { a: { type: "string" } } }, { type: "object", required: ["b"], properties: { b: { type: "integer" } } }] };
const maybeDate = { anyOf: [{ type: "string", format: "date" }, { type: "null" }] };

describe("the contract check with documented forms", () => {
    it("passes a response that matches one of the documented forms (oneOf / anyOf)", () => {
        expect(lines({ a: "x" }, either)).toEqual([]);
        expect(lines({ b: 3 }, either)).toEqual([]);
        expect(lines(null, maybeDate)).toEqual([]);
        expect(lines("2024-01-01", maybeDate)).toEqual([]);
        expect(lines([{ b: 1 }, { a: "y" }], { type: "array", items: either })).toEqual([]);
    });

    it("reports a response that matches none of the forms, with the nearest form's difference and its severity", () => {
        expect(lines({ b: "3" }, either)).toEqual(["- [high] response: matches none of the 2 documented forms; nearest: response.b: expected integer, got string"]);
        expect(lines({ c: 1 }, either)).toEqual(["- [high] response: matches none of the 2 documented forms; nearest: response.a: is missing, but the documentation marks it required"]);
        expect(lines({ a: 1 }, { anyOf: either.oneOf })).toHaveLength(1);
        expect(lines(5, maybeDate)).toEqual(["- [high] response: matches none of the 2 documented forms; nearest: response: expected string, got integer"]);
        expect(lines("soon", maybeDate)).toEqual(['- [low] response: matches none of the 2 documented forms; nearest: response: "soon" is not a valid date']);
        // a "null" form is a real constraint, not an empty one
        expect(lines(5, { type: "null" })).toEqual(["- [high] response: expected null, got integer"]);
    });

    it("a part of allOf that allows no extra fields refuses only fields no part documents, once the document is read", () => {
        const doc = { openapi: "3.0.0", info: { title: "t", version: "1" }, paths: { "/x": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { allOf: [{ type: "object", additionalProperties: false, properties: { id: { type: "integer" } } }, { properties: { name: { type: "string" } } }] } } } } } } } } };
        const schema = parseOpenApi(doc, "http://x/openapi.json").operations[0]!.spec!.responses[0]!.schema;
        expect(lines({ id: 1, name: "n" }, schema)).toEqual([]);
        expect(lines({ id: 1, name: "n", secret: "s" }, schema)).toEqual(["- [low] response.secret: is not documented (the documentation allows no extra fields)"]);
    });

    it("judges allOf as every part at once", () => {
        const named = { allOf: [{ type: "object", required: ["id"], properties: { id: { type: "integer" } } }, { required: ["name"], properties: { name: { type: "string", maxLength: 3 } } }] };
        expect(lines({ id: 1, name: "abc" }, named)).toEqual([]);
        expect(lines({ id: "1", name: "abcd" }, named)).toEqual(["- [high] response.id: expected integer, got string", "- [medium] response.name: is longer than the documented maximum of 3 characters"]);
    });

    it("still skips a node an older parser kept only partly (marked, with no forms)", () => {
        expect(lines({ b: 3 }, { type: "object", required: ["a"], "x-aitp-lossy": true })).toEqual([]);
    });
});

describe("the API document's forms reach the check", () => {
    const doc = {
        openapi: "3.0.0",
        info: { title: "t", version: "1" },
        components: { schemas: { Status: { type: "string", enum: ["active", "disabled"] }, Base: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } },
        paths: {
            "/either": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: either } } } } } },
            "/thing": {
                get: {
                    responses: {
                        "200": {
                            description: "ok",
                            content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object", properties: { status: { allOf: [{ $ref: "#/components/schemas/Status" }], description: "state" } } }] } } },
                        },
                    },
                },
            },
        },
    };
    const endpoints = parseOpenApi(doc, "http://x/openapi.json").operations;

    it("the attached schema keeps every oneOf form, and the check judges the response against each", () => {
        const spec = generateApiSpecs(endpoints, { allowMutating: false, maxPerEndpoint: 6 }).specs.find((s) => s.title.startsWith("GET /either") && s.title.endsWith("succeeds with a valid request"))!;
        const step = spec.steps.find((x) => x.action === "assertResponse" && x.check === "matchesSchema");
        if (step?.action !== "assertResponse") throw new Error("no schema check on GET /either");
        expect((step.schema as { oneOf?: unknown[] }).oneOf).toHaveLength(2);
        expect(lines({ b: 3 }, step.schema)).toEqual([]);
        expect(lines({ a: 3 }, step.schema)).toHaveLength(1);
    });

    it("an allOf around a reference keeps the referenced type (no object forced on a string)", () => {
        const schema = endpoints.find((e) => e.path === "/thing")!.spec!.responses[0]!.schema;
        expect(lines({ id: 1, status: "active" }, schema)).toEqual([]);
        expect(lines({ status: "gone" }, schema)).toEqual(["- [high] response.id: is missing, but the documentation marks it required", '- [medium] response.status: "gone" is not one of the documented values (active, disabled)']);
    });
});
