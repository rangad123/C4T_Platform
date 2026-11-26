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
import { validateBatch } from "../src/engine/validation/validator.js";
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

// ── round 2 (N2D: the saved suite run again on the practice store) ──

/** The store's own sign-up, sign-out and password change, as its /openapi.json documents them. */
const SESSION_DOC = {
    ...STORE_DOC,
    paths: {
        ...STORE_DOC.paths,
        "/api/auth/signup": {
            post: {
                summary: "Create an account",
                requestBody: { required: true, ...json({ type: "object", required: ["email", "password"], properties: { name: { type: "string" }, email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } }) },
                responses: { 201: res("Created", { type: "object", properties: { ok: { type: "boolean" } } }), 400: res("Invalid input"), 409: res("Conflict with the current state") },
            },
        },
        "/api/auth/logout": { post: { summary: "Sign out (ends the session or revokes the Bearer token)", responses: { 200: res("OK", { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } } }) } } },
        "/api/account/password": {
            post: {
                summary: "Change your password",
                requestBody: { required: true, ...json({ type: "object", required: ["currentPassword", "newPassword"], properties: { currentPassword: { type: "string" }, newPassword: { type: "string", minLength: 8 } } }) },
                responses: { 200: res("OK", { type: "object", properties: { ok: { type: "boolean" } } }), 400: res("Invalid input"), 401: res("Not signed in") },
            },
        },
    },
};
const SESSION_APIS = parseOpenApi(SESSION_DOC, "http://127.0.0.1:8351/openapi.json").operations;

/** API-016 as the run stored it: the store's sign-out sent with the project's shared credentials (its saved API token). */
const API_016 = TestSpecSchema.parse({
    testId: "API-016",
    title: "POST /api/auth/logout: succeeds with a valid request",
    description: "Sign out (ends the session or revokes the Bearer token)",
    kind: "api",
    category: "API · auth",
    priority: "high",
    steps: [
        { action: "request", method: "POST", path: "/api/auth/logout", auth: "default", description: "Send a valid POST request" },
        { action: "assertResponse", check: "statusClass", expected: "2xx", description: "Request succeeds" },
    ],
    expectedResults: ["Returns a successful response matching the documented contract"],
    tags: ["api", "happy-path"],
    source: { origin: "openapi" },
});
const noAi = { object: async () => { throw new Error("no AI call is expected"); } } as never;
const apiTest = (n: number, steps: Step[]) => TestSpecSchema.parse({ testId: `API-${String(n).padStart(3, "0")}`, title: `API test ${n}`, kind: "api", steps, expectedResults: ["ok"], source: { origin: "openapi" } });
const getCart: Step[] = [{ action: "request", method: "GET", path: "/api/cart/items", auth: "default", description: "Read the cart" }, { action: "assertResponse", check: "statusClass", expected: "2xx", description: "Readable" }] as Step[];
async function validateApi(specs: TestSpec[], runs: Record<string, ScriptRun>, events: Array<{ kind: string; message: string }> = []) {
    const config = loadConfig({});
    const ctx = { config, llm: noAi, emit: (e: { kind: string; message: string }) => void events.push(e) } as unknown as EngineContext;
    const scripts: Record<string, string> = {};
    const executor = {
        name: "fake",
        async execute(_a: string, batch: { scripts: Array<{ testId: string; content: string }> }) {
            for (const s of batch.scripts) scripts[s.testId] = s.content;
            return batch.scripts.map((s) => runs[s.testId]!);
        },
    };
    const outcomes = await validateBatch(
        ctx,
        { scratchDir: config.scratchDir, env: { baseUrl: "http://127.0.0.1:7651", headless: true, apiToken: "store-token-n2d" }, render: { baseUrl: "http://127.0.0.1:7651" }, model: { pages: [], apis: [] } as never, maxRepairAttempts: 2, workers: 2, executor: executor as never },
        specs.map((spec) => ({ spec, framework: "playwright-api" as const })),
        { async onAttempt() {}, async onFinal() {} },
    );
    return { outcomes, scripts };
}
const passed = (id: string): ScriptRun => ({ testId: id, status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [{ method: "GET", path: "/api/cart/items", status: 200 }] });
/** A run refused at its first request with "That API token is not valid or has expired" (HTTP 401). */
const refused = (id: string): ScriptRun => ({ testId: id, status: "failed", durationMs: 1, failedStepIndex: 1, steps: [{ index: 0, title: "1. Read the cart", status: "passed" }, { index: 1, title: "2. Readable", status: "failed", error: "Error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 4" }], artifacts: [], responses: [{ method: "GET", path: "/api/cart/items", status: 401 }] });

