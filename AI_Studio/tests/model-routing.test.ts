/**
 * Model routing through the real platform: HTTP API -> job queue -> worker -> real discovery of a local site -> the engine's calls to two
 * scripted `LlmClient` doubles (a main model and a fast model) -> the authoring agent driving Chromium -> real validation of the tests.
 * The doubles report usage numbers; nothing calls a real model.
 *
 *  - the Settings routes (GET/PUT /api/llm/fast-model): environment value, a value saved in the app, "" = off, null = the environment again;
 *  - with a fast model: understanding and planning on the main model, the agent's steps on the fast model, a scenario where the fast model
 *    fails the same action twice handed to the main model (job event, usage row "escalated", the job's one-line summary), usage by model;
 *  - with the setting empty: the old behaviour, the main model does everything and nothing is said about routing.
 *
 * Ports: 7330 fixture site. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/model-routing.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startMemorySite, type MemorySite } from "./fixtures/memory-site.js";

const SITE_PORT = 7330;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

let site: MemorySite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

type ToolStep = { tool: string; input: Record<string, unknown> };
const STEP = { input: 2000, output: 500 };
const OBJECT = { input: 5000, output: 1000 };

/** One scripted agent model: plays its queue of tool calls, one per step, and logs each step. */
function agent(name: string, queue: ToolStep[], log: string[]) {
    return new MockLanguageModelV3({
        provider: name,
        modelId: name,
        doGenerate: async () => {
            log.push(name);
            const usage = { inputTokens: { total: STEP.input, noCache: STEP.input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: STEP.output, text: STEP.output, reasoning: 0 } };
            const next = queue.shift();
            if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        },
    });
}

const steps: string[] = [];
const mainQueue: ToolStep[] = [];
const fastQueue: ToolStep[] = [];
const objectCalls = { main: [] as string[], fast: [] as string[] };
/** How the next planning call fills the agents' queues: "routed" = scenario 1 by the fast model, scenario 2 fumbled by it then done by the main one. */
let plan: "routed" | "main-only" = "routed";

const PLAN = [
    { title: "Browse the product list", journey: "Browse products", startPath: "/products", heading: "Products" },
    { title: "Read the about page", journey: "Read about us", startPath: "/about", heading: "About us" },
];
const assertHeading = (heading: string): ToolStep => ({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: heading } } });
const FINISH: ToolStep = { tool: "finish", input: { result: "complete", explanation: "checked" } };
const MISSING: ToolStep = { tool: "click", input: { target: { by: "css", value: "#no-such-element" }, why: "open the details" } };

function scriptedClient(name: string, own: string[], queue: ToolStep[]): LlmClient {
    const c: LlmClient = {
        modelName: name,
        model: agent(name, queue, steps),
        usage: { inputTokens: 0, outputTokens: 0 },
        text: async () => "",
        object: (async ({ system }: { system: string }) => {
            own.push(system.slice(0, 40));
            c.usage.inputTokens += OBJECT.input;
            c.usage.outputTokens += OBJECT.output;
            if (/analysing a web application/.test(system)) {
                return {
                    siteType: "ecommerce",
                    purpose: "A small shop",
                    features: ["Browse products"],
                    pagePurposes: [],
                    journeys: PLAN.map((s) => ({ name: s.journey, description: s.title, steps: ["Open"], priority: "high", pages: ["/", s.startPath], requiresAuth: false })),
                    authenticationMechanisms: [],
                };
            }
            if (/failing API test|analyse why an automatically generated/.test(system)) throw new Error("repair must not reach the model in these tests");
            if (plan === "routed") {
                fastQueue.push(assertHeading(PLAN[0]!.heading), FINISH, MISSING, MISSING);
                mainQueue.push(assertHeading(PLAN[1]!.heading), FINISH);
            } else {
                for (const s of PLAN) mainQueue.push(assertHeading(s.heading), FINISH);
            }
            return { scenarios: PLAN.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: s.journey, startPath: s.startPath, expectedResults: [`${s.heading} is shown`] })) };
        }) as LlmClient["object"],
    };
    return c;
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(SITE_PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-routing-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", LLM_API_KEY: "test-key-not-real", LLM_MODEL: "main-model", LLM_MODEL_FAST: "fast-model", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1", SECRET_KEY: "test-secret-key-0123456789" }),
    );
    server = await buildServer(platform);
    // A new pair of clients per job, as production builds them (each with its own counters).
    worker = new Worker({ ...platform, makeLlm: () => scriptedClient("main-model", objectCalls.main, mainQueue), makeFastLlm: () => scriptedClient("fast-model", objectCalls.fast, fastQueue) }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};
const TERMINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
async function generate(projectId: string) {
    const queued = await call("POST", `/api/projects/${projectId}/test-generation`, { url: SITE, targets: ["web"], maxPages: 6, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const jobId = queued.body.jobId as string;
    const end = Date.now() + 200_000;
    for (;;) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (TERMINAL.includes(j.status)) return { job: j, jobId };
        if (Date.now() > end) throw new Error(`job ${jobId} did not finish (${j.status})`);
        await new Promise((r) => setTimeout(r, 300));
    }
}
const eventsOf = async (jobId: string) => (await call("GET", `/api/test-generation/${jobId}/events`)).body as Array<{ kind: string; level: string; message: string }>;
const testsOf = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ title: string; validationStatus: string }>;
const reset = () => {
    steps.length = 0;
    mainQueue.length = 0;
    fastQueue.length = 0;
    objectCalls.main.length = 0;
    objectCalls.fast.length = 0;
};

