/**
 * AI usage and budgets through the real platform: HTTP API -> job queue -> worker -> real discovery of a local site -> the engine's real
 * calls to a scripted `LlmClient` double (analysis, planning, the authoring agent driving Chromium, repair) -> real validation.
 * The double reports usage numbers; it never calls a model. Checks usage rows per job/purpose/day, totals and groupings, prices and
 * budgets over the API, a job that hits its cap mid-way and stops cleanly (keeping and validating what it made), the project and
 * month caps, validation-only runs and repair under a reached cap, schedules skipped when the month is capped, that no prompt or
 * answer is ever stored, and that the endpoints sit behind the API key.
 *
 * Ports: 5770 fixture shop, 5771 fixture API. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/usage.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { monthBounds, monthOf } from "../src/engine/llm/usage.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { UsageStore } from "../src/platform/usage-store.js";
import { Worker } from "../src/platform/worker.js";
import { startMemorySite, type MemorySite } from "./fixtures/memory-site.js";

const SITE_PORT = 5770;
const API_PORT = 5771;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const KEY_SENTINEL = "SENTINEL-LLM-KEY-90210";
const ANSWER_SENTINEL = "SENTINEL-ANSWER-31337";

let site: MemorySite;
let apiFixture: http.Server;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let svc: ScheduleServices;
let dir: string;
let clockNow = Date.now();

// ── the scripted model ────────────────────────────────────────────────────────
const prompts: string[] = [];
const modelCalls = { object: 0, text: 0 };
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
/** What one agent step is reported as using. The numbers are far above the size of the prompts, so the up-front estimate of a call
 * (characters / 4) never decides these tests; only the reported usage does. */
const STEP = { input: 2000, output: 500 };
/** What one object() call is reported as using. */
const OBJECT = { input: 5000, output: 1000 };
/** What one text() call (the review of a finished web test) is reported as using. */
const REVIEW = { input: 1000, output: 500 };

const model = new MockLanguageModelV3({
    doGenerate: async () => {
        const usage = { inputTokens: { total: STEP.input, noCache: STEP.input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: STEP.output, text: STEP.output, reasoning: 0 } };
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});

const PLAN = [
    { title: "Browse the product list", journey: "Browse products", startPath: "/products", heading: "Products" },
    { title: "Read the about page", journey: "Read about us", startPath: "/about", heading: "About us" },
];

const scripted: LlmClient = {
    modelName: "scripted-usage",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => {
        modelCalls.text++;
        scripted.usage.inputTokens += REVIEW.input;
        scripted.usage.outputTokens += REVIEW.output;
        return "OK";
    },
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        modelCalls.object++;
        prompts.push(prompt);
        scripted.usage.inputTokens += OBJECT.input;
        scripted.usage.outputTokens += OBJECT.output;
        if (/analysing a web application/.test(system)) {
            return {
                siteType: "ecommerce",
                purpose: `A small shop ${ANSWER_SENTINEL}`,
                features: ["Browse products"],
                pagePurposes: [],
                journeys: [
                    { name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false },
                    { name: "Read about us", description: "Read the about page", steps: ["Open about"], priority: "low", pages: ["/about"], requiresAuth: false },
                ],
                authenticationMechanisms: [],
            };
        }
        if (/failing API test|analyse why an automatically generated/.test(system)) throw new Error("repair must not reach the model in these tests");
        // The coverage-gap call (pages the plan does not touch yet): nothing new, so planning ends there.
        if (prompt.includes("Already covered by the plan")) return { scenarios: [] };
        for (const s of PLAN) {
            toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: s.heading } } });
            toolQueue.push({ tool: "finish", input: { result: "complete", explanation: "checked" } });
        }
        return {
            scenarios: PLAN.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: s.journey, startPath: s.startPath, expectedResults: [`${s.heading} is shown`] })),
        };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(SITE_PORT);
    apiFixture = http.createServer((req, res) => {
        res.writeHead(req.url === "/api/ping" ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => apiFixture.listen(API_PORT, "127.0.0.1", r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-usage-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", LLM_API_KEY: KEY_SENTINEL, CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1", SECRET_KEY: "test-secret-key-0123456789" }));
    svc = getScheduleServices(platform, { clock: () => clockNow });
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted, onJobFinished: svc.onJobFinished }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await svc?.scheduler.stop();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.server.close();
    apiFixture?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────
