/**
 * One browser journey through environments and test data in the real UI:
 *  Tests -> More actions -> Environments: add staging and a production environment (read-only, needs a confirmation), keep a token
 *  write-only -> open a test, run it on staging, then on production -> the page keeps one result per environment while the test's
 *  own status never changes -> a data-changing test is refused on production, with the reason -> Tests -> More actions -> Test
 *  data: import a CSV, look at its rows, and see a bad file explained.
 * Everything underneath is real: a real platform validates three imported tests on the production-like fixture, and every
 * "Run again" really runs Playwright against the staging (one harmless bug) or production fixture (ports 5514 / 5515; platform 5516).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/environments-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { ENV_SPECS, startEnvironmentsApp, type EnvironmentsApp } from "./fixtures/environments-app.js";

const STAGING_PORT = 5514;
const PROD_PORT = 5515;
const PLATFORM_PORT = 5516;
const STAGING = `http://127.0.0.1:${STAGING_PORT}`;
const PROD = `http://127.0.0.1:${PROD_PORT}`;
const STAGING_TOKEN = "ui-stg-token-5d27c8";

let browser: Browser;
let page: Page;
let staging: EnvironmentsApp;
let prod: EnvironmentsApp;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let work: string;
let base: string;
let projectId: string;

const post = async (url: string, body: unknown) => {
    const res = await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
};

async function waitIdle() {
    for (let i = 0; i < 360; i++) {
        const jobs = (await (await fetch(`${base}/api/projects/${projectId}/jobs`)).json()) as Array<{ status: string }>;
        if (jobs.length && jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status))) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("project never became idle");
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    staging = await startEnvironmentsApp(STAGING_PORT, { label: "staging", bug: true, token: STAGING_TOKEN });
    prod = await startEnvironmentsApp(PROD_PORT, { label: "production", bug: false, token: "ui-prod-token" });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-env-ui-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-env-ui-files-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "1" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();
    base = `http://127.0.0.1:${PLATFORM_PORT}`;

    // Three tests that really validate on the project's own address (the production-like server).
    projectId = (await post("/api/projects", { name: "Environments UI" })).body.id;
    const specs = [ENV_SPECS[0], ENV_SPECS[2], ENV_SPECS[3]];
    expect((await post(`/api/projects/${projectId}/specs`, { specs, baseUrl: PROD })).status).toBe(202);
    await waitIdle();
    prod.reset();
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
}, 180_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await staging?.close();
    await prod?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
});

const openPanel = async (item: RegExp, region: string) => {
    // Environments and test data are both sections of the project's Settings (round 25; test data was in the Library).
    const environments = item.test("Environments");
    await page.goto(`${base}/#/projects/${projectId}/settings?section=${environments ? "environments" : "data"}`);
    await pwExpect(page.getByRole("heading", { name: "Settings", exact: true, level: 2 })).toBeVisible();
    const panel = page.getByRole("region", { name: region, exact: true });
    await pwExpect(panel).toBeVisible();
    return panel;
};

describe("environments in the UI", () => {
    it("adds staging and a read-only production environment, and keeps sign-in write-only", async () => {
        const panel = await openPanel(/^Environments/, "Environments");
        await pwExpect(panel.getByText("No environments yet.")).toBeVisible();

        await panel.getByRole("button", { name: "Add an environment" }).click();
        const save = panel.getByRole("button", { name: "Save environment" });
        await panel.getByLabel("Environment name").fill("staging");
        await panel.getByLabel("Address", { exact: true }).fill("https://staging.example.com/shop");
        // A wrong address is explained, and cannot be saved.
        await pwExpect(panel.getByText(/The address should be just the site/)).toBeVisible();
        await pwExpect(save).toBeDisabled();
        await panel.getByLabel("Address", { exact: true }).fill(STAGING);
        await panel.getByLabel("API token").fill(STAGING_TOKEN);
        await pwExpect(save).toBeEnabled();
        await save.click();
        const list = panel.getByRole("list", { name: "Saved environments" });
        await pwExpect(list.getByRole("listitem").filter({ hasText: "staging" })).toContainText("Default");
        await pwExpect(list.getByRole("listitem").filter({ hasText: "staging" })).toContainText("Sign-in saved");

        // Production: prominent, read-only, and a run needs an explicit confirmation.
        await panel.getByRole("button", { name: "Add an environment" }).click();
        await panel.getByLabel("Environment name").fill("production");
        await panel.getByLabel("Address", { exact: true }).fill(PROD);
        await panel.getByRole("checkbox", { name: /This is a production environment/ }).check();
        await pwExpect(panel.getByText(/Production is read-only here/).first()).toBeVisible();
        await panel.getByRole("button", { name: "Save environment" }).click();
        const production = list.getByRole("listitem").filter({ hasText: "production" });
        await pwExpect(production).toContainText("Production · read-only");
        await pwExpect(production).not.toContainText("Default");
        await pwExpect(production.getByRole("button", { name: "Run all tests on production" })).toBeDisabled();
        await production.getByRole("checkbox", { name: /Yes, run on production/ }).check();
        await pwExpect(production.getByRole("button", { name: "Run all tests on production" })).toBeEnabled();

        // The token is never shown again: the field only says one is saved, and the page text has no trace of it.
        await list.getByRole("listitem").filter({ hasText: "staging" }).getByRole("button", { name: "Edit staging" }).click();
        await pwExpect(panel.getByLabel("API token")).toHaveAttribute("placeholder", "Saved — leave empty to keep");
        await pwExpect(panel.getByLabel("API token")).toHaveValue("");
        expect(await page.content()).not.toContain(STAGING_TOKEN);
        await panel.getByRole("button", { name: "Cancel" }).click();

        // Nothing overflows on a phone.
        await page.setViewportSize({ width: 390, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 120_000);

    it("runs a test on staging, then on production, and keeps one result per environment", async () => {
        await page.goto(`${base}/#/projects/${projectId}/scripts`);
        // A row opens its script on the DSL tab; this checks the test's own page (the bare route).
        const href = await page.locator("a.sr-title", { hasText: "The offer banner shows the free-shipping threshold" }).getAttribute("href");
        expect(href).toMatch(/\/text$/);
        await page.goto(`${base}/${href!.replace(/\/text$/, "")}`);
        await pwExpect(page.getByText("Passing", { exact: true }).first()).toBeVisible();
        // "Run again" runs at once; the arrow next to it opens the choices, which now carry the environments (UX-A run control).
        await page.getByRole("button", { name: "More ways to run" }).click();
        const panel = page.getByRole("group", { name: "Run settings" });
        await pwExpect(panel.getByRole("radio", { name: "Project address", exact: true })).toBeVisible();
        await pwExpect(panel.getByRole("radio", { name: "staging", exact: true })).toBeVisible();
        await pwExpect(panel.getByRole("radio", { name: "production (production)", exact: true })).toBeVisible();
        // Round 21: the environment marked Default (staging, the first one saved) is preselected; the others stay one click away.
        await pwExpect(panel.getByRole("radio", { name: "staging", exact: true })).toBeChecked();
        await pwExpect(panel.getByRole("radio", { name: "Project address", exact: true })).not.toBeChecked();
        await pwExpect(panel.getByTestId("run-sentence")).toContainText("against staging");
        // The person can still choose another place, and back.
        await panel.getByRole("radio", { name: "Project address", exact: true }).check();
        await pwExpect(panel.getByTestId("run-sentence")).not.toContainText("against");
        await panel.getByRole("radio", { name: "staging", exact: true }).check();
        await pwExpect(panel.getByTestId("run-sentence")).toContainText("against staging");
        await panel.getByRole("button", { name: "Start run" }).click();
        const strip = page.getByRole("list", { name: "Last result in each environment" });
        await pwExpect(strip.getByRole("listitem").filter({ hasText: "staging" })).toContainText("Failed", { timeout: 120_000 });
        await pwExpect(strip.getByRole("listitem").filter({ hasText: "staging" })).toContainText(/5O|over/);
        // The test's own status did not change, and nothing went to the project's own address.
        await pwExpect(page.getByText("Passing", { exact: true }).first()).toBeVisible();
        expect(prod.hits).toHaveLength(0);

        await page.getByRole("button", { name: "More ways to run" }).click();
        await panel.getByRole("radio", { name: "production (production)", exact: true }).check();
        const start = panel.getByRole("button", { name: "Start run" });
        await pwExpect(start).toBeDisabled(); // production needs its confirmation first
        await panel.getByRole("checkbox", { name: "Yes, run on production" }).check();
        await pwExpect(start).toBeEnabled();
        await start.click();
        const prodItem = strip.getByRole("listitem").filter({ hasText: "production" });
        await pwExpect(prodItem).toContainText("Passed", { timeout: 120_000 });
        await pwExpect(prodItem).toContainText("Production");
        // Both environments are on the page at once, with different results for the same test.
        await pwExpect(strip.getByRole("listitem").filter({ hasText: "staging" })).toContainText("Failed");
        await pwExpect(page.getByText("Passing", { exact: true }).first()).toBeVisible();
    }, 300_000);

    it("refuses to run a data-changing test on production and says why, while staging runs it", async () => {
        await page.goto(`${base}/#/projects/${projectId}/scripts`);
        // A row opens its script on the DSL tab; this checks the test's own page (the bare route).
        const href = await page.locator("a.sr-title", { hasText: "An item can be created" }).getAttribute("href");
        expect(href).toMatch(/\/text$/);
        await page.goto(`${base}/${href!.replace(/\/text$/, "")}`);
        await page.getByRole("button", { name: "More ways to run" }).click();
        const panel = page.getByRole("group", { name: "Run settings" });
        await panel.getByRole("radio", { name: "production (production)", exact: true }).check();
        await panel.getByRole("checkbox", { name: "Yes, run on production" }).check();
        await panel.getByRole("button", { name: "Start run" }).click();
        await pwExpect(panel.getByRole("alert")).toContainText(/production is read-only/);
        expect(prod.mutations).toBe(0);
        expect(staging.mutations).toBe(0);

        await panel.getByRole("radio", { name: "staging", exact: true }).check();
        await panel.getByRole("button", { name: "Start run" }).click();
        await pwExpect(page.getByRole("list", { name: "Last result in each environment" }).getByRole("listitem").filter({ hasText: "staging" })).toContainText("Passed", { timeout: 120_000 });
        expect(staging.mutations).toBe(1);
        expect(prod.mutations).toBe(0);
    }, 300_000);

    it("shows the run on the Runs page in plain words", async () => {
        await page.goto(`${base}/#/projects/${projectId}/runs`);
        await pwExpect(page.getByRole("heading", { name: "Run on staging" }).first()).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Run on production" }).first()).toBeVisible();
    });

    it("a new run sequence starts its run steps at the default environment (round 21)", async () => {
        await page.goto(`${base}/#/projects/${projectId}/schedule`);
        const runbooks = page.getByRole("region", { name: "Run sequences", exact: true });
        await runbooks.getByRole("button", { name: "Write your own" }).click();
        const form = runbooks.getByRole("form", { name: "New run sequence" });
        const first = form.locator("fieldset[data-step]").nth(0);
        await pwExpect(first.getByLabel("Where", { exact: true })).toHaveValue("staging");
        // A run step added later starts there too; the person can change it.
        await form.getByLabel("Add a step").selectOption("run");
        await form.getByRole("button", { name: "Add step" }).click();
        const second = form.locator("fieldset[data-step]").nth(1);
        await pwExpect(second.getByLabel("Where", { exact: true })).toHaveValue("staging");
        await second.getByLabel("Where", { exact: true }).selectOption("");
        await pwExpect(second.getByLabel("Where", { exact: true })).toHaveValue("");
        await pwExpect(first.getByLabel("Where", { exact: true })).toHaveValue("staging");
    });
});

describe("test data in the UI", () => {
    it("imports a CSV, shows its rows, and explains a bad file", async () => {
        const panel = await openPanel(/^Test data/, "Test data");
        await pwExpect(panel.getByText("No data sets yet.")).toBeVisible();
        const good = path.join(work, "logins.csv");
        fs.writeFileSync(good, "q,shown\napple,apple\npear,pear\nplum,plum\n");
        await panel.locator("#data-file").setInputFiles(good);
        await pwExpect(panel.getByLabel("Data set name")).toHaveValue("logins"); // from the file name
        await panel.getByRole("button", { name: "Import", exact: true }).click();
        await pwExpect(panel.getByText("Imported “logins”: 3 rows, 2 columns.")).toBeVisible();
        const item = panel.getByRole("list", { name: "Saved data sets" }).getByRole("listitem").filter({ hasText: "logins" });
        await pwExpect(item).toContainText("3 rows");
        await pwExpect(item).toContainText("Not used yet");
        await item.getByRole("button", { name: "Show rows of logins" }).click();
        await pwExpect(item.getByRole("cell", { name: "pear", exact: true }).first()).toBeVisible();

        const bad = path.join(work, "empty.csv");
        fs.writeFileSync(bad, "q,shown\n");
        await panel.locator("#data-file").setInputFiles(bad);
        await panel.getByLabel("Data set name").fill("empty");
        await panel.getByRole("button", { name: "Import", exact: true }).click();
        await pwExpect(panel.getByRole("alert")).toContainText(/no rows/);

        // A name that is taken offers to replace it instead of failing.
        await panel.locator("#data-file").setInputFiles(good);
        await panel.getByLabel("Data set name").fill("logins");
        await pwExpect(panel.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
        await pwExpect(panel.getByRole("button", { name: "Replace “logins”" })).toBeVisible();

        await item.getByRole("button", { name: "Remove logins" }).click();
        await pwExpect(panel.getByText("Removed “logins”.")).toBeVisible();
    }, 120_000);
});
