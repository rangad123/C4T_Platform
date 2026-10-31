/**
 * Plain-English test authoring through the real platform: HTTP API -> job queue -> worker -> the real authoring agent driving a real
 * Chromium against a local fixture shop -> rendered script -> real validation run -> stored test.
 * The model is a scripted double (MockLanguageModelV3 for the agent's tool calls, a function for the API plan): it never calls a
 * real model, so these tests prove the plumbing and the honesty rules, not model quality.
 *
 *   a description becomes a VALIDATED test that keeps the sentence, its origin and a real execution
 *   sign-in details stay symbolic in the spec; an impossible description is kept as "needs review" with the agent's own explanation
 *   a test that checks almost nothing is not marked green; no model -> 422; unsafe descriptions are refused before any job
 *   one active job per project (409), cancellation, an environment (never production), the exported spec imports again
 *   an API description builds from the known operations (GET only unless data-changing tests are on) against a real analysis
 *   a test is rebuilt from a changed description keeping its id and history; a rebuild that fails leaves the test as it was
 *
 * Fixture shop: port 5610. The platform is driven through `server.inject`. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/plain-english.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { unavailableLlmClient, type LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { PLAIN_USER, startPlainSite, type PlainSite } from "./fixtures/plain-site.js";

const PORT = 5610;
const SITE = `http://127.0.0.1:${PORT}`;

let site: PlainSite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

// ── the scripted model ────────────────────────────────────────────────────────
type Call = { tool: string; input: Record<string, unknown> } | { hang: true };
const queue: Call[] = [];
const plans: unknown[] = [];
const seenPrompts: string[] = [];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
        seenPrompts.push(JSON.stringify(options.prompt).slice(0, 6000));
        const next = queue.shift();
        if (next && "hang" in next) {
            await new Promise((_, reject) => {
                const stop = () => reject(new DOMException("aborted", "AbortError"));
                if (options.abortSignal?.aborted) stop();
                options.abortSignal?.addEventListener("abort", stop);
            });
        }
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        const call = next as Exclude<Call, { hang: true }>;
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: call.tool, input: JSON.stringify(call.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ prompt }: { prompt: string }) => {
        seenPrompts.push(prompt.slice(0, 3000));
        const next = plans.shift();
        if (next === undefined) throw new Error("no scripted plan left");
        return next;
    }) as LlmClient["object"],
};

const click = (role: string, name: string): Call => ({ tool: "click", input: { target: { by: "role", role, value: name } } });
const assertText = (target: Record<string, unknown>, expected: string): Call => ({ tool: "assert", input: { check: "text", target, expected } });
const finish = (result: "complete" | "defect" | "blocked", explanation: string): Call => ({ tool: "finish", input: { result, explanation } });
/** Add the Blue Mug and check the total: the agent's tool calls for the shop. */
const ADD_MUG: Call[] = [click("link", "Products"), click("button", "Add Blue Mug to cart"), assertText({ by: "role", role: "status" }, "Total: $12.00"), finish("complete", "Added the mug and saw the total")];
const ADD_PLATE: Call[] = [click("link", "Products"), click("button", "Add Red Plate to cart"), assertText({ by: "role", role: "status" }, "Total: $8.50"), finish("complete", "Added the plate and saw the total")];

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startPlainSite(PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plain-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1" }));
    // The API route asks the platform's own client whether a model exists; the worker builds one per job.
    platform.llm = scripted;
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await site?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    queue.length = 0;
    plans.length = 0;
    seenPrompts.length = 0;
});

