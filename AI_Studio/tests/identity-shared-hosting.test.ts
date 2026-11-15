/**
 * The same-level API check on a shared hosting domain, in a real browser: the app is shop-a.herokuapp.com, its API is
 * api.shop-a.herokuapp.com, and each note page also calls shop-b.herokuapp.com, another customer's app on the same hosting domain,
 * with the account's own token. herokuapp.com is a public suffix (private part of the list), so shop-b is not the application's:
 * its answers are never kept as records, and no check is generated that would replay one account's record address, with another
 * account's credentials, there. The host names reach this machine through Chromium's host resolver rules (no DNS, no network).
 * Port 9671. Only GET requests and the sign-in form.
 */
import crypto from "node:crypto";
import http from "node:http";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { generateAccessSpecs, surveyAccess, type Reach } from "../src/engine/identity/access.js";

const PORT = 9671;
const APP = "http://shop-a.herokuapp.com";
const API = "http://api.shop-a.herokuapp.com";
const OTHER = "http://shop-b.herokuapp.com";
const USERS: Record<string, { password: string; name: string }> = { "alice@example.test": { password: "pw-alice-1", name: "alice" }, "bob@example.test": { password: "pw-bob-1", name: "bob" } };
const NOTES: Record<string, { owner: string; title: string }> = { "1": { owner: "alice", title: "Alice tax plan 2026" }, "2": { owner: "bob", title: "Bob holiday budget" } };
const sessions = new Map<string, { name: string; token: string }>();
const tokens = new Map<string, string>();
/** Every request the other customer's app received: host, path and query (which carries a token). */
const otherHits: string[] = [];

const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const json = (res: http.ServerResponse, status: number, value: unknown) => (res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": APP }), res.end(JSON.stringify(value)));
/** The other customer's app: it answers any note read with that note's content (its own data, but the same shape and path). */
function other(req: http.IncomingMessage, res: http.ServerResponse) {
    otherHits.push(req.url ?? "");
    const id = new URL(req.url ?? "/", OTHER).searchParams.get("id") ?? "";
    return json(res, 200, { id: Number(id), kind: "personal note", title: `Shop B note ${id} for its own customer`, body: "Shop B data" });
}
/** The application's API: a note is read with the account's token; note 1 is open to any signed-in account (the leak the check finds). */
function api(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url ?? "/", API);
    const id = u.searchParams.get("id") ?? "";
    const who = tokens.get(u.searchParams.get("access_token") ?? "");
    const n = NOTES[id];
    if (!who) return json(res, 401, { error: "Sign in first" });
    if (!n) return json(res, 404, { error: "Not found" });
    if (n.owner !== who && id !== "1") return json(res, 403, { error: "Not yours" });
    return json(res, 200, { id: Number(id), kind: "personal note", title: n.title, body: "Private", updatedAt: "2026-11-01T10:00:00Z" });
}
async function app(req: http.IncomingMessage, res: http.ServerResponse) {
    const p = (req.url ?? "/").split("?")[0]!;
    const me = sessions.get(/sid=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "");
    const html = (status: number, content: string) => (res.writeHead(status, { "content-type": "text/html" }), res.end(content));
    const redirect = (to: string, headers: Record<string, string> = {}) => (res.writeHead(303, { location: to, ...headers }), res.end());
    if (req.method === "POST" && p === "/login") {
        let raw = "";
        for await (const c of req) raw += c;
        const f = new URLSearchParams(raw);
        const u = USERS[f.get("email") ?? ""];
        if (!u || u.password !== f.get("password")) return html(400, shell("Sign in", '<p role="alert">Invalid email or password</p>'));
        const sid = crypto.randomBytes(8).toString("hex");
        const token = `tok-${u.name}-${crypto.randomBytes(6).toString("hex")}`;
        sessions.set(sid, { name: u.name, token });
        tokens.set(token, u.name);
        return redirect("/notes", { "set-cookie": `sid=${sid}; Path=/; HttpOnly` });
    }
    if (p === "/") return html(200, shell("Notes app", '<a href="/login">Log in</a>'));
    if (p === "/login") return html(200, shell("Sign in", '<form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>'));
    if (!me) return redirect("/login");
    if (p === "/notes") return html(200, shell("Your notes", Object.entries(NOTES).filter(([, n]) => n.owner === me.name).map(([id]) => `<a href="/notes/${id}">Note ${id}</a>`).join(" ")));
    const note = /^\/notes\/(\d+)$/.exec(p);
    if (!note) return html(404, shell("Not found", ""));
    const t = encodeURIComponent(me.token);
    const script = `<script>
fetch("${API}/v1/note?id=${note[1]}&access_token=${t}").then(r=>r.json()).then(n=>{document.getElementById("c").textContent=n.title||n.error});
fetch("${OTHER}/v1/note?id=${note[1]}&access_token=${t}").then(r=>r.json()).then(n=>{document.getElementById("d").textContent=n.title});
</script>`;
    return html(200, shell("Note", `<p id="c">Loading</p><p id="d"></p>${script}`));
}
const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const handle = host === "shop-a.herokuapp.com" ? app : host === "api.shop-a.herokuapp.com" ? api : host === "shop-b.herokuapp.com" ? other : undefined;
    if (!handle) return (res.writeHead(421), res.end());
    void Promise.resolve(handle(req, res)).catch(() => (res.headersSent ? res.end() : (res.writeHead(500), res.end())));
});
const context = (): EngineContext => ({ config: loadConfig({}), emit: () => undefined, llm: null }) as unknown as EngineContext;

