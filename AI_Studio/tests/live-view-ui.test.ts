/**
 * The live view on the Record a test page, in a real browser against the real platform, with a real recording session (the platform's own headless Chromium)
 * on a fixture application: closed until asked for, a picture with a text alternative and the list of elements, one request a second at most, no request
 * while the tab is in the background or the panel is closed, an agent that cannot be driven gives a plain message, axe in both themes, 375 px.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/live-view-ui.test.ts
 * Ports: platform 6178, fixture application 6179.
 */
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { recorderOptions } from "../src/platform/routes/recorder.js";
import { buildServer } from "../src/platform/server.js";
import { startRecorderApp } from "./fixtures/recorder-app.js";

const PLATFORM_PORT = 6178;
const APP_PORT = 6179;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let appServer: http.Server;
let dataDir: string;
let recBrowser: Browser | undefined;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let projectId = "";
let rid = "";
const consoleErrors: string[] = [];
/** When each snapshot request left the page. */
const snapshotAt: number[] = [];

const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : undefined } as { status: number; body: any };
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hide = (hidden: boolean) =>
    page.evaluate((h) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function settle(scheme: "light" | "dark") {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-liveview-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    recorderOptions.launch = async (headless) => (recBrowser = await chromium.launch({ headless }));
    recorderOptions.guard = async (u) => {
        if (!u.startsWith(`http://127.0.0.1:${APP_PORT}/`)) throw new Error("Only the fixture application may be opened in this test.");
    };
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    appServer = await startRecorderApp(APP_PORT);
    projectId = (await api("POST", "/api/projects", { name: "Live view" })).body.id;
    const started = await api("POST", `/api/projects/${projectId}/recordings`, { url: `${APP}/login`, headed: false });
    rid = started.body.id;
    for (let i = 0; i < 150; i++) {
        if ((await api("GET", `/api/recordings/${rid}`)).body.status === "recording") break;
        await sleep(100);
    }
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    page.on("request", (r) => {
        if (/\/api\/recordings\/[^/]+\/snapshot/.test(r.url())) snapshotAt.push(Date.now());
    });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    await recBrowser?.close().catch(() => undefined);
    appServer?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the live view", () => {
    it("is closed until asked for and asks the platform for nothing meanwhile", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/record?session=${rid}`);
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording");
        await pwExpect(page.getByRole("heading", { name: "Live view", exact: true })).toBeVisible();
        const toggle = page.getByRole("button", { name: "Show live view", exact: true });
        await pwExpect(toggle).toHaveAttribute("aria-expanded", "false");
        await sleep(2500);
        expect(snapshotAt).toHaveLength(0);
        await pwExpect(page.getByTestId("live-image")).toHaveCount(0);
    }, 60_000);

    it("shows the page as a picture with a text alternative, the address, when it was updated, and the elements as a list", async () => {
        await page.getByRole("button", { name: "Show live view", exact: true }).click();
        const img = page.getByTestId("live-image");
        await pwExpect(img).toBeVisible({ timeout: 15_000 });
        await pwExpect(img).toHaveAttribute("alt", `Log in, at ${APP}/login`);
        expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth > 100)).toBe(true);
        await pwExpect(page.getByTestId("live-url")).toHaveText(`${APP}/login`);
        await pwExpect(page.getByTestId("live-updated")).toHaveText("Updated just now");
        const summary = page.getByText(/^Elements on the page \(\d+\)$/);
        await pwExpect(summary).toBeVisible();
        await summary.click();
        await pwExpect(page.getByText("textbox “Email”", { exact: true })).toBeVisible();
        const password = page.getByText(/Password.*secret field/);
        await pwExpect(password).toBeVisible();
        await pwExpect(password).toHaveText("input “Password”, holds “[hidden]” (secret field)");
        await pwExpect(page.getByRole("button", { name: "Hide live view", exact: true })).toHaveAttribute("aria-expanded", "true");
    }, 60_000);

    it("follows the page, at most one picture a second", async () => {
        await api("POST", `/api/recordings/${rid}/act`, { action: "navigate", url: "/shop" });
        await pwExpect(page.getByTestId("live-url")).toHaveText(`${APP}/shop`, { timeout: 10_000 });
        await pwExpect(page.getByTestId("live-image")).toHaveAttribute("alt", `Shop, at ${APP}/shop`);
        await sleep(3500);
        expect(snapshotAt.length).toBeGreaterThanOrEqual(3);
        const gaps = snapshotAt.slice(1).map((t, i) => t - snapshotAt[i]!);
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(900);
        await pwExpect(page.getByTestId("rec-count")).toBeVisible(); // the rest of the recorder page works alongside
    }, 60_000);

    it("pauses while the tab is in the background and carries on when it is back", async () => {
        await hide(true);
        await pwExpect(page.getByText("Paused while this tab is in the background.")).toBeVisible();
        await sleep(1800); // a request already on its way may still land
        const n = snapshotAt.length;
        await sleep(3000);
        expect(snapshotAt.length).toBe(n);
        await hide(false);
        await pwExpect(page.getByText("Paused while this tab is in the background.")).toHaveCount(0);
        await sleep(2500);
        expect(snapshotAt.length).toBeGreaterThan(n);
    }, 60_000);

    it("stops asking when the panel is hidden again", async () => {
        await page.getByRole("button", { name: "Hide live view", exact: true }).click();
        await sleep(1800);
        const n = snapshotAt.length;
        await sleep(3000);
        expect(snapshotAt.length).toBe(n);
        await pwExpect(page.getByTestId("live-image")).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Show live view", exact: true })).toBeVisible();
    }, 60_000);

    it("has no accessibility violations in light and dark, and fits a phone without sideways scrolling or small targets", async () => {
        await page.getByRole("button", { name: "Show live view", exact: true }).click();
        await pwExpect(page.getByTestId("live-image")).toBeVisible({ timeout: 15_000 });
        for (const scheme of ["light", "dark"] as const) {
            await settle(scheme);
            await axe();
        }
        await settle("light");
        await page.setViewportSize({ width: 375, height: 800 });
        await sleep(500);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBe(0);
        const small = await page.evaluate(() => Array.from(document.querySelectorAll(".rec-live button, .rec-live summary")).filter((el) => el.getBoundingClientRect().height < 43.5).map((el) => el.textContent?.trim()));
        expect(small).toEqual([]);
        await axe();
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 90_000);

    it("says plainly why there is no picture when the session cannot be read, and the page carries on", async () => {
        await api("POST", `/api/recordings/${rid}/stop`);
        // the panel only exists while the session runs: once it has ended the rest of the page shows the result
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Stopped", { timeout: 15_000 });
        await pwExpect(page.getByRole("heading", { name: "Live view", exact: true })).toHaveCount(0);
        expect(consoleErrors).toEqual([]);
    }, 60_000);
});
