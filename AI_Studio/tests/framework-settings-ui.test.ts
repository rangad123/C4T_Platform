/**
 * The Frameworks section of the Runners tab in a real browser, against the real built UI (web/dist) and a real platform (no worker, no
 * model): availability lines in words, switching a framework off, a time limit, clamping and plain errors, "Use defaults", the change
 * log, the lock while a run is in progress, the quiet status line on the Tests page, keyboard use, axe in light and dark, phone width.
 * Run: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/framework-settings-ui.test.ts
 * Port 5954. Set FW_SHOTS=<folder> to also write screenshots there.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaInject } from "./fixtures/fake-agent.js";
import { addTest, seedProject, type Seed } from "./fixtures/dashboard-seed.js";

const PORT = 5954;
const BASE = `http://127.0.0.1:${PORT}`;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dir: string;
let shop: Seed;
const consoleErrors: string[] = [];
const shot = async (name: string) => {
    if (process.env.FW_SHOTS) await page.screenshot({ path: path.join(process.env.FW_SHOTS, `${name}.png`), fullPage: true });
};
// Frameworks are in Settings, a titled row with "Change": the form opens on request.
const runnersUrl = () => `${BASE}/#/projects/${shop.projectId}/settings?section=frameworks`;
const testsUrl = () => `${BASE}/#/projects/${shop.projectId}/tests`;
const open = async (url: string, ready: () => Promise<void>) => {
    await page.goto("about:blank");
    await page.goto(url);
    await ready();
};
const section = () => page.getByTestId("frameworks");
const ready = async () => {
    await page.getByRole("button", { name: "Change frameworks", exact: true }).click();
    await pwExpect(section().getByRole("heading", { name: "Web tests" })).toBeVisible();
};
const stored = async () => JSON.parse((await server.inject({ method: "GET", url: `/api/projects/${shop.projectId}/framework-settings` })).body);
const SAVED = "Saved. The next run uses these settings.";

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-fw-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), CONCURRENCY: "3" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    shop = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    addTest(platform, shop, "health");
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 90_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Frameworks section", () => {
    it("shows one card per framework with its availability in words, and the Tests page says nothing while all is default", async () => {
        await open(runnersUrl(), ready);
        await pwExpect(section().getByRole("heading", { name: "Frameworks", exact: true })).toBeVisible();
        for (const name of ["Web tests", "API tests", "Android tests", "Windows desktop tests"]) await pwExpect(section().getByRole("heading", { name, exact: true })).toBeVisible();
        await pwExpect(section().getByTestId("fw-playwright")).toContainText("Ready on this server");
        await pwExpect(section().getByTestId("fw-taqwright")).toContainText(/Needs an Android emulator|Ready on this server/);
        if (process.platform !== "win32") await pwExpect(section().getByTestId("fw-windows-uia")).toContainText("Needs Windows");
        await pwExpect(section().getByTestId("fw-playwright").getByLabel("Time limit per test (seconds)")).toHaveValue("60");
        await pwExpect(section().getByText("No changes yet. Everything runs as it always did.")).toBeVisible();
        await pwExpect(section().getByRole("button", { name: "Save settings" })).toBeDisabled();
        await pwExpect(section().getByText("Retries are not offered on purpose", { exact: false })).toBeVisible();
        await shot("frameworks-default");
        await open(testsUrl(), async () => pwExpect(page.getByRole("link", { name: /Check health/ })).toBeVisible());
        await page.waitForTimeout(500);
        await pwExpect(page.getByTestId("frameworks-line")).toHaveCount(0);
    });

    it("turns a framework off and sets a time limit with the keyboard, saves, and keeps it after a reload", async () => {
        await open(runnersUrl(), ready);
        const api = section().getByRole("switch", { name: /API tests/ });
        await api.focus();
        await page.keyboard.press("Space");
        await pwExpect(api).toHaveAttribute("aria-checked", "false");
        await section().getByTestId("fw-playwright").getByLabel("Time limit per test (seconds)").fill("120");
        await pwExpect(section().getByText("You have unsaved changes.")).toBeVisible();
        await section().getByRole("button", { name: "Save settings" }).click();
        await pwExpect(section().getByText(SAVED)).toBeVisible();
        await pwExpect(section().getByTestId("fw-changes")).toContainText("API tests turned off; Web time limit 60 s to 120 s");
        const s = await stored();
        expect(s.settings.enabled["playwright-api"]).toBe(false);
        expect(s.settings.web.testTimeoutSeconds).toBe(120);
        await open(runnersUrl(), ready);
        await pwExpect(section().getByRole("switch", { name: /API tests/ })).toHaveAttribute("aria-checked", "false");
        await pwExpect(section().getByTestId("fw-playwright").getByLabel("Time limit per test (seconds)")).toHaveValue("120");
        await shot("frameworks-changed");
        await open(testsUrl(), async () => pwExpect(page.getByTestId("frameworks-line")).toBeVisible());
        await pwExpect(page.getByTestId("frameworks-line")).toContainText("API tests are turned off, web tests stop after 120 s.");
        await page.getByTestId("frameworks-line").getByRole("link", { name: "Change" }).click();
        await ready();
    });

    it("says what clamping did and explains a value it cannot read", async () => {
        await open(runnersUrl(), ready);
        const web = section().getByTestId("fw-playwright").getByLabel("Time limit per test (seconds)");
        await web.fill("900");
        await section().getByRole("button", { name: "Save settings" }).click();
        await pwExpect(section().getByText("The web test time limit was set to 300 seconds, the most allowed.")).toBeVisible();
        await pwExpect(web).toHaveValue("300");
        await web.fill("");
        await section().getByRole("button", { name: "Save settings" }).click();
        await pwExpect(section().getByText("Web time limit: enter a number of seconds.")).toBeVisible();
        expect((await stored()).settings.web.testTimeoutSeconds).toBe(300);
        await pwExpect(section().getByLabel("Browser window")).toBeDisabled();
        await pwExpect(section().getByText("A visible window only opens on a runner.", { exact: false })).toBeVisible();
    });

    it("brings every setting back with Use defaults", async () => {
        await open(runnersUrl(), ready);
        await section().getByRole("button", { name: "Use defaults" }).click();
        await pwExpect(section().getByRole("switch", { name: /API tests/ })).toHaveAttribute("aria-checked", "true");
        await section().getByRole("button", { name: "Save settings" }).click();
        await pwExpect(section().getByText(SAVED)).toBeVisible();
        await pwExpect(section().getByTestId("fw-changes")).toContainText("Web time limit 300 s to 60 s");
        expect((await stored()).settings.web.testTimeoutSeconds).toBe(60);
    });

    it("names the runner agent and offers a visible window once the project runs on one", async () => {
        const token = JSON.parse((await server.inject({ method: "POST", url: `/api/projects/${shop.projectId}/agent-tokens`, payload: { label: "maya" } })).body).secret as string;
        const agent = new FakeAgent(viaInject(server), token, { name: "Maya laptop", capabilities: defaultCaps({ android: { adb: true, devices: [], avds: ["Pixel_6"] } }) });
        expect((await agent.hello()).status).toBe(200);
        expect((await server.inject({ method: "PUT", url: `/api/projects/${shop.projectId}/runner`, payload: { runOn: "agent" } })).statusCode).toBe(200);
        await open(runnersUrl(), ready);
        await pwExpect(section().getByTestId("fw-playwright")).toContainText("Ready on Maya laptop");
        await pwExpect(section().getByTestId("fw-taqwright")).toContainText("Ready on Maya laptop");
        await pwExpect(section().getByTestId("fw-windows-uia")).toContainText("Needs Windows on Maya laptop");
        await section().getByLabel("Browser window").selectOption("visible");
        await section().getByLabel("Default emulator").selectOption("Pixel_6");
        await section().getByLabel("Parallel browsers").fill("1");
        await section().getByRole("button", { name: "Save settings" }).click();
        await pwExpect(section().getByText(SAVED)).toBeVisible();
        const s = await stored();
        expect(s.settings.web).toMatchObject({ headless: false, workers: 1 });
        expect(s.settings.android.defaultAvd).toBe("Pixel_6");
        await shot("frameworks-agent");
        await server.inject({ method: "PUT", url: `/api/projects/${shop.projectId}/runner`, payload: { runOn: "platform" } });
    });

    it("locks the form while a run is in progress", async () => {
        const job = await platform.repo.createJob(shop.projectId, shop.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        await open(runnersUrl(), ready);
        await pwExpect(section().getByText("A run is in progress for this project.", { exact: false })).toBeVisible({ timeout: 10_000 });
        await pwExpect(section().getByRole("button", { name: "Save settings" })).toBeDisabled();
        await pwExpect(section().getByRole("switch", { name: /Web tests/ })).toBeDisabled();
        const refused = await server.inject({ method: "PUT", url: `/api/projects/${shop.projectId}/framework-settings`, payload: { settings: { web: { testTimeoutSeconds: 90 } } } });
        expect(refused.statusCode).toBe(409);
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    });

    it("is accessible in light and dark, fits a phone, and raised no console errors", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await open(runnersUrl(), ready);
            await page.waitForTimeout(400);
            const results = await new AxeBuilder({ page }).include('[data-testid="frameworks"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
            expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), scheme).toEqual([]);
            await shot(`frameworks-${scheme}-1280`);
        }
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.setViewportSize({ width: 390, height: 844 });
            await open(runnersUrl(), ready);
            await page.waitForTimeout(400);
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(over, `horizontal overflow in ${scheme}`).toBeLessThanOrEqual(0);
            const results = await new AxeBuilder({ page }).include('[data-testid="frameworks"]').analyze();
            expect(results.violations.map((v) => v.id), scheme).toEqual([]);
            await shot(`frameworks-${scheme}-390`);
        }
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
        expect(consoleErrors).toEqual([]);
    });
});
