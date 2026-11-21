/**
 * C7 stateful sequences (Phase 4 T16) without a browser or a server: an in-memory shop with bench-shop's order rules (requirements 5.5,
 * 5.7, 6.7-6.9) stands in for the application. The state model comes from the API document alone, or from the application model's
 * stated transitions.
 */
import { describe, expect, it } from "vitest";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import type { ProbeEnv, ProbeHttp } from "../src/engine/api/probes.js";
import { MAX_SEQUENCE_SHRINK_REQUESTS, MAX_SEQUENCE_STEPS, MAX_SEQUENCES, runSequences, stateCheckSpecs, stateModels } from "../src/engine/api/stateful.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";

const json = (schema: object) => ({ content: { "application/json": { schema } } });
const ORDER = { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["placed", "paid", "shipped", "cancelled"] } } };
const doc = (o: { paySummary?: string; payConflict?: string } = {}) => ({
    openapi: "3.0.3",
    info: { title: "Shop", version: "1" },
    paths: {
        "/api/register": { post: { requestBody: json({ type: "object", properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } }), responses: { 201: { description: "Created" } } } },
        "/api/login": { post: { responses: { 200: { description: "Signed in" } } } },
        "/api/products": { get: { responses: { 200: { description: "Products", ...json({ type: "object", properties: { products: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } } }) } } } },
        "/api/cart/items": { post: { summary: "Add a product", requestBody: json({ type: "object", properties: { productId: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 10 } } }), responses: { 201: { description: "Added" } } } },
        "/api/cart/discount": { post: { summary: "Apply a discount code", responses: { 200: { description: "Applied" } } } },
        "/api/checkout/address": { post: { summary: "Set the delivery address", responses: { 200: { description: "Saved", ...json({ type: "object", properties: { address: { type: "string", minLength: 5 } } }) } } } },
        "/api/orders": {
            get: { responses: { 200: { description: "Orders", ...json({ type: "object", properties: { orders: { type: "array", items: ORDER } } }) } } },
            post: { summary: "Place an order from the cart (needs a delivery address; empties the cart)", responses: { 201: { description: "Placed", ...json(ORDER) }, 409: { description: "Cart empty or no address" } } },
        },
        "/api/orders/{id}": { get: { responses: { 200: { description: "Order", ...json(ORDER) }, 404: { description: "Not found" } } } },
        "/api/orders/{id}/pay": { post: { summary: o.paySummary ?? "Pay a placed order (once)", responses: { 200: { description: "Paid", ...json(ORDER) }, 409: { description: o.payConflict ?? "Not payable" } } } },
        "/api/orders/{id}/cancel": { post: { summary: "Cancel an order that has not shipped", responses: { 200: { description: "Cancelled", ...json(ORDER) }, 409: { description: "Shipped or already cancelled" } } } },
    },
});
const apisOf = (d: object) => parseOpenApi(d, "http://shop.test/openapi.json").operations;
const APIS = apisOf(doc());

