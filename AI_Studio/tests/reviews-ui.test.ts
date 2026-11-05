/**
 * Review and approval in a real browser against a real platform (port 7751): the dashboard's and Test development's "Drafts waiting
 * for review" with its empty state, the Test scripts list with each version's state and sync status, a version's page with the
 * steps beside the approved version, approving and rejecting there, and the review policy in Settings → Members. Accessibility
 * checks on the list and the version page. Requires `web/dist` (vite build).
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
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runJob } from "../src/platform/job-runner.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7751;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "reviews-ui-owner-key-3f2a";
let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let stopBeat: (() => void) | undefined;
let projectId = "";
const tests: Record<string, string> = {};

const spec = (testId: string, title: string, url = "/") => TestSpecSchema.parse({ testId, title, kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url }] });

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-reviews-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    // Runs start only where a worker beats (round 38); the runs here are queued and run by the test itself (runJob).
    stopBeat = startHeartbeat(platform.db);
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const { repo } = platform;
    projectId = repo.createProject({ name: "Review shop" }).id as string;
    repo.createApplication(projectId, "http://127.0.0.1:9/", {});
    const suite = repo.getOrCreateSuite(projectId, "Smoke", "smoke");
    const add = (key: string, title: string) => (tests[key] = repo.insertTest({ projectId, suiteId: suite, jobId: null, spec: spec(key, title), framework: "playwright", validationStatus: "PENDING", versionSource: "ai" }));
    const store = new ReviewStore(platform.db);
    store.setPolicy(projectId, { aiGenerated: false }, "test");
    add("WEB-002", "Cart");
    store.setPolicy(projectId, { aiGenerated: true }, "test");
    repo.updateTest(tests["WEB-002"]!, { spec: spec("WEB-002", "Cart", "/cart"), versionSource: "ai" });
    add("WEB-001", "Home");
    add("WEB-003", "Search");
    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(BASE);
    await page.getByLabel("Email").fill("olga@example.com");
    await page.getByLabel("Password").fill("olga's long password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}, 90_000);
afterAll(async () => {
    stopBeat?.();
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const axeClean = async () => {
    const r = await new AxeBuilder({ page }).analyze();
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

describe("review and approval in the web app", () => {
    it("lists the drafts waiting for review on the dashboard and in Test development", async () => {
        await page.goto(`${BASE}/#/dashboard`);
        const queue = page.getByRole("region", { name: "Drafts waiting for review" });
        await pwExpect(queue.getByRole("link", { name: /WEB-001 Home/ })).toBeVisible();
        await pwExpect(queue.getByRole("link", { name: /WEB-002 Cart/ })).toBeVisible();
        await pwExpect(queue.getByRole("link", { name: /WEB-003 Search/ })).toBeVisible();
        await pwExpect(page.getByTestId("planned-review-queue")).toHaveCount(0);
        await page.goto(`${BASE}/#/develop`);
        await pwExpect(page.getByRole("region", { name: "Drafts waiting for review" }).getByRole("link", { name: /WEB-001 Home/ })).toBeVisible();
        await pwExpect(page.getByTestId("planned-review-queue")).toHaveCount(0);
    });

    it("shows every script with its state, sync status and what runs", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/scripts?section=review`);
        const list = page.getByRole("list", { name: "Test scripts" });
        await pwExpect(list.getByRole("link", { name: /Home/ })).toContainText("Waiting for approval");
        await pwExpect(list.getByRole("link", { name: /Cart/ })).toContainText("version 1 runs");
        await pwExpect(list.getByRole("link", { name: /Cart/ })).toContainText("Steps changed");
        await pwExpect(page.getByTestId("planned-script-approval")).toHaveCount(0);
        expect(await axeClean()).toEqual([]);
    });

    it("compares a draft with the approved version, and approves it", async () => {
        await page.getByRole("list", { name: "Test scripts" }).getByRole("link", { name: /Cart/ }).click();
        await pwExpect(page.getByRole("heading", { name: "WEB-002 Cart, version 2" })).toBeVisible();
        await pwExpect(page.getByText("Runs use version 1 until this one is approved.")).toBeVisible();
        await pwExpect(page.getByTestId("diff").first()).toContainText("/cart");
        expect(await axeClean()).toEqual([]);
        await page.getByRole("button", { name: "Approve", exact: true }).click();
        await page.getByLabel("Note (optional)").fill("Checked");
        await page.getByRole("button", { name: "Approve this version" }).click();
        await pwExpect(page.getByText("Approved. This version runs from now on.")).toBeVisible();
        await pwExpect(page.getByText("This is the version that runs.")).toBeVisible();
        expect(new ReviewStore(platform.db).approved(tests["WEB-002"]!)?.version).toBe(2);
    });

    it("rejects a draft with a reason, and asks for one first", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/scripts?test=${tests["WEB-003"]}&version=1`);
        await page.getByRole("button", { name: "Reject", exact: true }).click();
        await pwExpect(page.getByRole("button", { name: "Reject this version" })).toBeDisabled();
        await page.getByLabel("Why it is rejected").fill("Searches the wrong page");
        await page.getByRole("button", { name: "Reject this version" }).click();
        await pwExpect(page.getByText("Rejected. It will never run.")).toBeVisible();
        await pwExpect(page.getByRole("list", { name: "Comments" })).toContainText("Searches the wrong page");
    });

    it("says on the page that a saved edit does not change what the queued run runs", async () => {
        await page.goto(`${BASE}/#/tests/${tests["WEB-002"]}/steps`);
        await page.locator(".bld-head").first().click();
        await page.getByLabel("Address", { exact: true }).fill("/changed");
        await page.getByTestId("unsaved-bar").getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByTestId("saved-bar")).toContainText("A run has started. The run uses approved version 2, not this draft. A draft runs once a Project Admin approves it.");
        const job = platform.repo.listJobs(projectId)[0]!;
        platform.repo.setJobStatus(job.id, "FAILED", "test only");
        const store = new ReviewStore(platform.db);
        store.approve(store.latest(tests["WEB-002"]!)!, { kind: "system", name: "Test", role: "owner" }, null);
    });

    it("shows the tests a run held back with a link to review them, and a run of only drafts is not a failure", async () => {
        const job = await platform.repo.createJob(projectId, platform.repo.getLatestApplicationPublic(projectId)!.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [tests["WEB-001"]!] });
        const claimed = platform.repo.claimNextJob(60_000, "w-reviews-ui")!;
        expect(claimed.id).toBe(job.id);
        await runJob({ ...platform }, claimed, "w-reviews-ui");
        await page.goto(`${BASE}/#/projects/${projectId}/runs/${job.id}`);
        await pwExpect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await pwExpect(page.locator(".badge", { hasText: "Nothing ran" }).first()).toBeVisible();
        await pwExpect(page.getByText("Did not finish")).toHaveCount(0);
        await pwExpect(page.locator(".callout-danger")).toHaveCount(0);
        const held = page.getByTestId("run-held-back");
        await pwExpect(held.getByRole("heading", { name: "Waiting for approval (1)" })).toBeVisible();
        expect(await axeClean()).toEqual([]);
        await held.getByRole("link", { name: "Review WEB-001" }).click();
        await pwExpect(page.getByRole("heading", { name: "WEB-001 Home, version 1" })).toBeVisible();
        await page.goto(`${BASE}/#/projects/${projectId}/runs`);
        await pwExpect(page.locator(`[data-run="${job.id}"] .badge`, { hasText: "Nothing ran" })).toBeVisible();
    }, 60_000);

    it("says so when nothing is left to review", async () => {
        const v = new ReviewStore(platform.db).latest(tests["WEB-001"]!)!;
        const r = await server.inject({ method: "POST", url: `/api/tests/${tests["WEB-001"]}/review/1/approve`, headers: { "x-api-key": KEY }, payload: { seen: v.updatedAt } });
        expect(r.statusCode).toBe(200);
        await page.goto(`${BASE}/#/dashboard`);
        await pwExpect(page.getByRole("region", { name: "Drafts waiting for review" }).getByText("Nothing to review")).toBeVisible();
    });

    it("lets the project choose what needs approval, in Settings → Members", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/settings?section=members`);
        const card = page.getByRole("region", { name: "Review and approval" });
        await pwExpect(card.getByLabel(/Tests the AI writes/)).toBeChecked();
        await card.getByLabel(/Repairs after a failed run/).uncheck();
        await card.getByRole("button", { name: "Save" }).click();
        await pwExpect(card.getByText("Saved. It applies to changes from now on.")).toBeVisible();
        expect(new ReviewStore(platform.db).policy(projectId).healing).toBe(false);
    });
});
