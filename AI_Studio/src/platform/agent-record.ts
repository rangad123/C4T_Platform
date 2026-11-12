/**
 * Recording on a runner, the platform side: which machine records, the task that asks an agent to record, the remote driver that
 * mirrors the agent's session for the web page, and the rules for everything the agent pushes (it is semi-trusted: every push is untrusted input).
 *
 * How a record task differs from a run task (the protocol is the same queue):
 *  - `adapter_id` is `record:<agentId>`, so only the runner the recording was started on is offered it;
 *  - `job_id` is `rec-<recordingId>`: there is no job. Nothing that lists or cancels jobs matches it; the lease sweep fails such a task instead of
 *    re-offering it (a recording cannot move to another computer);
 *  - the agent pushes the whole recording state (RecordingPush) and receives the page's commands in the heartbeat reply.
 */
import { RecordCommand, type LiveResultWire, type RecordCommand as RecordCommandT, type RecordingPush as RecordingPushT, type RecStepWire, type ResultRequest } from "../agent-protocol/schema.js";
import { ON_SERVER_REFUSED, RUNNER_NOT_SET_UP, RUNNER_OFFLINE, runnerRefusal } from "./runner-only.js";
import { cleanAgentSnapshot, LIVE_LIMITS, type LiveAction, type LiveSnapshot } from "../engine/recorder/act.js";
import { describeRecStep } from "../engine/recorder/describe.js";
import { hasSavableSteps, reindex } from "../engine/recorder/normalise.js";
import { clip, locatorKey, REC_LIMITS, SECRET_PLACEHOLDERS, type RecAssertCheck, type RecStep, type SecretKind } from "../engine/recorder/model.js";
import { checkPatch, describeStep, type ActOutcome, type StepPatch } from "../engine/recorder/session.js";
import { ownerIdOfActor, type AgentRecord, type AgentTokenRecord, type RunnerSetting } from "./agent-store.js";
import { RateLimiter, scrubSecrets } from "./agent-routing.js";
import { HttpError } from "./http-error.js";
import type { Recording, RecorderDriver } from "./recorder-service.js";

// ── the task ────────────────────────────────────────────────────────────────

export const RECORD_ADAPTER_PREFIX = "record:";
export const recordAdapterId = (agentId: string): string => `${RECORD_ADAPTER_PREFIX}${agentId}`;
export const isRecordAdapter = (adapterId: string): boolean => adapterId.startsWith(RECORD_ADAPTER_PREFIX);
export const recordAgentOf = (adapterId: string): string => adapterId.slice(RECORD_ADAPTER_PREFIX.length);
export const recordJobId = (recordingId: string): string => `rec-${recordingId}`;

/** No push or heartbeat for this long: the agent is gone. */
export const LOST_CONTACT_MS = 45_000;
/** A record task nobody claimed in this long: the agent is busy or has stopped. */
export const CLAIM_WAIT_MS = 60_000;
/** After a stop or discard, how long the platform waits for the agent to confirm before it carries on. */
export const SETTLE_MS = 3_000;
/** Commands waiting for the agent: beyond this the oldest is dropped. */
export const MAX_QUEUED_COMMANDS = 40;
/** Commands in one heartbeat reply. */
export const MAX_COMMANDS_PER_BEAT = 20;
/** More pushes than this per second for one task are refused. */
export const MAX_PUSHES_PER_SECOND = 5;
/** A push larger than this is refused. */
export const MAX_PUSH_BYTES = 1_000_000;

// ── which machine records ───────────────────────────────────────────────────

export type RecorderChoice = { kind: "platform" } | { kind: "agent"; agent: AgentRecord };

/**
 * A machine a recording, a live session or a phone session may be opened on: the caller's own runner (round 45: the only runner there is),
 * while the caller may still run the project's tests. Another person's computer is never in the list: it hosts sessions for its owner only.
 */
export type SessionHost = AgentRecord & { online: boolean; activeTasks?: number; personal?: boolean; ownerId?: string | null; allowRealPhone?: boolean };

/** What sessionHosts needs of the runner store (agent-store.ts). */
export interface SessionHostStore {
    runnerOf(ownerId: string): { token: Pick<AgentTokenRecord, "allowRealPhone">; agent: AgentRecord | undefined; online: boolean } | undefined;
    ownerMayRun(ownerId: string, projectId: string): boolean;
    runningCount(agentId: string): number;
}

