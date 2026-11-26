/**
 * The practice-store full run (N2E): its last false positive and its one untested seed, built from the run's own test, model and
 * requirement text. Real platform (SQLite), scripted executor and scripted model doubles; no browser, no AI.
 *   1. WEB-044: the test typed an 81-character note title into a field with maxlength="80" (the analysis's own model records it), so the
 *      browser cut it to 80 before anything was sent, and the check that the app refuses 81 characters failed. The app never saw 81
 *      characters: the finding is the test's own (automation), never Confirmed.
 *   2. SUBTOTAL (requirement 6.6, "the line total must be price × quantity … rounded to the cent"): nothing checked the line total. The
 *      model's only 6.6 invariant was the subtotal half, which held a stated line-total rule out, and the probe guessed integer product ids
 *      1 to 10 instead of reading the product list.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { probeInvariant, type ProbeEnv, type ProbeHttp } from "../src/engine/api/probes.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { proposeInvariants, type Invariant } from "../src/engine/validation/invariants.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { AppIntelStore } from "../src/platform/app-intel-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { harvestExecutionFindings, verifyDepsOf, verifyFindings, type VerifyDeps } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

let platform: Platform;
let dir = "";
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-n2e-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "n2e-maxlength-secret-key-0123456789abcdef", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// ── 1. WEB-044 ──
const T81 = "qagims-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const T80 = T81.slice(0, 80);
const MESSAGE = "Enter a title of 1 to 80 characters.";
/** WEB-044 as the run stored it, its sign-in and repeated tries left out (a fresh browser stands in for the run's new account). */
const web044 = (title: string) =>
    TestSpecSchema.parse({
        testId: "WEB-044",
        title: "Title of 81 characters is rejected and 80 characters is accepted",
        kind: "web",
        category: "Notes",
        type: "boundary",
        priority: "high",
        steps: [
            { action: "navigate", url: "/spa/#/notes", description: "Open /spa/#/notes" },
            { action: "fill", locator: { by: "label", value: "Title" }, value: title, description: "Enter a 81-character title (80 plus one)" },
            { action: "fill", locator: { by: "label", value: "Body" }, value: "Boundary test body" },
            { action: "click", locator: { by: "role", role: "button", value: "Create note", exact: true } },
            { action: "assert", check: "visible", locator: { by: "text", value: MESSAGE, exact: true }, source: "expected:1" },
        ],
        expectedResults: [`With 81 characters the message ${MESSAGE} is shown and no note is created (requirement 10.8)`, "With 80 characters the note appears in the Notes list with its full title (requirement 10.3.b)"],
        source: { origin: "browser-agent", requirements: ["10.8", "10.3.b"] },
    });
/** The analysis's model of the notes page, as N2E's app_model_versions holds it (the Title field: maxLength 80). */
const NOTES_MODEL = {
    pages: [
        {
            id: "page-notes",
            path: "/spa/#/notes",
            forms: [{ name: "New note", fields: [{ name: "title", label: "Title", type: "text", required: true, maxLength: 80, message: MESSAGE }, { name: "body", label: "Body", type: "textarea" }] }],
        },
    ],
};
const failedRun = (spec: TestSpec): ScriptRun => ({
    testId: spec.testId,
    status: "failed",
    durationMs: 1,
    failedStepIndex: 4,
    steps: spec.steps.map((s, i) => ({ index: i, title: `${i + 1}. ${s.action}`, status: i === 4 ? "failed" : "passed", ...(i === 4 ? { error: `Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('${MESSAGE}', { exact: true })\nExpected: visible` } : {}) })),
    artifacts: [],
    responses: [],
});
async function verifyWeb044(title: string) {
    const spec = web044(title);
    const projectId = String(platform.repo.createProject({ name: `notes ${title.length}` }).id);
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:7651", { ...DEFAULT_JOB_OPTIONS }, { username: "user@practice.test", password: "pw-n2e" });
    await new AppIntelStore(platform.sql).addVersion({ projectId, applicationId: appId, model: NOTES_MODEL });
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Notes", "notes");
    const testId = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright", validationStatus: "NEEDS_REVIEW" });
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId] });
    const t = platform.repo.getTest(testId)!;
    const store = new CandidateFindingStore(platform.sql);
    const [finding] = await harvestExecutionFindings(store, { projectId, jobId: job.id, failed: [{ test: { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework }, run: failedRun(spec) }] });
    const execute: VerifyDeps["execute"] = async () => [failedRun(spec), failedRun(spec), failedRun(spec)];
    await verifyFindings({ ...verifyDepsOf(platform, job, { execute }), findings: [finding!] });
    return { r: (await store.get(projectId, finding!.id))!, history: (await store.history(projectId, finding!.id)).map((e) => e.reason ?? "").join("\n") };
}

describe("1. a limit the field's own maxlength enforced (WEB-044)", () => {
    it("an 81-character title cut to 80 by maxlength=80: the test's own problem, never Confirmed, and it says why", async () => {
        const { r, history } = await verifyWeb044(T81);
        expect(r.state).not.toBe("confirmed");
        expect(r.findingClass).toBe("automation");
        expect(history).toMatch(/maxlength/i);
    });
    it("the same failing check with a title the field takes whole is still the application's", async () => {
        const { r } = await verifyWeb044(T80);
        expect(r.findingClass).toBe("app_defect");
        expect(r.state).toBe("confirmed");
    });
});

