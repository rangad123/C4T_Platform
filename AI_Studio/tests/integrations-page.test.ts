/**
 * The Integrations place in a real browser against a real platform (port 7644), a stand-in Jira (7645) and a stand-in Slack (7646): the
 * left panel has it; every supported integration has a card with its status; Jira is set up once (checked before saving), given to a
 * project without entering anything again, tested, and taken away again; a Slack channel is set up and tested; a project's own
 * connection shows under its kind; the secret never reaches the page. Light-mode accessibility. Requires `web/dist` (vite build).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7644;
const BASE = `http://127.0.0.1:${PORT}`;
const JIRA = "http://127.0.0.1:7645";
const SLACK = "http://127.0.0.1:7646";
const KEY = "integrations-ui-owner-key-90fe";
const TOKEN = "UI-jira-token-6b5a4c";
const HOOK = "UI-slack-hook-3d2e1f";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let jira: http.Server;
let slack: http.Server;
let dataDir = "";
let alpha = "";
let page: Page;
const slackHits: string[] = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    jira = http.createServer((req, res) => {
        const token = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":").slice(1).join(":");
        res.setHeader("content-type", "application/json");
        if (token !== TOKEN) return res.writeHead(401).end(JSON.stringify({ errorMessages: ["You are not authenticated."] }));
        res.end(JSON.stringify({ key: "SHOP", name: "Shop" }));
    });
    slack = http.createServer((req, res) => {
        req.resume();
        slackHits.push(req.url!);
        res.writeHead(200).end("ok");
    });
    await Promise.all([new Promise<void>((r) => jira.listen(7645, "127.0.0.1", r)), new Promise<void>((r) => slack.listen(7646, "127.0.0.1", r))]);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-integrations-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    alpha = platform.repo.createProject({ name: "Alpha shop" }).id as string;
    const bravo = platform.repo.createProject({ name: "Bravo bank" }).id as string;
    // Bravo set up its own webhook in its settings before Integrations existed.
    const own = await server.inject({ method: "POST", url: `/api/projects/${bravo}/alert-channels`, headers: { "x-api-key": KEY }, payload: { kind: "webhook", url: `${SLACK}/bravo-own` } });
    expect(own.statusCode).toBe(201);
    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    browser = await chromium.launch();
    page = await (await browser.newContext()).newPage();
    await page.goto(BASE);
    await page.getByLabel("Email").fill("olga@example.com");
    await page.getByLabel("Password").fill("olga's long password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    for (const s of [jira, slack]) await new Promise((r) => s?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const axeClean = async (p: Page) => (await new AxeBuilder({ page: p }).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
const card = (kind: string) => page.getByTestId(`integration-${kind}`);

describe("the Integrations place", () => {
    it("is in the left panel and lists every supported integration with its status", async () => {
        await page.goto(`${BASE}/#/dashboard`);
        await page.getByRole("link", { name: "Integrations", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
        for (const kind of ["jira", "github", "notion", "sentry", "slack", "teams", "webhook", "email", "git", "device_farm", "mailbox"]) await pwExpect(card(kind)).toBeVisible();
        await pwExpect(card("jira").getByText("Not set up", { exact: true })).toBeVisible();
        await pwExpect(card("git")).toContainText("never stored, so there is nothing to share");
        // Bravo's own webhook is shown under Webhook, with a link to where it is set up.
        await pwExpect(card("webhook").getByText("Set up in 1 project", { exact: true })).toBeVisible();
        await pwExpect(card("webhook").getByTestId("own-webhook").getByRole("link", { name: "Bravo bank" })).toBeVisible();
        expect(await axeClean(page)).toEqual([]);
    });

    it("sets Jira up once, refusing a wrong token, and gives it to a project without entering anything again", async () => {
        const c = card("jira");
        await c.getByRole("button", { name: "Set up Jira" }).click();
        await c.getByLabel("Jira address").fill(JIRA);
        await c.getByLabel("Project key").fill("SHOP");
        await c.getByLabel("Account email").fill("qa@example.com");
        await c.getByLabel("API token").fill("UI-wrong-token");
        await c.getByRole("button", { name: "Set up Jira", exact: true }).click();
        await pwExpect(c.getByText("It was not set up")).toBeVisible();
        await pwExpect(c).toContainText("did not accept the token");
        await c.getByLabel("API token").fill(TOKEN);
        await c.getByRole("button", { name: "Set up Jira", exact: true }).click();
        const conn = c.getByTestId("shared-connection");
        await pwExpect(conn).toContainText("Jira SHOP");
        await pwExpect(conn.getByText("Working", { exact: true })).toBeVisible();
        await pwExpect(c.getByText("Connected", { exact: true })).toBeVisible();
        await pwExpect(conn).toContainText("No project uses it yet.");
        await conn.getByLabel("Use in a project").selectOption({ label: "Alpha shop" });
        await conn.getByRole("button", { name: "Use it" }).click();
        await pwExpect(conn.getByRole("link", { name: "Alpha shop" })).toBeVisible();
        await pwExpect(conn).toContainText("Used by 1 project:");
        // The project has the connection in its own list, without its token.
        const rows = (await server.inject({ method: "GET", url: `/api/projects/${alpha}/integrations`, headers: { "x-api-key": KEY } })).json();
        expect(rows.map((r: { name: string }) => r.name)).toEqual(["Jira SHOP"]);
        await conn.getByRole("button", { name: "Test the connection" }).click();
        await pwExpect(conn.getByRole("status")).toContainText("Connected to Jira project Shop.");
        expect(await page.content()).not.toContain(TOKEN);
        expect(await axeClean(page)).toEqual([]);
    });

    it("stops using it in a project, and only then lets it be removed", async () => {
        const conn = card("jira").getByTestId("shared-connection");
        await conn.getByRole("button", { name: "Stop using Jira SHOP in Alpha shop" }).click();
        await pwExpect(conn).toContainText("No project uses it yet.");
        const rows = (await server.inject({ method: "GET", url: `/api/projects/${alpha}/integrations`, headers: { "x-api-key": KEY } })).json();
        expect(rows).toEqual([]);
        page.once("dialog", (d) => void d.accept());
        await conn.getByRole("button", { name: "Remove" }).click();
        await pwExpect(card("jira").getByText("Not set up", { exact: true })).toBeVisible();
    });

    it("sets up a Slack channel showing only its host, and tests it with a real message", async () => {
        const c = card("slack");
        await c.getByRole("button", { name: "Set up Slack" }).click();
        await c.getByLabel("Incoming webhook address").fill(`${SLACK}/services/${HOOK}`);
        await c.getByRole("button", { name: "Set up Slack", exact: true }).click();
        const conn = c.getByTestId("shared-connection");
        await pwExpect(conn).toContainText("127.0.0.1:7646");
        await pwExpect(conn.getByText("Not tested yet", { exact: true })).toBeVisible();
        await conn.getByRole("button", { name: "Test the connection" }).click();
        await pwExpect(conn.getByRole("status")).toContainText("A test message was sent");
        await pwExpect(conn.getByText("Working", { exact: true })).toBeVisible();
        expect(slackHits).toContain(`/services/${HOOK}`);
        expect(await page.content()).not.toContain(HOOK);
    });
});
