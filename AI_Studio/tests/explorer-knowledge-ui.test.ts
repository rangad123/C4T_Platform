/**
 * Sheet #8 stage 5 in a real browser against a real platform (no worker: the exploration, its events, its saved model, its tests, its AI
 * usage and its page thumbnails are recorded as an exploration records them).
 *
 * - The run page's progress tree marks the reused page "Reused <date>" and says, as a warning, that reuse was switched off and why.
 * - "What the explorer knows" on the run page and on the project page: one tab at a time. Site map: the pages tests start on, with their
 *   titles, thumbnails (loaded through GET /api/artifacts/:id) and test links; the other pages as one folded list of addresses. "Reused and why":
 *   the reused pages with their dates, the reason reuse was switched off, and the cache figures (this person may see AI usage).
 * - Settings → General has "Keep page thumbnails", on.
 * - No accessibility violations in light and dark (the app is light-only: dark is emulated to prove nothing breaks), and a phone-sized
 *   screen (390 px) needs no sideways scrolling.
 *
 * Requires web/dist: node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/explorer-knowledge-ui.test.ts"
 * Screenshots: $SHOTS_DIR (when set). Ports: platform 6764.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { EngineEvent } from "../src/engine/context.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { buildServer } from "../src/platform/server.js";
import { UsageStore } from "../src/platform/usage-store.js";

const PORT = 6764;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS_DIR;
const SITE = "http://127.0.0.1:7393";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId: string;
let jobId: string;
let testId: string;
const consoleErrors: string[] = [];

const EVENTS: EngineEvent[] = [
    { stage: "discovery", kind: "signin_reused", message: "reused: went straight to the sign-in page known since 2026-11-10 (/login); the form was filled and the sign-in checked as usual.", data: { path: "/login", since: "2026-11-10T08:00:00.000Z" } },
    { stage: "discovery", kind: "page_visited", message: "Visited / (home, 0 forms, 4 controls); unchanged since 2026-11-10, so its menus, conditional fields and validation messages were taken from then", data: { url: `${SITE}/`, status: 200, depth: 0, type: "home", reusedFrom: "2026-11-10T08:00:00.000Z" } },
    { stage: "discovery", kind: "page_visited", message: "Visited /products (listing, 0 forms, 1 controls)", data: { url: `${SITE}/products`, status: 200, depth: 1, type: "listing" } },
    { stage: "discovery", kind: "page_visited", message: "Visited /products/7 (detail, 1 forms, 3 controls)", data: { url: `${SITE}/products/7`, status: 200, depth: 2, type: "detail" } },
    { stage: "discovery", kind: "page_visited", message: "Visited /help/faq (content, 0 forms, 1 controls)", data: { url: `${SITE}/help/faq`, status: 200, depth: 1, type: "content" } },
    { stage: "discovery", kind: "reuse_off", level: "warn", message: "Reuse of the last exploration is off for the rest of this run: a spot check of /products found it behaves differently from the last exploration (its menus, conditional fields or validation messages changed). Every page is tried again.", data: { reason: "a spot check of /products found it behaves differently from the last exploration (its menus, conditional fields or validation messages changed)", changed: 0, spotChecked: 1 } },
    { stage: "discovery", kind: "probes_reused", message: "reused: 1 page unchanged since 2026-11-10.", data: { pages: 1, since: "2026-11-10T08:00:00.000Z", spotChecked: 1, expired: 0, changed: 0, paths: ["/"] } },
    { stage: "discovery", kind: "pages_from_memory", message: "Started from 3 pages the last exploration knew", data: { pages: 3, gone: 0 } },
    { stage: "analysis", kind: "understanding_reused", message: "1 unchanged page was not sent to the AI again", data: { pages: 1, of: 4 } },
];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-knowledge-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "knowledge-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const { repo, store } = platform;
    projectId = (await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Knowing shop", platforms: ["web"], testingModes: ["agent"] } })).json().id;
    const app = repo.createApplication(projectId, SITE, {});
    const job = await repo.createJob(projectId, app, { ...DEFAULT_JOB_OPTIONS, targets: ["web"], planOnly: true });
    jobId = job.id;
    for (const e of EVENTS) repo.addEvent(jobId, e);
    for (const p of ["discovery", "understanding", "planning"] as const) repo.setPhase(jobId, p, "done");

    browser = await chromium.launch();
    // Two thumbnails as the crawl takes them: small JPEGs of a page (a teal and an ink one, so they are told apart on the screenshots).
    const maker = await browser.newPage({ viewport: { width: 320, height: 200 } });
    const jpegOf = async (color: string, text: string) => {
        await maker.setContent(`<body style="margin:0;background:${color};font:32px sans-serif;color:#fff;display:grid;place-items:center;height:200px">${text}</body>`);
        return maker.screenshot({ type: "jpeg", quality: 50 });
    };
    const sink = new RepoSink(repo, store, { id: jobId, projectId, applicationId: app });
    const home = (await sink.savePageThumbnail("thumb-1.jpg", await jpegOf("#0f766e", "Home")))!;
    const products = (await sink.savePageThumbnail("thumb-2.jpg", await jpegOf("#1e293b", "Products")))!;
    await maker.close();
    const model = {
        pages: [
            { url: `${SITE}/`, path: "/", title: "Shop home", type: "home", depth: 0, reusedFrom: { at: "2026-11-10T08:00:00.000Z" }, thumbnail: home },
            { url: `${SITE}/products`, path: "/products", title: "All products", type: "listing", depth: 1, thumbnail: products },
            { url: `${SITE}/products/7`, path: "/products/7", title: "Blue kettle with a long name that wraps on a phone", type: "detail", depth: 2 },
            { url: `${SITE}/help/faq`, path: "/help/faq", title: "Questions", type: "content", depth: 1 },
        ],
    };
    await sink.saveTextArtifact("app-model", "application-model.json", JSON.stringify(model));
    const suite = repo.getOrCreateSuite(projectId, "Browsing", "browsing");
    testId = repo.insertTest({ projectId, suiteId: suite, jobId, spec: TestSpecSchema.parse({ testId: "WEB-001", title: "Browse the product list", kind: "web", category: "Browsing", steps: [{ action: "navigate", url: "/products" }] }), framework: "playwright", validationStatus: "PENDING" });
    new UsageStore(platform.db).addUsage({ jobId, projectId, purpose: "planning", model: "claude-haiku-4-5", at: new Date(), calls: 4, failedCalls: 0, inputTokens: 20_000, outputTokens: 2_000, images: 0, estimatedCalls: 0, cacheReadTokens: 12_000, cacheWriteTokens: 3_000 });
    repo.setJobStatus(jobId, "COMPLETED");

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const shot = async (name: string) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
};
const axe = async (selector: string) => (await new AxeBuilder({ page }).include(selector).analyze()).violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join("; ")})`);

describe("the run page of a repeat exploration", () => {
    it("the progress tree marks the reused page with its date and warns that reuse was switched off, with the reason", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
        const disc = page.getByTestId("xt-stage:discovery");
        await disc.waitFor();
        await disc.locator(":scope > button.xt-toggle").click();
        await expect.poll(() => disc.innerText(), { timeout: 15_000 }).toContain("Reused 2026-11-10");
        const home = disc.locator('li[data-testid^="xt-page:"]').filter({ hasText: "Reused 2026-11-10" });
        expect(await home.count()).toBe(1);
        expect(await home.locator(".xt-name").innerText()).toBe("/");
        expect(await home.innerText()).toMatch(/Unchanged since 2026-11-10/);
        const off = disc.locator("li", { hasText: "Reuse of the last exploration was switched off" });
        expect(await off.innerText()).toContain("Reuse off");
        expect(await off.innerText()).toContain("Why: a spot check of /products found it behaves differently");
        expect(await axe('[data-testid="explore-tree"]')).toEqual([]);
    });

    it("what the explorer knows: the site map with titles, thumbnails and test links; only the chosen tab shows", async () => {
        const k = page.getByTestId("explorer-knowledge");
        await k.waitFor();
        expect(await page.getByTestId("xk-summary").innerText()).toBe("4 pages found, 1 page reused from the last exploration; reuse was switched off.");
        expect(await page.getByTestId("xk-tab-map").getAttribute("aria-selected")).toBe("true");
        expect(await page.getByTestId("xk-panel-reused").count()).toBe(0);
        const products = page.getByTestId("xk-page:/products");
        expect(await products.innerText()).toContain("All products");
        expect(await products.getByRole("link", { name: "WEB-001 Browse the product list" }).getAttribute("href")).toBe(`#/tests/${testId}`);
        // Only the page a test starts on is shown with its picture; the other three are one folded list of addresses.
        expect(await page.getByTestId("xk-map-counts").innerText()).toBe("Tests start on 1 of the 4 pages.");
        const others = page.getByTestId("xk-other-pages");
        expect(await others.getAttribute("open")).toBeNull();
        await others.locator("summary").click();
        expect(await others.locator("summary").innerText()).toBe("3 other pages");
        for (const p of ["/", "/help/faq", "/products/7"]) expect(await others.getByTestId(`xk-page:${p}`).count()).toBe(1);
        expect(await others.getByTestId("xk-page:/").getByTestId("xk-reused").innerText()).toBe("Reused 2026-11-10");
        // The thumbnail loads through the artifact route; pages no test starts on show none.
        const imgs = k.getByTestId("xk-thumb");
        await expect.poll(() => imgs.count(), { timeout: 15_000 }).toBe(1);
        await expect.poll(() => imgs.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth)), { timeout: 15_000 }).toEqual([320]);
        expect(await imgs.first().getAttribute("alt")).toBe("Picture of /products");
        expect(await axe('[data-testid="explorer-knowledge"]')).toEqual([]);
        await k.scrollIntoViewIfNeeded();
        await shot("knowledge-map-wide.png");
    });

    it("reused and why: the pages with their dates, why reuse went off, and the cache figures", async () => {
        await page.getByTestId("xk-tab-reused").click();
        const panel = page.getByTestId("xk-panel-reused");
        await panel.waitFor();
        expect(await page.getByTestId("xk-panel-map").count()).toBe(0);
        const text = await panel.innerText();
        expect(text).toContain("Reuse was switched off");
        expect(text).toContain("A spot check of /products found it behaves differently from the last exploration (its menus, conditional fields or validation messages changed). Every page was tried again from then on.");
        expect(await page.getByTestId("xk-reused-list").innerText()).toMatch(/^\/\s+Reused 2026-11-10$/);
        expect(text).toContain("Went straight to the sign-in page /login known since 2026-11-10");
        expect(text).toContain("1 unchanged page was not sent to the AI again (of 4).");
        const savings = await page.getByTestId("xk-savings").innerText();
        expect(savings).toContain("60%");
        expect(savings).toContain("12,000");
        expect(savings).toContain("3,000");
        // The arrow keys move between the tabs.
        await page.keyboard.press("ArrowLeft");
        expect(await page.getByTestId("xk-tab-map").getAttribute("aria-selected")).toBe("true");
        await page.keyboard.press("ArrowRight");
        expect(await axe('[data-testid="explorer-knowledge"]')).toEqual([]);
        await page.getByTestId("explorer-knowledge").scrollIntoViewIfNeeded();
        await shot("knowledge-reused-wide.png");
    });

    it("has no accessibility violations in dark either", async () => {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
        await page.getByTestId("explorer-knowledge").waitFor();
        expect(await axe('[data-testid="explorer-knowledge"]')).toEqual([]);
        await page.getByTestId("xk-tab-reused").click();
        expect(await axe('[data-testid="explorer-knowledge"]')).toEqual([]);
        expect(await axe('[data-testid="explore-tree"]')).toEqual([]);
        await shot("knowledge-dark.png");
        await page.emulateMedia({ colorScheme: "light" });
    });
});

describe("the project page and its settings", () => {
    it("shows the latest exploration's knowledge on the project page, and fits a phone-sized screen", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${BASE}/#/projects/${projectId}`);
        const k = page.getByTestId("explorer-knowledge");
        await k.waitFor({ timeout: 20_000 });
        await expect.poll(() => k.getByTestId("xk-thumb").count(), { timeout: 15_000 }).toBe(1);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(wide).toBeLessThanOrEqual(390);
        expect(await axe('[data-testid="explorer-knowledge"]')).toEqual([]);
        await k.scrollIntoViewIfNeeded();
        await page.screenshot({ path: SHOTS ? path.join(SHOTS, "knowledge-phone.png") : path.join(dataDir, "x.png"), fullPage: false });
        await page.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
        await page.getByTestId("explorer-knowledge").waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        await page.getByTestId("xk-tab-reused").click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        expect(await axe('[data-testid="explorer-knowledge"]')).toEqual([]);
        await page.getByTestId("explorer-knowledge").scrollIntoViewIfNeeded();
        await shot("knowledge-reused-phone.png");
    });

    it("Settings → General has “Keep page thumbnails”, on, and saving it off says so", async () => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`${BASE}/#/projects/${projectId}/settings`);
        const card = page.getByTestId("keep-thumbnails-setting");
        await card.waitFor({ timeout: 20_000 });
        const box = card.getByRole("checkbox", { name: /Keep page thumbnails/ });
        expect(await box.isChecked()).toBe(true);
        expect(await axe('[data-testid="keep-thumbnails-setting"]')).toEqual([]);
        await box.uncheck();
        await card.getByRole("button", { name: "Save" }).click();
        await expect.poll(() => card.innerText(), { timeout: 15_000 }).toContain("Later explorations keep no page pictures.");
        expect((await server.inject({ method: "GET", url: `/api/projects/${projectId}/agent-inputs` })).json().keepThumbnails).toBe(false);
        await card.scrollIntoViewIfNeeded();
        await shot("keep-thumbnails-setting.png");
        expect(consoleErrors).toEqual([]);
    });
});
