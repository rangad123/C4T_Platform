/**
 * Agent Workspace W2a: the Performance Testing Agent's outcome (SPEC §3: per-page timings, the slowest pages, and the load result when
 * a load check was allowed; nothing else), computed on read from what its runs saved: the page speed and load tests (meta.performance,
 * meta.load), their results, and the values they measured (perf_metrics).
 *
 *   GET /api/projects/:id/workspace/performance/outcome[?run=]   and the card's headline in GET /api/projects/:id/workspace
 *
 * Browser-free: node scripts/with-lock.mjs tsc -- npx vitest run tests/agent-outcome-performance.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PERFORMANCE_FAILURE_PREFIX } from "../src/engine/performance/checks.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { recordMetrics, type Sample } from "../src/platform/perf-store.js";
import { DEFAULT_JOB_OPTIONS, type JobOptions, type JobStatus } from "../src/platform/repo.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "agent-outcome-perf-key-3b9a";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let pid = "";
let appId = "";
let n = 0;
const ids: Record<string, string> = {};
const tests: Record<string, string> = {};

const get = async (url: string) => {
    const r = await app.inject({ method: "GET", url, headers: { "x-api-key": KEY } });
    return { status: r.statusCode, body: JSON.parse(r.body) as any };
};
const wait = () => new Promise((r) => setTimeout(r, 5));

async function job(agentId: string | undefined, status: JobStatus, extra: Partial<JobOptions> = {}, error?: string) {
    await wait();
    const j = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, ...(agentId ? { agentId: agentId as never } : {}), ...extra });
    platform.repo.setJobStatus(j.id, status, error);
    return j.id;
}

const ms = (metric: string, value: number, budget?: number): Sample => ({ metric, value, unit: "ms", ...(budget === undefined ? {} : { budget }) });

/** A check the engine saved and ran in this run, with what it measured (repo-sink.ts recordExecution → perf-store.ts recordMetrics). */
async function check(jobId: string, name: string, o: { page?: string; endpoint?: string; meta: Record<string, unknown>; status: "VALIDATED" | "NEEDS_REVIEW" | "FAILED_VALIDATION"; reason?: string; samples?: Sample[] }) {
    const kind = o.page ? "web" : "api";
    const steps = o.page
        ? [{ action: "navigate", url: o.page }, { action: "assert", check: "pageSpeed" }]
        : [{ action: "request", method: "GET", path: o.endpoint!.split(" ")[1] }, { action: "assertResponse", check: "status", expected: 200 }];
    const spec = TestSpecSchema.parse({ testId: `${kind === "web" ? "WEB" : "API"}-${String(++n).padStart(3, "0")}`, title: o.page ? `Page loads quickly (${o.page})` : `${o.endpoint}: handles 10 users at once`, kind, category: "Performance", type: "performance", steps });
    const suite = platform.repo.getOrCreateSuite(pid, "Performance", "performance");
    const id = platform.repo.insertTest({ projectId: pid, suiteId: suite, jobId, spec, framework: kind === "web" ? "playwright" : "playwright-api", validationStatus: "PENDING", meta: { ...o.meta, ...(o.endpoint ? { endpoint: o.endpoint } : {}) } });
    platform.repo.updateTest(id, { validationStatus: o.status, reason: o.reason ?? null });
    const exec = platform.repo.addExecution({ testId: id, scriptId: null, jobId, attempt: 1, status: o.status === "VALIDATED" ? "passed" : "failed", durationMs: 5, startedAt: new Date().toISOString(), steps: [] });
    if (o.samples) await recordMetrics(platform.sql, { projectId: pid, testId: id, executionId: exec, samples: o.samples });
    tests[name] = id;
    return id;
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-outcome-perf-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "agent-outcome-perf-secret-0123456789" } as never));
    app = await buildServer(platform);
    await app.ready();
    pid = platform.repo.createProject({ name: "Speed Store", platforms: ["web"], testingModes: ["agent"] }).id as string;
    await testingAgentsOf(platform).set(pid, ["performance", "accessibility", "api"], "test");
    appId = platform.repo.createApplication(pid, "http://127.0.0.1:6534", { ...DEFAULT_JOB_OPTIONS });

    // An older exploration that named no agent, with page speed and accessibility checks on: its timing is the Performance agent's,
    // its accessibility check is not.
    ids.old = await job(undefined, "COMPLETED", { performanceChecks: true, accessibility: true });
    await check(ids.old, "about", { page: "/about", meta: { performance: true }, status: "VALIDATED", samples: [ms("lcp", 800, 2500), ms("load", 900)] });
    await check(ids.old, "a11y", { page: "/help", meta: { accessibility: true }, status: "VALIDATED", samples: [ms("lcp", 9000)] });

    // Run 1 (done): the home page within budget, the cart over it; an API call timed too (not in this agent's SPEC row).
    ids.first = await job("performance", "COMPLETED");
    await check(ids.first, "home", { page: "/", meta: { performance: true }, status: "VALIDATED", samples: [ms("ttfb", 200, 800), ms("lcp", 1200, 2500), ms("load", 1500)] });
    await check(ids.first, "cart", { page: "/cart", meta: { performance: true }, status: "NEEDS_REVIEW", reason: `${PERFORMANCE_FAILURE_PREFIX} Main content appears after 3.4 s (aim for under 2.5 s) [medium]\nHow to fix: make it smaller`, samples: [ms("lcp", 3400, 2500), ms("load", 3600)] });
    await check(ids.first, "latency", { endpoint: "GET /api/items", meta: { performance: true }, status: "VALIDATED", samples: [ms("p95", 120, 800)] });

    // Another agent's run in the same project: never here.
    ids.api = await job("api", "COMPLETED");
    await check(ids.api, "users", { endpoint: "GET /users", meta: {}, status: "VALIDATED", samples: [ms("p95", 50)] });

    // Run 2 (stopped): the home page again, faster, and a load check that was allowed for this run.
    ids.second = await job("performance", "FAILED", { loadChecks: true }, "Cancelled");
    await check(ids.second, "home2", { page: "/", meta: { performance: true }, status: "VALIDATED", samples: [ms("lcp", 1000, 2500), ms("load", 1100)] });
    await check(ids.second, "load", {
        endpoint: "GET /products",
        meta: { performance: true, load: true },
        status: "VALIDATED",
        samples: [{ metric: "load_users", value: 10, unit: "users" }, { metric: "load_requests", value: 200, unit: "count" }, ms("load_p95", 300, 1000), { metric: "load_error_rate", value: 0, unit: "%", budget: 1 }],
    });
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const metric = (page: any, m: string) => (page.metrics as any[]).find((x) => x.metric === m)?.value;

