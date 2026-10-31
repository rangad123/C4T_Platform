/**
 * Phone sessions, the platform side: where the phone is (this computer or a runner agent), the device task that asks an agent for a session, the remote
 * driver that turns the explorer's calls into commands for the agent, and the rules for everything the agent sends back (semi-trusted: every push is untrusted).
 *
 * `openDeviceSession` is the ONE function the explorer calls. It returns a `DeviceSession` (src/engine/mobile/device/types.ts) that is either local (adb on this
 * computer) or remote (`kind: "agent"`); the explorer cannot tell them apart except by `kind`.
 *
 * How a device task differs from a run task (the protocol is the same queue, as for recordings in agent-record.ts):
 *  - `adapter_id` is `device:<agentId>`: only the agent the session was started on is offered it; the lease sweep fails such a task instead of re-offering it;
 *  - `job_id` is the exploration's job when the caller gives one (so a finished or cancelled job takes its phone session with it), else `dev-<sessionId>`;
 *  - the explorer's calls are commands in the heartbeat reply (`deviceCommands`); the agent's answers are pushes (`results`), matched by command id.
 *  An infrastructure failure (the agent stopped answering, the phone went away, a limit) is thrown as DeviceSessionError and is never a test verdict.
 */
import { randomUUID } from "node:crypto";
import { DeviceCommand, DEVICE_MAX_ELEMENTS, DEVICE_MAX_IMAGE_B64, TaskOffer, type DevicePush, type DeviceResultWire, type DeviceSnapshotWire, type ResultRequest } from "../agent-protocol/schema.js";
import { parseAction } from "../engine/mobile/device/actions.js";
import { DeviceSessionError } from "../engine/mobile/device/errors.js";
import { openLocalDeviceSession, SESSION_DEFAULTS } from "../engine/mobile/device/session.js";
import type { ActResult, DeviceAction, DeviceSession, OpenDeviceOptions, ScreenElement, ScreenSnapshot } from "../engine/mobile/device/types.js";
import { cleanText, fingerprintOf, textFingerprintOf } from "../engine/mobile/device/uiautomator.js";
import { adbPath } from "../engine/mobile/toolchain.js";
import { deviceSessionProblem } from "../engine/mobile/device/capability.js";
import type { AgentService } from "./agent-services.js";
import type { AgentRecord, RunnerSetting } from "./agent-store.js";
import { RateLimiter, scrubSecrets } from "./agent-routing.js";
import { HttpError } from "./http-error.js";
import { keyOfStoredFile } from "./object-store.js";

// ── the task ────────────────────────────────────────────────────────────────

export const DEVICE_ADAPTER_PREFIX = "device:";
export const deviceAdapterId = (agentId: string): string => `${DEVICE_ADAPTER_PREFIX}${agentId}`;
export const isDeviceAdapter = (adapterId: string): boolean => adapterId.startsWith(DEVICE_ADAPTER_PREFIX);
export const deviceAgentOf = (adapterId: string): string => adapterId.slice(DEVICE_ADAPTER_PREFIX.length);
export const deviceJobId = (sessionId: string): string => `dev-${sessionId}`;

/** No push or heartbeat for this long: the agent is gone. */
export const DEVICE_LOST_CONTACT_MS = 45_000;
/** A device task nobody claimed in this long: the agent is busy or has stopped. */
export const DEVICE_CLAIM_WAIT_MS = 60_000;
/** Once claimed, how long the agent may take to open the phone (starting an emulator can take minutes) while it keeps in touch. */
export const DEVICE_START_WAIT_MS = 12 * 60_000;
/** How long one command may wait for the agent's answer (an action settles for up to 3 s and may wait 3 s more). */
export const DEVICE_COMMAND_WAIT_MS = 45_000;
/** After a close, how long the platform waits for the agent to confirm before it carries on. */
export const DEVICE_SETTLE_MS = 3_000;
/** More pushes than this per second for one task are refused. */
export const MAX_DEVICE_PUSHES_PER_SECOND = 10;
export const MAX_DEVICE_PUSH_BYTES = 1_000_000;

