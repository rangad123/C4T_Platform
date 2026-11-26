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

    it("credits the schema after a documented refusal to that refusal, not to the first 2xx", () => {
        const s = spec([
            { action: "request", method: "POST", path: "/api/items", body: { qty: -1 } },
            { action: "assertResponse", check: "status", expected: 400 },
            { action: "assertResponse", check: "matchesSchema", schema: { type: "object" } },
        ]);
        withStatedSources(s, APIS);
        expect(sources(s)).toEqual([null, "API document: POST /api/items 400", "API document: POST /api/items 400"]);
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

    it("names the standard rule a behaviour check proves, and only the six rules of the list", () => {
        const acc = (o: Record<string, unknown>) => ({ action: "assert", check: "accessDenied", expected: JSON.stringify({ as: "a", path: "/x/1", sev: "high", ...o }) });
        const access = spec([acc({ sessionEnd: true }), acc({ identityWrite: "revoke", by: "b" }), acc({ identityWrite: "owner", method: "PUT" }), acc({ by: "b", of: "b", marker: "M" }), acc({ identityWrite: "role", method: "PATCH" })], { origin: "access-check" });
        withStatedSources(access, APIS);
        expect(sources(access)).toEqual(["standard rule: a session ends on sign-out", "standard rule: a revoked share is gone", "standard rule: a non-owner cannot read or write", "standard rule: a non-owner cannot read or write", null]);

        const behaviour = TestSpecSchema.parse({
            testId: "API-002",
            title: "A behaviour check",
            kind: "api",
            category: "API",
            tags: ["api", "workflow", "readback"],
            steps: [
                { action: "request", method: "PUT", path: "/api/profile", body: { name: "N" } },
                { action: "assertResponse", check: "relation", expression: "name == $recordBefore.name" },
                { action: "request", method: "POST", path: "/api/orders", parallel: 3 },
                { action: "assertResponse", check: "relation", expression: "ok == 1 and refused == 2" },
                { action: "request", method: "GET", path: "/api/orders" },
                { action: "assertResponse", check: "relation", expression: "count(orders) == count($listBefore) + 1" },
                { action: "assertResponse", check: "jsonPath", path: "name", expected: "N" },
                { action: "assertResponse", check: "dbCheck", name: "exists users where name = 'N'" },
                { action: "assertResponse", check: "dbCheck", name: "orphans carts(userId) -> users(id)" },
                { action: "assertResponse", check: "statusClass", expected: "2xx" },
            ],
        });
        withStatedSources(behaviour, APIS);
        expect(sources(behaviour)).toEqual([
            null,
            "standard rule: a refused write changes nothing",
            null,
            "standard rule: one request acts once",
            null,
            "standard rule: one request acts once",
            "standard rule: read-back equals what was written",
            "standard rule: read-back equals what was written",
            null,
            null,
        ]);
        // The same value check outside a read-back test proves no rule of the list.
        const plain = spec([{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "jsonPath", path: "name", expected: "N" }]);
        withStatedSources(plain, APIS);
        expect(sources(plain)).toEqual([null, null]);
    });
});
