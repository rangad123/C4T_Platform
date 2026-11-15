/**
 * Horizontal access checks on a real app with two ordinary accounts (alice and bob), through a real job: alice's first note is readable by
 * any signed-in account (the leak), her second note and bob's note are protected, a shared note and a product page are open to both, and
 * each account reaches its own notes. Only GET requests reach the app.
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

const PORT = 9570;
const BASE = `http://127.0.0.1:${PORT}`;
const USERS: Record<string, { password: string; name: string }> = { "alice@example.test": { password: "pw-alice-1", name: "alice" }, "bob@example.test": { password: "pw-bob-1", name: "bob" } };
const NOTES: Record<string, { owner: string; title: string; leaks?: boolean }> = {
    "1": { owner: "alice", title: "Alice tax plan 2026", leaks: true },
    "2": { owner: "alice", title: "Alice garden ideas" },
    "3": { owner: "bob", title: "Bob holiday budget" },
};
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
    const redirect = (to: string, headers: Record<string, string> = {}) => (res.writeHead(303, { location: to, ...headers }), res.end());
    const nav = me ? '<a href="/notes">Notes</a> <a href="/shared/9">Team offsite</a> <a href="/products/4">Kettle</a>' : '<a href="/login">Log in</a>';
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
    if (!me) return redirect("/login");
    if (p === "/notes") {
        const mine = Object.entries(NOTES).filter(([, n]) => n.owner === me);
        return html(200, shell("Your notes", `<ul>${mine.map(([id, n]) => `<li><a href="/notes/${id}">${n.title}</a></li>`).join("")}</ul>`, nav));
    }
    const note = /^\/notes\/(\d+)$/.exec(p);
    if (note) {
        const n = NOTES[note[1]!];
        if (!n) return html(404, shell("Not found", "", nav));
        // BROKEN for note 1: any signed-in account can read it. The others check the owner.
        if (n.owner !== me && !n.leaks) return html(403, shell("Forbidden", "<p>Access denied.</p>", nav));
        return html(200, shell(n.title, "<p>Private content.</p>", nav));
    }
    if (p === "/shared/9") return html(200, shell("Team offsite", "<p>Shared with everyone in the team.</p>", nav));
    if (p === "/products/4") return html(200, shell("Blue kettle", "<p>A kettle.</p>", nav));
    html(404, shell("Not found", "", nav));
});

describe("horizontal access checks on a real two-account app", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    beforeAll(async () => {
        await new Promise<void>((r) => app.listen(PORT, "127.0.0.1", r));
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-horizontal-"));
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
    type T = { title: string; suite: string; validationStatus: string; validationReason: string | null };
    async function analyse(projectId: string) {
        const queued = await call("POST", `/api/projects/${projectId}/test-generation`, { url: BASE, targets: ["web"], healthChecks: false, securityChecks: false, inputChecks: false, accessibility: false, maxPages: 12 });
        expect(queued.status).toBe(202);
        for (let i = 0; i < 480; i++) {
            const j = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        return ((await call("GET", `/api/projects/${projectId}/tests`)).body as T[]).filter((t) => t.suite === "Access control");
    }

    it("reports alice's leaking note to bob, passes the protected notes, and leaves shared and public pages alone, sending only GET", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Notes access" })).body.id as string;
        expect((await call("PUT", `/api/projects/${projectId}/roles`, { roles: [{ name: "alice", username: "alice@example.test", password: "pw-alice-1" }, { name: "bob", username: "bob@example.test", password: "pw-bob-1" }] })).status).toBe(200);
        methods.length = 0;
        const access = await analyse(projectId);
        const byTitle = Object.fromEntries(access.map((t) => [t.title, t]));
        const cross = access.filter((t) => t.title.includes("cannot open a record of"));
        expect(cross.map((t) => t.title).sort(), JSON.stringify(access.map((t) => t.title))).toEqual([
            "“alice” account: cannot open a record of “bob” (/notes/3)",
            "“bob” account: cannot open a record of “alice” (/notes/1)",
            "“bob” account: cannot open a record of “alice” (/notes/2)",
        ]);
        const leak = byTitle["“bob” account: cannot open a record of “alice” (/notes/1)"]!;
        expect(leak.validationStatus).toBe("NEEDS_REVIEW");
        expect(leak.validationReason).toContain("Access control check failed: 1 record may be open to another account");
        expect(leak.validationReason).toContain("A signed-in “bob” user can open /notes/1 and see “Alice tax plan 2026”, which belongs to the “alice” account");
        expect(byTitle["“bob” account: cannot open a record of “alice” (/notes/2)"]!.validationStatus).toBe("VALIDATED");
        expect(byTitle["“alice” account: cannot open a record of “bob” (/notes/3)"]!.validationStatus).toBe("VALIDATED");
        // Shared and public pages are reached by both accounts: no cross-account check for them, and bob's notes are not checked as pages
        // reserved for a "more privileged" alice.
        expect(access.some((t) => /\/shared\/9|\/products\/4/.test(t.title) && t.title.includes("record of"))).toBe(false);
        expect(access.some((t) => t.title.startsWith("“bob” account: cannot open /notes/"))).toBe(false);
        expect(methods.every((m) => m === "GET" || m === "HEAD")).toBe(true);
    }, 480_000);

    it("makes no cross-account check with one test account", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "One account" })).body.id as string;
        await call("PUT", `/api/projects/${projectId}/roles`, { roles: [{ name: "alice", username: "alice@example.test", password: "pw-alice-1" }] });
        const access = await analyse(projectId);
        expect(access.some((t) => t.title.includes("cannot open a record of"))).toBe(false);
    }, 480_000);
});
