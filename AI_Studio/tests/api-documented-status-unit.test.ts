/**
 * The API tests expect what the OpenAPI document says (sheet 28 follow-up, E2E on the Practice Store):
 *   - a call whose document lists no 2xx answer is tested for its documented status (an endpoint that always fails with 500);
 *   - a streaming call (a WebSocket upgrade, a text/event-stream answer) gets no request test, with a reason, instead of a timeout;
 *   - a payload echoed inside a JSON answer is not a reflected-payload failure; the check stays where the answer may be HTML;
 *   - a valid call that this account is refused in a way the document lists for that call (403; 404 of a fixed address) is tested
 *     for that status (documentedCallerStatus, applied by the validator before any AI repair).
 * Pure: npx vitest run -c vitest.fast.config.ts tests/api-documented-status-unit.test.ts
 */
import { describe, expect, it } from "vitest";
import { documentedCallerStatus } from "../src/engine/api/documented-status.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateApiSpecs, type DraftSpec } from "../src/engine/api/test-specs.js";
import type { TestSpec } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";

const json = (schema: object = { type: "object", properties: { ok: { type: "boolean" } } }) => ({ content: { "application/json": { schema } } });
const err = (description: string) => ({ description, ...json({ type: "object", properties: { error: { type: "object" } } }) });
const DOC = {
    openapi: "3.1.0",
    info: { title: "Shop", version: "1" },
    paths: {
        "/api/broken": { get: { summary: "Always fails", responses: { 500: err("Server error") } } },
        "/api/live/ws": { get: { summary: "WebSocket chat", responses: { 101: { description: "Switching Protocols (WebSocket)" }, 426: err("Upgrade required") } } },
        "/api/live/events": { get: { summary: "Events", responses: { 200: { description: "OK", content: { "text/event-stream": { schema: { type: "string" } } } } } } },
        "/api/mailbox": { get: { summary: "Mailbox", parameters: [{ name: "to", in: "query", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", ...json() }, 400: err("Invalid") } } },
        "/search": { get: { summary: "Search page", parameters: [{ name: "q", in: "query", schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "text/html": { schema: { type: "string" } } } } } } },
        "/api/admin/users": { get: { summary: "Every account", security: [{ bearerAuth: [] }], responses: { 200: { description: "OK", ...json() }, 401: err("Not signed in"), 403: err("Admins only") } } },
        "/api/account/avatar": { get: { summary: "Your avatar", security: [{ bearerAuth: [] }], responses: { 200: { description: "OK", content: { "image/png": {} } }, 401: err("Not signed in"), 404: err("Not found") } } },
        "/api/products/{id}": { get: { summary: "One product", parameters: [{ name: "id", in: "path", required: true, example: 1, schema: { type: "integer" } }], responses: { 200: { description: "OK", ...json() }, 404: err("Not found") } } },
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
};
const apis = parseOpenApi(DOC as never, "http://shop.test/openapi.json").operations;
const gen = generateApiSpecs(apis, { allowMutating: false, maxPerEndpoint: 6 });
const of = (endpoint: string) => gen.specs.filter((s) => s.title.startsWith(`${endpoint}:`));
const happy = (endpoint: string) => of(endpoint).find((s) => s.tags.includes("happy-path"))!;
const statusStep = (s: DraftSpec) => s.steps.find((x) => x.action === "assertResponse" && (x.check === "status" || x.check === "statusClass")) as { check: string; expected: unknown } | undefined;

describe("API tests from the document", () => {
    it("keeps each answer's media type from the document", () => {
        const events = apis.find((a) => a.path === "/api/live/events")!;
        expect(events.spec!.responses[0]).toMatchObject({ status: "200", contentType: "text/event-stream" });
    });

    it("tests a call that documents no 2xx answer for its documented status", () => {
        expect(statusStep(happy("GET /api/broken"))).toMatchObject({ check: "status", expected: 500 });
        expect(happy("GET /api/broken").title).toBe("GET /api/broken: answers its documented 500");
        // A call with a documented success still expects it.
        expect(statusStep(happy("GET /api/products/{id}"))).toMatchObject({ check: "statusClass", expected: "2xx" });
    });

    it("makes no request test for a streaming call, and says why", () => {
        expect(of("GET /api/live/ws")).toEqual([]);
        expect(of("GET /api/live/events")).toEqual([]);
        expect(gen.skipped).toEqual([
            { endpoint: "GET /api/live/ws", reason: expect.stringMatching(/WebSocket/) },
            { endpoint: "GET /api/live/events", reason: expect.stringMatching(/event stream/) },
        ]);
    });

    it("checks a reflected payload only where the answer may be HTML, never inside a JSON answer", () => {
        const injection = (endpoint: string) => of(endpoint).find((s) => s.tags.includes("injection"))!;
        const reflected = (s: DraftSpec) => s.steps.some((x) => x.action === "assertResponse" && x.check === "bodyNotContains");
        expect(reflected(injection("GET /api/mailbox"))).toBe(false);
        // The injection test still checks there is no server error.
        expect(injection("GET /api/mailbox").steps.filter((x) => x.action === "assertResponse" && x.check === "statusBelow")).toHaveLength(2);
        expect(reflected(injection("GET /search"))).toBe(true);
    });
});

const doc = (path: string) => {
    const ep = apis.find((a) => `${a.method} ${a.path}` === path)!;
    return { method: ep.method, path: ep.path, statuses: ep.statuses, requiresAuth: ep.requiresAuth, summary: ep.summary, spec: ep.spec };
};
const asSpec = (d: DraftSpec): TestSpec => ({ ...d, testId: "API-001" }) as TestSpec;
/** A failed run of the happy path: the request answered `status`, the status step failed. */
const failedAt = (s: TestSpec, status: number, path: string): ScriptRun => ({
    testId: s.testId,
    status: "failed",
    durationMs: 5,
    error: "expect(received).toBe(expected)",
    failedStepIndex: s.steps.findIndex((x) => x.action === "assertResponse" && x.check === "statusClass"),
    steps: [],
    artifacts: [],
    responses: [{ method: "GET", path, status }],
});

describe("a valid call this account is refused, as the document lists for it", () => {
    it("is tested for the documented 403 (an admin call with a customer's token)", () => {
        const s = asSpec(happy("GET /api/admin/users"));
        const r = documentedCallerStatus(s, failedAt(s, 403, "/api/admin/users"), doc("GET /api/admin/users"));
        expect(r).toBeDefined();
        expect(statusStep(r!.spec)).toMatchObject({ check: "status", expected: 403 });
        expect(r!.spec.steps.some((x) => x.action === "assertResponse" && x.check === "matchesSchema")).toBe(false);
        expect(r!.spec.title).toBe("GET /api/admin/users: answers 403 for this account, as documented");
        expect(r!.reason).toContain("Admins only");
    });

    it("is tested for the documented 404 of a fixed address (no avatar yet)", () => {
        const s = asSpec(happy("GET /api/account/avatar"));
        expect(statusStep(documentedCallerStatus(s, failedAt(s, 404, "/api/account/avatar"), doc("GET /api/account/avatar"))!.spec)).toMatchObject({ check: "status", expected: 404 });
    });

    it("stays a failure otherwise: a status the document does not list, a 404 for a record, a 500, or not the happy path", () => {
        const admin = asSpec(happy("GET /api/admin/users"));
        expect(documentedCallerStatus(admin, failedAt(admin, 404, "/api/admin/users"), doc("GET /api/admin/users"))).toBeUndefined();
        expect(documentedCallerStatus(admin, failedAt(admin, 401, "/api/admin/users"), doc("GET /api/admin/users"))).toBeUndefined();
        const product = asSpec(happy("GET /api/products/{id}"));
        expect(documentedCallerStatus(product, failedAt(product, 404, "/api/products/1"), doc("GET /api/products/{id}"))).toBeUndefined();
        const unauth = asSpec(of("GET /api/admin/users").find((s) => s.tags.includes("auth"))!);
        expect(documentedCallerStatus(unauth, { ...failedAt(unauth, 403, "/api/admin/users"), failedStepIndex: 1 }, doc("GET /api/admin/users"))).toBeUndefined();
        expect(documentedCallerStatus(admin, failedAt(admin, 403, "/api/admin/users"), undefined)).toBeUndefined();
    });
});
