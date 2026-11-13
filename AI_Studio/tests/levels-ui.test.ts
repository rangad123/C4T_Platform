/**
 * Round 53, "How much to explore" in a real browser against a real platform (port 9200): project Settings saves the level, the Explore
 * page starts from it with "Explore every page again" off, and what the person picks reaches the queued job. Light-mode accessibility of
 * both places. Requires `web/dist` (vite build). No worker runs the job; no network beyond 127.0.0.1.
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
import { buildServer } from "../src/platform/server.js";

const PORT = 9200;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = "https://shop.example/";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let stopBeat: (() => void) | undefined;
let dataDir = "";
let shop = "";

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-levels-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: "levels-ui-key-7b20", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    stopBeat = startHeartbeat(platform.db);
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    shop = platform.repo.createProject({ name: "Level shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
    platform.repo.createApplication(shop, SITE, { ...DEFAULT_JOB_OPTIONS });
    const users = accessControlOf(server).users;
    const owner = users.create({ email: "owner@example.com", name: "Project Owner", role: "owner" });
    users.setPassword(owner.id, await hashPassword("the owner's long password"));
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    stopBeat?.();
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const axeClean = async (page: Page) => (await new AxeBuilder({ page }).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);

describe("how much to explore", () => {
    let page: Page;
    it("project Settings saves the level", async () => {
        page = await (await browser.newContext()).newPage();
        await page.goto(BASE);
        await page.getByLabel("Email").fill("owner@example.com");
        await page.getByLabel("Password").fill("the owner's long password");
        await page.getByRole("button", { name: "Sign in" }).click();
        await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
        await page.goto(`${BASE}/#/projects/${shop}/settings`);
        const card = page.getByTestId("explore-level-setting");
        await pwExpect(card.getByRole("radio", { name: /Thorough/ })).toBeChecked();
        await pwExpect(card).toContainText("Up to 60 pages, 4 clicks deep, about 50 tests from the AI.");
        await pwExpect(card).toContainText("Up to 120 pages, 5 clicks deep, about 100 tests from the AI. Uses more AI and takes longer.");
        await card.getByRole("radio", { name: /Deep/ }).check();
        await card.getByRole("button", { name: "Save" }).click();
        await pwExpect(card).toContainText("Later explorations and schedules explore at Deep.");
        expect(platform.repo.getApplication(String(platform.repo.getLatestApplicationPublic(shop)!.id))!.config).toMatchObject({ level: "deep", maxPages: 120 });
        expect(await axeClean(page)).toEqual([]);
    });

    it("the Explore page starts from the project's level, and the choice reaches the job", async () => {
        await page.goto(`${BASE}/#/new?project=${shop}`);
        const levels = page.getByTestId("explore-level");
        await pwExpect(levels.getByRole("radio", { name: /Deep/ })).toBeChecked();
        await pwExpect(page.getByTestId("full-exploration")).not.toBeChecked();
        expect(await axeClean(page)).toEqual([]);
        await levels.getByRole("radio", { name: /Everything/ }).check();
        await page.getByTestId("full-exploration").check();
        await page.getByRole("button", { name: "Explore again" }).click();
        await pwExpect.poll(() => platform.repo.listJobs(shop).length).toBe(1);
        expect(platform.repo.listJobs(shop)[0]!.options).toMatchObject({ level: "everything", maxPages: 250, maxDepth: 6, maxScenarios: 150, fullExploration: true });
    });

    it("AI screen review: Deep shows it checked when the model can read images, and unchecking sends visionChecks:false", async () => {
        const p2 = await page.context().newPage();
        // The page's own view of the server: an AI model is set up (nothing is ever sent to a model here: no worker runs the job).
        await p2.route("**/api/config", async (route) => {
            const res = await route.fetch();
            const body = await res.json();
            await route.fulfill({ response: res, json: { ...body, llm: { ...body.llm, configured: true } } });
        });
        await p2.goto(`${BASE}/#/new?project=${shop}`);
        const levels = p2.getByTestId("explore-level");
        await levels.getByRole("radio", { name: /Thorough/ }).check();
        await pwExpect(p2.getByTestId("screen-review")).not.toBeChecked();
        await levels.getByRole("radio", { name: /Deep/ }).check();
        await pwExpect(p2.getByRole("checkbox", { name: /AI screen review \(screenshots go to your AI provider\)/ })).toBeChecked();
        expect(await axeClean(p2)).toEqual([]);
        await p2.getByTestId("screen-review").uncheck();
        // The project already has a queued exploration (above), so only what the page sends is checked here.
        const sent: Array<Record<string, unknown>> = [];
        await p2.route("**/api/projects/*/test-generation", (route) => {
            sent.push(route.request().postDataJSON());
            return route.continue();
        });
        await p2.getByRole("button", { name: "Explore again" }).click();
        await pwExpect.poll(() => sent.length).toBe(1);
        expect(sent[0]).toMatchObject({ level: "deep", visionChecks: false });
        await p2.close();
    });
});
