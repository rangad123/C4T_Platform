/**
 * The benchmark's pre-run estimate for a resumed run (cost.ts estimate + calibrationOf, controller.ts plannedTestsLeft) and the per-kind
 * output folders (cli.ts): pure functions and a scripted platform client, no app, platform or model.
 *
 * The shape this guards against (a run resumed on a later day): one app finished on the first day with an undercounted usage record (14 AI calls for 88 tests),
 * the other app was stopped by the daily cap after 45 of its 90 planned tests. The old estimate calibrated from the undercounted record
 * (about 0.16 calls per test) and counted the stopped app as one more exploration: about 25 calls, where the continuation used 950.
 * Also (controller.ts, cost.ts, scripted platform): a resume cut short keeps the earlier stopped apps' projects and jobs; the budget counts
 * the whole run's spend (since its first day, any month); a continued creation that ends rate-limited leaves the app stopped. The last
 * starts the stand-in app (tests/fixtures/bench-standin.mjs, plain HTTP, no browser) on port 9484.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultOutName, otherKindIn, parseBenchArgs, previousCalibration } from "../src/eval/bench/cli.js";
import type { BenchApp } from "../src/eval/bench/apps.js";
import { DAILY_CAP_STOP, plannedTestsLeft, RATE_LIMIT_STOP, runBenchmark, runUsageSoFar, usageMonitor, type BenchOptions } from "../src/eval/bench/controller.js";
import { calibrationOf, estimate, tokenLimits, tokenLimitsLeft } from "../src/eval/bench/cost.js";
import type { PlatformClient } from "../src/eval/client.js";
import type { BenchAppResult, BenchConfig } from "../src/eval/bench/schema.js";

const THOROUGH = { maxScenarios: 60, authoringMaxSteps: 50 };
const appResult = (id: string, status: string, aiCalls: number, testsGenerated: number) => ({ id, status, metrics: { aiCalls, testsGenerated, inputTokens: aiCalls * 9_000, outputTokens: aiCalls * 400 } });
/** The first day: the shop finished but its record counted only 14 calls; the RBAC app was stopped by the cap. */
const DAY1 = { benchmark: { mode: "discovery", config: { options: { mode: "discovery", login: "html" } }, apps: [appResult("bench-shop", "done", 14, 88), appResult("bench-rbac", "stopped", 936, 45)], metrics: { aiCalls: 950, testsGenerated: 133 } } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-bench-est-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("calibration from an earlier result", () => {
    it("is not taken from an undercounted record, nor from a stopped app", () => {
        expect(calibrationOf(DAY1)).toBeUndefined();
        // Only the finished app counts: 500 calls for 25 tests.
        const ok = { benchmark: { apps: [appResult("a", "done", 500, 25), appResult("b", "stopped", 900, 3)] } };
        expect(calibrationOf(ok)).toEqual({ inputPerCall: 9_000, outputPerCall: 400, callsPerTest: 20 });
        expect(calibrationOf(null)).toBeUndefined();
        expect(calibrationOf({ benchmark: { apps: [appResult("a", "done", 0, 0)] } })).toBeUndefined();
    });

    it("previousCalibration skips the unusable newest file and uses an older usable one", () => {
        const dir = path.join(tmp, "cal");
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "older.json"), JSON.stringify({ benchmark: { apps: [appResult("a", "done", 300, 20)] } }));
        fs.utimesSync(path.join(dir, "older.json"), new Date(2026, 0, 1), new Date(2026, 0, 1));
        fs.writeFileSync(path.join(dir, "newer-partial.json"), JSON.stringify(DAY1));
        fs.writeFileSync(path.join(dir, "bench-state.json"), JSON.stringify({ apps: [] }));
        fs.writeFileSync(path.join(dir, "broken.json"), "{");
        expect(previousCalibration(dir)?.callsPerTest).toBe(15);
        expect(previousCalibration(path.join(tmp, "none"))).toBeUndefined();
    });
});

