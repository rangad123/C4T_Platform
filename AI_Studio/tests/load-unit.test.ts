/**
 * Basic load check, browser-free: the helper's caps and kill-switches on a virtual clock (no waiting, deterministic), the
 * spec generator, the generated script, classification, severity, CLI category, production skip and the rule that automated
 * starters (schedules, deploy triggers) never run it. The real end-to-end run is tests/load.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { skipReason } from "../src/engine/environments/run.js";
import { renderScript } from "../src/engine/generators/index.js";
import {
    generateLoadSpecs,
    isLoadSpec,
    LOAD_FAILURE_PREFIX,
    LOAD_HELPER_SOURCE,
    LOAD_MAX_ENDPOINTS,
    LOAD_MAX_REQUESTS,
    LOAD_MAX_USERS,
    LOAD_PRODUCTION_SKIP_REASON,
    loadFinding,
    loadLoadRuntime,
    normalizeLoadBudgets,
    parseLoadReason,
    type LoadEnv,
} from "../src/engine/performance/load.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { assessSeverity } from "../src/engine/validation/severity.js";
import { deterministicFinding } from "../src/engine/validation/validator.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { categorize, type CiTest } from "../src/cli/model.js";
import { renderSarif } from "../src/cli/render.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { runnableTestIds, startScheduledJob } from "../src/platform/scheduler.js";
import { buildServer } from "../src/platform/server.js";
import type { Schedule } from "../src/platform/schedule-store.js";

const rt = loadLoadRuntime();

/** A virtual clock: sleeping and "network time" advance a counter, so ten simulated seconds take milliseconds. */
function virtualClock() {
    let t = 0;
    const timers: Array<{ at: number; resolve: () => void }> = [];
    const env: LoadEnv = { now: () => t, sleep: (ms) => new Promise<void>((resolve) => timers.push({ at: t + Math.max(0, ms), resolve })) };
    async function drive<T>(p: Promise<T>): Promise<T> {
        let state: { ok: true; v: T } | { ok: false; e: unknown } | undefined;
        p.then((v) => (state = { ok: true, v }), (e) => (state = { ok: false, e }));
        for (let guard = 0; !state; guard++) {
            if (guard > 200_000) throw new Error("virtual clock did not settle");
            await new Promise((r) => setImmediate(r)); // let every pending promise continuation run
            if (state) break;
            const next = timers.sort((a, b) => a.at - b.at).shift();
            if (next) {
                t = Math.max(t, next.at);
                next.resolve();
            }
        }
        if (!state.ok) throw state.e;
        return state.v;
    }
    return { env, drive, now: () => t };
}

interface Probe {
    calls: number;
    inFlight: number;
    peak: number;
    afterRateLimit: number;
}

/** A send() with a latency and a status chosen per call, that records how many requests were started and how many ran at once. */
function endpoint(env: LoadEnv, behave: (n: number, inFlight: number) => { ms: number; status?: number; fail?: boolean }) {
    const probe: Probe = { calls: 0, inFlight: 0, peak: 0, afterRateLimit: 0 };
    let limited = false;
    const send = async () => {
        if (limited) probe.afterRateLimit++;
        const n = ++probe.calls;
        probe.inFlight++;
        probe.peak = Math.max(probe.peak, probe.inFlight);
        const b = behave(n, probe.inFlight);
        await env.sleep(b.ms);
        probe.inFlight--;
        if (b.fail) throw new Error("connection reset");
        if (b.status === 429) limited = true;
        return { status: b.status ?? 200 };
    };
    return { send, probe };
}

async function run(send: () => Promise<{ status: number }>, env: ReturnType<typeof virtualClock>, spec = "", probeStatus: number | undefined = 200, lockKey?: string) {
    const attached: Array<{ name: string; body: string }> = [];
    let error: string | undefined;
    try {
        await env.drive(rt.loadAssert(send, spec, (name, body) => void attached.push({ name, body }), probeStatus, { env: env.env, ...(lockKey ? { lockKey } : {}) }));
    } catch (e) {
        error = (e as Error).message;
    }
    const metrics = attached.find((a) => a.name === "metrics") ? (JSON.parse(attached.find((a) => a.name === "metrics")!.body) as Array<{ metric: string; value: number; unit: string; budget?: number }>) : undefined;
    const notes = attached.filter((a) => a.name === "notes").flatMap((a) => JSON.parse(a.body) as string[]);
    return { error, metrics, notes };
}

