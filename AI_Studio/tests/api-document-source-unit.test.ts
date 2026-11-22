/**
 * A check's stated source (lead decision, eng-all): an expectation taken from the application's own API document (a documented status,
 * the documented schema, a documented refusal) names it as `API document: <METHOD> <path> <status>`; a requirement id on the test is
 * carried onto its checks that name nothing. A check whose expectation comes from neither (an observed status, a behaviour rule) keeps no
 * source, and a source a check already names is kept.
 */
import { describe, expect, it } from "vitest";
import { withStatedSources } from "../src/engine/api/stated-source.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import type { ApiEndpointModel } from "../src/engine/understanding/app-model.js";

const ep = (method: string, path: string, statuses: string[], source: ApiEndpointModel["source"] = "openapi"): ApiEndpointModel =>
    ({ method, path, origin: "http://app", statuses: statuses.map(Number), queryParams: [], source, usedIn: [], ...(source === "openapi" ? { spec: { responses: statuses.map((status) => ({ status, ...(status.startsWith("2") ? { schema: { type: "object" } } : {}) })) } } : {}) }) as unknown as ApiEndpointModel;
const APIS = [ep("POST", "/api/items", ["201", "400"]), ep("GET", "/api/items/{id}", ["200", "404"]), ep("GET", "/api/seen", ["200", "500"], "network")];
const spec = (steps: unknown[], source: Record<string, unknown> = { origin: "openapi" }) => TestSpecSchema.parse({ testId: "API-001", title: "A check", kind: "api", category: "API", source, steps });
const sources = (s: TestSpec) => s.steps.map((x) => (x as { source?: string }).source ?? null);

describe("withStatedSources", () => {
    it("names the API document for a documented status and the documented schema, on the request that precedes them", () => {
        const s = spec([
            { action: "request", method: "POST", path: "/api/items", body: { qty: -1 } },
            { action: "assertResponse", check: "status", expected: 400 },
            { action: "request", method: "GET", path: "/api/items/{{itemId}}" },
            { action: "assertResponse", check: "status", expected: 200 },
            { action: "assertResponse", check: "matchesSchema", schema: { type: "object" } },
        ]);
        withStatedSources(s, APIS);
        expect(sources(s)).toEqual([null, "API document: POST /api/items 400", null, "API document: GET /api/items/{id} 200", "API document: GET /api/items/{id} 200"]);
    });

    it("names nothing for an undocumented status, an endpoint only seen on the wire, or a status class", () => {
        const s = spec([
            { action: "request", method: "POST", path: "/api/items" },
            { action: "assertResponse", check: "status", expected: 409 },
            { action: "assertResponse", check: "statusClass", expected: "2xx" },
            { action: "request", method: "GET", path: "/api/seen" },
            { action: "assertResponse", check: "status", expected: 500 },
        ]);
        withStatedSources(s, APIS);
        expect(sources(s)).toEqual([null, null, null, null, null]);
    });

    it("names the documented refusal of an access check", () => {
        const s = spec([{ action: "assert", check: "accessDenied", expected: JSON.stringify({ api: true, refuse: true, as: "a", path: "/api/items/i-7", by: "b", documented: "404" }) }], { origin: "access-check" });
        withStatedSources(s, APIS);
        expect(sources(s)).toEqual(["API document: GET /api/items/{id} 404"]);
    });

    it("carries the test's requirement ids onto checks that name nothing, and keeps a source a check names", () => {
        const s = spec(
            [
                { action: "request", method: "POST", path: "/api/items" },
                { action: "assertResponse", check: "statusClass", expected: "2xx" },
                { action: "assertResponse", check: "relation", expression: "total == 1", source: "4.5" },
            ],
            { origin: "requirements", requirements: ["4.1", "4.2"] },
        );
        withStatedSources(s, APIS);
        expect(sources(s)).toEqual([null, "4.1, 4.2", "4.5"]);
    });
});
