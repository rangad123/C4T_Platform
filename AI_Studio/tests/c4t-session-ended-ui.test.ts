/**
 * A Crowd4Test sign-in that ends, or seems to, in the middle of work, in a real browser (ports 6874 AI Studio, 6875 a stand-in
 * crowd4test.com and its API). A refused request used to send the whole tab to crowd4test.com to sign in, losing what was typed:
 * now one refused request with the session still good changes nothing on the page, and a session that really ended is said over
 * the page, whose form keeps its text; signing in again (in another tab) and coming back carries on where the person was.
 * Requires `web/dist` (vite build).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 6874;
const SITE_PORT = 6875;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TOKEN = "access-good-1";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let site: http.Server;
let dataDir = "";
/** Each visit to the stand-in's sign-in hand-off, and to its renewal. */
const trips: string[] = [];
let renewals = 0;

const ADMIN = { id: "c4t-admin-1", email: "admin@people.example", role: "ADMIN", status: "ACTIVE", firstName: "Ada", lastName: "Admin", emailVerified: true, permissions: [], organisationId: null };

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    // crowd4test.com and its API in one: /v1/auth/me knows TOKEN only; the renewal cannot bring a cookie back (nothing to renew).
    site = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", SITE);
        if (url.pathname === "/app/ai-studio") {
            trips.push(url.searchParams.get("to") ?? "");
            res.writeHead(303, { location: `${BASE}/#${url.searchParams.get("to") ?? "/"}`, "cache-control": "no-store" });
            return res.end();
        }
        if (url.pathname === "/app/ai-studio/refresh") {
            renewals += 1;
            res.writeHead(204, { "cache-control": "no-store" });
            return res.end();
        }
        const ok = url.pathname === "/v1/auth/me" && req.headers.authorization === `Bearer ${TOKEN}`;
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ok ? { data: { user: ADMIN } } : { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => site.listen(SITE_PORT, "127.0.0.1", r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-c4t-ended-ui-"));
    platform = bootstrap(
        loadConfig({
            DATA_DIR: dataDir,
            HOST: "127.0.0.1",
            PORT: String(PORT),
            SCHEDULER_ENABLED: "false",
            WORKER_EMBEDDED: "false",
            SECRET_KEY: "c4t-ended-ui-secret-key-0123456789",
            C4T_API_ORIGIN: SITE,
            C4T_SITE_URL: SITE,
        }),
    );
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => site?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Signed in on Crowd4Test (cookies are not kept apart by port), on Create a project with a name typed and not saved. */
async function midForm(): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
    const context = await browser.newContext();
    await context.addCookies([{ name: "c4t_access", value: TOKEN, domain: "127.0.0.1", path: "/" }, { name: "c4t_shared", value: "2", domain: "127.0.0.1", path: "/" }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/#/create`);
    await page.getByLabel("Project name").fill("Half-typed checkout project");
    await page.getByLabel("Description (optional)").fill("Not saved yet");
    trips.length = 0;
    renewals = 0;
    return { context, page, errors };
}

const banner = (page: Page) => page.getByText("Your Crowd4Test sign-in has ended");
const signInRefusal = { error: "Sign in on Crowd4Test first", details: { crowd4test: "sign-in", signInUrl: `${SITE}/app/ai-studio`, refreshUrl: `${SITE}/app/ai-studio/refresh`, portalUrl: `${SITE}/app` } };

describe("a Crowd4Test sign-in that ends in the middle of work", () => {
    it("one refused request, with the session still good, changes nothing on the page", async () => {
        const context = await browser.newContext();
        await context.addCookies([{ name: "c4t_access", value: TOKEN, domain: "127.0.0.1", path: "/" }, { name: "c4t_shared", value: "2", domain: "127.0.0.1", path: "/" }]);
        // One background read (the organisations list of Create a project) comes back signed out; the session itself is fine.
        let refused = 0;
        await context.route("**/api/organizations", (route) => (refused++ === 0 ? route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(signInRefusal) }) : route.fallback()));
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        trips.length = 0;
        await page.goto(`${BASE}/#/create`);
        await pwExpect.poll(() => refused, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
        await page.getByLabel("Project name").fill("Still here");
        await page.waitForTimeout(1_500);
        expect(trips).toEqual([]);
        await pwExpect(banner(page)).toHaveCount(0);
        expect(page.url()).toBe(`${BASE}/#/create`);
        await pwExpect(page.getByLabel("Project name")).toHaveValue("Still here");
        expect(errors).toEqual([]);
        await context.close();
    });

    it("a session that really ended is said over the page, which keeps what was typed; signing in again carries on", async () => {
        const { context, page, errors } = await midForm();
        // Signed out on crowd4test.com in another tab: the cookie is gone.
        await context.clearCookies();
        await page.getByRole("radio", { name: /Code/ }).check();
        await page.getByLabel("Application URL").fill("https://shop.example");
        await page.getByRole("button", { name: "Create project" }).click();
        await pwExpect(banner(page)).toBeVisible({ timeout: 10_000 });
        expect(trips).toEqual([]);
        expect(page.url()).toBe(`${BASE}/#/create`);
        await pwExpect(page.getByLabel("Project name")).toHaveValue("Half-typed checkout project");
        await pwExpect(page.getByLabel("Description (optional)")).toHaveValue("Not saved yet");

        // Sign in again opens crowd4test.com in a new tab, set to come back to this same page.
        const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Sign in again" }).click()]);
        await popup.waitForLoadState();
        expect(trips).toEqual(["/create"]);
        await popup.close();

        // Back with a sign-in: the message goes once the tab is looked at again, and the form still holds its text.
        await context.addCookies([{ name: "c4t_access", value: TOKEN, domain: "127.0.0.1", path: "/" }]);
        await page.bringToFront();
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await pwExpect(banner(page)).toHaveCount(0, { timeout: 10_000 });
        await pwExpect(page.getByLabel("Project name")).toHaveValue("Half-typed checkout project");
        expect(errors).toEqual([]);
        await context.close();
    });
});
