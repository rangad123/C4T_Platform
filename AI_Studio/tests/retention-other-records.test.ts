/**
 * Retention of the other records (approved policy), against a real platform database with a fixed clock handed to the pass:
 *  - job events of warn/error level, job errors, test verdict reasons and agent-run steps past their period (failed 7 days, passed 30)
 *    say "Details expired." (event data loses its error and url fields; step addresses keep origin and path); younger ones are untouched
 *  - a test that needs review keeps its reason (it is the finding); any other expired verdict reason keeps its quarantine family prefix and severity tags: the family check and the severity read the same
 *  - a second pass changes nothing
 *  - findings, finding history, Activity, quarantine and healing decisions, approvals and releases stay byte-identical
 *  - there is no agent action table any more (migration slot 63); a scheduled pass keeps agent runs and, at the real clock, changes nothing
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { protectedFamily } from "../src/engine/quarantine/rules.js";
import { DETAILS_EXPIRED, expiredEventData, expiredReason, originPath } from "../src/engine/retention/rules.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { assessSeverity } from "../src/engine/validation/severity.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { wasCancelled } from "../src/platform/cancel-summary.js";
import { recentExecutions } from "../src/platform/quarantine-store.js";
import { planFor, pruneProject, publicPlan, RETENTION_START_KEY, recordRetentionStart, retentionStart, retentionStore, runScheduledRetention } from "../src/platform/retention-runner.js";
import { isNothingRan, nothingRanMessage } from "../src/platform/review-store.js";
import { detectFlaky } from "../src/platform/trends.js";
import { getTriggerServices } from "../src/platform/trigger-services.js";
import { isRepeatedSkip } from "../src/platform/variants-store.js";
import { addRun, addTest, DAY, pastGrace, type Seed, seedProject, type SeedTest } from "./fixtures/retention-seed.js";

const PAGE = "Welcome back, shopper 4471 (shopper@example.com)";
const URL_Q = "https://shop.example/api/orders?id=9&token=abc#top";

// Reasons as the engine writes them (validator summarise / deterministic findings), each with page text that must go.
const REASONS: Record<string, string> = {
    security: `Check headers — Security check failed: 2 browser security headers missing or weak\n- [medium] Content-Security-Policy is missing on ${URL_Q}. ${PAGE}\n- [low] X-Frame-Options is missing.\nHow to fix: add the headers.`,
    health: `Page health check failed: 1 request to this site failed\n- [high] GET ${URL_Q} returned 500: ${PAGE}\n2 links on this page are broken (checked 9)\n- [low] ${URL_Q}`,
    access: `Open admin — Access control check failed: the viewer reached a page for admins\n- [high] ${PAGE} saw /admin/users\nHow to fix: check the role.`,
    vision: `Look at the cart — AI judgement — please look: the page may be wrong\n- [medium] ${PAGE}`,
    a11y: `Open home — Accessibility audit failed: 1 rule\n- [critical] image-alt: ${PAGE}`,
    server: `Server error: POST /api/orders?card=4111 returned 500 (step "Pay"). ${PAGE}`,
    noauth: `Possible security issue: GET /api/orders is documented as requiring authentication but returned 200 without credentials. ${PAGE}`,
    flaky: `Flaky: passed 1 of 2 runs. The failing run stopped at Check headers — Security check failed: 1 browser security header missing or weak\n- [high] ${PAGE}`,
    plain: `2. Verify the greeting — Timed out waiting for text: ${PAGE}`,
};

const spec = (type: string): TestSpec =>
    TestSpecSchema.parse({ testId: "WEB-900", title: "A check", kind: "web", category: "Pages", type, priority: "medium", steps: [{ action: "navigate", url: "/" }] });

describe("expiredReason (pure)", () => {
    for (const [name, reason] of Object.entries(REASONS)) {
        it(`${name}: no page text left, family and severity read the same, a fixpoint`, () => {
            const cut = expiredReason(reason)!;
            expect(cut).not.toContain("4471");
            expect(cut).not.toContain("example.com");
            expect(cut).not.toContain("token=");
            expect(cut).not.toContain("card=");
            expect(cut).toContain(DETAILS_EXPIRED);
            for (const type of ["functional", "security", "accessibility"]) {
                const s = spec(type);
                expect(protectedFamily({ spec: s, reason: cut })).toBe(protectedFamily({ spec: s, reason }));
                expect(assessSeverity(s, "NEEDS_REVIEW", cut)).toEqual(assessSeverity(s, "NEEDS_REVIEW", reason));
            }
            expect(expiredReason(cut)).toBe(cut);
        });
    }

    it("keeps the step title and the prefix, and says what happened in the agreed shapes", () => {
        expect(expiredReason(REASONS.plain!)).toBe(DETAILS_EXPIRED);
        expect(expiredReason(REASONS.access!)).toBe("Open admin — Access control check failed: Details expired.\n- [high] Details expired.");
        expect(expiredReason(REASONS.security!)).toBe("Check headers — Security check failed: 2 browser security headers missing or weak. Details expired.\n- [medium] Details expired.\n- [low] Details expired.");
        expect(expiredReason(null)).toBeNull();
        expect(expiredReason("")).toBe("");
    });

    it("event data loses every error and url field at any depth; other fields stay; a fixpoint", () => {
        const out = expiredEventData(JSON.stringify({ testId: "WEB-001", attempt: 2, error: PAGE, url: URL_Q, step: { title: "Sign in", error: PAGE, url: URL_Q }, list: [{ url: URL_Q, n: 1 }] }))!;
        expect(JSON.parse(out)).toEqual({ testId: "WEB-001", attempt: 2, step: { title: "Sign in" }, list: [{ n: 1 }] });
        expect(expiredEventData(out)).toBeUndefined();
        expect(expiredEventData(null)).toBeUndefined();
        expect(expiredEventData("not json")).toBeNull();
    });

    it("origin and path only", () => {
        expect(originPath(URL_Q)).toBe("https://shop.example/api/orders");
        expect(originPath("https://user:pw@shop.example/a?b=1")).toBe("https://shop.example/a");
        expect(originPath("/relative?x=1")).toBe("/relative");
    });
});

let dataDir: string;
let platform: Platform;
// A fixed clock 60 days back, as in retention-run-history.test.ts.
const NOW = Math.floor((Date.now() - 60 * DAY) / DAY) * DAY + 12 * 3_600_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-retention-other-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    pastGrace(platform); // an installation long past its first-deploy grace (the grace itself: retention-other-records.test.ts)
}, 60_000);
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

let n = 0;
function job(seed: Seed, status: string, daysAgo: number, error: string | null): string {
    const id = `job-${++n}`;
    platform.db.run(
        "INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, error, created_at, started_at, finished_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        id, seed.projectId, seed.appId, status, "{}", "{}", "{}", error, ago(daysAgo), ago(daysAgo), ago(daysAgo), ago(daysAgo),
    );
    const event = (kind: string, level: string, message: string, data: unknown) =>
        platform.db.run("INSERT INTO agent_events (job_id, stage, kind, level, message, data_json, created_at) VALUES (?,?,?,?,?,?,?)", id, "validation", kind, level, message, data === undefined ? null : JSON.stringify(data), ago(daysAgo));
    event("validation_failed", "warn", `WEB-001 failed (attempt 1, 900ms): ${PAGE}`, { testId: "WEB-001", attempt: 1, status: "failed", error: PAGE, url: URL_Q });
    event("runner_log", "error", `runner: ${PAGE}`, undefined);
    event("pages_reused", "info", "Reused 3 pages", { pages: 3, url: URL_Q });
    return id;
}

function objectiveRun(seed: Seed, verdict: string, daysAgo: number): string {
    const id = `orun-${++n}`;
    platform.db.run(
        `INSERT INTO objective_runs (id, project_id, job_id, objective, start_address, max_steps, max_minutes, max_tokens, approval_seconds, state, verdict, reasoning, started_by_name, created_at, started_at, finished_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, seed.projectId, "job-x", "Buy a hat", "https://shop.example/", 10, 5, 1000, 60, "finished", verdict, "It worked", "Someone", ago(daysAgo), ago(daysAgo), ago(daysAgo), ago(daysAgo),
    );
    platform.db.run(
        "INSERT INTO objective_run_steps (id, run_id, seq, tool, summary, status, detail, url, step_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        `${id}-s1`, id, 1, "click", "Click Buy", "failed", `The page said: ${PAGE}`, URL_Q, JSON.stringify({ action: "click" }), ago(daysAgo),
    );
    platform.db.run("INSERT INTO objective_run_approvals (id, run_id, action, kind, why, url, state, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)", `${id}-a1`, id, "Pay", "pay", "It pays", URL_Q, "approved", ago(daysAgo), ago(daysAgo));
    return id;
}

function agentRun(jobId: string) {
    platform.db.run("INSERT INTO agent_runs (id, job_id, role, subject, status, started_at) VALUES (?,?,?,?,?,?)", `arun-${jobId}`, jobId, "author", "WEB-001", "DONE", ago(1));
}

const tableExists = (t: string) => !!platform.db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const PROTECTED = ["security_findings", "security_finding_history", "security_finding_sightings", "security_audit", "activity", "quarantine_entries", "quarantine_history", "healing_proposals", "objective_run_approvals", "releases", "release_results"];
const protectedSnapshot = () => JSON.stringify(PROTECTED.filter(tableExists).map((t) => [t, platform.db.all(`SELECT * FROM ${t} ORDER BY 1`)]));
const everything = () =>
    JSON.stringify(
        platform.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => [t.name, platform.db.all(`SELECT * FROM "${t.name}" ORDER BY 1`)]),
    );

describe("agent action records no longer exist (migration slot 63)", () => {
    // Runs first, at the real clock, before the old records below exist; its jobs are a day old at the real clock.
    it("has no agent_actions table; a scheduled pass keeps the agent runs and changes nothing else, also in a project with retention off", async () => {
        expect(tableExists("agent_actions")).toBe(false);
        const on = seedProject(platform, "Actions on");
        const off = seedProject(platform, "Actions off");
        retentionStore(platform).save(off.projectId, { ...retentionStore(platform).effective(off.projectId), enabled: false });
        const jobOn = job(on, "COMPLETED", -59, null);
        const jobOff = job(off, "COMPLETED", -59, null);
        agentRun(jobOn);
        agentRun(jobOff);
        const without = () => JSON.stringify((JSON.parse(everything()) as Array<[string, unknown]>).filter(([t]) => !t.startsWith("retention")));
        const before = without();

        await runScheduledRetention(platform, Date.now());
        expect(platform.db.get<any>("SELECT COUNT(*) AS n FROM agent_runs WHERE job_id IN (?, ?)", jobOn, jobOff).n).toBe(2); // the runs stay
        expect(without()).toBe(before);
        await runScheduledRetention(platform, Date.now());
        expect(without()).toBe(before);
        expect(tableExists("agent_actions")).toBe(false);
    });
});

describe("the retention pass clears the other records' details (fake clock, 7 / 30 days)", () => {
    let seed: Seed;
    let jobs: Record<string, string>;
    let tests: Record<string, SeedTest>;
    let runs: Record<string, string>;
    let protectedBefore: string;

    it("seeds records on both sides of each period, plus decisions and audit rows that must not change", () => {
        seed = seedProject(platform, "Other records");
        jobs = { failedOld: job(seed, "FAILED", 7.5, `Validation interrupted: ${PAGE}`), failedYoung: job(seed, "FAILED", 6.5, `Validation interrupted: ${PAGE}`), passedYoung: job(seed, "COMPLETED", 8, null), passedOld: job(seed, "COMPLETED", 30.5, null), partialOld: job(seed, "PARTIALLY_COMPLETED", 7.5, null) };
        tests = { review: addTest(platform, seed, "Review", "web"), sec: addTest(platform, seed, "Headers", "web"), plain: addTest(platform, seed, "Greeting", "web"), young: addTest(platform, seed, "Young", "web"), passedYoung: addTest(platform, seed, "Notes", "web") };
        addRun(platform, seed, tests.sec!, { daysAgo: 7.2, status: "failed", now: NOW });
        addRun(platform, seed, tests.review!, { daysAgo: 20, status: "failed", now: NOW });
        addRun(platform, seed, tests.plain!, { daysAgo: 20, status: "failed", now: NOW });
        addRun(platform, seed, tests.young!, { daysAgo: 6, status: "failed", now: NOW });
        addRun(platform, seed, tests.passedYoung!, { daysAgo: 20, status: "passed", now: NOW });
        // Each reason is written by its run (a reason's age is the later of its run and its own last write).
        const setReason = (t: SeedTest, status: string, reason: string, daysAgo: number) => platform.db.run("UPDATE test_cases SET validation_status = ?, validation_reason = ?, updated_at = ? WHERE id = ?", status, reason, ago(daysAgo), t.id);
        setReason(tests.sec!, "FAILED_VALIDATION", REASONS.security!, 7.2);
        setReason(tests.review!, "NEEDS_REVIEW", REASONS.security!, 20);
        setReason(tests.plain!, "FAILED_VALIDATION", REASONS.plain!, 20);
        setReason(tests.young!, "FAILED_VALIDATION", REASONS.plain!, 6);
        setReason(tests.passedYoung!, "VALIDATED", `Low-confidence AI note: ${PAGE}`, 20);
        runs = { failedOld: objectiveRun(seed, "failed", 7.5), failedYoung: objectiveRun(seed, "failed", 6.5), passedYoung: objectiveRun(seed, "passed", 20) };

        // Decisions and audit records (rows the pass must leave alone).
        platform.db.run("INSERT INTO quarantine_entries (id, project_id, test_id, reason, source, by_name, since, expires_at, status) VALUES (?,?,?,?,?,?,?,?,?)", "q1", seed.projectId, tests.plain!.id, `Flaky on ${PAGE}`, "manual", "Someone", ago(40), ago(26), "released");
        platform.db.run("INSERT INTO quarantine_history (project_id, entry_id, test_id, test_key, title, at, kind, by_name, reason) VALUES (?,?,?,?,?,?,?,?,?)", seed.projectId, "q1", tests.plain!.id, tests.plain!.key, "Greeting", ago(40), "quarantined", "Someone", `Flaky on ${PAGE}`);
        platform.db.run(
            "INSERT INTO healing_proposals (id, test_case_id, job_id, step_index, old_locator_json, new_locator_json, confidence, confidence_label, reason, old_description, new_description, status, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            "h1", tests.plain!.id, jobs.failedOld, 0, "{}", "{}", 0.9, "high", `Button "${PAGE}" is gone`, "a", "b", "applied", ago(40), ago(39),
        );
        platform.db.run("INSERT INTO activity (at, actor_kind, actor_id, actor_name, action, path, project_id, status, detail) VALUES (?,?,?,?,?,?,?,?,?)", ago(40), "user", "u1", "Someone", "POST /api/x", "/api/x", seed.projectId, 200, PAGE);
        platform.db.run("INSERT INTO releases (id, project_id, name, notes, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", "r1", seed.projectId, "1.0", PAGE, "approved", ago(40), ago(40));
        if (tableExists("security_audit"))
            platform.db.run("INSERT INTO security_audit (at, project_id, application_id, actor_kind, actor_id, actor_name, action, object_type, object_id, summary) VALUES (?,?,?,?,?,?,?,?,?,?)", ago(40), seed.projectId, null, "user", "u1", "Someone", "finding.status", "finding", "f1", PAGE);
        protectedBefore = protectedSnapshot();
    });

    it("replaces the expired details and leaves the young ones and everything else as it was", async () => {
        const r = await pruneProject(platform, seed.projectId, retentionStore(platform).effective(seed.projectId), "scheduled", NOW);
        expect(r.records).toBeGreaterThan(0);

        const jobRow = (id: string) => platform.db.get<any>("SELECT status, error FROM generation_jobs WHERE id = ?", id);
        expect(jobRow(jobs.failedOld!)).toEqual({ status: "FAILED", error: DETAILS_EXPIRED });
        expect(jobRow(jobs.failedYoung!).error).toContain("4471");

        const events = (id: string) => platform.db.all<any>("SELECT kind, level, stage, message, data_json FROM agent_events WHERE job_id = ? ORDER BY id", id);
        for (const id of [jobs.failedOld!, jobs.passedOld!, jobs.partialOld!]) {
            const [failed, log, info] = events(id);
            expect(failed).toMatchObject({ kind: "validation_failed", level: "warn", stage: "validation", message: DETAILS_EXPIRED });
            expect(JSON.parse(failed.data_json)).toEqual({ testId: "WEB-001", attempt: 1, status: "failed" });
            expect(log).toMatchObject({ kind: "runner_log", level: "error", message: DETAILS_EXPIRED, data_json: null });
            expect(info).toMatchObject({ message: "Reused 3 pages", data_json: JSON.stringify({ pages: 3, url: URL_Q }) }); // info level is not failure text
        }
        for (const id of [jobs.failedYoung!, jobs.passedYoung!]) expect(events(id)[0].message).toContain("4471");

        const reason = (t: SeedTest) => platform.db.get<any>("SELECT validation_status, validation_reason, updated_at FROM test_cases WHERE id = ?", t.id);
        expect(reason(tests.sec!)).toEqual({ validation_status: "FAILED_VALIDATION", validation_reason: expiredReason(REASONS.security!), updated_at: ago(7.2) });
        expect(reason(tests.plain!).validation_reason).toBe(DETAILS_EXPIRED);
        expect(reason(tests.review!).validation_reason).toBe(REASONS.security); // a finding awaiting review keeps its reason (retention.test.ts)
        expect(reason(tests.young!).validation_reason).toBe(REASONS.plain);
        expect(reason(tests.passedYoung!).validation_reason).toContain("4471"); // a passed run keeps 30 days
        // The quarantine family check and the severity still read the cleaned reason.
        const secSpec = platform.repo.getTest(tests.sec!.id)!.spec;
        expect(protectedFamily({ spec: secSpec, reason: reason(tests.sec!).validation_reason })).toBe("security");
        expect(assessSeverity(secSpec, "NEEDS_REVIEW", reason(tests.sec!).validation_reason)).toEqual(assessSeverity(secSpec, "NEEDS_REVIEW", REASONS.security!));

        const step = (run: string) => platform.db.get<any>("SELECT summary, status, detail, url, step_json FROM objective_run_steps WHERE run_id = ?", run);
        expect(step(runs.failedOld!)).toEqual({ summary: "Click Buy", status: "failed", detail: DETAILS_EXPIRED, url: "https://shop.example/api/orders", step_json: JSON.stringify({ action: "click" }) });
        expect(step(runs.failedYoung!).url).toBe(URL_Q);
        expect(step(runs.passedYoung!).detail).toContain("4471");
        // The run's reasoning expires too (approved policy); its verdict, state and objective stay.
        expect(platform.db.get<any>("SELECT verdict, reasoning, state, objective FROM objective_runs WHERE id = ?", runs.failedOld)).toEqual({ verdict: "failed", reasoning: DETAILS_EXPIRED, state: "finished", objective: "Buy a hat" });
        expect(platform.db.get<any>("SELECT reasoning FROM objective_runs WHERE id = ?", runs.failedYoung).reasoning).toBe("It worked");

        expect(protectedSnapshot()).toBe(protectedBefore);
    });

    it("a second pass changes nothing", async () => {
        const before = everything();
        const r = await pruneProject(platform, seed.projectId, retentionStore(platform).effective(seed.projectId), "manual", NOW);
        expect(r).toMatchObject({ files: 0, runs: 0, summaries: 0, records: 0 });
        // The pass logs itself in the retention log; every other table is byte-identical.
        const strip = (s: string) => JSON.stringify((JSON.parse(s) as Array<[string, unknown]>).filter(([t]) => !t.startsWith("retention")));
        expect(strip(everything())).toBe(strip(before));
        expect(protectedSnapshot()).toBe(protectedBefore);
    });

    it("later, the young records expire too", async () => {
        await pruneProject(platform, seed.projectId, retentionStore(platform).effective(seed.projectId), "manual", NOW + 11 * DAY);
        expect(platform.db.get<any>("SELECT error FROM generation_jobs WHERE id = ?", jobs.failedYoung).error).toBe(DETAILS_EXPIRED);
        expect(platform.db.get<any>("SELECT validation_reason FROM test_cases WHERE id = ?", tests.passedYoung!.id).validation_reason).toBe(DETAILS_EXPIRED);
        expect(protectedSnapshot()).toBe(protectedBefore);
    });
});

describe("fixed job errors code reads survive expiry (flaky detection, quarantine and the CI status do not change)", () => {
    it("a cancelled job keeps 'Cancelled', a job where nothing ran keeps its sentence; other failure text still expires", async () => {
        const seed = seedProject(platform, "Sentinels");
        const cancelled = job(seed, "FAILED", 20, "Cancelled");
        const nothingRan = job(seed, "FAILED", 20, nothingRanMessage(2));
        const failed = job(seed, "FAILED", 20, `Validation interrupted: ${PAGE}`);
        // A test that passes, except in two runs of the cancelled job: counting those would make it flip four times (flaky).
        const t = addTest(platform, seed, "Checkout", "web");
        for (const [daysAgo, status, jobId] of [[25, "passed", null], [24, "failed", cancelled], [23, "passed", null], [22, "failed", cancelled], [21, "passed", null]] as const) {
            const { executionId } = addRun(platform, seed, t, { daysAgo, status, now: NOW });
            platform.db.run("UPDATE test_executions SET job_id = ? WHERE id = ?", jobId, executionId);
        }
        const triggers = getTriggerServices(platform);
        const { token, record } = triggers.store.create(seed.projectId, {});
        triggers.store.addRun({ jobId: cancelled, tokenId: record.id });
        const readers = () => ({
            flaky: detectFlaky(platform.db, seed.projectId),
            window: recentExecutions(platform.db, [t.id]).get(t.id),
            ci: triggers.status(token, cancelled).state,
            cancelled: wasCancelled(platform.repo.getJob(cancelled)!),
            nothingRan: isNothingRan(platform.repo.getJob(nothingRan)!),
        });
        const before = readers();
        expect(before).toMatchObject({ flaky: [], ci: "cancelled", cancelled: true, nothingRan: true });
        expect(before.window!.map((x) => x.status)).toEqual(["passed", "passed", "passed"]);

        await pruneProject(platform, seed.projectId, retentionStore(platform).effective(seed.projectId), "scheduled", NOW);
        const error = (id: string) => platform.db.get<any>("SELECT error FROM generation_jobs WHERE id = ?", id).error;
        expect(error(cancelled)).toBe("Cancelled");
        expect(error(nothingRan)).toBe(nothingRanMessage(2));
        expect(error(failed)).toBe(DETAILS_EXPIRED);
        expect(readers()).toEqual(before);
        // Their events still expire: only the job's fixed error stays.
        expect(platform.db.get<any>("SELECT message FROM agent_events WHERE job_id = ? AND level = 'warn'", cancelled).message).toBe(DETAILS_EXPIRED);
    });
});

describe("a test reason's age (the later of its latest base run and its own last write)", () => {
    const reasonOf = (t: SeedTest) => platform.db.get<any>("SELECT validation_reason FROM test_cases WHERE id = ?", t.id).validation_reason;
    const setReason = (t: SeedTest, reason: string, daysAgo: number) => platform.db.run("UPDATE test_cases SET validation_status = 'FAILED_VALIDATION', validation_reason = ?, updated_at = ? WHERE id = ?", reason, ago(daysAgo), t.id);

    it("a reason written yesterday without a new run is kept, although the latest run is 10 days old", async () => {
        const seed = seedProject(platform, "Fresh reason");
        const t = addTest(platform, seed, "Render", "web");
        addRun(platform, seed, t, { daysAgo: 10, status: "failed", now: NOW });
        setReason(t, `Script could not be rendered: ${PAGE}`, 1);
        await pruneProject(platform, seed.projectId, retentionStore(platform).effective(seed.projectId), "scheduled", NOW);
        expect(reasonOf(t)).toContain("4471");
        await pruneProject(platform, seed.projectId, retentionStore(platform).effective(seed.projectId), "manual", NOW + 7 * DAY);
        expect(reasonOf(t)).toBe(DETAILS_EXPIRED); // 8 days after it was written
    });

    it("a variant or environment run yesterday does not keep an old base-run reason alive", async () => {
        const seed = seedProject(platform, "Old reason");
        const t = addTest(platform, seed, "Greeting", "web");
        addRun(platform, seed, t, { daysAgo: 20, status: "failed", now: NOW });
        setReason(t, REASONS.plain!, 20);
        addRun(platform, seed, t, { daysAgo: 1, status: "passed", now: NOW, variant: "firefox" });
        addRun(platform, seed, t, { daysAgo: 1, status: "passed", now: NOW, environment: "staging" });
        await pruneProject(platform, seed.projectId, retentionStore(platform).effective(seed.projectId), "scheduled", NOW);
        expect(reasonOf(t)).toBe(DETAILS_EXPIRED);
    });
});

describe("a run whose start time cannot be read", () => {
    it("keeps its files and its details, and the preview says why", async () => {
        const seed = seedProject(platform, "Unreadable time");
        const t = addTest(platform, seed, "Odd run", "web");
        const r = addRun(platform, seed, t, { daysAgo: 400, status: "failed", now: NOW, files: [{ kind: "screenshot" }, { kind: "trace" }] });
        platform.db.run("UPDATE test_executions SET started_at = ? WHERE id = ?", "not a date", r.executionId);
        const policy = retentionStore(platform).effective(seed.projectId);
        const preview = publicPlan(policy, planFor(platform, seed.projectId, policy, NOW));
        expect(preview).toMatchObject({ files: 0, runs: 0, undated: 2, undatedNote: "2 files are kept because the time of their runs could not be read." });

        const result = await pruneProject(platform, seed.projectId, policy, "scheduled", NOW);
        expect(result).toMatchObject({ files: 0, runs: 0 });
        for (const f of r.files) expect(fs.existsSync(f.abs)).toBe(true);
        expect(platform.db.get<any>("SELECT COUNT(*) AS n FROM artifacts WHERE execution_id = ? AND pruned_at IS NOT NULL", r.executionId).n).toBe(0);
        expect(platform.db.get<any>("SELECT error FROM test_executions WHERE id = ?", r.executionId).error).toBe("boom");
    });
});

describe("a skipped variant or environment row keeps its reason (the next run compares with it)", () => {
    it("so no duplicate skipped row is written after expiry; a failed variant run's error still goes", async () => {
        const seed = seedProject(platform, "Skips");
        const t = addTest(platform, seed, "Variants", "web");
        const SKIP = "This test does not run on WebKit: it uses a file upload.";
        const skipped = addRun(platform, seed, t, { daysAgo: 20, status: "failed", now: NOW, variant: "webkit" });
        platform.db.run("UPDATE test_executions SET status = 'skipped', error = ? WHERE id = ?", SKIP, skipped.executionId);
        const envSkipped = addRun(platform, seed, t, { daysAgo: 20, status: "failed", now: NOW, environment: "production" });
        platform.db.run("UPDATE test_executions SET status = 'skipped', error = ? WHERE id = ?", SKIP, envSkipped.executionId);
        const failed = addRun(platform, seed, t, { daysAgo: 20, status: "failed", now: NOW, variant: "firefox" });

        const policy = retentionStore(platform).effective(seed.projectId);
        const r = await pruneProject(platform, seed.projectId, policy, "scheduled", NOW);
        expect(r.runs).toBe(1);
        const error = (id: string) => platform.db.get<any>("SELECT error FROM test_executions WHERE id = ?", id).error;
        expect(error(skipped.executionId)).toBe(SKIP);
        expect(error(envSkipped.executionId)).toBe(SKIP);
        expect(error(failed.executionId)).toBeNull();
        expect(isRepeatedSkip(platform.db, t.id, "webkit", SKIP)).toBe(true);
        expect(await pruneProject(platform, seed.projectId, policy, "manual", NOW)).toMatchObject({ runs: 0, records: 0 });
    });
});

describe("needs-review findings keep their reason whole", () => {
    it("however old the run, a test waiting for review keeps every word of its reason", async () => {
        const seed = seedProject(platform, "Review stays");
        const t = addTest(platform, seed, "Headers", "web");
        addRun(platform, seed, t, { daysAgo: 300, status: "failed", now: NOW });
        platform.db.run("UPDATE test_cases SET validation_status = 'NEEDS_REVIEW', validation_reason = ?, updated_at = ? WHERE id = ?", REASONS.security, ago(300), t.id);
        await pruneProject(platform, seed.projectId, retentionStore(platform).effective(seed.projectId), "scheduled", NOW);
        expect(platform.db.get<any>("SELECT validation_reason FROM test_cases WHERE id = ?", t.id).validation_reason).toBe(REASONS.security);
    });
});

describe("AI agent runs: summaries and reasoning expire, the preview counts exactly what the pass clears", () => {
    it("clears agent_runs.summary and objective_runs reasoning / stop reason past their period; verdicts, approvals and history stay", async () => {
        const seed = seedProject(platform, "Agent runs");
        const oldJob = job(seed, "COMPLETED", 31, null);
        const youngJob = job(seed, "COMPLETED", 3, null);
        const authoring = (jobId: string, summary: string | null) => {
            const id = `arun-${++n}`;
            platform.db.run("INSERT INTO agent_runs (id, job_id, role, subject, status, summary, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?)", id, jobId, "author", "WEB-001", "DONE", summary, ago(31), ago(31));
            return id;
        };
        const oldAuthor = authoring(oldJob, `Wrote the test after reading ${PAGE}`);
        const oldEmpty = authoring(oldJob, null);
        const youngAuthor = authoring(youngJob, `Wrote it: ${PAGE}`);
        const failedRun = objectiveRun(seed, "failed", 8); // reasoning "It worked", a step and an approval
        platform.db.run("UPDATE objective_runs SET stop_reason = ? WHERE id = ?", `The job behind this run ended: ${PAGE}`, failedRun);
        const stopped = objectiveRun(seed, "inconclusive", 8);
        platform.db.run("UPDATE objective_runs SET state = 'stopped', stop_reason = 'A person stopped this run.' WHERE id = ?", stopped);
        const young = objectiveRun(seed, "failed", 2);
        const approvalsBefore = JSON.stringify(platform.db.all("SELECT * FROM objective_run_approvals ORDER BY id"));

        const policy = retentionStore(platform).effective(seed.projectId);
        const preview = publicPlan(policy, planFor(platform, seed.projectId, policy, NOW));
        expect(preview.agentRuns).toBe(3); // the old authoring summary, the failed run, the stopped run's reasoning

        const r = await pruneProject(platform, seed.projectId, policy, "manual", NOW);
        expect(r.agentRuns).toBe(preview.agentRuns);
        expect(r.records).toBe(preview.records);

        const summary = (id: string) => platform.db.get<any>("SELECT summary, status, role FROM agent_runs WHERE id = ?", id);
        expect(summary(oldAuthor)).toEqual({ summary: DETAILS_EXPIRED, status: "DONE", role: "author" });
        expect(summary(oldEmpty).summary).toBeNull();
        expect(summary(youngAuthor).summary).toContain("4471");
        const run = (id: string) => platform.db.get<any>("SELECT verdict, state, reasoning, stop_reason, objective FROM objective_runs WHERE id = ?", id);
        expect(run(failedRun)).toEqual({ verdict: "failed", state: "finished", reasoning: DETAILS_EXPIRED, stop_reason: DETAILS_EXPIRED, objective: "Buy a hat" });
        expect(run(stopped)).toEqual({ verdict: "inconclusive", state: "stopped", reasoning: DETAILS_EXPIRED, stop_reason: "A person stopped this run.", objective: "Buy a hat" });
        expect(run(young).reasoning).toBe("It worked");
        expect(JSON.stringify(platform.db.all("SELECT * FROM objective_run_approvals ORDER BY id"))).toBe(approvalsBefore);
        // Really gone from the database: no row of either table holds the old page text.
        const leftover = platform.db.all<any>("SELECT summary AS t FROM agent_runs WHERE job_id = ? UNION ALL SELECT reasoning FROM objective_runs WHERE id IN (?, ?) UNION ALL SELECT stop_reason FROM objective_runs WHERE id IN (?, ?)", oldJob, failedRun, stopped, failedRun, stopped);
        for (const row of leftover) expect(String(row.t ?? "")).not.toContain("4471");

        const again = publicPlan(policy, planFor(platform, seed.projectId, policy, NOW));
        expect(again).toMatchObject({ agentRuns: 0, records: 0 });
        expect(await pruneProject(platform, seed.projectId, policy, "manual", NOW)).toMatchObject({ agentRuns: 0, records: 0 });
    });
});

describe("first-deploy grace (14 days from the first start with retention)", () => {
    it("the first start records the time; a restart and a second deployment (new process, same database) keep it", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-retention-grace-"));
        const open = () => bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        try {
            const started = Date.now();
            const one = open();
            const first = retentionStart(one.db)!;
            expect(first).toBeGreaterThanOrEqual(started - 1000);
            expect(first).toBeLessThanOrEqual(Date.now());
            one.db.close();
            // A restart, then a later deployment: new processes over the same database, and an explicit later call.
            for (let i = 0; i < 2; i++) {
                const next = open();
                expect(retentionStart(next.db)).toBe(first);
                expect(recordRetentionStart(next.db, first + 30 * DAY)).toBe(first);
                expect(next.db.get<any>("SELECT COUNT(*) AS n FROM auth_settings WHERE key = ?", RETENTION_START_KEY).n).toBe(1);
                next.db.close();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a first-start row that cannot be read means the grace starts now, and the row is rewritten (never: no grace)", async () => {
        const original = platform.db.get<any>("SELECT value_json FROM auth_settings WHERE key = ?", RETENTION_START_KEY).value_json;
        const read = () => platform.db.get<any>("SELECT value_json FROM auth_settings WHERE key = ?", RETENTION_START_KEY).value_json as string;
        try {
            const seed = seedProject(platform, "Damaged grace");
            const t = addTest(platform, seed, "Old run", "web");
            const run = addRun(platform, seed, t, { daysAgo: 30, status: "failed", files: [{ kind: "screenshot" }] });
            const policy = retentionStore(platform).effective(seed.projectId);
            for (const damaged of ["{not json", JSON.stringify("yesterday-ish"), "12", "null", JSON.stringify("1970-01-01T00:00:00.000Z"), ""]) {
                platform.db.run("UPDATE auth_settings SET value_json = ? WHERE key = ?", damaged, RETENTION_START_KEY);
                const before = Date.now();
                // The preview reads it as a grace that starts now: the 30-day-old file of a failed run (7 days) is held, not listed to go.
                const shown = publicPlan(policy, planFor(platform, seed.projectId, policy, Date.now()));
                expect(shown, damaged).toMatchObject({ files: 0, grace: 1 });
                const repaired = Date.parse(JSON.parse(read()) as string);
                expect(repaired, damaged).toBeGreaterThanOrEqual(before);
                expect(repaired, damaged).toBeLessThanOrEqual(Date.now());
                expect(shown.graceUntil).toBe(new Date(repaired + 14 * DAY).toISOString());
                // Rewritten once: later reads, a later start and the real pass all agree, and the file is still there.
                expect(retentionStart(platform.db)).toBe(repaired);
                expect(recordRetentionStart(platform.db, repaired + 30 * DAY)).toBe(repaired);
                expect(await pruneProject(platform, seed.projectId, policy, "manual", Date.now())).toMatchObject({ files: 0 });
                expect(fs.existsSync(run.files[0]!.abs), damaged).toBe(true);
            }
            // Damaged at start-up or before the daily pass: the same repair.
            platform.db.run("UPDATE auth_settings SET value_json = ? WHERE key = ?", "{not json", RETENTION_START_KEY);
            const at = recordRetentionStart(platform.db);
            expect(Math.abs(at - Date.now())).toBeLessThan(5000);
            expect(Date.parse(JSON.parse(read()) as string)).toBe(at);
        } finally {
            platform.db.run("UPDATE auth_settings SET value_json = ? WHERE key = ?", original, RETENTION_START_KEY);
        }
    });

    it("during the grace the size limit does not count held files, and the preview says so", async () => {
        const original = platform.db.get<any>("SELECT value_json FROM auth_settings WHERE key = ?", RETENTION_START_KEY).value_json;
        const DEPLOY = NOW;
        platform.db.run("UPDATE auth_settings SET value_json = ? WHERE key = ?", JSON.stringify(new Date(DEPLOY).toISOString()), RETENTION_START_KEY);
        try {
            const MB = 1024 * 1024;
            const seed = seedProject(platform, "Grace and size");
            const t = addTest(platform, seed, "Run", "web");
            const before = addRun(platform, seed, t, { daysAgo: 3, status: "failed", now: DEPLOY, files: [{ kind: "screenshot" }] });
            const after = addRun(platform, seed, t, { daysAgo: -1, status: "failed", now: DEPLOY, files: [{ kind: "screenshot" }] });
            // Sizes as recorded (the rule reads the recorded size): 12 MB from before the deployment, 2 MB since; the limit is 10 MB.
            platform.db.run("UPDATE artifacts SET created_at = ?, size = ? WHERE execution_id = ?", new Date(DEPLOY - 3 * DAY).toISOString(), 12 * MB, before.executionId);
            platform.db.run("UPDATE artifacts SET created_at = ?, size = ? WHERE execution_id = ?", new Date(DEPLOY + 1 * DAY).toISOString(), 2 * MB, after.executionId);
            const policy = { ...retentionStore(platform).effective(seed.projectId), maxArtifactMB: 10 };
            const at = DEPLOY + 2 * DAY;
            const shown = publicPlan(policy, planFor(platform, seed.projectId, policy, at));
            expect(shown).toMatchObject({ files: 0, grace: 1, heldBytes: 12 * MB, sizeLimitNote: "The 10 MB size limit does not count the 12 MB of files kept for the first 14 days, so they do not push newer files out." });
            expect(await pruneProject(platform, seed.projectId, policy, "manual", at)).toMatchObject({ files: 0 });
            expect(fs.existsSync(after.files[0]!.abs)).toBe(true); // the run made since the deployment keeps its evidence
            expect(fs.existsSync(before.files[0]!.abs)).toBe(true);
            // No limit set, or nothing held: no such line.
            expect(publicPlan({ ...policy, maxArtifactMB: null }, planFor(platform, seed.projectId, { ...policy, maxArtifactMB: null }, at)).sizeLimitNote).toBeNull();
        } finally {
            platform.db.run("UPDATE auth_settings SET value_json = ? WHERE key = ?", original, RETENTION_START_KEY);
        }
    });

    it("a file older than 7 days from before the first deployment survives day 13 and goes after day 14; a newer file follows the normal rules", async () => {
        const original = platform.db.get<any>("SELECT value_json FROM auth_settings WHERE key = ?", RETENTION_START_KEY).value_json;
        // The first deployment is at NOW (the fixed clock); the earlier rows were stored before it.
        const DEPLOY = NOW;
        platform.db.run("UPDATE auth_settings SET value_json = ? WHERE key = ?", JSON.stringify(new Date(DEPLOY).toISOString()), RETENTION_START_KEY);
        try {
            const seed = seedProject(platform, "Grace");
            const t = addTest(platform, seed, "Old run", "web");
            const before = addRun(platform, seed, t, { daysAgo: 10, status: "failed", now: DEPLOY, files: [{ kind: "screenshot" }] });
            const after = addRun(platform, seed, t, { daysAgo: -1, status: "failed", now: DEPLOY, files: [{ kind: "screenshot" }] });
            // Text from before the deployment too: a failed job with an event, a test reason, an agent run with a step, an authoring summary.
            const oldJob = job(seed, "FAILED", 10, `Validation interrupted: ${PAGE}`);
            platform.db.run("INSERT INTO agent_runs (id, job_id, role, subject, status, summary, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?)", "arun-grace", oldJob, "author", "WEB-001", "DONE", `Read ${PAGE}`, ago(10), ago(10));
            const reasoned = addTest(platform, seed, "Old reason", "web"); // its own test: a reason is as young as its test's latest run
            const reasonedRun = addRun(platform, seed, reasoned, { daysAgo: 10, status: "failed", now: DEPLOY });
            platform.db.run("UPDATE test_cases SET validation_status = 'FAILED_VALIDATION', validation_reason = ?, updated_at = ? WHERE id = ?", REASONS.plain, ago(10), reasoned.id);
            const oldRun = objectiveRun(seed, "failed", 10);
            platform.db.run("INSERT INTO run_summaries (job_id, project_id, mode, trigger_kind, job_status, finished_at, total, validated, needs_review, failed, flaky, results_json, diff_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", oldJob, seed.projectId, "validate", "manual", "FAILED", ago(10), 1, 0, 0, 1, 0, JSON.stringify([{ id: t.id, s: "f", why: PAGE }]), JSON.stringify({ jobError: PAGE }));
            const text = () =>
                JSON.stringify([
                    platform.db.get("SELECT error FROM generation_jobs WHERE id = ?", oldJob),
                    platform.db.all("SELECT message, data_json FROM agent_events WHERE job_id = ? ORDER BY id", oldJob),
                    platform.db.get("SELECT summary FROM agent_runs WHERE id = 'arun-grace'"),
                    platform.db.get("SELECT validation_reason FROM test_cases WHERE id = ?", reasoned.id),
                    platform.db.get("SELECT error FROM test_executions WHERE id = ?", reasonedRun.executionId),
                    platform.db.get("SELECT reasoning FROM objective_runs WHERE id = ?", oldRun),
                    platform.db.all("SELECT detail, url FROM objective_run_steps WHERE run_id = ?", oldRun),
                    platform.db.get("SELECT error FROM test_executions WHERE id = ?", before.executionId),
                    platform.db.get("SELECT results_json, diff_json FROM run_summaries WHERE job_id = ?", oldJob),
                ]);
            const textBefore = text();
            const stored = (r: typeof before, at: number) => platform.db.run("UPDATE artifacts SET created_at = ? WHERE execution_id = ?", new Date(at).toISOString(), r.executionId);
            stored(before, DEPLOY - 10 * DAY);
            stored(after, DEPLOY + 1 * DAY);
            const policy = retentionStore(platform).effective(seed.projectId);

            // Day 9 after the deployment: the newer run is 8 days old and goes (normal rules); the older one is kept by the grace.
            const day9 = publicPlan(policy, planFor(platform, seed.projectId, policy, DEPLOY + 9 * DAY));
            expect(day9).toMatchObject({ files: 1, grace: 1, graceNote: "1 file stored before retention was first switched on is kept for the first 14 days.", graceUntil: new Date(DEPLOY + 14 * DAY).toISOString() });
            // Nothing from before the deployment is cleared either; the preview says how many records wait, and counts only what the pass clears now.
            expect(day9.graceRecords).toBeGreaterThanOrEqual(8);
            expect(day9.graceRecordsNote).toBe(`The details of ${day9.graceRecords} records from before retention was first switched on are kept for the first 14 days too.`);
            expect(day9).toMatchObject({ records: 0, agentRuns: 0, summaries: 0, runs: 1 }); // the one run made after the deployment
            const first = await pruneProject(platform, seed.projectId, policy, "manual", DEPLOY + 9 * DAY);
            expect(first).toMatchObject({ records: 0, agentRuns: 0, summaries: 0, runs: 1 });
            expect(text()).toBe(textBefore);
            expect(platform.db.get<any>("SELECT error FROM test_executions WHERE id = ?", after.executionId).error).toBeNull();
            expect(fs.existsSync(after.files[0]!.abs)).toBe(false);
            expect(fs.existsSync(before.files[0]!.abs)).toBe(true);

            await pruneProject(platform, seed.projectId, policy, "manual", DEPLOY + 13 * DAY);
            expect(fs.existsSync(before.files[0]!.abs)).toBe(true); // day 13: still kept
            await pruneProject(platform, seed.projectId, policy, "manual", DEPLOY + 14 * DAY);
            expect(fs.existsSync(before.files[0]!.abs)).toBe(true); // exactly 14 days: still kept
            expect(text()).toBe(textBefore);
            const due = publicPlan(policy, planFor(platform, seed.projectId, policy, DEPLOY + 14 * DAY + 60_000));
            expect(due).toMatchObject({ grace: 0, graceRecords: 0, graceUntil: null });
            const r = await pruneProject(platform, seed.projectId, policy, "manual", DEPLOY + 14 * DAY + 60_000);
            expect(r.files).toBe(1);
            expect(r).toMatchObject({ records: due.records, agentRuns: due.agentRuns, summaries: due.summaries, runs: due.runs });
            expect(r.records + r.summaries + r.runs).toBe(day9.graceRecords);
            expect(text()).not.toContain("4471");
            expect(fs.existsSync(before.files[0]!.abs)).toBe(false); // after day 14: the normal policy
        } finally {
            platform.db.run("UPDATE auth_settings SET value_json = ? WHERE key = ?", original, RETENTION_START_KEY);
        }
    });
});
