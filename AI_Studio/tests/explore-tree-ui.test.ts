/**
 * Sheet #6 and #7 in a real browser against a real platform (no worker: the jobs, their events and their tests are recorded in the
 * database as an exploration records them).
 *
 * - The run page of a creation that is writing its tests shows the progress tree: the stages with their state in words, the running stage
 *   open, its test ideas (written, being written, waiting) with their tests under them, the checks in one group, and every branch a button
 *   that says what it holds. On a phone-sized screen every branch starts folded. No accessibility violations in the tree.
 * - A stopped plan-only exploration offers Continue and Start over on the project page. Continue asks the platform to carry on, and a refusal
 *   shows the platform's sentence.
 *
 * Requires web/dist: node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/explore-tree-ui.test.ts"
 * Screenshots: $SHOTS_DIR (when set). Ports: platform 6735.
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
import { continueNeedsUpdate } from "../src/platform/explore-task.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 6735;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS_DIR;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId: string;
let creationJob: string;
let stoppedPlan: string;
const continues: string[] = [];
let refuse: string | null = null;
let refuseDetails: unknown;
const consoleErrors: string[] = [];

/** Events as the engine records them for a creation from a plan that is writing its second idea (orchestrator.ts, crawler.ts). */
const CREATION: EngineEvent[] = [
    { stage: "discovery", kind: "plan_reused", message: "Starting from the plan you approved: 5 pages and 0 API endpoints (nothing is explored again)" },
    { stage: "generation", kind: "scenarios_queued", message: "3 test idea(s) to write", data: { scenarios: [{ scenarioId: "S-001", title: "Browse the product list" }, { scenarioId: "S-002", title: "Read the about page" }, { scenarioId: "S-003", title: "Open the contact page" }] } },
    { stage: "generation", kind: "scenario_started", message: "S-001 Browse the product list", data: { scenarioId: "S-001" } },
    { stage: "generation", kind: "script_generated", message: "WEB-001 Browse the product list (2 steps)", data: { scenarioId: "S-001", testId: "WEB-001" } },
    { stage: "generation", kind: "scenario_started", message: "S-002 Read the about page", data: { scenarioId: "S-002" } },
];
const PLAN: EngineEvent[] = [
    { stage: "discovery", kind: "application_discovered", message: "Starting discovery of http://127.0.0.1:6731" },
    { stage: "discovery", kind: "page_visited", message: "Visited / (home, 0 forms, 4 controls)", data: { url: "http://127.0.0.1:6731/", status: 200, depth: 0, type: "home" } },
    { stage: "discovery", kind: "page_visited", message: "Visited /products (listing, 0 forms, 1 controls)", data: { url: "http://127.0.0.1:6731/products", status: 200, depth: 1, type: "listing" } },
];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-tree-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "explore-tree-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const repo = platform.repo;
    projectId = (await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Tree shop", platforms: ["web"], testingModes: ["agent"] } })).json().id;
    const app = repo.createApplication(projectId, "http://127.0.0.1:6731", {});

    // A creation writing its tests: generation running, one idea written (its test made), one being written, one waiting; two checks made.
    const creation = await repo.createJob(projectId, app, { ...DEFAULT_JOB_OPTIONS, targets: ["web"], fromPlan: "plan-job-stand-in" });
    creationJob = creation.id;
    for (const p of ["discovery", "understanding", "planning"] as const) repo.setPhase(creationJob, p, "done");
    repo.setJobStatus(creationJob, "GENERATING");
    repo.setPhase(creationJob, "generation", "running");
    for (const e of CREATION) repo.addEvent(creationJob, e);
    const suite = repo.getOrCreateSuite(projectId, "Browsing", "browsing");
    const spec = (testId: string, title: string) => TestSpecSchema.parse({ testId, title, kind: "web", category: "Browsing", steps: [{ action: "navigate", url: "/" }] });
    repo.insertTest({ projectId, suiteId: suite, jobId: creationJob, spec: spec("WEB-001", "Browse the product list"), framework: "playwright", validationStatus: "PENDING" });
    repo.insertTest({ projectId, suiteId: suite, jobId: creationJob, spec: spec("WEB-002", "Accessibility audit: Home"), framework: "playwright", validationStatus: "PENDING" });
    repo.insertTest({ projectId, suiteId: suite, jobId: creationJob, spec: spec("WEB-003", "Page health: Home"), framework: "playwright", validationStatus: "PENDING" });
    // It stays running: this platform has no worker to take it.

    // The project's latest job: a plan-only exploration stopped while it planned.
    const plan = await repo.createJob(projectId, app, { ...DEFAULT_JOB_OPTIONS, targets: ["web"], planOnly: true });
    stoppedPlan = plan.id;
    for (const e of PLAN) repo.addEvent(stoppedPlan, e);
    repo.setPhase(stoppedPlan, "discovery", "done");
    repo.setPhase(stoppedPlan, "understanding", "done");
    repo.setPhase(stoppedPlan, "planning", "running");
    repo.setJobStatus(stoppedPlan, "FAILED", "Cancelled");

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.route(`**/api/projects/${projectId}/explorations/*/continue`, async (route) => {
        continues.push(new URL(route.request().url()).pathname);
        if (refuse) return route.fulfill({ status: 409, json: { error: refuse, ...(refuseDetails ? { details: refuseDetails } : {}) } });
        await route.fulfill({ status: 202, json: { jobId: "continued", status: "QUEUED", from: "reading" } });
    });
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

describe("the progress tree on a run's page", () => {
    it("shows stages, the ideas with their tests and the checks, each with its state in words; the running stage is open", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runs/${creationJob}`);
        const tree = page.getByTestId("explore-tree");
        await tree.waitFor();
        const gen = page.getByTestId("xt-stage:generation");
        await expect.poll(() => gen.getAttribute("data-state"), { timeout: 15_000 }).toBe("running");
        expect(await page.getByTestId("xt-stage:discovery").getAttribute("data-state")).toBe("done");
        expect(await page.getByTestId("xt-stage:validation").getAttribute("data-state")).toBe("waiting");
        // The running stage starts open: its ideas and the checks group are listed with their states.
        const toggle = gen.locator(":scope > button.xt-toggle");
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        await expect.poll(() => toggle.innerText(), { timeout: 15_000 }).toMatch(/Hide 4 items\s+\(1 running, 1 done, 2 waiting\)/);
        expect(await page.getByTestId("xt-idea:S-001").getAttribute("data-state")).toBe("done");
        expect(await page.getByTestId("xt-idea:S-002").innerText()).toContain("Running");
        expect(await page.getByTestId("xt-idea:S-003").innerText()).toContain("Waiting");
        expect(await page.getByTestId("xt-checks").innerText()).toContain("Checks (2)");
        // A branch below opens on its button: the idea's own test.
        const idea = page.getByTestId("xt-idea:S-001");
        await idea.getByRole("button", { name: /Show 1 test/ }).click();
        await expect.poll(() => idea.innerText(), { timeout: 15_000 }).toContain("WEB-001 Browse the product list");
        // The crawl stage says the pages were kept, not explored again.
        await page.getByTestId("xt-stage:discovery").getByRole("button").click();
        await expect.poll(() => page.getByTestId("xt-stage:discovery").innerText(), { timeout: 15_000 }).toContain("5 pages kept from before, not explored again");
        const axe = await new AxeBuilder({ page }).include('[data-testid="explore-tree"]').analyze();
        expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
        await shot("tree-run-wide.png");
    });

    it("starts folded on a phone-sized screen, each branch saying what it holds", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${BASE}/#/projects/${projectId}`);
        await page.goto(`${BASE}/#/projects/${projectId}/runs/${creationJob}`);
        const gen = page.getByTestId("xt-stage:generation");
        await gen.waitFor();
        const toggle = gen.locator(":scope > button.xt-toggle");
        await expect.poll(() => toggle.innerText(), { timeout: 15_000 }).toMatch(/Show 4 items\s/);
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(await page.getByTestId("xt-idea:S-002").isVisible()).toBe(false);
        // No sideways scrolling on a phone.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await shot("tree-run-phone.png");
        await toggle.click();
        expect(await page.getByTestId("xt-idea:S-002").isVisible()).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
    });
});

