/**
 * Round 20 screens end to end (UI2) against the REAL platform: CORE's application and activity routes, SIGN's saved sign-ins, sensitive
 * workflows and API documents, OPS's notification setting, FIND's report with `format=xlsx`. Driven through the screens only (the project
 * and a hand-entered finding are set up through the API to keep the run short; the round-18 test already makes a project in the UI and
 * runs a real assessment).
 *
 * No assessment runs here, so nothing is ever requested from the target address (127.0.0.1, allowed with SECURITY_ALLOW_PRIVATE_TARGETS).
 * Temp data directory only (never ./data); no external site, no model. Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-ui2-real.test.ts
 * Port: platform 7191 (UI2's range 7190-7209).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { securityStoreFor } from "../src/security/store.js";

const PORT = 7191;
const BASE = `http://127.0.0.1:${PORT}`;
const TARGET = "http://127.0.0.1:7192/";
const COOKIE_SENTINEL = "UI2-REAL-COOKIE-SENTINEL-9f8e";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dataDir: string;
let projectId: string;
const consoleErrors: string[] = [];

async function apiCall(method: string, url: string, body?: unknown) {
    const res = await fetch(`${BASE}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as any };
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-ui2-real-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "ui2-real-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", SECURITY_ALLOW_PRIVATE_TARGETS: "true" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = String(platform.repo.createProject({ name: "Umbrella" }).id);
    securityStoreFor(platform.db).setTestingType(projectId, "security");
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text()) && !/^Blocked script execution in 'about:srcdoc'/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close?.();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("round 20 screens against the real platform", () => {
    it("sign-in and sensitive workflows on registration, the statement, the API document, a saved sign-in, notifications, the Excel report and the activity", async () => {
        // Register with the project's own saved sign-in (none saved yet: the server says so) and a sensitive workflow.
        await page.goto(`${BASE}/#/projects/${projectId}/security/applications/new`);
        const form = page.getByTestId("sec-app-form");
        await form.getByLabel("Name", { exact: true }).fill("Umbrella portal");
        await form.getByLabel("Target address", { exact: true }).fill(TARGET);
        const signIn = form.getByLabel("Signed-in assessment (optional)", { exact: true });
        await pwExpect(signIn.locator("option", { hasText: "The project’s own sign-in" })).toHaveText("The project’s own sign-in, no saved sign-in yet");
        await signIn.selectOption("main");
        await pwExpect(page.getByTestId("sa-signin-warning")).toContainText("No sign-in is saved for the project's own account.");
        await form.locator("summary", { hasText: "Advanced" }).click();
        await form.getByRole("button", { name: "Add a sensitive workflow", exact: true }).click();
        await form.getByLabel("Workflow name").fill("Payments");
        await form.getByLabel("Paths never requested").fill("/checkout/pay");
        await form.getByLabel("Workflow note (optional)").fill("Real card payments");
        await form.getByRole("button", { name: "Register application", exact: true }).click();

        // The server's statement names the workflow and the sign-in; the detail page shows both.
        await pwExpect(page.getByTestId("sec-auth-form")).toBeVisible();
        await pwExpect(page.getByTestId("sec-statement")).toContainText("Sensitive workflows, never requested: Payments (/checkout/pay).");
        await pwExpect(page.getByTestId("sec-statement")).toContainText("It visits signed in with the saved sign-in of the project's own account");
        await pwExpect(page.getByTestId("sa-sensitive")).toContainText("Payments: /checkout/pay. Real card payments");
        await pwExpect(page.getByTestId("sa-signin")).toContainText("The project’s own sign-in");
        const appId = new URL(page.url().replace("#/", "")).pathname.split("/").at(-1)!;
        const stored = securityStoreFor(platform.db).getApplication(appId)!;
        expect(stored.signInAccount).toBe("main");
        expect(stored.sensitiveWorkflows).toEqual([{ name: "Payments", pathPrefixes: ["/checkout/pay"], note: "Real card payments" }]);
        const auth = page.getByTestId("sec-auth-form");
        await auth.getByLabel("Approved by").fill("Alice Client");
        await auth.getByRole("checkbox", { name: /I confirm the statement above/ }).check();
        await auth.getByRole("button", { name: "Record authorization", exact: true }).click();
        await pwExpect(page.locator(".page-head")).toContainText("Authorized");

        // The API document, read by the real parser.
        const doc = { openapi: "3.0.0", info: { title: "Umbrella API", version: "1.4" }, paths: { "/health": { get: { responses: { "200": { description: "ok" } } } }, "/users/{id}": { get: { parameters: [{ name: "id", in: "path", required: true }], responses: { "200": { description: "ok" } } } }, "/orders": { post: { responses: { "201": { description: "made" } } } } } };
        const panel = page.getByTestId("sa-apidoc");
        await page.setInputFiles("#sa-apidoc-file", { name: "umbrella.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
        await panel.getByRole("button", { name: "Upload API document", exact: true }).click();
        await pwExpect(panel.getByTestId("sa-apidoc-summary")).toContainText("umbrella.json");
        await pwExpect(panel.getByTestId("sa-apidoc-summary")).toContainText("Umbrella API, version 1.4");
        await pwExpect(panel.getByTestId("sa-apidoc-summary")).toContainText("3 listed; 1 is a GET without required parameters");

        // A saved sign-in uploaded from a file: the state comes back in words; the cookie's value never reaches the page.
        const sp = page.getByTestId("sa-signin-panel");
        await pwExpect(sp.getByTestId("sa-signin-status")).toContainText("No sign-in is saved for the project's own account.");
        await sp.locator("summary", { hasText: "Upload a saved sign-in from a file" }).click();
        const state = { cookies: [{ name: "session", value: COOKIE_SENTINEL, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] };
        await page.setInputFiles("#sa-signin-file", { name: "state.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(state)) });
        await sp.getByRole("button", { name: "Save the sign-in", exact: true }).click();
        await pwExpect(sp.getByRole("status")).toContainText("The assessment loads the saved sign-in for the project's own account");
        expect(await page.locator("body").innerText()).not.toContain(COOKIE_SENTINEL);

        // Notifications: every finish on; the real setting changes.
        await page.getByRole("navigation", { name: "Security assessment sections" }).getByRole("link", { name: "Notifications", exact: true }).click();
        await pwExpect(page.getByText("No alert channels yet", { exact: true })).toBeVisible();
        await page.getByRole("checkbox", { name: /Every assessment that ends/ }).check();
        await page.getByRole("button", { name: "Save notification settings", exact: true }).click();
        await pwExpect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
        expect((await apiCall("GET", `/api/v1/security/projects/${projectId}/notifications`)).body.settings).toEqual({ newCriticalHigh: true, failed: true, everyFinish: true, channelIds: null });

        // A finding entered by hand (through the API), then the Excel report downloaded from the Reports page and read back.
        const manual = await apiCall("POST", `/api/v1/security/applications/${appId}/findings`, { title: "=HYPERLINK(\"http://evil.test\")", category: "tls", severity: "high", location: "127.0.0.1:443", description: "The client's scanner reports TLS 1.0.", impact: "Old versions are weak.", remediation: "Turn off TLS 1.0." });
        expect(manual.status).toBe(201);
        await page.getByRole("navigation", { name: "Security assessment sections" }).getByRole("link", { name: "Reports", exact: true }).click();
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download as Excel", exact: true }).click()]);
        expect(download.suggestedFilename()).toMatch(/^security-report-umbrella-\d{4}-\d{2}-\d{2}\.xlsx$/);
        const files = unzipSync(new Uint8Array(fs.readFileSync((await download.path())!)));
        expect(strFromU8(files["xl/workbook.xml"]!)).toMatch(/<sheet name="Summary"[^>]*\/><sheet name="Findings"/);
        const findings = strFromU8(files["xl/worksheets/sheet2.xml"]!);
        expect(findings).toContain(`<t xml:space="preserve">=HYPERLINK(&quot;http://evil.test&quot;)</t>`);
        expect(findings).not.toMatch(/<f[\s>]/);
        const summary = strFromU8(files["xl/worksheets/sheet1.xml"]!);
        expect(summary).toContain("Authorized by Alice Client");
        expect(summary).toContain("Sensitive workflow, never requested: Payments (/checkout/pay): Real card payments");
        expect(summary).toContain("Signed in with: the saved sign-in of the project's own account");
        expect(summary).toContain("API document: umbrella.json, 3 operations, of which 1 GET");
        expect(summary).not.toContain(COOKIE_SENTINEL);

        // Every step is in the project's security activity.
        await page.getByRole("navigation", { name: "Security assessment sections" }).getByRole("link", { name: "Activity", exact: true }).click();
        const act = page.getByTestId("sec-activity");
        await pwExpect(act).toContainText("Exported the project's security report as XLSX");
        await pwExpect(act).toContainText("Uploaded the API document “umbrella.json”");
        await pwExpect(act).toContainText("Saved a sign-in for");
        await pwExpect(act).toContainText("Changed the assessment messages");
        await pwExpect(act).toContainText("Recorded");
        // Reports: the HTML shown on the Reports page counts as an export too, then the workbook (newest first).
        await page.getByLabel("What", { exact: true }).selectOption("report");
        await pwExpect(act.locator("li")).toHaveCount(2);
        await pwExpect(act.locator("li").first()).toContainText("as XLSX");
        await pwExpect(act.locator("li").nth(1)).toContainText("as HTML");
        expect(await page.locator("body").innerText()).not.toContain(COOKIE_SENTINEL);

        expect(consoleErrors).toEqual([]);
    }, 240_000);
});
