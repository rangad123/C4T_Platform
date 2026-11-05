/**
 * One browser journey through the site-memory card in the real UI: the Overview says nothing is remembered yet, then
 * explains the first analysis, then shows "Since the last analysis: ..." with the details, survives a failed load,
 * asks before forgetting, and the "Analyze again" form offers (and sends) the memory switch.
 * The memory itself is written with the real distil / compare / store code from two site models (no jobs run here: the
 * jobs are covered by memory-pipeline.test.ts). Platform on port 5491; no worker is started, so no analysis really runs.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/memory-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { diffKnowledge } from "../src/engine/memory/diff.js";
import { distillKnowledge } from "../src/engine/memory/distill.js";
import type { AppModel, PageModel } from "../src/engine/understanding/app-model.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { latestMemory, saveMemory } from "../src/platform/memory-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 5491;
const base = `http://127.0.0.1:${PORT}`;

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;

const pg = (p: string, over: Partial<PageModel> = {}): PageModel => ({
    url: `http://shop.test${p}`, path: p, title: p, type: "content", depth: 1, status: 200, headings: [`Heading ${p}`], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [], ...over,
});
const site = (pages: PageModel[], apis: string[]): AppModel => ({
    url: "http://shop.test/", origin: "http://shop.test", siteType: "ecommerce", purpose: "A shop", features: [], navigation: [], pages,
    apis: apis.map((a) => ({ method: "GET", path: a, origin: "http://shop.test", statuses: [200], queryParams: [], source: "network" as const, usedIn: [] })),
    journeys: [{ name: "Browse", description: "d", steps: ["s"], priority: "high", pages: ["/"], requiresAuth: false }],
    externalDependencies: [], documentedTestCases: [], authentication: { required: false, mechanisms: [], loggedIn: false },
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});
const first = distillKnowledge(site([pg("/"), pg("/about"), pg("/products")], ["/api/items", "/api/legacy"]), { scenarios: [{ title: "Browse works", journey: "Browse", startPath: "/", validated: true }] });
const second = distillKnowledge(site([pg("/"), pg("/products", { headings: ["All products"] }), pg("/news")], ["/api/items"]), { scenarios: [{ title: "Browse works", journey: "Browse", startPath: "/", validated: true }] });

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-memory-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    // A project whose analysis has finished (the card belongs to a finished analysis).
    projectId = (platform.repo.createProject({ name: "Memory UI" }) as { id: string }).id;
    const appId = platform.repo.createApplication(projectId, "http://shop.test", { ...DEFAULT_JOB_OPTIONS });
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS });
    platform.repo.setJobStatus(job.id, "COMPLETED");

    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const card = () => page.getByRole("region", { name: "Site memory" });
const open = async () => {
    await page.goto(`${base}/#/projects/${projectId}`);
    await page.reload();
};

describe("site memory card", () => {
    it("shows no card at all until something is remembered (an empty card on a first run only adds noise)", async () => {
        await open();
        await pwExpect(page.locator("h1").first()).toBeVisible();
        await page.waitForTimeout(500);
        await pwExpect(card()).toHaveCount(0);
        await pwExpect(page.getByText("What we remember about this site")).toHaveCount(0);
    }, 60_000);

    it("after the first exploration it explains that there is nothing to compare yet", async () => {
        saveMemory(platform.db, { projectId, knowledge: first, changes: null });
        await open();
        await pwExpect(card().getByTestId("site-memory-first")).toContainText("This was the first exploration");
        const facts = card().getByRole("list", { name: "What is remembered" });
        await pwExpect(facts).toContainText("3 pages");
        await pwExpect(facts).toContainText("1 journey (1 with passing tests)");
        await pwExpect(facts).toContainText("2 API endpoints");
        await pwExpect(card()).toContainText("never page text, passwords or personal data");
    }, 60_000);

    it("after the second it shows what changed, with the details one click away", async () => {
        saveMemory(platform.db, { projectId, knowledge: second, changes: diffKnowledge(first, second) });
        await open();
        await pwExpect(card().getByTestId("site-memory-changes")).toHaveText("Since the last exploration: 1 new page, 1 page changed, 1 page no longer found, 1 endpoint gone.");
        await pwExpect(card().getByText("Pages no longer found")).toBeHidden(); // details are collapsed
        await card().getByText("See what changed", { exact: true }).click();
        const group = (title: string) => card().locator(".memory-group", { has: page.getByRole("heading", { name: title, exact: true }) });
        await pwExpect(group("New pages")).toContainText("/news");
        await pwExpect(group("Pages that changed")).toContainText("/products");
        await pwExpect(group("Pages no longer found")).toContainText("/about");
        await pwExpect(group("API endpoints that are gone")).toContainText("GET /api/legacy");
        await pwExpect(group("New API endpoints")).toHaveCount(0);
    }, 60_000);

    it("shows a retry when the memory cannot be loaded, and recovers", async () => {
        await page.route("**/api/projects/*/memory", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
        await open();
        await pwExpect(card().getByText("Could not load what we remember")).toBeVisible();
        await page.unroute("**/api/projects/*/memory");
        await card().getByRole("button", { name: "Try again" }).click();
        await pwExpect(card().getByTestId("site-memory-changes")).toBeVisible();
    }, 60_000);

    it("asks before forgetting; keeping it changes nothing, confirming forgets", async () => {
        await open();
        await card().getByRole("button", { name: "Forget what we learned" }).click();
        await pwExpect(card().getByText("Forget what we learned about this site? The next exploration starts from scratch.")).toBeVisible();
        await card().getByRole("button", { name: "Keep it" }).click();
        await pwExpect(card().getByRole("button", { name: "Forget what we learned" })).toBeVisible();
        expect(latestMemory(platform.db, projectId)).not.toBeNull();

        await card().getByRole("button", { name: "Forget what we learned" }).click();
        await card().getByRole("button", { name: "Yes, forget it" }).click();
        await pwExpect(card().getByText("Forgotten. The next exploration starts from scratch.")).toBeVisible();
        await pwExpect(card().getByTestId("site-memory-empty")).toBeVisible();
        expect(latestMemory(platform.db, projectId)).toBeNull();
    }, 60_000);

    it("the 'Explore again' page has no memory switch: an exploration starts from what was learned (the default)", async () => {
        await page.goto(`${base}/#/new?project=${projectId}`);
        await pwExpect(page.getByLabel("Application URL")).toBeVisible();
        await pwExpect(page.getByRole("checkbox", { name: /Start from what we learned last time/ })).toHaveCount(0);
        await page.getByLabel("Application URL").fill(base);
        await page.getByRole("button", { name: "Explore again" }).click();
        await pwExpect(page.getByRole("heading", { name: "Memory UI" })).toBeVisible();
        const jobs = platform.repo.listJobs(projectId);
        expect(jobs[0]!.options.useMemory).toBe(true);
    }, 60_000);
});
