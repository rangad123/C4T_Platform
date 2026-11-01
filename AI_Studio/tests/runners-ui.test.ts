/**
 * The Runners pages in a real browser against a real platform (port 7802) and a fake runner speaking protocol 1: the empty states say
 * how to add a runner; a person registers one (the token shown once), gives it to a project in project settings, sees it online with
 * its phone on the Runners page, on its own page and in the Dashboard's summary, filters the list, renames it, stops a project using
 * it, and retires it. Light-mode accessibility of the pages. Requires `web/dist` (vite build).
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
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";

const PORT = 7802;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "runners-ui-owner-key-41ab";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let shop = "";
let page: Page;
let keepAlive: ReturnType<typeof setInterval> | undefined;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runners-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    shop = platform.repo.createProject({ name: "Alpha shop" }).id as string;
    platform.repo.createProject({ name: "Bravo bank" });
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
    if (keepAlive) clearInterval(keepAlive);
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const axeClean = async (p: Page) => (await new AxeBuilder({ page: p }).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);

describe("runners in the web app", () => {
    it("explains how to add a runner when there is none, on every page that asks", async () => {
        await page.goto(`${BASE}/#/runners`);
        await pwExpect(page.getByRole("heading", { name: "Runners", level: 1 })).toBeVisible();
        await pwExpect(page.getByText("No runners yet")).toBeVisible();
        await pwExpect(page.getByText(/downloads an installer for Windows, macOS or Linux/)).toBeVisible();
        await pwExpect(page.getByTestId("planned-runner-registry")).toHaveCount(0);
        expect(await axeClean(page)).toEqual([]);
        await page.goto(`${BASE}/#/dashboard`);
        await pwExpect(page.getByTestId("dashboard-runners").getByText(/Nothing runs until one connects/)).toBeVisible();
        await pwExpect(page.getByTestId("planned-dashboard-runners")).toHaveCount(0);
        await page.goto(`${BASE}/#/projects/${shop}/settings?section=runners`);
        await pwExpect(page.getByTestId("runner-access").getByText(/Nothing runs until one connects/)).toBeVisible();
    });

    it("registers a runner, showing the token once, and gives it to a project", async () => {
        await page.goto(`${BASE}/#/runners`);
        await page.getByRole("button", { name: "Register a runner" }).click();
        await page.getByLabel("Runner name").fill("Lab Mac");
        await page.getByRole("button", { name: "Register", exact: true }).click();
        const secret = await page.getByTestId("new-token").inputValue();
        expect(secret).toMatch(/^aitg_/);
        await page.getByRole("button", { name: "I have copied it" }).click();
        await pwExpect(page.getByTestId("new-token")).toHaveCount(0);
        await pwExpect(page.getByRole("list", { name: "Runners" }).getByText("Not connected yet")).toBeVisible();
        await page.goto(`${BASE}/#/projects/${shop}/settings?section=runners`);
        const access = page.getByTestId("runner-access");
        await access.getByLabel("Give this project a runner").selectOption({ label: "Lab Mac (Crowd4Test (shared))" });
        await access.getByRole("button", { name: "Give access" }).click();
        await pwExpect(access.getByRole("list", { name: "Runners this project may use" }).getByRole("link", { name: "Lab Mac" })).toBeVisible();

        const agent = new FakeAgent(viaFetch(BASE), secret, { name: "lab-mac", capabilities: defaultCaps({ android: { adb: true, devices: [{ serial: "ph1", model: "Pixel 8", state: "device", emulator: false }], avds: [] } }) });
        expect((await agent.hello()).status).toBe(200);
        keepAlive = setInterval(() => void agent.hello().catch(() => undefined), 8000);
    });

    it("lists it with filters, and its page shows its health, its phone and its projects", async () => {
        await page.goto(`${BASE}/#/runners`);
        const list = page.getByRole("list", { name: "Runners" });
        await pwExpect(list.getByText("Online")).toBeVisible();
        await page.getByLabel("Status").selectOption({ label: "Offline" });
        await pwExpect(page.getByText("No runner matches these filters.")).toBeVisible();
        await page.getByLabel("Status").selectOption({ label: "Online" });
        await page.getByLabel("Find a runner").fill("nothing like it");
        await pwExpect(page.getByText("No runner matches these filters.")).toBeVisible();
        await page.getByLabel("Find a runner").fill("lab");
        expect(await axeClean(page)).toEqual([]);
        await list.getByRole("link").click();
        await pwExpect(page.getByRole("heading", { name: "Lab Mac", level: 1 })).toBeVisible();
        await pwExpect(page.getByRole("list", { name: "Phones and simulators" }).getByText("Pixel 8")).toBeVisible();
        await pwExpect(page.getByRole("list", { name: "Projects that use this runner" }).getByText("Alpha shop")).toBeVisible();
        await pwExpect(page.getByText("No failures in the last 24 hours.")).toBeVisible();
        expect(await axeClean(page)).toEqual([]);
    });

    it("shows it in the Dashboard's summary", async () => {
        await page.goto(`${BASE}/#/dashboard`);
        const card = page.getByTestId("dashboard-runners");
        await pwExpect(card.getByText("Waiting in the queue")).toBeVisible();
        await pwExpect(card.getByText(/1 phone and 0 simulators online/)).toBeVisible();
        await pwExpect(card.getByText(/Browsers: chromium/)).toBeVisible();
    });

    it("stops a project using it, renames it and retires it", async () => {
        await page.goto(`${BASE}/#/projects/${shop}/settings?section=runners`);
        const access = page.getByTestId("runner-access");
        await access.getByRole("button", { name: "Stop using Lab Mac" }).click();
        await pwExpect(access.getByRole("list", { name: "Runners this project may use" })).toHaveCount(0);
        await page.goto(`${BASE}/#/runners`);
        await page.getByRole("list", { name: "Runners" }).getByRole("link").click();
        await page.getByRole("button", { name: "Rename" }).click();
        await page.getByLabel("New name for Lab Mac").fill("Studio Mac");
        await page.getByRole("button", { name: "Save name" }).click();
        await pwExpect(page.getByRole("heading", { name: "Studio Mac", level: 1 })).toBeVisible();
        await page.getByRole("button", { name: "Retire", exact: true }).click();
        await page.getByRole("button", { name: "Retire runner" }).click();
        await pwExpect(page.getByText("Runner retired. Its token no longer works.")).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Actions" })).toHaveCount(0);
    });
});
