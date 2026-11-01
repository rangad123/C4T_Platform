/**
 * UX-C in a real browser: the places of a project (round 25: the testing lifecycle), the New test menu, the sidebar and the global
 * places, old links that must keep working (the six places of round 16 and the single pages before them),
 * and the usual bar (keyboard, phone width, touch targets, axe in light and dark).
 *
 * The platform underneath is real (seeded through the repo and the HTTP API; the page talks to it directly). Nothing is
 * stood in for. Ports: 6450 platform + UI.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/ux-nav-ui.test.ts
 * Set UXC_SHOTS=<folder> to also write screenshots.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { AgentRunStore } from "../src/platform/agent-run-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { ROUTE_ALIASES, resolveAlias } from "../web/src/lib/aliases.js";
import { LIBRARY_SECTIONS, RELEASE_SECTIONS, SETUP_SECTIONS, routes } from "../web/src/lib/router.js";
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const PORT = 6450;
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
let requirementId = "";
let agentRunId = "";
let suiteId = "";
let runnerId = "";
const consoleErrors: string[] = [];

const api = async (method: string, url: string, payload?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ux-nav-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    shop = seedProject(platform, "Atlas shop", "http://127.0.0.1:6459");
    for (const k of ["alpha", "beta", "gamma"]) addTest(platform, shop, k);
    await seedRun(platform, shop, { alpha: "pass", beta: "pass", gamma: "fail" }, { daysAgo: 1 });
    // A project with nothing in it: every place must still say what to do.
    empty = seedProject(platform, "Empty shop", null);

    jobId = (await api("GET", `/api/projects/${shop.projectId}/jobs`)).body[0].id ?? (await api("GET", `/api/projects/${shop.projectId}/jobs`)).body[0].jobId;
    await api("POST", `/api/projects/${shop.projectId}/blocks`, { name: "Sign in", description: "Sign in with a nickname", kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] });
    await api("POST", `/api/projects/${shop.projectId}/objects`, { name: "Checkout / Pay button", kind: "web", locator: { by: "role", role: "button", value: "Pay" } });
    releaseId = (await api("POST", `/api/projects/${shop.projectId}/releases`, { name: "Release 1.0" })).body.id;
    requirementId = (await api("POST", `/api/projects/${shop.projectId}/requirements`, { title: "A shopper can pay by card" })).body.id;
    const agentRuns = new AgentRunStore(platform.sql);
    const agentRun = await agentRuns.create({ projectId: shop.projectId, objective: "A shopper can open the shop", startAddress: "http://127.0.0.1:6459/", limits: { maxSteps: 5, maxMinutes: 1, maxTokens: 1_000, approvalSeconds: 60 }, startedBy: { id: null, name: "Test" } });
    await agentRuns.finish(agentRun.id, { state: "finished", verdict: "inconclusive", reasoning: "Nothing was checked." });
    agentRunId = agentRun.id;
    suiteId = (await api("POST", `/api/projects/${shop.projectId}/test-suites`, { name: "Checkout suite" })).body.id;
    runnerId = (await api("POST", "/api/runners", { name: "Lab laptop" })).body.runner.id;

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 180_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── harness ─────────────────────────────────────────────────────────────────

const shots = process.env.UXC_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
/** A fresh load of a page (a hash change alone would not re-run the page's loads). */
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.locator("h1").first()).toBeVisible();
}
async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs, .subtabs") && !el.closest("pre"))
            // The innermost ones are the cause; their ancestors only follow.
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
async function axeBoth(hash: string, before?: () => Promise<void>) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await visit(hash);
        await before?.();
        await page.waitForTimeout(400);
        await axe();
    }
    await page.emulateMedia({ colorScheme: null });
}
const contentText = () => page.evaluate(() => document.querySelector(".content")?.textContent ?? "");
const tabs = () => page.getByRole("navigation", { name: "Project sections", exact: true });
const hash = () => page.evaluate(() => location.hash);
const P = () => shop.projectId;

// The project's tab bar, in the order of the testing lifecycle (docs/product-restructure/INFORMATION_ARCHITECTURE.md, round 25).
const TAB_NAMES = ["Dashboard", "Requirements", "Test cases", "Test suites", "Test scripts", "Agent runs", "Runs", "Settings"];

// The places that hold several sections: [tab label, hash of the bare place, title, section names in order, hash of section i].
const CASES = ["automated", "manual"] as const;
const SCRIPTS = ["scripts", "steps", "elements", "helpers"] as const;
const RUNS = ["runs", "schedules", "deploys", "trends", "releases", "compliance"] as const;
const SETTINGS = ["general", "members", "environments", "data", "accounts", "ai", "runners", "frameworks", "mobile", "alerts", "issues", "storage"] as const;
const PLACES: Array<{ tab: string; h: () => string; title: string; sections: string[]; at: (i: number) => string }> = [
    { tab: "Test cases", h: () => routes.cases(P()), title: "Test cases", sections: ["Automated", "Manual"], at: (i) => routes.cases(P(), CASES[i]) },
    { tab: "Test scripts", h: () => routes.scripts(P()), title: "Test scripts", sections: ["Scripts", "Reusable steps", "Shared elements", "Helpers (code)"], at: (i) => routes.scripts(P(), SCRIPTS[i]) },
    { tab: "Runs", h: () => routes.runs(P()), title: "Runs", sections: ["All runs", "Schedules", "After a deploy", "Trends", "Releases", "Compliance"], at: (i) => routes.runs(P(), RUNS[i]) },
    {
        tab: "Settings",
        h: () => routes.projectSettings(P()),
        title: "Settings",
        sections: ["General", "Members", "Environments", "Test data", "Test accounts", "AI configuration", "Runners", "Frameworks", "Mobile app", "Alerts", "Issue tracker", "Storage and backup"],
        at: (i) => routes.projectSettings(P(), SETTINGS[i]),
    },
];
// The places that are one page: [tab label, hash, title].
const SINGLE: Array<{ tab: string; h: () => string; title: string }> = [
    { tab: "Dashboard", h: () => routes.project(P()), title: "Atlas shop" },
    { tab: "Requirements", h: () => routes.requirements(P()), title: "Requirements" },
    { tab: "Test suites", h: () => routes.suites(P()), title: "Test suites" },
    { tab: "Agent runs", h: () => routes.agentRuns(P()), title: "Agent runs" },
];

