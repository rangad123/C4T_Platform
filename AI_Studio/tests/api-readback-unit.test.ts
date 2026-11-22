/**
 * C9 read-back chains (Phase 4 T14), generated from bench-shop's own API document: PUT /api/profile then GET /api/profile returns the
 * written fields; POST /api/orders (after the cart and address its 409 names) twice, then the list holds both ids and the detail the
 * created one. Expected values come from the API document and requirements 5.5, 5.7, 6.3 and 7.3, not from a run of the shop.
 */
import { describe, expect, it } from "vitest";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import type { DraftSpec } from "../src/engine/api/test-specs.js";
import { generateApiWorkflowSpecs } from "../src/engine/api/workflows.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const SHOP = parseOpenApi(await benchOpenApi("bench-shop"), "http://127.0.0.1:9602/openapi.json").operations;
const RBAC = parseOpenApi(await benchOpenApi("bench-rbac"), "http://127.0.0.1:9603/openapi.json").operations;
const requests = (s: DraftSpec) => s.steps.filter((x): x is Extract<Step, { action: "request" }> => x.action === "request");
const line = (s: DraftSpec) => requests(s).map((r) => `${r.method} ${r.path}`);
const checks = (s: DraftSpec) => s.steps.filter((x): x is Extract<Step, { action: "assertResponse" }> => x.action === "assertResponse");
const gen = (allowMutating: boolean) => generateApiWorkflowSpecs(SHOP, { allowMutating, maxWorkflows: 50 }).specs;
const named = (title: string) => {
    const s = gen(true).find((x) => x.title.startsWith(title));
    if (!s) throw new Error(`no workflow "${title}"`);
    return s;
};

describe("C9 read-back chains on bench-shop", () => {
    it("PUT /api/profile, then GET /api/profile returns the written name and address, on a fresh account", () => {
        const s = named("Workflow: what is written is read back (PUT /api/profile");
        expect(line(s)).toEqual(["POST /api/register", "PUT /api/profile", "GET /api/profile"]);
        const put = requests(s)[1]!;
        const body = put.body as Record<string, string>;
        // New values, told apart from the fresh account's own (registered with the plain {{unique}}).
        expect(body.name).toContain("{{unique}}w");
        expect(body.address).toContain("{{unique}}w");
        expect(body.address.length).toBeLessThanOrEqual(200);
        const tail = s.steps.slice(s.steps.indexOf(requests(s)[2]!));
        expect(tail).toContainEqual(expect.objectContaining({ check: "jsonPath", path: "name", expected: body.name }));
        expect(tail).toContainEqual(expect.objectContaining({ check: "jsonPath", path: "address", expected: body.address }));
        expect(s.tags).toContain("readback");
    });

    it("POST /api/orders after the cart and the address its refusal names, twice; the list holds both ids, the detail the created one", () => {
        const s = named("Workflow: order lifecycle");
        const setup = ["GET /api/products", "POST /api/cart/items", "POST /api/checkout/address"];
        expect(line(s)).toEqual(["POST /api/register", ...setup, "POST /api/orders", "GET /api/orders/{{orderId}}", ...setup, "POST /api/orders", "GET /api/orders"]);
        const [, , addItem, address, order] = requests(s);
        expect(addItem!.body).toEqual({ productId: "{{productId}}", quantity: 1 });
        expect((address!.body as { address: string }).address.length).toBeGreaterThanOrEqual(5);
        expect(order!.extract).toEqual({ orderId: "id" });
        expect(requests(s)[9]!.extract).toEqual({ orderId2: "id" });
        expect(checks(s)).toContainEqual(expect.objectContaining({ check: "jsonPath", path: "id", expected: "{{orderId}}" }));
        expect(checks(s).at(-1)).toMatchObject({ check: "relation", expression: "contains(orders[*].id, $orderId) and contains(orders[*].id, $orderId2)" });
    });

    it("every read-back chain is a valid stored test and renders as an API script", () => {
        for (const s of gen(true).filter((x) => x.tags.includes("readback"))) {
            const spec = TestSpecSchema.parse({ ...s, testId: "API-001" });
            expect(() => renderScript(spec, "playwright-api", { baseUrl: "http://127.0.0.1:9602" })).not.toThrow();
        }
    });

    it("with data changes off, no read-back chain is generated", () => {
        expect(gen(false).filter((s) => s.tags.includes("readback") || requests(s).some((r) => r.method !== "GET"))).toEqual([]);
    });

    it("an update without a documented body sends the create's body: bench-rbac's PUT /api/notes/{id} gets a title (a bodiless PUT is refused on the clean app)", () => {
        const s = generateApiWorkflowSpecs(RBAC, { allowMutating: true, maxWorkflows: 50 }).specs.find((x) => x.title.startsWith("Workflow: note lifecycle"));
        expect(s).toBeDefined();
        const put = requests(s!).find((r) => r.method === "PUT")!;
        expect(put.path).toBe("/api/notes/{{noteId}}");
        expect((put.body as { title?: string }).title).toContain("{{unique}}u");
    });
});