describe("the limits are constants of the helper, and a spec can only lower them", () => {
    it("has the documented caps", () => {
        expect(LOAD_MAX_USERS).toBe(10);
        expect(LOAD_MAX_REQUESTS).toBe(300);
        expect(LOAD_MAX_ENDPOINTS).toBe(3);
        expect(LOAD_HELPER_SOURCE).toContain("const LOAD_MAX_USERS = 10;");
        expect(LOAD_HELPER_SOURCE).toContain("const LOAD_MAX_REQUESTS = 300;");
        expect(LOAD_HELPER_SOURCE).toContain("const LOAD_MAX_SECONDS = 10;");
    });

    it("parses overrides and clamps every number to the caps (looksLikeAttack: nothing above them is reachable)", () => {
        expect(rt.loadParse("")).toEqual({ p95: 1000, errors: 1, users: 10, seconds: 10, requests: 300 });
        expect(rt.loadParse("p95:500 errors:2 users:5 seconds:4 requests:100")).toEqual({ p95: 500, errors: 2, users: 5, seconds: 4, requests: 100 });
        // far above the caps
        expect(rt.loadParse("users:1000 seconds:3600 requests:999999 p95:99999999999")).toMatchObject({ users: 10, seconds: 10, requests: 300, p95: 600000 });
        // below the floor, garbage, exponent, negative, infinity: never above the cap, never NaN
        expect(rt.loadParse("users:0 seconds:0 requests:0")).toMatchObject({ users: 2, seconds: 2, requests: 10 });
        for (const bad of ["users:1.2.3", "users:abc", "users:-5", "users:Infinity", "users:1e9", "requests:1e9", "seconds:1e9", "users:", "users=10;;requests=300"]) {
            const b = rt.loadParse(bad);
            expect(b.users, bad).toBeLessThanOrEqual(10);
            expect(b.requests, bad).toBeLessThanOrEqual(300);
            expect(b.seconds, bad).toBeLessThanOrEqual(10);
            for (const v of Object.values(b)) expect(Number.isFinite(v), bad).toBe(true);
        }
        expect(rt.loadParse(undefined)).toEqual(rt.loadParse(""));
    });

    it("writes the clamped numbers into what the generator keeps", () => {
        expect(normalizeLoadBudgets("users:9999 requests:123456 seconds:99")).toBe("p95:1000 errors:1 users:10 seconds:10 requests:300");
        expect(normalizeLoadBudgets("users:3 p95:400")).toBe("p95:400 errors:1 users:3 seconds:10 requests:300");
        expect(normalizeLoadBudgets(42)).toBe("p95:1000 errors:1 users:10 seconds:10 requests:300");
    });
});

