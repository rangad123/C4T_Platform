/**
 * Quality history and the quality card (Phase 6 X2, spec G7: the history's numbers equal hand-computed values on a fixture history).
 * Browser-free. The pure part (trends.ts qualityHistory) on a fixture whose answers are worked out in the comments; then the real
 * platform (SQLite, routes by inject) reading the same kinds of rows: finding history, run summaries, pull request selections and the
 * run of their head commit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { qualityCard } from "../src/platform/dashboard.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { changeOfRoutes, qualityHistory, type FlakyTest, type PrChange, type QualityFacts } from "../src/platform/trends.js";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
// The window: 4 weeks back from now, 2026-10-25T12:00Z. Weeks start 10-25, 11-01, 11-08, 11-15 (12:00Z); the last ends now, inclusive.

const pr = (n: number, createdAt: string): PrChange => ({ pr: n, headSha: String(n).repeat(40), createdAt, proposed: 1, fullRunRecommended: false, fullRunReasons: [], tests: [], change: { pages: [], endpoints: [] }, outcome: null });
const flaky = { id: "tF", testKey: "WEB-009", title: "Search", executions: 6, passes: 3, fails: 3, flips: 4, flipRate: 0.8, flakyPasses: 0, lastStatus: "passed", lastRunAt: "2026-11-21T00:00:00.000Z" } satisfies FlakyTest;
const run = (i: number, passRate: number | null, notPassing: string[]) => ({ jobId: `r${i}`, finishedAt: new Date(NOW - i * 3_600_000).toISOString(), passRate, notPassing });

const FIXTURE: QualityFacts = {
    confirmations: [
        { findingId: "f1", at: "2026-10-20T00:00:00.000Z", firstSeenAt: "2026-10-19T00:00:00.000Z" }, // before the window
        { findingId: "f2", at: "2026-10-26T00:00:00.000Z", firstSeenAt: "2026-10-25T12:00:00.000Z" }, // week 1, 12 h
        { findingId: "f3", at: "2026-11-09T12:00:00.000Z", firstSeenAt: "2026-11-09T06:00:00.000Z" }, // week 3, 6 h
        { findingId: "f4", at: "2026-11-10T12:00:00.000Z", firstSeenAt: "2026-11-08T12:00:00.000Z" }, // week 3, 48 h
        { findingId: "f5", at: "2026-11-22T12:00:00.000Z", firstSeenAt: "2026-11-22T11:00:00.000Z" }, // week 4 (now), 1 h
    ],
    reopens: [
        { findingId: "f3", at: "2026-11-12T00:00:00.000Z" },
        { findingId: "f3", at: "2026-11-20T00:00:00.000Z" },
        { findingId: "f4", at: "2026-10-01T00:00:00.000Z" }, // before the window
    ],
    // Newest first. Only the latest 10 count: r11 would make /login and GET /api/x repeat, and would lower the pass rate.
    runs: [run(1, 100, ["tA", "tB"]), run(2, 80, ["tC"]), run(3, null, ["tA"]), run(4, 90, []), run(5, 70, ["tD"]), run(6, 100, []), run(7, 100, []), run(8, 50, []), run(9, 60, []), run(10, 100, []), run(11, 0, ["tC", "tD"])],
    runsInWindow: 8,
    areasOf: new Map([
        ["tA", ["/cart", "POST /api/cart"]],
        ["tB", ["/cart"]],
        ["tC", ["GET /api/x"]],
        ["tD", ["/login"]],
    ]),
    flaky: [flaky],
    prs: [pr(3, "2026-11-20T00:00:00.000Z"), pr(2, "2026-11-01T00:00:00.000Z"), pr(1, "2026-10-01T00:00:00.000Z")],
    workflowSteps: { total: 9, exercised: 7 },
};

describe("quality history on a fixture (G7)", () => {
    const h = qualityHistory(FIXTURE, NOW);

    it("counts bugs confirmed per week in the window, the last week ending now", () => {
        expect(h.since).toBe("2026-10-25T12:00:00.000Z");
        expect(h.defects).toEqual([
            { weekStart: "2026-10-25T12:00:00.000Z", confirmed: 1 },
            { weekStart: "2026-11-01T12:00:00.000Z", confirmed: 0 },
            { weekStart: "2026-11-08T12:00:00.000Z", confirmed: 2 },
            { weekStart: "2026-11-15T12:00:00.000Z", confirmed: 1 },
        ]);
    });

    it("lists the pages and endpoints that failed in at least 2 of the latest 10 runs, most runs first", () => {
        // /cart: r1 (tA and tB, one run) and r3 (tA). POST /api/cart: r1, r3. GET /api/x: r2 only. /login: r5 only (r11 is past the 10).
        expect(h.failureAreas).toEqual([
            { area: "/cart", runs: 2, testIds: ["tA", "tB"] },
            { area: "POST /api/cart", runs: 2, testIds: ["tA"] },
        ]);
    });

    it("counts bugs that came back after a fix in the window", () => {
        expect(h.regressions).toEqual({ reopened: 2, findings: 1 });
    });

    it("averages the pass rate of the latest 10 runs that have one", () => {
        // r1..r10 without r3 (none): (100+80+90+70+100+100+50+60+100) / 9 = 83.33 → 83.3
        expect(h.stability).toEqual({ runs: 9, passRate: 83.3 });
    });

    it("passes the unreliable tests, the pull requests and the workflow coverage through, counting the pull requests in the window", () => {
        expect(h.flaky).toEqual([flaky]);
        expect(h.changes.inWindow).toBe(2);
        expect(h.changes.prs.map((p) => p.pr)).toEqual([3, 2, 1]);
        expect(h.workflowCoverage).toEqual({ total: 9, exercised: 7 });
    });

    it("measures discovery: bugs confirmed per run and the median hours to confirm", () => {
        // 4 confirmed in the window over 8 runs = 0.5; hours 12, 6, 48, 1 → sorted 1, 6, 12, 48 → median (6 + 12) / 2 = 9.
        expect(h.discovery).toEqual({ confirmed: 4, runs: 8, perRun: 0.5, medianHoursToConfirm: 9 });
    });

    it("is empty, not wrong, for a project with no history", () => {
        const e = qualityHistory({ confirmations: [], reopens: [], runs: [], runsInWindow: 0, areasOf: new Map(), flaky: [], prs: [], workflowSteps: null }, NOW);
        expect(e.defects.map((d) => d.confirmed)).toEqual([0, 0, 0, 0]);
        expect(e.failureAreas).toEqual([]);
        expect(e.stability).toEqual({ runs: 0, passRate: null });
        expect(e.discovery).toEqual({ confirmed: 0, runs: 0, perRun: null, medianHoursToConfirm: null });
    });

    it("makes a card of six numbers and two lists of at most 5, each row with what its link needs", () => {
        const many = qualityHistory({ ...FIXTURE, flaky: Array.from({ length: 7 }, (_, i) => ({ ...flaky, id: `t${i}` })) }, NOW);
        const c = qualityCard(many);
        expect(c.numbers).toEqual({ confirmed: 4, reopened: 2, passRate: 83.3, workflowSteps: { total: 9, exercised: 7 }, hoursToConfirm: 9, pullRequests: 2 });
        expect(Object.keys(c.numbers)).toHaveLength(6);
        expect(c.areas).toEqual({ total: 2, items: [{ area: "/cart", runs: 2, tests: 2, testId: "tA" }, { area: "POST /api/cart", runs: 2, tests: 1, testId: "tA" }] });
        expect(c.flaky.total).toBe(7);
        expect(c.flaky.items).toHaveLength(5);
        expect(c.flaky.items[0]).toEqual({ id: "t0", testKey: "WEB-009", title: "Search", flips: 4, executions: 6 });
    });

    it("reads a pull request's reached routes back as the preview's change set", () => {
        expect(changeOfRoutes(["GET /cart (src/a.ts:1)", "POST /api/cart (src/a.ts:2)", "ANY /hook (src/b.ts:3)", "not a route"])).toEqual({ pages: ["/cart", "/hook"], endpoints: ["GET /cart", "POST /api/cart", "/hook"] });
    });
});

// ── the real platform ─────────────────────────────────────────────────────

const KEY = "quality-owner-key-1a2b3c4d";
const HEAD = "b".repeat(40);
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dir = "";

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-quality-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "quality-test-secret-key-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.ready();
});

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const get = (url: string) => server.inject({ method: "GET", url, headers: { "x-api-key": KEY } });
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

describe("the quality routes", () => {
    it("read the finding history, the runs and the pull requests with the run of their head commit", async () => {
        const db = platform.db;
        const projectId = String(platform.repo.createProject({ name: "Quality shop" }).id);
        const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5592", { ...DEFAULT_JOB_OPTIONS });
        const suiteId = platform.repo.getOrCreateSuite(projectId, "Cart", "cart");
        const spec = (testId: string, page: string) => TestSpecSchema.parse({ testId, title: `Opens ${page}`, kind: "web", category: "Cart", steps: [{ action: "navigate", url: page }] });
        const tA = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec: spec("WEB-001", "/cart"), framework: "playwright", validationStatus: "VALIDATED" });
        const tB = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec: spec("WEB-002", "/about"), framework: "playwright", validationStatus: "VALIDATED" });

        // Two findings: one confirmed 30 h after it was first seen, then fixed and back; one confirmed 10 h after. One older than the window.
        const finding = (id: string, firstSeen: string) =>
            db.run("INSERT INTO candidate_findings (id, project_id, fingerprint, status, confidence, capture, finding_json, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, projectId, `fp-${id}`, "candidate", "high", "screenshot", "{}", firstSeen, firstSeen, firstSeen, firstSeen);
        let seq = 0;
        const event = (findingId: string, from: string | null, to: string, at: string) => db.run("INSERT INTO finding_events (id, project_id, finding_id, seq, at, actor, by_kind, from_state, to_state) VALUES (?,?,?,?,?,?,?,?,?)", `e${++seq}`, projectId, findingId, seq, at, "Engine", "engine", from, to);
        finding("qf1", iso(100));
        finding("qf2", iso(40));
        finding("qf3", iso(2000));
        event("qf1", "reproduced", "confirmed", iso(70));
        event("qf1", "confirmed", "fixed", iso(50));
        event("qf1", "fixed", "verification_pending", iso(20));
        event("qf2", "reproduced", "confirmed", iso(30));
        event("qf3", "reproduced", "confirmed", iso(1900));

        // Three runs in the window and one before it: /cart failed in two of them; the newest one ran for the pull request's head commit (a trigger with its short hash).
        const summary = async (hoursAgo: number, passRate: number, results: Array<{ id: string; s: "p" | "f" }>) => {
            const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate" });
            db.run(
                "INSERT INTO run_summaries (job_id, project_id, mode, trigger_kind, job_status, finished_at, total, validated, needs_review, failed, flaky, pass_rate, results_json, diff_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                job.id, projectId, "validate", "trigger", "COMPLETED", iso(hoursAgo), results.length, results.filter((r) => r.s === "p").length, 0, results.filter((r) => r.s === "f").length, 0, passRate, JSON.stringify(results.map((r) => ({ k: r.id, key: r.id, title: r.id, ...r }))), "{}",
            );
            return job.id;
        };
        await summary(1000, 100, [{ id: tA, s: "p" }, { id: tB, s: "p" }]); // before the window: a run for stability, not for discovery
        await summary(60, 50, [{ id: tA, s: "f" }, { id: tB, s: "p" }]);
        await summary(30, 100, [{ id: tA, s: "p" }, { id: tB, s: "p" }]);
        const latest = await summary(5, 50, [{ id: tA, s: "f" }, { id: tB, s: "p" }]);
        db.run("INSERT INTO trigger_tokens (id, project_id, label, token_hash, hint, created_at) VALUES (?,?,?,?,?,?)", "qtok", projectId, "CI", "qhash", "qtok", iso(100));
        db.run("INSERT INTO trigger_runs (job_id, token_id, commit_sha, callback_state, created_at) VALUES (?,?,?,?,?)", latest, "qtok", HEAD.slice(0, 7), "none", iso(5));
        const reasons = { tests: [{ testId: tA, testKey: "WEB-001", title: "Opens /cart", score: 7, risk: "Risk 7", reasons: ["The change names GET /cart, and its steps open /cart (step 1)."] }], fullRunRecommended: true, fullRunReasons: ["Shared code changed: src/db.ts."], endpoints: ["GET /cart (src/cart.ts:4)"], unmapped: [], shared: ["src/db.ts"], findings: [], notes: [] };
        db.run("INSERT INTO pr_selections (id, project_id, pr, head_sha, mode, selected_json, reasons_json, created_at) VALUES (?,?,?,?,?,?,?,?)", "ps1", projectId, 7, HEAD, "full", JSON.stringify([tA]), JSON.stringify(reasons), iso(6));
        db.run("INSERT INTO pr_selections (id, project_id, pr, head_sha, mode, selected_json, reasons_json, created_at) VALUES (?,?,?,?,?,?,?,?)", "ps2", projectId, 8, "c".repeat(40), "full", "[]", "{not json", iso(1));

        const res = await get(`/api/projects/${projectId}/quality`);
        expect(res.statusCode, res.body).toBe(200);
        const { card, history } = res.json();
        // Confirmed in the window: qf1 (70 h ago, 30 h after first seen) and qf2 (30 h ago, 10 h after) → 2, median 20 h. qf3 is older.
        // Reopened: qf1 once. Pass rate of the latest 10 runs (100 + 50 + 100 + 50) / 4 = 75. Pull requests: 2. No exploration, so no workflow coverage.
        expect(card.numbers).toEqual({ confirmed: 2, reopened: 1, passRate: 75, workflowSteps: null, hoursToConfirm: 20, pullRequests: 2 });
        expect(card.areas).toEqual({ total: 1, items: [{ area: "/cart", runs: 2, tests: 1, testId: tA }] });
        expect(history.discovery).toEqual({ confirmed: 2, runs: 3, perRun: 0.67, medianHoursToConfirm: 20 });

        const prs = await get(`/api/projects/${projectId}/pull-requests`);
        expect(prs.statusCode).toBe(200);
        expect(prs.json().pullRequests).toEqual([
            { pr: 8, headSha: "c".repeat(40), createdAt: expect.any(String), proposed: 0, fullRunRecommended: false, fullRunReasons: [], tests: [], change: { pages: [], endpoints: [] }, outcome: null },
            {
                pr: 7,
                headSha: HEAD,
                createdAt: expect.any(String),
                proposed: 1,
                fullRunRecommended: true,
                fullRunReasons: ["Shared code changed: src/db.ts."],
                tests: [{ testKey: "WEB-001", title: "Opens /cart", why: "The change names GET /cart, and its steps open /cart (step 1)." }],
                change: { pages: ["/cart"], endpoints: ["GET /cart"] },
                outcome: { jobId: latest, passRate: 50, total: 2, failed: 1 },
            },
        ]);
    });

    it("answer 404 for a project that does not exist, and need the API key", async () => {
        expect((await get("/api/projects/nope/quality")).statusCode).toBe(404);
        expect((await get("/api/projects/nope/pull-requests")).statusCode).toBe(404);
        expect((await server.inject({ method: "GET", url: "/api/projects/nope/quality" })).statusCode).toBe(401);
    });
});