describe("Continue on a stopped exploration", () => {
    it("the project page offers Continue and Start over; Continue asks the platform to carry on; a refusal shows its sentence", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}`);
        const card = page.getByTestId("exploring-stopped");
        await card.waitFor();
        expect(await card.innerText()).toMatch(/Continue carries on from where it stopped/);
        expect(await card.getByRole("link", { name: "Start over" }).getAttribute("href")).toContain(`#/new?project=${projectId}`);
        await shot("stopped-continue.png");
        refuse = "This exploration was already continued. Continue the newer one, or explore again.";
        await card.getByRole("button", { name: "Continue" }).click();
        await expect.poll(() => card.innerText(), { timeout: 15_000 }).toContain(refuse);
        expect(continues).toEqual([`/api/projects/${projectId}/explorations/${stoppedPlan}/continue`]);
        // Row 208: a runner too old to carry on is refused with its sentence (as the server sends it); Start over stays there.
        refuse = continueNeedsUpdate("Priya laptop");
        refuseDetails = { code: "RUNNER_CANNOT_RUN", link: "#/settings#runner" };
        await card.getByRole("button", { name: "Continue" }).click();
        await expect.poll(() => card.innerText(), { timeout: 15_000 }).toContain("Your runner “Priya laptop” is too old to continue an exploration; download the runner again, or choose Start over.");
        expect(await card.getByRole("link", { name: "Start over" }).isVisible()).toBe(true);
        await shot("continue-runner-too-old.png");
        refuse = null;
        refuseDetails = undefined;
        await card.getByRole("button", { name: "Continue" }).click();
        await expect.poll(() => continues.length, { timeout: 15_000 }).toBe(3);
        expect(consoleErrors).toEqual([]);
    });
});
