/**
 * Storage, retention and backup against a real platform (database, artifact store on disk, HTTP routes through the real server),
 * no browser and no model. Evidence files are real files; their runs carry fake old timestamps.
 *  - retention off removes nothing; a run needs a policy that is on and { confirm: true }; policy bounds
 *  - preview equals run; protected files survive (baselines, latest runs, current failures, issues, releases, pending visual changes);
 *    run history, trends and flaky detection are unchanged; removed files are marked and say so (410, evidence message)
 *  - a running job blocks pruning; the daily pass runs once a day; a file that cannot be removed is logged, not fatal; a path that
 *    leaves the artifact folder is never touched; the platform default
 *  - storage numbers are exact, show no host path, ignore links, and are cached
 *  - backup to restore round trip, secrets never in the zip (every entry, plain / base64 / UTF-16), hostile uploads refused with nothing created
 * Ports: no listening server is needed (server.inject); 5750-5769 are reserved for the UI journey.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BACKUP_FORMAT, BACKUP_KIND } from "../src/engine/retention/backup-model.js";
import { RunbookDefinition } from "../src/engine/runbook/schema.js";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DataSetStore, setScheduleEnvironment } from "../src/platform/environments-store.js";
import { ManualCaseStore } from "../src/platform/manual-case-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RetentionStore } from "../src/platform/retention-store.js";
import { runScheduledRetention } from "../src/platform/retention-runner.js";
import { RunbookStore } from "../src/platform/runbook-store.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { ScheduleStore } from "../src/platform/schedule-store.js";
import { buildServer } from "../src/platform/server.js";
import { forgetUsage } from "../src/platform/storage-usage.js";
import { addBaseline, addRun, addTest, DAY, exists, seedProject, type Seed, type SeedFile } from "./fixtures/retention-seed.js";

// Distinct, greppable values, the same shapes as tests/secret-leak.test.ts.
const SECRETS = {
    password: "LEAKCHECK-Password-7f3a91",
    totp: "KRSXG5CTMVRXEZLUKN2XGZLSOBXXK3DQ",
    apiToken: "LEAKCHECK-ApiToken-c41d82",
    userPassword: "LEAKCHECK-UserPw-5be07c",
    userToken: "LEAKCHECK-UserTok-2a9f63",
    adminPassword: "LEAKCHECK-AdminPw-d8e124",
    adminTotp: "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U",
    adminToken: "LEAKCHECK-AdminTok-91b7ea",
    envPassword: "LEAKCHECK-EnvPw-3c58f1",
    envToken: "LEAKCHECK-EnvTok-e7a204",
    envTotp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    envAuthHeader: "X-Env-Key: LEAKCHECK-EnvHdr-b19d36",
    teamsHook: "LEAKCHECK-TeamsHook-82f1b0",
    notionToken: "LEAKCHECK-NotionTok-4d7e61",
    sentryToken: "LEAKCHECK-SentryTok-b30a8f",
    // places a secret can hide in data a backup does copy
    appUrlKey: "LEAKCHECK-AppUrlKey-1a2b3c",
    openApiToken: "LEAKCHECK-OpenApi-77aa21",
    envVariable: "LEAKCHECK-EnvVar-5d4c3b",
    dataColumn: "LEAKCHECK-DataPw-9f8e7d",
    envUrlUser: "LEAKCHECK-UrlUser-6a5b4c",
};

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;

interface Answer {
    status: number;
    body: any;
    raw: Buffer;
    headers: Record<string, any>;
}
async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, extra: { headers?: Record<string, string>; app?: typeof server } = {}): Promise<Answer> {
    const isBuffer = Buffer.isBuffer(body);
    const res = await (extra.app ?? server).inject({
        method,
        url,
        headers: { ...(isBuffer ? { "content-type": "application/octet-stream" } : {}), ...extra.headers },
        payload: body === undefined ? undefined : (body as never),
    });
    const text = res.rawPayload.toString("utf8");
    return { status: res.statusCode, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text, raw: res.rawPayload, headers: res.headers };
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-retention-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
}, 60_000);
afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const setPolicy = async (projectId: string, patch: Record<string, unknown>) => {
    const r = await call("PUT", `/api/projects/${projectId}/retention`, patch);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
};
const project = (name: string) => seedProject(platform, name);
const ok = (r: Answer, status: number) => {
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    return r;
};

// ═══════════════════════════════════════════════════════════════════════════

describe("retention is off by default and cannot be run by accident", () => {
    let seed: Seed;
    let files: SeedFile[] = [];

    it("a new project has retention off, with nothing scheduled", async () => {
        seed = project("Off by default");
        const t = addTest(platform, seed);
        files = [...Array.from({ length: 4 }, (_, i) => addRun(platform, seed, t, { daysAgo: 100 + i, files: [{ kind: "video", size: 4000 }, { kind: "screenshot" }] }).files).flat(), ...addRun(platform, seed, t, { daysAgo: 1, files: [{ kind: "screenshot" }] }).files];
        const r = await call("GET", `/api/projects/${seed.projectId}/retention`);
        expect(r.status).toBe(200);
        expect(r.body.policy).toMatchObject({ enabled: false, keepDays: 30, keepFailedDays: 90, keepLatestRuns: 5, maxArtifactMB: null });
        expect(r.body.source).toBe("default");
        expect(r.body.platformDefaultDays).toBeNull();
        expect(r.body.recent).toEqual([]);
    });

    it("a preview works while it is off (it shows what turning it on would do) and removes nothing", async () => {
        await setPolicy(seed.projectId, { enabled: false, keepLatestRuns: 1 });
        const r = await call("POST", `/api/projects/${seed.projectId}/retention/preview`);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ enabled: false, files: 8 }); // 4 old runs x (video + screenshot)
        expect(r.body.sentence).toContain("This would remove 8 files");
        expect(files.every(exists)).toBe(true);
    });

    it("a run is refused while it is off, whatever the caller sends", async () => {
        for (const body of [{ confirm: true }, {}, undefined]) {
            const r = await call("POST", `/api/projects/${seed.projectId}/retention/run`, body);
            expect(r.status).toBe(409);
            expect(r.body.error).toContain("switched off");
        }
        expect(files.every(exists)).toBe(true);
    });

    it("a run on a project that is on still needs { confirm: true }", async () => {
        await setPolicy(seed.projectId, { enabled: true });
        for (const body of [undefined, {}, { confirm: false }]) {
            const r = await call("POST", `/api/projects/${seed.projectId}/retention/run`, body);
            expect(r.status).toBe(400);
            expect(r.body.error).toContain("confirm");
        }
        expect((await call("POST", `/api/projects/${seed.projectId}/retention/run`, { confirm: "yes" })).status).toBe(400);
        expect(files.every(exists)).toBe(true);
    });

    it("refuses values outside the limits, with plain messages, and keeps the saved policy", async () => {
        const bad: Array<[Record<string, unknown>, RegExp]> = [
            [{ keepDays: 3 }, /at least 7/],
            [{ keepDays: 400 }, /at most 365/],
            [{ keepFailedDays: 800 }, /at most 730/],
            [{ keepLatestRuns: 0 }, /at least 1/],
            [{ keepLatestRuns: 51 }, /at most 50/],
            [{ keepDays: 100, keepFailedDays: 50 }, /at least as long/],
            [{ maxArtifactMB: 5 }, /at least 10/],
            [{ keepDays: "thirty" }, /./],
            [{ surprise: true }, /Unknown or invalid/],
        ];
        for (const [body, message] of bad) {
            const r = await call("PUT", `/api/projects/${seed.projectId}/retention`, body);
            expect(r.status, JSON.stringify(body)).toBe(400);
            expect(r.body.error, JSON.stringify(body)).toMatch(message);
        }
        const now = await call("GET", `/api/projects/${seed.projectId}/retention`);
        expect(now.body.policy).toMatchObject({ enabled: true, keepDays: 30, keepFailedDays: 90, keepLatestRuns: 1 });
        expect((await call("GET", `/api/projects/nope/retention`)).status).toBe(404);
        expect((await call("POST", `/api/projects/nope/retention/preview`)).status).toBe(404);
    });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("a run removes exactly what the preview promised, and keeps everything that must stay", () => {
    let seed: Seed;
    const gone: SeedFile[] = [];
    const kept: SeedFile[] = [];
    let before: { trends: string; flaky: string; executions: string; statuses: string };
    let oldWebRun = "";
    let webTestId = "";

    const snapshot = async () => ({
        trends: JSON.stringify((await call("GET", `/api/projects/${seed.projectId}/trends`)).body),
        flaky: JSON.stringify((await call("GET", `/api/projects/${seed.projectId}/flaky`)).body),
        executions: JSON.stringify(platform.db.all("SELECT id, test_case_id, status, started_at, finished_at, attempt, duration_ms FROM test_executions WHERE test_case_id IN (SELECT id FROM test_cases WHERE project_id = ?) ORDER BY id", seed.projectId)),
        statuses: JSON.stringify(platform.db.all("SELECT id, validation_status, validation_reason FROM test_cases WHERE project_id = ? ORDER BY id", seed.projectId)),
    });

    it("seeds a project with every kind of file worth protecting", async () => {
        seed = project("Retention rules");
        const { projectId } = seed;

        // A: old passed runs; only the newest is a "latest run". The three old runs go.
        const a = addTest(platform, seed, "A passes");
        for (const d of [200, 190, 180]) gone.push(...addRun(platform, seed, a, { daysAgo: d, files: [{ kind: "video", size: 5000 }, { kind: "screenshot", size: 300 }] }).files);
        kept.push(...addRun(platform, seed, a, { daysAgo: 1, files: [{ kind: "screenshot", size: 300 }] }).files);

        // B: failing now. Its newest run stays, however it looks; the failed run older than 90 days goes.
        const b = addTest(platform, seed, "B fails");
        gone.push(...addRun(platform, seed, b, { daysAgo: 230, status: "failed", files: [{ kind: "trace", size: 2000 }, { kind: "screenshot", size: 300 }] }).files);
        kept.push(...addRun(platform, seed, b, { daysAgo: 5, status: "failed", files: [{ kind: "trace", size: 2000 }, { kind: "video", size: 3000 }] }).files);

        // C: an approved baseline is never removed
        const c = addTest(platform, seed, "C has a baseline");
        kept.push(addBaseline(platform, seed, c));
        kept.push(...addRun(platform, seed, c, { daysAgo: 1, files: [{ kind: "screenshot" }] }).files);

        // D: an issue was filed from the failed run 150 days ago; the passed run in between goes
        const d = addTest(platform, seed, "D has an issue");
        kept.push(...addRun(platform, seed, d, { daysAgo: 150, status: "failed", files: [{ kind: "screenshot", size: 400 }] }).files);
        gone.push(...addRun(platform, seed, d, { daysAgo: 100, files: [{ kind: "screenshot", size: 400 }] }).files);
        kept.push(...addRun(platform, seed, d, { daysAgo: 1, files: [{ kind: "screenshot", size: 400 }] }).files);
        platform.db.run("INSERT INTO issue_links (id, test_case_id, integration_id, provider, external_id, url, title, created_at) VALUES (?,?,?,?,?,?,?,?)", "il-1", d.id, null, "github", "12", "https://github.example/issues/12", "Fails", new Date(Date.now() - 140 * DAY).toISOString());

        // E: a release was snapshotted 245 days ago; the newest run at that moment stays, the one after it goes
        const e = addTest(platform, seed, "E is in a release");
        kept.push(...addRun(platform, seed, e, { daysAgo: 250, files: [{ kind: "video", size: 800 }] }).files);
        gone.push(...addRun(platform, seed, e, { daysAgo: 240, files: [{ kind: "video", size: 800 }] }).files);
        kept.push(...addRun(platform, seed, e, { daysAgo: 1, files: [{ kind: "video", size: 800 }] }).files);
        const at = new Date(Date.now() - 245 * DAY).toISOString();
        platform.db.run("INSERT INTO releases (id, project_id, name, notes, status, snapshot_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", "rel-1", projectId, "1.0", "", "open", at, at, at);

        // F: a visual change waiting to be accepted
        const f = addTest(platform, seed, "F has a pending visual change");
        kept.push(...addRun(platform, seed, f, { daysAgo: 200, status: "failed", files: [{ kind: "visual-actual", size: 500 }, { kind: "visual-diff", size: 500 }] }).files);
        gone.push(...addRun(platform, seed, f, { daysAgo: 190, status: "failed", files: [{ kind: "screenshot", size: 500 }] }).files);
        kept.push(...addRun(platform, seed, f, { daysAgo: 180, status: "failed", files: [] }).files);

        // G: a web test whose old failed run recorded network calls and console messages
        const g = addTest(platform, seed, "G records evidence", "web");
        webTestId = g.id;
        const oldRun = addRun(platform, seed, g, { daysAgo: 200, status: "failed", files: [{ kind: "evidence", size: 600 }] });
        oldWebRun = oldRun.executionId;
        gone.push(...oldRun.files);
        kept.push(...addRun(platform, seed, g, { daysAgo: 10, status: "failed", files: [{ kind: "evidence", size: 600 }] }).files);

        // H: a browser variant has its own runs: its newest is kept too
        const h = addTest(platform, seed, "H on firefox");
        gone.push(...addRun(platform, seed, h, { daysAgo: 120, variant: "firefox", files: [{ kind: "screenshot", size: 200 }] }).files);
        kept.push(...addRun(platform, seed, h, { daysAgo: 110, variant: "firefox", files: [{ kind: "screenshot", size: 200 }] }).files);
        kept.push(...addRun(platform, seed, h, { daysAgo: 2, files: [{ kind: "screenshot", size: 200 }] }).files);

        // an artifact without a run, and an app model: never removed
        kept.push({ id: platform.repo.addArtifact({ projectId, kind: "app-model", path: `${projectId}/_artifacts/job/app-model.json`, size: 10 }), kind: "app-model", rel: "", abs: "", size: 10 });

        await setPolicy(projectId, { enabled: true, keepDays: 30, keepFailedDays: 90, keepLatestRuns: 1 });
        before = await snapshot();
    });

    it("the preview says what a run would remove: counts, bytes, dates, and ids instead of paths", async () => {
        const r = await call("POST", `/api/projects/${seed.projectId}/retention/preview`);
        expect(r.status).toBe(200);
        const expectedBytes = gone.reduce((n, f) => n + f.size, 0);
        expect(r.body).toMatchObject({ enabled: true, files: gone.length, bytes: expectedBytes });
        expect(r.body.size).toMatch(/KB|bytes/);
        expect(r.body.sentence).toBe(`This would remove ${gone.length} files (${r.body.size}) older than 30 days (90 for failed runs).`);
        expect(new Date(r.body.oldest).getTime()).toBeLessThan(new Date(r.body.newest).getTime());
        expect(r.body.sample.length).toBe(Math.min(20, gone.length));
        expect(r.body.sample.every((s: any) => typeof s.id === "string" && !("path" in s))).toBe(true);
        expect(r.body.byKind.video.files).toBe(gone.filter((f) => f.kind === "video").length);
        expect(r.body.kept["latest-runs"]).toBeGreaterThan(0);
        // exactly the files the test expects, by id
        const ids = new Set(gone.map((f) => f.id));
        expect(r.body.sample.every((s: any) => ids.has(s.id))).toBe(true);
        const text = JSON.stringify(r.body);
        expect(text).not.toContain(dataDir);
        expect(text).not.toContain("generated-tests");
        expect(gone.every(exists)).toBe(true); // a preview removes nothing
        expect(kept.filter((k) => k.abs).every(exists)).toBe(true);
    });

    it("a run removes exactly that: the same files and bytes, from disk, with the rows marked", async () => {
        const preview = (await call("POST", `/api/projects/${seed.projectId}/retention/preview`)).body;
        const run = await call("POST", `/api/projects/${seed.projectId}/retention/run`, { confirm: true });
        expect(run.status).toBe(200);
        expect(run.body).toMatchObject({ files: preview.files, bytes: preview.bytes, errors: 0 });
        expect(run.body.sentence).toBe(`Removed ${preview.files} files (${preview.size}).`);

        for (const f of gone) {
            expect(exists(f), `${f.kind} should be gone`).toBe(false);
            const row = platform.db.get<any>("SELECT pruned_at, pruned_reason FROM artifacts WHERE id = ?", f.id);
            expect(row.pruned_at).toBeTruthy();
            expect(["age", "age-failed", "size-cap"]).toContain(row.pruned_reason);
        }
        for (const k of kept) {
            if (k.abs) expect(exists(k), `${k.kind} ${k.rel} should stay`).toBe(true);
            expect(platform.db.get<any>("SELECT pruned_at FROM artifacts WHERE id = ?", k.id).pruned_at).toBeNull();
        }
        // a second run finds nothing more
        const again = await call("POST", `/api/projects/${seed.projectId}/retention/run`, { confirm: true });
        expect(again.body).toMatchObject({ files: 0, bytes: 0, errors: 0, sentence: "Nothing needed removing." });
    });

    it("run history, trends, flaky detection and test statuses are exactly as before", async () => {
        const after = await snapshot();
        expect(after.executions).toBe(before.executions);
        expect(after.statuses).toBe(before.statuses);
        expect(after.trends).toBe(before.trends);
        expect(after.flaky).toBe(before.flaky);
        expect(JSON.parse(after.executions).length).toBeGreaterThan(15);
    });

    it("the log records the run, and the storage view counts what was removed", async () => {
        const r = await call("GET", `/api/projects/${seed.projectId}/retention`);
        expect(r.body.recent[1]).toMatchObject({ trigger: "manual", files: gone.length, errors: 0 });
        expect(r.body.recent[0]).toMatchObject({ files: 0 });
        const s = await call("GET", `/api/projects/${seed.projectId}/storage`);
        expect(s.body.removed.files).toBe(gone.length);
    });

    it("a removed file answers 410 with an honest sentence; a kept file still downloads", async () => {
        const removed = gone.find((f) => f.kind === "video")!;
        const r = await call("GET", `/api/artifacts/${removed.id}`);
        expect(r.status).toBe(410);
        expect(r.body.error).toMatch(/^This recording was removed to save space on [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/);
        const ok = kept.find((f) => f.kind === "screenshot")!;
        const got = await call("GET", `/api/artifacts/${ok.id}`);
        expect(got.status).toBe(200);
        expect(got.raw.length).toBe(ok.size);
    });

    it("the test page marks removed files, and the evidence view says they were removed", async () => {
        const a = platform.db.get<any>("SELECT test_case_id FROM artifacts WHERE id = ?", gone[0]!.id).test_case_id;
        const detail = (await call("GET", `/api/tests/${a}`)).body;
        const pruned = detail.executions.flatMap((e: any) => e.artifacts).filter((x: any) => x.pruned_at);
        expect(pruned.length).toBeGreaterThan(0);
        expect(detail.executions[0].artifacts.every((x: any) => !x.pruned_at)).toBe(true); // the latest run is intact
        const ev = (await call("GET", `/api/tests/${webTestId}/evidence?executionId=${oldWebRun}`)).body;
        expect(ev.available).toBe(false);
        expect(ev.message).toMatch(/^This list of network calls and console messages was removed to save space on /);
    });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("a running job blocks pruning; the daily pass runs once a day", () => {
    const clock = Date.now();

    it("never prunes a project with a job in flight, then prunes when it has finished", async () => {
        const seed = project("Busy project");
        const t = addTest(platform, seed);
        const old = [100, 101, 102].flatMap((d) => addRun(platform, seed, t, { daysAgo: d, files: [{ kind: "video" }] }).files);
        addRun(platform, seed, t, { daysAgo: 1, files: [] });
        await setPolicy(seed.projectId, { enabled: true, keepLatestRuns: 1 });
        const job = await platform.repo.createJob(seed.projectId, seed.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [t.id] });

        const refused = await call("POST", `/api/projects/${seed.projectId}/retention/run`, { confirm: true });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toContain("still going");
        expect((await runScheduledRetention(platform, Date.now())).find((r) => r.projectId === seed.projectId)?.result).toBe("busy");
        expect(old.every(exists)).toBe(true);
        expect((await call("GET", `/api/projects/${seed.projectId}/retention`)).body.busy).toBe(true);

        platform.repo.setJobStatus(job.id, "COMPLETED");
        const ok = await call("POST", `/api/projects/${seed.projectId}/retention/run`, { confirm: true });
        expect(ok.body.files).toBe(3); // the newest run (no files) is the latest run; the three old ones go
        expect(old.filter(exists).length).toBe(0);
    });

    it("the scheduler's tick prunes enabled projects once per day, writes a log row, and leaves projects that are off alone", async () => {
        const on = project("Daily on");
        const off = project("Daily off");
        const t1 = addTest(platform, on);
        const t2 = addTest(platform, off);
        const oldOn = [100, 101].flatMap((d) => addRun(platform, on, t1, { daysAgo: d, now: clock, files: [{ kind: "video", size: 700 }] }).files);
        addRun(platform, on, t1, { daysAgo: 1, now: clock, files: [] });
        const oldOff = [100, 101].flatMap((d) => addRun(platform, off, t2, { daysAgo: d, now: clock, files: [{ kind: "video", size: 700 }] }).files);
        addRun(platform, off, t2, { daysAgo: 1, now: clock, files: [] });
        await setPolicy(on.projectId, { enabled: true, keepLatestRuns: 1 });
        await setPolicy(off.projectId, { enabled: false, keepLatestRuns: 1 });
        // other projects of this test file may have a policy that is on; their rows are not asserted here

        const services = getScheduleServices(platform, { clock: () => clock });
        const rows = () => new RetentionStore(platform.db).recent(on.projectId, 20);

        await services.scheduler.tick();
        expect(oldOn.filter(exists).length).toBe(0);
        expect(oldOff.every(exists)).toBe(true);
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toMatchObject({ trigger: "scheduled", files: 2, bytes: 1400, errors: 0 });
        expect(new RetentionStore(platform.db).recent(off.projectId)).toEqual([]);

        // the services were created earlier (by the routes) with the real clock, so later times are given to the pass directly
        addRun(platform, on, t1, { daysAgo: 400, now: clock, files: [{ kind: "video", size: 700 }] });
        await services.scheduler.tick(); // an immediate second tick: not again
        const first = Date.parse(rows()[0]!.at);
        await runScheduledRetention(platform, first + 60 * 60 * 1000);
        await runScheduledRetention(platform, first + 23 * 60 * 60 * 1000);
        expect(rows()).toHaveLength(1);

        // just over a day after the first run: once more
        await runScheduledRetention(platform, first + 25 * 60 * 60 * 1000);
        expect(rows()).toHaveLength(2);
        expect(rows()[0]!.files).toBe(1);
        const left = platform.db.all<any>("SELECT pruned_at FROM artifacts WHERE project_id = ? AND kind = 'video'", on.projectId);
        expect(left.filter((r) => r.pruned_at === null)).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("a file that cannot be removed, and a path that must not be touched", () => {
    it("logs the problem, skips the file, removes the rest, and finishes the job on the next run", async () => {
        const seed = project("Locked file");
        const t = addTest(platform, seed);
        const runs = [100, 101, 102].map((d) => addRun(platform, seed, t, { daysAgo: d, files: [{ kind: "video", size: 900 }, { kind: "screenshot", size: 100 }] }).files);
        addRun(platform, seed, t, { daysAgo: 1, files: [] });
        await setPolicy(seed.projectId, { enabled: true, keepLatestRuns: 1 });
        // a folder where a file should be: removing it as a file is impossible, like a file another program holds open
        const locked = runs[0]![0]!;
        fs.rmSync(locked.abs);
        fs.mkdirSync(locked.abs);
        fs.writeFileSync(path.join(locked.abs, "inside.txt"), "x");

        const r = await call("POST", `/api/projects/${seed.projectId}/retention/run`, { confirm: true });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ files: 5, errors: 1 }); // 6 planned (3 runs x 2), 1 stuck
        expect(r.body.sentence).toContain("1 could not be removed");
        expect(platform.db.get<any>("SELECT pruned_at FROM artifacts WHERE id = ?", locked.id).pruned_at).toBeNull();
        expect(fs.existsSync(path.join(locked.abs, "inside.txt"))).toBe(true);
        const log = (await call("GET", `/api/projects/${seed.projectId}/retention`)).body.recent[0];
        expect(log).toMatchObject({ errors: 1, files: 5 });
        expect(log.errorSample).toContain("could not be removed");
        expect(log.errorSample).not.toContain(dataDir);
        expect(log.errorSample).not.toMatch(/[A-Za-z]:\\/);

        // once the obstacle is gone the next run finishes the job
        fs.rmSync(locked.abs, { recursive: true });
        const again = await call("POST", `/api/projects/${seed.projectId}/retention/run`, { confirm: true });
        expect(again.body).toMatchObject({ files: 1, errors: 0 });
    });

    it("never touches a path outside the artifact folder, even if a row names one", async () => {
        const seed = project("Escaping path");
        const t = addTest(platform, seed);
        const outside = path.join(dataDir, "outside-the-store.txt");
        fs.writeFileSync(outside, "do not delete me");
        const run = addRun(platform, seed, t, { daysAgo: 200, files: [{ kind: "video" }] });
        addRun(platform, seed, t, { daysAgo: 1, files: [] });
        platform.db.run("UPDATE artifacts SET path = ? WHERE id = ?", "../outside-the-store.txt", run.files[0]!.id);
        await setPolicy(seed.projectId, { enabled: true, keepLatestRuns: 1 });
        const r = await call("POST", `/api/projects/${seed.projectId}/retention/run`, { confirm: true });
        expect(r.body).toMatchObject({ files: 0, errors: 1 });
        expect(fs.readFileSync(outside, "utf8")).toBe("do not delete me");
        expect(platform.db.get<any>("SELECT pruned_at FROM artifacts WHERE id = ?", run.files[0]!.id).pruned_at).toBeNull();
    });

    it("never removes a link, only plain files", async () => {
        const seed = project("Link instead of file");
        const t = addTest(platform, seed);
        const target = path.join(dataDir, "link-target");
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, "keep.txt"), "keep");
        const run = addRun(platform, seed, t, { daysAgo: 200, files: [{ kind: "trace" }] });
        addRun(platform, seed, t, { daysAgo: 1, files: [] });
        fs.rmSync(run.files[0]!.abs);
        try {
            fs.symlinkSync(target, run.files[0]!.abs, "junction");
        } catch {
            return; // this computer does not allow links for this user: the check above is the only one that can run
        }
        await setPolicy(seed.projectId, { enabled: true, keepLatestRuns: 1 });
        const r = await call("POST", `/api/projects/${seed.projectId}/retention/run`, { confirm: true });
        expect(r.body.errors).toBe(1);
        expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("keep");
    });
});

describe("the platform default", () => {
    it("is off unless set, ignores anything that is not a number of days, and applies only to projects without a policy of their own", async () => {
        const seed = project("Default days");
        const t = addTest(platform, seed);
        const old = [100, 101, 102].flatMap((d) => addRun(platform, seed, t, { daysAgo: d, files: [{ kind: "video" }] }).files);
        addRun(platform, seed, t, { daysAgo: 1, files: [] });
        for (const raw of [undefined, "", "abc", "6", "9999", "30 days"]) expect(new RetentionStore(platform.db, raw).effective(seed.projectId), String(raw)).toMatchObject({ enabled: false, source: "default" });
        expect(new RetentionStore(platform.db, "45").effective(seed.projectId)).toMatchObject({ enabled: true, keepDays: 45, keepFailedDays: 135, source: "platform" });
        expect((await runScheduledRetention(platform, Date.now())).find((r) => r.projectId === seed.projectId)).toBeUndefined();

        const withDefault = { ...platform, config: { ...platform.config, RETENTION_DEFAULT_DAYS: "30" } } as Platform;
        // keepLatestRuns is 5 by default: three old runs are all "latest", so nothing goes yet
        expect((await runScheduledRetention(withDefault, Date.now())).find((r) => r.projectId === seed.projectId)).toMatchObject({ result: "pruned", files: 0 });
        expect(old.every(exists)).toBe(true);
        // the project's own choice wins over the platform default, including "off"
        await setPolicy(seed.projectId, { enabled: false });
        expect(new RetentionStore(platform.db, "30").effective(seed.projectId)).toMatchObject({ enabled: false, source: "project" });
        const r = await call("GET", `/api/projects/${seed.projectId}/retention`);
        expect(r.body.source).toBe("project");
    });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("the storage view", () => {
    let seed: Seed;
    const sizes = { video: 3000, screenshot: 500, trace: 100, evidence: 250 };
    let scriptBytes = 0;

    it("reports exact sizes by kind for a project, and says where the numbers come from, without any path", async () => {
        seed = project("Storage numbers");
        const t = addTest(platform, seed);
        addRun(platform, seed, t, { daysAgo: 1, files: [{ kind: "video", size: sizes.video }, { kind: "video", size: sizes.video }, { kind: "screenshot", size: sizes.screenshot }, { kind: "trace", size: sizes.trace }, { kind: "evidence", size: sizes.evidence }] });
        addBaseline(platform, seed, t);
        scriptBytes = fs.statSync(path.join(platform.config.artifactsDir, platform.repo.getCurrentScript(t.id)!.storage_path)).size;
        forgetUsage(platform);

        const r = await call("GET", `/api/projects/${seed.projectId}/storage`);
        expect(r.status).toBe(200);
        const u = r.body.usage;
        expect(u.byKind.video).toMatchObject({ files: 2, bytes: 2 * sizes.video });
        expect(u.byKind.screenshot).toMatchObject({ files: 1, bytes: sizes.screenshot });
        expect(u.byKind.trace).toMatchObject({ files: 1, bytes: sizes.trace });
        expect(u.byKind.evidence).toMatchObject({ files: 1, bytes: sizes.evidence });
        expect(u.byKind.baseline.files).toBe(1);
        expect(u.byKind.script).toMatchObject({ files: 1, bytes: scriptBytes });
        const onDisk = (function walk(dir: string): number {
            return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? walk(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
        })(path.join(platform.config.artifactsDir, seed.projectId));
        expect(u.bytes).toBe(onDisk);
        expect(u.text).toMatch(/KB|MB|bytes/);
        expect(r.body.project).toEqual({ id: seed.projectId, name: "Storage numbers" });
        const text = JSON.stringify(r.body);
        expect(text).not.toContain(dataDir);
        expect(text).not.toContain("generated-tests");
    });

    it("lists the platform: database, files by kind, free disk, the biggest projects first", async () => {
        const r = await call("GET", "/api/storage");
        expect(r.status).toBe(200);
        expect(r.body.database.bytes).toBeGreaterThan(0);
        expect(r.body.disk?.freeBytes).toBeGreaterThan(0);
        expect(r.body.disk?.freeText).toMatch(/B$/);
        expect(r.body.files.bytes).toBeGreaterThan(0);
        const names: string[] = r.body.projects.map((p: any) => p.name);
        expect(names).toContain("Storage numbers");
        const bytes: number[] = r.body.projects.map((p: any) => p.bytes);
        expect([...bytes].sort((a, b) => b - a)).toEqual(bytes);
        expect(r.body.projects.find((p: any) => p.name === "Storage numbers").bytes).toBe((await call("GET", `/api/projects/${seed.projectId}/storage`)).body.usage.bytes);
        const text = JSON.stringify(r.body);
        expect(text).not.toContain(dataDir);
        expect(r.body.truncated).toBe(false);
    });

    it("caches for a minute, and forgets when files are removed", async () => {
        const t = platform.repo.listTests(seed.projectId)[0]!;
        const first = (await call("GET", `/api/projects/${seed.projectId}/storage`)).body.usage.bytes;
        fs.writeFileSync(path.join(platform.config.artifactsDir, seed.projectId, "_artifacts", "late.webm"), Buffer.alloc(5000));
        expect((await call("GET", `/api/projects/${seed.projectId}/storage`)).body.usage.bytes).toBe(first); // cached
        forgetUsage(platform);
        expect((await call("GET", `/api/projects/${seed.projectId}/storage`)).body.usage.bytes).toBe(first + 5000);
        void t;
    });

    it("does not follow a link out of the artifact folder", async () => {
        const outside = path.join(dataDir, "outside-dir");
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "big.bin"), Buffer.alloc(123_456));
        forgetUsage(platform);
        const before = (await call("GET", `/api/projects/${seed.projectId}/storage`)).body.usage.bytes;
        try {
            fs.symlinkSync(outside, path.join(platform.config.artifactsDir, seed.projectId, "linked"), "junction");
        } catch {
            return;
        }
        forgetUsage(platform);
        expect((await call("GET", `/api/projects/${seed.projectId}/storage`)).body.usage.bytes).toBe(before);
    });

    it("answers 404 for an unknown project", async () => {
        expect((await call("GET", "/api/projects/nope/storage")).status).toBe(404);
    });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("an API key protects every route of this feature", () => {
    it("401 without the key, normal answers with it", async () => {
        const seed = project("Protected");
        const guarded = await buildServer({ ...platform, config: { ...platform.config, API_KEY: "retention-test-key-91" } } as Platform);
        const key = { "x-api-key": "retention-test-key-91" };
        try {
            const routes: Array<["GET" | "POST" | "PUT" | "DELETE", string, unknown?]> = [
                ["GET", "/api/storage"],
                ["GET", `/api/projects/${seed.projectId}/storage`],
                ["GET", `/api/projects/${seed.projectId}/retention`],
                ["PUT", `/api/projects/${seed.projectId}/retention`, { enabled: false }],
                ["POST", `/api/projects/${seed.projectId}/retention/preview`],
                ["POST", `/api/projects/${seed.projectId}/retention/run`, { confirm: true }],
                ["GET", `/api/projects/${seed.projectId}/backup`],
                ["POST", "/api/projects/restore", Buffer.from("PK")],
                ["DELETE", `/api/projects/${seed.projectId}/restore-needs`],
            ];
            for (const [method, url, body] of routes) {
                expect((await call(method, url, body, { app: guarded })).status, `${method} ${url}`).toBe(401);
                expect((await call(method, url, body, { app: guarded, headers: { "x-api-key": "wrong" } })).status, `${method} ${url} wrong key`).toBe(401);
            }
            expect((await call("GET", "/api/storage", undefined, { app: guarded, headers: key })).status).toBe(200);
            expect((await call("GET", `/api/projects/${seed.projectId}/backup`, undefined, { app: guarded, headers: key })).status).toBe(200);
            // and the restore with the key reaches the real checks (this body is not a backup)
            expect((await call("POST", "/api/projects/restore", Buffer.from("not a zip"), { app: guarded, headers: key })).status).toBe(400);
        } finally {
            await guarded.close();
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════

const leaksIn = (bytes: Buffer | Uint8Array): string[] => {
    const b = Buffer.from(bytes);
    const forms = [b.toString("latin1"), b.toString("utf16le")];
    return Object.entries(SECRETS)
        .filter(([, v]) => forms.some((f) => f.includes(v)) || b.includes(Buffer.from(v).toString("base64").slice(0, 16)) || b.includes(Buffer.from(v, "utf16le")))
        .map(([k]) => k);
};

describe("backup and restore", () => {
    let seed: Seed;
    const tests: Array<{ id: string; key: string; scriptId: string }> = [];
    let zip: Buffer;
    let entries: Record<string, Uint8Array>;
    let restored: any;
    let manualCaseIds: string[] = [];

    it("seeds a project that holds a secret in every place a secret can be put", async () => {
        seed = seedProject(platform, "Shop", `http://127.0.0.1:5755/?api_key=${SECRETS.appUrlKey}`);
        // the application: sign-in details (encrypted) and settings that carry an address with a token
        platform.repo.createApplication(seed.projectId, `http://127.0.0.1:5755/?api_key=${SECRETS.appUrlKey}`, { ...DEFAULT_JOB_OPTIONS, scope: "checkout", openApiUrl: `http://127.0.0.1:5755/openapi.json?token=${SECRETS.openApiToken}` }, { username: "demo@example.com", password: SECRETS.password, totpSecret: SECRETS.totp, apiToken: SECRETS.apiToken });
        for (const [title, kind] of [["Home loads", "web"], ["Cart API answers", "api"], ["Login works", "web"]] as const) {
            const t = addTest(platform, seed, title, kind);
            tests.push({ id: t.id, key: t.key, scriptId: t.scriptId });
        }
        platform.repo.updateTest(tests[0]!.id, { validationStatus: "VALIDATED" });
        addBaseline(platform, seed, tests[0]!);
        addRun(platform, seed, tests[0]!, { daysAgo: 1, status: "failed", files: [{ kind: "video", size: 2 * 1024 * 1024 }, { kind: "screenshot", size: 800 }] });

        ok(await call("PUT", `/api/projects/${seed.projectId}/roles`, { roles: [{ name: "user", username: "user@example.com", password: SECRETS.userPassword, apiToken: SECRETS.userToken }, { name: "admin", username: "admin@example.com", password: SECRETS.adminPassword, totpSecret: SECRETS.adminTotp, apiToken: SECRETS.adminToken }] }), 200);
        ok(await call("POST", `/api/projects/${seed.projectId}/environments`, { name: "staging", baseUrl: "http://127.0.0.1:5755", variables: { REGION: "eu", API_TOKEN: SECRETS.envVariable } }), 201);
        ok(await call("PUT", `/api/projects/${seed.projectId}/environments/staging/secrets`, { username: "env-user@example.com", password: SECRETS.envPassword, totpSecret: SECRETS.envTotp, apiToken: SECRETS.envToken, apiAuthHeader: SECRETS.envAuthHeader }), 200);
        ok(await call("POST", `/api/projects/${seed.projectId}/test-data`, { name: "logins", content: `email,password\nqa@example.com,${SECRETS.dataColumn}\nqb@example.com,${SECRETS.dataColumn}\n`, format: "csv" }), 201);
        ok(await call("POST", `/api/projects/${seed.projectId}/alert-channels`, { kind: "teams", url: `http://127.0.0.1:5679/workflows/${SECRETS.teamsHook}` }), 201);
        ok(await call("POST", `/api/projects/${seed.projectId}/integrations`, { kind: "notion", databaseId: "a1b2c3d4e5f64789abc0123456789abc", token: SECRETS.notionToken, verify: false }), 201);
        ok(await call("PUT", `/api/projects/${seed.projectId}/sentry`, { organization: "acme", project: "shop", token: SECRETS.sentryToken, verify: false }), 201);
        const trig = await call("POST", `/api/projects/${seed.projectId}/triggers`, { label: "pipeline" });
        expect(trig.status).toBe(201);
        (SECRETS as Record<string, string>).triggerToken = trig.body.token;

        // manual cases (linked to tests), a runbook, a schedule on staging, a signed and an open release
        const manual = new ManualCaseStore(platform.db);
        const c1 = manual.createCase(seed.projectId, { title: "Pay with a saved card", area: "Checkout", priority: "high", requirement: "REQ-7", steps: [{ action: "Open the cart", expected: "Items are listed" }, { action: "Pay", expected: "A receipt appears" }], linkedTestIds: [tests[1]!.id] });
        const c2 = manual.createCase(seed.projectId, { title: "Receipt looks right", area: "Checkout", priority: "medium", requirement: "", steps: [], linkedTestIds: [] });
        manualCaseIds = [c1.id, c2.id];
        const relSigned = await call("POST", `/api/projects/${seed.projectId}/releases`, { name: "1.0", notes: "First release" });
        expect(relSigned.status).toBe(201);
        await call("PUT", `/api/projects/${seed.projectId}/releases/${relSigned.body.id}/results/${c1.id}`, { result: "failed", note: "Card form rejects valid cards", by: "QA Quinn" });
        const signed = await call("POST", `/api/projects/${seed.projectId}/releases/${relSigned.body.id}/signoff`, { decision: "rejected", by: "QA Quinn", comment: "" });
        expect(signed.status, JSON.stringify(signed.body)).toBe(200);
        expect((await call("POST", `/api/projects/${seed.projectId}/releases`, { name: "1.1", notes: "" })).status).toBe(201);
        new RunbookStore(platform.db).create(seed.projectId, RunbookDefinition.parse({ version: 1, name: "Smoke then everything", steps: [{ id: "smoke", type: "run", scope: { testIds: [tests[0]!.id] }, retries: 1 }] }));
        const sched = new ScheduleStore(platform.db).create({ projectId: seed.projectId, name: "Nightly", kind: "validate", cadence: { type: "daily", time: "02:00" } });
        setScheduleEnvironment(platform.db, sched.id, { environment: "staging", confirmProduction: false });
        await setPolicy(seed.projectId, { enabled: true, keepDays: 14, keepFailedDays: 60, keepLatestRuns: 3 });
    }, 60_000);

    it("downloads a zip with the documents of the project", async () => {
        const r = await call("GET", `/api/projects/${seed.projectId}/backup`);
        expect(r.status).toBe(200);
        expect(r.headers["content-type"]).toBe("application/zip");
        expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="backup-shop-\d{4}-\d{2}-\d{2}\.zip"$/);
        zip = r.raw;
        entries = unzipSync(new Uint8Array(zip));
        expect(Object.keys(entries).sort()).toEqual(["alert-channels.json", "environments.json", "manifest.json", "manual-cases.json", "project.json", "releases.json", "runbooks.json", "schedules.json", "secrets-needed.json", "test-data.json", "tests.json"]);
        const manifest = JSON.parse(strFromU8(entries["manifest.json"]!));
        expect(manifest).toMatchObject({ kind: BACKUP_KIND, format: BACKUP_FORMAT, project: { name: "Shop" }, includesFiles: false });
        expect(manifest.counts).toMatchObject({ tests: 3, scripts: 3, manualCases: 2, releases: 2, runbooks: 1, environments: 1, dataSets: 1, schedules: 1, alertChannels: 1, baselines: 0 });
        expect(manifest.createdAt).toMatch(/^\d{4}-/);
    });

    it("contains no secret anywhere: every entry, as plain text, base64 or UTF-16, and the zip itself", async () => {
        expect(Object.keys(SECRETS).length).toBeGreaterThan(18);
        const found = Object.entries(entries).flatMap(([name, bytes]) => leaksIn(bytes).map((s) => `${s} in ${name}`));
        expect(found).toEqual([]);
        expect(leaksIn(zip)).toEqual([]);
        // not even the user names that only exist inside the sign-in details
        for (const name of ["demo@example.com", "user@example.com", "admin@example.com", "env-user@example.com"]) expect(Buffer.from(zip).includes(name)).toBe(false);
        for (const [name, bytes] of Object.entries(entries)) expect(strFromU8(bytes), name).not.toMatch(/LEAKCHECK|credentials_enc|secret_enc|secrets_enc|url_enc/);
    });

    it("lists what has to be entered again, by name", () => {
        const needs = JSON.parse(strFromU8(entries["secrets-needed.json"]!)) as Array<{ kind: string; label: string }>;
        const has = (kind: string, text: string) => needs.some((n) => n.kind === kind && n.label.includes(text));
        expect(has("application-sign-in", "application")).toBe(true);
        expect(has("test-accounts", "“admin”")).toBe(true);
        expect(has("test-accounts", "“user”")).toBe(true);
        expect(has("environment-sign-in", "“staging”")).toBe(true);
        expect(has("environment-variable", "API_TOKEN")).toBe(true);
        expect(has("test-data-column", "“password”")).toBe(true);
        expect(has("alert-channel", "teams")).toBe(true);
        expect(has("issue-tracker", "notion")).toBe(true);
        expect(has("deploy-trigger", "1 deploy trigger token")).toBe(true);
        expect(needs.some((n) => n.kind === "address")).toBe(true);
        const project = JSON.parse(strFromU8(entries["project.json"]!));
        expect(project.application.config.scope).toBe("checkout");
        expect(project.application.url).not.toContain("api_key");
        expect(JSON.stringify(project.application.config)).not.toContain("token=");
        const envs = JSON.parse(strFromU8(entries["environments.json"]!));
        expect(envs[0]).toMatchObject({ name: "staging", variables: { REGION: "eu" } });
        expect(envs[0].variables.API_TOKEN).toBeUndefined();
        expect(envs[0].baseUrl).not.toContain("user:");
        const sets = JSON.parse(strFromU8(entries["test-data.json"]!));
        expect(sets[0].rows).toEqual([{ email: "qa@example.com", password: "" }, { email: "qb@example.com", password: "" }]);
        // alert channels: names and kinds only
        expect(JSON.parse(strFromU8(entries["alert-channels.json"]!))).toEqual([{ name: expect.any(String), kind: "teams" }]);
    });

    it("restores into a NEW project: same tests and scripts, ids made new, tests waiting to be run", async () => {
        const before = (await call("GET", "/api/projects")).body.length;
        const r = await call("POST", "/api/projects/restore", zip);
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        restored = r.body;
        expect(restored.project.id).not.toBe(seed.projectId);
        expect(restored.project.name).toBe("Shop (restored)");
        expect(restored.restored).toMatchObject({ tests: 3, scripts: 3, manualCases: 2, releases: 2, runbooks: 1, environments: 1, dataSets: 1, schedules: 1 });
        expect(restored.message).toContain("Nothing has been run");
        expect((await call("GET", "/api/projects")).body.length).toBe(before + 1);

        const id = restored.project.id as string;
        const list = (await call("GET", `/api/projects/${id}/tests`)).body as Array<{ id: string; testId: string; validationStatus: string; validationReason: string }>;
        expect(list.map((t) => t.testId).sort()).toEqual(tests.map((t) => t.key).sort());
        expect(list.every((t) => t.validationStatus === "PENDING")).toBe(true); // even the one that was VALIDATED
        expect(list[0]!.validationReason).toContain("Restored from a backup");
        const oldIds = new Set(tests.map((t) => t.id));
        expect(list.some((t) => oldIds.has(t.id))).toBe(false);

        // specs and scripts are the same
        const specsOld = (await call("GET", `/api/projects/${seed.projectId}/specs`)).body.specs;
        const specsNew = (await call("GET", `/api/projects/${id}/specs`)).body.specs;
        expect(specsNew).toEqual(specsOld);
        for (const t of list) {
            const oldTest = tests.find((x) => x.key === t.testId)!;
            const a = (await call("GET", `/api/tests/${oldTest.id}/script`)).body;
            const b = (await call("GET", `/api/tests/${t.id}/script`)).body;
            expect(b).toBe(a);
        }
        // nothing ran, nothing is scheduled to run
        expect((await call("GET", `/api/projects/${id}/jobs`)).body).toEqual([]);
        expect(platform.db.all("SELECT 1 FROM test_executions WHERE test_case_id IN (SELECT id FROM test_cases WHERE project_id = ?)", id)).toEqual([]);
    });

    it("restores manual cases (linked to the new tests), releases, runbooks, environments, test data and schedules", async () => {
        const id = restored.project.id as string;
        const newTests = (await call("GET", `/api/projects/${id}/tests`)).body as Array<{ id: string; testId: string }>;
        const manual = (await call("GET", `/api/projects/${id}/manual-cases`)).body.cases as Array<{ id: string; title: string; linkedTestIds: string[]; steps: unknown[]; requirement: string }>;
        expect(manual.map((c) => c.title).sort()).toEqual(["Pay with a saved card", "Receipt looks right"]);
        const pay = manual.find((c) => c.title === "Pay with a saved card")!;
        expect(pay.steps).toHaveLength(2);
        expect(pay.requirement).toBe("REQ-7");
        expect(pay.linkedTestIds).toEqual([newTests.find((t) => t.testId === tests[1]!.key)!.id]);
        expect(manual.some((c) => manualCaseIds.includes(c.id))).toBe(false);

        const releases = (await call("GET", `/api/projects/${id}/releases`)).body.releases as Array<{ id: string; name: string; status: string; signedBy: string | null }>;
        expect(releases.map((r) => `${r.name}:${r.status}`).sort()).toEqual(["1.0:rejected", "1.1:open"]);
        const signed = (await call("GET", `/api/projects/${id}/releases/${releases.find((r) => r.name === "1.0")!.id}`)).body;
        expect(signed.frozen).toBe(true);
        expect(signed.signedBy).toBe("QA Quinn");
        expect(signed.manual.items.find((i: any) => i.title === "Pay with a saved card")).toMatchObject({ result: "failed", note: "Card form rejects valid cards" });
        expect(signed.manual.items.every((i: any) => manual.some((c) => c.id === i.id))).toBe(true); // frozen ids point at the NEW cases
        expect(signed.audit).toHaveLength(1);

        const envs = (await call("GET", `/api/projects/${id}/environments`)).body.environments as Array<any>;
        expect(envs).toHaveLength(1);
        expect(envs[0]).toMatchObject({ name: "staging", variables: { REGION: "eu" }, hasPassword: false, hasTotp: false, hasApiToken: false, hasApiAuthHeader: false });
        const sets = (await call("GET", `/api/projects/${id}/test-data`)).body.dataSets as Array<any>;
        expect(sets.map((s) => s.name)).toEqual(["logins"]);
        expect(new DataSetStore(platform.db).get(id, "logins")!.rows[0]).toEqual({ email: "qa@example.com", password: "" });

        const runbooks = new RunbookStore(platform.db).list(id);
        expect(runbooks.map((r) => r.name)).toEqual(["Smoke then everything"]);
        const schedules = new ScheduleStore(platform.db).list(id);
        expect(schedules).toHaveLength(1);
        expect(schedules[0]).toMatchObject({ name: "Nightly", enabled: false, nextRunAt: null }); // switched off until a person decides
        expect(platform.db.get<any>("SELECT environment, confirm_production FROM schedules WHERE id = ?", schedules[0]!.id)).toMatchObject({ environment: "staging", confirm_production: 0 });
        expect(restored.notes.join(" ")).toContain("switched off");
    });

    it("brings back no secret, and says what is missing; the platform and the source project are untouched", async () => {
        const id = restored.project.id as string;
        const app = (await call("GET", `/api/projects/${id}`)).body.application;
        expect(app.hasCredentials).toBe(false);
        expect(app.url).not.toContain("api_key");
        expect(app.config.scope).toBe("checkout");
        expect(JSON.stringify(app.config)).not.toContain(SECRETS.openApiToken);
        expect((await call("GET", `/api/projects/${id}/alert-channels`)).body).toEqual([]);
        expect((await call("GET", `/api/projects/${id}/integrations`)).body).toEqual([]);
        expect((await call("GET", `/api/projects/${id}/roles`)).body.roles ?? []).toEqual([]);
        expect((await call("GET", `/api/projects/${id}/triggers`)).body.tokens).toEqual([]);
        // the retention policy comes back, switched off
        const pol = (await call("GET", `/api/projects/${id}/retention`)).body;
        expect(pol.policy).toMatchObject({ enabled: false, keepDays: 14, keepFailedDays: 60, keepLatestRuns: 3 });

        const needs = (await call("GET", `/api/projects/${id}/storage`)).body.needsSecrets as Array<{ kind: string; label: string }>;
        expect(needs.length).toBeGreaterThan(5);
        expect(restored.needsSecrets.length).toBe(needs.length);
        expect(needs.some((n) => n.kind === "application-sign-in")).toBe(true);
        expect(needs.some((n) => n.kind === "alert-channel")).toBe(true);
        // nothing leaked into what the restore returned either
        expect(leaksIn(Buffer.from(JSON.stringify(restored)))).toEqual([]);
        expect(leaksIn(Buffer.from(JSON.stringify(needs)))).toEqual([]);

        // the source project is as it was
        expect((await call("GET", `/api/projects/${seed.projectId}/tests`)).body).toHaveLength(3);
        expect((await call("GET", `/api/projects/${seed.projectId}/retention`)).body.policy.enabled).toBe(true);
        expect((await call("GET", `/api/projects/${seed.projectId}`)).body.application.hasCredentials).toBe(true);

        // "done": the list can be cleared
        expect((await call("DELETE", `/api/projects/${id}/restore-needs`)).body.cleared).toBe(needs.length);
        expect((await call("GET", `/api/projects/${id}/storage`)).body.needsSecrets).toEqual([]);
    });

    it("never overwrites: restoring the same file again makes another project; a restored project can be backed up again, without secrets", async () => {
        const n = (await call("GET", "/api/projects")).body.length;
        const again = await call("POST", "/api/projects/restore?name=Shop%20copy", zip);
        expect(again.status).toBe(201);
        expect(again.body.project.name).toBe("Shop copy");
        expect(again.body.project.id).not.toBe(restored.project.id);
        expect((await call("GET", "/api/projects")).body.length).toBe(n + 1);
        const second = await call("GET", `/api/projects/${restored.project.id}/backup`);
        expect(second.status).toBe(200);
        const e2 = unzipSync(new Uint8Array(second.raw));
        expect(Object.entries(e2).flatMap(([name, bytes]) => leaksIn(bytes).map((s) => `${s} in ${name}`))).toEqual([]);
        expect(JSON.parse(strFromU8(e2["manifest.json"]!)).counts.tests).toBe(3);
    });

    it("with ?evidence=true adds the approved baselines and recent evidence (up to a size limit), and restores the baselines", async () => {
        const small = await call("GET", `/api/projects/${seed.projectId}/backup?evidence=true&maxEvidenceMB=1`);
        expect(small.status).toBe(200);
        const e = unzipSync(new Uint8Array(small.raw));
        const names = Object.keys(e);
        expect(names.some((x) => x.startsWith(`baselines/${tests[0]!.key}/`))).toBe(true);
        expect(names.filter((x) => x.startsWith("evidence/") && x.endsWith(".webm"))).toEqual([]); // the 2 MB recording is over the 1 MB limit
        expect(names.filter((x) => x.startsWith("evidence/")).length).toBeGreaterThan(0); // the screenshot fits
        expect(Object.entries(e).flatMap(([name, bytes]) => leaksIn(bytes).map((s) => `${s} in ${name}`))).toEqual([]);
        expect((await call("GET", `/api/projects/${seed.projectId}/backup?evidence=true&maxEvidenceMB=999`)).status).toBe(400);

        const big = await call("GET", `/api/projects/${seed.projectId}/backup?evidence=true&maxEvidenceMB=10`);
        expect(Object.keys(unzipSync(new Uint8Array(big.raw))).some((x) => x.endsWith(".webm"))).toBe(true);

        const r = await call("POST", "/api/projects/restore", small.raw);
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.restored.baselines).toBe(1);
        const base = platform.db.get<any>("SELECT path, size FROM artifacts WHERE project_id = ? AND kind = 'baseline'", r.body.project.id);
        expect(base.path.startsWith(`${r.body.project.id}/_baselines/`)).toBe(true);
        expect(fs.statSync(path.join(platform.config.artifactsDir, base.path)).size).toBe(base.size);
    });
});

describe("hostile or damaged uploads are refused and leave nothing behind", () => {
    const stateOfTheWorld = async () => ({
        projects: (await call("GET", "/api/projects")).body.length as number,
        folders: fs.readdirSync(platform.config.artifactsDir).sort(),
        tests: platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM test_cases")!.n,
    });
    const manifest = (over: Record<string, unknown> = {}) => strToU8(JSON.stringify({ kind: BACKUP_KIND, format: BACKUP_FORMAT, platformVersion: "0.1.0", createdAt: "2026-10-08T00:00:00Z", project: { name: "Hostile" }, ...over }));

    it("path traversal, absolute names, unknown files and a future format", async () => {
        const before = await stateOfTheWorld();
        const cases: Array<[string, Uint8Array, number, RegExp]> = [
            ["traversal", zipSync({ "manifest.json": manifest(), "../../evil.json": strToU8("{}") }), 400, /leave its folder|not a backup/],
            ["absolute", zipSync({ "manifest.json": manifest(), "/etc/passwd": strToU8("x") }), 400, /absolute path|not a backup/],
            ["script", zipSync({ "manifest.json": manifest(), "install.sh": strToU8("rm -rf /") }), 400, /never contains/],
            ["no manifest", zipSync({ "tests.json": strToU8("[]") }), 400, /no manifest/],
            ["future format", zipSync({ "manifest.json": manifest({ format: BACKUP_FORMAT + 1 }) }), 422, /newer version of the platform/],
            ["bad json", zipSync({ "manifest.json": manifest(), "tests.json": strToU8("{oops") }), 400, /not readable/],
            ["wrong shape", zipSync({ "manifest.json": manifest(), "tests.json": strToU8(JSON.stringify([{ nope: 1 }])) }), 400, /damaged/],
            ["invalid test", zipSync({ "manifest.json": manifest(), "tests.json": strToU8(JSON.stringify([{ testKey: "WEB-001", suite: { name: "Home", slug: "home" }, framework: "playwright", spec: { title: "x" }, scripts: [{ framework: "playwright", filename: "WEB-001.spec.ts", content: "x", executable: true }] }])) }), 400, /not a valid test/],
            ["path-like script name", zipSync({ "manifest.json": manifest(), "project.json": strToU8(JSON.stringify({ name: "x", application: { url: "http://127.0.0.1:5755", config: {} } })), "tests.json": strToU8("[]") }), 201, /./],
        ];
        for (const [name, bytes, status, message] of cases) {
            const r = await call("POST", "/api/projects/restore", Buffer.from(bytes));
            expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(status);
            if (status !== 201) expect(r.body.error, name).toMatch(message);
        }
        const after = await stateOfTheWorld();
        expect(after.projects).toBe(before.projects + 1); // only the last, valid, one made a project
        expect(after.folders).toEqual(before.folders);
        expect(after.tests).toBe(before.tests);
    });

    it("something that is not a zip, an empty body, JSON, and a body of the wrong kind", async () => {
        const before = await stateOfTheWorld();
        expect((await call("POST", "/api/projects/restore", Buffer.from("this is plain text"))).status).toBe(400);
        expect((await call("POST", "/api/projects/restore", Buffer.alloc(0))).status).toBe(400);
        expect((await call("POST", "/api/projects/restore", { hello: "world" })).status).toBe(415);
        expect((await call("POST", "/api/projects/restore")).status).toBe(415);
        expect((await call("POST", "/api/projects/restore?name=" + "x".repeat(200), Buffer.from("PK"))).status).toBe(400);
        expect(await stateOfTheWorld()).toEqual(before);
    });

    it("a failure half-way through leaves no project, no rows and no files", async () => {
        const seed = seedProject(platform, "Half way", "http://127.0.0.1:5755");
        const t = addTest(platform, seed);
        platform.repo.updateTest(t.id, { validationStatus: "VALIDATED" });
        new ManualCaseStore(platform.db).createCase(seed.projectId, { title: "A manual check", area: "General", priority: "low", requirement: "", steps: [], linkedTestIds: [] });
        const backup = (await call("GET", `/api/projects/${seed.projectId}/backup`)).raw;
        const before = await stateOfTheWorld();
        const originalRun = platform.db.run.bind(platform.db);
        const spy = vi.spyOn(platform.db, "run").mockImplementation((sql: string, ...params: any[]) => {
            if (sql.includes("INSERT INTO manual_cases")) throw new Error("disk full");
            return originalRun(sql, ...params);
        });
        try {
            const r = await call("POST", "/api/projects/restore?name=Will%20fail", backup);
            expect(r.status).toBe(500);
            expect(r.body.error).toContain("Nothing was created");
        } finally {
            spy.mockRestore();
        }
        const after = await stateOfTheWorld();
        expect(after).toEqual(before);
        expect(platform.db.get("SELECT 1 FROM projects WHERE name = 'Will fail'")).toBeUndefined();
        expect(platform.db.get("SELECT 1 FROM manual_cases WHERE project_id NOT IN (SELECT id FROM projects)")).toBeUndefined();
        // and the same backup restores fine once the problem is gone
        expect((await call("POST", "/api/projects/restore?name=Will%20work", backup)).status).toBe(201);
    });
});