const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};
const newProject = async (name: string) => {
    const id = (await call("POST", "/api/projects", { name })).body.id as string;
    // This file runs the tests the AI wrote: with the default policy they are drafts and wait for approval (tests/reviews-api.test.ts).
    await call("PUT", `/api/projects/${id}/review-policy`, { aiGenerated: false });
    return id;
};
const TERMINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
async function waitJob(jobId: string, ms = 200_000) {
    const end = Date.now() + ms;
    for (;;) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (TERMINAL.includes(j.status)) return j;
        if (Date.now() > end) throw new Error(`job ${jobId} did not finish (${j.status})`);
        await new Promise((r) => setTimeout(r, 300));
    }
}
const events = async (jobId: string) => (await call("GET", `/api/test-generation/${jobId}/events`)).body as Array<{ kind: string; level: string; message: string }>;
const jobUsage = async (jobId: string) => (await call("GET", `/api/jobs/${jobId}/usage`)).body;
const month = async () => (await call("GET", "/api/usage")).body.month as { usedTokens: number; limitTokens: number | null; level: string };
const setBudgets = (b: Record<string, unknown>) => call("PUT", "/api/usage/budgets", b);

/** A real analysis of the fixture shop with the scripted model. */
async function analyse(projectId: string) {
    toolQueue.length = 0;
    const queued = await call("POST", `/api/projects/${projectId}/test-generation`, {
        url: SITE,
        targets: ["web"],
        maxPages: 6,
        accessibility: false,
        healthChecks: false,
        securityChecks: false,
        inputChecks: false,
        contractChecks: false,
        accessChecks: false,
    });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const job = await waitJob(queued.body.jobId);
    return { job, jobId: queued.body.jobId as string };
}
const testsOf = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string; validationStatus: string; validationReason: string | null }>;

