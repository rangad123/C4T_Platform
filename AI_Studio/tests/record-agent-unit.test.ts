/**
 * Recording on a runner agent, the parts that need no browser and no server: the protocol messages, the exact-match route, the push rules, the command
 * queue, lost-contact timing with an injected clock, where a recording runs (decision table), the agent's wire mapping, and the shared recorder core
 * driven through a fake page. Fast tier (no Chromium).
 */
import type { Browser } from "playwright";
import { describe, expect, it } from "vitest";
import { CheckedTaskOffer, Capabilities, HeartbeatResponse, RecordCommand, RecordingPush, RecStepWire, TaskOffer } from "../src/agent-protocol/schema.js";
import { webOnlyGuard } from "../src/agent/record-child.js";
import { toPush } from "../src/agent/record-task.js";
import { hasDisplay as agentHasDisplay } from "../src/agent/capabilities.js";
import { REC_ASSERT_CHECKS, REC_STEP_KINDS, REC_STRATEGIES, SECRET_PLACEHOLDERS, type RecStep } from "../src/engine/recorder/model.js";
import { checkPatch, RecorderError, RecorderSession, type RecState } from "../src/engine/recorder/session.js";
import { agentRouteOf, isAgentRoute } from "../src/platform/agent-routing.js";
import { chooseRecorder, cleanPush, cleanStep, CommandQueue, MAX_QUEUED_COMMANDS, recordAdapterId, RemoteDriver, recordProblem, type RemoteDeps } from "../src/platform/agent-record.js";
import type { AgentRecord } from "../src/platform/agent-store.js";

const TASK = "11111111-2222-3333-4444-555555555555";
const step = (over: Partial<RecStep> = {}): RecStep => ({ index: 0, kind: "click", locator: { strategy: "testId", value: "add" }, matches: 1, describe: 'Click the element with test id "add"', at: "2026-10-11T10:00:00.000Z", ...over });

describe("protocol: the record messages", () => {
    it("RecStepWire carries every field of the recorder's step and nothing is lost on a round trip", () => {
        const full: RecStep = {
            index: 3, kind: "fill", url: "http://localhost/x", locator: { strategy: "role", value: "textbox", name: "Email", exact: true },
            alternatives: [{ locator: { strategy: "label", value: "Email" }, matches: 2 }], matches: 1, value: "a@b.c", secret: false,
            assert: { check: "text", expected: "hi" }, ref: "email-field", describe: "Type", at: "2026-10-11T10:00:00.000Z",
        };
        expect(RecStepWire.parse(full)).toEqual(full);
        // Both directions assign: a field added to one side and not the other fails to compile here.
        const wire: RecStepWire = full;
        const back: RecStep = wire;
        expect(back.kind).toBe("fill");
        expect([...RecStepWire.shape.kind.options]).toEqual([...REC_STEP_KINDS]);
        expect([...RecStepWire.shape.locator.unwrap().shape.strategy.options]).toEqual([...REC_STRATEGIES]);
        expect([...RecStepWire.shape.assert.unwrap().shape.check.options]).toEqual([...REC_ASSERT_CHECKS]);
    });

    it("a record offer needs its settings, a run offer needs a script (CheckedTaskOffer); the plain TaskOffer stays an object", () => {
        const base = { taskId: "t", jobId: "rec-x", adapterId: "record:a", leaseSeconds: 60, workers: 1, scripts: [], env: { baseUrl: "http://x", headless: true } };
        expect(CheckedTaskOffer.safeParse({ ...base, kind: "record" }).success).toBe(false);
        expect(CheckedTaskOffer.safeParse({ ...base, kind: "record", record: { recordingId: "r", startUrl: "http://x", headed: false } }).success).toBe(true);
        expect(CheckedTaskOffer.safeParse(base).success).toBe(false);
        expect(CheckedTaskOffer.safeParse({ ...base, kind: "run" }).success).toBe(false);
        expect(CheckedTaskOffer.safeParse({ ...base, scripts: [{ testId: "a", filename: "a.spec.ts", content: "x" }] }).success).toBe(true);
        expect(TaskOffer.shape.scripts).toBeDefined();
        const parsed = TaskOffer.parse({ ...base, kind: "record", record: { recordingId: "r", startUrl: "http://x", headed: true } });
        expect(parsed.record).toMatchObject({ idleMinutes: 20, totalMinutes: 60, maxSteps: 300 });
    });

    it("capabilities, commands and pushes round-trip; bad shapes are refused", () => {
        expect(Capabilities.parse({ os: "win32", arch: "x64", node: "v24", browsers: ["chromium"], record: true, recordHeaded: true })).toMatchObject({ record: true, recordHeaded: true });
        // An older agent's capabilities (no record fields) are still valid.
        expect(Capabilities.safeParse({ os: "linux", arch: "x64", node: "v24", browsers: [] }).success).toBe(true);
        for (const c of [{ id: "1", type: "inspect", on: true }, { id: "2", type: "patch", index: 1, value: "x" }, { id: "3", type: "delete", index: 0 }, { id: "4", type: "stop" }, { id: "5", type: "discard" }]) expect(RecordCommand.parse(c)).toEqual(c);
        expect(RecordCommand.safeParse({ id: "1", type: "explode" }).success).toBe(false);
        expect(RecordCommand.safeParse({ id: "1", type: "delete", index: -1 }).success).toBe(false);
        const push = { status: "recording", steps: [step()], acked: ["c1"], notes: ["n"] };
        expect(RecordingPush.parse(push)).toMatchObject({ status: "recording", acked: ["c1"] });
        expect(RecordingPush.safeParse({ ...push, status: "saved" }).success).toBe(false);
        expect(RecordingPush.safeParse({ ...push, steps: Array.from({ length: 1001 }, (_, i) => step({ index: i })) }).success).toBe(false);
        expect(RecordingPush.safeParse({ ...push, steps: [{ ...step(), describe: "x".repeat(401) }] }).success).toBe(false);
        const cmds = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, type: "stop" as const }));
        expect(HeartbeatResponse.safeParse({ cancel: false, leaseSeconds: 60, commands: cmds }).success).toBe(false);
        expect(HeartbeatResponse.safeParse({ cancel: false, leaseSeconds: 60, commands: cmds.slice(0, 20) }).success).toBe(true);
        // A reply without commands (an older platform) is still valid.
        expect(HeartbeatResponse.safeParse({ cancel: false, leaseSeconds: 60 }).success).toBe(true);
    });
});