/** The machine `callerId` may open a session on in this project: the caller's own computer (one per person), or none. */
export function sessionHosts(store: SessionHostStore, projectId: string, callerId: string | null): SessionHost[] {
    if (!callerId || !store.ownerMayRun(callerId, projectId)) return [];
    const r = store.runnerOf(callerId);
    if (!r?.agent) return [];
    return [{ ...r.agent, online: r.online, activeTasks: store.runningCount(r.agent.id), personal: true, ownerId: callerId, allowRealPhone: r.token.allowRealPhone }];
}

/** Only the caller's own computers: another person's computer is dropped (defence in depth: sessionHosts never lists one). */
export const visibleHosts = <T extends SessionHost>(agents: T[], callerId: string | null | undefined): T[] => agents.filter((a) => !a.personal || (Boolean(callerId) && a.ownerId === callerId));

/**
 * May this person read or drive a session? A session on a person's own computer is its starter's alone (anyone else is told "not found",
 * like an id that does not exist); a session on the platform follows the project's rules.
 */
export function maySeeSession(session: { onPersonalRunner: boolean; startedBy: string | null } | undefined, callerId: string | null): boolean {
    if (!session?.onPersonalRunner) return true;
    return Boolean(callerId) && session.startedBy === callerId;
}

/** The caller as a runner owner (a signed-in user or their own API token; the open server as OPEN_OWNER_ID), or null for the access key, a schedule, the system. */
export function callerIdOf(actor: { kind: string; id?: string | undefined }): string | null {
    return ownerIdOfActor(actor);
}

/** Why a runner cannot host this recording, in words for the person, or undefined when it can. */
export function recordProblem(agent: Pick<AgentRecord, "name" | "capabilities">, headed: boolean): string | undefined {
    const c = agent.capabilities;
    if (c.record !== true) return `${agent.name} can't record: it has no Chromium browser installed (run “npx playwright install chromium” on it), or its runner program is too old to record. Update the runner.`;
    if (headed && c.recordHeaded !== true) return `${agent.name} has no screen to show the recording window on. Start the runner from a signed-in desktop session.`;
    return undefined;
}

/**
 * The caller's own runner for a session, or the refusal: not set up, offline, can't (`problem`), or ok. `hosts` comes from sessionHosts (online
 * first, most recent first: a person from before one runner per person may still have two). A named machine must be one of them, else "not found".
 */
export function ownHostFor<T extends SessionHost>(hosts: T[], problem: (host: T) => string | undefined, opts: { agentId?: string | undefined; notYours: string; offlineHint?: string }): T {
    if (opts.agentId && !hosts.some((h) => h.id === opts.agentId)) throw new HttpError(404, opts.notYours);
    const host = opts.agentId ? hosts.find((h) => h.id === opts.agentId)! : hosts[0];
    if (!host) throw runnerRefusal("RUNNER_NOT_SET_UP", RUNNER_NOT_SET_UP);
    if (!host.online) throw runnerRefusal("RUNNER_OFFLINE", opts.offlineHint ? `${RUNNER_OFFLINE} ${opts.offlineHint}` : RUNNER_OFFLINE);
    const why = problem(host);
    if (why) throw new HttpError(422, why);
    return host;
}

/**
 * Where does a new recording run? Pure: the decision table of the start route. `agents` comes from sessionHosts (the caller's own computer);
 * another person's computer is never chosen, named or not (it answers "not found").
 *  - `on` absent: the runner when the project's runner setting is "agent", else the platform;
 *  - `on: "platform"`: the platform (refused in `runners` mode); `on: "agent"`: the caller's own runner (ownHostFor).
 */
