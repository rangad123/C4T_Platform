/**
 * The quality card on a project's dashboard and the pull request lines on Runs, After a deploy (Phase 6 U2), in a real browser against
 * the real built UI (web/dist) and a real platform (port 9617, no worker, no AI). The card: up to five numbers and two lists whose rows link to a
 * test; hidden for a project with no history. The pull request lines: the reasons, the run of the commit, and two buttons, full first;
 * nothing is sent until a person clicks, and the focused run sends the change's routes. Axe in both colour schemes, phone width, and
 * screenshots at both widths in SCREENSHOTS (when set).
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

const PORT = 9617;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.QUALITY_SCREENSHOTS;
const HEAD = "d".repeat(40);

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;
let emptyId: string;
let cartTest: string;
let flakyTest: string;
let latestRun: string;
let confirmedRun: string;

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-qualityui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "quality-ui-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const { repo, db } = platform;

    projectId = String(repo.createProject({ name: "Quality shop" }).id);
    emptyId = String(repo.createProject({ name: "No history" }).id);
    const appId = repo.createApplication(projectId, "http://127.0.0.1:9618", { ...DEFAULT_JOB_OPTIONS });
    const suiteId = repo.getOrCreateSuite(projectId, "Shop", "shop");
    const add = (testId: string, title: string, page: string) => repo.insertTest({ projectId, suiteId, jobId: null, spec: TestSpecSchema.parse({ testId, title, kind: "web", category: "Shop", steps: [{ action: "navigate", url: page }] }), framework: "playwright", validationStatus: "VALIDATED" });
    cartTest = add("WEB-001", "Cart total", "/cart");
    flakyTest = add("WEB-002", "Search results", "/search");

    // Search flips between pass and fail: an unreliable test.
    ["passed", "failed", "passed", "failed"].forEach((status, i) => repo.addExecution({ testId: flakyTest, scriptId: null, jobId: null, attempt: 1, status: status as "passed", durationMs: 100, startedAt: iso(50 - i), steps: [] }));

    // Three runs; the cart test failed in two of them. The newest ran for the pull request's head commit.
    const summary = async (hoursAgo: number, passRate: number, cartPassed: boolean) => {
        const job = await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate" });
        const results = [
            { k: "WEB-001", id: cartTest, key: "WEB-001", title: "Cart total", s: cartPassed ? "p" : "f" },
            { k: "WEB-002", id: flakyTest, key: "WEB-002", title: "Search results", s: "p" },
        ];
        db.run(
            "INSERT INTO run_summaries (job_id, project_id, mode, trigger_kind, job_status, finished_at, total, validated, needs_review, failed, flaky, pass_rate, results_json, diff_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            job.id, projectId, "validate", "trigger", "COMPLETED", iso(hoursAgo), 2, cartPassed ? 2 : 1, 0, cartPassed ? 0 : 1, 0, passRate, JSON.stringify(results), "{}",
        );
        repo.setJobStatus(job.id, "COMPLETED");
        return job.id;
    };
    await summary(60, 50, false);
    await summary(30, 100, true);
    latestRun = await summary(5, 50, false);
    db.run("INSERT INTO trigger_tokens (id, project_id, label, token_hash, hint, created_at) VALUES (?,?,?,?,?,?)", "qui-tok", projectId, "CI", "qui-hash", "qtok", iso(100));
    db.run("INSERT INTO trigger_runs (job_id, token_id, commit_sha, callback_state, created_at) VALUES (?,?,?,?,?)", latestRun, "qui-tok", HEAD.slice(0, 7), "none", iso(5));

    // One bug confirmed 12 hours after it was first seen, later fixed, and back.
    const at = iso(80);
    const finding = (observed: string) =>
        JSON.stringify({ objective: null, actions: { stepCount: 1 }, expected: { text: "The total adds up.", source: null }, observed, evidence: { screenshots: [], requests: [], console: [] }, capture: "captured", independence: "independent", confidence: "high", fingerprint: `fp-${observed.length}`, modelVersion: null, replays: [] });
    db.run("INSERT INTO candidate_findings (id, project_id, fingerprint, status, confidence, capture, finding_json, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "qui-f1", projectId, "fp-qui", "candidate", "high", "screenshot", finding("The total is wrong."), at, at, at, at);
    // The bug confirmed now, found by an exploration: "Bugs confirmed" opens that run (its own events are left out, so the count stays 1).
    confirmedRun = (await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate" })).id;
    db.run("INSERT INTO candidate_findings (id, project_id, fingerprint, status, confidence, capture, finding_json, first_seen_at, last_seen_at, created_at, updated_at, state, first_job_id, last_job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", "qui-f2", projectId, "fp-qui-2", "candidate", "high", "captured", finding("The delivery fee is missing."), iso(2), iso(2), iso(2), iso(2), "confirmed", confirmedRun, confirmedRun);
    const ev = (seq: number, from: string, to: string, hoursAgo: number) => db.run("INSERT INTO finding_events (id, project_id, finding_id, seq, at, actor, by_kind, from_state, to_state) VALUES (?,?,?,?,?,?,?,?,?)", `qui-e${seq}`, projectId, "qui-f1", seq, iso(hoursAgo), "Engine", "engine", from, to);
    ev(1, "reproduced", "confirmed", 68);
    ev(2, "confirmed", "fixed", 40);
    ev(3, "fixed", "verification_pending", 10);

    const reasons = {
        tests: [{ testId: cartTest, testKey: "WEB-001", title: "Cart total", score: 7, risk: "Risk 7", reasons: ["The change names GET /cart, and its steps open /cart (step 1)."] }],
        fullRunRecommended: true,
        fullRunReasons: ["Shared code changed: src/db.ts reaches every request."],
        endpoints: ["GET /cart (src/cart.ts:4)"],
        unmapped: [],
        shared: ["src/db.ts"],
        findings: [],
        notes: [],
    };
    db.run("INSERT INTO pr_selections (id, project_id, pr, head_sha, mode, selected_json, reasons_json, created_at) VALUES (?,?,?,?,?,?,?,?)", "qui-ps", projectId, 42, HEAD, "full", JSON.stringify([cartTest]), JSON.stringify(reasons), iso(6));

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function axeBoth(selector: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        const result = await new AxeBuilder({ page }).include(selector).analyze();
        expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}

const shot = async (selector: string, name: string) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.locator(selector).screenshot({ path: path.join(SHOTS, name) });
};

describe("the quality card", () => {
    it("shows the numbers there is something for, Bugs confirmed opening its run, and two lists whose rows open the test", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}`);
        const card = page.getByTestId("quality-card");
        await pwExpect(card).toBeVisible({ timeout: 20_000 });
        // No workflow coverage was recorded, so that number is left out rather than shown as "–"; time to confirm is not on the card.
        await pwExpect(card.locator(".metric")).toHaveCount(4);
        const metric = (label: string) => card.locator(".metric").filter({ hasText: label }).locator(".num");
        await pwExpect(metric("Bugs confirmed")).toHaveText("1");
        await pwExpect(metric("Bugs confirmed").getByRole("link")).toHaveAttribute("href", `#/projects/${projectId}/runs/${confirmedRun}`);
        await pwExpect(metric("Came back after a fix")).toHaveText("1");
        await pwExpect(metric("Pass rate, last 10 runs")).toHaveText("66.7%");
        await pwExpect(metric("Pull requests checked")).toHaveText("1");
        await pwExpect(card).not.toContainText("Workflow steps tried");
        await pwExpect(card).not.toContainText("Time to confirm");
        const area = card.getByTestId("quality-areas").getByRole("link");
        await pwExpect(area).toHaveCount(1);
        await pwExpect(area).toContainText("/cart");
        await pwExpect(area).toContainText("Failed in 2 of the last 10 runs, 1 test");
        await pwExpect(area).toHaveAttribute("href", `#/tests/${cartTest}`);
        const flaky = card.getByTestId("quality-flaky").getByRole("link");
        await pwExpect(flaky).toHaveCount(1);
        await pwExpect(flaky).toContainText("WEB-002 Search results");
        await pwExpect(flaky).toHaveAttribute("href", `#/tests/${flakyTest}`);
        // Nothing else: no tab, no setting, no action button on the card (only the numbers' help tips).
        await pwExpect(card.locator(".btn, [role=tab], input, select")).toHaveCount(0);
        await shot('[data-testid="quality-card"]', "quality-card-desktop.png");
        await axeBoth('[data-testid="quality-card"]');
    }, 90_000);

    it("is not shown for a project with no history", async () => {
        const answered = page.waitForResponse((r) => r.url().includes(`/api/projects/${emptyId}/quality`));
        await page.goto(`${BASE}/#/projects/${emptyId}`);
        expect((await answered).status()).toBe(200);
        await page.waitForTimeout(500);
        await pwExpect(page.getByTestId("quality-card")).toHaveCount(0);
    }, 60_000);
});

describe("pull request lines on Runs, After a deploy", () => {
    it("show the reasons and the run of the commit, and send a run only when a person clicks, full first", async () => {
        const sent: unknown[] = [];
        await page.route("**/api/projects/*/selection-run", async (route) => {
            sent.push(route.request().postDataJSON());
            await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: latestRun, selection: "full", testCount: sent.length === 1 ? 2 : 1 }) });
        });
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=deploys`);
        const pr = page.getByTestId("selection-prs").locator('[data-pr="42"]');
        await pwExpect(pr).toBeVisible({ timeout: 20_000 });
        await pwExpect(pr).toContainText("Pull request #42");
        await pwExpect(pr).toContainText("dddddd");
        await pwExpect(pr).toContainText("1 test proposed");
        await pwExpect(pr).toContainText("Full run recommended. Shared code changed");
        await pwExpect(pr).toContainText("Shared code changed: src/db.ts reaches every request.");
        await pwExpect(pr).toContainText("WEB-001 Cart total: The change names GET /cart, and its steps open /cart (step 1).");
        await pwExpect(pr).toContainText("Run of this commit: 1 of 2 failed.");
        await pwExpect(pr.getByRole("link", { name: "Open the run" })).toHaveAttribute("href", `#/projects/${projectId}/runs/${latestRun}`);
        const buttons = pr.getByRole("button");
        await pwExpect(buttons).toHaveText(["Run all tests", "Run only the proposed tests"]);
        await pwExpect(buttons.first()).toHaveClass(/primary/);
        await shot('[data-testid="selection-prs"]', "pr-lines-desktop.png");
        await axeBoth('[data-testid="selection-prs"]');
        expect(sent).toEqual([]);
        // With pull request lines, naming the changes by hand is folded under them.
        const byHand = page.getByTestId("selection-by-hand");
        await pwExpect(byHand.locator("summary")).toHaveText("Or name the changed pages and endpoints yourself");
        await pwExpect(page.getByRole("button", { name: "Preview the tests" })).toBeHidden();
        await byHand.locator("summary").click();
        await pwExpect(page.getByRole("button", { name: "Preview the tests" })).toBeVisible();

        await buttons.first().click();
        await pwExpect(pr.getByRole("status")).toContainText("Started a run of 2 tests.");
        await buttons.nth(1).click();
        await pwExpect(pr.getByRole("status")).toContainText("Started a run of 1 test.");
        expect(sent).toEqual([{ selection: "full" }, { selection: "focused", pages: ["/cart"], endpoints: ["GET /cart"] }]);
        await page.unroute("**/api/projects/*/selection-run");
    }, 90_000);
});

describe("at phone width", () => {
    it("fits without sideways scrolling", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        for (const [url, sel, name] of [
            [`/#/projects/${projectId}`, '[data-testid="quality-card"]', "quality-card-phone.png"],
            [`/#/projects/${projectId}/runs?section=deploys`, '[data-testid="selection-prs"]', "pr-lines-phone.png"],
        ] as const) {
            await page.goto(BASE + url);
            await pwExpect(page.locator(sel)).toBeVisible({ timeout: 20_000 });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow, url).toBeLessThanOrEqual(0);
            await shot(sel, name);
        }
        await page.setViewportSize({ width: 1200, height: 900 });
    }, 60_000);
});
