/**
 * The engine boundary of migration stage M1 (POSTGRES_S3_MIGRATION.md 3.2): one job's writes keep their order, whether the stores behind them
 * are synchronous (today) or not (M2-M3, simulated here with a write that takes a moment), and all of them are stored before the job's final
 * status, also when the job throws or is cancelled. The engine's Settings values come from a cache it never waits on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { promptCacheSetting, setPromptCacheSource } from "../src/engine/llm/prompt-cache.js";
import type { EngineEvent } from "../src/engine/context.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runJob } from "../src/platform/job-runner.js";
import { JobWriteQueue } from "../src/platform/job-write-queue.js";
import { installPromptCache, savePromptCache } from "../src/platform/prompt-cache-settings.js";
import { DEFAULT_JOB_OPTIONS, type JobRow } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { SETTINGS_REFRESH_MS, SettingsCache } from "../src/platform/settings-cache.js";

const later = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms));

describe("the per-job write queue", () => {
    it("runs a synchronous write at once while nothing waits, as the direct call did", () => {
        const q = new JobWriteQueue();
        const seen: number[] = [];
        q.push(() => seen.push(1));
        expect(seen).toEqual([1]);
        expect(q.pending).toBe(false);
    });

    it("hands a synchronous failure of an idle queue to the caller, as the direct call did", async () => {
        const q = new JobWriteQueue();
        expect(() =>
            q.push(() => {
                throw new Error("disk full");
            }),
        ).toThrow("disk full");
        await expect(
            q.run(() => {
                throw new Error("disk full");
            }),
        ).rejects.toThrow("disk full");
    });

    it("keeps the order under many writes, slow and fast, pushed and awaited", async () => {
        const q = new JobWriteQueue();
        const seen: number[] = [];
        const awaited: Array<Promise<number>> = [];
        for (let i = 0; i < 500; i++) {
            if (i % 50 === 0) {
                q.push(async () => {
                    await later();
                    seen.push(i);
                });
            } else if (i % 7 === 0) {
                awaited.push(q.run(() => (seen.push(i), i)));
            } else {
                q.push(() => seen.push(i));
            }
        }
        await q.flush();
        expect(seen).toEqual(Array.from({ length: 500 }, (_, i) => i));
        expect(q.pending).toBe(false);
        // An awaited write gets its own result back.
        expect((await Promise.all(awaited)).every((v) => v % 7 === 0)).toBe(true);
    });

    it("carries on after a queued write fails, reports it, and flush does not reject", async () => {
        const failures: unknown[] = [];
        const q = new JobWriteQueue((e) => failures.push(e));
        const seen: string[] = [];
        q.push(async () => {
            await later();
            seen.push("a");
        });
        q.push(() => {
            throw new Error("lost connection");
        });
        const rejected = q.run(() => {
            throw new Error("refused");
        });
        q.push(() => seen.push("b"));
        await expect(rejected).rejects.toThrow("refused");
        await q.flush();
        expect(seen).toEqual(["a", "b"]);
        expect(failures).toHaveLength(1);
    });

    it("flush also waits for writes handed in while it waits", async () => {
        const q = new JobWriteQueue();
        const seen: string[] = [];
        q.push(async () => {
            await later();
            seen.push("first");
            q.push(async () => {
                await later();
                seen.push("second");
            });
        });
        await q.flush();
        expect(seen).toEqual(["first", "second"]);
    });

    it("goes back to running writes at once when the queue has drained", async () => {
        const q = new JobWriteQueue();
        q.push(() => later());
        await q.flush();
        const seen: number[] = [];
        q.push(() => seen.push(1));
        expect(seen).toEqual([1]);
    });
});

describe("a job's writes through the sink and the job runner", () => {
    let platform: Platform;
    let dataDir: string;

    beforeAll(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sink-queue-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(() => {
        platform?.db.close();
        setPromptCacheSource(undefined);
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    /** A claimed job of the given tests. */
    const claimed = async (testIds: string[]): Promise<JobRow> => {
        const { repo } = platform;
        const projectId = repo.createProject({ name: `Queue ${Math.random()}` }).id as string;
        const appId = repo.createApplication(projectId, "http://127.0.0.1:1", { ...DEFAULT_JOB_OPTIONS }, undefined);
        const job = await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds });
        // Jobs of earlier tests are finished, so the next one in line is this one.
        const row = repo.claimNextJob(60_000, "owner-1");
        expect(row?.id).toBe(job.id);
        return row!;
    };

    /** Event writes that take a moment, as they will on a network database; what reached the store, in the order it did. */
    const slowEvents = () => {
        const { repo } = platform;
        const log: string[] = [];
        const addEvent = repo.addEvent.bind(repo);
        vi.spyOn(repo, "addEvent").mockImplementation(((jobId: string, e: EngineEvent) =>
            later().then(() => {
                addEvent(jobId, e);
                log.push(e.kind);
            })) as never);
        const setJobStatus = repo.setJobStatus.bind(repo);
        vi.spyOn(repo, "setJobStatus").mockImplementation((jobId, status, error) => {
            log.push(`status:${status}`);
            setJobStatus(jobId, status, error);
        });
        return log;
    };

    const run = (job: JobRow) => runJob({ repo: platform.repo, store: platform.store, config: platform.config, llm: platform.llm }, job, "owner-1");
    const storedKinds = (jobId: string) => platform.repo.listEvents(jobId).map((e) => e.kind as string);

    it("keeps many events in order through the sink", async () => {
        const job = await claimed([]);
        const sink = new RepoSink(platform.repo, platform.store, job);
        slowEvents();
        const kinds = Array.from({ length: 100 }, (_, i) => `k${i}`);
        for (const kind of kinds) sink.event({ stage: "validation", kind, message: kind });
        await sink.writes.flush();
        expect(storedKinds(job.id)).toEqual(kinds);
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    });

    it("stores an agent's actions before the run they belong to is finished", async () => {
        const job = await claimed([]);
        const { repo } = platform;
        const sink = new RepoSink(repo, platform.store, job);
        const log: string[] = [];
        const addAgentAction = repo.addAgentAction.bind(repo);
        vi.spyOn(repo, "addAgentAction").mockImplementation(((runId: string, a: Parameters<typeof repo.addAgentAction>[1]) =>
            later().then(() => {
                addAgentAction(runId, a);
                log.push(a.tool);
            })) as never);
        const finishAgentRun = repo.finishAgentRun.bind(repo);
        vi.spyOn(repo, "finishAgentRun").mockImplementation((...a) => {
            log.push("finished");
            finishAgentRun(...a);
        });
        const runId = await sink.startAgentRun("web-authoring", "A scenario");
        sink.agentAction(runId, { tool: "click", args: {}, ok: true, observation: "" });
        sink.agentAction(runId, { tool: "fill", args: {}, ok: true, observation: "" });
        await sink.finishAgentRun(runId, "done", "ok");
        expect(log).toEqual(["click", "fill", "finished"]);
        repo.setJobStatus(job.id, "FAILED", "test over");
    });

    it("stores every event before the job's final status", async () => {
        const job = await claimed(["gone"]);
        const log = slowEvents();
        await run(job);
        const end = log.indexOf("status:FAILED");
        expect(end).toBeGreaterThan(-1);
        expect(log.slice(0, end)).toContain("job_started");
        expect(log.slice(0, end)).toContain("test_missing");
        expect(storedKinds(job.id).slice(0, 2)).toEqual(log.slice(0, 2));
        expect(platform.repo.getJob(job.id)?.status).toBe("FAILED");
    });

    it("keeps the events of a job that throws, the failure last, before its final status", async () => {
        const job = await claimed(["boom"]);
        const log = slowEvents();
        vi.spyOn(platform.repo, "getTest").mockImplementation(() => {
            throw new Error("the job fell over");
        });
        await run(job);
        expect(log.slice(0, log.indexOf("status:FAILED"))).toEqual(expect.arrayContaining(["job_started", "job_failed"]));
        expect(log.indexOf("job_started")).toBeLessThan(log.indexOf("job_failed"));
        expect(log.indexOf("job_failed")).toBeLessThan(log.indexOf("status:FAILED"));
        expect(storedKinds(job.id)).toEqual(expect.arrayContaining(["job_started", "job_failed"]));
        expect(platform.repo.getJob(job.id)?.error).toBe("the job fell over");
    });

    it("keeps the events of a cancelled job, the cancel last, before its final status", async () => {
        const job = await claimed(["boom"]);
        const log = slowEvents();
        const interval = vi.spyOn(globalThis, "setInterval");
        const { repo } = platform;
        vi.spyOn(repo, "isCancelRequested").mockReturnValue(true);
        vi.spyOn(repo, "getTest").mockImplementation(() => {
            // The job runner's own five-second check, run now: it sees the cancel and aborts.
            const tick = interval.mock.calls.find((c) => c[1] === 5_000)?.[0] as () => void;
            tick();
            throw new Error("aborted");
        });
        await run(job);
        expect(log.indexOf("job_started")).toBeLessThan(log.indexOf("job_cancelled"));
        expect(log.indexOf("job_cancelled")).toBeGreaterThan(-1);
        expect(log.indexOf("job_cancelled")).toBeLessThan(log.indexOf("status:FAILED"));
        expect(storedKinds(job.id)).toEqual(expect.arrayContaining(["job_started", "job_cancelled"]));
        expect(repo.getJob(job.id)?.error).toBe("Cancelled");
    });

    it("sees a save on this process at once, through the engine's own read", () => {
        installPromptCache(platform.db);
        savePromptCache(platform.db, false);
        expect(promptCacheSetting({ LLM_PROMPT_CACHE: "" })).toMatchObject({ enabled: false, source: "app" });
        savePromptCache(platform.db, true);
        expect(promptCacheSetting({ LLM_PROMPT_CACHE: "" })).toMatchObject({ enabled: true, source: "app" });
        savePromptCache(platform.db, null);
        expect(promptCacheSetting({ LLM_PROMPT_CACHE: "" }).source).toBe("default");
    });
});

