/**
 * Signing in judges the outcome, not the page right after the click (src/engine/discovery/auth.ts, afterSubmit), and the crawl loads a
 * page once more when another navigation interrupted it (src/engine/discovery/crawler.ts, gotoOnceMore). A local site on this file's own
 * port: sign-in forms sent by a script (fetch, then location.href; after a slow answer; a client-side route; a token kept in
 * localStorage; a one-time-code step shown after a request), a plain HTML form, wrong passwords, and a page that sends the browser
 * elsewhere while the next load is still going.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { login } from "../src/engine/discovery/auth.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { crawl, gotoOnceMore } from "../src/engine/discovery/crawler.js";
import { totp } from "../src/engine/identity/totp.js";
import { totpAccepted } from "./fixtures/independent-totp.js";

const PORT = 9510;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = "ana@example.test";
const PASS = "Right-pass-1";
const SECRET = "JBSWY3DPEHPK3PXP";
const sessions = new Set<string>();
let server: http.Server;
let browser: Browser;

const layout = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const sid = (req: http.IncomingMessage) => /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
const signedIn = (req: http.IncomingMessage) => sessions.has(sid(req) ?? "");

/** A sign-in form sent by script: `mode` says what the script does after the answer. */
function scriptForm(mode: "redirect" | "slow" | "push" | "storage" | "otp", welcome = false): string {
    const after: Record<typeof mode, string> = {
        redirect: `location.href = "/home";`,
        slow: `location.href = "/home";`,
        push: `history.pushState({}, "", "/app"); document.body.innerHTML = "<h1>Your dashboard</h1><a href='/logout'>Log out</a>";`,
        storage: `localStorage.setItem("token", data.token); location.href = "/home?open=1";`,
        otp: `document.getElementById("f").hidden = true; document.getElementById("code-box").hidden = false;`,
    };
    return layout(
        "Sign in",
        `<h1>Sign in</h1>${welcome ? "<p>Welcome back! Please sign in.</p>" : ""}<p id="err" role="alert"></p>
<form id="f"><label>Email <input id="email" type="email"></label><label>Password <input id="pw" type="password"></label><button type="submit">Log in</button></form>
<form id="code-box" hidden><label>6-digit code <input id="code" autocomplete="one-time-code"></label><button type="submit">Verify</button></form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/login?mode=${mode}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: document.getElementById("email").value, password: document.getElementById("pw").value }) });
  if (!r.ok) { document.getElementById("err").textContent = "Wrong email or password."; return; }
  const data = await r.json();
  ${after[mode]}
});
document.getElementById("code-box").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: document.getElementById("code").value }) });
  if (!r.ok) { document.getElementById("err").textContent = "Code not accepted."; return; }
  location.href = "/home";
});
</script>`,
    );
}

function read(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => resolve(raw));
    });
}