// ── helpers ───────────────────────────────────────────────────────────────────
const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    const text = res.body;
    return { status: res.statusCode, body: (text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text) as any };
};
const newProject = async (name: string) => (await call("POST", "/api/projects", { name })).body.id as string;
const TERMINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
async function waitJob(jobId: string, ms = 150_000) {
    const end = Date.now() + ms;
    for (;;) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (TERMINAL.includes(j.status)) return j;
        if (Date.now() > end) throw new Error(`job ${jobId} did not finish (${j.status})`);
        await new Promise((r) => setTimeout(r, 300));
    }
}
const plainTests = async (projectId: string) => ((await call("GET", `/api/projects/${projectId}/tests`)).body as any[]).filter((t) => t.suite === "Plain English");
const detail = async (id: string) => (await call("GET", `/api/tests/${id}`)).body;
/** A project whose application is the fixture shop, with a test account (the import stores the address and the sign-in). */
async function projectWithSite(name: string, credentials?: { username: string; password: string }) {
    const id = await newProject(name);
    const imported = await call("POST", `/api/projects/${id}/specs`, {
        baseUrl: SITE,
        validate: false,
        ...(credentials ? { credentials } : {}),
        specs: [{ testId: "WEB-001", title: "Home shows the shop name", kind: "web", category: "Imported", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Plain Shop" } }] }],
    });
    expect(imported.status).toBe(202);
    return id;
}
const create = (projectId: string, body: Record<string, unknown>) => call("POST", `/api/projects/${projectId}/plain-tests`, body);

describe("plain-English tests: web", () => {
    let projectId: string;
    let builtId: string;
    const SENTENCE = "Add the Blue Mug to the cart and check the total shows $12.00";

    it("builds a test from a sentence, runs it for real and stores it with the sentence and its origin", async () => {
        projectId = await projectWithSite("Plain web");
        queue.push(...ADD_MUG);
        const res = await create(projectId, { description: SENTENCE });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        expect(res.body.kind).toBe("web");
        const job = await waitJob(res.body.jobId);
        expect(job.mode).toBe("plain");
        expect(job.status, job.error).toBe("COMPLETED");

        const tests = await plainTests(projectId);
        expect(tests).toHaveLength(1);
        const t = tests[0]!;
        builtId = t.id;
        expect(t.validationStatus).toBe("VALIDATED");
        expect(t.title).toBe(SENTENCE);
        const d = await detail(t.id);
        expect(d.spec.source.origin).toBe("plain-english");
        expect(d.spec.description).toBe(SENTENCE);
        expect(d.spec.expectedResults).toEqual(["The total shows $12.00"]);
        expect(d.generationMeta.plain.description).toBe(SENTENCE);
        // Only what worked was recorded, and it ends in an assertion; the script was really executed and passed.
        expect(d.spec.steps.map((s: any) => s.action)).toEqual(["navigate", "click", "click", "assert"]);
        expect(d.executions.length).toBeGreaterThan(0);
        expect(d.executions[0].status).toBe("passed");
        expect(d.scripts[0].content).toContain("Add Blue Mug to cart");
        // The agent was handed the sentence as its goal.
        expect(seenPrompts.join("\n")).toContain(SENTENCE);
        expect(t.quality?.level).toBe("good");
    }, 240_000);

    it("exports the spec and imports it again into another project, where it still passes", async () => {
        const exported = (await call("GET", `/api/projects/${projectId}/specs`)).body.specs as any[];
        const spec = exported.find((s) => s.source.origin === "plain-english");
        expect(spec).toBeTruthy();
        const other = await newProject("Round trip");
        const { testId: _drop, ...withoutId } = spec;
        const imported = await call("POST", `/api/projects/${other}/specs`, { baseUrl: SITE, specs: [withoutId] });
        expect(imported.status, JSON.stringify(imported.body)).toBe(202);
        expect((await waitJob(imported.body.jobId)).status).toBe("COMPLETED");
        const t = ((await call("GET", `/api/projects/${other}/tests`)).body as any[])[0];
        expect(t.validationStatus).toBe("VALIDATED");
        expect((await detail(t.id)).spec.source.origin).toBe("plain-english");
    }, 240_000);

    it("uses the project's sign-in without ever writing the password into the test", async () => {
        const id = await projectWithSite("Plain sign-in", { username: PLAIN_USER.email, password: PLAIN_USER.password });
        queue.push(
            click("link", "Log in"),
            { tool: "fill", input: { target: { by: "label", value: "Email" }, value: "{{credentials.username}}" } },
            { tool: "fill", input: { target: { by: "label", value: "Password" }, value: "{{credentials.password}}" } },
            click("button", "Log in"),
            { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Welcome, Demo" } } },
            finish("complete", "Signed in and saw the welcome"),
        );
        const res = await create(id, { description: "Log in with the test account and check the welcome message is shown" });
        const job = await waitJob(res.body.jobId);
        expect(job.status, job.error).toBe("COMPLETED");
        const t = (await plainTests(id))[0]!;
        expect(t.validationStatus).toBe("VALIDATED");
        const d = await detail(t.id);
        expect(seenPrompts.join("\n")).toContain("credentials.username");
        const everything = JSON.stringify(d) + JSON.stringify((await call("GET", `/api/test-generation/${res.body.jobId}/events`)).body);
        expect(everything).not.toContain(PLAIN_USER.password);
        expect(JSON.stringify(d.spec)).toContain("{{credentials.password}}");
    }, 240_000);

    it("keeps a description the agent could not do as 'needs review' with its own explanation, and does not run it", async () => {
        const id = await projectWithSite("Plain impossible");
        const why = "We could not find a way to check the total: the page has no element showing it.";
        queue.push(click("link", "Products"), finish("blocked", why));
        const res = await create(id, { description: "Apply the discount code SAVE10 and check the total drops" });
        const job = await waitJob(res.body.jobId);
        expect(job.status).toBe("PARTIALLY_COMPLETED");
        const tests = await plainTests(id);
        expect(tests).toHaveLength(1);
        expect(tests[0]!.validationStatus).toBe("NEEDS_REVIEW");
        expect(tests[0]!.validationReason).toBe(why);
        const d = await detail(tests[0]!.id);
        expect(d.executions).toHaveLength(0);
        expect(d.generationMeta.plain.description).toContain("SAVE10");
        expect(d.generationMeta.authoring).toBe("blocked");
    }, 240_000);

    it("does not mark a test green when it checks almost nothing", async () => {
        const id = await projectWithSite("Plain weak");
        queue.push(click("link", "Products"), { tool: "assert", input: { check: "url", expected: "/products" } }, finish("complete", "Opened the products page"));
        const res = await create(id, { description: "Open the products page and check it works" });
        const job = await waitJob(res.body.jobId);
        expect(job.status).toBe("PARTIALLY_COMPLETED");
        const t = (await plainTests(id))[0]!;
        // It really ran and passed, yet it is not counted as validated.
        const d = await detail(t.id);
        expect(d.executions[0].status).toBe("passed");
        expect(t.validationStatus).toBe("NEEDS_REVIEW");
        expect(t.validationReason).toContain("checks very little");
        expect(t.validationReason).toContain("We have not counted it as validated");
        expect(t.quality?.level).toBe("weak");
    }, 240_000);

    it("builds on a named environment (never a production one)", async () => {
        const id = await newProject("Plain environment");
        expect((await call("POST", `/api/projects/${id}/environments`, { name: "staging", baseUrl: `http://localhost:${PORT}` })).status).toBe(201);
        expect((await call("POST", `/api/projects/${id}/environments`, { name: "live", baseUrl: `http://localhost:${PORT}`, production: true })).status).toBe(201);

        const prod = await create(id, { description: SENTENCE, environment: "live" });
        expect(prod.status).toBe(422);
        expect(prod.body.error).toContain("production");
        expect((await create(id, { description: SENTENCE, environment: "nope" })).status).toBe(404);

        site.log.length = 0;
        queue.push(...ADD_MUG);
        const res = await create(id, { description: SENTENCE, environment: "staging" });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        const job = await waitJob(res.body.jobId);
        expect(job.status, job.error).toBe("COMPLETED");
        const t = (await plainTests(id))[0]!;
        expect(t.validationStatus).toBe("VALIDATED");
        expect((await detail(t.id)).generationMeta.plain.environment).toBe("staging");
        // The browser really went to the environment's address.
        expect(site.log.some((l) => l.host === `localhost:${PORT}` && l.path === "/products")).toBe(true);
    }, 240_000);

    it("rebuilds the same test from a changed description, keeping its id and history", async () => {
        const before = await detail(builtId);
        queue.push(...ADD_PLATE);
        const NEW = "Add the Red Plate to the cart and check the total shows $8.50";
        const res = await call("POST", `/api/tests/${builtId}/plain-rewrite`, { description: NEW });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        const job = await waitJob(res.body.jobId);
        expect(job.status, job.error).toBe("COMPLETED");

        const after = await detail(builtId);
        expect(after.id).toBe(before.id);
        expect(after.testId).toBe(before.testId);
        expect(after.title).toBe(NEW);
        expect(after.validationStatus).toBe("VALIDATED");
        expect(after.generationMeta.plain.description).toBe(NEW);
        expect(after.scripts[0].version).toBeGreaterThan(before.scripts[0].version);
        expect(after.scripts[0].content).toContain("Add Red Plate to cart");
        expect(after.executions.length).toBeGreaterThan(before.executions.length);
        expect((await plainTests(projectId)).length).toBe(1);
    }, 240_000);

    it("leaves the test as it was when a rebuild cannot be finished, and only rebuilds plain-English tests", async () => {
        const before = await detail(builtId);
        queue.push(finish("blocked", "There is no discount code field on this page."));
        const res = await call("POST", `/api/tests/${builtId}/plain-rewrite`, { description: "Apply a discount code and check the total drops" });
        expect(res.status).toBe(202);
        const job = await waitJob(res.body.jobId);
        expect(job.status).toBe("FAILED");
        expect(job.error).toContain("The test was left as it was");
        expect(job.error).toContain("There is no discount code field");
        const after = await detail(builtId);
        expect(after.title).toBe(before.title);
        expect(after.validationStatus).toBe("VALIDATED");
        expect(after.scripts[0].version).toBe(before.scripts[0].version);

        const imported = ((await call("GET", `/api/projects/${projectId}/tests`)).body as any[]).find((t) => t.suite === "Imported")!;
        const refused = await call("POST", `/api/tests/${imported.id}/plain-rewrite`, { description: "Something else entirely" });
        expect(refused.status).toBe(422);
        expect(refused.body.error).toContain("plain English");
    }, 240_000);
});

describe("plain-English tests: refusals and job rules", () => {
    it("answers 422 with the plain 'AI model isn't set up' message when no model exists, and creates nothing", async () => {
        const id = await projectWithSite("Plain no model");
        const jobsBefore = (await call("GET", `/api/projects/${id}/jobs`)).body.length;
        const real = platform.llm;
        platform.llm = unavailableLlmClient("no key");
        try {
            const res = await create(id, { description: "Add the Blue Mug to the cart and check the total shows $12.00" });
            expect(res.status).toBe(422);
            expect(res.body.error).toMatch(/AI model isn.t set up/);
        } finally {
            platform.llm = real;
        }
        expect((await call("GET", `/api/projects/${id}/jobs`)).body).toHaveLength(jobsBefore);
        expect(await plainTests(id)).toHaveLength(0);
    });

    it("refuses unsafe descriptions up front with a plain reason, before any job exists", async () => {
        const id = await projectWithSite("Plain unsafe");
        const jobsBefore = (await call("GET", `/api/projects/${id}/jobs`)).body.length;
        const cases: Array<[string, RegExp]> = [
            ["Add a product, enter the credit card number and pay for the order", /pay for something|card details/],
            ["Log in and delete my account, then check it is gone", /delete data/],
            ["Log in with another user's password and check the account page", /someone else/],
            ["Try to brute force the login with common passwords", /break in|attack/],
            ["POST /api/products with the name Fork and check it answers 201", /sends data/],
        ];
        for (const [description, reason] of cases) {
            const res = await create(id, { description });
            expect(res.status, description).toBe(422);
            expect(res.body.error, description).toMatch(reason);
        }
        expect((await call("GET", `/api/projects/${id}/jobs`)).body.length).toBe(jobsBefore);
        // A description that only mentions the same words harmlessly is not refused.
        queue.push(click("link", "Products"), assertText({ by: "role", role: "status" }, "Total: $0.00"), finish("complete", "Checked the empty cart"));
        const ok = await create(id, { description: "Open the products page and check the cart total is $0.00" });
        expect(ok.status).toBe(202);
        await waitJob(ok.body.jobId);
    }, 240_000);

    it("validates the request body", async () => {
        const id = await projectWithSite("Plain input");
        expect((await create(id, { description: "ab" })).status).toBe(400);
        expect((await create(id, { description: "x".repeat(2001) })).status).toBe(400);
        expect((await create(id, { description: "Open the shop", kind: "mobile" })).status).toBe(400);
        const empty = await newProject("No application yet");
        const noApp = await create(empty, { description: "Open the shop and check the heading" });
        expect(noApp.status).toBe(400);
        expect(noApp.body.error).toMatch(/no application yet/);
        expect((await call("POST", `/api/projects/does-not-exist/plain-tests`, { description: "Open the shop" })).status).toBe(404);
    });

    it("allows one active job per project, and a running build can be cancelled", async () => {
        const id = await projectWithSite("Plain cancel");
        queue.push({ hang: true });
        const first = await create(id, { description: "Open the products page and check the cart total is $0.00" });
        expect(first.status).toBe(202);
        // The agent is now waiting on the (scripted) model.
        for (let i = 0; i < 100; i++) {
            const j = (await call("GET", `/api/test-generation/${first.body.jobId}`)).body;
            if (j.status === "GENERATING") break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const second = await create(id, { description: "Open the products page and check the cart total is $0.00" });
        expect(second.status).toBe(409);
        expect(second.body.error).toContain(first.body.jobId);

        expect((await call("DELETE", `/api/test-generation/${first.body.jobId}`)).status).toBe(202);
        const job = await waitJob(first.body.jobId, 60_000);
        expect(job.status).toBe("FAILED");
        expect(job.error).toBe("Cancelled");
        expect(await plainTests(id)).toHaveLength(0);
        // Free again afterwards.
        queue.push(click("link", "Products"), assertText({ by: "role", role: "status" }, "Total: $0.00"), finish("complete", "ok"));
        const third = await create(id, { description: "Open the products page and check the cart total is $0.00" });
        expect(third.status).toBe(202);
        await waitJob(third.body.jobId);
    }, 240_000);
});

describe("plain-English tests: API", () => {
    let projectId: string;

    it("needs known API operations first", async () => {
        const id = await projectWithSite("Plain api none");
        const res = await create(id, { description: "GET /api/products/1 should return the Blue Mug", kind: "api" });
        expect(res.status).toBe(422);
        expect(res.body.error).toContain("no known API operations");
    });

    it("learns the operations from a real analysis, then builds a GET test from a sentence and runs it", async () => {
        projectId = await newProject("Plain api");
        const analysis = await call("POST", `/api/projects/${projectId}/test-generation`, {
            url: SITE,
            targets: ["api"],
            openApiUrl: `${SITE}/openapi.json`,
            accessibility: false,
            healthChecks: false,
            securityChecks: false,
            inputChecks: false,
            accessChecks: false,
            useMemory: false,
            maxPages: 3,
        });
        expect(analysis.status, JSON.stringify(analysis.body)).toBe(202);
        const a = await waitJob(analysis.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(a.status);

        site.log.length = 0;
        plans.push({
            operation: "GET /api/products/{id}",
            explanation: "The description asks for one product.",
            pathValues: { id: "1" },
            query: {},
            expect: { fields: [{ path: "name", equals: "Blue Mug" }], bodyContains: [] },
        });
        const res = await create(projectId, { description: "GET /api/products/1 should return the Blue Mug" });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        expect(res.body.kind).toBe("api");
        const job = await waitJob(res.body.jobId);
        expect(job.status, job.error).toBe("COMPLETED");

        const t = (await plainTests(projectId))[0]!;
        expect(t.kind).toBe("api");
        expect(t.validationStatus).toBe("VALIDATED");
        const d = await detail(t.id);
        expect(d.spec.source.origin).toBe("plain-english");
        expect(d.spec.steps[0]).toMatchObject({ action: "request", method: "GET", path: "/api/products/1" });
        expect(d.spec.steps.some((s: any) => s.check === "jsonPath" && s.path === "name" && s.expected === "Blue Mug")).toBe(true);
        expect(d.executions[0].status).toBe("passed");
        // The model was only given the known operations; nothing but reads reached the shop.
        expect(seenPrompts.join("\n")).toContain("GET /api/products/{id}");
        expect(site.log.filter((l) => l.path.startsWith("/api/") && l.method !== "GET")).toEqual([]);
    }, 300_000);

    it("keeps a data-changing choice as 'needs review' without sending it, and an unknown operation with the reason", async () => {
        site.log.length = 0;
        plans.push({ operation: "POST /api/products", explanation: "Adds a product.", pathValues: {}, query: {}, body: { name: "Fork" }, expect: { status: 201, fields: [], bodyContains: [] } });
        const post = await create(projectId, { description: "Check that adding a product answers with success", kind: "api" });
        expect(post.status).toBe(202);
        expect((await waitJob(post.body.jobId)).status).toBe("PARTIALLY_COMPLETED");

        plans.push({ operation: "GET /api/orders", explanation: "", pathValues: {}, query: {}, expect: { fields: [], bodyContains: [] } });
        const unknown = await create(projectId, { description: "Check that the list of orders is not empty", kind: "api" });
        expect((await waitJob(unknown.body.jobId)).status).toBe("PARTIALLY_COMPLETED");

        const tests = await plainTests(projectId);
        expect(tests.length).toBe(3);
        const changing = tests.find((t) => t.title.startsWith("Check that adding a product"))!;
        expect(changing.validationStatus).toBe("NEEDS_REVIEW");
        expect(changing.validationReason).toContain("changes data");
        const missing = tests.find((t) => t.title.startsWith("Check that the list of orders"))!;
        expect(missing.validationStatus).toBe("NEEDS_REVIEW");
        expect(missing.validationReason).toContain("not one of the operations");
        for (const t of [changing, missing]) expect((await detail(t.id)).executions).toHaveLength(0);
        expect(site.log.filter((l) => l.path.startsWith("/api/"))).toEqual([]);
    }, 300_000);

    it("does not call a bare success check green", async () => {
        plans.push({ operation: "GET /api/products", explanation: "The list.", pathValues: {}, query: {}, expect: { fields: [], bodyContains: [] } });
        const res = await create(projectId, { description: "GET /api/products should work", kind: "api" });
        const job = await waitJob(res.body.jobId);
        expect(job.status).toBe("PARTIALLY_COMPLETED");
        const t = (await plainTests(projectId)).find((x) => x.title === "GET /api/products should work")!;
        expect(t.validationStatus).toBe("NEEDS_REVIEW");
        expect(t.validationReason).toContain("checks very little");
    }, 300_000);
});