/** Timeouts the tests shorten. */
export interface RemoteDeviceTimeouts {
    lostContactMs?: number;
    claimWaitMs?: number;
    startWaitMs?: number;
    commandWaitMs?: number;
    settleMs?: number;
}
/** Test seam: set `deviceOptions.remote` to shorten the timeouts of every remote session. Unset in normal use. */
export const deviceOptions: { remote?: RemoteDeviceTimeouts } = {};

// ── where the phone is ──────────────────────────────────────────────────────

export type DeviceHostChoice = { kind: "platform" } | { kind: "agent"; agent: AgentRecord };

/** Why an agent cannot host a phone session, in words for the person, or undefined when it can. */
export function deviceProblem(agent: Pick<AgentRecord, "name" | "capabilities">): string | undefined {
    const c = agent.capabilities;
    if (c.deviceSession === true) return undefined;
    // An agent program from before phone exploration says nothing about it: then adb is the only thing we can judge.
    const why = c.android ? deviceSessionProblem(c) : "it has no Android tools";
    return c.android && why === undefined
        ? `${agent.name} can't be used to explore a phone: its agent program is too old. Update the runner agent, or use the platform.`
        : `${agent.name} can't be used to explore a phone: ${why ?? "it has no Android tools"}`;
}

/** Why this computer cannot be used for a phone session, or undefined. */
export function localDeviceProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return adbPath(env) ? undefined : "This computer has no Android tools (adb), so a phone can't be explored here. Run `npx @taqwright/taqwright install --with-avd` on it, or use a runner agent that has a phone.";
}

/**
 * Where does a phone session run? Pure: the decision table.
 *  - `on` absent: the agent when the project's runner setting is "agent", else this computer (today's behaviour for tests);
 *  - `on: "platform"`: this computer; `on: "agent"`: an online agent of the project that can host a session (the one named, or the one the project is pinned to,
 *    or the least busy of the online ones), otherwise a plain refusal naming what is missing.
 */
export function chooseDeviceHost(input: { on?: "platform" | "agent"; agentId?: string; runner: RunnerSetting; agents: Array<AgentRecord & { online: boolean; activeTasks?: number }>; localProblem?: string }): DeviceHostChoice {
    const target = input.on ?? (input.runner.runOn === "agent" ? "agent" : "platform");
    if (target === "platform") {
        if (input.localProblem) throw new HttpError(409, input.localProblem);
        return { kind: "platform" };
    }
    const wanted = input.agentId ?? input.runner.agentId ?? undefined;
    if (wanted) {
        const agent = input.agents.find((a) => a.id === wanted);
        if (!agent) throw new HttpError(404, "That runner agent does not belong to this project.");
        if (!agent.online) throw new HttpError(409, `${agent.name} is offline. Start it, or use another agent or the platform.`);
        const why = deviceProblem(agent);
        if (why) throw new HttpError(422, why);
        return { kind: "agent", agent };
    }
    const online = input.agents.filter((a) => a.online);
    if (online.length === 0) throw new HttpError(409, "No runner agent is online for this project. Start one, or explore on the platform instead.");
    const capable = online.filter((a) => !deviceProblem(a));
    if (capable.length === 0) throw new HttpError(422, deviceProblem(online[0]!)!);
    capable.sort((a, b) => (a.activeTasks ?? 0) - (b.activeTasks ?? 0));
    return { kind: "agent", agent: capable[0]! };
}

// ── what the agent sends back ───────────────────────────────────────────────

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A snapshot from the agent, made safe: texts cleaned again, a password field's text emptied whatever was sent, the element list renumbered and capped, the
 * fingerprint recomputed here (so equal screens compare equal whatever an agent claims), a picture kept only if it is a JPEG of the size the contract allows,
 * and every credential the project knows removed from every string.
 */