export function chooseRecorder(input: { on?: "platform" | "agent"; agentId?: string; headed: boolean; runner: RunnerSetting; agents: SessionHost[]; caller?: string | null }): RecorderChoice {
    const target = input.on ?? (input.runner.runOn === "agent" ? "agent" : "platform");
    // EXECUTION_MODE=runners: nothing is started on the server, even when asked for by name (runner-only.ts).
    if (target === "platform" && input.runner.runnersOnly) throw new HttpError(409, ON_SERVER_REFUSED("Recording"), { executionMode: "runners" });
    if (target === "platform") return { kind: "platform" };
    const agent = ownHostFor(visibleHosts(input.agents, input.caller), (a) => recordProblem(a, input.headed), {
        agentId: input.agentId,
        notYours: "That runner is not yours. Recordings open on your own runner.",
        ...(input.runner.runnersOnly ? {} : { offlineHint: "Or record on the platform instead." }),
    });
    return { kind: "agent", agent };
}

/**
 * The address a recording on an agent starts at. It is reached from the agent's own network, so private and loopback addresses are fine (the same rule
 * as agent runs); only http(s) and no credentials in the address are checked here, and the platform fetches nothing for it.
 */
export function assertAgentTarget(raw: string): void {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new HttpError(400, "That is not a valid address.");
    }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "Enter a full address starting with http:// or https://");
    if (u.username || u.password) throw new HttpError(400, "The address must not contain a user name or password. Put credentials in the project's settings instead.");
}

// ── what the agent pushes ───────────────────────────────────────────────────

const PLACEHOLDER_KIND = new Map<string, SecretKind>((Object.entries(SECRET_PLACEHOLDERS) as Array<[SecretKind, string]>).map(([k, v]) => [v, k]));

/**
 * One pushed step, made safe: a secret step's value is replaced by the standard placeholder whatever was sent (and its description is rebuilt from the
 * placeholder, so the words cannot carry it either), text is capped, and a page address that is not http(s) is dropped.
 */