describe("6. a test that ends a session never uses the shared credentials (API-016)", () => {
    it("generation: every request to sign-out or the password change goes on a fresh account of its own", () => {
        const specs = generateApiSpecs(SESSION_APIS, { allowMutating: true, maxPerEndpoint: 6 }).specs;
        const ending = specs.filter((s) => s.steps.some((x) => x.action === "request" && /logout|password/.test(x.path)));
        expect(ending.length).toBeGreaterThan(0);
        for (const s of ending) {
            for (const r of s.steps) if (r.action === "request" && /logout|password/.test(r.path)) expect(r.auth, s.title).toBe("none");
            expect(s.steps[0], s.title).toMatchObject({ action: "request", path: "/api/auth/signup" });
        }
    });

    it("a saved test that sends it with the shared credentials skips itself and says why, with no repair", async () => {
        const skipped: ScriptRun = { testId: "API-016", status: "skipped", durationMs: 0, failedStepIndex: -1, steps: [], artifacts: [], responses: [] };
        const { outcomes, scripts } = await validateApi([API_016], { "API-016": skipped });
        // It skips whenever its run has shared credentials (a token, a header or the project's account): session-end-own-unit.test.ts.
        expect(scripts["API-016"]).toContain("test.skip(!!(process.env.API_TOKEN || process.env.API_AUTH_HEADER || process.env.TEST_USERNAME),");
        expect(outcomes[0]).toMatchObject({ status: "FAILED_VALIDATION", reason: expect.stringContaining("shared") });
        // On a fresh account of its own it runs.
        const own = TestSpecSchema.parse({ ...API_016, steps: [...signup, { ...API_016.steps[0], auth: "none" }, API_016.steps[1]] });
        expect((await validateApi([own], { "API-016": passed("API-016") })).scripts["API-016"]).not.toContain("Not run: it signs out");
    });

    it("the shared token refused part way through the run is one cause, not one failure per test, and nothing is repaired", async () => {
        const specs = [1, 2, 3, 4].map((n) => apiTest(n, getCart));
        const events: Array<{ kind: string; message: string }> = [];
        const { outcomes } = await validateApi(specs, { "API-001": passed("API-001"), "API-002": refused("API-002"), "API-003": refused("API-003"), "API-004": refused("API-004") }, events);
        expect(outcomes[0]!.status).toBe("VALIDATED");
        const reasons = outcomes.slice(1).map((o) => [o.status, o.reason]);
        for (const [status, reason] of reasons) {
            expect(status).toBe("FAILED_VALIDATION");
            expect(reason).toMatch(/API token stopped being accepted during this run/);
        }
        expect(new Set(reasons.map((r) => r[1])).size).toBe(1);
        expect(events.filter((e) => e.kind === "api_token_refused")).toHaveLength(1);
    });
});

