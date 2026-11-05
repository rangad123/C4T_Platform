/**
 * What the agents need, in a real browser against a real platform (port 7822): the Explore page without Advanced options and with
 * Focus kept, the pop-up for a project whose API agent has no API documentation yet and its way to Requirements, the inputs card on
 * the Requirements tab (an earlier exploration's sign-in shown as saved, a secret saved and shown as "Saved"), and exploring with what
 * is saved there. Light-mode accessibility of the pages. Requires `web/dist` (vite build).
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
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { agentInputsStoreOf } from "../src/platform/routes/agent-inputs.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7822;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "agent-inputs-ui-key-2e7d";
const SITE = "https://shop.example/";
const TOKEN = "AGINPUT-UI-Token-c3a1f0";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let stopBeat: (() => void) | undefined;
let dataDir = "";
let shop = "";

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-inputs-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    // A worker in another process says it is alive, so an exploration is queued (and nothing here runs it).
    stopBeat = startHeartbeat(platform.db);
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    // A project explored before with a sign-in (an existing project), whose agents now include the API agent. Its saved inputs are
    // what migration slot 50 carried over from its latest application (made here after the migration, so carried over by hand).
    shop = platform.repo.createProject({ name: "API shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
    platform.repo.createApplication(shop, SITE, { ...DEFAULT_JOB_OPTIONS }, { username: "old@shop.example", password: "an earlier password" });
    agentInputsStoreOf(platform).save(shop, { site: SITE, credentials: { username: "old@shop.example", password: "an earlier password" } });
    await testingAgentsOf(platform).set(shop, ["api", "test-generation"], "test");
    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    stopBeat?.();
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const axeClean = async (page: Page) => {
    const r = await new AxeBuilder({ page }).analyze();
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

describe("what the agents need", () => {
    let page: Page;
    const dialog = () => page.getByRole("dialog", { name: "Add what the agents need first" });

    it("the Explore page has no Advanced options and keeps Focus", async () => {
        page = await (await browser.newContext()).newPage();
        await page.goto(BASE);
        await page.getByLabel("Email").fill("olga@example.com");
        await page.getByLabel("Password").fill("olga's long password");
        await page.getByRole("button", { name: "Sign in" }).click();
        await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
        await page.goto(`${BASE}/#/new?url=${encodeURIComponent(SITE)}`);
        await pwExpect(page.getByLabel("Application URL")).toHaveValue(SITE);
        await pwExpect(page.getByLabel(/^Focus/)).toBeVisible();
        await pwExpect(page.getByText("Advanced options")).toHaveCount(0);
        for (const gone of ["What should we test?", "Username or email", "Bearer token", "OpenAPI document URL", "Requirements document", "Include API tests that change data"]) await pwExpect(page.getByText(gone, { exact: true })).toHaveCount(0);
        await pwExpect(page.getByTestId("inputs-note")).toContainText("keep its sign-in details, API access, OpenAPI document and requirements on its Requirements tab");
        // No AI model here: said plainly, and only the API is explored.
        await pwExpect(page.getByText("Exploring the web application needs it, so only the application’s API is explored here.", { exact: false })).toBeVisible();
        expect(await axeClean(page)).toEqual([]);
    });

    it("opens the pop-up at once and again on Explore for an API agent without its documentation, and it leads to Requirements", async () => {
        await page.goto(`${BASE}/#/new?project=${shop}`);
        await pwExpect(dialog()).toBeVisible();
        await pwExpect(page.getByTestId("missing-inputs")).toHaveText("OpenAPI document URL: The API Testing Agent needs the API documentation: the address of the OpenAPI document.");
        expect(await axeClean(page)).toEqual([]);
        await dialog().getByRole("button", { name: "Not now" }).click();
        await pwExpect(dialog()).toHaveCount(0);
        await pwExpect(page.getByLabel(/^Focus/)).toBeVisible();
        await pwExpect(page.getByTestId("explore-agents")).toHaveText("Checked by this project’s testing agents: API Testing Agent, Test Case Generation Agent.");
        await pwExpect(page.getByTestId("inputs-note").getByRole("link", { name: "Requirements" })).toHaveAttribute("href", `#/projects/${shop}/requirements`);
        await page.getByRole("button", { name: "Explore again" }).click();
        await pwExpect(dialog()).toBeVisible();
        expect(platform.repo.listJobs(shop)).toHaveLength(0);
        await dialog().getByRole("button", { name: "Open Requirements" }).click();
        // It lands on the card, open.
        await page.waitForURL((u) => u.hash === `#/projects/${shop}/requirements?inputs=open`);
        await pwExpect(page.getByRole("button", { name: "What the agents need" })).toHaveAttribute("aria-expanded", "true");
        const card = page.getByTestId("agent-inputs");
        await pwExpect(card.getByRole("heading", { name: "What the agents need" })).toBeVisible();
        await pwExpect(card.getByTestId("agent-inputs-missing")).toContainText("The API Testing Agent needs the API documentation");
    });

    it("shows the earlier sign-in as saved, saves a secret and shows it as Saved, and exploring uses what is saved", async () => {
        const card = page.getByTestId("agent-inputs");
        await pwExpect(card.getByLabel("Username or email")).toHaveValue("old@shop.example");
        const password = card.getByRole("group", { name: "Password" });
        await pwExpect(password.getByText("Saved", { exact: true })).toBeVisible();
        await pwExpect(password.getByRole("button", { name: "Replace the password" })).toBeVisible();
        await pwExpect(password.getByRole("button", { name: "Remove the password" })).toBeVisible();
        await card.getByLabel("Bearer token").fill(TOKEN);
        await card.getByLabel(/^OpenAPI document URL/).fill("https://shop.example/openapi.json");
        await card.getByRole("button", { name: "Save", exact: true }).click();
        await pwExpect(card.getByText("Saved. The next exploration uses these.")).toBeVisible();
        await pwExpect(card.getByRole("group", { name: "Bearer token" }).getByText("Saved", { exact: true })).toBeVisible();
        await pwExpect(card.getByTestId("agent-inputs-missing")).toHaveCount(0);
        await pwExpect(card.locator("input#ai-token")).toHaveCount(0); // the secret is never put back in a field
        expect(await page.content()).not.toContain(TOKEN);
        expect(await axeClean(page)).toEqual([]);

        await page.goto(`${BASE}/#/new?project=${shop}`);
        await page.getByLabel(/^Focus/).fill("search and checkout only");
        await pwExpect(dialog()).toHaveCount(0);
        await page.getByRole("button", { name: "Explore again" }).click();
        await page.waitForURL((u) => u.hash === `#/projects/${shop}`);
        const job = platform.repo.listJobs(shop)[0]!;
        expect(job.options).toMatchObject({ scope: "search and checkout only", openApiUrl: "https://shop.example/openapi.json", planOnly: true });
        expect(platform.repo.getApplication(job.applicationId)!.credentials).toMatchObject({ username: "old@shop.example", password: "an earlier password", apiToken: TOKEN });
    });

    it("is one line while nothing is missing, says what is saved, and opens on a click", async () => {
        await page.goto(`${BASE}/#/projects/${shop}/requirements`);
        const toggle = page.getByRole("button", { name: "What the agents need" });
        await pwExpect(toggle).toHaveAttribute("aria-expanded", "false");
        await pwExpect(page.getByTestId("agent-inputs-summary")).toHaveText("Saved: sign-in as old@shop.example, API token, OpenAPI document. Nothing the chosen agents need is missing.");
        await pwExpect(page.getByLabel("Username or email")).toHaveCount(0);
        if (process.env.UI_REVIEW_SHOTS) await page.screenshot({ path: path.join(process.env.UI_REVIEW_SHOTS, "agent-inputs-closed.png"), fullPage: true });
        await toggle.click();
        await pwExpect(toggle).toHaveAttribute("aria-expanded", "true");
        await pwExpect(page.getByTestId("agent-inputs").getByLabel("Username or email")).toHaveValue("old@shop.example");
        await pwExpect(page.getByTestId("agent-inputs-summary")).toHaveCount(0);
        expect(await axeClean(page)).toEqual([]);
        if (process.env.UI_REVIEW_SHOTS) await page.screenshot({ path: path.join(process.env.UI_REVIEW_SHOTS, "agent-inputs-open.png"), fullPage: true });
    });
});
