/**
 * Finding more of the app: pages only a sitemap names (one named in robots.txt, behind a sitemap index), links that
 * appear only in a hover menu, a clicked menu, a tab or after "Load more", and a session that ends mid-crawl.
 * Scope and destructive controls still hold. A local site on this file's own port.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { login } from "../src/engine/discovery/auth.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { crawl } from "../src/engine/discovery/crawler.js";

const PORT = 9210;
const BASE = `http://127.0.0.1:${PORT}`;
const hits: string[] = [];
const sessions = new Set<string>();
let logins = 0;
let server: http.Server;
/** Another origin (another port) the app's page also calls: it must never see the project's credential. */
let thirdParty: http.Server;
const seenAuth: Array<{ where: string; path: string; authorization?: string; apiKey?: string }> = [];
const record = (where: string, req: http.IncomingMessage) =>
    seenAuth.push({ where, path: new URL(req.url ?? "/", BASE).pathname, authorization: req.headers.authorization, apiKey: req.headers["x-api-key"] as string | undefined });
let browser: Browser;

const page = (title: string, body = "") => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><a href="/">Home</a>${body}</body></html>`;

const HOME = page(
    "Home",
    `<style>.css ul{display:none}.css:hover ul{display:block}</style>
<nav><ul>
  <li class="css">Products<ul><li><a href="/css-menu">All products</a></li></ul></li>
  <li id="company">Company</li>
</ul></nav>
<button aria-expanded="false" id="more">More</button><div id="more-box"></div>
<div role="tablist"><button role="tab">Overview</button><button role="tab" id="reports">Reports</button></div><div id="panel"></div>
<button id="load">Load more</button><div id="list"></div>
<button aria-expanded="false" id="danger">Delete account</button>
<a href="/logout">Log out</a> <a href="/outside/linked">Elsewhere</a>
<script>
let n = 0;
document.getElementById("company").addEventListener("mouseenter", (e) => { if (!document.getElementById("hm")) e.target.insertAdjacentHTML("beforeend", '<a id="hm" href="/hover-menu">Careers</a>'); });
document.getElementById("more").onclick = (e) => { e.target.setAttribute("aria-expanded", "true"); document.getElementById("more-box").innerHTML = '<a href="/click-menu">Partners</a>'; };
document.getElementById("reports").onclick = () => { document.getElementById("panel").innerHTML = '<a href="/tab-only">Monthly report</a>'; };
document.getElementById("load").onclick = () => { n++; document.getElementById("list").insertAdjacentHTML("beforeend", '<a href="/more-' + n + '">Item ' + n + '</a>'); };
document.getElementById("danger").onclick = () => fetch("/hit/delete");
</script>`,
);

function cookieSid(req: http.IncomingMessage): string | undefined {
    return /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", BASE);
        const p = url.pathname;
        hits.push(p);
        const send = (body: string, type = "text/html", status = 200) => {
            res.writeHead(status, { "content-type": type });
            res.end(body);
        };
        if (p === "/") return send(HOME);
        if (p === "/robots.txt") return send(`User-agent: *\nSitemap: ${BASE}/maps/index.xml\n`, "text/plain");
        if (p === "/maps/index.xml")
            return send(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${BASE}/maps/pages.xml</loc></sitemap><sitemap><loc>http://other.invalid/s.xml</loc></sitemap></sitemapindex>`, "application/xml");
        if (p === "/maps/pages.xml")
            return send(
                `<?xml version="1.0"?><urlset><url><loc>${BASE}/from-sitemap</loc></url><url><loc>${BASE}/outside/listed</loc></url><url><loc>${BASE}/logout</loc></url><url><loc>http://other.invalid/page</loc></url></urlset>`,
                "text/xml",
            );
        if (p === "/login" && req.method === "POST") {
            logins++;
            const sid = `s${logins}`;
            sessions.add(sid);
            res.writeHead(302, { location: "/account", "set-cookie": `sid=${sid}; Path=/` });
            return res.end();
        }
        if (p === "/login") return send(page("Sign in", `<form method="post" action="/login"><input name="username"><input type="password" name="password"><button type="submit">Sign in</button></form>`));
        if (p.startsWith("/account")) {
            const sid = cookieSid(req);
            if (!sid || !sessions.has(sid)) {
                res.writeHead(302, { location: "/login" });
                return res.end();
            }
            // The session ends right after this page: the next signed-in page sends the crawl to the sign-in form.
            if (p === "/account/b") sessions.delete(sid);
            if (p === "/account") return send(page("Account", ["a", "b", "c", "d"].map((x) => `<a href="/account/${x}">Section ${x}</a>`).join(" ")));
            return send(page(`Account ${p.slice(-1)}`));
        }
        if (p.startsWith("/hit/")) return send("ok", "text/plain");
        if (p === "/api-page")
            return send(
                page(
                    "API page",
                    `<img src="http://127.0.0.1:${PORT + 1}/pixel.gif"><script>fetch("/api/me"); fetch("/api/hop"); fetch("http://127.0.0.1:${PORT + 1}/track", { mode: "no-cors" });</script>`,
                ),
            );
        if (p === "/api/me") {
            record("app", req);
            return send("{}", "application/json");
        }
        if (p === "/api/hop") {
            record("app", req);
            res.writeHead(302, { location: `http://127.0.0.1:${PORT + 1}/after-redirect` });
            return res.end();
        }
        return send(page(p.slice(1) || "page"));
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    thirdParty = http.createServer((req, res) => {
        record("third-party", req);
        res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
        res.end("ok");
    });
    await new Promise<void>((r) => thirdParty.listen(PORT + 1, "127.0.0.1", r));
    expect((server.address() as AddressInfo).port).toBe(PORT);
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
    await new Promise((r) => thirdParty?.close(r));
});

