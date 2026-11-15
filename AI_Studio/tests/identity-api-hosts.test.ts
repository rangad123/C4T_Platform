/**
 * Same-level API checks where the application's API is on a separate host (the same machine name on another port) and records are
 * read by query string (GET /v1/note?id=N&access_token=T, GET /v1/notes/N?access_token=T). Two ordinary accounts (alice and bob) each
 * have one note; each note page calls the API host with the account's own token in the query string, and also calls an outside
 * service on another host (127.0.0.2), which is never replayed. With the leak on, alice's note is readable through both API
 * addresses by any signed-in account; with it off, every read checks its owner. Only GET requests (and the sign-in form) are made.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 9673;
const API_PORT = 9674;
const VENDOR_PORT = 9675;
const BASE = `http://127.0.0.1:${PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const VENDOR = `http://127.0.0.2:${VENDOR_PORT}`;
const USERS: Record<string, { password: string; name: string }> = { "alice@example.test": { password: "pw-alice-1", name: "alice" }, "bob@example.test": { password: "pw-bob-1", name: "bob" } };
const NOTES: Record<string, { owner: string; title: string; body: string }> = {
    "1": { owner: "alice", title: "Alice tax plan 2026", body: "Quarterly figures for the accountant" },
    "2": { owner: "bob", title: "Bob holiday budget", body: "Train tickets and two nights by the lake" },
};
let leak = true;
const sessions = new Map<string, { name: string; token: string }>();
const tokens = new Map<string, string>();
const methods: string[] = [];
/** Every read on the API host: whose token, which note. */
const reads: Array<{ who: string | undefined; id: string }> = [];
let vendorHits = 0;

