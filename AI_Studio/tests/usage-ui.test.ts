/**
 * One browser journey through AI usage in the real UI: Settings -> AI usage (empty) -> a real analysis with a scripted model fills it ->
 * set a price (a cost appears) -> set a per-job limit, a project limit and a monthly limit -> a second analysis stops at the job limit
 * and its Overview says "AI limit reached" with a link to Settings, and its technical details show the AI use and the limit that
 * stopped it -> a third analysis is stopped by the monthly limit and Settings says the limit is used up -> axe-clean in light and dark,
 * and nothing spills sideways on a phone.
 * Everything underneath is real (platform, worker, discovery, authoring agent driving Chromium, validation); only the model is a
 * scripted double. Ports: 5772 fixture shop, 5773 platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/usage-ui.test.ts
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
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startMemorySite, type MemorySite } from "./fixtures/memory-site.js";

const SITE_PORT = 5772;
const PLATFORM_PORT = 5773;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

let browser: Browser;
let context: BrowserContext;
let page: Page;
let site: MemorySite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let base: string;

// ── the scripted model (same shape as tests/usage.test.ts) ───────────────────
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
const STEP = { input: 2000, output: 500 };
const OBJECT = { input: 5000, output: 1000 };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        const usage = { inputTokens: { total: STEP.input, noCache: STEP.input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: STEP.output, text: STEP.output, reasoning: 0 } };
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const PLAN = [
    { title: "Browse the product list", journey: "Browse products", startPath: "/products", heading: "Products" },
    { title: "Read the about page", journey: "Read about us", startPath: "/about", heading: "About us" },
];
const scripted: LlmClient = {
    modelName: "scripted-usage",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system }: { system: string }) => {
        scripted.usage.inputTokens += OBJECT.input;
        scripted.usage.outputTokens += OBJECT.output;
        if (/analysing a web application/.test(system)) {
            return {
                siteType: "ecommerce",
                purpose: "A small shop",
                features: ["Browse products"],
                pagePurposes: [],
                journeys: [
                    { name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false },
                    { name: "Read about us", description: "Read the about page", steps: ["Open about"], priority: "low", pages: ["/about"], requiresAuth: false },
                ],
                authenticationMechanisms: [],
            };
        }
        for (const s of PLAN) {
            toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: s.heading } } });
            toolQueue.push({ tool: "finish", input: { result: "complete", explanation: "checked" } });
        }
        return { scenarios: PLAN.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: s.journey, startPath: s.startPath, expectedResults: [`${s.heading} is shown`] })) };
    }) as LlmClient["object"],
};

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; body: any };
};
async function analyse(name: string): Promise<{ projectId: string; jobId: string; status: string }> {
    toolQueue.length = 0;
    const projectId = (await call("POST", "/api/projects", { name })).body.id as string;
    const queued = await call("POST", `/api/projects/${projectId}/test-generation`, { url: SITE, targets: ["web"], maxPages: 6, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false });
    expect(queued.status).toBe(202);
    for (let i = 0; i < 600; i++) {
        const job = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return { projectId, jobId: queued.body.jobId, status: job.status };
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("job did not finish");
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(SITE_PORT);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-usage-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1" }));
    platform.llm = scripted;
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 200);
    worker.start();
    base = `http://127.0.0.1:${PLATFORM_PORT}`;
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const panel = () => page.getByTestId("usage-panel");
const openSettings = async () => {
    await page.goto(`${base}/#/settings`);
    await page.reload();
    await pwExpect(panel().getByRole("heading", { name: "AI usage", exact: true })).toBeVisible();
};

describe("AI usage in the UI", () => {
    let shopA: { projectId: string; jobId: string };
    let shopB: { projectId: string; jobId: string };
    let shopC: { projectId: string; jobId: string };

    it("starts empty and says so: no use yet, no limit, no price", async () => {
        await openSettings();
        await pwExpect(panel().getByTestId("usage-empty")).toContainText("No AI use recorded yet this month");
        await pwExpect(panel().getByTestId("usage-month-limit")).toContainText("No monthly limit is set");
        await pwExpect(panel().getByTestId("usage-month-tokens")).toHaveText("0 tokens");
        await pwExpect(panel().getByText("No prices are built in", { exact: false })).toBeVisible();
    });

    it("shows what a real analysis used: tokens, a bar per day, who used it, and a cost once a price is set", async () => {
        const a = await analyse("Shop A");
        expect(a.status).toBe("COMPLETED");
        shopA = a;
        await openSettings();
        await pwExpect(panel().getByTestId("usage-month-tokens")).toHaveText("22,000 tokens");
        await pwExpect(panel().getByTestId("usage-month-detail")).toContainText("18,000 in, 4,000 out, 6 calls");
        await pwExpect(panel().getByTestId("usage-month-detail")).toContainText("Set a price to see a cost.");
        await pwExpect(panel().getByRole("img", { name: /Tokens per day\. The busiest day was \d{4}-\d{2}-\d{2} with 22K tokens\./ })).toBeVisible();

        // by project, then by purpose and by model
        const table = panel().getByTestId("usage-table");
        await pwExpect(table.getByRole("row", { name: /Shop A/ })).toContainText("6");
        await panel().getByRole("button", { name: "By purpose", exact: true }).click();
        for (const label of ["Understanding the application", "Planning tests", "Writing web tests"]) await pwExpect(table.getByRole("rowheader", { name: label, exact: true })).toBeVisible();
        await panel().getByRole("button", { name: "By model", exact: true }).click();
        await pwExpect(table.getByRole("rowheader", { name: "scripted-usage", exact: true })).toBeVisible();
        await pwExpect(table.getByRole("cell", { name: "no price" })).toBeVisible();

        // a price: the cost appears with the label the person chose
        await panel().getByLabel("Model name", { exact: true }).fill("scripted-usage");
        await panel().getByLabel("Input, per million tokens", { exact: true }).fill("10");
        await panel().getByLabel("Output, per million tokens", { exact: true }).fill("50");
        await panel().getByLabel("Currency label", { exact: true }).fill("USD");
        await panel().getByRole("button", { name: "Save price", exact: true }).click();
        await pwExpect(panel().getByText("Price saved for scripted-usage.", { exact: true })).toBeVisible();
        await pwExpect(panel().getByTestId("usage-cost")).toHaveText("Cost so far: USD 0.38");
        await pwExpect(table.getByRole("cell", { name: "USD 0.38" })).toBeVisible();
        await pwExpect(panel().getByTestId("usage-price-list")).toContainText("scripted-usage");
    }, 240_000);

    it("sets a limit per job, per project and per month with plain feedback, and refuses nonsense", async () => {
        await openSettings();
        // nonsense is refused and says what is allowed
        await panel().getByLabel("Tokens per job", { exact: true }).first().fill("lots");
        await panel().getByRole("button", { name: "Save limits", exact: true }).click();
        await pwExpect(panel().getByText(/Use whole numbers: limits of 1 or more/)).toBeVisible();

        await panel().getByLabel("Tokens per job", { exact: true }).first().fill("15000");
        await panel().getByLabel("Tokens per month, all projects", { exact: true }).fill("40000");
        await panel().getByRole("button", { name: "Save limits", exact: true }).click();
        await pwExpect(panel().getByText("Limits saved. They apply to the next AI call.", { exact: true })).toBeVisible();
        await pwExpect(panel().getByTestId("usage-month-limit")).toContainText("55% of the monthly limit of 40,000 tokens.");
        await pwExpect(panel().getByRole("meter", { name: "AI tokens used this month" })).toHaveAttribute("aria-valuenow", "22000");

        // one project's own limit
        await panel().getByLabel("Project", { exact: true }).selectOption({ label: "Shop A" });
        await panel().getByLabel("Tokens per month", { exact: true }).fill("99999");
        await panel().getByRole("button", { name: "Save project limits", exact: true }).click();
        await pwExpect(panel().getByText("Project limits saved.", { exact: true })).toBeVisible();
        const saved = (await call("GET", `/api/projects/${shopA.projectId}/usage-budget`)).body;
        expect(saved).toMatchObject({ monthlyTokens: 99_999, jobTokens: null });
        const platformBudget = (await call("GET", "/api/usage/budgets")).body.platform;
        expect(platformBudget).toMatchObject({ jobTokens: 15_000, monthlyTokens: 40_000 });
    }, 120_000);

    it("a job stopped by its limit says so on the Overview, with a way to Settings, and in its technical details", async () => {
        const b = await analyse("Shop B");
        shopB = b;
        expect(b.status).toBe("PARTIALLY_COMPLETED");
        await page.goto(`${base}/#/projects/${b.projectId}`);
        await page.reload();
        const callout = page.locator(".callout-warning", { has: page.locator(".title", { hasText: "AI limit reached" }) });
        await pwExpect(callout).toBeVisible();
        await pwExpect(callout).toContainText("The AI token limit for this job was reached. Raise the limit in Settings, or wait until next month.");
        await pwExpect(callout).toContainText("Tests that were already created are kept.");
        // the test it had already made is there
        expect(((await call("GET", `/api/projects/${b.projectId}/tests`)).body as unknown[]).length).toBe(1);

        await page.locator("summary", { hasText: "View technical details" }).click();
        await pwExpect(page.getByTestId("job-ai-use")).toHaveText("14K in, 3K out, 4 calls, cost USD 0.29");
        await pwExpect(page.getByTestId("job-ai-stop")).toContainText("The AI token limit for this job was reached (this job: 17,000 of 15,000 tokens)");
        await pwExpect(page.getByLabel("Activity log")).toContainText("AI use has reached 80% of the limit for this job");

        // the link goes to Settings
        await callout.getByRole("link", { name: "Open settings", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "AI usage", exact: true })).toBeVisible();
    }, 240_000);

    it("a job stopped by the monthly limit says that, and Settings shows the month as used up", async () => {
        const c = await analyse("Shop C");
        shopC = c;
        expect(c.status).toBe("FAILED");
        await page.goto(`${base}/#/projects/${c.projectId}`);
        await page.reload();
        const callout = page.locator(".callout-danger", { has: page.locator(".title", { hasText: "AI limit reached" }) });
        await pwExpect(callout).toBeVisible();
        await pwExpect(callout).toContainText("The AI token limit for this month was reached.");

        await openSettings();
        await pwExpect(panel().getByText("Limit reached", { exact: true })).toBeVisible();
        await pwExpect(panel().getByTestId("usage-month-limit")).toContainText("The monthly limit of 40,000 tokens is used up.");
        await pwExpect(panel().getByTestId("usage-month-tokens")).toHaveText("45,000 tokens");
        // a limit can be raised again: the limit says "no limit" when emptied
        await panel().getByLabel("Tokens per month, all projects", { exact: true }).fill("");
        await panel().getByRole("button", { name: "Save limits", exact: true }).click();
        await pwExpect(panel().getByText("Limits saved. They apply to the next AI call.", { exact: true })).toBeVisible();
        await pwExpect(panel().getByTestId("usage-month-limit")).toContainText("No monthly limit is set");
        expect(shopB.projectId).not.toBe(shopC.projectId);
    }, 240_000);

    it("has no serious accessibility problems in light or dark, and fits a phone", async () => {
        await openSettings();
        await pwExpect(panel().getByTestId("usage-table")).toBeVisible();
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            const result = await new AxeBuilder({ page }).include('[data-testid="usage-panel"]').analyze();
            expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help} (${v.nodes[0]?.html.slice(0, 120)})`), scheme).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 375, height: 800 });
        await openSettings();
        await pwExpect(panel()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        const box = await panel().boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 120_000);
});
