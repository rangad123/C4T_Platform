/**
 * Production hosting through the real platform (no browser):
 * - in-process server (server.inject): /healthz, /readyz with each failing check, /metrics behind the key or METRICS_TOKEN with jobs, AI usage
 *   and cost, HTTP numbers by route template, request ids, JSON request logs without secrets;
 * - scheduled backups on the real database: an online copy verified by opening it, the key file beside it, pruning, the upload hook, a damaged
 *   copy refused, one backup per slot;
 * - graceful shutdown with a real job row: a job that finishes in time keeps its result; one that does not is stopped and recorded as
 *   interrupted (its running tests back to not run yet), never left "running";
 * - the real program (`node --import tsx src/main.ts`, port 6790) with LOG_FORMAT=json and BACKUP_DIR: probes, JSON lines, a first backup, no
 *   secret on stdout/stderr; on Linux/macOS also SIGTERM ending cleanly (Windows cannot send SIGTERM to a process, so that part is skipped there).
 * Run under the lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/ops.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { Db, knownSchemaVersion } from "../src/platform/db.js";
import { backupTime, listBackups, makeBackup, readStatus, startBackupSchedule, verifyBackupFile } from "../src/platform/ops/backup-schedule.js";
import { checkReadiness } from "../src/platform/ops/health.js";
import { readHeartbeat, writeHeartbeat } from "../src/platform/ops/heartbeat.js";
import { createShutdown, INTERRUPTED_MESSAGE } from "../src/platform/ops/shutdown.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { opsRuntimeFor } from "../src/platform/routes/ops.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "SENTINEL-OPS-KEY-61803398";
const METRICS_TOKEN = "SENTINEL-OPS-METRICS-27182818";
const PORT = 6790;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ops-it-"));
const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
};

let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let projectId: string;
const stdout: string[] = [];
let realWrite: typeof process.stdout.write;

const newPlatform = (name: string) => bootstrap(loadConfig({ DATA_DIR: path.join(root, name), LLM_PROVIDER: "anthropic", API_KEY: KEY }));

beforeAll(async () => {
    setEnv("API_KEY", KEY);
    setEnv("METRICS_TOKEN", METRICS_TOKEN);
    setEnv("LOG_FORMAT", "json");
    setEnv("READY_MIN_FREE_MB", "1");
    setEnv("BACKUP_DIR", path.join(root, "metrics-backups"));
    platform = newPlatform("main");
    app = await buildServer(platform);
    projectId = platform.repo.createProject({ name: "Ops shop" }).id as string;
    // Capture what the request log writes (JSON lines on stdout), passing it through.
    realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        stdout.push(String(chunk));
        return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
}, 60_000);

afterAll(async () => {
    process.stdout.write = realWrite;
    await app?.close();
    try {
        platform?.db.close();
    } catch {
        /* closed by a test */
    }
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
});

