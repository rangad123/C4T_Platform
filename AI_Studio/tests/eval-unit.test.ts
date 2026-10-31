/**
 * Evaluation harness, the parts that need no browser and no AI (fast tier): the corpus file and its checks, the sign-in variables, the
 * sorting of failure reasons, the judgement of a test over its reruns, the numbers of an entry and of a run, the quality gates, the
 * comparison with the previous run, the Markdown summary, the command's arguments, and the platform side (store and routes, through
 * `server.inject`, with and without the API key).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { main, parseArgs } from "../src/eval/cli.js";
import { credentialsFromEnv, loadCorpus, parseCorpus } from "../src/eval/corpus.js";
import { checkGates, classifyFailure, compareMetrics, entryMetrics, judgeTest, overallOf, parseGates, ratesOf, type EntryFacts, type TestObservation } from "../src/eval/metrics.js";
import { markdownSummary } from "../src/eval/report.js";
import { EvalRunSchema, type EvalRun } from "../src/eval/run.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { Db } from "../src/platform/db.js";
import { EvalStore } from "../src/platform/eval-store.js";
import { buildServer } from "../src/platform/server.js";

const obs = (id: string, firstRun: TestObservation["firstRun"], reruns: TestObservation["reruns"], reason?: string, duplicate = false): TestObservation => ({ id, testId: `T-${id}`, title: `Test ${id}`, firstRun, reruns, reason, duplicate });

describe("the corpus file", () => {
    it("ships the two local fixtures, valid, and an example that is valid too", () => {
        const c = loadCorpus(path.join(REPO_ROOT, "eval/corpus.json"));
        expect(c.entries.map((e) => [e.id, e.kind, e.fixture])).toEqual([
            ["sample-app", "web", "sample-app"],
            ["fake-shop", "android", "fake-shop"],
        ]);
        const ex = loadCorpus(path.join(REPO_ROOT, "eval/corpus.example.json"));
        expect(ex.entries.length).toBeGreaterThan(2);
        // Only names of environment variables: no value-looking secret in the example.
        for (const e of ex.entries) for (const v of Object.values(e.credentials ?? {})) expect(v).toMatch(/^[A-Z][A-Z0-9_]*$/);
    });

    it("says in plain words what is wrong, for every problem", () => {
        const bad = JSON.stringify({
            entries: [
                { id: "Shop!", kind: "web" },
                { id: "app", kind: "android", url: "https://x.example" },
                { id: "app", kind: "web", url: "https://x.example", credentials: { username: "my secret value" } },
                { id: "apk", kind: "android", appPackage: "com.a.b", apk: "app.zip", targets: ["web"] },
            ],
        });
        let message = "";
        try {
            parseCorpus(bad, "corpus.json");
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toContain("entries.0.id: Use lower-case letters, digits and dashes");
        expect(message).toContain("entries.0.url: A website needs its url");
        expect(message).toContain("entries.1.appPackage: An Android app needs its appPackage");
        expect(message).toContain("entries.1.url: url is for websites");
        expect(message).toContain("Use the NAME of an environment variable");
        expect(message).toContain("Give both username and password, or neither");
        expect(message).toContain("The id “app” is used twice");
        expect(message).toContain("The apk file name must end in .apk");
        expect(message).toContain('An Android app is explored with targets ["mobile"]');
        expect(() => parseCorpus("{ nope", "corpus.json")).toThrow(/corpus.json is not valid JSON/);
        expect(() => parseCorpus(JSON.stringify({ entries: [], extra: 1 }))).toThrow(/Unrecognized key/);
    });

    it("reads sign-in details from the environment by name, and names the missing ones", () => {
        const e = parseCorpus(JSON.stringify({ entries: [{ id: "a", kind: "web", url: "https://a.example", credentials: { username: "A_USER", password: "A_PASS" } }] })).entries[0]!;
        expect(credentialsFromEnv(e, { A_USER: "u", A_PASS: "p" })).toEqual({ values: { username: "u", password: "p" }, missing: [] });
        expect(credentialsFromEnv(e, { A_USER: "u" })).toEqual({ values: undefined, missing: ["A_PASS"] });
    });
});

describe("the numbers", () => {
    it("sorts failure reasons: element not there or a timeout is the test, other content, a server error or a finding is the product", () => {
        expect(classifyFailure("expect(locator).toBeVisible() failed\n Locator: getByRole('button') Expected: visible Received: <element(s) not found>")).toBe("test-wrong");
        expect(classifyFailure("locator.click: Timeout 10000ms exceeded. waiting for locator('#buy')")).toBe("test-wrong");
        expect(classifyFailure("Test timeout of 30000ms exceeded.")).toBe("test-wrong");
        expect(classifyFailure('Expected: "Welcome back" Received: "Welcome"')).toBe("product");
        expect(classifyFailure("The server answered 500 Internal Server Error")).toBe("product");
        expect(classifyFailure("anything", "finding")).toBe("product");
        expect(classifyFailure("Something odd")).toBe("unclear");
        expect(classifyFailure(undefined)).toBe("unclear");
    });

    it("judges a test over its reruns: stable, flaky, or not run", () => {
        expect(judgeTest(obs("a", "passed", ["passed", "passed", "passed"])).outcome).toBe("stable-pass");
        expect(judgeTest(obs("b", "failed", ["failed", "finding", "failed"], "Expected: 3 Received: 4"))).toMatchObject({ outcome: "stable-fail", failure: "product" });
        expect(judgeTest(obs("c", "passed", ["passed", "failed", "passed"], "waiting for locator('#x')")).outcome).toBe("flaky");
        expect(judgeTest(obs("d", "passed", ["passed", "not_run", "passed"])).outcome).toBe("not-run");
        expect(judgeTest(obs("e", null, [])).outcome).toBe("not-run");
        // A passing test carries no failure reason.
        expect(judgeTest(obs("f", "failed", ["passed", "passed"], "old reason")).reason).toBeUndefined();
    });

    const facts = (tests: TestObservation[], extra: Partial<EntryFacts> = {}): EntryFacts => ({ planned: 5, tests, coverageUnit: "pages", found: 4, covered: 3, durationMs: 60_000, aiCalls: 10, inputTokens: 1000, outputTokens: 200, cost: null, safetyRefusals: null, ...extra });

    it("adds up an entry and a run; rates come from the sums", () => {
        const a = entryMetrics(facts([obs("1", "passed", ["passed", "passed"]), obs("2", "failed", ["failed", "failed"], "Received: <element(s) not found>"), obs("3", "passed", ["passed", "failed"]), obs("4", "passed", ["passed", "passed"], undefined, true)]));
        expect(a.metrics).toMatchObject({ planned: 5, created: 4, passedFirstRun: 3, stable: 3, stablePassing: 2, stableFailing: 1, flaky: 1, notRun: 0, failingTestWrong: 1, failingProduct: 0, duplicates: 1, found: 4, covered: 3 });
        expect(ratesOf(a.metrics)).toEqual({ firstPass: 0.75, stable: 0.75, flaky: 0.25, duplicates: 0.25, coverage: 0.75, testWrong: 1 });
        const b = entryMetrics(facts([obs("5", "passed", ["passed", "passed"])], { coverageUnit: "screens", found: 6, covered: 2, cost: 0.5, safetyRefusals: 2 }));
        const all = overallOf([a, b, { metrics: undefined }]);
        expect(all).toMatchObject({ entries: 3, entriesDone: 2, created: 5, stable: 4, flaky: 1, found: 10, covered: 5, cost: 0.5, safetyRefusals: 2 });
        expect(all.rates).toMatchObject({ stable: 0.8, flaky: 0.2, coverage: 0.5 });
        // Nothing created: no rate at all (never "100% stable").
        expect(overallOf([]).rates.stable).toBeNull();
    });

    it("reads quality gates and fails a run under them, with a plain message", () => {
        const gates = parseGates("stable=0.8, flaky=0.1,coverage=.5");
        expect(gates).toEqual([
            { name: "stable", limit: 0.8 },
            { name: "flaky", limit: 0.1 },
            { name: "coverage", limit: 0.5 },
        ]);
        const r = checkGates({ firstPass: 1, stable: 0.75, flaky: 0.1, duplicates: 0, coverage: null, testWrong: null }, gates);
        expect(r.map((g) => g.passed)).toEqual([false, true, false]);
        expect(r[0]!.message).toBe("stable 75%, at least 80% wanted: failed");
        expect(r[2]!.message).toBe("coverage nothing to measure, at least 50% wanted: failed");
        expect(checkGates({ firstPass: null, stable: null, flaky: null, duplicates: null, coverage: null, testWrong: null }, parseGates("flaky=0.1"))[0]!.passed).toBe(true);
        expect(() => parseGates("speed=0.5")).toThrow("“speed” is not a gate");
        expect(() => parseGates("stable=2")).toThrow("between 0 and 1");
        expect(() => parseGates("stable")).toThrow("Write it like stable=0.8");
        expect(() => parseGates("")).toThrow("at least one gate");
    });

    it("compares with the previous run: better, worse, the same within a small margin, or new", () => {
        const prev = { planned: 10, created: 8, durationMs: 100_000, aiCalls: 50, cost: null, safetyRefusals: 1, rates: { firstPass: 0.5, stable: 0.8, flaky: 0.1, coverage: 0.5, duplicates: 0, testWrong: null } };
        const cur = { planned: 12, created: 8, durationMs: 105_000, aiCalls: 70, cost: 1.2, safetyRefusals: 1, rates: { firstPass: 0.6, stable: 0.803, flaky: 0.2, coverage: 0.4, duplicates: 0, testWrong: 0.5 } };
        const by = Object.fromEntries(compareMetrics(prev, cur).map((c) => [c.metric, c.change]));
        expect(by).toEqual({
            "rates.firstPass": "better",
            "rates.stable": "same",
            "rates.coverage": "worse",
            "rates.flaky": "worse",
            "rates.duplicates": "same",
            "rates.testWrong": "new",
            planned: "changed",
            created: "same",
            durationMs: "same",
            aiCalls: "worse",
            cost: "new",
            safetyRefusals: "same",
        });
        expect(compareMetrics(undefined, cur).every((c) => c.change === "new")).toBe(true);
    });
});

// ── a run, as the harness writes it ───────────────────────────────────────────
function sampleRun(over: Partial<EvalRun> = {}, stable = 0.75): EvalRun {
    const e = entryMetrics({ planned: 4, tests: [obs("1", "passed", ["passed", "passed"]), obs("2", "failed", ["failed", "failed"], "Received: <element(s) not found>")], coverageUnit: "pages", found: 3, covered: 2, durationMs: 1000, aiCalls: 4, inputTokens: 40, outputTokens: 20, cost: null, safetyRefusals: null });
    const overall = overallOf([e]);
    overall.rates.stable = stable;
    return {
        format: 1,
        corpus: "default",
        startedAt: "2026-10-18T10:00:00.000Z",
        finishedAt: "2026-10-18T10:05:00.000Z",
        repeat: 2,
        planOnly: false,
        platform: { mode: "in-process", model: "scripted" },
        entries: [{ id: "sample-app", kind: "web", status: "done", metrics: e.metrics, rates: ratesOf(e.metrics), tests: e.tests }],
        overall,
        ...over,
    };
}

describe("the summary and the command", () => {
    it("writes a Markdown summary with the overall numbers, the entries and the tests to look at", () => {
        const md = markdownSummary(sampleRun(), null);
        expect(md).toContain("# Evaluation: default");
        expect(md).toContain("| Tests created | 2 |");
        expect(md).toContain("| Coverage (pages or screens a test visits, of those found) | 2 of 3 (66.7%) |");
        expect(md).toContain("nothing to compare with yet");
        expect(md).toContain("- T-2 Test 2: keeps failing (the test is wrong). Received: <element(s) not found>");
        expect(md).toContain("| Cost | n/a (no price set in Settings, AI usage) |");
        expect(EvalRunSchema.parse(sampleRun())).toBeTruthy();
    });

    it("reads its options and refuses wrong ones (exit code 2, with the usage)", async () => {
        expect(parseArgs(["--repeat", "5", "--only", "a,b", "--plan-only", "--fail-under", "stable=0.9", "--yes"])).toMatchObject({ repeat: 5, only: ["a", "b"], planOnly: true, yes: true, gates: [{ name: "stable", limit: 0.9 }] });
        expect(() => parseArgs(["--repeat", "0"])).toThrow("from 1 to 10");
        expect(() => parseArgs(["--data-dir", path.join(REPO_ROOT, "data")])).toThrow("must not be the platform's own ./data folder");
        expect(() => parseArgs(["--corpus"])).toThrow("--corpus needs a value");
        const lines: string[] = [];
        const log = (s: string) => lines.push(s);
        expect(await main(["--bogus"], { log })).toBe(2);
        expect(lines.join("\n")).toContain("Unknown option --bogus");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-eval-unit-"));
        try {
            fs.writeFileSync(path.join(dir, "empty.json"), JSON.stringify({ name: "x", entries: [] }));
            expect(await main(["--corpus", path.join(dir, "empty.json")], { log })).toBe(2);
            expect(lines.join("\n")).toContain("The corpus has no entries");
            expect(await main(["--only", "nope"], { log })).toBe(2);
            expect(lines.join("\n")).toContain("The corpus has no entry nope");
            expect(await main(["--help"], { log })).toBe(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("the platform keeps runs and compares each with the one before", () => {
    let dir: string;
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    const KEY = "eval-unit-key-0123456789";

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-eval-store-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", API_KEY: KEY }));
        server = await buildServer(platform);
    });
    afterAll(async () => {
        await server?.close();
        platform?.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, key: string | null = KEY) => {
        const res = await server.inject({ method, url, payload: payload as never, headers: key ? { "x-api-key": key } : {} });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
    };

    it("creates its table in a fresh database (slot 30), and the store works on its own", () => {
        const db = new Db(":memory:");
        const s = new EvalStore(db);
        const id = s.add(sampleRun(), JSON.stringify(sampleRun()));
        expect(s.list()[0]).toMatchObject({ id, corpus: "default", planOnly: false });
        expect(s.compare(s.list()[0]!)).toBeNull();
        db.close();
    });

    it("needs the API key", async () => {
        expect((await call("GET", "/api/eval/runs", undefined, null)).status).toBe(401);
        expect((await call("POST", "/api/eval/runs", sampleRun(), "wrong-key-wrong-key-xxxxx")).status).toBe(401);
    });

    it("keeps a run, lists it, and compares the next run of the same corpus with it", async () => {
        expect((await call("GET", "/api/eval/runs")).body).toEqual({ runs: [] });
        const first = await call("POST", "/api/eval/runs", sampleRun({}, 0.5));
        expect(first.status).toBe(201);
        expect(first.body.comparison).toBeNull();
        const second = await call("POST", "/api/eval/runs", sampleRun({ startedAt: "2026-10-18T11:00:00.000Z", finishedAt: "2026-10-18T11:05:00.000Z" }, 0.9));
        expect(second.status).toBe(201);
        expect(second.body.comparison.comparedWith.id).toBe(first.body.id);
        expect(second.body.comparison.overall.find((c: { metric: string }) => c.metric === "rates.stable")).toEqual({ metric: "rates.stable", previous: 0.5, current: 0.9, change: "better" });
        expect(second.body.comparison.entries[0].id).toBe("sample-app");
        // Another corpus, or a plan-only run, is never compared with this one.
        const other = await call("POST", "/api/eval/runs", sampleRun({ corpus: "other", startedAt: "2026-10-18T12:00:00.000Z", finishedAt: "2026-10-18T12:01:00.000Z" }));
        expect(other.body.comparison).toBeNull();

        const list = (await call("GET", "/api/eval/runs")).body.runs;
        expect(list.map((r: { corpus: string }) => r.corpus)).toEqual(["other", "default", "default"]);
        expect(list[1].comparison.comparedWith.id).toBe(first.body.id);
        const one = await call("GET", `/api/eval/runs/${second.body.id}`);
        expect(one.status).toBe(200);
        expect(one.body.run.entries[0].tests).toHaveLength(2);
        expect(one.body.comparison.comparedWith.id).toBe(first.body.id);
    });

    it("refuses what is not a run, and answers 404 for an unknown one", async () => {
        const bad = await call("POST", "/api/eval/runs", { ...sampleRun(), entries: [{ id: "x", kind: "web", status: "weird" }] });
        expect(bad.status).toBe(400);
        expect((await call("POST", "/api/eval/runs", { ...sampleRun(), secret: "x" })).status).toBe(400);
        expect((await call("POST", "/api/eval/runs", sampleRun({ finishedAt: "2026-10-18T09:00:00.000Z" }))).body.error).toBe("“finishedAt” must not be before “startedAt”");
        const big = sampleRun();
        big.entries[0]!.tests = Array.from({ length: 501 }, (_, i) => ({ ...big.entries[0]!.tests![0]!, id: String(i) }));
        expect((await call("POST", "/api/eval/runs", big)).status).toBe(400);
        expect((await call("GET", "/api/eval/runs/not-a-run")).status).toBe(404);
        expect((await call("GET", "/api/eval/runs/00000000-0000-4000-8000-000000000000")).status).toBe(404);
        expect((await call("GET", "/api/eval/runs?limit=0")).status).toBe(400);
    });

    it("forgets a run", async () => {
        const id = (await call("POST", "/api/eval/runs", sampleRun({ corpus: "gone" }))).body.id;
        expect((await call("DELETE", `/api/eval/runs/${id}`)).body).toEqual({ deleted: true });
        expect((await call("DELETE", `/api/eval/runs/${id}`)).status).toBe(404);
    });
});
