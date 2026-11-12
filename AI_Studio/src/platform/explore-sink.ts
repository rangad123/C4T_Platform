/**
 * Round 51: the platform end of what an exploration job on a runner saves (POST /api/agent/tasks/:id/explore/sink, mounted in
 * routes/agents.ts, which has already checked the runner token, the task's owner and its attempt).
 *
 * Each task attempt gets the job's own RepoSink, built as job-runner.ts runJobAs builds it, and every call is applied to it in the order
 * received. Nothing from the runner is trusted: every message is checked against its schema, a test handle is one this sink made (and its
 * test is this job's project's), script and agent run ids are ones it handed out, and files arrive as bytes, written by the platform into
 * a folder of its own under names it checked. A path from the runner is never used.
 *
 * Round 52, a platform restart: what the sink must remember between calls (the handles it made, the scripts and agent runs it handed out,
 * the bytes moved, the number of the last batch applied and its answers) is kept in the task's row of explore_task_state after every
 * batch, so the next platform process carries on where this one stopped. The runner sends a batch that got no answer again with the same
 * number: a number already applied is answered as before (reads are read again), never applied twice. Large evidence arrives in chunks
 * (`fileChunk`), each written at its offset into the attempt's folder, which keeps the same name across a restart.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScriptRun } from "../engine/validation/runner.js";
import type { TestHandle } from "../engine/orchestrator.js";
import { EXPLORE_CALL_FILES_MAX_BYTES, EXPLORE_CHUNK_BYTES, EXPLORE_FILE_MAX_BYTES, EXPLORE_TASK_MAX_BYTES, SinkRequest, type SinkCall, type WireFile, type WireSinkRun } from "../agent-protocol/explore-sink.js";
import { SafeName } from "../agent-protocol/schema.js";
import type { Platform } from "./bootstrap.js";
import type { ExploreTaskRef } from "./explore-task.js";
import { HttpError } from "./http-error.js";
import { RepoSink } from "./repo-sink.js";
import { applyAgentCall } from "./agent-on-runner.js";

interface TaskSink {
    attempt: number;
    jobId: string;
    /** The number of the last batch applied (0: none yet), and its answers (reads left out: they are read again). */
    seq: number;
    last: unknown[];
    sink: RepoSink;
    /** Opaque wire handle -> the test it stands for. */
    handles: Map<string, TestHandle>;
    scripts: Set<string>;
    agentRuns: Set<string>;
    /** File bytes this attempt moved, both ways. */
    bytes: number;
    /** This attempt's own folder for the files it sends (removed when it is forgotten). */
    dir: string;
    /** Calls of this task are applied one batch after the other. */
    chain: Promise<unknown>;
}

const sinks = new Map<string, TaskSink>();
/** Round 52: tests a task works on that it did not create (a described test being rebuilt), by wire handle; set before the task is offered. */
const presets = new Map<string, Array<[string, TestHandle]>>();

/** Name an existing test of the job for this task's runner (an opaque handle, as createTest answers). Dropped with dropExplorePresets. */
export function presetExploreHandle(taskId: string, real: TestHandle): { id: string; testId: string } {
    const id = `h_${randomBytes(12).toString("base64url")}`;
    presets.set(taskId, [...(presets.get(taskId) ?? []), [id, real]]);
    return { id, testId: real.testId };
}
export const dropExplorePresets = (taskId: string): void => void presets.delete(taskId);

/** Answers read again when a batch is sent a second time: they are not kept (baselines are large) and reading twice changes nothing. */
const READS = new Set<string>(["loadMemory", "loadBaselines", "approvalState"]);

/** The attempt's folder: the same name in the next platform process, so uploads made before a restart are still there. */
const folderOf = (task: ExploreTaskRef) => path.join(os.tmpdir(), `explore-sink-${task.taskId.replace(/[^A-Za-z0-9-]/g, "_").slice(0, 80)}-${task.attempt}`);

interface Saved {
    seq: number;
    last: unknown[];
    handles: Array<[string, TestHandle]>;
    scripts: string[];
    agentRuns: string[];
    bytes: number;
}

/** What the next platform process needs to carry on: written after every batch (the job's writes of that batch are stored first). */
function save(p: Platform, taskId: string, s: TaskSink): void {
    const state: Saved = { seq: s.seq, last: s.last, handles: [...s.handles], scripts: [...s.scripts], agentRuns: [...s.agentRuns], bytes: s.bytes };
    p.repo.db.run(
        "INSERT INTO explore_task_state (task_id, attempt, sink_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET attempt = excluded.attempt, sink_json = excluded.sink_json, updated_at = excluded.updated_at",
        taskId,
        s.attempt,
        JSON.stringify(state),
        new Date().toISOString(),
    );
}