export function cleanStep(raw: RecStepWire): RecStep | undefined {
    const step: RecStep = { ...raw } as RecStep;
    if (step.kind === "goto") {
        if (!step.url || !/^https?:\/\//i.test(step.url)) return undefined;
        step.url = clip(step.url, 2000);
    }
    if (step.secret === true) {
        const kind = step.value !== undefined ? PLACEHOLDER_KIND.get(step.value) : undefined;
        step.value = SECRET_PLACEHOLDERS[kind ?? "password"];
        step.describe = clip(describeRecStep({ kind: step.kind, ...(step.locator ? { locator: step.locator } : {}), value: step.value, secret: true }, { secretKind: kind ?? "password" }), REC_LIMITS.maxDescribe);
    } else {
        if (step.value !== undefined) step.value = clip(step.value, REC_LIMITS.maxValue);
        step.describe = clip(step.describe, REC_LIMITS.maxDescribe);
    }
    if (step.assert && typeof step.assert.expected === "string") step.assert = { ...step.assert, expected: clip(step.assert.expected, REC_LIMITS.maxAssertText) };
    return step;
}

/** Everything of a push that becomes platform state, made safe. Credentials the project knows are scrubbed from every text. */
export interface CleanPush {
    status: RecordingPushT["status"];
    currentUrl?: string;
    steps: RecStep[];
    inspect?: { on: boolean; mode: "locator" | "assertion"; assertCheck?: RecAssertCheck };
    picked?: Recording["picked"];
    notes: string[];
    error?: string;
    acked: string[];
}

export function cleanPush(push: RecordingPushT, opts: { maxSteps: number; secrets: string[] }): CleanPush {
    const scrubbed = scrubSecrets(push, opts.secrets);
    const steps = reindex(scrubbed.steps.flatMap((s) => cleanStep(s) ?? []).slice(0, opts.maxSteps));
    return {
        status: scrubbed.status,
        ...(scrubbed.currentUrl !== undefined ? { currentUrl: scrubbed.currentUrl } : {}),
        steps,
        ...(scrubbed.inspect ? { inspect: { on: scrubbed.inspect.on, mode: scrubbed.inspect.mode, ...(scrubbed.inspect.check ? { assertCheck: scrubbed.inspect.check } : {}) } } : {}),
        ...(scrubbed.picked ? { picked: { ...scrubbed.picked, ...(scrubbed.picked.text !== undefined ? { text: clip(scrubbed.picked.text, REC_LIMITS.maxAssertText) } : {}) } } : {}),
        notes: (scrubbed.notes ?? []).slice(0, REC_LIMITS.maxNotes),
        ...(scrubbed.error !== undefined ? { error: scrubbed.error } : {}),
        acked: scrubbed.acked ?? [],
    };
}

// ── the commands waiting for the agent ──────────────────────────────────────

/** Commands in order, ids unique, at most `max` (the oldest is dropped beyond that). The agent confirms by id; unknown ids are ignored. */
export class CommandQueue {
    private list: RecordCommandT[] = [];
    private seq = 0;
    /** How many commands were dropped because the agent did not keep up. */
    dropped = 0;

    constructor(private readonly max: number = MAX_QUEUED_COMMANDS) {}

    /** Adds a command (the id is made here). Returns it. */
    add(c: DistributiveOmit<RecordCommandT, "id">): RecordCommandT {
        const cmd = RecordCommand.parse({ ...c, id: `c${++this.seq}` });
        this.list.push(cmd);
        while (this.list.length > this.max) {
            this.list.shift();
            this.dropped++;
        }
        return cmd;
    }

    /** What goes out in the next heartbeat reply (still queued until confirmed). */
    next(limit: number = MAX_COMMANDS_PER_BEAT): RecordCommandT[] {
        return this.list.slice(0, limit);
    }

    ack(ids: string[]): void {
        if (!ids.length) return;
        const set = new Set(ids);
        this.list = this.list.filter((c) => !set.has(c.id));
    }

    has(type: RecordCommandT["type"]): boolean {
        return this.list.some((c) => c.type === type);
    }

    get length(): number {
        return this.list.length;
    }
}
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

// ── the remote driver ───────────────────────────────────────────────────────

/** What the remote driver needs of its surroundings (the agent service wires these; tests pass fakes). */
export interface RemoteDeps {
    clock(): number;
    /** The record task's row (status, times, cancel flag), or undefined when it is gone. */
    task(taskId: string): { status: "queued" | "running" | "done" | "failed" | "cancelled"; createdMs: number; claimedMs: number | null; cancelRequested: boolean } | undefined;
    /** Ask the agent to give the task up (its next heartbeat says cancel), or drop it when it is still queued. */
    cancel(taskId: string): void;
    /** Credentials the project knows (exact strings); they are scrubbed from everything an agent pushes. */
    secrets(): string[];
    lostContactMs?: number;
    claimWaitMs?: number;
    settleMs?: number;
    /** Driving step by step: how long an action or a snapshot may wait for the agent's answer (default 30 s). */
    liveWaitMs?: number;
    /** Why the session must end now (its starter lost access to the project, the computer may no longer host it), or undefined. Asked on every beat. */
    accessProblem?(): string | undefined;
}

export interface RemoteInit {
    id: string;
    projectId: string;
    taskId: string;
    agent: { id: string; name: string };
    startUrl: string;
    headed: boolean;
    environment?: string;
    maxSteps: number;
    /** The agent reports it understands the act and snapshot commands (capabilities.liveSession). */
    live?: boolean;
    /** The person who started it (null: the access key or the system). */
    startedBy?: string | null;
    /** It runs on a person's own computer: only its starter may read or drive it. */
    personal?: boolean;
}

/** Said when a session on an agent is driven step by step but the agent does not know how. */
export const TOO_OLD_TO_DRIVE = "This runner is too old to be driven step by step. Update the runner.";
const LIVE_WAIT_MS = 30_000;

const stepKey = (s: RecStep): string => `${s.at}|${s.kind}|${locatorKey(s.locator)}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The session as the platform knows it: a copy of what the agent last pushed, plus the commands the agent has not confirmed yet. Nothing is applied
 * optimistically: the page sees an edit once the agent has applied it and pushed the new state.
 */
export class RemoteDriver implements RecorderDriver {
    private status: Recording["status"] = "starting";
    private currentUrl: string | undefined;
    private steps: RecStep[] = [];
    private inspect: Recording["inspect"] = { on: false, mode: "locator" };
    private picked: Recording["picked"];
    private notes: string[] = [];
    private error: string | undefined;
    private readonly startedAt: string;
    private stoppedAt: string | undefined;
    private savedTestId: string | undefined;
    private readonly queue = new CommandQueue();
    private lastContact: number;
    private discarded = false;
    /** Names the page gave to shared elements, kept by step identity so a later push (which does not know them) does not lose them. */
    private readonly refs = new Map<string, string>();
    private readonly limiter: RateLimiter;
    private secretCache?: { at: number; list: string[] };
    /** Driving step by step: answers the agent still owes, by command id. */
    private readonly waiters = new Map<string, { resolve: (r: LiveResultWire) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    private actBusy = false;
    private snapshotWait?: { image: boolean; promise: Promise<LiveSnapshot> };
    private lastFrame?: { at: number; snap: LiveSnapshot };

    constructor(
        private readonly deps: RemoteDeps,
        private readonly init: RemoteInit,
    ) {
        this.startedAt = new Date(deps.clock()).toISOString();
        this.lastContact = deps.clock();
        this.limiter = new RateLimiter(MAX_PUSHES_PER_SECOND, 1000, deps.clock);
    }

    get id(): string {
        return this.init.id;
    }
    get projectId(): string {
        return this.init.projectId;
    }
    get taskId(): string {
        return this.init.taskId;
    }
    get startedBy(): string | null {
        return this.init.startedBy ?? null;
    }
    get onPersonalRunner(): boolean {
        return this.init.personal === true;
    }

    private get finished(): boolean {
        return this.status === "stopped" || this.status === "failed" || this.status === "saved";
    }

    private end(status: "stopped" | "failed", error?: string): void {
        if (this.finished) return;
        this.status = status;
        this.stoppedAt = new Date(this.deps.clock()).toISOString();
        this.inspect = { ...this.inspect, on: false };
        if (error !== undefined) this.error = error;
        // The last picture kept for re-use is let go with the session.
        this.lastFrame = undefined;
        this.failWaiters("The recording ended while the agent was working on this.");
    }

    private failWaiters(message: string): void {
        for (const [id, w] of this.waiters) {
            clearTimeout(w.timer);
            w.reject(new HttpError(409, message));
            this.waiters.delete(id);
        }
    }

    /** Time-based rules, evaluated whenever the state is read (so they hold with an injected clock and without timers). */
    tick(): void {
        if (this.finished) return;
        const now = this.deps.clock();
        const t = this.deps.task(this.init.taskId);
        const lost = `Lost contact with ${this.init.agent.name}. The steps recorded so far are kept.`;
        if (!t) return this.end(this.steps.length ? "stopped" : "failed", lost);
        if (t.status === "queued") {
            if (now - t.createdMs > (this.deps.claimWaitMs ?? CLAIM_WAIT_MS)) {
                this.deps.cancel(this.init.taskId);
                this.end("failed", `${this.init.agent.name} did not start the recording. Check that the agent is running and not busy with another task, then try again.`);
            }
            return;
        }
        if (t.status === "running") {
            this.lastContact = Math.max(this.lastContact, t.claimedMs ?? 0);
            if (now - this.lastContact > (this.deps.lostContactMs ?? LOST_CONTACT_MS)) {
                this.deps.cancel(this.init.taskId);
                this.end("stopped", lost);
            }
            return;
        }
        // The task ended without the agent's word (its lease ran out and the platform failed it, or it was cancelled).
        if (t.status === "done") this.end("stopped");
        else this.end("stopped", lost);
    }

    snapshot(): Recording {
        this.tick();
        const steps = this.steps.map((s) => {
            const ref = this.refs.get(stepKey(s));
            return ref ? { ...s, ref } : { ...s };
        });
        return {
            id: this.init.id,
            projectId: this.init.projectId,
            status: this.status,
            startUrl: this.init.startUrl,
            ...(this.currentUrl !== undefined ? { currentUrl: this.currentUrl } : {}),
            headed: this.init.headed,
            ...(this.init.environment ? { environment: this.init.environment } : {}),
            steps,
            inspect: { ...this.inspect },
            ...(this.picked ? { picked: this.picked } : {}),
            startedAt: this.startedAt,
            ...(this.stoppedAt ? { stoppedAt: this.stoppedAt } : {}),
            ...(this.error !== undefined ? { error: this.error } : {}),
            ...(this.savedTestId ? { savedTestId: this.savedTestId } : {}),
            canSave: this.status !== "saved" && (this.status === "stopped" || this.status === "recording") && hasSavableSteps(this.steps),
            notes: [...this.notes],
            runner: { kind: "agent", agentId: this.init.agent.id, name: this.init.agent.name },
            pendingCommands: this.queue.length,
        };
    }

    // ── from the agent ────────────────────────────────────────────────────────

    private secrets(): string[] {
        const now = this.deps.clock();
        if (!this.secretCache || now - this.secretCache.at > 30_000) this.secretCache = { at: now, list: this.deps.secrets() };
        return this.secretCache.list;
    }

    /** True for a push that fits the per-second budget. */
    allowPush(): boolean {
        return this.limiter.take(this.init.taskId);
    }

    /** The agent's state. Refused when the recording already ended on this side. */
    onPush(push: RecordingPushT): void {
        if (this.finished) throw new HttpError(409, "This recording has already ended.");
        const c = cleanPush(push, { maxSteps: Math.min(this.init.maxSteps, REC_LIMITS.maxSteps), secrets: this.secrets() });
        this.lastContact = this.deps.clock();
        this.queue.ack(c.acked);
        this.steps = c.steps;
        this.notes = c.notes;
        if (c.currentUrl !== undefined) this.currentUrl = c.currentUrl;
        if (c.inspect) this.inspect = c.inspect;
        this.picked = c.picked;
        // A session never goes back to "starting".
        if (c.status === "recording" && this.status === "starting") this.status = "recording";
        // Answers to act and snapshot commands come first, so a final push that ends the session still delivers them.
        for (const r of push.results ?? []) this.onLiveResult(r);
        if (c.status === "stopped" || c.status === "failed") this.end(c.status, c.error);
        else if (c.error !== undefined) this.error = c.error;
    }

    private onLiveResult(r: LiveResultWire): void {
        const w = this.waiters.get(r.id);
        if (!w) return; // not ours (a repeat, or one that timed out)
        clearTimeout(w.timer);
        this.waiters.delete(r.id);
        w.resolve(r);
    }

    /** The agent's beat: the commands it has not confirmed yet, and whether it should give the task up. */
    onHeartbeat(): { commands: RecordCommandT[]; cancel: boolean } {
        this.lastContact = this.deps.clock();
        this.tick();
        // Its starter lost access (or the computer may no longer host it): the session ends within this beat; the steps so far are kept.
        const gone = this.finished ? undefined : this.deps.accessProblem?.();
        if (gone) {
            this.discarded = true;
            this.deps.cancel(this.init.taskId);
            this.end("stopped", gone);
            return { commands: [], cancel: true };
        }
        const t = this.deps.task(this.init.taskId);
        return { commands: this.finished ? [] : this.queue.next(), cancel: this.discarded || Boolean(t?.cancelRequested) };
    }

    /** The agent's final word (a normal result). */
    onResult(body: Pick<ResultRequest, "ok" | "error">): void {
        if (this.finished) return;
        if (body.ok) return this.end("stopped");
        this.end(this.steps.length ? "stopped" : "failed", clip(scrubSecrets(body.error ?? `${this.init.agent.name} stopped the recording.`, this.secrets()), 500));
    }

    // ── from the page ─────────────────────────────────────────────────────────

    private send(c: DistributiveOmit<RecordCommandT, "id">): void {
        this.queue.add(c);
        if (this.queue.dropped > 0 && !this.notes.includes(DROPPED_NOTE)) this.notes = [...this.notes, DROPPED_NOTE];
    }

    async setInspect(o: { on: boolean; mode?: "locator" | "assertion"; check?: RecAssertCheck }): Promise<void> {
        this.tick();
        if (this.status !== "recording") throw new HttpError(409, "The recording has ended, so there is no page to inspect. Start a new recording.");
        this.send({ type: "inspect", on: o.on, ...(o.mode ? { mode: o.mode } : {}), ...(o.check ? { check: o.check } : {}) });
    }

    private editable(): void {
        this.tick();
        if (this.status === "saved") throw new HttpError(409, "This recording is already saved as a test. Edit the test instead.");
        if (this.status === "starting") throw new HttpError(409, "The recording is still starting.");
    }

    async patchStep(index: number, patch: StepPatch): Promise<void> {
        this.editable();
        const cur = this.steps[index];
        if (!cur) throw new HttpError(404, `This recording has no step ${index + 1}.`);
        try {
            checkPatch(cur, { ...(patch.value !== undefined ? { value: patch.value } : {}), ...(patch.assert ? { assert: patch.assert } : {}), ...(patch.locator ? { locator: patch.locator } : {}) });
        } catch (e) {
            throw new HttpError((e as { status?: number }).status ?? 400, (e as Error).message);
        }
        // The agent has finished: nothing is left to apply the edit, so the platform's copy (what a save builds from) takes it directly.
        if (this.finished) return this.patchLocally(index, patch);
        this.send({
            type: "patch",
            index,
            ...(patch.locator ? { locator: patch.locator } : {}),
            ...(patch.value !== undefined ? { value: clip(patch.value, 1000) } : {}),
            ...(patch.assert ? { assert: patch.assert } : {}),
        });
    }

    /** The same edit the recorder core makes, on the platform's copy (a locator change cannot count matches here: only a known alternative has a count). */
    private patchLocally(index: number, patch: StepPatch): void {
        const cur = this.steps[index]!;
        let step: RecStep = { ...cur };
        if (patch.locator && cur.locator) {
            const want = locatorKey(patch.locator);
            const known = cur.alternatives?.find((a) => locatorKey(a.locator) === want);
            const old = { locator: cur.locator, matches: cur.matches ?? 0 };
            const rest = [old, ...(cur.alternatives ?? [])].filter((a) => locatorKey(a.locator) !== want).slice(0, REC_LIMITS.maxAlternatives);
            step = { ...step, locator: patch.locator, alternatives: rest };
            if (known) step.matches = known.matches;
            else delete step.matches;
            delete step.ref;
        }
        step = checkPatch(step, { ...(patch.value !== undefined ? { value: patch.value } : {}), ...(patch.assert ? { assert: patch.assert } : {}) });
        step.describe = describeStep(step);
        const steps = [...this.steps];
        steps[index] = step;
        this.steps = steps;
    }

    // ── driving the page step by step ─────────────────────────────────────────

    /** Sends a command and waits (bounded) for the agent's answer to it. */
    private ask(c: DistributiveOmit<RecordCommandT, "id">): Promise<LiveResultWire> {
        const cmd = this.queue.add(c);
        const ms = this.deps.liveWaitMs ?? LIVE_WAIT_MS;
        return new Promise<LiveResultWire>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters.delete(cmd.id);
                this.queue.ack([cmd.id]);
                reject(new HttpError(504, `${this.init.agent.name} did not answer in time. The action may or may not have been done: take a snapshot to see the page.`));
            }, ms);
            timer.unref?.();
            this.waiters.set(cmd.id, { resolve, reject, timer });
        });
    }

    private liveReady(): void {
        this.tick();
        if (!this.init.live) throw new HttpError(422, TOO_OLD_TO_DRIVE);
        if (this.status !== "recording") throw new HttpError(409, "The recording has ended, so there is no page to drive. Start a new session.");
    }

    async act(action: LiveAction, o: { secret?: string; origins?: string[]; image?: boolean }): Promise<ActOutcome> {
        this.liveReady();
        if (this.actBusy) throw new HttpError(409, "Another action is still running in this session. Wait for it to finish, then try again.");
        this.actBusy = true;
        try {
            const res = scrubSecrets(await this.ask({ type: "act", action, ...(o.secret !== undefined ? { secret: o.secret } : {}), ...(o.secret !== undefined && o.origins?.length ? { origins: o.origins } : {}), ...(o.image ? { image: true } : {}) }), [...this.secrets(), ...(o.secret ? [o.secret] : [])]);
            if (!res.ok) throw new HttpError(res.status ?? 422, res.error ?? `${this.init.agent.name} could not do that.`);
            const step = res.step ? cleanStep(res.step) : undefined;
            const snapshot = res.snapshot ? cleanAgentSnapshot(res.snapshot) : { url: this.currentUrl ?? "", title: "", text: "", elements: [] };
            this.lastFrame = { at: this.deps.clock(), snap: snapshot };
            return { recorded: Boolean(step), ...(step ? { step } : {}), ...(res.note ? { note: res.note } : {}), snapshot };
        } finally {
            this.actBusy = false;
        }
    }

    async liveSnapshot(o: { image?: boolean }): Promise<LiveSnapshot> {
        this.liveReady();
        const image = o.image === true;
        // Frames are bounded in rate: a picture no older than a second is served again, and requests that arrive while one is on its way share its answer.
        const last = this.lastFrame;
        if (last && this.deps.clock() - last.at < LIVE_LIMITS.minFrameGapMs && (!image || last.snap.image)) return last.snap;
        if (this.snapshotWait && (this.snapshotWait.image || !image)) return this.snapshotWait.promise;
        const promise = (async () => {
            const res = scrubSecrets(await this.ask({ type: "snapshot", image }), this.secrets());
            if (!res.ok || !res.snapshot) throw new HttpError(res.status ?? 422, res.error ?? `${this.init.agent.name} could not read the page.`);
            const snap = cleanAgentSnapshot(res.snapshot);
            this.lastFrame = { at: this.deps.clock(), snap };
            return snap;
        })();
        this.snapshotWait = { image, promise };
        try {
            return await promise;
        } finally {
            if (this.snapshotWait?.promise === promise) this.snapshotWait = undefined;
        }
    }

    deleteStep(index: number): void {
        this.editable();
        if (!this.steps[index]) throw new HttpError(404, `This recording has no step ${index + 1}.`);
        if (this.finished) {
            this.steps = reindex(this.steps.filter((_, i) => i !== index));
            return;
        }
        this.send({ type: "delete", index });
    }

    setRef(index: number, name: string): void {
        this.editable();
        const cur = this.steps[index];
        if (!cur) throw new HttpError(404, `This recording has no step ${index + 1}.`);
        this.refs.set(stepKey(cur), name);
    }

    step(index: number): RecStep {
        const st = this.steps[index];
        if (!st) throw new HttpError(404, `This recording has no step ${index + 1}.`);
        const ref = this.refs.get(stepKey(st));
        return ref ? { ...st, ref } : { ...st };
    }

    async stop(): Promise<void> {
        this.tick();
        if (this.finished || this.queue.has("stop")) return;
        this.send({ type: "stop" });
    }

    /** Waits (bounded) until the recording has ended on the agent's word, so a save sees the final steps. */
    async settled(maxMs: number): Promise<void> {
        const end = Date.now() + Math.max(0, maxMs);
        for (;;) {
            this.tick();
            if (this.finished || Date.now() >= end) return;
            await sleep(50);
        }
    }

    async discard(): Promise<void> {
        this.tick();
        this.discarded = true;
        if (this.finished) return;
        this.send({ type: "discard" });
        await this.settled(this.deps.settleMs ?? SETTLE_MS);
        // Whether the agent confirmed or not, the platform is done with it: an agent that did not hear it is told to give the task up.
        this.deps.cancel(this.init.taskId);
        this.end("stopped");
    }

    markSaved(testId: string): void {
        this.savedTestId = testId;
        this.status = "saved";
        this.stoppedAt ??= new Date(this.deps.clock()).toISOString();
    }

    pid(): number | undefined {
        return undefined;
    }

    /** Platform shutdown: the agent is asked to give the task up; nothing else is waited for. */
    async dispose(): Promise<void> {
        this.discarded = true;
        if (!this.finished) this.deps.cancel(this.init.taskId);
        this.end("stopped");
    }
}

const DROPPED_NOTE = "Some edits were not delivered to the runner agent because it did not keep up. Check the steps.";

/** The recordings of one platform that live on an agent, by task id (the agent routes find the driver of a task here). */
export class RecordHub {
    private readonly byTask = new Map<string, RemoteDriver>();
    add(d: RemoteDriver): void {
        this.byTask.set(d.taskId, d);
    }
    get(taskId: string): RemoteDriver | undefined {
        return this.byTask.get(taskId);
    }
    /** The driver of a recording, by the recording's id. */
    byRecording(recordingId: string): RemoteDriver | undefined {
        for (const d of this.byTask.values()) if (d.id === recordingId) return d;
        return undefined;
    }
    forget(taskId: string): void {
        this.byTask.delete(taskId);
    }
    /** Drivers whose recording ended long ago are dropped so the map cannot grow without bound. */
    prune(keep: (d: RemoteDriver) => boolean): void {
        for (const [k, d] of this.byTask) if (!keep(d)) this.byTask.delete(k);
    }
    get size(): number {
        return this.byTask.size;
    }
}