describe("a sub-resource, then its parent deleted (the stored data must not keep the sub-resource)", () => {
    it("bench-rbac: a second person, a fresh account, a note shared with that person, the note deleted and gone", () => {
        const s = generateApiWorkflowSpecs(RBAC, { allowMutating: true, maxWorkflows: 50 }).specs.find((x) => x.title.startsWith("Workflow: delete a note that has a share"));
        expect(s).toBeDefined();
        expect(line(s!)).toEqual(["POST /api/register", "POST /api/register", "POST /api/notes", "POST /api/notes/{{noteId}}/share", "DELETE /api/notes/{{noteId}}", "GET /api/notes/{{noteId}}"]);
        const [other, , , share] = requests(s!);
        // The sub-resource names the other person, made first, by the address it registered with.
        expect((share!.body as { email: string }).email).toBe((other!.body as { email: string }).email);
        expect(s!.tags).toEqual(expect.arrayContaining(["mutating", "subresource"]));
        expect(checks(s!).at(-1)).toMatchObject({ check: "statusClass", expected: "4xx" });
    });

    it("is not made without a documented body for the sub-resource, or without data changes", () => {
        const noBody = RBAC.map((e) => (e.path === "/api/notes/{id}/share" && e.method === "POST" ? { ...e, spec: { ...e.spec!, requestBody: undefined } } : e));
        expect(generateApiWorkflowSpecs(noBody, { allowMutating: true, maxWorkflows: 50 }).specs.some((x) => x.tags.includes("subresource"))).toBe(false);
        expect(generateApiWorkflowSpecs(RBAC, { allowMutating: false, maxWorkflows: 50 }).specs.some((x) => x.tags.includes("subresource"))).toBe(false);
    });
});

describe("the list check on a paged list (a page may not hold the new records)", () => {
    it("with paging documented, each new record is read by its own address instead; without paging the list check stays", () => {
        const paged = SHOP.map((e) => (e.method === "GET" && e.path === "/api/orders" ? { ...e, spec: { ...e.spec!, parameters: [...(e.spec?.parameters ?? []), { name: "page", location: "query" as const, required: false, type: "integer" }] } } : e));
        const s = generateApiWorkflowSpecs(paged, { allowMutating: true, maxWorkflows: 50 }).specs.find((x) => x.title.startsWith("Workflow: order lifecycle"))!;
        expect(checks(s).some((c) => c.check === "relation" && /contains\(orders/.test(String(c.expression)))).toBe(false);
        expect(line(s).slice(-2)).toEqual(["GET /api/orders/{{orderId}}", "GET /api/orders/{{orderId2}}"]);
        expect(checks(s).at(-1)).toMatchObject({ check: "jsonPath", path: "id", expected: "{{orderId2}}" });
        // The shop's own list has no paging: the list check (BS-12) is kept.
        expect(checks(named("Workflow: order lifecycle")).at(-1)).toMatchObject({ check: "relation" });
    });
});
