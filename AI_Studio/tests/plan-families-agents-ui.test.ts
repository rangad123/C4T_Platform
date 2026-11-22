/**
 * Founder 2026-11-19 (sheet row 19; SPEC P2.4, P4.1, P4.3, R13) in a real browser against a real platform, no worker:
 * - the plan's "Edit the plan" list shows only the kinds of test the chosen agents do: an Accessibility-only project shows only
 *   "Accessibility"; a mixed project keeps every kind;
 * - a Test Case Generation project's old test script address (#/tests/<id>) and its Test scripts place say where test scripts live,
 *   with no DSL or Code tabs, no Run button and no draft warning; a mixed project's script page is unchanged;
 * - the explore form of a Test Case Generation project says what will happen and has no "checks" wording;
 * - the Test Case Generation Agent's page says "What it gives you", not "What it checks".
 * Axe in light and dark, and a phone width (390 px) with no sideways scrolling.
 *
 * Requires web/dist: node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/plan-families-agents-ui.test.ts"
 * Screenshots: $SHOTS_DIR (when set). Port: platform 7633.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7633;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS_DIR;
const SITE = "http://127.0.0.1:7634";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];
const ids = { a11y: "", mixed: "", tcg: "", tcgPlus: "", a11yJob: "", mixedJob: "", tcgTest: "", mixedTest: "" };

// The twelve kinds of test a web plan lists (src/engine/planning/preview.ts), as GET /api/projects/:id/plans/:jobId answers them.
const KINDS: Array<[string, string, string, "web" | "api" | "both"]> = [
    ["journeys", "Journeys through the app", "web", "web"],
    ["api", "API checks", "api", "api"],
    ["contract", "Answers match the documentation", "contractChecks", "api"],
    ["accessibility", "Accessibility", "accessibility", "web"],
    ["health", "Page health", "healthChecks", "web"],
    ["input", "Form input", "inputChecks", "web"],
    ["security", "Basic security", "securityChecks", "both"],
    ["access", "Who can open what", "accessChecks", "both"],
    ["performance", "Speed", "performanceChecks", "both"],
    ["load", "Load", "loadChecks", "api"],
    ["visual", "Visual changes", "visual", "web"],
    ["vision", "AI screen review", "visionChecks", "web"],
];
const planAnswer = (jobId: string) => ({
    ready: true,
    jobId,
    status: "COMPLETED",
    createdAt: new Date().toISOString(),
    url: SITE,
    targets: ["web", "api"],
    found: { pages: 4, apiEndpoints: 2, forms: 1, journeys: 2 },
    about: null,
    pages: [{ path: "/", title: "Shop home", type: "home" }],
    ideas: [{ id: "S-001", title: "Search for a kettle", journey: "Search", priority: "high", type: "functional" }],
    families: KINDS.map(([id, label, option, needs]) => ({ id, label, about: `About ${label}.`, count: 2, on: true, option, needs, ...(needs === "both" ? { split: { web: 1, api: 1 } } : {}) })),
    total: 24,
    warnings: [],
    signInDetails: false,
    used: null,
});

async function agentProject(name: string, agents: string[] | null, modes: string[] = ["agent"]): Promise<string> {
    // A mixed project (both modes) can no longer be made through the API (one mode per project): made as an older project was.
    const id = modes.length > 1 ? (platform.repo.createProject({ name, platforms: ["web"], testingModes: modes as Array<"agent" | "code"> }).id as string) : ((await server.inject({ method: "POST", url: "/api/projects", payload: { name, platforms: ["web"], testingModes: modes } })).json().id as string);
    expect(id, name).toBeTruthy();
    if (agents) {
        const r = await server.inject({ method: "PUT", url: `/api/projects/${id}/testing-agents`, payload: { agents } });
        expect(r.statusCode, r.body).toBe(200);
    }
    return id;
}
async function planJob(projectId: string): Promise<string> {
    const { repo } = platform;
    const app = repo.createApplication(projectId, SITE, {});
    const job = await repo.createJob(projectId, app, { ...DEFAULT_JOB_OPTIONS, targets: ["web", "api"], planOnly: true });
    for (const p of ["discovery", "understanding", "planning"] as const) repo.setPhase(job.id, p, "done");
    repo.setJobStatus(job.id, "COMPLETED");
    return job.id;
}
function oldScript(projectId: string): string {
    const { repo } = platform;
    const suite = repo.getOrCreateSuite(projectId, "Browsing", "browsing");
    return repo.insertTest({ projectId, suiteId: suite, jobId: null, spec: TestSpecSchema.parse({ testId: "WEB-001", title: "Browse the product list", kind: "web", category: "Browsing", steps: [{ action: "navigate", url: "/products" }] }), framework: "playwright", validationStatus: "PENDING" });
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plan-agents-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "plan-agents-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    ids.a11y = await agentProject("Accessible shop", ["accessibility"]);
    ids.mixed = await agentProject("Mixed shop", null, ["agent", "code"]);
    ids.tcg = await agentProject("Case shop", ["test-generation"]);
    ids.tcgPlus = await agentProject("Case shop with more agents", ["test-generation", "accessibility", "security"]);
    ids.a11yJob = await planJob(ids.a11y);
    ids.mixedJob = await planJob(ids.mixed);
    ids.tcgTest = oldScript(ids.tcg);
    ids.mixedTest = oldScript(ids.mixed);

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    for (const [pid, jid] of [
        [ids.a11y, ids.a11yJob],
        [ids.mixed, ids.mixedJob],
    ] as const) {
        await page.route(`**/api/projects/${pid}/plans/${jid}`, (route) => route.fulfill({ json: planAnswer(jid) }));
    }
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
async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}
/** At 390 px the page needs no sideways scrolling; a screenshot of it when asked. */
async function onPhone(name?: string) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    if (name) await shot(name);
    await page.setViewportSize({ width: 1280, height: 900 });
}
const content = () => page.locator(".content");
const kindsShown = async () => page.getByRole("group", { name: "Kinds of test" }).locator(".plan-family > label.check > span > .title").allTextContents();

describe("the plan lists the kinds of test of the chosen agents (R13)", () => {
    it("an Accessibility-only project's plan shows only Accessibility", async () => {
        await page.goto(`${BASE}/#/projects/${ids.a11y}`);
        await pwExpect(page.getByTestId("plan-preview")).toBeVisible();
        await page.locator("summary", { hasText: "Edit the plan" }).click();
        expect(await kindsShown()).toEqual(["Accessibility"]);
        // What the plan would make counts only that kind, too.
        await pwExpect(page.getByRole("list", { name: "Tests to create" }).getByRole("listitem")).toHaveCount(1);
        await pwExpect(page.getByRole("list", { name: "Tests to create" })).toContainText("Accessibility");
        for (const gone of ["API checks", "Page health", "Form input", "Basic security", "Who can open what", "Speed", "Load", "Visual changes", "AI screen review"]) await pwExpect(content().getByText(gone, { exact: true })).toHaveCount(0);
        await shot("plan-accessibility-only.png");
        await axeBoth();
    });

    it("a mixed project's plan keeps every kind (unchanged this round)", async () => {
        await page.goto(`${BASE}/#/projects/${ids.mixed}`);
        await pwExpect(page.getByTestId("plan-preview")).toBeVisible();
        await page.locator("summary", { hasText: "Edit the plan" }).click();
        expect(await kindsShown()).toEqual(KINDS.map((k) => k[1]));
    });
});

