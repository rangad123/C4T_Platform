/**
 * The Runs place of a Test Case Generation project in a real browser against a real platform (founder 2026-11-19 P2, P3.1, P5.3, P7.2,
 * R10.3, Q4, O6, O7; PLAN.md U5, FX8, FX9). The runs are seeded straight into the platform (their pages and test cases as the events a
 * run records), so no model, no site and no worker are needed; the finished-run hook (case-outcome.ts noteCaseRunFinished) writes each
 * run's last word as it does after a real run.
 *
 *   - the hub has only All runs and Schedules; no Run button, no run strip, no "See each test"; each row says what that run added, and a
 *     stopped one that what it found is kept;
 *   - a run's page says "Added N pages and M test cases" and shows that run's part of the tree with its test cases, and none of the old
 *     run page (What ran, On the runner, Tests created, Run these tests, the explorer's site map, the Progress list of pages);
 *   - a running run shows the stages Exploring, Understanding and Writing test cases, on its page and on the Dashboard; when it ends, its
 *     last word "Test cases written: N (M new)" shows without a reload (FX9);
 *   - a run that ended with a problem says "Test cases written, with a problem", not "Ready, some tests need a look" (FX8);
 *   - a mixed project keeps every old part of the Runs place and the run page;
 *   - axe in light and dark, screenshots at 1280 and 390 px.
 *
 * Requires web/dist (build inside the lock):
 *   node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/case-agent-run-ui.test.ts"
 * Screenshots: /home/aadhaar/projects/c4t-scratch/f1119-shots/u5 (or $U5_SHOTS). Port: platform 9087.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { noteCaseRunFinished } from "../src/platform/case-outcome.js";
import { DEFAULT_JOB_OPTIONS, type JobStatus } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 9087;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.U5_SHOTS ?? "/home/aadhaar/projects/c4t-scratch/f1119-shots/u5";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];
let tcg = "";
let mixed = "";
const runs: Record<"first" | "stopped" | "partial" | "running", string> = { first: "", stopped: "", partial: "", running: "" };
let mixedRun = "";

const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text && /^[{[]/.test(text) ? JSON.parse(text) : text } as { status: number; body: any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** No modes: the server's default, a mixed project (project-setup.ts). */
async function project(name: string, modes?: string[], agents?: string[]): Promise<{ id: string; app: string }> {
    const made = await api("POST", "/api/projects", { name, ...(modes ? { platforms: ["web"], testingModes: modes } : {}), ...(agents ? { agents } : {}) });
    if (made.status !== 201) throw new Error(JSON.stringify(made.body));
    return { id: made.body.id, app: platform.repo.createApplication(made.body.id, "http://shop.test/", { ...DEFAULT_JOB_OPTIONS }) };
}

