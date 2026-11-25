/**
 * The Responsive UI Testing Agent's page in a real browser (Agent Workspace W2c, .scratch/agent-workspace/SPEC.md §3, CONTRACT.md):
 *
 *   - Outcome: the layout issues (a verified desktop change with its new picture and difference; a page that fails on the phone with its
 *     evidence), then the page × screen size grid with the picture kept for each cell, and why a cell was not checked; nothing of another
 *     agent;
 *   - Runs: its runs only, each opening that run's part (a stopped run's page kept);
 *   - Setup: the address, the sign-in and the screen sizes; the run form offers the three sizes, all ticked, and sends the ones kept;
 *   - axe with the colour scheme light and dark, and no sideways scroll at 375 px (the grid scrolls inside its card).
 *
 * The platform is real; the runs are seeded as the engine leaves them (visual checks with their pictures, repeats tagged with their
 * variant, findings walked along the lifecycle). The pictures are real PNGs, drawn by the test's browser. Port 7812.
 * Requires web/dist:
 *   node scripts/with-lock.mjs build -- npm run build:web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/agent-responsive-ui-ui.test.ts
 * Screenshots go to AGENT_SHOTS (default c4t-scratch/agent-ws/responsive-ui beside the repository).
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
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { executionFinding } from "../src/platform/findings/adapters.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { addVariantExecution } from "../src/platform/variants-store.js";
import { routes } from "../web/src/lib/router.js";

const PORT = 7812;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.AGENT_SHOTS ?? path.resolve(REPO_ROOT, "../../c4t-scratch/agent-ws/responsive-ui");
let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let pid = "";
const ids: Record<string, string> = {};
const consoleErrors: string[] = [];

const visual = (testId: string, at: string) =>
    TestSpecSchema.parse({ testId, title: `Page looks the same as its approved baseline (${at})`, kind: "web", type: "visual", priority: "high", steps: [{ action: "navigate", url: at }, { action: "assert", check: "screenshot", expected: 100 }], expectedResults: ["Same."] });
const failed = (error: string) => ({ testId: "x", status: "failed", durationMs: 10, failedStepIndex: 1, steps: [{ index: 1, title: "screenshot", status: "failed", error }], artifacts: [], responses: [] }) as unknown as ScriptRun;

/** A picture of a small shop page at this size, drawn by the browser (`banner`: a cookie banner over the Pay button). */
async function picture(b: Browser, width: number, height: number, title: string, opts: { banner?: boolean; diff?: boolean } = {}): Promise<Buffer> {
    const p = await (await b.newContext({ viewport: { width, height } })).newPage();
    await p.setContent(`<body style="margin:0;font:16px sans-serif;background:${opts.diff ? "#fff" : "#faf8f5"}">
        <header style="padding:16px;background:#0b7a6e;color:#fff;font-weight:600">Practice Store</header>
        <main style="padding:24px"><h1 style="margin:0 0 12px">${title}</h1><p>${"Travel mugs, notebooks and bags. ".repeat(4)}</p>
        <button style="padding:10px 16px;background:#17130f;color:#fff;border:0;border-radius:6px">Pay</button></main>
        ${opts.banner ? '<div style="position:fixed;bottom:0;left:0;right:0;padding:40px 16px;background:#3d342b;color:#fff">We use cookies. Accept?</div>' : ""}
        ${opts.diff ? '<div style="position:absolute;top:90px;left:20px;width:260px;height:40px;background:rgba(220,0,0,.6)"></div>' : ""}</body>`);
    const png = await p.screenshot();
    await p.context().close();
    return png;
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-rui-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "agent-responsive-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "true" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    browser = await chromium.launch();

    const repo = platform.repo;
    pid = repo.createProject({ name: "Responsive Store", platforms: ["web"], testingModes: ["agent"] }).id as string;
    const appId = repo.createApplication(pid, "http://127.0.0.1:7829", { ...DEFAULT_JOB_OPTIONS });
    const put = await fetch(`${BASE}/api/projects/${pid}/testing-agents`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agents: ["security", "responsive-ui"] }) });
    expect(put.status).toBe(200);
    const suite = repo.getOrCreateSuite(pid, "General", "general");
    const job = async (agentId: string, extra: Record<string, unknown> = {}) => (await repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, agentId, ...extra } as never)).id;
    ids.first = await job("responsive-ui", { visual: true, variants: ["phone-375", "tablet-768"] });
    ids.stopped = await job("responsive-ui", { visual: true });
    ids.security = await job("security");
    const add = (jobId: string, s: ReturnType<typeof visual>, status: "VALIDATED" | "NEEDS_REVIEW" | "PENDING", meta: Record<string, unknown>, reason?: string) => {
        const id = repo.insertTest({ projectId: pid, suiteId: suite, jobId, spec: s, framework: s.kind === "api" ? "playwright-api" : "playwright", validationStatus: status, meta });
        if (reason) repo.updateTest(id, { reason });
        return id;
    };
    const run = (testId: string, jobId: string, status: string) => repo.addExecution({ testId, scriptId: null, jobId, attempt: 1, status, durationMs: 900, startedAt: new Date().toISOString(), steps: [] });
    const keep = async (testId: string, executionId: string | undefined, kind: string, png: Buffer) => {
        const rel = `${pid}/_artifacts/${testId}/${kind}-${Math.random().toString(36).slice(2)}.png`;
        await platform.store.put(rel, png);
        return repo.addArtifact({ projectId: pid, jobId: ids.first, testId, ...(executionId ? { executionId } : {}), kind, path: rel, size: png.length });
    };
    const variant = (testId: string, v: string, status: "passed" | "failed" | "skipped" | "unavailable", reason?: string) =>
        addVariantExecution(repo.db, { testId, scriptId: null, jobId: ids.first, variant: v, status, ...(reason ? { reason } : {}), durationMs: 800, startedAt: new Date().toISOString(), steps: [] });
    /** A repeat on one of the agent's sizes that passed, with the picture it keeps (repo-sink.ts recordVariant). */
    const pictured = async (testId: string, v: "phone-375" | "tablet-768", title: string) => keep(testId, variant(testId, v, "passed"), "screenshot", await picture(browser, v === "phone-375" ? 375 : 768, v === "phone-375" ? 812 : 1024, title));

    const home = add(ids.first, visual("WEB-001", "/"), "VALIDATED", { visual: true });
    await keep(home, run(home, ids.first, "passed"), "screenshot", await picture(browser, 1280, 800, "Home"));
    await pictured(home, "phone-375", "Home");
    await pictured(home, "tablet-768", "Home");
    const products = add(ids.first, visual("WEB-002", "/products"), "VALIDATED", { visual: true });
    await keep(products, run(products, ids.first, "passed"), "screenshot", await picture(browser, 1280, 800, "Products"));
    await pictured(products, "phone-375", "Products");
    await pictured(products, "tablet-768", "Products");
    ids.cart = add(ids.first, visual("WEB-003", "/cart"), "NEEDS_REVIEW", { visual: true }, "The page no longer matches its approved baseline: 840 pixels differ.");
    const cartRun = run(ids.cart, ids.first, "failed");
    await keep(ids.cart, cartRun, "visual-actual", await picture(browser, 1280, 800, "Your cart (2)"));
    await keep(ids.cart, cartRun, "visual-diff", await picture(browser, 1280, 800, "Your cart (2)", { diff: true }));
    await pictured(ids.cart, "phone-375", "Your cart (2)");
    await pictured(ids.cart, "tablet-768", "Your cart (2)");
    const checkout = add(ids.first, TestSpecSchema.parse({ testId: "WEB-010", title: "A visitor checks out", kind: "web", type: "functional", priority: "high", steps: [{ action: "navigate", url: "/checkout" }, { action: "click", locator: { by: "role", role: "button", value: "Pay" } }], expectedResults: ["Paid."] }), "VALIDATED", {});
    await keep(checkout, run(checkout, ids.first, "passed"), "screenshot", await picture(browser, 1280, 800, "Checkout"));
    const phone = variant(checkout, "phone-375", "failed", "Click Pay - the button is covered by the cookie banner");
    await keep(checkout, phone, "screenshot", await picture(browser, 375, 812, "Checkout", { banner: true }));
    await pictured(checkout, "tablet-768", "Checkout");
    add(ids.stopped, visual("WEB-004", "/orders"), "PENDING", { visual: true });
    add(ids.security, TestSpecSchema.parse({ testId: "API-001", title: "Browser security headers are set (/)", kind: "api", type: "security", priority: "medium", steps: [{ action: "request", method: "GET", path: "/" }, { action: "assertResponse", check: "securityHeaders" }], expectedResults: ["Set."] }) as never, "NEEDS_REVIEW", { security: true }, "Security check failed: no CSP.");
    repo.setJobStatus(ids.first, "COMPLETED");
    repo.setJobStatus(ids.stopped, "FAILED", "Cancelled");
    repo.setJobStatus(ids.security, "COMPLETED");

    const store = new CandidateFindingStore(platform.sql);
    const s = visual("WEB-003", "/cart");
    const f = (await store.upsert({ projectId: pid, jobId: ids.first, testId: ids.cart, finding: executionFinding({ id: ids.cart, title: s.title, spec: s }, failed("840 pixels (ratio 0.01 of all image pixels) are different")) })).finding;
    await store.transition(pid, f.id, { to: "verification_pending", by: "engine" });
    const a = { outcome: "failed", failedStep: 2, check: "screenshot", error: "840 pixels are different" };
    await store.transition(pid, f.id, { to: "reproduced", by: "engine", set: { severity: "low", attempts: [a, a] } });
    // Verified means confirmed, classified or reported, as for every agent (security.ts VERIFIED_STATES).
    await store.transition(pid, f.id, { to: "confirmed", by: "person", reason: "Seen it myself." });

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