describe("a run on a virtual clock", () => {
    it("spreads at most 10 users over the whole window, never exceeds the request cap and never has more than 10 requests in flight", async () => {
        const clock = virtualClock();
        const { send, probe } = endpoint(clock.env, () => ({ ms: 20 }));
        const st = await clock.drive(rt.loadStage(send, 10, 200, 10, clock.env));
        expect(probe.calls).toBe(st.done);
        expect(probe.calls).toBeLessThanOrEqual(200);
        expect(probe.calls).toBeGreaterThan(100); // a real amount of traffic, not a token request
        expect(probe.peak).toBeLessThanOrEqual(10);
        expect(st.users).toBe(10);
        expect(st.elapsed).toBeGreaterThanOrEqual(9000); // it holds for the window; the request cap is not used up in the first second
        expect(st.elapsed).toBeLessThanOrEqual(10_500);
    });

    it("stops exactly at the request cap even when the endpoint answers instantly", async () => {
        const clock = virtualClock();
        const { send, probe } = endpoint(clock.env, () => ({ ms: 0 }));
        // A tiny cap with a long window forces the cap (not the clock) to end the run.
        await clock.drive(rt.loadStage(send, 10, 25, 10, clock.env));
        expect(probe.calls).toBe(25);
    });

    it("passes a fast, healthy endpoint with one run, records twelve values and keeps all requests within the total budget", async () => {
        const clock = virtualClock();
        const { send, probe } = endpoint(clock.env, () => ({ ms: 40 }));
        const out = await run(send, clock);
        expect(out.error).toBeUndefined();
        expect(out.notes).toEqual([]);
        expect(probe.calls).toBeLessThanOrEqual(200); // no confirmation run when nothing is wrong
        expect(out.metrics!.map((m) => m.metric)).toEqual(["load_users", "load_requests", "load_rps", "load_error_rate", "load_p50", "load_p95", "load_max", "load_ok", "load_4xx", "load_5xx", "load_429", "load_network"]);
        const by = Object.fromEntries(out.metrics!.map((m) => [m.metric, m]));
        expect(by.load_users!.value).toBe(10);
        expect(by.load_requests!.value).toBe(probe.calls);
        expect(by.load_p95!.budget).toBe(1000);
        expect(by.load_error_rate!.budget).toBe(1);
        expect(by.load_p95!.value).toBe(40);
        expect(by.load_rps!.unit).toBe("req/s");
        expect(by.load_ok!.value).toBe(probe.calls);
    });

    it("never sends more than 299 requests in total (the test's own request is the 300th), even when everything is slow and the confirmation run happens", async () => {
        const clock = virtualClock();
        const { send, probe } = endpoint(clock.env, () => ({ ms: 2500 }));
        const out = await run(send, clock);
        expect(probe.calls).toBeLessThanOrEqual(299);
        expect(probe.peak).toBeLessThanOrEqual(10);
        expect(out.error).toContain(`${LOAD_FAILURE_PREFIX} the endpoint struggled at 5 users at once`); // also over budget at half the users
        expect(out.error).toContain("(also over budget)");
        // A lower request budget lowers the total too.
        const clock2 = virtualClock();
        const small = endpoint(clock2.env, () => ({ ms: 2500 }));
        await run(small.send, clock2, "requests:40 users:4");
        expect(small.probe.calls).toBeLessThanOrEqual(39);
        expect(small.probe.peak).toBeLessThanOrEqual(4);
    });

    it("clamps what a spec asks for: users:500 requests:9999 stays within 10 users and 299 requests", async () => {
        const clock = virtualClock();
        const { send, probe } = endpoint(clock.env, () => ({ ms: 3000 }));
        await run(send, clock, "users:500 requests:9999 seconds:600");
        expect(probe.peak).toBeLessThanOrEqual(10);
        expect(probe.calls).toBeLessThanOrEqual(299);
    });

    it("re-runs once at half the users before reporting; when the endpoint copes at half, the finding says so", async () => {
        const clock = virtualClock();
        // Contended: every request in flight at the same moment adds 80 ms to each answer. 10 users ~800 ms, 5 users ~400 ms.
        const { send, probe } = endpoint(clock.env, (_n, inFlight) => ({ ms: 80 * inFlight }));
        const out = await run(send, clock, "p95:600");
        expect(out.error).toMatch(new RegExp(`^${LOAD_FAILURE_PREFIX} the endpoint struggled at 10 users at once \\(it coped with 5\\)`));
        expect(out.error).toMatch(/- \[medium\] 95% of responses arrive within [\d.]+ (ms|s) \(budget 600 ms\)/);
        expect(out.error).toMatch(/- Confirmation at 5 users: .*\(within budget\)/);
        expect(out.error).not.toContain("also over budget");
        expect(probe.calls).toBeGreaterThan(200); // the confirmation run really happened
        expect(probe.calls).toBeLessThanOrEqual(299);
        expect(parseLoadReason(out.error!)).toBe("medium");
        // The metrics describe the main run (10 users), not the confirmation.
        expect(out.metrics!.find((m) => m.metric === "load_users")!.value).toBe(10);
    });

    it("does not rerun, and does not report, a run within budget", async () => {
        const clock = virtualClock();
        const { send, probe } = endpoint(clock.env, () => ({ ms: 300 }));
        const out = await run(send, clock, "p95:600");
        expect(out.error).toBeUndefined();
        expect(probe.calls).toBeLessThanOrEqual(200);
    });

    it("stops at once when more than 20% of the answers are server errors, re-runs once at half the users, and reports it as a finding", async () => {
        const clock = virtualClock();
        const { send, probe } = endpoint(clock.env, (n) => ({ ms: 30, status: n % 2 === 0 ? 500 : 200 }));
        const first = await clock.drive(rt.loadStage(send, 10, 200, 10, clock.env));
        expect(first.stop).toBe("errors");
        expect(first.done).toBeLessThanOrEqual(5 + 10); // at the sample floor plus what was already in flight; no new request after the stop
        expect(probe.calls).toBe(first.done);

        const clock2 = virtualClock();
        const flaky = endpoint(clock2.env, (n) => ({ ms: 30, status: n % 2 === 0 ? 500 : 200 }));
        const out = await run(flaky.send, clock2);
        expect(out.error).toContain(`${LOAD_FAILURE_PREFIX} the endpoint struggled at 5 users at once`);
        expect(out.error).toContain("- [medium] Stopped to protect the application: more than 20% of the requests failed");
        expect(flaky.probe.calls).toBeLessThan(60);
        expect(out.metrics!.find((m) => m.metric === "load_5xx")!.value).toBeGreaterThan(0);
    });

    it("counts network failures as errors", async () => {
        const clock = virtualClock();
        const { send } = endpoint(clock.env, () => ({ ms: 10, fail: true }));
        const out = await run(send, clock);
        expect(out.error).toContain("Stopped to protect the application");
        expect(out.metrics!.find((m) => m.metric === "load_network")!.value).toBeGreaterThan(0);
        expect(out.metrics!.find((m) => m.metric === "load_ok")!.value).toBe(0);
    });

    it("stops at the first HTTP 429, never retries, never sends another request, and is a pass with a note (not a finding)", async () => {
        const clock = virtualClock();
        const { send, probe } = endpoint(clock.env, (n) => ({ ms: 20, status: n >= 21 ? 429 : 200 }));
        const out = await run(send, clock);
        expect(out.error).toBeUndefined();
        expect(out.notes).toHaveLength(1);
        expect(out.notes[0]).toContain("limits how often it can be called (HTTP 429)");
        expect(out.notes[0]).toContain("stopped");
        expect(probe.afterRateLimit).toBe(0); // no request STARTED after the 429 came back
        expect(probe.calls).toBeLessThanOrEqual(21 + 10);
        expect(out.metrics!.find((m) => m.metric === "load_429")!.value).toBeGreaterThanOrEqual(1);
    });

    it("does not put an endpoint under load when the test's own request was not a success", async () => {
        for (const status of [401, 403, 404, 500, 503]) {
            const clock = virtualClock();
            const { send, probe } = endpoint(clock.env, () => ({ ms: 10 }));
            const out = await run(send, clock, "", status);
            expect(out.error, String(status)).toBeUndefined();
            expect(probe.calls).toBe(0);
            expect(out.notes[0]).toContain(`HTTP ${status}`);
        }
    });

    it("ignores a single stray error, but flags a mild error rate as low severity (after the half-load re-run)", async () => {
        const clock = virtualClock();
        const stray = endpoint(clock.env, (n) => ({ ms: 20, status: n === 40 ? 500 : 200 }));
        expect((await run(stray.send, clock)).error).toBeUndefined();

        // 2.5% of the answers fail in BOTH runs: over the 1% budget, under the 5% "mild" line, never near the 20% kill-switch.
        const clock2 = virtualClock();
        const mild = endpoint(clock2.env, (n) => ({ ms: 20, status: n % 40 === 0 ? 500 : 200 }));
        const out = await run(mild.send, clock2);
        expect(out.error).toMatch(/- \[low\] [\d.]+% of requests failed \(budget 1%\): \d+ server errors?, 0 network failures/);
        expect(parseLoadReason(out.error!)).toBe("low");
    });
});

