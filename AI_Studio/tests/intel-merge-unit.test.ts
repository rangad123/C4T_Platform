/**
 * Merging the fragments every source returns into one application model, and the missing-context sentences. Pure (fast tier).
 *
 * Expected values come from the model's rules: pages are one per path, endpoints one per method and path (an OpenAPI document wins the
 * record, traffic stays as evidence, an endpoint nobody documented or saw is never recorded), entities one per name, workflows one per id;
 * the result does not depend on the order the sources arrive in; a limit that cuts something off says so as missing context.
 */
import { describe, expect, it } from "vitest";
import { ModelFragmentSchema, type ModelFragment } from "../src/engine/intel/fragment.js";
import { merge } from "../src/engine/intel/merge.js";
import { missingContext } from "../src/engine/intel/missing-context.js";
import { AppModelSchema, RuleSchema, ruleFingerprint, type SourceRecord } from "../src/engine/intel/model.js";

const fragment = (f: Record<string, unknown>): ModelFragment => ModelFragmentSchema.parse({ model: {}, ...f });
const processed = (kind: string, ref: string): SourceRecord => ({ kind, ref, fingerprint: `sha-${ref}`, status: "processed", processedAt: "2026-11-16T00:00:00Z" }) as SourceRecord;

const request = (method: string, path: string) => ({ kind: "request", ref: `${method} ${path}`, excerpt: "on /cart" });
const openapi = (method: string, path: string) => ({ kind: "openapi", ref: `${method} ${path}` });

const exploration = fragment({
    source: processed("exploration", "https://shop.test"),
    model: {
        appType: "e-commerce",
        contextSources: ["url", "crawl"],
        pages: [
            { id: "p-cart", path: "/cart", purpose: "Shows the cart", elements: [{ role: "button", name: "Checkout", kind: "button" }], interactions: [{ control: "Delete", method: "DELETE", path: "/api/cart/items/{id}" }] },
            { id: "p-home", path: "/", purpose: "Home" },
        ],
        navigation: [{ from: "p-home", to: "p-cart", control: "Cart", evidence: [{ kind: "page", ref: "/" }] }],
        endpoints: [
            { method: "post", path: "/api/orders", origin: "observed", evidence: [request("POST", "/api/orders")] },
            { method: "GET", path: "/api/cart", origin: "observed", evidence: [request("GET", "/api/cart")] },
        ],
        workflows: [{ id: "checkout", name: "Checkout (seen)", steps: [{ order: 0, action: "Open the cart", page: "p-cart" }], sourceType: "inferred", evidence: [{ kind: "page", ref: "/cart" }] }],
        entities: [{ id: "e-order", name: "Order", fields: [{ name: "total", constraints: [] }], evidence: [{ kind: "page", ref: "/cart" }] }],
    },
});

const apiDoc = fragment({
    source: processed("openapi", "https://shop.test/openapi.json"),
    model: {
        contextSources: ["openapi"],
        endpoints: [
            { method: "POST", path: "/api/orders", origin: "documented", requestSchema: "#/components/schemas/NewOrder", responseSchema: "#/components/schemas/Order", evidence: [openapi("POST", "/api/orders")] },
            { method: "GET", path: "/api/orders/{id}", origin: "documented", responseSchema: "#/components/schemas/Order", evidence: [openapi("GET", "/api/orders/{id}")] },
        ],
        entities: [{ id: "order-schema", name: "order", fields: [{ name: "total", type: "number", constraints: ["minimum 0"] }, { name: "status", type: "string", constraints: [] }], evidence: [{ kind: "openapi", ref: "#/components/schemas/Order" }] }],
        relationships: [{ from: "order-schema", to: "order-schema", kind: "references", evidence: [{ kind: "openapi", ref: "#/components/schemas/Order" }] }],
    },
});

const rule = (over: Record<string, unknown> = {}) => ({
    ref: "R-1",
    kind: "constraint",
    description: "Quantity limit",
    expected: "The quantity is between 1 and 10.",
    sourceType: "requirement",
    sourceRef: "requirements.md:12",
    explicitness: "explicit",
    confidence: 0.9,
    entities: ["order"],
    ...over,
});