export function cleanDeviceSnapshot(wire: DeviceSnapshotWire, secrets: string[]): ScreenSnapshot {
    const w = scrubSecrets(wire, secrets);
    const elements: ScreenElement[] = w.elements.slice(0, DEVICE_MAX_ELEMENTS).map((e, index) => ({
        index,
        cls: cleanText(e.cls, 60) || "View",
        text: e.password ? "" : cleanText(e.text),
        desc: cleanText(e.desc),
        id: cleanText(e.id, 100),
        clickable: e.clickable,
        longClickable: e.longClickable,
        scrollable: e.scrollable,
        editable: e.editable,
        password: e.password,
        checkable: e.checkable,
        checked: e.checked,
        enabled: e.enabled,
        focused: e.focused,
        bounds: e.bounds,
        // Round 24 (optional): where the element sits, for the locators a written test uses.
        ...(e.scopes?.length ? { scopes: e.scopes.slice(-6).map((s) => cleanText(s, 100)).filter(Boolean) } : {}),
        ...(e.inScroll ? { inScroll: true as const } : {}),
        ...(e.selected ? { selected: true as const } : {}),
        ...(e.bareId ? { bareId: true as const } : {}),
    }));
    const pkg = cleanText(w.package, 200);
    const activity = w.activity ? cleanText(w.activity, 200) : undefined;
    const picture = w.screenshot && w.screenshot.length <= DEVICE_MAX_IMAGE_B64 && w.screenshot.startsWith("/9j/") && B64.test(w.screenshot) ? w.screenshot : undefined;
    return {
        package: pkg,
        ...(activity ? { activity } : {}),
        width: w.width,
        height: w.height,
        elements,
        fingerprint: fingerprintOf(pkg, activity, elements, w.height),
        textFingerprint: textFingerprintOf(pkg, activity, elements),
        ...(picture ? { screenshot: picture } : {}),
        keyboard: w.keyboard,
        outsideApp: w.outsideApp,
    };
}

// ── the remote driver ───────────────────────────────────────────────────────

export interface RemoteDeviceDeps {
    clock(): number;
    /** The device task's row, or undefined when it is gone. */
    task(taskId: string): { status: "queued" | "running" | "done" | "failed" | "cancelled"; createdMs: number; claimedMs: number | null; cancelRequested: boolean } | undefined;
    /** Ask the agent to give the task up (its next heartbeat says cancel), or drop it when it is still queued. */
    cancel(taskId: string): void;
    /** Credentials the project knows (exact strings): scrubbed from everything an agent sends. */
    secrets(): string[];
}

export interface RemoteDeviceInit {
    id: string;
    projectId: string;
    taskId: string;
    agent: { id: string; name: string };
    maxActions: number;
    maxMinutes: number;
    timeouts?: RemoteDeviceTimeouts;
}

