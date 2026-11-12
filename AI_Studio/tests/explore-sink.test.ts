/**
 * Round 51: what an exploration on a runner saves reaches the job's RepoSink on the platform, in order, as the job would have saved it
 * itself. The runner end (agent/remote-sink.ts) talks to the platform end (platform/explore-sink.ts) through a post that sends the
 * body as JSON, as the wire does; the platform end writes to a real RepoSink on a temporary database.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { EXPLORE_CHUNK_BYTES, EXPLORE_FILE_MAX_BYTES } from "../src/agent-protocol/explore-sink.js";
import type { ExplorePost } from "../src/agent/explore-transport.js";
import { remoteGenerationSink } from "../src/agent/remote-sink.js";
import { MEMORY_VERSION, type SiteKnowledge } from "../src/engine/memory/types.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { exploreRepoSink, forgetExploreSink, handleExploreSink, handOverExploreSinks } from "../src/platform/explore-sink.js";
import type { ExploreTaskRef } from "../src/platform/explore-task.js";
import { HttpError } from "../src/platform/http-error.js";
import { localPathOf } from "../src/platform/object-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

let platform: Platform;
let dataDir: string;
let scratch: string;

beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-sink-"));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-runner-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
});

afterAll(() => {
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
});

const spec = (testId: string): TestSpec => TestSpecSchema.parse({ testId, title: `Home ${testId}`, kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] });

let n = 0;
async function newTask(): Promise<{ task: ExploreTaskRef; appId: string }> {
    const { repo } = platform;
    const projectId = repo.createProject({ name: `Explore ${Math.random()}` }).id as string;
    const appId = repo.createApplication(projectId, "http://127.0.0.1:9045", { ...DEFAULT_JOB_OPTIONS }, undefined);
    const job = await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS });
    return { task: { taskId: `task-${++n}`, attempt: 1, jobId: job.id, projectId, agentId: "agent-1" }, appId };
}

/** The wire: JSON both ways, the platform's handler behind it; every body is kept. */
function wire(task: ExploreTaskRef) {
    const bodies: Array<{ calls: Array<{ method: string }> }> = [];
    const post: ExplorePost = async (route, body) => {
        expect(route).toBe("sink");
        const sent = JSON.parse(JSON.stringify(body));
        bodies.push(sent);
        return JSON.parse(JSON.stringify(await handleExploreSink(platform, task, sent)));
    };
    return { post, bodies, methods: () => bodies.flatMap((b) => b.calls.map((c) => c.method)) };
}

const file = (name: string, bytes: Buffer | string) => {
    const p = path.join(scratch, `${Math.random().toString(36).slice(2)}-${name}`);
    fs.writeFileSync(p, bytes);
    return p;
};

const run = (testId: string, artifacts: ScriptRun["artifacts"]): ScriptRun => ({
    testId,
    status: "failed",
    durationMs: 1234,
    error: "Expected the heading",
    failedStepIndex: 0,
    steps: [{ index: 0, title: "Open the home page", status: "failed", error: "not found" }],
    artifacts,
    responses: [],
    metrics: [{ metric: "lcp", value: 900, unit: "ms", budget: 2500 }],
});

const knowledge: SiteKnowledge = {
    version: MEMORY_VERSION,
    origin: "http://127.0.0.1:9045",
    analysedAt: "2026-11-12T00:00:00.000Z",
    siteType: "shop",
    purpose: "Sells things",
    pages: [{ path: "/", type: "home", title: "Home", fp: "0123456789abcdef" }],
    journeys: [],
    apis: [],
    validationKnown: true,
    learned: "One page.",
} as SiteKnowledge;