async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.getByTestId("place-head").locator("h2")).toHaveText("Responsive UI Testing Agent");
}
async function shot(name: string) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true, animations: "disabled" });
}
async function axe(what: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${what} (${scheme}): ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
}
async function at375(name: string) {
    await page.setViewportSize({ width: 375, height: 800 });
    try {
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await shot(name);
    } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
    }
}
const imagesLoaded = (scope: ReturnType<Page["getByTestId"]>) => scope.locator("img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0));

describe("the Responsive UI Testing Agent's page (W2c)", () => {
    it("Outcome: the layout issues with their evidence, then each page on each screen size with its picture; nothing else", async () => {
        await visit(routes.projectAgent(pid, "responsive-ui"));
        const issues = page.getByTestId("responsive-issue");
        await pwExpect(issues).toHaveCount(2);
        await pwExpect(issues.nth(0)).toContainText("/cart on Desktop");
        await pwExpect(issues.nth(0)).toContainText("Looks different");
        await pwExpect(issues.nth(0)).toContainText("Confirmed");
        await pwExpect(issues.nth(0).locator("img")).toHaveCount(2);
        await pwExpect(issues.nth(1)).toContainText("/checkout on Phone");
        await pwExpect(issues.nth(1)).toContainText("covered by the cookie banner");
        const grid = page.getByTestId("responsive-grid");
        expect(await grid.locator("thead th").allTextContents()).toEqual(["Page", "Phone 375 × 812", "Tablet 768 × 1024", "Desktop 1280 × 800"]);
        expect(await grid.locator("tbody th").allTextContents()).toEqual(["/", "/products", "/cart", "/orders", "/checkout"]);
        const row = (p: string) => grid.locator("tbody tr", { has: page.locator("th", { hasText: new RegExp(`^${p.replace(/\//g, "\\/")}$`) }) });
        await pwExpect(row("/").getByTestId("cell-desktop")).toContainText("Same");
        await pwExpect(row("/").getByTestId("cell-phone-375")).toContainText("Pictured");
        await pwExpect(row("/").getByTestId("cell-tablet-768")).toContainText("Pictured");
        await pwExpect(row("/cart").getByTestId("cell-desktop")).toContainText("Changed");
        await pwExpect(row("/checkout").getByTestId("cell-phone-375")).toContainText("Fails");
        await pwExpect(row("/checkout").getByTestId("cell-tablet-768")).toContainText("Works");
        await pwExpect(row("/orders").getByTestId("cell-desktop")).toContainText("Not run");
        await pwExpect(row("/orders").getByTestId("cell-phone-375")).toContainText("Not tried");
        // A full grid: a picture in every cell but the page whose run was stopped (4 pages × 3 sizes).
        await pwExpect(page.getByTestId("responsive-notes")).toHaveCount(0);
        await pwExpect.poll(() => imagesLoaded(grid)).toEqual(Array(12).fill(true));
        expect(await page.getByTestId("responsive-outcome").textContent()).not.toContain("Security");
        await axe("responsive outcome");
        await shot("outcome.png");
        await at375("outcome-375.png");
    });

    it("Runs: its runs only, each opening that run's part; a stopped run's page is kept", async () => {
        await visit(routes.projectAgent(pid, "responsive-ui", "runs"));
        await pwExpect(page.getByTestId("agent-runs").locator("li")).toHaveCount(2);
        await visit(routes.projectAgentRun(pid, "responsive-ui", ids.stopped));
        const grid = page.getByTestId("responsive-grid");
        expect(await grid.locator("thead th").allTextContents()).toEqual(["Page", "Desktop 1280 × 800"]);
        expect(await grid.locator("tbody th").allTextContents()).toEqual(["/orders"]);
        await pwExpect(grid).toContainText("1 page in this run");
        await visit(routes.projectAgentRun(pid, "responsive-ui", ids.first));
        await pwExpect(page.getByTestId("responsive-issue")).toHaveCount(2);
        await axe("responsive run");
        await shot("run.png");
        await at375("run-375.png");
    });

    it("Setup: the address, the sign-in and the screen sizes", async () => {
        await visit(routes.projectAgent(pid, "responsive-ui", "settings"));
        const s = page.getByTestId("agent-setup");
        await pwExpect(s).toContainText("http://127.0.0.1:7829");
        await pwExpect(s).toContainText("Phone (375 wide), tablet (768 wide) and desktop (1280 wide) on every run");
        await pwExpect(s.getByRole("link", { name: "Settings → Sign-in" })).toBeVisible();
        await axe("responsive setup");
        await shot("setup.png");
        await at375("setup-375.png");
    });

    it("Settings: its own defaults (level, model, sizes, no screen review); saved sizes prefill the run form, which can still change them", async () => {
        await visit(routes.projectAgent(pid, "responsive-ui", "settings"));
        const d = page.getByTestId("agent-defaults");
        await pwExpect(d.getByTestId("explore-level")).toBeVisible();
        await pwExpect(d.getByTestId("agent-model")).toBeVisible();
        await pwExpect(d.getByTestId("screen-review")).toHaveCount(0);
        await pwExpect(page.getByTestId("agent-schedules-link").getByRole("link", { name: "Schedules" })).toHaveAttribute("href", routes.agentSchedules(pid, "responsive-ui"));
        await axe("responsive settings");
        await shot("settings-agent-responsive-ui-1280.png");
        await at375("settings-agent-responsive-ui-375.png");
        await d.getByTestId("size-picker").getByRole("checkbox", { name: /Phone/ }).uncheck();
        await d.getByRole("radio", { name: /Deep/ }).check();
        await d.getByRole("button", { name: "Save" }).click();
        await pwExpect(d.locator(".callout")).toContainText("Saved.");
        let sent: any;
        await page.route("**/api/projects/*/test-generation", async (r) => {
            sent = r.request().postDataJSON();
            await r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Stopped by the test." }) });
        });
        try {
            await page.goto("about:blank");
            await page.goto(`${BASE}/${routes.newProject({ project: pid, agent: "responsive-ui" })}`);
            const picker = page.getByTestId("size-picker");
            await pwExpect(picker.getByRole("checkbox", { name: /Phone/ })).not.toBeChecked();
            await pwExpect(picker.getByRole("checkbox", { name: /Tablet/ })).toBeChecked();
            await pwExpect(page.getByTestId("agent-settings-note").getByRole("link", { name: "Settings" })).toHaveAttribute("href", routes.projectAgent(pid, "responsive-ui", "settings"));
            // The run sends the saved level and sizes (the form always sends a level, so it must be the agent's).
            await page.locator("form button[type=submit]").click();
            await pwExpect.poll(() => sent?.level).toBe("deep");
            expect(sent.variants).toEqual(["tablet-768"]);
        } finally {
            await page.unroute("**/api/projects/*/test-generation");
            // Back to none saved, for the run form test below.
            const r = await fetch(`${BASE}/api/projects/${pid}/workspace/responsive-ui/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
            expect(r.status).toBe(200);
        }
    });

    it("the run form offers the three sizes, all ticked, desktop always; the run sends the ones kept", async () => {
        let sent: any;
        await page.route("**/api/projects/*/test-generation", async (r) => {
            sent = r.request().postDataJSON();
            await r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Stopped by the test." }) });
        });
        try {
            await page.goto("about:blank");
            await page.goto(`${BASE}/${routes.newProject({ project: pid, agent: "responsive-ui" })}`);
            const picker = page.getByTestId("size-picker");
            await pwExpect(picker.getByRole("checkbox")).toHaveCount(3);
            for (const name of ["Phone, 375 wide", "Tablet, 768 wide", "Desktop, 1280 wide"]) await pwExpect(picker.getByRole("checkbox", { name: new RegExp(name) })).toBeChecked();
            await pwExpect(picker.getByRole("checkbox", { name: /Desktop/ })).toBeDisabled();
            await axe("run form with sizes");
            await shot("run-form.png");
            await picker.getByRole("checkbox", { name: /Tablet/ }).uncheck();
            await page.locator("form button[type=submit]").click();
            await pwExpect.poll(() => sent?.variants).toEqual(["phone-375"]);
            expect(sent.agentId).toBe("responsive-ui");
        } finally {
            await page.unroute("**/api/projects/*/test-generation");
        }
        expect(consoleErrors.filter((e) => !/Stopped by the test/.test(e))).toEqual([]);
    });
});