describe("the same-level API check on a shared hosting domain", () => {
    let browser: Browser;
    let reach: Reach[];
    beforeAll(async () => {
        await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
        browser = await chromium.launch({ args: ["--no-sandbox", `--host-resolver-rules=MAP *.herokuapp.com 127.0.0.1:${PORT}, EXCLUDE localhost`] });
        reach = await surveyAccess(context(), browser, `${APP}/`, [
            { name: "alice", username: "alice@example.test", password: "pw-alice-1" },
            { name: "bob", username: "bob@example.test", password: "pw-bob-1" },
        ]);
    }, 120_000);
    afterAll(async () => {
        await browser?.close();
        await new Promise((r) => server.close(r));
    });

    it("keeps the application's own API reads and none from another customer's app, though the pages called it", () => {
        const api = reach.flatMap((r) => (r.api ?? []).map((a) => ({ who: r.who, origin: a.origin, path: a.path })));
        expect(api).toEqual(expect.arrayContaining([{ who: "alice", origin: API, path: "/v1/note?id=1&access_token=•••" }, { who: "bob", origin: API, path: "/v1/note?id=2&access_token=•••" }]));
        expect(api.every((a) => a.origin === API)).toBe(true);
        // The pages did call the other customer's app, with each account's own token: the survey saw those answers and left them out.
        expect(otherHits.some((h) => h.includes("access_token=tok-alice-"))).toBe(true);
        expect(otherHits.some((h) => h.includes("access_token=tok-bob-"))).toBe(true);
    });

    it("generates checks that replay records only on the application's API, never on the other customer's host", () => {
        const checks = generateAccessSpecs(reach).filter((s) => s.title.includes("through the API"));
        expect(checks.length).toBeGreaterThan(0);
        for (const s of checks) {
            const cfg = JSON.parse(String((s.steps[1] as { expected: string }).expected)) as { origin?: string; pattern?: string };
            expect(cfg.origin).toBe(API);
            expect(cfg.pattern?.startsWith(API)).toBe(true);
        }
        const text = JSON.stringify(checks);
        expect(text).not.toContain("shop-b.herokuapp.com");
        expect(text).not.toContain("tok-");
    });
});
