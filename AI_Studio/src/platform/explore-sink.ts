/**
 * Round 51: the platform end of what an exploration job on a runner saves (POST /api/agent/tasks/:id/explore/sink, mounted in
 * routes/agents.ts, which has already checked the runner token, the task's owner and its attempt).
 *
 * Each task attempt gets the job's own RepoSink, built as job-runner.ts runJobAs builds it, and every call is applied to it in the order
 * received. Nothing from the runner is trusted: every message is checked against its schema, a test handle is one this sink made (and its
 * test is this job's project's), script and agent run ids are ones it handed out, and files arrive as bytes, written by the platform into
 * a folder of its own under names it checked. A path from the runner is never used.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScriptRun } from "../engine/validation/runner.js";
import type { TestHandle } from "../engine/orchestrator.js";
import { EXPLORE_CALL_FILES_MAX_BYTES, EXPLORE_FILE_MAX_BYTES, EXPLORE_TASK_MAX_BYTES, SinkRequest, type SinkCall, type WireFile, type WireSinkRun } from "../agent-protocol/explore-sink.js";
import { SafeName } from "../agent-protocol/schema.js";
import type { Platform } from "./bootstrap.js";
import type { ExploreTaskRef } from "./explore-task.js";
import { HttpError } from "./http-error.js";
import { RepoSink } from "./repo-sink.js";

interface TaskSink {
    attempt: number;
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

const refuse = (message: string): never => {
    throw new HttpError(400, message);
};

/** The task's sink is no longer needed (the task ended or moved to another attempt): what it queued is stored, its folder removed. */
export async function forgetExploreSink(taskId: string): Promise<void> {
    const s = sinks.get(taskId);
    if (!s) return;
    sinks.delete(taskId);
    await s.chain.catch(() => undefined);
    await s.sink.writes.flush();
    await fs.rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
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
    const fresh: TaskSink = {
        attempt: task.attempt,
        sink: new RepoSink(p.repo, p.store, { id: job.id, projectId: job.projectId, applicationId: job.applicationId, mode: job.options.mode }),
        handles: new Map(),
        scripts: new Set(),
        agentRuns: new Set(),
        bytes: 0,
        dir: await fs.mkdtemp(path.join(os.tmpdir(), "explore-sink-")),
        chain: Promise.resolve(),
    };
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
    const go = s.chain.then(async () => {
        const results: unknown[] = [];
        for (const c of parsed.data!.calls) results.push((await apply(p, task, s, c)) ?? null);
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

/** Applies `fn` to a ScriptRun rebuilt from the wire, its evidence written to the platform's own folder, which is removed after. */
async function withRun<T>(s: TaskSink, w: WireSinkRun | undefined, fn: (run: ScriptRun | undefined) => Promise<T>): Promise<T> {
    if (!w) return fn(undefined);
    const got = await receive(
        s,
        w.artifacts.map((a) => a.file),
    );
    try {
        const { artifacts, ...rest } = w;
        return await fn({ ...rest, artifacts: artifacts.map((a, i) => ({ kind: a.kind, path: got.paths[i]! })) });
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
        default:
            return refuse(`The runner asked for a save the platform does not know (${(c as { method?: string }).method}).`);
    }
}
