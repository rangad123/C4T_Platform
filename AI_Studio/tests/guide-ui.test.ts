/**
 * The in-app help in a real browser: the Help button and panel on every place, the Guide page, the glossary, the tour,
 * the "See how" lines, and the usual bar (keyboard, phone width, touch targets, axe in light and dark).
 *
 * The platform underneath is real (seeded through the repo; the page talks to it over HTTP). The one thing stood in for is the
 * empty projects list, to reach the first-run welcome page and the tour with no project, which a seeded platform cannot show.
 * Ports: 6510 platform + UI.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/guide-ui.test.ts
 * Set GUIDE_SHOTS=<folder> to also write screenshots.
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
import { buildServer } from "../src/platform/server.js";
import { routes } from "../web/src/lib/router.js";
import { glossary, topics, wants } from "../web/src/features/guide/content/index.js";
import { PLACES, type PlaceId } from "../web/src/features/guide/places.js";
import { GROUP_TITLES } from "../web/src/features/guide/types.js";
import { whereToHref } from "../web/src/features/guide/where.js";
import { stepsFor } from "../web/src/features/guide/tour-steps.js";
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";


/**
 * No projects at all. The Projects page asks for a page (`?limit=&offset=`, round 37) and gets a page; other callers ask for the
 * plain list and get an empty one, as the server answers.
 */
const PROJECT_LIST = /\/api\/projects(\?[^/]*)?$/;
const noProjects = (route: import("playwright").Route) => {
    if (route.request().method() !== "GET") return route.continue();
    const q = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: q.has("limit") || q.has("offset") ? { projects: [], total: 0, limit: Number(q.get("limit") ?? 20), offset: Number(q.get("offset") ?? 0) } : [] });
};

const PORT = 6510;
const BASE = `http://127.0.0.1:${PORT}`;

let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let shop: Seed;
let empty: Seed;
let jobId = "";
let releaseId = "";
let testId = "";
const consoleErrors: string[] = [];

const api = async (method: string, url: string, payload?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
};

function watch(p: Page) {
    p.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    p.on("pageerror", (e) => consoleErrors.push(String(e)));
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-guide-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    shop = seedProject(platform, "Atlas shop", "http://127.0.0.1:6519");
    for (const k of ["alpha", "beta", "gamma"]) addTest(platform, shop, k);
    await seedRun(platform, shop, { alpha: "pass", beta: "pass", gamma: "fail" }, { daysAgo: 1 });
    testId = shop.tests.get("alpha")!;
    // A project with nothing in it: every empty page must still say how it works.
    empty = seedProject(platform, "Empty shop", null);

    const jobs = (await api("GET", `/api/projects/${shop.projectId}/jobs`)).body;
    jobId = jobs[0].id ?? jobs[0].jobId;
    await api("POST", `/api/projects/${shop.projectId}/blocks`, { name: "Sign in", description: "Sign in with a nickname", kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] });
    releaseId = (await api("POST", `/api/projects/${shop.projectId}/releases`, { name: "Release 1.0" })).body.id;

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    watch(page);
}, 180_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── harness ─────────────────────────────────────────────────────────────────

const shots = process.env.GUIDE_SHOTS;
async function shot(name: string, p: Page = page) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await p.screenshot({ path: path.join(shots, `${name}.png`) });
}
/** A fresh load of a page (a hash change alone would not re-run the page's loads, and the guide remembers the last project). */
async function visit(hash: string, p: Page = page) {
    await p.goto("about:blank");
    await p.goto(`${BASE}/${hash}`);
    await pwExpect(p.locator("h1").first()).toBeVisible();
}
async function noOverflow(label: string) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, label).toBe(0);
}
async function axe(label: string) {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}
/** Light then dark, each after a fresh visit and the 400 ms the colours need to settle. */
async function axeBoth(label: string, hash: string, before: () => Promise<void>) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await visit(hash);
        await before();
        await page.waitForTimeout(400);
        await axe(`${label} (${scheme})`);
    }
    await page.emulateMedia({ colorScheme: null });
}
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const P = () => shop.projectId;
const panel = (p: Page = page) => p.getByRole("complementary", { name: "Help", exact: true });
const sheet = () => page.getByRole("dialog", { name: "Help", exact: true });
const helpBtn = (p: Page = page) => p.locator(".topbar").getByRole("button", { name: "Help", exact: true });
const tourCard = (p: Page = page) => p.getByRole("region", { name: "Guided tour", exact: true });
const offer = (p: Page = page) => p.getByRole("region", { name: "Tour offer", exact: true });
const hash = (p: Page = page) => p.evaluate(() => location.hash);
const topic = (id: string) => topics.find((t) => t.id === id)!;
async function openHelp() {
    await helpBtn().click();
    await pwExpect(panel().or(sheet())).toBeVisible();
}
/** Every button, link, summary and field in `scope` is at least 44 px tall (links inside a sentence are exempt). */
async function targets(scope: string, label: string) {
    const small = await page.evaluate((sel) => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(`${sel} button, ${sel} a, ${sel} summary, ${sel} input, ${sel} select`))) {
            if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue;
            if (el.tagName === "A" && el.closest("p, li > span, .crumbs")) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.height < 43.5) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30)}" is ${Math.round(r.height)}px`);
        }
        return out;
    }, scope);
    expect(small, label).toEqual([]);
}

// ── the Help panel ──────────────────────────────────────────────────────────

