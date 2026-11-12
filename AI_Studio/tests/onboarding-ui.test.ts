/**
 * UX-E in a real browser: the first run. Three equal ways to start, a plan to read before anything is created, tests appearing
 * as they are made, and a list of next steps that ticks itself, plus the usual bar (keyboard, phone width, touch targets, axe in
 * light and dark).
 *
 * The platform underneath is real: a worker runs real jobs against a small local site (tests/fixtures/memory-site.ts) with a
 * scripted model double, so a plan is made by the real exploration and the tests are really created and run. Where a state is hard
 * to hold still (a job in the middle of planning, a stopped run, a plan that was discarded) the page's own requests for that one
 * project are answered by the test; those cases say so in their names.
 *
 * Ports: 8791 platform + UI, 8792 site.
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/onboarding-ui.test.ts
 * Set UXE_SHOTS=<folder> to also write screenshots.
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

const PORT = 8791;
const SITE_PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let site: MemorySite;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];

// ── the scripted model (same shape as tests/onboarding-plan.test.ts) ──────────
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const IDEAS = [
    { title: "Browse the product list", journey: "Browse products", startPath: "/products", heading: "Products" },
    { title: "Read the about page", journey: "Read about us", startPath: "/about", heading: "About us" },
] as const;
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system }: { system: string }) => {
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
        for (const s of IDEAS) {
            toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: s.heading } } });
            toolQueue.push({ tool: "finish", input: { result: "complete", explanation: "checked" } });
        }
        return {
            scenarios: IDEAS.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: s.journey, startPath: s.startPath, expectedResults: [`${s.heading} is shown`] })),
        };
    }) as LlmClient["object"],
};

const api = async (method: string, url: string, payload?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
};
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
async function finished(jobId: string): Promise<any> {
    for (let i = 0; i < 600; i++) {
        const job = (await api("GET", `/api/test-generation/${jobId}`)).body;
        if (DONE.includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("the job did not finish");
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(SITE_PORT);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-onboarding-ui-"));
    // A key is set (never used: the worker's model is the double) so the page sees an AI model that is set up.
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", LLM_API_KEY: "test-key-not-real", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1", SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── harness ─────────────────────────────────────────────────────────────────
const shots = process.env.UXE_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
/** A fresh load (a hash change alone would not re-run the page's loads). */
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.locator("h1").first()).toBeVisible();
}
async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs, .subtabs") && !el.closest("pre"))
            .filter((el) => !Array.from(el.children).some((c) => c.getBoundingClientRect().right > document.documentElement.clientWidth + 1))
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? "").trim().slice(0, 40)}"`),
    );
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect({ overflow, wide }, page.url()).toEqual({ overflow: 0, wide: [] });
}
async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
/** Light and dark, with the colour transition settled. `before` re-opens whatever a fresh load closes. */
async function axeBoth(before?: () => Promise<void>) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await before?.();
        await page.waitForTimeout(400);
        await axe();
    }
    await page.emulateMedia({ colorScheme: null });
    await page.waitForTimeout(400);
}
async function tallEnough(locator: ReturnType<Page["locator"]>, what: string) {
    const box = await locator.boundingBox();
    expect(box?.height ?? 0, `${what} is at least 44 px tall`).toBeGreaterThanOrEqual(43.5);
}
const contentText = () => page.evaluate(() => document.querySelector(".content")?.textContent ?? "");

/** The platform's own answers for one project's job, replaced for a state that is hard to hold still. */
const NOW = () => new Date().toISOString();
const PROGRESS = { discovery: "pending", understanding: "pending", planning: "pending", generation: "pending", validation: "pending" };
const COUNTERS = { pagesDiscovered: 0, apisDiscovered: 0, journeysIdentified: 0, scenariosPlanned: 0, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, scenariosSkipped: 0 };
function fakeJob(projectId: string, over: Record<string, unknown>) {
    return { jobId: "job-fake", projectId, status: "PLANNING", mode: "generate", trigger: "manual", scheduleId: null, runbookRunId: null, environment: null, deploy: null, progress: PROGRESS, counters: COUNTERS, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, error: null, createdAt: NOW(), startedAt: NOW(), finishedAt: null, ...over };
}
async function fakeLatestJob(projectId: string, over: Record<string, unknown>) {
    const real = (await api("GET", `/api/projects/${projectId}`)).body;
    await page.route(`**/api/projects/${projectId}`, (route) => route.fulfill({ json: { ...real, latestJob: fakeJob(projectId, over) } }));
}
const runAnswer = (projectId: string, job: Record<string, unknown>, tests: Array<Record<string, unknown>>, counts: Record<string, number>) => ({
    job,
    jobId: "job-fake",
    projectId,
    mode: "generate",
    active: !DONE.includes(String(job.status)),
    counts: { planned: tests.length, ran: 0, passed: 0, failed: 0, findings: 0, running: 0, waiting: 0, notRun: 0, ...counts },
    tests,
    startedBy: { kind: "person" },
    changes: null,
});


