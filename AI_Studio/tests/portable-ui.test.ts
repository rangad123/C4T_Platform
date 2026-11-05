/**
 * "Run it on your own computer" on a test's Code tab, in a real browser against a real platform: the button downloads the test as a zip
 * that runs on its own (package.json with exact versions, lockfile, README), for a test made from steps and for a code test (with the
 * helper it imports); the project's Export dialog says what its zip holds. Keyboard, phone width, both colour schemes (axe).
 * See docs/features/portable-code-tests.md. Ports: 6964 platform (serves web/dist).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/portable-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { strFromU8, unzipSync } from "fflate";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
// @ts-expect-error plain JavaScript script (no type declarations)
import { CODE_HELPER, codeTest, portableSpecs } from "../scripts/portable-check.mjs";

const PORT = 6964;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = "http://127.0.0.1:6965";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId = "";
let webId = "";
let webKey = "";
let codeId = "";
const consoleErrors: string[] = [];

const api = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: payload !== undefined ? { "content-type": "application/json" } : {} });
    return { status: res.statusCode, body: res.body && (res.body.startsWith("{") || res.body.startsWith("[")) ? JSON.parse(res.body) : res.body };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-portable-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", MAX_REPAIR_ATTEMPTS: "0", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await api("POST", "/api/projects", { name: "Portable shop" })).body.id;
    const imp = await api("POST", `/api/projects/${projectId}/specs`, { specs: portableSpecs(APP).slice(0, 1), baseUrl: APP, validate: false });
    expect(imp.status).toBe(202);
    [{ id: webId, testId: webKey }] = imp.body.tests;
    expect((await api("PUT", `/api/projects/${projectId}/helpers/shop`, { content: CODE_HELPER })).status).toBe(200);
    const c = await api("POST", `/api/projects/${projectId}/custom-tests`, { title: "The product list shows four products", kind: "web", category: "Shop", content: codeTest(APP) });
    expect(c.status).toBe(201);
    codeId = c.body.testId;
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const open = async (hash: string) => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
};
const download = async () => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download ready to run", exact: true }).click()]);
    const file = await dl.path();
    return { name: dl.suggestedFilename(), files: Object.fromEntries(Object.entries(unzipSync(new Uint8Array(fs.readFileSync(file!)))).map(([k, v]) => [k, strFromU8(v)])) };
};

describe("Run it on your own computer", () => {
    it("a test made from steps downloads as a folder that runs anywhere", async () => {
        await open(`#/tests/${webId}/code`);
        const section = page.getByRole("region", { name: "Run it on your own computer", exact: true });
        await section.waitFor();
        await expect(section.textContent()).resolves.toContain("npx playwright install");
        const { name, files } = await download();
        expect(name).toBe(`${webKey}.zip`);
        expect(Object.keys(files)).toEqual(expect.arrayContaining(["package.json", "package-lock.json", ".nvmrc", "playwright.config.ts", "README.md", ".gitignore", `specs/${webKey}.json`]));
        expect(Object.keys(JSON.parse(files["package.json"]!).devDependencies)).toEqual(["@playwright/test"]);
    }, 60_000);

    it("a code test brings the helper it imports; the button works from the keyboard", async () => {
        await open(`#/tests/${codeId}/code`);
        const button = page.getByRole("button", { name: "Download ready to run", exact: true });
        await button.waitFor();
        await button.focus();
        const [dl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
        const files = unzipSync(new Uint8Array(fs.readFileSync((await dl.path())!)));
        expect(Object.keys(files).filter((n) => n.startsWith("tests/")).sort()).toEqual(["tests/shop/WEB-002.spec.ts", "tests/shop/helpers/shop.ts"]);
        const box = await button.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
    }, 60_000);

    it("fits a phone without sideways scrolling and passes axe in light and dark", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await open(`#/tests/${webId}/code`);
        await page.getByRole("button", { name: "Download ready to run", exact: true }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400);
            const r = await new AxeBuilder({ page }).include("#runnable-title").analyze();
            const section = await new AxeBuilder({ page }).include("section[aria-labelledby='runnable-title']").analyze();
            expect([...r.violations, ...section.violations].map((v) => `${scheme}: ${v.id}`)).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 60_000);

    it("the project's Export dialog says what the tests zip holds", async () => {
        await open(`#/projects/${projectId}/scripts`);
        await page.getByRole("button", { name: "More actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Export…", exact: true }).click();
        await page.getByText("The tests that pass, as a folder that runs anywhere: exact package versions, a lockfile and a README with three steps.", { exact: true }).waitFor();
        expect(consoleErrors).toEqual([]);
    }, 60_000);
});