function loadSaved(p: Platform, task: ExploreTaskRef): Saved | undefined {
    const row = p.repo.db.get<{ attempt: number; sink_json: string | null }>("SELECT attempt, sink_json FROM explore_task_state WHERE task_id = ?", task.taskId);
    if (!row?.sink_json || row.attempt !== task.attempt) return undefined;
    try {
        return JSON.parse(row.sink_json) as Saved;
    } catch {
        return undefined;
    }
}

const refuse = (message: string): never => {
    throw new HttpError(400, message);
};

/** The task's sink is no longer needed (the task ended or moved to another attempt): what it queued is stored, its folder removed. */
export async function forgetExploreSink(taskId: string, p?: Pick<Platform, "repo">): Promise<void> {
    const s = sinks.get(taskId);
    if (s) {
        sinks.delete(taskId);
        await s.chain.catch(() => undefined);
        await s.sink.writes.flush();
        await fs.rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
    }
    try {
        p?.repo.db.run("UPDATE explore_task_state SET sink_json = NULL WHERE task_id = ?", taskId);
    } catch {
        // Only bookkeeping: a row left behind is read by nobody.
    }
}

/**
 * A graceful restart hands the job over (runner-handover.ts): the batches of its tasks still being applied finish and their writes are
 * stored, then this process lets go of them. Their saved state and folders stay for the next process.
 */
export async function handOverExploreSinks(jobId: string): Promise<void> {
    for (const [taskId, s] of [...sinks]) {
        if (s.jobId !== jobId) continue;
        await s.chain.catch(() => undefined);
        await s.sink.writes.flush();
        if (sinks.get(taskId) === s) sinks.delete(taskId);
    }
}

/** The RepoSink of this task's attempt (for the job's own bookkeeping: flush, restoreInterrupted, keepSteps). */
export function exploreRepoSink(taskId: string): RepoSink | undefined {
    return sinks.get(taskId)?.sink;
}

async function sinkFor(p: Platform, task: ExploreTaskRef): Promise<TaskSink> {
    const had = sinks.get(task.taskId);
    if (had && had.attempt === task.attempt) return had;
    if (had) await forgetExploreSink(task.taskId);
    const job = p.repo.getJob(task.jobId);
    if (!job || job.projectId !== task.projectId) throw new HttpError(404, "The job of this task was not found.");
    // After a restart: what the previous platform process kept of this attempt.
    const saved = loadSaved(p, task);
    const dir = folderOf(task);
    if (!saved) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await fs.mkdir(path.join(dir, "uploads"), { recursive: true });
    const fresh: TaskSink = {
        attempt: task.attempt,
        jobId: job.id,
        seq: saved?.seq ?? 0,
        last: saved?.last ?? [],
        sink: new RepoSink(p.repo, p.store, { id: job.id, projectId: job.projectId, applicationId: job.applicationId, mode: job.options.mode }),
        handles: new Map([...(presets.get(task.taskId) ?? []), ...(saved?.handles ?? [])]),
        scripts: new Set(saved?.scripts ?? []),
        agentRuns: new Set(saved?.agentRuns ?? []),
        bytes: saved?.bytes ?? 0,
        dir,
        chain: Promise.resolve(),
    };
    // Two calls of a new attempt at once build it once.
    const raced = sinks.get(task.taskId);
    if (raced && raced.attempt === task.attempt) return raced;
    sinks.set(task.taskId, fresh);
    return fresh;
}

export async function handleExploreSink(p: Platform, task: ExploreTaskRef, body: unknown): Promise<unknown> {
    const parsed = SinkRequest.safeParse(body);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        refuse(`The runner sent a save the platform does not accept (${issue?.path.join(".") || "message"}: ${issue?.message ?? "invalid"}).`);
    }
    const s = await sinkFor(p, task);
    const { calls, seq } = parsed.data!;
    const go = s.chain.then(async () => {
        if (seq !== undefined && seq <= s.seq) {
            // Sent again (its answer was lost to a restart): answered as the first time, nothing applied twice.
            if (seq !== s.seq || s.last.length !== calls.length) refuse("The runner sent an earlier save again, out of order.");
            const results: unknown[] = [];
            for (const [i, c] of calls.entries()) results.push(READS.has(c.method) ? ((await apply(p, task, s, c)) ?? null) : (s.last[i] ?? null));
            return { results };
        }
        if (seq !== undefined && seq !== s.seq + 1) refuse("The runner skipped a save: the exploration cannot carry on.");
        const results: unknown[] = [];
        for (const c of calls) results.push((await apply(p, task, s, c)) ?? null);
        // Stored before the number is: a restart after this point never applies the batch again.
        await s.sink.writes.flush();
        if (seq !== undefined) {
            s.seq = seq;
            s.last = calls.map((c, i) => (READS.has(c.method) ? null : results[i]));
        }
        save(p, task.taskId, s);
        return { results };
    });
    s.chain = go.catch(() => undefined);
    return go;
}