// ── 2. SUBTOTAL ──
const json = (schema: object) => ({ content: { "application/json": { schema } } });
const CART = {
    type: "object",
    properties: {
        items: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, productId: { type: "integer" }, price: { type: "number" }, qty: { type: "integer" }, lineTotal: { type: "number" } } } },
        subtotal: { type: "number" },
        total: { type: "number" },
    },
};
const STORE = parseOpenApi(
    {
        openapi: "3.1.0",
        info: { title: "Practice store", version: "1" },
        paths: {
            "/api/products": { get: { summary: "Products", responses: { 200: { description: "OK", ...json({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, price: { type: "number" } } } } } }) } } } },
            "/api/cart/items": {
                post: {
                    summary: "Add a product (adds to the line if it is already in the cart)",
                    requestBody: { required: true, ...json({ type: "object", required: ["productId"], properties: { productId: { type: "integer", minimum: 1 }, qty: { type: "integer", minimum: 1, maximum: 10 } } }) },
                    responses: { 201: { description: "Created", ...json(CART) }, 400: { description: "Invalid input" } },
                },
            },
        },
    },
    "http://127.0.0.1:8351/openapi.json",
).operations;
/** Requirement 6.6 as the store states it, and the model's only 6.6 invariant in N2E (API-145: the subtotal half). */
const REQ_6_6 = { id: "6.6", text: "The line total must be price × quantity, and the subtotal the sum of line totals, both rounded to the cent." };
const MODEL_6_6: Invariant = { requirementId: "6.6", endpoint: "POST /api/cart/items", setup: [], write: "POST /api/cart/items", expression: "subtotal == round(sum(items[*].lineTotal), 2)" };
/** The store's half-cent products (ids 15 and 19: 2.495 and 4.995) on its first page, priced in mills as server/store.mjs keeps them. */
const PRODUCTS = [
    { id: 15, mills: 2495 },
    { id: 19, mills: 4995 },
];
/** The store's cart: SUBTOTAL truncates a line total to the cent instead of rounding it (server/api.mjs lineCents). */
function store(seeded: boolean): ProbeEnv {
    return {
        apis: STORE,
        dataChanges: true,
        async newClient(): Promise<ProbeHttp> {
            const lines = new Map<number, number>();
            return {
                async send(method, p, body) {
                    if (p === "/api/products") return { status: 200, json: { items: PRODUCTS.map((x) => ({ id: x.id, price: x.mills / 1000 })) } };
                    if (method === "POST" && p === "/api/cart/items") {
                        const b = (body ?? {}) as { productId?: number; qty?: number };
                        const prod = PRODUCTS.find((x) => x.id === b.productId);
                        if (!prod) return { status: 404, json: { error: { code: "not_found", message: "Not found" } } };
                        // 6.2 and 6.3: a repeat adds to the line, and a line above 10 is refused.
                        const qty = (lines.get(prod.id) ?? 0) + Number(b.qty ?? 1);
                        if (qty > 10) return { status: 400, json: { error: { code: "invalid", message: "Quantity must be between 1 and 10." } } };
                        lines.set(prod.id, qty);
                        const items = [...lines].map(([id, qty]) => {
                            const m = PRODUCTS.find((x) => x.id === id)!.mills * qty;
                            return { productId: id, price: PRODUCTS.find((x) => x.id === id)!.mills / 1000, qty, lineTotal: (seeded ? Math.floor(m / 10) : Math.round(m / 10)) / 100 };
                        });
                        const subtotal = Math.round(items.reduce((s, l) => s + l.lineTotal * 100, 0)) / 100;
                        return { status: 201, json: { items, subtotal, total: subtotal } };
                    }
                    return { status: 404, json: {} };
                },
            };
        },
    };
}

describe("2. requirement 6.6's line total is checked (SUBTOTAL)", () => {
    it("the stated line-total rule is kept beside the model's subtotal half, and its probe finds the truncated line on the store's own products", async () => {
        const llm = { object: async () => ({ invariants: [MODEL_6_6] }) } as never;
        const { invariants } = await proposeInvariants({ llm }, { requirements: [REQ_6_6], apis: STORE, origins: new Set(["http://127.0.0.1:8351"]), dataChanges: true, secrets: [] });
        expect(invariants.map((i) => i.expression)).toContain(MODEL_6_6.expression);
        const line = invariants.find((i) => /lineTotal ==/.test(i.expression));
        expect(line).toMatchObject({ requirementId: "6.6", write: "POST /api/cart/items", expression: "items[*].lineTotal == round(items[*].price * items[*].qty, 2)" });
        // Product ids come from the product list, not a guess from 1 to 10.
        expect(await probeInvariant(line!, store(true), { seed: 20261126 })).toMatchObject({ outcome: "failed" });
        expect(await probeInvariant(line!, store(false), { seed: 20261126 })).toMatchObject({ outcome: "held" });
    });
});