beforeAll(async () => {
    server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", BASE);
        const p = url.pathname;
        const html = (s: string, status = 200, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }).end(s);
        if (p.startsWith("/js-") || p === "/welcome-js") {
            const mode = p.slice(4) as "redirect" | "slow" | "push" | "storage" | "otp";
            return html(p === "/welcome-js" ? scriptForm("redirect", true) : scriptForm(mode));
        }
        if (p === "/api/login" && req.method === "POST") {
            const b = JSON.parse((await read(req)) || "{}") as { email?: string; password?: string };
            const mode = url.searchParams.get("mode");
            if (mode === "slow") await new Promise((r) => setTimeout(r, 1_500));
            if (b.email !== USER || b.password !== PASS) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"no"}');
            if (mode === "otp") return res.writeHead(200, { "content-type": "application/json", "set-cookie": "pending=1; Path=/" }).end('{"next":"code"}');
            const id = `s${sessions.size + 1}`;
            sessions.add(id);
            return res.writeHead(200, { "content-type": "application/json", ...(mode === "storage" ? {} : { "set-cookie": `sid=${id}; Path=/; HttpOnly` }) }).end(JSON.stringify({ token: `tok-${id}` }));
        }
        if (p === "/api/verify" && req.method === "POST") {
            const b = JSON.parse((await read(req)) || "{}") as { code?: string };
            if (!totpAccepted(SECRET, b.code ?? "")) return res.writeHead(401).end();
            const id = `s${sessions.size + 1}`;
            sessions.add(id);
            return res.writeHead(200, { "content-type": "application/json", "set-cookie": `sid=${id}; Path=/; HttpOnly` }).end("{}");
        }
        if (p === "/html-login") {
            if (req.method === "POST") {
                const f = new URLSearchParams(await read(req));
                if (f.get("email") !== USER || f.get("password") !== PASS) return html(layout("Sign in", `<h1>Sign in</h1><p role="alert">Wrong email or password.</p><form method="post" action="/html-login"><input name="email" type="email"><input name="password" type="password"><button type="submit">Log in</button></form>`), 400);
                const id = `s${sessions.size + 1}`;
                sessions.add(id);
                return res.writeHead(303, { location: "/home", "set-cookie": `sid=${id}; Path=/; HttpOnly` }).end();
            }
            return html(layout("Sign in", `<h1>Sign in</h1><form method="post" action="/html-login"><input name="email" type="email"><input name="password" type="password"><button type="submit">Log in</button></form>`));
        }
        if (p === "/home") {
            // The token-in-storage app has no cookie: its home page shows itself to anyone (the script reads the token).
            if (!signedIn(req) && url.searchParams.get("open") === null) return res.writeHead(303, { location: "/html-login" }).end();
            return html(layout("Home", `<h1>Orders</h1><a href="/logout">Log out</a><a href="/second">Second</a>`));
        }
        if (p === "/second") return html(layout("Second", `<h1>Second page</h1><a href="/home">Home</a>`));
        if (p === "/jumps-away") return html(layout("Jumps", `<h1>Jumps</h1><a href="/slow">Slow</a><button id="go">Go</button><script>document.getElementById("go").onclick = async () => { await fetch("/late"); location.href = "/landed"; };</script>`));
        if (p === "/late") {
            await new Promise((r) => setTimeout(r, 300));
            return res.writeHead(200, { "content-type": "application/json" }).end("{}");
        }
        if (p === "/landed") return html(layout("Landed", `<h1>Landed</h1>`));
        if (p === "/slow") {
            await new Promise((r) => setTimeout(r, 1_500));
            return html(layout("Slow", `<h1>Slow page</h1>`));
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    expect((server.address() as AddressInfo).port).toBe(PORT);
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
});

async function signIn(path: string, password = PASS, totpSecret?: string) {
    const session = await BrowserSession.launch(browser, { startUrl: BASE });
    const t0 = Date.now();
    try {
        const r = await login(session, `${BASE}${path}`, { username: USER, password, ...(totpSecret ? { totpSecret } : {}) });
        return { r, ms: Date.now() - t0, session };
    } catch (e) {
        await session.close();
        throw e;
    }
}

