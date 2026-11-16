/**
 * The application model, second shape: endpoints with their origin, navigation, form constraints, page structures, roles, state
 * transitions, sources, missing context and the application version; the rule fingerprint; the diff; and the fragment every source
 * returns. Pure (fast tier).
 */
import { describe, expect, it } from "vitest";
import { SourceRecordSchema, ModelFragmentSchema } from "../src/engine/intel/fragment.js";
import { AppModelSchema, AppVersionSchema, diffModels, EndpointSchema, RuleSchema, ruleFingerprint, TransitionSchema } from "../src/engine/intel/model.js";

/** A model exactly as the first version stored it: none of the new fields. */
const PHASE_1_STORED = JSON.parse(
    JSON.stringify({
        appType: "e-commerce",
        contextSources: ["url", "crawl", "requirements"],
        pages: [{ id: "cart", path: "/cart", purpose: "Shows the cart", elements: [{ role: "button", name: "Checkout", kind: "button" }], requiresSignIn: true }],
        workflows: [{ id: "checkout", name: "Checkout", steps: [{ order: 0, action: "Open the cart", page: "cart" }], preconditions: ["Signed in"], postconditions: ["An order exists"], roles: [], sourceType: "requirement" }],
        entities: [{ id: "cart", name: "Cart", fields: [{ name: "quantity", type: "integer", constraints: ["min 1"] }], evidence: [] }],
        relationships: [],
        scenarios: [],
    }),
);

const documented = { method: "GET", path: "/api/orders/{id}", origin: "documented", evidence: [{ kind: "openapi", ref: "GET /api/orders/{id}" }] };
const observed = { method: "POST", path: "/api/cart/items", origin: "observed", evidence: [{ kind: "request", ref: "POST /api/cart/items", excerpt: "on /cart" }] };

const rule = (over: Record<string, unknown> = {}) =>
    RuleSchema.parse({
        ref: "R-1",
        kind: "constraint",
        description: "Quantity limit",
        expected: "The quantity is between 1 and 10.",
        sourceType: "requirement",
        sourceRef: "requirements.md:12",
        explicitness: "explicit",
        confidence: 0.9,
        entities: ["cart", "item"],
        workflows: ["checkout"],
        endpoints: ["POST /api/cart/items"],
        ...over,
    });

describe("a model stored by the first version", () => {
    it("still parses, and the new parts are empty", () => {
        const m = AppModelSchema.parse(PHASE_1_STORED);
        expect(m.pages[0]).toMatchObject({ id: "cart", path: "/cart", requiresSignIn: true });
        expect(m).toMatchObject({ endpoints: [], navigation: [], roles: [], transitions: [], sources: [], missingContext: [] });
        expect(m.appVersion).toBeUndefined();
    });
});

describe("endpoints", () => {
    it("are documented only with an OpenAPI path as evidence", () => {
        expect(EndpointSchema.safeParse(documented).success).toBe(true);
        const r = EndpointSchema.safeParse({ ...documented, evidence: [{ kind: "request", ref: "GET /api/orders/7" }] });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toMatch(/OpenAPI/);
    });

    it("are recorded only with evidence: one nobody documented or saw is refused", () => {
        expect(EndpointSchema.safeParse(observed).success).toBe(true);
        expect(EndpointSchema.safeParse({ ...observed, evidence: [] }).success).toBe(false);
    });

    it("keep parameters, schema references, sign-in and error responses", () => {
        const e = EndpointSchema.parse({
            ...documented,
            parameters: [{ name: "id", in: "path", required: true, type: "string" }],
            requestSchema: "#/components/schemas/OrderQuery",
            responseSchema: "#/components/schemas/Order",
            requiresAuth: true,
            errors: [{ status: "404", description: "No such order" }],
        });
        expect(e).toMatchObject({ requiresAuth: true, errors: [{ status: "404" }], parameters: [{ name: "id", in: "path" }] });
    });
});

