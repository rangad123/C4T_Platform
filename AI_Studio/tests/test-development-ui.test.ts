/**
 * Test development is out of the sidebar for now (founder review 2026-11-19, owner decision Q2): it repeated each project's Test
 * scripts. No role sees the item, Reusable libraries stays, and an old `#/develop` link or bookmark lands on Projects instead of a
 * blank page. The drafts waiting for review stay on the Dashboard and in each project's Test scripts → Review (reviews-ui.test.ts).
 * Real browser against a real platform (port 7901). Requires `web/dist`.
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

const PORT = 7901;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.F1119_SHOTS ?? "";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";

const PEOPLE = [
    ["olga@example.com", "Olga Owner", "owner"],
    ["eddie@example.com", "Eddie Editor", "editor"],
    ["vera@example.com", "Vera Viewer", "viewer"],
] as const;

const signedIn = async (email: string, name: string, width = 1280): Promise<Page> => {
    const p = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
    await p.goto(BASE);
    await p.getByLabel("Email").fill(email);
    await p.getByLabel("Password").fill(`${name}'s long password`);
    await p.getByRole("button", { name: "Sign in" }).click();
    await pwExpect(p.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    return p;
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-develop-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: "develop-ui-owner-key-61c2", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const projectId = platform.repo.createProject({ name: "Launch shop" }).id as string;
    platform.repo.createApplication(projectId, "http://127.0.0.1:9/", {});
    const users = accessControlOf(server).users;
    for (const [email, name, role] of PEOPLE) {
        const u = users.create({ email, name, role });
        users.setPassword(u.id, await hashPassword(`${name}'s long password`));
    }
    browser = await chromium.launch();
}, 90_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Test development is out of the sidebar (Q2)", () => {
    for (const [email, name, role] of PEOPLE) {
        it(`shows ${role}s no Test development item, and keeps Reusable libraries`, async () => {
            const p = await signedIn(email, name);
            const side = p.getByRole("complementary", { name: "Main navigation" });
            await pwExpect(side.getByRole("link", { name: "Reusable libraries", exact: true })).toBeVisible();
            await pwExpect(side.getByRole("link", { name: "Test development" })).toHaveCount(0);
            await pwExpect(side.locator('a[href="#/develop"]')).toHaveCount(0);
            if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `sidebar-${role}.png`) });
            await p.context().close();
        });
    }

    it("keeps it out of the phone navigation too", async () => {
        const p = await signedIn("eddie@example.com", "Eddie Editor", 390);
        await p.getByRole("button", { name: "Toggle navigation" }).click();
        const side = p.getByRole("complementary", { name: "Main navigation" });
        await pwExpect(side.getByRole("link", { name: "Reusable libraries", exact: true })).toBeVisible();
        await pwExpect(side.getByRole("link", { name: "Test development" })).toHaveCount(0);
        // the drawer slides in; the picture waits until it is fully open
        await pwExpect.poll(async () => (await side.boundingBox())?.x).toBe(0);
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "sidebar-phone.png") });
        await p.context().close();
    });

    it("lands an old #/develop link on Projects, with Projects marked in the sidebar and no Test development page", async () => {
        const p = await signedIn("olga@example.com", "Olga Owner");
        await p.goto("about:blank");
        await p.goto(`${BASE}/#/develop`);
        await pwExpect(p.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
        await pwExpect(p.getByText("Launch shop").first()).toBeVisible();
        await pwExpect(p.getByRole("heading", { name: "Test development" })).toHaveCount(0);
        await pwExpect(p.getByRole("complementary", { name: "Main navigation" }).locator('a.nav-item[aria-current="page"]')).toHaveText("Projects");
        await pwExpect(p.locator('.content [role="alert"]')).toHaveCount(0);
        expect((await new AxeBuilder({ page: p }).analyze()).violations.map((v) => v.id)).toEqual([]);
        await p.context().close();
    });
});