describe("only one load check at a time per application address", () => {
    const lockDir = (key: string) => path.join(os.tmpdir(), "ai-testing-load-" + key.replace(/[^a-z0-9]+/gi, "_"));

    it("makes a second check wait its turn, so the application never sees two groups of users at once", async () => {
        const key = `unit-${process.pid}-${Date.now()}`;
        const clock = virtualClock();
        let inFlight = 0;
        let peak = 0;
        const send = async () => {
            peak = Math.max(peak, ++inFlight);
            await clock.env.sleep(2500); // slow enough that the two checks would overlap if they could
            inFlight--;
            return { status: 200 };
        };
        const one = () => rt.loadAssert(send, "users:4 seconds:2 requests:40", undefined, 200, { env: clock.env, lockKey: key }).catch(() => undefined);
        await clock.drive(Promise.all([one(), one()]));
        expect(peak).toBeLessThanOrEqual(4); // side by side it would be 8
        expect(fs.existsSync(lockDir(key))).toBe(false); // the lock is released afterwards
    });

    it("ignores a lock left behind by a crashed run", async () => {
        const key = `stale-${process.pid}-${Date.now()}`;
        fs.mkdirSync(lockDir(key));
        const old = new Date(Date.now() - 5 * 60_000);
        fs.utimesSync(lockDir(key), old, old);
        const clock = virtualClock();
        const { send, probe } = endpoint(clock.env, () => ({ ms: 10 }));
        const out = await run(send, clock, "users:2 seconds:2 requests:20", 200, key);
        expect(out.error).toBeUndefined();
        expect(probe.calls).toBeGreaterThan(0);
        expect(fs.existsSync(lockDir(key))).toBe(false);
    });

    it("gives up (with a plain message, not a finding) when another check holds the address for two minutes", async () => {
        const key = `busy-${process.pid}-${Date.now()}`;
        fs.mkdirSync(lockDir(key));
        try {
            const clock = virtualClock();
            const { send, probe } = endpoint(clock.env, () => ({ ms: 10 }));
            const out = await run(send, clock, "", 200, key);
            expect(out.error).toContain("Load check could not run: another load check kept the application busy");
            expect(out.error).not.toContain(LOAD_FAILURE_PREFIX);
            expect(probe.calls).toBe(0);
        } finally {
            fs.rmSync(lockDir(key), { recursive: true, force: true });
        }
    });
});

