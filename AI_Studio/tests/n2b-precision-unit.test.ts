/**
 * Precision on a real app (the practice-store rerun): each case is built from the run's own test, its requirement or API document text,
 * its request and the app's answer. Real platform (SQLite), scripted executor and scripted model doubles; no browser, no AI.
 *   1. A finding whose expectation contradicts the API document is never Confirmed: the cart's POST /api/cart/items "adds to the line if
 *      it is already in the cart", so a repeat answered 201 is not a refused duplicate (API-070, API-157); a field absent from the cart
 *      read before and after a refused write is unchanged (API-160).
 *   2. A stated check whose failure analysis says the app is right (WEB-002: "the app is sorting correctly") waits for a person.
 *   3. An access check whose document names the refusals (401 or 404) fails on another refusal (403): a contract mismatch, medium (NOTE_403).
 *   4. A repaired API test keeps the API document as its check's source (API-084: a second SAVE10 answered 200, documented 409).
 *   5. A stored-row check targets the table of the resource the request wrote: PATCH /api/me is never checked in `products` (API-159).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { backendOpsChains } from "../src/engine/api/backend-ops.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateApiSpecs } from "../src/engine/api/test-specs.js";
import type { EngineContext } from "../src/engine/context.js";
import { cleanSchema } from "../src/engine/database/probe.js";
import { persistenceCheck } from "../src/engine/database/checks.js";
import { severityOf } from "../src/engine/findings/score.js";
import { FindingViewSchema } from "../src/engine/findings/view.js";
import { ACCESS_API_HELPER_SOURCE, ACCESS_HELPER_SOURCE, generateApiListSpecs } from "../src/engine/identity/access.js";
import { ScenarioSchema, TestSpecSchema, type Step, type TestSpec } from "../src/engine/spec/schema.js";
import { checkRelation } from "../src/engine/validation/relation.js";
import { repairApi, repairWeb } from "../src/engine/validation/repair.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { harvestExecutionFindings, verifyDepsOf, verifyFindings, type VerifyDeps } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

// ── the practice store's own API document (its /openapi.json, the parts these cases call) ──
const ERROR = { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, field: { type: "string" } } } } };
const CART = {
    type: "object",
    properties: {
        items: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, productId: { type: "integer" }, name: { type: "string" }, price: { type: "number" }, qty: { type: "integer", minimum: 1, maximum: 10 } } } },
        count: { type: "integer" },
        subtotal: { type: "number" },
        discountCode: { type: ["string", "null"] },
        total: { type: "number" },
        message: { type: "string" },
    },
};
const json = (schema: object) => ({ content: { "application/json": { schema } } });
const res = (description: string, schema: object = ERROR) => ({ description, ...json(schema) });
const STORE_DOC = {
    openapi: "3.1.0",
    info: { title: "Practice store", version: "1" },
    paths: {
        "/api/cart/items": {
            get: { summary: "Your cart with totals", responses: { 200: res("OK", CART), 401: res("Not signed in") } },
            post: {
                summary: "Add a product (adds to the line if it is already in the cart)",
                requestBody: { required: true, ...json({ type: "object", required: ["productId"], properties: { productId: { type: "integer", minimum: 1 }, qty: { type: "integer", minimum: 1, maximum: 10 } } }) },
                responses: { 201: res("Created", CART), 400: res("Invalid input"), 401: res("Not signed in"), 404: res("Not found"), 409: res("Conflict with the current state") },
            },
        },
        "/api/cart/discount": {
            post: {
                summary: "Apply a discount code (SAVE10: 10% off, once per account)",
                requestBody: { required: true, ...json({ type: "object", required: ["code"], properties: { code: { type: "string", maxLength: 40 } } }) },
                responses: { 200: res("OK", CART), 400: res("Invalid input"), 401: res("Not signed in"), 409: res("Conflict with the current state") },
            },
        },
    },
};
const STORE = parseOpenApi(STORE_DOC, "http://127.0.0.1:8351/openapi.json").operations;

const signup: Step[] = [
    { action: "request", method: "POST", path: "/api/auth/signup", body: { name: "test-name-{{unique}}", email: "qa+{{unique}}@example.com", password: "test-password-{{unique}}", confirmPassword: "test-password-{{unique}}", age: 18, country: "IN", terms: true }, auth: "default", description: "Create a fresh account for this check" },
    { action: "assertResponse", check: "statusClass", expected: "2xx", description: "The fresh account is created" },
] as Step[];

/** API-070 as the run stored it (spec_json of test_cases), the documented duplicate case of POST /api/cart/items. */
const API_070 = TestSpecSchema.parse({
    testId: "API-070",
    title: "POST /api/cart/items: rejects the same request twice (a duplicate)",
    description: "Add a product (adds to the line if it is already in the cart)",
    kind: "api",
    category: "API · cart",
    type: "negative",
    priority: "medium",
    preconditions: ["A valid API credential is configured (API_TOKEN)"],
    steps: [
        ...signup,
        { action: "request", method: "POST", path: "/api/cart/items", body: { productId: 1, qty: 1 }, auth: "default", description: "Send a valid request" },
        { action: "assertResponse", check: "statusClass", expected: "2xx", description: "The first one is accepted" },
        { action: "request", method: "POST", path: "/api/cart/items", body: { productId: 1, qty: 1 }, auth: "default", description: "Send the same request again" },
        { action: "assertResponse", check: "status", expected: 409, description: "Answered with the documented HTTP 409", source: "API document: POST /api/cart/items 409" },
    ],
    expectedResults: ["HTTP 409 (Conflict with the current state), as the API document says"],
    tags: ["api", "validation", "documented"],
    source: { origin: "openapi" },
});