const requirements = fragment({
    source: processed("requirements", "doc-1"),
    model: {
        contextSources: ["requirements"],
        pages: [{ id: "cart-page", path: "/cart", purpose: "", reachableBy: ["customer"] }],
        workflows: [{ id: "checkout", name: "Checkout", steps: [{ order: 0, action: "Pay", page: "cart-page" }], sourceType: "requirement", evidence: [{ kind: "quote", ref: "requirements.md:3" }] }],
    },
    rules: [rule()],
    notes: ["2 rules dropped: their quote is not in the document."],
});

const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

describe("merge", () => {
    it("gives the same model and rules whatever order the fragments arrive in", () => {
        const results = permutations([exploration, apiDoc, requirements]).map((fs) => merge(undefined, fs));
        expect(results).toHaveLength(6);
        for (const r of results.slice(1)) {
            expect(JSON.stringify(r.model)).toBe(JSON.stringify(results[0]!.model));
            expect(JSON.stringify(r.rules)).toBe(JSON.stringify(results[0]!.rules));
        }
    });

    it("records a documented endpoint from the document, keeps the traffic as its evidence, and never invents one", () => {
        const { model } = merge(undefined, [exploration, apiDoc, requirements]);
        const byKey = new Map(model.endpoints.map((e) => [`${e.method} ${e.path}`, e]));
        // Exactly the endpoints a document described or traffic showed: DELETE /api/cart/items/{id} appears only as a control's request on
        // a page, so it is not recorded as an endpoint.
        expect([...byKey.keys()].sort()).toEqual(["GET /api/cart", "GET /api/orders/{id}", "POST /api/orders"]);

        const both = byKey.get("POST /api/orders")!;
        expect(both.origin).toBe("documented");
        expect(both.responseSchema).toBe("#/components/schemas/Order");
        expect(both.evidence).toEqual([openapi("POST", "/api/orders"), request("POST", "/api/orders")]);

        expect(byKey.get("GET /api/orders/{id}")!.origin).toBe("documented");
        expect(byKey.get("GET /api/cart")!.origin).toBe("observed");
        expect(byKey.get("GET /api/cart")!.evidence).toEqual([request("GET", "/api/cart")]);
    });

    it("keeps one page per path, one entity per name and one workflow per id, and points links at the page kept", () => {
        const { model } = merge(undefined, [requirements, apiDoc, exploration]);
        const carts = model.pages.filter((p) => p.path === "/cart");
        expect(carts).toHaveLength(1);
        const cart = carts[0]!;
        expect(cart.purpose).toBe("Shows the cart");
        expect(cart.reachableBy).toEqual(["customer"]);
        expect(cart.elements.map((e) => e.name)).toEqual(["Checkout"]);

        // Every link to the page uses the id that was kept.
        expect(model.navigation.map((n) => n.to)).toEqual([cart.id]);
        const checkout = model.workflows.filter((w) => w.id === "checkout");
        expect(checkout).toHaveLength(1);
        // A workflow a document states wins over one only inferred from the crawl; evidence from both is kept.
        expect(checkout[0]!.sourceType).toBe("requirement");
        expect(checkout[0]!.steps.map((s) => s.page)).toEqual([cart.id]);
        expect(checkout[0]!.evidence).toEqual(expect.arrayContaining([{ kind: "quote", ref: "requirements.md:3" }, { kind: "page", ref: "/cart" }]));

        const orders = model.entities.filter((e) => e.name.toLowerCase() === "order");
        expect(orders).toHaveLength(1);
        expect(orders[0]!.fields.map((f) => f.name).sort()).toEqual(["status", "total"]);
        expect(orders[0]!.fields.find((f) => f.name === "total")!.constraints).toEqual(["minimum 0"]);
        expect(model.relationships.map((r) => [r.from, r.to])).toEqual([[orders[0]!.id, orders[0]!.id]]);

        expect(model.contextSources).toEqual(["url", "crawl", "openapi", "requirements"]);
        expect(model.sources.map((s) => s.kind)).toEqual(["exploration", "openapi", "requirements"]);
        expect(() => AppModelSchema.parse(model)).not.toThrow();
    });

    it("never folds two different workflows into one because their ids were hidden", () => {
        const wf = (name: string) => ({ id: "[hidden]", name, steps: [{ order: 0, action: name }], sourceType: "inferred", evidence: [{ kind: "page", ref: "/" }] });
        const f = fragment({ source: processed("exploration", "x"), model: { workflows: [wf("Browse"), wf("Cancel"), wf("Browse")] } });
        expect(merge(undefined, [f]).model.workflows.map((w) => w.name)).toEqual(["Browse", "Cancel"]);
    });

    it("reports changed only when the merged model differs from the previous one", () => {
        const first = merge(undefined, [exploration, apiDoc, requirements]);
        expect(first.changed).toBe(true);
        expect(merge(first.model, [requirements, exploration, apiDoc]).changed).toBe(false);

        // Processing the same content again at a later time is not a change.
        const later = fragment({ ...apiDoc, source: { ...apiDoc.source, processedAt: "2026-11-17T09:00:00Z" } });
        expect(merge(first.model, [exploration, later, requirements]).changed).toBe(false);

        const edited = fragment({ ...apiDoc, model: { ...apiDoc.model, endpoints: apiDoc.model.endpoints.slice(0, 1) } });
        expect(merge(first.model, [exploration, edited, requirements]).changed).toBe(true);
    });

    it("keeps one rule per fingerprint, preferring the one a source states", () => {
        const guessed = fragment({
            source: processed("exploration", "https://shop.test/2"),
            rules: [rule({ ref: "R-9", description: "Guessed", expected: "The quantity is  between 1 and 10.", sourceType: "inferred", sourceRef: "", explicitness: "inferred", confidence: 0.99 })],
        });
        const { rules } = merge(undefined, [guessed, requirements]);
        expect(rules).toHaveLength(1);
        expect(rules[0]!.explicitness).toBe("explicit");
        expect(ruleFingerprint(rules[0]!)).toBe(ruleFingerprint(RuleSchema.parse(rule())));
    });

    it("lists what a limit cut off as missing context instead of dropping it silently", () => {
        const pages = Array.from({ length: 2003 }, (_, i) => ({ id: `p${i}`, path: `/p/${i}` }));
        const rules = Array.from({ length: 1001 }, (_, i) => rule({ ref: `R-${i}`, expected: `Rule number ${i} holds.` }));
        // Each fragment is within the limits; together they are over them.
        const big = [pages.slice(0, 1002), pages.slice(1002)].map((p, n) => fragment({ source: processed("exploration", `https://big.test/${n}`), model: { pages: p } }));
        const many = [0, 1].map((n) => fragment({ source: processed("requirements", `doc-${n}`), rules: rules.map((r) => ({ ...r, expected: `${r.expected} (${n})` })) }));
        const { model, rules: kept } = merge(undefined, [...big, ...many]);
        expect(model.pages).toHaveLength(2000);
        expect(kept).toHaveLength(2000);
        const texts = model.missingContext.map((m) => m.text);
        expect(texts.some((t) => /\b3\b/.test(t) && /pages/i.test(t) && t.includes("2000"))).toBe(true);
        expect(texts.some((t) => /\b2\b/.test(t) && /rules/i.test(t) && t.includes("2000"))).toBe(true);
    });

    it("carries each source's notes and failed sources into missing context", () => {
        const failed = fragment({ source: { kind: "db_schema", ref: "schema.sql", status: "failed", error: "The file is not a SQL or Prisma schema." } });
        const { model } = merge(undefined, [exploration, requirements, failed]);
        expect(model.missingContext).toEqual(expect.arrayContaining([{ text: "2 rules dropped: their quote is not in the document.", source: "requirements" }]));
        expect(model.missingContext.some((m) => m.source === "db_schema" && m.text.includes("schema.sql") && m.text.includes("The file is not a SQL or Prisma schema."))).toBe(true);
    });
});

