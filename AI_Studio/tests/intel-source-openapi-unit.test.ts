/**
 * OpenAPI documents as a source of application knowledge, and source fingerprints (pure, no network, no model: fast tier).
 */
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { ModelFragmentSchema } from "../src/engine/intel/fragment.js";
import { endpointKey } from "../src/engine/intel/model.js";
import { fingerprintCommit, fingerprintJson, fingerprintText } from "../src/engine/intel/sources/fingerprint.js";
import { openApiFragment, openApiFragmentFromText } from "../src/engine/intel/sources/openapi.js";

/** The document bench-shop serves at /openapi.json: its OPENAPI object, read from the app's source (the app is not changed or started). */
function benchShopOpenApi(): Record<string, any> {
    const source = fs.readFileSync(new URL("../examples/bench-shop/server.mjs", import.meta.url), "utf8");
    const start = source.indexOf("const OPENAPI = ");
    const end = source.indexOf("\n};\n", start);
    if (start < 0 || end < 0) throw new Error("bench-shop's OPENAPI object was not found");
    const literal = source.slice(start + "const OPENAPI = ".length, end + 2);
    if (!literal.startsWith("{") || !literal.endsWith("}")) throw new Error("bench-shop's OPENAPI is not an object literal");
    // Only the object literal is evaluated, in an empty context: no require, process or other globals.
    return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 }) as Record<string, any>;
}

const SHOP = {
    openapi: "3.0.3",
    info: { title: "Shop", version: "1" },
    servers: [{ url: "https://shop.example/api" }],
    components: {
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
        schemas: {
            Customer: { type: "object", required: ["email"], properties: { id: { type: "string" }, email: { type: "string", format: "email", maxLength: 200 } } },
            Order: {
                type: "object",
                required: ["id", "status"],
                properties: {
                    id: { type: "string" },
                    status: { type: "string", enum: ["placed", "paid", "cancelled"] },
                    total: { type: "integer", minimum: 0 },
                    customer: { $ref: "#/components/schemas/Customer" },
                    lines: { type: "array", items: { $ref: "#/components/schemas/OrderLine" } },
                },
            },
            OrderLine: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer", minimum: 1, maximum: 10 } } },
            Note: { type: "object", properties: { text: { type: "string" }, mentions: { type: "string", description: "Customer ids, written as text" } } },
        },
    },
    paths: {
        "/orders": {
            get: { responses: { 200: { description: "Orders", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Order" } } } } } } },
            post: {
                security: [{ bearer: [] }],
                requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } },
                responses: { 201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } }, 400: { description: "Invalid order" }, 401: { description: "Not signed in" } },
            },
        },
        "/orders/{orderId}": {
            parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
            get: { parameters: [{ name: "expand", in: "query", schema: { type: "string" } }], responses: { 200: { description: "One order", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } }, 404: { description: "No such order" } } },
        },
    },
};

describe("source fingerprints", () => {
    it("JSON key order and whitespace do not change the fingerprint", () => {
        const a = JSON.parse('{"openapi":"3.0.3","paths":{"/a":{"get":{"summary":"A"}},"/b":{}}}');
        const b = JSON.parse('{\n  "paths": {\n    "/b": {},\n    "/a": { "get": { "summary": "A" } }\n  },\n  "openapi": "3.0.3"\n}');
        expect(fingerprintJson(a)).toBe(fingerprintJson(b));
    });

    it("a changed JSON value or array order changes the fingerprint", () => {
        expect(fingerprintJson({ a: [1, 2] })).not.toBe(fingerprintJson({ a: [2, 1] }));
        expect(fingerprintJson({ a: "x" })).not.toBe(fingerprintJson({ a: "y" }));
        expect(fingerprintJson({ a: { b: 1 } })).not.toBe(fingerprintJson({ a: { b: 2 } }));
    });

    it("line endings and trailing spaces do not change a text fingerprint; a changed word does", () => {
        expect(fingerprintText("CREATE TABLE a (id int);\nSELECT 1;\n")).toBe(fingerprintText("CREATE TABLE a (id int);  \r\nSELECT 1;\r\n\r\n"));
        expect(fingerprintText("CREATE TABLE a (id int);")).not.toBe(fingerprintText("CREATE TABLE b (id int);"));
    });

    it("a commit fingerprint ignores case and surrounding space and differs per commit", () => {
        expect(fingerprintCommit(" ABC123 ")).toBe(fingerprintCommit("abc123"));
        expect(fingerprintCommit("abc123")).not.toBe(fingerprintCommit("abc124"));
    });

    it("the same content as text and as JSON are different sources", () => {
        expect(fingerprintText("{}")).not.toBe(fingerprintJson({}));
    });
});