describe("the recording route is an exact match", () => {
    it("accepts exactly POST /api/agent/tasks/<id>/recording", () => {
        expect(agentRouteOf("POST", `/api/agent/tasks/${TASK}/recording`)).toEqual({ kind: "recording", taskId: TASK });
        expect(isAgentRoute("POST", `/api/agent/tasks/${TASK}/recording`)).toBe(true);
    });
    it("every path trick falls through to the API-key check", () => {
        const tricks: Array<[string, string]> = [
            ["GET", `/api/agent/tasks/${TASK}/recording`],
            ["PUT", `/api/agent/tasks/${TASK}/recording`],
            ["DELETE", `/api/agent/tasks/${TASK}/recording`],
            ["POST", `/api/agent/tasks/${TASK}/recording/`],
            ["POST", `/api/agent/tasks/${TASK}/Recording`],
            ["POST", `/API/agent/tasks/${TASK}/recording`],
            ["POST", `/api/agent/tasks/${TASK}/recordings`],
            ["POST", `/api/agent/tasks/${TASK}/recording/x`],
            ["POST", `/api//agent/tasks/${TASK}/recording`],
            ["POST", `//api/agent/tasks/${TASK}/recording`],
            ["POST", `/api/agent/tasks/%2e%2e/recording`],
            ["POST", `/api/agent/tasks/../tasks/${TASK}/recording`],
            ["POST", `/api/agent/tasks/${TASK}/../recording`],
            ["POST", `/api/agent/tasks/${TASK}%2frecording`],
            ["POST", `/api/agent/tasks/${TASK}/recording?x=1`],
            ["POST", `/api/agent/tasks/${TASK}/recording#x`],
            ["POST", `/api/agent/tasks/short/recording`],
            ["POST", `/api/agent/tasks//recording`],
            ["POST", `/api/agent/tasks/${TASK}/files/recording`],
            ["POST", `/api/agent/tasks/${TASK}/recording\n`],
            ["POST", `/x/api/agent/tasks/${TASK}/recording`],
        ];
        for (const [m, p] of tricks) expect(isAgentRoute(m, p), `${m} ${p}`).toBe(false);
    });
});