/** A run that visited `pages` and announced `cases` (as the crawler and the planner record them), left at `status`. */
async function seedRun(p: { id: string; app: string }, pages: string[], cases: string[], status: JobStatus, error?: string, planOnly = true): Promise<string> {
    const job = await platform.repo.createJob(p.id, p.app, { ...DEFAULT_JOB_OPTIONS, mode: "generate", ...(planOnly ? { planOnly: true } : {}) });
    for (const path of pages) platform.repo.addEvent(job.id, { stage: "discovery", kind: "page_visited", message: `Visited ${path}`, data: { url: `http://shop.test${path}` } });
    cases.forEach((title, i) => platform.repo.addEvent(job.id, { stage: "planning", kind: "scenario_planned", message: `S-${String(i + 1).padStart(3, "0")} [Browsing/high] ${title}`, data: { title } }));
    platform.repo.setPhase(job.id, "discovery", "done");
    platform.repo.updateCounters(job.id, { pagesDiscovered: pages.length });
    platform.repo.setJobStatus(job.id, status, error);
    if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(status)) await noteCaseRunFinished(platform, platform.repo.getJob(job.id)!);
    await sleep(5); // a later created_at for the next run
    return job.id;
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-u5-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "u5-secret-key-0123456789abcdef", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" } as never));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    const t = await project("Shop test cases", ["agent"], ["test-generation"]);
    tcg = t.id;
    // An old run of tests from before (not part of the tree): counted in one line, not listed.
    await seedRun(t, [], [], "COMPLETED", undefined, false);
    runs.first = await seedRun(t, ["/", "/products", "/about"], ["Open the home page", "Browse the products", "Read about the shop"], "COMPLETED");
    runs.stopped = await seedRun(t, ["/products", "/products/1", "/cart"], ["Browse the products", "Open a product"], "FAILED", "Cancelled");
    runs.partial = await seedRun(t, ["/", "/login"], ["Sign in with the demo account"], "PARTIALLY_COMPLETED", "API discovery failed: the address did not answer");
    runs.running = await seedRun(t, ["/", "/search"], [], "DISCOVERING");
    platform.repo.setPhase(runs.running, "discovery", "running");

    const m = await project("Mixed shop");
    mixed = m.id;
    mixedRun = await seedRun(m, ["/", "/products"], ["Browse the products"], "PARTIALLY_COMPLETED", undefined, false);

    fs.mkdirSync(SHOTS, { recursive: true });
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (msg) => msg.type() === "error" && !/Failed to load resource|fonts\.(googleapis|gstatic)/.test(msg.text()) && consoleErrors.push(msg.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const visit = async (hash: string) => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
};
const main = () => page.locator("main");
const mainText = async () => (await main().textContent()) ?? "";
async function shot(name: string) {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true, animations: "disabled" });
}
async function axe(where: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(r.violations.map((v) => `${where} ${scheme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
}
/** Words the old run screens used that a Test Case Generation project must not show (P2, P3.1, P5, O7). */
const OLD_RUN_WORDS = ["Create the tests", "Discard the plan", "Edit the plan", "Here is what we will do", "Kinds of test", "Failing", "Not passing", "Not run", "View technical details", "What ran", "On the runner", "On this server", "Tests created", "Run these tests", "See each test", "What the explorer knows", "Site map", "What we found", "Screens found", "Show all", "Passing", "passed", "No test produced a result", "test idea", "Plan ready", "Exploration, plan only", "need a look"];

describe("the Runs place of a Test Case Generation project", () => {
    it("has only All runs and Schedules, no Run button, and rows that say what each run added (P7.2, O6, R10.3, Q4, FX8)", async () => {
        await visit(`#/projects/${tcg}/runs`);
        const list = page.getByTestId("case-runs");
        await list.locator("[data-run]").first().waitFor();
        const sections = page.getByRole("navigation", { name: /runs/i }).getByRole("link");
        expect(await sections.allTextContents()).toEqual(["All runs", "Schedules"]);
        const text = await mainText();
        for (const gone of ["After a deploy", "Trends", "Releases", "Compliance", "signing off a release"]) expect(text).not.toContain(gone);
        expect(await main().getByRole("button", { name: /^Run\b/ }).count()).toBe(0);
        expect(await page.getByTestId("run-strip").count()).toBe(0);
        for (const w of OLD_RUN_WORDS) expect(text, w).not.toContain(w);

        // Newest first, numbered from the first; the old run of tests is not a row.
        expect(await list.locator("[data-run] h2").allTextContents()).toEqual(["Run 4", "Run 3", "Run 2", "Run 1"]);
        const row = (id: string) => list.locator(`[data-run="${id}"]`);
        expect(await row(runs.first).getByTestId("case-run-line").textContent()).toBe("Added 3 pages and 3 test cases.");
        expect(await row(runs.stopped).getByTestId("case-run-line").textContent()).toBe("Stopped. What it found is kept: it added 2 pages and 1 test case.");
        expect(await row(runs.stopped).textContent()).toContain("Stopped");
        expect(await row(runs.partial).textContent()).toContain("Test cases written, with a problem");
        expect(await row(runs.first).textContent()).toContain("Test cases written");
        expect(await row(runs.running).textContent()).toContain("Exploring");
        expect(await page.getByTestId("case-runs-others").textContent()).toBe("1 earlier run is not part of the tree, so it is not listed.");
        expect(await row(runs.first).getByRole("link", { name: "See what it found" }).getAttribute("href")).toBe(`#/projects/${tcg}/runs/${runs.first}`);
        await shot("runs.png");
        await axe("runs");
        await page.setViewportSize({ width: 390, height: 844 });
        await shot("runs-phone.png");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 60_000);

    it("a run's page says what it added and shows its part of the tree with its test cases, and nothing of the old run page (P3.1, R10.3)", async () => {
        await visit(`#/projects/${tcg}/runs/${runs.first}`);
        await page.getByTestId("case-outcome").waitFor();
        expect(await page.locator("h1").allTextContents()).toContain("Run 1");
        expect(await page.getByTestId("case-run-summary").textContent()).toBe("Added 3 pages and 3 test cases.");
        await expect.poll(() => page.getByTestId("case-run-last-word").textContent()).toBe("Test cases written: 3 (3 new)");
        const outcome = page.getByTestId("case-outcome");
        expect(await outcome.getByRole("heading", { level: 2 }).first().textContent()).toBe("What this run found");
        // One list of pages: the run's part of the tree (/ with /products and /about under it).
        expect(await page.getByRole("tree").count()).toBe(1);
        expect(await page.getByRole("treeitem").count()).toBe(3);
        expect(await outcome.locator(".oc-case").count()).toBe(3);
        expect(await outcome.getByTestId("outcome-download").count()).toBe(0);
        const text = await mainText();
        for (const w of OLD_RUN_WORDS) expect(text, w).not.toContain(w);
        expect(await page.getByTestId("run-explore-tree").count()).toBe(0);
        // Only the status line, what the run added and its part of the tree (lead, owner rule 2026-11-20).
        expect(await page.getByRole("button", { name: /Create the tests|Discard|Edit the plan|Run/ }).count()).toBe(0);
        await shot("run-detail.png");
        await axe("run detail");
        await page.setViewportSize({ width: 390, height: 844 });
        await shot("run-detail-phone.png");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 60_000);

    it("a stopped run shows what it kept: its own pages and test cases, with the numbers of the whole outcome (Q4, R10.3)", async () => {
        await visit(`#/projects/${tcg}/runs/${runs.stopped}`);
        await page.getByTestId("case-outcome").waitFor();
        expect(await page.locator("h1").allTextContents()).toContain("Run 2");
        expect(await page.getByTestId("case-run-summary").textContent()).toBe("Stopped. What it found is kept: it added 2 pages and 1 test case.");
        await expect.poll(() => page.getByTestId("case-run-last-word").textContent()).toBe("Test cases written: 2 (1 new)");
        expect(await page.getByRole("treeitem").count()).toBe(3);
        // "Browse the products" keeps the number run 1 gave it.
        const ids = await page.getByTestId("case-outcome").locator(".oc-case .oc-id").allTextContents();
        expect(ids.sort()).toEqual(["TC-002", "TC-004"]);
        const text = await mainText();
        for (const w of OLD_RUN_WORDS) expect(text, w).not.toContain(w);
        // The report adds no "the last run was stopped" note of its own: the status is said once, above.
        expect(await page.getByTestId("outcome-run-note").count()).toBe(0);
        await shot("run-stopped.png");
    }, 60_000);

    it("a run that ended with a problem is said in its own words, with the reason (FX8)", async () => {
        await visit(`#/projects/${tcg}/runs/${runs.partial}`);
        await page.getByTestId("case-outcome").waitFor();
        const text = await mainText();
        expect(text).toContain("Test cases written, with a problem");
        expect(text).toContain("the address did not answer");
        expect(text).not.toContain("Ready, some tests need a look");
    }, 60_000);

    it("a running run shows its three stages, and its last word appears when it ends, without a reload (P5.3, FX9)", async () => {
        await visit(`#/projects/${tcg}/runs/${runs.running}`);
        await page.getByTestId("case-run-stages").waitFor();
        expect(await page.getByTestId("case-run-stages").locator(".name").allTextContents()).toEqual(["Exploring", "Understanding", "Writing test cases"]);
        const text = await mainText();
        for (const w of OLD_RUN_WORDS) expect(text, w).not.toContain(w);
        expect(await page.getByRole("button", { name: "Stop exploring" }).count()).toBe(1);
        await shot("run-progress.png");

        // The Dashboard's live view of the same run names the same stages, and has no list of pages or test ideas of its own.
        await visit(`#/projects/${tcg}`);
        await page.getByTestId("case-run-stages").waitFor();
        expect(await page.getByTestId("case-run-stages").locator(".name").allTextContents()).toEqual(["Exploring", "Understanding", "Writing test cases"]);
        await shot("dashboard-progress.png");

        // Back on the run's page, the run ends; its last word is written a moment after the final status, as the worker's hook does.
        await visit(`#/projects/${tcg}/runs/${runs.running}`);
        await page.getByTestId("case-run-stages").waitFor();
        const navigations: string[] = [];
        page.on("framenavigated", (f) => f === page.mainFrame() && navigations.push(f.url()));
        platform.repo.addEvent(runs.running, { stage: "planning", kind: "scenario_planned", message: "S-001 [Browsing/high] Search for a product", data: { title: "Search for a product" } });
        platform.repo.setPhase(runs.running, "discovery", "done");
        platform.repo.setJobStatus(runs.running, "COMPLETED");
        await sleep(1500);
        await noteCaseRunFinished(platform, platform.repo.getJob(runs.running)!);
        await expect.poll(() => page.getByTestId("case-run-last-word").textContent(), { timeout: 20_000 }).toBe("Test cases written: 1 (1 new)");
        await expect.poll(() => page.getByTestId("case-run-summary").textContent(), { timeout: 10_000 }).toBe("Added 1 page and 1 test case.");
        expect(await page.getByTestId("case-run-stages").count()).toBe(0);
        expect(navigations).toEqual([]);
    }, 90_000);
});

describe("a mixed project keeps its Runs place and run page", () => {
    it("has every section, the Run button, See each test and the old run page", async () => {
        await visit(`#/projects/${mixed}/runs`);
        await page.locator("[data-run]").first().waitFor();
        expect(await page.getByRole("navigation", { name: /runs/i }).getByRole("link").allTextContents()).toEqual(["All runs", "Schedules", "After a deploy", "Trends", "Releases", "Compliance"]);
        expect(await main().getByRole("button", { name: /^Run\b/ }).count()).toBeGreaterThan(0);
        expect(await page.getByRole("link", { name: "See each test" }).count()).toBe(1);
        expect(await page.locator("[data-run] h2").first().textContent()).toBe("Exploration");
        expect(await page.locator("[data-run]").first().textContent()).toContain("Ready, some tests need a look");
        expect(await page.getByTestId("case-runs").count()).toBe(0);
        await shot("mixed-runs.png");

        await visit(`#/projects/${mixed}/runs/${mixedRun}`);
        await page.getByText("What ran").waitFor();
        const text = await mainText();
        for (const kept of ["What ran", "Where", "Tests created", "The AI explored the app and created"]) expect(text, kept).toContain(kept);
        expect(await page.getByTestId("case-run").count()).toBe(0);
        expect(await page.getByTestId("case-outcome").count()).toBe(0);
    }, 60_000);

    it("logged no errors in the browser", () => {
        expect(consoleErrors).toEqual([]);
    });
});