describe("7. relation checks compare amounts, not floating-point noise (API-147, requirement 6.11)", () => {
    const REQ_6_11 = "subtotal == round(subtotal, 2) and total == round(total, 2) and sum(items[*].lineTotal) == round(sum(items[*].lineTotal), 2)";
    it("the run's own cart (27.99 + 22.50 = 50.49) holds; a real difference still fails", () => {
        const cart = { subtotal: 50.49, total: 50.49, items: [{ lineTotal: 27.99 }, { lineTotal: 22.5 }] };
        expect(checkRelation(REQ_6_11, { body: cart }, "6.11")).toMatchObject({ held: true });
        expect(checkRelation(REQ_6_11, { body: { ...cart, total: 50.4899 } }, "6.11")).toMatchObject({ held: false });
        expect(checkRelation("subtotal == 50.48", { body: cart })).toMatchObject({ held: false });
        // Rounding is decimal: 1.005 to the cent is 1.01, as written.
        expect(checkRelation("round(x, 2) == 1.01", { body: { x: 1.005 } })).toMatchObject({ held: true });
        expect(checkRelation("0.1 + 0.2 <= 0.3 and 0.1 + 0.2 >= 0.3 and (0.1 + 0.2 > 0.3) == false", { body: {} })).toMatchObject({ held: true });
    });
});

describe("8. an order from an empty cart: the refusal the document gives (API-150)", () => {
    const ORDER = { type: "object", properties: { id: { type: "integer" }, status: { type: "string", enum: ["pending", "paid", "shipped", "delivered", "cancelled"] } } };
    const ORDERS_DOC = {
        openapi: "3.1.0",
        info: { title: "Practice store", version: "1" },
        paths: {
            "/api/auth/signup": SESSION_DOC.paths["/api/auth/signup"],
            "/api/cart/items": { post: { summary: "Add a product (adds to the line if it is already in the cart)", requestBody: json({ type: "object", properties: { productId: { type: "integer", minimum: 1 }, qty: { type: "integer", minimum: 1, maximum: 10 } } }), responses: { 201: res("Created", CART), 400: res("Invalid input") } } },
            "/api/orders": { post: { summary: "Place an order from your cart", responses: { 201: res("Created", ORDER), 400: res("Invalid input"), 401: res("Not signed in"), 409: res("Conflict with the current state") } } },
            "/api/orders/{id}": { get: { summary: "One of your orders", responses: { 200: res("OK", ORDER), 404: res("Not found") } } },
            "/api/orders/{id}/cancel": { post: { summary: "Cancel your order while it is pending or paid", responses: { 200: res("OK", ORDER), 409: res("Conflict with the current state") } } },
        },
    };
    it("a document that names neither 400 nor 409 for it accepts either documented refusal; the store's 400 holds", async () => {
        const apis = parseOpenApi(ORDERS_DOC, "http://127.0.0.1:8351/openapi.json").operations;
        const [m] = (await import("../src/engine/api/stateful.js")).stateModels(apis);
        expect(m!.create!.needs.map((n) => n.label)).toEqual(["POST /api/cart/items"]);
        // The store: an order from an empty cart is "Your cart is empty." (400); with a line it is placed (201, pending).
        let next = 1000;
        const orders = new Map<number, string>();
        const client = () => {
            let cart = 0;
            return {
                async send(method: string, path: string) {
                    if (path === "/api/auth/signup") return { status: 201, json: { ok: true } };
                    if (path === "/api/cart/items") return (cart++, { status: 201, json: {} });
                    if (path === "/api/orders" && method === "POST") {
                        if (!cart) return { status: 400, json: { error: { code: "empty_cart", message: "Your cart is empty." } } };
                        cart = 0;
                        orders.set(next, "pending");
                        return { status: 201, json: { id: next++, status: "pending" } };
                    }
                    const m = /^\/api\/orders\/(\d+)(\/cancel)?$/.exec(path);
                    const id = Number(m?.[1]);
                    if (!m || !orders.has(id)) return { status: 404, json: {} };
                    if (!m[2]) return { status: 200, json: { id, status: orders.get(id) } };
                    if (!["pending", "paid"].includes(orders.get(id)!)) return { status: 409, json: {} };
                    orders.set(id, "cancelled");
                    return { status: 200, json: { id, status: "cancelled" } };
                },
            };
        };
        const r = await (await import("../src/engine/api/stateful.js")).runSequences(m!, { apis, dataChanges: true, newClient: async () => client() }, { seed: 2128578828 });
        expect(r.message ?? "").not.toMatch(/expects HTTP 409/);
        expect(r.outcome).toBe("held");
    });
});
