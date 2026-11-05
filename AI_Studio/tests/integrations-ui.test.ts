/**
 * Browser journey for Notion and Sentry: connect Notion as an issue tracker (a wrong token first), connect Sentry (read-only),
 * create a Notion page from a failed test, and see "Related errors in Sentry" on that test's page (with an empty and a failed
 * lookup too). The platform is real (HTTP server, SQLite, built UI); Notion and Sentry are local receivers shaped like their APIs.
 * Requires the web build; run inside the `browser` lock.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PLATFORM_PORT = 5735;
const NOTION_PORT = 5736;
const SENTRY_PORT = 5737;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const NOTION_TOKEN = "secret_uiJourneyNotionToken000000";
const SENTRY_TOKEN = "sntrys_uiJourneySentryToken0000000";
const DB = "a1b2c3d4-e5f6-4789-8abc-0123456789ab";

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let notion: http.Server;
let sentry: http.Server;
let dataDir: string;
let projectId = "";
let otherProjectId = "";
let testId = "";
let otherTestId = "";
const pages: any[] = [];
let runStart = new Date();
let sentryMode: "issues" | "empty" | "denied" = "issues";
const shot = async (name: string) => {
    if (process.env.INTEGRATIONS_UI_SHOTS) await page.screenshot({ path: path.join(process.env.INTEGRATIONS_UI_SHOTS, `${name}.png`), fullPage: true });
};
const json = (res: http.ServerResponse, code: number, obj: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
const iso = (ms: number) => new Date(runStart.getTime() + ms).toISOString();

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: run the web build first");
    notion = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            if (req.headers.authorization !== `Bearer ${NOTION_TOKEN}`) return json(res, 401, { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." });
            if (req.method === "GET" && req.url === `/v1/databases/${DB}`) return json(res, 200, { object: "database", title: [{ plain_text: "QA findings" }], properties: { Name: { type: "title" } } });
            if (req.method === "POST" && req.url === "/v1/pages") {
                pages.push(JSON.parse(raw));
                return json(res, 200, { object: "page", id: "p", url: `https://www.notion.so/Finding-${pages.length}` });
            }
            json(res, 404, { object: "error", status: 404, code: "object_not_found", message: "not found" });
        });
    });
    sentry = http.createServer((req, res) => {
        if (req.headers.authorization !== `Bearer ${SENTRY_TOKEN}`) return json(res, 401, { detail: "Invalid token" });
        if (/^\/api\/0\/projects\/acme\/shop\/$/.test(req.url!)) return json(res, 200, { slug: "shop", name: "Shop (web)" });
        if (/^\/api\/0\/projects\/acme\/shop\/issues\//.test(req.url!)) {
            if (sentryMode === "denied") return json(res, 401, { detail: "Invalid token" });
            if (sentryMode === "empty") return json(res, 200, []);
            return json(res, 200, [
                { id: "101", title: "TypeError: cart is undefined", culprit: "GET /api/cart", level: "error", count: "40", firstSeen: iso(40_000), lastSeen: iso(50_000), permalink: "https://acme.sentry.example/issues/101/", stacktrace: "STACKTRACE-SENTINEL", user: { email: "person@private.example" } },
                { id: "102", title: "Slow query", culprit: "db.query", level: "warning", count: 3, firstSeen: iso(-3_600_000), lastSeen: iso(5000), permalink: "https://acme.sentry.example/issues/102/" },
            ]);
        }
        json(res, 404, { detail: "not found" });
    });
    await new Promise<void>((r) => notion.listen(NOTION_PORT, "127.0.0.1", r));
    await new Promise<void>((r) => sentry.listen(SENTRY_PORT, "127.0.0.1", r));

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-integrations-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });

    // Failed tests written directly: this test is about the integrations UI, not about running tests.
    const { repo } = platform;
    runStart = new Date(Date.now() - 5 * 60_000);
    const seed = (project: string) => {
        const spec = TestSpecSchema.parse({ testId: "API-001", title: "Cart loads for a signed-in shopper", kind: "api", category: "Checkout", priority: "high", steps: [{ action: "request", method: "GET", path: "/api/cart" }, { action: "assertResponse", check: "statusBelow", expected: 500 }] });
        const id = repo.insertTest({ projectId: project, suiteId: repo.getOrCreateSuite(project, "Checkout", "checkout"), jobId: null, spec, framework: "playwright-api", validationStatus: "NEEDS_REVIEW" });
        repo.updateTest(id, { validationStatus: "NEEDS_REVIEW", reason: "Server error: GET /api/cart returned 503." });
        repo.addExecution({ testId: id, scriptId: null, jobId: null, attempt: 1, status: "failed", durationMs: 60_000, startedAt: runStart.toISOString(), steps: [{ index: 0, title: "GET /api/cart", status: "passed" }, { index: 1, title: "Verify", status: "failed", error: "503" }] });
        return id;
    };
    projectId = repo.createProject({ name: "Shop" }).id as string;
    repo.createApplication(projectId, "https://shop.example.test", {});
    testId = seed(projectId);
    otherProjectId = repo.createProject({ name: "Second shop" }).id as string;
    repo.createApplication(otherProjectId, "https://other.example.test", {});
    otherTestId = seed(otherProjectId);

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
}, 60_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    notion?.close();
    sentry?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const openPanel = async () => {
    await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
    await page.getByRole("navigation", { name: "Project sections", exact: true }).getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Issue tracker", exact: true }).click();
    return page.getByRole("region", { name: "Issue tracker" });
};

describe("Notion and Sentry journey", () => {
    it("connects Notion from a pasted link (a wrong token first) and checks the connection", async () => {
        const panel = await openPanel();
        await panel.getByRole("button", { name: "Connect an issue tracker" }).click();
        await panel.getByRole("button", { name: "Notion", exact: true }).click();

        const connect = panel.getByRole("button", { name: "Connect", exact: true });
        await pwExpect(connect).toBeDisabled();
        await panel.getByLabel("Notion database").fill(`https://www.notion.so/yourteam/QA-findings-${DB.replace(/-/g, "")}?v=${"f".repeat(32)}`);
        await panel.getByLabel("Notion integration token").fill("secret_notTheRightToken");
        await panel.getByText("Reaching Notion through a proxy").click();
        await panel.getByLabel("Notion address").fill(`http://127.0.0.1:${NOTION_PORT}`);
        await connect.click();
        await pwExpect(panel.getByRole("alert")).toContainText("Notion didn’t accept the token");
        await pwExpect(panel.getByRole("alert")).not.toContainText("secret_notTheRightToken");
        await shot("notion-error");

        await panel.getByLabel("Notion integration token").fill(NOTION_TOKEN);
        await connect.click();
        const list = panel.getByRole("list", { name: "Connected issue trackers" });
        await pwExpect(list).toContainText("Notion database a1b2c3d4");
        await list.getByRole("button", { name: "Test connection" }).click();
        await pwExpect(list.getByRole("status")).toContainText("Connected to the Notion database “QA findings”.");
        await shot("notion-connected");
        expect(await page.content()).not.toContain(NOTION_TOKEN);
    }, 120_000);

    it("connects Sentry in the same panel (a wrong token first), read-only, and it does not become a tracker", async () => {
        const panel = await openPanel();
        const box = panel.getByRole("region", { name: "Sentry" });
        await pwExpect(box).toContainText("only read, never changed");
        await box.getByRole("button", { name: "Connect Sentry" }).click();

        const save = box.getByRole("button", { name: "Save Sentry connection" });
        await pwExpect(save).toBeDisabled();
        await box.getByLabel("Sentry organisation").fill("acme");
        await box.getByLabel("Sentry project").fill("shop");
        await box.getByLabel("Sentry auth token").fill("sntrys_notTheRightToken");
        await box.getByText("Self-hosted Sentry").click();
        await box.getByLabel("Sentry address").fill(`http://127.0.0.1:${SENTRY_PORT}`);
        await save.click();
        await pwExpect(box.getByRole("alert")).toContainText("Sentry didn’t accept the token");
        await pwExpect(box.getByRole("alert")).not.toContainText("sntrys_notTheRightToken");

        await box.getByLabel("Sentry auth token").fill(SENTRY_TOKEN);
        await save.click();
        await pwExpect(box).toContainText("Sentry acme/shop");
        await pwExpect(box).toContainText(`acme/shop on 127.0.0.1:${SENTRY_PORT}`);
        await box.getByRole("button", { name: "Test Sentry connection" }).click();
        await pwExpect(box.getByRole("status")).toContainText("Connected to the Sentry project Shop (web).");
        await shot("sentry-connected");
        expect(await page.content()).not.toContain(SENTRY_TOKEN);

        // Sentry is not in the list of issue trackers
        const list = panel.getByRole("list", { name: "Connected issue trackers" });
        await pwExpect(list.getByRole("listitem")).toHaveCount(1);
        await pwExpect(list).not.toContainText("Sentry");
    }, 120_000);

    it("creates a Notion page from the failed test and shows related errors in Sentry with the reason, as links out", async () => {
        await page.goto(`${BASE}/#/tests/${testId}`);
        const tracker = page.getByRole("region", { name: "Issue tracker" });
        await pwExpect(tracker).toBeVisible();
        // only one place to file the issue: Sentry is not offered
        await tracker.getByRole("button", { name: "Create issue" }).click();
        const chip = tracker.getByRole("link", { name: /Notion page/ });
        await pwExpect(chip).toBeVisible();
        await pwExpect(chip).toHaveAttribute("href", "https://www.notion.so/Finding-1");
        expect(pages).toHaveLength(1);
        expect(pages[0].parent).toEqual({ database_id: DB });
        expect(pages[0].properties.Name.title[0].text.content).toBe("[High] Cart loads for a signed-in shopper");

        const related = page.getByRole("region", { name: "Related errors in Sentry" });
        await pwExpect(related).toBeVisible();
        const items = related.getByRole("list", { name: "Errors that might be related" }).getByRole("listitem");
        await pwExpect(items).toHaveCount(2);
        const first = items.nth(0);
        await pwExpect(first).toContainText("TypeError: cart is undefined");
        await pwExpect(first).toContainText("First seen 40 seconds into the failed run and is reported at /api/cart, which failed in this run.");
        await pwExpect(first).toContainText("Error, 40 events");
        const link = first.getByRole("link", { name: /TypeError: cart is undefined/ });
        await pwExpect(link).toHaveAttribute("href", "https://acme.sentry.example/issues/101/");
        await pwExpect(link).toHaveAttribute("target", "_blank");
        await pwExpect(link).toHaveAttribute("rel", "noreferrer");
        await pwExpect(related).toContainText("might be related");
        await shot("test-page");
        // nothing but title, level, counts and times was fetched
        const text = await page.locator("body").innerText();
        expect(text).not.toContain("STACKTRACE-SENTINEL");
        expect(text).not.toContain("person@private.example");
        expect(await page.content()).not.toMatch(/caused by|root cause/i);
    }, 120_000);

    it("says plainly when nothing looks related, and when Sentry cannot be checked", async () => {
        sentryMode = "empty";
        await page.goto(`${BASE}/#/tests/${testId}`);
        const related = page.getByRole("region", { name: "Related errors in Sentry" });
        await related.getByRole("button", { name: "Check again" }).click();
        await pwExpect(related.getByText("Nothing in Sentry looks related")).toBeVisible();

        sentryMode = "denied";
        await related.getByRole("button", { name: "Check again" }).click();
        await pwExpect(related).toContainText("We couldn’t check Sentry");
        await pwExpect(related).toContainText("Sentry didn’t accept the token. Connect Sentry again with a new token.");
        await shot("test-page-sentry-error");
        sentryMode = "issues";
    }, 60_000);

    it("shows nothing about Sentry on a project that has not connected it", async () => {
        await page.goto(`${BASE}/#/tests/${otherTestId}`);
        await pwExpect(page.getByTestId("issue-empty")).toBeVisible();
        await page.waitForLoadState("networkidle");
        await pwExpect(page.getByRole("region", { name: "Related errors in Sentry" })).toHaveCount(0);
        expect(await page.locator("body").innerText()).not.toMatch(/sentry/i);
    }, 60_000);

    it("disconnects Sentry and the section disappears; Notion stays", async () => {
        const panel = await openPanel();
        const box = panel.getByRole("region", { name: "Sentry" });
        await box.getByRole("button", { name: /Disconnect Sentry/ }).click();
        await pwExpect(box.getByText("Your tests are not affected.")).toBeVisible();
        await box.getByRole("button", { name: "Yes, disconnect" }).click();
        await pwExpect(box.getByRole("button", { name: "Connect Sentry" })).toBeVisible();
        await pwExpect(panel.getByRole("list", { name: "Connected issue trackers" })).toContainText("Notion");

        await page.goto(`${BASE}/#/tests/${testId}`);
        await pwExpect(page.getByRole("region", { name: "Issue tracker" })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await pwExpect(page.getByRole("region", { name: "Related errors in Sentry" })).toHaveCount(0);
    }, 60_000);

    it("works on a phone-sized screen without sideways scrolling", async () => {
        await page.setViewportSize({ width: 390, height: 800 });
        for (const target of [`${BASE}/#/tests/${testId}`]) {
            await page.goto(target);
            await pwExpect(page.getByRole("region", { name: "Issue tracker" })).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
        }
        const panel = await openPanel();
        await panel.getByRole("button", { name: /Connect (an issue tracker|another)/ }).click();
        await panel.getByRole("button", { name: "Notion", exact: true }).click();
        await pwExpect(panel.getByRole("textbox", { name: "Notion database" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    }, 60_000);
});