describe("the fast model setting in Settings, AI model", () => {
    it("shows the server's value, what goes to which model, and the escalation rules", async () => {
        const r = await call("GET", "/api/llm/fast-model");
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ provider: "anthropic", model: "fast-model", source: "environment", environment: "fast-model", ready: true, active: true, images: false, configured: true, limits: { sameActionFails: 2 } });
        expect(r.body.fastFor.join(" ")).toMatch(/web test/);
        expect(r.body.mainFor.join(" ")).toMatch(/Planning tests/);
        expect(JSON.stringify(r.body)).not.toContain("test-key-not-real");
    });
    it("refuses a name with spaces or commas, in words", async () => {
        const r = await call("PUT", "/api/llm/fast-model", { model: "a, b" });
        expect(r.status).toBe(400);
        expect(r.body.error ?? r.body.message).toMatch(/One model name/);
        expect((await call("PUT", "/api/llm/fast-model", { model: "x", extra: 1 })).status).toBe(400);
    });
});

describe("a job with a fast model", () => {
    let projectId: string;
    let jobId: string;

    it("plans on the main model, writes on the fast one, and hands a fumbled scenario to the main one", async () => {
        reset();
        plan = "routed";
        projectId = (await call("POST", "/api/projects", { name: "Routing" })).body.id;
        const r = await generate(projectId);
        jobId = r.jobId;
        expect(r.job.status, JSON.stringify(r.job)).toBe("COMPLETED");
        const tests = await testsOf(projectId);
        expect(tests.map((t) => t.title).sort()).toEqual(PLAN.map((p) => p.title).sort());
        expect(tests.every((t) => t.validationStatus === "VALIDATED")).toBe(true);
        // Understanding and planning: main model only.
        expect(objectCalls.main).toHaveLength(2);
        expect(objectCalls.fast).toEqual([]);
        // Scenario 1: fast, fast. Scenario 2: fast fails the same click twice, then the main model asserts and finishes.
        expect(steps).toEqual(["fast-model", "fast-model", "fast-model", "fast-model", "main-model", "main-model"]);
        const esc = (await eventsOf(jobId)).filter((e) => e.kind === "ai_model_escalated");
        expect(esc.map((e) => e.message)).toEqual(["Scenario S-002: the fast AI model fast-model tried the same action twice and it failed both times, so the main model main-model does the rest of it."]);
    }, 240_000);

    it("counts the escalation and the tokens per model in the job's usage", async () => {
        const u = (await call("GET", `/api/jobs/${jobId}/usage`)).body;
        expect(u.totals.escalations).toBe(1);
        expect(u.summary).toMatch(/, 1 escalated to the main model$/);
        const byModel = Object.fromEntries((u.byModel as Array<{ key: string; inputTokens: number; escalations: number }>).map((g) => [g.key, g]));
        expect(byModel["fast-model"]!.inputTokens).toBe(4 * STEP.input);
        expect(byModel["main-model"]!.inputTokens).toBe(2 * OBJECT.input + 2 * STEP.input);
        expect(byModel["main-model"]!.escalations).toBe(1);
        // "Escalation" is not a purpose of its own in the breakdown.
        expect((u.byPurpose as Array<{ key: string }>).map((g) => g.key)).not.toContain("escalation");
        const month = (await call("GET", "/api/usage")).body;
        expect(month.totals.escalations).toBe(1);
        expect(month.totals.totalTokens).toBe(u.totals.totalTokens);
    });
});

describe("the setting emptied in Settings", () => {
    it("switches routing off: the main model does everything, as before", async () => {
        const saved = await call("PUT", "/api/llm/fast-model", { model: "" });
        expect(saved.status).toBe(200);
        expect(saved.body).toMatchObject({ source: "app", model: null, active: false, environment: "fast-model" });
        reset();
        plan = "main-only";
        const projectId = (await call("POST", "/api/projects", { name: "No routing" })).body.id;
        const r = await generate(projectId);
        expect(r.job.status).toBe("COMPLETED");
        expect((await testsOf(projectId)).every((t) => t.validationStatus === "VALIDATED")).toBe(true);
        expect(steps).toEqual(["main-model", "main-model", "main-model", "main-model"]);
        expect(objectCalls.fast).toEqual([]);
        const ev = await eventsOf(r.jobId);
        expect(ev.some((e) => e.kind === "ai_model_escalated" || e.kind === "ai_fast_model_unused")).toBe(false);
        const u = (await call("GET", `/api/jobs/${r.jobId}/usage`)).body;
        expect(u.totals.escalations).toBe(0);
        expect((u.byModel as Array<{ key: string }>).map((g) => g.key)).toEqual(["main-model"]);
        expect(u.summary).not.toMatch(/escalated/);

        // null: follow the server's LLM_MODEL_FAST again.
        expect((await call("PUT", "/api/llm/fast-model", { model: null })).body).toMatchObject({ source: "environment", model: "fast-model", active: true });
    }, 240_000);
});