function context(events: string[]): EngineContext {
    return { config: loadConfig({}), emit: (e: { message: string }) => events.push(e.message), llm: null } as unknown as EngineContext;
}

describe("discovery finds more of the app", () => {
    it("reads the sitemaps robots.txt names, and links behind hover menus, clicked menus, tabs and Load more", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        const events: string[] = [];
        try {
            const r = await crawl(session, context(events), { startUrl: BASE, maxPages: 60, maxDepth: 3, maxPerPattern: 3 });
            const paths = r.pages.map((p) => p.path);
            expect(paths).toEqual(expect.arrayContaining(["/", "/from-sitemap", "/css-menu", "/hover-menu", "/click-menu", "/tab-only", "/more-1", "/outside/linked"]));
            // Nothing destructive: the logout link (linked and in the sitemap) is never opened, the delete toggle never clicked.
            expect(hits).not.toContain("/logout");
            expect(hits).not.toContain("/hit/delete");
            expect(events).toEqual(expect.arrayContaining([expect.stringMatching(/^Found \d+ pages? from the sitemap$/), expect.stringMatching(/^Found \d+ pages? behind menus, tabs and "Load more"$/)]));
        } finally {
            await session.close();
        }
    }, 120_000);

    it("keeps to the testing scope, for sitemap and menu pages too", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        try {
            const r = await crawl(session, context([]), { startUrl: BASE, maxPages: 60, maxDepth: 3, maxPerPattern: 3, includePaths: ["/from-sitemap", "/tab-only"] });
            const paths = r.pages.map((p) => p.path).sort();
            expect(paths).toEqual(["/", "/from-sitemap", "/tab-only"]);
        } finally {
            await session.close();
        }
    }, 120_000);

    it("signs in again once when the session ends mid-crawl, and carries on", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        const events: string[] = [];
        const creds = { username: "tester@example.com", password: "not-a-real-password" };
        try {
            logins = 0;
            expect((await login(session, `${BASE}/login`, creds)).ok).toBe(true);
            const r = await crawl(session, context(events), {
                startUrl: `${BASE}/account`,
                maxPages: 10,
                maxDepth: 1,
                maxPerPattern: 5,
                relogin: async () => (await login(session, `${BASE}/login`, creds)).ok,
            });
            const titles = r.pages.map((p) => p.title);
            expect(titles).toEqual(expect.arrayContaining(["Account", "Account a", "Account b", "Account c", "Account d"]));
            expect(logins).toBe(2);
            expect(events).toContain("Signed in again after the session ended");
        } finally {
            await session.close();
        }
    }, 120_000);

    it("sends the project's API credential to the app's own origin only, never to another host or a redirect's next hop", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE, authHeaders: { headers: { Authorization: "Bearer test-token-123", "X-Api-Key": "test-key-456" }, origins: [BASE] } });
        try {
            seenAuth.length = 0;
            await crawl(session, context([]), { startUrl: `${BASE}/api-page`, maxPages: 1, maxDepth: 0, maxPerPattern: 1 });
            await session.page.waitForTimeout(500);
            const app = seenAuth.filter((s) => s.where === "app");
            const other = seenAuth.filter((s) => s.where === "third-party");
            expect(app.map((s) => s.path)).toEqual(expect.arrayContaining(["/api/me", "/api/hop"]));
            for (const s of app) expect([s.authorization, s.apiKey]).toEqual(["Bearer test-token-123", "test-key-456"]);
            // The third-party origin was really called (image, fetch, the redirect's next hop), and never with the credential.
            expect(other.map((s) => s.path)).toEqual(expect.arrayContaining(["/pixel.gif", "/track", "/after-redirect"]));
            for (const s of other) expect([s.authorization, s.apiKey]).toEqual([undefined, undefined]);
        } finally {
            await session.close();
        }
    }, 120_000);
});
