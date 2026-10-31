/**
 * One browser journey through test-data cleanup in the real UI:
 *  Overview card ("Last run created 5 records; 3 removed, 2 left behind", what stayed and why) -> a record that could not be
 *  removed is retried after the application recovers -> a test's own page says what its run created -> Tests -> More actions ->
 *  Records created by tests: switch cleanup off (warning shown), run a test, see its records "Left in place" -> switch it on again ->
 *  the generation form offers the choice next to "Include API tests that change data".
 * Everything underneath is real: a real platform runs four imported API tests against a fixture API that holds an in-memory store
 * (ports 5580 fixture, 5581 platform).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/cleanup-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startCleanupApp, type CleanupApp } from "./fixtures/cleanup-app.js";

const FX_PORT = 5580;
const PLATFORM_PORT = 5581;
const FX = `http://127.0.0.1:${FX_PORT}`;
const TOKEN = "cleanup-ui-token-3e71ab";

let browser: Browser;
let context: BrowserContext;
let page: Page;
let fx: CleanupApp;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let base: string;
let projectId: string;

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; body: any };
};

async function waitIdle() {
    for (let i = 0; i < 360; i++) {
        const jobs = (await call("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ status: string }>;
        if (jobs.length && jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status))) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("project never became idle");
}

const req = (method: string, p: string, extra: Record<string, unknown> = {}) => ({ action: "request", method, path: p, auth: "default", description: "", ...extra });
const ok = { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" };
const spec = (testId: string, title: string, steps: unknown[]) => ({ testId, title, kind: "api", category: "Items", type: "functional", priority: "medium", tags: ["api"], steps });
const SPECS = [
    spec("API-001", "An item can be created and deleted", [req("POST", "/api/items", { body: { name: "lifecycle" }, extract: { item: "id" } }), ok, req("DELETE", "/api/items/{{item}}"), ok]),
    spec("API-002", "Two items can be created", [req("POST", "/api/items", { body: { name: "first" } }), ok, req("POST", "/api/items", { body: { name: "second" } }), ok]),
    spec("API-003", "A note can be added", [req("POST", "/api/notes", { body: { name: "memo" } }), ok]),
    spec("API-004", "A flaky record can be created and deleted", [req("POST", "/api/flaky", { body: { name: "f" }, extract: { f: "id" } }), ok, req("DELETE", "/api/flaky/{{f}}"), ok]),
];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    fx = await startCleanupApp(FX_PORT, { token: TOKEN });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-cleanup-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "1" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();
    base = `http://127.0.0.1:${PLATFORM_PORT}`;

    projectId = (await call("POST", "/api/projects", { name: "Cleanup UI" })).body.id;
    const imported = await call("POST", `/api/projects/${projectId}/specs`, { specs: SPECS, baseUrl: FX, credentials: { apiToken: TOKEN } });
    expect(imported.status).toBe(202);
    await waitIdle();
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); // axe-core refuses pages that were not made through a context
    page = await context.newPage();
}, 180_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await fx?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const card = () => page.getByRole("region", { name: "Test data cleanup", exact: true });

describe("test data cleanup in the UI", () => {
    it("the Overview says what the last run created, what was removed and what stayed, and why", async () => {
        await page.goto(`${base}/#/projects/${projectId}`);
        await pwExpect(card()).toBeVisible();
        await pwExpect(card().getByTestId("cleanup-summary")).toContainText("Last run created 5 records; 3 removed, 2 left behind.");
        const left = card().getByRole("list", { name: "Records left in the application" });
        await pwExpect(left.getByRole("listitem")).toHaveCount(2);
        await pwExpect(left).toContainText("POST /api/notes");
        await pwExpect(left).toContainText("No way to remove it");
        await pwExpect(left).toContainText("stays in the application");
        await pwExpect(left).toContainText("POST /api/flaky");
        await pwExpect(left).toContainText("Could not remove");
        await pwExpect(left).toContainText("The application answered HTTP 500.");
        await pwExpect(card().getByRole("button", { name: "Retry removing 1 record" })).toBeVisible();
        // The records the tests created are gone from the application, except the two that could not be removed.
        expect(fx.store.items!.size).toBe(0);
        expect(fx.store.notes!.size).toBe(1);
        expect(fx.store.flaky!.size).toBe(1);
    });

    it("has no serious accessibility problems in light or dark, and fits a phone", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            const result = await new AxeBuilder({ page }).include('[data-testid="cleanup-card"]').analyze();
            expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help}`), scheme).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 375, height: 800 });
        await pwExpect(card()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("retries only the record that failed, after the application recovers", async () => {
        fx.flakyHealthy = true;
        fx.log.length = 0;
        await card().getByRole("button", { name: "Retry removing 1 record" }).click();
        await pwExpect(card().getByText("Removed 1 record. Nothing is left to retry.")).toBeVisible();
        await pwExpect(card().getByTestId("cleanup-summary")).toContainText("Last run created 5 records; 4 removed, 1 left behind.");
        await pwExpect(card().getByRole("button", { name: /Retry removing/ })).toHaveCount(0);
        expect(fx.log.filter((l) => l.op === "delete").map((l) => l.resource)).toEqual(["flaky"]);
        expect(fx.store.flaky!.size).toBe(0);
        expect(fx.store.notes!.size).toBe(1);
    });

    it("a test's own page says what its run created", async () => {
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string }>;
        await page.goto(`${base}/#/tests/${tests.find((t) => t.testId === "API-003")!.id}`);
        const line = page.getByTestId("test-cleanup");
        await pwExpect(line).toBeVisible();
        await pwExpect(line).toContainText("The last run created 1 record; 0 removed, 1 left behind.");
        await pwExpect(line).toContainText("no way to remove it");
        await page.goto(`${base}/#/tests/${tests.find((t) => t.testId === "API-001")!.id}`);
        await pwExpect(page.getByTestId("test-cleanup")).toContainText("The last run created 1 record; 1 removed.");
    });

    it("switching cleanup off warns that records will stay, and a run then leaves them in place", async () => {
        await page.goto(`${base}/#/projects/${projectId}/tests`);
        await pwExpect(page.getByRole("heading", { name: "Automated tests", exact: true })).toBeVisible();
        // Test data moved from the Library to the project's Settings (round 25).
        await page.getByRole("navigation", { name: "Project sections", exact: true }).getByRole("link", { name: "Settings", exact: true }).click();
        await page.getByRole("link", { name: "Test data", exact: true }).click();
        const panel = card();
        await pwExpect(panel).toBeVisible();
        const box = panel.getByRole("checkbox", { name: /Remove the records tests create after each run/ });
        await pwExpect(box).toBeChecked();
        await box.uncheck();
        await pwExpect(panel.getByText("Cleanup is off", { exact: true })).toBeVisible();
        await pwExpect(panel.getByText(/Records the tests create will stay in the application/)).toBeVisible();
        await pwExpect(box).not.toBeChecked();

        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string }>;
        fx.log.length = 0;
        expect((await call("POST", `/api/tests/${tests.find((t) => t.testId === "API-002")!.id}/validate`)).status).toBe(202);
        await waitIdle();
        expect(fx.store.items!.size).toBe(2); // nothing was removed
        expect(fx.log.filter((l) => l.op === "delete")).toHaveLength(0);

        await page.goto(`${base}/#/projects/${projectId}`);
        await pwExpect(card().getByTestId("cleanup-summary")).toContainText("Last run created 2 records; 0 removed, 2 left behind.");
        await pwExpect(card().getByRole("list", { name: "Records left in the application" })).toContainText("Left in place");
        await pwExpect(card().getByRole("list", { name: "Records left in the application" })).toContainText("Cleanup is switched off for this project");
        await pwExpect(card().getByText("Cleanup is off", { exact: true })).toBeVisible();
    });

    it("switching it back on is remembered", async () => {
        await card().getByRole("checkbox", { name: /Remove the records tests create after each run/ }).check();
        await pwExpect(card().getByText("Cleanup is off", { exact: true })).toHaveCount(0);
        await page.reload();
        await pwExpect(card().getByRole("checkbox", { name: /Remove the records tests create after each run/ })).toBeChecked();
        expect((await call("GET", `/api/projects/${projectId}/cleanup`)).body.enabled).toBe(true);
    });

    it("the generation form offers the choice next to tests that change data, with a plain warning when it is off", async () => {
        await page.goto(`${base}/#/new?url=${encodeURIComponent(FX)}`);
        await page.locator("summary", { hasText: "Advanced options" }).click();
        const change = page.getByRole("checkbox", { name: /Include API tests that change data/ });
        await change.check();
        const remove = page.getByRole("checkbox", { name: /Remove the records these tests create afterwards/ });
        await pwExpect(remove).toBeChecked();
        await remove.uncheck();
        await pwExpect(page.getByText(/Cleanup is off: the records the tests create will stay in the application/)).toBeVisible();
        await change.uncheck();
        await pwExpect(page.getByRole("checkbox", { name: /Remove the records these tests create afterwards/ })).toHaveCount(0);
    });
});