describe("signing in waits for the outcome", () => {
    it("a script-sent form (fetch, then location.href) signs in, lands on the next page and stays signed in", async () => {
        const { r, session } = await signIn("/js-redirect");
        try {
            expect(r).toMatchObject({ ok: true, loginPath: "/js-redirect" });
            expect(new URL(r.landingUrl!).pathname).toBe("/home");
            // The next load is neither sent back to the sign-in page nor interrupted by a late navigation.
            const res = await session.page.goto(`${BASE}/second`, { waitUntil: "domcontentloaded" });
            expect(res?.status()).toBe(200);
            expect(new URL(session.page.url()).pathname).toBe("/second");
        } finally {
            await session.close();
        }
    }, 30_000);

    it("three times in a row (no flake)", async () => {
        for (let i = 0; i < 3; i++) {
            const { r, session } = await signIn("/js-redirect");
            await session.close();
            expect(r.ok, `attempt ${i + 1}`).toBe(true);
        }
    }, 60_000);

    it("a wrong password on a script-sent form fails, and quickly (not the whole wait)", async () => {
        const { r, ms, session } = await signIn("/js-redirect", "Wrong-pass-9");
        await session.close();
        expect(r).toMatchObject({ ok: false, error: "Login did not succeed with the supplied credentials" });
        expect(ms).toBeLessThan(8_000);
    }, 30_000);

    it("a plain HTML form still signs in, and a wrong password still fails", async () => {
        const good = await signIn("/html-login");
        await good.session.close();
        expect(good.r).toMatchObject({ ok: true, loginPath: "/html-login" });
        expect(new URL(good.r.landingUrl!).pathname).toBe("/home");
        const bad = await signIn("/html-login", "Wrong-pass-9");
        await bad.session.close();
        expect(bad.r.ok).toBe(false);
        expect(bad.ms).toBeLessThan(8_000);
    }, 30_000);

    it("an answer that takes 1.5 s, a client-side route without a page load, and a token kept in localStorage all sign in", async () => {
        for (const path of ["/js-slow", "/js-push", "/js-storage"]) {
            const { r, session } = await signIn(path);
            await session.close();
            expect(r.ok, path).toBe(true);
        }
    }, 60_000);

    it("a one-time-code step shown after the sign-in request is passed", async () => {
        const { r, session } = await signIn("/js-otp", PASS, SECRET);
        await session.close();
        expect(r).toMatchObject({ ok: true, mechanisms: expect.arrayContaining(["totp"]) });
        expect(new URL(r.landingUrl!).pathname).toBe("/home");
        // The engine's code is the one the fixture's independent TOTP accepts.
        expect(totpAccepted(SECRET, totp(SECRET))).toBe(true);
    }, 30_000);

    it("a signed-out page that says Welcome and keeps the form after a failed sign-in is not taken for success", async () => {
        const { r, session } = await signIn("/welcome-js", "Wrong-pass-9");
        await session.close();
        expect(r.ok).toBe(false);
    }, 30_000);

    it("after a script-sent sign-in the crawl starts on the landing page with no failed page", async () => {
        const { r, session } = await signIn("/js-redirect");
        const events: string[] = [];
        try {
            expect(r.ok).toBe(true);
            const ctx = { config: loadConfig({}), emit: (e: { message: string }) => events.push(e.message), llm: null } as unknown as EngineContext;
            const out = await crawl(session, ctx, { startUrl: r.landingUrl!, maxPages: 5, maxDepth: 1, maxPerPattern: 2 });
            expect(out.pages.map((p) => p.path)).toEqual(expect.arrayContaining(["/home", "/second"]));
            expect(events.filter((m) => /interrupted by another navigation|ERR_ABORTED/i.test(m))).toEqual([]);
        } finally {
            await session.close();
        }
    }, 60_000);
});

describe("a load interrupted by another navigation is tried once more", () => {
    it("the page that sends the browser elsewhere during the next load does not make that load fail", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        try {
            // Without the retry: a plain goto is cut off by the old page's late navigation (started by a click, as a sign-in form's is).
            await session.page.goto(`${BASE}/jumps-away`, { waitUntil: "domcontentloaded" });
            await session.page.click("#go");
            const plain = await session.page.goto(`${BASE}/slow`, { waitUntil: "domcontentloaded" }).then(
                () => "loaded",
                (e: Error) => e.message,
            );
            expect(plain).toMatch(/interrupted by another navigation|net::ERR_ABORTED/i);
            // With it: the same sequence ends on the requested page.
            await session.page.goto(`${BASE}/jumps-away`, { waitUntil: "domcontentloaded" });
            await session.page.click("#go");
            const res = await gotoOnceMore(session.page, `${BASE}/slow`);
            expect(res?.status()).toBe(200);
            expect(new URL(session.page.url()).pathname).toBe("/slow");
        } finally {
            await session.close();
        }
    }, 30_000);

    it("any other load error is not retried", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        try {
            // The session's address guard refuses other addresses: that refusal is passed on as it is, not retried.
            await expect(gotoOnceMore(session.page, "http://127.0.0.1:9/nothing-listens")).rejects.toThrow(/ERR_/);
            await expect(gotoOnceMore(session.page, "http://127.0.0.1:9/nothing-listens")).rejects.not.toThrow(/interrupted|ERR_ABORTED/);
        } finally {
            await session.close();
        }
    }, 30_000);
});
