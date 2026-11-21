/**
 * D-a, the bench data back end (Phase 4 T20; spec 4.4): the benchmark apps' read-only data routes as a `DatabaseProbe`.
 *   - each stored-data seed is red with the seed on, alone, and green on the clean app (tests/fixtures/db-seeds.ts);
 *   - only loopback apps, only with the token; a refusal never names the token;
 *   - the harness (src/eval/bench/controller.ts) starts the app with a random token per trial and hands the engine a probe for the app's
 *     address, never the token: it is in no request to the platform, no log line and nothing the run keeps. With a database back end the
 *     stored-data-only seeds count as reachable; without one the trial is scored as in Phase 3.
 * Plain HTTP against the apps on free loopback ports, a scripted platform client, no browser, no AI.
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { benchDataProbe, benchProbeFor } from "../src/engine/database/bench-data.js";
import type { BenchApp } from "../src/eval/bench/apps.js";
import { isUnreachable, type Catalogue } from "../src/eval/bench/catalogue.js";
import { runBenchmark, type BenchOptions } from "../src/eval/bench/controller.js";
import type { BenchConfig } from "../src/eval/bench/schema.js";
import { BENCH_DATA_TEST_TOKEN, startBenchApp, type RunningBenchApp } from "../src/eval/bench/verify/app.js";
import type { Answer, PlatformClient } from "../src/eval/client.js";
import { DB_SEEDS } from "./fixtures/db-seeds.js";

let running: RunningBenchApp | undefined;
afterEach(async () => {
    await running?.stop();
    running = undefined;
});
const freePort = () =>
    new Promise<number>((resolve) => {
        const s = net.createServer().listen(0, "127.0.0.1", () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });

describe("the stored-data seeds through the bench data routes", () => {
    for (const s of DB_SEEDS) {
        it(`${s.seed}: red with the seed alone, red with every seed on, green on the clean app`, async () => {
            const red = async (defects: string) => {
                running = await startBenchApp(s.app, await freePort(), defects);
                try {
                    return await s.red(running.base, benchDataProbe({ url: running.base, token: BENCH_DATA_TEST_TOKEN }));
                } finally {
                    await running.stop();
                    running = undefined;
                }
            };
            expect(await red(s.seed)).toBe(true);
            expect(await red("all")).toBe(true);
            expect(await red("none")).toBe(false);
        });
    }
});

describe("access", () => {
    it("reads loopback apps only, and only with a token", () => {
        expect(() => benchDataProbe({ url: "http://example.com:80", token: "t" })).toThrow(/loopback/);
        expect(() => benchDataProbe({ url: "http://10.0.0.1:5291", token: "t" })).toThrow(/loopback/);
        expect(() => benchDataProbe({ url: "http://127.0.0.1:5291", token: "" })).toThrow(/token/);
    });

    it("a wrong token is refused by the app (403), and the refusal names neither token", async () => {
        running = await startBenchApp("bench-shop", await freePort(), "none");
        const wrong = "wrong-token-0123456789";
        const err = await benchDataProbe({ url: running.base, token: wrong }).schema().then(() => undefined, (e: Error) => e);
        expect(err?.message).toMatch(/HTTP 403/);
        expect(err?.message).not.toContain(wrong);
        expect(err?.message).not.toContain(BENCH_DATA_TEST_TOKEN);
    });

    it("the schema has names and counts only; a name outside it is refused before any data is read", async () => {
        running = await startBenchApp("bench-shop", await freePort(), "none");
        const probe = benchDataProbe({ url: running.base, token: BENCH_DATA_TEST_TOKEN });
        const schema = await probe.schema();
        expect(schema.tables.map((t) => t.name)).toContain("cart_items");
        expect(JSON.stringify(schema)).not.toMatch(/alice|Password/i);
        await expect(probe.check({ kind: "count", table: "sessions", where: [] })).rejects.toThrow(/no table "sessions"/);
        await expect(probe.check({ kind: "count", table: "users", where: ["password"] }, { password: "Password1!" })).rejects.toThrow(/no column "password"/);
    });
});

// The harness on a scripted platform with the real bench shop: what the engine is handed, and how the seeds are scored.
const SHOP: BenchApp = { id: "bench-shop", script: "examples/bench-shop/server.mjs", workflows: [{ name: "Checkout", paths: ["/checkout"] }] };
const CATALOGUE: Catalogue = {
    version: "test-db",
    sha256: "0".repeat(64),
    defects: [{ id: "BS-18", app: "bench-shop", workflow: "Checkout", category: "referential-integrity", severity: "high", storedDataOnly: true }],
};
const CONFIG = { apps: [{ id: "bench-shop", version: "v1" }] } as unknown as BenchConfig;

const ROUTE_CHECK = "route-check";
/** A platform that explores nothing; each replay run asks the engine's probe for the app (as the engine's database layer will). */
function platform(appUrl: string, sent: string[], probeCounts: number[], routeStatus: number[]) {
    const tests = [{ id: "t1", testId: "API-001", title: "Placing an order leaves no item rows", type: "api", validationStatus: "NEEDS_REVIEW", validationReason: "Database check failed" }];
    let runs = 0;
    const client: PlatformClient = {
        mode: "in-process",
        upload: async () => ({ status: 404, body: {} }),
        call: async (method, url, body): Promise<Answer> => {
            sent.push(`${method} ${url} ${JSON.stringify(body ?? null)}`);
            if (method === "POST" && url === "/api/projects") return { status: 201, body: { id: "p1" } };
            if (method === "PUT") return { status: 200, body: {} };
            if (method === "POST" && url === "/api/projects/p1/test-generation") return { status: 202, body: { jobId: "plan1" } };
            if (method === "POST" && url === "/api/projects/p1/plans/plan1/create") return { status: 202, body: { jobId: "c1" } };
            if (method === "GET" && url === "/api/projects/p1/plans/plan1") return { status: 200, body: { total: 1, found: { pages: 1 }, pages: [{ path: "/checkout" }] } };
            if (method === "GET" && url === "/api/projects/p1/tests") return { status: 200, body: tests };
            if (method === "GET" && url === "/api/tests/t1") return { status: 200, body: { spec: { steps: [{ action: "navigate", url: "/checkout" }] }, attempts: 1, generationMeta: null } };
            if (method === "GET" && url === "/api/tests/t1/executions") return { status: 200, body: [] };
            if (method === "POST" && url === "/api/projects/p1/runs") {
                // Whether the app's data routes are on at all: a wrong token is 403 when they are, 404 when they are off (Phase 3).
                routeStatus.push((await fetch(`${appUrl}/__bench/data`, { headers: { "x-bench-data": ROUTE_CHECK } })).status);
                const probe = benchProbeFor(appUrl);
                if (probe) probeCounts.push((await probe.check({ kind: "count", table: "cart_items", where: [] })).count);
                return { status: 202, body: { jobId: `r${++runs}` } };
            }
            if (method === "GET" && /^\/api\/projects\/p1\/runs\/\w+$/.test(url)) return { status: 200, body: { tests: [{ id: "t1", state: "passed" }] } };
            if (method === "GET" && /^\/api\/test-generation\/[^/]+$/.test(url)) return { status: 200, body: { status: "COMPLETED" } };
            if (method === "GET" && /\/events$/.test(url)) return { status: 200, body: [] };
            if (method === "GET" && /^\/api\/jobs\/[^/]+\/usage$/.test(url)) return { status: 200, body: { totals: { calls: 0, inputTokens: 0, outputTokens: 0 } } };
            return { status: 404, body: { error: "not here" } };
        },
    };
    return client;
}