describe("1. an expectation the API document contradicts", () => {
    it("generation: no duplicate refusal for a write whose document says a repeat adds to the line; one for a once-only code", () => {
        const titles = generateApiSpecs(STORE, { allowMutating: true, maxPerEndpoint: 6 }).specs.map((s) => s.title);
        expect(titles).toContain("POST /api/cart/discount: rejects the same request twice (a duplicate)");
        expect(titles).not.toContain("POST /api/cart/items: rejects the same request twice (a duplicate)");
        // C6: the same write twice expects no 409 from POST /api/cart/items either (API-157).
        const dup = backendOpsChains(STORE).map((c) => c.spec).filter((s) => s.title.startsWith("Backend: the same write twice"));
        for (const s of dup) expect(s.steps.some((x) => x.action === "assertResponse" && x.check === "status" && x.expected === 409), s.title).toBe(false);
    });

    it("API-157's comparison: a field the cart read leaves out before and after the refused write is unchanged; one that went missing is not", () => {
        const before = { items: [{ id: 1, productId: 1, qty: 1 }], count: 1, subtotal: 12, discountCode: null, total: 17 };
        expect(checkRelation("message == $recordBefore.message", { body: before, vars: { recordBefore: JSON.stringify(before) } })).toMatchObject({ held: true });
        expect(checkRelation("message == $recordBefore.message", { body: before, vars: { recordBefore: JSON.stringify({ ...before, message: "SAVE10 applied" }) } })).toMatchObject({
            held: false,
            message: expect.stringContaining("no value at message"),
        });
        expect(checkRelation("message != $recordBefore.message", { body: before, vars: { recordBefore: JSON.stringify(before) } })).toMatchObject({ held: false });
    });
});

// ── verification on a real platform ──
let platform: Platform;
let dir = "";
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-n2bprec-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "n2b-precision-secret-key-0123456789abcdef", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A project with one test left as a finding by its run (failing at step `at`, 0-based), and that finding. */
async function seed(spec: TestSpec, framework: "playwright" | "playwright-api", at: number, reason?: string) {
    const projectId = String(platform.repo.createProject({ name: spec.testId }).id);
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:7651", { ...DEFAULT_JOB_OPTIONS, allowMutatingApiTests: true }, { username: "user@practice.test", password: "pw-n2b" });
    const suiteId = platform.repo.getOrCreateSuite(projectId, spec.category, spec.category);
    const testId = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework, validationStatus: "NEEDS_REVIEW" });
    if (reason) platform.repo.updateTest(testId, { reason });
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId] });
    const t = platform.repo.getTest(testId)!;
    const store = new CandidateFindingStore(platform.sql);
    const [finding] = await harvestExecutionFindings(store, { projectId, jobId: job.id, failed: [{ test: { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework }, run: runOf(spec, at) }] });
    return { projectId, job, store, finding: finding! };
}
const ERRORS: Record<string, string> = {
    "API-070": "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 409\nReceived: 201",
    "WEB-002": 'Error: 3. Verify exactText of css "tbody tr:nth-child(1) td:nth-child(1)" = Order 1005\n\nexpect(locator).toHaveText(expected) failed',
};
function runOf(spec: TestSpec, at: number): ScriptRun {
    const responses = spec.kind === "api" ? [{ method: "POST", path: "/api/auth/signup", status: 201 }, { method: "POST", path: "/api/cart/items", status: 201 }, { method: "POST", path: "/api/cart/items", status: 201 }] : [];
    return {
        testId: spec.testId,
        status: "failed",
        durationMs: 1,
        failedStepIndex: at,
        steps: spec.steps.slice(0, at + 1).map((s, i) => ({ index: i, title: `${i + 1}. ${s.description ?? s.action}`, status: i === at ? "failed" : "passed", ...(i === at ? { error: ERRORS[spec.testId] } : {}) })),
        artifacts: [],
        responses: responses as ScriptRun["responses"],
    };
}
const verify = async (s: Awaited<ReturnType<typeof seed>>, spec: TestSpec, at: number) => {
    const execute: VerifyDeps["execute"] = async () => [runOf(spec, at), runOf(spec, at), runOf(spec, at)];
    await verifyFindings({ ...verifyDepsOf(platform, s.job, { execute }), findings: [s.finding] });
    return (await s.store.get(s.projectId, s.finding.id))!;
};

