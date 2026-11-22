/**
 * The Dashboard and the Projects row of a Test Case Generation project in a real browser (founder 2026-11-19 P1, P3, P5, P6, P7, R4;
 * PLAN.md U4). Such a project (agent-only, with the test-generation agent chosen, SPEC D3) shows its outcome and nothing else:
 *
 * - the header (name, kind, Explore again), the setup checklist while something is missing, and the outcome report: one summary line, one
 *   tree of pages, the test cases, one Download test cases button; no pass or fail, no tests to run or open, no plan to confirm
 *   ("Create the tests" is gone: the server refuses it with a 409, FX5), no second list of pages, no requirements coverage;
 * - the tree's header count equals its nodes; it is an ARIA tree that works by keyboard, and passes axe with the colour scheme set to light and
 *   to dark (the app itself is light only since it joined crowd4test.com, styles/tokens.css, so both look the same);
 * - Download test cases saves `<project name> test cases.xlsx`; a refusal shows as its sentence; no button without the export permission;
 * - a project not explored yet offers Start exploring and no download; a stopped run keeps what it found;
 * - the Projects row says "N test cases, M pages" (or Not explored yet), never "Plan ready" or "tests passing";
 * - unchanged: an agent project of other agents (except that no agent Dashboard has requirements coverage), a mixed project and a code
 *   project keep their Dashboards and rows.
 *
 * The platform underneath is real; runs are seeded as a plan-only job leaves them (its plan artifact and events), so no AI and no
 * exploring browser are needed. Where the permission set matters, the page's own /api/auth/state is answered by the test (said in the
 * test's name); the server's 403 for the download is covered by tests/case-workbook.test.ts. Port 7871.
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs build,browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/case-agent-dashboard-ui.test.ts
 * Set CASE_DASH_SHOTS=<folder> to also write screenshots.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { StoredPlan } from "../src/engine/planning/preview.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { PLAN_ARTIFACT } from "../src/platform/plan-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { routes } from "../web/src/lib/router.js";
import { addTest, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const PORT = 7871;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = "http://127.0.0.1:7879";
const shots = process.env.CASE_DASH_SHOTS;

let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let store = ""; // TCG, two runs, and 12 old test scripts with a run (3 failing)
let fresh = ""; // TCG, never explored
let quarry = ""; // TCG, its only run stopped after 2 pages
let access = ""; // agent project of the Accessibility agent only, with test scripts
let mixed = ""; // mixed (agent and code), with test scripts
let code = ""; // code, with test scripts
const consoleErrors: string[] = [];

const api = async (method: string, url: string, payload?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
};

const PAGES: Record<string, string> = { "/": "Home", "/products": "Products", "/products/1": "Travel mug", "/about": "About us", "/cart": "Cart" };
const appModel = (paths: string[], navigation: Array<[string, string]>) => ({
    url: SITE,
    origin: SITE,
    pages: paths.map((p, i) => ({ url: `${SITE}${p}`, path: p, title: PAGES[p], purpose: `Where a shopper sees ${PAGES[p]!.toLowerCase()}`, type: "other", depth: i ? 1 : 0, status: 200, headings: [], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] })),
    navigation: navigation.map(([from, to]) => ({ from, to, label: to })),
    apis: [],
    authentication: { required: false, mechanisms: [], loggedIn: false },
    externalDependencies: [],
    documentedTestCases: [],
    stats: { pagesVisited: paths.length, pagesSkipped: 0, apisFound: 0, durationMs: 1 },
    siteType: "ecommerce",
    purpose: "A shop",
    features: [],
    journeys: [],
});

/** A plan-only run of a Test Case Generation project, as the worker leaves it: the plan artifact (app model and ideas), then its status. */
async function planRun(pid: string, paths: string[], navigation: Array<[string, string]>, ideas: Array<{ title: string; startPath: string }>, failed: string[] = []) {
    const appId = platform.repo.getLatestApplicationPublic(pid)!.id as string;
    const job = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, planOnly: true, targets: ["web"], functionalTests: true });
    const plan: StoredPlan = {
        version: 1,
        createdAt: new Date().toISOString(),
        model: appModel(paths, navigation) as never,
        scenarios: ideas.map((s, i) => ScenarioSchema.parse({ scenarioId: `S-${i + 1}`, title: s.title, description: s.title, category: "Browsing", priority: "high", startPath: s.startPath, preconditions: ["The shop is open"], expectedResults: [`${s.title}: done`] })),
        analysed: true,
        specBaseTrusted: false,
        accessReach: [],
        apiAccess: [],
        warnings: [],
    };
    const rel = `${pid}/_artifacts/${job.id}/plan.json`;
    const body = JSON.stringify(plan);
    await platform.store.put(rel, body);
    platform.repo.addArtifact({ projectId: pid, jobId: job.id, kind: PLAN_ARTIFACT, path: rel, size: body.length });
    for (const f of failed) platform.repo.addEvent(job.id, { stage: "discovery", kind: "page_failed", level: "warn", message: `Could not load ${SITE}${f}: net::ERR_CONNECTION_REFUSED` });
    platform.repo.setJobStatus(job.id, "COMPLETED");
    return job.id as string;
}

