/**
 * The benchmark harness's job time limit and isolated replays (src/eval/bench/cli.ts, controller.ts), and the author's capture copied
 * into each finding, against a scripted platform client and a stand-in app with one account (tests/fixtures/bench-account.mjs, port 9473):
 *   - `--job-timeout-min` and `--isolated-replays` are parsed, absent by default (a default run's config is what it was), and a resumed
 *     run keeps the first attempt's values whatever the resume command says;
 *   - with isolated replays every replay job holds one test and the app starts fresh before each, so a test that changes the account
 *     cannot fail the next one; without them the old batched behaviour stays (and the second test fails on the changed account);
 *   - a finding carries the test's meta.capture ("captured" / "observed_only"), and nothing when the test has none or another value.
 * No browser, no AI.
 */
import { describe, expect, it } from "vitest";
import type { Answer, PlatformClient } from "../src/eval/client.js";
import type { BenchApp } from "../src/eval/bench/apps.js";
import type { Catalogue } from "../src/eval/bench/catalogue.js";
import { configLimits, parseBenchArgs, resumedArgs } from "../src/eval/bench/cli.js";
import { runBenchmark, type BenchOptions } from "../src/eval/bench/controller.js";
import type { BenchAppResult, BenchConfig } from "../src/eval/bench/schema.js";

const PORT = 9473;
const URL_ = `http://127.0.0.1:${PORT}`;
const APP: BenchApp = { id: "bench-account", script: "tests/fixtures/bench-account.mjs", workflows: [{ name: "Account", paths: ["/"] }] };
const CATALOGUE: Catalogue = {
    version: "test-1",
    sha256: "0".repeat(64),
    defects: [{ id: "AC-1", app: "bench-account", workflow: "Account", category: "calculation", severity: "high", expected: "a", actual: "b" }],
};
const CONFIG = { apps: [{ id: "bench-account", version: "v1" }] } as unknown as BenchConfig;

/** An app an earlier attempt stopped with every test made: the continuation has nothing to create and goes straight to judging. */
const stoppedApp = (): BenchAppResult =>
    ({
        id: "bench-account",
        entryId: "bench-account",
        projectId: "p1",
        status: "stopped",
        reason: "stopped: provider rate limit",
        appVersion: "v1",
        seededDefects: ["AC-1"],
        defects: [],
        findings: [],
        metrics: { testsGenerated: 3 },
        jobs: { planJobId: "plan1", createJobIds: ["c1"] },
    }) as unknown as BenchAppResult;

type Verdict = "passed" | "failed";
/**
 * The three tests, run against the real stand-in app when a run starts:
 *   t1 spends from the account, and fails while AC-1 is on;
 *   t2 fails when the account was already spent (it needs a fresh account), else passes;
 *   t3 always passes.
 */
async function runOne(id: string): Promise<Verdict> {
    if (id === "t1") {
        await fetch(`${URL_}/spend`, { method: "POST" });
        const a = (await (await fetch(`${URL_}/account`)).json()) as { defects: string[] };
        return a.defects.includes("AC-1") ? "failed" : "passed";
    }
    if (id === "t2") return ((await (await fetch(`${URL_}/account`)).json()) as { spent: boolean }).spent ? "failed" : "passed";
    return "passed";
}

const META: Record<string, unknown> = { t1: { capture: "captured" }, t2: { capture: "observed_only" }, t3: { capture: "something else" } };

/** A platform with the three tests in `status`; every run job is recorded with the tests it held. */
function platform(status: string) {
    const jobs: string[][] = [];
    const results = new Map<string, Array<{ id: string; state: Verdict }>>();
    const client: PlatformClient = {
        mode: "in-process",
        upload: async () => ({ status: 404, body: {} }),
        call: async (method, url, body): Promise<Answer> => {
            if (method === "POST" && url.endsWith("/create")) return { status: 400, body: { error: "Nothing is left to create." } };
            if (method === "GET" && url === "/api/projects/p1/tests")
                return { status: 200, body: ["t1", "t2", "t3"].map((id, i) => ({ id, testId: `WEB-00${i + 1}`, title: `Test ${id}`, type: "functional", validationStatus: status })) };
            const detail = /^\/api\/tests\/(t\d)$/.exec(url);
            if (method === "GET" && detail) return { status: 200, body: { spec: {}, generationMeta: META[detail[1]!] ?? null } };
            if (method === "GET" && /^\/api\/tests\/t\d\/executions$/.test(url)) return { status: 200, body: [] };
            if (method === "POST" && url === "/api/projects/p1/runs") {
                const ids = (body as { testIds: string[] }).testIds;
                const jobId = `r${jobs.length + 1}`;
                jobs.push(ids);
                const out: Array<{ id: string; state: Verdict }> = [];
                for (const id of ids) out.push({ id, state: await runOne(id) });
                results.set(jobId, out);
                return { status: 202, body: { jobId } };
            }
            const run = /^\/api\/projects\/p1\/runs\/(r\d+)$/.exec(url);
            if (method === "GET" && run) return { status: 200, body: { tests: results.get(run[1]!) ?? [] } };
            if (method === "GET" && /^\/api\/test-generation\/[^/]+$/.test(url)) return { status: 200, body: { status: "COMPLETED" } };
            if (method === "GET" && /\/events$/.test(url)) return { status: 200, body: [] };
            return { status: 404, body: { error: "not here" } };
        },
    };
    return { client, jobs };
}

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
    previous: { startedAt: new Date().toISOString(), apps: [stoppedApp()], entries: [], notes: [] },
    ...extra,
});