describe("health and readiness", () => {
    it("answers /healthz without a key, and /api still needs one", async () => {
        const h = await app.inject("/healthz");
        expect(h.statusCode).toBe(200);
        expect(h.json()).toEqual({ status: "ok" });
        expect((await app.inject("/api/projects")).statusCode).toBe(401);
    });

    it("is not ready until a worker said it is alive, then ready, and names failing checks only", async () => {
        const before = await app.inject("/readyz");
        expect(before.statusCode).toBe(503);
        expect(before.json()).toEqual({ status: "not ready", failing: ["worker"] });
        writeHeartbeat(platform.db);
        const after = await app.inject("/readyz");
        expect(after.statusCode).toBe(200);
        expect(after.json()).toEqual({ status: "ready" });
        // Nothing about the server: no folder, version or number.
        expect(before.body).not.toContain(root.slice(0, 12));
        expect(before.body.length).toBeLessThan(80);
    });

    it("fails a stale worker, a full disk, a database that is not migrated, and a process that is stopping", async () => {
        const db = platform.db;
        const dataDir = platform.config.dataDir;
        writeHeartbeat(db, Date.now() - 10 * 60_000);
        expect(checkReadiness({ db, dataDir, minFreeBytes: 1, workerStaleMs: 90_000, shuttingDown: false }).failing).toEqual(["worker"]);
        writeHeartbeat(db);
        expect(checkReadiness({ db, dataDir, minFreeBytes: 10 * 1024 ** 3, workerStaleMs: 90_000, shuttingDown: false, freeBytes: () => 1024 }).failing).toEqual(["disk"]);
        expect(checkReadiness({ db, dataDir, minFreeBytes: 1, workerStaleMs: 90_000, shuttingDown: true }).failing).toEqual(["shutdown"]);
        // A database left at an older schema version (another process mid-update) is not ready.
        const other = newPlatform("old-schema");
        other.db.run("DELETE FROM schema_version WHERE version = ?", knownSchemaVersion());
        writeHeartbeat(other.db);
        expect(checkReadiness({ db: other.db, dataDir: other.config.dataDir, minFreeBytes: 1, workerStaleMs: 90_000, shuttingDown: false }).failing).toEqual(["migrations"]);
        other.db.close();
        // A database another connection holds the write lock of cannot take work.
        const first = newPlatform("locked");
        const second = bootstrap(loadConfig({ DATA_DIR: first.config.dataDir, LLM_PROVIDER: "anthropic" }));
        second.db.raw.exec("PRAGMA busy_timeout = 50");
        writeHeartbeat(first.db);
        first.db.raw.exec("BEGIN IMMEDIATE");
        expect(checkReadiness({ db: second.db, dataDir: first.config.dataDir, minFreeBytes: 1, workerStaleMs: 90_000, shuttingDown: false }).failing).toEqual(["database"]);
        first.db.raw.exec("ROLLBACK");
        expect(checkReadiness({ db: second.db, dataDir: first.config.dataDir, minFreeBytes: 1, workerStaleMs: 90_000, shuttingDown: false }).failing).toEqual([]);
        second.db.close();
        first.db.close();
        // The shutdown flag of the running server is the one /readyz reads.
        opsRuntimeFor(app)!.state.shuttingDown = true;
        expect((await app.inject("/readyz")).json()).toEqual({ status: "not ready", failing: ["shutdown"] });
        opsRuntimeFor(app)!.state.shuttingDown = false;
    });
});

