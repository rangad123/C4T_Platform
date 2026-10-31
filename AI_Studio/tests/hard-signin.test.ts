/**
 * Hard sign-ins, for real: a platform with its worker, a fixture app on port 6832 whose sign-in goes through a popup window of another
 * site (an "identity provider" on port 6833), real headless Chromium. The test plays the person: it signs in by hand in the browser the
 * platform opened (following the popup), saves the session, and then:
 *  - a run starts signed in (the dashboard opens without a sign-in) and the session's cookie appears in no answer and not in the database;
 *  - email steps get an emailed code and a magic link from mail forwarded to the platform's inbound address;
 *  - a page with a captcha is reported with the captcha sentence, and the sign-in says so too;
 *  - when the app forgets the session, the next run stops before any test with "Sign in again", and no result changes;
 *  - the Test accounts page shows the panel and makes a forwarding address.
 * Run under the shared browser lock.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BrowserSession } from "../src/engine/discovery/browser.js";
import { login } from "../src/engine/discovery/auth.js";
import { pidAlive } from "../src/engine/recorder/session.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { hardSignInOf, hardSignInOptions } from "../src/platform/routes/hard-signin.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const APP_PORT = 6832;
const IDP_PORT = 6833;
const UI_PORT = 6834;
const APP = `http://localhost:${APP_PORT}`;
const IDP = `http://127.0.0.1:${IDP_PORT}`;

// ── the fixture app ─────────────────────────────────────────────────────────
const sessions = new Set<string>();
const codes = new Map<string, string>();
const magic = new Map<string, string>();
let deliver: (to: string, subject: string, text: string, html?: string) => Promise<void> = async () => undefined;
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const cookieOf = (req: http.IncomingMessage) => /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
const readBody = (req: http.IncomingMessage) => new Promise<URLSearchParams>((r) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => r(new URLSearchParams(b)));
});

const app = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", APP);
    const html = (s: string, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "text/html", ...headers });
        res.end(s);
    };
    const signedIn = sessions.has(cookieOf(req) ?? "");
    if (u.pathname === "/") return html(page("Acme", `<h1>Acme</h1><a href="/login">Sign in</a>`));
    if (u.pathname === "/login") {
        // Sign-in only through the identity provider's popup: nothing the platform could fill in.
        return html(page("Sign in", `<h1>Sign in</h1><button id="sso" onclick="window.open('${IDP}/authorize', 'idp', 'width=500,height=600')">Sign in with Acme ID</button>`));
    }
    if (u.pathname === "/callback" && u.searchParams.get("code") === "ok") {
        const sid = `SID-${randomBytes(12).toString("hex")}`;
        sessions.add(sid);
        const exp = new Date(Date.now() + 3600_000).toUTCString();
        return html("", 302, { location: "/dashboard", "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Expires=${exp}` });
    }
    if (u.pathname === "/dashboard") return signedIn ? html(page("Dashboard", "<h1>Your dashboard</h1><p>Signed in.</p>")) : html("", 302, { location: "/login" });
    if (u.pathname === "/revoke") {
        sessions.clear();
        return html("ok");
    }
    if (u.pathname === "/signup" && req.method === "GET") return html(page("Sign up", `<h1>Sign up</h1><form method="post" action="/signup"><label for="e">Email</label><input id="e" name="email" type="email"><button>Sign up</button></form>`));
    if (u.pathname === "/signup" && req.method === "POST") {
        const email = (await readBody(req)).get("email") ?? "";
        const code = String(100000 + Math.floor(Math.random() * 899999));
        codes.set(email, code);
        await deliver(email, "Confirm your email", `Hello! It is 2026.\nYour verification code is ${code}.\nThanks, Acme`);
        return html(page("Check your email", `<h1>Check your email</h1><form method="post" action="/verify"><input type="hidden" name="email" value="${email}"><label for="c">Code</label><input id="c" name="code"><button>Verify</button></form>`));
    }
    if (u.pathname === "/verify" && req.method === "POST") {
        const b = await readBody(req);
        return html(page("Verify", codes.get(b.get("email") ?? "") === b.get("code") ? "<h1>Email verified</h1>" : "<h1>Wrong code</h1>"));
    }
    if (u.pathname === "/magic-request" && req.method === "GET") return html(page("Magic link", `<h1>Get a sign-in link</h1><form method="post" action="/magic-request"><label for="m">Email</label><input id="m" name="email"><button>Send me a link</button></form>`));
    if (u.pathname === "/magic-request" && req.method === "POST") {
        const email = (await readBody(req)).get("email") ?? "";
        const t = randomBytes(8).toString("hex");
        magic.set(t, email);
        await deliver(email, "Your sign-in link", `Open ${APP}/magic?t=${t}`, `<p><a href="https://tracker.example/unsubscribe">Unsubscribe</a> <a href="${APP}/magic?t=${t}">Sign in to Acme</a></p>`);
        return html(page("Sent", "<h1>Link sent</h1>"));
    }
    if (u.pathname === "/magic") return html(page("Welcome", magic.has(u.searchParams.get("t") ?? "") ? "<h1>Welcome back</h1>" : "<h1>Link expired</h1>"));
    if (u.pathname === "/captcha") return html(page("Contact", `<h1>Contact us</h1><div class="g-recaptcha" data-sitekey="test"></div><script src="/recaptcha/api.js"></script>`));
    if (u.pathname === "/captcha-login") return html(page("Sign in", `<h1>Sign in</h1><form><input name="user"><input type="password" name="pw"><div class="h-captcha" data-sitekey="x"></div><button>Sign in</button></form>`));
    if (u.pathname === "/recaptcha/api.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end("/* a local stand-in: no request leaves this computer */");
    }
    html("not found", 404);
});
const idp = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page("Acme ID", `<h1>Acme ID</h1><button id="allow" onclick="window.opener.location.href='${APP}/callback?code=ok'; window.close();">Allow</button>`));
});