describe("generation", () => {
    const op = (summary: string, extra: Record<string, unknown> = {}) => ({ get: { summary, ...extra, responses: { "200": { description: "ok" } } } });
    const doc = {
        openapi: "3.0.0",
        info: { title: "t", version: "1" },
        paths: {
            "/login": op("log in"),
            "/api/sign-up": op("sign up"),
            "/api/checkout": op("checkout"),
            "/api/payments": op("payments"),
            "/api/orders": op("orders"),
            "/api/logout": op("logout"),
            "/api/token": op("token"),
            "/api/secure": op("secure", { security: [{ bearer: [] }] }),
            "/items/{id}": { get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }], responses: { "200": { description: "ok" } } } },
            "/post-only": { post: { responses: { "200": { description: "ok" } } } },
            "/gone": { get: { responses: { "404": { description: "gone" } } } },
            "/a": op("a"),
            "/b": op("b"),
            "/c": op("c"),
            "/d": op("d"),
        },
    };
    const endpoints = parseOpenApi(doc, "http://x/openapi.json").operations;

    it("picks at most 3 safe GET endpoints: never sign-in, sign-up, payment, orders, logout, token, data-changing or uncallable ones", () => {
        const specs = generateLoadSpecs(endpoints, {});
        expect(specs.map((s) => s.title)).toEqual(["GET /a: handles 10 users at once", "GET /b: handles 10 users at once", "GET /c: handles 10 users at once"]);
        // A bigger ask never gets more than 3, and nothing risky is reachable even when the cap is raised.
        const raised = generateLoadSpecs(endpoints, { maxEndpoints: 500 });
        expect(raised).toHaveLength(3);
        const everything = generateLoadSpecs(endpoints.filter((e) => /^\/(login|api\/(sign-up|checkout|payments|orders|logout|token|secure)|post-only|gone|items)/.test(e.path)), { maxEndpoints: 500 });
        expect(everything.map((s) => s.title)).toEqual([]);
    });

    it("includes an endpoint that needs sign-in only when an API credential is configured", () => {
        const secure = endpoints.filter((e) => e.path === "/api/secure");
        expect(secure[0]!.requiresAuth).toBe(true);
        expect(generateLoadSpecs(secure, {})).toHaveLength(0);
        expect(generateLoadSpecs(secure, { hasCredential: true }).map((s) => s.title)).toEqual(["GET /api/secure: handles 10 users at once"]);
    });

    it("builds a GET request step followed by a load check, with every number clamped, never anything else", () => {
        const [a] = generateLoadSpecs(endpoints, { budgets: "users:9999 requests:99999 seconds:999 p95:400" });
        expect(a).toMatchObject({ kind: "api", type: "performance", category: "Performance", source: { origin: "performance-check" } });
        expect(a!.steps[0]).toMatchObject({ action: "request", method: "GET", path: "/a", auth: "default" });
        expect(a!.steps[1]).toMatchObject({ action: "assertResponse", check: "load", expected: "p95:400 errors:1 users:10 seconds:10 requests:300" });
        expect(a!.steps[1]!.description).toContain("10 users at once (95% within 400 ms)");
        expect(a!.tags).toContain("load");
        expect(isLoadSpec(TestSpecSchema.parse({ ...a, testId: "API-001" }))).toBe(true);
        for (const s of generateLoadSpecs(endpoints, {})) expect(s.steps.filter((st) => st.action === "request").every((st) => st.action === "request" && st.method === "GET")).toBe(true);
    });
});