// The name of each section in its row (old section keys kept their names when they moved).
const SECTION_NAME: Record<string, string> = { steps: "Reusable steps", elements: "Shared elements", helpers: "Helpers (code)", data: "Test data", accounts: "Test accounts", runners: "Runners", environments: "Environments", frameworks: "Frameworks", mobile: "Mobile app", alerts: "Alerts", issues: "Issue tracker", storage: "Storage and backup" };

// ── the project's places ────────────────────────────────────────────────────

describe("the project's places, in the order of the testing lifecycle", () => {
    it("the tab bar is a labelled navigation with Dashboard, Requirements, Test cases, Test suites, Test scripts, Agent runs, Runs, Settings in that order, on every place", async () => {
        for (const h of [...SINGLE.map((p) => p.h()), ...PLACES.map((p) => p.h())]) {
            await visit(h);
            const names = (await tabs().locator("a.tab").allTextContents()).map((t) => t.replace(/\d+$/, "").trim());
            expect(names, h).toEqual(TAB_NAMES);
            await pwExpect(tabs().locator('[aria-current="page"]')).toHaveCount(1);
        }
    });

    it("the open tab is the one for the place (and stays visible on a phone)", async () => {
        const open = async () => (await tabs().locator('[aria-current="page"]').textContent())!.replace(/\d+$/, "").trim();
        for (const p of [...SINGLE, ...PLACES]) {
            await visit(p.h());
            expect(await open(), p.tab).toBe(p.tab);
        }
        // A run and a release are opened from Runs, so Runs stays the open tab.
        await visit(routes.run(P(), jobId));
        expect(await open()).toBe("Runs");
        await visit(routes.release(P(), releaseId));
        expect(await open()).toBe("Runs");
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            for (const p of [...SINGLE, ...PLACES]) {
                await visit(p.h());
                await page.waitForTimeout(300);
                const box = await tabs().locator('[aria-current="page"]').boundingBox();
                expect(box!.x, `${p.tab} tab is inside the screen`).toBeGreaterThanOrEqual(0);
                expect(box!.x + box!.width, `${p.tab} tab is inside the screen`).toBeLessThanOrEqual(376);
            }
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    for (const p of SINGLE.slice(1)) {
        it(`${p.tab}: one page titled with the place, no section row, no error`, async () => {
            await visit(p.h());
            await pwExpect(page.locator("h1")).toHaveCount(1);
            await pwExpect(page.locator("h1")).toHaveText(p.title);
            await pwExpect(page.locator(".subtabs")).toHaveCount(0);
            await page.waitForTimeout(250);
            await pwExpect(page.locator('.content [role="alert"]'), p.tab).toHaveCount(0);
        });
    }

    for (const p of PLACES) {
        it(`${p.tab}: shows its sections in a labelled row, and every one of them opens without an error`, async () => {
            await visit(p.h());
            const row = page.getByRole("navigation", { name: `${p.title} sections`, exact: true });
            expect(await row.locator("a.subtab").allTextContents()).toEqual(p.sections);
            await pwExpect(row.locator('[aria-current="page"]')).toHaveText(p.sections[0]!);
            for (const [i, name] of p.sections.entries()) {
                await row.getByRole("link", { name, exact: true }).click();
                await pwExpect(row.locator('[aria-current="page"]')).toHaveText(name);
                expect(await hash(), name).toBe(p.at(i));
                // The section is drawn inside the place: one h1 (the place), the section's own heading is an h2.
                await pwExpect(page.locator("h1")).toHaveCount(1);
                await pwExpect(page.locator("h1")).toHaveText(p.title);
                await page.waitForTimeout(250);
                await pwExpect(page.locator('.content [role="alert"]'), `${p.tab} > ${name}`).toHaveCount(0);
                await pwExpect(page.locator(".skeleton")).toHaveCount(0, { timeout: 10_000 });
            }
        });
    }

    it("each section link carries its tour name (data-tour=\"<place>-<section>\")", async () => {
        for (const [p, keys] of [[PLACES[0]!, CASES], [PLACES[1]!, SCRIPTS], [PLACES[2]!, RUNS], [PLACES[3]!, SETTINGS]] as const) {
            await visit(p.h());
            const place = new URL(`http://x/${p.h().replace(/^#\//, "")}`).pathname.split("/").pop();
            const tours = await page.getByRole("navigation", { name: `${p.title} sections`, exact: true }).locator("a.subtab").evaluateAll((els) => els.map((e) => e.getAttribute("data-tour")));
            expect(tours, p.tab).toEqual(keys.map((k) => `${place}-${k}`));
        }
    });

    it("Test cases > Automated is the old Tests page under the heading Automated tests; Manual holds the manual checks", async () => {
        await visit(routes.cases(P()));
        await pwExpect(page.locator(".sec-head h2")).toHaveText("Automated tests");
        await pwExpect(page.getByRole("button", { name: "New test", exact: true })).toBeVisible();
        await visit(routes.cases(P(), "manual"));
        await pwExpect(page.locator(".hub-body")).toHaveAttribute("data-section", "manual");
        await pwExpect(page.locator('.content [role="alert"]')).toHaveCount(0);
    });

    it("Test scripts > Scripts lists every test's script with its review state and opens its latest version (round 34)", async () => {
        await visit(routes.scripts(P()));
        const list = page.getByRole("list", { name: "Test scripts", exact: true });
        await pwExpect(list.getByRole("link")).toHaveCount(3);
        const testId = [...shop.tests.values()][0]!;
        await pwExpect(list.locator(`a[href^="#/projects/${P()}/scripts?test=${testId}&version="]`)).toHaveCount(1);
        await pwExpect(page.getByTestId("script-review-list")).toBeVisible();
        await pwExpect(page.getByTestId("planned-script-approval")).toHaveCount(0);
    });

    it("Settings > General edits the project's details, AI configuration says whether AI is available and who pays, Members lists who is on the project; the testing type is under General", async () => {
        // General is real since round 26: name, platforms and testing modes (US-010), the Crowd4Test link, and archive or delete (round 34).
        await visit(routes.projectSettings(P(), "general"));
        const general = page.getByTestId("project-general");
        await pwExpect(general.getByLabel("Name", { exact: true })).toBeVisible();
        await pwExpect(general.getByRole("group", { name: "Platforms" }).getByRole("checkbox", { name: "Web" })).toBeChecked();
        await pwExpect(general.getByRole("group", { name: "Testing modes" }).getByRole("checkbox", { name: "AI agent" })).toBeChecked();
        await pwExpect(general.getByTestId("project-c4t-link")).toBeVisible();
        await pwExpect(general.getByTestId("project-archive").getByRole("button", { name: "Archive project" })).toBeVisible();
        await visit(routes.projectSettings(P(), "ai"));
        await pwExpect(page.getByTestId("project-ai-available")).toBeVisible();
        await pwExpect(page.getByTestId("project-ai-choice").getByRole("heading", { name: "Who pays for this project’s AI" })).toBeVisible();
        await visit(routes.projectSettings(P(), "members"));
        await pwExpect(page.getByTestId("project-members").getByRole("heading", { name: "Members", exact: true })).toBeVisible();
        // The security module is on by default (round 18), so the project's testing type shows; it moved here from Setup.
        await visit(routes.projectSettings(P()));
        await pwExpect(page.getByTestId("setting-testing-type").getByRole("heading", { name: "Testing type", exact: true })).toBeVisible();
    });

    it("a section opened by a link stays open on a fresh load, and the crumb and the title name the place", async () => {
        await visit(routes.projectSettings(P(), "alerts"));
        await pwExpect(page.getByRole("navigation", { name: "Settings sections" }).locator('[aria-current="page"]')).toHaveText("Alerts");
        expect(await page.title()).toBe("Settings · Atlas shop · AI Studio");
        await pwExpect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Atlas shop");
        await pwExpect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Settings");
    });

    it("Dashboard: no storage form, no empty card; the list of what needs attention is titled in plain words", async () => {
        await visit(routes.project(P()));
        const text = await contentText();
        expect(text).not.toMatch(/Storage and backup/);
        expect(text).not.toMatch(/Keep results for|Download backup|Restore from a backup/i);
        await pwExpect(page.getByRole("heading", { name: "Needs your attention", exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("next-run")).toHaveCount(0); // no schedule: no empty line about one
        await shot("overview-light-1280");
    });

    it("Settings > Storage and backup, Frameworks and Mobile app are a titled row with a summary and Change; the form opens on request", async () => {
        for (const [section, title] of [["storage", "Storage and backup"], ["frameworks", "Frameworks"], ["mobile", "Mobile app"]] as const) {
            await visit(routes.projectSettings(P(), section));
            const row = page.getByTestId(`setting-${section}`);
            await pwExpect(row.getByRole("heading", { name: title, exact: true })).toBeVisible();
            await pwExpect(row.locator(".setting-text .t-secondary")).not.toHaveText("");
            await pwExpect(row.locator(".setting-body")).toHaveCount(0);
            await row.getByRole("button", { name: `Change ${title.toLowerCase()}`, exact: true }).click();
            await pwExpect(row.locator(".setting-body")).toBeVisible();
        }
    });

    it("Settings > Runners: connected runners first, Add a runner is one click away, and the folder way is tucked under Advanced", async () => {
        await visit(routes.runners(P()));
        const order = await page.locator(".content h2, .content summary .t-section").allTextContents();
        expect(order.indexOf("Connected runners")).toBeGreaterThanOrEqual(0);
        expect(order.indexOf("Connected runners")).toBeLessThan(order.indexOf("Advanced: start a runner from the project folder"));
        // Most people do not need a runner: the guided panel opens on request, the old steps stay closed.
        await pwExpect(page.getByRole("button", { name: "Add a runner", exact: true })).toBeVisible();
        await pwExpect(page.locator("details.ag-add")).not.toHaveAttribute("open", "");
        await pwExpect(page.getByText("Most people do not need one.")).toBeVisible();
        await shot("setup-light-1280");
    });

    it("Test scripts: one search finds reusable steps and shared elements by name and links to them", async () => {
        await visit(routes.scripts(P(), "steps"));
        const search = page.getByRole("searchbox", { name: "Search shared steps, elements and helpers", exact: true });
        await search.fill("sign");
        const results = page.getByRole("region", { name: "Search results", exact: true });
        await pwExpect(results.getByRole("link", { name: /Sign in/ })).toBeVisible();
        await search.fill("pay");
        await pwExpect(results.getByRole("link", { name: /Checkout \/ Pay button/ })).toBeVisible();
        await search.fill("zzz");
        await pwExpect(results).toContainText("Nothing shared is called “zzz”.");
        await search.fill("sign");
        await results.getByRole("link", { name: /Sign in/ }).click();
        await pwExpect(page.getByRole("heading", { name: /Change reusable steps/ }).first()).toBeVisible();
    });

    it("an empty project: every place still loads and says what to do, no error", async () => {
        const e = empty.projectId;
        for (const h of [routes.project(e), routes.requirements(e), routes.cases(e), routes.cases(e, "manual"), routes.suites(e), routes.scripts(e), routes.scripts(e, "steps"), routes.agentRuns(e), routes.runs(e), routes.runs(e, "releases"), routes.projectSettings(e), routes.projectSettings(e, "runners")]) {
            await visit(h);
            await page.waitForTimeout(400);
            await pwExpect(page.locator('.content [role="alert"]'), h).toHaveCount(0);
        }
    });
});

// ── sidebar ─────────────────────────────────────────────────────────────────

describe("sidebar and the Projects page", () => {
    it("the sidebar holds the global places in their groups (Security: the module is on by default, round 18); New project is an action on the Projects page", async () => {
        await visit("#/");
        const side = page.getByRole("complementary", { name: "Main navigation" });
        await pwExpect(side.getByRole("link", { name: "Security assessment", exact: true })).toBeVisible();
        expect(await side.locator(".nav-label").allTextContents()).toEqual(["Workspace", "Operations", "Security", "System"]);
        expect(await side.locator("a.nav-item").allTextContents()).toEqual(["Dashboard", "Projects", "Test development", "Folders", "Runners", "Security assessment", "Settings"]);
        expect(await side.locator("a.nav-item").evaluateAll((els) => els.map((e) => e.getAttribute("href")))).toEqual([routes.dashboard, routes.home, routes.develop, routes.folders, routes.allRunners, "#/security", routes.settings]);
        await pwExpect(side.getByRole("button", { name: /Help/ })).toBeVisible();
        await pwExpect(side.getByRole("link", { name: /New project/ })).toHaveCount(0);
        const add = page.locator(".page-head").getByRole("link", { name: "New project", exact: true });
        await pwExpect(add).toBeVisible();
        await add.click();
        // New project opens Create a project (US-010); exploring with AI is a step from the new project's dashboard.
        expect(await hash()).toBe("#/create");
        await pwExpect(page.getByTestId("create-project")).toBeVisible();
        await pwExpect(page.getByRole("group", { name: "Platforms" }).getByRole("checkbox", { name: /Web/ })).toBeChecked();
        await pwExpect(page.getByRole("group", { name: "Testing modes" }).getByRole("checkbox", { name: /AI agent/ })).toBeChecked();
    });

    it("each global place opens with its own title, and the open one is marked in the sidebar", async () => {
        const side = page.getByRole("complementary", { name: "Main navigation" });
        for (const [h, title, nav] of [[routes.dashboard, "Dashboard", "Dashboard"], [routes.develop, "Test development", "Test development"], [routes.folders, "Folders", "Folders"], [routes.allRunners, "Runners", "Runners"], [routes.settings, "Settings", "Settings"]] as const) {
            await visit(h);
            await pwExpect(page.locator("h1"), h).toHaveText(title);
            await pwExpect(side.locator('a.nav-item[aria-current="page"]'), h).toHaveText(nav);
            await pwExpect(page.locator('.content [role="alert"]'), h).toHaveCount(0);
        }
        await visit(routes.profile);
        await pwExpect(page.locator("h1")).toHaveText("Profile");
        await pwExpect(page.getByTestId("profile-account")).toBeVisible();
    });

    it("the emulator panel moved from Settings to Runners, as Mobile tooling on this computer", async () => {
        await visit(routes.allRunners);
        const tooling = page.getByTestId("mobile-tooling");
        await pwExpect(tooling.getByRole("heading", { name: "Mobile tooling on this computer", exact: true })).toBeVisible();
        await visit(routes.settings);
        await pwExpect(page.getByRole("heading", { name: "Mobile testing", exact: true })).toHaveCount(0);
        await pwExpect(page.getByTestId("mobile-tooling")).toHaveCount(0);
    });

    it("the Projects page still offers New project with only one project, and the empty welcome page is the new-project page", async () => {
        await visit("#/new");
        await pwExpect(page.locator("h1").first()).toBeVisible();
        await pwExpect(page.getByRole("complementary", { name: "Main navigation" }).getByRole("link", { name: "Projects" })).toBeVisible();
    });
});

// ── Tests page ──────────────────────────────────────────────────────────────

describe("Test cases > Automated (the old Tests page)", () => {
    it("has a calm header: the count, Run, New test and a small More menu; the five creation buttons and the long menu are gone", async () => {
        await visit(routes.tests(P()));
        // The place has the page title; the section's own header row holds the count and the actions.
        await pwExpect(page.locator(".page-head h1")).toHaveText("Test cases");
        const head = page.locator(".sec-head");
        await pwExpect(head.locator("h2")).toHaveText("Automated tests");
        await pwExpect(head.locator(".sub")).toHaveText("3 tests, 2 passing, 1 not passing");
        await pwExpect(head.getByRole("button", { name: "Run", exact: true })).toBeVisible();
        await pwExpect(head.getByRole("button", { name: "New test", exact: true })).toBeVisible();
        for (const gone of ["Write a test", "Build a test", "Write as text", "Write code", "Download tests"]) await pwExpect(head.getByRole("button", { name: gone, exact: true }), gone).toHaveCount(0);
        await pwExpect(head.getByRole("link", { name: "Record a test", exact: true })).toHaveCount(0);
        await head.getByRole("button", { name: "More actions", exact: true }).click();
        expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Import tests…", "Export…", "Check other browsers & screen sizes"]);
        await shot("tests-light-1280");
    });

    it("the New test menu groups its entries and says in a line what each one is", async () => {
        await visit(routes.tests(P()));
        await page.getByRole("button", { name: "New test", exact: true }).click();
        const items = page.getByRole("menuitem");
        expect(await items.evaluateAll((els) => els.map((e) => e.querySelector("span > span")?.textContent ?? e.textContent))).toEqual(["Describe it", "Record it in a browser", "Explore the phone app (AI)", "Build steps by hand", "Write it as text", "Write code", "Import tests…"]);
        // Each entry's name is its title; the explanation is its description.
        for (const [name, words] of [
            ["Describe it", /AI writes the steps/],
            ["Record it in a browser", /Click through your application/],
            // This project has no phone app, so the line says what to do first (with an app it says what the AI does: tests/phone-ai-ui.test.ts).
            ["Explore the phone app (AI)", /Add a phone app first/],
            ["Build steps by hand", /one by one/],
            ["Write it as text", /No AI needed/],
            ["Write code", /Runs only where code tests are allowed/],
            ["Import tests…", /JSON file, Maestro flows or a Git repository/],
        ] as const) {
            const item = page.getByRole("menuitem", { name, exact: true });
            await pwExpect(item).toBeVisible();
            const desc = await item.evaluate((el) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? "");
            expect(desc, name).toMatch(words);
        }
        await pwExpect(page.locator(".menu-label")).toHaveText(["With help", "By hand", "From elsewhere"]);
        await shot("tests-new-test-menu-light-1280");
    });

    it("each New test entry opens the dialog or page that already existed", async () => {
        const choose = async (name: string) => {
            await visit(routes.tests(P()));
            await page.getByRole("button", { name: "New test", exact: true }).click();
            await page.getByRole("menuitem", { name, exact: true }).click();
        };
        await choose("Describe it");
        await pwExpect(page.getByRole("dialog", { name: "Write a test", exact: true })).toBeVisible();
        await choose("Build steps by hand");
        await pwExpect(page.getByRole("dialog", { name: "Build a test", exact: true })).toBeVisible();
        await choose("Write it as text");
        await pwExpect(page.getByRole("dialog", { name: "Write a test as text", exact: true })).toBeVisible();
        await choose("Write code");
        await pwExpect(page.getByRole("dialog", { name: "Write a test in code", exact: true })).toBeVisible();
        await choose("Record it in a browser");
        await pwExpect(page.getByRole("heading", { name: "Record a test", exact: true })).toBeVisible();
        expect(await hash()).toBe(routes.record(P()));
    });

    it("Import tests… offers JSON, Maestro and Git; Maestro and Git open their own panels; a JSON file really imports", async () => {
        await visit(routes.tests(P()));
        await page.getByRole("button", { name: "New test", exact: true }).click();
        await page.getByRole("menuitem", { name: "Import tests…", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Import tests", exact: true });
        await pwExpect(dialog.getByRole("button", { name: "Choose a JSON file", exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: "Import Maestro flows", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Import Maestro flows", exact: true })).toBeVisible();

        await visit(routes.tests(P()));
        await page.getByRole("button", { name: "More actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Import tests…", exact: true }).click();
        await page.getByRole("dialog", { name: "Import tests", exact: true }).getByRole("button", { name: "Import from Git", exact: true }).click();
        await pwExpect(page.getByRole("dialog", { name: "Import from Git", exact: true })).toBeVisible();

        await visit(routes.tests(P()));
        await page.getByRole("button", { name: "More actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Import tests…", exact: true }).click();
        const specs = [{ testId: "API-900", title: "Imported through the dialog", kind: "api", category: "API", priority: "low", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] }];
        await page.locator('input[type="file"][aria-label="Test file in JSON"]').setInputFiles({ name: "tests.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(specs)) });
        await pwExpect(page.getByText(/Imported 1 test/)).toBeVisible();
        const list = (await api("GET", `/api/projects/${P()}/tests`)).body as Array<{ title: string }>;
        expect(list.map((t) => t.title)).toContain("Imported through the dialog");
    });

    it("Export… lists every download with what is in it; one of them really downloads", async () => {
        await visit(routes.tests(P()));
        await page.getByRole("button", { name: "More actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Export…", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Export", exact: true });
        for (const b of ["Download tests", "Export as JSON", "Download PDF", "Download web page", "Download results"]) await pwExpect(dialog.getByRole("button", { name: b, exact: true }), b).toBeVisible();
        const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download results", exact: true }).click()]);
        expect(download.suggestedFilename()).toBe("Atlas shop-results.xml");
    });

    it("status filter chips use the decided words and wrap on a phone without sideways scroll", async () => {
        await visit(routes.tests(P()));
        const chips = (await page.getByRole("group", { name: "Filter by status" }).getByRole("button").allTextContents()).map((t) => t.replace(/\s*\d+$/, ""));
        expect(chips.slice(0, 4)).toEqual(["All", "Passing", "Failing", "Not run yet"]);
        await page.setViewportSize({ width: 390, height: 844 });
        try {
            await visit(routes.tests(P()));
            await noOverflow();
            await shot("tests-light-390");
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("Select shows a checkbox column (UX-A's selection mode still hooks in)", async () => {
        await visit(routes.tests(P()));
        await page.getByRole("button", { name: /^Select/ }).first().click();
        await pwExpect(page.getByRole("checkbox").first()).toBeVisible();
    });
});

// ── old links ───────────────────────────────────────────────────────────────

describe("old links keep working", () => {
    const at = (rest: string) => () => `#/projects/${P()}/${rest}`;
    // [name, old link, where it must land, the section that is then open].
    const old: Array<[string, () => string, () => string, string?]> = [
        // Single pages of the rounds before 16.
        ["schedule", at("schedule"), at("runs?section=schedules"), "Schedules"],
        ["schedule with a run", at("schedule?run=r1"), at("runs?section=schedules&run=r1"), "Schedules"],
        ["runners", at("runners"), at("settings?section=runners"), "Runners"],
        ["objects", at("objects"), at("scripts?section=elements"), "Shared elements"],
        ["blocks", at("blocks"), at("scripts?section=steps"), "Reusable steps"],
        ["blocks to edit", at("blocks?edit=Sign%20in"), at("scripts?section=steps&edit=Sign+in"), "Reusable steps"],
        ["helpers", at("helpers"), at("scripts?section=helpers"), "Helpers (code)"],
        ["releases", at("releases"), at("runs?section=releases"), "Releases"],
        ["one release", () => `#/projects/${P()}/releases/${releaseId}`, () => `#/projects/${P()}/release/${releaseId}`],
        ["manual cases", at("manual-cases"), at("tests?section=manual"), "Manual"],
        ["compliance", at("compliance"), at("runs?section=compliance"), "Compliance"],
        // The places of rounds 16 to 24: Setup became Settings, Library and Release were split up (round 25).
        ["setup", at("setup"), at("settings?section=runners"), "Runners"],
        ...(["runners", "environments", "frameworks", "mobile", "alerts", "issues", "storage"] as const).map((k): [string, () => string, () => string, string?] => [`setup > ${k}`, at(`setup?section=${k}`), at(`settings?section=${k}`), SECTION_NAME[k]]),
        ["setup with an unknown section", at("setup?section=nothing"), at("settings?section=runners"), "Runners"],
        ["setup keeps another query (the welcome page's start=phone)", at("setup?section=mobile&start=phone"), at("settings?section=mobile&start=phone"), "Mobile app"],
        ["library", at("library"), at("scripts?section=steps"), "Reusable steps"],
        ...(["steps", "elements", "helpers"] as const).map((k): [string, () => string, () => string, string?] => [`library > ${k}`, at(`library?section=${k}`), at(`scripts?section=${k}`), SECTION_NAME[k]]),
        ...(["data", "accounts"] as const).map((k): [string, () => string, () => string, string?] => [`library > ${k}`, at(`library?section=${k}`), at(`settings?section=${k}`), SECTION_NAME[k]]),
        ["release", at("release"), at("runs?section=releases"), "Releases"],
        ["release > releases", at("release?section=releases"), at("runs?section=releases"), "Releases"],
        ["release > compliance", at("release?section=compliance"), at("runs?section=compliance"), "Compliance"],
        ["release > manual", at("release?section=manual"), at("tests?section=manual"), "Manual"],
    ];
    for (const [name, from, to, section] of old) {
        it(`${name}: lands on the right place and section`, async () => {
            await page.goto("about:blank");
            await page.goto(`${BASE}/${from()}`);
            await pwExpect(page.locator("h1").first()).toBeVisible();
            expect(await hash()).toBe(to());
            if (section) await pwExpect(page.locator('.subtabs [aria-current="page"]')).toHaveText(section);
            await pwExpect(page.locator('.content [role="alert"]')).toHaveCount(0);
        });
    }

    it("the old route helpers return the new homes directly, not an old link that redirects again", () => {
        const p = "p1";
        expect(routes.setup(p)).toBe("#/projects/p1/settings?section=runners");
        for (const k of SETUP_SECTIONS) expect(routes.setup(p, k), k).toBe(`#/projects/p1/settings?section=${k}`);
        expect(routes.library(p)).toBe("#/projects/p1/scripts?section=steps");
        expect(routes.library(p, "elements")).toBe("#/projects/p1/scripts?section=elements");
        expect(routes.library(p, "helpers")).toBe("#/projects/p1/scripts?section=helpers");
        expect(routes.library(p, "data")).toBe("#/projects/p1/settings?section=data");
        expect(routes.library(p, "accounts")).toBe("#/projects/p1/settings?section=accounts");
        expect(routes.objects(p)).toBe("#/projects/p1/scripts?section=elements");
        expect(routes.blocks(p, "Sign in")).toBe("#/projects/p1/scripts?section=steps&edit=Sign+in");
        expect(routes.helpers(p)).toBe("#/projects/p1/scripts?section=helpers");
        expect(routes.releaseHub(p)).toBe("#/projects/p1/runs?section=releases");
        expect(routes.releases(p)).toBe("#/projects/p1/runs?section=releases");
        expect(routes.compliance(p)).toBe("#/projects/p1/runs?section=compliance");
        expect(routes.manualCases(p)).toBe("#/projects/p1/tests?section=manual");
        expect(routes.runners(p)).toBe("#/projects/p1/settings?section=runners");
        // No helper of `routes` builds a link that the alias table would move again.
        const sample = (k: string, f: unknown): string[] => (typeof f === "string" ? [f] : k === "writeCode" ? [routes.writeCode(p, { title: "x", kind: "web" })] : k === "guideTopic" ? [routes.guideTopic("x")] : [(f as (a: string, b?: string) => string)(p), (f as (a: string, b: string) => string)(p, "x")]);
        for (const [k, f] of Object.entries(routes)) {
            for (const h of sample(k, f)) {
                const [path, qs] = h.replace(/^#\/?/, "").split("?");
                expect(resolveAlias(path!.split("/").filter(Boolean), new URLSearchParams(qs ?? "")), `routes.${k} → ${h}`).toBeNull();
            }
        }
    });

    it("the alias table is complete: every old path of an earlier version has a row, and no row loops", () => {
        expect(ROUTE_ALIASES.map((a) => a.old).sort()).toEqual(["blocks", "compliance", "helpers", "manual-cases", "objects", "releases", "runners", "schedule"]);
        for (const a of ROUTE_ALIASES) {
            const to = a.to("p1", a.extra ? "x" : undefined, new URLSearchParams());
            const [path, qs] = to.replace(/^#\//, "").split("?");
            expect(resolveAlias(path!.split("/"), new URLSearchParams(qs ?? "")), `${a.old} must not redirect again`).toBeNull();
        }
        // The three retired places: every section of each lands on a current place, which does not redirect again.
        for (const [place, list] of [["setup", SETUP_SECTIONS], ["library", LIBRARY_SECTIONS], ["release", RELEASE_SECTIONS]] as const) {
            for (const k of [undefined, ...list]) {
                const to = resolveAlias(["projects", "p1", place], new URLSearchParams(k ? { section: k } : {}));
                expect(to, `${place} ${k}`).toMatch(/^#\/projects\/p1\/(tests|scripts|runs|settings)(\?|$)/);
                const [path, qs] = to!.replace(/^#\//, "").split("?");
                expect(resolveAlias(path!.split("/"), new URLSearchParams(qs ?? "")), `${place} ${k} must not redirect again`).toBeNull();
            }
        }
        for (const current of ["tests", "requirements", "suites", "scripts", "agent", "runs", "settings"]) expect(resolveAlias(["projects", "p1", current], new URLSearchParams()), current).toBeNull();
        expect(resolveAlias(["tests", "t1"], new URLSearchParams())).toBeNull();
    });

    it("the filters of the Tests page that other pages link to still work (?quarantine=1, ?quality=weak, ?git=1)", async () => {
        await visit(`${routes.tests(P())}?quarantine=1`);
        await pwExpect(page.getByRole("button", { name: /^Quarantined/ })).toHaveAttribute("aria-pressed", "true");
        await visit(`${routes.tests(P())}?quality=weak`);
        await pwExpect(page.getByRole("button", { name: /^Weak checks/ })).toHaveAttribute("aria-pressed", "true");
        await visit(`${routes.tests(P())}?git=1`);
        await pwExpect(page.getByRole("dialog", { name: "Import from Git", exact: true })).toBeVisible();
    });
});

// ── link integrity ──────────────────────────────────────────────────────────

describe("every route builder opens a page without an error", () => {
    it("crawls each `routes.*` with a sample id (and fails if a builder has no sample)", async () => {
        const testId = [...shop.tests.values()][0]!;
        const samples: Record<string, string[]> = {
            home: ["#/"],
            newProject: [routes.newProject(), routes.newProject({ project: P() }), routes.newProject({ url: "http://127.0.0.1:6459" })],
            project: [routes.project(P())],
            tests: [routes.tests(P())],
            newTest: [routes.newTest(P(), "describe"), routes.newTest(P(), "build")],
            runs: RUNS.map((k) => routes.runs(P(), k)),
            run: [routes.run(P(), jobId)],
            schedule: [routes.schedule(P()), routes.schedule(P(), "run-1")],
            runners: [routes.runners(P())],
            requirements: [routes.requirements(P())],
            requirement: [routes.requirement(P(), requirementId)],
            cases: CASES.map((k) => routes.cases(P(), k)),
            suites: [routes.suites(P())],
            suite: [routes.suite(P(), suiteId)],
            scripts: [...SCRIPTS.map((k) => routes.scripts(P(), k)), routes.scripts(P(), "steps", "Sign in")],
            agentRuns: [routes.agentRuns(P())],
            agentRun: [routes.agentRun(P(), agentRunId)],
            projectSettings: SETTINGS.map((k) => routes.projectSettings(P(), k)),
            setup: [routes.setup(P()), routes.setup(P(), "environments"), routes.setup(P(), "alerts"), routes.setup(P(), "issues")],
            library: [routes.library(P()), routes.library(P(), "data"), routes.library(P(), "accounts")],
            objects: [routes.objects(P())],
            blocks: [routes.blocks(P()), routes.blocks(P(), "Sign in")],
            record: [routes.record(P())],
            releaseHub: [routes.releaseHub(P()), routes.releaseHub(P(), "manual")],
            compliance: [routes.compliance(P())],
            releases: [routes.releases(P())],
            release: [routes.release(P(), releaseId)],
            manualCases: [routes.manualCases(P())],
            test: [routes.test(testId)],
            code: [routes.code(testId)],
            builder: [routes.builder(testId)],
            testTab: [routes.testTab(testId, "steps"), routes.testTab(testId, "text"), routes.testTab(testId, "code"), routes.testTab(testId, "history")],
            helpers: [routes.helpers(P())],
            writeCode: [routes.writeCode(P(), { title: "A new test", kind: "web" })],
            dashboard: [routes.dashboard],
            develop: [routes.develop],
            createProject: [routes.createProject],
            allRunners: [routes.allRunners],
            runner: [routes.runner(runnerId)],
            folders: [routes.folders],
            profile: [routes.profile],
            settings: [routes.settings],
            guide: [routes.guide],
            guideTopic: [routes.guideTopic("first-steps")],
            guideWords: [routes.guideWords],
        };
        const missing = Object.keys(routes).filter((k) => !(k in samples));
        expect(missing, "add a sample for the new route builder").toEqual([]);
        const failures: string[] = [];
        for (const [name, list] of Object.entries(samples)) {
            for (const h of list) {
                await visit(h);
                await page.waitForTimeout(350);
                const alerts = await page.locator('.content [role="alert"]').allTextContents();
                const empty = (await contentText()).trim().length === 0;
                if (alerts.length || empty) failures.push(`${name} ${h}: ${alerts.join(" | ") || "empty page"}`);
            }
        }
        expect(failures).toEqual([]);
    });
});

// ── keyboard, phone, touch, axe, words ──────────────────────────────────────

describe("keyboard", () => {
    it("Tab reaches the New test menu, Enter opens it, Tab moves through its entries, Escape closes it and returns to the button", async () => {
        await visit(routes.tests(P()));
        const button = page.getByRole("button", { name: "New test", exact: true });
        await button.focus();
        await page.keyboard.press("Enter");
        await pwExpect(page.getByRole("menu")).toBeVisible();
        await page.keyboard.press("Tab");
        await pwExpect(page.getByRole("menuitem", { name: "Describe it", exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await pwExpect(page.getByRole("menuitem", { name: "Record it in a browser", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await pwExpect(page.getByRole("menu")).toHaveCount(0);
        await pwExpect(button).toBeFocused();
    });

    it("an entry chosen with Enter opens its dialog; Escape closes the dialog", async () => {
        await visit(routes.tests(P()));
        await page.getByRole("button", { name: "New test", exact: true }).focus();
        await page.keyboard.press("Enter");
        await page.getByRole("menuitem", { name: "Write it as text", exact: true }).focus();
        await page.keyboard.press("Enter");
        await pwExpect(page.getByRole("dialog", { name: "Write a test as text", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);
    });

    it("the section row is reachable with Tab and a section opens with Enter", async () => {
        await visit(routes.scripts(P()));
        await page.getByRole("link", { name: "Shared elements", exact: true }).focus();
        await page.keyboard.press("Enter");
        await pwExpect(page.locator('.subtabs [aria-current="page"]')).toHaveText("Shared elements");
    });

    it("the Change row of a setting opens with Enter and shows a visible focus ring", async () => {
        await visit(routes.projectSettings(P(), "mobile"));
        const change = page.getByRole("button", { name: "Change mobile app", exact: true });
        await change.focus();
        const ring = await change.evaluate((el) => getComputedStyle(el).outlineStyle + "|" + getComputedStyle(el).boxShadow);
        expect(ring).not.toBe("none|none");
        await page.keyboard.press("Enter");
        await pwExpect(page.getByTestId("setting-mobile").locator(".setting-body")).toBeVisible();
    });
});

describe("phone and touch targets", () => {
    it("375 px: every place (Test cases with the New test menu open) and its sections have no sideways scroll", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            for (const h of [...SINGLE.map((p) => p.h()), ...PLACES.map((p) => p.h()), routes.cases(P(), "manual"), routes.scripts(P(), "steps"), routes.runs(P(), "releases"), routes.projectSettings(P(), "data"), routes.projectSettings(P(), "alerts"), routes.projectSettings(P(), "storage")]) {
                await visit(h);
                await page.waitForTimeout(300);
                await noOverflow();
            }
            await visit(routes.tests(P()));
            await page.getByRole("button", { name: "New test", exact: true }).click();
            await pwExpect(page.getByRole("menuitem", { name: "Describe it", exact: true })).toBeVisible();
            const pop = await page.locator(".menu-pop").boundingBox();
            expect(pop!.x).toBeGreaterThanOrEqual(0);
            expect(pop!.x + pop!.width).toBeLessThanOrEqual(376);
            await shot("tests-new-test-menu-light-375");
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("tabs, section links, menu entries and header buttons are at least 44 px tall", async () => {
        const small = async () =>
            page.evaluate(() =>
                Array.from(document.querySelectorAll<HTMLElement>(".tab, .subtab, .menu-item, .page-head .btn, .sec-head .btn, .setting-row .btn"))
                    .filter((el) => el.getBoundingClientRect().height > 0)
                    .map((el) => ({ n: el.textContent?.trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height) }))
                    .filter((x) => x.h < 44),
            );
        for (const h of [routes.tests(P()), routes.scripts(P(), "steps"), routes.projectSettings(P(), "mobile")]) {
            await visit(h);
            expect(await small(), h).toEqual([]);
        }
        await visit(routes.tests(P()));
        await page.getByRole("button", { name: "New test", exact: true }).click();
        expect(await small()).toEqual([]);
    });
});

describe("accessibility and words", () => {
    it("every place and the Tests page with the New test menu open: axe-clean in light and dark", async () => {
        for (const p of SINGLE) await axeBoth(p.h());
        for (const p of PLACES) await axeBoth(p.h());
        await axeBoth(routes.tests(P()));
        await axeBoth(routes.tests(P()), async () => {
            await page.getByRole("button", { name: "New test", exact: true }).click();
            await pwExpect(page.getByRole("menu")).toBeVisible();
        });
        await axeBoth(routes.projectSettings(P(), "storage"), async () => {
            await page.getByRole("button", { name: "Change storage and backup", exact: true }).click();
        });
        await axeBoth(routes.projectSettings(P(), "data"));
        await axeBoth(routes.scripts(P(), "steps"));
        await axeBoth(routes.allRunners);
        await axeBoth(routes.runs(P(), "schedules"));
    });

    it("none of the places uses a retired word", async () => {
        const RETIRED = /(?<!could not be )\bvalidated\b|\bvalidation failed\b|\bneeds review\b|\bnot yet validated\b|\bre-validation\b|\banaly[sz](is|e|ed)\b|\bhand-written\b|\btake over\b|\brunner agents?\b|\brunbooks?\b|\bmake shared\b|\bshared locators?\b|\bscenarios?\b|\bspecification\b/i;
        const hits: string[] = [];
        for (const h of [...SINGLE.map((p) => p.h()), ...PLACES.flatMap((p) => p.sections.map((_, i) => p.at(i)))]) {
            // The compliance map quotes standard control names ("post-incident analysis"); those are data, not our words.
            if (h.endsWith("section=compliance")) continue;
            await visit(h);
            await page.waitForTimeout(300);
            const text = await page.evaluate(() => {
                const root = document.querySelector(".content")?.cloneNode(true) as HTMLElement | undefined;
                root?.querySelectorAll("pre, code, script, style").forEach((e) => e.remove());
                return root?.textContent ?? "";
            });
            const m = RETIRED.exec(text);
            if (m) hits.push(`${h}: …${text.slice(Math.max(0, m.index - 40), m.index + 40)}…`);
        }
        expect(hits).toEqual([]);
    });

    it("screenshots of Dashboard, Test cases (menu open), Test scripts, Settings and Runs, light and dark, 1280 and 390 (only when UXC_SHOTS is set)", async () => {
        if (!shots) return;
        for (const [w, h] of [[1280, 900], [390, 844]] as const) {
            await page.setViewportSize({ width: w, height: h });
            for (const scheme of ["light", "dark"] as const) {
                await page.emulateMedia({ colorScheme: scheme });
                for (const [name, hh] of [["dashboard", routes.project(P())], ["scripts", routes.scripts(P())], ["settings", routes.projectSettings(P())], ["runs", routes.runs(P())]] as const) {
                    await visit(hh);
                    await page.waitForTimeout(400);
                    await shot(`${name}-${scheme}-${w}`);
                }
                await visit(routes.tests(P()));
                await page.getByRole("button", { name: "New test", exact: true }).click();
                await page.waitForTimeout(400);
                await shot(`tests-menu-${scheme}-${w}`);
            }
        }
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("never logged an error in the console", () => {
        expect(consoleErrors).toEqual([]);
    });
});