describe("missingContext", () => {
    const endpoints = AppModelSchema.parse({
        endpoints: [
            { method: "GET", path: "/a", origin: "observed", evidence: [request("GET", "/a")] },
            { method: "GET", path: "/b", origin: "observed", responseSchema: "#/x", evidence: [request("GET", "/b")] },
            { method: "GET", path: "/c", origin: "observed", evidence: [request("GET", "/c")] },
            { method: "GET", path: "/d", origin: "documented", evidence: [openapi("GET", "/d")] },
        ],
    });

    it("without an API description, counts the observed endpoints that have no response schema", () => {
        const out = missingContext(endpoints, [processed("exploration", "u"), processed("requirements", "d")]);
        expect(out).toHaveLength(1);
        expect(out[0]!.source).toBe("openapi");
        expect(out[0]!.text).toMatch(/\b2 observed endpoints have no response schema/);
        expect(missingContext(endpoints, [processed("openapi", "o"), processed("requirements", "d")])).toEqual([]);
    });

    it("without a requirements document, says rules are inferred only", () => {
        const out = missingContext(AppModelSchema.parse({}), [processed("openapi", "o")]);
        expect(out).toEqual([{ text: expect.stringMatching(/rules are inferred only/i), source: "requirements" }]);
        // A requirements source that failed answered nothing either.
        const failed = { kind: "requirements", ref: "doc", status: "failed", error: "The AI call failed." } as SourceRecord;
        expect(missingContext(AppModelSchema.parse({}), [processed("openapi", "o"), failed]).map((m) => m.source)).toEqual(["requirements", "requirements"]);
    });

    it("asks for a newer runner when the crawl came from an older one", () => {
        const out = missingContext(AppModelSchema.parse({}), [processed("openapi", "o"), processed("requirements", "d")], { oldRunner: true });
        expect(out).toEqual([{ text: expect.stringMatching(/download the runner again/i), source: "exploration" }]);
    });

    it("names each failed source with its reason, the same way whatever order the sources come in", () => {
        const a = { kind: "repository", ref: "repo@abc", status: "failed", error: "The check-out is gone." } as SourceRecord;
        const b = { kind: "db_schema", ref: "schema.sql", status: "failed", error: "Too large." } as SourceRecord;
        const base = [processed("openapi", "o"), processed("requirements", "d")];
        const one = missingContext(AppModelSchema.parse({}), [...base, a, b]);
        expect(one).toEqual(missingContext(AppModelSchema.parse({}), [b, ...base, a]));
        expect(one.map((m) => m.source)).toEqual(["db_schema", "repository"]);
        expect(one[1]!.text).toContain("repo@abc");
        expect(one[1]!.text).toContain("The check-out is gone.");
    });
});