describe("state transitions", () => {
    it("seen only in the application's behaviour are never an expectation", () => {
        const t = { entity: "order", from: "placed", to: "shipped", trigger: "Ship", evidence: [{ kind: "page", ref: "/orders/1" }] };
        expect(TransitionSchema.safeParse({ ...t, sourceType: "observed", expectation: false }).success).toBe(true);
        const r = TransitionSchema.safeParse({ ...t, sourceType: "observed", expectation: true });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toMatch(/not a source of expected behaviour/);
        expect(TransitionSchema.safeParse({ ...t, sourceType: "requirement", expectation: true, evidence: [{ kind: "quote", ref: "req.md:4" }] }).success).toBe(true);
    });

    it("default to not being an expectation", () => {
        expect(TransitionSchema.parse({ entity: "order", from: "a", to: "b", sourceType: "db_schema", evidence: [{ kind: "file", ref: "schema.sql:3" }] }).expectation).toBe(false);
    });
});

describe("the new parts of a model", () => {
    it("hold navigation, form constraints, page structures, roles, sources, missing context and the application version", () => {
        const m = AppModelSchema.parse({
            ...PHASE_1_STORED,
            pages: [
                {
                    id: "signup",
                    path: "/signup",
                    screenId: "S3",
                    reachableBy: ["admin", "member"],
                    forms: [{ name: "Sign up", fields: [{ name: "age", type: "number", required: true, min: "18", max: "120", message: "Value must be 18 or more." }, { name: "plan", type: "select", options: ["free", "pro"] }] }],
                    structures: [{ kind: "table", name: "Plans", headers: ["Plan", "Price"] }, { kind: "dialog", name: "Terms" }],
                    interactions: [{ control: "Open details", method: "GET", path: "/api/plans/{id}" }],
                },
            ],
            endpoints: [documented, observed],
            navigation: [{ from: "home", to: "signup", control: "Sign up", evidence: [{ kind: "page", ref: "/" }] }],
            roles: [{ name: "admin", reaches: ["signup"], differs: ["Sees the Delete button"], evidence: [{ kind: "page", ref: "/signup" }] }],
            sources: [{ kind: "openapi", ref: "https://shop.test/openapi.json", fingerprint: "a".repeat(64), status: "processed", processedAt: "2026-11-16T00:00:00.000Z" }],
            missingContext: [{ text: "No requirements document: rules are inferred only.", source: "requirements" }],
            appVersion: { source: "person", label: "2.4.1", analysedAt: "2026-11-16T00:00:00.000Z" },
        });
        expect(m.pages[0]!.forms[0]!.fields[0]).toMatchObject({ required: true, min: "18", message: "Value must be 18 or more." });
        expect(m.endpoints.map((e) => e.origin)).toEqual(["documented", "observed"]);
    });

    it("refuse a navigation edge without evidence", () => {
        expect(AppModelSchema.safeParse({ navigation: [{ from: "a", to: "b", control: "Go", evidence: [] }] }).success).toBe(false);
    });

    it("never invent an application version: a label is needed unless it is unversioned", () => {
        expect(AppVersionSchema.safeParse({ source: "unversioned", label: "", analysedAt: "2026-11-16T00:00:00.000Z" }).success).toBe(true);
        expect(AppVersionSchema.safeParse({ source: "person", label: "", analysedAt: "2026-11-16T00:00:00.000Z" }).success).toBe(false);
        expect(AppVersionSchema.safeParse({ source: "repository", label: "9f2c1ab", analysedAt: "2026-11-16T00:00:00.000Z" }).success).toBe(true);
        expect(AppVersionSchema.safeParse({ source: "page", label: "v3", analysedAt: "2026-11-16T00:00:00.000Z" }).success).toBe(false);
    });
});