describe("the generated script", () => {
    const spec = (over: Record<string, unknown> = {}, steps?: unknown[]) =>
        TestSpecSchema.parse({
            testId: "API-007",
            title: "GET /a: handles 10 users at once",
            kind: "api",
            type: "performance",
            source: { origin: "performance-check" },
            steps: steps ?? [{ action: "request", method: "GET", path: "/a", query: { limit: "1" }, auth: "default" }, { action: "assertResponse", check: "load", expected: "users:9999 requests:123456 seconds:999 p95:700" }],
            ...over,
        });
    const render = (s: TestSpec) => renderScript(s, "playwright-api", { baseUrl: "http://app.test" }).content;

    it("carries the helper and the GET-only sender, with the caps as constants and the spec's numbers already clamped", () => {
        const script = render(spec());
        expect(script).toContain("async function loadAssert");
        expect(script).toContain("async function loadCall");
        expect(script).toContain("const LOAD_MAX_USERS = 10;");
        expect(script).toContain("const LOAD_MAX_REQUESTS = 300;");
        expect(script).toContain('"p95:700 errors:1 users:10 seconds:10 requests:300"'); // not users:9999
        expect(script).not.toContain("9999");
        expect(script).toContain('loadCall(request, "/a", { query: { "limit": "1" }');
        expect(script).toContain('method: "GET"');
        expect(script).toContain("lockKey: new URL(API_BASE_URL).host");
        expect(script).toContain("test.setTimeout(180_000);");
        // the sender has no method parameter at all
        expect(script).toMatch(/async function loadCall\(request: APIRequestContext, path: string, opts:/);
        expect(script).not.toMatch(/sk-|password|secret/i);
    });

    it("is not generated for anything but a GET, more than one load step, or a data-driven test", () => {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
            const s = spec({}, [{ action: "request", method, path: "/a", auth: "default" }, { action: "assertResponse", check: "load" }]);
            expect(() => render(s), method).toThrow(/needs a GET request step/);
        }
        expect(() => render(spec({}, [{ action: "assertResponse", check: "load" }]))).toThrow(/needs a GET request step/);
        const twice = spec({}, [{ action: "request", method: "GET", path: "/a" }, { action: "assertResponse", check: "load" }, { action: "request", method: "GET", path: "/b" }, { action: "assertResponse", check: "load" }]);
        expect(() => render(twice)).toThrow(/only one load check/);
        const data = spec({ testData: { dataSet: "rows" } });
        expect(() => renderScript(data, "playwright-api", { baseUrl: "http://app.test", dataSets: { rows: { columns: ["x"], rows: [{ x: "1" }] } } })).toThrow(/cannot be data-driven/);
    });

    it("leaves the other API scripts untouched (no load helper, no longer timeout)", () => {
        const plain = render(spec({ title: "plain" }, [{ action: "request", method: "GET", path: "/a" }, { action: "assertResponse", check: "status", expected: "200" }]));
        expect(plain).not.toContain("loadAssert");
        expect(plain).not.toContain("setTimeout(180_000)");
    });
});