type Status = "queued" | "starting" | "ready" | "ended" | "failed";
type Command = DeviceCommand;
type CommandBody = Command extends infer C ? (C extends unknown ? Omit<C, "id"> : never) : never;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RemoteDeviceDriver {
    get limits(): { actions: number; minutes: number } {
        return { actions: this.init.maxActions, minutes: this.init.maxMinutes };
    }
    private status: Status = "queued";
    private deviceName = "";
    private error: string | undefined;
    private notes: string[] = [];
    private queue: Command[] = [];
    private seq = 0;
    private lastContact: number;
    private closing = false;
    private actions = 0;
    private readonly startedAt: number;
    private readonly limiter: RateLimiter;
    private secretCache?: { at: number; list: string[] };
    private readonly waiters = new Map<string, { resolve: (r: DeviceResultWire) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    /** Calls run one at a time, in order. */
    private chain: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly deps: RemoteDeviceDeps,
        private readonly init: RemoteDeviceInit,
    ) {
        this.startedAt = deps.clock();
        this.lastContact = deps.clock();
        this.limiter = new RateLimiter(MAX_DEVICE_PUSHES_PER_SECOND, 1000, deps.clock);
    }

    get id(): string {
        return this.init.id;
    }
    get taskId(): string {
        return this.init.taskId;
    }
    get agentName(): string {
        return this.init.agent.name;
    }
    get name(): string {
        return this.deviceName || `Phone on ${this.init.agent.name}`;
    }
    get state(): { status: Status; error?: string; notes: string[] } {
        this.tick();
        return { status: this.status, ...(this.error ? { error: this.error } : {}), notes: [...this.notes] };
    }
    get finished(): boolean {
        return this.status === "ended" || this.status === "failed";
    }

    private t(): Required<RemoteDeviceTimeouts> {
        const o = this.init.timeouts ?? {};
        return {
            lostContactMs: o.lostContactMs ?? DEVICE_LOST_CONTACT_MS,
            claimWaitMs: o.claimWaitMs ?? DEVICE_CLAIM_WAIT_MS,
            startWaitMs: o.startWaitMs ?? DEVICE_START_WAIT_MS,
            commandWaitMs: o.commandWaitMs ?? DEVICE_COMMAND_WAIT_MS,
            settleMs: o.settleMs ?? DEVICE_SETTLE_MS,
        };
    }

    private secrets(): string[] {
        const now = this.deps.clock();
        if (!this.secretCache || now - this.secretCache.at > 30_000) this.secretCache = { at: now, list: this.deps.secrets() };
        return this.secretCache.list;
    }

    private end(status: "ended" | "failed", error?: string): void {
        if (this.finished) return;
        this.status = status;
        if (error !== undefined) this.error = error;
        this.failWaiters(this.error ?? "The phone session ended while the runner agent was working on this.");
        this.queue = [];
    }

    private failWaiters(message: string): void {
        for (const [id, w] of this.waiters) {
            clearTimeout(w.timer);
            w.reject(new DeviceSessionError(message));
            this.waiters.delete(id);
        }
    }

    /** Time-based rules, evaluated whenever the state is read (so they hold with an injected clock and without timers). */
    tick(): void {
        if (this.finished) return;
        const now = this.deps.clock();
        const t = this.deps.task(this.init.taskId);
        const lost = `Lost contact with ${this.init.agent.name}. The phone session was ended.`;
        if (!t) return this.end("failed", lost);
        const limits = this.t();
        if (t.status === "queued") {
            if (now - t.createdMs > limits.claimWaitMs) {
                this.deps.cancel(this.init.taskId);
                this.end("failed", `${this.init.agent.name} did not start the phone session. Check that the agent is running and not busy with another task, then try again.`);
            }
            return;
        }
        if (t.status === "running") {
            this.lastContact = Math.max(this.lastContact, t.claimedMs ?? 0);
            if (now - this.lastContact > limits.lostContactMs) {
                this.deps.cancel(this.init.taskId);
                this.end("failed", lost);
            }
            return;
        }
        // The task ended without the agent's word (its lease ran out and the platform failed it, or it was cancelled).
        if (t.status === "done" || this.closing) this.end("ended");
        else this.end("failed", lost);
    }

    // ── from the agent ────────────────────────────────────────────────────────

    allowPush(): boolean {
        return this.limiter.take(this.init.taskId);
    }

    onPush(push: DevicePush): void {
        if (this.finished) throw new HttpError(409, "This phone session has already ended.");
        this.lastContact = this.deps.clock();
        const safe = scrubSecrets(push, this.secrets());
        if (safe.notes) this.notes = safe.notes.map((n) => cleanText(n, 300)).slice(-20);
        if (safe.deviceName) this.deviceName = cleanText(safe.deviceName, 80);
        if (safe.status === "starting" && this.status === "queued") this.status = "starting";
        // Answers come first, so a final push that ends the session still delivers them.
        for (const r of push.results ?? []) this.onAnswer(r);
        if (safe.status === "ready" && !this.finished) this.status = "ready";
        else if (safe.status === "ended") this.end("ended");
        else if (safe.status === "failed") this.end("failed", cleanText(safe.error ?? `${this.init.agent.name} could not use the phone.`, 400));
    }

    private onAnswer(r: DeviceResultWire): void {
        const w = this.waiters.get(r.id);
        if (!w) return; // not ours (a repeat, or one that timed out)
        clearTimeout(w.timer);
        this.waiters.delete(r.id);
        this.queue = this.queue.filter((c) => c.id !== r.id);
        w.resolve(r);
    }

    /** The agent's beat: the commands it has not answered yet, and whether it should give the task up. */
    onHeartbeat(): { commands: Command[]; cancel: boolean } {
        this.lastContact = this.deps.clock();
        this.tick();
        const t = this.deps.task(this.init.taskId);
        return { commands: this.finished ? [] : this.queue.slice(0, 5), cancel: this.closing || Boolean(t?.cancelRequested) };
    }

    /** The agent's final word (a normal result). */
    onResult(body: Pick<ResultRequest, "ok" | "error">): void {
        if (this.finished) return;
        if (body.ok) return this.end("ended");
        this.end("failed", cleanText(scrubSecrets(body.error ?? `${this.init.agent.name} stopped the phone session.`, this.secrets()), 400));
    }

    // ── from the explorer ─────────────────────────────────────────────────────

    /** Waits (bounded) until the agent has opened the phone. Throws DeviceSessionError with the reason when it cannot. */
    async waitReady(signal?: AbortSignal): Promise<void> {
        const limit = Date.now() + this.t().startWaitMs;
        for (;;) {
            this.tick();
            if (this.status === "ready") return;
            if (this.finished) throw new DeviceSessionError(this.error ?? `${this.init.agent.name} could not open the phone.`);
            if (signal?.aborted) throw new DeviceSessionError("The session was stopped.");
            if (Date.now() > limit) {
                this.deps.cancel(this.init.taskId);
                this.end("failed", `${this.init.agent.name} did not open the phone in time.`);
                throw new DeviceSessionError(this.error!);
            }
            await sleep(40);
        }
    }

    private ask(c: CommandBody): Promise<DeviceResultWire> {
        const cmd = DeviceCommand.parse({ ...c, id: `d${++this.seq}` });
        this.queue.push(cmd);
        const ms = this.t().commandWaitMs;
        return new Promise<DeviceResultWire>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters.delete(cmd.id);
                // An agent that stopped answering ends the session: it can't be known what the phone did.
                this.deps.cancel(this.init.taskId);
                this.end("failed", `${this.init.agent.name} did not answer in time, so the phone session was ended.`);
                reject(new DeviceSessionError(this.error!));
            }, ms);
            timer.unref?.();
            this.waiters.set(cmd.id, { resolve, reject, timer });
        });
    }

    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(async () => {
            this.tick();
            if (this.closing) throw new DeviceSessionError("This session has ended.");
            if (this.finished) throw new DeviceSessionError(this.error ?? "This session has ended.");
            if (this.status !== "ready") throw new DeviceSessionError("The phone is not open yet.");
            if (this.deps.clock() - this.startedAt > this.init.maxMinutes * 60_000) {
                await this.close();
                throw new DeviceSessionError(`This session reached its time limit of ${this.init.maxMinutes} minutes.`);
            }
            return fn();
        });
        this.chain = run.catch(() => undefined);
        return run;
    }

    snapshot(screenshot: boolean): Promise<ScreenSnapshot> {
        return this.serial(async () => {
            const r = await this.ask({ type: "snapshot", screenshot });
            if (!r.ok || !r.snapshot) throw new DeviceSessionError(cleanText(scrubSecrets(r.error ?? `${this.init.agent.name} could not read the phone's screen.`, this.secrets()), 300));
            return cleanDeviceSnapshot(r.snapshot, this.secrets());
        });
    }

    act(action: DeviceAction, screenshot: boolean): Promise<ActResult> {
        return this.serial(async () => {
            if (this.actions >= this.init.maxActions) {
                await this.close();
                throw new DeviceSessionError(`This session reached its limit of ${this.init.maxActions} actions.`);
            }
            this.actions++;
            const checked = parseAction(action);
            if (!checked.ok) return { ok: false, error: checked.error };
            const r = await this.ask({ type: "act", action: checked.action as never, ...(screenshot ? { screenshot: true } : {}) });
            const snapshot = r.snapshot ? cleanDeviceSnapshot(r.snapshot, this.secrets()) : undefined;
            if (!r.ok) return { ok: false, error: cleanText(scrubSecrets(r.error ?? "The phone could not do that.", this.secrets()), 300), ...(snapshot ? { snapshot } : {}) };
            return { ok: true, ...(snapshot ? { snapshot } : {}) };
        });
    }

    /** Ends the session: the agent is told to give the task up, which closes the phone session and stops an emulator it started. */
    async close(): Promise<void> {
        this.tick();
        if (this.closing) return;
        this.closing = true;
        if (this.finished) return;
        this.deps.cancel(this.init.taskId);
        // How long to wait is real time; the injected clock only decides the state rules in tick().
        const end = Date.now() + this.t().settleMs;
        while (!this.finished && Date.now() < end) {
            this.tick();
            await sleep(40);
        }
        this.end("ended");
    }

    /** Platform shutdown: the agent is asked to give the task up; nothing else is waited for. */
    dispose(): void {
        this.closing = true;
        if (!this.finished) this.deps.cancel(this.init.taskId);
        this.end("ended");
    }
}