const byKey = (a: BenchAppResult) => Object.fromEntries(a.findings.map((f) => [f.id, f]));

describe("isolated replays", () => {
    it("replay each finding alone on a freshly started app in every stage, so one test's changes never reach the next", async () => {
        const { client, jobs } = platform("NEEDS_REVIEW");
        const { benchmark } = await runBenchmark(client, options({ isolatedReplays: true }));
        const app = benchmark.apps[0]!;
        expect(app.status, app.reason).toBe("done");
        // Seeded: one job per finding; clean: only t1 failed with the defect on; single AC-1: only t1 passed clean.
        expect(jobs).toEqual([["t1"], ["t2"], ["t3"], ["t1"], ["t1"]]);
        const f = byKey(app);
        expect(f.t1).toMatchObject({ category: "confirmed", defects: ["AC-1"], replay: { seeded: "failed", clean: "passed", single: { "AC-1": "failed" } } });
        // t1 spent the account in its own app; t2 started on a fresh one and passed.
        expect(f.t2).toMatchObject({ category: "unreproduced", replay: { seeded: "passed", clean: null } });
    }, 60_000);

    it("are off by default: one job per stage, as before (t2 then fails on the account t1 changed)", async () => {
        const { client, jobs } = platform("NEEDS_REVIEW");
        const { benchmark } = await runBenchmark(client, options({}));
        const app = benchmark.apps[0]!;
        expect(app.status, app.reason).toBe("done");
        expect(jobs).toEqual([["t1", "t2", "t3"], ["t1", "t2"], ["t1"]]);
        const f = byKey(app);
        expect(f.t1!.category).toBe("confirmed");
        expect(f.t2).toMatchObject({ category: "false_positive", replay: { seeded: "failed", clean: "failed" } });
    }, 60_000);

    it("also split the first run of a regression benchmark (the created tests run with the defects in)", async () => {
        const { client, jobs } = platform("VALIDATED");
        const { benchmark } = await runBenchmark(client, options({ mode: "regression", isolatedReplays: true }));
        expect(benchmark.apps[0]!.status, benchmark.apps[0]!.reason).toBe("done");
        expect(jobs).toEqual([["t1"], ["t2"], ["t3"], ["t1"], ["t1"]]);
        expect(benchmark.apps[0]!.findings.map((f) => f.id)).toEqual(["t1"]);
    }, 60_000);
});

describe("the author's capture on each finding", () => {
    it("is the test's meta.capture when it is captured or observed_only, and absent otherwise", async () => {
        const { client } = platform("NEEDS_REVIEW");
        const { benchmark } = await runBenchmark(client, options({ isolatedReplays: true }));
        const f = byKey(benchmark.apps[0]!);
        expect(f.t1!.capture).toBe("captured");
        expect(f.t2!.capture).toBe("observed_only");
        expect("capture" in f.t3!).toBe(false);
    }, 60_000);
});

describe("the command's options", () => {
    it("--job-timeout-min and --isolated-replays are read; a default run leaves the config as it was", () => {
        const d = parseBenchArgs(["--apps", "a"]);
        expect(d.jobTimeoutMin).toBeUndefined();
        expect(d.isolatedReplays).toBe(false);
        expect(configLimits(d)).toEqual({ options: {}, run: {} });
        const s = parseBenchArgs(["--isolated-replays", "--job-timeout-min", "180", "--apps", "a"]);
        expect(s).toMatchObject({ jobTimeoutMin: 180, isolatedReplays: true, apps: ["a"] });
        expect(configLimits(s)).toEqual({ options: { jobTimeoutMin: 180, isolatedReplays: true }, run: { jobTimeoutMs: 180 * 60_000, isolatedReplays: true } });
        expect(() => parseBenchArgs(["--job-timeout-min", "0"])).toThrow(/whole number from 1/);
        expect(() => parseBenchArgs(["--job-timeout-min", "2.5"])).toThrow(/whole number/);
    });

    it("a resumed run keeps the first attempt's values whatever the resume command says", () => {
        const first = ["--apps", "a", "--isolated-replays", "--daily-call-cap", "5", "--job-timeout-min", "180", "--yes"];
        const r = resumedArgs(first, ["--resume", "--out", "/tmp/x", "--job-timeout-min", "30", "--daily-call-cap", "9"]);
        expect(r).toMatchObject({ jobTimeoutMin: 180, isolatedReplays: true, dailyCallCap: 9, apps: ["a"], resume: true });
        // A first attempt without them: the resume cannot switch them on either.
        const plain = resumedArgs(["--apps", "a", "--daily-call-cap", "5"], ["--resume", "--isolated-replays", "--job-timeout-min", "180", "--daily-call-cap", "9"]);
        expect(plain).toMatchObject({ isolatedReplays: false, dailyCallCap: 9 });
        expect(plain.jobTimeoutMin).toBeUndefined();
    });
});

