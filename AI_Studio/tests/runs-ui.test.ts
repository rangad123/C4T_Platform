/**
 * UX-A run control in a real browser against a real platform and worker: the Run panel (what, where, how, and one sentence of what
 * will happen), the run strip with a live list, an honest Stop, the Run page, choosing tests in the list, the production confirmation,
 * the test page, the keyboard path, phone width and axe in both colour schemes. Real API tests run (Playwright test runner) against a
 * local fixture; only the list of runners is stood in for with a browser route (no runner agent is started here).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runs-ui.test.ts
 * Screenshots go to .scratch/ux-a/shots (light and dark, 1280 and 390).
 * Ports: platform 6411, fixture app 6412.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { planSentence, ranSentence, runCountsLine, runningLine, stopQuestion, stoppedLine } from "../web/src/features/runs/run-text.js";

const PORT = 6411;
const APP_PORT = 6412;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const SHOTS = path.join(REPO_ROOT, ".scratch", "ux-a", "shots");

// ── the words and numbers, without a browser ────────────────────────────────

describe("the sentences of run control", () => {
    it("say what a run will do from facts, and nothing more", () => {
        expect(planSentence({ count: 7, runner: "Maya's laptop", variants: [], retry: false })).toBe("Runs 7 tests on Maya's laptop. Results replace the last results of these tests.");
        expect(planSentence({ count: 1, runner: null, variants: [], retry: false })).toBe("Runs 1 test on this server. Results replace the last results of these tests.");
        expect(planSentence({ count: 0, runner: null, variants: [], retry: false })).toBe("Choose at least one test to run.");
        expect(planSentence({ count: 3, runner: null, environment: "staging", variants: ["Firefox"], retry: true })).toBe("Runs 3 tests on this server against staging. The results are kept for staging; the tests’ own results do not change.");
        expect(planSentence({ count: 3, runner: null, variants: ["Firefox", "Phone"], retry: true })).toContain("Tests that pass are also checked on Firefox and Phone. A failing test runs once more straight away.");
        // No time estimate is ever promised: the platform has no real total to give.
        expect(planSentence({ count: 300, runner: null, variants: [], retry: false })).not.toMatch(/second|minute|about/i);
    });

    it("state every count with what it is out of", () => {
        expect(ranSentence({ ran: 17, passed: 17, failed: 0, findings: 0, notRun: 6 })).toBe("17 of 17 that ran passed, 6 not run.");
        expect(ranSentence({ ran: 5, passed: 3, failed: 1, findings: 1, notRun: 0 })).toBe("3 of 5 that ran passed, 1 failing, 1 needs a look.");
        expect(ranSentence({ ran: 0, passed: 0, failed: 0, findings: 0, notRun: 0 })).toBe("No test produced a result.");
        expect(stoppedLine({ ran: 3, planned: 7 })).toBe("Stopped: 3 of 7 ran");
        expect(runningLine("validate", { planned: 7, ran: 3, passed: 2, failed: 1, findings: 0, running: 4, waiting: 0, notRun: 0 }, false)).toBe("Running 7 tests");
        expect(runCountsLine({ mode: "validate", environment: null, counters: { testsGenerated: 23, testsValidated: 17, testsFailedValidation: 0, testsNeedingReview: 0 } as never })).toBe("17 of 17 that ran passed, 6 not run.");
    });

    it("promise only what the platform proved when a run is stopped", () => {
        const some = { planned: 7, ran: 3, passed: 3, failed: 0, findings: 0, running: 4, waiting: 0, notRun: 0 };
        expect(stopQuestion("validate", some)).toEqual({ title: "Stop this run?", body: "3 results are kept. Tests that did not finish keep their previous result." });
        expect(stopQuestion("validate", { ...some, ran: 1 }).body).toBe("1 result is kept. Tests that did not finish keep their previous result.");
        expect(stopQuestion("validate", { ...some, ran: 0 }).body).toBe("No results have been recorded yet. Tests that did not finish keep their previous result.");
        // The platform could not say how many finished: nothing is said about them.
        expect(stopQuestion("validate", undefined).body).toBe("Tests that did not finish keep their previous result.");
        expect(stopQuestion("generate", { ...some, planned: 12 })).toEqual({ title: "Stop exploring?", body: "The 12 tests created so far are kept. Tests that were not run yet show as Not run yet." });
    });
});

// ── the real platform ────────────────────────────────────────────────────────

let dataDir: string;
let platform: Platform;
let svc: ScheduleServices;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let fixture: http.Server;
let browser: Browser;
let context: BrowserContext;
let page: Page;
/** easy: answers as the tests expect. changed: Fast one breaks and Missing six works. slow: every answer takes 3 s. hang: slow tests hang, fast ones now fail. */
let mode: "easy" | "changed" | "slow" | "hang" = "easy";
let slowHits = 0;
let projectId = "";
const idOf: Record<string, string> = {};
const consoleErrors: string[] = [];
const runner = { runOn: "platform" as "platform" | "agent", agentId: null as string | null, puts: [] as unknown[] };