/** The session the explorer holds when the phone is on a runner agent. */
export class RemoteDeviceSession implements DeviceSession {
    readonly kind = "agent" as const;
    constructor(private readonly driver: RemoteDeviceDriver) {}
    /** The caps the runner was given (R24): the explorer stops before them. */
    get actionLimit(): number {
        return this.driver.limits.actions;
    }
    get minuteLimit(): number {
        return this.driver.limits.minutes;
    }
    get deviceName(): string {
        return this.driver.name;
    }
    snapshot(opts: { screenshot?: boolean } = {}): Promise<ScreenSnapshot> {
        return this.driver.snapshot(opts.screenshot === true);
    }
    act(action: DeviceAction, opts: { screenshot?: boolean } = {}): Promise<ActResult> {
        return this.driver.act(action, opts.screenshot === true);
    }
    close(): Promise<void> {
        return this.driver.close();
    }
}

/** The phone sessions that live on an agent, by task id (the agent routes find the driver of a task here). */
export class DeviceHub {
    private readonly byTask = new Map<string, RemoteDeviceDriver>();
    add(d: RemoteDeviceDriver): void {
        this.byTask.set(d.taskId, d);
    }
    get(taskId: string): RemoteDeviceDriver | undefined {
        return this.byTask.get(taskId);
    }
    /** Drivers whose session ended long ago are dropped so the map cannot grow without bound. */
    prune(keep: (d: RemoteDeviceDriver) => boolean): void {
        for (const [k, d] of this.byTask) if (!keep(d)) this.byTask.delete(k);
    }
    get size(): number {
        return this.byTask.size;
    }
}