describe("1. verification: API-070 against its own document", () => {
    it("a repeat answered 201 where the document says a repeat adds to the line is an incorrect expectation, never Confirmed", async () => {
        const s = await seed(API_070, "playwright-api", 5);
        const r = await verify(s, API_070, 5);
        expect(r.state).not.toBe("confirmed");
        expect(r.findingClass).toBe("incorrect_expectation");
    });

    it("the same shape on a once-only write (the discount code, documented 409) is still an application defect", async () => {
        const discount = TestSpecSchema.parse({
            ...API_070,
            testId: "API-084",
            title: "POST /api/cart/discount: rejects the same request twice (a duplicate)",
            description: "Apply a discount code (SAVE10: 10% off, once per account)",
            steps: API_070.steps.map((x) => (x.action === "request" && x.path === "/api/cart/items" ? { ...x, path: "/api/cart/discount", body: { code: "SAVE10" } } : x.action === "assertResponse" && x.check === "status" ? { ...x, source: "API document: POST /api/cart/discount 409" } : x)),
        });
        const s = await seed(discount, "playwright-api", 5);
        const r = await verify(s, discount, 5);
        expect(r.findingClass).toBe("app_defect");
        expect(r.state).toBe("confirmed");
    });
});

/**
 * WEB-002 as the run stored it, without its sign-in steps (the run replayed it on a newly registered account each time; here a fresh
 * browser stands in for that clean state) and its large structure snapshots (they come after the failing check).
 */
