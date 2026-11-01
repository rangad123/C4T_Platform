/**
 * Test suites in a real browser: the list (suites people build beside the groups by area), making a suite, adding tests, putting
 * them in order with the keyboard and by dragging, the settings, Run (and what it says when tests cannot run on this server), the
 * last runs, a schedule that runs a suite, accessibility, and a phone-sized screen. No worker: a run stays queued.
 * Needs web/dist (build it first, inside the lock). Runs a browser:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/suites-ui.test.ts
 * Ports: platform 7728.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { defaultFramework } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7728;
const BASE = `http://127.0.0.1:${PORT}`;

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;
const ids: Record<string, string> = {};

const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(BASE + url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return (res.status === 204 ? null : res.json()) as Promise<any>;
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "suites-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "suites-ui-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await api("POST", "/api/projects", { name: "Suite shop" })).id;
    new ReviewStore(platform.db).setPolicy(projectId, { aiGenerated: false, edits: false, healing: false }, "test");
    platform.repo.createApplication(projectId, "http://127.0.0.1:7729", { ...DEFAULT_JOB_OPTIONS });
    for (const [key, title, area] of [
        ["API-001", "Cart opens", "Checkout"],
        ["API-002", "Pay by card", "Checkout"],
        ["API-003", "Search finds shoes", "Search"],
    ] as const) {
        const spec = TestSpecSchema.parse({ testId: key, title, kind: "api", category: area, steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] });
        ids[title] = platform.repo.insertTest({ projectId, suiteId: platform.repo.getOrCreateSuite(projectId, area, area.toLowerCase()), jobId: null, spec, framework: defaultFramework("api"), validationStatus: "PENDING" });
    }
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1200, height: 1000 } })).newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const suiteOrder = async (sid: string) => ((await api("GET", `/api/projects/${projectId}/test-suites/${sid}`)).tests as Array<{ title: string }>).map((t) => t.title);
const rows = () => page.getByRole("list", { name: "Tests in this suite" }).locator("li");

describe("test suites page", () => {
    let sid: string;

    it("lists the groups by area as made for you, and no Planned card remains", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/suites`);
        await pwExpect(page.getByRole("heading", { name: "Suites you build" })).toBeVisible();
        await pwExpect(page.getByRole("list", { name: "Groups by area" }).getByText("Checkout")).toBeVisible();
        await pwExpect(page.getByText("Made for you")).toBeVisible();
        await pwExpect(page.getByText("No suites yet")).toBeVisible();
        expect(await page.locator("[data-testid=planned-suites]").count()).toBe(0);
    });

    it("makes a suite and opens it", async () => {
        await page.getByRole("button", { name: "New suite" }).click();
        await page.getByLabel("Name").fill("Smoke");
        await page.getByLabel("What it is for (optional)").fill("The quick check before a release");
        await page.getByRole("button", { name: "Create suite" }).click();
        await pwExpect(page.getByRole("heading", { name: "Smoke" })).toBeVisible();
        sid = page.url().split("/suites/")[1]!;
        expect(sid).toMatch(/^[0-9a-f-]{36}$/);
        await pwExpect(page.getByText("No tests in this suite yet")).toBeVisible();
        // Nothing to run yet: Run says why.
        await pwExpect(page.getByRole("button", { name: "Run suite" })).toHaveAttribute("aria-disabled", "true");
    });

    it("adds tests from a searchable list, in the order of that list", async () => {
        await page.getByRole("button", { name: "Add tests" }).first().click();
        await page.getByLabel("Find test cases").fill("checkout");
        const pick = page.getByRole("list", { name: "Test cases you can add" });
        await pwExpect(pick.getByText("Search finds shoes")).toHaveCount(0);
        await page.getByLabel("Find test cases").fill("");
        for (const t of ["Search finds shoes", "Cart opens", "Pay by card"]) await pick.getByText(t).click();
        await page.getByRole("button", { name: "Add 3 tests" }).click();
        await pwExpect(rows()).toHaveCount(3);
        expect(await suiteOrder(sid)).toEqual(["Cart opens", "Pay by card", "Search finds shoes"]);
    });

    it("moves a test with the keyboard and says where it went", async () => {
        const down = page.getByRole("button", { name: "Move Cart opens down" });
        await down.focus();
        await page.keyboard.press("Enter");
        await pwExpect(page.getByText("Moved “Cart opens” to position 2 of 3.")).toBeAttached();
        await pwExpect.poll(() => suiteOrder(sid)).toEqual(["Pay by card", "Cart opens", "Search finds shoes"]);
        // Focus stays on the control that moved, so pressing again keeps going.
        await page.keyboard.press("Enter");
        await pwExpect.poll(() => suiteOrder(sid)).toEqual(["Pay by card", "Search finds shoes", "Cart opens"]);
        await pwExpect(rows().first()).toContainText("Pay by card");
    });

    it("moves a test by dragging it", async () => {
        await rows().nth(2).dragTo(rows().nth(0));
        await pwExpect.poll(() => suiteOrder(sid)).toEqual(["Cart opens", "Pay by card", "Search finds shoes"]);
    });

    it("removes a test from the suite, not from the project", async () => {
        await page.getByRole("button", { name: "Remove Search finds shoes from the suite" }).click();
        await pwExpect(rows()).toHaveCount(2);
        expect((await api("GET", `/api/projects/${projectId}/tests`)).length).toBe(3);
    });

    it("saves how the suite runs", async () => {
        await page.getByLabel("Firefox").check();
        await page.getByLabel("When a test fails").selectOption("1");
        await page.getByLabel("Stop at the first failure").check();
        await page.getByRole("button", { name: "Save settings" }).click();
        await pwExpect(page.getByText("Saved. The next run uses these settings.")).toBeVisible();
        expect((await api("GET", `/api/projects/${projectId}/test-suites/${sid}`)).suite.settings).toMatchObject({ browsers: ["firefox"], retries: 1, stopOnFirstFailure: true, environment: null });
        await pwExpect(page.getByText(/also on Firefox, a failing test is run again once, stops at the first failure/)).toBeVisible();
    });

    it("runs the suite and shows the run in Last runs", async () => {
        await page.getByRole("button", { name: "Run suite" }).click();
        await pwExpect(page.getByText("2 tests queued in this suite’s order.")).toBeVisible();
        const runs = page.getByRole("list", { name: "Last runs of this suite" });
        await pwExpect(runs.getByText("2 tests waiting to start")).toBeVisible();
        const jobId = (await api("GET", `/api/projects/${projectId}/test-suites/${sid}`)).runs[0].jobId;
        expect(platform.repo.getJob(jobId)!.options.testIds).toEqual([ids["Cart opens"], ids["Pay by card"]]);
        platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED', finished_at = ? WHERE id = ?", new Date().toISOString(), jobId);
    });

    it("has no serious accessibility problems, and fits a phone screen", async () => {
        await page.reload();
        await pwExpect(page.getByRole("heading", { name: "Smoke" })).toBeVisible();
        const result = await new AxeBuilder({ page }).include("main").analyze();
        expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
        await page.setViewportSize({ width: 390, height: 800 });
        await pwExpect(page.getByRole("button", { name: "Run suite" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await page.setViewportSize({ width: 1200, height: 1000 });
    });

    it("says plainly when tests cannot run on this server, instead of queuing", async () => {
        platform.config.WORKER_EMBEDDED = false;
        try {
            await page.reload();
            await pwExpect(page.getByText("Tests do not run on this server").first()).toBeVisible();
            await pwExpect(page.getByRole("button", { name: "Run suite" })).toHaveAttribute("aria-disabled", "true");
            await page.goto(`${BASE}/#/projects/${projectId}/suites`);
            await pwExpect(page.getByText("Tests do not run on this server", { exact: true })).toBeVisible();
            await pwExpect(page.getByRole("list", { name: "Suites you build" }).getByText("Smoke")).toBeVisible();
        } finally {
            platform.config.WORKER_EMBEDDED = true;
        }
    });

    it("lets a schedule run the suite", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=schedules`);
        await page.getByRole("button", { name: "New schedule" }).first().click();
        await page.getByLabel("What should run").selectOption({ label: "Run the suite “Smoke”" });
        await pwExpect(page.getByText("Run the suite “Smoke” every day at 02:00")).toBeVisible();
        await page.getByRole("button", { name: "Create schedule" }).click();
        await pwExpect(page.getByText("Runs the suite “Smoke”")).toBeVisible();
        await page.goto(`${BASE}/#/projects/${projectId}/suites/${sid}`);
        await pwExpect(page.getByText(/Run on a schedule by/)).toBeVisible();
    });
});
