/**
 * Agent Workspace W2a: the Performance Testing Agent's page in a real browser (SPEC §3). Outcome: each page's timings with its budget,
 * the slowest pages and the load result of a run that allowed one, nothing of another agent's (no API call timings either); Runs: its
 * runs only, each opening what that run timed; Setup: its inputs only. Axe with the colour scheme light and dark, no sideways scroll at
 * 375 px. Runs are seeded as the worker leaves them (checks, results, perf_metrics); no AI and no exploring browser. Port 7612.
 * Screenshots: c4t-scratch/agent-ws/performance/. Requires web/dist:
 *   node scripts/with-lock.mjs build -- npm run build:web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/agent-performance-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { PERFORMANCE_FAILURE_PREFIX } from "../src/engine/performance/checks.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { recordMetrics, type Sample } from "../src/platform/perf-store.js";
import { DEFAULT_JOB_OPTIONS, type JobOptions, type JobStatus } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { routes } from "../web/src/lib/router.js";

const PORT = 7612;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.resolve(REPO_ROOT, "../../c4t-scratch/agent-ws/performance");

let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let pid = "";
let appId = "";
let n = 0;
const jobs: Record<string, string> = {};
const consoleErrors: string[] = [];

async function job(agentId: string, status: JobStatus, extra: Partial<JobOptions> = {}, error?: string) {
    await new Promise((r) => setTimeout(r, 5));
    const j = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, agentId: agentId as never, ...extra });
    platform.repo.setJobStatus(j.id, status, error);
    return j.id;
}
const ms = (metric: string, value: number, budget?: number): Sample => ({ metric, value, unit: "ms", ...(budget === undefined ? {} : { budget }) });
async function check(jobId: string, o: { page?: string; endpoint?: string; meta: Record<string, unknown>; status: "VALIDATED" | "NEEDS_REVIEW"; reason?: string; samples: Sample[] }) {
    const kind = o.page ? "web" : "api";
    const steps = o.page ? [{ action: "navigate", url: o.page }, { action: "assert", check: "pageSpeed" }] : [{ action: "request", method: "GET", path: o.endpoint!.split(" ")[1] }];
    const spec = TestSpecSchema.parse({ testId: `T-${String(++n).padStart(3, "0")}`, title: o.page ? `Page loads quickly (${o.page})` : `${o.endpoint}: timed`, kind, category: "Performance", type: "performance", steps });
    const id = platform.repo.insertTest({ projectId: pid, suiteId: platform.repo.getOrCreateSuite(pid, "Performance", "performance"), jobId, spec, framework: kind === "web" ? "playwright" : "playwright-api", validationStatus: "PENDING", meta: { ...o.meta, ...(o.endpoint ? { endpoint: o.endpoint } : {}) } });
    platform.repo.updateTest(id, { validationStatus: o.status, reason: o.reason ?? null });
    const exec = platform.repo.addExecution({ testId: id, scriptId: null, jobId, attempt: 1, status: o.status === "VALIDATED" ? "passed" : "failed", durationMs: 5, startedAt: new Date().toISOString(), steps: [] });
    await recordMetrics(platform.sql, { projectId: pid, testId: id, executionId: exec, samples: o.samples });
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-perf-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    pid = platform.repo.createProject({ name: "Speed Shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
    appId = platform.repo.createApplication(pid, "http://127.0.0.1:7629", { ...DEFAULT_JOB_OPTIONS });
    expect((await fetch(`${BASE}/api/projects/${pid}/testing-agents`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agents: ["performance", "accessibility"] }) })).status).toBe(200);

    jobs.first = await job("performance", "COMPLETED");
    await check(jobs.first, { page: "/", meta: { performance: true }, status: "VALIDATED", samples: [ms("ttfb", 180, 800), ms("fcp", 700, 1800), ms("lcp", 1200, 2500), ms("load", 1500)] });
    await check(jobs.first, { page: "/products/a-very-long-product-page-address-for-narrow-screens", meta: { performance: true }, status: "VALIDATED", samples: [ms("ttfb", 300, 800), ms("fcp", 900, 1800), ms("lcp", 1900, 2500), ms("load", 2100)] });
    await check(jobs.first, { page: "/cart", meta: { performance: true, signedIn: true }, status: "NEEDS_REVIEW", reason: `${PERFORMANCE_FAILURE_PREFIX} Main content appears after 3.4 s (aim for under 2.5 s) [medium]\nHow to fix: make it smaller`, samples: [ms("ttfb", 400, 800), ms("fcp", 1600, 1800), ms("lcp", 3400, 2500), ms("load", 3600)] });
    await check(jobs.first, { endpoint: "GET /api/items", meta: { performance: true }, status: "VALIDATED", samples: [ms("p95", 120, 800)] });
    jobs.a11y = await job("accessibility", "COMPLETED");
    await check(jobs.a11y, { page: "/about", meta: { accessibility: true }, status: "VALIDATED", samples: [ms("lcp", 9000)] });
    jobs.second = await job("performance", "FAILED", { loadChecks: true }, "Cancelled");
    await check(jobs.second, {
        endpoint: "GET /api/products",
        meta: { performance: true, load: true },
        status: "VALIDATED",
        samples: [{ metric: "load_users", value: 10, unit: "users" }, { metric: "load_requests", value: 200, unit: "count" }, ms("load_p95", 300, 1000), { metric: "load_error_rate", value: 0, unit: "%", budget: 1 }],
    });

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.locator("h1").first()).toBeVisible();
}
async function shot(name: string) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true, animations: "disabled" });
}
async function axe(what: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${what} (${scheme}): ${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}
async function narrow(name: string) {
    await page.setViewportSize({ width: 375, height: 800 });
    try {
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await shot(name);
    } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
    }
}
const rows = async () => (await pwExpect(page.getByTestId("performance-pages")).toBeVisible(), Promise.all((await page.getByTestId("performance-pages").locator("tbody tr").all()).map(async (r) => (await r.locator("td").allTextContents()).map((t) => t.trim()))));

describe("the Performance Testing Agent's page", () => {
    it("Outcome: each page's timings and budget, the slowest pages and the load result, and nothing of another agent's", async () => {
        await visit(routes.projectAgent(pid, "performance"));
        await pwExpect(page.getByTestId("performance-outcome")).toBeVisible();
        expect(await page.getByTestId("performance-pages").locator("thead th").allTextContents()).toEqual(["Page", "Server starts responding", "First content appears", "Main content appears", "Page finished loading", "Budget"]);
        expect(await rows()).toEqual([
            ["/", "180 ms", "700 ms", "1.2 s", "1.5 s", "Within budget"],
            ["/cartSigned in", "400 ms", "1.6 s", "3.4 s", "3.6 s", "Over budgetMain content appears after 3.4 s (aim for under 2.5 s)"],
            ["/products/a-very-long-product-page-address-for-narrow-screens", "300 ms", "900 ms", "1.9 s", "2.1 s", "Within budget"],
        ]);
        expect((await page.getByTestId("performance-slowest").locator("li").allTextContents()).map((t) => t.split(/\d/)[0])).toEqual(["/cart", "/products/a-very-long-product-page-address-for-narrow-screens", "/"]);
        await pwExpect(page.getByTestId("performance-slowest").locator("li").first()).toContainText("over the 2.5 s budget");
        const load = page.getByTestId("performance-load").locator("li");
        await pwExpect(load).toHaveCount(1);
        await pwExpect(load.first()).toContainText("GET /api/products");
        await pwExpect(load.first()).toContainText("Coped");
        await pwExpect(load.first()).toContainText("Users at once10");
        await pwExpect(load.first()).toContainText("95% of responses within300 ms");
        const text = (await page.locator(".content").textContent()) ?? "";
        for (const other of ["/about", "/api/items", "9.0 s", "Test cases", "Passing", "Contract"]) expect(text).not.toContain(other);
        await axe("performance outcome");
        await shot("outcome.png");
        await narrow("outcome-375.png");
    });

    it("Runs: its runs only, each opening what that run timed, a stopped run's part included", async () => {
        await visit(routes.projectAgent(pid, "performance", "runs"));
        const list = page.getByTestId("agent-runs").locator("li");
        await pwExpect(list).toHaveCount(2);
        await list.first().getByRole("link", { name: "Run 2" }).click();
        await pwExpect(page.getByTestId("agent-run")).toContainText("Run 2");
        await pwExpect(page.getByTestId("performance-load").locator("li")).toHaveCount(1);
        await pwExpect(page.getByTestId("performance-pages")).toHaveCount(0);
        await pwExpect(page.getByText("No page was timed in this run.")).toBeVisible();
        await axe("performance run");
        await shot("run.png");
        await visit(routes.projectAgentRun(pid, "performance", jobs.first));
        expect((await rows()).map((r) => r[0])).toEqual(["/", "/cartSigned in", "/products/a-very-long-product-page-address-for-narrow-screens"]);
        await pwExpect(page.getByText("None in this run.", { exact: false })).toBeVisible();
        await narrow("run-375.png");
    });

    it("Setup: its own inputs: the address, the sign-in, and when a load check runs", async () => {
        await visit(routes.projectAgent(pid, "performance", "setup"));
        const setup = page.getByTestId("agent-setup");
        await pwExpect(setup).toContainText("Application address");
        await pwExpect(setup).toContainText("Sign in");
        await pwExpect(setup).toContainText("never on a production environment");
        await pwExpect(setup.locator(".callout")).toHaveCount(0);
        await pwExpect(setup).not.toContainText("OpenAPI");
        await axe("performance setup");
        await shot("setup.png");
        await narrow("setup-375.png");
        expect(consoleErrors).toEqual([]);
    });
});
