/**
 * Client-side route discovery against examples/spa-app: hash routes, pushState links (one of which
 * 404s when loaded directly), an href-less nav button, plus anchors/destructive routes that must be
 * ignored.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { crawl, normalizeUrl, urlPattern } from "../src/engine/discovery/crawler.js";

const PORT = 5091;
const BASE = `http://127.0.0.1:${PORT}`;
let app: ChildProcess;
let browser: Browser;

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/spa-app/server.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    app?.kill();
});

describe("URL normalisation", () => {
    it("keeps hash routes, drops in-page anchors and root hash routes", () => {
        expect(normalizeUrl("/#/active", BASE)).toBe(`${BASE}/#/active`);
        expect(normalizeUrl("/#/active/", BASE)).toBe(`${BASE}/#/active`);
        expect(normalizeUrl("/#!/archive", BASE)).toBe(`${BASE}/#!/archive`);
        expect(normalizeUrl("/#features", BASE)).toBe(`${BASE}/`);
        expect(normalizeUrl("/#/", BASE)).toBe(`${BASE}/`);
        expect(normalizeUrl("/docs/#!/", BASE)).toBe(`${BASE}/docs`);
    });

    it("collapses ids inside hash routes for the per-pattern cap", () => {
        expect(urlPattern(`${BASE}/#/inbox/42`)).toBe(urlPattern(`${BASE}/#/inbox/7`));
        expect(urlPattern(`${BASE}/#/inbox/42`)).not.toBe(urlPattern(`${BASE}/#/inbox`));
        expect(urlPattern(`${BASE}/products/3`)).toBe("/products/{id}");
    });
});

describe("SPA crawl", () => {
    it("discovers hash routes and pushState routes, and stays away from destructive ones", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE + "/" });
        const ctx = { config: loadConfig({}), emit: () => undefined, llm: null as any } as unknown as EngineContext;
        try {
            const r = await crawl(session, ctx, { startUrl: BASE + "/", maxPages: 15, maxDepth: 3, maxPerPattern: 2 });
            const byPath = Object.fromEntries(r.pages.map((p) => [p.path, p]));
            const paths = Object.keys(byPath).sort();

            // Hash routes, each rendering its own view.
            expect(byPath["/#/inbox"]?.headings).toContain("Inbox");
            expect(byPath["/#/inbox/42"]?.headings).toContain("Message 42");
            expect(byPath["/#!/archive"]?.headings).toContain("Archive");
            // pushState link the server also serves.
            expect(byPath["/about"]?.headings).toContain("About");
            // pushState link that 404s server-side: reached by replaying the click from its parent.
            expect(byPath["/reports"]?.status).toBe(200);
            expect(byPath["/reports"]?.headings).toContain("Reports");
            // pushState from an href-less nav button.
            expect(byPath["/settings"]?.headings).toContain("Settings");

            // Root route counted once; in-page anchor ignored; destructive route/control never used.
            expect(paths.filter((p) => p === "/" || p.startsWith("/#/") && p.length <= 3)).toEqual(["/"]);
            expect(paths.some((p) => p.includes("features"))).toBe(false);
            expect(paths.some((p) => /logout|danger/.test(p))).toBe(false);
            expect(r.pages.some((p) => p.headings.includes("Account deleted") || p.headings.includes("Logged out"))).toBe(false);
            expect(new Set(r.pages.map((p) => p.url)).size).toBe(r.pages.length);

            expect(r.navigation).toContainEqual({ from: "/", to: "/settings", label: "Settings" });
        } finally {
            await session.close();
        }
    }, 120_000);

    it("respects maxPages", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE + "/" });
        const ctx = { config: loadConfig({}), emit: () => undefined, llm: null as any } as unknown as EngineContext;
        try {
            const r = await crawl(session, ctx, { startUrl: BASE + "/", maxPages: 3, maxDepth: 3, maxPerPattern: 2 });
            expect(r.pages.length).toBe(3);
        } finally {
            await session.close();
        }
    }, 60_000);
});