const spec = (title: string, p: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: p }, { action: "assertResponse", check: "status", expected: 200 }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text && /^[{[]/.test(text) ? JSON.parse(text) : text } as { status: number; body: any };
};
async function jobDone(jobId: string, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const job = (await api("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        if (Date.now() > until) throw new Error(`job ${jobId} did not finish`);
        await sleep(200);
    }
}
const snapshot = async (id: string) => {
    const t = (await api("GET", `/api/tests/${id}`)).body;
    return { status: t.validationStatus as string, reason: t.validationReason as string | null, executions: (t.executions as unknown[]).length };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runs-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), CONCURRENCY: "1" }));
    svc = getScheduleServices(platform);
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();
    fixture = http.createServer((req, res) => {
        const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
        const url = req.url ?? "";
        if (url === "/api/broken") return json(500, { error: "boom" });
        const later = (status: number, ms: number) => {
            const timer = setTimeout(() => json(status, { ok: true }), ms);
            res.on("close", () => clearTimeout(timer));
        };
        if (url === "/api/missing") return mode === "changed" ? json(200, { ok: true }) : mode === "slow" ? later(404, 3000) : json(404, { error: "gone" });
        if (mode === "changed" && url.startsWith("/api/fast1")) return json(404, { error: "changed" });
        if (mode === "slow") return later(200, 3000);
        if (mode === "hang" && url.startsWith("/api/fast")) return json(404, { error: "changed" });
        if (mode === "hang" && url.startsWith("/api/slow")) {
            slowHits++;
            return later(200, 45_000);
        }
        json(200, { ok: true });
    });
    await new Promise<void>((r) => fixture.listen(APP_PORT, "127.0.0.1", r));

    projectId = (await api("POST", "/api/projects", { name: "Run control shop" })).body.id;
    const titles: Array<[string, string]> = [["Fast one", "/api/fast1"], ["Fast two", "/api/fast2"], ["Slow three", "/api/slow3"], ["Slow four", "/api/slow4"], ["Broken five", "/api/broken"], ["Missing six", "/api/missing"]];
    const imp = await api("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, specs: titles.map(([t, p]) => spec(t, p)) });
    if (imp.status !== 202) throw new Error(JSON.stringify(imp.body));
    await jobDone(imp.body.jobId);
    for (const t of (await api("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string }>) idOf[t.title] = t.id;

    fs.mkdirSync(SHOTS, { recursive: true });
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    // The runner agents are stood in for here (a real one is covered by the agent tests): two runners, one online.
    await page.route("**/api/projects/*/agents", (route) =>
        route.fulfill({
            json: [
                { id: "ag-1", name: "Maya's laptop", online: true, version: "1", os: "darwin", capabilities: { browsers: ["chromium"] } },
                { id: "ag-2", name: "Old desktop", online: false, version: "1", os: "win32", capabilities: { browsers: ["chromium"] } },
            ],
        }),
    );
    await page.route("**/api/projects/*/runner", async (route) => {
        if (route.request().method() === "PUT") {
            const body = route.request().postDataJSON() as { runOn: "platform" | "agent"; agentId?: string | null };
            runner.puts.push(body);
            runner.runOn = body.runOn;
            runner.agentId = body.agentId ?? null;
        }
        await route.fulfill({ json: { runOn: runner.runOn, agentId: runner.agentId, status: runner.runOn === "agent" ? "Runs on Maya's laptop (online)." : "Runs on this server.", canRunWeb: true, canRunMobile: false, unavailableReason: null } });
    });
}, 180_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await svc?.flush();
    await server?.close();
    fixture?.closeAllConnections?.();
    fixture?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const visit = async (hash: string) => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
};
const testsPage = () => visit(`#/projects/${projectId}/scripts`);
const strip = () => page.getByTestId("run-strip");
const panel = () => page.getByRole("group", { name: "Run settings" });
async function shot(name: string) {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}
async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
/** Audit in both colour schemes after the 400 ms settle; `setup` brings the page back to the state to audit. */
async function axeBoth(name: string, setup: () => Promise<void>) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        await setup();
        await shot(`${name}-${scheme}-1280`);
        await axe();
    }
    await page.emulateMedia({ colorScheme: null });
    await page.waitForTimeout(400);
}
async function noSidewaysScroll() {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
}
async function tallEnough(locator: ReturnType<Page["locator"]>, what: string) {
    const box = await locator.boundingBox();
    expect(box?.height ?? 0, `${what} is at least 44 px tall`).toBeGreaterThanOrEqual(43.5);
}