describe("the settings cache", () => {
    it("reads once at start, and not again within the refresh interval", () => {
        let reads = 0;
        let clock = 1_000;
        const c = new SettingsCache(() => ++reads, { refreshMs: 5_000, now: () => clock });
        expect(reads).toBe(1);
        for (let i = 0; i < 50; i++) expect(c.get()).toBe(1);
        clock += 4_999;
        expect(c.get()).toBe(1);
        expect(reads).toBe(1);
    });

    it("sees a save on another process once the interval has passed", () => {
        let stored = "old";
        let clock = 0;
        const c = new SettingsCache(() => stored, { refreshMs: SETTINGS_REFRESH_MS, now: () => clock });
        stored = "saved elsewhere";
        expect(c.get()).toBe("old");
        clock += SETTINGS_REFRESH_MS;
        expect(c.get()).toBe("saved elsewhere");
    });

    it("sees a save on this process at once, however recent the last read", async () => {
        let stored = "old";
        const c = new SettingsCache(() => stored, { now: () => 0 });
        stored = "saved here";
        await c.refresh();
        expect(c.get()).toBe("saved here");
    });

    it("never waits on an asynchronous read: it answers with what it has, and at most one re-read runs", async () => {
        let stored = "old";
        let reads = 0;
        let clock = 0;
        const c = new SettingsCache(
            async () => {
                reads++;
                await later();
                return stored;
            },
            { refreshMs: 1_000, now: () => clock },
        );
        expect(c.get()).toBeUndefined();
        await later(10);
        expect(c.get()).toBe("old");
        stored = "new";
        clock += 1_000;
        const before = reads;
        expect(c.get()).toBe("old");
        expect(c.get()).toBe("old");
        expect(reads).toBe(before + 1);
        await later(10);
        expect(c.get()).toBe("new");
    });

    it("does not let a slow old read overwrite a newer one", async () => {
        const gates: Array<(v: string) => void> = [];
        const c = new SettingsCache(() => new Promise<string>((r) => gates.push(r)), { now: () => 0 });
        const second = c.refresh();
        gates[1]!("newer");
        await second;
        gates[0]!("older");
        await later();
        expect(c.get()).toBe("newer");
    });

    it("keeps the last value when a read fails", async () => {
        let fail = false;
        const c = new SettingsCache(
            () => {
                if (fail) throw new Error("table gone");
                return "kept";
            },
            { now: () => 0 },
        );
        fail = true;
        await c.refresh();
        expect(c.get()).toBe("kept");
    });
});
