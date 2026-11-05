/**
 * Testing agents in a real browser against a real platform (port 7621): the Agents place in the left panel, the eight agent cards
 * with Chatbot shown as not available, an agent's detail with the projects that use it, choosing agents in Create project (at least
 * one, only those that work on the platform), changing them in project Settings, and the Explore page naming the agents that
 * decide the checks. Light-mode accessibility of the pages. Requires `web/dist` (vite build).
 */
import fs from "node:fs";
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

const PORT = 7621;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "testing-agents-ui-key-71c0";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let alpha = "";

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-testing-agents-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    alpha = platform.repo.createProject({ name: "Alpha shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const axeClean = async (page: Page) => {
    const r = await new AxeBuilder({ page }).analyze();
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

describe("testing agents in the web app", () => {
    let page: Page;

    it("shows Agents in the left panel, with eight agents and Chatbot not available", async () => {
        page = await (await browser.newContext()).newPage();
        await page.goto(BASE);
        await page.getByLabel("Email").fill("olga@example.com");
        await page.getByLabel("Password").fill("olga's long password");
        await page.getByRole("button", { name: "Sign in" }).click();
        await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
        const nav = page.getByRole("complementary", { name: "Main navigation" });
        await nav.getByRole("link", { name: "Agents" }).click();
        await pwExpect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
        await pwExpect(nav.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
        // Agents comes right after Projects.
        const labels = await nav.getByRole("link").allTextContents();
        expect(labels.indexOf("Agents")).toBe(labels.indexOf("Projects") + 1);
        const cards = page.getByRole("list", { name: "Testing agents" }).getByRole("listitem");
        await pwExpect(cards).toHaveCount(8);
        await pwExpect(page.getByTestId("agent-card-chatbot")).toContainText("Not available yet");
        await pwExpect(page.getByTestId("agent-card-accessibility")).toContainText("1 project uses it");
        // No AI key and no worker here: said plainly.
        await pwExpect(page.getByText("AI is not set up on this server")).toBeVisible();
        await pwExpect(page.getByText("Tests do not run on this server", { exact: true })).toBeVisible();
        expect(await axeClean(page)).toEqual([]);
    });

    it("opens an agent with what it checks, what it needs and the projects that use it", async () => {
        await page.getByTestId("agent-card-accessibility").click();
        const d = page.getByTestId("agent-detail");
        await pwExpect(d.getByRole("heading", { name: "Accessibility Testing Agent" })).toBeVisible();
        await pwExpect(d.getByRole("heading", { name: "What it checks" })).toBeVisible();
        await pwExpect(d.getByRole("heading", { name: "What it needs" })).toBeVisible();
        await pwExpect(d.getByText("Works on: Web, Android.")).toBeVisible();
        await pwExpect(d.getByRole("list", { name: "Projects that use it" }).getByRole("link", { name: "Alpha shop" })).toBeVisible();
        expect(await axeClean(page)).toEqual([]);
        await page.goto(`${BASE}/#/agents/chatbot`);
        await pwExpect(page.getByText("It cannot be chosen yet")).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Projects that use it" })).toHaveCount(0);
    });

    it("picks agents in Create project: at least one, and only those that work on the platform", async () => {
        await page.goto(`${BASE}/#/create`);
        await page.getByLabel("Project name").fill("Phone app");
        await page.getByRole("radio", { name: "Android" }).check();
        await page.getByRole("radio", { name: "Add it later" }).check();
        await pwExpect(page.getByTestId("agent-picker")).toHaveCount(0);
        await page.getByRole("radio", { name: "AI agent" }).check();
        const picker = page.getByTestId("agent-picker");
        await pwExpect(picker).toBeVisible();
        await pwExpect(picker.getByRole("checkbox", { name: "Security Testing Agent" })).toBeDisabled();
        await pwExpect(picker.getByText("Works on Web only.").first()).toBeVisible();
        await pwExpect(picker.getByRole("checkbox", { name: "Chatbot Testing Agent" })).toBeDisabled();
        // The defaults for Android: accessibility and test case generation.
        await pwExpect(picker.getByRole("checkbox", { name: "Accessibility Testing Agent" })).toBeChecked();
        await pwExpect(picker.getByRole("checkbox", { name: "Test Case Generation Agent" })).toBeChecked();
        await picker.getByRole("checkbox", { name: "Accessibility Testing Agent" }).uncheck();
        await picker.getByRole("checkbox", { name: "Test Case Generation Agent" }).uncheck();
        await page.getByRole("button", { name: "Create project" }).click();
        await pwExpect(page.getByText("Choose at least one testing agent.")).toBeVisible();
        expect(platform.repo.listProjects().some((r) => r.name === "Phone app")).toBe(false);
        await picker.getByRole("checkbox", { name: "Performance Testing Agent" }).check();
        expect(await axeClean(page)).toEqual([]);
        await page.getByRole("button", { name: "Create project" }).click();
        await page.waitForURL(/#\/projects\/[^/]+$/);
        const id = page.url().split("/").pop()!;
        expect(platform.db.all<{ agent_id: string }>("SELECT agent_id FROM project_testing_agents WHERE project_id = ?", id).map((r) => r.agent_id)).toEqual(["performance"]);
    });

    it("changes a project's agents in Settings, and the explore form follows them", async () => {
        await page.goto(`${BASE}/#/projects/${alpha}/settings`);
        const panel = page.getByTestId("project-agents");
        await pwExpect(panel.getByText("No agents saved yet")).toBeVisible();
        await pwExpect(panel.getByRole("checkbox", { name: "Accessibility Testing Agent" })).toBeChecked();
        for (const n of ["API Testing Agent", "Security Testing Agent", "UX Testing Agent", "Test Case Generation Agent"]) await panel.getByRole("checkbox", { name: n }).uncheck();
        await panel.getByRole("checkbox", { name: "Accessibility Testing Agent" }).uncheck();
        await pwExpect(panel.getByRole("button", { name: "Save agents" })).toBeDisabled();
        await panel.getByRole("checkbox", { name: "Accessibility Testing Agent" }).check();
        await panel.getByRole("button", { name: "Save agents" }).click();
        await pwExpect(panel.getByText("Saved. The next exploration runs the checks of these agents.")).toBeVisible();
        await pwExpect(panel.getByText("No agents saved yet")).toHaveCount(0);
        expect(await axeClean(page)).toEqual([]);
        // The Explore page has no check list of its own: it names the agents that decide the checks.
        await page.goto(`${BASE}/#/new?project=${alpha}`);
        await pwExpect(page.getByTestId("explore-agents")).toHaveText("Checked by this project’s testing agents: Accessibility Testing Agent.");
        await pwExpect(page.getByText("Advanced options")).toHaveCount(0);
        await pwExpect(page.getByRole("checkbox", { name: /Basic security checks/ })).toHaveCount(0);
    });
});