function handle(p: Platform, task: ExploreTaskRef, s: TaskSink, h: { id: string; testId: string }): TestHandle {
    const real = s.handles.get(h.id);
    if (!real || real.testId !== h.testId) return refuse("The runner named a test this job did not create.");
    if (p.repo.getTest(real.id)?.projectId !== task.projectId) return refuse("The runner named a test of another project.");
    return real;
}

function scriptId(s: TaskSink, id: string | null): string | null {
    if (id !== null && !s.scripts.has(id)) refuse("The runner named a script this job did not save.");
    return id;
}

function agentRun(s: TaskSink, id: string): string {
    if (!s.agentRuns.has(id)) refuse("The runner named an agent run this job did not start.");
    return id;
}

/** The files of one call, checked against the caps and written to a folder of their own. */
async function receive(s: TaskSink, files: WireFile[]): Promise<{ dir: string; paths: string[] }> {
    const bufs = files.map((f) => Buffer.from(f.data, "base64"));
    let total = 0;
    for (const [i, b] of bufs.entries()) {
        if (b.length > EXPLORE_FILE_MAX_BYTES) refuse(`The file ${files[i]!.name} is larger than the ${EXPLORE_FILE_MAX_BYTES / 1024 / 1024} MB a runner may send.`);
        total += b.length;
    }
    if (total > EXPLORE_CALL_FILES_MAX_BYTES) refuse("The runner sent more file bytes in one save than the platform accepts.");
    if (s.bytes + total > EXPLORE_TASK_MAX_BYTES) refuse("This exploration has sent more files than the platform accepts for one job.");
    s.bytes += total;
    const dir = path.join(s.dir, randomBytes(8).toString("hex"));
    await fs.mkdir(dir);
    const paths: string[] = [];
    for (const [i, f] of files.entries()) {
        const file = path.join(dir, `${i}`, f.name);
        await fs.mkdir(path.dirname(file));
        await fs.writeFile(file, bufs[i]!);
        paths.push(file);
    }
    return { dir, paths };
}

/** One chunk of an upload, written at its offset (a chunk sent again writes the same bytes). Its new bytes count toward the attempt's cap. */
async function chunk(s: TaskSink, upload: string, offset: number, data: string): Promise<null> {
    const buf = Buffer.from(data, "base64");
    if (buf.length > EXPLORE_CHUNK_BYTES) refuse("The runner sent a larger piece of a file than the platform accepts.");
    const file = path.join(s.dir, "uploads", upload);
    const size = (await fs.stat(file).catch(() => undefined))?.size ?? 0;
    if (offset > size) refuse("The runner sent a piece of a file out of order.");
    const grows = Math.max(0, offset + buf.length - size);
    if (s.bytes + grows > EXPLORE_TASK_MAX_BYTES) refuse("This exploration has sent more files than the platform accepts for one job.");
    const fh = await fs.open(file, size === 0 && offset === 0 ? "w" : "r+");
    try {
        await fh.write(buf, 0, buf.length, offset);
    } finally {
        await fh.close();
    }
    s.bytes += grows;
    return null;
}