describe("a Test Case Generation project has no test scripts (P2.4)", () => {
    it("an old test script's address says where test scripts live, with no tabs, no Run and no draft warning", async () => {
        await page.goto(`${BASE}/#/tests/${ids.tcgTest}`);
        const notice = page.getByTestId("scripts-in-code-projects");
        await pwExpect(notice).toBeVisible();
        await pwExpect(notice).toContainText("Test scripts belong to code projects");
        await pwExpect(notice).toContainText("Download this project's test cases and import them into a code project.");
        await pwExpect(page.getByRole("heading", { name: "Browse the product list" })).toBeVisible();
        await pwExpect(page.getByRole("tab")).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: /^Run/ })).toHaveCount(0);
        await pwExpect(content().getByText(/a draft|in review/)).toHaveCount(0);
        await pwExpect(notice.getByRole("link", { name: "Open the test cases" })).toHaveAttribute("href", `#/projects/${ids.tcg}`);
        await pwExpect(notice.getByRole("link", { name: "Create a code project" })).toHaveAttribute("href", "#/create");
        await shot("old-script-url.png");
        await axeBoth();
        await onPhone("old-script-url-phone.png");
    });

    it("its Test scripts place says the same, with no scripts listed", async () => {
        await page.goto(`${BASE}/#/projects/${ids.tcg}/scripts`);
        await pwExpect(page.getByTestId("scripts-in-code-projects")).toBeVisible();
        await pwExpect(content().getByText("Browse the product list")).toHaveCount(0);
        for (const gone of ["Review", "Reusable steps", "Helpers (code)"]) await pwExpect(page.getByRole("link", { name: gone, exact: true })).toHaveCount(0);
        await shot("old-scripts-place.png");
        await axeBoth();
        await onPhone("old-scripts-place-phone.png");
    });

    it("a mixed project's script page keeps its tabs", async () => {
        await page.goto(`${BASE}/#/tests/${ids.mixedTest}`);
        await pwExpect(page.getByRole("tab", { name: "DSL" })).toBeVisible();
        await pwExpect(page.getByTestId("scripts-in-code-projects")).toHaveCount(0);
    });
});

