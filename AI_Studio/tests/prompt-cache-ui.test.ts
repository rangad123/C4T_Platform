/**
 * One browser journey through prompt caching in the real UI: Settings, AI model shows the switch (on by default) with what it does for
 * the model in use -> turning it off is saved and reported as set here -> "Use the server’s setting" goes back -> AI usage shows the
 * cached part of the input (a "From cache" column, the detail line) -> a price with a cached-input price gives the cost that uses it ->
 * axe-clean in light and dark, and nothing spills sideways on a phone. No model is called: the usage rows are written to the real store.
 * Port 7292.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/prompt-cache-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { setPromptCacheSource } from "../src/engine/llm/prompt-cache.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { UsageStore } from "../src/platform/usage-store.js";

const PORT = 7292;
let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
const base = `http://127.0.0.1:${PORT}`;
const api = async (url: string) => (await fetch(`${base}${url}`)).json() as Promise<any>;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-prompt-cache-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5-5", LLM_API_KEY: "fake-key-never-used", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const projectId = platform.repo.createProject({ name: "Cache shop" }).id as string;
    new UsageStore(platform.db).addUsage({ jobId: "job-ui", projectId, purpose: "authoring", model: "claude-sonnet-5-5", at: new Date(), calls: 12, failedCalls: 0, inputTokens: 120_000, outputTokens: 6_000, images: 0, estimatedCalls: 0, cacheReadTokens: 100_000, cacheWriteTokens: 12_000 });
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    setPromptCacheSource(undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const setting = () => page.getByTestId("prompt-cache-setting");
const usage = () => page.getByTestId("usage-panel");
const openSettings = async () => {
    await page.goto(`${base}/#/settings`);
    await page.reload();
    await pwExpect(setting()).toBeVisible();
};

describe("prompt caching in Settings", () => {
    it("is on by default, says what it does for the model in use, and can be turned off and handed back to the server", async () => {
        await openSettings();
        const box = setting().getByRole("checkbox", { name: /Reuse repeated instructions \(prompt caching\)/ });
        await pwExpect(box).toBeChecked();
        await pwExpect(setting().getByTestId("prompt-cache-explanation")).toContainText("marked for Anthropic’s prompt cache");
        await pwExpect(setting().getByTestId("prompt-cache-source")).toHaveText("On by default.");

        await box.uncheck();
        await pwExpect(box).not.toBeChecked();
        await pwExpect(setting().getByTestId("prompt-cache-source")).toHaveText("Set here. The server’s own setting is on (nothing is set on the server).");
        await pwExpect(setting().getByText("Off: every request is read at the full input price.", { exact: true })).toBeVisible();
        expect(await api("/api/llm/prompt-cache")).toMatchObject({ enabled: false, source: "app" });

        await page.reload();
        await pwExpect(setting().getByRole("checkbox")).not.toBeChecked(); // saved, not only in the page

        await setting().getByRole("button", { name: "Use the server’s setting", exact: true }).click();
        await pwExpect(setting().getByRole("checkbox")).toBeChecked();
        await pwExpect(setting().getByTestId("prompt-cache-source")).toHaveText("On by default.");
        expect(await api("/api/llm/prompt-cache")).toMatchObject({ enabled: true, source: "default" });
    }, 60_000);

    it("AI usage shows the part of the input that came from the cache, and a cached-input price is used for the cost", async () => {
        await openSettings();
        // 8,000 plain + 100,000 x 0.1 + 12,000 x 1.25 + 6,000 out = 39,000 toward the limits
        await pwExpect(usage().getByTestId("usage-month-tokens")).toHaveText("39,000 tokens");
        await pwExpect(usage().getByTestId("usage-month-detail")).toContainText("120,000 in, 6,000 out, 12 calls");
        await pwExpect(usage().getByTestId("usage-cache-detail")).toContainText("100,000 of the input came from the prompt cache and 12,000 went into it.");
        await usage().getByRole("button", { name: "By model", exact: true }).click();
        const table = usage().getByTestId("usage-table");
        await pwExpect(table.getByRole("columnheader", { name: "From cache", exact: true })).toBeVisible();
        await pwExpect(table.getByRole("row", { name: /claude-sonnet-5-5/ })).toContainText("100K");

        await usage().getByLabel("Model name", { exact: true }).fill("claude-sonnet-5-5");
        await usage().getByLabel("Input, per million tokens", { exact: true }).fill("2");
        await usage().getByLabel("Output, per million tokens", { exact: true }).fill("10");
        await usage().getByLabel("Cached input, per million tokens", { exact: true }).fill("0.2");
        await usage().getByLabel("Cache writes, per million tokens", { exact: true }).fill("2.5");
        await usage().getByRole("button", { name: "Save price", exact: true }).click();
        // (8,000 x 2 + 100,000 x 0.2 + 12,000 x 2.5 + 6,000 x 10) / 1M = 0.126
        await pwExpect(usage().getByTestId("usage-cost")).toHaveText("Cost so far: 0.13");
        await pwExpect(usage().getByTestId("usage-price-list")).toContainText("2 in, 10 out, 0.2 cached in, 2.5 cache writes, per million tokens");
    }, 60_000);

    it("has no serious accessibility problems in light or dark, and fits a phone", async () => {
        await openSettings();
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            const result = await new AxeBuilder({ page }).include('[data-testid="prompt-cache-setting"]').include('[data-testid="usage-panel"]').analyze();
            expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help} (${v.nodes[0]?.html.slice(0, 120)})`), scheme).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        // The switch's label row is a comfortable target.
        const row = await setting().locator("label.check").boundingBox();
        expect(row!.height).toBeGreaterThanOrEqual(44);
        await page.setViewportSize({ width: 375, height: 800 });
        await openSettings();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        const box = await setting().boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    }, 60_000);
});