/** Applies `fn` to a ScriptRun rebuilt from the wire, its evidence written to the platform's own folder, which is removed after. */
async function withRun<T>(s: TaskSink, w: WireSinkRun | undefined, fn: (run: ScriptRun | undefined) => Promise<T>): Promise<T> {
    if (!w) return fn(undefined);
    const inline = w.artifacts.flatMap((a) => ("file" in a ? [a.file] : []));
    const got = await receive(s, inline);
    try {
        const { artifacts, ...rest } = w;
        let next = 0;
        const files: ScriptRun["artifacts"] = [];
        for (const a of artifacts) {
            if ("file" in a) {
                files.push({ kind: a.kind, path: got.paths[next++]! });
                continue;
            }
            // An uploaded file: complete, then moved next to the call's own files under the name it was given.
            const from = path.join(s.dir, "uploads", a.upload.id);
            const size = (await fs.stat(from).catch(() => undefined))?.size;
            if (size !== a.upload.size) refuse(`The file ${a.upload.name} did not arrive whole.`);
            const to = path.join(got.dir, `u-${a.upload.id}`, a.upload.name);
            await fs.mkdir(path.dirname(to));
            await fs.rename(from, to);
            files.push({ kind: a.kind, path: to });
        }
        return await fn({ ...rest, artifacts: files });
    } finally {
        await fs.rm(got.dir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function apply(p: Platform, task: ExploreTaskRef, s: TaskSink, c: SinkCall): Promise<unknown> {
    const k = s.sink;
    switch (c.method) {
        case "phase":
            return k.phase(c.status, c.phase, c.state);
        case "counters":
            return k.counters(c.patch, c.add);
        case "saveModel":
            return k.saveModel(c.model as unknown as Parameters<RepoSink["saveModel"]>[0]);
        case "nextTestKey":
            return k.nextTestKey(c.prefix);
        case "createTest": {
            const real = await k.createTest({ spec: c.spec, framework: c.framework, validation: c.validation, reason: c.reason, meta: c.meta });
            const id = `h_${randomBytes(12).toString("base64url")}`;
            s.handles.set(id, real);
            return { id, testId: real.testId };
        }
        case "updateTest":
            return k.updateTest(handle(p, task, s, c.h), c.patch);
        case "restoreTest":
            return k.restoreTest(handle(p, task, s, c.h));
        case "saveScript": {
            const id = await k.saveScript(handle(p, task, s, c.h), c.script, c.executable);
            s.scripts.add(id);
            return id;
        }
        case "recordExecution": {
            const h = handle(p, task, s, c.h);
            const sid = scriptId(s, c.scriptId);
            return withRun(s, c.run, (run) => k.recordExecution(h, sid, c.attempt, run!, c.startedAt));
        }
        case "recordVariant": {
            const h = handle(p, task, s, c.h);
            const sid = scriptId(s, c.scriptId);
            return withRun(s, c.r.run, (run) => k.recordVariant(h, sid, { ...c.r, run }, c.startedAt));
        }
        case "recordEnvironment": {
            const h = handle(p, task, s, c.h);
            const sid = scriptId(s, c.scriptId);
            return withRun(s, c.r.run, (run) => k.recordEnvironment(h, sid, { ...c.r, run }, c.startedAt));
        }
        case "saveTextArtifact":
            return k.saveTextArtifact(c.kind, c.name, c.content);
        case "saveHealing":
            return k.saveHealing(handle(p, task, s, c.h), c.result);
        case "saveCleanup":
            return k.saveCleanup(c.items as Parameters<RepoSink["saveCleanup"]>[0]);
        case "loadMemory":
            return k.loadMemory(c.origin);
        case "saveMemory":
            return k.saveMemory(c.knowledge, c.changes);
        case "rememberPhone":
            return k.rememberPhone(c.d);
        case "fileChunk":
            return chunk(s, c.upload, c.offset, c.data);
        case "saveBaselines": {
            const h = handle(p, task, s, c.h);
            const got = await receive(s, c.files);
            try {
                return await k.saveBaselines(
                    h,
                    c.files.map((f, i) => ({ name: f.name, path: got.paths[i]! })),
                );
            } finally {
                await fs.rm(got.dir, { recursive: true, force: true }).catch(() => undefined);
            }
        }
        case "loadBaselines": {
            const files = await k.loadBaselines(handle(p, task, s, c.h));
            const out: WireFile[] = [];
            let total = 0;
            for (const f of files) {
                if (!SafeName.safeParse(f.name).success) continue;
                const b = await fs.readFile(f.path).catch(() => undefined);
                if (!b) continue;
                if (b.length > EXPLORE_FILE_MAX_BYTES) refuse(`The baseline ${f.name} is larger than the ${EXPLORE_FILE_MAX_BYTES / 1024 / 1024} MB a runner may receive.`);
                total += b.length;
                out.push({ name: f.name, data: b.toString("base64") });
            }
            if (total > EXPLORE_CALL_FILES_MAX_BYTES || s.bytes + total > EXPLORE_TASK_MAX_BYTES) refuse("This test's baselines are more than the platform sends to a runner at once.");
            s.bytes += total;
            return out;
        }
        case "startAgentRun": {
            const id = await k.startAgentRun(c.role, c.subject);
            s.agentRuns.add(id);
            return id;
        }
        case "agentAction":
            k.agentAction(agentRun(s, c.runId), c.a);
            return null;
        case "finishAgentRun":
            return k.finishAgentRun(agentRun(s, c.runId), c.status, c.summary);
        case "agentStep":
        case "agentTokens":
        case "agentApproval":
        case "approvalState":
        case "agentOutcome":
            return applyAgentCall(p, task, (files) => receive(s, files), c);
        default:
            return refuse(`The runner asked for a save the platform does not know (${(c as { method?: string }).method}).`);
    }
}