// ── the platform ────────────────────────────────────────────────────────────
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;
let browser: Browser | undefined;

beforeAll(async () => {
    await new Promise<void>((r) => app.listen(APP_PORT, "127.0.0.1", r));
    await new Promise<void>((r) => idp.listen(IDP_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-wa-"));
    hardSignInOptions.launch = (headless) => chromium.launch({ headless });
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
    deliver = async (to, subject, text, html) => {
        const r = await server.inject({ method: "POST", url: inboundPath, payload: { to, from: "noreply@acme.test", subject, text, ...(html ? { html } : {}) } });
        if (r.statusCode !== 202) throw new Error(`inbound ${r.statusCode}`);
    };
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    delete hardSignInOptions.launch;
    await new Promise((r) => app.close(r));
    await new Promise((r) => idp.close(r));
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* Windows may hold a file a moment longer */
    }
});

const call = async (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, ...(payload !== undefined ? { payload: payload as never } : {}) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, raw: res.body };
};
const until = async <T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v !== undefined) return v;
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 250));
    }
};
async function waitJob(jobId: string): Promise<{ status: string; error: string | null }> {
    return until(async () => {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        return ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status) ? j : undefined;
    }, 240_000);
}
const testsOf = async (pid: string) => (await call("GET", `/api/projects/${pid}/tests`)).body as Array<{ id: string; title: string; validationStatus: string; validationReason: string | null }>;

let projectId = "";
let inboundPath = "";
const spec = (title: string, steps: unknown[], testData: Record<string, string> = {}) => ({ title, kind: "web", steps, testData });

