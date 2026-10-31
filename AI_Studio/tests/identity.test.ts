/**
 * Test accounts and access-control checks: generation rules, the accounts API (write-only secrets, encrypted at rest), and a
 * real job against an app with user and admin accounts (admin with two-step sign-in), a protected page, broken pages and a
 * public page.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { generateAccessSpecs, type Reach } from "../src/engine/identity/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { totpAccepted } from "./fixtures/independent-totp.js";

// ── generation rules ──────────────────────────────────────────────────────────
const page = (p: string, heading: string) => ({ path: p, heading });
const reach = (who: string, ...pages: Array<[string, string]>): Reach => ({ who, pages: pages.map(([p, h]) => page(p, h)) });
const SHARED: Array<[string, string]> = [["/", "Acme Portal"], ["/about", "About Acme"]];

describe("which checks are generated", () => {
    const anon = reach("anonymous", ...SHARED);
    const user = reach("user", ...SHARED, ["/account", "Your account"], ["/orders", "Your orders"]);
    const admin = reach("admin", ...SHARED, ["/account", "Your account"], ["/orders", "Your orders"], ["/admin/users", "User management"], ["/reports", "Quarterly reports"], ["/billing", "Billing and invoices"]);
    const asData = (specs: ReturnType<typeof generateAccessSpecs>) => specs.map((s) => JSON.parse(String((s.steps[1] as { expected: string }).expected)) as { as: string; path: string; by: string; sev: string; marker: string });

    it("checks pages a more privileged account reached against lesser accounts and visitors, privileged-looking addresses first", () => {
        const found = asData(generateAccessSpecs([anon, user, admin]));
        // admin reaches the most pages, so it is never the one being checked
        expect(found.every((f) => f.as !== "admin")).toBe(true);
        const forUser = found.filter((f) => f.as === "user").map((f) => f.path);
        expect(forUser.sort()).toEqual(["/admin/users", "/billing", "/reports"]);
        const forAnon = found.filter((f) => f.as === "anonymous").map((f) => f.path);
        expect(forAnon).toEqual(expect.arrayContaining(["/admin/users", "/billing", "/reports", "/account", "/orders"]));
        // privileged-looking first
        const firstOrdinary = found.findIndex((f) => f.sev === "low");
        expect(found.slice(0, firstOrdinary).every((f) => f.sev === "high")).toBe(true);
        expect(found.find((f) => f.path === "/admin/users")!).toMatchObject({ by: "admin", sev: "high", marker: "User management" });
        expect(found.find((f) => f.path === "/orders")!).toMatchObject({ by: "user", sev: "low" });
    });

    it("describes each check in plain words and as a single GET-only step", () => {
        const spec = generateAccessSpecs([anon, user, admin]).find((s) => s.title.startsWith("“user” account") && s.title.includes("/reports"))!;
        expect(spec).toMatchObject({ kind: "web", type: "security", category: "Access control", priority: "high", source: { origin: "access-check" } });
        expect(spec.steps.map((s) => s.action)).toEqual(["navigate", "assert"]);
        expect(spec.steps[1]).toMatchObject({ check: "accessDenied" });
        expect(spec.steps[1]!.description).toBe("The “user” account cannot open /reports (it is only reached by “admin” when browsing)");
        expect(spec.preconditions).toEqual(["A test account named “user” is set up for this project"]);
    });

    it("does not compare accounts that reach the same number of pages (no way to tell which is the lesser)", () => {
        const editor = reach("editor", ...SHARED, ["/account", "Your account"], ["/drafts", "Your drafts"]);
        const viewer = reach("viewer", ...SHARED, ["/account", "Your account"], ["/library", "The library"]);
        const found = asData(generateAccessSpecs([anon, editor, viewer]));
        expect(found.filter((f) => f.as === "editor" || f.as === "viewer")).toEqual([]);
        expect(found.filter((f) => f.as === "anonymous")).toHaveLength(3); // /account, /drafts, /library
    });

    it("skips markers that say nothing about the page", () => {
        const owner = reach("owner", ...SHARED, ["/a", "Home"], ["/b", "Hi"], ["/c", "About Acme"], ["/d", "Reports for finance"]);
        expect(asData(generateAccessSpecs([anon, owner])).map((f) => f.path)).toEqual(["/d"]); // generic, too short, and already seen by the visitor
    });

    it("caps the number of checks, and the ordinary ones in particular", () => {
        const many = reach("boss", ...SHARED, ...Array.from({ length: 12 }, (_, i): [string, string] => [`/page${i}`, `Heading number ${i}`]), ...Array.from({ length: 12 }, (_, i): [string, string] => [`/admin/area${i}`, `Admin area ${i}`]));
        const found = asData(generateAccessSpecs([anon, many]));
        expect(found).toHaveLength(8);
        expect(found.filter((f) => f.sev === "low").length).toBeLessThanOrEqual(3);
    });

    it("generates nothing when only one viewer was surveyed", () => {
        expect(generateAccessSpecs([anon])).toEqual([]);
    });
});

// ── the accounts API ──────────────────────────────────────────────────────────
describe("test accounts API", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-roles-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
    });
    afterAll(async () => {
        await server.close();
        platform.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const call = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => {
        const r = await server.inject({ method, url, payload: payload as never });
        return { status: r.statusCode, body: r.json() as any };
    };

    it("saves accounts, shows only what is safe to show, and keeps secrets encrypted", async () => {
        const id = (await call("POST", "/api/projects", { name: "Roles" })).body.id as string;
        expect((await call("GET", `/api/projects/${id}/roles`)).body).toEqual({ roles: [] });

        const saved = await call("PUT", `/api/projects/${id}/roles`, { roles: [{ name: "user", username: "user@example.com", password: "S3cret-user-pw" }, { name: "admin", username: "admin@example.com", password: "S3cret-admin-pw", totpSecret: "JBSWY3DPEHPK3PXP" }] });
        expect(saved.status).toBe(200);
        expect(saved.body.roles).toEqual([
            { name: "user", username: "user@example.com", hasPassword: true, hasTotp: false, hasApiToken: false },
            { name: "admin", username: "admin@example.com", hasPassword: true, hasTotp: true, hasApiToken: false },
        ]);
        const everything = JSON.stringify([saved.body, (await call("GET", `/api/projects/${id}/roles`)).body, (await call("GET", `/api/projects/${id}`)).body]);
        for (const secret of ["S3cret-user-pw", "S3cret-admin-pw", "JBSWY3DPEHPK3PXP"]) expect(everything).not.toContain(secret);

        // encrypted at rest: neither the database file nor its journal contains a secret (or even a username)
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const bytes = fs.readFileSync(path.join(dir, "platform.db")).toString("latin1");
        for (const secret of ["S3cret-user-pw", "S3cret-admin-pw", "JBSWY3DPEHPK3PXP", "admin@example.com"]) expect(bytes).not.toContain(secret);
    });

    it("keeps a saved password or secret when it is left out, and removes a secret with an empty value", async () => {
        const id = (await call("POST", "/api/projects", { name: "Keep" })).body.id as string;
        await call("PUT", `/api/projects/${id}/roles`, { roles: [{ name: "admin", username: "a@example.com", password: "pw-1", totpSecret: "JBSWY3DPEHPK3PXP" }] });
        const kept = await call("PUT", `/api/projects/${id}/roles`, { roles: [{ name: "admin", username: "new-name@example.com" }] });
        expect(kept.body.roles).toEqual([{ name: "admin", username: "new-name@example.com", hasPassword: true, hasTotp: true, hasApiToken: false }]);
        const stored = (platform.repo as unknown as { db: { get: (sql: string, ...p: unknown[]) => unknown } }).db.get("SELECT 1 AS x FROM project_roles WHERE project_id = ?", id);
        expect(stored).toBeTruthy();
        const cleared = await call("PUT", `/api/projects/${id}/roles`, { roles: [{ name: "admin", username: "new-name@example.com", totpSecret: "" }] });
        expect(cleared.body.roles[0]).toMatchObject({ hasPassword: true, hasTotp: false });
        expect((await call("PUT", `/api/projects/${id}/roles`, { roles: [] })).body).toEqual({ roles: [] });
        expect((await call("GET", `/api/projects/${id}/roles`)).body).toEqual({ roles: [] });
    });

    it("rejects bad input with a plain reason", async () => {
        const id = (await call("POST", "/api/projects", { name: "Bad" })).body.id as string;
        const put = (roles: unknown[]) => call("PUT", `/api/projects/${id}/roles`, { roles });
        expect((await put([{ name: "Admin!", username: "u", password: "p" }])).status).toBe(400);
        expect((await put([{ name: "a", username: "u", password: "p" }, { name: "a", username: "v", password: "q" }])).body.error).toBe("Each test account needs its own name.");
        expect((await put([{ name: "fresh", username: "u" }])).body.error).toBe("The account “fresh” needs a password.");
        expect((await put([{ name: "a", username: "u", password: "p", totpSecret: "not base32!" }])).status).toBe(400);
        expect((await put(Array.from({ length: 7 }, (_, i) => ({ name: `r${i}`, username: "u", password: "p" })))).status).toBe(400);
        expect((await call("GET", "/api/projects/nope/roles")).status).toBe(404);
        expect((await call("PUT", "/api/projects/nope/roles", { roles: [] })).status).toBe(404);
    });
});

// ── a real job ────────────────────────────────────────────────────────────────
const PORT = 5341;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOTP = "JBSWY3DPEHPK3PXP";
const ACCOUNTS: Record<string, { password: string; role: "user" | "admin" }> = { "user@example.com": { password: "pw-user-1", role: "user" }, "admin@example.com": { password: "pw-admin-1", role: "admin" } };
const sessions = new Map<string, { role: "user" | "admin"; full: boolean }>();

const shell = (title: string, body: string, nav = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><nav>${nav}</nav><h1>${title}</h1>${body}</body></html>`;
const publicNav = '<a href="/">Home</a> <a href="/about">About</a> <a href="/login">Log in</a>';
const navFor = (role: "user" | "admin") => `<a href="/account">Account</a> <a href="/orders">Orders</a>${role === "admin" ? ' <a href="/admin/users">Users</a> <a href="/reports">Reports</a> <a href="/billing">Billing</a>' : ""} <form method="post" action="/logout" style="display:inline"><button>Log out</button></form>`;

const readForm = (req: http.IncomingMessage) =>
    new Promise<URLSearchParams>((resolve) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => resolve(new URLSearchParams(raw)));
    });
const app = http.createServer(async (req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    const sid = /sid=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    const me = sessions.get(sid);
    const html = (status: number, content: string, headers: Record<string, string> = {}) => (res.writeHead(status, { "content-type": "text/html", ...headers }), res.end(content));
    const redirect = (to: string, headers: Record<string, string> = {}) => (res.writeHead(302, { location: to, ...headers }), res.end());
    const nav = me?.full ? navFor(me.role) : publicNav;

    if (req.method === "POST" && p === "/login") {
        const f = await readForm(req);
        const acct = ACCOUNTS[f.get("email") ?? ""];
        if (!acct || acct.password !== f.get("password")) return html(401, shell("Sign in", '<p role="alert">Invalid email or password</p>', publicNav));
        const id = crypto.randomBytes(8).toString("hex");
        sessions.set(id, { role: acct.role, full: acct.role !== "admin" }); // admin needs the one-time code too
        return redirect(acct.role === "admin" ? "/verify" : "/account", { "set-cookie": `sid=${id}; Path=/; HttpOnly` });
    }
    if (p === "/verify") {
        if (!me) return redirect("/login");
        if (req.method === "POST") {
            const f = await readForm(req);
            if (!totpAccepted(ADMIN_TOTP, (f.get("code") ?? "").trim())) return html(401, shell("Two-step verification", '<p role="alert">That code is not valid</p><form method="post"><input name="code" autocomplete="one-time-code"><button>Verify</button></form>'));
            me.full = true;
            return redirect("/account");
        }
        return html(200, shell("Two-step verification", '<form method="post" action="/verify"><label>Code <input name="code" autocomplete="one-time-code"></label><button type="submit">Verify</button></form>'));
    }
    if (req.method === "POST" && p === "/logout") return redirect("/", { "set-cookie": "sid=; Path=/; Max-Age=0" });

    if (p === "/" || p === "/about") return html(200, shell(p === "/" ? "Acme Portal" : "About Acme", "<p>Welcome.</p>", nav));
    if (p === "/login") return html(200, shell("Sign in", '<form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>', publicNav));
    // Properly protected: signed in, and a visitor is sent to the sign-in page
    if (p === "/account") return me?.full ? html(200, shell("Your account", "<p>Details.</p>", nav)) : redirect("/login");
    if (p === "/orders") return me?.full ? html(200, shell("Your orders", "<p>None yet.</p>", nav)) : redirect("/login");
    // Properly protected: admins only (a user gets 403)
    if (p === "/admin/users") return !me?.full ? redirect("/login") : me.role === "admin" ? html(200, shell("User management", "<p>All users.</p>", nav)) : html(403, shell("Forbidden", "<p>Access denied.</p>", nav));
    // BROKEN: meant for admins, but any signed-in user can open it
    if (p === "/reports") return me?.full ? html(200, shell("Quarterly reports", "<p>Revenue.</p>", nav)) : redirect("/login");
    // BROKEN: no check at all, not even for visitors
    if (p === "/billing") return html(200, shell("Billing and invoices", "<p>Invoices.</p>", nav));
    // A public page nobody links to: must not be flagged (nobody's crawl reaches it, so no check is made for it)
    if (p === "/terms") return html(200, shell("Terms of service", "<p>Be nice.</p>", publicNav));
    html(404, shell("Not found", "", nav));
});

describe("on a real app with user and admin accounts", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    beforeAll(async () => {
        await new Promise<void>((r) => app.listen(PORT, "127.0.0.1", r));
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-access-"));
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
    type T = { id: string; title: string; suite: string; validationStatus: string; validationReason: string | null; severity: { severity: string; basis: string } | null };
    async function analyse(projectId: string) {
        const queued = await call("POST", `/api/projects/${projectId}/test-generation`, { url: BASE, targets: ["web"], healthChecks: false, securityChecks: false, inputChecks: false, accessibility: false, maxPages: 12 });
        expect(queued.status).toBe(202);
        for (let i = 0; i < 480; i++) {
            const j = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        return (await call("GET", `/api/projects/${projectId}/tests`)).body as T[];
    }
    let access: Record<string, T> = {};
    let projectId = "";

    it("flags the two broken pages and passes the protected ones, with the pages named and rated", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Acme access" })).body.id as string;
        const roles = await call("PUT", `/api/projects/${projectId}/roles`, { roles: [{ name: "user", username: "user@example.com", password: "pw-user-1" }, { name: "admin", username: "admin@example.com", password: "pw-admin-1", totpSecret: ADMIN_TOTP }] });
        expect(roles.status).toBe(200);

        const tests = await analyse(projectId);
        access = Object.fromEntries(tests.filter((t) => t.suite === "Access control").map((t) => [t.title, t]));
        const titles = Object.keys(access);
        expect(titles, JSON.stringify(titles)).toEqual(expect.arrayContaining(["Not signed in: cannot open /billing", "“user” account: cannot open /reports", "“user” account: cannot open /billing", "“user” account: cannot open /admin/users", "Not signed in: cannot open /admin/users", "Not signed in: cannot open /reports"]));
        expect(titles.every((t) => !t.startsWith("“admin”"))).toBe(true); // admin reaches the most pages: never the one checked
        expect(titles.some((t) => t.includes("/terms"))).toBe(false); // nobody's crawl reached it

        const findings = Object.entries(access).filter(([, t]) => t.validationStatus === "NEEDS_REVIEW").map(([title]) => title).sort();
        expect(findings).toEqual(["Not signed in: cannot open /billing", "“user” account: cannot open /billing", "“user” account: cannot open /reports"].sort());
        for (const [title, t] of Object.entries(access)) if (!findings.includes(title)) expect(t.validationStatus, `${title}: ${t.validationReason}`).toBe("VALIDATED");

        const reports = access["“user” account: cannot open /reports"]!;
        expect(reports.validationReason).toContain("Access control check failed: 1 page may be open to someone who should not see it");
        expect(reports.validationReason).toContain("- [high] A signed-in “user” user can open /reports and see “Quarterly reports”. It is normally reached only by “admin”, so this is possible broken access control");
        expect(reports.validationReason).toContain("How to fix:");
        expect(reports.severity).toEqual({ severity: "high", basis: "page open to someone it may be restricted from" });
        expect(access["Not signed in: cannot open /billing"]!.validationReason).toContain("Anyone who is not signed in can open /billing");
    }, 480_000);

    it("never puts an account's password or secret in a script, the spec or any API answer", async () => {
        const detail = (await call("GET", `/api/tests/${access["“user” account: cannot open /reports"]!.id}`)).body;
        const script = detail.scripts[0].content as string;
        expect(script).toContain("async function accessAssert");
        expect(script).toContain("function totpCode(");
        expect(script).toContain("process.env[k + \"_PASSWORD\"]");
        const everything = JSON.stringify([detail, (await call("GET", `/api/projects/${projectId}/specs`)).body, (await call("GET", `/api/projects/${projectId}`)).body, (await call("GET", `/api/projects/${projectId}/roles`)).body]);
        for (const secret of ["pw-user-1", "pw-admin-1", ADMIN_TOTP]) expect(everything).not.toContain(secret);
    });

    it("re-runs from stored specs (the accounts are looked up again, not remembered in the script)", async () => {
        const t = access["“user” account: cannot open /admin/users"]!;
        const again = await call("POST", `/api/tests/${t.id}/validate`);
        expect(again.status).toBe(202);
        for (let i = 0; i < 240; i++) {
            const j = (await call("GET", `/api/test-generation/${again.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        expect((await call("GET", `/api/tests/${t.id}`)).body.validationStatus).toBe("VALIDATED");
    }, 240_000);

    it("does nothing for a project without test accounts, and when switched off", async () => {
        const plain = (await call("POST", "/api/projects", { name: "No accounts" })).body.id as string;
        expect((await analyse(plain)).filter((t) => t.suite === "Access control")).toEqual([]);

        const off = (await call("POST", "/api/projects", { name: "Switched off" })).body.id as string;
        await call("PUT", `/api/projects/${off}/roles`, { roles: [{ name: "user", username: "user@example.com", password: "pw-user-1" }] });
        const queued = await call("POST", `/api/projects/${off}/test-generation`, { url: BASE, targets: ["web"], healthChecks: false, securityChecks: false, inputChecks: false, accessibility: false, accessChecks: false });
        for (let i = 0; i < 240; i++) {
            const j = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        expect(((await call("GET", `/api/projects/${off}/tests`)).body as T[]).filter((t) => t.suite === "Access control")).toEqual([]);
    }, 480_000);
});
