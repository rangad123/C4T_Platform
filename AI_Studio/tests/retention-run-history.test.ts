/**
 * Retention and the run-history rows (approved policy), against a real platform (database, artifact store on disk, routes
 * through server.inject; no browser, no model, no listening port). The clock is a fixed `now` handed to the retention pass.
 *  - fake-clock expiry: failed runs' files after 7 days, passing runs' evidence (footprint) after 30; strictly more than N days
 *  - the run rows stay (id, test, outcome, timing), but their failure text (run error, step errors) and old run summaries' reasons
 *    are cleared in the same pass that deletes the files; a run inside its period keeps everything; a second pass changes nothing
 *  - the files really leave the disk, the evidence record says it expired, the preview counts the runs it would clear
 *  - retention off clears nothing
 *  - restore: a saved policy that was off comes back on, a backup without a policy comes back on, a hand-edited "enabled": false
 *    is ignored, and the server's limits hold a restored policy
 *  - accepting a visual change whose screenshots expired (or went missing) is refused with 409 and a sentence; nothing is accepted
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { formatDate } from "../src/engine/retention/format.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { RetentionStore } from "../src/platform/retention-store.js";
import { pruneProject, retentionStore, runScheduledRetention } from "../src/platform/retention-runner.js";
import { buildServer } from "../src/platform/server.js";
import { addBaseline, addRun, addTest, DAY, exists, pastGrace, type Seed, seedProject, type SeedTest } from "./fixtures/retention-seed.js";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-retention-history-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    pastGrace(platform); // an installation long past its first-deploy grace (the grace itself: retention-other-records.test.ts)
    server = await buildServer(platform);
}, 60_000);
afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown, app = server) {
    const isBuffer = Buffer.isBuffer(body);
    const res = await app.inject({ method, url, headers: isBuffer ? { "content-type": "application/octet-stream" } : {}, payload: body === undefined ? undefined : (body as never) });
    const text = res.rawPayload.toString("utf8");
    return { status: res.statusCode, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text, raw: res.rawPayload };
}

// A fixed clock 60 days back: every run is seeded relative to it and the pass runs at it (the preview, at the real clock, sees all as old).
const NOW = Math.floor((Date.now() - 60 * DAY) / DAY) * DAY + 12 * 3_600_000;
const NOW_DATE = formatDate(NOW);
const PAGE_TEXT = "Welcome back, shopper 4471 at https://shop.example/api/orders?id=9";

function stepRows(executionId: string, failedError: string | null) {
    platform.db.run("INSERT INTO test_execution_steps (id, execution_id, idx, title, status, error) VALUES (?,?,?,?,?,?)", `${executionId}-s0`, executionId, 0, "1. Open the shop", "passed", null);
    platform.db.run("INSERT INTO test_execution_steps (id, execution_id, idx, title, status, error) VALUES (?,?,?,?,?,?)", `${executionId}-s1`, executionId, 1, "2. Verify the greeting", failedError ? "failed" : "passed", failedError);
}

function run(seed: Seed, t: SeedTest, daysAgo: number, status: "passed" | "failed", kinds: string[]) {
    const r = addRun(platform, seed, t, { daysAgo, status, now: NOW, files: kinds.map((kind) => ({ kind, size: 400 })) });
    // The failure text a real run stores: it quotes the page and the addresses it saw.
    platform.db.run("UPDATE test_executions SET error = ? WHERE id = ?", `Expected the greeting, the page said: ${PAGE_TEXT}`, r.executionId);
    stepRows(r.executionId, `Timed out: ${PAGE_TEXT}`);
    return r;
}

const execRow = (id: string) => platform.db.get<any>("SELECT id, test_case_id, status, attempt, duration_ms, started_at, finished_at, error FROM test_executions WHERE id = ?", id);
const stepErrors = (id: string) => platform.db.all<{ error: string | null }>("SELECT error FROM test_execution_steps WHERE execution_id = ? ORDER BY idx", id).map((s) => s.error);
const anyPageText = (projectId: string) =>
    JSON.stringify([
        platform.db.all("SELECT e.* FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ?", projectId),
        platform.db.all("SELECT s.* FROM test_execution_steps s JOIN test_executions e ON e.id = s.execution_id JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ?", projectId),
        platform.db.all("SELECT * FROM run_summaries WHERE project_id = ?", projectId),
    ]).includes("shopper 4471");

function summary(projectId: string, jobId: string, daysAgo: number) {
    const results = [
        { k: "WEB-001", id: "x", key: "WEB-001", title: "Greeting", s: "f", why: `Broken: ${PAGE_TEXT}` },
        { k: "WEB-002", id: "y", key: "WEB-002", title: "Cart", s: "p" },
    ];
    const diff = { newFindings: [{ key: "WEB-001", title: "Greeting", id: "x", status: "f", reason: `Broken: ${PAGE_TEXT}`, was: "p" }], fixed: [], jobError: `Could not reach ${PAGE_TEXT}` };
    platform.db.run(
        `INSERT INTO run_summaries (job_id, project_id, mode, trigger_kind, schedule_id, job_status, finished_at, total, validated, needs_review, failed, flaky, pass_rate, duration_ms, results_json, diff_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        jobId, projectId, "rerun", "manual", null, "COMPLETED", new Date(NOW - daysAgo * DAY).toISOString(), 2, 1, 0, 1, 0, 50, 1000, JSON.stringify(results), JSON.stringify(diff),
    );
}

describe("run rows stay, their evidence and failure text expire with the files (fake clock, 7 / 30 days)", () => {
    let seed: Seed;
    let t: SeedTest;
    let failedOld: ReturnType<typeof run>;
    let failedYoung: ReturnType<typeof run>;
    let passedOld: ReturnType<typeof run>;
    let passedYoung: ReturnType<typeof run>;
    let before: Record<string, any>;

    it("seeds runs on both sides of each period, and the preview counts what would be cleared", async () => {
        seed = seedProject(platform, "Run history");
        t = addTest(platform, seed, "The shop greets the shopper", "web");
        failedOld = run(seed, t, 7.1, "failed", ["evidence", "screenshot", "trace", "video"]);
        failedYoung = run(seed, t, 6.9, "failed", ["evidence", "screenshot", "trace"]);
        passedOld = run(seed, t, 30.1, "passed", ["evidence"]); // its footprint
        passedYoung = run(seed, t, 29.9, "passed", ["evidence"]);
        summary(seed.projectId, "job-old", 7.5);
        summary(seed.projectId, "job-young", 6.5);
        before = Object.fromEntries([failedOld, failedYoung, passedOld, passedYoung].map((r) => [r.executionId, execRow(r.executionId)]));

        const preview = (await call("POST", `/api/projects/${seed.projectId}/retention/preview`, {})).body;
        // the preview runs at the real clock, where every seeded run is old: it says the details go too
        expect(preview.runs).toBe(4);
        expect(preview.summaries).toBe(2);
        expect(preview.details).toBe("The failure details of 4 runs and 2 run summaries past the retention period are cleared too. The runs stay in the history with their outcome and timing.");
    });

    it("deletes the expired files from disk, keeps the run rows, clears only the expired runs' failure text and old summaries' reasons", async () => {
        const policy = retentionStore(platform).effective(seed.projectId);
        expect(policy).toMatchObject({ enabled: true, keepDays: 30, keepFailedDays: 7 });
        const r = await pruneProject(platform, seed.projectId, policy, "scheduled", NOW);
        expect(r).toMatchObject({ errors: 0, runs: 2, summaries: 1 });

        // files: failed > 7 days and passed > 30 days are gone from the disk; the younger ones stay
        expect(failedOld.files.some(exists)).toBe(false);
        expect(passedOld.files.some(exists)).toBe(false);
        expect(failedYoung.files.every(exists)).toBe(true); // its evidence record, screenshot and trace, inside 7 days
        expect(passedYoung.files.every(exists)).toBe(true); // its footprint, inside 30 days
        for (const f of [...failedOld.files, ...passedOld.files]) {
            expect(platform.db.get<any>("SELECT pruned_at FROM artifacts WHERE id = ?", f.id)!.pruned_at).toBe(new Date(NOW).toISOString());
        }

        // rows: every run is still there with its id, test, outcome and timing
        for (const id of Object.keys(before)) {
            const { error: _e, ...kept } = before[id];
            const { error, ...now } = execRow(id);
            expect(now).toEqual(kept);
            const expired = id === failedOld.executionId || id === passedOld.executionId;
            expect(error === null, id).toBe(expired);
            expect(stepErrors(id).every((x) => x === null), id).toBe(expired);
        }
        expect(stepErrors(failedYoung.executionId)[1]).toContain("shopper 4471");
        expect(platform.db.all("SELECT title, status FROM test_execution_steps WHERE execution_id = ? ORDER BY idx", failedOld.executionId)).toEqual([
            { title: "1. Open the shop", status: "passed" },
            { title: "2. Verify the greeting", status: "failed" },
        ]);

        // run summaries: the old one keeps its counts and outcomes, loses its reasons; the young one is untouched
        const old = platform.db.get<any>("SELECT * FROM run_summaries WHERE job_id = 'job-old'")!;
        expect(old).toMatchObject({ total: 2, validated: 1, failed: 1, pass_rate: 50 });
        expect(JSON.parse(old.results_json)).toEqual([
            { k: "WEB-001", id: "x", key: "WEB-001", title: "Greeting", s: "f" },
            { k: "WEB-002", id: "y", key: "WEB-002", title: "Cart", s: "p" },
        ]);
        expect(JSON.parse(old.diff_json)).toEqual({ newFindings: [{ key: "WEB-001", title: "Greeting", id: "x", status: "f", was: "p" }], fixed: [], jobError: null });
        expect(platform.db.get<any>("SELECT results_json FROM run_summaries WHERE job_id = 'job-young'")!.results_json).toContain("shopper 4471");
    });

    it("the evidence record and the footprint say they expired; a young record still reads", async () => {
        const failedView = (await call("GET", `/api/tests/${t.id}/evidence?executionId=${failedOld.executionId}`)).body;
        expect(failedView).toMatchObject({ available: false });
        expect(failedView.message).toContain(`This list of network calls and console messages expired and was removed on ${NOW_DATE}`);
        const passedView = (await call("GET", `/api/tests/${t.id}/evidence?executionId=${passedOld.executionId}`)).body;
        expect(passedView.message).toContain(`expired and was removed on ${NOW_DATE}`);
        expect(passedView.footprint).toBeUndefined();
        expect((await call("GET", `/api/artifacts/${failedOld.files.find((f) => f.kind === "screenshot")!.id}`)).status).toBe(410);
        expect((await call("GET", `/api/artifacts/${failedYoung.files.find((f) => f.kind === "screenshot")!.id}`)).status).toBe(200);
        // the test page lists every run, with no failure text for the expired one
        const detail = (await call("GET", `/api/tests/${t.id}`)).body;
        expect(detail.executions.map((e: any) => e.id).sort()).toEqual(Object.keys(before).sort());
        expect(JSON.stringify(detail.executions.find((e: any) => e.id === failedOld.executionId))).not.toContain("shopper 4471");
    });

    it("a second pass at the same clock changes nothing; at day 8 and day 31 the young runs follow", async () => {
        expect(await pruneProject(platform, seed.projectId, retentionStore(platform).effective(seed.projectId), "scheduled", NOW)).toMatchObject({ files: 0, runs: 0, summaries: 0 });
        const later = await pruneProject(platform, seed.projectId, retentionStore(platform).effective(seed.projectId), "scheduled", NOW + 1.2 * DAY);
        expect(later).toMatchObject({ runs: 2, summaries: 1 }); // the young failed run (8.1 days) and young passed run (31.1 days)
        expect(failedYoung.files.some(exists)).toBe(false);
        expect(passedYoung.files.some(exists)).toBe(false);
        expect(anyPageText(seed.projectId)).toBe(false);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM test_executions WHERE test_case_id = ?", t.id)!.n).toBe(4);
    });

    it("the manual run reports the cleared runs in words", async () => {
        const s = seedProject(platform, "Manual words");
        const tt = addTest(platform, s, "Words", "web");
        addRun(platform, s, tt, { daysAgo: 9, status: "failed", files: [{ kind: "screenshot" }] });
        const r = (await call("POST", `/api/projects/${s.projectId}/retention/run`, { confirm: true })).body;
        expect(r).toMatchObject({ files: 1, runs: 1, sentence: "Removed 1 file (1000 bytes).", details: "Cleared the failure details of 1 run; the runs stay in the history." });
    });

    it("with retention off, nothing is removed and no run loses its details", async () => {
        const s = seedProject(platform, "Off keeps details");
        const tt = addTest(platform, s, "Kept", "web");
        const r = run(s, tt, 40, "failed", ["screenshot"]);
        expect((await call("PUT", `/api/projects/${s.projectId}/retention`, { enabled: false })).status).toBe(200);
        expect((await runScheduledRetention(platform, NOW)).find((x) => x.projectId === s.projectId)).toBeUndefined();
        expect(r.files.every(exists)).toBe(true);
        expect(execRow(r.executionId)!.error).toContain("shopper 4471");
    });
});

describe("restore never brings retention back switched off", () => {
    const backupOf = async (projectId: string) => {
        const r = await call("GET", `/api/projects/${projectId}/backup`);
        expect(r.status).toBe(200);
        return r.raw;
    };
    const restore = async (zip: Buffer | Uint8Array, app = server) => {
        const r = await call("POST", "/api/projects/restore", Buffer.from(zip), app);
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        return r.body.project.id as string;
    };

    it("a saved policy that was off comes back on, with its periods", async () => {
        const s = seedProject(platform, "Was off");
        addTest(platform, s);
        expect((await call("PUT", `/api/projects/${s.projectId}/retention`, { enabled: false, keepDays: 40, keepFailedDays: 10 })).status).toBe(200);
        const id = await restore(await backupOf(s.projectId));
        expect((await call("GET", `/api/projects/${id}/retention`)).body).toMatchObject({ source: "project", policy: { enabled: true, keepDays: 40, keepFailedDays: 10 } });
        expect(retentionStore(platform).effective(s.projectId).enabled).toBe(false); // the source project is unchanged
    });

    it("a backup without a policy comes back on (the default)", async () => {
        const s = seedProject(platform, "No policy");
        addTest(platform, s);
        const id = await restore(await backupOf(s.projectId));
        expect((await call("GET", `/api/projects/${id}/retention`)).body).toMatchObject({ source: "default", policy: { enabled: true, keepDays: 30, keepFailedDays: 7 } });
        expect(new RetentionStore(platform.db).saved(id)).toBeUndefined();
    });

    it("a hand-edited backup that says enabled: false still comes back on", async () => {
        const s = seedProject(platform, "Edited off");
        addTest(platform, s);
        expect((await call("PUT", `/api/projects/${s.projectId}/retention`, { keepDays: 45 })).status).toBe(200);
        const files = unzipSync(new Uint8Array(await backupOf(s.projectId)));
        const doc = JSON.parse(strFromU8(files["project.json"]!));
        expect(doc.retention).toMatchObject({ keepDays: 45 });
        files["project.json"] = strToU8(JSON.stringify({ ...doc, retention: { ...doc.retention, enabled: false } }));
        const id = await restore(zipSync(files));
        expect(retentionStore(platform).effective(id)).toMatchObject({ enabled: true, keepDays: 45 });
    });

    it("the server's limits hold a restored policy (and refuse a longer one in the form)", async () => {
        const s = seedProject(platform, "Long periods");
        addTest(platform, s);
        expect((await call("PUT", `/api/projects/${s.projectId}/retention`, { enabled: false, keepDays: 200, keepFailedDays: 300 })).status).toBe(200);
        const zip = await backupOf(s.projectId);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-retention-limits-"));
        const limited = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", RETENTION_MAX_METADATA_DAYS: "60", RETENTION_MAX_FAILED_MEDIA_DAYS: "14" }));
        const app = await buildServer(limited);
        try {
            const id = await restore(zip, app);
            const r = (await call("GET", `/api/projects/${id}/retention`, undefined, app)).body;
            expect(r).toMatchObject({ source: "project", heldToLimits: true, policy: { enabled: true, keepDays: 60, keepFailedDays: 14 } });
            const over = await call("PUT", `/api/projects/${id}/retention`, { keepFailedDays: 15 }, app);
            expect(over.status).toBe(400);
            expect(over.body.error).toBe("This server keeps traces, recordings and screenshots of failed runs for at most 14 days.");
        } finally {
            await app.close();
            limited.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("accepting a visual change whose screenshots expired", () => {
    const SENTENCE = "The screenshots of the latest run are no longer kept (they expired or are missing), so there is nothing to accept. Run the test again, then accept the new screenshots.";

    function visualTest(seed: Seed, title: string): SeedTest {
        const t = addTest(platform, seed, title, "web");
        const spec = TestSpecSchema.parse({ testId: t.key, title, kind: "web", category: "Visual", type: "visual", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "screenshot", expected: 100 }] });
        platform.db.run("UPDATE test_cases SET spec_json = ? WHERE id = ?", JSON.stringify(spec), t.id);
        return t;
    }
    const baselines = (testId: string) => platform.db.all("SELECT id FROM artifacts WHERE test_case_id = ? AND kind = 'baseline'", testId);

    it("refuses with 409 and a sentence once retention removed them; nothing is accepted and no run starts", async () => {
        const seed = seedProject(platform, "Visual expired");
        const t = visualTest(seed, "Home looks right");
        const r = addRun(platform, seed, t, { daysAgo: 8, status: "failed", files: [{ kind: "visual-actual" }, { kind: "visual-diff" }] });
        await runScheduledRetention(platform, Date.now());
        expect(r.files.some(exists)).toBe(false);
        const jobsBefore = platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generation_jobs WHERE project_id = ?", seed.projectId)!.n;

        const res = await call("POST", `/api/tests/${t.id}/baseline`);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe(SENTENCE);
        expect(baselines(t.id)).toEqual([]);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generation_jobs WHERE project_id = ?", seed.projectId)!.n).toBe(jobsBefore);
    });

    it("refuses the same way when one of the screenshots is missing from the disk (not pruned)", async () => {
        const seed = seedProject(platform, "Visual missing");
        const t = visualTest(seed, "Home looks right");
        const r = addRun(platform, seed, t, { daysAgo: 1, status: "failed", files: [{ kind: "visual-actual" }, { kind: "visual-actual" }] });
        fs.rmSync(r.files[1]!.abs);
        const res = await call("POST", `/api/tests/${t.id}/baseline`);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe(SENTENCE);
        expect(baselines(t.id)).toEqual([]); // the first, still present, was not accepted alone
    });

    it("is all or nothing: a screenshot removed after the check leaves every earlier baseline as it was (409, nothing accepted)", async () => {
        const seed = seedProject(platform, "Visual race");
        const t = visualTest(seed, "Home looks right");
        const before = addBaseline(platform, seed, t, "visual.png");
        const beforeBytes = fs.readFileSync(before.abs);
        const r = addRun(platform, seed, t, { daysAgo: 1, status: "failed", files: [{ kind: "visual-actual" }, { kind: "visual-actual" }] });
        // Retention removes the second screenshot as soon as the first one is read (after the route's check that both are there).
        const store = platform.store as unknown as Record<"copy" | "getBytes", (...a: unknown[]) => Promise<unknown>>;
        const original = { copy: store.copy, getBytes: store.getBytes };
        const removeSecond = () => fs.rmSync(r.files[1]!.abs, { force: true });
        store.copy = async (...a: unknown[]) => (removeSecond(), original.copy.apply(platform.store, a));
        store.getBytes = async (...a: unknown[]) => (removeSecond(), original.getBytes.apply(platform.store, a));
        try {
            const res = await call("POST", `/api/tests/${t.id}/baseline`);
            expect(res.status).toBe(409);
            expect(res.body.error).toBe(SENTENCE);
        } finally {
            Object.assign(store, original);
        }
        expect(baselines(t.id)).toEqual([{ id: before.id }]);
        expect(fs.readFileSync(before.abs).equals(beforeBytes)).toBe(true); // the approved baseline was not replaced by the first screenshot
    });

    it("still accepts screenshots that are there (control)", async () => {
        const seed = seedProject(platform, "Visual present");
        const t = visualTest(seed, "Home looks right");
        addRun(platform, seed, t, { daysAgo: 1, status: "failed", files: [{ kind: "visual-actual" }] });
        const res = await call("POST", `/api/tests/${t.id}/baseline`);
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        expect(baselines(t.id)).toHaveLength(1);
    });
});