/** Every place a person can be in, as an address. */
function everyPlace(): Array<[string, PlaceId]> {
    return [
        [routes.home, "projects"],
        [routes.newProject(), "new-project"],
        [routes.project(P()), "overview"],
        [routes.tests(P()), "tests"],
        [routes.runs(P(), "runs"), "runs-runs"],
        [routes.runs(P(), "schedules"), "runs-schedules"],
        [routes.runs(P(), "deploys"), "runs-deploys"],
        [routes.runs(P(), "trends"), "runs-trends"],
        [routes.run(P(), jobId), "run-detail"],
        // Round 25: the old Library, Release and Setup sections live in Test scripts, Test cases, Runs and Settings, with their help.
        [routes.scripts(P(), "steps"), "library-steps"],
        [routes.blocks(P(), "Sign in"), "library-steps-edit"],
        [routes.scripts(P(), "elements"), "library-elements"],
        [routes.scripts(P(), "helpers"), "library-helpers"],
        [routes.scripts(P(), "library"), "library-library"],
        [routes.projectSettings(P(), "data"), "library-data"],
        [routes.projectSettings(P(), "accounts"), "library-accounts"],
        [routes.runs(P(), "releases"), "release-releases"],
        [routes.cases(P(), "manual"), "release-manual"],
        [routes.runs(P(), "compliance"), "release-compliance"],
        [routes.release(P(), releaseId), "release-detail"],
        // Round 37: a project's runners are on the Runners page (routes.runners(P()) is that place, listed once below as allRunners).
        [routes.projectSettings(P(), "environments"), "setup-environments"],
        [routes.projectSettings(P(), "frameworks"), "setup-frameworks"],
        [routes.projectSettings(P(), "mobile"), "setup-mobile"],
        [routes.projectSettings(P(), "alerts"), "setup-alerts"],
        [routes.projectSettings(P(), "issues"), "setup-issues"],
        [routes.projectSettings(P(), "storage"), "setup-storage"],
        [routes.projectSettings(P(), "general"), "settings-general"],
        [routes.projectSettings(P(), "members"), "settings-members"],
        [routes.projectSettings(P(), "ai"), "settings-ai"],
        [routes.requirements(P()), "requirements"],
        [routes.suites(P()), "suites"],
        [routes.scripts(P()), "scripts"],
        [routes.agentRuns(P()), "agent-runs"],
        [routes.dashboard, "dashboard"],
        [routes.develop, "develop"],
        [routes.allRunners, "runners-global"],
        [routes.integrations, "integrations"],
        [routes.libraries, "libraries"],
        [routes.projectFolders, "folders"],
        [routes.profile, "profile"],
        [routes.testTab(testId, "steps"), "test-steps"],
        [routes.testTab(testId, "text"), "test-text"],
        [routes.testTab(testId, "code"), "test-code"],
        [routes.testTab(testId, "history"), "test-history"],
        [routes.record(P()), "recorder"],
        [routes.writeCode(P(), { title: "My test", kind: "web" }), "write-code"],
        [routes.settings, "settings"],
        [routes.guide, "guide"],
        [routes.guideTopic("schedules"), "guide-topic"],
        [routes.guideWords, "guide-words"],
    ];
}