/** One shop (its orders numbered from 1000 up); each client is a new account with its own cart and checkout. */
function shop(defect?: "BS-05" | "BS-10") {
    let next = 1000;
    let requests = 0;
    const orders: Array<{ id: string; owner: number; status: string }> = [{ id: "ord-0999", owner: 0, status: "shipped" }];
    let accounts = 0;
    const client = (owner: number): ProbeHttp => {
        let cart = 0;
        let address = false;
        return {
            async send(method, path, body) {
                requests++;
                const b = (body ?? {}) as Record<string, unknown>;
                if (path === "/api/register") return { status: 201, json: {} };
                if (path === "/api/products") return { status: 200, json: { products: [{ id: "p1" }, { id: "p2" }] } };
                if (path === "/api/cart/items") return b.productId === "p1" ? ((cart += Number(b.quantity ?? 1)), { status: 201, json: {} }) : { status: 404, json: {} };
                if (path === "/api/checkout/address") return String(b.address ?? "").length >= 5 ? ((address = true), { status: 200, json: {} }) : { status: 400, json: {} };
                if (path === "/api/orders" && method === "GET") return { status: 200, json: { orders: orders.filter((o) => o.owner === owner) } };
                if (path === "/api/orders" && method === "POST") {
                    if (!cart || (!address && defect !== "BS-10")) return { status: 409, json: {} };
                    const o = { id: `ord-${next++}`, owner, status: "placed" };
                    orders.push(o);
                    cart = 0;
                    address = false;
                    return { status: 201, json: o };
                }
                const m = /^\/api\/orders\/([\w-]+)(?:\/(pay|cancel))?$/.exec(path);
                const o = m && orders.find((x) => x.id === m[1] && x.owner === owner);
                if (!o) return { status: 404, json: {} };
                if (!m![2]) return { status: 200, json: o };
                if (m![2] === "pay") return o.status === "placed" ? ((o.status = "paid"), { status: 200, json: o }) : { status: 409, json: {} };
                if (o.status === "cancelled" || (o.status === "shipped" && defect !== "BS-05")) return { status: 409, json: {} };
                o.status = "cancelled";
                return { status: 200, json: o };
            },
        };
    };
    const credentials: boolean[] = [];
    const env: ProbeEnv & { requests: () => number; main: ProbeHttp; credentials: boolean[] } = { apis: APIS, dataChanges: true, newClient: async (credential) => (credentials.push(credential), client(++accounts)), requests: () => requests, main: client(0), credentials };
    return env;
}

