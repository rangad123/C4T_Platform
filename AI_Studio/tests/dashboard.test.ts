/**
 * Cross-project dashboard, browser-free:
 *  - the readiness rules as a table (every state, every reason, boundaries, precedence);
 *  - trend, fleet sentence, filter and sort helpers;
 *  - a real platform with projects seeded through the repo/store APIs the worker uses (no model, no browser) covering every
 *    readiness state through GET /api/dashboard, corrupt data, read-only behaviour, API-key protection and speed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { assessReadiness, buildDashboard, fleetCounts, filterAndSort, STALE_DAYS, trendOf, type Readiness, type ReadinessInput } from "../src/platform/dashboard.js";
import { ScheduleStore } from "../src/platform/schedule-store.js";
import { buildServer } from "../src/platform/server.js";
import { attentionHref, matches, sparkSegments, ticksFor, type FleetProject } from "../web/src/features/dashboard/dashboard.js";
import { addTest, SEED_NOW, seedProject, seedRun } from "./fixtures/dashboard-seed.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

// ── readiness rules (pure) ──────────────────────────────────────────────────

const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
    activeJob: false,
    latestJob: { status: "COMPLETED", mode: "validate" },
    tests: { total: 4, validated: 4, needsReview: 0, failedValidation: 0, waiting: 0 },
    findings: { critical: 0, high: 0, medium: 0, low: 0 },
    latestRun: { failed: 0, needsReview: 0, total: 4 },
    flaky: 0,
    breakingChanges: 0,
    lastRunAt: new Date(NOW - DAY).toISOString(),
    ...over,
});
const codes = (i: ReadinessInput, now = NOW) => assessReadiness(i, now).reasons.map((r) => r.code);

describe("readiness rules", () => {
    const table: Array<[string, Partial<ReadinessInput>, Readiness, string[], string[]]> = [
        // name, input, state, reason codes (in order), reason texts (in order)
        ["everything passing and recent", {}, "ready", [], []],
        ["one critical finding", { findings: { critical: 1, high: 0, medium: 0, low: 0 } }, "blocked", ["critical-findings"], ["1 critical finding"]],
        ["several critical findings", { findings: { critical: 3, high: 0, medium: 0, low: 0 } }, "blocked", ["critical-findings"], ["3 critical findings"]],
        ["high-severity findings", { findings: { critical: 0, high: 2, medium: 0, low: 0 } }, "blocked", ["high-findings"], ["2 high-severity findings"]],
        ["critical and high together, critical first", { findings: { critical: 1, high: 2, medium: 0, low: 0 } }, "blocked", ["critical-findings", "high-findings"], ["1 critical finding", "2 high-severity findings"]],
        ["the last run failed", { latestJob: { status: "FAILED", mode: "validate" } }, "blocked", ["job-failed"], ["The last run failed"]],
        ["a run of only drafts is held back, not a failure", { latestJob: { status: "FAILED", mode: "validate", nothingRan: true } }, "needs-attention", ["nothing-ran"], ["The last run ran nothing: its tests are waiting for approval"]],
        ["the last analysis failed", { latestJob: { status: "FAILED", mode: "generate" }, tests: { total: 0, validated: 0, needsReview: 0, failedValidation: 0, waiting: 0 }, latestRun: null }, "blocked", ["job-failed"], ["The last analysis failed"]],
        ["tests failing in the last run", { latestRun: { failed: 2, needsReview: 0, total: 4 }, tests: { total: 4, validated: 2, needsReview: 0, failedValidation: 2, waiting: 0 } }, "needs-attention", ["failing-tests"], ["2 tests failing in the last run"]],
        ["tests that could not be validated (no run summary)", { latestRun: null, tests: { total: 4, validated: 3, needsReview: 0, failedValidation: 1, waiting: 0 } }, "needs-attention", ["failing-tests"], ["1 test could not be run"]],
        ["medium findings", { findings: { critical: 0, high: 0, medium: 2, low: 0 } }, "needs-attention", ["medium-findings"], ["2 medium-severity findings"]],
        ["low findings", { findings: { critical: 0, high: 0, medium: 0, low: 1 } }, "needs-attention", ["low-findings"], ["1 low-severity finding"]],
        ["unreliable tests", { flaky: 3 }, "needs-attention", ["unreliable-tests"], ["3 unreliable tests"]],
        ["a breaking API change", { breakingChanges: 1 }, "needs-attention", ["breaking-api-change"], ["1 breaking API change since the previous run"]],
        ["tests not validated yet", { tests: { total: 4, validated: 3, needsReview: 0, failedValidation: 0, waiting: 1 } }, "needs-attention", ["unvalidated-tests"], ["1 test not validated yet"]],
        ["a run older than a week", { lastRunAt: new Date(NOW - 12 * DAY).toISOString() }, "needs-attention", ["stale"], ["Last run 12 days ago"]],
        ["never analyzed (no tests, no job)", { latestJob: null, latestRun: null, tests: { total: 0, validated: 0, needsReview: 0, failedValidation: 0, waiting: 0 }, lastRunAt: null }, "unknown", ["never-analysed"], ["Not analyzed yet"]],
        ["tests exist but were never run", { latestJob: null, latestRun: null, tests: { total: 3, validated: 0, needsReview: 0, failedValidation: 0, waiting: 0 }, lastRunAt: null }, "unknown", ["never-run"], ["Its tests have never been run"]],
        ["the first analysis is still running", { latestJob: null, activeJob: true, latestRun: null, tests: { total: 0, validated: 0, needsReview: 0, failedValidation: 0, waiting: 0 }, lastRunAt: null }, "unknown", ["analysis-running"], ["The first analysis is still running"]],
        ["an analysis that made no tests", { latestJob: { status: "COMPLETED", mode: "generate" }, latestRun: null, tests: { total: 0, validated: 0, needsReview: 0, failedValidation: 0, waiting: 0 } }, "unknown", ["no-tests"], ["The analysis made no tests yet"]],
        ["unreadable data", { problem: "Some of this project’s data could not be read" }, "unknown", ["data-unreadable"], ["Some of this project’s data could not be read"]],
    ];
    it.each(table)("%s", (_name, over, state, reasonCodes, texts) => {
        const r = assessReadiness(input(over), NOW);
        expect(r.state).toBe(state);
        expect(r.reasons.map((x) => x.code)).toEqual(reasonCodes);
        expect(r.reasons.map((x) => x.text)).toEqual(texts);
        expect(r.label).toBe({ ready: "Ready", "needs-attention": "Needs attention", blocked: "Blocked", unknown: "Unknown" }[state]);
    });

    it("treats exactly 7 days as fresh and anything older as stale", () => {
        const at = (ms: number) => input({ lastRunAt: new Date(NOW - ms).toISOString() });
        expect(assessReadiness(at(STALE_DAYS * DAY), NOW)).toMatchObject({ state: "ready", stale: false });
        expect(assessReadiness(at(STALE_DAYS * DAY + 1), NOW)).toMatchObject({ state: "needs-attention", stale: true });
        expect(codes(at(7 * DAY + 3_600_000))).toEqual(["stale"]);
        expect(assessReadiness(at(7 * DAY + 3_600_000), NOW).reasons[0]!.text).toBe("Last run 7 days ago");
        expect(assessReadiness(at(8 * DAY), NOW).reasons[0]!.text).toBe("Last run 8 days ago");
    });

    it("lets blocked win over needs attention, and needs attention over ready, keeping every reason in order", () => {
        const all = input({
            latestJob: { status: "FAILED", mode: "validate" },
            findings: { critical: 0, high: 1, medium: 1, low: 1 },
            latestRun: { failed: 1, needsReview: 0, total: 4 },
            flaky: 1,
            breakingChanges: 2,
            tests: { total: 4, validated: 1, needsReview: 1, failedValidation: 1, waiting: 1 },
            lastRunAt: new Date(NOW - 30 * DAY).toISOString(),
        });
        const r = assessReadiness(all, NOW);
        expect(r.state).toBe("blocked");
        expect(r.reasons.map((x) => x.code)).toEqual(["high-findings", "job-failed", "failing-tests", "medium-findings", "low-findings", "unreliable-tests", "breaking-api-change", "unvalidated-tests", "stale"]);
        expect(assessReadiness(input({ flaky: 1, lastRunAt: new Date(NOW - 9 * DAY).toISOString() }), NOW).reasons.map((x) => x.code)).toEqual(["unreliable-tests", "stale"]);
    });

    it("shows unknown only when there is nothing else to report; a finding beats unknown", () => {
        const none = { latestJob: null, latestRun: null, tests: { total: 0, validated: 0, needsReview: 0, failedValidation: 0, waiting: 0 }, lastRunAt: null };
        expect(assessReadiness(input({ ...none, findings: { critical: 0, high: 1, medium: 0, low: 0 } }), NOW).state).toBe("blocked");
        // Stale is never added to "unknown": there is no run to be old.
        expect(assessReadiness(input(none), NOW).stale).toBe(false);
    });
});

// ── helpers (pure) ──────────────────────────────────────────────────────────

describe("trend, fleet sentence, filter and sort", () => {
    it("keeps the newest 10 runs, oldest first, and keeps null pass rates", () => {
        const runs = Array.from({ length: 14 }, (_, i) => ({ finishedAt: new Date(NOW + (13 - i) * 1000).toISOString(), passRate: i === 5 ? null : 100 - i }));
        const t = trendOf(runs);
        expect(t).toHaveLength(10);
        expect(t.map((x) => x.at)).toEqual([...t.map((x) => x.at)].sort());
        expect(t.at(-1)!.at).toBe(new Date(NOW + 13 * 1000).toISOString());
        expect(trendOf([])).toEqual([]);
        expect(t.some((x) => x.passRate === null)).toBe(true);
    });

    it("writes the fleet in one sentence", () => {
        expect(fleetCounts(["ready", "ready", "ready", "needs-attention", "blocked"]).sentence).toBe("5 projects: 3 ready, 1 needs attention, 1 blocked");
        expect(fleetCounts(["ready"]).sentence).toBe("1 project: 1 ready");
        expect(fleetCounts(["unknown", "blocked"]).sentence).toBe("2 projects: 1 blocked, 1 unknown");
        expect(fleetCounts([]).sentence).toBe("No projects yet");
        expect(fleetCounts(["blocked", "ready"])).toMatchObject({ total: 2, ready: 1, blocked: 1, needsAttention: 0, unknown: 0 });
    });

    const p = (name: string, state: Readiness, host = "") => ({ name, host, readiness: { state } });
    const fleet = [p("Zeta", "ready"), p("alpha", "ready"), p("Mid", "unknown"), p("Beta", "blocked", "shop.example.com"), p("Gamma", "needs-attention"), p("Aardvark", "blocked")];

    it("sorts blocked first, then needs attention, unknown, ready, and by name inside a group", () => {
        expect(filterAndSort(fleet).map((x) => x.name)).toEqual(["Aardvark", "Beta", "Gamma", "Mid", "alpha", "Zeta"]);
    });
    it("filters by state and by name or host, case-insensitively", () => {
        expect(filterAndSort(fleet, { state: "blocked" }).map((x) => x.name)).toEqual(["Aardvark", "Beta"]);
        expect(filterAndSort(fleet, { q: "  ALP " }).map((x) => x.name)).toEqual(["alpha"]);
        expect(filterAndSort(fleet, { q: "shop.example" }).map((x) => x.name)).toEqual(["Beta"]);
        expect(filterAndSort(fleet, { state: "ready", q: "z" }).map((x) => x.name)).toEqual(["Zeta"]);
        expect(filterAndSort(fleet, { q: "nothing like this" })).toEqual([]);
    });
});

describe("dashboard page helpers", () => {
    const tests = (validated: number, needsAttention: number, couldNotValidate: number, waiting: number) => ({ total: validated + needsAttention + couldNotValidate + waiting, validated, needsAttention, couldNotValidate, waiting });

    it("draws one ribbon tick per test, in proportion above 36, never dropping a verdict that has tests", () => {
        expect(ticksFor(tests(2, 1, 0, 1))).toEqual(["pass", "pass", "attention", "idle"]);
        expect(ticksFor(tests(0, 0, 0, 0))).toEqual([]);
        const big = ticksFor(tests(300, 1, 1, 0));
        expect(big.length).toBeLessThanOrEqual(40);
        expect(big.filter((t) => t === "attention")).toHaveLength(1);
        expect(big.filter((t) => t === "fail")).toHaveLength(1);
        expect(big.filter((t) => t === "pass").length).toBeGreaterThan(30);
    });

    it("turns pass rates into line segments (0% at the bottom) and breaks the line at a run that ran nothing", () => {
        const seg = sparkSegments([{ passRate: 100 }, { passRate: 50 }, { passRate: null }, { passRate: 0 }], 100, 30);
        expect(seg).toHaveLength(2);
        expect(seg[0]).toHaveLength(2);
        expect(seg[0]![0]![1]).toBeLessThan(seg[0]![1]![1]); // 100% is higher up than 50%
        expect(seg[1]![0]![1]).toBe(27); // 0% sits at the bottom edge minus the padding
        expect(sparkSegments([], 100, 30)).toEqual([]);
        expect(sparkSegments([{ passRate: 80 }], 100, 30)[0]![0]![0]).toBe(50); // a single run is centred
    });

    it("matches name or address like the API does, and links the attention list to the right filter", () => {
        expect(matches({ name: "Atlas shop", host: "atlas.example.test" }, " ATLAS ")).toBe(true);
        expect(matches({ name: "Atlas shop", host: "atlas.example.test" }, "example.test")).toBe(true);
        expect(matches({ name: "Atlas shop", host: "atlas.example.test" }, "billing")).toBe(false);
        const p = (t: ReturnType<typeof tests>) => ({ id: "p1", tests: t }) as FleetProject;
        expect(attentionHref(p(tests(1, 1, 1, 0)))).toBe("#/projects/p1/tests?status=review");
        expect(attentionHref(p(tests(1, 0, 1, 0)))).toBe("#/projects/p1/tests?status=failed");
        expect(attentionHref(p(tests(1, 0, 0, 0)))).toBe("#/projects/p1/tests");
    });
});

// ── a real platform with seeded projects ────────────────────────────────────

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
const jobCount = () => (platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generation_jobs")!).n;
const getDash = async (qs = "") => {
    const res = await server.inject({ method: "GET", url: `/api/dashboard${qs}` });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const named = (body: any, name: string) => body.projects.find((x: any) => x.name === name);

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-dash-"));
    // The security assessment loop polls the database in the background; this file counts the dashboard's own queries, so it is off here.
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", SECURITY_ASSESSMENT: "off" }));
    server = await buildServer(platform);

    // Ready: all passing yesterday, with a schedule whose last run worked and a few earlier runs for the trend.
    const ready = seedProject(platform, "Ready shop", "https://shop.example.test/app?key=secret");
    addTest(platform, ready, "R-1");
    addTest(platform, ready, "R-2");
    await seedRun(platform, ready, { "R-1": "pass", "R-2": "fail" }, { daysAgo: 4 });
    await seedRun(platform, ready, { "R-1": "pass", "R-2": "pass" }, { daysAgo: 2 });
    const lastReady = await seedRun(platform, ready, { "R-1": "pass", "R-2": "pass" }, { daysAgo: 1 });
    const sched = new ScheduleStore(platform.db, () => SEED_NOW).create({ projectId: ready.projectId, name: "nightly", kind: "validate", cadence: { type: "daily", time: "02:00" } });
    platform.db.run("UPDATE schedules SET last_run_at = ?, last_job_id = ?, last_outcome = 'started' WHERE id = ?", lastReady.finishedAt, lastReady.id, sched.id);

    // Needs attention: a medium finding and a failing test.
    const attention = seedProject(platform, "Needs a look");
    addTest(platform, attention, "N-1", "medium");
    addTest(platform, attention, "N-2");
    addTest(platform, attention, "N-3");
    await seedRun(platform, attention, { "N-1": "review:Something looked odd on the page", "N-2": "fail", "N-3": "pass" });

    // Blocked by findings: a server error on a critical journey (critical) and on a normal one (high).
    const blocked = seedProject(platform, "Blocked by findings");
    addTest(platform, blocked, "B-1", "critical");
    addTest(platform, blocked, "B-2", "medium");
    addTest(platform, blocked, "B-3");
    await seedRun(platform, blocked, { "B-1": "review:Server error: GET /api/x returned 500", "B-2": "review:Server error: GET /api/y returned 500", "B-3": "pass" });

    // Blocked because the last analysis failed.
    const failed = seedProject(platform, "Blocked by failure");
    await seedRun(platform, failed, {}, { jobStatus: "FAILED", error: "Application unreachable", daysAgo: 0 });

    // Unknown: nothing has happened yet.
    seedProject(platform, "Brand new", null);

    // Stale: everything passed, but twelve days ago.
    const stale = seedProject(platform, "Gone quiet");
    addTest(platform, stale, "S-1");
    await seedRun(platform, stale, { "S-1": "pass" }, { daysAgo: 12.5 });

    // Unreliable test: failed then passed on an immediate retry.
    const flaky = seedProject(platform, "Flaky one");
    addTest(platform, flaky, "F-1");
    await seedRun(platform, flaky, { "F-1": "flaky" });

    // Breaking API change: an operation that answered 200 in the older run is gone in the newer, complete one.
    const drift = seedProject(platform, "Drifting API");
    addTest(platform, drift, "D-1");
    const j1 = await seedRun(platform, drift, { "D-1": "pass" }, { daysAgo: 2 });
    const j2 = await seedRun(platform, drift, { "D-1": "pass" }, { daysAgo: 1 });
    platform.db.run("INSERT INTO api_snapshots (project_id, job_id, at, complete, operations_json) VALUES (?,?,?,?,?)", drift.projectId, j1.id, j1.finishedAt, 1, JSON.stringify({ "GET /api/users": { statuses: [200] }, "GET /api/orders": { statuses: [200] } }));
    platform.db.run("INSERT INTO api_snapshots (project_id, job_id, at, complete, operations_json) VALUES (?,?,?,?,?)", drift.projectId, j2.id, j2.finishedAt, 1, JSON.stringify({ "GET /api/users": { statuses: [200] } }));
}, 30_000);

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});


/** Statements the database layer ran while `fn` executed. */
async function countQueries<T>(p: Platform, fn: () => Promise<T>): Promise<{ result: T; queries: number; writes: number }> {
    const db = p.db as any;
    let queries = 0;
    let writes = 0;
    const originals = (["all", "get", "run"] as const).map((k) => [k, db[k]] as const);
    for (const [k, orig] of originals) db[k] = (...args: unknown[]) => (queries++, k === "run" && writes++, orig.apply(db, args));
    try {
        return { result: await fn(), queries, writes };
    } finally {
        for (const [k, orig] of originals) db[k] = orig;
    }
}

