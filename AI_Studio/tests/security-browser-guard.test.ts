/**
 * Security Assessment, the scope guard in a REAL Chromium: `browserRouteGuard` on a context. The page is served by a local app WE own
 * under a name only the guard's resolver knows ("app.test"), so it can only load through the guard's pinned connection. The guard
 * lets in-scope reads through (cookies included), never sends a POST (a form submit, a script's beacon), never requests an excluded
 * path, another origin or a private address outside scope, and stops a redirect that leaves the scope.
 *
 * Ports: 7012 (the app), 7013 (the "outside" server that must never be reached). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-browser-guard.test.ts
 */
import http from "node:http";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SecurityApplication } from "../src/security/contract.js";
import { browserRouteGuard, createScopeSession, type Resolver, type ScopeEvent } from "../src/security/scope.js";

const APP_PORT = 7012;
const OUTSIDE_PORT = 7013;
const ORIGIN = `http://app.test:${APP_PORT}`;
const hits: string[] = [];
const outsideHits: string[] = [];
let appServer: http.Server;
let outsideServer: http.Server;
let browser: Browser;

const HOME = `<!doctype html><html><head><title>Fixture shop</title><link rel="stylesheet" href="/style.css"></head><body>
<h1>Fixture shop</h1>
<img src="/logo.png" alt="logo">
<script src="http://127.0.0.1:${OUTSIDE_PORT}/tracker.js"></script>
<iframe src="/admin/billing" title="billing"></iframe>
<form id="signin" method="post" action="/login"><input name="user" value="x"><button>Sign in</button></form>
<p id="data">loading</p>
<script>
  fetch("/api/data").then(r => r.text()).then(t => { document.getElementById("data").textContent = t; });
  fetch("/api/track", { method: "POST", body: "x" }).catch(() => {});
  fetch("http://10.0.0.5/internal").catch(() => {});
</script>
</body></html>`;

beforeAll(async () => {
    appServer = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        const u = req.url ?? "/";
        if (u === "/") return res.writeHead(200, { "content-type": "text/html", "set-cookie": ["sid=fixture-session; Path=/", "theme=dark; Path=/"] }).end(HOME);
        if (u === "/style.css") return res.writeHead(200, { "content-type": "text/css" }).end("h1{color:teal}");
        if (u === "/api/data") return res.writeHead(200, { "content-type": "text/plain" }).end(`data for ${req.headers.cookie ?? "nobody"}`);
        if (u === "/leave") return res.writeHead(302, { location: `http://127.0.0.1:${OUTSIDE_PORT}/stolen` }).end();
        if (u === "/hop") return res.writeHead(302, { location: "/landing" }).end();
        if (u === "/landing") return res.writeHead(200, { "content-type": "text/html" }).end("<h1>Landing</h1>");
        res.writeHead(404).end("no");
    });
    outsideServer = http.createServer((req, res) => {
        outsideHits.push(`${req.method} ${req.url}`);
        res.end("outside");
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", r));
    await new Promise<void>((r) => outsideServer.listen(OUTSIDE_PORT, "127.0.0.1", r));
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await new Promise((r) => appServer.close(r));
    await new Promise((r) => outsideServer.close(r));
});

const app: Pick<SecurityApplication, "targetUrl" | "scope" | "excludedPaths" | "maxRequestsPerSecond"> = { targetUrl: `${ORIGIN}/`, scope: [], excludedPaths: ["/admin/billing"], maxRequestsPerSecond: 10 };
const resolver: Resolver = async (host) => {
    if (host === "app.test") return [{ address: "127.0.0.1", family: 4 }];
    throw new Error("ENOTFOUND");
};

describe("browserRouteGuard in Chromium", () => {
    it("loads in-scope reads through the pinned connection and blocks everything else", async () => {
        const events: ScopeEvent[] = [];
        const session = createScopeSession(app, { allowPrivate: true, resolver, onEvent: (e) => events.push(e) });
        const context = await browser.newContext({ serviceWorkers: "block" });
        try {
            const received: Array<{ url: string; cookies: string[] }> = [];
            await context.route("**/*", browserRouteGuard(session, { onResponse: (r) => received.push({ url: r.url, cookies: r.setCookies }) }));
            const page = await context.newPage();
            await page.goto(`${ORIGIN}/`);
            await expect.poll(() => received.some((r) => r.url === `${ORIGIN}/` && r.cookies.length === 2)).toBe(true);
            await expect.poll(async () => page.locator("#data").textContent(), { timeout: 10_000 }).toBe("data for sid=fixture-session; theme=dark");
            expect(await page.title()).toBe("Fixture shop");
            // Both cookies of the answer reached the browser (one set-cookie header each).
            expect((await context.cookies()).map((c) => `${c.name}=${c.value}`).sort()).toEqual(["sid=fixture-session", "theme=dark"]);

            // A form submit is a POST: never sent.
            await page.evaluate(() => (document.getElementById("signin") as HTMLFormElement).submit()).catch(() => undefined);
            await page.waitForTimeout(500);

            // An in-scope redirect is followed by the guard (each hop checked; the page keeps the address it asked for); one that
            // leaves the scope is not followed at all and the navigation fails.
            const page2 = await context.newPage();
            await page2.goto(`${ORIGIN}/hop`);
            expect(await page2.locator("h1").textContent()).toBe("Landing");
            const left = await page2.goto(`${ORIGIN}/leave`).then(() => null, (e: Error) => e);
            expect(left).not.toBeNull();
            expect(page2.url()).not.toContain(`${OUTSIDE_PORT}`);

            expect(hits).toEqual(expect.arrayContaining(["GET /", "GET /style.css", "GET /api/data", "GET /hop", "GET /landing", "GET /leave"]));
            expect(hits.filter((h) => !h.startsWith("GET "))).toEqual([]);
            expect(hits).not.toContain("GET /admin/billing");
            // Images, media and fonts are not needed by a passive assessment: not requested.
            expect(hits).not.toContain("GET /logo.png");
            expect(outsideHits).toEqual([]);

            const blocked = events.filter((e): e is Extract<ScopeEvent, { type: "blocked" }> => e.type === "blocked");
            const codes = new Set(blocked.map((e) => `${e.code} ${new URL(e.url).pathname}`));
            expect(codes.has("out-of-scope /tracker.js")).toBe(true);
            expect(codes.has("excluded-path /admin/billing")).toBe(true);
            expect(codes.has("method /api/track")).toBe(true);
            expect(codes.has("method /login")).toBe(true);
            expect(codes.has("out-of-scope /internal")).toBe(true);
            expect(codes.has("out-of-scope /stolen")).toBe(true);
            expect(blocked.every((e) => (e.code === "out-of-scope" && new URL(e.url).pathname === "/stolen" ? e.via === "redirect" : e.via === "browser"))).toBe(true);
            expect(session.stats.requests).toBe(hits.length);
        } finally {
            await context.close();
        }
    }, 60_000);

    it("aborts everything once the session is stopped", async () => {
        const session = createScopeSession(app, { allowPrivate: true, resolver });
        const context = await browser.newContext({ serviceWorkers: "block" });
        try {
            await context.route("**/*", browserRouteGuard(session));
            session.stop();
            const before = hits.length;
            const page = await context.newPage();
            const err = await page.goto(`${ORIGIN}/`).then(() => null, (e: Error) => e);
            expect(err).not.toBeNull();
            expect(hits.length).toBe(before);
        } finally {
            await context.close();
        }
    }, 60_000);
});