describe("the estimate of a resumed run (resumed on a later day)", () => {
    it("counts the stopped app's planned tests not made yet, not one more exploration from an undercounted record", () => {
        // The old estimate: the stopped app as a whole new exploration, calibrated from the first day's combined (undercounted) numbers.
        const old = estimate({ apps: 1, ...THOROUGH, previous: { inputPerCall: 9_000, outputPerCall: 400, callsPerTest: 14 / 88 } });
        expect(old.mid.calls).toBeLessThan(30);
        // Now: the shop is finished (nothing more), the RBAC app has 45 of 90 planned tests still to make; no usable calibration.
        const now = estimate({ apps: 0, continued: [45], ...THOROUGH, ...(calibrationOf(DAY1) ? { previous: calibrationOf(DAY1)! } : {}) });
        const perTest = { low: 10 + 1.7, mid: 20 + 1.7, high: 40 + 1.7 };
        expect(now.low.calls).toBe(Math.round(45 * perTest.low));
        expect(now.mid.calls).toBe(Math.round(45 * perTest.mid));
        expect(now.high.calls).toBe(Math.round(45 * perTest.high));
        expect(now.mid.calls).toBeGreaterThan(950);
        expect(now.basis).toMatch(/1 continued app counted from 45 planned tests not made yet/);
    });

    it("a continued app with a usable calibration uses its calls per test; a new app still counts its exploration", () => {
        const previous = { inputPerCall: 10_000, outputPerCall: 500, callsPerTest: 20 };
        const e = estimate({ apps: 1, continued: [10, 5], ...THOROUGH, previous });
        // New app: 8 fixed calls + 42 likely tests x 20; continued: 15 tests x 20.
        expect(e.mid.calls).toBe(8 + 42 * 20 + 15 * 20);
        expect(e.mid.inputTokens).toBe(e.mid.calls * 10_000);
        // Nothing left to make: nothing to spend.
        expect(estimate({ apps: 0, continued: [0], ...THOROUGH }).mid.calls).toBe(0);
    });
});

describe("plannedTestsLeft", () => {
    /** A platform with a 6-idea plan: S-001 and S-002 have tests (their idea is in spec.source), S-003 was skipped, M-001 is a phone idea. */
    const client: PlatformClient = {
        mode: "in-process",
        upload: async () => ({ status: 404, body: {} }),
        call: async (_m, url) => {
            if (url === "/api/projects/p1/plans/plan1") return { status: 200, body: { ready: true, ideas: ["S-001", "S-002", "S-003", "S-004", "S-005", "M-001"].map((id) => ({ id })) } };
            if (url === "/api/projects/p1/tests") return { status: 200, body: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] };
            if (url === "/api/tests/t1") return { status: 200, body: { spec: { source: { scenarioId: "S-001", origin: "browser-agent" } } } };
            if (url === "/api/tests/t2") return { status: 200, body: { spec: { source: { scenarioId: "S-002", origin: "browser-agent" } } } };
            if (url === "/api/tests/t3") return { status: 200, body: { spec: { source: { origin: "health-check" } } } };
            if (url === "/api/test-generation/c1/events") return { status: 200, body: [{ kind: "scenario_skipped", message: 'S-003 "Admin" could not be authored: no way in' }, { kind: "info", message: "S-004 started" }] };
            return { status: 404, body: { error: "not found" } };
        },
    };
    const prev = { id: "bench-rbac", status: "stopped", projectId: "p1", jobs: { planJobId: "plan1", createJobIds: ["c1"] } } as unknown as BenchAppResult;

    it("reads the idea each test was made from (spec.source.scenarioId) and leaves out skipped and phone ideas", async () => {
        expect(await plannedTestsLeft(client, prev)).toEqual({ planned: 5, made: 2, skipped: 1, left: 2 });
    });

    it("undefined when the plan cannot be read or the app has no plan (it is then estimated as a new app)", async () => {
        expect(await plannedTestsLeft(client, { ...prev, jobs: { planJobId: "gone", createJobIds: [] } } as BenchAppResult)).toBeUndefined();
        expect(await plannedTestsLeft(client, { ...prev, projectId: undefined } as unknown as BenchAppResult)).toBeUndefined();
    });
});

