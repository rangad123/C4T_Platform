/**
 * One browser journey through "Write a test" in the real UI: Tests -> Write a test -> describe the test -> Create and run test ->
 * live progress -> "Your test is ready" -> the test's own page shows the sentence -> change the description and rebuild it ->
 * a refused description says why and keeps the words -> Escape closes the dialog and focus returns to the button ->
 * without an AI model the dialog says so and cannot be submitted.
 * Everything underneath is real (platform, worker, authoring agent driving Chromium against a fixture shop, validation); only the model
 * is a scripted double. Ports: 5611 fixture shop, 5612 platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/plain-english-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { MockLanguageModelV3 } from "ai/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { unavailableLlmClient, type LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startPlainSite, type PlainSite } from "./fixtures/plain-site.js";

const FX_PORT = 5611;
const PLATFORM_PORT = 5612;
const FX = `http://127.0.0.1:${FX_PORT}`;

let browser: Browser;
let context: BrowserContext;
let page: Page;
let site: PlainSite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let base: string;
let projectId: string;

type Call = { tool: string; input: Record<string, unknown> };
const queue: Call[] = [];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        const next = queue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const scripted: LlmClient = { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: (async () => ({})) as LlmClient["object"] };
const click = (role: string, name: string): Call => ({ tool: "click", input: { target: { by: "role", role, value: name } } });
const addThenCheck = (product: string, total: string): Call[] => [
    click("link", "Products"),
    click("button", `Add ${product} to cart`),
    { tool: "assert", input: { check: "text", target: { by: "role", role: "status" }, expected: `Total: ${total}` } },
    { tool: "finish", input: { result: "complete", explanation: "Checked the total" } },
];

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; body: any };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startPlainSite(FX_PORT);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plain-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1" }));
    platform.llm = scripted;
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 200);
    worker.start();
    base = `http://127.0.0.1:${PLATFORM_PORT}`;

    projectId = (await call("POST", "/api/projects", { name: "Plain UI" })).body.id;
    const imported = await call("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: FX,
        validate: false,
        specs: [{ testId: "WEB-001", title: "Home shows the shop name", kind: "web", category: "Imported", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Plain Shop" } }] }],
    });
    expect(imported.status).toBe(202);
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); // axe-core refuses pages that were not made through a context
    page = await context.newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await site?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const dialog = () => page.getByRole("dialog", { name: "Write a test", exact: true });
/** The New test button (the focus goes back to it when the dialog closes) and the menu entry that opens the dialog. */
const writeButton = () => page.getByRole("button", { name: "New test script", exact: true });
const openDescribe = async () => {
    await writeButton().click();
    await page.getByRole("menuitem", { name: "Describe it", exact: true }).click();
};
const box = () => dialog().getByLabel("Describe what the test should do", { exact: true });
const SENTENCE = "Add the Blue Mug to the cart and check the total shows $12.00";