describe("what an agent pushes is untrusted input", () => {
    const wire = (over: Partial<RecStepWire> = {}): RecStepWire => RecStepWire.parse({ ...step(), ...over });

    it("a secret step keeps only the standard placeholder, whatever the agent sent, and its words cannot carry the value", () => {
        const s = cleanStep(wire({ kind: "fill", secret: true, value: "REAL-PASSWORD-9", describe: 'Type "REAL-PASSWORD-9" into the password field' }))!;
        expect(s.value).toBe(SECRET_PLACEHOLDERS.password);
        expect(JSON.stringify(s)).not.toContain("REAL-PASSWORD-9");
        // The placeholders the recorder itself uses are kept as they are.
        expect(cleanStep(wire({ kind: "fill", secret: true, value: SECRET_PLACEHOLDERS.otp }))!.value).toBe(SECRET_PLACEHOLDERS.otp);
        expect(cleanStep(wire({ kind: "fill", secret: true }))!.value).toBe(SECRET_PLACEHOLDERS.password);
    });

    it("a page that is not http(s) is dropped, long text is capped, indexes are renumbered, the step cap holds", () => {
        const push = RecordingPush.parse({
            status: "recording",
            steps: [wire({ kind: "goto", url: "javascript:alert(1)", index: 0 }), wire({ kind: "goto", url: "http://app.test/", index: 1 }), wire({ kind: "fill", value: "x".repeat(900), index: 2 }), wire({ index: 3 }), wire({ index: 4 })],
        });
        const c = cleanPush(push, { maxSteps: 3, secrets: [] });
        expect(c.steps.map((s) => [s.index, s.kind])).toEqual([[0, "goto"], [1, "fill"], [2, "click"]]);
        expect(c.steps[1]!.value!.length).toBeLessThanOrEqual(500);
    });

    it("the project's known credentials are scrubbed from every text", () => {
        const push = RecordingPush.parse({ status: "recording", steps: [wire({ describe: "Type hunter2-secret into the box", value: "hunter2-secret" })], notes: ["saw hunter2-secret"], error: "x hunter2-secret", currentUrl: "http://a/?p=hunter2-secret" });
        const c = cleanPush(push, { maxSteps: 300, secrets: ["hunter2-secret"] });
        expect(JSON.stringify(c)).not.toContain("hunter2-secret");
        expect(JSON.stringify(c)).toContain("[hidden]");
    });
});

describe("the command queue", () => {
    it("keeps order, makes unique ids, caps at 40 (oldest dropped), and removes confirmed ids only", () => {
        const q = new CommandQueue();
        const a = q.add({ type: "inspect", on: true });
        const b = q.add({ type: "delete", index: 2 });
        const c = q.add({ type: "stop" });
        expect(new Set([a.id, b.id, c.id]).size).toBe(3);
        expect(q.next().map((x) => x.type)).toEqual(["inspect", "delete", "stop"]);
        expect(q.has("stop")).toBe(true);
        q.ack([b.id, "unknown"]);
        expect(q.next().map((x) => x.id)).toEqual([a.id, c.id]);
        for (let i = 0; i < 60; i++) q.add({ type: "delete", index: i });
        expect(q.length).toBe(MAX_QUEUED_COMMANDS);
        expect(q.dropped).toBe(22);
        expect(q.next()).toHaveLength(20);
        expect((q.next()[0] as { index?: number }).index).toBe(22 - 2);
    });
    it("refuses a command that does not fit the protocol", () => {
        expect(() => new CommandQueue().add({ type: "patch", index: -1 } as never)).toThrow();
    });
});

function driverFixture(over: Partial<RemoteDeps> = {}) {
    const clock = { now: 1_000_000 };
    const task = { status: "running" as "queued" | "running" | "done" | "failed" | "cancelled", createdMs: clock.now, claimedMs: clock.now as number | null, cancelRequested: false };
    const cancelled: string[] = [];
    const deps: RemoteDeps = { clock: () => clock.now, task: () => task, cancel: (id) => void cancelled.push(id), secrets: () => ["hunter2-secret"], settleMs: 20, ...over };
    const driver = new RemoteDriver(deps, { id: "rec-1", projectId: "p1", taskId: TASK, agent: { id: "a1", name: "Maya's laptop" }, startUrl: "http://app.test/", headed: true, maxSteps: 300 });
    const push = (over: Record<string, unknown> = {}) => driver.onPush(RecordingPush.parse({ status: "recording", steps: [wireGoto(), wireClick(1)], ...over }));
    return { clock, task, cancelled, driver, push };
}
const wireGoto = () => RecStepWire.parse(step({ index: 0, kind: "goto", url: "http://app.test/", locator: undefined, matches: undefined }));
const wireClick = (index: number) => RecStepWire.parse(step({ index, at: `2026-10-11T10:00:0${index}.000Z` }));