describe("the remote generation sink", () => {
    it("round-trips every method into the job's RepoSink, in order", async () => {
        const { task, appId } = await newTask();
        const { repo } = platform;
        const w = wire(task);
        const sink = remoteGenerationSink({ post: w.post, dir: path.join(scratch, "baselines") });

        await sink.phase("DISCOVERING", "discovery", "running");
        await sink.counters({ pagesDiscovered: 3 });
        await sink.counters({ pagesDiscovered: 2 }, true);
        await sink.saveModel({ pages: [{ url: "/" }] } as never);
        const key = await sink.nextTestKey("WEB");
        expect(key).toMatch(/^WEB-\d+$/);
        const h = await sink.createTest({ spec: spec(key), framework: "playwright", validation: "PENDING", reason: "first", meta: { origin: "explore" } });
        // Opaque: the runner never sees the database id.
        expect(h.id).toMatch(/^h_/);
        expect(repo.getTest(h.id)).toBeUndefined();
        const tests = repo.listTests(task.projectId);
        expect(tests).toHaveLength(1);
        const dbId = tests[0]!.id;
        expect(tests[0]!.testKey).toBe(key);

        await sink.updateTest(h, { validation: "VALIDATING", attempts: 1 });
        await sink.restoreTest!(h);
        const scriptId = await sink.saveScript(h, { framework: "playwright", filename: `${key}.spec.ts`, content: "test('x', () => {});", language: "typescript" }, true);
        expect(repo.getCurrentScript(dbId, "playwright")?.id).toBe(scriptId);

        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
        await sink.recordExecution(h, scriptId, 1, run(key, [{ kind: "screenshot", path: file("shot.png", png) }]), "2026-11-12T00:00:00.000Z");
        await sink.recordVariant!(h, scriptId, { variant: "firefox", status: "failed", reason: "different", run: run(key, [{ kind: "trace", path: file("trace.zip", "trace") }]) }, "2026-11-12T00:00:01.000Z");
        await sink.recordEnvironment!(h, null, { environment: "staging", status: "failed", run: run(key, [{ kind: "video", path: file("video.webm", "video") }]) }, "2026-11-12T00:00:02.000Z");
        await sink.saveTextArtifact("report", "report.md", "# Report");
        const rs = exploreRepoSink(task.taskId)!;
        const healing = vi.spyOn(rs, "saveHealing");
        const cleanup = vi.spyOn(rs, "saveCleanup");
        const phone = vi.spyOn(rs, "rememberPhone");
        await sink.saveHealing!(h, { status: "none", reason: "nothing better" });
        await sink.saveCleanup!([{ testId: key, seq: 1, method: "POST", path: "/things", id: "7", status: "removed", createdAt: "2026-11-12T00:00:00.000Z" }]);
        await sink.saveMemory!(knowledge, null);
        await sink.rememberPhone!({ exploredOn: { serial: "emulator-5554", emulator: true } });
        const runId = await sink.startAgentRun("author", key);
        sink.agentAction(runId, { tool: "click", args: { name: "Buy" }, ok: true, observation: "clicked" });
        sink.agentAction(runId, { tool: "read", args: {}, ok: false, observation: "nothing" });
        await sink.finishAgentRun(runId, "DONE", "wrote one test");
        const mem = await sink.loadMemory!("http://127.0.0.1:9045");
        await sink.flush();

        expect(w.methods()).toEqual([
            "phase", "counters", "counters", "saveModel", "nextTestKey", "createTest", "updateTest", "restoreTest", "saveScript",
            "recordExecution", "recordVariant", "recordEnvironment", "saveTextArtifact", "saveHealing", "saveCleanup", "saveMemory",
            "rememberPhone", "startAgentRun", "agentAction", "agentAction", "finishAgentRun", "loadMemory",
        ]);
        const job = repo.getJob(task.jobId)!;
        expect(job.status).toBe("DISCOVERING");
        expect(job.counters.pagesDiscovered).toBe(5);
        expect(repo.getApplication(appId)!.model).toEqual({ pages: [{ url: "/" }] });
        const t = repo.getTest(dbId)!;
        expect(t.validationStatus).toBe("PENDING");
        // The base run, the variant run and the environment run, each with its evidence.
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM test_executions WHERE test_case_id = ?", dbId)?.n).toBe(3);
        const arts = repo.listArtifacts({ testId: dbId }) as Array<{ kind: string; path: string }>;
        expect(arts.map((a) => a.kind).sort()).toEqual(["screenshot", "trace", "video"]);
        // The screenshot's bytes arrived intact in the store.
        const shot = arts.find((a) => a.kind === "screenshot")!;
        expect(fs.readFileSync(localPathOf(platform.store, shot.path)!)).toEqual(png);
        expect(repo.listArtifacts({ jobId: task.jobId }).some((a) => a.kind === "report")).toBe(true);
        expect(healing).toHaveBeenCalledWith(expect.objectContaining({ id: dbId }), { status: "none", reason: "nothing better" });
        expect(cleanup.mock.calls[0]![0][0]).toMatchObject({ testId: key, id: "7", status: "removed" });
        expect(phone).toHaveBeenCalledWith({ exploredOn: { serial: "emulator-5554", emulator: true } });
        expect(mem.knowledge?.origin).toBe("http://127.0.0.1:9045");
        const actions = platform.db.all<{ tool: string; ok: number }>("SELECT tool, ok FROM agent_actions WHERE run_id = ? ORDER BY id", runId);
        expect(actions).toEqual([{ tool: "click", ok: 1 }, { tool: "read", ok: 0 }]);
        expect(platform.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id = ?", runId)?.status).toBe("DONE");
        await forgetExploreSink(task.taskId);
    });

    it("sends baselines as bytes and gets them back as files in the task's folder", async () => {
        const { task } = await newTask();
        const w = wire(task);
        const dir = path.join(scratch, "bl-task");
        const sink = remoteGenerationSink({ post: w.post, dir });
        const h = await sink.createTest({ spec: spec("WEB-001"), framework: "playwright", validation: "PENDING" });
        const bytes = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
        const src = file("home-1.png", bytes);
        await sink.saveBaselines(h, [{ name: "home-1.png", path: src }]);
        // The runner's file can go: the platform has its own copy.
        fs.rmSync(src);
        const back = await sink.loadBaselines(h);
        expect(back.map((b) => b.name)).toEqual(["home-1.png"]);
        expect(back[0]!.path.startsWith(dir)).toBe(true);
        expect(fs.readFileSync(back[0]!.path)).toEqual(bytes);
        await sink.flush();
        await forgetExploreSink(task.taskId);
    });

    it("batches what returns nothing and keeps the order under many calls", async () => {
        const { task } = await newTask();
        const w = wire(task);
        const sink = remoteGenerationSink({ post: w.post });
        const runId = await sink.startAgentRun("author", "many");
        for (let i = 0; i < 300; i++) sink.agentAction(runId, { tool: `t${i}`, args: {}, ok: true, observation: "" });
        await sink.flush();
        const tools = platform.db.all<{ tool: string }>("SELECT tool FROM agent_actions WHERE run_id = ? ORDER BY id", runId).map((r) => r.tool);
        expect(tools).toEqual(Array.from({ length: 300 }, (_, i) => `t${i}`));
        // Fewer posts than calls: batched (at most 200 calls a batch).
        expect(w.bodies.length).toBeLessThan(10);
        await forgetExploreSink(task.taskId);
    });

    it("flush waits for everything queued to be accepted", async () => {
        const { task } = await newTask();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const inner = wire(task);
        const post: ExplorePost = async (route, body, o) => {
            await gate;
            return inner.post(route, body, o);
        };
        const sink = remoteGenerationSink({ post });
        await sink.phase("ANALYZING", "understanding", "running");
        let flushed = false;
        const f = sink.flush().then(() => (flushed = true));
        await new Promise((r) => setTimeout(r, 20));
        expect(flushed).toBe(false);
        expect(platform.repo.getJob(task.jobId)!.status).not.toBe("ANALYZING");
        release();
        await f;
        expect(platform.repo.getJob(task.jobId)!.status).toBe("ANALYZING");
        await forgetExploreSink(task.taskId);
    });

    it("ends the job on a refused call: later calls and flush reject with it", async () => {
        const { task } = await newTask();
        const sink = remoteGenerationSink({
            post: async () => {
                throw new HttpError(409, "This task is no longer yours.");
            },
        });
        await sink.phase("DISCOVERING", "discovery", "running");
        await expect(sink.flush()).rejects.toThrow("no longer yours");
        await expect(sink.counters({ pagesDiscovered: 1 })).rejects.toThrow("no longer yours");
        await expect(sink.nextTestKey("WEB")).rejects.toThrow("no longer yours");
        void task;
    });

    it("stops sending once its signal is aborted", async () => {
        const { task } = await newTask();
        const w = wire(task);
        const ac = new AbortController();
        const sink = remoteGenerationSink({ post: w.post, signal: ac.signal });
        ac.abort(new Error("stopped"));
        await expect(sink.phase("DISCOVERING", "discovery", "running")).rejects.toThrow("stopped");
        await expect(sink.flush()).rejects.toThrow("stopped");
        expect(w.bodies).toHaveLength(0);
    });
});

describe("the platform end refuses", () => {
    const refusal = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(HttpError);

    it("a handle it did not make, and one of another project", async () => {
        const a = await newTask();
        const b = await newTask();
        const hA = ((await handleExploreSink(platform, a.task, { calls: [{ method: "createTest", spec: spec("WEB-001"), framework: "playwright", validation: "PENDING" }] })) as { results: Array<{ id: string; testId: string }> }).results[0]!;
        // Task B never made this handle.
        await refusal(handleExploreSink(platform, b.task, { calls: [{ method: "updateTest", h: hA, patch: { validation: "VALIDATED" } }] }));
        // An invented one.
        await refusal(handleExploreSink(platform, a.task, { calls: [{ method: "restoreTest", h: { id: "h_inventedinvented", testId: "WEB-001" } }] }));
        // A database id instead of a handle is not even a handle.
        const dbId = platform.repo.listTests(a.task.projectId)[0]!.id;
        await refusal(handleExploreSink(platform, a.task, { calls: [{ method: "restoreTest", h: { id: dbId, testId: "WEB-001" } }] }));
        // A test that moved to another project since is refused too.
        platform.db.run("UPDATE test_cases SET project_id = ? WHERE id = ?", b.task.projectId, dbId);
        await refusal(handleExploreSink(platform, a.task, { calls: [{ method: "updateTest", h: hA, patch: { validation: "VALIDATED" } }] }));
        platform.db.run("UPDATE test_cases SET project_id = ? WHERE id = ?", a.task.projectId, dbId);
        // Script and agent run ids it did not hand out.
        await refusal(handleExploreSink(platform, a.task, { calls: [{ method: "finishAgentRun", runId: "made-up", status: "DONE" }] }));
        await refusal(handleExploreSink(platform, a.task, { calls: [{ method: "recordExecution", h: hA, scriptId: "made-up", attempt: 1, run: { ...run("WEB-001", []), artifacts: [] }, startedAt: "x" }] }));
        await forgetExploreSink(a.task.taskId);
        await forgetExploreSink(b.task.taskId);
    });

    it("an unknown method, and a path where a file name belongs", async () => {
        const { task } = await newTask();
        await refusal(handleExploreSink(platform, task, { calls: [{ method: "deleteEverything" }] }));
        await refusal(handleExploreSink(platform, task, { calls: [{ method: "saveTextArtifact", kind: "report", name: "../../etc/passwd", content: "x" }] }));
        const h = ((await handleExploreSink(platform, task, { calls: [{ method: "createTest", spec: spec("WEB-001"), framework: "playwright", validation: "PENDING" }] })) as { results: Array<{ id: string; testId: string }> }).results[0]!;
        await refusal(handleExploreSink(platform, task, { calls: [{ method: "saveBaselines", h, files: [{ name: "/tmp/x.png", data: "AAAA" }] }] }));
        await forgetExploreSink(task.taskId);
    });

    it("an oversized file", async () => {
        const { task } = await newTask();
        const w = wire(task);
        const sink = remoteGenerationSink({ post: w.post });
        const h = await sink.createTest({ spec: spec("WEB-001"), framework: "playwright", validation: "PENDING" });
        const big = file("big.png", Buffer.alloc(EXPLORE_FILE_MAX_BYTES + 1));
        await sink.saveBaselines(h, [{ name: "big.png", path: big }]);
        await expect(sink.flush()).rejects.toThrow(/larger than/);
        expect(platform.repo.listArtifacts({ jobId: task.jobId }).filter((a) => a.kind === "baseline")).toHaveLength(0);
        await forgetExploreSink(task.taskId);
    });

    it("uploads evidence larger than one call in chunks, and it arrives whole; evidence past the attempt's cap stays on the runner", async () => {
        const { task } = await newTask();
        const w = wire(task);
        const sink = remoteGenerationSink({ post: w.post });
        const h = await sink.createTest({ spec: spec("WEB-001"), framework: "playwright", validation: "PENDING" });
        const bytes = Buffer.alloc(EXPLORE_FILE_MAX_BYTES + EXPLORE_CHUNK_BYTES + 17);
        for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
        const big = file("video.webm", bytes);
        await sink.recordExecution(h, null, 1, run("WEB-001", [{ kind: "video", path: big }, { kind: "screenshot", path: file("s.png", "png") }]), "x");
        await sink.flush();
        // Four chunks (4 MB, 4 MB, 4 MB, 17 bytes), each on its own, before the call that names the upload.
        expect(w.methods().filter((m) => m === "fileChunk")).toHaveLength(4);
        expect(w.methods().indexOf("recordExecution")).toBeGreaterThan(w.methods().lastIndexOf("fileChunk"));
        const dbId = platform.repo.listTests(task.projectId)[0]!.id;
        const arts = platform.repo.listArtifacts({ testId: dbId }) as Array<{ kind: string; path: string }>;
        expect(arts.map((a) => a.kind).sort()).toEqual(["screenshot", "video"]);
        const got = fs.readFileSync(localPathOf(platform.store, arts.find((a) => a.kind === "video")!.path)!);
        expect(got.length).toBe(bytes.length);
        expect(createHash("sha256").update(got).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
        await forgetExploreSink(task.taskId);
    });

    it("a chunk sent again changes nothing, and an upload that did not arrive whole is refused", async () => {
        const { task } = await newTask();
        const h = ((await handleExploreSink(platform, task, { calls: [{ method: "createTest", spec: spec("WEB-001"), framework: "playwright", validation: "PENDING" }] })) as { results: Array<{ id: string; testId: string }> }).results[0]!;
        const data = Buffer.from("abcdef").toString("base64");
        await handleExploreSink(platform, task, { calls: [{ method: "fileChunk", upload: "u1", offset: 0, data }] });
        await handleExploreSink(platform, task, { calls: [{ method: "fileChunk", upload: "u1", offset: 0, data }] });
        await refusal(handleExploreSink(platform, task, { calls: [{ method: "fileChunk", upload: "u1", offset: 99, data }] }));
        const wireRun = { testId: "WEB-001", status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], responses: [] };
        await refusal(handleExploreSink(platform, task, { calls: [{ method: "recordExecution", h, scriptId: null, attempt: 1, startedAt: "x", run: { ...wireRun, artifacts: [{ kind: "video", upload: { id: "u1", name: "v.webm", size: 7 } }] } }] }));
        await handleExploreSink(platform, task, { calls: [{ method: "recordExecution", h, scriptId: null, attempt: 1, startedAt: "x", run: { ...wireRun, artifacts: [{ kind: "video", upload: { id: "u1", name: "v.webm", size: 6 } }] } }] });
        const dbId = platform.repo.listTests(task.projectId)[0]!.id;
        const video = (platform.repo.listArtifacts({ testId: dbId }) as Array<{ kind: string; path: string }>).find((a) => a.kind === "video")!;
        expect(fs.readFileSync(localPathOf(platform.store, video.path)!, "utf8")).toBe("abcdef");
        await forgetExploreSink(task.taskId);
    });

    it("a new attempt starts from a sink of its own: the old attempt's handles mean nothing to it", async () => {
        const { task } = await newTask();
        const h = ((await handleExploreSink(platform, task, { calls: [{ method: "createTest", spec: spec("WEB-001"), framework: "playwright", validation: "PENDING" }] })) as { results: Array<{ id: string; testId: string }> }).results[0]!;
        await refusal(handleExploreSink(platform, { ...task, attempt: 2 }, { calls: [{ method: "restoreTest", h }] }));
        await forgetExploreSink(task.taskId);
    });
});

describe("a platform restart while a runner explores (round 52)", () => {
    const refusal = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(HttpError);
    const create = (testId: string) => ({ method: "createTest", spec: spec(testId), framework: "playwright", validation: "PENDING" });

    it("a batch sent again with its number is applied once and answered as the first time", async () => {
        const { task } = await newTask();
        const first = (await handleExploreSink(platform, task, { seq: 1, calls: [create("WEB-001"), { method: "loadMemory", origin: "http://127.0.0.1:9045" }] })) as { results: unknown[] };
        const again = (await handleExploreSink(platform, task, { seq: 1, calls: [create("WEB-001"), { method: "loadMemory", origin: "http://127.0.0.1:9045" }] })) as { results: unknown[] };
        expect(again.results).toEqual(first.results);
        expect(platform.repo.listTests(task.projectId)).toHaveLength(1);
        // A number skipped or one from before the last is refused.
        await refusal(handleExploreSink(platform, task, { seq: 3, calls: [create("WEB-002")] }));
        await handleExploreSink(platform, task, { seq: 2, calls: [create("WEB-002")] });
        await refusal(handleExploreSink(platform, task, { seq: 1, calls: [create("WEB-001"), { method: "loadMemory", origin: "x" }] }));
        expect(platform.repo.listTests(task.projectId)).toHaveLength(2);
        await forgetExploreSink(task.taskId, platform);
    });

    it("after a hand-over the next process knows the handles, the scripts and the last batch from the task's row", async () => {
        const { task } = await newTask();
        const h = ((await handleExploreSink(platform, task, { seq: 1, calls: [create("WEB-001")] })) as { results: Array<{ id: string; testId: string }> }).results[0]!;
        const sid = ((await handleExploreSink(platform, task, { seq: 2, calls: [{ method: "saveScript", h, script: { framework: "playwright", filename: "a.spec.ts", content: "test()", language: "typescript" }, executable: true }] })) as { results: string[] }).results[0]!;
        // The process lets go of the task (a graceful restart); everything it knew is now read back from the database.
        await handOverExploreSinks(task.jobId);
        expect(exploreRepoSink(task.taskId)).toBeUndefined();
        // The answer to batch 2 was lost: the runner sends it again and gets the same script id, and nothing new is saved.
        const again = (await handleExploreSink(platform, task, { seq: 2, calls: [{ method: "saveScript", h, script: { framework: "playwright", filename: "a.spec.ts", content: "test()", language: "typescript" }, executable: true }] })) as { results: string[] };
        expect(again.results[0]).toBe(sid);
        await handleExploreSink(platform, task, { seq: 3, calls: [{ method: "updateTest", h, patch: { validation: "VALIDATED" } }, { method: "recordExecution", h, scriptId: sid, attempt: 1, startedAt: "x", run: { testId: "WEB-001", status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], responses: [], artifacts: [] } }] });
        const dbId = platform.repo.listTests(task.projectId)[0]!.id;
        expect(platform.repo.getTest(dbId)!.validationStatus).toBe("VALIDATED");
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generated_scripts WHERE test_case_id = ?", dbId)?.n).toBe(1);
        await forgetExploreSink(task.taskId, platform);
        expect(platform.db.get<{ s: string | null }>("SELECT sink_json AS s FROM explore_task_state WHERE task_id = ?", task.taskId)?.s).toBeNull();
    });

    it("the runner sends a batch again while the platform is away, and the exploration carries on", { timeout: 20_000 }, async () => {
        const { task } = await newTask();
        let away = 2;
        const bodies: Array<{ seq?: number }> = [];
        const post: ExplorePost = async (_route, body) => {
            const sent = JSON.parse(JSON.stringify(body));
            bodies.push(sent);
            const answer = JSON.parse(JSON.stringify(await handleExploreSink(platform, task, sent)));
            // The platform applied it, then went away before the answer reached the runner.
            if (away-- > 0) throw Object.assign(new Error("The platform had a problem (HTTP 503)."), { name: "ExplorePostError", status: 503 });
            return answer;
        };
        // Tried again after 1 s and 2 s (explore-transport.ts).
        const sink = remoteGenerationSink({ post });
        const h = await sink.createTest({ spec: spec("WEB-001"), framework: "playwright", validation: "PENDING" });
        expect(h.testId).toBe("WEB-001");
        await sink.flush();
        expect(bodies.map((b) => b.seq)).toEqual([1, 1, 1]);
        expect(platform.repo.listTests(task.projectId)).toHaveLength(1);
        await forgetExploreSink(task.taskId, platform);
    });

    it("a refusal of the platform's own is not sent again", async () => {
        let posts = 0;
        const post: ExplorePost = async () => {
            posts++;
            throw Object.assign(new Error("The platform refused (HTTP 400)."), { name: "ExplorePostError", status: 400 });
        };
        const sink = remoteGenerationSink({ post });
        await sink.phase("DISCOVERING", "discovery", "running");
        await expect(sink.flush()).rejects.toThrow(/HTTP 400/);
        expect(posts).toBe(1);
    });
});