describe("metrics", () => {
    it("needs the API key or the metrics token", async () => {
        expect((await app.inject("/metrics")).statusCode).toBe(401);
        expect((await app.inject({ url: "/metrics", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
        expect((await app.inject({ url: "/metrics", headers: { "x-api-key": KEY } })).statusCode).toBe(200);
        const r = await app.inject({ url: "/metrics", headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
        expect(r.statusCode).toBe(200);
        expect(r.headers["content-type"]).toMatch(/^text\/plain; version=0\.0\.4/);
    });

    it("counts jobs by status, the queue, finished-job durations, AI calls, tokens and cost, runners, and HTTP traffic by route template", async () => {
        const repo = platform.repo;
        const appId = repo.createApplication(projectId, "http://127.0.0.1:6799", {});
        await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const done = await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED', started_at = ?, finished_at = ? WHERE id = ?", "2026-10-18T10:00:00.000Z", "2026-10-18T10:01:30.000Z", done.id);
        platform.db.run("INSERT INTO ai_usage (job_id, project_id, purpose, model, day, calls, failed_calls, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?)", done.id, projectId, "planning", "model-a", "2026-10-18", 4, 1, 1_000_000, 500_000);
        platform.db.run("INSERT INTO ai_usage (job_id, project_id, purpose, model, day, calls, failed_calls, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?)", done.id, projectId, "planning", "model-unpriced", "2026-10-18", 1, 0, 300, 200);
        platform.db.run("INSERT INTO ai_prices (model, input_per_mtok, output_per_mtok, updated_at) VALUES ('model-a', 3, 15, ?)", new Date().toISOString());
        await app.inject({ url: `/api/projects/${projectId}`, headers: { "x-api-key": KEY } });
        await app.inject({ url: `/api/projects/${projectId}`, headers: { "x-api-key": KEY } });
        const text = (await app.inject({ url: "/metrics", headers: { "x-api-key": KEY } })).body;
        expect(text).toContain('aitp_jobs{status="QUEUED"} 1');
        expect(text).toContain('aitp_jobs{status="COMPLETED"} 1');
        expect(text).toContain('aitp_jobs{status="FAILED"} 0');
        expect(text).toContain("aitp_job_queue_length 1");
        expect(text).toContain('aitp_job_duration_seconds_bucket{mode="validate",le="60"} 0');
        expect(text).toContain('aitp_job_duration_seconds_bucket{mode="validate",le="120"} 1');
        expect(Number(/aitp_job_duration_seconds_sum\{mode="validate"\} ([\d.]+)/.exec(text)?.[1])).toBeCloseTo(90, 2);
        expect(text).toContain("aitp_ai_calls_total 5");
        expect(text).toContain("aitp_ai_failed_calls_total 1");
        expect(text).toContain('aitp_ai_tokens_total{direction="input"} 1000300');
        expect(text).toContain('aitp_ai_estimated_cost_total{currency="USD"} 10.5');
        expect(text).toContain("aitp_ai_unpriced_tokens_total 500");
        expect(text).toContain('aitp_runners{state="online"} 0');
        expect(text).toContain('aitp_http_requests_total{method="GET",route="/api/projects/:id",status="200"} 2');
        expect(text).toContain('aitp_http_requests_total{method="GET",route="/metrics",status="401"}');
        expect(text).toMatch(/aitp_database_bytes \d+/);
        expect(text).toMatch(/aitp_worker_heartbeat_age_seconds [\d.]+/);
        // The real id is never a label; no secret anywhere.
        expect(text).not.toContain(projectId);
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(METRICS_TOKEN);
        // Every sample line is valid exposition format.
        for (const line of text.trim().split("\n")) expect(line).toMatch(/^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?[\d.e+-]+)$/);
    });
});

describe("request ids and JSON request logs", () => {
    it("echoes a plain x-request-id, replaces an unsafe one, and adds one to refusals", async () => {
        const a = await app.inject({ url: "/healthz", headers: { "x-request-id": "lb-req.42" } });
        expect(a.headers["x-request-id"]).toBe("lb-req.42");
        const b = await app.inject({ url: "/healthz", headers: { "x-request-id": "bad id <script> with spaces" } });
        expect(b.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
        const c = await app.inject({ url: "/api/projects" });
        expect(c.statusCode).toBe(401);
        expect(c.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("writes one JSON line per request with the route template, never the address or a key", async () => {
        stdout.length = 0;
        await app.inject({ url: `/api/artifacts/some-file.png?key=${KEY}`, headers: { "x-request-id": "trace-me-1" } });
        await app.inject({ url: `/api/projects/${projectId}`, headers: { "x-api-key": KEY, "x-request-id": "trace-me-2" } });
        const lines = stdout.join("").split("\n").filter((l) => l.includes('"trace-me-'));
        expect(lines).toHaveLength(2);
        const second = JSON.parse(lines[1]!);
        expect(second).toMatchObject({ level: "info", msg: "request", component: "http", requestId: "trace-me-2", method: "GET", route: "/api/projects/:id", status: 200 });
        expect(typeof second.durationMs).toBe("number");
        const all = stdout.join("");
        expect(all).not.toContain(KEY);
        expect(all).not.toContain(projectId);
    });
});

describe("scheduled backups", () => {
    const log: string[] = [];
    const job = (dir: string, extra: Partial<Parameters<typeof makeBackup>[0]> = {}) => ({
        db: platform.db,
        dataDir: platform.config.dataDir,
        secretKeyFromEnv: false,
        dir,
        keep: 2,
        log: (level: string, msg: string) => void log.push(`${level} ${msg}`),
        ...extra,
    });

    it("makes an online copy, proves it by opening it, keeps the key file beside it, and records the result", async () => {
        const dir = path.join(root, "backups-a");
        const out = await makeBackup(job(dir), new Date(Date.UTC(2026, 9, 18, 2, 30, 0)));
        expect(out).toMatchObject({ ok: true, file: "platform-20261018-023000.db", removed: [] });
        const file = path.join(dir, out.file!);
        expect(verifyBackupFile(file).version).toBe(knownSchemaVersion());
        expect(fs.existsSync(`${file}-wal`)).toBe(false);
        expect(fs.readFileSync(`${file}.secret`, "utf8")).toBe(fs.readFileSync(path.join(platform.config.dataDir, ".secret"), "utf8"));
        // The copy holds the live data.
        // Loaded the way db.ts does: the test bundler cannot resolve "node:sqlite" as an import.
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
        const copy = new DatabaseSync(file, { readOnly: true });
        expect((copy.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string }).name).toBe("Ops shop");
        copy.close();
        expect(readStatus(dir)).toMatchObject({ lastOk: true, lastFile: out.file, kept: 1 });
        expect(fs.readdirSync(dir).some((n) => n.endsWith(".partial"))).toBe(false);
    });

    it("keeps the newest N, runs the upload command with the file, and does not copy a key that lives in SECRET_KEY", async () => {
        const dir = path.join(root, "backups-b");
        const marker = path.join(root, "uploaded.txt");
        const upload = `node -e "require('fs').appendFileSync(process.argv[1], require('path').basename(process.env.BACKUP_FILE) + '\\n')" "${marker}"`;
        for (const h of [1, 2, 3]) {
            const out = await makeBackup(job(dir, { uploadCommand: upload, secretKeyFromEnv: true }), new Date(Date.UTC(2026, 9, 18, h, 0, 0)));
            expect(out.ok).toBe(true);
            expect(out.uploaded).toBe(true);
        }
        expect(listBackups(dir)).toEqual(["platform-20261018-030000.db", "platform-20261018-020000.db"]);
        expect(fs.readdirSync(dir).some((n) => n.endsWith(".secret"))).toBe(false);
        expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["platform-20261018-010000.db", "platform-20261018-020000.db", "platform-20261018-030000.db"]);
        // A failing upload is reported, and the backup is still kept.
        const failed = await makeBackup(job(dir, { uploadCommand: 'node -e "process.exit(3)"' }), new Date(Date.UTC(2026, 9, 18, 4, 0, 0)));
        expect(failed).toMatchObject({ ok: true, uploaded: false });
        expect(log.some((l) => l.startsWith("error [backup] The upload command failed") && l.includes("exit code 3"))).toBe(true);
    });

    it("refuses a damaged copy and a backup folder that is the data folder", async () => {
        const bad = path.join(root, "damaged.db");
        fs.writeFileSync(bad, Buffer.alloc(8192, 7));
        expect(() => verifyBackupFile(bad)).toThrow(/^Backup check failed/);
        const out = await makeBackup(job(platform.config.dataDir), new Date());
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/must not be the data folder/);
    });

    it("makes one backup per slot and waits after a failure", async () => {
        const dir = path.join(root, "backups-c");
        const sched = startBackupSchedule(job(dir), { kind: "daily", atMinuteUtc: 150 }, 3_600_000);
        try {
            const t1 = new Date(Date.UTC(2026, 9, 18, 3, 0, 0));
            const [a, b] = await Promise.all([sched.tick(t1), sched.tick(t1)]);
            expect([a?.ok, b]).toEqual([true, undefined]);
            expect(await sched.tick(new Date(Date.UTC(2026, 9, 18, 23, 0, 0)))).toBeUndefined();
            const next = await sched.tick(new Date(Date.UTC(2026, 9, 19, 2, 30, 0)));
            expect(next?.ok).toBe(true);
            expect(listBackups(dir).map((n) => new Date(backupTime(n)!).toISOString())).toEqual(["2026-10-19T02:30:00.000Z", "2026-10-18T03:00:00.000Z"]);
        } finally {
            await sched.stop();
        }
    });
});

describe("graceful shutdown", () => {
    async function seed(p: Platform) {
        const pid = p.repo.createProject({ name: "Shutdown" }).id as string;
        const appId = p.repo.createApplication(pid, "http://127.0.0.1:6798", {});
        const suite = p.repo.getOrCreateSuite(pid, "Suite", "suite");
        const t = new Date().toISOString();
        const testIds = ["t-ran", "t-running"].map((id) => {
            p.db.run("INSERT INTO test_cases (id, project_id, suite_id, test_key, title, kind, type, priority, validation_status, framework, spec_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", id, pid, suite, id, id, "web", "functional", "medium", "VALIDATING", "playwright", "{}", t, t);
            return id;
        });
        p.db.run("UPDATE test_cases SET validation_status = 'VALIDATED' WHERE id = 't-ran'");
        // The job is created empty (the seeded rows are bare, not runnable tests the job gates could judge), then names the two tests.
        const job = await p.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        p.db.run("UPDATE generation_jobs SET options_json = ? WHERE id = ?", JSON.stringify({ ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds }), job.id);
        const claimed = p.repo.claimNextJob(60_000, "owner-1")!;
        expect(claimed.id).toBe(job.id);
        return job.id;
    }
    const harness = (p: Platform, worker: { stop(): Promise<void>; leaseOwner: string }) => {
        const exits: number[] = [];
        const lines: string[] = [];
        const state = { shuttingDown: false };
        let closed = false;
        const shutdown = createShutdown({
            repo: p.repo,
            db: p.db,
            worker,
            stopTakingWork: [],
            closeServer: async () => {
                closed = true;
            },
            graceMs: 150,
            stopWaitMs: 300,
            log: (level, msg) => void lines.push(`${level} ${msg}`),
            exit: (c) => void exits.push(c),
            state,
        });
        return { shutdown, exits, lines, state, closed: () => closed };
    };

    it("lets a job that finishes in time keep its real result", async () => {
        const p = newPlatform("shutdown-a");
        const jobId = await seed(p);
        const worker = { leaseOwner: "owner-1", stop: () => new Promise<void>((r) => setTimeout(() => (p.repo.setJobStatus(jobId, "COMPLETED"), r()), 50)) };
        const h = harness(p, worker);
        const run = h.shutdown("SIGTERM");
        expect(h.state.shuttingDown).toBe(true);
        await run;
        expect(h.exits).toEqual([0]);
        expect(h.closed()).toBe(true);
        expect(h.lines.at(-1)).toBe("info [shutdown] Stopped cleanly.");
        const reopened = newPlatform("shutdown-a");
        expect(reopened.repo.getJob(jobId)!.status).toBe("COMPLETED");
        reopened.db.close();
    });

    it("stops a job that does not finish, through its own stop path, and records it as interrupted", async () => {
        const p = newPlatform("shutdown-b");
        const jobId = await seed(p);
        // The job's stop path (job-runner) reacts to the cancel flag: it ends the job as cancelled.
        let release!: () => void;
        const stopped = new Promise<void>((r) => (release = r));
        const poll = setInterval(() => {
            if (p.repo.isCancelRequested(jobId)) {
                clearInterval(poll);
                p.repo.resetValidatingTests(["t-running"], "PENDING", null);
                p.repo.setJobStatus(jobId, "FAILED", "Cancelled");
                release();
            }
        }, 20);
        const h = harness(p, { leaseOwner: "owner-1", stop: () => stopped });
        await h.shutdown("SIGTERM");
        const reopened = newPlatform("shutdown-b");
        const j = reopened.repo.getJob(jobId)!;
        expect(j.status).toBe("FAILED");
        expect(j.error).toBe(INTERRUPTED_MESSAGE);
        expect(reopened.db.get("SELECT lease_owner FROM generation_jobs WHERE id = ?", jobId)?.lease_owner).toBeNull();
        const ev = reopened.db.all("SELECT kind, message FROM agent_events WHERE job_id = ?", jobId).find((e) => e.kind === "job_interrupted");
        expect(ev?.message).toMatch(/^The platform was shut down while this job was running\. It waited 0 s/);
        expect(reopened.db.get("SELECT validation_status AS s FROM test_cases WHERE id = 't-ran'")?.s).toBe("VALIDATED");
        expect(reopened.db.get("SELECT validation_status AS s FROM test_cases WHERE id = 't-running'")?.s).toBe("PENDING");
        expect(h.exits).toEqual([0]);
        reopened.db.close();
    });

    it("marks a job that ignores the stop as interrupted, its running tests back to not run yet", async () => {
        const p = newPlatform("shutdown-c");
        const jobId = await seed(p);
        const h = harness(p, { leaseOwner: "owner-1", stop: () => new Promise<void>(() => undefined) });
        await h.shutdown("SIGTERM");
        expect(h.lines.some((l) => l.includes("did not stop in time"))).toBe(true);
        const reopened = newPlatform("shutdown-c");
        expect(reopened.repo.getJob(jobId)).toMatchObject({ status: "FAILED", error: INTERRUPTED_MESSAGE });
        expect(reopened.db.get("SELECT validation_status AS s FROM test_cases WHERE id = 't-running'")?.s).toBe("PENDING");
        expect(reopened.db.get("SELECT validation_status AS s FROM test_cases WHERE id = 't-ran'")?.s).toBe("VALIDATED");
        // A restarted worker does not pick it up again by itself.
        expect(reopened.repo.reclaimStaleJobs()).toBe(0);
        expect(reopened.repo.claimNextJob(60_000, "owner-2")).toBeUndefined();
        reopened.db.close();
    });

    it("exits at once on a second signal", async () => {
        const p = newPlatform("shutdown-d");
        const h = harness(p, { leaseOwner: "nobody", stop: () => new Promise<void>((r) => setTimeout(r, 100)) });
        const first = h.shutdown("SIGTERM");
        await h.shutdown("SIGINT");
        expect(h.exits).toEqual([1]);
        await first;
    });
});

describe("the real program", () => {
    let child: ChildProcess | undefined;
    const out: string[] = [];
    const err: string[] = [];
    const dataDir = path.join(root, "real-data");
    const backupDir = path.join(root, "real-backups");
    afterAll(() => {
        // Only the exact process this test started.
        if (child && child.exitCode === null) child.kill();
    });

    const cleanEnv = (): NodeJS.ProcessEnv => {
        const env: NodeJS.ProcessEnv = {};
        // No credentials of the machine reach the program (no model is ever called).
        for (const [k, v] of Object.entries(process.env)) if (!/KEY|TOKEN|SECRET|PASSWORD|LLM_|ANTHROPIC|OPENAI|GOOGLE|BACKUP|LOG_|METRICS|READY_|VITEST|NODE_OPTIONS/i.test(k)) env[k] = v;
        return { ...env, DATA_DIR: dataDir, PORT: String(PORT), HOST: "127.0.0.1", API_KEY: KEY, LOG_FORMAT: "json", BACKUP_DIR: backupDir, READY_MIN_FREE_MB: "1", SHUTDOWN_GRACE_SECONDS: "5", LLM_PROVIDER: "anthropic" };
    };

    const waitFor = async <T>(fn: () => Promise<T | undefined>, ms: number): Promise<T> => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const v = await fn().catch(() => undefined);
            if (v !== undefined) return v;
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error(`timed out; stdout: ${out.join("").slice(-1500)} stderr: ${err.join("").slice(-1500)}`);
    };

    it("starts, answers the probes, writes JSON lines without secrets, and makes a first verified backup", async () => {
        child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd: REPO_ROOT, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        child.stdout!.on("data", (b: Buffer) => out.push(b.toString("utf8")));
        child.stderr!.on("data", (b: Buffer) => err.push(b.toString("utf8")));
        const base = `http://127.0.0.1:${PORT}`;
        await waitFor(async () => ((await fetch(`${base}/healthz`)).ok ? true : undefined), 90_000);
        const ready = await waitFor(async () => {
            const r = await fetch(`${base}/readyz`);
            return r.status === 200 ? r.json() : undefined;
        }, 20_000);
        expect(ready).toEqual({ status: "ready" });
        const m = await fetch(`${base}/metrics`, { headers: { "x-api-key": KEY } });
        expect(m.status).toBe(200);
        expect(await m.text()).toContain('aitp_jobs{status="QUEUED"} 0');
        await fetch(`${base}/api/artifacts/nothing.png?key=${KEY}`);
        // The first backup is due at once (none exists yet); the timer looks 5 s after start.
        const name = await waitFor(async () => listBackups(backupDir)[0], 30_000);
        expect(verifyBackupFile(path.join(backupDir, name)).version).toBe(knownSchemaVersion());
        expect(fs.existsSync(path.join(backupDir, `${name}.secret`))).toBe(true);
        const lines = out.join("").split("\n").filter((l) => l.trim());
        const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(parsed.some((o) => o.component === "worker" && /embedded worker started/.test(String(o.msg)))).toBe(true);
        expect(parsed.some((o) => o.component === "http" && o.route === "/api/artifacts/:id")).toBe(true);
        expect(parsed.some((o) => o.component === "backup" && /Made and verified/.test(String(o.msg)))).toBe(true);
        // Node's own process warnings ("(node:123) ...") are not the platform's lines.
        const errLines = err.join("").split("\n").filter((l) => l.trim() && !l.startsWith("(node:") && !l.startsWith("(Use `node --trace"));
        for (const l of errLines) JSON.parse(l);
        expect(errLines.map((l) => JSON.parse(l) as Record<string, unknown>).some((o) => o.component === "llm")).toBe(true);
        expect(out.join("") + err.join("")).not.toContain(KEY);
        // The heartbeat is a database row the API and a separate worker both see (shared-state.ts), not a file in the data folder.
        const seen = new Db(path.join(dataDir, "platform.db"));
        try {
            expect(readHeartbeat(seen)).toBeGreaterThan(0);
        } finally {
            seen.close();
        }
        expect(fs.existsSync(path.join(dataDir, "ops", "worker-heartbeat.json"))).toBe(false);
    }, 150_000);

    it.skipIf(process.platform === "win32")("stops cleanly on SIGTERM", async () => {
        const exited = new Promise<number | null>((r) => child!.once("exit", (code) => r(code)));
        child!.kill("SIGTERM");
        expect(await exited).toBe(0);
        expect(out.join("")).toContain("Stopped cleanly.");
    }, 60_000);
});
