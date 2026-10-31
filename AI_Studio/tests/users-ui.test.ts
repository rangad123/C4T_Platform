/**
 * People and access in a real browser against a real platform (port 6812, protected by an access key): the key screen while
 * nobody has an account, creating the first owner in Settings, adding an editor and opening the invite link in another browser,
 * the editor's sign-in page and sidebar, a refused owner-only action, signing out, and the sign-in page's accessibility in
 * light and dark and at phone width. Requires `web/dist` (vite build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 6812;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "usr-ui-owner-key-5d21";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let inviteLink = "";

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-usr-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
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

describe("people and access in the web app", () => {
    let owner: Page;

    it("asks for the access key while nobody has an account, then the key holder creates the first owner", async () => {
        owner = await browser.newPage();
        await owner.goto(BASE);
        await pwExpect(owner.getByRole("heading", { name: "Enter the access key" })).toBeVisible();
        await owner.getByLabel("Access key").fill(KEY);
        await owner.getByRole("button", { name: "Continue" }).click();
        await owner.getByRole("link", { name: "Settings", exact: true }).click();
        const people = owner.getByRole("region", { name: "People" });
        await pwExpect(people.getByText("Nobody has an account yet.", { exact: false })).toBeVisible();
        await owner.getByLabel("Your name").fill("Olga Owner");
        await owner.getByLabel("Your email").fill("olga@example.com");
        await owner.getByLabel("Password", { exact: true }).fill("olga's long password");
        await owner.getByRole("button", { name: "Create owner account" }).click();
        // Now signed in as a person: the sidebar says who, and People lists her.
        await pwExpect(owner.getByText("Olga Owner").first()).toBeVisible();
        await pwExpect(owner.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
        // Her own password and tokens moved from Settings to Profile (round 25); Settings keeps the people of the platform.
        await pwExpect(owner.getByRole("region", { name: "Your account" })).toHaveCount(0);
        await owner.goto(`${BASE}/#/profile`);
        await pwExpect(owner.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
        await pwExpect(owner.getByRole("region", { name: "Your account" })).toBeVisible();
        await owner.goto(`${BASE}/#/settings`);
        await pwExpect(owner.getByRole("region", { name: "People" })).toBeVisible();
    });

    it("a signed-in person reaches Profile from the sidebar's account area", async () => {
        await owner.goto(`${BASE}/#/settings`);
        await owner.getByRole("complementary", { name: "Main navigation" }).getByRole("link", { name: /Profile|Olga Owner/ }).first().click();
        await pwExpect(owner).toHaveURL(/#\/profile$/);
        await pwExpect(owner.getByRole("region", { name: "Your account" })).toBeVisible();
        // The journeys below go on from Settings.
        await owner.goto(`${BASE}/#/settings`);
        await pwExpect(owner.getByRole("region", { name: "People" })).toBeVisible();
    });

    it("adds an editor and shows the invite link once", async () => {
        const people = owner.getByRole("region", { name: "People" });
        await people.getByRole("button", { name: "Add a person" }).click();
        await owner.getByLabel("Email", { exact: true }).fill("eve@example.com");
        await owner.getByLabel("Name", { exact: true }).fill("Eve Editor");
        await owner.locator("#np-role").selectOption("editor");
        await owner.getByRole("button", { name: "Add and make invite link" }).click();
        const shown = owner.getByTestId("shown-once");
        await pwExpect(shown).toContainText("/#/invite/");
        inviteLink = (await shown.textContent())!.trim();
        expect(inviteLink.startsWith(`${BASE}/#/invite/`)).toBe(true);
        await pwExpect(people.getByText("eve@example.com, last signed in never", { exact: true })).toBeVisible();
        await pwExpect(people.getByText("Invited", { exact: true })).toBeVisible();
    });

    it("lets the invited editor choose a password and work, but not manage people", async () => {
        const ctx = await browser.newContext();
        const eve = await ctx.newPage();
        await eve.goto(inviteLink);
        await pwExpect(eve.getByRole("heading", { name: "Set up your account" })).toBeVisible();
        await eve.getByLabel("New password", { exact: true }).fill("eve's long password");
        await eve.getByLabel("New password again").fill("eve's long password");
        await eve.getByRole("button", { name: "Save password and sign in" }).click();
        await pwExpect(eve.getByText("Eve Editor").first()).toBeVisible();
        await pwExpect(eve.getByText("Editor", { exact: true }).first()).toBeVisible();
        // An editor creates projects with the page's own CSRF token...
        const made = await eve.evaluate(async () => {
            const csrf = /aitp_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? "";
            const r = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": decodeURIComponent(csrf) }, body: JSON.stringify({ name: "Eve's project" }) });
            return r.status;
        });
        expect(made).toBe(201);
        // ...but the owner-only People list is refused, and Settings does not show it.
        expect(await eve.evaluate(async () => (await fetch("/api/users")).status)).toBe(403);
        await eve.goto(`${BASE}/#/profile`);
        await pwExpect(eve.getByRole("region", { name: "Your account" })).toBeVisible();
        await eve.goto(`${BASE}/#/settings`);
        await pwExpect(eve.getByRole("region", { name: "People" })).toHaveCount(0);
        // Signing out leads to the sign-in page, and signing in again works.
        await eve.getByRole("button", { name: "Sign out", exact: true }).click();
        await pwExpect(eve.getByRole("heading", { name: "Sign in" })).toBeVisible();
        await eve.getByLabel("Email").fill("eve@example.com");
        await eve.getByLabel("Password").fill("wrong password here");
        await eve.getByRole("button", { name: "Sign in" }).click();
        await pwExpect(eve.getByText("That email and password don’t match an account.", { exact: false })).toBeVisible();
        await eve.getByLabel("Password").fill("eve's long password");
        await eve.getByRole("button", { name: "Sign in" }).click();
        await pwExpect(eve.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
        await ctx.close();
    });

    it("shows the owner who did what in Activity", async () => {
        await owner.reload();
        const activity = owner.getByRole("region", { name: "Activity" });
        await pwExpect(activity.getByText("Eve Editor: Added a project", { exact: true })).toBeVisible();
        await pwExpect(activity.getByText("Eve Editor: Signed in", { exact: true }).first()).toBeVisible();
    });

    it("has an accessible sign-in page in light and dark, without sideways scrolling on a phone", async () => {
        const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
        const page = await ctx.newPage();
        await page.goto(BASE);
        await pwExpect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
        await page.locator("summary", { hasText: "Use an access key instead" }).click();
        await pwExpect(page.getByLabel("Access key")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400);
            expect(await axeClean(page), scheme).toEqual([]);
        }
        // The sign-in button is a comfortable target.
        const box = await page.getByRole("button", { name: "Sign in" }).boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        await ctx.close();
    });
});