describe("the Help button and panel", () => {
    it("every place has the button, and the panel says what that place is, with the actions and what next", async () => {
        const places = everyPlace();
        expect(new Set(places.map(([, id]) => id)).size).toBe(places.length);
        for (const [h, id] of places) {
            await visit(h);
            await openHelp();
            const text = norm(await panel().innerText());
            expect(text, `${id}: what`).toContain(norm(PLACES[id].what));
            expect(text, `${id}: title`).toContain(PLACES[id].title);
            for (const heading of ["What is this page", "What you can do here", "What next"]) expect(text, `${id}: ${heading}`).toContain(heading);
            // Each action has its button, and the first one is on screen.
            await pwExpect(panel().getByRole("heading", { name: "What you can do here" })).toBeVisible();
            expect(await panel().locator(".help-actions li").count(), id).toBeGreaterThanOrEqual(4);
            expect(await panel().getByRole("button", { name: "Open the full guide" }).count() + (await panel().getByRole("link", { name: "Open the full guide" }).count()), id).toBe(1);
        }
    }, 240_000);

    it("shows the first-run welcome page's own help, and the plan's, even though their address is the projects list's", async () => {
        await page.route(PROJECT_LIST, noProjects);
        try {
            await visit(routes.home);
            await openHelp();
            expect(norm(await panel().innerText())).toContain(norm(PLACES.welcome.what));
            await shot("welcome-panel");
        } finally {
            await page.unroute(PROJECT_LIST);
        }
    });

    it("follows the person from page to page while it stays open, and goes back to the page's help after a topic", async () => {
        await visit(routes.tests(P()));
        await openHelp();
        expect(norm(await panel().innerText())).toContain(norm(PLACES.tests.what));
        // Click through the real tabs and sections.
        await page.getByRole("navigation", { name: "Project sections", exact: true }).getByRole("link", { name: /^Runs/ }).click();
        await pwExpect(panel()).toContainText(PLACES["runs-runs"].what);
        await page.getByRole("navigation", { name: "Runs sections", exact: true }).getByRole("link", { name: "Schedules", exact: true }).click();
        await pwExpect(panel()).toContainText(PLACES["runs-schedules"].what);
        await page.getByRole("navigation", { name: "Runs sections", exact: true }).getByRole("link", { name: "Trends", exact: true }).click();
        await pwExpect(panel()).toContainText(PLACES["runs-trends"].what);
        // A topic opened in the panel is left behind when the person moves on.
        await panel().getByRole("button", { name: /^Read more:/ }).click();
        await pwExpect(panel().getByRole("button", { name: "Help for this page" })).toBeVisible();
        await page.getByRole("navigation", { name: "Runs sections", exact: true }).getByRole("link", { name: "Schedules", exact: true }).click();
        await pwExpect(panel()).toContainText(PLACES["runs-schedules"].what);
        await pwExpect(panel().getByRole("button", { name: "Help for this page" })).toHaveCount(0);
        // Moving to a test, tab by tab.
        await page.goto(`${BASE}/${routes.testTab(testId, "steps")}`);
        await page.evaluate(() => location.reload());
        await pwExpect(page.locator("h1").first()).toBeVisible();
        await openHelp();
        await pwExpect(panel()).toContainText(PLACES["test-steps"].what);
        for (const [tab, id] of [["Text", "test-text"], ["Code", "test-code"], ["History", "test-history"]] as const) {
            await page.getByRole("tab", { name: tab, exact: true }).click();
            await pwExpect(panel()).toContainText(PLACES[id as PlaceId].what);
        }
    });

    it("Escape closes it and focus goes back to the button that opened it (topbar and sidebar)", async () => {
        await visit(routes.tests(P()));
        await helpBtn().focus();
        await page.keyboard.press("Enter");
        await pwExpect(panel()).toBeVisible();
        await pwExpect(helpBtn()).toHaveAttribute("aria-expanded", "true");
        await pwExpect(page.locator("#help-title")).toBeFocused();
        await page.keyboard.press("Escape");
        await pwExpect(panel()).toHaveCount(0);
        await pwExpect(helpBtn()).toBeFocused();
        await pwExpect(helpBtn()).toHaveAttribute("aria-expanded", "false");

        const side = page.locator(".sidebar").getByRole("button", { name: "Help", exact: true });
        await side.click();
        await pwExpect(panel()).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(panel()).toHaveCount(0);
        await pwExpect(side).toBeFocused();
        // The close button does the same.
        await side.click();
        await panel().getByRole("button", { name: "Close help" }).click();
        await pwExpect(panel()).toHaveCount(0);
        await pwExpect(side).toBeFocused();
    });

    it("searches the whole guide: a question finds the topic, a typo is forgiven, nothing found suggests the chooser", async () => {
        await visit(routes.tests(P()));
        await openHelp();
        const box = panel().getByRole("searchbox", { name: "Search the guide" });
        await box.fill("run tests every night");
        const first = panel().locator(".help-results button").first();
        await pwExpect(first).toContainText(topic("schedules").title);
        await first.click();
        await pwExpect(panel().getByRole("heading", { name: topic("schedules").title, level: 3 })).toBeVisible();
        await pwExpect(panel().getByRole("heading", { name: "How", level: 4 })).toBeVisible();
        expect(await panel().locator(".guide-steps li").count()).toBeGreaterThanOrEqual(2);
        // The topic's own button opens the right place for the current project, and the panel follows.
        const open = topic("schedules").open!;
        await panel().getByRole("link", { name: open.label, exact: true }).click();
        expect(await hash()).toBe(whereToHref(open.to, P()));
        await pwExpect(panel()).toContainText(PLACES["runs-schedules"].what);

        await box.fill("acessibility");
        await pwExpect(panel().locator(".help-results button").first()).toContainText(topic("accessibility").title);
        await box.fill("qqzxv");
        await pwExpect(panel().getByRole("heading", { name: "Nothing found" })).toBeVisible();
        await pwExpect(panel().getByRole("link", { name: /I want to/ })).toBeVisible();
        await box.fill("");
        await pwExpect(panel().getByRole("heading", { name: "What is this page" })).toBeVisible();
    });

    it("on a wide screen sits beside the page: the page narrows, stays usable, and nothing scrolls sideways", async () => {
        await visit(routes.tests(P()));
        const before = await page.locator(".shell > .main").boundingBox();
        await openHelp();
        await pwExpect(page.locator(".shell")).toHaveClass(/help-docked/);
        const main = await page.locator(".shell > .main").boundingBox();
        const side = await panel().boundingBox();
        expect(main!.width).toBeLessThan(before!.width);
        expect(main!.x + main!.width).toBeLessThanOrEqual(side!.x + 1);
        expect(await page.evaluate(() => (document.querySelector(".shell") as HTMLElement & { inert?: boolean }).inert)).toBeFalsy();
        await noOverflow("tests, panel docked");
        // Not modal: a click on the page goes through to the page.
        await page.getByRole("navigation", { name: "Project sections", exact: true }).getByRole("link", { name: /^Test scripts/ }).click();
        await pwExpect(page.getByRole("heading", { name: "Test scripts", level: 1 })).toBeVisible();
        await pwExpect(panel()).toBeVisible();
        await noOverflow("test scripts, panel docked");
        await visit(routes.guide);
        await openHelp();
        await noOverflow("guide, panel docked");
        await shot("panel-wide");
    });

    it("on a middle screen floats over the right edge without switching the page off", async () => {
        await page.setViewportSize({ width: 1100, height: 900 });
        try {
            await visit(routes.tests(P()));
            await openHelp();
            await pwExpect(page.locator(".shell")).not.toHaveClass(/help-docked/);
            expect(await page.evaluate(() => (document.querySelector(".shell") as HTMLElement & { inert?: boolean }).inert)).toBeFalsy();
            const box = await panel().boundingBox();
            expect(box!.x + box!.width).toBeGreaterThanOrEqual(1099);
            await page.locator(".sidebar").getByRole("link", { name: "Projects", exact: true }).click();
            expect(await hash()).toBe("#/");
            await pwExpect(panel()).toBeVisible();
            await noOverflow("projects, panel floating");
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("on a phone is a full-height sheet that is a modal dialog: the page behind is off, a tap outside or Escape closes it", async () => {
        for (const width of [390, 375, 768]) {
            await page.setViewportSize({ width, height: 800 });
            try {
                await visit(routes.tests(P()));
                await helpBtn().click();
                await pwExpect(sheet()).toBeVisible();
                await pwExpect(sheet()).toHaveAttribute("aria-modal", "true");
                expect(await page.evaluate(() => (document.querySelector(".shell") as HTMLElement & { inert?: boolean }).inert), `${width}px: page is switched off`).toBe(true);
                const box = await sheet().boundingBox();
                expect(box!.height, `${width}px: full height`).toBeGreaterThanOrEqual(799);
                await noOverflow(`${width}px sheet`);
                // Focus cannot leave the sheet by keyboard.
                for (let i = 0; i < 25; i++) {
                    await page.keyboard.press("Tab");
                    expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".help-panel"))), `${width}px: focus stays in the sheet after ${i + 1} Tabs`).toBe(true);
                }
                if (width === 768) {
                    // The scrim is the part of the page the sheet does not cover.
                    await page.mouse.click(40, 400);
                    await pwExpect(sheet()).toHaveCount(0);
                    await pwExpect(helpBtn()).toBeFocused();
                } else {
                    await page.keyboard.press("Escape");
                    await pwExpect(sheet()).toHaveCount(0);
                    await pwExpect(helpBtn()).toBeFocused();
                }
                expect(await page.evaluate(() => (document.querySelector(".shell") as HTMLElement & { inert?: boolean }).inert), `${width}px: page is back`).toBeFalsy();
                if (width === 390) {
                    await openHelp();
                    await shot("panel-phone");
                }
            } finally {
                await page.setViewportSize({ width: 1280, height: 900 });
            }
        }
    });

    it("works by keyboard alone: reach Help, open it, search, open a topic, close it", async () => {
        await visit(routes.tests(P()));
        let reached = false;
        for (let i = 0; i < 80 && !reached; i++) {
            await page.keyboard.press("Tab");
            reached = await page.evaluate(() => document.activeElement?.hasAttribute("data-help-button") === true && document.activeElement?.closest(".topbar") !== null);
        }
        expect(reached, "Tab reaches the Help button in the top bar").toBe(true);
        await page.keyboard.press("Enter");
        await pwExpect(panel()).toBeVisible();
        let search = false;
        for (let i = 0; i < 8 && !search; i++) {
            await page.keyboard.press("Tab");
            search = await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type === "search");
        }
        expect(search, "Tab reaches the search box").toBe(true);
        await page.keyboard.type("stop a run");
        // Past the "Help for this page" button, the first result is next.
        let inResults = false;
        for (let i = 0; i < 4 && !inResults; i++) {
            await page.keyboard.press("Tab");
            inResults = await page.evaluate(() => Boolean(document.activeElement?.closest(".help-results")));
        }
        expect(inResults, "Tab reaches the results").toBe(true);
        await page.keyboard.press("Enter");
        await pwExpect(panel().getByRole("heading", { name: topic("stop-a-run").title, level: 3 })).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(panel()).toHaveCount(0);
    });

    it("touch targets in the panel and the Help buttons are at least 44 px", async () => {
        await visit(routes.tests(P()));
        await openHelp();
        await targets(".help-panel", "panel, this page");
        await targets(".topbar", "top bar");
        await panel().getByRole("button", { name: /^Read more:/ }).click();
        await targets(".help-panel", "panel, a topic");
        await panel().getByRole("searchbox").fill("night");
        await targets(".help-panel", "panel, search results");
        await page.setViewportSize({ width: 390, height: 800 });
        try {
            await visit(routes.tests(P()));
            await helpBtn().click();
            await targets(".help-panel", "sheet");
            await targets(".topbar", "top bar, phone");
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("is accessible in light and dark: docked panel, a topic in it, and the phone sheet", async () => {
        await axeBoth("panel on Tests", routes.tests(P()), openHelp);
        await axeBoth("a topic in the panel", routes.tests(P()), async () => {
            await openHelp();
            await panel().getByRole("button", { name: /^Read more:/ }).click();
            await pwExpect(panel().getByRole("button", { name: "Help for this page" })).toBeVisible();
        });
        await axeBoth("search results in the panel", routes.tests(P()), async () => {
            await openHelp();
            await panel().getByRole("searchbox").fill("run tests every night");
            await pwExpect(panel().locator(".help-results button").first()).toBeVisible();
        });
        await page.setViewportSize({ width: 390, height: 800 });
        try {
            await axeBoth("phone sheet", routes.tests(P()), async () => {
                await helpBtn().click();
                await pwExpect(sheet()).toBeVisible();
            });
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    }, 120_000);

    it("looks right (screenshots, when asked for)", async () => {
        if (!shots) return;
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            for (const [width, tag] of [[1280, "wide"], [390, "phone"]] as const) {
                await page.setViewportSize({ width, height: width === 1280 ? 900 : 800 });
                for (const [h, name] of [[routes.tests(P()), "tests"], [routes.run(P(), jobId), "run"], [routes.testTab(testId, "steps"), "workbench"]] as const) {
                    await visit(h);
                    await openHelp();
                    await page.waitForTimeout(450);
                    await shot(`help-${name}-${tag}-${scheme}`);
                }
            }
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.emulateMedia({ colorScheme: null });
    }, 120_000);
});

// ── "See how" on empty pages ────────────────────────────────────────────────

describe("See how lines", () => {
    const seeHow = () => page.getByRole("button", { name: "See how", exact: true });
    const cases: Array<[string, () => string, string]> = [
        ["Test cases (empty project)", () => routes.tests(empty.projectId), topic("first-steps").title],
        ["Runs (empty project)", () => routes.runs(empty.projectId), topic("run-panel").title],
        ["Reusable steps (empty project)", () => routes.scripts(empty.projectId, "steps"), topic("reusable-steps").title],
        ["Shared elements (empty project)", () => routes.scripts(empty.projectId, "elements"), topic("shared-elements").title],
        ["Helpers (empty project)", () => routes.scripts(empty.projectId, "helpers"), topic("write-code").title],
        ["Test data (empty project)", () => routes.projectSettings(empty.projectId, "data"), topic("test-data").title],
        ["Test accounts (empty project)", () => routes.projectSettings(empty.projectId, "accounts"), topic("test-accounts").title],
    ];
    it.each(cases)("%s opens its topic in the panel", async (_n, h, title) => {
        await visit(h());
        await pwExpect(seeHow()).toBeVisible();
        await seeHow().click();
        await pwExpect(panel()).toBeVisible();
        await pwExpect(panel().getByRole("heading", { name: title, level: 3 })).toBeVisible();
        // The page is not left: the address is the same page's.
        await page.keyboard.press("Escape");
        await pwExpect(panel()).toHaveCount(0);
    });

    it("the first-run welcome page has one too", async () => {
        await page.route(PROJECT_LIST, noProjects);
        try {
            await visit(routes.home);
            await seeHow().click();
            await pwExpect(panel().getByRole("heading", { name: topic("first-steps").title, level: 3 })).toBeVisible();
        } finally {
            await page.unroute(PROJECT_LIST);
        }
    });

    it("a page with content does not show the line", async () => {
        await visit(routes.tests(P()));
        await pwExpect(page.getByRole("link", { name: /Check alpha/ })).toBeVisible();
        await pwExpect(seeHow()).toHaveCount(0);
    });
});

// ── the Guide page ──────────────────────────────────────────────────────────

describe("the Guide page", () => {
    it("starts with what a person wants to do, then every topic by group", async () => {
        await visit(routes.guide);
        await pwExpect(page.getByRole("heading", { name: "I want to…", level: 2 })).toBeVisible();
        const wantLinks = page.locator("a.guide-want");
        expect(await wantLinks.count()).toBe(wants.filter((w) => topics.some((t) => t.id === w.topic)).length);
        expect(await wantLinks.count()).toBeGreaterThanOrEqual(25);
        for (const g of Object.values(GROUP_TITLES)) await pwExpect(page.getByRole("heading", { name: g, level: 3 })).toBeVisible();
        expect(await page.locator(".guide-index a").count()).toBe(topics.length);
        await pwExpect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Guide");
        await shot("guide-page");
        // Each "I want to" opens its own topic.
        const w = wants[0]!;
        await wantLinks.first().click();
        await pwExpect(page.getByRole("heading", { name: topic(w.topic).title, level: 1 })).toBeVisible();
        expect(await hash()).toBe(routes.guideTopic(w.topic));
    });

    it("a topic page has what it is, why, numbered steps with the on-screen names in bold, good to know, words, related topics and technical detail", async () => {
        const t = topics.find((x) => x.steps.some((s: { ui?: string[] }) => s.ui?.length) && x.goodToKnow?.length && x.words?.length && x.related?.length && x.moreDoc && x.open)!;
        expect(t, "a topic with every part").toBeDefined();
        await visit(routes.guideTopic(t.id));
        await pwExpect(page.getByRole("heading", { name: t.title, level: 1 })).toBeVisible();
        for (const h of ["What it is", "Why you’d use it", "How", "Good to know", "Words in this topic", "Related topics"]) await pwExpect(page.getByRole("heading", { name: h, level: 2 })).toBeVisible();
        expect(await page.locator("ol.guide-steps li").count()).toBe(t.steps.length);
        const name = t.steps.flatMap((s: { ui?: string[] }) => s.ui ?? [])[0]!;
        await pwExpect(page.locator("ol.guide-steps strong", { hasText: name }).first()).toBeVisible();
        await pwExpect(page.locator(".guide-more summary")).toHaveText("More technical detail");
        await page.locator(".guide-more summary").click();
        await pwExpect(page.locator(".guide-more")).toContainText(t.moreDoc!);
        // The technical document is named, not linked.
        expect(await page.locator(".guide-more a").count()).toBe(0);
        await pwExpect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(t.title);
        await shot("guide-topic");
        // A related topic opens.
        const rel = topic(t.related![0]!);
        await page.locator(".guide-related a").first().click();
        await pwExpect(page.getByRole("heading", { name: rel.title, level: 1 })).toBeVisible();
    });

    it("'Open it in the app' with several projects and none current asks which one, then lands in the right place and section", async () => {
        for (const id of ["schedules", "storage-and-backup"]) {
            const t = topic(id);
            expect(t.open, id).toBeDefined();
            await visit(routes.guideTopic(id));
            await pwExpect(page.locator("#guide-project")).toBeVisible();
            await pwExpect(page.getByRole("link", { name: t.open!.label, exact: true })).toHaveCount(0);
            await pwExpect(page.locator(".guide-open button", { hasText: t.open!.label })).toBeDisabled();
            await page.locator("#guide-project").selectOption({ label: "Atlas shop" });
            await page.getByRole("link", { name: t.open!.label, exact: true }).click();
            await page.waitForFunction((h) => location.hash === h, whereToHref(t.open!.to, P()));
            // Setup is the project's Settings since round 25.
            const place = t.open!.to.place === "runs" ? "Runs" : "Settings";
            await pwExpect(page.getByRole("heading", { name: place, level: 1 })).toBeVisible();
            if (t.open!.to.section) await pwExpect(page.getByRole("navigation", { name: `${place} sections`, exact: true }).locator('[aria-current="page"]')).toBeVisible();
        }
    });

    it("'Open it in the app' uses the project the person was in, with no question", async () => {
        await visit(routes.tests(P()));
        await openHelp();
        await panel().getByRole("link", { name: "Open the full guide" }).click();
        await pwExpect(page.getByRole("heading", { name: "Guide", level: 1 })).toBeVisible();
        await page.locator("#content").getByRole("searchbox", { name: "Search all topics" }).fill("run tests every night");
        const t = topic("schedules");
        await page.locator(".guide-hits a").first().click();
        await pwExpect(page.getByRole("heading", { name: t.title, level: 1 })).toBeVisible();
        await pwExpect(page.locator("#guide-project")).toHaveCount(0);
        await page.getByRole("link", { name: t.open!.label, exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Runs", level: 1 })).toBeVisible();
        expect(await hash()).toBe(routes.runs(P(), "schedules"));
    });

    it("with no project at all it says so instead of offering a dead button", async () => {
        await page.route(PROJECT_LIST, noProjects);
        try {
            await visit(routes.guideTopic("schedules"));
            await pwExpect(page.getByText("you have none yet")).toBeVisible();
            await pwExpect(page.getByRole("link", { name: "Start a project" })).toBeVisible();
        } finally {
            await page.unroute(PROJECT_LIST);
        }
    });

    it("searches: a question finds the topic, nothing found offers the chooser again, clearing brings the chooser back", async () => {
        await visit(routes.guide);
        const box = page.getByRole("searchbox", { name: "Search all topics" });
        await box.fill("run tests every night");
        await pwExpect(page.locator(".guide-hits a").first()).toContainText(topic("schedules").title);
        await pwExpect(page.locator("a.guide-want")).toHaveCount(0);
        await box.fill("zzzzqx");
        await pwExpect(page.getByRole("heading", { name: "Nothing found" })).toBeVisible();
        await page.getByRole("button", { name: "Show what I want to do" }).click();
        await pwExpect(page.locator("a.guide-want").first()).toBeVisible();
    });

    it("has a page of words in alphabetical order that also finds the older names", async () => {
        await visit(routes.guideWords);
        await pwExpect(page.getByRole("heading", { name: "Words", level: 1 })).toBeVisible();
        const terms = await page.locator(".guide-glossary dt").allTextContents();
        expect(terms.length).toBe(glossary.length);
        expect(terms).toEqual([...terms].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
        const old = glossary.find((g) => g.alsoCalled?.length)!;
        await page.getByRole("searchbox", { name: "Search the words" }).fill(old.alsoCalled![0]!);
        await pwExpect(page.locator(".guide-glossary dt", { hasText: old.term }).first()).toBeVisible();
        await page.getByRole("searchbox", { name: "Search the words" }).fill("qqzxv");
        await pwExpect(page.getByRole("heading", { name: "No word like that" })).toBeVisible();
        await visit(`${routes.guideWords}?word=${glossary[3]!.id}`);
        await pwExpect(page.locator(`#word-${glossary[3]!.id}`)).toBeVisible();
        await shot("guide-words");
    });

    it("says plainly when a topic is not there", async () => {
        await visit(routes.guideTopic("no-such-topic"));
        await pwExpect(page.getByRole("heading", { name: "We can’t find that topic" })).toBeVisible();
        await page.getByRole("link", { name: "Open the Guide" }).click();
        await pwExpect(page.getByRole("heading", { name: "Guide", level: 1 })).toBeVisible();
    });

    it("never scrolls sideways, at 375, 390, 768 and 1280", async () => {
        for (const width of [375, 390, 768, 1280]) {
            await page.setViewportSize({ width, height: 800 });
            try {
                for (const h of [routes.guide, routes.guideTopic("schedules"), routes.guideWords]) {
                    await visit(h);
                    await page.waitForTimeout(150);
                    await noOverflow(`${h} at ${width}px`);
                }
            } finally {
                await page.setViewportSize({ width: 1280, height: 900 });
            }
        }
    });

    it("touch targets on the Guide pages are at least 44 px", async () => {
        for (const h of [routes.guide, routes.guideTopic("schedules"), routes.guideWords]) {
            await visit(h);
            await targets(".content", h);
        }
    });

    it("is accessible in light and dark: the Guide, a topic, the words", async () => {
        await axeBoth("guide page", routes.guide, async () => undefined);
        await axeBoth("topic page", routes.guideTopic("schedules"), async () => undefined);
        await axeBoth("topic page, with the project chooser", routes.guideTopic("storage-and-backup"), async () => undefined);
        await axeBoth("words page", routes.guideWords, async () => undefined);
    }, 120_000);

    it("can be printed: the chrome is hidden and the content is not", async () => {
        await visit(routes.guideTopic("schedules"));
        await page.emulateMedia({ media: "print" });
        try {
            expect(await page.locator(".sidebar").isVisible()).toBe(false);
            expect(await page.locator(".topbar").isVisible()).toBe(false);
            await pwExpect(page.getByRole("heading", { name: topic("schedules").title, level: 1 })).toBeVisible();
        } finally {
            await page.emulateMedia({ media: "screen" });
        }
    });
});

// ── the tour ────────────────────────────────────────────────────────────────

async function freshPage(opts: { viewport?: { width: number; height: number }; reducedMotion?: "reduce"; blockStorage?: boolean } = {}) {
    const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 900 }, ...(opts.reducedMotion ? { reducedMotion: opts.reducedMotion } : {}) });
    if (opts.blockStorage) await ctx.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new Error("storage is blocked"); } }));
    const p = await ctx.newPage();
    watch(p);
    return { ctx, p };
}
const stored = (p: Page) => p.evaluate(() => localStorage.getItem("guide.tour"));

