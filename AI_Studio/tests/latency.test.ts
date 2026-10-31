/** API latency checks: the helper, generation, and a real run proving requests are sequential and stop at 429 / 5xx. */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateLatencySpecs, LATENCY_FAILURE_PREFIX, loadLatencyRuntime } from "../src/engine/performance/latency.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const rt = loadLatencyRuntime();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function outcome(send: () => Promise<{ status: number }>, spec?: string) {
    const attached: Array<{ name: string; body: string }> = [];
    try {
        await rt.latencyAssert(send, spec, (name, body) => void attached.push({ name, body }));
        return { error: undefined as string | undefined, attached };
    } catch (e) {
        return { error: (e as Error).message, attached };
    }
}

describe("helper", () => {
    it("parses overrides and clamps the number of requests", () => {
        expect(rt.latencyParse("")).toEqual({ p95: 1000, runs: 10 });
        expect(rt.latencyParse("p95:500 p50=200 max:3000 runs:15 bogus:1")).toEqual({ p95: 500, p50: 200, max: 3000, runs: 15 });
        expect(rt.latencyParse("runs:1").runs).toBe(3);
        expect(rt.latencyParse("runs:500").runs).toBe(30);
    });

    it("passes a fast endpoint, makes exactly one warm-up plus the measured requests, and records the values", async () => {
        let calls = 0;
        const { error, attached } = await outcome(async () => (calls++, { status: 200 }), "p95:200 runs:5");
        expect(error).toBeUndefined();
        expect(calls).toBe(6); // 1 warm-up (discarded) + 5 measured
        const metrics = JSON.parse(attached[0]!.body) as Array<{ metric: string; value: number; budget?: number }>;
        expect(attached[0]!.name).toBe("metrics");
        expect(metrics.map((m) => m.metric)).toEqual(["p50", "p95", "max"]);
        expect(metrics.find((m) => m.metric === "p95")!.budget).toBe(200);
    });

    it("never sends two requests at once", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        await outcome(async () => {
            maxInFlight = Math.max(maxInFlight, ++inFlight);
            await sleep(5);
            inFlight--;
            return { status: 200 };
        }, "runs:6");
        expect(maxInFlight).toBe(1);
    });

    it("rates how far over budget an endpoint is: <1.5x low, >=1.5x medium, >=3x high", async () => {
        const slow = (ms: number) => async () => (await sleep(ms), { status: 200 });
        // Margins are wide on purpose: timers on a busy machine are off by tens of milliseconds.
        const sev = async (ms: number) => /\[(low|medium|high)\] 95%/.exec((await outcome(slow(ms), "p95:200 runs:3")).error ?? "")?.[1];
        expect(await sev(225)).toBe("low"); // ~1.1x
        expect(await sev(350)).toBe("medium"); // ~1.75x
        expect(await sev(700)).toBe("high"); // ~3.5x
    });

    it("reports a p50 or max budget too, with plain wording", async () => {
        const { error } = await outcome(async () => (await sleep(40), { status: 200 }), "p95:10000 p50:10 max:20 runs:3");
        expect(error).toMatch(new RegExp(`^${LATENCY_FAILURE_PREFIX} 2 measurements are over budget for this endpoint \\(3 requests, one at a time\\)`));
        expect(error).toMatch(/The typical \(median\) response takes \d+ ms \(budget 10 ms\)/);
        expect(error).toMatch(/The slowest of 3 requests took \d+ ms \(budget 20 ms\)/);
    });

    it("stops at once on HTTP 429 and on 5xx, and still records what was measured", async () => {
        let n = 0;
        const limited = await outcome(async () => ({ status: ++n >= 4 ? 429 : 200 }), "runs:10");
        expect(n).toBe(4); // not one request more
        expect(limited.error).toContain("limits how often it can be called (HTTP 429)");
        expect(limited.error).toContain("- [low] It answered HTTP 429 after 3 requests; measuring stopped there");
        expect(limited.attached).toHaveLength(1); // the 2 measured requests so far

        let m = 0;
        const boom = await outcome(async () => (m++, { status: 503 }), "runs:10");
        expect(m).toBe(1);
        expect(boom.error).toContain("fails instead of answering (HTTP 503)");
        expect(boom.error).toContain("- [high] It answered HTTP 503 on request 1; measuring stopped there");
        expect(boom.attached).toHaveLength(0); // nothing was measured
    });
});