async function project(name: string, testingModes: Array<"agent" | "code">, agents?: string[]): Promise<string> {
    const id = platform.repo.createProject({ name, platforms: ["web"], testingModes }).id as string;
    platform.repo.createApplication(id, SITE, { ...DEFAULT_JOB_OPTIONS });
    if (agents) expect((await api("PUT", `/api/projects/${id}/testing-agents`, { agents })).status).toBe(200);
    return id;
}
/** Test scripts and a finished run of them, some failing (what an old exploration left in the project). */
async function oldTests(pid: string, n: number, failing: number) {
    const seed: Seed = { projectId: pid, appId: platform.repo.getLatestApplicationPublic(pid)!.id as string, tests: new Map(), scripts: new Map() };
    const outcomes: Record<string, "pass" | "fail"> = {};
    for (let i = 0; i < n; i++) (addTest(platform, seed, `t${i}`), (outcomes[`t${i}`] = i < failing ? "fail" : "pass"));
    await seedRun(platform, seed, outcomes, { daysAgo: 3 });
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-case-dash-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    store = await project("Practice Store", ["agent"], ["test-generation"]);
    await oldTests(store, 12, 3);
    await planRun(store, ["/", "/products", "/products/1", "/about"], [["/", "/products"], ["/products", "/products/1"], ["/", "/about"]], [
        { title: "Browse the product list", startPath: "/products" },
        { title: "Open a product from the list", startPath: "/products" },
        { title: "Read a product's details", startPath: "/products/1" },
        { title: "Read about the shop", startPath: "/about" },
    ], ["/broken"]);
    await planRun(store, ["/", "/products", "/cart"], [["/", "/products"], ["/products", "/cart"]], [
        { title: "Browse the product list", startPath: "/products" },
        { title: "Add a product to the cart", startPath: "/cart" },
    ]);
    fresh = await project("Fresh Store", ["agent"], ["test-generation"]);
    quarry = await project("Quarry Store", ["agent"], ["test-generation", "accessibility"]);
    const stopped = await planRun(quarry, ["/", "/products"], [["/", "/products"]], [{ title: "Browse the product list", startPath: "/products" }]);
    platform.repo.setJobStatus(stopped, "FAILED", "Cancelled");
    access = await project("Access Store", ["agent"], ["accessibility"]);
    await oldTests(access, 4, 1);
    mixed = await project("Mixed Store", ["agent", "code"]);
    await oldTests(mixed, 4, 1);
    code = await project("Code Store", ["code"]);
    await oldTests(code, 4, 1);

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
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(shots, name), fullPage: true, animations: "disabled" });
}
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.locator("h1").first()).toBeVisible();
}
async function dashboard(id: string) {
    await visit(routes.project(id));
    await pwExpect(page.getByTestId("project-head")).toBeVisible();
}
const contentText = async () => (await page.locator(".content").textContent()) ?? "";
async function axe(what: string) {
    await page.waitForTimeout(300);
    const r = await new AxeBuilder({ page }).analyze();
    expect(r.violations.map((v) => `${what}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function noOverflow() {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}
const row = (name: string) => page.locator("a.list-row", { hasText: name });

/** Texts that belong to tests, runs of tests, plans or the old lists of pages: none may show on a Test Case Generation Dashboard. */
const NOT_ON_TCG = [
    "Passing",
    "Not passing",
    "tests passing",
    "Run all tests",
    "Open a test that is not passing",
    "See each test",
    "View tests",
    "View test suite",
    "Your test suite is ready",
    "Needs your attention",
    "check very little",
    "Here is what we will do",
    "Create the tests",
    "Discard the plan",
    "Edit the plan",
    "Kinds of test",
    "Plan ready",
    "test ideas",
    "What the explorer knows",
    "Site map",
    "What we found",
    "Screens found",
    "Requirements coverage",
    "Last explored",
    "API checks",
    "Page health",
    "Run these tests",
    // The plan card (owner's screenshot of a TCG project, 2026-11-20): none of it may show.
    "We will create about",
    "Nothing has been created or run yet",
    "Journeys through the app",
    "Form input",
];

describe("the Dashboard of a Test Case Generation project", () => {
    it("is the outcome: header, setup checklist and the report, with no pass or fail, no tests to run, no plan step and no coverage", async () => {
        await dashboard(store);
        const outcome = page.getByTestId("case-outcome");
        await pwExpect(outcome).toBeVisible();
        await pwExpect(page.getByTestId("outcome-summary")).toHaveText("5 pages, 5 test cases, from 2 runs");
        const head = page.getByTestId("project-head");
        await pwExpect(head.locator("h1")).toHaveText("Practice Store");
        await pwExpect(head.getByRole("link", { name: "Explore again" })).toHaveAttribute("href", routes.newProject({ project: store }));
        await pwExpect(head.getByRole("link")).toHaveCount(2); // the application's address and Explore again
        await pwExpect(outcome.getByTestId("outcome-download")).toHaveText("Download test cases");
        await pwExpect(page.getByTestId("outcome-not-opened")).toContainText("1 address could not be opened");
        // At most three regions: the setup checklist (only while something is missing) and the report.
        const parts = await page.getByTestId("case-agent-dashboard").evaluate((el) => Array.from(el.children).map((c) => c.getAttribute("data-testid") ?? c.className));
        expect(parts.filter((p) => p !== "setup-checklist")).toEqual(["case-outcome"]);
        await pwExpect(page.getByTestId("requirements-coverage")).toHaveCount(0);
        const text = await contentText();
        for (const banned of NOT_ON_TCG) expect(text, banned).not.toContain(banned);
        // The tabs of an agent project; no Test scripts.
        expect((await page.getByRole("navigation", { name: "Project sections", exact: true }).locator("a.tab").allTextContents()).map((t) => t.replace(/\d+$/, "").trim())).toEqual(["Dashboard", "Runs", "Requirements", "Settings"]);
        await shot("dashboard.png");
    });

    it("has no plan card: no 'We will create about', no family counts, no Create the tests, Discard the plan, Edit the plan or What we found (owner 2026-11-20)", async () => {
        // The project's newest job is a plan-only exploration with a saved plan: the old Dashboard showed it as a plan card here.
        await dashboard(store);
        await pwExpect(page.getByTestId("case-outcome")).toBeVisible();
        for (const name of ["Create the tests", "Discard the plan", "Edit the plan", /What we found/]) {
            await pwExpect(page.getByRole("button", { name })).toHaveCount(0);
            await pwExpect(page.getByText(name)).toHaveCount(0);
        }
        for (const t of ["We will create about", "Nothing has been created or run yet", "Journeys through the app", "Form input", "Change what is included"]) await pwExpect(page.getByText(t)).toHaveCount(0);
        await shot("no-plan-card.png");
    });

    it("counts one page per tree node, the same as the server's outcome and its workbook", async () => {
        await dashboard(store);
        const o = (await api("GET", `/api/projects/${store}/outcome`)).body;
        expect(o.caseAgent).toBe(true);
        // Open every node and count them.
        for (let i = 0; i < 20; i++) {
            const closed = page.locator('.ot-item[aria-expanded="false"] > .ot-row .ot-chev');
            if ((await closed.count()) === 0) break;
            await closed.first().click();
        }
        await pwExpect(page.getByRole("treeitem")).toHaveCount(5);
        expect(o.tree.length).toBe(5);
        expect(o.pages.length).toBe(5);
        expect((await page.getByTestId("outcome-summary").textContent())!.startsWith(`${o.tree.length} pages,`)).toBe(true);
        expect(await page.locator(".oc-list > .oc-case").count()).toBe(o.cases.length);
    });

    it("has an ARIA tree that works by keyboard (P3.4): one tab stop, arrows open, close and move, Enter lists the page's test cases", async () => {
        await dashboard(store);
        const tree = page.getByRole("tree", { name: "Pages of the application" });
        await pwExpect(tree).toBeVisible();
        await pwExpect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
        const focused = () => page.evaluate(() => document.activeElement?.querySelector(".ot-title")?.textContent ?? null);
        const level = () => page.evaluate(() => document.activeElement?.getAttribute("aria-level") ?? null);
        await tree.locator('[tabindex="0"]').focus();
        expect(await focused()).toBe("Home");
        expect(await level()).toBe("1");
        await page.keyboard.press("ArrowDown");
        expect(await focused()).toBe("Products");
        const products = tree.locator('[role="treeitem"][data-path="/products"]');
        expect(await products.getAttribute("aria-expanded")).toBe("false");
        await page.keyboard.press("ArrowRight");
        expect(await products.getAttribute("aria-expanded")).toBe("true");
        await page.keyboard.press("ArrowRight");
        expect(await focused()).toBe("Travel mug");
        expect(await level()).toBe("3");
        await page.keyboard.press("ArrowLeft");
        expect(await focused()).toBe("Products");
        // Enter selects: the cases that start on Products, and the count on the node is what is listed.
        await page.keyboard.press("Enter");
        expect(await products.getAttribute("aria-selected")).toBe("true");
        await pwExpect(page.getByTestId("outcome-cases").locator("h3")).toHaveText("Test cases on Products2");
        await pwExpect(page.locator(".oc-list > .oc-case")).toHaveCount(2);
        await pwExpect(products.locator(":scope > .ot-row .ot-count")).toHaveText("2");
        await page.keyboard.press("ArrowLeft");
        expect(await products.getAttribute("aria-expanded")).toBe("false");
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.closest('[role="tree"]') === null)).toBe(true);
        await shot("tree-light.png");
    });

    it("passes axe in light and dark", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await dashboard(store);
            await pwExpect(page.getByTestId("case-outcome")).toBeVisible();
            await axe(`dashboard ${scheme}`);
            if (scheme === "dark") {
                await page.getByRole("tree").locator('[role="treeitem"][data-path="/products"] > .ot-row .ot-chev').click();
                await page.getByRole("tree").locator('[role="treeitem"][data-path="/products"] > .ot-row .ot-title').click();
                await axe("tree dark, a page selected");
                await shot("tree-dark.png");
            }
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("Download test cases saves the project's workbook", async () => {
        await dashboard(store);
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("outcome-download").click()]);
        expect(download.suggestedFilename()).toBe("Practice Store test cases.xlsx");
        const file = path.join(dataDir, "saved.xlsx");
        await download.saveAs(file);
        expect(fs.readFileSync(file).subarray(0, 2).toString()).toBe("PK");
        await pwExpect(page.getByText("The test cases could not be downloaded")).toHaveCount(0);
    });

    it("a refused download says the server's sentence (the workbook answer is made by the test)", async () => {
        const sentence = "There are no test cases to download yet. Explore the application first.";
        await page.route("**/api/projects/*/outcome/workbook", (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: sentence }) }));
        try {
            await dashboard(store);
            await page.getByTestId("outcome-download").click();
            const alert = page.locator(".callout", { hasText: "The test cases could not be downloaded" });
            await pwExpect(alert).toBeVisible();
            await pwExpect(alert).toContainText(sentence);
        } finally {
            await page.unroute("**/api/projects/*/outcome/workbook");
        }
    });

    it("has no Download button for a person without the export permission (the page's /api/auth/state is answered by the test)", async () => {
        await page.route("**/api/auth/state", async (r) => {
            const res = await r.fetch();
            const body = await res.json();
            const all: string[] = body.me?.permissions ?? [];
            expect(all).toContain("ai_studio.reports.export");
            body.me.permissions = all.filter((p) => p !== "ai_studio.reports.export");
            await r.fulfill({ response: res, json: body });
        });
        try {
            await dashboard(store);
            await pwExpect(page.getByTestId("outcome-summary")).toBeVisible();
            await pwExpect(page.getByTestId("outcome-download")).toHaveCount(0);
            await pwExpect(page.getByText("Download test cases")).toHaveCount(0);
        } finally {
            await page.unroute("**/api/auth/state");
        }
    });

    it("an outcome that cannot be read shows its sentence and Try again, never the old agent Dashboard (F3 L4; the answer is made by the test)", async () => {
        const sentence = "The outcome could not be read just now.";
        const outcomeUrl = (u: URL) => u.pathname === `/api/projects/${store}/outcome`;
        await page.route(outcomeUrl, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: sentence }) }));
        try {
            await dashboard(store);
            const failed = page.getByTestId("case-agent-dashboard").locator(".callout", { hasText: "The test cases could not be loaded" });
            await pwExpect(failed).toBeVisible();
            await pwExpect(failed).toContainText(sentence);
            await shot("outcome-error.png");
            const text = await contentText();
            for (const banned of NOT_ON_TCG) expect(text, banned).not.toContain(banned);
        } finally {
            await page.unroute(outcomeUrl);
        }
        await page.getByRole("button", { name: "Try again" }).click();
        await pwExpect(page.getByTestId("outcome-summary")).toBeVisible();
        await pwExpect(page.getByText("The test cases could not be loaded")).toHaveCount(0);
    });

    it("not explored yet: Start exploring, and no download", async () => {
        await dashboard(fresh);
        const outcome = page.getByTestId("case-outcome");
        await pwExpect(outcome.getByRole("heading", { name: "Not explored yet" })).toBeVisible();
        await pwExpect(outcome.getByRole("link", { name: "Start exploring" })).toHaveAttribute("href", routes.newProject({ project: fresh }));
        await pwExpect(page.getByTestId("outcome-download")).toHaveCount(0);
        await pwExpect(page.getByTestId("outcome-summary")).toHaveCount(0);
        const text = await contentText();
        for (const banned of NOT_ON_TCG) expect(text, banned).not.toContain(banned);
        expect(text).not.toContain("The test cases it writes run only when you run them");
    });

    it("a stopped run keeps what it found, with no 'Exploring was stopped… nothing was created' and no See each test", async () => {
        await dashboard(quarry);
        await pwExpect(page.getByTestId("outcome-summary")).toHaveText("2 pages, 1 test case, from 1 run");
        await pwExpect(page.getByTestId("outcome-run-note")).toContainText("The last run was stopped. It kept the");
        await pwExpect(page.getByTestId("exploring-stopped")).toHaveCount(0);
        const text = await contentText();
        for (const banned of [...NOT_ON_TCG, "No plan was made", "Try again"]) expect(text, banned).not.toContain(banned);
    });

    it("fits a phone: no sideways scroll at 375 px, the tree and the download still there", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            await dashboard(store);
            await pwExpect(page.getByTestId("outcome-download")).toBeVisible();
            await pwExpect(page.getByRole("tree")).toBeVisible();
            await page.waitForTimeout(300);
            await noOverflow();
            await shot("dashboard-375.png");
            await page.emulateMedia({ colorScheme: "dark" });
            await page.waitForTimeout(300);
            await shot("dashboard-dark-375.png");
            await page.emulateMedia({ colorScheme: null });
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });
});

describe("the Projects row of a Test Case Generation project", () => {
    it("says its outcome's counts, or Not explored yet, never Plan ready or tests passing", async () => {
        await visit("#/?page=all");
        await pwExpect(row("Practice Store")).toBeVisible();
        await pwExpect(row("Practice Store").getByTestId("row-cases")).toHaveText("5 test cases, 5 pages");
        await pwExpect(row("Practice Store").locator(".tail")).toHaveText("Test cases written");
        await pwExpect(row("Practice Store").locator(".pk-ribbon > *")).toHaveCount(0);
        await pwExpect(row("Fresh Store").locator(".tail")).toHaveText("Not explored yet");
        await pwExpect(row("Fresh Store").getByTestId("row-cases")).toHaveCount(0);
        await pwExpect(row("Quarry Store").getByTestId("row-cases")).toHaveText("1 test case, 2 pages");
        await pwExpect(row("Quarry Store").locator(".tail")).toHaveText("Stopped");
        for (const name of ["Practice Store", "Fresh Store", "Quarry Store"]) {
            const t = (await row(name).textContent()) ?? "";
            expect(t, name).not.toMatch(/Plan ready|tests passing|Exploration failed|Ready/);
        }
        await axe("projects");
        await page.locator(".pk-list").first().screenshot({ path: shots ? (fs.mkdirSync(shots, { recursive: true }), path.join(shots, "projects-row.png")) : path.join(dataDir, "rows.png") });
    });

    it("asks only for the outcome's counts, which match the full outcome (F3 L6)", async () => {
        const asked: string[] = [];
        const onRequest = (r: { url: () => string }) => void (r.url().includes("/outcome") && asked.push(r.url()));
        page.on("request", onRequest);
        try {
            await visit("#/?page=all");
            await pwExpect(row("Practice Store").getByTestId("row-cases")).toHaveText("5 test cases, 5 pages");
        } finally {
            page.off("request", onRequest);
        }
        expect(asked.length).toBeGreaterThan(0);
        for (const u of asked) expect(new URL(u).searchParams.get("counts"), u).toBe("1");

        const full = (await api("GET", `/api/projects/${store}/outcome`)).body;
        const counts = await api("GET", `/api/projects/${store}/outcome?counts=1`);
        expect(counts.status).toBe(200);
        expect(counts.body).toEqual({ caseAgent: true, runs: full.runs, counts: { cases: full.cases.length, pages: full.pages.length, areas: 0 } });
        expect((await api("GET", `/api/projects/${access}/outcome?counts=1`)).body).toEqual({ caseAgent: false, runs: [], counts: { cases: 0, pages: 0, areas: 0 } });
    });

    it("rows of other projects are unchanged: pass counts and their ribbon", async () => {
        await visit("#/?page=all");
        for (const name of ["Access Store", "Mixed Store", "Code Store"]) {
            await pwExpect(row(name)).toContainText("3 of 4 tests passing");
            await pwExpect(row(name).locator(".pk-ribbon > *")).toHaveCount(1);
            await pwExpect(row(name).getByTestId("row-cases")).toHaveCount(0);
        }
    });

    it("fits a phone", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            await visit("#/?page=all");
            await pwExpect(row("Practice Store").getByTestId("row-cases")).toBeVisible();
            await page.waitForTimeout(300);
            await noOverflow();
            await shot("projects-375.png");
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });
});

describe("other projects keep their Dashboards", () => {
    it("an agent project of other agents: the same Dashboard (tests, Passing, Not passing), and no requirements coverage (P6)", async () => {
        await dashboard(access);
        await pwExpect(page.getByTestId("case-outcome")).toHaveCount(0);
        await pwExpect(page.locator(".metrics:not(.quality-metrics)")).toContainText("Passing");
        await pwExpect(page.locator(".metrics:not(.quality-metrics)")).toContainText("Not passing");
        await pwExpect(page.getByTestId("project-head").getByRole("link", { name: "View tests" })).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Needs your attention" })).toBeVisible();
        await pwExpect(page.getByTestId("requirements-coverage")).toHaveCount(0);
        expect((await api("GET", `/api/projects/${access}/outcome`)).body.caseAgent).toBe(false);
    });

    it("a mixed project and a code project: the same Dashboard, with requirements coverage", async () => {
        for (const id of [mixed, code]) {
            await dashboard(id);
            await pwExpect(page.locator(".metrics:not(.quality-metrics)")).toContainText("Passing");
            await pwExpect(page.getByTestId("requirements-coverage")).toBeVisible();
            await pwExpect(page.getByTestId("case-outcome")).toHaveCount(0);
        }
        expect(consoleErrors).toEqual([]);
    });
});
