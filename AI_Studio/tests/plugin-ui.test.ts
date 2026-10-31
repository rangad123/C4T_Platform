/**
 * Adapter plug-ins in the Frameworks section of the Runners tab, in a real browser against the built UI (web/dist) and a real platform
 * with the real example plug-in loaded (and one broken plug-in): the plug-in framework is listed with a "Plug-in" label, the plug-in that
 * failed to load is explained in words, nothing shows while the feature is unused, light and dark are accessible, a phone fits.
 * Run: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/plugin-ui.test.ts
 * Ports 6271 (platform with plug-ins) and 6272 (platform without).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { loadConfiguredPlugins, unloadPlugins } from "../src/engine/frameworks/plugin-loader.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { addTest, seedProject, type Seed } from "./fixtures/dashboard-seed.js";

const PORT = 6271;
const PORT_PLAIN = 6272;
const KEY = "plugin-ui-key-77aa";
const EXAMPLE = path.join(REPO_ROOT, "examples", "adapter-plugin");
const quiet = { warn: () => undefined, log: () => undefined };

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dir: string;
let brokenDir: string;
let shop: Seed;
const consoleErrors: string[] = [];
const url = (port: number, projectId: string) => `http://127.0.0.1:${port}/#/projects/${projectId}/settings?section=frameworks`;
const open = async (target: string) => {
    await page.goto("about:blank");
    await page.goto(target);
    await page.getByRole("button", { name: "Change frameworks", exact: true }).click(); // Frameworks is a titled row in Settings
    await pwExpect(page.getByTestId("frameworks").getByRole("heading", { name: "Web tests" })).toBeVisible();
};
const section = () => page.getByTestId("frameworks");

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plugin-ui-"));
    brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plugin-ui-broken-"));
    const broken = path.join(brokenDir, "broken-plugin");
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, "plugin.json"), JSON.stringify({ name: "broken-plugin", version: "0.1.0", apiVersion: 1, adapters: [{ id: "broken-one", label: "Broken" }] }));
    fs.writeFileSync(path.join(broken, "adapter.mjs"), `throw new Error("this plug-in cannot start");\n`);
    const config = loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), API_KEY: KEY, ALLOW_ADAPTER_PLUGINS: "true", ADAPTER_PLUGINS: [EXAMPLE, broken].join(";") });
    platform = bootstrap(config);
    await loadConfiguredPlugins(config, quiet);
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    shop = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    addTest(platform, shop, "health");
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // about:blank has no storage: the key is only set on the platform's own pages.
    await context.addInitScript((key) => {
        try {
            localStorage.setItem("aitp.apiKey", key);
        } catch {
            /* no storage on this page */
        }
    }, KEY);
    page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 90_000);

afterAll(async () => {
    await browser?.close();
    unloadPlugins();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(brokenDir, { recursive: true, force: true });
});