describe("generation", () => {
    const op = (summary: string, extra: Record<string, unknown> = {}) => ({ get: { summary, ...extra, responses: { "200": { description: "ok" } } } });
    const doc = {
        openapi: "3.0.0",
        info: { title: "t", version: "1" },
        paths: {
            "/a": op("a"),
            "/b": op("b", { parameters: [{ name: "limit", in: "query", required: true, schema: { type: "integer" } }] }),
            "/items/{id}": { get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }], responses: { "200": { description: "ok" } } } }, // no example: cannot be called
            "/items/{kind}": { get: { parameters: [{ name: "kind", in: "path", required: true, schema: { type: "string", enum: ["x"] } }], responses: { "200": { description: "ok" } } } },
            "/c": { post: { responses: { "200": { description: "ok" } } } }, // never: changes data
            ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`/many${i}`, op(`m${i}`)])),
        },
    };
    const endpoints = parseOpenApi(doc, "http://x/openapi.json").operations;

    it("picks only safe GET endpoints it can call, at most the cap", () => {
        const specs = generateLatencySpecs(endpoints, { maxEndpoints: 4 });
        expect(specs).toHaveLength(4);
        expect(specs.map((s) => s.title)).toEqual(["GET /a: responds quickly", "GET /b: responds quickly", "GET /items/{kind}: responds quickly", "GET /many0: responds quickly"]);
        const all = generateLatencySpecs(endpoints, { maxEndpoints: 50 }).map((s) => s.title);
        expect(all).not.toContain("GET /items/{id}: responds quickly");
        expect(all.some((t) => t.startsWith("POST"))).toBe(false);
    });

    it("sends the request first (with its required query), then the latency check, with budgets in the step", () => {
        const b = generateLatencySpecs(endpoints, { maxEndpoints: 5, budgets: "p95:500" }).find((s) => s.title.startsWith("GET /b"))!;
        expect(b.steps[0]).toMatchObject({ action: "request", method: "GET", path: "/b", query: { limit: "1" } });
        expect(b.steps[1]).toMatchObject({ action: "assertResponse", check: "latency", expected: "p95:500" });
        expect(b.steps[1]!.description).toContain("95% within 500 ms");
        expect(b).toMatchObject({ kind: "api", type: "performance", category: "Performance", source: { origin: "performance-check" } });
    });
});

// ── a real run ────────────────────────────────────────────────────────────────
const PORT = 5330;
const BASE = `http://127.0.0.1:${PORT}`;
const hits: Record<string, number> = {};
// Different endpoints may be tested in parallel; each endpoint must only ever see one request at a time.
const inFlight: Record<string, number> = {};
const maxInFlight: Record<string, number> = {};
const api = http.createServer(async (req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    hits[p] = (hits[p] ?? 0) + 1;
    inFlight[p] = (inFlight[p] ?? 0) + 1;
    maxInFlight[p] = Math.max(maxInFlight[p] ?? 0, inFlight[p]!);
    const done = (status: number, body: unknown = { ok: true }) => {
        inFlight[p]!--;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    };
    if (p === "/api/slow") await sleep(250);
    if (p === "/api/limited" && hits[p]! >= 4) return done(429, { error: "slow down" });
    if (p === "/api/boom") return done(500, { error: "boom" });
    done(200);
});

