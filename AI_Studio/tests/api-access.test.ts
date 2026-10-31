/**
 * Access-control checks for API endpoints, really executed: a fixture API with an admin-only endpoint that is properly
 * protected, one that wrongly lets a plain user in, and one that is open to everyone — surveyed and checked through the worker.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { generateApiAccessSpecs, surveyApiAccess, type ApiAccessRow } from "../src/engine/identity/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const row = (p: string, status: Record<string, number>): ApiAccessRow => ({ method: "GET", path: p, called: p, status });

describe("generation rules", () => {
    const rows = [
        row("/api/admin/users", { anonymous: 401, user: 403, admin: 200 }),
        row("/api/admin/reports", { anonymous: 401, user: 200, admin: 200 }),
        row("/api/admin/export", { anonymous: 200, user: 200, admin: 200 }),
    ];
    const names = (specs: ReturnType<typeof generateApiAccessSpecs>) => specs.map((s) => s.title).sort();

    it("asks every lesser viewer to be refused by each endpoint the most privileged account can call", () => {
        expect(names(generateApiAccessSpecs(rows))).toEqual(
            [
                "Not signed in: cannot call GET /api/admin/export",
                "Not signed in: cannot call GET /api/admin/reports",
                "Not signed in: cannot call GET /api/admin/users",
                "“user” account: cannot call GET /api/admin/export",
                "“user” account: cannot call GET /api/admin/reports",
                "“user” account: cannot call GET /api/admin/users",
            ].sort(),
        );
    });

    it("renders one GET with the account's token (never the default credential) and a refusal check", () => {
        const spec = generateApiAccessSpecs(rows).find((s) => s.title === "“user” account: cannot call GET /api/admin/reports")!;
        expect(spec).toMatchObject({ kind: "api", type: "security", category: "Access control", priority: "high", source: { origin: "access-check" } });
        expect(spec.steps[0]).toMatchObject({ action: "request", method: "GET", path: "/api/admin/reports", auth: "none", headers: { Authorization: "Bearer {{credentials.user.apiToken}}" } });
        expect(spec.steps[1]).toMatchObject({ action: "assertResponse", check: "statusDenied" });
        expect(JSON.parse(String((spec.steps[1] as { expected: string }).expected))).toEqual({ as: "user", path: "/api/admin/reports", by: "admin", sev: "high" });
        const anon = generateApiAccessSpecs(rows).find((s) => s.title.startsWith("Not signed in"))!;
        expect((anon.steps[0] as { headers?: unknown }).headers).toBeUndefined();
    });

    it("makes no checks when nobody with a token can call the endpoint, or there is one account only", () => {
        expect(generateApiAccessSpecs([row("/api/admin/x", { anonymous: 401, user: 403, admin: 403 })])).toEqual([]);
        expect(generateApiAccessSpecs([row("/api/admin/x", { anonymous: 401, admin: 200 })]).map((s) => s.title)).toEqual(["Not signed in: cannot call GET /api/admin/x"]);
    });

    it("caps the number of checks", () => {
        const many = Array.from({ length: 10 }, (_, i) => row(`/api/admin/a${i}`, { anonymous: 401, user: 403, admin: 200 }));
        expect(generateApiAccessSpecs(many)).toHaveLength(8);
    });
});

describe("survey", () => {
    it("calls only privileged-looking GET endpoints, one at a time, each as a visitor and per account with a token", async () => {
        const calls: Array<{ url: string; auth?: string }> = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const request = {
            async get(url: string, o: { headers: Record<string, string> }) {
                maxInFlight = Math.max(maxInFlight, ++inFlight);
                calls.push({ url, auth: o.headers.Authorization });
                await new Promise((r) => setTimeout(r, 2));
                inFlight--;
                return { status: () => 200 };
            },
        };
        const rows = await surveyApiAccess(
            request,
            "http://x.test",
            [
                { method: "GET", path: "/api/admin/users", called: "/api/admin/users" },
                { method: "GET", path: "/api/products", called: "/api/products" }, // not privileged-looking: never called
                { method: "POST", path: "/api/admin/delete", called: "/api/admin/delete" }, // never POST
            ],
            [{ name: "user", username: "u", password: "p", apiToken: "tok-u" }, { name: "plain", username: "x", password: "y" }],
        );
        expect(rows).toEqual([{ method: "GET", path: "/api/admin/users", called: "/api/admin/users", status: { anonymous: 200, user: 200 } }]);
        expect(calls.map((c) => c.auth)).toEqual([undefined, "Bearer tok-u"]);
        expect(maxInFlight).toBe(1);
    });
    it("does nothing without any account token", async () => {
        const request = { get: async () => { throw new Error("must not be called"); } };
        expect(await surveyApiAccess(request, "http://x.test", [{ method: "GET", path: "/api/admin/a", called: "/api/admin/a" }], [{ name: "user", username: "u", password: "p" }])).toEqual([]);
    });
});

// ── a real run ────────────────────────────────────────────────────────────────
const PORT = 5342;
const BASE = `http://127.0.0.1:${PORT}`;
const OPENAPI = {
    openapi: "3.0.0",
    info: { title: "Acme API", version: "1" },
    servers: [{ url: BASE }],
    paths: Object.fromEntries(["/api/admin/users", "/api/admin/reports", "/api/admin/export", "/api/profile"].map((p) => [p, { get: { summary: p, responses: { "200": { description: "ok" } } } }])),
};
const calls: string[] = [];
const api = http.createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    const auth = String(req.headers.authorization ?? "");
    calls.push(`${req.method} ${p} ${auth || "-"}`);
    const who = auth === "Bearer tok-admin" ? "admin" : auth === "Bearer tok-user" ? "user" : "anonymous";
    const send = (status: number, body: unknown = { ok: true }) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
    if (p === "/openapi.json") return send(200, OPENAPI);
    if (p === "/api/admin/users") return who === "admin" ? send(200) : who === "user" ? send(403) : send(401); // properly protected
    if (p === "/api/admin/reports") return who === "anonymous" ? send(401) : send(200); // BROKEN: any signed-in user
    if (p === "/api/admin/export") return send(200); // BROKEN: open to everyone
    if (p === "/api/profile") return who === "anonymous" ? send(401) : send(200); // ordinary: not probed
    send(404);
});

describe("on a real API with user and admin tokens", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    const call = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };
    type T = { id: string; title: string; suite: string; validationStatus: string; validationReason: string | null; severity: { severity: string } | null };
    let projectId = "";
    let access: Record<string, T> = {};

    beforeAll(async () => {
        await new Promise<void>((r) => api.listen(PORT, "127.0.0.1", r));
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-apiaccess-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
        worker = new Worker(platform, 200);
        worker.start();
    }, 30_000);
    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        await new Promise((r) => api.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("flags the open and the over-permissive endpoints and passes the protected one", async () => {
        projectId = (await call("POST", "/api/projects", { name: "API access" })).body.id as string;
        const saved = await call("PUT", `/api/projects/${projectId}/roles`, { roles: [{ name: "user", username: "u", password: "p", apiToken: "tok-user" }, { name: "admin", username: "a", password: "q", apiToken: "tok-admin" }] });
        expect(saved.body.roles).toEqual([
            { name: "user", username: "u", hasPassword: true, hasTotp: false, hasApiToken: true },
            { name: "admin", username: "a", hasPassword: true, hasTotp: false, hasApiToken: true },
        ]);
        const queued = await call("POST", `/api/projects/${projectId}/test-generation`, { url: BASE, targets: ["api"], securityChecks: false, contractChecks: false });
        for (let i = 0; i < 480; i++) {
            const j = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as T[];
        access = Object.fromEntries(tests.filter((t) => t.suite === "Access control").map((t) => [t.title, t]));
        expect(Object.keys(access).sort()).toEqual(
            [
                "Not signed in: cannot call GET /api/admin/export",
                "Not signed in: cannot call GET /api/admin/reports",
                "Not signed in: cannot call GET /api/admin/users",
                "“user” account: cannot call GET /api/admin/export",
                "“user” account: cannot call GET /api/admin/reports",
                "“user” account: cannot call GET /api/admin/users",
            ].sort(),
        );
        const open = Object.entries(access).filter(([, t]) => t.validationStatus === "NEEDS_REVIEW").map(([title]) => title).sort();
        expect(open).toEqual(["Not signed in: cannot call GET /api/admin/export", "“user” account: cannot call GET /api/admin/export", "“user” account: cannot call GET /api/admin/reports"].sort());
        for (const [title, t] of Object.entries(access)) if (!open.includes(title)) expect(t.validationStatus, `${title}: ${t.validationReason}`).toBe("VALIDATED");

        const reports = access["“user” account: cannot call GET /api/admin/reports"]!;
        expect(reports.validationReason).toContain("Access control check failed: 1 endpoint may be open to someone who should not call it");
        expect(reports.validationReason).toContain("- [high] A caller with the “user” account’s token can call GET /api/admin/reports (HTTP 200). It is normally reached only by “admin”");
        expect(reports.validationReason).toContain("possible broken access control");
        expect(reports.severity!.severity).toBe("high");
        expect(access["Not signed in: cannot call GET /api/admin/export"]!.validationReason).toContain("A caller without credentials can call GET /api/admin/export (HTTP 200)");
    }, 480_000);

    it("only ever sent GET requests, and never probed the ordinary endpoint with the accounts' tokens", () => {
        expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
        expect(calls.some((c) => c.startsWith("GET /api/profile") && c.includes("tok-"))).toBe(false);
    });

    it("keeps tokens out of scripts, specs and every API answer, and uses them from the environment", async () => {
        const t = access["“user” account: cannot call GET /api/admin/reports"]!;
        const detail = (await call("GET", `/api/tests/${t.id}`)).body;
        const script = detail.scripts[0].content as string;
        expect(script).toContain("process.env.TEST_USER_API_TOKEN");
        expect(script).toContain("function accessStatusAssert");
        const everything = JSON.stringify([detail, (await call("GET", `/api/projects/${projectId}/specs`)).body, (await call("GET", `/api/projects/${projectId}/roles`)).body, (await call("GET", `/api/projects/${projectId}`)).body]);
        for (const secret of ["tok-user", "tok-admin"]) expect(everything).not.toContain(secret);
    });

    it("re-runs from the stored spec, finding the token in the environment again", async () => {
        const t = access["“user” account: cannot call GET /api/admin/users"]!;
        const again = await call("POST", `/api/tests/${t.id}/validate`);
        for (let i = 0; i < 240; i++) {
            const j = (await call("GET", `/api/test-generation/${again.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        expect((await call("GET", `/api/tests/${t.id}`)).body.validationStatus).toBe("VALIDATED");
    }, 240_000);

    it("keeps a saved token when it is left out, and removes it with an empty value", async () => {
        const kept = await call("PUT", `/api/projects/${projectId}/roles`, { roles: [{ name: "user", username: "u" }, { name: "admin", username: "a", apiToken: "" }] });
        expect(kept.body.roles.map((r: { name: string; hasApiToken: boolean }) => [r.name, r.hasApiToken])).toEqual([["user", true], ["admin", false]]);
    });
});
