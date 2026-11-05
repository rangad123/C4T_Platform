/**
 * End-to-end UI smoke test: a real browser drives the real built UI against a real platform and
 * sample app (API-only analysis, so no LLM is needed):
 *   first-run welcome → enter URL → live progress → ready → tests list → test detail → code → run again.
 * Requires `npm run build:web` (CI does this before the tests).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";

/** UI_BROWSER=chromium|firefox|webkit (default chromium). The platform's own validation runs always use Chromium. */
const uiBrowser = { chromium, firefox, webkit }[(process.env.UI_BROWSER ?? "chromium") as "chromium"];
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const APP_PORT = 5181;
const UI_PORT = 4181;
let sample: ChildProcess;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let browser: Browser;
let page: Page;
let dataDir: string;
const consoleErrors: string[] = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: run `npm run build:web` first");
    sample = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(APP_PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${APP_PORT}/`)).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(UI_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: UI_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();
    // UI_CHANNEL=chrome|msedge: the installed Google Chrome or Microsoft Edge instead of Playwright's Chromium (scripts/ui-browsers.mjs).
    browser = await uiBrowser.launch(process.env.UI_CHANNEL ? { channel: process.env.UI_CHANNEL } : {});
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 60_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    sample?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("UI journey", () => {
    it("first visit explains the product and offers one obvious action", async () => {
        await page.goto(`http://127.0.0.1:${UI_PORT}/`);
        await pwExpect(page.getByRole("heading", { name: "Test any web application automatically" })).toBeVisible();
        // UX-E: three ways to start; the first one explores.
        await pwExpect(page.getByRole("button", { name: "Explore my app", exact: true })).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Record a test", level: 2 })).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Start from tests I have", level: 2 })).toBeVisible();
        await pwExpect(page.getByText("How it works", { exact: false }).or(page.getByText("Enter your URL"))).toBeVisible();
        // the AI chip tells the truth: no model is configured in this test
        await pwExpect(page.getByText("AI not set up")).toBeVisible();
    });

    it("rejects a bad address in plain words, without a server round-trip", async () => {
        await page.getByLabel("Application URL").fill("notaurl");
        await page.getByRole("button", { name: "Explore my app", exact: true }).click();
        await pwExpect(page.getByText("That doesn’t look like a complete address")).toBeVisible();
        await pwExpect(page.getByLabel("Application URL")).toHaveAttribute("aria-invalid", "true");
    });

    it("starts an analysis from one field and shows live progress, then the result", async () => {
        // An address without its scheme. The IP, not "localhost": Playwright's API requests look the name up for IPv6 as well, which
        // takes ten seconds on a machine whose hosts file names only ip6-localhost, the whole timeout of an API step.
        await page.getByLabel("Application URL").fill(`127.0.0.1:${APP_PORT}`);
        await page.getByRole("button", { name: "Choose what to test first" }).click();
        // No AI model here: the page says so and explores only the API, which needs none.
        await pwExpect(page.getByText("only the application’s API is explored here", { exact: false })).toBeVisible();
        await page.getByLabel("Project name").fill("Smoke shop"); // round 37: typed, never made from the address
        await page.getByRole("button", { name: "Start exploring" }).click();

        await pwExpect(page.getByRole("heading", { name: /Exploring your application/ })).toBeVisible({ timeout: 15_000 });
        // UX-E: the exploration ends at a plan; the tests are created when the person says so.
        await page.getByRole("button", { name: "Create the tests", exact: true }).click({ timeout: 90_000 });
        await pwExpect(page.getByText("Your test suite is ready")).toBeVisible({ timeout: 90_000 });
        await pwExpect(page.getByText("Tests", { exact: true }).first()).toBeVisible();
        // plain language only — never an internal state name
        const body = await page.locator("body").innerText();
        expect(body).not.toMatch(/PARTIALLY_COMPLETED|DISCOVERING|VALIDATED\b|NEEDS_REVIEW/);
    }, 120_000);

    it("lists tests grouped by area with human status wording, and opens one", async () => {
        await page.getByRole("link", { name: "View tests" }).click();
        await pwExpect(page.getByRole("heading", { name: "Scripts", exact: true })).toBeVisible();
        await pwExpect(page.getByText("Passing", { exact: true }).first()).toBeVisible();
        await page.getByPlaceholder("Search scripts").fill("products/{id}");
        await pwExpect(page.locator(".script-row").first()).toBeVisible();
        await page.locator("a.sr-title").first().click();
        // Round 38: a script's title opens its DSL tab; what the test checks is read on its Steps tab.
        await pwExpect(page.getByRole("tab", { name: "DSL", exact: true })).toHaveAttribute("aria-selected", "true");
        await page.getByRole("tab", { name: "Steps", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "What this test checks" })).toBeVisible();
        await pwExpect(page.getByText("This test is passing")).toBeVisible();
    });

    it("shows the generated code beside the steps, and re-runs a test", async () => {
        // the script sits beside the steps in the workbench (the test first), and the Code tab shows it on its own
        await page.getByRole("tab", { name: "Steps", exact: true }).click();
        await pwExpect(page.getByRole("tab", { name: "Steps", exact: true })).toHaveAttribute("aria-selected", "true");
        // the test comes first; the platform's setup code (which holds API_BASE_URL) is folded behind one line
        await pwExpect(page.locator("pre.code:visible")).toContainText("test(");
        await pwExpect(page.getByText(/^Show setup code \(\d+ lines\)$/)).toBeVisible();
        await page.getByRole("button", { name: "Copy" }).first().click();
        await page.getByRole("button", { name: "Run again" }).click();
        // The run strip says it is running (this replaced the old "Running…" button label), then how it ended.
        await pwExpect(page.getByTestId("run-strip")).toBeVisible();
        await pwExpect(page.getByRole("region", { name: "Run finished" })).toBeVisible({ timeout: 60_000 });
        await pwExpect(page.getByText("This test is passing")).toBeVisible();
    }, 90_000);

    it("imports a script with the Import button and validates it", async () => {
        await page.getByRole("link", { name: "Test scripts", exact: true }).first().click();
        await pwExpect(page.getByRole("heading", { name: "Scripts", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "More actions" }).click();
        await pwExpect(page.getByRole("menuitem", { name: "Export…", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Import", exact: true }).click();
        const spec = { title: "Product list returns an array", kind: "api", category: "API · Imported", steps: [{ action: "request", method: "GET", path: "/api/products" }, { action: "assertResponse", check: "jsonType", expected: "array" }] };
        await page.locator('input[type="file"]').setInputFiles({ name: "specs.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ specs: [spec] })) });
        await pwExpect(page.getByText(/Imported 1 test/)).toBeVisible({ timeout: 15_000 });
        await pwExpect(page.getByText("Product list returns an array")).toBeVisible();
        // the imported test is validated by a real run and ends up passing
        await pwExpect(page.locator(".script-row", { hasText: "Product list returns an array" }).getByText("Passing", { exact: true })).toBeVisible({ timeout: 60_000 });
    }, 90_000);

    it("never logged a browser error", () => {
        // clipboard permission is the only tolerated message in headless Chromium
        expect(consoleErrors.filter((e) => !/clipboard|permission/i.test(e))).toEqual([]);
    });
});
