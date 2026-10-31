/**
 * Basic load check, really executed through the platform: imported load checks run by the real worker under Playwright
 * against a local fixture API (fast, contended, flaky, rate-limited, and a POST endpoint that must never be touched).
 * Proves the caps from the SERVER'S side (requests received, requests at once, methods), the early stops, the half-load
 * re-run, stored metrics, production refusal, opt-in analysis, and that the script carries no secrets.
 * Fixture ports 5550-5555. Runs `playwright test` (API only, no browser window) but keep it under the shared lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/load.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT_A = 5550; // caps, early stops, metrics
const PORT_B = 5551; // analysis (OpenAPI), production refusal
const PORT_PROD = 5552; // an address that is only ever a production environment's (nothing listens there)
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Stats {
    hits: Record<string, number>;
    methods: Record<string, number>;
    inFlight: Record<string, number>;
    maxInFlight: Record<string, number>;
    total: number;
    maxOpenSockets: number;
    /** Requests being answered at one moment across every path. */
    maxTotalInFlight: number;
}

/** A fixture API that records exactly what it was asked, per path and method, and how many requests were open at once. */
function startFixture(port: number, behave: (path: string, n: number, inFlight: number) => { delayMs?: number; status?: number }, openapi?: unknown) {
    const stats: Stats = { hits: {}, methods: {}, inFlight: {}, maxInFlight: {}, total: 0, maxOpenSockets: 0, maxTotalInFlight: 0 };
    let openNow = 0;
    let sockets = 0;
    const server = http.createServer(async (req, res) => {
        const p = (req.url ?? "/").split("?")[0]!;
        const send = (status: number, body: unknown = { ok: true }) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
        if (p === "/openapi.json" && openapi) return send(200, openapi);
        stats.total++;
        stats.methods[req.method ?? "?"] = (stats.methods[req.method ?? "?"] ?? 0) + 1;
        const n = (stats.hits[p] = (stats.hits[p] ?? 0) + 1);
        const open = (stats.inFlight[p] = (stats.inFlight[p] ?? 0) + 1);
        stats.maxInFlight[p] = Math.max(stats.maxInFlight[p] ?? 0, open);
        stats.maxTotalInFlight = Math.max(stats.maxTotalInFlight, ++openNow);
        const b = behave(p, n, open);
        if (b.delayMs) await sleep(b.delayMs);
        stats.inFlight[p]!--;
        openNow--;
        send(b.status ?? 200);
    });
    server.on("connection", (s) => {
        sockets++;
        stats.maxOpenSockets = Math.max(stats.maxOpenSockets, sockets);
        s.on("close", () => sockets--);
    });
    return { stats, server, listen: () => new Promise<void>((r) => server.listen(port, "127.0.0.1", r)), close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
}

const fixtureA = startFixture(PORT_A, (p, n, open) => {
    if (p === "/api/contended") return { delayMs: 150 * open }; // every request in flight at once adds 150 ms to each answer: 10 users ~1.5 s, 5 users ~0.75 s (wide margins: the machine may be busy)
    if (p === "/api/flaky") return { status: n % 2 === 0 ? 500 : 200 };
    if (p === "/api/limited") return { status: n > 25 ? 429 : 200 };
    return { delayMs: 5 };
});
const openapiB = {
    openapi: "3.0.0",
    info: { title: "Shop", version: "1" },
    servers: [{ url: BASE_B }],
    paths: {
        "/api/login": { get: { summary: "login", responses: { "200": { description: "ok" } } } },
        "/api/orders": { post: { summary: "create an order", requestBody: { content: { "application/json": { schema: { type: "object", properties: { sku: { type: "string" } } } } } }, responses: { "201": { description: "created" } } } },
        ...Object.fromEntries(["a", "b", "c", "d"].map((x) => [`/api/${x}`, { get: { summary: x, responses: { "200": { description: "ok" } } } }])),
    },
};
const fixtureB = startFixture(PORT_B, () => ({ delayMs: 3 }), openapiB);

describe("on a real API", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };
    type T = { id: string; testId: string; title: string; suite: string; validationStatus: string; validationReason: string | null; severity: { severity: string; basis: string } | null };
    const loadSpec = (p: string, budgets?: string) => ({
        title: `GET ${p}: handles 10 users at once`,
        kind: "api",
        category: "Performance",
        type: "performance",
        source: { origin: "performance-check" },
        steps: [{ action: "request", method: "GET", path: p, auth: "default" }, { action: "assertResponse", check: "load", ...(budgets ? { expected: budgets } : {}) }],
    });
    async function done(jobId: string): Promise<void> {
        for (let i = 0; i < 600; i++) {
            const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return;
            await sleep(500);
        }
        throw new Error("job never finished");
    }
    const testsOf = async (project: string) => (await call("GET", `/api/projects/${project}/tests`)).body as T[];

    beforeAll(async () => {
        await Promise.all([fixtureA.listen(), fixtureB.listen()]);
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-load-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "3" }));
        server = await buildServer(platform);
        worker = new Worker(platform, 200);
        worker.start();
    }, 30_000);
    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        await Promise.all([fixtureA.close(), fixtureB.close()]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // ── caps, early stops, half-load re-run, metrics ────────────────────────────
    let projectA = "";
    let by: Record<string, T> = {};

    it("passes a healthy endpoint, flags a contended one and a failing one, and treats a rate limit as a note", async () => {
        projectA = (await call("POST", "/api/projects", { name: "Load" })).body.id as string;
        const specs = [
            loadSpec("/api/fast"), // the full default profile: 10 users, about 10 seconds, up to 300 requests
            loadSpec("/api/contended", "p95:1100 seconds:5"),
            loadSpec("/api/flaky", "seconds:5"),
        ];
        // An import carries at most 3 load checks, so the fourth comes in a second import.
        const imported = await call("POST", `/api/projects/${projectA}/specs`, { specs, baseUrl: BASE_A });
        expect(imported.status, JSON.stringify(imported.body)).toBe(202);
        await done(imported.body.jobId);
        const second = await call("POST", `/api/projects/${projectA}/specs`, { specs: [loadSpec("/api/limited", "seconds:5")], baseUrl: BASE_A });
        expect(second.status, JSON.stringify(second.body)).toBe(202);
        await done(second.body.jobId);
        by = Object.fromEntries((await testsOf(projectA)).map((t) => [t.title.split(": ")[0]!, t]));

        const fast = by["GET /api/fast"]!;
        expect(fast.validationStatus, fast.validationReason ?? "").toBe("VALIDATED");

        const contended = by["GET /api/contended"]!;
        expect(contended.validationStatus).toBe("NEEDS_REVIEW");
        expect(contended.validationReason).toMatch(/^Load check failed: the endpoint struggled at 10 users at once \(it coped with 5\)/);
        expect(contended.validationReason).toMatch(/- \[medium\] 95% of responses arrive within [\d.]+ (ms|s) \(budget 1\.1 s\)/);
        expect(contended.validationReason).toContain("How to fix:");
        expect(contended.severity).toEqual({ severity: "medium", basis: "API endpoint struggles under load" });

        const flaky = by["GET /api/flaky"]!;
        expect(flaky.validationStatus).toBe("NEEDS_REVIEW");
        expect(flaky.validationReason).toContain("struggled at 5 users at once");
        expect(flaky.validationReason).toContain("Stopped to protect the application");
        expect(flaky.severity!.severity).toBe("medium");

        const limited = by["GET /api/limited"]!;
        expect(limited.validationStatus, limited.validationReason ?? "").toBe("VALIDATED"); // a rate limiter doing its job is not a finding
        expect(limited.validationReason).toContain("limits how often it can be called (HTTP 429)");
        expect(limited.severity).toBeNull();
    }, 400_000);

    it("stayed inside the caps as the SERVER saw it: at most 300 requests per endpoint, at most 10 at once, only GET", () => {
        const s = fixtureA.stats;
        for (const p of ["/api/fast", "/api/contended", "/api/flaky", "/api/limited"]) {
            expect(s.hits[p], p).toBeLessThanOrEqual(300);
            expect(s.maxInFlight[p], p).toBeLessThanOrEqual(10);
        }
        expect(s.hits["/api/fast"]!).toBeGreaterThan(100); // a real amount of traffic
        // Load checks take turns, so the application never sees two groups of 10 users; the few extra are the other tests' own single requests.
        expect(s.maxTotalInFlight).toBeLessThanOrEqual(10 + 3);
        expect(s.hits["/api/contended"]!).toBeGreaterThan(30); // both rounds ran (answers are slow under load, so each round sends few requests)
        expect(s.maxInFlight["/api/contended"]!).toBeGreaterThanOrEqual(8); // the main round really had (almost) 10 users at once
        expect(s.hits["/api/flaky"]!).toBeLessThan(80); // stopped early, twice
        expect(s.hits["/api/limited"]!).toBeLessThanOrEqual(25 + 10 + 1); // nothing after the 429 except what was already on its way
        expect(Object.keys(s.methods)).toEqual(["GET"]);
    });

    it("keeps the measured values per run, visible through the performance API", async () => {
        const perf = (await call("GET", `/api/tests/${by["GET /api/fast"]!.id}/performance`)).body;
        const latest = Object.fromEntries(perf.latest.map((m: { metric: string; value: number; unit: string; budget?: number }) => [m.metric, m]));
        expect(Object.keys(latest).sort()).toEqual(["load_4xx", "load_429", "load_5xx", "load_error_rate", "load_max", "load_network", "load_ok", "load_p50", "load_p95", "load_requests", "load_rps", "load_users"].sort());
        expect(latest.load_users.value).toBe(10);
        expect(latest.load_requests.value).toBeGreaterThan(100);
        expect(latest.load_requests.value).toBeLessThanOrEqual(299);
        expect(latest.load_p95.budget).toBe(1000);
        expect(latest.load_p95.unit).toBe("ms");
        expect(latest.load_error_rate.value).toBe(0);
        expect(latest.load_error_rate.budget).toBe(1);
        expect(latest.load_rps.unit).toBe("req/s");
        // The contended endpoint's metrics describe the 10-user run that went over budget.
        const contended = Object.fromEntries((await call("GET", `/api/tests/${by["GET /api/contended"]!.id}/performance`)).body.latest.map((m: { metric: string; value: number }) => [m.metric, m]));
        expect(contended.load_p95.value).toBeGreaterThan(1100);
        expect(contended.load_429.value).toBe(0);
        // A 429 run still records what it measured.
        const limited = Object.fromEntries((await call("GET", `/api/tests/${by["GET /api/limited"]!.id}/performance`)).body.latest.map((m: { metric: string; value: number }) => [m.metric, m]));
        expect(limited.load_429.value).toBeGreaterThanOrEqual(1);
    });

    it("renders a portable script that carries the helper with its caps and no secrets", async () => {
        const detail = (await call("GET", `/api/tests/${by["GET /api/fast"]!.id}`)).body;
        const script = detail.scripts[0].content as string;
        expect(script).toContain("async function loadAssert");
        expect(script).toContain("const LOAD_MAX_USERS = 10;");
        expect(script).toContain("const LOAD_MAX_REQUESTS = 300;");
        expect(script).toContain('"p95:1000 errors:1 users:10 seconds:10 requests:300"');
        expect(script).toContain('method: "GET"');
        expect(script).not.toMatch(/sk-|password/i);
        expect(JSON.stringify(detail)).not.toMatch(/sk-[A-Za-z0-9]/);
    });

    it("never sends a data-changing request: a load check after a POST is refused, and the POST endpoint is never touched", async () => {
        const project = (await call("POST", "/api/projects", { name: "Load POST" })).body.id as string;
        const post = { title: "POST /api/post: handles 10 users at once", kind: "api", type: "performance", steps: [{ action: "request", method: "POST", path: "/api/post", auth: "default" }, { action: "assertResponse", check: "load" }] };
        const res = await call("POST", `/api/projects/${project}/specs`, { specs: [post], baseUrl: BASE_A });
        expect(res.status).toBe(422);
        expect(fixtureA.stats.hits["/api/post"]).toBeUndefined();
        expect(fixtureA.stats.methods.POST).toBeUndefined();
    });

    // ── production and opt-in ──────────────────────────────────────────────────────
    it("refuses to run on production: an environment run is skipped with the plain reason, a load analysis of that address is refused, and a re-run does not send load", async () => {
        const prodEnv = await call("POST", `/api/projects/${projectA}/environments`, { name: "production", baseUrl: `http://127.0.0.1:${PORT_PROD}`, production: true });
        expect(prodEnv.status, JSON.stringify(prodEnv.body)).toBe(201);
        const started = await call("POST", `/api/projects/${projectA}/environments/production/runs`, { confirmProduction: true, testIds: [by["GET /api/fast"]!.id] });
        expect(started.status).toBe(422);
        expect(JSON.stringify(started.body)).toContain("load checks don't run on production");

        // A project whose production environment IS the analysed address: the load option is refused, the rest is allowed.
        const project = (await call("POST", "/api/projects", { name: "Load production" })).body.id as string;
        expect((await call("POST", `/api/projects/${project}/environments`, { name: "production", baseUrl: BASE_B, production: true })).status).toBe(201);
        const refused = await call("POST", `/api/projects/${project}/test-generation`, { url: BASE_B, targets: ["api"], loadChecks: true });
        expect(refused.status).toBe(409);
        expect(JSON.stringify(refused.body)).toContain("Load checks don't run on production");
        expect(fixtureB.stats.total).toBe(0);

        // A re-run of a load check whose address is a production environment is not sent either.
        const imported = await call("POST", `/api/projects/${project}/specs`, { specs: [loadSpec("/api/z")], baseUrl: BASE_B });
        expect(imported.status, JSON.stringify(imported.body)).toBe(202);
        await done(imported.body.jobId);
        expect(fixtureB.stats.hits["/api/z"]).toBeUndefined();
        const events = (await call("GET", `/api/test-generation/${imported.body.jobId}/events`)).body as Array<{ kind: string; message: string }> | { events: Array<{ kind: string; message: string }> };
        const list = Array.isArray(events) ? events : events.events;
        expect(list.some((e) => e.kind === "load_skipped" && e.message.includes("don't run on production"))).toBe(true);
    }, 120_000);

    it("is off unless asked for: an analysis without the option makes no load checks; with it, at most 3, GET only, never sign-in or data-changing endpoints", async () => {
        const off = (await call("POST", "/api/projects", { name: "Load off" })).body.id as string;
        const queued = await call("POST", `/api/projects/${off}/test-generation`, { url: BASE_B, targets: ["api"], securityChecks: false, contractChecks: false });
        expect(queued.status).toBe(202);
        await done(queued.body.jobId);
        const none = await testsOf(off);
        expect(none.length).toBeGreaterThan(0);
        expect(none.filter((t) => /handles \d+ users at once/.test(t.title))).toEqual([]);
        const before = { ...fixtureB.stats.hits };

        const on = (await call("POST", "/api/projects", { name: "Load on" })).body.id as string;
        const started = await call("POST", `/api/projects/${on}/test-generation`, { url: BASE_B, targets: ["api"], securityChecks: false, contractChecks: false, loadChecks: true, loadBudgets: "users:3 seconds:3 requests:60 p95:900" });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        await done(started.body.jobId);
        const all = await testsOf(on);
        const load = all.filter((t) => /handles 3 users at once/.test(t.title));
        expect(load.map((t) => t.title).sort()).toEqual(["GET /api/a: handles 3 users at once", "GET /api/b: handles 3 users at once", "GET /api/c: handles 3 users at once"]);
        expect(load.every((t) => t.validationStatus === "VALIDATED"), JSON.stringify(load.map((t) => [t.title, t.validationStatus, t.validationReason]))).toBe(true);
        expect(all.some((t) => /login|orders/.test(t.title) && /handles/.test(t.title))).toBe(false);
        // The lowered limits were honoured by the server's own count: three users, at most 60 requests (59 + the test's own) per endpoint beyond the ordinary tests.
        const extra = (p: string) => (fixtureB.stats.hits[p] ?? 0) - (before[p] ?? 0);
        for (const p of ["/api/a", "/api/b", "/api/c"]) expect(extra(p), p).toBeLessThanOrEqual(60 + 12);
        expect(fixtureB.stats.maxInFlight["/api/d"] ?? 0).toBeLessThanOrEqual(3);
        expect(Object.keys(fixtureB.stats.methods).every((m) => ["GET", "POST"].includes(m))).toBe(true);
        const detail = (await call("GET", `/api/tests/${load[0]!.id}`)).body;
        expect(detail.scripts[0].content).toContain('"p95:900 errors:1 users:3 seconds:3 requests:60"');
    }, 400_000);
});