// ── starting a session on an agent ──────────────────────────────────────────

export interface StartDeviceOptions {
    projectId: string;
    agent: AgentRecord;
    appPackage: string;
    apkPath?: string;
    avd?: string;
    serial?: string;
    credentials?: { username?: string; password?: string };
    /** The exploration's job: when it ends, the phone session is taken away with it. */
    jobId?: string;
    maxActions?: number;
    maxMinutes?: number;
    timeouts?: RemoteDeviceTimeouts;
}

/** Queues the device task for `agent` and returns the driver that mirrors the session for the explorer. */
export async function startDeviceTask(svc: AgentService, o: StartDeviceOptions): Promise<RemoteDeviceDriver> {
    const id = randomUUID();
    const taskId = randomUUID();
    const files: Array<{ direction: "in" | "out"; ref: string; path: string; size: number; sha256: string }> = [];
    let apk: { ref: string; size: number; sha256: string } | undefined;
    if (o.apkPath) {
        // Only a file inside the platform's own store is ever offered to an agent.
        const rel = keyOfStoredFile(svc.p.store, o.apkPath, o.projectId);
        if (!rel) throw new DeviceSessionError("The app file is not in this project's storage, so it cannot be sent to a runner agent. Upload it again.");
        const { sha, size } = await svc.apkHash(rel).catch(() => {
            throw new DeviceSessionError("The app file could not be read, so the session was not sent to the agent.");
        });
        const ref = `app-${sha.slice(0, 12)}.apk`;
        apk = { ref, size, sha256: sha };
        files.push({ direction: "in", ref, path: rel, size, sha256: sha });
    }
    const maxActions = Math.min(500, Math.max(1, o.maxActions ?? SESSION_DEFAULTS.maxActions));
    const maxMinutes = Math.min(120, Math.max(1, o.maxMinutes ?? SESSION_DEFAULTS.maxMinutes));
    let offer: TaskOffer;
    try {
        offer = TaskOffer.parse({
            taskId,
            jobId: o.jobId ?? deviceJobId(id),
            adapterId: deviceAdapterId(o.agent.id),
            leaseSeconds: svc.limits.leaseSeconds,
            workers: 1,
            kind: "device",
            scripts: [],
            env: { baseUrl: "device:", headless: true },
            device: {
                sessionId: id,
                appPackage: o.appPackage,
                ...(apk ? { apk } : {}),
                ...(o.avd ? { avd: o.avd } : {}),
                ...(o.serial ? { deviceSerial: o.serial } : {}),
                ...(o.credentials && (o.credentials.username || o.credentials.password) ? { credentials: { ...(o.credentials.username ? { username: o.credentials.username } : {}), ...(o.credentials.password ? { password: o.credentials.password } : {}) } } : {}),
                maxActions,
                totalMinutes: maxMinutes,
            },
        });
    } catch {
        throw new DeviceSessionError("These phone settings cannot be sent to a runner agent. Check the app id and the emulator name.");
    }
    svc.store.enqueue({ id: taskId, projectId: o.projectId, jobId: offer.jobId, adapterId: offer.adapterId, payloadEnc: svc.encrypt(offer), files });
    const password = o.credentials?.password ?? "";
    const driver = new RemoteDeviceDriver(
        {
            clock: svc.clock,
            task: (tid) => svc.store.getTask(tid),
            cancel: (tid) => svc.store.requestCancel(tid),
            secrets: () => [...svc.projectSecrets(o.projectId), ...(password.length >= 4 ? [password] : [])],
        },
        { id, projectId: o.projectId, taskId, agent: { id: o.agent.id, name: o.agent.name }, maxActions, maxMinutes, timeouts: { ...(deviceOptions.remote ?? {}), ...(o.timeouts ?? {}) } },
    );
    svc.devices.add(driver);
    return driver;
}