describe("on a real API", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };
    const spec = (p: string, budgets: string) => ({
        title: `GET ${p}: responds quickly`,
        kind: "api",
        category: "Performance",
        type: "performance",
        source: { origin: "performance-check" },
        steps: [{ action: "request", method: "GET", path: p, auth: "default" }, { action: "assertResponse", check: "latency", expected: budgets }],
    });
    type T = { id: string; title: string; validationStatus: string; validationReason: string | null; severity: { severity: string } | null };
    let by: Record<string, T> = {};

    beforeAll(async () => {
        await new Promise<void>((r) => api.listen(PORT, "127.0.0.1", r));
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-latency-"));
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

    it("passes a fast endpoint, flags a slow one, and handles rate limiting and server errors", async () => {
        const project = (await call("POST", "/api/projects", { name: "Latency" })).body.id as string;
        const specs = [spec("/api/fast", "p95:300 runs:10"), spec("/api/slow", "p95:130 runs:4"), spec("/api/limited", "p95:300 runs:10"), spec("/api/boom", "p95:300 runs:10")];
        const res = await call("POST", `/api/projects/${project}/specs`, { specs, baseUrl: BASE });
        expect(res.status).toBe(202);
        for (let i = 0; i < 240; i++) {
            const j = (await call("GET", `/api/test-generation/${res.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await sleep(500);
        }
        by = Object.fromEntries(((await call("GET", `/api/projects/${project}/tests`)).body as T[]).map((t) => [t.title.split(": ")[0]!, t]));

        expect(by["GET /api/fast"]!.validationStatus).toBe("VALIDATED");

        const slow = by["GET /api/slow"]!;
        expect(slow.validationStatus).toBe("NEEDS_REVIEW");
        expect(slow.validationReason).toMatch(/^API speed check failed: 1 measurement is over budget for this endpoint \(4 requests, one at a time\)/);
        expect(slow.validationReason).toMatch(/\[medium\] 95% of responses arrive within \d+ ms \(budget 130 ms\)/);
        expect(slow.validationReason).toContain("How to fix:");
        expect(slow.severity).toEqual({ severity: "medium", basis: "API endpoint answers slowly" }); // ~1.9x the budget

        const limited = by["GET /api/limited"]!;
        expect(limited.validationStatus).toBe("NEEDS_REVIEW");
        expect(limited.validationReason).toContain("HTTP 429");
        expect(limited.severity!.severity).toBe("low");

        const boom = by["GET /api/boom"]!;
        expect(boom.validationStatus).toBe("NEEDS_REVIEW");
        expect(boom.validationReason).toContain("fails instead of answering (HTTP 500)");
        expect(boom.severity!.severity).toBe("high");
    }, 240_000);

    it("was gentle: one request at a time per endpoint, exactly the requests it needed, and no more after a 429 or a 5xx", () => {
        for (const endpoint of ["/api/fast", "/api/slow", "/api/limited", "/api/boom"]) expect(maxInFlight[endpoint], endpoint).toBe(1);
        expect(hits["/api/fast"]).toBe(12); // the test's own request + 1 warm-up + 10 measured
        expect(hits["/api/slow"]).toBe(6); // 1 + 1 + 4
        expect(hits["/api/limited"]).toBe(4); // stopped at the first 429
        expect(hits["/api/boom"]).toBe(2); // the test's request, then the warm-up, which failed
    });

    it("keeps the measured values as history", async () => {
        const history = (await call("GET", `/api/tests/${by["GET /api/slow"]!.id}/performance`)).body;
        const latest = Object.fromEntries(history.latest.map((m: { metric: string; value: number; budget?: number }) => [m.metric, m]));
        expect(Object.keys(latest).sort()).toEqual(["max", "p50", "p95"]);
        expect(latest.p95.budget).toBe(130);
        expect(latest.p95.value).toBeGreaterThan(200);
        expect(latest.max.value).toBeGreaterThanOrEqual(latest.p95.value);
        expect((await call("GET", `/api/tests/${by["GET /api/boom"]!.id}/performance`)).body.latest).toEqual([]); // nothing was measured
    });

    it("renders a portable script that carries the helper, no secrets", async () => {
        const detail = (await call("GET", `/api/tests/${by["GET /api/slow"]!.id}`)).body;
        const script = detail.scripts[0].content as string;
        expect(script).toContain("async function latencyAssert");
        expect(script).toContain('latencyAssert(() => call(request, "GET", "/api/slow"');
        expect(script).toContain('"p95:130 runs:4"');
        expect(script).not.toMatch(/sk-|password/i);
    });
});