describe("the guided tour", () => {
    /** The steps the tour shows in Atlas shop (the same rules the tour uses): tests, a failing one, a run, a release, the module on. */
    const shopSteps = () => stepsFor({ project: P(), test: testId, failing: shop.tests.get("gamma"), job: jobId, release: releaseId, module: true });
    const around = () => shopSteps().filter((s) => s.chapter === "around");
    const counted = (p: Page) => tourCard(p).locator(".tour-count");
    /** From the chapter list (where every start lands) to the first step. */
    async function begin(p: Page) {
        await pwExpect(tourCard(p).getByRole("heading", { name: "Take the tour" })).toBeVisible({ timeout: 8000 });
        await tourCard(p).getByRole("button", { name: "Start from the beginning", exact: true }).click();
    }

    it("is offered once on a first visit, never to an automated browser by default, and remembers 'Not now'", async () => {
        const { ctx, p } = await freshPage();
        try {
            // Quiet by default under automation: this is what keeps the existing UI tests unchanged.
            await p.goto(`${BASE}/#/`);
            await pwExpect(p.locator("h1").first()).toBeVisible();
            await p.waitForTimeout(1600);
            await pwExpect(offer(p)).toHaveCount(0);
            // Asked for, it appears, small and not blocking.
            await p.goto(`${BASE}/?tour=1#/`);
            await pwExpect(offer(p)).toBeVisible({ timeout: 8000 });
            await pwExpect(offer(p)).toContainText("New here? Take the guided tour, one chapter at a time.");
            expect(await offer(p).getByRole("button").allTextContents()).toEqual(["Start the tour", "Not now"]);
            expect(await p.evaluate(() => document.querySelector(".tour-offer")?.getBoundingClientRect().width)).toBeLessThan(400);
            await p.getByRole("button", { name: "Not now", exact: true }).click();
            await pwExpect(offer(p)).toHaveCount(0);
            expect(await stored(p)).toBe("later");
            // Remembered: not offered again, even when asked for.
            await p.goto(`${BASE}/?tour=1#/`);
            await p.waitForTimeout(1600);
            await pwExpect(offer(p)).toHaveCount(0);
            // And `?notour=1` is always quiet.
            await p.evaluate(() => localStorage.clear());
            await p.goto(`${BASE}/?tour=1&notour=1#/`);
            await p.waitForTimeout(1600);
            await pwExpect(offer(p)).toHaveCount(0);
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("walks the first chapter pinned to real elements: the chapter list, Next, Back, the counter with the chapter, then Finish", async () => {
        const { ctx, p } = await freshPage();
        try {
            await p.goto(`${BASE}/?tour=1#/projects/${P()}`);
            await pwExpect(p.locator("h1").first()).toBeVisible();
            await pwExpect(offer(p)).toBeVisible({ timeout: 8000 });
            await p.getByRole("button", { name: "Start the tour", exact: true }).click();
            // The chapter list first: this project has no phone app and does not use security assessment, so those are left out.
            const list = tourCard(p).getByRole("list", { name: "Chapters" });
            await pwExpect(list).toBeVisible({ timeout: 8000 });
            expect((await list.getByRole("button").allTextContents()).map((t) => t.trim())).toEqual(["Getting around", "Making tests", "Running and results", "Release and settings", "Help"]);
            await begin(p);
            const all = shopSteps();
            const card = tourCard(p);
            const steps = around();
            for (let i = 0; i < steps.length; i++) {
                const s = steps[i]!;
                await pwExpect(card.getByRole("heading", { name: s.title, exact: true })).toBeVisible({ timeout: 8000 });
                expect(norm(await counted(p).innerText()), s.id).toBe(`Step ${i + 1} of ${all.length} · Getting around`);
                // The target is outlined, and the card sits beside it, inside the window.
                await pwExpect(p.locator(`[data-tour="${s.target}"]`).first()).toHaveClass(/tour-target/, { timeout: 5000 });
                expect(await hash(p), s.id).toMatch(/#\/projects\/[^/]+$/);
                const t = await p.locator(`[data-tour="${s.target}"]`).first().boundingBox();
                const c = await card.boundingBox();
                expect(c!.x, s.id).toBeGreaterThanOrEqual(0);
                expect(c!.y, s.id).toBeGreaterThanOrEqual(0);
                expect(c!.x + c!.width, s.id).toBeLessThanOrEqual(1281);
                expect(c!.y + c!.height, s.id).toBeLessThanOrEqual(901);
                const near = c!.y >= t!.y + t!.height - 1 || c!.y + c!.height <= t!.y + 1;
                expect(near, `${s.id}: the card is above or below its target, not on it`).toBe(true);
                // Steps are announced politely, and the page is not dimmed.
                await pwExpect(card.locator('[aria-live="polite"]')).toBeVisible();
                if (i === 0) {
                    await pwExpect(card.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
                    await shot("tour-step", p);
                }
                if (i === 2) {
                    // Back goes back, and forward again.
                    await card.getByRole("button", { name: "Back", exact: true }).click();
                    await pwExpect(counted(p)).toContainText(`Step 2 of ${all.length}`);
                    await card.getByRole("button", { name: "Next", exact: true }).click();
                    await pwExpect(counted(p)).toContainText(`Step 3 of ${all.length}`);
                }
                await card.getByRole("button", { name: "Next", exact: true }).click();
            }
            // The next chapter starts on the Tests page.
            await pwExpect(counted(p)).toContainText(`Step ${steps.length + 1} of ${all.length} · Making tests`, { timeout: 8000 });
            await pwExpect(p).toHaveURL(/#\/projects\/[^/]+\/tests$/);
            // Straight to the last chapter, and through it to the end.
            await card.locator("summary", { hasText: "Chapters" }).click();
            await card.locator(".tour-chapters").getByRole("button", { name: "Help", exact: true }).click();
            const help = all.filter((s) => s.chapter === "help");
            for (const s of help.slice(0, -1)) {
                await pwExpect(card.getByRole("heading", { name: s.title, exact: true })).toBeVisible({ timeout: 8000 });
                await card.getByRole("button", { name: "Next", exact: true }).click();
            }
            await pwExpect(card.getByRole("button", { name: "Finish", exact: true })).toBeVisible({ timeout: 8000 });
            await card.getByRole("button", { name: "Finish", exact: true }).click();
            await pwExpect(card).toHaveCount(0);
            expect(await p.locator(".tour-target").count()).toBe(0);
            expect(await stored(p)).toBe("done");
            // The page was never covered: nothing full-screen sits over it.
            expect(await p.evaluate(() => Array.from(document.querySelectorAll("body *")).some((el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.position === "fixed" && r.width >= innerWidth - 2 && r.height >= innerHeight - 2; }))).toBe(false);
        } finally {
            await ctx.close();
        }
    }, 120_000);

    it("End tour and Escape end it, and it can be started again from Help", async () => {
        const { ctx, p } = await freshPage();
        try {
            await p.goto(`${BASE}/#/projects/${P()}`);
            await pwExpect(p.locator("h1").first()).toBeVisible();
            for (const how of ["end", "escape"]) {
                await helpBtn(p).click();
                await panel(p).getByRole("button", { name: "Take the tour" }).click();
                // Starting the tour closes the panel, so the two never fight for the screen.
                await pwExpect(panel(p)).toHaveCount(0);
                await begin(p);
                await pwExpect(counted(p)).toContainText(`Step 1 of ${shopSteps().length}`, { timeout: 8000 });
                if (how === "end") await tourCard(p).getByRole("button", { name: "End tour", exact: true }).click();
                else await p.keyboard.press("Escape");
                await pwExpect(tourCard(p)).toHaveCount(0);
                expect(await stored(p)).toBe("skipped");
                expect(await p.locator(".tour-target").count()).toBe(0);
            }
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("passes over a step whose target is not there, quietly, and the counter stays honest", async () => {
        const { ctx, p } = await freshPage();
        try {
            await p.goto(`${BASE}/#/projects/${P()}`);
            await pwExpect(p.locator("h1").first()).toBeVisible();
            await helpBtn(p).click();
            await panel(p).getByRole("button", { name: "Take the tour" }).click();
            await begin(p);
            const all = shopSteps();
            const card = tourCard(p);
            // Round 37 order: Test scripts, then Test suites.
            const at = all.findIndex((s) => s.id === "tab-scripts");
            expect(all[at + 1]!.id).toBe("tab-suites");
            for (let i = 0; i < at; i++) {
                await pwExpect(counted(p)).toContainText(`Step ${i + 1} of ${all.length}`, { timeout: 8000 });
                await card.getByRole("button", { name: "Next", exact: true }).click();
            }
            await pwExpect(card.getByRole("heading", { name: all[at]!.title, exact: true })).toBeVisible({ timeout: 8000 });
            // The Test suites tab goes away (as if the page had no such tab): the tour moves on without a word.
            await p.evaluate(() => document.querySelector('[data-tour="tab-suites"]')?.removeAttribute("data-tour"));
            await card.getByRole("button", { name: "Next", exact: true }).click();
            await pwExpect(card.getByRole("heading", { name: all[at + 2]!.title, exact: true })).toBeVisible({ timeout: 10_000 });
            await pwExpect(counted(p)).toContainText(`Step ${at + 2} of ${all.length - 1}`);
            expect(await p.locator('[role="alert"]').count()).toBe(0);
            await card.getByRole("button", { name: "End tour", exact: true }).click();
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("with no project explains that plainly instead of pointing at nothing", async () => {
        const { ctx, p } = await freshPage();
        try {
            await p.route(PROJECT_LIST, noProjects);
            await p.goto(`${BASE}/?tour=1#/`);
            await pwExpect(offer(p)).toBeVisible({ timeout: 8000 });
            await p.getByRole("button", { name: "Start the tour", exact: true }).click();
            const expected = stepsFor({ module: true });
            await begin(p);
            const card = tourCard(p);
            await pwExpect(counted(p)).toContainText(`Step 1 of ${expected.length} · Getting around`);
            // The tour starts in the sidebar: Dashboard is its first place since round 25.
            expect(expected[0]!.id).toBe("nav-dashboard");
            await pwExpect(card.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
            const plainAt = expected.findIndex((s) => s.id === "no-project");
            for (let i = 1; i <= plainAt; i++) await card.getByRole("button", { name: "Next", exact: true }).click();
            await pwExpect(counted(p)).toContainText(`Step ${plainAt + 1} of ${expected.length}`);
            await pwExpect(card.getByRole("heading", { name: "The rest needs a project" })).toBeVisible();
            expect(await p.locator(".tour-target").count()).toBe(0);
            await card.getByRole("button", { name: "Next", exact: true }).click();
            await pwExpect(card.getByRole("heading", { name: "Help is always here" })).toBeVisible();
            await pwExpect(counted(p)).toContainText(`· Help`);
            await card.getByRole("button", { name: "End tour", exact: true }).click();
            await pwExpect(card).toHaveCount(0);
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("works when browser storage is blocked: offered each load, never twice in one visit, nothing breaks", async () => {
        const errorsBefore = consoleErrors.length;
        const { ctx, p } = await freshPage({ blockStorage: true });
        try {
            await p.goto(`${BASE}/?tour=1#/`);
            await pwExpect(p.locator("h1").first()).toBeVisible();
            await pwExpect(offer(p)).toBeVisible({ timeout: 8000 });
            await p.getByRole("button", { name: "Not now", exact: true }).click();
            await pwExpect(offer(p)).toHaveCount(0);
            // Moving around in the same visit does not bring it back.
            await p.evaluate((h) => { location.hash = h; }, routes.settings);
            await pwExpect(p.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
            await p.waitForTimeout(1600);
            await pwExpect(offer(p)).toHaveCount(0);
            // The tour itself still runs.
            await helpBtn(p).click();
            await panel(p).getByRole("button", { name: "Take the tour" }).click();
            await begin(p);
            await pwExpect(counted(p)).toContainText(/Step 1 of \d+/, { timeout: 8000 });
            await p.keyboard.press("Escape");
            await pwExpect(tourCard(p)).toHaveCount(0);
            // A new load asks again (there is nowhere to remember the answer), which is the honest behaviour.
            await p.goto("about:blank");
            await p.goto(`${BASE}/?tour=1#/`);
            await pwExpect(offer(p)).toBeVisible({ timeout: 8000 });
        } finally {
            await ctx.close();
        }
        expect(consoleErrors.slice(errorsBefore), "no errors with storage blocked").toEqual([]);
    }, 90_000);

    it("respects reduced motion: nothing animates while the tour runs", async () => {
        const { ctx, p } = await freshPage({ reducedMotion: "reduce" });
        try {
            await p.goto(`${BASE}/#/projects/${P()}`);
            await pwExpect(p.locator("h1").first()).toBeVisible();
            await helpBtn(p).click();
            await panel(p).getByRole("button", { name: "Take the tour" }).click();
            await begin(p);
            await pwExpect(counted(p)).toContainText("Step 1 of", { timeout: 8000 });
            await tourCard(p).getByRole("button", { name: "Next", exact: true }).click();
            await pwExpect(counted(p)).toContainText("Step 2 of");
            expect(await p.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
            expect(await p.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && (a.effect?.getComputedTiming().duration as number) > 1).length)).toBe(0);
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("on a phone the card stays on screen beside its target, and targets off screen (the sidebar) are skipped", async () => {
        const { ctx, p } = await freshPage({ viewport: { width: 390, height: 800 } });
        try {
            await p.goto(`${BASE}/#/projects/${P()}`);
            await pwExpect(p.locator("h1").first()).toBeVisible();
            await helpBtn(p).click();
            await pwExpect(p.getByRole("dialog", { name: "Help" })).toBeVisible();
            await p.getByRole("dialog", { name: "Help" }).getByRole("button", { name: "Take the tour" }).click();
            await begin(p);
            const card = tourCard(p);
            // The sidebar is behind the menu on a phone, so its steps are passed over and the count leaves them out.
            const sidebar = shopSteps().filter((s) => s.target?.startsWith("nav-")).length;
            await pwExpect(card.getByRole("heading", { name: "The places of a project" })).toBeVisible({ timeout: 8000 });
            await pwExpect(counted(p)).toContainText(`Step 1 of ${shopSteps().length - sidebar}`);
            const box = await card.boundingBox();
            const t = await p.locator('[data-tour="project-tabs"]').boundingBox();
            expect(box!.x).toBeGreaterThanOrEqual(8);
            expect(box!.x + box!.width).toBeLessThanOrEqual(382);
            expect(box!.y).toBeGreaterThanOrEqual(0);
            expect(box!.y + box!.height).toBeLessThanOrEqual(800);
            expect(box!.y >= t!.y + t!.height - 1 || box!.y + box!.height <= t!.y + 1, "the card does not cover the tabs").toBe(true);
            await noOverflowOn(p, "tour on a phone");
            await shot("tour-phone", p);
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("by keyboard: the card takes focus, Enter goes on, Escape ends", async () => {
        const { ctx, p } = await freshPage();
        try {
            await p.goto(`${BASE}/#/projects/${P()}`);
            await pwExpect(p.locator("h1").first()).toBeVisible();
            await helpBtn(p).focus();
            await p.keyboard.press("Enter");
            await p.getByRole("button", { name: "Take the tour" }).focus();
            await p.keyboard.press("Enter");
            await pwExpect(tourCard(p).getByRole("button", { name: "Start from the beginning", exact: true })).toBeFocused({ timeout: 8000 });
            await p.keyboard.press("Enter");
            await pwExpect(counted(p)).toContainText("Step 1 of", { timeout: 8000 });
            await pwExpect(tourCard(p).getByRole("button", { name: "Next", exact: true })).toBeFocused({ timeout: 5000 });
            await p.keyboard.press("Enter");
            await pwExpect(counted(p)).toContainText("Step 2 of");
            await pwExpect(tourCard(p).getByRole("button", { name: "Next", exact: true })).toBeFocused({ timeout: 5000 });
            await p.keyboard.press("Escape");
            await pwExpect(tourCard(p)).toHaveCount(0);
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("touch targets in the tour card and the offer are at least 44 px", async () => {
        const { ctx, p } = await freshPage();
        try {
            const saved = page;
            // `targets` measures the shared page: point it at this one for a moment.
            page = p;
            try {
                await p.goto(`${BASE}/?tour=1#/projects/${P()}`);
                await pwExpect(offer(p)).toBeVisible({ timeout: 8000 });
                await targets(".tour-offer", "offer");
                await p.getByRole("button", { name: "Start the tour", exact: true }).click();
                await pwExpect(tourCard(p).getByRole("heading", { name: "Take the tour" })).toBeVisible({ timeout: 8000 });
                await targets(".tour-card", "chapter list");
                await begin(p);
                await pwExpect(counted(p)).toContainText("Step 1 of", { timeout: 8000 });
                await targets(".tour-card", "tour card");
            } finally {
                page = saved;
            }
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("is accessible in light and dark: the offer and a tour step", async () => {
        for (const scheme of ["light", "dark"] as const) {
            const { ctx, p } = await freshPage();
            try {
                await p.emulateMedia({ colorScheme: scheme });
                await p.goto(`${BASE}/?tour=1#/projects/${P()}`);
                await pwExpect(offer(p)).toBeVisible({ timeout: 8000 });
                await p.waitForTimeout(400);
                let result = await new AxeBuilder({ page: p }).analyze();
                expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `offer (${scheme})`).toEqual([]);
                await p.getByRole("button", { name: "Start the tour", exact: true }).click();
                await begin(p);
                await pwExpect(counted(p)).toContainText("Step 1 of", { timeout: 8000 });
                await tourCard(p).getByRole("button", { name: "Next", exact: true }).click();
                await pwExpect(counted(p)).toContainText("Step 2 of");
                await pwExpect(p.locator(".tour-target")).toHaveCount(1);
                await p.waitForTimeout(400);
                result = await new AxeBuilder({ page: p }).analyze();
                expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `tour step (${scheme})`).toEqual([]);
                if (shots && scheme === "dark") await p.screenshot({ path: path.join(shots, "tour-step-dark.png") });
            } finally {
                await ctx.close();
            }
        }
    }, 90_000);
});

async function noOverflowOn(p: Page, label: string) {
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, label).toBe(0);
}

describe("the whole run", () => {
    it("raised no browser errors", () => {
        expect(consoleErrors).toEqual([]);
    });
});