// ── the one function the explorer calls ─────────────────────────────────────

export interface DeviceHost {
    /** The runner agents of the platform; absent means this computer only. */
    agents?: AgentService;
    projectId?: string;
    /** Force the place; absent: the project's runner choice (an agent when the project runs on an agent, else this computer). */
    on?: "platform" | "agent";
    agentId?: string;
    /** The exploration's job id, so a finished or cancelled job takes its phone session on an agent with it. */
    jobId?: string;
    timeouts?: RemoteDeviceTimeouts;
}

/**
 * Opens a phone session where the project's runner choice says (this computer, or a runner agent) and returns it once the phone is ready.
 * Rejects with DeviceSessionError carrying a plain sentence when it cannot.
 */
export async function openDeviceSession(opts: OpenDeviceOptions, host: DeviceHost = {}): Promise<DeviceSession> {
    const env = opts.env ?? process.env;
    let choice: DeviceHostChoice;
    try {
        if (!host.agents || !host.projectId) {
            if (host.on === "agent") throw new HttpError(409, "No runner agents are known here, so the phone can't be explored on one.");
            const problem = localDeviceProblem(env);
            if (problem) throw new HttpError(409, problem);
            choice = { kind: "platform" };
        } else {
            choice = chooseDeviceHost({
                ...(host.on ? { on: host.on } : {}),
                ...(host.agentId ? { agentId: host.agentId } : {}),
                runner: host.agents.store.getRunner(host.projectId),
                agents: host.agents.store.listAgents(host.projectId),
                ...(localDeviceProblem(env) ? { localProblem: localDeviceProblem(env)! } : {}),
            });
        }
    } catch (e) {
        if (e instanceof HttpError) throw new DeviceSessionError(e.message);
        throw e;
    }
    if (choice.kind === "platform") return openLocalDeviceSession({ ...opts, env });

    const driver = await startDeviceTask(host.agents!, {
        projectId: host.projectId!,
        agent: choice.agent,
        appPackage: opts.appPackage,
        ...(opts.apkPath ? { apkPath: opts.apkPath } : {}),
        ...(opts.avd ? { avd: opts.avd } : {}),
        ...(opts.serial ? { serial: opts.serial } : {}),
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
        ...(host.jobId ? { jobId: host.jobId } : {}),
        ...(opts.maxActions ? { maxActions: opts.maxActions } : {}),
        ...(opts.maxMinutes ? { maxMinutes: opts.maxMinutes } : {}),
        ...(host.timeouts ? { timeouts: host.timeouts } : {}),
    });
    opts.log?.(`Asked ${choice.agent.name} to open the phone`);
    // A stop from outside ends the remote session too (the agent is told to give the task up).
    const onAbort = () => void driver.close().catch(() => undefined);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        await driver.waitReady(opts.signal);
    } catch (e) {
        opts.signal?.removeEventListener("abort", onAbort);
        await driver.close().catch(() => undefined);
        throw e;
    }
    opts.log?.(`Opened ${opts.appPackage} on ${driver.name}`);
    return new RemoteDeviceSession(driver);
}
