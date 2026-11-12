/**
 * Round 51: the GenerationSink of an exploration job running on this runner. Every call goes to the platform (explore/sink), which applies
 * it to the job's own RepoSink in the order it was made (src/platform/explore-sink.ts).
 *
 * One ordered queue, sent in batches: the methods that return nothing resolve at once and are sent with the next batch; the ones that
 * return a value (a test key, a test handle, a script id, an agent run id, site memory, baselines) wait for the platform's answer, so the
 * runner never invents an id. The first refused or failed batch ends the job: every later call, and flush(), reject with it. Files
 * (evidence, baselines) are read when the engine hands them over and travel as bytes; evidence too large for one call is uploaded in
 * chunks first and named in the call. Baselines that come back are written into this task's own folder.
 *
 * Round 52: each batch carries its number (`seq`), and a batch or chunk that got no answer because the platform was away (a restart) is
 * sent again, the same, for a couple of minutes (explore-transport.ts); the platform applies each number once.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GenerationSink, TestHandle } from "../engine/orchestrator.js";
import type { ScriptRun } from "../engine/validation/runner.js";
import { EXPLORE_CALL_FILES_MAX_BYTES, EXPLORE_CHUNK_BYTES, EXPLORE_FILE_MAX_BYTES, EXPLORE_SINK_MAX_CALLS, EXPLORE_TASK_MAX_BYTES, SinkAnswers, SinkResponse, type SinkCall, type WireFile, type WireSinkRun } from "../agent-protocol/explore-sink.js";
import { retrying, type ExplorePost } from "./explore-transport.js";

/** Calls stop being added to a batch once its JSON reaches this size (a single larger call still goes alone). */
const BATCH_BYTES = 2 * 1024 * 1024;

interface Entry {
    call: Promise<SinkCall>;
    done?: (v: unknown) => void;
    fail?: (e: unknown) => void;
}

/** A plain file name the platform accepts (agent-protocol SafeName). */
export function wireName(name: string): string {
    const n = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "");
    return (n || "file").slice(0, 120);
}

