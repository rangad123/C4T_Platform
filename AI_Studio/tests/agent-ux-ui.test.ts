/**
 * The UX Testing Agent's page in a real browser (Agent Workspace W2b, .scratch/agent-workspace/SPEC.md §3):
 * - Outcome: each page's health (broken links, script errors, failed requests…, each problem with its severity and how to fix it) and
 *   the AI screen review's visual notes with the screenshot. No accessibility audit, no other agent's run, no test scripts.
 * - Runs: the agent's runs only (the default list); a run opens that run's part only, a stopped run's too.
 * - Setup: the agent's inputs only, with where each is kept.
 * - A project not run yet offers Run; the Workspace card carries the headline; axe passes in light and dark; nothing scrolls sideways at 375 px.
 *
 * Runs are seeded as a check agent's run leaves them (its checks as tests with their results and reasons), so no AI and no exploring
 * browser are needed. Port 7744. Requires web/dist:
 *   node scripts/with-lock.mjs build -- npm run build:web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/agent-ux-ui.test.ts
 * Set W2B_SHOTS=<folder> to write screenshots to <folder>/ux/.
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
import { DEFAULT_JOB_OPTIONS, type JobOptions, type JobStatus, type ValidationState } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { routes } from "../web/src/lib/router.js";

const PORT = 7744;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = "http://127.0.0.1:7749";
const shots = process.env.W2B_SHOTS;

let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let pid = "";
let fresh = "";
const ids: Record<string, string> = {};
const consoleErrors: string[] = [];

async function project(name: string, agents: string[]): Promise<string> {
    const id = platform.repo.createProject({ name, platforms: ["web"], testingModes: ["agent"] }).id as string;
    platform.repo.createApplication(id, SITE, { ...DEFAULT_JOB_OPTIONS });
    const r = await fetch(`${BASE}/api/projects/${id}/testing-agents`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agents }) });
    expect(r.status).toBe(200);
    return id;
}
async function run(agentId: string, status: JobStatus, error?: string, extra: Partial<JobOptions> = {}) {
    const appId = platform.repo.getLatestApplicationPublic(pid)!.id as string;
    const j = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, agentId: agentId as never, ...extra });
    platform.repo.setJobStatus(j.id, status, error);
    return j.id as string;
}
const STEP = { accessibility: { action: "assert", check: "a11y", expected: "serious" }, health: { action: "assert", check: "noBrokenLinks" }, vision: { action: "assert", check: "looksRight", expected: "" } } as const;
let n = 0;
function check(jobId: string, type: keyof typeof STEP, at: string, status: ValidationState, reason?: string): string {
    const spec = TestSpecSchema.parse({ testId: `WEB-${String(++n).padStart(3, "0")}`, title: `${type} of ${at}`, kind: "web", category: "Checks", type, steps: [{ action: "navigate", url: at }, STEP[type]] });
    const id = platform.repo.insertTest({ projectId: pid, suiteId: platform.repo.getOrCreateSuite(pid, "Web", "web"), jobId, spec, framework: "playwright", validationStatus: "PENDING", meta: { [type]: true } });
    if (status !== "PENDING") platform.repo.updateTest(id, { validationStatus: status, reason: reason ?? null });
    return id;
}
const audit = (rule: string) => `Accessibility audit failed: 1 WCAG rule violated at "serious" impact or above\n- ${rule} [critical]: Form elements must have labels (2 nodes: input, select)`;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ux-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    pid = await project("Checks Store", ["accessibility", "ux", "security"]);
    ids.u1 = await run("ux", "COMPLETED", undefined, { visionChecks: true });
    check(ids.u1, "health", "/", "NEEDS_REVIEW", "Page health check failed: 2 JavaScript errors were reported on this page\n- [medium] Uncaught error: cart is not defined\n- [medium] console.error: Could not load the basket\n1 link on this page is broken (checked 12)\n- [medium] /old-offers returned HTTP 404\nHow to fix: …");
    const look = check(ids.u1, "vision", "/", "NEEDS_REVIEW", "AI judgement — please look: a screen may not look right\n- [medium] Step 2 (high confidence): The footer covers the Add to cart button\nHow to check: …");
    platform.repo.addArtifact({ projectId: pid, jobId: ids.u1, testId: look, kind: "screenshot", path: `${pid}/_artifacts/x/screenshot.png`, size: 10 });
    check(ids.u1, "health", "/about", "VALIDATED");
    check(ids.u1, "vision", "/about", "VALIDATED");
    ids.u2 = await run("ux", "FAILED", "Cancelled");
    check(ids.u2, "health", "/products", "NEEDS_REVIEW", "Page health check failed: 1 request to this site failed\n- [high] GET /api/stock returned HTTP 500");
    // Another agent's run, with an audit and a health check in it: on neither page.
    ids.sec = await run("security", "COMPLETED");
    check(ids.sec, "accessibility", "/admin", "NEEDS_REVIEW", audit("label"));
    check(ids.sec, "health", "/admin", "NEEDS_REVIEW", "Page health check failed: 1 link on this page is broken (checked 1)\n- [medium] /x returned HTTP 404");
    fresh = await project("Fresh Store", ["accessibility", "ux"]);

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
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

async function shot(agent: string, name: string) {
    if (!shots) return;
    fs.mkdirSync(path.join(shots, agent), { recursive: true });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(shots, agent, name), fullPage: true, animations: "disabled" });
}
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.locator("h1").first()).toBeVisible();
}
async function axe(what: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${what} (${scheme}): ${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}
async function narrow(agent: string, name: string) {
    await page.setViewportSize({ width: 375, height: 800 });
    try {
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await shot(agent, name);
    } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
    }
}
const tab = (agent: string, name: string) => page.getByRole("navigation", { name: `${agent} sections` }).getByRole("link", { name });

describe("the UX Testing Agent's page", () => {
    it("Outcome: each page's health and the visual notes; nothing of another agent", async () => {
        await visit(routes.projectAgent(pid, "ux"));
        const out = page.getByTestId("ux-outcome");
        await pwExpect(out.locator(".metric")).toHaveText(["2Pages with problems", "1Healthy pages", "0Not checked", "1Visual notes to look at"]);
        const pages = page.getByTestId("ux-page");
        await pwExpect(pages).toHaveCount(3);
        const home = pages.nth(0);
        await pwExpect(home).toContainText("Broken links: 1 link on this page is broken (checked 12)");
        await pwExpect(home).toContainText("/old-offers returned HTTP 404");
        await pwExpect(home).toContainText("Script errors: 2 JavaScript errors were reported on this page");
        await pwExpect(home.getByTestId("ux-visual")).toContainText("Please look");
        await pwExpect(home.getByTestId("ux-visual")).toContainText("The footer covers the Add to cart button");
        await pwExpect(home.getByRole("link", { name: "Open the screenshot" })).toHaveAttribute("href", /^\/api\/artifacts\/[\w-]+$/);
        await pwExpect(pages.filter({ hasText: "/products" })).toContainText("Failed requests: 1 request to this site failed");
        await pwExpect(pages.filter({ hasText: "/products" }).getByTestId("ux-visual")).toHaveCount(0);
        const text = (await out.textContent()) ?? "";
        expect(text).not.toMatch(/\/admin|image-alt|WCAG 2\.1|WEB-\d|Passing|Failing/);
        await axe("ux outcome");
        await shot("ux", "outcome.png");
        await narrow("ux", "outcome-375.png");
    });

    it("Runs: its runs only; a stopped run opens its part, which says screen review was off", async () => {
        await tab("UX Testing Agent", "Runs").click();
        await pwExpect(page.getByTestId("agent-runs").locator("li")).toHaveCount(2);
        await page.getByRole("link", { name: "Run 2" }).click();
        await page.waitForURL(`**${routes.projectAgentRun(pid, "ux", ids.u2)}`);
        await pwExpect(page.getByTestId("ux-page")).toHaveCount(1);
        await pwExpect(page.getByTestId("ux-scope")).toContainText("AI screen review was not part of these runs");
        await axe("ux run");
        await shot("ux", "run.png");
    });

    it("Settings (an old ?tab=setup link lands here): its own defaults with the screen review, its schedules, then its inputs only", async () => {
        // The old Setup tab's address: still works, as the Settings tab.
        await visit(`#/projects/${pid}/agents/ux?tab=setup`);
        await pwExpect(tab("UX Testing Agent", "Settings")).toHaveAttribute("aria-current", "page");
        const d = page.getByTestId("agent-defaults");
        await pwExpect(d.getByTestId("explore-level")).toBeVisible();
        await pwExpect(d.getByTestId("screen-review")).toBeVisible();
        await pwExpect(d.getByTestId("size-picker")).toHaveCount(0);
        await pwExpect(page.getByTestId("agent-schedules-link")).toBeVisible();
        const setup = page.getByTestId("agent-setup");
        await pwExpect(setup).toContainText(SITE);
        await pwExpect(setup).toContainText("AI screen review");
        await pwExpect(setup).not.toContainText(/OpenAPI|Requirements|accessibility/i);
        await axe("ux setup");
        await shot("ux", "setup.png");
        await narrow("ux", "setup-375.png");
    });
});

describe("before a run", () => {
    it("its Outcome offers Run, and its Workspace card carries the headline", async () => {
        await visit(routes.projectAgent(fresh, "ux"));
        await pwExpect(page.getByTestId("ux-outcome").getByRole("link", { name: "Run the agent" })).toHaveAttribute("href", routes.newProject({ project: fresh, agent: "ux" }));
        await shot("ux", "not-run.png");
        await visit(routes.project(pid));
        await pwExpect(page.locator('.ws-card[data-agent="ux"]').getByTestId("agent-headline")).toHaveText("2 pages with problems, 1 healthy");
        await shot("ux", "workspace.png");
        expect(consoleErrors).toEqual([]);
    });
});
