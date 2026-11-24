/**
 * C12 (Phase 4) layer report, skeleton: every run says, for the page, the API, stored data (through the API) and the database, either
 * that it was checked (with how many tests) or that it was not, and why. Each generated test carries its layer (meta.layer).
 * Expected wording comes from PHASE_4_SPEC §4.4 / C12 ("Database: not checked (no read-only access set up)").
 */
import { describe, expect, it } from "vitest";
import { ResultRequest } from "../src/agent-protocol/schema.js";
import { LayerReportSchema, layerOfSpec, layerReport, layersOfSpec } from "../src/engine/validation/layers.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { backendOpsChains } from "../src/engine/api/backend-ops.js";
import { generateApiSpecs } from "../src/engine/api/test-specs.js";
import { generateApiWorkflowSpecs } from "../src/engine/api/workflows.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const SHOP = parseOpenApi(await benchOpenApi("bench-shop"), "http://127.0.0.1:9602/openapi.json").operations;
const shopWorkflow = (title: string) => {
    const s = generateApiWorkflowSpecs(SHOP, { allowMutating: true, maxWorkflows: 50 }).specs.find((x) => x.title.startsWith(title));
    if (!s) throw new Error(`no workflow "${title}"`);
    return s;
};

const on = { web: true, api: true, apiEndpoints: 3, dataChanges: true };
const nav = { action: "navigate", url: "/", description: "" } as const;

describe("the layer of a test (meta.layer)", () => {
    it("API tests and API access checks are the API layer; page tests are the page layer", () => {
        expect(layerOfSpec({ kind: "api", steps: [] })).toBe("api");
        expect(layerOfSpec({ kind: "web", steps: [nav, { action: "assert", check: "accessDenied", expected: JSON.stringify({ api: true, as: "bob", path: "/api/x" }), description: "" }] as never })).toBe("api");
        expect(layerOfSpec({ kind: "web", steps: [nav, { action: "assert", check: "accessDenied", expected: JSON.stringify({ as: "bob", path: "/admin" }), description: "" }] as never })).toBe("page");
        expect(layerOfSpec({ kind: "web", steps: [nav] as never })).toBe("page");
    });

    // Gap 3 (VERIFY-P3-P4): bench-shop's C9 read-backs catch BS-06 (profile not stored) and BS-12 (newest order missing), yet every run
    // said "no write was read back through the API". Spec §4.3: C5, C6, C7 and C9 read stored data back through the API.
    it("bench-shop's read-back chains (C9) and backend operations (C6) are the stored-data layer, and still API tests", () => {
        const profile = shopWorkflow("Workflow: what is written is read back (PUT /api/profile");
        const orders = shopWorkflow("Workflow: order lifecycle");
        const duplicate = backendOpsChains(SHOP).find((c) => c.spec.title.startsWith("Backend: the same write twice"))!.spec;
        for (const s of [profile, orders, duplicate]) {
            expect(layerOfSpec(s)).toBe("storedData");
            expect(layersOfSpec(s)).toEqual(["api", "storedData"]);
        }
        const plain = generateApiSpecs(SHOP, { allowMutating: false, maxPerEndpoint: 6 }).specs.find((x) => x.title.startsWith("GET /api/products"))!;
        expect(layersOfSpec(plain)).toEqual(["api"]);
    });

    it("a test holding a database check (C10) is the database layer, and keeps the layers it reads through", () => {
        const profile = shopWorkflow("Workflow: what is written is read back (PUT /api/profile");
        const db = { action: "assertResponse", check: "dbCheck", name: "exists users(name = {{unique}}w)", description: "" } as const;
        const withDb = { ...profile, steps: [...profile.steps, db] };
        expect(layerOfSpec(withDb)).toBe("database");
        expect(layersOfSpec(withDb)).toEqual(["api", "storedData", "database"]);
        expect(layersOfSpec({ kind: "web", steps: [nav, db] as never })).toEqual(["page", "database"]);
    });
});

describe("the run's layer report (summary.layers)", () => {
    it("a layer with tests is checked, with its count", () => {
        const r = layerReport({ page: 4, api: 2 }, on);
        expect(r.page).toEqual({ status: "ran", tests: 4 });
        expect(r.api).toEqual({ status: "ran", tests: 2 });
    });

    it("each layer that was not checked says why, in its own condition", () => {
        expect(layerReport({}, { ...on, web: false }).page).toEqual({ status: "unavailable", reason: "Not checked: this run makes no web tests." });
        expect(layerReport({}, on).page).toEqual({ status: "unavailable", reason: "Not checked: no page test was made." });
        expect(layerReport({}, { ...on, api: false }).api).toEqual({ status: "unavailable", reason: "Not checked: API tests are not part of this run." });
        expect(layerReport({}, { ...on, apiEndpoints: 0 }).api).toEqual({ status: "unavailable", reason: "Not checked: no API was found (no API document, and none seen while exploring)." });
        expect(layerReport({}, on).api).toEqual({ status: "unavailable", reason: "Not checked: no API test was made." });
        expect(layerReport({}, { ...on, dataChanges: false }).storedData).toEqual({ status: "unavailable", reason: "Not checked: data changes are off, so nothing is written and read back." });
        expect(layerReport({}, on).storedData).toEqual({ status: "unavailable", reason: "Not checked: no write was read back through the API." });
    });

    it("the database is not available until a back end is set up", () => {
        expect(layerReport({ page: 1, api: 1, storedData: 1 }, on).database).toEqual({ status: "unavailable", reason: "Not checked: no read-only database access is set up." });
    });

    it("every layer is always listed, and the report checks against its own schema", () => {
        const r = layerReport({ api: 1 }, on);
        expect(Object.keys(r)).toEqual(["page", "api", "storedData", "database"]);
        expect(LayerReportSchema.safeParse(r).success).toBe(true);
        expect(LayerReportSchema.safeParse({ ...r, page: { status: "ran" } }).success).toBe(false);
        // nothing but the count rides along (no row values, no evidence in the summary)
        expect(LayerReportSchema.safeParse({ ...r, api: { status: "ran", tests: 1, rows: ["x"] } }).success).toBe(false);
    });
});

describe("old summaries", () => {
    const explore = { testsGenerated: 1, testsValidated: 1, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
    it("a runner's result without layers parses as before; one with layers keeps them", () => {
        expect(ResultRequest.safeParse({ ok: true, runs: [], explore }).success).toBe(true);
        const r = layerReport({ api: 1 }, on);
        const parsed = ResultRequest.parse({ ok: true, runs: [], explore: { ...explore, layers: r } });
        expect(LayerReportSchema.parse(parsed.explore!.layers)).toEqual(r);
    });
});