// ── the first screen ────────────────────────────────────────────────────────

describe("the first screen", () => {
    it("a first visit offers three equal ways to start, says what each does, and keeps the short explainer", async () => {
        await visit("");
        await pwExpect(page.getByRole("heading", { name: "Test any web application automatically", level: 1 })).toBeVisible();
        const group = page.getByRole("group", { name: "Ways to start", exact: true });
        const names = await group.getByRole("heading", { level: 2 }).allTextContents();
        expect(names).toEqual(["Explore my app", "Record a test", "Start from tests I have"]);
        // Said before anything is done: what it uses, what it needs, and that nothing is created without a yes.
        await pwExpect(group).toContainText("Nothing is created or run until you say so.");
        await pwExpect(page.getByTestId("ai-note")).toContainText("Uses the AI model");
        await pwExpect(group).not.toContainText("isn’t set up");
        await pwExpect(group.getByText("No AI needed.", { exact: false })).toHaveCount(2);
        await pwExpect(page.getByText("2. We explore and show a plan")).toBeVisible();
        // The cards are siblings of equal width, in one row on a wide screen.
        const boxes = await group.locator(".welcome-card").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
        expect(boxes.length).toBe(3);
        expect(Math.abs(boxes[0]!.width - boxes[1]!.width)).toBeLessThan(2);
        expect(Math.abs(boxes[1]!.width - boxes[2]!.width)).toBeLessThan(2);
        expect(boxes[0]!.top).toBeCloseTo(boxes[2]!.top, 0);
        await shot("welcome-light-1280");
    });

    it("without the AI model the first card says so plainly and links to Settings; the other two still work", async () => {
        await page.route("**/api/config", async (route) => {
            const real = await (await route.fetch()).json();
            await route.fulfill({ json: { ...real, llm: { ...real.llm, configured: false, model: "unavailable" } } });
        });
        try {
            await visit("");
            const explore = page.getByRole("group", { name: "Ways to start" }).locator(".welcome-card").nth(0);
            await pwExpect(explore.getByText("The AI model isn’t set up on this server")).toBeVisible();
            await pwExpect(explore.getByRole("link", { name: "Open Settings", exact: true })).toHaveAttribute("href", "#/settings");
            await pwExpect(page.getByTestId("ai-note")).toHaveCount(0);
            await pwExpect(page.getByLabel("Address to start from")).toBeEnabled();
            await pwExpect(page.getByRole("button", { name: "Record a test", exact: true })).toBeEnabled();
            await pwExpect(page.getByRole("button", { name: "Import tests", exact: true })).toBeEnabled();
            await shot("welcome-no-ai-light-1280");
        } finally {
            await page.unroute("**/api/config");
        }
    });

    it("a bad address is refused in plain words, and Choose what to test first opens the options with a way back", async () => {
        await visit("");
        await page.getByLabel("Application URL").fill("notaurl");
        await page.getByRole("button", { name: "Explore my app", exact: true }).click();
        await pwExpect(page.getByText("That doesn’t look like a complete address")).toBeVisible();
        await pwExpect(page.getByLabel("Application URL")).toHaveAttribute("aria-invalid", "true");

        await page.getByLabel("Application URL").fill(SITE);
        await page.getByRole("button", { name: "Choose what to test first" }).click();
        await pwExpect(page.getByLabel("Application URL")).toHaveValue(SITE);
        await pwExpect(page.getByRole("button", { name: "Start exploring", exact: true })).toBeVisible();
        // Round 38: no Advanced options; Focus is the one optional field, and the agents' inputs are kept on the Requirements tab.
        await pwExpect(page.locator("summary", { hasText: "Advanced options" })).toHaveCount(0);
        await pwExpect(page.getByLabel(/^Focus/)).toBeVisible();
        await pwExpect(page.getByRole("group", { name: "Ways to start" })).toHaveCount(0);
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await pwExpect(page.getByRole("group", { name: "Ways to start" })).toBeVisible();
        await pwExpect(page.getByLabel("Application URL")).toHaveValue(SITE);
    });

    it("Record a test makes a project and opens the recorder with the address ready", async () => {
        await visit("");
        await page.getByLabel("Address to start from").fill(`127.0.0.1:${SITE_PORT}`);
        // Round 37: the project's name is typed, never made from the address.
        await page.getByRole("button", { name: "Record a test", exact: true }).click();
        await pwExpect(page.getByText("Give the project a name.")).toBeVisible();
        await page.getByLabel("Project name").fill("Recorded shop");
        await page.getByRole("button", { name: "Record a test", exact: true }).click();
        await page.waitForURL((u) => /^#\/projects\/[^/]+\/record\?url=/.test(u.hash));
        await pwExpect(page.getByRole("heading", { name: "Record a test", level: 1 })).toBeVisible();
        await pwExpect(page.getByLabel("Address to start from")).toHaveValue(`${SITE}/`);
        const projects = (await api("GET", "/api/projects")).body as Array<{ name: string; test_count: number }>;
        expect(projects.map((p) => p.name)).toEqual(["Recorded shop"]);
        expect(projects[0]!.test_count).toBe(0);
    });

    it("on the New project page the same three cards open the import chooser and the Tests page", async () => {
        await visit("#/new");
        await pwExpect(page.getByRole("heading", { name: "Create a test project", level: 1 })).toBeVisible();
        await pwExpect(page.getByRole("group", { name: "Ways to start" })).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Cancel", exact: true })).toHaveAttribute("href", "#/");

        await page.getByLabel("Project name").fill("Existing suite");
        await page.getByRole("button", { name: "Import tests", exact: true }).click();
        await page.waitForURL((u) => /^#\/projects\/[^/]+\/scripts\?start=import$/.test(u.hash));
        await pwExpect(page.getByRole("dialog", { name: "Import tests" })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Choose a JSON file" })).toBeVisible();
        await page.keyboard.press("Escape");

        await visit("#/new");
        await page.getByLabel("Project name").fill("Written by hand");
        await page.getByRole("button", { name: "Write a test by hand", exact: true }).click();
        await page.waitForURL((u) => /^#\/projects\/[^/]+\/scripts$/.test(u.hash));
        await pwExpect(page.getByRole("heading", { name: "No test scripts yet" })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "New test script", exact: true }).first()).toBeVisible();
        const names = ((await api("GET", "/api/projects")).body as Array<{ name: string }>).map((p) => p.name).sort();
        expect(names).toEqual(["Recorded shop", "Existing suite", "Written by hand"].sort());
    });

    it("the first screen: keyboard path, 375 px, 44 px targets, axe in both themes", async () => {
        // A first visit needs an empty platform: the cards are the same component on the New project page, which is audited here.
        await visit("#/new");
        await page.getByLabel("Application URL").focus();
        const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() || (document.activeElement as HTMLInputElement | null)?.id || "");
        const order: string[] = [];
        for (let i = 0; i < 8; i++) {
            await page.keyboard.press("Tab");
            order.push(await focused());
        }
        // The first card is reached first, then the second and third in order: every action is on the keyboard path.
        expect(order.slice(0, 2)).toEqual(["Explore my app", "Choose what to test first"]);
        expect(order).toContain("Record a test");
        expect(order).toContain("Import tests");
        expect(order.indexOf("Record a test")).toBeLessThan(order.indexOf("Import tests"));
        // The focus is visible.
        await page.getByRole("button", { name: "Explore my app" }).focus();
        const ring = await page.getByRole("button", { name: "Explore my app" }).evaluate((el) => getComputedStyle(el).outlineStyle + "|" + getComputedStyle(el).boxShadow);
        expect(ring).not.toBe("none|none");
        for (const [what, loc] of [
            ["Explore my app", page.getByRole("button", { name: "Explore my app", exact: true })],
            ["Record a test", page.getByRole("button", { name: "Record a test", exact: true })],
            ["Import tests", page.getByRole("button", { name: "Import tests", exact: true })],
            ["Application URL", page.getByLabel("Application URL")],
        ] as const) await tallEnough(loc, what);
        await axeBoth(async () => {
            await visit("#/new");
        });
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            await visit("#/new");
            await page.waitForTimeout(300);
            await noOverflow();
            await shot("welcome-light-375");
            await page.emulateMedia({ colorScheme: "dark" });
            await page.waitForTimeout(400);
            await shot("welcome-dark-375");
            await page.emulateMedia({ colorScheme: null });
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
        expect(consoleErrors).toEqual([]);
    });
});

// ── explore, read the plan, create, watch, next steps (real platform) ───────

describe("explore, then a plan, then the tests (real jobs, scripted model)", () => {
    let projectId = "";
    let planJob = "";
    let before: any;

    it("Explore my app: progress in words with Stop, and no run phase listed", async () => {
        await visit("#/new");
        await page.getByLabel("Project name").fill("Explored shop");
        await page.getByLabel("Application URL").fill(SITE);
        await page.getByRole("button", { name: "Explore my app", exact: true }).click();
        await page.waitForURL((u) => /^#\/projects\/[^/]+$/.test(u.hash));
        projectId = page.url().split("/projects/")[1]!;
        await pwExpect(page.getByRole("heading", { name: "Exploring your application" })).toBeVisible({ timeout: 20_000 });
        // The visible sentence on the page (the job badge's closed tooltip says it too, hidden, and must not count).
        await pwExpect(page.locator("p").filter({ hasText: "Nothing is created yet." })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Stop exploring" })).toBeVisible();
        await pwExpect(page.getByTestId("elapsed")).toBeVisible();
        const steps = (await page.locator("ol.steps li").allTextContents()).join(" | ");
        expect(steps).not.toMatch(/Run the tests|Tests run|Create test scripts|Test scripts created/);
        // The request carried the plan flag; the platform has no test yet.
        const jobs = (await api("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ jobId: string; planOnly?: boolean }>;
        expect(jobs[0]!.planOnly).toBe(true);
        planJob = jobs[0]!.jobId;
        await shot("exploring-light-1280");
    });

    it("then the plan: what was found, how many tests of each kind, and nothing created", async () => {
        await pwExpect(page.getByTestId("plan-preview")).toBeVisible({ timeout: 90_000 });
        await pwExpect(page.getByRole("heading", { name: "Here is what we will do" })).toBeVisible();
        before = (await api("GET", `/api/projects/${projectId}/plans/${planJob}`)).body;
        await pwExpect(page.getByTestId("plan-found")).toHaveText(new RegExp(`We found ${before.found.pages} pages and 2 API endpoints`));
        await pwExpect(page.getByTestId("plan-sentence")).toContainText(`We will create about ${before.total} tests:`);
        await pwExpect(page.getByTestId("plan-about")).toContainText("ecommerce");
        await pwExpect(page.getByText("Nothing has been created or run yet.")).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Create the tests", exact: true })).toBeEnabled();
        await pwExpect(page.getByRole("button", { name: "Discard the plan", exact: true })).toBeVisible();
        // Nothing exists yet, and the Overview shows no result for it.
        expect(((await api("GET", `/api/projects/${projectId}/tests`)).body as unknown[]).length).toBe(0);
        const text = await contentText();
        expect(text).not.toMatch(/Your test suite is ready/);
        // The project list says "Plan ready", not "Test suite ready".
        await shot("plan-light-1280");
    });

    it("the plan: keyboard path, 375 px, 44 px targets and axe in both themes (the Edit the plan section open)", async () => {
        // Keyboard: Tab reaches Create the tests, and Enter on the summary opens the editor.
        await page.getByRole("button", { name: "Create the tests" }).focus();
        const create = await page.evaluate(() => document.activeElement?.textContent);
        expect(create).toContain("Create the tests");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        const next = await page.evaluate(() => document.activeElement?.tagName + ":" + (document.activeElement?.textContent ?? "").trim());
        expect(next).toMatch(/^SUMMARY:Edit the plan/);
        await page.keyboard.press("Enter");
        await pwExpect(page.getByRole("checkbox", { name: /Accessibility/ })).toBeVisible();

        // Every checkbox row is a 44 px target.
        for (const box of await page.locator(".plan-edit label.check").all()) await tallEnough(box, `the row "${(await box.textContent())?.slice(0, 30)}"`);
        await tallEnough(page.getByRole("button", { name: "Create the tests" }), "Create the tests");
        await tallEnough(page.getByRole("button", { name: "Discard the plan" }), "Discard the plan");
        await shot("plan-edit-light-1280");

        const open = async () => {
            await page.goto("about:blank");
            await page.goto(`${BASE}/#/projects/${projectId}`);
            await pwExpect(page.getByTestId("plan-preview")).toBeVisible();
            await page.locator("summary", { hasText: "Edit the plan" }).click();
            await page.locator("summary", { hasText: /What we found/ }).click();
        };
        await axeBoth(open);

        await page.setViewportSize({ width: 375, height: 800 });
        try {
            await open();
            await page.waitForTimeout(300);
            await noOverflow();
            await shot("plan-edit-light-375");
            await page.emulateMedia({ colorScheme: "dark" });
            await page.waitForTimeout(400);
            await shot("plan-edit-dark-375");
            await page.emulateMedia({ colorScheme: null });
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
        await open();
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await shot("plan-edit-dark-1280");
        await page.emulateMedia({ colorScheme: null });
    });

    it("editing the plan changes the numbers as it is edited, and Create sends exactly what was shown", async () => {
        await visit(`#/projects/${projectId}`);
        await pwExpect(page.getByTestId("plan-preview")).toBeVisible();
        await page.locator("summary", { hasText: "Edit the plan" }).click();
        const fam = (id: string) => before.families.find((f: any) => f.id === id);
        const total = async () => Number(/about (\d+) tests?/.exec(await page.getByTestId("plan-sentence").innerText())![1]);
        expect(await total()).toBe(before.total);

        await page.getByRole("checkbox", { name: /Accessibility/ }).uncheck();
        expect(await total()).toBe(before.total - fam("accessibility").count);
        await page.getByRole("checkbox", { name: /Page health/ }).uncheck();
        await page.getByRole("checkbox", { name: /Form input/ }).uncheck();
        await page.getByRole("checkbox", { name: "Read the about page" }).uncheck();
        const expected = before.total - fam("accessibility").count - fam("health").count - fam("input").count - 1;
        expect(await total()).toBe(expected);
        await pwExpect(page.getByRole("list", { name: "Tests to create" })).not.toContainText("Accessibility");
        await pwExpect(page.getByRole("list", { name: "Tests to create" })).toContainText("Journeys through the app");

        // Everything left out and nothing selected: Create is not offered.
        await page.getByRole("checkbox", { name: /Journeys through the app/ }).uncheck();
        await page.getByRole("checkbox", { name: /^API checks/ }).uncheck();
        await page.getByRole("checkbox", { name: /Basic security/ }).uncheck();
        await pwExpect(page.getByTestId("plan-sentence")).toHaveText("Nothing is selected to create yet.");
        await pwExpect(page.getByRole("button", { name: "Create the tests", exact: true })).toBeDisabled();
        await page.getByRole("checkbox", { name: /Journeys through the app/ }).check();
        await page.getByRole("checkbox", { name: "Read the about page" }).uncheck();
        await page.getByRole("checkbox", { name: /^API checks/ }).check();
        await page.getByRole("checkbox", { name: /Basic security/ }).check();
        expect(await total()).toBe(expected);

        let sent: Record<string, unknown> | undefined;
        await page.route(`**/api/projects/${projectId}/plans/${planJob}/create`, (route) => {
            sent = route.request().postDataJSON();
            return route.continue();
        });
        await page.getByRole("button", { name: "Create the tests", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Creating your tests" })).toBeVisible({ timeout: 20_000 });
        expect(sent).toMatchObject({ accessibility: false, healthChecks: false, inputChecks: false, securityChecks: true, targets: ["web", "api"], excludeIdeas: [before.ideas[1].id] });
        await shot("creating-light-1280");
    }, 90_000);

    it("while the tests are made they appear in a list, with the phase in words, the time and Stop; then the result", async () => {
        await pwExpect(page.getByTestId("created-tests")).toBeVisible();
        await pwExpect(page.getByTestId("created-count")).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Stop exploring" })).toBeVisible();
        await pwExpect(page.getByTestId("elapsed")).toBeVisible();
        await pwExpect(page.locator(".run-test").first()).toBeVisible({ timeout: 60_000 });
        // Phases are named in words.
        await pwExpect(page.locator("ol.steps")).toContainText(/Application explored|Test ideas planned/);
        await pwExpect(page.getByText(/Your test suite is ready/)).toBeVisible({ timeout: 180_000 });

        const tests = (await api("GET", `/api/projects/${projectId}/tests`)).body as Array<{ testId: string; title: string; validationStatus: string }>;
        // The numbers shown in the plan are the tests that exist: 1 journey (one was left out), the API checks and the security checks.
        const fam = (id: string) => before.families.find((f: any) => f.id === id);
        expect(tests.length).toBe(1 + fam("api").count + fam("security").count);
        expect(tests.filter((t) => t.testId.startsWith("WEB-")).map((t) => t.title)).toEqual(["Browse the product list"]);
        await shot("ready-light-1280");
    }, 240_000);

    it("Ready: the Overview lists next steps with one action each, and they tick from what really happened", async () => {
        await visit(`#/projects/${projectId}`);
        const steps = page.getByTestId("next-steps");
        await pwExpect(steps).toBeVisible();
        await pwExpect(steps.getByRole("heading", { name: "Next steps" })).toBeVisible();
        const done = async (key: string) => (await steps.locator(`[data-step="${key}"]`).getAttribute("data-done")) === "true";
        for (const key of ["run", "schedule", "login"]) {
            await pwExpect(steps.locator(`[data-step="${key}"]`)).toHaveCount(1);
            expect(await done(key), key).toBe(false);
        }
        // The runner is asked for once, in Still to set up and on the Dashboard, not again here.
        await pwExpect(steps.locator('[data-step="runner"]')).toHaveCount(0);
        // One action each, in words.
        await pwExpect(steps.getByRole("button", { name: "Run all tests" })).toBeVisible();
        await pwExpect(steps.getByRole("link", { name: "Set a schedule" })).toHaveAttribute("href", `#/projects/${projectId}/runs?section=schedules`);
        await pwExpect(steps.getByRole("link", { name: "Add sign-in details" })).toBeVisible();
        // The empty cards stay out of the way.
        const text = await contentText();
        expect(text).not.toMatch(/Storage and backup/);
        await shot("next-steps-light-1280");

        // A schedule exists: that step ticks (and loses its button).
        const made = await api("POST", `/api/projects/${projectId}/schedules`, { kind: "validate", cadence: { type: "daily", time: "02:00" } });
        expect(made.status).toBe(201);
        await visit(`#/projects/${projectId}`);
        await pwExpect(steps.locator('[data-step="schedule"]')).toHaveAttribute("data-done", "true");
        await pwExpect(steps.getByRole("link", { name: "Set a schedule" })).toHaveCount(0);
        await pwExpect(steps.locator('[data-step="run"]')).toHaveAttribute("data-done", "false");

        // A run of the tests happened: that one ticks.
        const run = await api("POST", `/api/projects/${projectId}/runs`, {});
        expect(run.status).toBe(202);
        await finished(run.body.jobId);
        await visit(`#/projects/${projectId}`);
        await pwExpect(steps.locator('[data-step="run"]')).toHaveAttribute("data-done", "true");
        await pwExpect(steps.getByText("You have run them again.")).toBeVisible();
    }, 240_000);

    it("Next steps: keyboard path, 375 px, 44 px targets, axe in both themes", async () => {
        await visit(`#/projects/${projectId}`);
        await pwExpect(page.getByTestId("next-steps")).toBeVisible();
        for (const l of await page.getByTestId("next-steps").locator("a.btn, button.btn").all()) await tallEnough(l, `the action "${(await l.textContent())?.trim()}"`);
        await page.getByTestId("next-steps").getByRole("link", { name: "Add sign-in details" }).focus();
        const ring = await page.getByTestId("next-steps").getByRole("link", { name: "Add sign-in details" }).evaluate((el) => getComputedStyle(el).outlineStyle + "|" + getComputedStyle(el).boxShadow);
        expect(ring).not.toBe("none|none");
        await axeBoth(async () => {
            await visit(`#/projects/${projectId}`);
            await pwExpect(page.getByTestId("next-steps")).toBeVisible();
        });
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            await visit(`#/projects/${projectId}`);
            await pwExpect(page.getByTestId("next-steps")).toBeVisible();
            await page.waitForTimeout(300);
            await noOverflow();
            await shot("next-steps-light-375");
            await page.emulateMedia({ colorScheme: "dark" });
            await page.waitForTimeout(400);
            await shot("next-steps-dark-375");
            await page.emulateMedia({ colorScheme: null });
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("a plan that is not used stays a plan: it is discarded on request, says it is gone, and offers to explore again", async () => {
        const p = (await api("POST", "/api/projects", { name: "Plan to discard" })).body.id as string;
        const j = (await api("POST", `/api/projects/${p}/test-generation`, { url: SITE, targets: ["api"], plan: true })).body.jobId as string;
        await finished(j);
        await visit(`#/projects/${p}`);
        await pwExpect(page.getByTestId("plan-preview")).toBeVisible();
        // An API-only plan has no web side: those kinds are listed but cannot be switched on.
        await page.locator("summary", { hasText: "Edit the plan" }).click();
        await pwExpect(page.getByRole("checkbox", { name: /Accessibility/ })).toBeDisabled();
        await pwExpect(page.getByText("The web side was not explored in this plan.").first()).toBeVisible();
        await page.getByRole("button", { name: "Discard the plan" }).click();
        await pwExpect(page.getByText("The plan was discarded")).toBeVisible();
        await pwExpect(page.getByText("Nothing was created. Explore again whenever you like.")).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Explore again" }).first()).toBeVisible();
        expect(((await api("GET", `/api/projects/${p}/tests`)).body as unknown[]).length).toBe(0);
        expect((await api("GET", `/api/projects/${p}/plans/${j}`)).status).toBe(410);
        // Opened again later, it says the same in the platform's words.
        await visit(`#/projects/${p}`);
        await pwExpect(page.getByText("This plan is no longer available")).toBeVisible();
    }, 90_000);
});

// ── stages the platform's answers are faked for ─────────────────────────────

describe("stopping at each stage says what is kept (the platform's answers for one project are faked)", () => {
    let pid = "";
    beforeAll(async () => {
        pid = (await api("POST", "/api/projects", { name: "Stages" })).body.id as string;
    });

    it("while planning: Stop exploring says no plan is made and nothing is created", async () => {
        await fakeLatestJob(pid, { status: "PLANNING", planOnly: true, progress: { ...PROGRESS, discovery: "done", understanding: "done", planning: "running", generation: "skipped", validation: "skipped" }, counters: { ...COUNTERS, pagesDiscovered: 5, apisDiscovered: 2, journeysIdentified: 3 } });
        await page.route(`**/api/projects/${pid}/runs/job-fake`, (route) => route.fulfill({ json: runAnswer(pid, fakeJob(pid, { planOnly: true }), [], {}) }));
        try {
            await visit(`#/projects/${pid}`);
            await pwExpect(page.getByRole("heading", { name: "Exploring your application" })).toBeVisible();
            await pwExpect(page.locator("ol.steps li")).toHaveCount(3);
            await pwExpect(page.getByText("Found 5 pages and 2 API endpoints")).toBeVisible();
            await page.getByRole("button", { name: "Stop exploring" }).click();
            const dialog = page.getByRole("dialog", { name: "Stop exploring?" });
            await pwExpect(dialog.getByTestId("stop-body")).toContainText("No plan is made and nothing is created. Tests you already have are unchanged.");
            await pwExpect(dialog.getByRole("button", { name: "Keep running" })).toBeFocused();
            await page.keyboard.press("Escape");
            await pwExpect(dialog).toHaveCount(0);
        } finally {
            await page.unroute(`**/api/projects/${pid}`);
            await page.unroute(`**/api/projects/${pid}/runs/job-fake`);
        }
    });

    it("a stopped exploration: no plan, nothing created, and a way to explore again", async () => {
        await fakeLatestJob(pid, { status: "FAILED", planOnly: true, error: "Cancelled", finishedAt: NOW(), cancelled: { planned: 0, ran: 0, notRun: 0, note: "The run was cancelled before any test started. No test was changed." } });
        try {
            await visit(`#/projects/${pid}`);
            await pwExpect(page.getByText("Exploring was stopped")).toBeVisible();
            await pwExpect(page.getByText("No plan was made and nothing was created. Tests you already had are unchanged.")).toBeVisible();
            await pwExpect(page.getByRole("link", { name: "Explore again" }).first()).toHaveAttribute("href", `#/new?project=${pid}`);
            await shot("stopped-exploring-light-1280");
        } finally {
            await page.unroute(`**/api/projects/${pid}`);
        }
    });

    it("while the tests are made: the list shows what exists, Stop keeps it and says how many", async () => {
        const rows = [
            { id: "t1", testId: "API-001", title: "GET /api/items: returns the list", suite: "API", state: "passed", durationMs: 840 },
            { id: "t2", testId: "API-002", title: "GET /api/items: refuses a bad request", suite: "API", state: "failed", reason: "Expected status 400 but the response was 200", durationMs: 600 },
            { id: "t3", testId: "WEB-001", title: "Browse the product list", suite: "Browsing", state: "waiting" },
        ];
        const job = { fromPlan: "plan-1", status: "VALIDATING", progress: { ...PROGRESS, discovery: "done", understanding: "done", planning: "done", generation: "done", validation: "running" }, counters: { ...COUNTERS, pagesDiscovered: 5, testsGenerated: 3, testsValidated: 1, testsFailedValidation: 1 } };
        await fakeLatestJob(pid, job);
        await page.route(`**/api/projects/${pid}/runs/job-fake`, (route) => route.fulfill({ json: runAnswer(pid, fakeJob(pid, job), rows, { ran: 2, passed: 1, failed: 1, waiting: 1 }) }));
        try {
            await visit(`#/projects/${pid}`);
            await pwExpect(page.getByRole("heading", { name: "Creating your tests" })).toBeVisible();
            await pwExpect(page.getByTestId("created-count")).toHaveText("3 tests created, 2 run so far.");
            const list = page.getByRole("list", { name: "Tests in this run" });
            await pwExpect(list.locator(".run-test")).toHaveCount(3);
            await pwExpect(list.locator('[data-state="passed"]')).toContainText("Passing");
            await pwExpect(list.locator('[data-state="failed"]')).toContainText("Failing");
            await pwExpect(list.locator('[data-state="waiting"]')).toContainText("Waiting");
            await pwExpect(list.getByRole("link", { name: "GET /api/items: returns the list" })).toHaveAttribute("href", "#/tests/t1");
            await pwExpect(page.locator("ol.steps li.running")).toContainText("Running the tests");
            await shot("creating-faked-light-1280");

            await page.getByRole("button", { name: "Stop exploring" }).click();
            await pwExpect(page.getByRole("dialog", { name: "Stop exploring?" }).getByTestId("stop-body")).toContainText("The 3 tests created so far are kept. Tests that were not run yet show as Not run yet.");
            await page.keyboard.press("Escape");

            // 375 px and axe, in this state too.
            await axeBoth(async () => {
                await visit(`#/projects/${pid}`);
                await pwExpect(page.getByTestId("created-tests")).toBeVisible();
            });
            await page.setViewportSize({ width: 375, height: 800 });
            try {
                await visit(`#/projects/${pid}`);
                await pwExpect(page.getByTestId("created-tests")).toBeVisible();
                await page.waitForTimeout(300);
                await noOverflow();
                await shot("creating-faked-light-375");
            } finally {
                await page.setViewportSize({ width: 1280, height: 900 });
            }
        } finally {
            await page.unroute(`**/api/projects/${pid}`);
            await page.unroute(`**/api/projects/${pid}/runs/job-fake`);
        }
    });

    it("a stopped creation: the platform's own count of what ran is said, and each test can still be seen", async () => {
        await fakeLatestJob(pid, { fromPlan: "plan-1", status: "FAILED", error: "Cancelled", finishedAt: NOW(), cancelled: { planned: 7, ran: 3, notRun: 4, note: "The run was cancelled. 3 of 7 tests had finished and keep their new results. 4 did not run and have not been run yet." }, counters: { ...COUNTERS, testsGenerated: 7, testsValidated: 3 } });
        try {
            await visit(`#/projects/${pid}`);
            await pwExpect(page.getByText("Stopped: 3 of 7 ran")).toBeVisible();
            await pwExpect(page.getByText("4 did not run and have not been run yet.")).toBeVisible();
            await pwExpect(page.getByRole("link", { name: "See each test" })).toBeVisible();
        } finally {
            await page.unroute(`**/api/projects/${pid}`);
        }
    });

    it("a plan that cannot be shown says so: gone, or the AI model missing, or nothing found", async () => {
        const job = { status: "PARTIALLY_COMPLETED", planOnly: true, finishedAt: NOW(), progress: { ...PROGRESS, discovery: "done", understanding: "failed", planning: "failed", generation: "skipped", validation: "skipped" } };
        await fakeLatestJob(pid, job);
        try {
            // Gone.
            await page.route(`**/api/projects/${pid}/plans/job-fake`, (route) => route.fulfill({ status: 410, json: { error: "The plan is no longer available, so nothing was created. Explore the application again to get a new plan." } }));
            await visit(`#/projects/${pid}`);
            await pwExpect(page.getByText("This plan is no longer available")).toBeVisible();
            await pwExpect(page.getByText("Nothing was created.")).toBeVisible();
            await page.unroute(`**/api/projects/${pid}/plans/job-fake`);

            // The AI model missing: the API side is still planned, and the warning is in plain words with the way to fix it.
            const ready = {
                ready: true, jobId: "job-fake", status: "PARTIALLY_COMPLETED", createdAt: NOW(), url: SITE, targets: ["web", "api"],
                found: { pages: 5, apiEndpoints: 2, forms: 1, journeys: 0 }, about: null, pages: [{ path: "/", title: "Shop", type: "home" }, { path: "/login", title: "Sign in", type: "login" }], ideas: [],
                families: [
                    { id: "journeys", label: "Journeys through the app", about: "The AI tries each journey in a real browser.", count: 0, on: true, option: "web", needs: "web", note: "No journeys were planned." },
                    { id: "api", label: "API checks", about: "For each endpoint.", count: 6, on: true, option: "api", needs: "api" },
                    { id: "security", label: "Basic security", about: "A read-only look at security headers.", count: 5, on: true, option: "securityChecks", needs: "both" },
                ],
                total: 11, warnings: ["Web analysis/planning failed: No credentials for LLM provider \"anthropic\". Set ANTHROPIC_API_KEY (or LLM_API_KEY) before starting the platform."], signInDetails: false, used: null,
            };
            await page.route(`**/api/projects/${pid}/plans/job-fake`, (route) => route.fulfill({ json: ready }));
            await visit(`#/projects/${pid}`);
            await pwExpect(page.getByText("The AI model isn’t set up yet")).toBeVisible();
            await pwExpect(page.getByRole("link", { name: "Open settings" })).toBeVisible();
            await pwExpect(page.getByTestId("plan-sentence")).toHaveText("We will create about 11 tests: API checks 6 and basic security 5.");
            await pwExpect(page.getByTestId("plan-login-hint")).toBeVisible();
            await page.unroute(`**/api/projects/${pid}/plans/job-fake`);

            // Nothing found: Create is not offered.
            await page.route(`**/api/projects/${pid}/plans/job-fake`, (route) => route.fulfill({ json: { ...ready, found: { pages: 0, apiEndpoints: 0, forms: 0, journeys: 0 }, pages: [], families: ready.families.map((f) => ({ ...f, count: 0 })), total: 0, warnings: [] } }));
            await visit(`#/projects/${pid}`);
            await pwExpect(page.getByText("Nothing to test was found")).toBeVisible();
            await pwExpect(page.getByRole("button", { name: "Create the tests", exact: true })).toBeDisabled();
        } finally {
            await page.unroute(`**/api/projects/${pid}`);
            await page.unroute(`**/api/projects/${pid}/plans/job-fake`);
        }
    });

    it("a project with a plan and no tests reads Plan ready in the project list (the list is answered by the test)", async () => {
        const PROJECT_LIST = /\/api\/projects(\?[^/]*)?$/;
        // Round 37: the Projects page asks for a page (?limit=&offset=) and gets one; the plain list stays an array.
        const list = [{ id: "p1", name: "Atlas", created_at: NOW(), test_count: 0, validated_count: 0, url: SITE, last_job_status: "COMPLETED" }, { id: "p2", name: "Borealis", created_at: NOW(), test_count: 4, validated_count: 4, url: SITE, last_job_status: "COMPLETED" }];
        await page.route(PROJECT_LIST, (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.has("limit") ? { projects: list, total: list.length, limit: 20, offset: 0 } : list }));
        await page.route("**/api/dashboard**", (route) => route.abort());
        try {
            await visit("");
            const rows = page.locator("a.list-row");
            await pwExpect(rows.filter({ hasText: "Atlas" }).getByText("Plan ready")).toBeVisible();
            await pwExpect(rows.filter({ hasText: "Borealis" }).getByText("Test suite ready")).toBeVisible();
        } finally {
            await page.unroute(PROJECT_LIST);
            await page.unroute("**/api/dashboard**");
        }
    });

    it("ends with no unexpected error in the browser console", () => {
        expect(consoleErrors).toEqual([]);
    });
});
