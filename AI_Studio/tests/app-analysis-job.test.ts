/**
 * The analysis an exploration job runs after saving its model: a cancel while it reads ends the job as cancelled, never as a finished
 * exploration. The exploration engine is a stand-in that saves a model; the AI double never answers (no browser, no provider).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AppModel as UnderstandingModel } from "../src/engine/understanding/app-model.js";

const MODEL = {
    url: "https://shop.test",
    origin: "https://shop.test",
    siteType: "shop",
    purpose: "A shop",
    features: [],
    pages: [{ url: "https://shop.test/cart", path: "/cart", title: "Cart", type: "cart", purpose: "A cart must hold at most 50 lines", depth: 0, status: 200, headings: [], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [], discovery: 2 }],
    navigation: [],
    apis: [],
    authentication: { required: false, mechanisms: [], loggedIn: false },
    journeys: [],
    externalDependencies: [],
    documentedTestCases: [],
    stats: { pagesVisited: 1, pagesSkipped: 0, apisFound: 0, durationMs: 1 },
} as unknown as UnderstandingModel;

/** Set by a test: the exploration stops at a plan, as a plan-only job (or the benchmark's resumable run) does. */
const stopsAtPlan = vi.hoisted(() => ({ on: false }));
vi.mock("../src/engine/orchestrator.js", async (orig) => ({
    ...(await orig<object>()),
    runGeneration: async (_ctx: unknown, _req: unknown, sink: { saveModel(m: UnderstandingModel): unknown }) => {
        await sink.saveModel(MODEL);
        if (stopsAtPlan.on) return { model: MODEL, plan: { version: 1, scenarios: [], accessReach: [], apiAccess: [], model: MODEL }, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
        return { model: MODEL, testsGenerated: 1, testsValidated: 1, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
    },
}));

const { loadConfig } = await import("../src/config.js");
const { bootstrap } = await import("../src/platform/bootstrap.js");
const { runJob } = await import("../src/platform/job-runner.js");
const { DEFAULT_JOB_OPTIONS } = await import("../src/platform/repo.js");
const { AppIntelStore } = await import("../src/platform/app-intel-store.js");
import type { LlmClient } from "../src/engine/llm/provider.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-analysis-job-"));
for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
const platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "app-analysis-job-secret-key-0123456789ab" }));
afterAll(() => {
    platform.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the analysis after an exploration", () => {
    it("is stopped by a cancel, and the job ends cancelled with nothing of the analysis kept", async () => {
        const owner = platform.db.get<{ id: string }>("SELECT id FROM users LIMIT 1")!.id;
        const at = new Date().toISOString();
        platform.db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", "pj", owner, "Job", at, at);
        const app = platform.repo.createApplication("pj", "https://shop.test", {});
        let calls = 0;
        const never = { modelName: "never", usage: {}, object: () => (calls++, new Promise(() => undefined)), text: () => new Promise(() => undefined) } as unknown as LlmClient;
        await platform.repo.createJob("pj", app, { ...DEFAULT_JOB_OPTIONS, mode: "generate", startedBy: { kind: "key" } } as never);
        const job = platform.repo.claimNextJob(60_000, "w-analysis")!;
        const run = runJob({ repo: platform.repo, store: platform.store, config: platform.config, llm: platform.llm, makeLlm: () => never }, job, "w-analysis");
        for (let i = 0; i < 400 && calls === 0; i++) await new Promise((r) => setTimeout(r, 25));
        expect(calls).toBe(1); // the page text is being read
        platform.repo.requestCancel(job.id);
        await run;
        const done = platform.repo.getJob(job.id)!;
        expect(done.status).toBe("FAILED");
        expect(done.error).toBe("Cancelled");
        expect(await new AppIntelStore(platform.sql).latest("pj")).toBeUndefined();
    }, 60_000);
});

describe("the time limit during the analysis", () => {
    it("stops only the analysis: an exploration that finished in time ends completed, with a warning", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-analysis-job-time-"));
        const p = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "app-analysis-job-secret-key-0123456789ab", JOB_MAX_MINUTES: "0.02" } as never));
        try {
            const owner = p.db.get<{ id: string }>("SELECT id FROM users LIMIT 1")!.id;
            const at = new Date().toISOString();
            p.db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", "pt", owner, "Time", at, at);
            const app = p.repo.createApplication("pt", "https://shop.test", {});
            const never = { modelName: "never", usage: {}, object: () => new Promise(() => undefined), text: () => new Promise(() => undefined) } as unknown as LlmClient;
            await p.repo.createJob("pt", app, { ...DEFAULT_JOB_OPTIONS, mode: "generate", startedBy: { kind: "key" } } as never);
            const job = p.repo.claimNextJob(60_000, "w-time")!;
            await runJob({ repo: p.repo, store: p.store, config: p.config, llm: p.llm, makeLlm: () => never }, job, "w-time");
            const done = p.repo.getJob(job.id)!;
            expect(done.status).toBe("COMPLETED");
            const { ANALYSIS_OVER_TIME } = await import("../src/platform/app-analysis.js");
            expect(p.db.all<{ message: string }>("SELECT message FROM agent_events WHERE job_id = ? AND kind = 'analysis_over_time'", job.id).map((e) => e.message)).toEqual([ANALYSIS_OVER_TIME]);
            expect(await new AppIntelStore(p.sql).latest("pt")).toBeUndefined();
        } finally {
            p.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});

describe("a cancel during the analysis of an exploration that stopped at a plan", () => {
    it("ends the job cancelled but keeps the plan, so tests can still be created from it", async () => {
        stopsAtPlan.on = true;
        try {
            const owner = platform.db.get<{ id: string }>("SELECT id FROM users LIMIT 1")!.id;
            const at = new Date().toISOString();
            platform.db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", "pp", owner, "Plan", at, at);
            const app = platform.repo.createApplication("pp", "https://shop.test", {});
            let calls = 0;
            const never = { modelName: "never", usage: {}, object: () => (calls++, new Promise(() => undefined)), text: () => new Promise(() => undefined) } as unknown as LlmClient;
            await platform.repo.createJob("pp", app, { ...DEFAULT_JOB_OPTIONS, mode: "generate", planOnly: true, startedBy: { kind: "key" } } as never);
            const job = platform.repo.claimNextJob(60_000, "w-plan")!;
            const run = runJob({ repo: platform.repo, store: platform.store, config: platform.config, llm: platform.llm, makeLlm: () => never }, job, "w-plan");
            for (let i = 0; i < 400 && calls === 0; i++) await new Promise((r) => setTimeout(r, 25));
            expect(calls).toBe(1); // the analysis is reading
            platform.repo.requestCancel(job.id);
            await run;
            expect(platform.repo.getJob(job.id)).toMatchObject({ status: "FAILED", error: "Cancelled" });
            const { requireStoredPlan } = await import("../src/platform/plan-store.js");
            await expect(requireStoredPlan(platform.repo, platform.store, job.id)).resolves.toMatchObject({ version: 1 });
        } finally {
            stopsAtPlan.on = false;
        }
    }, 60_000);
});
