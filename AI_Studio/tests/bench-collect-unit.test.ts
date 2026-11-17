/**
 * Which tests a discovery benchmark collects as findings (src/eval/bench/controller.ts with the harness, src/eval/harness.ts), against a
 * scripted platform client and the stand-in app (tests/fixtures/bench-standin.mjs, port 9485). No browser, no AI.
 *
 * The findings are the tests the generation ended in review (NEEDS_REVIEW), whatever a later run does to their status. A run that does not
 * resume goes through the harness's rerun, which moves a defect test out of review (to VALIDATED when it passes, to FAILED_VALIDATION when
 * it fails as a test problem); a run that resumes past creation skips that rerun. Both are judged on the same tests, the same way:
 *   - the same findings (test, source, category, defects, the author's reason and capture), and the same observed-vs-captured rows, E1, E2;
 *   - a defect test the author stopped is an "authoring" finding even after the rerun ran it.
 */
import { describe, expect, it } from "vitest";
import type { Answer, PlatformClient } from "../src/eval/client.js";
import type { BenchApp } from "../src/eval/bench/apps.js";
import type { Catalogue } from "../src/eval/bench/catalogue.js";
import { runBenchmark, type BenchOptions } from "../src/eval/bench/controller.js";
import { observedOf } from "../src/eval/bench/observed.js";
import type { BenchAppResult, BenchConfig, Benchmark } from "../src/eval/bench/schema.js";

const PORT = 9485;
const APP: BenchApp = { id: "bench-standin", script: "tests/fixtures/bench-standin.mjs", workflows: [{ name: "Shop", paths: ["/shop"] }] };
const CATALOGUE: Catalogue = {
    version: "test-1",
    sha256: "0".repeat(64),
    defects: [{ id: "SI-1", app: "bench-standin", workflow: "Shop", category: "api-contract", severity: "high", expected: "The item list loads", actual: "HTTP 500" }],
};
const CONFIG = { apps: [{ id: "bench-standin", version: "v1" }] } as unknown as BenchConfig;

const CREATED_AT = "2026-11-17T10:00:00.000Z";
const DEFECT_REASON = "The application did not behave as expected: the item list did not load.";
type Row = { id: string; testId: string; title: string; type: string; validationStatus: string; validationReason: string | null };

/**
 * One project p1 as the creation left it: t1 and t2 are defect tests the author stopped (NEEDS_REVIEW, never run), t3 passed its validation.
 * With `harnessRerun`, the first run is the harness's rerun and moves t1 to VALIDATED (it passed) and t2 to FAILED_VALIDATION (a test
 * problem), as in calibration C1. Every other run is a replay: t1 and t2 fail while SI-1 is on in the stand-in app, and pass with it off.
 */
function platform(harnessRerun: boolean) {
    const tests: Row[] = [
        { id: "t1", testId: "WEB-001", title: "Shop lists its items", type: "functional", validationStatus: "NEEDS_REVIEW", validationReason: DEFECT_REASON },
        { id: "t2", testId: "WEB-002", title: "Shop item list loads", type: "functional", validationStatus: "NEEDS_REVIEW", validationReason: DEFECT_REASON },
        { id: "t3", testId: "WEB-003", title: "Home page opens", type: "functional", validationStatus: "VALIDATED", validationReason: null },
    ];
    const executions = new Map<string, Array<{ status: string; startedAt: string }>>([["t1", []], ["t2", []], ["t3", [{ status: "passed", startedAt: CREATED_AT }]]]);
    const runs = new Map<string, Array<{ id: string; state: string }>>();
    let rerunPending = harnessRerun;
    let jobs = 0;
    const client: PlatformClient = {
        mode: "in-process",
        upload: async () => ({ status: 404, body: {} }),
        call: async (method, url, body): Promise<Answer> => {
            if (method === "POST" && url === "/api/projects") return { status: 201, body: { id: "p1" } };
            if (method === "PUT") return { status: 200, body: {} };
            if (method === "POST" && url === "/api/projects/p1/test-generation") return { status: 202, body: { jobId: "plan1" } };
            if (method === "POST" && url === "/api/projects/p1/plans/plan1/create") return harnessRerun ? { status: 202, body: { jobId: "c1" } } : { status: 400, body: { error: "Nothing is left to create." } };
            if (method === "GET" && url === "/api/projects/p1/plans/plan1") return { status: 200, body: { total: 3, found: { pages: 2 }, pages: [{ path: "/" }, { path: "/shop" }] } };
            if (method === "GET" && url === "/api/projects/p1/tests") return { status: 200, body: tests.map((t) => ({ ...t })) };
            const detail = /^\/api\/tests\/(t\d)$/.exec(url);
            if (method === "GET" && detail) return { status: 200, body: { spec: { steps: [{ action: "navigate", url: "/shop" }] }, attempts: 1, generationMeta: detail[1] === "t3" ? null : { capture: "captured" } } };
            const execs = /^\/api\/tests\/(t\d)\/executions$/.exec(url);
            if (method === "GET" && execs) return { status: 200, body: executions.get(execs[1]!) ?? [] };
            if (method === "POST" && url === "/api/projects/p1/runs") {
                const ids = (body as { testIds: string[] }).testIds;
                const jobId = `r${++jobs}`;
                const seeded = (await fetch(`http://127.0.0.1:${PORT}/api/items`)).status === 500;
                const out: Array<{ id: string; state: string }> = [];
                for (const id of ids) {
                    const t = tests.find((x) => x.id === id)!;
                    let state: string;
                    if (rerunPending) {
                        state = id === "t2" ? "failed" : "passed";
                        if (id === "t1") Object.assign(t, { validationStatus: "VALIDATED", validationReason: null });
                        if (id === "t2") Object.assign(t, { validationStatus: "FAILED_VALIDATION", validationReason: "The test needs fixing, not your application." });
                    } else state = id !== "t3" && seeded ? "failed" : "passed";
                    executions.get(id)!.push({ status: state, startedAt: new Date().toISOString() });
                    out.push({ id, state });
                }
                rerunPending = false;
                runs.set(jobId, out);
                return { status: 202, body: { jobId } };
            }
            const run = /^\/api\/projects\/p1\/runs\/(\w+)$/.exec(url);
            if (method === "GET" && run) return { status: 200, body: { tests: run[1] === "c1" ? [{ id: "t3", state: "passed" }] : (runs.get(run[1]!) ?? []) } };
            if (method === "GET" && /^\/api\/test-generation\/[^/]+$/.test(url)) return { status: 200, body: { status: "COMPLETED" } };
            if (method === "GET" && /\/events$/.test(url)) return { status: 200, body: [] };
            if (method === "GET" && /^\/api\/jobs\/[^/]+\/usage$/.test(url)) return { status: 200, body: { totals: { calls: 0, inputTokens: 0, outputTokens: 0 } } };
            return { status: 404, body: { error: "not here" } };
        },
    };
    return { client, tests };
}

