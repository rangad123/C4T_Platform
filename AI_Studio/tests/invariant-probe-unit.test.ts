/**
 * C5 invariant probe (Phase 4 T13) without a browser or a server: an in-memory shop with bench-shop's cart rules stands in for the
 * application. Expected values come from the requirements: 3.9 (subtotal is the sum of the line totals) and 4.5 (free shipping from
 * $50.00 after the discount).
 */
import { describe, expect, it } from "vitest";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { aimedCases, expressionConstants, generateCase, MAX_PROBE_WRITES, MAX_SHRINK_REQUESTS, probeInvariant, withValues, type ProbeEnv, type ProbeHttp } from "../src/engine/api/probes.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { checkRelation, parseRelation } from "../src/engine/validation/relation.js";
import type { Invariant } from "../src/engine/validation/invariants.js";

const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: object) => ({ content: { "application/json": { schema } } });
const DOC = {
    openapi: "3.0.3",
    info: { title: "Shop", version: "1" },
    paths: {
        "/api/register": { post: { requestBody: json({ type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } }), responses: { 201: { description: "Created" } } } },
        "/api/products": { get: { responses: { 200: { description: "Products", ...json({ type: "object", properties: { products: { type: "array", items: { type: "object", properties: { id: { type: "string" }, price: { type: "integer" } } } } } }) } } } },
        "/api/cart/items": { post: { requestBody: json({ type: "object", required: ["productId"], properties: { productId: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 10 } } }), responses: { 201: { description: "Added", ...json(ref("Cart")) }, 400: { description: "Invalid" } } } },
    },
    components: { schemas: { Cart: { type: "object", properties: { lines: { type: "array", items: { type: "object", properties: { lineTotal: { type: "integer" } } } }, subtotal: { type: "integer" }, discount: { type: "integer" }, shipping: { type: "integer" } } } } },
};
const APIS = parseOpenApi(DOC, "http://shop.test/openapi.json").operations;
const PRODUCTS = [
    { id: "p1", price: 1250 },
    { id: "p2", price: 3450 },
    { id: "p3", price: 425 },
];

/** The shop: one cart per account (a sign-up starts a new one). `defect` switches a bench seed's behaviour on. */
function shop(defect?: "BS-02" | "BS-11") {
    let requests = 0;
    const env: ProbeEnv & { requests: () => number } = {
        apis: APIS,
        dataChanges: true,
        requests: () => requests,
        async newClient(): Promise<ProbeHttp> {
            let lines: Array<{ productId: string; quantity: number }> = [];
            return {
                async send(method, path, body) {
                    requests++;
                    const b = (body ?? {}) as Record<string, unknown>;
                    if (path === "/api/register") return { status: 201, json: {} };
                    if (path === "/api/products") return { status: 200, json: { products: PRODUCTS } };
                    if (method === "POST" && path === "/api/cart/items") {
                        const p = PRODUCTS.find((x) => x.id === b.productId);
                        const q = Number(b.quantity ?? 1);
                        if (!p) return { status: 404, json: {} };
                        const line = lines.find((l) => l.productId === p.id);
                        if ((line?.quantity ?? 0) + q > 10) return { status: 400, json: { error: "too many" } };
                        if (line) line.quantity += q;
                        else lines = [...lines, { productId: p.id, quantity: q }];
                        const priced = lines.map((l) => ({ unitPrice: PRODUCTS.find((x) => x.id === l.productId)!.price, lineTotal: PRODUCTS.find((x) => x.id === l.productId)!.price * l.quantity }));
                        const subtotal = priced.reduce((s, l, i) => s + (defect === "BS-02" && i === priced.length - 1 && priced.length > 1 ? l.unitPrice : l.lineTotal), 0);
                        const free = defect === "BS-11" ? subtotal > 5000 : subtotal >= 5000;
                        return { status: 201, json: { lines: priced, subtotal, discount: 0, shipping: free ? 0 : 500 } };
                    }
                    return { status: 404, json: {} };
                },
            };
        },
    };
    return env;
}

const SUM: Invariant = { requirementId: "3.9", endpoint: "POST /api/cart/items", setup: [], write: "POST /api/cart/items", expression: "subtotal == sum(lines[*].lineTotal)" };
const FREE: Invariant = { requirementId: "4.5", endpoint: "POST /api/cart/items", setup: [], write: "POST /api/cart/items", expression: "(subtotal - discount >= 5000) implies shipping == 0" };
const planLike = {
    write: APIS.find((a) => a.path === "/api/cart/items")!,
    refs: new Map([["productId", { values: PRODUCTS.map((p) => p.id), records: PRODUCTS }]]),
    numbers: [{ field: "quantity", min: 1, max: 10, integer: true }],
    others: new Map<string, unknown>(),
};

