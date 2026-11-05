/**
 * Two screens in a real browser, against a real platform and local receivers:
 *  - Schedule tab → Alerts: add a Microsoft Teams channel and an email channel (plain fields, write-only secrets), send test
 *    messages that really arrive (a fake Teams webhook, a fake SMTP server);
 *  - Tests → More actions → Import Maestro flows: choose files, read what each becomes and why some are left out, import.
 * Requires the built UI; runs a browser, so use the lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/notify-import-ui.test.ts
 * Ports 5680 (platform), 5681 (Teams receiver), 5682 (SMTP).
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
import { parseMail, startFakeSmtp, type FakeSmtp } from "./fixtures/fake-smtp.js";

const PLATFORM_PORT = 5680;
const TEAMS_PORT = 5681;
const SMTP_PORT = 5682;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const SMTP_PASS = "UI-Sentinel-Smtp-Pw-77d2";

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;
let teams: http.Server;
let smtp: FakeSmtp;
const posted: any[] = [];

const LOGIN_FLOW = `appId: com.example.shop
name: Sign in shows the welcome screen
env:
  PASSWORD: never-copied-ui-value
---
- launchApp
- tapOn: "Email"
- inputText: "\${EMAIL}"
- tapOn: "Password"
- inputText: "\${PASSWORD}"
- tapOn: "Sign in"
- hideKeyboard
- assertVisible: "Welcome back"
`;
const CLICK_ONLY = `appId: com.example.shop
---
- launchApp
- tapOn: "Start"
`;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    teams = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            posted.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            res.writeHead(202).end("1");
        });
    });
    await new Promise<void>((r) => teams.listen(TEAMS_PORT, "127.0.0.1", r));
    smtp = await startFakeSmtp(SMTP_PORT);
    smtp.requireAuth = { user: "alerts-login", pass: SMTP_PASS };
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-notifyui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), WORKER_EMBEDDED: "false" }));
    getScheduleServices(platform, { delivery: { backoffMs: [20], timeoutMs: 3_000 } });
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    projectId = ((await (await fetch(`${BASE}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Notify shop" }) })).json()) as { id: string }).id;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    teams?.close();
    await smtp?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Alerts: Teams and email", () => {
    it("offers Teams and Email next to Slack and webhooks, and adds a Teams channel whose test message arrives", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/settings?section=alerts`);
        await pwExpect(page.getByText("No alerts set up")).toBeVisible();
        await page.getByRole("button", { name: "Add a channel" }).click();
        const form = page.getByRole("form", { name: "Add an alert channel" });
        const options = await form.getByLabel("Send alerts to").locator("option").allTextContents();
        expect(options).toEqual(["Slack (incoming webhook)", "Microsoft Teams (workflow webhook)", "Email", "Any web address (JSON webhook)"]);
        await form.getByLabel("Send alerts to").selectOption("teams");
        await form.getByLabel("Teams workflow URL").fill(`http://127.0.0.1:${TEAMS_PORT}/workflows/ui-secret-teams-path`);
        await form.getByRole("button", { name: "Add channel" }).click();

        const channel = page.locator("[data-channel]");
        await pwExpect(channel).toContainText("Teams");
        await pwExpect(channel).toContainText(`127.0.0.1:${TEAMS_PORT}`);
        await pwExpect(channel.getByText(/ui-secret-teams-path/)).toHaveCount(0);
        await channel.getByRole("button", { name: /Send a test message/ }).click();
        await pwExpect(channel.getByText(/Test message delivered \(the receiver answered 202\)/)).toBeVisible();
        expect(posted).toHaveLength(1);
        expect(posted[0].attachments[0]).toMatchObject({ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard" } });
    });

    it("adds an email channel with its own mail server; the password is write-only and the test email arrives", async () => {
        await page.getByRole("button", { name: "Add a channel" }).click();
        const form = page.getByRole("form", { name: "Add an alert channel" });
        await form.getByLabel("Send alerts to").selectOption("email");
        // the server has no mail settings, so the form asks for them right away
        await pwExpect(form.getByText("This server has no mail settings of its own, so the channel needs its own.")).toBeVisible();
        await form.getByLabel("Email addresses").fill("qa@example.test, lead@example.test");
        await form.getByLabel("Server", { exact: true }).fill("127.0.0.1");
        await form.getByLabel("Port", { exact: true }).fill(String(SMTP_PORT));
        await form.getByLabel("Send from").fill("alerts@platform.test");
        await form.getByLabel("User name (optional)").fill("alerts-login");
        const password = form.getByLabel("Password (optional)");
        await pwExpect(password).toHaveAttribute("type", "password");
        await password.fill(SMTP_PASS);
        await form.getByRole("button", { name: "Add channel" }).click();

        const channel = page.locator("[data-channel]").filter({ hasText: "Email to qa@example.test" });
        await pwExpect(channel).toContainText("qa@example.test, lead@example.test");
        await pwExpect(channel).toContainText("Mail server: 127.0.0.1 (own sign-in saved)");
        await channel.getByRole("button", { name: /Send a test message/ }).click();
        await pwExpect(channel.getByText("Test email sent. Check the inbox of the people listed.")).toBeVisible();
        expect(smtp.mails).toHaveLength(1);
        expect(smtp.mails[0]).toMatchObject({ from: "alerts@platform.test", to: ["qa@example.test", "lead@example.test"], pass: SMTP_PASS });
        expect(parseMail(smtp.mails[0]!.data).headers.subject).toBe("Test message: Notify shop");

        // write-only: the page, the channel list and the log never show the password or the user name
        await page.reload();
        await pwExpect(page.locator("[data-channel]").filter({ hasText: "Email to qa@example.test" })).toBeVisible();
        const text = (await page.locator("body").innerText()) + (await page.content());
        expect(text).not.toContain(SMTP_PASS);
        expect(text).not.toContain("alerts-login");
        const api = await (await fetch(`${BASE}/api/projects/${projectId}/alert-channels`)).text();
        expect(api).not.toContain(SMTP_PASS);
        expect(api).not.toContain("alerts-login");
    });

    it("says what went wrong when the mail server refuses, in plain words", async () => {
        smtp.requireAuth = { user: "alerts-login", pass: "changed-on-the-server" };
        const channel = page.locator("[data-channel]").filter({ hasText: "Email to qa@example.test" });
        await channel.getByRole("button", { name: /Send a test message/ }).click();
        await pwExpect(channel.getByText("Not delivered: The mail server refused the sign-in. Check the user name and password.")).toBeVisible();
        await pwExpect(page.getByText("Not delivered", { exact: true }).first()).toBeVisible();
    });

    it("works on a phone-sized screen without sideways scrolling", async () => {
        await page.setViewportSize({ width: 390, height: 800 });
        await page.goto(`${BASE}/#/projects/${projectId}/settings?section=alerts`);
        await page.getByRole("button", { name: "Add a channel" }).click();
        await page.getByRole("form", { name: "Add an alert channel" }).getByLabel("Send alerts to").selectOption("email");
        await pwExpect(page.getByLabel("Password (optional)")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBe(0);
        await page.setViewportSize({ width: 1200, height: 900 });
    });
});

describe("Import Maestro flows", () => {
    it("shows what each file becomes and why one is left out, then imports", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        await page.getByRole("menuitem", { name: "Import scripts…", exact: true }).click();
        await page.getByRole("dialog", { name: "Import tests", exact: true }).getByRole("button", { name: "Import Maestro flows", exact: true }).click();
        const panel = page.getByRole("region", { name: "Import Maestro flows" });
        await pwExpect(panel).toBeVisible();

        await panel.getByLabel("Maestro flow files").setInputFiles([
            { name: "login.yaml", mimeType: "text/yaml", buffer: Buffer.from(LOGIN_FLOW) },
            { name: "click-only.yaml", mimeType: "text/yaml", buffer: Buffer.from(CLICK_ONLY) },
        ]);
        const list = panel.getByRole("list", { name: "What each file becomes" });
        const login = list.locator('[data-flow="login.yaml"]');
        await pwExpect(login).toContainText("Mobile test");
        await pwExpect(login).toContainText("Sign in shows the welcome screen");
        await pwExpect(login).toContainText("1 check");
        await pwExpect(login).toContainText("1 left out");
        const clickOnly = list.locator('[data-flow="click-only.yaml"]');
        await pwExpect(clickOnly).toContainText("Left out");
        await pwExpect(clickOnly).toContainText("the test would only act and never verify anything");

        // the per-step reasons and the variables are one click away; values are never shown
        await login.getByText("Details for login.yaml").click();
        await pwExpect(login).toContainText("Step 7, hideKeyboard left out: This command is not supported by the importer yet.");
        await pwExpect(login).toContainText("EMAIL");
        await pwExpect(login).toContainText("{{credentials.password}}");
        expect(await page.content()).not.toContain("never-copied-ui-value");
        // nothing was stored by looking
        expect(((await (await fetch(`${BASE}/api/projects/${projectId}/tests`)).json()) as unknown[]).length).toBe(0);

        await panel.getByLabel("Run the tests right away").uncheck();
        await panel.getByRole("button", { name: "Import 1 test" }).click();
        await pwExpect(panel.getByText("Imported 1 test; 1 left out.")).toBeVisible();
        await pwExpect(page.getByText("Sign in shows the welcome screen").first()).toBeVisible();
        const tests = (await (await fetch(`${BASE}/api/projects/${projectId}/tests`)).json()) as Array<{ kind: string; title: string }>;
        expect(tests).toEqual([expect.objectContaining({ kind: "mobile", title: "Sign in shows the welcome screen" })]);
    });

    it("explains a file that is not valid YAML and lists it", async () => {
        const panel = page.getByRole("region", { name: "Import Maestro flows" });
        await panel.getByLabel("Maestro flow files").setInputFiles([{ name: "broken.yaml", mimeType: "text/yaml", buffer: Buffer.from("appId: [oops\n---\n- back") }]);
        await pwExpect(panel.getByText("Some files are not valid YAML. Fix them or leave them out and try again.")).toBeVisible();
        await pwExpect(panel.getByText(/broken\.yaml/)).toBeVisible();
        await pwExpect(panel.getByRole("button", { name: /^Import \d+ tests?$/ })).toHaveCount(0);
    });
});
