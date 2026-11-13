/**
 * UX-E, the plan mode of the start route, through real jobs: HTTP API -> queue -> worker -> real discovery of a local site ->
 * understanding and planning with a scripted model double -> a plan the person can read -> the tests are created only when
 * the plan is confirmed, from the stored exploration (nothing is explored twice).
 *
 * Checks that a plan-only job creates and runs nothing and keeps no run summary, that the numbers in the plan are the numbers the
 * platform then creates, that choices (a check kind off, a test idea left out) are honoured, that the old start (no `plan`) is
 * unchanged, and the refusals (used twice, widened, unknown idea, discarded, other project).
 *
 * Fixture site: port 6491 (tests/fixtures/memory-site.ts). The platform is driven through `server.inject`.
 * Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/onboarding-plan.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLlmClientOrUnavailable, type LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startMemorySite, type MemorySite } from "./fixtures/memory-site.js";

const PORT = 6491;
const URL = `http://127.0.0.1:${PORT}`;

let site: MemorySite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;
let svc: ReturnType<typeof getScheduleServices>;

// ── the scripted model ────────────────────────────────────────────────────────
const prompts = { analysis: 0, plan: 0, gap: 0 };
let modelCalls = 0;
/** When false the platform has no AI model configured (the real "unavailable" client). */
let aiOn = true;
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        modelCalls++;
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});

const IDEAS = [
    { title: "Browse the product list", journey: "Browse products", startPath: "/products", heading: "Products" },
    { title: "Read the about page", journey: "Read about us", startPath: "/about", heading: "About us" },
] as const;

