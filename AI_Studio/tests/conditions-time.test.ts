/**
 * Time, conditions, sign-ins beyond cookies and live apps, for real: a local fixture site on port 9320 and headless Chromium.
 *  - a clock step finishes a 10-minute countdown in a moment; a pinned date keeps a page that prints the time visually stable;
 *  - dark mode, another locale and time zone, and JavaScript off run as variants (and show they really applied);
 *  - an offline step in the middle of a form shows the app's offline message (script and live interpreter);
 *  - a sign-in kept in IndexedDB and sessionStorage is captured and survives into a run;
 *  - a saved sign-in that has run out is renewed once for the whole run;
 *  - the WebSocket the app opens is recorded, and the socket and offline faults are caught by a test that checks the live data.
 * Run under the shared browser lock.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type net from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SignInCapture } from "../src/engine/auth/capture.js";
import { RENEWED_LINE } from "../src/engine/auth/run-session.js";
import { NetworkInterceptor } from "../src/engine/discovery/network.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { classifyFaultRun } from "../src/engine/mutation/faults.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts, type RunEnv, type ScriptInput } from "../src/engine/validation/runner.js";
import { runVariantChecks, type VariantRecord } from "../src/engine/validation/variants.js";
import { executeStep, runtimeData } from "../src/engine/web/interpreter.js";
import { socketFaultScript } from "../src/engine/web/socket-faults.js";

const PORT = 9320;
const BASE = `http://127.0.0.1:${PORT}`;
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

let logins = 0;
const fresh = new Set<string>();
const readBody = (req: http.IncomingMessage) => new Promise<URLSearchParams>((r) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => r(new URLSearchParams(b)));
});

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", BASE);
    const html = (s: string, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "text/html", ...headers });
        res.end(s);
    };
    switch (u.pathname) {
        case "/countdown":
            return html(page("Countdown", `<h1>Your session</h1><p id="left"></p><script>
                const end = Date.now() + 10 * 60 * 1000;
                const tick = () => { const s = Math.round((end - Date.now()) / 1000); document.getElementById("left").textContent = s > 0 ? "Session ends in " + s + " s" : "Session expired"; };
                tick(); setInterval(tick, 1000);</script>`));
        case "/today":
            return html(page("Today", `<h1>Today</h1><p id="t" style="font: 20px monospace"></p><script>document.getElementById("t").textContent = new Date().toISOString();</script>`));
        case "/theme":
            return html(page("Theme", `<h1>Theme page</h1><p id="m"></p><p id="z"></p><button onclick="this.textContent='Clicked'">Press</button><script>
                document.getElementById("m").textContent = matchMedia("(prefers-color-scheme: dark)").matches ? "Dark theme" : "Light theme";
                document.getElementById("z").textContent = "Zone " + Intl.DateTimeFormat().resolvedOptions().timeZone + " " + navigator.language;</script>`));
        case "/form":
            return html(page("Form", `<h1>Profile</h1><label for="n">Name</label><input id="n"><button id="s">Save</button><p id="msg"></p><script>
                document.getElementById("s").onclick = () => fetch("/save", { method: "POST", body: document.getElementById("n").value })
                    .then(() => (document.getElementById("msg").textContent = "Saved"))
                    .catch(() => (document.getElementById("msg").textContent = "You are offline. Your changes are kept."));</script>`));
        case "/save":
            return html("ok");
        case "/idb-login":
            return html(page("Sign in", `<h1>Sign in</h1><button id="go">Sign in</button><script>
                document.getElementById("go").onclick = () => { const r = indexedDB.open("auth", 1); r.onupgradeneeded = () => r.result.createObjectStore("tokens");
                  r.onsuccess = () => { const tx = r.result.transaction("tokens", "readwrite"); tx.objectStore("tokens").put({ token: "tok-abc123456", user: "Ada" }, "user");
                    tx.oncomplete = () => { sessionStorage.setItem("tab", "tab-xyz98765"); location.href = "/idb-home"; }; }; };</script>`));
        case "/idb-home":
            return html(page("Home", `<h1>Home</h1><p id="who">Checking</p><p id="tab"></p><script>
                document.getElementById("tab").textContent = sessionStorage.getItem("tab") === "tab-xyz98765" ? "Tab: present" : "Tab: missing";
                const r = indexedDB.open("auth", 1); r.onupgradeneeded = () => r.result.createObjectStore("tokens");
                r.onsuccess = () => { const q = r.result.transaction("tokens").objectStore("tokens").get("user");
                  q.onsuccess = () => (document.getElementById("who").textContent = q.result ? "Signed in as " + q.result.user : "Signed out"); };</script>`));
        case "/login":
            if (req.method === "POST") {
                const b = await readBody(req);
                if (b.get("username") !== "ada" || b.get("password") !== "pw-secret-1") return html(page("Sign in", "<p>Wrong</p>"), 401);
                logins++;
                const sid = `fresh-${logins}-session`;
                fresh.add(sid);
                return html("", 302, { location: "/account", "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
            }
            return html(page("Sign in", `<h1>Sign in</h1><form method="post" action="/login"><label for="u">Username</label><input id="u" name="username"><label for="p">Password</label><input id="p" name="password" type="password"><button>Sign in</button></form>`));
        case "/account": {
            const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
            return fresh.has(sid) ? html(page("Account", "<h1>Your account</h1>")) : html("", 302, { location: "/login" });
        }
        case "/live":
            return html(page("Live", `<h1>Prices</h1><p id="p">Waiting</p><script>
                const ws = new WebSocket("ws://127.0.0.1:${PORT}/feed?token=abc");
                ws.onmessage = (e) => { try { const d = JSON.parse(e.data); document.getElementById("p").textContent = d.price ? "Price: " + d.price : "Feed error"; } catch { document.getElementById("p").textContent = "Feed error"; } };
                ws.onclose = () => { if (document.getElementById("p").textContent === "Waiting") document.getElementById("p").textContent = "Disconnected"; };</script>`));
    }
    html("not found", 404);
});
// A minimal WebSocket server (handshake and one text frame), so the fixture needs no package.
const sockets = new Set<net.Socket>();
server.on("upgrade", (req, socket: net.Socket) => {
    sockets.add(socket);
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const payload = Buffer.from(JSON.stringify({ price: "42" }));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    socket.on("data", () => undefined);
    socket.on("error", () => undefined);
});

const spec = (s: Record<string, unknown>): TestSpec => TestSpecSchema.parse({ kind: "web", title: "A fixture test", ...s });
const script = (t: TestSpec, extra: Partial<ScriptInput> = {}): ScriptInput => {
    const r = renderWithAdapter(t, "playwright", { baseUrl: BASE });
    return { testId: t.testId, filename: r.filename, content: r.content, framework: "playwright", ...extra };
};
const env: RunEnv = { baseUrl: BASE, headless: true };
let scratch: string;
let browser: Browser;

beforeAll(async () => {
    // Run folders live under the repository, as the platform's do (.validation): the scripts resolve @playwright/test from there.
    fs.mkdirSync(path.join(process.cwd(), ".validation"), { recursive: true });
    scratch = fs.mkdtempSync(path.join(process.cwd(), ".validation", "k-conditions-"));
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
    for (const s of sockets) s.destroy();
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(scratch, { recursive: true, force: true });
});

describe("time", () => {
    it("a clock step finishes a 10-minute countdown at once, in the script and live", async () => {
        const t = spec({
            testId: "WEB-101",
            steps: [
                { action: "clock", op: "install", time: "2025-01-15T09:00:00Z" },
                { action: "navigate", url: "/countdown" },
                { action: "assert", check: "text", locator: { by: "css", value: "#left" }, expected: "Session ends in 600 s" },
                { action: "clock", op: "fastForward", minutes: 11 },
                { action: "assert", check: "text", locator: { by: "css", value: "#left" }, expected: "Session expired" },
            ],
        });
        const s = script(t);
        expect(s.content).toContain("await page.clock.install({ time: new Date(\"2025-01-15T09:00:00.000Z\") });");
        expect(s.content).toContain("await page.clock.fastForward(660000);");
        const [run] = await runScripts(scratch, [s], env, { workers: 1 });
        expect(run!.status, run!.error).toBe("passed");

        const p = await browser.newPage();
        for (const step of t.steps) await executeStep(p, step as never, runtimeData({}), BASE);
        await p.close();
    }, 120_000);

    it("a pinned date keeps a page that prints the time visually stable (without it the screenshot differs)", async () => {
        const steps = [{ action: "navigate", url: "/today" }, { action: "assert", check: "screenshot", expected: 0 }];
        const pinned = spec({ testId: "WEB-102", pinnedTime: "2025-01-15", steps });
        expect(script(pinned).content).toContain('await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));');
        const first = await runScripts(scratch, [script(pinned)], env, { workers: 1 });
        const base = first[0]!.newBaselines ?? [];
        expect(base.length).toBe(1);
        const keep = path.join(scratch, "pinned.png");
        fs.copyFileSync(base[0]!.path, keep);
        const again = await runScripts(scratch, [script(pinned, { baselines: [{ name: base[0]!.name, path: keep }] })], env, { workers: 1 });
        expect(again[0]!.status, again[0]!.error).toBe("passed");

        const loose = spec({ testId: "WEB-102", steps });
        const unpinned = await runScripts(scratch, [script(loose, { baselines: [{ name: base[0]!.name, path: keep }] })], env, { workers: 1 });
        expect(unpinned[0]!.status).toBe("failed");
    }, 180_000);
});

describe("conditions", () => {
    it("dark mode, another locale and time zone, and JavaScript off run as variants, and really apply", async () => {
        const light = spec({ testId: "WEB-111", priority: "high", steps: [{ action: "navigate", url: "/theme" }, { action: "assert", check: "text", locator: { by: "css", value: "#m" }, expected: "Light theme" }] });
        const zone = spec({ testId: "WEB-112", priority: "high", steps: [{ action: "navigate", url: "/theme" }, { action: "assert", check: "text", locator: { by: "css", value: "#z" }, expected: "Pacific/Auckland de-DE" }] });
        const acts = spec({ testId: "WEB-113", priority: "high", steps: [{ action: "navigate", url: "/theme" }, { action: "click", locator: { by: "role", role: "button", value: "Press" } }, { action: "assert", check: "visible", locator: { by: "role", role: "button", value: "Clicked" } }] });
        const recorded: Array<{ testId: string; r: VariantRecord }> = [];
        await runVariantChecks(
            { config: loadConfig({ DATA_DIR: scratch }), llm: undefined as never, emit: () => undefined },
            { scratchDir: scratch, env, render: { baseUrl: BASE }, workers: 2, detect: () => ({ chromium: true, firefox: false, webkit: false }), sink: { counters: async () => undefined, recordVariant: async (h, _s, r) => void recorded.push({ testId: h.testId, r }) } },
            [light, zone, acts].map((s) => ({ handle: { id: s.testId, testId: s.testId }, spec: s, validationStatus: "VALIDATED" })),
            ["dark", "locale", "no-js"],
        );
        const status = (testId: string, v: string) => recorded.find((x) => x.testId === testId && x.r.variant === v)?.r.status;
        expect(status("WEB-111", "dark")).toBe("failed"); // the page saw dark mode
        expect(status("WEB-111", "locale")).toBe("passed");
        expect(status("WEB-112", "locale")).toBe("passed"); // German, New Zealand time
        expect(status("WEB-112", "dark")).toBe("failed");
        expect(status("WEB-113", "dark")).toBe("passed");
        expect(status("WEB-111", "no-js")).toBe("failed"); // the text is written by JavaScript
        expect(status("WEB-113", "no-js")).toBe("skipped"); // it clicks: not a content-page test
    }, 240_000);

    it("an offline step in the middle of a form shows the app's offline message, in the script and live", async () => {
        const t = spec({
            testId: "WEB-121",
            steps: [
                { action: "navigate", url: "/form" },
                { action: "fill", locator: { by: "label", value: "Name" }, value: "Ada" },
                { action: "condition", set: "offline" },
                { action: "click", locator: { by: "role", role: "button", value: "Save" } },
                { action: "assert", check: "text", locator: { by: "css", value: "#msg" }, expected: "You are offline" },
                { action: "condition", set: "online" },
                { action: "click", locator: { by: "role", role: "button", value: "Save" } },
                { action: "assert", check: "text", locator: { by: "css", value: "#msg" }, expected: "Saved" },
            ],
        });
        const [run] = await runScripts(scratch, [script(t)], env, { workers: 1 });
        expect(run!.status, run!.error).toBe("passed");
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        for (const step of t.steps) await executeStep(p, step as never, runtimeData({}), BASE);
        await ctx.close();
    }, 120_000);
});

describe("sign-ins beyond cookies", () => {
    it("a sign-in kept in IndexedDB and sessionStorage is captured and survives into a run", async () => {
        const cap = new SignInCapture({ startUrl: `${BASE}/idb-login`, headed: false });
        cap.start();
        for (let i = 0; i < 100 && cap.state().status === "starting"; i++) await new Promise((r) => setTimeout(r, 100));
        await cap.mainPage()!.getByRole("button", { name: "Sign in" }).click();
        await cap.mainPage()!.getByText("Signed in as Ada").waitFor();
        const { state } = await cap.save();
        expect(state.cookies).toEqual([]);
        expect(JSON.stringify(state.origins)).toContain("tok-abc123456");
        expect(state.origins[0]!.sessionStorage).toEqual([{ name: "tab", value: "tab-xyz98765" }]);

        const t = spec({ testId: "WEB-131", steps: [{ action: "navigate", url: "/idb-home" }, { action: "assert", check: "text", locator: { by: "css", value: "#who" }, expected: "Signed in as Ada" }, { action: "assert", check: "text", locator: { by: "css", value: "#tab" }, expected: "Tab: present" }] });
        const [run] = await runScripts(scratch, [script(t, { session: true })], { ...env, storageState: JSON.stringify(state) }, { workers: 1 });
        expect(run!.status, run!.error).toBe("passed");
        // and without it the same test is signed out
        const [cold] = await runScripts(scratch, [script(t)], env, { workers: 1 });
        expect(cold!.status).toBe("failed");
    }, 120_000);

    it("a saved sign-in that has run out is renewed once for the whole run, instead of failing every test", async () => {
        const stale = { cookies: [{ name: "sid", value: "stale-session-1", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" as const }], origins: [], checkUrl: `${BASE}/account` };
        const a = spec({ testId: "WEB-141", steps: [{ action: "navigate", url: "/account" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Your account" } }] });
        const b = spec({ testId: "WEB-142", steps: [{ action: "navigate", url: "/account" }, { action: "assert", check: "title", expected: "Account" }] });
        logins = 0;
        const runs = await runScripts(scratch, [script(a, { session: true }), script(b, { session: true })], { ...env, credentials: { username: "ada", password: "pw-secret-1" }, storageState: JSON.stringify(stale) }, { workers: 2 });
        for (const r of runs) expect(r.status, r.error).toBe("passed");
        expect(logins).toBe(1);
        expect(RENEWED_LINE).toMatch(/signed in again once/);
        // Without the stored password nothing can be renewed: the tests fail as before.
        const without = await runScripts(scratch, [script(a, { session: true })], { ...env, storageState: JSON.stringify(stale) }, { workers: 1 });
        expect(without[0]!.status).toBe("failed");
        expect(logins).toBe(1);
    }, 180_000);
});

describe("live apps", () => {
    it("records the WebSocket the app opens, and a test of its live data catches the socket and offline faults", async () => {
        const net = new NetworkInterceptor();
        const p = await browser.newPage();
        net.attach(p);
        net.setCurrentPage(`${BASE}/live`);
        await p.goto(`${BASE}/live`);
        await p.getByText("Price: 42").waitFor();
        await p.close();
        expect(net.getWebSockets()).toEqual([{ url: `ws://127.0.0.1:${PORT}/feed`, usedIn: ["/live"] }]);

        const t = spec({ testId: "WEB-151", steps: [{ action: "navigate", url: "/live" }, { action: "assert", check: "text", locator: { by: "css", value: "#p" }, expected: "Price: 42" }] });
        const form = spec({ testId: "WEB-152", steps: [{ action: "navigate", url: "/form" }, { action: "fill", locator: { by: "label", value: "Name" }, value: "Ada" }, { action: "click", locator: { by: "role", role: "button", value: "Save" } }, { action: "assert", check: "text", locator: { by: "css", value: "#msg" }, expected: "Saved" }] });
        expect(socketFaultScript(t, { baseUrl: BASE }, "offline")).toBeUndefined(); // offline before the page opens says nothing
        const scripts = [script(t), socketFaultScript(t, { baseUrl: BASE }, "socket-drop")!, socketFaultScript(t, { baseUrl: BASE }, "socket-error")!, socketFaultScript(form, { baseUrl: BASE }, "offline")!];
        const runs = await runScripts(scratch, scripts, env, { workers: 2 });
        const by = (id: string) => runs.find((r) => r.testId === id);
        expect(by("WEB-151")!.status).toBe("passed");
        expect(classifyFaultRun(by("WEB-151~fault-socket-drop"))).toBe("caught");
        expect(classifyFaultRun(by("WEB-151~fault-socket-error"))).toBe("caught");
        expect(classifyFaultRun(by("WEB-152~fault-offline"))).toBe("caught");
        // A socket fault on a page that opens no socket does not take effect, so it does not count.
        const [none] = await runScripts(scratch, [socketFaultScript(form, { baseUrl: BASE }, "socket-drop")!], env, { workers: 1 });
        expect(classifyFaultRun(none)).toBe("not_applied");
    }, 180_000);
});