export function remoteGenerationSink(o: {
    post: ExplorePost;
    signal?: AbortSignal;
    /** Where baselines from the platform are written (default: a new temporary folder). */ dir?: string;
    /** How long a call is tried again while the platform is away (explore-transport.ts). */ retryMs?: number;
}): GenerationSink & { flush(): Promise<void> } {
    const post = retrying(o.post, o.retryMs);
    const queue: Entry[] = [];
    let seq = 0;
    let uploads = 0;
    let failed: unknown;
    let sending: Promise<void> | undefined;
    let sentBytes = 0;
    let dir: Promise<string> | undefined;
    let loads = 0;

    const fail = (e: unknown) => {
        failed ??= e instanceof Error ? e : new Error(String(e));
        for (const q of queue.splice(0)) q.fail?.(failed);
    };
    o.signal?.addEventListener("abort", () => fail(o.signal!.reason ?? new Error("The exploration was stopped.")), { once: true });

    const pump = (): Promise<void> =>
        (sending ??= (async () => {
            // Let the calls made in the same turn join this batch.
            await new Promise<void>((r) => setImmediate(r));
            try {
                while (queue.length && failed === undefined) {
                    const batch: Array<{ e: Entry; c: SinkCall }> = [];
                    let size = 0;
                    while (queue.length && batch.length < EXPLORE_SINK_MAX_CALLS && (batch.length === 0 || size < BATCH_BYTES)) {
                        const c = await queue[0]!.call;
                        size += JSON.stringify(c).length;
                        if (batch.length && size > BATCH_BYTES) break;
                        batch.push({ e: queue.shift()!, c });
                    }
                    if (failed !== undefined) {
                        for (const b of batch) b.e.fail?.(failed);
                        break;
                    }
                    const answer = SinkResponse.parse(await post("sink", { calls: batch.map((b) => b.c), seq: ++seq }, { signal: o.signal }));
                    batch.forEach((b, i) => b.e.done?.(answer.results[i] ?? null));
                }
            } catch (e) {
                fail(e);
            } finally {
                sending = undefined;
            }
            if (queue.length && failed === undefined) await pump();
        })());

    /** Queued: resolves once the call is in line (after its files were read), never waits for the platform. */
    const send = (call: SinkCall | Promise<SinkCall>): Promise<void> => {
        if (failed !== undefined) return Promise.reject(failed);
        const c = Promise.resolve(call);
        c.catch(fail);
        queue.push({ call: c });
        void pump();
        return c.then(() => undefined);
    };

    /** Waits for the platform's answer. */
    const ask = <T>(call: SinkCall, parse: (v: unknown) => T): Promise<T> => {
        if (failed !== undefined) return Promise.reject(failed);
        return new Promise<T>((resolve, reject) => {
            queue.push({
                call: Promise.resolve(call),
                done: (v) => {
                    try {
                        resolve(parse(v));
                    } catch (e) {
                        reject(e);
                        fail(e);
                    }
                },
                fail: reject,
            });
            void pump();
        });
    };

    /** A file in chunks, ahead of the call that names it (each chunk on its own: written at its offset, it may be sent again). */
    const upload = async (file: string, size: number): Promise<{ id: string; name: string; size: number }> => {
        const id = `u${++uploads}`;
        sentBytes += size;
        const fh = await fs.open(file, "r");
        let offset = 0;
        try {
            do {
                const buf = Buffer.alloc(Math.min(EXPLORE_CHUNK_BYTES, size - offset));
                const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
                if (bytesRead === 0 && offset > 0) break;
                SinkResponse.parse(await post("sink", { calls: [{ method: "fileChunk", upload: id, offset, data: buf.subarray(0, bytesRead).toString("base64") }] }, { signal: o.signal }));
                offset += bytesRead;
                if (bytesRead === 0) break;
            } while (offset < size);
        } finally {
            await fh.close();
        }
        return { id, name: wireName(file), size: offset };
    };

    const read = async (file: string, budget: { left: number }, required: boolean): Promise<WireFile | undefined> => {
        const st = await fs.stat(file).catch(() => undefined);
        // Evidence over the task's cap stays here, as a vanished artifact would; a baseline goes anyway and the platform says no.
        if (!st || (!required && (st.size > EXPLORE_FILE_MAX_BYTES || st.size > budget.left || sentBytes + st.size > EXPLORE_TASK_MAX_BYTES))) {
            if (required) throw new Error(`The file ${path.basename(file)} could not be read.`);
            return undefined;
        }
        const b = await fs.readFile(file);
        budget.left -= b.length;
        sentBytes += b.length;
        return { name: wireName(file), data: b.toString("base64") };
    };

    const wireRun = async (run: ScriptRun | undefined): Promise<WireSinkRun | undefined> => {
        if (!run) return undefined;
        const budget = { left: EXPLORE_CALL_FILES_MAX_BYTES };
        const artifacts: WireSinkRun["artifacts"] = [];
        for (const a of run.artifacts.slice(0, 50)) {
            const file = await read(a.path, budget, false);
            if (file) {
                artifacts.push({ kind: a.kind, file });
                continue;
            }
            // Too large for this call: uploaded first, if the attempt's cap allows it.
            const size = (await fs.stat(a.path).catch(() => undefined))?.size;
            if (size === undefined || sentBytes + size > EXPLORE_TASK_MAX_BYTES) continue;
            // An upload that fails leaves the file here, as a vanished artifact would; a stopped job or a refused task ends at the next batch.
            const up = await upload(a.path, size).catch(() => undefined);
            if (up) artifacts.push({ kind: a.kind, upload: up });
        }
        return {
            testId: run.testId,
            status: run.status,
            durationMs: run.durationMs,
            error: run.error?.slice(0, 4000),
            failedStepIndex: run.failedStepIndex,
            steps: run.steps.slice(0, 500).map((s) => ({ index: s.index, title: s.title.slice(0, 500), status: s.status, ...(s.error !== undefined ? { error: s.error.slice(0, 2000) } : {}) })),
            artifacts,
            notes: run.notes,
            visionJudged: run.visionJudged,
            responses: run.responses.slice(0, 500),
            metrics: run.metrics,
            variant: run.variant,
        };
    };

    const folder = () => (dir ??= o.dir ? fs.mkdir(o.dir, { recursive: true }).then(() => o.dir!) : fs.mkdtemp(path.join(os.tmpdir(), "explore-baselines-")));

    const h = (x: TestHandle) => ({ id: x.id, testId: x.testId });

    return {
        phase: (status, phase, state) => send({ method: "phase", status, phase, state }),
        counters: (patch, add) => send({ method: "counters", patch: patch as Record<string, number>, ...(add !== undefined ? { add } : {}) }),
        saveModel: (model) => send({ method: "saveModel", model: model as unknown as Record<string, unknown> }),
        nextTestKey: (prefix) => ask({ method: "nextTestKey", prefix }, (v) => SinkAnswers.nextTestKey.parse(v)),
        createTest: ({ spec, framework, validation, reason, meta }) => ask({ method: "createTest", spec, framework, validation, reason, meta }, (v) => SinkAnswers.createTest.parse(v)),
        updateTest: (x, patch) => send({ method: "updateTest", h: h(x), patch }),
        restoreTest: (x) => send({ method: "restoreTest", h: h(x) }),
        saveScript: (x, script, executable) => ask({ method: "saveScript", h: h(x), script, executable }, (v) => SinkAnswers.saveScript.parse(v)),
        recordExecution: (x, scriptId, attempt, run, startedAt) => send(wireRun(run).then((r) => ({ method: "recordExecution", h: h(x), scriptId, attempt, run: r!, startedAt }))),
        recordVariant: (x, scriptId, r, startedAt) => send(wireRun(r.run).then((run) => ({ method: "recordVariant", h: h(x), scriptId, r: { variant: r.variant, status: r.status, reason: r.reason, run }, startedAt }))),
        recordEnvironment: (x, scriptId, r, startedAt) => send(wireRun(r.run).then((run) => ({ method: "recordEnvironment", h: h(x), scriptId, r: { environment: r.environment, status: r.status, reason: r.reason, run }, startedAt }))),
        saveTextArtifact: (kind, name, content) => send({ method: "saveTextArtifact", kind, name: wireName(name), content }),
        saveHealing: (x, result) => send({ method: "saveHealing", h: h(x), result }),
        saveCleanup: (items) => send({ method: "saveCleanup", items }),
        loadMemory: (origin) => ask({ method: "loadMemory", origin }, (v) => SinkAnswers.loadMemory.parse(v)),
        saveMemory: (knowledge, changes) => send({ method: "saveMemory", knowledge, changes }),
        rememberPhone: (d) => send({ method: "rememberPhone", d }),
        saveBaselines: (x, files) =>
            send(
                (async () => {
                    const budget = { left: Number.POSITIVE_INFINITY };
                    const wire: WireFile[] = [];
                    for (const f of files) wire.push({ ...(await read(f.path, budget, true))!, name: wireName(f.name) });
                    return { method: "saveBaselines" as const, h: h(x), files: wire };
                })(),
            ),
        loadBaselines: async (x) => {
            const files = await ask({ method: "loadBaselines", h: h(x) }, (v) => SinkAnswers.loadBaselines.parse(v));
            if (!files.length) return [];
            // Each load in its own folder: two tests can have baselines of the same name.
            const into = path.join(await folder(), `b${++loads}`);
            await fs.mkdir(into, { recursive: true });
            const out: Array<{ name: string; path: string }> = [];
            for (const f of files) {
                const file = path.join(into, wireName(f.name));
                await fs.writeFile(file, Buffer.from(f.data, "base64"));
                out.push({ name: f.name, path: file });
            }
            return out;
        },
        startAgentRun: (role, subject) => ask({ method: "startAgentRun", role, subject }, (v) => SinkAnswers.startAgentRun.parse(v)),
        agentAction: (runId, a) => {
            // Fire-and-forget, as the engine expects; a failure ends the job through the next awaited call or flush().
            send({ method: "agentAction", runId, a }).catch(() => undefined);
        },
        finishAgentRun: (runId, status, summary) => send({ method: "finishAgentRun", runId, status, summary }),
        flush: async () => {
            while (queue.length || sending) {
                if (failed !== undefined) break;
                await (sending ?? pump());
            }
            if (failed !== undefined) throw failed;
        },
    };
}