describe("classification, severity, CLI", () => {
    const loadSpec = TestSpecSchema.parse({
        testId: "API-008",
        title: "GET /a: handles 10 users at once",
        kind: "api",
        type: "performance",
        source: { origin: "performance-check" },
        steps: [{ action: "request", method: "GET", path: "/a", auth: "default" }, { action: "assertResponse", check: "load", expected: "p95:600" }],
    });
    const message = `${LOAD_FAILURE_PREFIX} the endpoint struggled at 10 users at once (it coped with 5)\n- [medium] 95% of responses arrive within 1.4 s (budget 600 ms); typically 900 ms, slowest 2.0 s\n- Run at 10 users: 150 requests at 10 users, 95% within 1.4 s, 0.0% failed\n- Confirmation at 5 users: 90 requests at 5 users, 95% within 300 ms, 0.0% failed (within budget)`;
    const failedRun = (over: Partial<ScriptRun> = {}): ScriptRun => ({
        testId: "API-008",
        status: "failed",
        durationMs: 25_000,
        failedStepIndex: 1,
        steps: [{ index: 0, title: "1. Send GET /a", status: "passed" }, { index: 1, title: "2. Stays fast", status: "failed", error: message }],
        artifacts: [],
        responses: [],
        ...over,
    });

    it("turns the check's own failure into a finding with how to fix it, and nothing else", () => {
        const f = loadFinding(loadSpec, failedRun())!;
        expect(f.startsWith(LOAD_FAILURE_PREFIX)).toBe(true);
        expect(f).toContain("How to fix:");
        expect(f).toContain("- Confirmation at 5 users");
        expect(deterministicFinding(loadSpec, failedRun())).toBe(f); // wired into the shared validator, ahead of repair
        expect(loadFinding(loadSpec, failedRun({ status: "passed" }))).toBeUndefined();
        // A different failure of the same test (e.g. the request step itself) is not a load finding.
        expect(loadFinding(loadSpec, failedRun({ steps: [{ index: 0, title: "1. Send GET /a", status: "failed", error: "connect ECONNREFUSED" }], failedStepIndex: 0 }))).toBeUndefined();
    });

    it("scores per-line severity: medium for a budget breach or a struggle, low for a mild error rate", () => {
        expect(assessSeverity(loadSpec, "NEEDS_REVIEW", loadFinding(loadSpec, failedRun())!)).toEqual({ severity: "medium", basis: "API endpoint struggles under load" });
        const mild = `${LOAD_FAILURE_PREFIX} the endpoint struggled at 10 users at once (it coped with 5)\n- [low] 2.5% of requests failed (budget 1%): 4 server errors, 0 network failures`;
        expect(parseLoadReason(mild)).toBe("low");
        expect(parseLoadReason("Server error: GET /a returned 500")).toBeUndefined();
    });

    it("is a 'load' category for the CLI with its own SARIF rule", () => {
        expect(categorize(message)).toBe("load");
        const t = { id: "1", testId: "API-008", title: "GET /a: handles 10 users at once", suite: "Performance", kind: "api", type: "performance", priority: "low", outcome: "finding", validation: "NEEDS_REVIEW", severity: "medium", reason: message, category: "load", durationMs: 1, attempts: 1 } as CiTest;
        const sarif = JSON.parse(
            renderSarif({ schemaVersion: 1, tool: { name: "ai-test", version: "0" }, generatedAt: "2026-01-01T00:00:00.000Z", mode: "replay", target: "http://app.test", project: { name: "p" }, durationMs: 1, summary: { total: 1, passed: 0, findings: 1, failedValidation: 0, notRun: 0, bySeverity: { critical: 0, high: 0, medium: 1, low: 0 } }, gate: { failOn: "high", failOnFailedValidation: true, passed: true, reasons: [], exitCode: 0 }, tests: [t] } as never, { fingerprint: (s) => `fp:${s.length}` }),
        );
        expect(sarif.runs[0].tool.driver.rules.map((r: { id: string; name: string }) => [r.id, r.name])).toEqual([["ai-testing/load", "LoadCapacity"]]);
        expect(sarif.runs[0].results).toHaveLength(1);
    });
});

