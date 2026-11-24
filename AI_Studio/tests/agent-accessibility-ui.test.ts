/**
 * The Accessibility Testing Agent's page in a real browser (Agent Workspace W2b, .scratch/agent-workspace/SPEC.md §3):
 * - Outcome: the counts of pages with issues, clean and not checked; the rules broken, worst first; each page with its issues by rule and
 *   severity and the run it is from. No health checks, no other agent's run, no test scripts.
 * - Runs: the agent's runs only (the default list); a run opens that run's part only, a stopped run's too.
 * - Setup: the agent's inputs only, with where each is kept.
 * - A project not run yet offers Run; the Workspace card carries the headline; axe passes in light and dark; nothing scrolls sideways at 375 px.
 *
 * Runs are seeded as a check agent's run leaves them (its checks as tests with their results and reasons), so no AI and no exploring
 * browser are needed. Port 7743. Requires web/dist:
 *   node scripts/with-lock.mjs build -- npm run build:web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/agent-accessibility-ui.test.ts
 * Set W2B_SHOTS=<folder> to write screenshots to <folder>/accessibility/.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { formatA11yAllRules, formatA11yViolations } from "../src/engine/a11y/audit.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { executionFinding } from "../src/platform/findings/adapters.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS, type JobOptions, type JobStatus, type ValidationState } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { routes } from "../web/src/lib/router.js";

const PORT = 7743;
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
const audit = (...rules: Array<[string, "critical" | "serious", string, number]>) =>
    formatA11yViolations(rules.map(([id, impact, help, nodes]) => ({ id, impact, help, nodes: Array.from({ length: nodes }, (_, i) => ({ target: [`main > img:nth-child(${i + 1})`] })) })), "serious")!;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-accessibility-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    pid = await project("Checks Store", ["accessibility", "ux", "security"]);
    ids.a1 = await run("accessibility", "COMPLETED");
    check(ids.a1, "accessibility", "/", "NEEDS_REVIEW", audit(["image-alt", "critical", "Images must have alternate text", 3], ["color-contrast", "serious", "Elements must meet minimum color contrast ratio thresholds", 5]));
    check(ids.a1, "accessibility", "/about", "VALIDATED");
    check(ids.a1, "accessibility", "/cart", "FAILED_VALIDATION", "Could not open /cart: net::ERR_CONNECTION_REFUSED");
    // Passed the "serious" threshold, with every rule kept: a moderate and a minor issue.
    const lvl = (id: string, impact: string) => ({ id, impact, help: `Help for ${id}`, nodes: [{ target: ["html"] }] });
    // And one item axe could not decide (W3): for a person's check, never an issue.
    check(ids.a1, "accessibility", "/levels", "VALIDATED", formatA11yAllRules([lvl("html-xml-lang-mismatch", "moderate"), lvl("server-side-image-map", "minor")], [lvl("frame-tested", "critical")])!.join("\n"));
    // A person said not a bug.
    const promo = check(ids.a1, "accessibility", "/promo", "NEEDS_REVIEW", audit(["color-contrast", "serious", "Elements must meet minimum color contrast ratio thresholds", 2]));
    const t = platform.repo.getTest(promo)!;
    const store = new CandidateFindingStore(platform.sql);
    const fake = { status: "failed", failedStepIndex: 1, steps: [{ index: 1, title: "2", status: "failed", error: "failed" }], responses: [], error: "failed" } as unknown as ScriptRun;
    const { finding } = await store.upsert({ projectId: pid, jobId: ids.a1, testId: promo, finding: executionFinding({ id: t.id, title: t.title, spec: t.spec }, fake) });
    await store.transition(pid, finding.id, { to: "not_a_bug", by: "person", actor: { label: "Asha" }, reason: "The banner is decorative." });
    ids.a2 = await run("accessibility", "FAILED", "Cancelled");
    check(ids.a2, "accessibility", "/products/travel-mug-with-a-very-long-name-that-wraps", "NEEDS_REVIEW", audit(["label", "serious", "Form elements must have labels", 1]));
    // Another agent's run, with an audit and a health check in it: on neither page.
    ids.sec = await run("security", "COMPLETED");
    check(ids.sec, "accessibility", "/admin", "NEEDS_REVIEW", audit(["label", "critical", "Form elements must have labels", 2]));
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

describe("the Accessibility Testing Agent's page", () => {
    it("Outcome: the issues on each page by rule and severity, and the pages clean and with issues; nothing of another agent", async () => {
        await visit(routes.projectAgent(pid, "accessibility"));
        const out = page.getByTestId("accessibility-outcome");
        await pwExpect(out.locator(".metric")).toHaveText(["3Pages with issues", "1Clean pages", "1Not checked", "5Rules broken", "1Needs a person’s check"]);
        await pwExpect(page.getByTestId("a11y-rules").locator("li")).toHaveText([/Critical\s*image-alt\s*Images must have alternate text\s*1 page · 3 elements/, /Serious\s*color-contrast\s*.*1 page · 5 elements/, /Serious\s*label/, /Moderate\s*html-xml-lang-mismatch/, /Minor\s*server-side-image-map/]);
        const pages = page.getByTestId("a11y-page");
        await pwExpect(pages).toHaveCount(6);
        await pwExpect(pages.filter({ hasText: "/levels" })).toContainText("html-xml-lang-mismatch: Help for html-xml-lang-mismatch. 1 element: html");
        const review = pages.filter({ hasText: "/levels" }).getByTestId("a11y-review");
        await pwExpect(review).toContainText("Needs a person’s check: axe could not decide these by itself. They are not counted as issues.");
        await pwExpect(review).toContainText("frame-tested: Help for frame-tested. 1 element: html");
        await pwExpect(page.getByTestId("a11y-rules")).not.toContainText("frame-tested");
        const promo = pages.filter({ hasText: "/promo" });
        await pwExpect(promo.locator(".badge").first()).toHaveText("Not a bug");
        await pwExpect(promo).toContainText("A person marked this not a bug: The banner is decorative.");
        await pwExpect(page.getByTestId("a11y-scope")).toContainText("a finding needs no replay to verify it");
        await pwExpect(page.getByTestId("a11y-scope")).toContainText("1 page a person marked not a bug is listed below and left out of these counts.");
        await pwExpect(pages.nth(0)).toContainText("/");
        await pwExpect(pages.nth(0)).toContainText("image-alt: Images must have alternate text. 3 elements: main > img:nth-child(1)");
        await pwExpect(pages.nth(0).getByRole("link", { name: "Run 1" })).toHaveAttribute("href", routes.projectAgentRun(pid, "accessibility", ids.a1));
        await pwExpect(pages.filter({ hasText: "/cart" })).toContainText("Could not be checked: Could not open /cart");
        await pwExpect(pages.filter({ hasText: "/about" }).locator(".badge")).toHaveText("Clean");
        const text = (await out.textContent()) ?? "";
        expect(text).not.toMatch(/\/admin|Broken links|Script errors|WEB-\d|Passing|Failing/);
        await axe("accessibility outcome");
        await shot("accessibility", "outcome.png");
        await narrow("accessibility", "outcome-375.png");
    });

    it("Runs: its runs only; a run opens that run's part, a stopped run's too", async () => {
        await tab("Accessibility Testing Agent", "Runs").click();
        await pwExpect(page.getByTestId("agent-runs").locator("li")).toHaveCount(2);
        await page.getByRole("link", { name: "Run 2" }).click();
        await page.waitForURL(`**${routes.projectAgentRun(pid, "accessibility", ids.a2)}`);
        const out = page.getByTestId("accessibility-outcome");
        await pwExpect(out.locator("h3").first()).toHaveText("Run 2");
        await pwExpect(page.getByTestId("a11y-page")).toHaveCount(1);
        await pwExpect(page.getByTestId("a11y-page")).toContainText("label: Form elements must have labels");
        await axe("accessibility run");
        await shot("accessibility", "run.png");
        await narrow("accessibility", "run-375.png");
    });

    it("Setup: its inputs only, with where each is kept", async () => {
        await visit(routes.projectAgent(pid, "accessibility", "setup"));
        const setup = page.getByTestId("agent-setup");
        await pwExpect(setup).toContainText(SITE);
        await pwExpect(setup.getByRole("link", { name: "Settings → General" })).toHaveAttribute("href", routes.projectSettings(pid, "general"));
        await pwExpect(setup.getByRole("link", { name: "Settings → AI keys" })).toBeVisible();
        await pwExpect(setup).not.toContainText(/OpenAPI|Requirements|screen review/);
        await axe("accessibility setup");
        await shot("accessibility", "setup.png");
    });
});

describe("before a run", () => {
    it("its Outcome offers Run, and its Workspace card carries the headline", async () => {
        await visit(routes.projectAgent(fresh, "accessibility"));
        await pwExpect(page.getByTestId("accessibility-outcome").getByRole("link", { name: "Run the agent" })).toHaveAttribute("href", routes.newProject({ project: fresh, agent: "accessibility" }));
        await shot("accessibility", "not-run.png");
        await visit(routes.project(pid));
        await pwExpect(page.locator('.ws-card[data-agent="accessibility"]').getByTestId("agent-headline")).toHaveText("3 pages with issues, 1 clean, 1 not checked, 1 dismissed");
        await shot("accessibility", "workspace.png");
        expect(consoleErrors).toEqual([]);
    });
});
