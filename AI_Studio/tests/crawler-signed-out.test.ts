/**
 * The short signed-out pass after a signed-in crawl: the sign-in page the crawl signed in on becomes a page of the model with its form,
 * and the public pages (welcome, sign-in, create account) that the signed-in navigation hides are added, within the crawl's page cap,
 * without sending any form. A local app in this file (its own port).
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/crawler-signed-out.test.ts
 */
import http from "node:http";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { login } from "../src/engine/discovery/auth.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { addSignedOutPages, crawl } from "../src/engine/discovery/crawler.js";

const PORT = 9871;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;
let browser: Browser;
const posts: string[] = [];

const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const signedIn = (req: http.IncomingMessage) => /(?:^|;\s*)sid=ok/.test(req.headers.cookie ?? "");

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", BASE);
        const send = (body: string, status = 200) => (res.writeHead(status, { "content-type": "text/html" }), res.end(body));
        const go = (to: string, cookie?: string) => (res.writeHead(303, { location: to, ...(cookie ? { "set-cookie": cookie } : {}) }), res.end());
        if (req.method === "POST") {
            posts.push(url.pathname);
            if (url.pathname === "/login") return go("/notes", "sid=ok; Path=/");
            return go("/");
        }
        const inside = signedIn(req);
        switch (url.pathname) {
            case "/":
                return inside ? go("/notes") : send(html("Welcome", `<a href="/login">Sign in</a> <a href="/register">Create account</a> <a href="/about">About</a>`));
            case "/login":
                return inside
                    ? go("/notes")
                    : send(html("Sign in", `<form method="post" action="/login"><label>Email <input name="email" type="email" required></label><label>Password <input name="password" type="password" required></label><button type="submit">Sign in</button></form><a href="/register">Create account</a>`));
            case "/register":
                return send(html("Create account", `<form method="post" action="/register"><label>Email <input name="email" type="email" required></label><label>Name <input name="name" required></label><button type="submit">Create account</button></form>`));
            case "/about":
                return send(html("About", `<a href="/">Home</a>`));
            case "/notes":
                return inside ? send(html("Notes", `<a href="/notes/1">First note</a> <a href="/settings">Settings</a> <a href="/logout">Sign out</a>`)) : go("/login");
            case "/notes/1":
            case "/settings":
                return inside ? send(html(url.pathname === "/settings" ? "Settings" : "First note", `<a href="/notes">Notes</a> <a href="/logout">Sign out</a>`)) : go("/login");
            default:
                return send(html("Not found", ""), 404);
        }
    });
    await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
});

function context(): EngineContext {
    return { config: loadConfig({}), emit: () => undefined, llm: null } as unknown as EngineContext;
}

async function signedInCrawl(maxPages: number) {
    const session = await BrowserSession.launch(browser, { startUrl: BASE });
    try {
        const r = await login(session, BASE, { username: "a@b.test", password: "pw-123456" });
        expect(r.ok).toBe(true);
        const result = await crawl(session, context(), { startUrl: BASE, maxPages, maxDepth: 2, maxPerPattern: 2, seedUrls: r.landingUrl ? [r.landingUrl] : undefined });
        return { result, loginPath: r.loginPath };
    } finally {
        await session.close();
    }
}

describe("the signed-out pass after a signed-in crawl", () => {
    it("the signed-in crawl alone misses the sign-in, create-account and welcome pages", async () => {
        const { result } = await signedInCrawl(20);
        expect([...new Set(result.pages.map((p) => p.path))].sort()).toEqual(["/notes", "/notes/1", "/settings"]);
    });

    it("adds the sign-in page with its form and the public pages, sends no form, and keeps the signed-in pages", async () => {
        const { result, loginPath } = await signedInCrawl(20);
        const before = result.pages.map((p) => p.path);
        posts.length = 0;
        const added = await addSignedOutPages(result, context(), { launch: () => BrowserSession.launch(browser, { startUrl: BASE }), startUrl: BASE, signInPath: loginPath, maxPages: 20, maxPerPattern: 2 });
        expect(posts).toEqual([]);
        const paths = result.pages.map((p) => p.path);
        expect(paths.slice(0, before.length)).toEqual(before);
        expect(paths).toEqual(expect.arrayContaining(["/login", "/register", "/"]));
        const fresh = paths.slice(before.length);
        expect(added).toBe(fresh.length);
        expect(new Set(fresh).size).toBe(fresh.length);
        expect(fresh.filter((p) => before.includes(p))).toEqual([]);
        const signIn = result.pages.find((p) => p.path === "/login")!;
        expect(signIn.type).toBe("login");
        expect(signIn.forms[0]!.fields.map((f) => f.name)).toEqual(["email", "password"]);
        expect(result.navigation).toEqual(expect.arrayContaining([{ from: "/login", to: "/register", label: "Create account" }]));
    });

    it("stays within the crawl's page cap", async () => {
        const { result, loginPath } = await signedInCrawl(5);
        const before = result.pages.map((p) => p.path);
        expect(before.length).toBeLessThan(5);
        await addSignedOutPages(result, context(), { launch: () => BrowserSession.launch(browser, { startUrl: BASE }), startUrl: BASE, signInPath: loginPath, maxPages: 5, maxPerPattern: 2 });
        expect(result.pages.map((p) => p.path)).toEqual([...before, "/login", ...(before.length < 4 ? ["/"] : [])]);
        const none = await addSignedOutPages(result, context(), { launch: () => BrowserSession.launch(browser, { startUrl: BASE }), startUrl: BASE, signInPath: loginPath, maxPages: 5, maxPerPattern: 2 });
        expect(none).toBe(0);
    });
});
