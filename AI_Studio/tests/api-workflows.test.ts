/**
 * Multi-request API workflows: chain detection (unit) and generated list → detail / login → secured
 * workflows executed for real against the bundled sample app (integration), including proof that a
 * broken capture fails the test instead of requesting /things/undefined.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { request } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { probeOpenApi } from "../src/engine/api/openapi.js";
import type { DraftSpec } from "../src/engine/api/test-specs.js";
import { generateApiWorkflowSpecs } from "../src/engine/api/workflows.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type Step, type TestSpec } from "../src/engine/spec/schema.js";
import type { ApiEndpointModel, OpenApiOperation } from "../src/engine/understanding/app-model.js";
import { runScripts } from "../src/engine/validation/runner.js";

const PORT = 5101;
const BASE = `http://127.0.0.1:${PORT}`;

// ── Hand-built endpoint models ────────────────────────────────────────────────

const Pet = { type: "object", required: ["id", "name"], properties: { id: { type: "integer", readOnly: true }, name: { type: "string" }, tag: { type: "string" } } };

function op(method: string, p: string, detail: Partial<OpenApiOperation> = {}, extra: Partial<ApiEndpointModel> = {}): ApiEndpointModel {
    const spec: OpenApiOperation = { tags: [], parameters: [], responses: [], security: [], ...detail };
    return {
        method,
        path: p,
        origin: "http://api.test",
        statuses: spec.responses.map((r) => Number(r.status)),
        queryParams: [],
        requiresAuth: spec.security.length > 0,
        source: "openapi",
        spec,
        usedIn: [],
        ...extra,
    };
}

const petIdParam = { name: "petId", location: "path" as const, required: true, type: "integer" };
const petstore: ApiEndpointModel[] = [
    op("GET", "/pets", { responses: [{ status: "200", description: "ok", schema: { type: "array", items: Pet } }] }),
    op("POST", "/pets", {
        requestBody: { required: true, contentType: "application/json", schema: Pet },
        responses: [{ status: "201", description: "created", schema: Pet }],
    }),
    op("GET", "/pets/{petId}", { parameters: [petIdParam], responses: [{ status: "200", description: "ok", schema: Pet }] }),
    op("PUT", "/pets/{petId}", {
        parameters: [petIdParam],
        requestBody: { required: true, contentType: "application/json", schema: Pet },
        responses: [{ status: "200", description: "ok", schema: Pet }],
    }),
    op("DELETE", "/pets/{petId}", { parameters: [petIdParam], responses: [{ status: "204", description: "deleted" }] }),
    op("POST", "/auth/login", {
        requestBody: { required: true, contentType: "application/json", schema: { type: "object", properties: { username: { type: "string" }, password: { type: "string" } } } },
        responses: [{ status: "200", description: "ok", schema: { type: "object", properties: { access_token: { type: "string" }, refresh_token: { type: "string" } } } }],
    }),
    op("GET", "/me", { security: ["bearerAuth"], responses: [{ status: "200", description: "ok", schema: { type: "object", properties: { email: { type: "string" } } } }] }),
];

const requests = (s: DraftSpec) => s.steps.filter((x): x is Extract<Step, { action: "request" }> => x.action === "request");
const byTag = (specs: DraftSpec[], tag: string) => specs.filter((s) => s.tags.includes(tag));

describe("workflow chain detection", () => {
    it("builds a safe list → detail chain that threads the listed id into the detail path", () => {
        const { specs } = generateApiWorkflowSpecs(petstore, { allowMutating: false, maxWorkflows: 10 });
        const [wf] = byTag(specs, "list-detail");
        expect(wf).toBeDefined();
        expect(wf!.type).toBe("workflow");
        expect(wf!.kind).toBe("api");
        expect(wf!.tags).toEqual(expect.arrayContaining(["api", "workflow"]));
        expect(wf!.source.origin).toBe("openapi");
        const [list, detail] = requests(wf!);
        expect(list).toMatchObject({ method: "GET", path: "/pets", extract: { petId: "0.id" } });
        expect(detail).toMatchObject({ method: "GET", path: "/pets/{{petId}}" });
        expect(wf!.steps).toContainEqual(expect.objectContaining({ action: "assertResponse", check: "jsonPath", path: "id", expected: "{{petId}}" }));
        // The spec is valid canonical input once the orchestrator assigns an id.
        expect(() => TestSpecSchema.parse({ ...wf, testId: "API-001" })).not.toThrow();
    });

    it("safe mode generates no mutating requests and counts the skipped chains", () => {
        const { specs, skippedMutating } = generateApiWorkflowSpecs(petstore, { allowMutating: false, maxWorkflows: 10 });
        expect(specs.flatMap(requests).every((r) => r.method === "GET")).toBe(true);
        expect(skippedMutating).toBe(2); // crud_pets + auth_login_then_me
    });

    it("detects the OpenAPI CRUD chain: create → read → update → delete → read-after-delete 4xx", () => {
        const { specs, skippedMutating } = generateApiWorkflowSpecs(petstore, { allowMutating: true, maxWorkflows: 10 });
        expect(skippedMutating).toBe(0);
        const [crud] = byTag(specs, "crud");
        expect(crud).toBeDefined();
        const reqs = requests(crud!);
        expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /pets", "GET /pets/{{petId}}", "PUT /pets/{{petId}}", "DELETE /pets/{{petId}}", "GET /pets/{{petId}}"]);
        expect(reqs[0]!.extract).toEqual({ petId: "id" });
        // readOnly id is not sent in the create body; unique-ish strings avoid collisions between runs.
        expect(reqs[0]!.body).not.toHaveProperty("id");
        expect(reqs[0]!.body).toMatchObject({ name: expect.stringContaining("{{unique}}") });
        const asserts = crud!.steps.filter((s) => s.action === "assertResponse");
        expect(asserts[asserts.length - 1]).toMatchObject({ check: "statusClass", expected: "4xx" });
        expect(asserts).toContainEqual(expect.objectContaining({ check: "jsonPath", path: "id", expected: "{{petId}}" }));
    });

    it("detects a login → secured endpoint chain using a captured bearer token (never the refresh token)", () => {
        const { specs } = generateApiWorkflowSpecs(petstore, { allowMutating: true, maxWorkflows: 10 });
        const [auth] = byTag(specs, "auth");
        expect(auth).toBeDefined();
        const [login, secured] = requests(auth!);
        expect(login).toMatchObject({ method: "POST", path: "/auth/login", auth: "none", extract: { token: "access_token" } });
        expect(login!.body).toEqual({ username: "{{credentials.username}}", password: "{{credentials.password}}" });
        expect(secured).toMatchObject({ method: "GET", path: "/me", auth: "none", headers: { Authorization: "Bearer {{token}}" } });
    });

    it("handles generic {id} params, wrapped list responses and <resource>Id fields from observed traffic", () => {
        const eps: ApiEndpointModel[] = [
            {
                method: "GET", path: "/api/v1/orders", origin: "http://x", statuses: [200], queryParams: [], source: "network", usedIn: [],
                responseSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { orderId: { type: "string" }, total: { type: "number" } } } } } },
            },
            {
                method: "GET", path: "/api/v1/orders/{id}", origin: "http://x", statuses: [200], queryParams: [], source: "network", usedIn: [],
                responseSchema: { type: "object", properties: { data: { type: "object", properties: { orderId: { type: "string" } } } } },
            },
        ];
        const { specs } = generateApiWorkflowSpecs(eps, { allowMutating: false, maxWorkflows: 5 });
        expect(specs).toHaveLength(1);
        expect(specs[0]!.source.origin).toBe("network");
        const [list, detail] = requests(specs[0]!);
        expect(list!.extract).toEqual({ orderId: "items.0.orderId" });
        expect(detail!.path).toBe("/api/v1/orders/{{orderId}}");
        expect(specs[0]!.steps).toContainEqual(expect.objectContaining({ check: "jsonPath", path: "data.orderId", expected: "{{orderId}}" }));
    });

    it("builds nested chains by creating each parent first, and respects maxWorkflows", () => {
        const User = { type: "object", properties: { id: { type: "integer" } } };
        const Post = { type: "object", properties: { id: { type: "integer" }, title: { type: "string" } } };
        const eps = [
            op("POST", "/users", { responses: [{ status: "201", description: "", schema: User }] }),
            op("POST", "/users/{userId}/posts", { parameters: [{ name: "userId", location: "path", required: true, type: "integer" }], responses: [{ status: "201", description: "", schema: Post }] }),
            op("GET", "/users/{userId}/posts/{postId}", { responses: [{ status: "200", description: "", schema: Post }] }),
        ];
        const { specs } = generateApiWorkflowSpecs(eps, { allowMutating: true, maxWorkflows: 10 });
        const [nested] = byTag(specs, "nested");
        expect(requests(nested!).map((r) => `${r.method} ${r.path}`)).toEqual(["POST /users", "POST /users/{{userId}}/posts", "GET /users/{{userId}}/posts/{{postId}}"]);
        expect(generateApiWorkflowSpecs(eps, { allowMutating: true, maxWorkflows: 0 }).specs).toHaveLength(0);
    });

    it("renders captures, a missing-value guard, and {{var}} expectations compared as text", () => {
        const { specs } = generateApiWorkflowSpecs(petstore, { allowMutating: false, maxWorkflows: 10 });
        const spec = TestSpecSchema.parse({ ...byTag(specs, "list-detail")[0], testId: "API-900" });
        const { content } = renderScript(spec, "playwright-api", { baseUrl: "http://api.test" });
        expect(content).toContain('data["petId"] = capture(last, "petId", "0.id");');
        expect(content).toContain('need("petId");');
        expect(content).toContain('`/pets/${data["petId"] ?? ""}`');
        expect(content).toContain('expect(String(at(last.json, "id"))).toBe(`${data["petId"] ?? ""}`);');
    });
});

// ── Integration against the sample app ───────────────────────────────────────

let app: ChildProcess;
beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) return;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    throw new Error("sample app did not start");
}, 20_000);
afterAll(() => app?.kill());

const cfg = loadConfig({});
// No API_TOKEN: the login workflow must succeed with the token it captured itself.
const env = { baseUrl: BASE, credentials: { username: "demo@example.com", password: "Password123!" }, headless: true };

describe("workflow execution against the sample app", () => {
    it("generated list → detail and login → /api/me workflows pass; a broken capture fails clearly", async () => {
        const ctx = await request.newContext();
        const found = await probeOpenApi(ctx, BASE);
        await ctx.dispose();
        expect(found).not.toBeNull();
        const ops = found!.parsed.operations;

        const safe = generateApiWorkflowSpecs(ops, { allowMutating: false, maxWorkflows: 10 });
        expect(safe.specs).toHaveLength(1);
        expect(safe.skippedMutating).toBe(1); // POST /api/login → GET /api/me
        const mutating = generateApiWorkflowSpecs(ops, { allowMutating: true, maxWorkflows: 10 });
        const authWf = byTag(mutating.specs, "auth");
        expect(authWf).toHaveLength(1);

        const listDetail = safe.specs[0]!;
        expect(requests(listDetail).map((r) => r.path)).toEqual(["/api/products", "/api/products/{{productId}}"]);

        // Same workflow, but capturing from a path that does not exist in the list response.
        const broken = structuredClone(listDetail);
        (broken.steps[0] as Extract<Step, { action: "request" }>).extract = { productId: "0.doesNotExist" };
        broken.title = "Broken capture must FAIL";

        const full: TestSpec[] = [listDetail, authWf[0]!, broken].map((d, i) => TestSpecSchema.parse({ ...d, testId: `API-${String(901 + i)}` }));
        const scripts = full.map((s) => {
            const r = renderScript(s, "playwright-api", { baseUrl: BASE });
            return { testId: s.testId, filename: r.filename, content: r.content };
        });
        const runs = await runScripts(cfg.scratchDir, scripts, env, { workers: 3 });
        const by = Object.fromEntries(runs.map((r) => [r.testId, r]));

        expect(by["API-901"]!.status, by["API-901"]!.error).toBe("passed");
        expect(by["API-901"]!.responses.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(["GET /api/products 200", "GET /api/products/1 200"]);
        expect(by["API-902"]!.status, by["API-902"]!.error).toBe("passed");
        expect(by["API-902"]!.responses.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(["POST /api/login 200", "GET /api/me 200"]);

        const bad = by["API-903"]!;
        expect(bad.status).toBe("failed");
        expect(bad.failedStepIndex).toBe(0);
        expect(bad.error).toMatch(/Could not capture "productId": no value at "0\.doesNotExist"/);
        // The detail request was never sent with an empty/undefined id.
        expect(bad.responses.map((r) => r.path)).toEqual(["/api/products"]);
    }, 120_000);
});
