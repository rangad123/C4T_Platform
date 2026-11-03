/**
 * The load check in the real UI: the opt-in toggle (off by default, with the confirmation line, sent only when ticked, stored
 * with the job) and the result view on a test's page. The values shown are produced by the real helper against a real local
 * HTTP endpoint, then stored the way a run stores them.
 * Needs web/dist; run under the shared lock after building the UI:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/load-ui.test.ts
 * Fixture port 5554; platform 5553.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { loadFinding, loadLoadRuntime } from "../src/engine/performance/load.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { recordMetrics } from "../src/platform/perf-store.js";
import { buildServer } from "../src/platform/server.js";

const PLATFORM_PORT = 5553;
const FIXTURE_PORT = 5554;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dir: string;
const fixture = http.createServer((_req, res) => setTimeout(() => (res.writeHead(200, { "content-type": "application/json" }), res.end("{}")), 120));

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    await new Promise<void>((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-loadui-"));
    // No worker: jobs are accepted and stored but never run, so this file sends no traffic of its own.
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => (fixture.closeAllConnections?.(), fixture.close(r)));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the toggle on the new-project form", () => {
    it("is off by default, says what it sends, is sent only when ticked, and is stored with the job", async () => {
        const dead = "http://127.0.0.1:5555/";
        let made = 0;
        const open = async () => {
            await page.goto(`${BASE}/#/new?url=${encodeURIComponent(dead)}`);
            await pwExpect(page.getByLabel("Application URL")).toHaveValue(dead);
            // Round 37: a new project's name is always typed (a taken name is refused, so each form gets its own).
            await page.getByLabel("Project name").fill(`Load project ${++made}`);
            await page.locator("summary", { hasText: "Advanced options" }).click();
        };
        await open();
        const toggle = page.getByRole("checkbox", { name: /Load check \(test environments only\)/ });
        await pwExpect(toggle).not.toBeChecked();
        await pwExpect(toggle).toBeEnabled();
        await pwExpect(page.getByText("Sends up to 300 requests to each of up to 3 pages of your application. Use a test environment.", { exact: false })).toBeVisible();
        await pwExpect(page.getByText(/We.ll test:/)).not.toContainText("load");

        const sent: Array<Record<string, unknown>> = [];
        await page.route("**/api/projects/*/test-generation", (route) => {
            sent.push(route.request().postDataJSON());
            return route.continue();
        });
        await page.getByRole("button", { name: "Start exploring" }).click();
        await page.waitForURL((u) => u.hash.startsWith("#/projects/"));
        await pwExpect.poll(() => sent.length).toBe(1);
        expect(sent[0]).not.toHaveProperty("loadChecks"); // not even sent when off

        await open();
        await toggle.check();
        await pwExpect(page.getByText(/We.ll test:/)).toContainText("load");
        await page.getByRole("button", { name: "Start exploring" }).click();
        await pwExpect.poll(() => sent.length).toBe(2);
        expect(sent[1]).toMatchObject({ loadChecks: true });

        const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ id: string }>;
        const options = projects.flatMap((p) => platform.repo.listJobs(p.id).map((j) => j.options as unknown as Record<string, unknown>));
        expect(options.some((o) => o.loadChecks === true)).toBe(true);
        expect(options.some((o) => o.loadChecks === false)).toBe(true); // the default stored with the first job
    }, 120_000);
});

describe("the result on the test page", () => {
    it("shows how the endpoint coped with several users, in words, with budgets and without empty counts", async () => {
        // A real run of the helper against a real endpoint (answers take ~120 ms, the budget is 50 ms): over budget at both levels.
        const rt = loadLoadRuntime();
        const attached: Array<{ name: string; body: string }> = [];
        let error = "";
        const send = async () => ({ status: (await fetch(`${FIXTURE}/api/slow`)).status });
        try {
            await rt.loadAssert(send, "users:4 seconds:2 requests:40 p95:50", (name, body) => void attached.push({ name, body }), 200);
        } catch (e) {
            error = (e as Error).message;
        }
        const samples = JSON.parse(attached.find((a) => a.name === "metrics")!.body) as Array<{ metric: string; value: number; unit: string; budget?: number }>;
        expect(error).toMatch(/^Load check failed: the endpoint struggled at 2 users at once/);

        const { repo } = platform;
        const projectId = repo.createProject({ name: "Load UI" }).id as string;
        repo.createApplication(projectId, FIXTURE, {});
        const spec = TestSpecSchema.parse({
            testId: "API-001",
            title: "GET /api/slow: handles 4 users at once",
            kind: "api",
            category: "Performance",
            type: "performance",
            steps: [{ action: "request", method: "GET", path: "/api/slow", auth: "default" }, { action: "assertResponse", check: "load", expected: "users:4 seconds:2 requests:40 p95:50" }],
            source: { origin: "performance-check" },
        });
        const id = repo.insertTest({ projectId, suiteId: repo.getOrCreateSuite(projectId, "Performance", "performance"), jobId: null, spec, framework: "playwright-api", validationStatus: "NEEDS_REVIEW" });
        const run = { testId: "API-001", status: "failed" as const, durationMs: 4000, failedStepIndex: 1, steps: [{ index: 1, title: "2. load", status: "failed" as const, error }], artifacts: [], responses: [] };
        repo.updateTest(id, { validationStatus: "NEEDS_REVIEW", reason: loadFinding(spec, run) ?? "" });
        const exec = repo.addExecution({ testId: id, scriptId: null, jobId: null, attempt: 1, status: "failed", durationMs: 4000, startedAt: new Date().toISOString(), steps: [] });
        await recordMetrics(repo.db.sql, { projectId, testId: id, executionId: exec, samples });

        await page.goto(`${BASE}/#/tests/${id}`);
        const card = page.getByTestId("load-check");
        await pwExpect(card.getByText("Handles 4 users at once", { exact: true })).toBeVisible();
        await pwExpect(card.getByText("read-only requests, about 10 seconds, at most 300")).toBeVisible();
        await pwExpect(card.locator('[data-metric="load_users"]').getByText("Users at once")).toBeVisible();
        await pwExpect(card.locator('[data-metric="load_requests"]').getByText("Requests sent")).toBeVisible();
        await pwExpect(card.locator('[data-metric="load_rps"]').getByText("Requests per second")).toBeVisible();
        const p95 = card.locator('[data-metric="load_p95"]');
        await pwExpect(p95.getByText("95% of responses within")).toBeVisible();
        await pwExpect(p95.getByText("budget 50 ms")).toBeVisible();
        await pwExpect(p95.getByText("Over budget")).toBeVisible();
        const errors = card.locator('[data-metric="load_error_rate"]');
        await pwExpect(errors.getByText("Requests that failed")).toBeVisible();
        await pwExpect(errors.getByText("0.0%")).toBeVisible();
        await pwExpect(errors.getByText("budget 1.0%")).toBeVisible();
        await pwExpect(errors.getByText("Within budget")).toBeVisible();
        await pwExpect(card.locator('[data-metric="load_ok"]').getByText("Answered successfully")).toBeVisible();
        for (const empty of ["load_4xx", "load_5xx", "load_429", "load_network"]) await pwExpect(card.locator(`[data-metric="${empty}"]`)).toHaveCount(0);
        // the ordinary speed card is not shown for a load check, and the finding reads in plain words
        await pwExpect(page.getByTestId("page-speed")).toHaveCount(0);
        await pwExpect(page.getByText("Load check:").first()).toBeVisible();
        await pwExpect(page.getByText("struggled at 2 users at once").first()).toBeVisible();
    }, 120_000);
});