describe("the rule fingerprint", () => {
    it("is a sha256 that ignores only spacing and the order of linked items", () => {
        const a = ruleFingerprint(rule());
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        const b = ruleFingerprint(rule({ expected: "  The quantity is between 1   and 10. ", entities: ["item", " cart"], ref: "R-9", description: "Other words", confidence: 0.2 }));
        expect(b).toBe(a);
    });

    it("changes with case or a character that only looks alike: a person confirmed exactly what they read", () => {
        expect(ruleFingerprint(rule({ expected: "Use the code SAVE10." }))).not.toBe(ruleFingerprint(rule({ expected: "Use the code save10." })));
        expect(ruleFingerprint(rule({ expected: "At most 10² items." }))).not.toBe(ruleFingerprint(rule({ expected: "At most 102 items." })));
        expect(ruleFingerprint(rule({ endpoints: ["GET /api/Orders/{id}"] }))).not.toBe(ruleFingerprint(rule({ endpoints: ["get /api/orders/{id}"] })));
    });

    it("changes when what the rule expects, its kind or its links change", () => {
        const a = ruleFingerprint(rule());
        expect(ruleFingerprint(rule({ expected: "The quantity is between 1 and 20." }))).not.toBe(a);
        expect(ruleFingerprint(rule({ kind: "invariant" }))).not.toBe(a);
        expect(ruleFingerprint(rule({ workflows: ["returns"] }))).not.toBe(a);
        // A link moved from one list to another is a different rule.
        expect(ruleFingerprint(rule({ entities: ["cart"], workflows: ["checkout", "item"] }))).not.toBe(a);
    });
});

describe("the diff between two analyses", () => {
    it("covers pages, workflows, entities, endpoints and roles: added, removed and changed", () => {
        const before = AppModelSchema.parse({ ...PHASE_1_STORED, endpoints: [documented], roles: [{ name: "admin", reaches: [], evidence: [{ kind: "page", ref: "/" }] }] });
        const after = AppModelSchema.parse({
            ...PHASE_1_STORED,
            pages: [{ id: "cart", path: "/cart", purpose: "Shows the cart and its total" }],
            endpoints: [observed],
            roles: [{ name: "admin", reaches: [], evidence: [{ kind: "page", ref: "/" }] }, { name: "member", reaches: [], evidence: [{ kind: "page", ref: "/" }] }],
        });
        const d = diffModels(before, after);
        expect(d.pages).toEqual({ added: [], removed: [], changed: ["cart"] });
        expect(d.endpoints).toEqual({ added: ["POST /api/cart/items"], removed: ["GET /api/orders/{id}"], changed: [] });
        expect(d.roles).toEqual({ added: ["member"], removed: [], changed: [] });
        expect(d.workflows).toEqual({ added: [], removed: [], changed: [] });
    });

    it("is empty for the same model", () => {
        const m = AppModelSchema.parse(PHASE_1_STORED);
        const d = diffModels(m, AppModelSchema.parse(PHASE_1_STORED));
        for (const part of Object.values(d)) expect(part).toEqual({ added: [], removed: [], changed: [] });
    });
});

describe("the fragment a source returns", () => {
    const source = { kind: "openapi", ref: "https://shop.test/openapi.json", fingerprint: "b".repeat(64), status: "processed" };

    it("carries a source record; a failed source says why in a sentence", () => {
        expect(SourceRecordSchema.safeParse(source).success).toBe(true);
        expect(SourceRecordSchema.safeParse({ ...source, status: "failed" }).success).toBe(false);
        expect(SourceRecordSchema.safeParse({ ...source, status: "failed", error: "The document could not be read." }).success).toBe(true);
        expect(SourceRecordSchema.safeParse({ ...source, kind: "figma" }).success).toBe(false);
    });

    it("holds a partial model and rules that cannot claim to be confirmed", () => {
        const f = ModelFragmentSchema.parse({ source, model: { endpoints: [documented] } });
        expect(f.model.endpoints).toHaveLength(1);
        expect(f.model.pages).toEqual([]);
        expect(f.rules).toEqual([]);
        expect(ModelFragmentSchema.safeParse({ source, model: {}, rules: [{ ...rule(), status: "confirmed" }] }).success).toBe(false);
    });
});