describe("plug-in frameworks in the Frameworks section", () => {
    it("lists the loaded plug-in framework with a Plug-in label and explains the one that failed, in words", async () => {
        await open(url(PORT, shop.projectId));
        const group = page.getByTestId("fw-plugins");
        await pwExpect(group.getByRole("heading", { name: "Plug-in frameworks", exact: true })).toBeVisible();
        const item = group.getByTestId("fw-plugin-node-http-check");
        await pwExpect(item).toContainText("Node HTTP check (example plug-in)");
        await pwExpect(item).toContainText("From the plug-in node-http-check 1.0.0, runs API tests on this server.");
        await pwExpect(item.getByText("Plug-in", { exact: true })).toBeVisible();
        await pwExpect(group.getByRole("alert")).toContainText("broken-plugin did not load");
        await pwExpect(group.getByRole("alert")).toContainText("this plug-in cannot start");
        await pwExpect(group.getByRole("alert")).toContainText("The rest of the platform works as usual.");
        await pwExpect(group.getByText("Plug-ins are turned on and off by whoever runs the server, not from this page.", { exact: false })).toBeVisible();
        // The built-in frameworks are still there and unchanged.
        for (const name of ["Web tests", "API tests", "Android tests", "Windows desktop tests"]) await pwExpect(section().getByRole("heading", { name, exact: true })).toBeVisible();
        // No server folder anywhere on the page.
        const text = (await page.locator("body").innerText()) + (await page.content());
        expect(text).not.toContain(brokenDir);
        expect(text).not.toContain(KEY);
    });

    it("shows a plug-in test with the plug-in's own name and a Plug-in badge, never the raw framework id", async () => {
        const spec = TestSpecSchema.parse({ testId: "API-900", title: "Reads items through the plug-in", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/items" }, { action: "assertResponse", check: "status", expected: 200 }] });
        const suite = platform.repo.getOrCreateSuite(shop.projectId, "API", "api");
        const id = platform.repo.insertTest({ projectId: shop.projectId, suiteId: suite, jobId: null, spec, framework: "node-http-check", validationStatus: "PENDING" });
        platform.repo.addScript(id, { framework: "node-http-check", filename: "API-900.node-http-check.mjs", content: "// a script", hash: "h-plugin-ui", storagePath: "x/plugin-ui", executable: true });
        const heading = page.getByRole("heading", { name: "Reads items through the plug-in", exact: true });
        const openTest = async () => {
            await page.goto("about:blank");
            await page.goto(`http://127.0.0.1:${PORT}/#/tests/${id}`);
            await pwExpect(heading).toBeVisible();
        };
        await openTest();
        const main = page.locator("main");
        await pwExpect(main.getByText("Plug-in", { exact: true })).toBeVisible();
        // before the Code tab is opened, the raw id is nowhere in the words of the page
        expect(await main.innerText()).not.toContain("node-http-check");
        // the Code tab names the format in words, and so do the technical details
        await page.getByRole("tab", { name: "Code", exact: true }).click();
        await pwExpect(main.getByText("Node HTTP check (example plug-in)", { exact: true }).first()).toBeVisible();
        await main.getByText("View technical details", { exact: true }).click();
        await pwExpect(main.getByText("Runs with", { exact: true })).toBeVisible();
        await pwExpect(main.locator("dd", { hasText: "Node HTTP check (example plug-in)" })).toBeVisible();
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await openTest();
            await page.waitForTimeout(400);
            const results = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
            expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), scheme).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: null });
        // a built-in test of the same project shows no Plug-in badge
        const plain = addTest(platform, shop, "plain-one");
        await page.goto("about:blank");
        await page.goto(`http://127.0.0.1:${PORT}/#/tests/${plain}`);
        await pwExpect(page.getByRole("heading", { name: "Check plain-one", exact: true })).toBeVisible();
        await pwExpect(page.locator("main").getByText("Plug-in", { exact: true })).toHaveCount(0);
    });

    it("is accessible in light and dark, fits a phone, and raised no console errors", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await open(url(PORT, shop.projectId));
            await pwExpect(page.getByTestId("fw-plugins")).toBeVisible();
            await page.waitForTimeout(400);
            const results = await new AxeBuilder({ page }).include('[data-testid="frameworks"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
            expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), scheme).toEqual([]);
        }
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.setViewportSize({ width: 375, height: 800 });
            await open(url(PORT, shop.projectId));
            await pwExpect(page.getByTestId("fw-plugins")).toBeVisible();
            await page.waitForTimeout(400);
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(over, `horizontal overflow in ${scheme}`).toBeLessThanOrEqual(0);
            const results = await new AxeBuilder({ page }).include('[data-testid="frameworks"]').analyze();
            expect(results.violations.map((v) => v.id), scheme).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
        expect(consoleErrors).toEqual([]);
    });

    it("shows nothing about plug-ins while the feature is unused", async () => {
        unloadPlugins();
        const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plugin-ui-plain-"));
        const plain = bootstrap(loadConfig({ DATA_DIR: plainDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT_PLAIN) }));
        const plainServer = await buildServer(plain);
        await plainServer.listen({ port: PORT_PLAIN, host: "127.0.0.1" });
        try {
            const seed = seedProject(plain, "Plain shop", "https://plain.example.test");
            await open(url(PORT_PLAIN, seed.projectId));
            await page.waitForTimeout(500);
            await pwExpect(page.getByTestId("fw-plugins")).toHaveCount(0);
            await pwExpect(page.getByText("Plug-in frameworks")).toHaveCount(0);
        } finally {
            await plainServer.close();
            plain.db.close();
            fs.rmSync(plainDir, { recursive: true, force: true });
        }
    });
});
