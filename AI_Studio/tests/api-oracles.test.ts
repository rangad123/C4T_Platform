/**
 * C2 (Phase 4): documented cases. Each one breaks one rule the API document states and expects the status the document gives for it.
 * The documents are tests/fixtures/bench-openapi.ts (the bench apps' own, as the bench extension makes them). Expected values come from
 * those documents and the requirements, never from a run.
 */
import { describe, expect, it } from "vitest";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateApiSpecs, type DraftSpec } from "../src/engine/api/test-specs.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { RBAC_OPENAPI, SHOP_OPENAPI } from "./fixtures/bench-openapi.js";

const SHOP = SHOP_OPENAPI;
const RBAC = RBAC_OPENAPI;

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