describe("the reruns of a new trial (B3 stability)", () => {
    it("run on the clean app; the replays after them still run with the defects in", async () => {
        // Which behaviours the app had on when each run job started, and whether it carried allowMutatingApiTests (only replays do).
        const seen: Array<{ kind: "rerun" | "replay"; defects: string[] }> = [];
        const results = new Map<string, Array<{ id: string; state: Verdict }>>();
        const tests = ["t1", "t2", "t3"].map((id, i) => ({ id, testId: `WEB-00${i + 1}`, title: `Test ${id}`, type: "functional", validationStatus: "NEEDS_REVIEW" }));
        const client: PlatformClient = {
            mode: "in-process",
            upload: async () => ({ status: 404, body: {} }),
            call: async (method, url, body): Promise<Answer> => {
                if (method === "POST" && url === "/api/projects") return { status: 201, body: { id: "p1" } };
                if (method === "PUT" && url === "/api/projects/p1/review-policy") return { status: 200, body: {} };
                if (method === "POST" && url === "/api/projects/p1/test-generation") return { status: 202, body: { jobId: "plan1" } };
                if (method === "GET" && url === "/api/projects/p1/plans/plan1") return { status: 200, body: { total: 3, pages: [], found: { pages: 1 }, ideas: [] } };
                if (method === "POST" && url === "/api/projects/p1/plans/plan1/create") return { status: 202, body: { jobId: "c1" } };
                if (method === "GET" && url === "/api/projects/p1/tests") return { status: 200, body: tests };
                const detail = /^\/api\/tests\/(t\d)$/.exec(url);
                if (method === "GET" && detail) return { status: 200, body: { spec: {}, generationMeta: null } };
                if (method === "GET" && /^\/api\/tests\/t\d\/executions$/.test(url)) return { status: 200, body: [] };
                if (method === "POST" && url === "/api/projects/p1/runs") {
                    const b = body as { testIds: string[]; allowMutatingApiTests?: boolean };
                    seen.push({ kind: b.allowMutatingApiTests ? "replay" : "rerun", defects: ((await (await fetch(`${URL_}/account`)).json()) as { defects: string[] }).defects });
                    const jobId = `r${results.size + 1}`;
                    const out: Array<{ id: string; state: Verdict }> = [];
                    for (const id of b.testIds) out.push({ id, state: await runOne(id) });
                    results.set(jobId, out);
                    return { status: 202, body: { jobId } };
                }
                const run = /^\/api\/projects\/p1\/runs\/(\w+)$/.exec(url);
                if (method === "GET" && run) return { status: 200, body: { tests: results.get(run[1]!) ?? [] } };
                if (method === "GET" && /^\/api\/test-generation\/[^/]+$/.test(url)) return { status: 200, body: { status: "COMPLETED" } };
                if (method === "GET" && /\/events(\?|$)/.test(url)) return { status: 200, body: [] };
                if (method === "GET" && /^\/api\/jobs\/[^/]+\/usage$/.test(url)) return { status: 200, body: { totals: { calls: 0, inputTokens: 0, outputTokens: 0 } } };
                if (method === "GET" && url.startsWith("/api/usage")) return { status: 200, body: { totals: { calls: 0, cost: 0 }, rows: [] } };
                return { status: 404, body: { error: "not here" } };
            },
        };
        const { benchmark } = await runBenchmark(client, { ...options({}), previous: undefined });
        expect(benchmark.apps[0]!.status, benchmark.apps[0]!.reason).toBe("done");
        expect(seen[0]).toEqual({ kind: "rerun", defects: [] });
        expect(seen.find((s) => s.kind === "replay")).toEqual({ kind: "replay", defects: ["AC-1"] });
        // The finding is still judged on the seeded app: t1 fails with AC-1 on and passes clean.
        expect(byKey(benchmark.apps[0]!).t1).toMatchObject({ category: "confirmed", defects: ["AC-1"] });
    }, 60_000);
});