describe("GET /api/dashboard", () => {
    it("puts every seeded project in the right state with the reasons in plain words", async () => {
        const { status, body } = await getDash();
        expect(status).toBe(200);
        expect(body.projects).toHaveLength(8);
        const reasons = (name: string) => named(body, name).readiness.reasons.map((r: any) => r.text);
        const state = (name: string) => named(body, name).readiness.state;

        expect(state("Ready shop")).toBe("ready");
        expect(reasons("Ready shop")).toEqual([]);
        expect(state("Needs a look")).toBe("needs-attention");
        expect(reasons("Needs a look")).toEqual(["1 test failing in the last run", "1 medium-severity finding"]);
        expect(state("Blocked by findings")).toBe("blocked");
        expect(reasons("Blocked by findings")).toEqual(["1 critical finding", "1 high-severity finding"]);
        expect(state("Blocked by failure")).toBe("blocked");
        expect(reasons("Blocked by failure")).toEqual(["The last run failed"]);
        expect(state("Brand new")).toBe("unknown");
        expect(reasons("Brand new")).toEqual(["Not analyzed yet"]);
        expect(state("Gone quiet")).toBe("needs-attention");
        expect(reasons("Gone quiet")).toEqual(["Last run 12 days ago"]);
        expect(named(body, "Gone quiet").readiness.stale).toBe(true);
        expect(state("Flaky one")).toBe("needs-attention");
        expect(reasons("Flaky one")).toEqual(["1 unreliable test"]);
        expect(state("Drifting API")).toBe("needs-attention");
        expect(reasons("Drifting API")).toEqual(["1 breaking API change since the previous run"]);
    });

    it("sorts blocked first, then needs attention, unknown, ready, and writes the fleet sentence", async () => {
        const { body } = await getDash();
        expect(body.projects.map((x: any) => x.name)).toEqual(["Blocked by failure", "Blocked by findings", "Drifting API", "Flaky one", "Gone quiet", "Needs a look", "Brand new", "Ready shop"]);
        expect(body.summary).toMatchObject({ total: 8, ready: 1, needsAttention: 4, blocked: 2, unknown: 1, sentence: "8 projects: 1 ready, 4 needs attention, 2 blocked, 1 unknown" });
    });

    it("returns the numbers each card needs: counts, pass rate, trend, schedule, findings, flaky, API changes, last run", async () => {
        const { body } = await getDash();
        const ready = named(body, "Ready shop");
        expect(ready.host).toBe("shop.example.test");
        expect(ready.tests).toEqual({ total: 2, validated: 2, needsAttention: 0, couldNotValidate: 0, waiting: 0 });
        expect(ready.latestRun).toMatchObject({ passRate: 100, total: 2, validated: 2, failed: 0, trigger: "manual" });
        expect(ready.trend.map((t: any) => t.passRate)).toEqual([50, 100, 100]);
        expect(ready.schedule).toMatchObject({ exists: true, enabled: 1, total: 1, lastRunOk: true });
        expect(ready.analysis).toMatchObject({ status: "COMPLETED", active: false });
        expect(ready.lastRunAt).toBeTruthy();

        const needs = named(body, "Needs a look");
        expect(needs.tests).toMatchObject({ total: 3, validated: 1, needsAttention: 1, couldNotValidate: 1 });
        expect(needs.latestRun.passRate).toBe(33.3);
        expect(needs.findings).toMatchObject({ critical: 0, high: 0, medium: 1, low: 0, highOrCritical: 0 });
        expect(needs.schedule).toMatchObject({ exists: false, lastRunOk: null });

        expect(named(body, "Blocked by findings").findings).toMatchObject({ critical: 1, high: 1, highOrCritical: 2 });
        expect(named(body, "Flaky one").flaky).toBe(1);
        expect(named(body, "Drifting API").apiBreakingChanges).toBe(1);
        expect(named(body, "Brand new")).toMatchObject({ analysis: null, latestRun: null, trend: [], lastRunAt: null, host: "" });
    });

    it("reports a schedule whose last run failed", async () => {
        const p = seedProject(platform, "Schedule trouble");
        addTest(platform, p, "T-1");
        const job = await seedRun(platform, p, { "T-1": "pass" }, { jobStatus: "FAILED", error: "down" });
        const s = new ScheduleStore(platform.db, () => SEED_NOW).create({ projectId: p.projectId, name: "hourly", kind: "validate", cadence: { type: "interval", every: 1, unit: "hours" } });
        platform.db.run("UPDATE schedules SET last_run_at = ?, last_job_id = ?, last_outcome = 'started' WHERE id = ?", job.finishedAt, job.id, s.id);
        try {
            const { body } = await getDash("?q=schedule%20trouble");
            expect(body.projects[0].schedule).toMatchObject({ exists: true, lastRunOk: false });
        } finally {
            platform.db.run("DELETE FROM projects WHERE id = ?", p.projectId);
        }
    });

    it("explains its rules in the response", async () => {
        const { body } = await getDash();
        expect(body.staleDays).toBe(7);
        expect(body.rules.map((r: any) => r.state)).toEqual(["blocked", "needs-attention", "unknown", "ready"]);
        for (const r of body.rules) expect(r.when.length).toBeGreaterThan(0);
        expect(JSON.stringify(body.rules)).toMatch(/critical or high-severity/);
    });

    it("filters by state and by name, and rejects an unknown state", async () => {
        expect((await getDash("?state=blocked")).body.projects.map((x: any) => x.name)).toEqual(["Blocked by failure", "Blocked by findings"]);
        expect((await getDash("?state=ready")).body.projects.map((x: any) => x.name)).toEqual(["Ready shop"]);
        expect((await getDash("?q=SHOP")).body.projects.map((x: any) => x.name)).toEqual(["Ready shop"]); // matches the host too
        expect((await getDash("?q=flaky&state=blocked")).body.projects).toEqual([]);
        // The summary counts the whole fleet even when the list is filtered, so filter chips keep their numbers.
        expect((await getDash("?state=blocked")).body.summary.total).toBe(8);
        expect((await getDash("?state=great")).status).toBe(400);
    });

    it("never shows the full application address, a secret or a server path", async () => {
        const raw = JSON.stringify((await getDash()).body);
        expect(raw).not.toContain("key=secret");
        expect(raw).not.toContain("/app?");
        expect(raw).not.toContain(dataDir);
    });

    it("degrades one project with unreadable data to unknown with a reason, and the others still answer", async () => {
        const bad = seedProject(platform, "Corrupt tests");
        addTest(platform, bad, "C-1");
        await seedRun(platform, bad, { "C-1": "review:odd" });
        platform.db.run("UPDATE test_cases SET spec_json = '{not json' WHERE id = ?", bad.tests.get("C-1")!);
        const bad2 = seedProject(platform, "Corrupt job");
        addTest(platform, bad2, "C-2");
        const job = await seedRun(platform, bad2, { "C-2": "pass" });
        platform.db.run("UPDATE generation_jobs SET options_json = 'garbage' WHERE id = ?", job.id);
        try {
            const { status, body } = await getDash();
            expect(status).toBe(200);
            for (const name of ["Corrupt tests", "Corrupt job"]) {
                expect(named(body, name).readiness).toMatchObject({ state: "unknown", reasons: [{ code: "data-unreadable", text: "Some of this project’s data could not be read" }] });
            }
            expect(named(body, "Ready shop").readiness.state).toBe("ready");
            expect(body.projects).toHaveLength(10);
        } finally {
            platform.db.run("DELETE FROM projects WHERE id IN (?, ?)", bad.projectId, bad2.projectId);
        }
    });

    it("is read-only: no job is started and nothing is written", async () => {
        const count = (table: string) => platform.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
        const before = { jobs: jobCount(), summaries: count("run_summaries"), tests: count("test_cases") };
        const out = await countQueries(platform, async () => {
            await getDash();
            await getDash("?state=ready");
        });
        expect(out.writes).toBe(0);
        expect(jobCount()).toBe(before.jobs);
        expect(count("run_summaries")).toBe(before.summaries);
        expect(count("test_cases")).toBe(before.tests);
    });

    it("answers an empty platform with an empty fleet", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-dash-empty-"));
        const p = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789" }));
        try {
            const out = buildDashboard(p.db, { now: NOW });
            expect(out.projects).toEqual([]);
            expect(out.summary).toMatchObject({ total: 0, sentence: "No projects yet" });
        } finally {
            p.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("dashboard access and speed", () => {
    it("is protected by the API key like every other route", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-dash-key-"));
        const p = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", API_KEY: "dashboard-api-key-12345" }));
        const srv = await buildServer(p);
        try {
            expect((await srv.inject({ method: "GET", url: "/api/dashboard" })).statusCode).toBe(401);
            expect((await srv.inject({ method: "GET", url: "/api/dashboard", headers: { "x-api-key": "wrong-key-wrong-key-12" } })).statusCode).toBe(401);
            const ok = await srv.inject({ method: "GET", url: "/api/dashboard", headers: { "x-api-key": "dashboard-api-key-12345" } });
            expect(ok.statusCode).toBe(200);
            expect(JSON.parse(ok.body).projects).toEqual([]);
        } finally {
            await srv.close();
            p.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("runs the same number of queries for 8 projects as for 50 (no work per project), and fast", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-dash-perf-"));
        const big = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", SECURITY_ASSESSMENT: "off" }));
        const bigServer = await buildServer(big);
        try {
            for (let i = 0; i < 50; i++) {
                const s = seedProject(big, `Project ${String(i).padStart(2, "0")}`, `http://host-${i}.example.test`);
                for (const k of ["a", "b", "c"]) addTest(big, s, `P${i}-${k}`, i % 4 === 0 ? "high" : "medium");
                await seedRun(big, s, { [`P${i}-a`]: "pass", [`P${i}-b`]: i % 3 === 0 ? "fail" : "pass", [`P${i}-c`]: i % 5 === 0 ? "review:Server error: GET /x returned 500" : "pass" }, { daysAgo: 1 + (i % 10) });
                await seedRun(big, s, { [`P${i}-a`]: "pass" }, { daysAgo: 0.5 });
            }
            const small = await countQueries(platform, () => getDash());
            let elapsed = 0;
            const large = await countQueries(big, async () => {
                const t0 = performance.now();
                const res = await bigServer.inject({ method: "GET", url: "/api/dashboard" });
                elapsed = performance.now() - t0;
                return JSON.parse(res.body);
            });
            expect(large.result.projects).toHaveLength(50);
            expect(large.queries).toBe(small.queries);
            expect(large.queries).toBeLessThan(20);
            expect(elapsed).toBeLessThan(3000);
            const states = new Set(large.result.projects.map((x: any) => x.readiness.state));
            expect(states.has("blocked") && states.has("needs-attention")).toBe(true);
        } finally {
            await bigServer.close();
            big.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
