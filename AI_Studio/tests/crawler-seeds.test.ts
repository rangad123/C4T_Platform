/**
 * Extra crawl seeds (e.g. where login landed). Found on a real site (saucedemo.com): it keeps showing the
 * login form at "/" when signed in and never links to the app from there, so a crawl seeded only with
 * the start URL never reached the product pages.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { login } from "../src/engine/discovery/auth.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { crawl, looksLikeErrorPage } from "../src/engine/discovery/crawler.js";

const PORT = 5171;
const BASE = `http://127.0.0.1:${PORT}`;
let app: ChildProcess;
let browser: Browser;
const ctx = { config: loadConfig({}), emit: () => undefined, llm: null } as unknown as EngineContext;

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    browser = await launchChromium(true);
}, 20_000);
afterAll(async () => {
    await browser?.close();
    app?.kill();
});

describe("crawl seeds", () => {
    it("login reports where it landed", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        try {
            const r = await login(session, BASE, { username: "demo@example.com", password: "Password123!" });
            expect(r.ok).toBe(true);
            expect(new URL(r.landingUrl!).pathname).toBe("/account");
        } finally {
            await session.close();
        }
    }, 60_000);

    it("visits seed URLs even when nothing links to them from the start page", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        try {
            // Depth 0: no links are followed, so /products/3 is reachable only as a seed.
            const r = await crawl(session, ctx, { startUrl: BASE, maxPages: 5, maxDepth: 0, maxPerPattern: 2, seedUrls: [`${BASE}/products/3`] });
            expect(r.pages.map((p) => p.path)).toEqual(expect.arrayContaining(["/", "/products/3"]));
        } finally {
            await session.close();
        }
    }, 60_000);
});

describe("error-page detection", () => {
    it("does not trust the status code alone (SPA served via a 404 fallback)", () => {
        // saucedemo.com: working product page, HTTP 404, 19 controls
        expect(looksLikeErrorPage(404, "Products Sauce Labs Backpack $29.99 Add to cart", 19)).toBe(false);
    });
    it("recognises real error pages", () => {
        expect(looksLikeErrorPage(404, "Page not found. The page you requested does not exist.", 6)).toBe(true);
        expect(looksLikeErrorPage(500, "Something", 1)).toBe(true);
        expect(looksLikeErrorPage(200, "not found anywhere", 1)).toBe(false);
    });
});