describe("the Run panel", () => {
    it("opens from the Tests header with counted choices and says in one sentence what will happen", async () => {
        await testsPage();
        const run = page.getByRole("button", { name: "Run", exact: true });
        await pwExpect(run).toBeVisible();
        await pwExpect(run).toHaveAttribute("aria-expanded", "false");
        await run.click();
        await pwExpect(run).toHaveAttribute("aria-expanded", "true");
        await pwExpect(panel()).toBeVisible();

        // Failing now (1: Missing six; the finding is not "failing") is the default; every choice carries its count.
        await pwExpect(panel().getByRole("radio", { name: "Failing now (1)" })).toBeChecked();
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText("Runs 1 test on this server. Results replace the last results of these tests.");
        await panel().getByRole("radio", { name: "All tests (6)" }).check();
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText("Runs 6 tests on this server. Results replace the last results of these tests.");
        // A choice with no tests is there but cannot be picked, and says why.
        await pwExpect(panel().getByRole("radio", { name: "Not run yet (0)" })).toBeDisabled();
        await pwExpect(panel().getByRole("radio", { name: "Selected tests (0)" })).toBeDisabled();
        await pwExpect(panel().getByText("Choose Select scripts in the list")).toBeVisible();
        await panel().getByRole("radio", { name: /^This group/ }).check();
        await panel().getByLabel("Group", { exact: true }).selectOption({ label: "API (6)" });
        await pwExpect(panel().getByTestId("run-sentence")).toContainText("Runs 6 tests");

        // How: one disclosure; what it adds is said in the sentence, never a time.
        await panel().getByText("How", { exact: true }).click();
        await panel().getByRole("checkbox", { name: /Run failing tests once more straight away/ }).check();
        await pwExpect(panel().getByTestId("run-sentence")).toContainText("A failing test runs once more straight away.");
        await shot("panel-light-1280");
    }, 120_000);

    it("closes with Escape and gives the focus back to the button; the panel is a labelled group, not a menu", async () => {
        await page.keyboard.press("Escape");
        await pwExpect(panel()).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Run", exact: true })).toBeFocused();
        // Keyboard only: Enter opens it and the first choice that can be picked has the focus.
        await page.keyboard.press("Enter");
        await pwExpect(panel()).toBeVisible();
        await pwExpect(panel().getByRole("radio", { name: /Failing now/ })).toBeFocused();
        await page.keyboard.press("Escape");
    });

    it("is audited in both colour schemes and fits a phone", async () => {
        await axeBoth("panel-open", async () => {
            await testsPage();
            await page.getByRole("button", { name: "Run", exact: true }).click();
            await pwExpect(panel()).toBeVisible();
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await testsPage();
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await pwExpect(panel()).toBeVisible();
        await noSidewaysScroll();
        for (const row of await panel().locator("label.run-opt:not(.is-off)").all()) if (await row.isVisible()) await tallEnough(row, "an option row");
        await tallEnough(panel().getByRole("button", { name: "Start run" }), "Start run");
        await shot("panel-light-390");
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 180_000);

    it("shows where it can run, and changing it is said to change the project's setting", async () => {
        await testsPage();
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await pwExpect(panel().getByRole("radio", { name: "This server" })).toBeChecked();
        await pwExpect(panel().getByRole("radio", { name: /Maya's laptop/ })).toBeEnabled();
        await pwExpect(panel().getByText("online", { exact: true })).toBeVisible();
        await pwExpect(panel().getByRole("radio", { name: /Old desktop/ })).toBeDisabled();
        await pwExpect(panel().getByText("offline", { exact: true })).toBeVisible();
        await panel().getByRole("radio", { name: /Maya's laptop/ }).check();
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText("Runs 1 test on Maya's laptop. Results replace the last results of these tests.");
        await pwExpect(panel().getByText("This also becomes where this project runs its tests, until you change it.")).toBeVisible();
        // Starting changes the project's runner first (the platform's own route), then starts the run.
        await panel().getByRole("button", { name: "Start run" }).click();
        await pwExpect(strip()).toBeVisible({ timeout: 30_000 });
        expect(runner.puts).toEqual([{ runOn: "agent", agentId: "ag-1" }]);
        await pwExpect(page.getByRole("region", { name: "Run finished" })).toBeVisible({ timeout: 90_000 });
        // Back to this server for the rest of the file.
        runner.runOn = "platform";
        runner.agentId = null;
    }, 180_000);
});

describe("a run you started: strip, live list, results, Run page", () => {
    it("runs the failing tests: the strip says what is running, lists the test, then how it ended", async () => {
        mode = "slow";
        await testsPage();
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await pwExpect(panel().getByRole("radio", { name: "Failing now (1)" })).toBeChecked();
        await panel().getByRole("button", { name: "Start run" }).click();
        await pwExpect(panel()).toHaveCount(0);

        await pwExpect(strip()).toBeVisible({ timeout: 30_000 });
        await pwExpect(strip()).toContainText("Running 1 test");
        await pwExpect(strip()).toContainText("On this server");
        // The Run button says why it cannot start another one, and the old "being created" callout is not shown for a run.
        await pwExpect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
        await pwExpect(page.getByText("Tests are still being created")).toHaveCount(0);
        await strip().getByRole("button", { name: "Show tests" }).click();
        const row = strip().getByRole("listitem").filter({ hasText: "Missing six" });
        await pwExpect(row).toBeVisible();
        await pwExpect(row).toHaveAttribute("data-state", "running");
        await pwExpect(row.getByRole("link", { name: "Missing six" })).toHaveAttribute("href", /#\/tests\//);

        const finished = page.getByRole("region", { name: "Run finished" });
        await pwExpect(finished).toBeVisible({ timeout: 90_000 });
        await pwExpect(finished).toContainText("Run finished, 1 test");
        await pwExpect(finished).toContainText("0 of 1 that ran passed, 1 failing.");
        await shot("strip-finished-light-1280");
        mode = "easy";
    }, 240_000);

    it("opens the run: facts, failures first with the reason, and ways to run again", async () => {
        await page.getByRole("link", { name: "See the run" }).click();
        await pwExpect(page).toHaveURL(/#\/projects\/[^/]+\/runs\/[^/]+$/);
        await pwExpect(page.getByRole("heading", { name: "Run", exact: true })).toBeVisible();
        const about = page.getByRole("region", { name: "About this run" });
        await pwExpect(about).toContainText("On this server");
        await pwExpect(about).toContainText("Started by");
        await pwExpect(about).toContainText("A person");
        await pwExpect(about).toContainText("How long");
        await pwExpect(page.getByTestId("run-summary")).toHaveText("0 of 1 that ran passed, 1 failing.");
        const first = page.getByRole("list", { name: "Tests in this run" }).getByRole("listitem").first();
        await pwExpect(first).toContainText("Missing six");
        await pwExpect(first).toContainText("Failing");
        await pwExpect(first.locator(".why")).not.toBeEmpty();
        await pwExpect(page.getByRole("button", { name: "Run failing tests again (1)" })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Run these tests again" })).toBeVisible();
        await shot("run-detail-light-1280");
    });

    it("says what changed since the last run, and runs the failing ones again from the page", async () => {
        mode = "changed"; // Fast one now breaks, Missing six now works
        await testsPage();
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await panel().getByRole("radio", { name: "All tests (6)" }).check();
        await panel().getByRole("button", { name: "Start run" }).click();
        await pwExpect(page.getByRole("region", { name: "Run finished" })).toBeVisible({ timeout: 120_000 });
        await page.getByRole("link", { name: "See the run" }).click();
        await pwExpect(page.getByTestId("run-summary")).toContainText("that ran passed");
        const changed = page.getByRole("region", { name: "Changed since the last run" });
        await pwExpect(changed).toBeVisible();
        await pwExpect(changed.getByRole("heading", { name: "Newly failing (1)" })).toBeVisible();
        await pwExpect(changed.getByRole("link", { name: "Fast one" })).toBeVisible();
        await pwExpect(changed.getByRole("heading", { name: "Newly passing (1)" })).toBeVisible();
        await pwExpect(changed.getByRole("link", { name: "Missing six" })).toBeVisible();
        // Failures first in the list: the failing test is at the top.
        await pwExpect(page.getByRole("list", { name: "Tests in this run" }).getByRole("listitem").first()).toContainText("Failing");

        mode = "easy";
        await page.getByRole("button", { name: /^Run failing tests again/ }).click();
        await pwExpect(panel()).toContainText("The 1 failing test of this run.");
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText("Runs 1 test on this server. Results replace the last results of these tests.");
        await panel().getByRole("button", { name: "Start run" }).click();
        await pwExpect(page.getByRole("region", { name: "Run finished" })).toBeVisible({ timeout: 90_000 });
        // It passes now (the application is back to normal), through the platform's own record.
        expect((await snapshot(idOf["Fast one"]!)).status).toBe("VALIDATED");
    }, 300_000);

    it("the Runs page names each run, its numbers with denominators, and links to it", async () => {
        await visit(`#/projects/${projectId}/runs`);
        await pwExpect(page.getByRole("heading", { name: "Run", exact: true }).first()).toBeVisible();
        await pwExpect(page.getByText("0 of 1 that ran passed, 1 failing.").first()).toBeVisible();
        const link = page.getByRole("heading", { name: "Run", exact: true }).first().getByRole("link");
        await link.click();
        await pwExpect(page).toHaveURL(/#\/projects\/[^/]+\/runs\/[^/]+$/);
        // "See each test" from the list does the same.
        await visit(`#/projects/${projectId}/runs`);
        await pwExpect(page.getByRole("link", { name: "See each test" }).first()).toBeVisible();
    });
});

describe("stopping a run honestly", () => {
    let before: Record<string, Awaited<ReturnType<typeof snapshot>>> = {};
    it("asks first, says what is kept, and Keep running changes nothing", async () => {
        for (const [title, id] of Object.entries(idOf)) before[title] = await snapshot(id);
        mode = "hang";
        slowHits = 0;
        await testsPage();
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await panel().getByRole("radio", { name: "All tests (6)" }).check();
        await panel().getByRole("button", { name: "Start run" }).click();
        await pwExpect(strip()).toBeVisible({ timeout: 30_000 });
        await pwExpect(strip()).toContainText("Running 6 tests");
        for (let i = 0; i < 300 && slowHits === 0; i++) await sleep(100);
        expect(slowHits, "the run reached a slow test").toBeGreaterThan(0);

        await strip().getByRole("button", { name: "Stop run" }).click();
        const dialog = page.getByRole("dialog", { name: "Stop this run?" });
        await pwExpect(dialog).toBeVisible();
        await pwExpect(dialog.getByRole("button", { name: "Keep running" })).toBeFocused();
        // The platform records results when the scripts finish: while they run, none is recorded, and the dialog says so.
        await pwExpect(dialog.getByTestId("stop-body")).toHaveText("No results have been recorded yet. Tests that did not finish keep their previous result.");
        await shot("stop-dialog-light-1280");
        await axeBoth("stop-dialog", async () => {
            // the dialog is a top-layer element: it stays open while the scheme changes
            await pwExpect(dialog).toBeVisible();
        });
        await dialog.getByRole("button", { name: "Keep running" }).click();
        await pwExpect(dialog).toHaveCount(0);
        await pwExpect(strip()).toBeVisible();
        await pwExpect(strip().getByRole("button", { name: "Stop run" })).toBeEnabled();
    }, 240_000);

    it("the strip is audited in both colour schemes and fits a phone", async () => {
        await strip().getByRole("button", { name: "Show tests" }).click();
        await pwExpect(strip().getByRole("list", { name: "Tests in this run" })).toBeVisible();
        await shot("strip-light-1280");
        await axeBoth("strip", async () => {
            await pwExpect(strip().getByRole("list", { name: "Tests in this run" })).toBeVisible();
        });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await shot("strip-dark-1280");
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(400);
        await noSidewaysScroll();
        await tallEnough(strip().getByRole("button", { name: "Stop run" }), "Stop run");
        await shot("strip-light-390");
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 180_000);

    it("stops: 'Stopping…', then 'Stopped: N of 6 ran', and the tests that did not run are exactly as they were", async () => {
        await strip().getByRole("button", { name: "Stop run" }).click();
        const dialog = page.getByRole("dialog", { name: "Stop this run?" });
        await dialog.getByRole("button", { name: "Stop run" }).click();
        await pwExpect(strip().getByRole("button", { name: "Stopping…" })).toBeDisabled();

        const stopped = page.getByRole("region", { name: "Run finished" });
        await pwExpect(stopped).toBeVisible({ timeout: 90_000 });
        const jobs = (await api("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ jobId: string; cancelled?: { planned: number; ran: number; notRun: number; note: string } }>;
        const cancelled = jobs.find((j) => j.cancelled)!;
        expect(cancelled.cancelled).toMatchObject({ planned: 6 });
        await pwExpect(stopped).toContainText(`Stopped: ${cancelled.cancelled!.ran} of 6 ran`);
        await pwExpect(stopped).toContainText(cancelled.cancelled!.note);
        await shot("strip-stopped-light-1280");

        // The platform agrees: the run reads test by test, and the ones that did not run keep their old result.
        const detail = (await api("GET", `/api/projects/${projectId}/runs/${cancelled.jobId}`)).body;
        expect(detail.counts.ran).toBe(cancelled.cancelled!.ran);
        expect(detail.counts.notRun).toBe(cancelled.cancelled!.notRun);
        expect(detail.counts.notRun).toBeGreaterThan(0);
        for (const t of detail.tests.filter((x: { state: string }) => x.state === "not_run")) expect(await snapshot(t.id), t.title).toEqual(before[t.title]);
        mode = "easy";
    }, 240_000);

    it("a stopped run reads the same on the Runs page, the Overview and the run's own page", async () => {
        const jobs = (await api("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ jobId: string; cancelled?: { ran: number; planned: number } }>;
        const c = jobs.find((j) => j.cancelled)!.cancelled!;
        const line = `Stopped: ${c.ran} of ${c.planned} ran`;
        await visit(`#/projects/${projectId}/runs`);
        await pwExpect(page.getByText(line).first()).toBeVisible();
        await pwExpect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
        await pwExpect(page.getByText("Nothing was changed")).toHaveCount(0);
        await visit(`#/projects/${projectId}`);
        await pwExpect(page.getByText(line).first()).toBeVisible();
        await visit(`#/projects/${projectId}/runs/${jobs.find((j) => j.cancelled)!.jobId}`);
        await pwExpect(page.getByTestId("run-summary")).toContainText(line);
        await pwExpect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
        await axeBoth("run-detail", async () => {
            await visit(`#/projects/${projectId}/runs/${jobs.find((j) => j.cancelled)!.jobId}`);
            await pwExpect(page.getByTestId("run-summary")).toBeVisible();
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await visit(`#/projects/${projectId}/runs/${jobs.find((j) => j.cancelled)!.jobId}`);
        await pwExpect(page.getByTestId("run-summary")).toBeVisible();
        await noSidewaysScroll();
        await shot("run-detail-light-390");
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 240_000);

    it("a run started elsewhere shows on a page opened later, and the Run button says why it waits", async () => {
        mode = "hang";
        slowHits = 0;
        const started = await api("POST", `/api/projects/${projectId}/runs`, { testIds: [idOf["Slow three"]] });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        for (let i = 0; i < 300 && slowHits === 0; i++) await sleep(100);
        await testsPage();
        await pwExpect(strip()).toBeVisible({ timeout: 20_000 });
        await pwExpect(strip()).toContainText("Running 1 test");
        const run = page.getByRole("button", { name: "Run", exact: true });
        await pwExpect(run).toBeDisabled();
        // Round 19: the reason moved from a native title (not shown to keyboard or touch users) to the button's tooltip, its accessible description.
        await pwExpect(run).toHaveAccessibleDescription("A run is going. Stop it or wait for it to finish.");
        // The Runs page shows it too, with a Live marker or the newest step.
        await visit(`#/projects/${projectId}/runs`);
        await pwExpect(page.getByTestId("run-strip")).toBeVisible({ timeout: 20_000 });
        expect((await api("DELETE", `/api/test-generation/${started.body.jobId}`)).status).toBe(202);
        await jobDone(started.body.jobId);
        await pwExpect(page.getByRole("region", { name: "Run finished" })).toBeVisible({ timeout: 30_000 });
        mode = "easy";
    }, 240_000);
});

describe("choosing tests in the list", () => {
    it("every row has a checkbox; Select scripts opens a bar that counts; the Run panel runs exactly those", async () => {
        await testsPage();
        const toggle = page.getByRole("button", { name: "Select scripts" });
        await pwExpect(toggle).toHaveAttribute("aria-pressed", "false");
        await toggle.click();
        await pwExpect(toggle).toHaveAttribute("aria-pressed", "true");
        const bar = page.getByRole("region", { name: "Selected scripts" });
        await pwExpect(bar).toContainText("No scripts selected");
        await page.getByRole("checkbox", { name: "Select Fast one" }).check();
        await page.getByRole("checkbox", { name: "Select Fast two" }).check();
        await pwExpect(bar).toContainText("2 scripts selected");
        await shot("selection-light-1280");

        await bar.getByRole("button", { name: "Run selected" }).click();
        await pwExpect(panel().getByRole("radio", { name: "Selected tests (2)" })).toBeChecked();
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText("Runs 2 tests on this server. Results replace the last results of these tests.");
        await panel().getByRole("button", { name: "Start run" }).click();
        await pwExpect(page.getByRole("region", { name: "Run finished" })).toBeVisible({ timeout: 90_000 });
        const jobs = (await api("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ jobId: string }>;
        const detail = (await api("GET", `/api/projects/${projectId}/runs/${jobs[0]!.jobId}`)).body;
        expect(detail.tests.map((t: { title: string }) => t.title).sort()).toEqual(["Fast one", "Fast two"]);
    }, 240_000);

    it("selects everything shown, clears it again, and leaves the mode", async () => {
        await page.getByRole("button", { name: /^Select the 6 shown$/ }).click();
        await pwExpect(page.getByRole("region", { name: "Selected scripts" })).toContainText("6 scripts selected");
        await page.getByRole("button", { name: "Clear the shown scripts" }).click();
        await pwExpect(page.getByRole("region", { name: "Selected scripts" })).toContainText("No scripts selected");
        await page.getByRole("button", { name: "Done" }).click();
        await pwExpect(page.getByRole("region", { name: "Selected scripts" })).toHaveCount(0);
        await pwExpect(page.getByRole("checkbox", { name: "Select Fast one" })).not.toBeChecked();
        await pwExpect(page.getByRole("button", { name: "Select scripts" })).toHaveAttribute("aria-pressed", "false");
    });

    it("every checkbox has a 44 px target, the bar is audited in both schemes and nothing scrolls sideways on a phone", async () => {
        await page.getByRole("button", { name: "Select scripts" }).click();
        await page.getByRole("checkbox", { name: "Select Fast one" }).check();
        for (const label of await page.locator("label.run-pick").all()) await tallEnough(label, "a selection checkbox");
        await axeBoth("selection", async () => {
            await pwExpect(page.getByRole("region", { name: "Selected scripts" })).toBeVisible();
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await noSidewaysScroll();
        await shot("selection-light-390");
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 180_000);
});

describe("environments and production", () => {
    it("a production environment still needs its confirmation, in the same panel", async () => {
        expect((await api("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: APP })).status).toBe(201);
        expect((await api("POST", `/api/projects/${projectId}/environments`, { name: "production", baseUrl: APP, production: true })).status).toBe(201);
        await testsPage();
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await panel().getByRole("radio", { name: "All tests (6)" }).check();
        // Round 21: the environment marked Default (staging, the first one made) is preselected; it used to be the project address.
        await pwExpect(panel().getByRole("radio", { name: "staging", exact: true })).toBeChecked();
        await pwExpect(panel().getByRole("radio", { name: "Project address" })).not.toBeChecked();
        await panel().getByRole("radio", { name: "production (production)", exact: true }).check();
        const start = panel().getByRole("button", { name: "Start run" });
        await pwExpect(start).toBeDisabled();
        await pwExpect(panel().getByTestId("run-sentence")).toContainText("against production");
        await pwExpect(panel().getByTestId("run-sentence")).toContainText("The results are kept for production; the tests’ own results do not change.");
        await panel().getByRole("checkbox", { name: "Yes, run on production" }).check();
        await pwExpect(start).toBeEnabled();
        // Browsers and retries are options of the project's own run: not offered against an environment.
        await pwExpect(panel().getByText("How", { exact: true })).toHaveCount(0);
        await start.click();
        await pwExpect(page.getByRole("region", { name: "Run finished" })).toBeVisible({ timeout: 120_000 });
        const jobs = (await api("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ jobId: string; mode: string; environment: string | null }>;
        expect(jobs[0]).toMatchObject({ mode: "environment", environment: "production" });
        await page.getByRole("link", { name: "See the run" }).click();
        await pwExpect(page.getByRole("heading", { name: "Run on production" })).toBeVisible();
        await pwExpect(page.getByRole("region", { name: "About this run" })).toContainText("against production");
        // The run page offers the same environment again, with the confirmation still required.
        await page.getByRole("button", { name: "Run these tests again" }).click();
        await pwExpect(panel().getByRole("checkbox", { name: "Yes, run on production" })).toBeVisible();
        await pwExpect(panel().getByRole("button", { name: "Start run" })).toBeDisabled();
    }, 300_000);
});

describe("the test page", () => {
    it("Run again runs at once, the strip follows it, and the arrow opens the same choices", async () => {
        mode = "slow";
        await visit(`#/tests/${idOf["Fast one"]}`);
        const again = page.getByRole("button", { name: "Run again" });
        await pwExpect(again).toBeVisible();
        await again.click();
        await pwExpect(strip()).toBeVisible({ timeout: 30_000 });
        await pwExpect(strip()).toContainText("Running this test");
        await pwExpect(strip().getByRole("button", { name: "Stop run" })).toBeVisible();
        // One voice for "running": the old callout is gone.
        await pwExpect(page.getByText("This test is running")).toHaveCount(0);
        await shot("test-page-strip-light-1280");
        await pwExpect(page.getByRole("region", { name: "Run finished" })).toBeVisible({ timeout: 90_000 });
        await pwExpect(page.getByRole("region", { name: "Run finished" })).toContainText("The run finished");
        mode = "easy";

        await page.getByRole("button", { name: "More ways to run" }).click();
        await pwExpect(panel()).toContainText("This test.");
        // The project has a default environment (staging, made in "environments and production" above), so the panel starts there (round 21).
        await pwExpect(panel().getByTestId("run-sentence")).toContainText("Runs 1 test on this server against staging.");
        await panel().getByRole("radio", { name: "Project address", exact: true }).check();
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText("Runs 1 test on this server. Results replace the last results of these tests.");
        await page.keyboard.press("Escape");
        await pwExpect(page.getByRole("button", { name: "More ways to run" })).toBeFocused();
    }, 240_000);

    it("is audited in both colour schemes and fits a phone", async () => {
        await axeBoth("test-page", async () => {
            await visit(`#/tests/${idOf["Fast one"]}`);
            await pwExpect(page.getByRole("button", { name: "Run again" })).toBeVisible();
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await visit(`#/tests/${idOf["Fast one"]}`);
        await pwExpect(page.getByRole("button", { name: "Run again" })).toBeVisible();
        await noSidewaysScroll();
        await page.setViewportSize({ width: 1280, height: 900 });
        expect(consoleErrors).toEqual([]);
    }, 180_000);
});