describe("stateful sequences", () => {
    it("reads the state model from the API document: the conflict's named states refuse, the summary's named state allows, and what a create needs", () => {
        const [m] = stateModels(APIS);
        expect(m).toMatchObject({ entity: "orders", field: "status", states: ["placed", "paid", "shipped", "cancelled"] });
        expect(m!.actions.map((a) => [a.verb, a.allowed, a.refused])).toEqual([
            ["pay", ["placed"], ["paid", "shipped", "cancelled"]],
            ["cancel", ["placed", "paid"], ["shipped", "cancelled"]],
        ]);
        expect(m!.create!.needs.map((n) => n.label)).toEqual(["POST /api/cart/items", "POST /api/checkout/address"]);
    });

    it("takes the application model's stated transitions where the document names no state", () => {
        const apis = apisOf(doc({ paySummary: "Pay an order", payConflict: "Not possible" }));
        expect(stateModels(apis)[0]!.actions.map((a) => a.verb)).toEqual(["cancel"]);
        const pay = stateModels(apis, [{ entity: "Order", from: "Placed", to: "Paid", trigger: "Customer pays the order" }])[0]!.actions[0]!;
        expect(pay).toMatchObject({ verb: "pay", allowed: ["placed"], refused: [], to: "paid" });
    });

    it("sends nothing with data changes off", async () => {
        const env = { ...shop("BS-10"), dataChanges: false };
        expect(await runSequences(stateModels(APIS)[0]!, env, { seed: 1 })).toMatchObject({ outcome: "skipped", requests: 0 });
        expect(env.requests()).toBe(0);
    });

    it("BS-10: the precondition skip (an order without step 1) gets 201 instead of the documented 409; the finding carries the sequence log", async () => {
        const r = await runSequences(stateModels(APIS)[0]!, shop("BS-10"), { seed: 5 });
        expect(r.outcome).toBe("failed");
        expect(r.log.map((s) => [s.request, s.status, s.expected])).toEqual([
            ["POST /api/cart/items", 201, "2xx"],
            ["POST /api/orders", 201, "HTTP 409"],
        ]);
        expect(r.log[0]!.state).toBe("POST /api/cart/items: done; POST /api/checkout/address: not done");
        // Found by the precondition skips themselves, before fast-check: [address, create] held, then [items, create], each after a sign-up.
        expect([r.sequences, r.requests]).toEqual([2, 6]);
        const spec = TestSpecSchema.parse({ ...r.spec, testId: "API-001" });
        expect(spec.description).toMatch(/seed 5\b[\s\S]*1\. POST \/api\/cart\/items -> HTTP 201 \(expected 2xx\); state: /);
        expect(spec.testData.sequenceSeed).toBe("5");
        expect(spec.steps.map((s) => (s.action === "request" ? `${s.method} ${s.path}` : s.action === "assertResponse" ? `${s.check} ${s.expected}` : s.action))).toEqual(["POST /api/register", "statusClass 2xx", "POST /api/cart/items", "statusClass 2xx", "POST /api/orders", "status 409"]);
    });

    it.each([1, 2, 3])("clean shop, seed %i: every sequence holds within the caps, and the same seed gives the same sequences", async (seed) => {
        const env = shop();
        const r = await runSequences(stateModels(APIS)[0]!, env, { seed });
        expect(r.outcome).toBe("held");
        expect(r.sequences).toBeLessThanOrEqual(MAX_SEQUENCES);
        // The product list, then each sequence: its sign-up and at most 8 steps.
        expect(env.requests()).toBeLessThanOrEqual(1 + MAX_SEQUENCES * (1 + MAX_SEQUENCE_STEPS));
        const again = await runSequences(stateModels(APIS)[0]!, shop(), { seed });
        expect(again.log).toEqual(r.log);
        expect(again.seen).toEqual(r.seen);
    });

    it("a failure in a generated sequence is shrunk to the smallest one, within the request cap", async () => {
        // An app that fails every order it should place (500 instead of 201): only a sequence with both needed steps before the create shows it.
        const env = shop();
        const real = env.newClient;
        env.newClient = async (credential) => {
            const c = await real(credential);
            return { send: async (method, path, body) => ((r) => (method === "POST" && path === "/api/orders" && r.status === 201 ? { status: 500, json: {} } : r))(await c.send(method, path, body)) };
        };
        let found = 0;
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const before = env.requests();
            const r = await runSequences(stateModels(APIS)[0]!, env, { seed });
            if (r.outcome !== "failed") continue;
            found++;
            // Both needed steps, in either order, then the create: nothing else is left.
            expect(r.log.slice(0, 2).map((s) => s.request).sort()).toEqual(["POST /api/cart/items", "POST /api/checkout/address"]);
            expect(r.log[2], JSON.stringify(r.log.map((s) => s.request))).toMatchObject({ request: "POST /api/orders", status: 500, expected: "2xx" });
            expect(r.log).toHaveLength(3);
            expect(env.requests() - before).toBeLessThanOrEqual(1 + MAX_SEQUENCES * (1 + MAX_SEQUENCE_STEPS) + MAX_SEQUENCE_SHRINK_REQUESTS);
        }
        expect(found).toBeGreaterThan(0);
    });

    it("on a fresh account only its session is sent: no run token while sequencing, and auth none in the saved sequence", async () => {
        const env = shop("BS-10");
        const r = await runSequences(stateModels(APIS)[0]!, env, { seed: 5 });
        expect(env.credentials.length).toBeGreaterThan(1);
        expect(env.credentials.every((c) => c === false)).toBe(true);
        expect(r.spec!.steps.filter((s) => s.action === "request").map((s) => s.action === "request" && s.auth)).toEqual(["none", "none", "none"]);
        const noSignUp = { ...shop("BS-10"), apis: APIS.filter((a) => a.path !== "/api/register") };
        await runSequences(stateModels(noSignUp.apis)[0]!, noSignUp, { seed: 5 });
        expect(new Set(noSignUp.credentials)).toEqual(new Set([true]));
    });

    it("BS-05: a state no new account reaches is checked on the project's account's record in it", async () => {
        const env = shop();
        const m = stateModels(APIS)[0]!;
        const specs = await stateCheckSpecs(m, env.main, ["placed", "paid", "cancelled"], true);
        expect(specs.map((s) => s.title)).toEqual(["POST /api/orders/{id}/pay: a shipped order is refused with HTTP 409", "POST /api/orders/{id}/cancel: a shipped order is refused with HTTP 409"]);
        expect(specs[1]!.steps).toMatchObject([
            { method: "GET", path: "/api/orders/ord-0999" },
            { check: "jsonPath", path: "status", expected: "shipped" },
            { method: "POST", path: "/api/orders/ord-0999/cancel" },
            { check: "status", expected: 409 },
        ]);
        expect(specs[1]!.description).toMatch(/Known limit \(data changes are on\): .*a rerun stops at the state check/);
        expect(await stateCheckSpecs(m, env.main, [], false)).toEqual([]);
    });
});