describe("invariant probe", () => {
    it("the same seed gives the same case; another seed another one; values stay in the documented range and the listed ids", () => {
        const a = generateCase(planLike, 7, 12);
        expect(generateCase(planLike, 7, 12)).toEqual(a);
        expect(generateCase(planLike, 8, 12)).not.toEqual(a);
        expect(a).toHaveLength(12);
        for (const w of a) {
            expect(["p1", "p2", "p3"]).toContain(w.body!.productId);
            expect(w.body!.quantity).toBeGreaterThanOrEqual(1);
            expect(w.body!.quantity).toBeLessThanOrEqual(10);
        }
    });

    it("aims at the stated amount: a cart of exactly $50.00 from the listed prices", () => {
        expect(expressionConstants(FREE.expression)).toEqual([5000]);
        expect(expressionConstants('round(x, 2) == 1 and code == "SAVE10" and y > 0.10')).toEqual([2]);
        expect(aimedCases(planLike, [5000])).toEqual([[{ path: "/api/cart/items", body: { productId: "p1", quantity: 4 }, vars: { productId: "p1", quantity: 4 } }]]);
    });

    it("sends nothing with data changes off", async () => {
        const env = { ...shop("BS-02"), dataChanges: false };
        const r = await probeInvariant(SUM, env, { seed: 1 });
        expect(r).toMatchObject({ outcome: "skipped", reason: expect.stringMatching(/data changes are off/), requests: 0 });
        expect(env.requests()).toBe(0);
        expect(r.spec).toBeUndefined();
    });

    it.each([1, 2, 3, 4, 5])("finds BS-02 with seed %i, shrinks it to two lines within the request cap, and saves the case with its seed", async (seed) => {
        const env = shop("BS-02");
        const r = await probeInvariant(SUM, env, { seed });
        expect(r.outcome).toBe("failed");
        expect(r.writes).toBeLessThanOrEqual(MAX_PROBE_WRITES);
        expect(r.case).toHaveLength(2);
        expect(r.message).toMatch(/Relation check failed/);
        // The list read, the generation run (sign-up and its writes, two of them checks), and at most 20 more while shrinking.
        expect(env.requests()).toBeLessThanOrEqual(1 + 1 + r.writes + MAX_SHRINK_REQUESTS);
        const spec = TestSpecSchema.parse({ ...r.spec, testId: "API-001" });
        expect(spec.testData.probeSeed).toBe(String(seed));
        expect(spec.steps[0]).toMatchObject({ action: "request", path: "/api/register" });
        expect(spec.steps.filter((s) => s.action === "assertResponse" && s.check === "relation")).toHaveLength(2);
        expect(spec.description).toMatch(new RegExp(`seed ${seed}\\b.*held 1 time before it failed`));
        // The same seed on the same application gives the same saved case.
        expect((await probeInvariant(SUM, shop("BS-02"), { seed })).case).toEqual(r.case);
    });

    it("finds BS-11 by the boundary aim alone, and holds on the clean shop", async () => {
        const r = await probeInvariant(FREE, shop("BS-11"), { seed: 3 });
        expect(r).toMatchObject({ outcome: "failed", held: 0, case: [{ body: { productId: "p1", quantity: 4 } }] });
        const clean = await probeInvariant(FREE, shop(), { seed: 3 });
        expect(clean.outcome).toBe("held");
        expect(clean.held).toBeGreaterThan(0);
        expect(TestSpecSchema.parse({ ...clean.spec, testId: "API-002" }).testData.probeSeed).toBe("3");
        expect((await probeInvariant(SUM, shop(), { seed: 3 })).outcome).toBe("held");
    });

    it("the saved relation carries the values each write sent, and stays inside the grammar", () => {
        const text = withValues('lineTotal == $quantity * unitPrice and name != "$quantity"', { quantity: 3 });
        expect(text).toBe('lineTotal == (3) * unitPrice and name != "$quantity"');
        expect(parseRelation(text).ok).toBe(true);
        expect(checkRelation(withValues("x == $q", { q: -2 }), { body: { x: -2 } }).held).toBe(true);
    });
});
