/**
 * Security Assessment end to end (round 18, UI): the real platform (real routes of CORE, RUN and FIND, the real assessment loop with a real
 * headless Chromium) and the local security fixture application (tests/fixtures/security-fixture-app.ts, made by RUN), driven only through the
 * screens: make a security project, register the application, record the authorization, run a passive assessment, read the findings, change
 * one's state with a reason, read and download the report. Proves the screens and the real API agree on every shape the screens use.
 *
 * Temp data directory only (never ./data); SECURITY_ALLOW_PRIVATE_TARGETS=true because the fixture listens on 127.0.0.1; no external site,
 * no model. Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-ui-real.test.ts
 * Ports: platform 7071, fixture 7072, its out-of-scope "outside" server 7073 (UI builder's range 7070-7089).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { startSecurityFixture, type SecurityFixture } from "./fixtures/security-fixture-app.js";

const PORT = 7071;
const BASE = `http://127.0.0.1:${PORT}`;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let fixture: SecurityFixture;
let browser: Browser;
let page: Page;
let dataDir: string;
const consoleErrors: string[] = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    fixture = await startSecurityFixture(7072, 7073);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-ui-real-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", SECURITY_ALLOW_PRIVATE_TARGETS: "true", SECURITY_ASSESSMENT_MINUTES: "3" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
    page.on("console", (m) => {
        // The report is shown in a frame sandboxed so that nothing runs in it; Playwright's frame queries trip that, as intended.
        if (m.type() === "error" && !/Failed to load resource/.test(m.text()) && !/^Blocked script execution in 'about:srcdoc'/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close?.();
    await fixture?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Security Assessment through the screens, against the real platform and the fixture application", () => {
    it("project, application, authorization, a real passive assessment, findings, a state change and the report", async () => {
        await page.goto(`${BASE}/#/new`);
        const sidebar = page.getByRole("complementary", { name: "Main navigation" });
        // Round 37: Security assessment is no longer in the left panel; the module is on, so a project can still include it.
        await pwExpect(page.getByTestId("testing-type")).toBeVisible();
        expect(await sidebar.getByRole("link", { name: "Security assessment", exact: true }).count()).toBe(0);
        await page.getByTestId("testing-type").getByRole("radio", { name: /Security assessment/ }).check();
        await page.getByLabel("Project name", { exact: true }).fill("Fixture client");
        await page.getByRole("button", { name: "Create project", exact: true }).click();

        // Register the application: the fixture, with the billing area excluded.
        const form = page.getByTestId("sec-app-form");
        await pwExpect(form).toBeVisible();
        await form.getByLabel("Name", { exact: true }).fill("Fixture shop");
        await form.getByLabel("Target address", { exact: true }).fill(fixture.origin);
        await form.getByLabel("Environment", { exact: true }).selectOption("development");
        await form.locator("summary", { hasText: "Advanced" }).click();
        await form.getByLabel("Never request these paths").fill("/admin/billing");
        await form.getByLabel("Most requests per second").fill("10");
        await form.getByRole("button", { name: "Register application", exact: true }).click();

        // The authorization step, with the server's own statement.
        const auth = page.getByTestId("sec-auth-form");
        await pwExpect(auth).toBeVisible();
        await pwExpect(page.getByTestId("sec-statement")).toContainText("I confirm that Fixture client owns");
        await pwExpect(page.locator(".page-head")).toContainText("Not authorized yet");
        await auth.getByLabel("Approved by").fill("Dana Client");
        await auth.getByLabel("Their email (optional)").fill("dana@client.example");
        await auth.getByRole("checkbox", { name: /I confirm the statement above/ }).check();
        await auth.getByRole("button", { name: "Record authorization", exact: true }).click();
        await pwExpect(page.locator(".page-head")).toContainText("Authorized");

        // Start a real passive assessment and watch it finish.
        await page.getByRole("link", { name: "New assessment", exact: true }).first().click();
        await pwExpect(page.getByTestId("na-limits")).toContainText("/admin/billing");
        await page.getByRole("button", { name: "Start assessment", exact: true }).click();
        await pwExpect(page).toHaveURL(/\/security\/assessments\/[^/?]+$/);
        const outcome = page.locator(".callout").filter({ hasText: /Every step finished|Some steps did not finish/ });
        await pwExpect(outcome).toBeVisible({ timeout: 150_000 });
        const cov = page.getByTestId("sec-coverage");
        await pwExpect(cov).toBeVisible();

        // The fixture's deliberate problems are listed as findings; nothing out of scope or excluded was requested.
        await page.getByRole("link", { name: "See findings", exact: true }).click();
        const list = page.getByTestId("sec-findings");
        await pwExpect(list).toBeVisible();
        await pwExpect(list).toContainText("Content-Security-Policy header missing");
        await pwExpect(list).toContainText(/Sensitive file publicly readable/);
        expect(fixture.outsideRequests).toEqual([]);
        expect(fixture.requests.filter((r) => r.path.startsWith("/admin/billing"))).toEqual([]);
        expect(fixture.requests.filter((r) => r.method === "POST")).toEqual([]);

        // Filter by category, open one, change its state with a reason.
        await page.getByLabel("Category", { exact: true }).selectOption("exposed-files");
        await pwExpect(list.locator("li")).not.toHaveCount(0);
        await list.getByRole("link").first().click();
        await pwExpect(page.getByTestId("fd-evidence")).toBeVisible();
        // The fake values of the fixture's .env never reach the page.
        expect(await page.locator(".content").innerText()).not.toMatch(/fake-db-password-123|fake0token0abcdef0123456789/);
        const v = page.getByTestId("fd-validation");
        await v.getByLabel("Change the state to").selectOption("confirmed");
        await v.getByLabel("Why").fill("Opened it in a browser: the file is readable.");
        await v.getByRole("button", { name: "Save state", exact: true }).click();
        await pwExpect(v.getByRole("status")).toHaveText("Saved as confirmed.");
        await pwExpect(page.getByTestId("fd-history")).toContainText("“Opened it in a browser: the file is readable.”");

        // The overview counts it; the report shows in the page and downloads as CSV.
        await page.getByRole("navigation", { name: "Security assessment sections" }).getByRole("link", { name: "Overview", exact: true }).click();
        await pwExpect(page.getByTestId("sec-metrics")).toContainText("1Application assessed");
        await pwExpect(page.getByTestId("sec-risk")).toBeVisible();
        await page.getByRole("navigation", { name: "Security assessment sections" }).getByRole("link", { name: "Reports", exact: true }).click();
        await pwExpect(page.frameLocator('[data-testid="sec-report-frame"]').locator("body")).toContainText("Fixture shop", { timeout: 30_000 });
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download findings as CSV", exact: true }).click()]);
        expect(download.suggestedFilename()).toMatch(/\.csv$/);
        const csv = fs.readFileSync((await download.path())!, "utf8");
        expect(csv).toContain("Content-Security-Policy header missing");
        expect(csv).not.toMatch(/fake-db-password-123|fake0token0abcdef0123456789/);

        expect(consoleErrors).toEqual([]);
    }, 300_000);
});