async function trial(database: BenchOptions["database"]) {
    const port = await freePort();
    const appUrl = `http://127.0.0.1:${port}`;
    const sent: string[] = [];
    const logs: string[] = [];
    const probeCounts: number[] = [];
    const routeStatus: number[] = [];
    // Every data-route token the probe sends, read off the requests to the app.
    const tokens = new Set<string>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const t = new Headers(init?.headers).get("x-bench-data");
        if (t && t !== ROUTE_CHECK) tokens.add(t);
        return realFetch(input, init);
    }) as typeof fetch;
    try {
        const out = await runBenchmark(platform(appUrl, sent, probeCounts, routeStatus), { apps: [{ app: SHOP, port }], catalogue: CATALOGUE, mode: "discovery", exploration: {}, repeat: 1, model: "scripted", config: CONFIG, baseline: false, pollMs: 20, log: (l) => logs.push(l), ...(database ? { database } : {}) });
        return { out, sent, logs, probeCounts, routeStatus, tokens, appUrl };
    } finally {
        globalThis.fetch = realFetch;
    }
}

describe("the harness with a database back end", () => {
    it("hands the engine a probe, never the token; the stored-data seed counts as reachable", async () => {
        const t = await trial({ kind: "bench-data" });
        expect(t.out.benchmark.apps[0]!.status, t.logs.join("\n")).toBe("done");
        expect(t.probeCounts.length).toBeGreaterThan(0);
        expect(new Set(t.routeStatus)).toEqual(new Set([403]));
        expect(t.tokens.size).toBe(1);
        const token = [...t.tokens][0]!;
        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(t.sent.join("\n")).not.toContain(token);
        expect(t.logs.join("\n")).not.toContain(token);
        expect(JSON.stringify(t.out)).not.toContain(token);
        expect(t.out.benchmark.apps[0]!.defects.find((d) => d.id === "BS-18")?.unreachable).toBeUndefined();
        expect(t.out.benchmark.apps[0]!.metrics.reachable).toBe(1);
        // The probe is forgotten when the app stops.
        expect(benchProbeFor(t.appUrl)).toBeUndefined();
    });

    it("each trial gets its own token", async () => {
        const a = await trial({ kind: "bench-data" });
        const b = await trial({ kind: "bench-data" });
        expect([...a.tokens][0]).not.toBe([...b.tokens][0]);
    });

    it("without one the trial is as in Phase 3: no probe, no data routes, the seed unreachable", async () => {
        const t = await trial(undefined);
        expect(t.probeCounts).toEqual([]);
        expect(t.tokens.size).toBe(0);
        expect(t.routeStatus.length).toBeGreaterThan(0);
        expect(new Set(t.routeStatus)).toEqual(new Set([404]));
        expect(t.out.benchmark.apps[0]!.defects.find((d) => d.id === "BS-18")?.unreachable).toBe(true);
        expect(t.out.benchmark.apps[0]!.metrics.reachable).toBe(0);
    });

    it("the rescore rule: stored-data-only seeds are unreachable unless the trial recorded a database back end", () => {
        expect(isUnreachable({ storedDataOnly: true }, false)).toBe(true);
        expect(isUnreachable({ storedDataOnly: true }, true)).toBe(false);
        expect(isUnreachable({ unreachable: "no route" }, true)).toBe(true);
        expect(isUnreachable({}, false)).toBe(false);
    });
});