const WEB_002 = TestSpecSchema.parse({
    testId: "WEB-002",
    title: "Order list shows the signed-in user's orders newest first",
    description: "Open the orders page as a signed-in customer and check the order rows, their order, and their details.",
    kind: "web",
    category: "Orders",
    type: "functional",
    priority: "high",
    preconditions: ["Signed in as the customer account"],
    steps: [
        { action: "navigate", url: "/orders", description: "Open /orders" },
        { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Your orders", exact: true }, source: "expected:1" },
        { action: "assert", check: "exactText", locator: { by: "css", value: "tbody tr:nth-child(1) td:nth-child(1)" }, expected: "Order 1005", source: "expected:1" },
        { action: "assert", check: "count", locator: { by: "role", role: "table", value: "Orders, newest first" }, expected: 1, source: "expected:1" },
    ],
    expectedResults: [
        "The heading 'Your orders' is shown with five order links listed top to bottom as Order 1005, Order 1004, Order 1003, Order 1002, Order 1001 (requirement 7.5)",
        "Each order row shows an order number, a date, a status and a total (requirement 7.5)",
    ],
    source: { origin: "browser-agent", requirements: ["7.5"] },
});
const WEB_002_TRIAGE = {
    category: "test_data",
    fixable: true,
    reason: "The first row shows Order 1009, which is the newest order for this account, so the app is sorting correctly. The test hardcodes Order 1005 as the first row, which doesn't match the current seed data.",
};

describe("2. the failure analysis says the app is right (WEB-002)", () => {
    it("validation keeps it a finding of a stated check, and says the analysis reads the test as wrong; verification never confirms it", async () => {
        const scenario = ScenarioSchema.parse({ scenarioId: "S-016", title: WEB_002.title, description: WEB_002.description, category: "Orders", expectedResults: WEB_002.expectedResults, requirements: ["7.5"] });
        const ctx = { emit: () => undefined, llm: { object: async () => WEB_002_TRIAGE } } as unknown as EngineContext;
        const repair = await repairWeb({ ctx, browser: {} as never, baseUrl: "http://127.0.0.1:7651", model: {} as never, scenario, spec: WEB_002, run: runOf(WEB_002, 2), requirementIds: ["7.5"] });
        expect(repair.verdict).toBe("app_defect");
        expect(repair.reason).toContain("so the app is sorting correctly");

        const s = await seed(WEB_002, "playwright", 2, repair.reason);
        const r = await verify(s, WEB_002, 2);
        expect(r.state).toBe("needs_manual_review");
        expect((await s.store.history(s.projectId, s.finding.id)).map((e) => e.reason ?? "").join("\n")).toContain("so the app is sorting correctly");
    });

    it("a stated check the analysis blames on the application still confirms", async () => {
        const spec = TestSpecSchema.parse({ ...WEB_002, testId: "WEB-003" });
        ERRORS["WEB-003"] = ERRORS["WEB-002"]!;
        const scenario = ScenarioSchema.parse({ scenarioId: "S-017", title: spec.title, description: spec.description, category: "Orders", expectedResults: spec.expectedResults, requirements: ["7.5"] });
        const ctx = { emit: () => undefined, llm: { object: async () => ({ category: "app_defect", fixable: false, reason: "The orders are listed oldest first." }) } } as unknown as EngineContext;
        const repair = await repairWeb({ ctx, browser: {} as never, baseUrl: "http://127.0.0.1:7651", model: {} as never, scenario, spec, run: runOf(spec, 2), requirementIds: ["7.5"] });
        const s = await seed(spec, "playwright", 2, repair.reason);
        expect((await verify(s, spec, 2)).state).toBe("confirmed");
    });
});

describe("3. a refusal with another status than the document names (NOTE_403)", () => {
    /** WEB-057's check: the customer asks for admin's note 3; the document gives 401 or 404 (requirement 10.5: "404, never 403"). */
    const NOTE = { api: true, refuse: true, as: "customer", path: "/api/notes/3", by: "admin", of: "admin", sev: "high", documented: "401 or 404" };
    // The helpers the scripts carry, compiled from their constant text when a case runs.
    const web = (cfg: object, status: number) => (new Function(`${ACCESS_HELPER_SOURCE}\nreturn accessOffDocument;`)() as (cfg: object, status: number) => string | undefined)(cfg, status);
    const api = (last: { status: number }, spec: string) => (new Function(`${ACCESS_API_HELPER_SOURCE}\nreturn accessStatusAssert;`)() as (last: { status: number }, spec: string) => void)(last, spec);

    it("names the mismatch, at medium severity, in the access check's own words; a documented refusal passes", () => {
        const said = web(NOTE, 403);
        expect(said).toMatch(/^Access control check failed: 1 refusal differs from the API document\n- \[medium\] /);
        expect(said).toContain("HTTP 403");
        expect(said).toContain("HTTP 401 or 404");
        for (const status of [401, 404]) expect(web(NOTE, status)).toBeUndefined();
        // Nothing named for a signed-in caller beyond 401, or no document at all: any refusal stays a refusal.
        expect(web({ ...NOTE, documented: "401" }, 403)).toBeUndefined();
        expect(web({ ...NOTE, documented: undefined }, 403)).toBeUndefined();
    });

    it("the token check does the same: 403 against a documented 404 fails, a documented 404 passes, a 200 is still an open record", () => {
        const spec = JSON.stringify({ as: "customer", path: "/api/notes/3", by: "admin", of: "admin", sev: "high", documented: "401 or 404" });
        expect(() => api({ status: 403 }, spec)).toThrow(/1 refusal differs from the API document\n- \[medium\]/);
        expect(() => api({ status: 404 }, spec)).not.toThrow();
        expect(() => api({ status: 200 }, spec)).toThrow(/1 record may be open to another account\n- \[high\]/);
        // The token checks carry the documented refusals too.
        const [t] = generateApiListSpecs([{ list: "/api/notes", detail: "/api/notes/{id}", documented: [401, 404], items: { customer: [{ id: "1" }], admin: [{ id: "3" }] } }], { tokens: ["customer"] });
        expect(JSON.parse(String((t!.steps[1] as { expected: string }).expected))).toMatchObject({ documented: "401 or 404" });
    });

    it("the finding's severity is the check's own medium, not an access break's high", () => {
        const said = web(NOTE, 403)!;
        const v = FindingViewSchema.parse({
            id: "f-57",
            projectId: "p-1",
            source: { kind: "execution", id: "t-57" },
            state: "reproduced",
            title: "“customer” account: cannot read a record of “admin” through the API (GET /api/notes/3)",
            testId: "t-57",
            detectedAt: "2026-11-25T15:00:00.000Z",
            expected: { text: "GET /api/notes/3 is refused for the “customer” account", source: "API document: GET /api/notes/{id} 401 or 404", stated: "explicit" },
            observed: said.split("\n")[0],
            steps: [],
            attempts: [1, 2, 3].map(() => ({ outcome: "failed", failedStep: 2, check: "accessDenied", error: said })),
            priority: "high",
            origin: "access-check",
            layer: "api",
        });
        expect(severityOf(v).severity).toBe("medium");
        const open = { ...v, attempts: v.attempts.map((a) => ({ ...a, error: "Access control check failed: 1 record may be open to another account\n- [high] A signed-in “customer” user can call GET /api/notes/3 (HTTP 200)" })) };
        expect(["high", "critical"]).toContain(severityOf(open).severity);
    });
});

describe("4. a repaired API test keeps its documented source (API-084)", () => {
    it("the second SAVE10's 409 check still cites the API document after the repair rewrote the steps", async () => {
        const spec = TestSpecSchema.parse({
            ...API_070,
            testId: "API-084",
            title: "POST /api/cart/discount: rejects the same request twice (a duplicate)",
            description: "Apply a discount code (SAVE10: 10% off, once per account)",
            steps: [
                ...signup,
                { action: "request", method: "POST", path: "/api/cart/discount", body: { code: "test-code-{{unique}}" }, auth: "default", description: "Send a valid request" },
                { action: "assertResponse", check: "statusClass", expected: "2xx", description: "The first one is accepted" },
                { action: "request", method: "POST", path: "/api/cart/discount", body: { code: "test-code-{{unique}}" }, auth: "default", description: "Send the same request again" },
                { action: "assertResponse", check: "status", expected: 409, description: "Answered with the documented HTTP 409", source: "API document: POST /api/cart/discount 409" },
            ],
        });
        // The model's answer: SAVE10 in both requests, and its steps name no source (as the run's repair did).
        const answer = (s: Step) =>
            s.action === "request" ? { action: "request", method: s.method, path: s.path, auth: s.auth, description: s.description, body: JSON.stringify(s.path === "/api/cart/discount" ? { code: "SAVE10" } : s.body) } : { action: s.action, check: (s as { check: string }).check, expected: (s as { expected: unknown }).expected, description: s.description };
        let calls = 0;
        const ctx = {
            emit: () => undefined,
            llm: {
                object: async () =>
                    ++calls === 1
                        ? { category: "test_data", fixable: true, reason: "The test used a made-up code; the documented valid code is SAVE10." }
                        : { verdict: "fix", reason: "Use SAVE10 in both requests.", steps: spec.steps.map(answer) },
            },
        } as unknown as EngineContext;
        const ep = STORE.find((e) => e.method === "POST" && e.path === "/api/cart/discount")!;
        const run = { ...runOf(spec, 3), steps: [] };
        const out = await repairApi(ctx, spec, run, { method: ep.method, path: ep.path, statuses: ep.statuses, requiresAuth: ep.requiresAuth, summary: ep.summary, spec: ep.spec });
        expect(out.verdict).toBe("fixed");
        expect(out.spec!.steps.find((s) => s.action === "assertResponse" && s.check === "status")).toMatchObject({ expected: 409, source: "API document: POST /api/cart/discount 409" });
    });
});

describe("5. a stored-row check names the table of the resource the request wrote (API-159)", () => {
    const req = (method: string, p: string, body: object) => ({ action: "request", method, path: p, body, auth: "default", description: "" }) as Extract<Step, { action: "request" }>;
    it("PATCH /api/me with a name is never checked in products; it is checked in users when users holds the field", () => {
        // The run's probe: `name` was a column of products and not of users as it reported them.
        const probe = cleanSchema({
            tables: [
                { name: "users", columns: ["id", "email", "role"], primaryKey: ["id"] },
                { name: "products", columns: ["id", "name", "category", "price_mills", "stock"], primaryKey: ["id"] },
            ],
        });
        expect(persistenceCheck(req("PATCH", "/api/me", { name: "Test name {{unique}}" }), probe)).toBeUndefined();
        const withName = cleanSchema({ tables: [{ name: "users", columns: ["id", "email", "name", "role"], primaryKey: ["id"] }, { name: "products", columns: ["id", "name"], primaryKey: ["id"] }] });
        expect(persistenceCheck(req("PATCH", "/api/me", { name: "Test name {{unique}}" }), withName)).toBe("exists users where name = 'Test name {{unique}}'");
        // A write to a resource with no table of its own is not checked in another one that happens to hold its fields.
        expect(persistenceCheck(req("PUT", "/api/settings", { name: "x" }), probe)).toBeUndefined();
    });
});