const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        // The coverage-gap call (pages the plan does not touch yet): nothing new, so planning ends there.
        if (prompt.includes("Already covered by the plan")) {
            prompts.gap++;
            return { scenarios: [] };
        }
        if (/analysing a web application/.test(system)) {
            prompts.analysis++;
            return {
                siteType: "ecommerce",
                purpose: "A small shop",
                features: ["Browse products"],
                pagePurposes: [],
                journeys: [
                    { name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false },
                    { name: "Read about us", description: "Read the about page", steps: ["Open about"], priority: "low", pages: ["/about"], requiresAuth: false },
                ],
                authenticationMechanisms: [],
            };
        }
        prompts.plan++;
        for (const s of IDEAS) {
            toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: s.heading } } });
            toolQueue.push({ tool: "finish", input: { result: "complete", explanation: "checked" } });
        }
        return {
            scenarios: IDEAS.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: s.journey, startPath: s.startPath, expectedResults: [`${s.heading} is shown`] })),
        };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-onboarding-plan-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1", SECRET_KEY: "test-secret-key-0123456789" }));
    svc = getScheduleServices(platform);
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: (cfg) => (aiOn ? scripted : createLlmClientOrUnavailable(cfg)), onJobFinished: svc.onJobFinished }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await svc?.scheduler.stop();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────
const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};
const newProject = async (name: string) => (await call("POST", "/api/projects", { name })).body.id as string;
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
async function finished(jobId: string): Promise<any> {
    for (let i = 0; i < 600; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (DONE.includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("the job did not finish");
}
const events = async (jobId: string) => (await call("GET", `/api/test-generation/${jobId}/events`)).body as Array<{ kind: string; level: string; message: string }>;
const START = { url: URL, maxPages: 10, targets: ["web", "api"] };
const testsOf = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; title: string; validationStatus: string }>;
const family = (plan: any, id: string) => plan.families.find((f: any) => f.id === id);

// ── the journey ───────────────────────────────────────────────────────────────
describe("explore first, create after the person has looked", () => {
    let projectId = "";
    let planJob = "";
    let plan: any;

    it("a plan-only job explores and plans, and creates and runs nothing", async () => {
        projectId = await newProject("Plan first");
        const started = await call("POST", `/api/projects/${projectId}/test-generation`, { ...START, plan: true });
        expect(started.status).toBe(202);
        expect(started.body.plan).toBe(true);
        planJob = started.body.jobId;
        const job = await finished(planJob);

        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        expect(job.planOnly).toBe(true);
        expect(job.testsGenerated).toBe(0);
        expect(job.progress).toMatchObject({ discovery: "done", understanding: "done", planning: "done", generation: "skipped", validation: "skipped" });
        expect(job.counters.pagesDiscovered).toBeGreaterThan(3);
        expect(job.counters.scenariosPlanned).toBe(2);
        // The AI was asked to understand and to plan (the plan, then one coverage-gap call), and never to author a test.
        expect(prompts).toEqual({ analysis: 1, plan: 1, gap: 1 });
        expect(modelCalls).toBe(0);
        // Nothing exists yet: no test, no run summary, no script.
        expect(await testsOf(projectId)).toEqual([]);
        expect(platform.db.all("SELECT job_id FROM run_summaries WHERE job_id = ?", planJob)).toEqual([]);
        expect(platform.db.all("SELECT id FROM generated_scripts").length).toBe(0);
        const kinds = (await events(planJob)).map((e) => e.kind);
        expect(kinds).toContain("plan_ready");
        expect(kinds).not.toContain("script_generated");
        expect(kinds).not.toContain("validation_passed");
    }, 120_000);

    it("the plan says what was found, lists the test ideas and counts the tests each kind of check would create", async () => {
        const r = await call("GET", `/api/projects/${projectId}/plans/${planJob}`);
        expect(r.status).toBe(200);
        plan = r.body;
        expect(plan).toMatchObject({ ready: true, jobId: planJob, url: URL, targets: ["web", "api"], used: null, signInDetails: false, warnings: [] });
        expect(plan.found.pages).toBeGreaterThanOrEqual(4);
        expect(plan.found.apiEndpoints).toBe(2);
        expect(plan.found.journeys).toBe(2);
        expect(plan.about).toMatchObject({ siteType: "ecommerce" });
        expect(plan.ideas.map((i: any) => i.title)).toEqual(["Browse the product list", "Read the about page"]);
        expect(plan.pages.length).toBe(plan.found.pages);
        // Every family is listed with a plain sentence; the default switches decide which are on.
        const on = plan.families.filter((f: any) => f.on).map((f: any) => f.id).sort();
        expect(on).toEqual(["access", "accessibility", "api", "contract", "health", "input", "journeys", "security"].sort());
        for (const f of plan.families) expect(f.about.length).toBeGreaterThan(20);
        expect(family(plan, "journeys").count).toBe(2);
        expect(family(plan, "api").count).toBeGreaterThan(0);
        expect(family(plan, "accessibility").count).toBeGreaterThan(0);
        expect(family(plan, "contract").count).toBe(0); // no OpenAPI description on this site
        expect(family(plan, "access").note).toMatch(/test accounts/);
        expect(plan.total).toBe(plan.families.filter((f: any) => f.on).reduce((n: number, f: any) => n + f.effective, 0));
        // The plan holds what the site showed to a visitor: no page text, no secrets.
        expect(JSON.stringify(plan)).not.toMatch(/SENTINEL|Sentinel-Pass/);
        // Another project cannot read it, and a job that is not a plan is not one.
        const other = await newProject("Someone else");
        expect((await call("GET", `/api/projects/${other}/plans/${planJob}`)).status).toBe(404);
        expect((await call("GET", `/api/projects/${projectId}/plans/not-a-job`)).status).toBe(404);
    });

    it("refuses choices that make no sense before it starts anything", async () => {
        const create = (body: unknown, id = projectId) => call("POST", `/api/projects/${id}/plans/${planJob}/create`, body);
        expect((await create({ excludeIdeas: ["SC-999"] })).body.error).toMatch(/Unknown test idea/);
        expect((await create({ nonsense: true })).status).toBe(400);
        const noApi = await create({ targets: ["web"], accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, excludeIdeas: plan.ideas.map((i: any) => i.id) });
        expect(noApi.status).toBe(400);
        expect(noApi.body.error).toMatch(/Nothing is selected/);
        expect((await create({}, await newProject("Not mine"))).status).toBe(404);
        // None of that created a job.
        expect((await call("GET", `/api/projects/${projectId}/jobs`)).body.length).toBe(1);
    });

    it("creates exactly the chosen tests from the stored exploration, without exploring again", async () => {
        const left = plan.ideas[1].id as string;
        const created = await call("POST", `/api/projects/${projectId}/plans/${planJob}/create`, {
            accessibility: false,
            healthChecks: false,
            inputChecks: false,
            excludeIdeas: [left],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(202);
        // A second confirmation of the same plan is refused while and after the first one runs.
        expect((await call("POST", `/api/projects/${projectId}/plans/${planJob}/create`, {})).status).toBe(409);
        const job = await finished(created.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        expect(job.fromPlan).toBe(planJob);
        expect(job.planOnly).toBeUndefined();
        expect(job.counters.scenariosPlanned).toBe(1);

        // Nothing was explored, understood or planned again.
        expect(prompts).toEqual({ analysis: 1, plan: 1, gap: 1 });
        const kinds = (await events(created.body.jobId)).map((e) => e.kind);
        expect(kinds).toContain("plan_reused");
        expect(kinds).not.toContain("application_discovered");

        // The numbers in the plan are the numbers created: one journey (the other was left out), the API checks and the basic security checks.
        const tests = await testsOf(projectId);
        const web = tests.filter((t) => t.testId.startsWith("WEB-"));
        const apiTests = tests.filter((t) => t.testId.startsWith("API-"));
        expect(web.map((t) => t.title)).toEqual(["Browse the product list"]);
        expect(apiTests.length).toBe(family(plan, "api").count + family(plan, "security").count);
        expect(tests.length).toBe(1 + family(plan, "api").count + family(plan, "security").count);
        // The model was asked to author the one journey that was kept.
        expect(modelCalls).toBeGreaterThan(0);
        // A creation job is a real run: it counts, a plan does not.
        expect(platform.db.all("SELECT job_id FROM run_summaries WHERE job_id = ?", created.body.jobId).length).toBe(1);
        expect(platform.db.all("SELECT job_id FROM run_summaries WHERE job_id = ?", planJob)).toEqual([]);

        // The project reads the plan as used.
        const again = (await call("GET", `/api/projects/${projectId}/plans/${planJob}`)).body;
        expect(again.used).toEqual({ jobId: created.body.jobId });
        const run = (await call("GET", `/api/projects/${projectId}/runs/${created.body.jobId}`)).body;
        expect(run.tests.length).toBe(tests.length);
    }, 240_000);

    it("a plan that is discarded is gone, and says so", async () => {
        const p2 = await newProject("Discarded plan");
        toolQueue.length = 0;
        const j = (await call("POST", `/api/projects/${p2}/test-generation`, { ...START, targets: ["api"], plan: true })).body.jobId;
        const done = await finished(j);
        expect(done.status).toBe("COMPLETED");
        expect(done.progress).toMatchObject({ understanding: "skipped", planning: "skipped" });
        const view = (await call("GET", `/api/projects/${p2}/plans/${j}`)).body;
        expect(view.ideas).toEqual([]);
        expect(view.about).toBeNull();
        expect(family(view, "journeys").on).toBe(false);
        expect((await call("DELETE", `/api/projects/${p2}/plans/${j}`)).body).toEqual({ discarded: true });
        const gone = await call("GET", `/api/projects/${p2}/plans/${j}`);
        expect(gone.status).toBe(410);
        expect(gone.body.error).toMatch(/no longer available/);
        expect((await call("POST", `/api/projects/${p2}/plans/${j}/create`, {})).status).toBe(410);
        expect(await testsOf(p2)).toEqual([]);
    }, 120_000);

    it("cannot widen what the exploration looked at", async () => {
        const p3 = await newProject("Narrow plan");
        const j = (await call("POST", `/api/projects/${p3}/test-generation`, { ...START, targets: ["api"], plan: true })).body.jobId;
        await finished(j);
        const widen = await call("POST", `/api/projects/${p3}/plans/${j}/create`, { targets: ["web", "api"] });
        expect(widen.status).toBe(400);
        expect(widen.body.error).toMatch(/only explored the api side/);
    }, 120_000);
});

describe("without an AI model", () => {
    it("still plans the API side and says plainly what could not be planned", async () => {
        aiOn = false;
        try {
            const p = await newProject("No model");
            const j = (await call("POST", `/api/projects/${p}/test-generation`, { ...START, plan: true })).body.jobId;
            const job = await finished(j);
            expect(job.status).toBe("PARTIALLY_COMPLETED");
            const view = (await call("GET", `/api/projects/${p}/plans/${j}`)).body;
            expect(view.warnings.join(" ")).toMatch(/Web analysis\/planning failed/);
            expect(view.ideas).toEqual([]);
            expect(family(view, "api").count).toBeGreaterThan(0);
            expect(view.total).toBeGreaterThan(0);
            expect(await testsOf(p)).toEqual([]);

            // A web-only plan has nothing to offer without it: the job fails, with the reason, instead of a plan with nothing in it.
            const p2 = await newProject("No model, web only");
            const j2 = (await call("POST", `/api/projects/${p2}/test-generation`, { ...START, targets: ["web"], plan: true, accessibility: false, healthChecks: false, inputChecks: false, securityChecks: false, contractChecks: false })).body.jobId;
            const failed = await finished(j2);
            expect(failed.status).toBe("FAILED");
            expect(failed.error).toBeTruthy();
            expect((await call("GET", `/api/projects/${p2}/plans/${j2}`)).status).toBe(409);
        } finally {
            aiOn = true;
        }
    }, 240_000);
});

describe("the start every other caller uses is unchanged", () => {
    it("without `plan` the job explores, creates and runs in one go, and no plan exists", async () => {
        const p = await newProject("Old start");
        const started = await call("POST", `/api/projects/${p}/test-generation`, { ...START, targets: ["api"], securityChecks: false });
        expect(started.status).toBe(202);
        expect(started.body.plan).toBeUndefined();
        const job = await finished(started.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        expect(job.planOnly).toBeUndefined();
        expect(job.fromPlan).toBeUndefined();
        expect(job.testsGenerated).toBeGreaterThan(0);
        expect((await testsOf(p)).length).toBe(job.testsGenerated);
        expect((await call("GET", `/api/projects/${p}/plans/${started.body.jobId}`)).status).toBe(404);
        // The option is validated like every other.
        expect((await call("POST", `/api/projects/${p}/test-generation`, { ...START, plan: "yes" })).status).toBe(400);
    }, 180_000);
});