describe("the remote driver", () => {
    it("starts empty, shows what the agent pushes, and names the agent", () => {
        const { driver, push } = driverFixture();
        expect(driver.snapshot()).toMatchObject({ status: "starting", steps: [], runner: { kind: "agent", agentId: "a1", name: "Maya's laptop" }, pendingCommands: 0, canSave: false });
        push({ currentUrl: "http://app.test/cart" });
        expect(driver.snapshot()).toMatchObject({ status: "recording", currentUrl: "http://app.test/cart", canSave: true });
        expect(driver.snapshot().steps.map((s) => s.kind)).toEqual(["goto", "click"]);
    });

    it("commands are answered with the state as known, queued in order, and removed when the next push confirms them", async () => {
        const { driver, push } = driverFixture();
        push();
        await driver.setInspect({ on: true, mode: "assertion", check: "text" });
        await driver.patchStep(1, { value: undefined, locator: { strategy: "css", value: "#add" } });
        driver.deleteStep(1);
        expect(driver.snapshot().pendingCommands).toBe(3);
        expect(driver.snapshot().steps).toHaveLength(2); // nothing applied optimistically
        expect(driver.snapshot().inspect.on).toBe(false);
        const beat = driver.onHeartbeat();
        expect(beat.commands.map((c) => c.type)).toEqual(["inspect", "patch", "delete"]);
        // The agent applied the first two; the third stays queued and is sent again.
        push({ acked: [beat.commands[0]!.id, beat.commands[1]!.id], inspect: { on: true, mode: "assertion", check: "text" } });
        expect(driver.snapshot()).toMatchObject({ pendingCommands: 1, inspect: { on: true, mode: "assertion", assertCheck: "text" } });
        expect(driver.onHeartbeat().commands.map((c) => c.type)).toEqual(["delete"]);
    });

    it("refuses an edit the page could not make before it is queued, with the recorder's own sentences", async () => {
        const { driver, push } = driverFixture();
        await expect(driver.patchStep(0, { value: "x" })).rejects.toMatchObject({ status: 409 }); // still starting
        push({ steps: [wireGoto(), wireClick(1), RecStepWire.parse(step({ index: 2, kind: "fill", secret: true, value: SECRET_PLACEHOLDERS.password, at: "2026-10-11T10:00:02.000Z" }))] });
        await expect(driver.patchStep(9, { value: "x" })).rejects.toMatchObject({ status: 404 });
        await expect(driver.patchStep(2, { value: "x" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/secret/) });
        await expect(driver.patchStep(1, { value: "x" })).rejects.toMatchObject({ status: 400 }); // a click has no value
        await expect(driver.patchStep(0, { locator: { strategy: "css", value: "a" } })).rejects.toMatchObject({ status: 400 }); // a goto has no element
        expect(() => driver.deleteStep(9)).toThrowError(/no step 10/);
        expect(driver.snapshot().pendingCommands).toBe(0);
    });

    it("a shared element's name survives the next push, and follows its step when another step is deleted", () => {
        const { driver, push } = driverFixture();
        push();
        driver.setRef(1, "add-button");
        expect(driver.snapshot().steps[1]!.ref).toBe("add-button");
        push();
        expect(driver.snapshot().steps[1]!.ref).toBe("add-button");
        expect(driver.step(1).ref).toBe("add-button");
        // The goto at index 0 was deleted on the agent: the click is now step 0.
        push({ steps: [RecStepWire.parse({ ...wireClick(1), index: 0 })] });
        expect(driver.snapshot().steps[0]!.ref).toBe("add-button");
    });

    it("lost contact: 45 s without a push or a heartbeat stops it with the plain sentence, keeps the steps, and gives the task up", () => {
        const { driver, push, clock, cancelled } = driverFixture();
        push();
        clock.now += 44_000;
        expect(driver.snapshot().status).toBe("recording");
        driver.onHeartbeat(); // a heartbeat counts as contact
        clock.now += 44_000;
        expect(driver.snapshot().status).toBe("recording");
        clock.now += 2_000;
        const r = driver.snapshot();
        expect(r).toMatchObject({ status: "stopped", error: "Lost contact with Maya's laptop. The steps recorded so far are kept.", canSave: true });
        expect(r.steps).toHaveLength(2);
        expect(cancelled).toEqual([TASK]);
        // Late news from the agent is refused: the recording ended here.
        expect(() => push()).toThrowError(/already ended/);
    });

    it("an agent that never takes the task fails it after the wait, and the queued task is cancelled", () => {
        const { driver, task, clock, cancelled } = driverFixture();
        task.status = "queued";
        task.claimedMs = null;
        clock.now += 59_000;
        expect(driver.snapshot().status).toBe("starting");
        clock.now += 2_000;
        expect(driver.snapshot()).toMatchObject({ status: "failed", error: expect.stringMatching(/Maya's laptop did not start the recording/) });
        expect(cancelled).toEqual([TASK]);
    });

    it("the agent's normal result ends it: ok keeps the steps as stopped, a failure without steps is failed", () => {
        const a = driverFixture();
        a.push();
        a.driver.onResult({ ok: true });
        expect(a.driver.snapshot()).toMatchObject({ status: "stopped", canSave: true });
        const b = driverFixture();
        b.driver.onResult({ ok: false, error: "The agent was stopped." });
        expect(b.driver.snapshot()).toMatchObject({ status: "failed", error: "The agent was stopped." });
    });

    it("more than five pushes in a second are over the budget; a push for a finished recording is refused", () => {
        const { driver, clock } = driverFixture();
        const taken = Array.from({ length: 7 }, () => driver.allowPush());
        expect(taken).toEqual([true, true, true, true, true, false, false]);
        clock.now += 1_001;
        expect(driver.allowPush()).toBe(true);
    });

    it("stop is queued once; discard asks the agent, then gives the task up and ends the recording on this side", async () => {
        const { driver, push, cancelled } = driverFixture();
        push();
        await driver.stop();
        await driver.stop();
        expect(driver.onHeartbeat().commands.map((c) => c.type)).toEqual(["stop"]);
        await driver.discard();
        expect(cancelled).toEqual([TASK]);
        expect(driver.snapshot().status).toBe("stopped");
        expect(driver.onHeartbeat()).toMatchObject({ commands: [], cancel: true });
    });

    it("an unconfirmed flood drops the oldest edits and says so", async () => {
        const { driver, push } = driverFixture();
        push();
        for (let i = 0; i < 45; i++) await driver.setInspect({ on: i % 2 === 0 });
        expect(driver.snapshot().pendingCommands).toBe(40);
        expect(driver.snapshot().notes.join(" ")).toMatch(/did not keep up/);
    });

    it("pushed secrets never reach the snapshot", () => {
        const { driver, push } = driverFixture();
        push({ steps: [wireGoto(), RecStepWire.parse(step({ index: 1, kind: "fill", secret: true, value: "TYPED-PASSWORD-77", describe: "Type TYPED-PASSWORD-77", at: "2026-10-11T10:00:01.000Z" })), RecStepWire.parse(step({ index: 2, kind: "fill", value: "hunter2-secret", at: "2026-10-11T10:00:02.000Z" }))] });
        const text = JSON.stringify(driver.snapshot());
        expect(text).not.toContain("TYPED-PASSWORD-77");
        expect(text).not.toContain("hunter2-secret");
    });
});

describe("where a recording runs (decision table)", () => {
    const agent = (over: Partial<AgentRecord> & { online?: boolean; activeTasks?: number } = {}): AgentRecord & { online: boolean; activeTasks: number } => ({
        id: "a1", projectId: "p1", tokenId: "t1", name: "Maya's laptop", version: "1", os: "win32", arch: "x64", node: "v24", concurrency: 1, firstSeenMs: 0, lastSeenMs: 0,
        capabilities: { os: "win32", arch: "x64", node: "v24", browsers: ["chromium"], record: true, recordHeaded: true }, online: true, activeTasks: 0, ...over,
    });
    const platformRunner = { runOn: "platform" as const, agentId: null };
    const agentRunner = (agentId: string | null = null) => ({ runOn: "agent" as const, agentId });

    it("defaults to the runner setting: the platform when it runs there, an agent when it runs on one", () => {
        expect(chooseRecorder({ headed: true, runner: platformRunner, agents: [agent()] })).toEqual({ kind: "platform" });
        expect(chooseRecorder({ headed: true, runner: platformRunner, agents: [] })).toEqual({ kind: "platform" });
        expect(chooseRecorder({ headed: true, runner: agentRunner(), agents: [agent()] })).toMatchObject({ kind: "agent", agent: { id: "a1" } });
        expect(chooseRecorder({ on: "platform", headed: true, runner: agentRunner(), agents: [agent()] })).toEqual({ kind: "platform" });
        expect(chooseRecorder({ on: "agent", headed: true, runner: platformRunner, agents: [agent()] })).toMatchObject({ kind: "agent" });
    });

    it("names the missing thing when an agent cannot be used", () => {
        const refuse = (input: Parameters<typeof chooseRecorder>[0]) => {
            try {
                chooseRecorder(input);
            } catch (e) {
                return e as { status: number; message: string };
            }
            throw new Error("expected a refusal");
        };
        expect(refuse({ on: "agent", headed: true, runner: platformRunner, agents: [] })).toMatchObject({ status: 409, message: "Set up your runner in Settings to run tests." });
        expect(refuse({ on: "agent", headed: true, runner: platformRunner, agents: [agent({ online: false })] })).toMatchObject({ status: 409, message: expect.stringMatching(/^Your runner is offline/) });
        expect(refuse({ on: "agent", agentId: "a1", headed: true, runner: platformRunner, agents: [agent({ online: false })] })).toMatchObject({ status: 409, message: "Your runner is offline. Start it on your computer, then try again." });
        expect(refuse({ on: "agent", agentId: "other", headed: true, runner: platformRunner, agents: [agent()] })).toMatchObject({ status: 404 });
        const noRecord = agent({ capabilities: { os: "linux", arch: "x64", node: "v24", browsers: ["chromium"] } });
        expect(refuse({ on: "agent", agentId: "a1", headed: false, runner: platformRunner, agents: [noRecord] })).toMatchObject({ status: 422, message: expect.stringMatching(/Maya's laptop can't record/) });
        const noDisplay = agent({ capabilities: { os: "linux", arch: "x64", node: "v24", browsers: ["chromium"], record: true } });
        expect(refuse({ on: "agent", agentId: "a1", headed: true, runner: platformRunner, agents: [noDisplay] })).toMatchObject({ status: 422, message: "Maya's laptop has no display, so it can't show the browser window. Turn off “Show the browser window”, or use another agent." });
        // Without the window it can record.
        expect(chooseRecorder({ on: "agent", agentId: "a1", headed: false, runner: platformRunner, agents: [noDisplay] })).toMatchObject({ kind: "agent" });
        expect(recordProblem(noDisplay, false)).toBeUndefined();
    });

    it("picks, among several online agents, one that can record (and is least busy); a project's pin is no longer read (round 45)", () => {
        const idle = agent({ id: "a2", name: "Idle", activeTasks: 0 });
        const busy = agent({ id: "a3", name: "Busy", activeTasks: 2 });
        const old = agent({ id: "a4", name: "Old", capabilities: { os: "linux", arch: "x64", node: "v24", browsers: ["chromium"] } });
        expect(chooseRecorder({ on: "agent", headed: true, runner: platformRunner, agents: [old, busy, idle] })).toMatchObject({ agent: { id: "a2" } });
        expect(chooseRecorder({ headed: true, runner: agentRunner("a3"), agents: [old, busy, idle] })).toMatchObject({ agent: { id: "a2" } });
        expect(() => chooseRecorder({ headed: true, runner: agentRunner("a4"), agents: [old] })).toThrowError(/Old can't record/);
    });

    it("the task's adapter id names the agent it is for", () => {
        expect(recordAdapterId("a1")).toBe("record:a1");
    });
});

describe("the agent: what it reports and refuses", () => {
    it("a display exists on Windows (interactive session) and macOS, on Linux only with a display server", () => {
        expect(agentHasDisplay("win32", {}, true)).toBe(true);
        expect(agentHasDisplay("win32", {}, undefined)).toBe(true);
        expect(agentHasDisplay("win32", {}, false)).toBe(false);
        expect(agentHasDisplay("darwin", {})).toBe(true);
        expect(agentHasDisplay("linux", {})).toBe(false);
        expect(agentHasDisplay("linux", { DISPLAY: ":0" })).toBe(true);
        expect(agentHasDisplay("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    });

    it("only http and https pages without credentials are recorded", async () => {
        await expect(webOnlyGuard("http://127.0.0.1:3000/x")).resolves.toBeUndefined();
        await expect(webOnlyGuard("https://example.test/")).resolves.toBeUndefined();
        for (const bad of ["file:///C:/secret.txt", "javascript:alert(1)", "chrome://settings", "ftp://x/", "http://user:pass@host/", "not a url"]) await expect(webOnlyGuard(bad), bad).rejects.toBeInstanceOf(RecorderError);
    });

    it("the state is made to fit the wire: a step that does not fit is left out and the person is told", () => {
        const state: RecState = {
            status: "recording", startUrl: "http://a/", headed: false, startedAt: "x", notes: ["n".repeat(400)],
            inspect: { on: true, mode: "assertion", assertCheck: "text" },
            steps: [step({ index: 0 }), step({ index: 1, describe: "d".repeat(500) })],
        };
        const p = toPush(state, ["c1"]);
        expect(p.steps).toHaveLength(1);
        expect(p.notes!.length).toBe(2);
        expect(p.notes![0]!.length).toBe(300);
        expect(p.notes![1]).toMatch(/could not be sent/);
        expect(p).toMatchObject({ status: "recording", acked: ["c1"], inspect: { on: true, mode: "assertion", check: "text" } });
        expect(RecordingPush.safeParse(p).success).toBe(true);
    });
});

describe("the editing rules are the same wherever the session runs", () => {
    it("checkPatch", () => {
        const fill = step({ kind: "fill", value: "a" });
        expect(checkPatch(fill, { value: "b" }).value).toBe("b");
        expect(() => checkPatch(step({ kind: "fill", secret: true, value: SECRET_PLACEHOLDERS.password }), { value: "b" })).toThrowError(/secret/);
        expect(() => checkPatch(step({ kind: "press", value: "Enter" }), { value: "F5" })).toThrowError(/Enter, Escape or Tab/);
        expect(() => checkPatch(step({ kind: "assert", assert: { check: "text", expected: "a" } }), { assert: { check: "text", expected: "" } })).toThrowError(/Say what/);
        expect(() => checkPatch(step({ kind: "assert", assert: { check: "count", expected: 1 } }), { assert: { check: "count", expected: "x" } })).toThrowError(/whole number/);
        expect(checkPatch(step({ kind: "assert", assert: { check: "count", expected: 1 } }), { assert: { check: "count", expected: "4" } }).assert).toEqual({ check: "count", expected: 4 });
        expect(() => checkPatch(step({ kind: "click" }), { assert: { check: "visible" } })).toThrowError(/Only an assertion/);
    });
});

// ── the shared core, driven through a fake page ──────────────────────────────

type Handler = (...a: unknown[]) => unknown;
function fakeBrowser() {
    const calls = { launched: 0, closed: 0, evaluated: [] as unknown[], initScripts: [] as string[], routes: 0 };
    const browserHandlers = new Map<string, Handler[]>();
    const pageHandlers = new Map<string, Handler[]>();
    let binding: Handler | undefined;
    const frame = {
        locator: () => {
            throw new Error("no page");
        },
        getByTestId: () => {
            throw new Error("no page");
        },
    };
    const page = {
        on: (e: string, h: Handler) => void pageHandlers.set(e, [...(pageHandlers.get(e) ?? []), h]),
        mainFrame: () => frame,
        goto: async () => undefined,
        url: () => "http://app.test/",
        isClosed: () => calls.closed > 0,
        evaluate: async (...a: unknown[]) => void calls.evaluated.push(a),
    };
    const context = {
        exposeBinding: async (_n: string, h: Handler) => void (binding = h),
        addInitScript: async (s: string) => void calls.initScripts.push(s),
        route: async () => void calls.routes++,
        on: () => undefined,
        newPage: async () => page,
    };
    const browser = {
        on: (e: string, h: Handler) => void browserHandlers.set(e, [...(browserHandlers.get(e) ?? []), h]),
        newBrowserCDPSession: async () => {
            throw new Error("no cdp");
        },
        newContext: async () => context,
        close: async () => {
            calls.closed++;
            for (const h of browserHandlers.get("disconnected") ?? []) h();
        },
    };
    const launch = async () => {
        calls.launched++;
        return browser as unknown as Browser;
    };
    /** What the page's recorder script would send for a person's action. */
    const send = async (payload: Record<string, unknown>) => {
        const tok = /"token":"([0-9a-f]{32})"/.exec(calls.initScripts.join("\n"))?.[1];
        await binding!({ page, frame }, { tok, ts: Date.now(), url: "http://app.test/", ...payload });
    };
    return { launch, calls, send };
}
const until = async (fn: () => boolean, what: string, ms = 5000) => {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
};
const cand = (value: string, over: Record<string, unknown> = {}) => ({ strategy: "testId", value, matches: 1, ...over });

describe("the shared recorder core (fake page)", () => {
    it("records what the page reports, never keeps a secret's value, and reports every change", async () => {
        const fb = fakeBrowser();
        const taps: string[] = [];
        let changes = 0;
        const s = new RecorderSession({ startUrl: "http://app.test/", headed: false, launch: fb.launch, tap: (m) => void taps.push(JSON.stringify(m)), onChange: () => void changes++ });
        expect(s.status).toBe("starting");
        s.start();
        await until(() => s.status === "recording", "recording");
        expect(s.state().steps.map((x) => x.kind)).toEqual(["goto"]);
        await fb.send({ t: "doc" });
        await fb.send({ t: "click", cands: [cand("add")] });
        await fb.send({ t: "fill", value: "SPACE-SENTINEL-1", cands: [cand("email")] });
        await fb.send({ t: "fill", secretKind: "password", value: "PASSWORD-SENTINEL-2", cands: [cand("pw")] });
        await until(() => s.state().steps.length === 4, "four steps");
        const st = s.state();
        expect(st.steps.map((x) => [x.kind, x.value])).toEqual([["goto", undefined], ["click", undefined], ["fill", "SPACE-SENTINEL-1"], ["fill", SECRET_PLACEHOLDERS.password]]);
        expect(st.steps[3]!.secret).toBe(true);
        expect(JSON.stringify(st)).not.toContain("PASSWORD-SENTINEL-2");
        expect(st.steps.map((x) => x.index)).toEqual([0, 1, 2, 3]);
        expect(changes).toBeGreaterThan(3);
        expect(s.canSave()).toBe(true);
        // A message with the wrong token is ignored (the page's own binding is private).
        await fb.send({ t: "click", cands: [cand("evil")], tok: "0".repeat(32) });
        await new Promise((r) => setTimeout(r, 50));
        expect(s.state().steps).toHaveLength(4);
        expect(taps.length).toBeGreaterThan(4);
        await s.stop();
        expect(s.state()).toMatchObject({ status: "stopped" });
        expect(s.state().stoppedAt).toBeDefined();
        expect(fb.calls.closed).toBe(1);
        await s.stop(); // twice is fine
        expect(fb.calls.closed).toBe(1);
        await fb.send({ t: "click", cands: [cand("late")] });
        expect(s.state().steps).toHaveLength(4);
    });

    it("inspect and pick, assertion steps, edits and deletes", async () => {
        const fb = fakeBrowser();
        const s = new RecorderSession({ startUrl: "http://app.test/", headed: false, launch: fb.launch });
        s.start();
        await until(() => s.status === "recording", "recording");
        await s.setInspect({ on: true, mode: "assertion", check: "text" });
        expect(s.state().inspect).toEqual({ on: true, mode: "assertion", assertCheck: "text" });
        expect(fb.calls.evaluated.length).toBeGreaterThan(0);
        await fb.send({ t: "pick", tag: "p", text: "Hello there", cands: [cand("greeting")] });
        await until(() => s.state().steps.some((x) => x.kind === "assert"), "an assert step");
        expect(s.state().picked).toMatchObject({ tag: "p", text: "Hello there" });
        expect(s.state().steps.at(-1)!.assert).toEqual({ check: "text", expected: "Hello there" });
        await s.patchStep(1, { assert: { check: "text", expected: "Bye" } });
        expect(s.step(1).assert).toEqual({ check: "text", expected: "Bye" });
        expect(s.step(1).describe).toMatch(/Bye/);
        s.setRef(1, "greeting-text");
        expect(s.step(1).ref).toBe("greeting-text");
        s.deleteStep(0);
        expect(s.state().steps.map((x) => x.index)).toEqual([0]);
        expect(() => s.deleteStep(5)).toThrowError(RecorderError);
        await s.stop();
        // After the end: steps stay editable, inspect is refused.
        await expect(s.setInspect({ on: true })).rejects.toMatchObject({ status: 409 });
        s.deleteStep(0);
        expect(s.state().steps).toHaveLength(0);
    });

    it("the step cap and the idle limit end it with the plain notes; the browser is closed each time", async () => {
        const fb = fakeBrowser();
        const capped = new RecorderSession({ startUrl: "http://app.test/", headed: false, launch: fb.launch, caps: { maxSteps: 2 } });
        capped.start();
        await until(() => capped.status === "recording", "recording");
        await fb.send({ t: "click", cands: [cand("a")] });
        await fb.send({ t: "click", cands: [cand("b")] });
        await until(() => capped.state().notes.some((n) => /2-step limit/.test(n)), "the cap note");
        expect(capped.state().steps).toHaveLength(2);
        await capped.discard();
        const idle = fakeBrowser();
        const quick = new RecorderSession({ startUrl: "http://app.test/", headed: false, launch: idle.launch, caps: { idleMs: 120, totalMs: 60_000 } });
        quick.start();
        await until(() => quick.status === "stopped", "the idle stop");
        expect(quick.state().notes.join(" ")).toMatch(/without activity/);
        expect(idle.calls.closed).toBe(1);
    });

    it("an address the guard refuses never opens a browser; no guard means no check", async () => {
        const fb = fakeBrowser();
        const s = new RecorderSession({ startUrl: "http://10.0.0.1/", headed: false, launch: fb.launch, guard: async () => void (() => { throw new RecorderError(400, "That address is not allowed here."); })() });
        s.start();
        await until(() => s.status === "failed", "failed");
        expect(s.state().error).toBe("That address is not allowed here.");
        expect(fb.calls.launched).toBe(0);
        const open = fakeBrowser();
        const free = new RecorderSession({ startUrl: "http://10.0.0.1/", headed: false, launch: open.launch });
        free.start();
        await until(() => free.status === "recording", "recording");
        expect(open.calls.routes).toBe(0); // no address interception without a guard
        const guarded = fakeBrowser();
        const g = new RecorderSession({ startUrl: "http://app.test/", headed: false, launch: guarded.launch, guard: async () => undefined });
        g.start();
        await until(() => g.status === "recording", "recording");
        expect(guarded.calls.routes).toBe(1);
        // The agent checks the first address but lets the browser fetch pages itself (proxies, single sign-on).
        const hands = fakeBrowser();
        const h = new RecorderSession({ startUrl: "http://app.test/", headed: false, launch: hands.launch, guard: async () => undefined, interceptRequests: false });
        h.start();
        await until(() => h.status === "recording", "recording");
        expect(hands.calls.routes).toBe(0);
        await h.discard();
        await free.discard();
        await g.discard();
    });

    it("discard before the browser opened ends quietly", async () => {
        const fb = fakeBrowser();
        const s = new RecorderSession({ startUrl: "http://app.test/", headed: false, launch: fb.launch });
        s.start();
        await s.discard();
        expect(s.status).toBe("stopped");
        await s.ended;
    });
});