describe("each kind of run has its own output folder", () => {
    it("defaults by mode and sign-in; the html discovery folder stays eval/results/bench", () => {
        expect(defaultOutName("discovery", "html")).toBe("bench");
        expect(defaultOutName("discovery", "js")).toBe("bench-login-js");
        expect(defaultOutName("regression", "html")).toBe("bench-regression");
        expect(defaultOutName("regression", "js")).toBe("bench-regression-login-js");
        expect(path.basename(parseBenchArgs([]).out)).toBe("bench");
        expect(path.basename(parseBenchArgs(["--login", "js"]).out)).toBe("bench-login-js");
        expect(path.basename(parseBenchArgs(["--mode", "regression"]).out)).toBe("bench-regression");
        expect(parseBenchArgs(["--mode", "regression", "--out", tmp]).out).toBe(tmp);
    });

    it("a folder holding results of another kind is named, so the run is refused there", () => {
        const dir = path.join(tmp, "kinds");
        fs.mkdirSync(dir);
        expect(otherKindIn(dir, "discovery", "js")).toBeUndefined();
        fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify({ benchmark: { mode: "discovery", config: { options: { mode: "discovery", login: "html" } } } }));
        expect(otherKindIn(dir, "discovery", "html")).toBeUndefined();
        expect(otherKindIn(dir, "discovery", "js")).toMatch(/baseline\.json \(discovery, html sign-in\)/);
        expect(otherKindIn(dir, "regression", "html")).toMatch(/baseline\.json/);
    });
});

// ---- Resumes, the run's budget and rate-limited continuations (controller.ts, cost.ts) ----

/** A scripted platform: answers by "METHOD url"; everything else is 404. Records every call. */
function scriptedPlatform(routes: Record<string, unknown | (() => unknown)>) {
    const calls: string[] = [];
    const client: PlatformClient = {
        mode: "in-process",
        upload: async () => ({ status: 404, body: {} }),
        call: async (m, url) => {
            calls.push(`${m} ${url}`);
            const r = routes[`${m} ${url}`];
            if (r === undefined) return { status: 404, body: { error: "not found" } };
            const body = typeof r === "function" ? (r as () => unknown)() : r;
            return { status: m === "POST" ? 202 : 200, body };
        },
    };
    return { client, calls };
}

const STANDIN: BenchApp = { id: "bench-standin", script: "tests/fixtures/bench-standin.mjs", workflows: [{ name: "Home", paths: ["/"] }] };
const benchOptions = (over: Partial<BenchOptions>): BenchOptions => ({
    apps: [],
    catalogue: { version: "t", sha256: "0".repeat(64), defects: [] },
    mode: "discovery",
    exploration: {},
    repeat: 1,
    model: "scripted",
    config: { apps: [] } as unknown as BenchConfig,
    baseline: false,
    pollMs: 5,
    jobTimeoutMs: 5000,
    log: () => undefined,
    ...over,
});
const stoppedEarlier = (id: string) =>
    ({ id, entryId: id, projectId: `p-${id}`, status: "stopped", reason: DAILY_CAP_STOP, appVersion: "1", seededDefects: [], defects: [], findings: [], metrics: { aiCalls: 400, testsGenerated: 20 }, jobs: { planJobId: `plan-${id}`, createJobIds: [`c-${id}`] } }) as unknown as BenchAppResult;

describe("a resume cut short before reaching an app an earlier attempt stopped", () => {
    it("keeps that app's project, jobs and numbers, so the next --resume still continues it", async () => {
        const { client, calls } = scriptedPlatform({});
        const ac = new AbortController();
        ac.abort(); // e.g. the daily cap was reached on an earlier app
        const earlier = stoppedEarlier("bench-late");
        const late: BenchApp = { ...STANDIN, id: "bench-late" };
        const fresh: BenchApp = { ...STANDIN, id: "bench-new" };
        const saved: BenchAppResult[][] = [];
        const r = await runBenchmark(
            client,
            benchOptions({
                apps: [{ app: late, port: 1 }, { app: fresh, port: 2 }],
                signal: ac.signal,
                previous: { startedAt: "2026-11-13T10:00:00.000Z", apps: [earlier], entries: [], notes: [] },
                onProgress: (s) => saved.push(s.apps),
            }),
        );
        expect(r.benchmark.apps[0]).toEqual(earlier);
        expect(saved.at(-1)![0]).toEqual(earlier); // what bench-state.json gets
        expect(r.benchmark.apps[1]).toMatchObject({ id: "bench-new", status: "skipped" });
        expect(r.complete).toBe(false);
        expect(calls).toEqual([]); // nothing was started or asked
    });
});