describe("entities from several sources", () => {
    const named = (kind: string, ref: string, e: Record<string, unknown>) => fragment({ source: processed(kind, ref), model: { entities: [e] } });
    const fromPath = named("openapi", "api.json", { id: "order", name: "order", fields: [{ name: "quantity", type: "integer", constraints: [] }], sourceType: "inferred", explicitness: "inferred", evidence: [{ kind: "openapi", ref: "api.json#/paths/~1api~1orders~1{id}" }] });
    const fromDoc = named("requirements", "doc-1", { id: "order", name: "Order", fields: [{ name: "status", constraints: [] }], sourceType: "requirement", explicitness: "explicit", evidence: [{ kind: "quote", ref: "doc-1#L4", excerpt: "Orders have one of four states" }] });

    it("are one entity per name; a source that states it wins over one that only infers it, and every source's evidence stays", () => {
        for (const order of [[fromPath, fromDoc], [fromDoc, fromPath]]) {
            const { model } = merge(undefined, order);
            expect(model.entities).toHaveLength(1);
            const e = model.entities[0]!;
            expect(e).toMatchObject({ sourceType: "requirement", explicitness: "explicit" });
            expect(e.fields.map((f) => f.name).sort()).toEqual(["quantity", "status"]);
            expect(e.evidence.map((x) => x.ref).sort()).toEqual(["api.json#/paths/~1api~1orders~1{id}", "doc-1#L4"]);
        }
    });

    it("one only inferred stays inferred", () => {
        const { model } = merge(undefined, [fromPath]);
        expect(model.entities[0]).toMatchObject({ sourceType: "inferred", explicitness: "inferred" });
    });
});
