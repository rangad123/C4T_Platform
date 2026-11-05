/**
 * The Schedule tab in a real browser: create a schedule, add a webhook channel and send a test message,
 * press "Run now", and watch the run and the trend appear. The platform, worker, fixture application and
 * webhook receiver are all real and local. Requires `npm run build:web`; runs a browser, so use the lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/schedules-ui.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const FIXTURE_PORT = 5252;
const RECEIVER_PORT = 5253;
const PLATFORM_PORT = 5254;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;

let browser: Browser;
let page: Page;
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;
const fixture = http.createServer((req, res) => {
    res.writeHead(req.url?.startsWith("/api/") ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
});
const received: any[] = [];
const receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200).end("ok");
    });
});

const post = async (url: string, body: unknown) => (await fetch(BASE + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    await Promise.all([new Promise<void>((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r)), new Promise<void>((r) => receiver.listen(RECEIVER_PORT, "127.0.0.1", r))]);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-schedui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2" }));
    const svc = getScheduleServices(platform, { delivery: { backoffMs: [20], timeoutMs: 2_000 } });
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();

    // A project with two tests that have been run once.
    projectId = (await post("/api/projects", { name: "Tracked shop" })).id;
    const spec = (title: string, p: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: p }, { action: "assertResponse", check: "status", expected: 200 }] });
    const imp = await post(`/api/projects/${projectId}/specs`, { baseUrl: `http://127.0.0.1:${FIXTURE_PORT}`, specs: [spec("Stable endpoint answers", "/api/stable"), spec("Other endpoint answers", "/api/other")] });
    await waitForJob(imp.jobId);
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    fixture.close();
    receiver.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function waitForJob(jobId: string) {
    for (let i = 0; i < 300; i++) {
        const j = (await (await fetch(`${BASE}/api/test-generation/${jobId}`)).json()) as { status: string };
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) {
            // the run summary is written by the worker just after the status
            await new Promise((r) => setTimeout(r, 400));
            return;
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("job did not finish");
}

describe("Schedule tab", () => {
    it("starts empty, with the project's first run already in the trend", async () => {
        // The old Schedule tab is three sections now: schedules and run sequences (Runs), alerts (Settings), trend and unreliable tests (Runs > Trends).
        await page.goto(`${BASE}/#/projects/${projectId}/schedule`); // an old address still lands on Runs > Schedules
        await pwExpect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
        await pwExpect(page.getByText("Nothing is scheduled yet")).toBeVisible();
        await page.goto(`${BASE}/#/projects/${projectId}/settings?section=alerts`);
        await pwExpect(page.getByText("No alerts set up")).toBeVisible();
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=trends`);
        await pwExpect(page.getByText("No unreliable tests found")).toBeVisible();
        await pwExpect(page.getByRole("img", { name: /Pass rate over the last 1 run/ })).toBeVisible();
        await pwExpect(page.locator(".metric", { hasText: "Runs" })).toContainText("1");
        await pwExpect(page.locator(".metric", { hasText: "Latest pass rate" })).toContainText("100%");
    });

    it("creates a schedule from plain choices", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=schedules`);
        await page.getByRole("button", { name: "New schedule" }).click();
        const form = page.getByRole("form", { name: "New schedule" });
        await pwExpect(form.getByText("Re-run all tests every day at 02:00")).toBeVisible();
        await form.getByLabel("How often").selectOption("weekly");
        await form.getByLabel("Day of the week").selectOption("5");
        await form.getByLabel("Time of day").fill("17:45");
        await pwExpect(form.getByText("Re-run all tests every Friday at 17:45")).toBeVisible();
        await form.getByLabel("How often").selectOption("daily");
        await form.getByLabel("Time of day").fill("02:00");
        await form.getByRole("button", { name: "Create schedule" }).click();

        const row = page.locator("[data-schedule]");
        await pwExpect(row).toContainText("Re-run all tests · every day at 02:00");
        await pwExpect(row).toContainText("Active");
        await pwExpect(row).toContainText(/Next run: (Today|Tomorrow) at 02:00/);
        await pwExpect(row).toContainText("Last run: never");
        await pwExpect(page.getByText(/Times are server time/)).toBeVisible();
    });

    it("offers Explore again only to a project that explores", async () => {
        const kind = page.getByRole("form", { name: "New schedule" }).getByLabel("What should run");
        await page.getByRole("button", { name: "New schedule" }).click();
        await pwExpect(kind.locator("option[value=generate]")).toHaveCount(1);
        platform.repo.updateProject(projectId, { testingModes: ["code"] });
        try {
            await page.goto("about:blank");
            await page.goto(`${BASE}/#/projects/${projectId}/runs?section=schedules`);
            await page.getByRole("button", { name: "New schedule" }).click();
            await pwExpect(kind.locator("option[value=validate]")).toHaveCount(1);
            await pwExpect(kind.locator("option[value=generate]")).toHaveCount(0);
        } finally {
            platform.repo.updateProject(projectId, { testingModes: ["agent", "code"] });
            await page.goto("about:blank");
        }
    });

    it("adds a webhook channel and sends a test message that really arrives", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/settings?section=alerts`);
        await page.getByRole("button", { name: "Add a channel" }).click();
        const form = page.getByRole("form", { name: "Add an alert channel" });
        await form.getByLabel("Send alerts to").selectOption("webhook");
        await form.getByLabel("Webhook URL").fill(`http://127.0.0.1:${RECEIVER_PORT}/hooks/secret-path-123`);
        await form.getByRole("button", { name: "Add channel" }).click();

        const channel = page.locator("[data-channel]");
        await pwExpect(channel).toContainText(`127.0.0.1:${RECEIVER_PORT}`);
        await pwExpect(channel.getByText(/secret-path-123/)).toHaveCount(0); // the address is never shown again
        await channel.getByRole("button", { name: /Send a test message/ }).click();
        await pwExpect(channel.getByText(/Test message delivered \(the receiver answered 200\)/)).toBeVisible();
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ event: "test", test: true, project: { name: "Tracked shop" } });
        await pwExpect(page.getByText("Test message", { exact: true })).toBeVisible(); // in "Recent alerts"
        await pwExpect(page.getByText("Delivered", { exact: true })).toBeVisible();
    });

    it("Run now starts a real run; the run and the trend appear when it finishes", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=schedules`);
        await page.getByRole("button", { name: /Run now/ }).click();
        await pwExpect(page.getByText(/Run started/)).toBeVisible();
        // finished: the schedule says when it last ran, and the trend (Runs > Trends) now has a second run, labelled as scheduled
        await pwExpect(page.locator("[data-schedule]")).toContainText(/Last run: (just now|[0-9]+ min ago)/, { timeout: 90_000 });
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=trends`);
        await pwExpect(page.locator(".metric", { hasText: "Runs" })).toContainText("2", { timeout: 90_000 });
        await pwExpect(page.getByRole("img", { name: /Pass rate over the last 2 runs/ })).toBeVisible();
        await pwExpect(page.locator(".list-row", { hasText: "2 of 2 tests passed" }).filter({ hasText: "Scheduled" })).toHaveCount(1);

        // and the Runs tab says which run was scheduled
        await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Runs", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
        await pwExpect(page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Run", exact: true }) }).getByText("Scheduled", { exact: true })).toHaveCount(1);
    });

    it("works on a phone-sized screen without sideways scrolling", async () => {
        await page.setViewportSize({ width: 390, height: 800 });
        await page.goto(`${BASE}/#/projects/${projectId}/schedule`);
        await pwExpect(page.getByRole("heading", { name: "Scheduled runs" })).toBeVisible();
        const wide = await page.evaluate(() =>
            Array.from(document.querySelectorAll(".content *"))
                .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs"))
                .slice(0, 5)
                .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
        );
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect({ overflow, wide }).toEqual({ overflow: 0, wide: [] });
    });
});