/** The same project, stopped by an earlier attempt after its creation: --resume goes straight to judging (no harness rerun). */
const stoppedApp = (): BenchAppResult =>
    ({
        id: "bench-standin",
        entryId: "bench-standin",
        projectId: "p1",
        status: "stopped",
        reason: "stopped: budget reached",
        appVersion: "v1",
        seededDefects: ["SI-1"],
        defects: [],
        findings: [],
        metrics: { testsGenerated: 3 },
        jobs: { planJobId: "plan1", createJobIds: ["c0"] },
    }) as unknown as BenchAppResult;

const options = (extra: Partial<BenchOptions>): BenchOptions => ({
    apps: [{ app: APP, port: PORT }],
    catalogue: CATALOGUE,
    mode: "discovery",
    exploration: {},
    repeat: 1,
    model: "scripted",
    config: CONFIG,
    baseline: false,
    pollMs: 20,
    ...extra,
});

const findingsOf = (b: Benchmark) =>
    b.apps[0]!.findings.map((f) => ({ testKey: f.testKey, source: f.source, category: f.category, defects: f.defects, reason: f.reason, capture: f.capture })).sort((a, b) => a.testKey.localeCompare(b.testKey));

describe("the findings a discovery benchmark collects", () => {
    it("are the defect tests the creation left in review, even after the harness rerun moved them out of it; resumed or not, the same", async () => {
        const fresh = platform(true);
        const a = await runBenchmark(fresh.client, options({}));
        expect(a.benchmark.apps[0]!.status, a.benchmark.apps[0]!.reason).toBe("done");
        // The rerun did move them out of review (what C1 saw).
        expect(fresh.tests.map((t) => t.validationStatus)).toEqual(["VALIDATED", "FAILED_VALIDATION", "VALIDATED"]);

        const resumed = platform(false);
        const b = await runBenchmark(resumed.client, options({ previous: { startedAt: new Date().toISOString(), apps: [stoppedApp()], entries: [], notes: [] } }));
        expect(b.benchmark.apps[0]!.status, b.benchmark.apps[0]!.reason).toBe("done");

        const expected = [
            { testKey: "WEB-001", source: "authoring", category: "confirmed", defects: ["SI-1"], reason: DEFECT_REASON, capture: "captured" },
            { testKey: "WEB-002", source: "authoring", category: "confirmed", defects: ["SI-1"], reason: DEFECT_REASON, capture: "captured" },
        ];
        expect(findingsOf(a.benchmark)).toEqual(expected);
        expect(findingsOf(b.benchmark)).toEqual(expected);
        expect(a.benchmark.metrics.detected).toBe(1);
        expect(b.benchmark.metrics.detected).toBe(1);
        // Execution failures are counted on the same statuses too (none: the rerun's FAILED_VALIDATION is not the creation's).
        expect(a.benchmark.metrics.executionFailures).toBe(b.benchmark.metrics.executionFailures);
    }, 60_000);

    it("feed the observed-vs-captured report the same tests on both sides", async () => {
        const a = await runBenchmark(platform(true).client, options({}));
        const b = await runBenchmark(platform(false).client, options({ previous: { startedAt: new Date().toISOString(), apps: [stoppedApp()], entries: [], notes: [] } }));
        const oa = observedOf(a.benchmark);
        const ob = observedOf(b.benchmark);
        const rows = (o: typeof oa) => o.rows.map((r) => `${r.testKey}:${r.source}:${r.kind}:${r.capture}`).sort();
        expect(rows(oa)).toEqual(["WEB-001:authoring:captured:captured", "WEB-002:authoring:captured:captured"]);
        expect(rows(ob)).toEqual(rows(oa));
        expect(oa.e1).toEqual({ n: 2, of: 2, rate: 1 });
        expect(ob.e1).toEqual(oa.e1);
        expect(oa.e2).toEqual(ob.e2);
        expect(oa.authorCapture).toEqual({ captured: 2, observed_only: 0, unrecorded: 0 });
    }, 60_000);
});