describe("hard sign-ins on a real app", () => {
    it("signs in once by hand through a popup, saves the session encrypted, and never shows it", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Acme SSO" })).body.id;
        const imported = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs: [spec("Dashboard opens", [{ action: "navigate", url: "/dashboard" }, { action: "assert", check: "visible", expected: "Your dashboard" }])] });
        expect(imported.status).toBe(202);
        expect((await call("POST", `/api/projects/${projectId}/sessions/nobody/capture`, { headed: false })).status).toBe(404);

        const started = await call("POST", `/api/projects/${projectId}/sessions/main/capture`, { url: "/login", headed: false });
        expect(started.status).toBe(201);
        expect((await call("POST", `/api/projects/${projectId}/sessions/main/capture`, { headed: false })).status).toBe(409);
        await until(async () => ((await call("GET", `/api/projects/${projectId}/sessions/capture`)).body.status === "open" ? true : undefined));
        const capture = hardSignInOf(server)!.captureHandle(projectId)!;
        const pid = capture.browserPid();
        const main = capture.mainPage()!;
        // The person: opens the identity provider's popup and allows.
        const [popup] = await Promise.all([main.waitForEvent("popup"), main.click("#sso")]);
        await popup.waitForLoadState("domcontentloaded");
        expect((await call("GET", `/api/projects/${projectId}/sessions/capture`)).body).toMatchObject({ popupOpen: true, popups: 1 });
        await popup.click("#allow");
        await main.waitForURL(`${APP}/dashboard`);
        const view = await until(async () => {
            const c = (await call("GET", `/api/projects/${projectId}/sessions/capture`)).body;
            return c.popupOpen === false && c.currentUrl === `${APP}/dashboard` ? c : undefined;
        });
        expect(view.popups).toBe(1);

        const saved = await call("POST", `/api/projects/${projectId}/sessions/capture/save`);
        expect(saved.status).toBe(200);
        expect(saved.body.session).toMatchObject({ account: "main", how: "browser", checkUrl: `${APP}/dashboard`, cookies: 1 });
        expect(Date.parse(saved.body.session.expiresAt)).toBeGreaterThan(Date.now());
        if (pid) expect(pidAlive(pid)).toBe(false);
        const sid = [...sessions][0]!;
        const answers = [saved.raw, (await call("GET", `/api/projects/${projectId}/hard-sign-in`)).raw, (await call("GET", `/api/projects/${projectId}`)).raw];
        for (const a of answers) expect(a).not.toContain(sid);
        expect(fs.readFileSync(path.join(dir, "platform.db")).includes(sid)).toBe(false);

        const check = await call("POST", `/api/projects/${projectId}/sessions/main/check`);
        expect(check.body).toMatchObject({ signedIn: true, session: { state: "ok", checkOk: true } });
    }, 120_000);

    it("runs start signed in, email steps get the emailed code and link, and a captcha is named", async () => {
        const box = await call("PUT", `/api/projects/${projectId}/mailbox`, { kind: "inbound" });
        expect(box.body.inboundPath).toMatch(/^\/api\/inbound-mail\/[A-Za-z0-9_-]{30,}$/);
        inboundPath = box.body.inboundPath;
        expect((await call("POST", "/api/inbound-mail/not-a-real-token-at-all-000000", { to: "a@b.test", text: "x" })).status).toBe(404);
        const addr = { addr: "qa+{{unique}}@mail.test" };
        const imported = await call("POST", `/api/projects/${projectId}/specs`, {
            validate: false,
            specs: [
                spec("Sign up with an emailed code", [{ action: "navigate", url: "/signup" }, { action: "fill", locator: { by: "label", value: "Email" }, value: "{{addr}}" }, { action: "click", locator: { by: "role", role: "button", value: "Sign up" } }, { action: "email", to: "{{addr}}", use: "code", locator: { by: "label", value: "Code" } }, { action: "click", locator: { by: "role", role: "button", value: "Verify" } }, { action: "assert", check: "visible", expected: "Email verified" }], addr),
                spec("Sign in with a magic link", [{ action: "navigate", url: "/magic-request" }, { action: "fill", locator: { by: "label", value: "Email" }, value: "{{addr}}" }, { action: "click", locator: { by: "role", role: "button", value: "Send me a link" } }, { action: "assert", check: "visible", expected: "Link sent" }, { action: "email", to: "{{addr}}", use: "link" }, { action: "assert", check: "visible", expected: "Welcome back" }], addr),
                spec("Contact form", [{ action: "navigate", url: "/captcha" }, { action: "assert", check: "visible", expected: "Message sent" }]),
            ],
        });
        expect(imported.status).toBe(202);
        const run = await call("POST", `/api/projects/${projectId}/runs`, {});
        expect(run.status).toBe(202);
        const job = await waitJob(run.body.jobId);
        const tests = await testsOf(projectId);
        const by = (t: string) => tests.find((x) => x.title === t)!;
        expect(by("Dashboard opens").validationStatus).toBe("VALIDATED");
        expect(by("Sign up with an emailed code")).toMatchObject({ validationStatus: "VALIDATED" });
        expect(by("Sign in with a magic link")).toMatchObject({ validationStatus: "VALIDATED" });
        expect(by("Contact form")).toMatchObject({ validationStatus: "NEEDS_REVIEW", validationReason: expect.stringMatching(/^This page has a captcha \(reCAPTCHA\); use a saved session or ask the site to turn it off for tests\./) });
        expect(job.status).not.toBe("FAILED");
        const events = JSON.stringify((await call("GET", `/api/test-generation/${run.body.jobId}/events`)).body);
        expect(events).toContain("start signed in with the saved sign-in");
        expect(events).not.toContain([...sessions][0]!);
    }, 300_000);

    it("the sign-in itself stops at a captcha and says so", async () => {
        browser = await chromium.launch({ headless: true });
        const s = await BrowserSession.launch(browser, { startUrl: APP });
        try {
            const r = await login(s, `${APP}/captcha-login`, { username: "u", password: "p" });
            expect(r).toMatchObject({ ok: false, error: "This page has a captcha (hCaptcha) at /captcha-login; use a saved session or ask the site to turn it off for tests." });
        } finally {
            await s.close();
        }
    }, 60_000);

    it("when the app forgets the session, the next run stops before any test and asks to sign in again", async () => {
        await fetch(`${APP}/revoke`);
        const before = await testsOf(projectId);
        const run = await call("POST", `/api/projects/${projectId}/runs`, {});
        const job = await waitJob(run.body.jobId);
        expect(job.status).toBe("FAILED");
        expect(job.error).toMatch(/^The saved sign-in for this project no longer works \(The page asks for a password again|^The saved sign-in for this project no longer works \(The page moved to a sign-in address/);
        expect(job.error).toContain("Sign in again under Test accounts");
        const after = await testsOf(projectId);
        expect(after.map((t) => [t.id, t.validationStatus])).toEqual(before.map((t) => [t.id, t.validationStatus]));
        expect((await call("GET", `/api/projects/${projectId}/hard-sign-in`)).body.sessions[0]).toMatchObject({ state: "expired", checkOk: false });
    }, 120_000);

    it("the Test accounts page shows saved sign-ins and makes a forwarding address", async () => {
        if (!fs.existsSync(path.join(process.cwd(), "web", "dist", "index.html"))) {
            const b = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "web"], { stdio: "ignore" });
            expect(b.status).toBe(0);
        }
        await server.listen({ port: UI_PORT, host: "127.0.0.1" });
        browser ??= await chromium.launch({ headless: true });
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const p = await ctx.newPage();
        try {
            await p.goto(`http://127.0.0.1:${UI_PORT}/#/projects/${projectId}/settings?section=accounts`);
            await p.getByRole("heading", { name: "Saved sign-ins", exact: true }).waitFor();
            await p.getByText("Signed out", { exact: true }).waitFor();
            await p.getByRole("button", { name: "Sign in again", exact: true }).waitFor();
            await p.getByRole("heading", { name: "Test mailbox", exact: true }).waitFor();
            await p.getByRole("button", { name: "Make a new address", exact: true }).click();
            await p.getByText("Your forwarding address (shown once)", { exact: true }).waitFor();
            const shown = await p.locator("code").filter({ hasText: "/api/inbound-mail/" }).innerText();
            expect(shown).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${UI_PORT}/api/inbound-mail/[A-Za-z0-9_-]{30,}$`));
            // At phone width nothing scrolls sideways.
            await p.setViewportSize({ width: 375, height: 800 });
            expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        } finally {
            await ctx.close();
        }
    }, 240_000);
});
