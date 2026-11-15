/**
 * Same-level API access checks on a real app with two ordinary accounts (alice and bob), through a real job. Each note page has the same
 * heading ("Note") and loads its content from GET /api/notes/:id, so the screen pass has nothing to compare and the API pass does the
 * work. With the leak on, alice's first note is readable through the API by any signed-in account; with it off, every note checks its
 * owner. Only GET requests (and the sign-in form) reach the app.
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

const PORT = 9670;
const BASE = `http://127.0.0.1:${PORT}`;
const USERS: Record<string, { password: string; name: string }> = { "alice@example.test": { password: "pw-alice-1", name: "alice" }, "bob@example.test": { password: "pw-bob-1", name: "bob" } };
const NOTES: Record<string, { owner: string; title: string; body: string }> = {
    "1": { owner: "alice", title: "Alice tax plan 2026", body: "Quarterly figures for the accountant" },
    "2": { owner: "alice", title: "Alice garden ideas", body: "Tomatoes and beans along the fence" },
    "3": { owner: "bob", title: "Bob holiday budget", body: "Train tickets and two nights by the lake" },
};
let leak = true;
const sessions = new Map<string, string>();
const methods: string[] = [];

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
    const json = (status: number, value: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(value)));
    const redirect = (to: string, headers: Record<string, string> = {}) => (res.writeHead(303, { location: to, ...headers }), res.end());
    const nav = me ? '<a href="/notes">Notes</a>' : '<a href="/login">Log in</a>';
    if (req.method === "POST" && p === "/login") {
        const f = await readForm(req);
        const u = USERS[f.get("email") ?? ""];
        if (!u || u.password !== f.get("password")) return html(400, shell("Sign in", '<p role="alert">Invalid email or password</p>'));
        const id = crypto.randomBytes(8).toString("hex");
        sessions.set(id, u.name);
        return redirect("/notes", { "set-cookie": `sid=${id}; Path=/; HttpOnly` });
    }
    if (p === "/") return html(200, shell("Notes app", "<p>Welcome.</p>", nav));
    if (p === "/login") return html(200, shell("Sign in", '<form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>'));
    const api = /^\/api\/notes\/(\d+)$/.exec(p);
    if (api) {
        if (!me) return json(401, { error: "Sign in first" });
        const n = NOTES[api[1]!];
        if (!n) return json(404, { error: "Not found" });
        // BROKEN when `leak` is on, for note 1 only: any signed-in account can read it. Every other note checks the owner.
        if (n.owner !== me && !(leak && api[1] === "1")) return json(403, { error: "Not yours" });
        return json(200, { id: Number(api[1]), kind: "personal note", title: n.title, body: n.body, updatedAt: "2026-11-01T10:00:00Z" });
    }
    if (!me) return redirect("/login");
    if (p === "/notes") {
        const mine = Object.entries(NOTES).filter(([, n]) => n.owner === me);
        return html(200, shell("Your notes", `<ul>${mine.map(([id]) => `<li><a href="/notes/${id}">Note ${id}</a></li>`).join("")}</ul>`, nav));
    }
    const note = /^\/notes\/(\d+)$/.exec(p);
    if (note) {
        // The page itself is the same for every note: its content comes from the API.
        const script = `<script>fetch("/api/notes/${note[1]}").then(r=>r.json()).then(n=>{document.getElementById("c").textContent=(n.title||"")+" - "+(n.body||n.error||"")})</script>`;
        return html(200, shell("Note", `<p id="c">Loading</p>${script}`, nav));
    }
    html(404, shell("Not found", "", nav));
});

describe("same-level API access checks on a real two-account app", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    beforeAll(async () => {
        await new Promise<void>((r) => app.listen(PORT, "127.0.0.1", r));
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-api-horizontal-"));
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
        "“alice” account: cannot read a record of “bob” through the API (GET /api/notes/3)",
        "“bob” account: cannot read a record of “alice” through the API (GET /api/notes/1)",
        "“bob” account: cannot read a record of “alice” through the API (GET /api/notes/2)",
    ];

    it("reports alice's note that bob can read through the API, with masked evidence, and passes the protected notes, sending only GET", async () => {
        leak = true;
        methods.length = 0;
        const { all, access } = await analyse("Notes API leak");
        expect(apiTitles(access), JSON.stringify(access.map((t) => t.title))).toEqual(EXPECTED);
        const byTitle = Object.fromEntries(access.map((t) => [t.title, t]));
        const finding = byTitle[EXPECTED[1]!]!;
        expect(finding.validationStatus).toBe("NEEDS_REVIEW");
        expect(finding.validationReason).toContain("Access control check failed: 1 record may be open to another account");
        expect(finding.validationReason).toContain("A signed-in “bob” user can call GET /api/notes/1 (HTTP 200) and the answer holds content of a record that belongs to the “alice” account");
        expect(finding.validationReason).toContain("[high]");
        // Evidence is masked: the field and a preview, never the value itself (in the reason or in any stored test).
        expect(finding.validationReason).toMatch(/title: •+ \(19 characters\)/);
        expect(JSON.stringify(all)).not.toContain("Alice tax plan 2026");
        expect(JSON.stringify(all)).not.toContain("Quarterly figures");
        expect(byTitle[EXPECTED[0]!]!.validationStatus).toBe("VALIDATED");
        expect(byTitle[EXPECTED[2]!]!.validationStatus).toBe("VALIDATED");
        // The note pages all share one heading: no screen-level record check is made for them.
        expect(access.some((t) => t.title.includes("cannot open a record of"))).toBe(false);
        expect(methods.length).toBeGreaterThan(0);
        expect(methods.every((m) => m === "GET" || m === "HEAD")).toBe(true);
    }, 480_000);

    it("makes the same checks and finds nothing when every note checks its owner", async () => {
        leak = false;
        methods.length = 0;
        const { access } = await analyse("Notes API clean");
        expect(apiTitles(access)).toEqual(EXPECTED);
        for (const t of access.filter((x) => x.title.includes("through the API"))) expect(t.validationStatus, `${t.title}: ${t.validationReason}`).toBe("VALIDATED");
        expect(methods.every((m) => m === "GET" || m === "HEAD")).toBe(true);
    }, 480_000);
});
