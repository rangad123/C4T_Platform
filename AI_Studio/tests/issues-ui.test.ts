/**
 * Browser journey for the issue tracker: connect GitHub (wrong token first), test the connection, create an
 * issue from a finding on the test page, see the linked-issue chip, remove the connection.
 * The platform is real (HTTP server, SQLite, built UI); GitHub is a local mock of its REST API.
 * Requires `npm run build:web`; run inside the `browser` lock.
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
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { buildServer } from "../src/platform/server.js";

const PLATFORM_PORT = 5280;
const GITHUB_PORT = 5281;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const TOKEN = "ghp_uiJourneyTokenForTests0000";

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let github: http.Server;
let dataDir: string;
let projectId = "";
let testId = "";
const created: any[] = [];
/** Set ISSUES_UI_SHOTS=<folder> to keep screenshots of the journey for a visual check. */
const shot = async (name: string) => {
    if (process.env.ISSUES_UI_SHOTS) await page.screenshot({ path: path.join(process.env.ISSUES_UI_SHOTS, `${name}.png`), fullPage: true });
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: run the web build first");
    github = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            const send = (code: number, obj: unknown) => {
                res.writeHead(code, { "content-type": "application/json" });
                res.end(JSON.stringify(obj));
            };
            if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "Bad credentials" });
            if (req.method === "GET" && req.url === "/repos/acme/shop") return send(200, { full_name: "acme/shop", has_issues: true });
            if (req.method === "POST" && req.url === "/repos/acme/shop/issues") {
                created.push(JSON.parse(raw));
                return send(201, { number: created.length, html_url: `https://github.example/acme/shop/issues/${created.length}` });
            }
            send(404, { message: "Not Found" });
        });
    });
    await new Promise<void>((r) => github.listen(GITHUB_PORT, "127.0.0.1", r));

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-issues-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });

    // One finding to file an issue about (written directly: this test is about the tracker UI, not about running tests).
    const { repo } = platform;
    projectId = repo.createProject({ name: "Shop" }).id as string;
    repo.createApplication(projectId, "https://shop.example.test", {});
    const spec = TestSpecSchema.parse({
        testId: "API-001",
        title: "Cart loads for a signed-in shopper",
        kind: "api",
        category: "Checkout",
        priority: "high",
        steps: [
            { action: "request", method: "GET", path: "/api/cart" },
            { action: "assertResponse", check: "statusBelow", expected: 500 },
        ],
    });
    testId = repo.insertTest({ projectId, suiteId: repo.getOrCreateSuite(projectId, "Checkout", "checkout"), jobId: null, spec, framework: "playwright-api", validationStatus: "NEEDS_REVIEW" });
    repo.updateTest(testId, { validationStatus: "NEEDS_REVIEW", reason: "Server error: GET /api/cart returned 503." });
    repo.addExecution({ testId, scriptId: null, jobId: null, attempt: 1, status: "failed", durationMs: 90, startedAt: new Date().toISOString(), steps: [{ index: 0, title: "GET /api/cart", status: "passed" }, { index: 1, title: "Verify", status: "failed", error: "503" }] });

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
}, 60_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    github?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("issue tracker journey", () => {
    it("connects GitHub, tests the connection, creates an issue from a finding, and shows the link", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/tests`);
        await page.getByRole("navigation", { name: "Project sections", exact: true }).getByRole("link", { name: "Settings", exact: true }).click();
        await page.getByRole("link", { name: "Issue tracker", exact: true }).click();

        const panel = page.getByRole("region", { name: "Issue tracker" });
        await pwExpect(panel.getByRole("heading", { name: "Issue tracker" })).toBeVisible();
        await pwExpect(panel.getByText("Nothing connected yet")).toBeVisible();
        await shot("panel-empty");
        await panel.getByRole("button", { name: "Connect an issue tracker" }).click();

        // The Connect button waits until the needed fields are filled in.
        const connect = panel.getByRole("button", { name: "Connect", exact: true });
        await pwExpect(connect).toBeDisabled();
        await panel.getByLabel("Repository").fill("https://github.com/acme/shop");
        await panel.getByLabel("Access token").fill("ghp_notTheRightToken");
        await panel.getByText("GitHub Enterprise Server").click();
        await panel.getByLabel("API address").fill(`http://127.0.0.1:${GITHUB_PORT}`);
        await connect.click();
        // A wrong token is explained in plain words, and the secret is not echoed.
        await pwExpect(panel.getByRole("alert")).toContainText("did not accept the token");
        await shot("panel-error");
        await pwExpect(panel.getByRole("alert")).not.toContainText("ghp_notTheRightToken");

        await panel.getByLabel("Access token").fill(TOKEN);
        await connect.click();
        await pwExpect(panel.getByRole("list", { name: "Connected issue trackers" })).toContainText("GitHub acme/shop");

        await panel.getByRole("button", { name: "Test connection" }).click();
        await pwExpect(panel.getByRole("status")).toContainText("Connected to acme/shop");
        await shot("panel-connected");
        expect(await page.content()).not.toContain(TOKEN);

        // The finding's page: create the issue
        await page.goto(`${BASE}/#/projects/${projectId}/tests`);
        await page.getByRole("link", { name: /Cart loads for a signed-in shopper/ }).click();
        const section = page.getByRole("region", { name: "Issue tracker" });
        await pwExpect(section).toBeVisible();
        await section.getByRole("button", { name: "Create issue" }).click();

        const chip = section.getByRole("link", { name: /GitHub #1/ });
        await pwExpect(chip).toBeVisible();
        await shot("test-page");
        await pwExpect(chip).toHaveAttribute("href", "https://github.example/acme/shop/issues/1");
        await pwExpect(chip).toHaveAttribute("target", "_blank");
        // creating is one click, once: the button is gone and nothing else was sent
        await pwExpect(section.getByRole("button", { name: /Create issue/ })).toHaveCount(0);
        expect(created).toHaveLength(1);
        expect(created[0].title).toBe("[High] Cart loads for a signed-in shopper");
        expect(created[0].labels).toContain("ai-testing");
        expect(created[0].body).toContain(`${BASE}/#/tests/${testId}`);

        // still there after a reload
        await page.reload();
        await pwExpect(page.getByRole("region", { name: "Issue tracker" }).getByRole("link", { name: /GitHub #1/ })).toBeVisible();
        await pwExpect(page.getByRole("region", { name: "Issue tracker" }).getByText("An issue has been created in every connected tracker.")).toBeVisible();
    }, 120_000);

    it("removes the connection but keeps the record of issues already created", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/tests`);
        await page.getByRole("navigation", { name: "Project sections", exact: true }).getByRole("link", { name: "Settings", exact: true }).click();
        await page.getByRole("link", { name: "Issue tracker", exact: true }).click();
        const panel = page.getByRole("region", { name: "Issue tracker" });
        await panel.getByRole("button", { name: "Remove GitHub acme/shop" }).click();
        await pwExpect(panel.getByText("Issues already created stay where they are")).toBeVisible();
        await panel.getByRole("button", { name: "Yes, remove" }).click();
        await pwExpect(panel.getByText("Nothing connected yet")).toBeVisible();

        await page.goto(`${BASE}/#/tests/${testId}`);
        const section = page.getByRole("region", { name: "Issue tracker" });
        await pwExpect(section.getByRole("link", { name: /GitHub #1/ })).toBeVisible();
        await pwExpect(section.getByText(/No issue tracker is connected now/)).toBeVisible();
    }, 60_000);

    it("works on a phone-sized screen without sideways scrolling", async () => {
        await page.setViewportSize({ width: 390, height: 800 });
        await page.goto(`${BASE}/#/projects/${projectId}/tests`);
        await page.getByRole("navigation", { name: "Project sections", exact: true }).getByRole("link", { name: "Settings", exact: true }).click();
        await page.getByRole("link", { name: "Issue tracker", exact: true }).click();
        await pwExpect(page.getByRole("region", { name: "Issue tracker" })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
    }, 60_000);
});