describe("production and automated starters", () => {
    it("skips a load test on production with the plain reason, and not elsewhere", () => {
        const s = TestSpecSchema.parse({ testId: "API-009", title: "load", kind: "api", source: { origin: "performance-check" }, steps: [{ action: "request", method: "GET", path: "/a" }, { action: "assertResponse", check: "load" }] });
        expect(skipReason(s, { production: true })).toBe(LOAD_PRODUCTION_SKIP_REASON);
        expect(LOAD_PRODUCTION_SKIP_REASON).toContain("load checks don't run on production");
        expect(skipReason(s, { production: false })).toBeUndefined();
        const plain = TestSpecSchema.parse({ testId: "API-010", title: "plain", kind: "api", steps: [{ action: "request", method: "GET", path: "/a" }] });
        expect(skipReason(plain, { production: true })).toBeUndefined();
    });
});

describe("schedules and deploy triggers never start a load check", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-loadunit-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" })); // no worker: jobs are created, never run
        server = await buildServer(platform);
    }, 30_000);
    afterAll(async () => {
        await server?.close();
        platform?.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };

    it("leaves load tests out of scheduled re-runs, and turns the option off in a scheduled re-analysis", async () => {
        const project = (await call("POST", "/api/projects", { name: "Load schedules" })).body.id as string;
        const specs = [
            { title: "GET /a: handles 10 users at once", kind: "api", category: "Performance", type: "performance", source: { origin: "performance-check" }, steps: [{ action: "request", method: "GET", path: "/a", auth: "default" }, { action: "assertResponse", check: "load" }] },
            { title: "GET /a: answers", kind: "api", steps: [{ action: "request", method: "GET", path: "/a" }, { action: "assertResponse", check: "status", expected: "200" }] },
        ];
        const imported = await call("POST", `/api/projects/${project}/specs`, { specs, baseUrl: "http://127.0.0.1:5559", validate: false });
        expect(imported.status, JSON.stringify(imported.body)).toBe(202);
        const tests = platform.repo.listTests(project);
        expect(tests).toHaveLength(2);
        const ids = await runnableTestIds(platform.repo, project);
        expect(ids).toHaveLength(1);
        expect(isLoadSpec(platform.repo.getTest(ids[0]!)!.spec)).toBe(false);

        // The project's saved analysis settings say load checks are on; a schedule must not repeat that.
        platform.repo.createApplication(project, "http://127.0.0.1:5559", { ...DEFAULT_JOB_OPTIONS, targets: ["api"], loadChecks: true }, undefined);
        const schedule = { id: "s1", projectId: project, name: "nightly", kind: "generate", cadence: { type: "daily", time: "03:00" }, enabled: true, retryFailures: 1, nextRunAt: null, lastRunAt: null, lastJobId: null, lastOutcome: null, lastOutcomeAt: null, lastNote: null, createdAt: "", updatedAt: "" } as unknown as Schedule;
        const job = await startScheduledJob(platform.repo, schedule);
        expect(job.options.mode).toBe("generate");
        expect(job.options.loadChecks).toBe(false);
        expect(job.options.targets).toEqual(["api"]); // the other saved settings are kept
    });

    it("defaults the option to off and refuses an import of more than 3 load checks at once", async () => {
        expect(DEFAULT_JOB_OPTIONS.loadChecks).toBe(false);
        const project = (await call("POST", "/api/projects", { name: "Load import" })).body.id as string;
        const load = (n: number) => ({ title: `GET /l${n}: handles 10 users at once`, kind: "api", type: "performance", source: { origin: "performance-check" }, steps: [{ action: "request", method: "GET", path: `/l${n}` }, { action: "assertResponse", check: "load" }] });
        const tooMany = await call("POST", `/api/projects/${project}/specs`, { specs: [1, 2, 3, 4].map(load), baseUrl: "http://127.0.0.1:5559", validate: false });
        expect(tooMany.status).toBe(400);
        expect(JSON.stringify(tooMany.body)).toContain("at most 3 load checks");
        const post = await call("POST", `/api/projects/${project}/specs`, {
            specs: [{ title: "POST /x: handles 10 users at once", kind: "api", type: "performance", steps: [{ action: "request", method: "POST", path: "/x" }, { action: "assertResponse", check: "load" }] }],
            baseUrl: "http://127.0.0.1:5559",
            validate: false,
        });
        expect(post.status).toBe(422); // not renderable: a load check only follows a GET
        const three = await call("POST", `/api/projects/${project}/specs`, { specs: [1, 2, 3].map(load), baseUrl: "http://127.0.0.1:5559", validate: false });
        expect(three.status, JSON.stringify(three.body)).toBe(202);
    });
});
