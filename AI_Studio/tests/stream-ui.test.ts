/**
 * Live updates in a real browser (Chromium): the Overview of a running job shows the newest step as it happens, without a reload; the
 * activity log fills live (pause, resume, follow only at the bottom, fade-in off with reduced motion); when the stream is lost the page says
 * so, keeps updating by polling, and goes back to live by itself; the Runs page marks the running job; axe-clean in light and dark,
 * no sideways scroll on a phone.
 *
 * The platform is real (real stream routes, real database); events are written the way the worker writes them (`repo.addEvent`).
 * Requires web/dist:
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/stream-ui.test.ts
 * Set AL_SHOTS=<folder> to also write screenshots (light and dark, 1280 and 390 wide).
 * Ports: platform 5975.
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
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getStreamHub } from "../src/platform/routes/stream.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 5975;
const BASE = `http://127.0.0.1:${PORT}`;
const shots = process.env.AL_SHOTS;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let projectId: string;
let jobId: string;

const ev = (message: string, level: "info" | "warn" | "error" = "info") => platform.repo.addEvent(jobId, { stage: "validation", kind: "agent_progress", level, message });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const overview = () => `${BASE}/#/projects/${projectId}`;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-stream-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = platform.repo.createProject({ name: "Atlas shop" }).id;
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5999", { ...DEFAULT_JOB_OPTIONS }, undefined);
    jobId = (await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] })).id;
    platform.repo.setJobStatus(jobId, "VALIDATING");
    platform.repo.setPhase(jobId, "validation", "running");
    ev("Sent 3 script(s) to a runner agent.");
    ev("Maya's laptop: Running 3 scripts");
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function noOverflow() {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
}
const status = () => page.locator(".live-line [role=status]").first();
const logLines = () => page.locator(".log > div");

describe("live updates in the browser", () => {
    it("the Overview shows the newest step as it happens, without a reload", async () => {
        await page.goto(overview());
        await page.evaluate(() => ((window as unknown as { __marker: string }).__marker = "same page"));
        await pwExpect(page.getByRole("heading", { name: "Running your tests", exact: true })).toBeVisible();
        await pwExpect(status()).toContainText("Running 3 scripts", { timeout: 10_000 });
        ev("Maya's laptop: Finished 1 of 3 tests: Check home page (passed)");
        await pwExpect(status()).toContainText("Finished 1 of 3 tests", { timeout: 3_000 });
        ev("Maya's laptop: Finished 2 of 3 tests: Check pricing page (passed)");
        await pwExpect(status()).toContainText("Finished 2 of 3 tests", { timeout: 3_000 });
        expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe("same page");
        // only the newest status is a live region, not every log line
        expect(await page.locator("[aria-live]").count()).toBeLessThanOrEqual(2);
    });

    it("the activity log fills live; Pause holds the view; it follows new lines only at the bottom", async () => {
        await page.getByText("View technical details").click();
        await pwExpect(logLines().first()).toBeVisible();
        await pwExpect(logLines().filter({ hasText: "Finished 2 of 3 tests" })).toHaveCount(1);
        ev("Maya's laptop: Uploading screenshots and other files");
        await pwExpect(logLines().filter({ hasText: "Uploading screenshots" })).toHaveCount(1, { timeout: 3_000 });

        await page.getByRole("button", { name: "Pause updates", exact: true }).click();
        const before = await logLines().count();
        ev("Maya's laptop: Finished 3 of 3 tests: Check cart (failed)", "warn");
        await sleep(1_200);
        expect(await logLines().count()).toBe(before);
        await pwExpect(page.getByRole("button", { name: "Resume updates (1 new)", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Resume updates (1 new)", exact: true }).click();
        await pwExpect(logLines().filter({ hasText: "Finished 3 of 3 tests" })).toHaveCount(1);

        // many lines while the reader is at the bottom: the log follows; scrolled up: it stays where the reader is
        for (let i = 0; i < 40; i++) ev(`step ${i}`);
        await pwExpect(logLines().filter({ hasText: "step 39" })).toHaveCount(1, { timeout: 4_000 });
        const atBottom = () => page.locator(".log").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 30);
        expect(await atBottom()).toBe(true);
        await page.locator(".log").evaluate((el) => (el.scrollTop = 0));
        await sleep(200);
        ev("while reading older lines");
        await pwExpect(logLines().filter({ hasText: "while reading older lines" })).toHaveCount(1, { timeout: 3_000 });
        expect(await page.locator(".log").evaluate((el) => el.scrollTop)).toBeLessThan(50);
        await page.locator(".log").evaluate((el) => (el.scrollTop = el.scrollHeight));
    });

    it("new lines fade in, and not at all when the person prefers reduced motion", async () => {
        const animation = () => logLines().last().evaluate((el) => getComputedStyle(el).animationName);
        ev("a line with motion");
        await pwExpect(logLines().last()).toContainText("a line with motion");
        // the fade lasts 140 ms; check it was applied by looking at the class right away is racy, so look at the rule instead
        const rule = await page.evaluate(() => Array.from(document.styleSheets).flatMap((s) => { try { return Array.from(s.cssRules); } catch { return []; } }).some((r) => r instanceof CSSKeyframesRule && r.name === "log-in"));
        expect(rule).toBe(true);
        await page.emulateMedia({ reducedMotion: "reduce" });
        ev("a line without motion");
        await pwExpect(logLines().last()).toContainText("a line without motion");
        await sleep(300);
        expect(await animation()).toBe("none");
        await page.emulateMedia({ reducedMotion: null });
    });

    it("when the stream is lost the page says so, keeps updating by polling, and goes live again by itself", async () => {
        // new streams cannot be set up (no tickets), and the open one is cut
        await page.route("**/api/stream-tickets", (r) => r.abort());
        getStreamHub(platform)!.closeAll();
        await pwExpect(page.getByText("Live updates paused, retrying", { exact: false }).first()).toBeVisible({ timeout: 5_000 });
        // polling carries the log meanwhile (every 3 s)
        ev("written while the stream was down");
        await pwExpect(logLines().filter({ hasText: "written while the stream was down" })).toHaveCount(1, { timeout: 9_000 });
        // no layout jump: the status line keeps its height
        const h1 = await page.locator(".live-line").first().evaluate((el) => el.getBoundingClientRect().height);
        expect(h1).toBeGreaterThanOrEqual(20);
        await shot("retrying-light-1280");
        await page.unroute("**/api/stream-tickets");
        await pwExpect(page.getByText("Live updates paused, retrying", { exact: false })).toHaveCount(0, { timeout: 20_000 });
        ev("back on the stream");
        await pwExpect(status()).toContainText("back on the stream", { timeout: 3_000 });
        // nothing was lost or repeated across the cut
        const texts = await logLines().allInnerTexts();
        expect(new Set(texts).size).toBe(texts.length);
        expect(texts.filter((t) => t.includes("written while the stream was down"))).toHaveLength(1);
    });

    it("the Runs page marks the running job as live and shows its newest step", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runs`);
        await page.reload();
        await pwExpect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
        await pwExpect(page.locator(".live-badge").first()).toContainText("Live", { timeout: 10_000 });
        ev("the newest step of the run");
        await pwExpect(page.getByText("the newest step of the run").first()).toBeVisible({ timeout: 3_000 });
        await axe();
    });

    for (const scheme of ["light", "dark"] as const) {
        it(`is axe-clean and fits a phone in ${scheme} mode, live`, async () => {
            await page.emulateMedia({ colorScheme: scheme });
            await page.goto(overview());
            await page.reload();
            await pwExpect(status()).toContainText("the newest step of the run", { timeout: 10_000 });
            await page.getByText("View technical details").click();
            await pwExpect(logLines().first()).toBeVisible();
            await page.waitForTimeout(400); // colours ease over 140 ms
            await axe();
            await shot(`overview-live-${scheme}-1280`);
            await page.setViewportSize({ width: 390, height: 844 });
            await page.waitForTimeout(400);
            await noOverflow();
            await axe();
            await shot(`overview-live-${scheme}-390`);
            await page.setViewportSize({ width: 1280, height: 900 });
        });
    }

    it("when the run ends the page moves on to the result", async () => {
        await page.emulateMedia({ colorScheme: null });
        await page.goto(overview());
        await page.reload();
        await pwExpect(page.getByRole("heading", { name: "Running your tests", exact: true })).toBeVisible();
        platform.repo.setJobStatus(jobId, "COMPLETED");
        await pwExpect(page.getByRole("heading", { name: "Running your tests", exact: true })).toHaveCount(0, { timeout: 8_000 });
        await sleep(300);
        expect(getStreamHub(platform)!.stats().open).toBe(0);
    });
});
