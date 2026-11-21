/**
 * C6 backend operations (Phase 4 T15), generated from bench-shop's own API document. Duplicate: POST /api/orders twice after what its
 * 409 names (cart, address); the repeat is refused (409, req 5.7) and the order list holds one more. Transaction: after a valid write,
 * the same write with one documented rule broken is refused and the cart (or profile) reads as before (req 3.6, 4.7). Nothing is
 * generated with data changes off. Expected values come from the API document and the requirements, not from a run of the shop.
 */
import { describe, expect, it } from "vitest";
import { backendOpsChains } from "../src/engine/api/backend-ops.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import type { DraftSpec } from "../src/engine/api/test-specs.js";
import { generateApiWorkflowSpecs } from "../src/engine/api/workflows.js";
import { comparableSpec, parseDsl, printSpec } from "../src/engine/dsl/index.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const SHOP = parseOpenApi(await benchOpenApi("bench-shop"), "http://127.0.0.1:9603/openapi.json").operations;
const requests = (s: DraftSpec) => s.steps.filter((x): x is Extract<Step, { action: "request" }> => x.action === "request");
const line = (s: DraftSpec) => requests(s).map((r) => `${r.method} ${r.path}`);
const checks = (s: DraftSpec) => s.steps.filter((x): x is Extract<Step, { action: "assertResponse" }> => x.action === "assertResponse");
const chains = backendOpsChains(SHOP).map((c) => c.spec);
const titled = (t: string) => {
    const s = chains.find((x) => x.title.startsWith(t));
    if (!s) throw new Error(`no chain "${t}"; have ${chains.map((c) => c.title).join(" | ")}`);
    return s;
};

describe("C6 duplicate operation", () => {
    it("POST /api/orders twice on a fresh account: the repeat gets the documented 409, the list one more", () => {
        const s = titled("Backend: the same write twice makes one record (POST /api/orders)");
        expect(line(s)).toEqual(["POST /api/register", "GET /api/products", "POST /api/cart/items", "POST /api/checkout/address", "GET /api/orders", "POST /api/orders", "POST /api/orders", "GET /api/orders"]);
        const [first, second] = requests(s).filter((r) => r.method === "POST" && r.path === "/api/orders");
        expect(second!.body).toEqual(first!.body);
        expect(requests(s)[4]!.extract).toEqual({ listBefore: "orders" });
        expect(checks(s)).toContainEqual(expect.objectContaining({ check: "status", expected: 409 }));
        expect(checks(s).at(-1)).toMatchObject({ check: "relation", expression: "count(orders) == count($listBefore) + 1" });
    });
    it("sign-up and sign-in writes get no duplicate chain (C2 covers the sign-up's own 409)", () => {
        expect(chains.filter((c) => /register|login/.test(c.title))).toEqual([]);
    });
});

describe("C6 transaction: a refused write changes nothing", () => {
    it("POST /api/cart/discount: SAVE10 applied, then an unknown code refused (400), and every cart field reads as before", () => {
        const s = titled("Backend: a refused write changes nothing (POST /api/cart/discount");
        const writes = requests(s).filter((r) => r.path === "/api/cart/discount");
        expect(writes.map((w) => w.body)).toEqual([{ code: "SAVE10" }, { code: "not-a-code-{{unique}}" }]);
        expect(requests(s).find((r) => r.extract?.recordBefore !== undefined)).toMatchObject({ method: "GET", path: "/api/cart" });
        expect(checks(s)).toContainEqual(expect.objectContaining({ check: "status", expected: 400 }));
        const rel = checks(s).filter((c) => c.check === "relation").map((c) => c.expression);
        expect(rel).toEqual(["lines == $recordBefore.lines", "subtotal == $recordBefore.subtotal", "code == $recordBefore.code", "discount == $recordBefore.discount", "shipping == $recordBefore.shipping", "total == $recordBefore.total"]);
    });
    it("POST /api/cart/items breaks its documented maximum (11), PUT /api/profile an empty name; both read their record back", () => {
        const items = titled("Backend: a refused write changes nothing (POST /api/cart/items");
        expect(requests(items).filter((r) => r.path === "/api/cart/items").map((r) => (r.body as { quantity: number }).quantity)).toEqual([1, 11]);
        const profile = titled("Backend: a refused write changes nothing (PUT /api/profile");
        expect(requests(profile).filter((r) => r.method === "PUT").map((r) => (r.body as { name: string }).name)).toEqual([expect.stringContaining("{{unique}}"), ""]);
        expect(line(profile)).toContain("GET /api/profile");
    });
});

describe("C6 chains as stored tests", () => {
    it("are valid, survive a DSL round trip, and render as API scripts", () => {
        for (const d of chains) {
            const spec = TestSpecSchema.parse({ ...d, testId: "API-001" });
            const printed = printSpec(spec);
            expect(printed.reasons, printed.text).toEqual([]);
            const back = parseDsl(printed.text);
            expect(back.diagnostics, printed.text).toEqual([]);
            expect(comparableSpec(back.spec!)).toBe(comparableSpec(spec));
            expect(() => renderScript(spec, "playwright-api", { baseUrl: "http://127.0.0.1:9603" })).not.toThrow();
        }
    });
    it("data-change gate: none is generated with data changes off, all with them on", () => {
        const tagged = (on: boolean) => generateApiWorkflowSpecs(SHOP, { allowMutating: on, maxWorkflows: 100 }).specs.filter((s) => s.tags.includes("backend"));
        expect(tagged(false)).toEqual([]);
        expect(tagged(true).map((s) => s.title).sort()).toEqual(chains.map((s) => s.title).sort());
    });
});