const shell = (title: string, body: string, nav = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><nav>${nav}</nav><h1>${title}</h1>${body}</body></html>`;
const readForm = (req: http.IncomingMessage) =>
    new Promise<URLSearchParams>((resolve) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => resolve(new URLSearchParams(raw)));
    });
const app = http.createServer(async (req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    if (p !== "/login" || req.method !== "POST") methods.push(req.method ?? "");
    const me = sessions.get(/sid=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "");
    const html = (status: number, content: string) => (res.writeHead(status, { "content-type": "text/html" }), res.end(content));
    const redirect = (to: string, headers: Record<string, string> = {}) => (res.writeHead(303, { location: to, ...headers }), res.end());
    const nav = me ? '<a href="/notes">Notes</a>' : '<a href="/login">Log in</a>';
    if (req.method === "POST" && p === "/login") {
        const f = await readForm(req);
        const u = USERS[f.get("email") ?? ""];
        if (!u || u.password !== f.get("password")) return html(400, shell("Sign in", '<p role="alert">Invalid email or password</p>'));
        const id = crypto.randomBytes(8).toString("hex");
        const token = `tok-${u.name}-${crypto.randomBytes(6).toString("hex")}`;
        sessions.set(id, { name: u.name, token });
        tokens.set(token, u.name);
        return redirect("/notes", { "set-cookie": `sid=${id}; Path=/; HttpOnly` });
    }
    if (p === "/") return html(200, shell("Notes app", "<p>Welcome.</p>", nav));
    if (p === "/login") return html(200, shell("Sign in", '<form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>'));
    if (!me) return redirect("/login");
    if (p === "/notes") {
        const mine = Object.entries(NOTES).filter(([, n]) => n.owner === me.name);
        return html(200, shell("Your notes", `<ul>${mine.map(([id]) => `<li><a href="/notes/${id}">Note ${id}</a></li>`).join("")}</ul>`, nav));
    }
    const note = /^\/notes\/(\d+)$/.exec(p);
    if (note) {
        // The page is the same for every note: its content comes from the API host, called with the account's own token.
        const t = encodeURIComponent(me.token);
        const script = `<script>
fetch("${API}/v1/note?id=${note[1]}&access_token=${t}").then(r=>r.json()).then(n=>{document.getElementById("c").textContent=(n.title||"")+" - "+(n.body||n.error||"")});
fetch("${API}/v1/notes/${note[1]}?access_token=${t}").then(r=>r.json()).then(n=>{document.getElementById("d").textContent=(n.note&&n.note.title)||n.error||""});
fetch("${VENDOR}/v1/notes/${note[1]}?id=${note[1]}").catch(()=>{});
</script>`;
        return html(200, shell("Note", `<p id="c">Loading</p><p id="d"></p>${script}`, nav));
    }
    html(404, shell("Not found", "", nav));
});
const api = http.createServer((req, res) => {
    methods.push(req.method ?? "");
    const u = new URL(req.url ?? "/", API);
    const json = (status: number, value: unknown) => (res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": BASE }), res.end(JSON.stringify(value)));
    const id = u.pathname === "/v1/note" ? u.searchParams.get("id") : /^\/v1\/notes\/(\d+)$/.exec(u.pathname)?.[1];
    if (!id) return json(404, { error: "Not found" });
    const who = tokens.get(u.searchParams.get("access_token") ?? "");
    reads.push({ who, id });
    if (!who) return json(401, { error: "Sign in first" });
    const n = NOTES[id];
    if (!n) return json(404, { error: "Not found" });
    // BROKEN when `leak` is on, for note 1 only: any signed-in account can read it. Every other read checks the owner.
    if (n.owner !== who && !(leak && id === "1")) return json(403, { error: "Not yours" });
    const content = { kind: "personal note", title: n.title, body: n.body, updatedAt: "2026-11-01T10:00:00Z" };
    return json(200, u.pathname === "/v1/note" ? { id: Number(id), ...content } : { note: content });
});
/** An outside service the note pages also call, on another host name: it must never be replayed. */
const vendor = http.createServer((req, res) => {
    vendorHits++;
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": BASE });
    res.end(JSON.stringify({ title: "Vendor widget for this note", body: "Shown to everyone who opens it" }));
});

describe("same-level API checks on a separate API host with query-scoped reads", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    beforeAll(async () => {
        await new Promise<void>((r) => app.listen(PORT, "127.0.0.1", r));
        await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
        await new Promise<void>((r) => vendor.listen(VENDOR_PORT, "127.0.0.2", r));
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-api-hosts-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
        worker = new Worker(platform, 200);
        worker.start();
    }, 30_000);
    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        await new Promise((r) => app.close(r));
        await new Promise((r) => api.close(r));
        await new Promise((r) => vendor.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const call = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };
    type T = { title: string; suite: string; validationStatus: string; validationReason: string | null; spec?: unknown };
    async function analyse(name: string) {
        const projectId = (await call("POST", "/api/projects", { name })).body.id as string;
        expect((await call("PUT", `/api/projects/${projectId}/roles`, { roles: [{ name: "alice", username: "alice@example.test", password: "pw-alice-1" }, { name: "bob", username: "bob@example.test", password: "pw-bob-1" }] })).status).toBe(200);
        const queued = await call("POST", `/api/projects/${projectId}/test-generation`, { url: BASE, targets: ["web"], healthChecks: false, securityChecks: false, inputChecks: false, accessibility: false, maxPages: 12 });
        expect(queued.status).toBe(202);
        for (let i = 0; i < 480; i++) {
            const j = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        const all = (await call("GET", `/api/projects/${projectId}/tests`)).body as T[];
        return { all, access: all.filter((t) => t.suite === "Access control") };
    }
    const apiTitles = (access: T[]) => access.filter((t) => t.title.includes("through the API")).map((t) => t.title).sort();
    const EXPECTED = [
        `“alice” account: cannot read a record of “bob” through the API (GET ${API}/v1/note?id=2&access_token=•••)`,
        `“alice” account: cannot read a record of “bob” through the API (GET ${API}/v1/notes/2?access_token=•••)`,
        `“bob” account: cannot read a record of “alice” through the API (GET ${API}/v1/note?id=1&access_token=•••)`,
        `“bob” account: cannot read a record of “alice” through the API (GET ${API}/v1/notes/1?access_token=•••)`,
    ];
    const noSecretsStored = (all: T[]) => {
        const text = JSON.stringify(all);
        for (const t of tokens.keys()) expect(text).not.toContain(t);
        expect(text).not.toContain("Alice tax plan 2026");
        expect(text).not.toContain("Quarterly figures");
        expect(text).not.toContain(VENDOR);
    };

    it("reports alice's note that bob can read on the API host, by query string and by path, with masked evidence and bob's own token", async () => {
        leak = true;
        methods.length = 0;
        reads.length = 0;
        const { all, access } = await analyse("Notes API host leak");
        expect(apiTitles(access), JSON.stringify(access.map((t) => t.title))).toEqual(EXPECTED);
        const byTitle = Object.fromEntries(access.map((t) => [t.title, t]));
        for (const title of EXPECTED.slice(2)) {
            const finding = byTitle[title]!;
            expect(finding.validationStatus, `${title}: ${finding.validationReason}`).toBe("NEEDS_REVIEW");
            expect(finding.validationReason).toContain("Access control check failed: 1 record may be open to another account");
            expect(finding.validationReason).toContain(`A signed-in “bob” user can call GET ${API}/v1/note`);
            expect(finding.validationReason).toContain("access_token=•••");
            expect(finding.validationReason).toMatch(/title: •+ \(19 characters\)/);
        }
        for (const title of EXPECTED.slice(0, 2)) expect(byTitle[title]!.validationStatus, `${title}: ${byTitle[title]!.validationReason}`).toBe("VALIDATED");
        // The replay read alice's note with bob's own token (never alice's), on both addresses.
        expect(reads.filter((r) => r.id === "1" && r.who === "bob").length).toBeGreaterThanOrEqual(2);
        noSecretsStored(all);
        expect(vendorHits).toBeGreaterThan(0);
        expect(methods.length).toBeGreaterThan(0);
        expect(methods.every((m) => m === "GET" || m === "HEAD")).toBe(true);
    }, 480_000);

    it("makes the same checks and finds nothing when every read checks its owner", async () => {
        leak = false;
        methods.length = 0;
        const { all, access } = await analyse("Notes API host clean");
        expect(apiTitles(access)).toEqual(EXPECTED);
        for (const t of access.filter((x) => x.title.includes("through the API"))) expect(t.validationStatus, `${t.title}: ${t.validationReason}`).toBe("VALIDATED");
        noSecretsStored(all);
        expect(methods.every((m) => m === "GET" || m === "HEAD")).toBe(true);
    }, 480_000);
});
