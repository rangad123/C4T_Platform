/**
 * The Projects page for someone with no project, in a real browser against the built page and a real platform (port 9820), with a
 * stand-in Crowd4Test sign-in (9821). An admin sees every project; a sub-admin only the projects they were added to, so a sub-admin
 * added to none, with no AI key and no runner, lands on an empty Projects page. That page is the Projects page itself, with one card
 * that opens Create a project and says what is still missing and where it is fixed; never the old full-page start screen.
 * Requires `web/dist`.
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
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { resolveAlias } from "../web/src/lib/aliases.js";

const PORT = 9820;
const C4T_PORT = 9821;
const BASE = `http://127.0.0.1:${PORT}`;

const user = (id: string, role: string, permissions: readonly string[]) => ({ data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId: null } } });
const ACCOUNTS: Record<string, unknown> = {
    "t-ada": user("ada", "ADMIN", PERMISSIONS),
    "t-sam": user("sam", "SUB_ADMIN", PERMISSIONS.filter((c) => c !== "ai_studio.platform.settings")),
    "t-vic": user("vic", "SUB_ADMIN", ["ai_studio.access"]),
};

let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let c4t: http.Server;
let dir = "";
const contexts: BrowserContext[] = [];

const pageFor = async (token: string, colorScheme: "light" | "dark" = "light") => {
    const ctx = await browser.newContext({ colorScheme });
    contexts.push(ctx);
    await ctx.addCookies([{ name: "c4t_access", value: token, url: BASE }]);
    return ctx.newPage();
};
const axe = async (page: Page) => {
    const r = await new AxeBuilder({ page }).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-first-project-ui-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: "first-project-ui-key-1", SECRET_KEY: "first-project-ui-secret-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://crowd4test.example", WEB_DIST: path.join(REPO_ROOT, "web/dist") } as never),
    );
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    browser = await chromium.launch();
    for (const t of Object.keys(ACCOUNTS)) await server.inject({ method: "GET", url: "/api/auth/state", headers: { cookie: `c4t_access=${t}` } });
    // The admin's project: the admin sees it, the sub-admins were not added to it.
    const made = await server.inject({ method: "POST", url: "/api/projects", headers: { "x-api-key": "first-project-ui-key-1" }, payload: { name: "Gift shop", platforms: ["web"], testingModes: ["agent"] } });
    expect(made.statusCode, made.body).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the old New project address", () => {
    const q = (s = "") => new URLSearchParams(s);
    it("goes to Create a project, with a testing type and an address carried over; Explore again (?project=) stays", () => {
        expect(resolveAlias(["new"], q())).toBe("#/create");
        expect(resolveAlias(["new"], q("type=security"))).toBe("#/create?type=security");
        expect(resolveAlias(["new"], q("url=https%3A%2F%2Fshop.example"))).toBe("#/create?url=https%3A%2F%2Fshop.example");
        expect(resolveAlias(["new"], q("project=p1"))).toBeNull();
    });

    it("in the browser: #/new opens Create a project, and ?url= fills its address", async () => {
        const page = await pageFor("t-sam");
        await page.goto(`${BASE}/#/new?url=${encodeURIComponent("https://shop.example")}`);
        await pwExpect(page).toHaveURL(/#\/create\?url=/);
        await pwExpect(page.getByRole("heading", { name: "Create a project", level: 1 })).toBeVisible();
        await pwExpect(page.getByLabel("Application URL")).toHaveValue("https://shop.example");
        await pwExpect(page.getByRole("button", { name: "Explore my app" })).toHaveCount(0);
    });
});

describe("the Projects page with no project", () => {
    it("a sub-admin added to no project, with no AI key and no runner, sees the Projects page with Create a project, not the old start screen", async () => {
        const page = await pageFor("t-sam");
        await page.goto(`${BASE}/#/`);
        await pwExpect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
        const first = page.getByTestId("first-project");
        await pwExpect(first.getByRole("heading", { name: "No projects yet" })).toBeVisible();
        await pwExpect(first.getByRole("link", { name: "Create a project", exact: true })).toHaveAttribute("href", "#/create");
        // What is missing, each with where it is fixed: AI keys (an admin can assign an organisational key there) and Your runner.
        await pwExpect(first.getByText("You have no usable AI key")).toBeVisible();
        await pwExpect(first).toContainText("ask an admin to assign an organisational key");
        await pwExpect(first.getByRole("link", { name: "Open AI keys", exact: true })).toHaveAttribute("href", "#/settings#ai-keys");
        // No test worker on this server: a runner would not help, so the panel says what does instead of linking to Your runner.
        await pwExpect(first.getByText("Runs can’t start on this server yet")).toBeVisible();
        await pwExpect(first).toContainText("npm run worker");
        await pwExpect(first.getByRole("link", { name: "Open Your runner in Settings" })).toHaveCount(0);
        // None of the old full-page start screen.
        await pwExpect(page.getByText("Test any web application automatically")).toHaveCount(0);
        await pwExpect(page.getByText("What kind of testing is this project for?")).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Explore my app" })).toHaveCount(0);
        await pwExpect(page.getByText("1. Enter your URL")).toHaveCount(0);
        // The link opens the current Create a project page (platform, testing mode, agents).
        await first.getByRole("link", { name: "Create a project", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Create a project", level: 1 })).toBeVisible();
        await pwExpect(page.getByRole("group", { name: "Testing mode" })).toBeVisible();
    });

    it("a sub-admin who may not create projects is told to ask to be added", async () => {
        const page = await pageFor("t-vic");
        await page.goto(`${BASE}/#/`);
        const first = page.getByTestId("first-project");
        await pwExpect(first.getByRole("heading", { name: "No projects yet" })).toBeVisible();
        await pwExpect(first).toContainText("You have not been added to a project yet.");
        await pwExpect(first.getByRole("link", { name: "Create a project" })).toHaveCount(0);
    });

    it("an admin with projects still sees the project list", async () => {
        const page = await pageFor("t-ada");
        await page.goto(`${BASE}/#/`);
        await pwExpect(page.locator("a.list-row").filter({ hasText: "Gift shop" })).toBeVisible();
        await pwExpect(page.getByTestId("first-project")).toHaveCount(0);
        await pwExpect(page.getByRole("link", { name: "New project", exact: true })).toHaveAttribute("href", "#/create");
    });

    it("the empty Projects page passes axe in light and dark", async () => {
        for (const scheme of ["light", "dark"] as const) {
            const page = await pageFor("t-sam", scheme);
            await page.goto(`${BASE}/#/`);
            await pwExpect(page.getByTestId("first-project").getByText("You have no usable AI key")).toBeVisible();
            await pwExpect(page.getByTestId("first-project").getByText("Runs can’t start on this server yet")).toBeVisible();
            await page.waitForTimeout(400); // the colour transition settles
            await axe(page);
        }
    });
});