describe("the approved budget is for the whole run, not this calendar month", () => {
    it("reads the usage since the run's first day, whatever month that was", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const { client, calls } = scriptedPlatform({ [`GET /api/usage?from=2026-10-30&to=${today}`]: { totals: { cost: 7.5, calls: 900 }, month: { usedTokens: 120_000 } } });
        expect(await runUsageSoFar(client, "2026-10-30T22:15:00.000Z")).toEqual({ cost: 7.5, calls: 900, monthUsedTokens: 120_000 });
        expect(calls).toEqual([`GET /api/usage?from=2026-10-30&to=${today}`]);
        await expect(runUsageSoFar(scriptedPlatform({}).client, "2026-10-30T22:15:00.000Z")).rejects.toThrow(/Reading the AI usage of this run/);
    });

    it("the watch stops the run when the run's spend (earlier months included) passes the budget, though this month's alone does not", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const { client } = scriptedPlatform({
            "GET /api/usage": { totals: { cost: 3, calls: 10 } }, // this month only
            [`GET /api/usage?from=${today}&to=${today}`]: { totals: { cost: 1, calls: 10 } },
            [`GET /api/usage?from=2026-10-30&to=${today}`]: { totals: { cost: 12, calls: 2000 } }, // the whole run
        });
        const ac = new AbortController();
        const stopReason: { value?: string } = {};
        const notes: string[] = [];
        const stop = usageMonitor(client, benchOptions({ budget: 10 }), ac, () => undefined, notes, stopReason, 20, "2026-10-30T22:15:00.000Z");
        try {
            const end = Date.now() + 5000;
            while (!ac.signal.aborted && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
        } finally {
            stop();
        }
        expect(ac.signal.aborted).toBe(true);
        expect(stopReason.value).toBe("stopped: budget reached");
        expect(notes[0]).toBe("Stopped: the estimated AI cost of this run so far ($12.00) passed the approved budget ($10.00).");
    });

    it("token limits for a resume: what earlier attempts spent is taken off; this month's use counts on top of the monthly limit", () => {
        const price = { model: "m", inputPerMTok: 3, outputPerMTok: 15 };
        const rest = tokenLimits(6, 2, price);
        expect(tokenLimitsLeft(10, 4, 1_000_000, 2, price)).toEqual({ monthlyTokens: 1_000_000 + rest.monthlyTokens, jobTokens: rest.jobTokens });
        // Nothing spent yet, nothing used this month: the same as the plain limits.
        expect(tokenLimitsLeft(10, 0, 0, 2, price)).toEqual(tokenLimits(10, 2, price));
        // Spent past the budget: no more than the floor on top of this month's use.
        expect(tokenLimitsLeft(10, 12, 500, 1, price).monthlyTokens).toBe(500 + 1_000);
    });
});

describe("a continued creation that ends rate-limited", () => {
    it("leaves the app stopped (resumable), never judged done with part of the plan made", async () => {
        const id = STANDIN.id;
        const prev = stoppedEarlier(id);
        const { client, calls } = scriptedPlatform({
            [`GET /api/test-generation/plan-${id}`]: { status: "COMPLETED" },
            [`GET /api/test-generation/c-${id}`]: { status: "PARTIALLY_COMPLETED", error: "The AI provider is rate limiting this key" },
            [`GET /api/projects/p-${id}/tests`]: [],
            [`GET /api/test-generation/c-${id}/events`]: [],
            [`POST /api/projects/p-${id}/plans/plan-${id}/create`]: { jobId: "c2" },
            "GET /api/test-generation/c2": { status: "PARTIALLY_COMPLETED", error: "Stopped: the AI provider kept answering 429 Too Many Requests (rate limit)" },
        });
        const r = await runBenchmark(
            client,
            benchOptions({ apps: [{ app: STANDIN, port: 9484 }], previous: { startedAt: "2026-11-13T10:00:00.000Z", apps: [prev], entries: [], notes: [] } }),
        );
        const app = r.benchmark.apps[0]!;
        expect(app.status).toBe("stopped");
        expect(app.reason).toBe(RATE_LIMIT_STOP);
        expect(app.projectId).toBe(`p-${id}`);
        expect(app.jobs?.createJobIds).toEqual([`c-${id}`, "c2"]);
        expect(r.complete).toBe(false);
        expect(calls.some((c) => c.includes("/runs"))).toBe(false); // nothing was validated or replayed
    }, 30_000);
});
