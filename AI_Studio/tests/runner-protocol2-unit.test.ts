/**
 * Protocol 2, browser-free: version negotiation, phases and attempts in the store (accept, reject, accept time-out, fencing, live event
 * dedup), encoded secret masking on both sides, the live reporter's parser, the agent's live event batching and retries, and the result
 * outbox (kept on disk, delivered once, survives a restart of the agent). No port is opened.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canMovePhase, AgentStore, MAX_OFFERS, OPEN_OWNER_ID } from "../src/platform/agent-store.js";
import { basicAuthForms, envSecrets, liveEventData, liveEventMessage, negotiateProtocol, scrubSecrets } from "../src/platform/agent-routing.js";
import { secretVariants } from "../src/agent-protocol/secret-variants.js";
import { EventsRequest, HelloRequest, LIVE_EVENT_KINDS, TaskOffer, type Capabilities as Caps, type LiveEvent } from "../src/agent-protocol/schema.js";
import { LiveParser, type LiveRunEvent } from "../src/engine/validation/runner.js";
import { LiveEventSender } from "../src/agent/live-events.js";
import { ResultOutbox } from "../src/agent/outbox.js";
import { memoryLogger } from "../src/agent/log.js";
import { secretsOfEnv } from "../src/agent/mapping.js";
import { PlatformError, type PlatformClient } from "../src/agent/client.js";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";

let platform: Platform;
let dataDir: string;
let projectId: string;
let now = 1_700_000_000_000;
let store: AgentStore;
const caps = (): Caps => ({ os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"] });

beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-p2-unit-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir }));
    projectId = platform.repo.createProject({ name: "Protocol two" }).id as string;
    store = new AgentStore(platform.db, () => now);
    store.openMode = () => true;
});
afterAll(() => {
    platform.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("version negotiation", () => {
    it("speaks the highest version both sides know; a protocol-1 agent gets protocol 1", () => {
        expect(negotiateProtocol({ protocol: 1 })).toBe(1);
        expect(negotiateProtocol({ protocol: 1, protocols: [1, 2] })).toBe(2);
        expect(negotiateProtocol({ protocol: 2 })).toBe(2);
        expect(negotiateProtocol({ protocol: 1, protocols: [1, 2, 7] })).toBe(2);
        expect(negotiateProtocol({ protocol: 7 })).toBeUndefined();
        // The hello a protocol-1 platform parses (it reads `protocol` only) still says 1.
        expect(HelloRequest.parse({ protocol: 1, protocols: [1, 2], name: "x", version: "1", capabilities: caps(), concurrency: 1 }).protocol).toBe(1);
    });
});

describe("phases and attempts in the store", () => {
    const LEASE = 60_000;
    const newTask = () => {
        const id = crypto.randomUUID();
        store.enqueue({ id, projectId, jobId: `job-${id}`, adapterId: "playwright", payloadEnc: "enc", files: [], ownerId: OPEN_OWNER_ID });
        return id;
    };
    const agentFor = (name: string, protocol = 2) => {
        const { record } = store.createPersonalToken({ ownerId: OPEN_OWNER_ID, label: name, createdBy: "test" });
        const agent = store.upsertAgent(record, { name, version: "1", capabilities: caps(), concurrency: 1 });
        store.setAgentProtocol(agent.id, protocol);
        return agent;
    };

    it("only moves forward, never out of a final phase", () => {
        expect(canMovePhase("assigned", "accepted")).toBe(true);
        expect(canMovePhase("running", "preparing")).toBe(false);
        expect(canMovePhase("uploading", "completed")).toBe(true);
        expect(canMovePhase("completed", "running")).toBe(false);
        expect(canMovePhase("lost_connection", "failed")).toBe(false);
    });

    it("every claim is a new attempt with a new id; protocol 1 is accepted by the claim, protocol 2 must accept", () => {
        const v1 = agentFor("one", 1);
        const t1 = newTask();
        store.claimFor(t1, v1, LEASE);
        const a1 = store.beginAttempt(t1, v1.id, { protocol: 1, acceptMs: 30_000 })!;
        expect(a1).toMatchObject({ phase: "accepted", attempt: 1 });
        expect(a1.attemptId).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(store.agentProtocol(v1.id)).toBe(1);

        const v2 = agentFor("two");
        const t2 = newTask();
        store.claimFor(t2, v2, LEASE);
        const a2 = store.beginAttempt(t2, v2.id, { protocol: 2, acceptMs: 30_000 })!;
        expect(a2).toMatchObject({ phase: "assigned", attempt: 1, acceptedMs: null });
        expect(store.accept(t2, v2.id, "wrong-attempt-id-123", LEASE)).toBe("superseded");
        expect(store.accept(t2, v2.id, a2.attemptId!, LEASE)).toBe("accepted");
        expect(store.accept(t2, v2.id, a2.attemptId!, LEASE)).toBe("already");
        // the agent reports what it does; never backwards
        expect(store.heartbeat(t2, v2.id, LEASE, {}, "running")).toBe(true);
        expect(store.heartbeat(t2, v2.id, LEASE, {}, "preparing")).toBe(true);
        expect(store.getTask(t2)!.phase).toBe("running");
        expect(store.finish(t2, v2.id, { status: "done", resultEnc: "r", attemptId: a2.attemptId! })).toBe(true);
        expect(store.getTask(t2)).toMatchObject({ phase: "completed", resultAttemptId: a2.attemptId });
    });

    it("an attempt not accepted in time goes back to the queue without using up an offer, and a re-offer starts clean", () => {
        const a = agentFor("slow");
        const id = newTask();
        store.claimFor(id, a, LEASE);
        const first = store.beginAttempt(id, a.id, { protocol: 2, acceptMs: 30_000 })!;
        store.addFile({ taskId: id, direction: "out", ref: "old.png", path: "x/old.png", size: 1, sha256: "0".repeat(64) });
        now += 30_001;
        const swept = store.sweep();
        expect(swept.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "accept_timeout", taskId: id, agentId: a.id })]));
        expect(store.getTask(id)).toMatchObject({ status: "queued", phase: "queued", offers: 0, agentId: null });
        store.claimFor(id, a, LEASE);
        const second = store.beginAttempt(id, a.id, { protocol: 2, acceptMs: 30_000 })!;
        expect(second.attempt).toBe(2);
        expect(second.attemptId).not.toBe(first.attemptId);
        expect(store.getFile(id, "out", "old.png")).toBeUndefined();
        expect(store.accept(id, a.id, first.attemptId!, LEASE)).toBe("superseded");
    });

    it("a reject sends the task back to the queue with the reason, never to the same runner, without using an offer", () => {
        const a = agentFor("no-browser");
        const id = newTask();
        store.claimFor(id, a, LEASE);
        const at = store.beginAttempt(id, a.id, { protocol: 2, acceptMs: 30_000 })!;
        expect(store.reject(id, a.id, "another-attempt-id", { reason: "missing-browser", message: "x" }).outcome).toBe("superseded");
        const r = store.reject(id, a.id, at.attemptId!, { reason: "missing-browser", message: "No browser here." });
        expect(r.outcome).toBe("requeued");
        expect(store.getTask(id)).toMatchObject({ status: "queued", offers: 0, rejections: [expect.objectContaining({ agentId: a.id, reason: "missing-browser", message: "No browser here." })] });
        expect(MAX_OFFERS).toBe(2);
    });

    it("a lease that ran out twice ends as lost connection; a task nobody took ends as timed out", () => {
        const a = agentFor("gone", 1);
        const id = newTask();
        for (let i = 0; i < 2; i++) {
            store.claimFor(id, a, LEASE);
            store.beginAttempt(id, a.id, { protocol: 1, acceptMs: 1 });
            now += LEASE + 1;
            store.sweep();
        }
        expect(store.getTask(id)).toMatchObject({ status: "failed", phase: "lost_connection" });
        const stale = newTask();
        now += 31 * 60_000;
        store.sweep();
        expect(store.getTask(stale)).toMatchObject({ status: "failed", phase: "timed_out" });
    });

    it("a live event is kept once per task, attempt and sequence number", () => {
        const id = newTask();
        expect(store.noteLiveEvent(id, "attempt-aaaaaaaa", 0)).toBe(true);
        expect(store.noteLiveEvent(id, "attempt-aaaaaaaa", 0)).toBe(false);
        expect(store.noteLiveEvent(id, "attempt-bbbbbbbb", 0)).toBe(true);
    });
});

describe("secrets in their encoded forms", () => {
    const PW = "p@ss word/+&1";
    it("the platform's scrub masks URL-encoded, plus, lower-hex, JSON-escaped and Basic forms", () => {
        const secrets = envSecrets({ credentials: { username: "ann", password: PW } });
        const basic = basicAuthForms("ann", PW)[0]!;
        const text = `a ${encodeURIComponent(PW)} b ${encodeURIComponent(PW).replace(/%20/g, "+")} c ${encodeURIComponent(PW).replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase())} d ${JSON.stringify(PW)} e Basic ${basic}`;
        const out = scrubSecrets({ line: text, nested: [`x${PW}y`] }, secrets);
        for (const v of [...secretVariants(PW), basic]) expect(JSON.stringify(out)).not.toContain(v);
        expect(out.nested[0]).toBe("x[hidden]y");
    });
    it("the agent's log masks the same forms", () => {
        const { log, lines } = memoryLogger();
        log.addSecrets(secretsOfEnv({ baseUrl: "http://x", headless: true, credentials: { username: "ann", password: PW } }));
        log.info(`sign-in https://app/login?pw=${encodeURIComponent(PW)} body {"password":${JSON.stringify(PW)}} auth ${basicAuthForms("ann", PW)[1]}`);
        expect(lines[0]).not.toContain(encodeURIComponent(PW));
        expect(lines[0]).not.toContain(basicAuthForms("ann", PW)[1]!);
        expect(lines[0]).toContain("***");
    });
});

describe("live events", () => {
    it("every event kind becomes a runner_* job event with a sentence and its data", () => {
        const step: LiveEvent = { type: "step_finished", seq: 3, at: "now", testId: "t1", index: 1, title: "2. Click", status: "failed", durationMs: 1200, error: "Timeout" };
        expect(LIVE_EVENT_KINDS[step.type]).toBe("runner_step");
        expect(liveEventMessage(step, "Ann's laptop")).toBe("Ann's laptop: step 2 failed (1.2 s): 2. Click — Timeout");
        expect(liveEventData(step)).toMatchObject({ state: "finished", index: 1, testId: "t1", seq: 3 });
        // "runner_engine" is never written: an exploration's engine event keeps its own kind (round 51, agent-services.ts events).
        expect(new Set(Object.values(LIVE_EVENT_KINDS))).toEqual(new Set(["runner_test_started", "runner_test_finished", "runner_step", "runner_log", "runner_screenshot", "runner_phase", "runner_engine"]));
        expect(EventsRequest.safeParse({ attemptId: "abcdefgh12", events: [] }).success).toBe(false);
        expect(TaskOffer.shape.attemptId.safeParse("bad id").success).toBe(false);
    });

    it("the live reporter's lines become events with the script's test id and step index; other output is ignored", () => {
        const got: LiveRunEvent[] = [];
        const p = new LiveParser([{ testId: "t-home", filename: "home.spec.ts" }], false, (e) => got.push(e));
        const M = "\u001eAITP-LIVE ";
        p.push(`Running 1 test\n${M}${JSON.stringify({ t: "test_started", file: "home.spec.ts", title: "Home" })}\n  ok 1 home.spec.ts:1:1 › Home (1s)\n${M}{"t":"step_started","file":"home.spec.ts","title":"Home","step":"1. Open"}\n`);
        p.push(`${M}{"t":"step_finished","file":"home.spec.ts","title":"Home","step":"1. Open","ok":true,"durationMs":5}\n${M}{"t":"step_started","file":"home.spec.ts","title":"Home","step":"helper"}\n${M}{"t":"step_finished","file":"other.spec.ts","title":"X","step":"1. a","ok":true}\n${M}not json\n`);
        p.push(`${M}${JSON.stringify({ t: "test_finished", file: "home.spec.ts", title: "Home", status: "interrupted", durationMs: 9, error: "\u001b[31mboom\u001b[39m" })}\n${M}{"t":"screenshot","file":"home.spec.ts","title":"Home","path":"/tmp/a.png"}\n`);
        expect(got).toEqual([
            { type: "test_started", testId: "t-home", title: "Home" },
            { type: "step_started", testId: "t-home", index: 0, title: "1. Open" },
            { type: "step_finished", testId: "t-home", index: 0, title: "1. Open", status: "passed", durationMs: 5 },
            { type: "step_started", testId: "t-home", index: 1, title: "helper" },
            { type: "test_finished", testId: "t-home", title: "Home", status: "error", durationMs: 9, error: "boom" },
            { type: "screenshot", testId: "t-home", path: "/tmp/a.png" },
        ]);
    });

    it("the agent batches events (at most 50, or after the wait), numbers them, retries a lost batch with the same numbers, and stops when the attempt is over", async () => {
        const batches: LiveEvent[][] = [];
        let fail = 1;
        let gone = "";
        const s = new LiveEventSender({
            send: async (events) => {
                if (fail-- > 0) throw new PlatformError("network", "away");
                batches.push(events);
            },
            redact: (t) => t.split("SECRET1").join("***"),
            onGone: (why) => void (gone = why),
            maxDelayMs: 20,
            retryDelayMs: () => 5,
        });
        for (let i = 0; i < 120; i++) s.push({ type: "log", line: i === 0 ? "has SECRET1" : `line ${i}` });
        await s.flush(2000);
        expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
        expect(batches.flat().map((e) => e.seq)).toEqual([...Array(120).keys()]);
        expect((batches[0]![0] as { line: string }).line).toBe("has ***");
        // the platform says the attempt was replaced: nothing more is sent
        const s2 = new LiveEventSender({ send: async () => Promise.reject(new PlatformError("rejected", "superseded", 409)), redact: (t) => t, onGone: (why) => void (gone = why), maxDelayMs: 1 });
        s2.push({ type: "phase", phase: "running" });
        await s2.flush(1000);
        expect(gone).toBe("superseded");
        expect(s2.isGone).toBe(true);
        s2.push({ type: "phase", phase: "uploading" });
        await s2.close(100);
    });
});

describe("the result outbox", () => {
    const fakeClient = (answers: Array<"ok" | "again" | "network" | 409>) => {
        const calls: string[] = [];
        const client = {
            result: async (taskId: string) => {
                calls.push(taskId);
                const a = answers.shift() ?? "ok";
                if (a === "network") throw new PlatformError("network", "Could not reach the platform");
                if (a === 409) throw new PlatformError("rejected", "superseded", 409);
                return { alreadyReceived: a === "again" };
            },
        } as unknown as PlatformClient;
        return { client, calls };
    };
    const body = { ok: true, runs: [], attemptId: "attempt-1234" };

    it("keeps a result until the platform answers, and delivers it once after a restart of the agent", async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-outbox-"));
        try {
            const first = fakeClient(["network", "network"]);
            const { log } = memoryLogger();
            const box = new ResultOutbox(work, { client: first.client, log });
            await box.put("task-1", body);
            expect((fs.statSync(path.join(work, "outbox", "task-1.json")).mode & 0o777).toString(8)).toBe("600");
            expect(await box.deliver("task-1")).toBe("pending");
            expect(await box.flush()).toBe(1);
            // the agent restarts: a new outbox on the same folder delivers it, and only once
            const second = fakeClient(["ok"]);
            const after = new ResultOutbox(work, { client: second.client, log });
            expect(await after.pending()).toEqual(["task-1"]);
            expect(await after.flush()).toBe(0);
            expect(await after.flush()).toBe(0);
            expect(second.calls).toEqual(["task-1"]);
            // a refusal (a newer attempt, a task the platform forgot) ends it too
            const third = fakeClient([409]);
            const box3 = new ResultOutbox(work, { client: third.client, log });
            await box3.put("task-2", body);
            expect(await box3.deliver("task-2")).toBe("refused");
            expect(await box3.pending()).toEqual([]);
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    });

    it("the background loop keeps trying until the platform is back", async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-outbox-"));
        try {
            const c = fakeClient(["network", "network", "again"]);
            const { log, lines } = memoryLogger();
            const box = new ResultOutbox(work, { client: c.client, log, maxDelayMs: 20 });
            await box.put("task-3", body);
            box.start();
            for (let i = 0; i < 100 && (await box.pending()).length > 0; i++) await new Promise((r) => setTimeout(r, 30));
            await box.stop();
            expect(await box.pending()).toEqual([]);
            expect(c.calls.length).toBe(3);
            expect(lines.join("\n")).toMatch(/the platform had it already/);
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    });
});

describe("a visible browser where there is no display (decision 8)", () => {
    const offer = (attemptId?: string) =>
        TaskOffer.parse({ taskId: "task-headed-1234", jobId: "job-1", adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "t1", filename: "t1.spec.ts", content: "x" }], env: { baseUrl: "http://app", headless: false }, ...(attemptId ? { attemptId, attempt: 1, acceptSeconds: 30 } : {}) });
    const runnerWith = async (protocol: number) => {
        const { TaskRunner } = await import("../src/agent/task-runner.js");
        const calls: Array<{ kind: string; body: any }> = [];
        const client = {
            reject: async (_id: string, body: unknown) => void calls.push({ kind: "reject", body }),
            accept: async () => void calls.push({ kind: "accept", body: null }),
            result: async (_id: string, body: unknown) => (calls.push({ kind: "result", body }), { alreadyReceived: false }),
        } as unknown as PlatformClient;
        const { log } = memoryLogger();
        const runner = new TaskRunner({ client, cache: {} as never, log, workDir: os.tmpdir(), hello: { agentId: "a", projectId: "p", protocol, pollSeconds: 1, heartbeatSeconds: 1, maxFileBytes: 1000, serverTime: "now" }, probe: { get: async () => caps() } as never, env: {} });
        return { runner, calls };
    };
    it("protocol 2 turns the task down with the reason no-display; protocol 1 answers ok=false with the same sentence", async () => {
        const two = await runnerWith(2);
        await two.runner.run(offer("attempt-headed-1"));
        expect(two.calls).toEqual([{ kind: "reject", body: expect.objectContaining({ attemptId: "attempt-headed-1", reason: "no-display", message: expect.stringMatching(/visible browser window/) }) }]);
        const one = await runnerWith(1);
        await one.runner.run(offer());
        expect(one.calls).toEqual([{ kind: "result", body: expect.objectContaining({ ok: false, error: expect.stringMatching(/visible browser window/) }) }]);
    });
});

describe("a switch changed while the runner was idle", () => {
    it("arrives with the next offer (config), so the runner does not turn down a task its owner just allowed", async () => {
        const { TaskRunner } = await import("../src/agent/task-runner.js");
        const calls: Array<{ kind: string; body: any }> = [];
        const client = { reject: async (_id: string, body: unknown) => void calls.push({ kind: "reject", body }) } as unknown as PlatformClient;
        const { log } = memoryLogger();
        // The hello said private addresses are off (a personal runner's default).
        const hello = { agentId: "a", projectId: "p", protocol: 2, pollSeconds: 1, heartbeatSeconds: 1, maxFileBytes: 1000, serverTime: "now", runner: { id: "r", kind: "personal" as const, customScripts: false, privateTargets: false } };
        const runner = new TaskRunner({ client, cache: {} as never, log, workDir: os.tmpdir(), hello, probe: { get: async () => caps() } as never, env: {} });
        // headless: false on a machine without a display: a task that passes the address check is then turned down as no-display, before anything starts.
        const offer = (n: number, config?: { privateTargets?: boolean }) =>
            TaskOffer.parse({ taskId: `task-private-${n}234`, jobId: "job-1", adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "t1", filename: "t1.spec.ts", content: "x" }], env: { baseUrl: "http://127.0.0.1:9", headless: false }, attemptId: `attempt-private-${n}`, attempt: 1, acceptSeconds: 30, ...(config ? { config } : {}) });
        await runner.run(offer(1));
        expect(calls.at(-1)?.body).toMatchObject({ reason: "private-target" });
        // The owner switched private addresses on while the runner sat idle: the platform's offer says so.
        await runner.run(offer(2, { privateTargets: true }));
        expect(calls.at(-1)?.body).toMatchObject({ reason: "no-display" });
        // A protocol-1 agent's offer never has the field: TaskOffer keeps it optional.
        expect(TaskOffer.parse({ taskId: "t", jobId: "j", adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [], env: { baseUrl: "http://x", headless: true } }).config).toBeUndefined();
    });
});