describe("the explore form of a Test Case Generation project (P4.3)", () => {
    it("says what will happen, and has no checks wording", async () => {
        await page.goto(`${BASE}/#/new?project=${ids.tcg}`);
        await pwExpect(page.getByText("We’ll explore the application, add to its tree and write test cases. Nothing is run.", { exact: false })).toBeVisible();
        await pwExpect(page.getByTestId("explore-agents")).toHaveText("The Test Case Generation Agent writes this project’s test cases.");
        await pwExpect(page.getByTestId("ai-note")).toHaveText("Exploring uses your AI key: it reads each page and writes the test cases in plain English.");
        await pwExpect(page.getByTestId("screen-review")).toHaveCount(0);
        const text = await content().innerText();
        expect(text).not.toMatch(/\bchecks?\b|checked by|show you a plan|tests are kept/i);
        await shot("explore-form.png");
        await axeBoth();
        await onPhone("explore-form-phone.png");
    });

    it("with other agents chosen as well, says they come back later (Q6)", async () => {
        await page.goto(`${BASE}/#/new?project=${ids.tcgPlus}`);
        await pwExpect(page.getByTestId("explore-agents")).toHaveText("The Test Case Generation Agent writes this project’s test cases. The Accessibility Testing Agent and Security Testing Agent come back in a later update.");
    });

    it("an Accessibility-only project's form still names its agent", async () => {
        await page.goto(`${BASE}/#/new?project=${ids.a11y}`);
        await pwExpect(page.getByTestId("explore-agents")).toHaveText("Checked by this project’s testing agents: Accessibility Testing Agent.");
    });
});

describe("the Test Case Generation Agent's page (FX6)", () => {
    it("says what it gives you; other agents still say what they check", async () => {
        await page.goto(`${BASE}/#/agents/test-generation`);
        const d = page.getByTestId("agent-detail");
        await pwExpect(d.getByRole("heading", { name: "What it gives you" })).toBeVisible();
        await pwExpect(d.getByRole("heading", { name: "What it checks" })).toHaveCount(0);
        await shot("agent-what-it-gives.png");
        await axeBoth();
        await onPhone("agent-what-it-gives-phone.png");
        await page.goto(`${BASE}/#/agents/accessibility`);
        await pwExpect(page.getByTestId("agent-detail").getByRole("heading", { name: "What it checks" })).toBeVisible();
    });

    it("logged no script errors", () => {
        expect(consoleErrors).toEqual([]);
    });
});