describe("OpenAPI document -> model fragment", () => {
    it("bench-shop's served document yields every operation as a documented endpoint and nothing else", () => {
        const doc = benchShopOpenApi();
        const expected = Object.entries<Record<string, unknown>>(doc.paths).flatMap(([path, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${path}`));
        expect(expected.length).toBeGreaterThan(10);
        const f = openApiFragment(doc, { ref: "http://127.0.0.1:9710/openapi.json", now: "2026-11-16T00:00:00.000Z" });
        expect(f.model.endpoints.map(endpointKey).sort()).toEqual([...expected].sort());
        expect(f.model.endpoints.every((e) => e.origin === "documented")).toBe(true);
    });

    it("every endpoint carries its OpenAPI path as evidence, and the fragment passes the model schema", () => {
        const f = openApiFragment(SHOP, { ref: "shop-openapi.json" });
        expect(() => ModelFragmentSchema.parse(f)).not.toThrow();
        const post = f.model.endpoints.find((e) => endpointKey(e) === "POST /api/orders")!;
        expect(post.evidence).toEqual([{ kind: "openapi", ref: "shop-openapi.json#/paths/~1orders/post" }]);
    });

    it("records parameters, schema references, auth and error responses", () => {
        const f = openApiFragment(SHOP, { ref: "shop-openapi.json" });
        const one = f.model.endpoints.find((e) => endpointKey(e) === "GET /api/orders/{orderId}")!;
        expect(one.parameters).toEqual([
            { name: "orderId", in: "path", required: true, type: "string" },
            { name: "expand", in: "query", required: false, type: "string" },
        ]);
        expect(one.responseSchema).toBe("#/components/schemas/Order");
        expect(one.errors).toEqual([{ status: "404", description: "No such order" }]);
        // The document says nothing about sign-in for this operation: unknown, not "no sign-in needed".
        expect(one.requiresAuth).toBeUndefined();
        const post = f.model.endpoints.find((e) => endpointKey(e) === "POST /api/orders")!;
        expect(post.requestSchema).toBe("#/components/schemas/Order");
        expect(post.requiresAuth).toBe(true);
        expect(post.errors.map((e) => e.status)).toEqual(["400", "401"]);
    });

    it("an operation that opts out of a global security requirement needs no sign-in; one under it does", () => {
        const doc = { openapi: "3.0.3", info: { title: "T", version: "1" }, security: [{ bearer: [] }], components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, paths: { "/health": { get: { security: [], responses: { 200: { description: "ok" } } } }, "/me": { get: { responses: { 200: { description: "me" } } } } } };
        const f = openApiFragment(doc, { ref: "t.json" });
        expect(f.model.endpoints.find((e) => e.path === "/health")!.requiresAuth).toBe(false);
        expect(f.model.endpoints.find((e) => e.path === "/me")!.requiresAuth).toBe(true);
    });

    it("turns component schemas into entities with field types and constraints", () => {
        const f = openApiFragment(SHOP, { ref: "shop-openapi.json" });
        expect(f.model.entities.map((e) => e.name).sort()).toEqual(["Customer", "Note", "Order", "OrderLine"]);
        const order = f.model.entities.find((e) => e.name === "Order")!;
        expect(order.evidence).toEqual([{ kind: "openapi", ref: "shop-openapi.json#/components/schemas/Order" }]);
        expect(order.fields.find((x) => x.name === "status")).toEqual({ name: "status", type: "string", constraints: ["required", "one of: placed, paid, cancelled"] });
        expect(order.fields.find((x) => x.name === "total")!.constraints).toEqual(["minimum 0"]);
        expect(order.fields.find((x) => x.name === "lines")!.type).toBe("OrderLine[]");
        const line = f.model.entities.find((e) => e.name === "OrderLine")!;
        expect(line.fields.find((x) => x.name === "qty")!.constraints).toEqual(["minimum 1", "maximum 10"]);
    });

    it("component schemas are entities the document states", () => {
        const f = openApiFragment(SHOP, { ref: "shop-openapi.json" });
        for (const e of f.model.entities) expect(e, e.name).toMatchObject({ sourceType: "openapi", explicitness: "explicit" });
    });

    it("without component schemas, a collection addressed by id is an entity inferred from its path, with the fields its request bodies name", () => {
        const f = openApiFragment(benchShopOpenApi(), { ref: "shop.json" });
        expect(() => ModelFragmentSchema.parse(f)).not.toThrow();
        // /api/products/{id}, /api/cart/items/{productId} (under /api/cart, itself documented) and /api/orders/{id}; nothing from
        // /api/register, /api/login, /api/profile or /api/cart, which address no collection by id.
        expect(f.model.entities.map((e) => e.name).sort()).toEqual(["cart item", "order", "product"]);
        for (const e of f.model.entities) expect(e, e.name).toMatchObject({ sourceType: "inferred", explicitness: "inferred" });
        const item = f.model.entities.find((e) => e.name === "cart item")!;
        expect(item.evidence.map((x) => x.ref)).toEqual(["shop.json#/paths/~1api~1cart~1items~1{productId}", "shop.json#/paths/~1api~1cart~1items/post/requestBody"]);
        expect(item.fields).toEqual([
            { name: "productId", type: "string", constraints: ["required"] },
            { name: "quantity", type: "integer", constraints: ["minimum 1", "maximum 10"] },
        ]);
        expect(f.model.entities.find((e) => e.name === "product")!.fields).toEqual([]);
    });

    it("a request body that is not a collection's (a sign-up, a sign-in) makes no entity", () => {
        const doc = { openapi: "3.0.3", info: { title: "T", version: "1" }, paths: { "/api/register": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { email: { type: "string" } } } } } }, responses: { 201: { description: "ok" } } } }, "/api/status/{id}": { get: { responses: { 200: { description: "ok" } } } } } };
        expect(openApiFragment(doc, { ref: "t.json" }).model.entities).toEqual([]);
    });

    it("records relationships only where a $ref states them", () => {
        const f = openApiFragment(SHOP, { ref: "shop-openapi.json" });
        const rels = f.model.relationships.map((r) => `${r.from} ${r.kind} ${r.to} @ ${r.evidence[0]!.ref}`).sort();
        expect(rels).toEqual([
            "Order has_many OrderLine @ shop-openapi.json#/components/schemas/Order/properties/lines",
            "Order references Customer @ shop-openapi.json#/components/schemas/Order/properties/customer",
        ]);
    });

    it("turns request chains (list -> detail, create -> read) into workflows over documented endpoints", () => {
        const f = openApiFragment(SHOP, { ref: "shop-openapi.json" });
        expect(f.model.workflows.length).toBeGreaterThan(0);
        const keys = new Set(f.model.endpoints.map(endpointKey));
        for (const w of f.model.workflows) {
            expect(w.sourceType).toBe("openapi");
            expect(w.steps.length).toBeGreaterThan(1);
            for (const s of w.steps) expect(keys.has(s.endpoint!)).toBe(true);
        }
        expect(f.model.workflows.some((w) => w.steps.map((s) => s.endpoint).join(" > ") === "GET /api/orders > GET /api/orders/{orderId}")).toBe(true);
    });

    it("its source record is processed, fingerprinted independent of key order, and it states no rules", () => {
        const f = openApiFragment(SHOP, { ref: "shop-openapi.json", now: "2026-11-16T00:00:00.000Z" });
        expect(f.source).toEqual({ kind: "openapi", ref: "shop-openapi.json", fingerprint: fingerprintJson(SHOP), status: "processed", processedAt: "2026-11-16T00:00:00.000Z" });
        const reordered = JSON.parse(JSON.stringify({ paths: SHOP.paths, components: SHOP.components, servers: SHOP.servers, info: SHOP.info, openapi: SHOP.openapi }));
        expect(openApiFragment(reordered, { ref: "x" }).source.fingerprint).toBe(f.source.fingerprint);
        expect(f.rules).toEqual([]);
        expect(f.model.contextSources).toEqual(["openapi"]);
    });

    it("a document that does not parse, or is not OpenAPI, fails its source with a sentence", () => {
        const bad = openApiFragmentFromText("{ not json", { ref: "broken.json" });
        expect(bad.source.status).toBe("failed");
        expect(bad.source.error).toMatch(/\w+ \w+/);
        expect(bad.model.endpoints).toEqual([]);
        const notSpec = openApiFragmentFromText('{"name":"x"}', { ref: "x.json" });
        expect(notSpec.source.status).toBe("failed");
        expect(() => ModelFragmentSchema.parse(bad)).not.toThrow();
    });

    it("reads YAML text", () => {
        const f = openApiFragmentFromText("openapi: 3.0.0\ninfo: { title: T, version: '1' }\npaths:\n  /ping:\n    get:\n      responses: { '200': { description: ok } }\n", { ref: "api.yaml" });
        expect(f.model.endpoints.map(endpointKey)).toEqual(["GET /ping"]);
    });

    it("a very large document stays fast: request chains are looked for only among the operations kept", () => {
        const paths: Record<string, unknown> = {};
        for (let i = 0; i < 12_000; i++) paths[`/p${i}/{id}`] = { get: { responses: { 200: { description: "ok" } } }, post: { responses: { 201: { description: "ok" } } }, delete: { responses: { 204: { description: "ok" } } } };
        const started = performance.now();
        const f = openApiFragment({ openapi: "3.0.0", info: { title: "big", version: "1" }, paths }, { ref: "big.json" });
        expect(performance.now() - started).toBeLessThan(2000);
        expect(f.model.endpoints).toHaveLength(2000);
        expect(f.notes.join(" ")).toMatch(/2000 operations/);
    });

    it("text over 2 MB fails its source with a sentence instead of being read", () => {
        const f = openApiFragmentFromText('{"openapi":"3.0.0","paths":{},"x":"' + "a".repeat(2 * 1024 * 1024) + '"}', { ref: "huge.json" });
        expect(f.source.status).toBe("failed");
        expect(f.source.error).toMatch(/2 MB/);
    });

    it("a deeply nested document fails its source with a sentence and never throws", () => {
        const text = '{"openapi":"3.0.0","paths":{},"x":' + "[".repeat(200_000) + "]".repeat(200_000) + "}";
        const f = openApiFragmentFromText(text, { ref: "deep.json" });
        expect(f.source.status).toBe("failed");
        expect(f.source.error).toMatch(/nested/);
        expect(() => ModelFragmentSchema.parse(f)).not.toThrow();
    });

    it("secrets in error descriptions, patterns and enum values are hidden before storage", () => {
        const doc = {
            openapi: "3.0.3",
            info: { title: "T", version: "1" },
            components: { schemas: { Key: { type: "object", properties: { kind: { type: "string", enum: ["public", "sk_live_51Habcdefgh1234"] }, code: { type: "string", pattern: "^ghp_abcdefghij1234567890$" } } } } },
            paths: { "/x": { get: { responses: { 200: { description: "ok" }, 401: { description: "Use the token sk_live_51Habcdefgh1234 or password Hunter2!Secret" } } } } },
        };
        const text = JSON.stringify(openApiFragment(doc, { ref: "t.json" }));
        for (const secret of ["sk_live_51Habcdefgh1234", "ghp_abcdefghij1234567890", "Hunter2!Secret"]) expect(text).not.toContain(secret);
    });
});