// ── the API on its own ───────────────────────────────────────────────────────
describe("usage, prices and budgets over the API", () => {
    const lastMonthDay = (() => {
        const d = new Date();
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() - 1);
        d.setUTCDate(15);
        return d.toISOString().slice(0, 10);
    })();
    const dayAfter = new Date(Date.parse(`${lastMonthDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    let pA: string;
    let pB: string;

    it("starts empty: no usage, no prices (none are built in), no limits, and says how to get a cost", async () => {
        pA = await newProject("Usage A");
        pB = await newProject("Usage B");
        const u = await call("GET", "/api/usage");
        expect(u.status).toBe(200);
        expect(u.body.totals).toMatchObject({ calls: 0, totalTokens: 0, cost: null, estimated: false });
        expect(u.body.groups).toEqual([]);
        expect(u.body.currency).toBe("");
        expect(u.body.month).toMatchObject({ usedTokens: 0, limitTokens: null, level: "none", warnPercent: 80 });
        expect(u.body.pricing).toBeNull(); // nothing used, nothing to price
        const days = u.body.series.length;
        expect(days).toBeGreaterThanOrEqual(1);
        expect(u.body.series[0].key).toBe(monthBounds(monthOf(Date.now())).from);
        expect((await call("GET", "/api/usage/prices")).body).toEqual({ currency: "", prices: [] });
        expect((await call("GET", "/api/usage/budgets")).body.platform).toMatchObject({ monthlyTokens: null, jobTokens: null, monthlySource: "none", warnPercent: 80 });
    });

    it("totals and groupings for a range: by day, project, purpose and model, and for one project only", async () => {
        const store = new UsageStore(platform.db);
        const add = (projectId: string, jobId: string, purpose: string, modelName: string, day: string, i: number, o: number, extra: { calls?: number; est?: number } = {}) =>
            store.addUsage({ jobId, projectId, purpose, model: modelName, at: new Date(`${day}T10:00:00Z`), calls: extra.calls ?? 1, failedCalls: 0, inputTokens: i, outputTokens: o, images: 0, estimatedCalls: extra.est ?? 0 });
        add(pA, "seed-1", "analysis", "model-x", lastMonthDay, 1000, 100);
        add(pA, "seed-1", "repair", "model-x", lastMonthDay, 400, 40, { calls: 2 });
        add(pB, "seed-2", "vision", "model-y", dayAfter, 5000, 500, { est: 1 });

        const q = (extra: string) => call("GET", `/api/usage?from=${lastMonthDay}&to=${dayAfter}${extra}`);
        const all = (await q("")).body;
        expect(all.totals).toMatchObject({ calls: 4, inputTokens: 6400, outputTokens: 640, totalTokens: 7040, estimated: true, cost: null, unpricedTokens: 7040 });
        expect(all.pricing).toBe("Set a price to see a cost.");
        expect(all.series.map((d: any) => [d.key, d.totalTokens])).toEqual([[lastMonthDay, 1540], [dayAfter, 5500]]);

        const byProject = (await q("&groupBy=project")).body.groups;
        expect(byProject.map((g: any) => [g.label, g.totalTokens])).toEqual([["Usage B", 5500], ["Usage A", 1540]]);
        const byPurpose = (await q("&groupBy=purpose")).body.groups;
        expect(byPurpose.map((g: any) => g.key)).toEqual(["vision", "analysis", "repair"]);
        expect(byPurpose.find((g: any) => g.key === "repair").calls).toBe(2);
        expect((await q("&groupBy=model")).body.groups.map((g: any) => [g.key, g.totalTokens])).toEqual([["model-y", 5500], ["model-x", 1540]]);
        // one project only: another project's numbers never show
        const onlyA = (await q(`&projectId=${pA}`)).body;
        expect(onlyA.totals.totalTokens).toBe(1540);
        expect(onlyA.groups.map((g: any) => g.key)).toEqual([lastMonthDay]); // grouped by day by default
        expect(onlyA.series.reduce((n: number, d: any) => n + d.totalTokens, 0)).toBe(1540);
        // these rows are from last month: this month's total is untouched
        expect((await call("GET", "/api/usage")).body.month.usedTokens).toBe(0);
    });

    it("rejects ranges that are too long, backwards or not dates, unknown projects and unknown parameters", async () => {
        expect((await call("GET", "/api/usage?from=2026-01-01&to=2027-12-31")).status).toBe(400);
        expect((await call("GET", "/api/usage?from=2026-10-10&to=2026-10-01")).status).toBe(400);
        expect((await call("GET", "/api/usage?from=2026-13-40")).status).toBe(400);
        expect((await call("GET", "/api/usage?from=yesterday")).status).toBe(400);
        expect((await call("GET", "/api/usage?groupBy=prompt")).status).toBe(400);
        expect((await call("GET", "/api/usage?projectId=nope")).status).toBe(404);
        expect((await call("GET", "/api/usage?evil=1")).status).toBe(400);
        const exactlyAYear = await call("GET", "/api/usage?from=2026-01-01&to=2026-12-31");
        expect(exactlyAYear.status).toBe(200);
        expect(exactlyAYear.body.series).toHaveLength(365);
    });

    it("prices are the user's own: a cost appears only for priced models, with their currency label", async () => {
        const bad = [
            { model: "model-x" },
            { model: "model-x", inputPerMTok: 3 },
            { model: "model-x", inputPerMTok: -1, outputPerMTok: 15 },
            { inputPerMTok: 3, outputPerMTok: 15 },
            { model: "", inputPerMTok: 1, outputPerMTok: 1 },
            { model: "model-x", inputPerMTok: "3", outputPerMTok: 15 },
            { model: "model-x", inputPerMTok: 3, outputPerMTok: 15, extra: 1 },
            {},
            { currency: "<script>" },
            { currency: "WAY-TOO-LONG-LABEL" },
        ];
        for (const b of bad) expect((await call("PUT", "/api/usage/prices", b)).status, JSON.stringify(b)).toBe(400);

        const put = await call("PUT", "/api/usage/prices", { model: "model-x", inputPerMTok: 3, outputPerMTok: 15, currency: "EUR" });
        expect(put.status).toBe(200);
        expect(put.body).toEqual({ currency: "EUR", prices: [{ model: "model-x", inputPerMTok: 3, outputPerMTok: 15 }] });
        const u = (await call("GET", `/api/usage?from=${lastMonthDay}&to=${dayAfter}`)).body;
        // model-x: 1400 in, 140 out; model-y is not priced, so the cost is partial and says so
        expect(u.totals.cost).toBeCloseTo((1400 / 1e6) * 3 + (140 / 1e6) * 15, 10);
        expect(u.totals.unpricedTokens).toBe(5500);
        expect(u.pricing).toBe("The cost covers only the models that have a price.");
        expect(u.currency).toBe("EUR");
        // a currency label alone is fine; a price can be replaced and removed
        expect((await call("PUT", "/api/usage/prices", { currency: "" })).body.currency).toBe("");
        expect((await call("PUT", "/api/usage/prices", { model: "model-x", inputPerMTok: 4, outputPerMTok: 16 })).body.prices[0]).toMatchObject({ inputPerMTok: 4 });
        expect((await call("DELETE", "/api/usage/prices?model=model-x")).body.prices).toEqual([]);
        expect((await call("DELETE", "/api/usage/prices?model=model-x")).status).toBe(404);
        expect((await call("GET", `/api/usage?from=${lastMonthDay}&to=${dayAfter}`)).body.totals.cost).toBeNull();
    });

    it("validates budgets, keeps them per project and lets a limit be removed", async () => {
        for (const b of [{ monthlyTokens: 0 }, { monthlyTokens: -5 }, { jobTokens: 1.5 }, { monthlyTokens: "100" }, { warnPercent: 0 }, { warnPercent: 100 }, { surprise: 1 }])
            expect((await setBudgets(b)).status, JSON.stringify(b)).toBe(400);
        const ok = await setBudgets({ monthlyTokens: 1_000_000, jobTokens: 50_000, warnPercent: 90 });
        expect(ok.status).toBe(200);
        expect(ok.body.platform).toMatchObject({ monthlyTokens: 1_000_000, jobTokens: 50_000, warnPercent: 90, monthlySource: "app", jobSource: "app" });
        expect(ok.body.month).toMatchObject({ limitTokens: 1_000_000, level: "ok", warnPercent: 90 });
        // leaving a field out keeps it; null removes it
        expect((await setBudgets({ jobTokens: null })).body.platform).toMatchObject({ monthlyTokens: 1_000_000, jobTokens: null, jobSource: "none" });

        expect((await call("PUT", "/api/projects/nope/usage-budget", { monthlyTokens: 5 })).status).toBe(404);
        expect((await call("PUT", `/api/projects/${pA}/usage-budget`, { monthlyTokens: 0 })).status).toBe(400);
        expect((await call("PUT", `/api/projects/${pA}/usage-budget`, { warnPercent: 50 })).status).toBe(400);
        const p = await call("PUT", `/api/projects/${pA}/usage-budget`, { monthlyTokens: 7000, jobTokens: 900 });
        expect(p.body).toMatchObject({ projectId: pA, monthlyTokens: 7000, jobTokens: 900, usedTokens: 0 });
        expect((await call("GET", `/api/projects/${pB}/usage-budget`)).body).toMatchObject({ projectId: pB, monthlyTokens: null, jobTokens: null });
        expect((await call("GET", "/api/usage/budgets")).body.projects).toEqual([{ projectId: pA, name: "Usage A", monthlyTokens: 7000, jobTokens: 900, usedTokens: 0 }]);
        // clean up so the real jobs below start without any limit
        await setBudgets({ monthlyTokens: null, jobTokens: null, warnPercent: 80 });
        await call("PUT", `/api/projects/${pA}/usage-budget`, { monthlyTokens: null, jobTokens: null });
        expect((await call("GET", "/api/usage/budgets")).body.projects).toEqual([]);
    });

    it("answers 404 for a job that does not exist", async () => {
        expect((await call("GET", "/api/jobs/not-a-job/usage")).status).toBe(404);
    });
});

// ── jobs with the scripted model ─────────────────────────────────────────────
describe("AI use by real jobs", () => {
    let p1: string;
    let p4: string;
    let j1: string;

    it("a normal analysis records its calls by purpose, model and day, and the numbers match what the model reported", async () => {
        p1 = await newProject("Shop one");
        const { job, jobId } = await analyse(p1);
        j1 = jobId;
        expect(job.status, job.error).toBe("COMPLETED");
        const tests = await testsOf(p1);
        expect(tests).toHaveLength(2);
        expect(tests.every((t) => t.validationStatus === "VALIDATED")).toBe(true);

        const u = await jobUsage(jobId);
        // analysis x1, planning x2 (the plan, then the coverage-gap call), the authoring agent's 2 steps per scenario, and a review of each test
        expect(Object.fromEntries(u.byPurpose.map((g: any) => [g.key, [g.calls, g.inputTokens, g.outputTokens]]))).toEqual({
            analysis: [1, OBJECT.input, OBJECT.output],
            planning: [2, 2 * OBJECT.input, 2 * OBJECT.output],
            authoring: [4, 4 * STEP.input, 4 * STEP.output],
            review: [2, 2 * REVIEW.input, 2 * REVIEW.output],
        });
        expect(modelCalls.text).toBe(2);
        expect(u.totals).toMatchObject({ calls: 9, inputTokens: 3 * OBJECT.input + 4 * STEP.input + 2 * REVIEW.input, outputTokens: 3 * OBJECT.output + 4 * STEP.output + 2 * REVIEW.output, estimated: false, cost: null });
        expect(u.byModel.map((g: any) => g.key)).toEqual(["scripted-usage"]);
        expect(u.summary).toBe("25K in, 6K out, 9 calls");
        expect(u.stop).toBeNull();
        expect(u.projectId).toBe(p1);
        // the job's own counters (used by the older technical details line) agree
        expect(job.counters.llmInputTokens).toBe(25_000);

        // no limits set: no warning, no stop
        expect((await events(jobId)).filter((e) => e.kind.startsWith("ai_budget"))).toEqual([]);

        // the same numbers by project, purpose and day (one row per job x purpose x model x day: four rows)
        const rows = platform.db.all("SELECT * FROM ai_usage WHERE job_id = ?", jobId);
        expect(rows).toHaveLength(4);
        const today = new Date().toISOString().slice(0, 10);
        expect(new Set(rows.map((r) => r.day))).toEqual(new Set([today]));
        const byProject = (await call("GET", "/api/usage?groupBy=project")).body;
        expect(byProject.totals.totalTokens).toBe(31_000);
        expect(byProject.month.usedTokens).toBe(31_000);
        const byPurpose = (await call("GET", "/api/usage?groupBy=purpose")).body.groups;
        expect(byPurpose.map((g: any) => [g.key, g.totalTokens])).toEqual([["planning", 12_000], ["authoring", 10_000], ["analysis", 6000], ["review", 3000]]);
        expect((await call("GET", `/api/usage?projectId=${p1}`)).body.totals.totalTokens).toBe(31_000);
    }, 240_000);

    it("with a price set, the same job shows its cost; without one it shows tokens only", async () => {
        expect((await jobUsage(j1)).totals.cost).toBeNull();
        await call("PUT", "/api/usage/prices", { model: "scripted-usage", inputPerMTok: 10, outputPerMTok: 50, currency: "USD" });
        const u = await jobUsage(j1);
        expect(u.currency).toBe("USD");
        expect(u.totals.cost).toBeCloseTo((25_000 / 1e6) * 10 + (6000 / 1e6) * 50, 10);
        await call("DELETE", "/api/usage/prices?model=scripted-usage");
    });

    it("a per-job limit stops the job cleanly mid-way: the plain message, numbers in the log, the test already made is kept and validated", async () => {
        const p2 = await newProject("Shop two");
        // analysis (6000) + planning (2 x 6000) = 18000; scenario one's two steps (2500 each) and its review (1500) take it to 24500; scenario two is refused before its first step
        expect((await setBudgets({ jobTokens: 24_000 })).status).toBe(200);
        const { job, jobId } = await analyse(p2);
        await setBudgets({ jobTokens: null }); // whatever the checks below say, later tests start without this limit

        expect(job.status, JSON.stringify({ error: job.error, events: (await events(jobId)).map((e) => `${e.level} ${e.kind}: ${e.message}`) })).toBe("PARTIALLY_COMPLETED");
        expect(job.error).toBe("The AI token limit for this job was reached");
        const tests = await testsOf(p2);
        expect(tests).toHaveLength(1);
        expect(tests[0]).toMatchObject({ title: "Browse the product list", validationStatus: "VALIDATED" });

        const log = await events(jobId);
        const warn = log.find((e) => e.kind === "ai_budget_warning");
        expect(warn?.message).toBe("AI use has reached 85% of the limit for this job (20,500 of 24,000 tokens).");
        const stops = log.filter((e) => e.kind === "ai_budget_stop");
        expect(stops).toHaveLength(1);
        expect(stops[0]!.message).toBe("The AI token limit for this job was reached. This job: 24,500 of 24,000 tokens used. AI work stops here; what was already created is kept.");
        expect(log.some((e) => e.kind === "scenario_skipped" && /was not authored: The AI token limit for this job was reached/.test(e.message))).toBe(true);

        const u = await jobUsage(jobId);
        expect(u.stop).toMatchObject({ cap: "job", message: "The AI token limit for this job was reached", usedTokens: 24_500, limitTokens: 24_000 });
        expect(u.totals.totalTokens).toBe(24_500); // the refused call added nothing
    }, 240_000);

    it("the project's monthly limit stops a new analysis before it spends anything, exactly at the limit", async () => {
        const used = (await call("GET", `/api/usage?projectId=${p1}`)).body.month.project.usedTokens as number;
        expect(used).toBe(31_000);
        expect((await call("PUT", `/api/projects/${p1}/usage-budget`, { monthlyTokens: used })).status).toBe(200);
        const calls0 = modelCalls.object;
        const { job, jobId } = await analyse(p1);
        await call("PUT", `/api/projects/${p1}/usage-budget`, { monthlyTokens: null });
        expect(job.status).toBe("FAILED");
        expect(job.error).toBe("The AI token limit for this project was reached");
        expect(modelCalls.object).toBe(calls0); // the model was never asked
        const stop = (await jobUsage(jobId)).stop;
        expect(stop).toMatchObject({ cap: "project", usedTokens: 31_000, limitTokens: 31_000, scope: "This project this month" });
        expect((await events(jobId)).find((e) => e.kind === "ai_budget_stop")?.message).toBe("The AI token limit for this project was reached. This project this month: 31,000 of 31,000 tokens used. AI work stops here; what was already created is kept.");
        // the tests from the first analysis are still there
        expect(await testsOf(p1)).toHaveLength(2);
    }, 240_000);

    it("the platform's monthly limit stops every project; validation-only runs and plain re-runs are unaffected, and repair is skipped with the same plain message", async () => {
        const total = (await month()).usedTokens;
        expect(total).toBeGreaterThanOrEqual(31_000 + 24_500);
        await setBudgets({ monthlyTokens: total });
        expect((await month()).level).toBe("reached");

        const p3 = await newProject("Shop three");
        const calls0 = modelCalls.object;
        const capped = await analyse(p3);
        expect(capped.job.status).toBe("FAILED");
        expect(capped.job.error).toBe("The AI token limit for this month was reached");
        expect((await jobUsage(capped.jobId)).stop).toMatchObject({ cap: "month", usedTokens: total, limitTokens: total });
        expect(await testsOf(p3)).toEqual([]);

        // re-validating existing tests needs no model: it runs, passes and is not counted as AI use
        const [first] = await testsOf(p1);
        const run = await call("POST", `/api/tests/${first!.id}/validate`);
        expect(run.status).toBe(202);
        const done = await waitJob(run.body.jobId);
        expect(done.status, done.error).toBe("COMPLETED");
        expect((await testsOf(p1)).find((t) => t.id === first!.id)!.validationStatus).toBe("VALIDATED");
        const vu = await jobUsage(run.body.jobId);
        expect(vu.totals.calls).toBe(0);
        expect(vu.stop).toBeNull();

        // a failing API test would normally be sent to the model for repair: under the cap that is skipped, the failure stays as it is
        p4 = await newProject("Shop four");
        const imported = await call("POST", `/api/projects/${p4}/specs`, {
            baseUrl: API,
            specs: [{ title: "Ping answers 404 (wrong on purpose)", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/ping" }, { action: "assertResponse", check: "status", expected: 404 }] }],
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(202);
        await waitJob(imported.body.jobId);
        const [bad] = await testsOf(p4);
        expect(bad!.validationStatus).toBe("FAILED_VALIDATION");
        expect(bad!.validationReason).toContain("automatic repair skipped: The AI token limit for this month was reached");
        expect(modelCalls.object).toBe(calls0); // nothing above reached the model

        // the month total did not move
        expect((await month()).usedTokens).toBe(total);
    }, 300_000);

    it("a schedule that would run a new analysis is skipped with a plain reason while the month is capped; a re-run schedule still starts", async () => {
        const total = (await month()).usedTokens;
        expect((await month()).level).toBe("reached");
        const gen = await call("POST", `/api/projects/${p1}/schedules`, { kind: "generate", cadence: { type: "interval", every: 5, unit: "minutes" } });
        const val = await call("POST", `/api/projects/${p4}/schedules`, { kind: "validate", cadence: { type: "interval", every: 5, unit: "minutes" }, retryFailures: 0 });
        expect(gen.status, JSON.stringify(gen.body)).toBe(201);
        expect(val.status, JSON.stringify(val.body)).toBe(201);
        const jobsBefore = ((await call("GET", `/api/projects/${p1}/jobs`)).body as unknown[]).length;
        const jobsBeforeOther = ((await call("GET", `/api/projects/${p4}/jobs`)).body as unknown[]).length;
        const calls0 = modelCalls.object;

        clockNow = Math.max(new Date(gen.body.nextRunAt).getTime(), new Date(val.body.nextRunAt).getTime()) + 1_000;
        const ticked = await svc.scheduler.tick();
        const byId = Object.fromEntries(ticked.map((t) => [t.scheduleId, t]));
        expect(byId[gen.body.id]).toMatchObject({ result: "skipped" });
        expect(byId[gen.body.id]!.note).toBe("Skipped: the AI token limit for this month was reached, so a new analysis could not run. Raise the limit in Settings or wait until next month. Runs that only re-run existing tests are not affected.");
        expect(byId[val.body.id]).toMatchObject({ result: "started" });

        // exactly one new job (the re-run of the other project), none for the skipped analysis
        await waitJob(byId[val.body.id]!.jobId!);
        expect(((await call("GET", `/api/projects/${p1}/jobs`)).body as unknown[]).length).toBe(jobsBefore);
        expect(((await call("GET", `/api/projects/${p4}/jobs`)).body as unknown[]).length).toBe(jobsBeforeOther + 1);
        const list = [...(await call("GET", `/api/projects/${p1}/schedules`)).body.schedules, ...(await call("GET", `/api/projects/${p4}/schedules`)).body.schedules] as any[];
        expect(list.find((s) => s.id === gen.body.id)).toMatchObject({ lastOutcome: "skipped", lastJobId: null });
        expect(list.find((s) => s.id === gen.body.id).lastNote).toMatch(/^Skipped: the AI token limit for this month was reached/);
        expect(list.find((s) => s.id === val.body.id)).toMatchObject({ lastOutcome: "started" });
        // the skipped slot moved on: it is not retried at the next tick
        expect((await svc.scheduler.tick()).filter((t) => t.scheduleId === gen.body.id)).toEqual([]);
        expect(modelCalls.object).toBe(calls0);
        expect((await month()).usedTokens).toBe(total);
        await setBudgets({ monthlyTokens: null });
        expect((await month()).level).toBe("none");
    }, 240_000);

    it("never stores a prompt, an answer or the model key: only counts and labels", async () => {
        // the double really saw prompts and answered with the sentinel (so the check below proves something)
        expect(prompts.some((p) => p.includes(ANSWER_SENTINEL))).toBe(true);
        const tables = ["ai_usage", "ai_prices", "ai_settings", "ai_project_budgets", "ai_budget_stops"];
        const stored = tables.map((t) => JSON.stringify(platform.db.all(`SELECT * FROM ${t}`))).join("\n");
        expect(stored.length).toBeGreaterThan(100);
        for (const secret of ["SENTINEL", KEY_SENTINEL, "Browse the product list", "Products", "scenarios"]) expect(stored, secret).not.toContain(secret);
        // nor do the usage endpoints say anything about the key
        const bodies = [
            (await call("GET", "/api/usage?groupBy=model")).body,
            (await call("GET", "/api/usage/budgets")).body,
            (await call("GET", "/api/usage/prices")).body,
            await jobUsage(j1),
        ].map((b) => JSON.stringify(b));
        for (const b of bodies) {
            expect(b).not.toContain(KEY_SENTINEL);
            expect(b).not.toContain("SENTINEL");
        }
        // job events carry the counts and the cap, never the key
        expect((await events(j1)).map((e) => e.message).join("\n")).not.toContain(KEY_SENTINEL);
    });
});

// ── the endpoints sit behind the API key ─────────────────────────────────────
describe("usage endpoints need the API key", () => {
    it("every usage route answers 401 without the key and works with it", async () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-usage-key-"));
        const p = bootstrap(loadConfig({ DATA_DIR: d, API_KEY: "usage-test-key", SECRET_KEY: "test-secret-key-0123456789" }));
        const s = await buildServer(p);
        try {
            const project = (await s.inject({ method: "POST", url: "/api/projects", headers: { "x-api-key": "usage-test-key" }, payload: { name: "Keyed" } })).json().id as string;
            const routes: Array<[string, string, unknown?]> = [
                ["GET", "/api/usage"],
                ["GET", "/api/usage/prices"],
                ["PUT", "/api/usage/prices", { currency: "USD" }],
                ["DELETE", "/api/usage/prices?model=x"],
                ["GET", "/api/usage/budgets"],
                ["PUT", "/api/usage/budgets", { monthlyTokens: 5 }],
                ["GET", "/api/jobs/abc/usage"],
                ["GET", `/api/projects/${project}/usage-budget`],
                ["PUT", `/api/projects/${project}/usage-budget`, { monthlyTokens: 5 }],
            ];
            for (const [method, url, payload] of routes) {
                const denied = await s.inject({ method: method as "GET", url, payload: payload as never });
                expect(denied.statusCode, `${method} ${url}`).toBe(401);
                const wrong = await s.inject({ method: method as "GET", url, payload: payload as never, headers: { "x-api-key": "not-it" } });
                expect(wrong.statusCode, `${method} ${url} wrong key`).toBe(401);
            }
            const ok = await s.inject({ method: "PUT", url: "/api/usage/budgets", payload: { monthlyTokens: 5 }, headers: { "x-api-key": "usage-test-key" } });
            expect(ok.statusCode).toBe(200);
            expect(ok.json().platform.monthlyTokens).toBe(5);
            expect((await s.inject({ method: "GET", url: "/api/usage", headers: { "x-api-key": "usage-test-key" } })).statusCode).toBe(200);
        } finally {
            await s.close();
            p.db.close();
            fs.rmSync(d, { recursive: true, force: true });
        }
    });
});
