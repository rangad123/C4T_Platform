/**
 * Per-project access in a real browser against a real platform (port 7132): an owner limits a client to one project in Settings,
 * People ("Only these projects", a project and a role), the client then sees only that project on the projects list, the dashboard
 * and the security section, gets "not found" for another project's address, and does not see platform-wide settings. Also the
 * People screen's accessibility in light and dark with the editor open, and at phone width. Requires `web/dist` (vite build).
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

const PORT = 7132;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "acc-ui-owner-key-81c4";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let alpha = "";
let bravo = "";

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-acc-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    alpha = platform.repo.createProject({ name: "Alpha shop" }).id as string;
    bravo = platform.repo.createProject({ name: "Bravo bank" }).id as string;
    // Both projects include the security assessment, so the security home would list both for someone who sees everything.
    for (const id of [alpha, bravo]) {
        const r = await server.inject({ method: "PUT", url: `/api/v1/security/projects/${id}/testing-type`, headers: { "x-api-key": KEY }, payload: { testingType: "both" } });
        if (r.statusCode !== 200) throw new Error(`testing type: ${r.statusCode} ${r.body}`);
    }
    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    const cleo = users.create({ email: "cleo@example.com", name: "Cleo Client", role: "editor" });
    users.setPassword(cleo.id, await hashPassword("cleo's long password"));
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

async function signIn(page: Page, email: string, password: string) {
    await page.goto(BASE);
    await pwExpect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}

describe("per-project access in the web app", () => {
    let owner: Page;

    it("lets an owner limit a person to one project with a role there", async () => {
        owner = await (await browser.newContext()).newPage();
        await signIn(owner, "olga@example.com", "olga's long password");
        await owner.getByRole("link", { name: "Settings", exact: true }).click();
        const people = owner.getByRole("region", { name: "People" });
        await pwExpect(people.getByText("All projects", { exact: true }).first()).toBeVisible();
        await people.locator("summary", { hasText: "Projects Cleo Client can see" }).click();
        await people.getByRole("radio", { name: /Only these projects/ }).check();
        await people.getByRole("checkbox", { name: /Alpha shop/ }).check();
        await people.getByLabel("Role of Cleo Client in Alpha shop", { exact: true }).selectOption("editor");
        // An editor on the platform cannot be made an owner in a project: the choice is not offered.
        expect(await people.getByLabel("Role of Cleo Client in Alpha shop", { exact: true }).locator("option").allTextContents()).toEqual(["Viewer", "Editor"]);
        await people.getByRole("button", { name: "Save access" }).click();
        await pwExpect(people.getByText("Cleo Client now sees 1 project only.", { exact: true })).toBeVisible();
        await pwExpect(people.getByText("1 project", { exact: true })).toBeVisible();
        const access = accessControlOf(server).projects.store.accessOf(accessControlOf(server).users.byEmail("cleo@example.com")!.id);
        expect(access).toEqual({ mode: "only", projects: new Map([[alpha, "editor"]]) });
    });

    it("is accessible in light and dark with the editor open, and fits a phone", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await owner.emulateMedia({ colorScheme: scheme });
            await owner.waitForTimeout(400);
            expect(await axeClean(owner), scheme).toEqual([]);
        }
        await owner.emulateMedia({ colorScheme: "light" });
        await owner.setViewportSize({ width: 375, height: 800 });
        await owner.waitForTimeout(200);
        expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        // The project rows are comfortable targets.
        const row = await owner.getByRole("checkbox", { name: /Alpha shop/ }).locator("xpath=ancestor::label[1]").boundingBox();
        expect(row!.height).toBeGreaterThanOrEqual(44);
        await owner.setViewportSize({ width: 1280, height: 800 });
    });

    it("shows the limited person only their project, and nothing platform-wide", async () => {
        const ctx = await browser.newContext();
        const cleo = await ctx.newPage();
        await signIn(cleo, "cleo@example.com", "cleo's long password");
        await cleo.goto(`${BASE}/#/`);
        await pwExpect(cleo.getByText("Alpha shop", { exact: true }).first()).toBeVisible();
        await pwExpect(cleo.getByText("Bravo bank", { exact: true })).toHaveCount(0);
        // The API agrees: the list and another project's address.
        expect(await cleo.evaluate(async () => (await (await fetch("/api/projects")).json()).map((p: { name: string }) => p.name))).toEqual(["Alpha shop"]);
        expect(await cleo.evaluate(async (id) => (await fetch(`/api/projects/${id}`)).status, bravo)).toBe(404);
        // The security home lists the projects that include it: only Alpha for her (the owner sees both).
        await cleo.goto(`${BASE}/#/security`);
        await pwExpect(cleo.getByText("Alpha shop", { exact: true }).first()).toBeVisible();
        await pwExpect(cleo.getByText("Bravo bank", { exact: true })).toHaveCount(0);
        await owner.goto(`${BASE}/#/security`);
        await pwExpect(owner.getByText("Bravo bank", { exact: true }).first()).toBeVisible();
        await cleo.goto(`${BASE}/#/projects/${bravo}`);
        await pwExpect(cleo.getByText(/not found/i).first()).toBeVisible();
        // Settings: people, usage and storage are not there. Their account (on Profile since round 25) says they are limited.
        await cleo.getByRole("link", { name: "Settings", exact: true }).click();
        await pwExpect(cleo.locator("h1")).toHaveText("Settings");
        await pwExpect(cleo.getByRole("region", { name: "People" })).toHaveCount(0);
        await pwExpect(cleo.getByRole("heading", { name: "Storage", exact: true })).toHaveCount(0);
        await cleo.goto(`${BASE}/#/profile`);
        await pwExpect(cleo.getByText("You see only the projects an owner chose for you", { exact: false })).toBeVisible();
        await ctx.close();
    });
});