describe("Write a test in the UI", () => {
    it("opens a dialog with the cursor in the text box, examples as hints, and a button that waits for words", async () => {
        await page.goto(`${base}/#/projects/${projectId}/scripts`);
        await pwExpect(page.getByRole("heading", { name: "Scripts", exact: true })).toBeVisible();
        await openDescribe();
        await pwExpect(dialog()).toBeVisible();
        await pwExpect(box()).toBeFocused();
        await pwExpect(box()).toHaveAttribute("placeholder", /Add a product to the cart and check that the total is shown/);
        await pwExpect(dialog().getByRole("button", { name: "Create and run test", exact: true })).toBeDisabled();
        // An example fills the box.
        await dialog().getByRole("button", { name: "Search for “mug” and check that at least one result is listed", exact: true }).click();
        await pwExpect(box()).toHaveValue("Search for “mug” and check that at least one result is listed");
        await box().fill("");
        await pwExpect(dialog().getByText("0 of 2000", { exact: true })).toBeVisible();
    });

    it("has no serious accessibility problems in light or dark, and fits a phone", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            const result = await new AxeBuilder({ page }).include("dialog.write-test").analyze();
            expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help}`), scheme).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 375, height: 700 });
        await pwExpect(dialog()).toBeVisible();
        const box = await dialog().boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("says why a description is refused and keeps the words; Escape closes the dialog and gives the focus back", async () => {
        await box().fill("Add a product and pay with the credit card number from my wallet");
        await dialog().getByRole("button", { name: "Create and run test", exact: true }).click();
        await pwExpect(dialog().getByText("We couldn’t start the test", { exact: true })).toBeVisible();
        await pwExpect(dialog().getByText(/We don’t build tests that pay for something/)).toBeVisible();
        await pwExpect(box()).toHaveValue(/credit card number/);
        await page.keyboard.press("Escape");
        await pwExpect(dialog()).toBeHidden();
        await pwExpect(writeButton()).toBeFocused();
        expect((await call("GET", `/api/projects/${projectId}/jobs`)).body).toHaveLength(0);
    });

    it("builds, runs and links the test, which then shows its sentence", async () => {
        queue.push(...addThenCheck("Blue Mug", "$12.00"));
        await openDescribe();
        await box().fill(SENTENCE);
        await dialog().getByRole("button", { name: "Create and run test", exact: true }).click();
        await pwExpect(dialog().getByRole("heading", { name: "Building your test", exact: true })).toBeVisible();
        await pwExpect(dialog().getByText("Your test is ready and it passed", { exact: true })).toBeVisible({ timeout: 120_000 });
        await dialog().getByRole("link", { name: "Open the test", exact: true }).click();

        await pwExpect(page.getByRole("heading", { name: SENTENCE, exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("plain-origin")).toContainText("Written in plain English");
        await pwExpect(page.getByTestId("plain-origin")).toContainText(SENTENCE);
        await pwExpect(page.getByText("Passing", { exact: true }).first()).toBeVisible();
        await pwExpect(page.getByText(/Click .*Add Blue Mug to cart/).first()).toBeVisible();
    }, 180_000);

    it("lists the new test on the Tests page and the run on the Runs page", async () => {
        await page.goto(`${base}/#/projects/${projectId}/scripts`);
        await pwExpect(page.getByRole("button", { name: "Plain English", exact: false }).first()).toBeVisible();
        await pwExpect(page.getByRole("link", { name: new RegExp(SENTENCE.replace(/[$.]/g, "\\$&")) })).toBeVisible();
        await page.goto(`${base}/#/projects/${projectId}/runs`);
        await pwExpect(page.getByRole("heading", { name: "Test from a description", exact: true })).toBeVisible();
        await pwExpect(page.getByText("Test ready", { exact: true }).first()).toBeVisible();
    });

    it("rebuilds the test from a changed description", async () => {
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; suite: string }>;
        const plain = tests.find((t) => t.suite === "Plain English")!;
        await page.goto(`${base}/#/tests/${plain.id}`);
        queue.push(...addThenCheck("Red Plate", "$8.50"));
        await page.getByRole("button", { name: "Change the description", exact: true }).click();
        const rewriteDialog = page.getByRole("dialog", { name: "Change the description", exact: true });
        await pwExpect(rewriteDialog).toBeVisible();
        const field = rewriteDialog.getByLabel("Describe what the test should do", { exact: true });
        await pwExpect(field).toHaveValue(SENTENCE);
        await field.fill("Add the Red Plate to the cart and check the total shows $8.50");
        await rewriteDialog.getByRole("button", { name: "Rebuild and run test", exact: true }).click();
        await pwExpect(rewriteDialog.getByText("Your test was rebuilt and passed", { exact: true })).toBeVisible({ timeout: 120_000 });
        await rewriteDialog.getByRole("button", { name: "Close", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Add the Red Plate to the cart and check the total shows $8.50", exact: true })).toBeVisible();
        expect(((await call("GET", `/api/projects/${projectId}/tests`)).body as unknown[]).length).toBe(2);
    }, 180_000);

    it("says so when no AI model is set up, and cannot be submitted", async () => {
        platform.llm = unavailableLlmClient("no key");
        try {
            await page.goto(`${base}/#/projects/${projectId}/scripts`);
            await page.reload(); // the server's capabilities are read once per page load
            await openDescribe();
            await pwExpect(dialog().getByText("The AI model isn’t set up yet", { exact: true })).toBeVisible();
            await box().fill(SENTENCE);
            await pwExpect(dialog().getByRole("button", { name: "Create and run test", exact: true })).toBeDisabled();
        } finally {
            platform.llm = scripted;
        }
    });
});