describe("the Performance Testing Agent's outcome", () => {
    it("times each page, the newest run's timing per page, and says which are over budget", async () => {
        const r = await get(`/api/projects/${pid}/workspace/performance/outcome`);
        expect(r.status).toBe(200);
        expect(r.body.runs).toBe(3);
        const pages = Object.fromEntries((r.body.pages as any[]).map((p) => [p.path, p]));
        expect(Object.keys(pages).sort()).toEqual(["/", "/about", "/cart"]);
        expect(pages["/"]).toMatchObject({ testId: tests.home2, verdict: "within", jobId: ids.second });
        expect(metric(pages["/"], "lcp")).toBe(1000);
        expect(pages["/cart"]).toMatchObject({ verdict: "over", jobId: ids.first });
        expect(pages["/cart"].note).toBe("Main content appears after 3.4 s (aim for under 2.5 s)");
        expect(pages["/cart"].note).not.toContain("How to fix");
        expect(metric(pages["/about"], "lcp")).toBe(800);
    });

    it("lists the slowest pages by when their main content appears", async () => {
        const r = await get(`/api/projects/${pid}/workspace/performance/outcome`);
        expect((r.body.slowest as any[]).map((s) => [s.path, s.value])).toEqual([["/cart", 3400], ["/", 1000], ["/about", 800]]);
    });

    it("shows the load result of a run that allowed it", async () => {
        const r = await get(`/api/projects/${pid}/workspace/performance/outcome`);
        expect(r.body.load).toHaveLength(1);
        expect(r.body.load[0]).toMatchObject({ testId: tests.load, endpoint: "GET /products", verdict: "within", jobId: ids.second });
        expect(metric(r.body.load[0], "load_p95")).toBe(300);
    });

    it("holds only this agent's items: no API call timings, no other agent's checks or runs", async () => {
        const r = await get(`/api/projects/${pid}/workspace/performance/outcome`);
        expect(Object.keys(r.body).sort()).toEqual(["load", "pages", "runs", "slowest"]);
        const all = JSON.stringify(r.body);
        for (const t of ["a11y", "latency", "users"]) expect(all).not.toContain(tests[t]);
        expect((r.body.pages as any[]).every((p) => metric(p, "lcp") !== 9000)).toBe(true);
    });

    it("answers one run's part with ?run=, a stopped run's items included; another agent's run is a 404", async () => {
        const first = await get(`/api/projects/${pid}/workspace/performance/outcome?run=${ids.first}`);
        expect(first.status).toBe(200);
        expect(first.body.runs).toBe(1);
        expect((first.body.pages as any[]).map((p) => p.path).sort()).toEqual(["/", "/cart"]);
        expect(metric((first.body.pages as any[]).find((p) => p.path === "/"), "lcp")).toBe(1200);
        expect(first.body.load).toEqual([]);
        const stopped = await get(`/api/projects/${pid}/workspace/performance/outcome?run=${ids.second}`);
        expect((stopped.body.pages as any[]).map((p) => p.path)).toEqual(["/"]);
        expect(stopped.body.load).toHaveLength(1);
        expect((await get(`/api/projects/${pid}/workspace/performance/outcome?run=${ids.api}`)).status).toBe(404);
    });

    it("gives the card one line, and none before a run", async () => {
        const ws = await get(`/api/projects/${pid}/workspace`);
        expect(ws.body.agents.find((a: any) => a.id === "performance").headline).toBe("3 pages timed, 1 over budget");
        const bare = platform.repo.createProject({ name: "No runs", platforms: ["web"], testingModes: ["agent"] }).id as string;
        await testingAgentsOf(platform).set(bare, ["performance"], "test");
        expect((await get(`/api/projects/${bare}/workspace`)).body.agents[0]).toMatchObject({ id: "performance", status: "not-run", headline: null });
        expect((await get(`/api/projects/${bare}/workspace/performance/outcome`)).body).toEqual({ runs: 0, pages: [], slowest: [], load: [] });
    });
});
