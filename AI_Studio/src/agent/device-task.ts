/**
 * A device task, from the agent's side: open the app under test on a phone or emulator of THIS computer, answer what the explorer on the platform asks of it
 * (read the screen, do one action), and close everything it started.
 *
 *  - the session runs in this process (adb calls have their own time limits); the emulator, if this task started one, is stopped by the exact serial it
 *    recorded, on a normal end, a cancel, a time limit, the agent being stopped or the platform going away;
 *  - every command is checked again here (the protocol's strict action schema, then the session's own rules): an action carries only an element number, so a
 *    package, a coordinate or a command line has nowhere to go; the session only ever starts the task's own package;
 *  - the heartbeat is every second, carries the commands and the cancel flag; answers go out as pushes the moment they exist, and the last state is never dropped;
 *  - a password the task carries is typed on this computer only: it is registered with the log, scrubbed from texts, and never sent back.
 */
import { DeviceCommand, DevicePush, DeviceSnapshotWire, DeviceTask as DeviceTaskSchema, type DeviceResultWire, type ResultRequest, type TaskOffer } from "../agent-protocol/schema.js";
import { DeviceSessionError } from "../engine/mobile/device/errors.js";
import { openLocalDeviceSession } from "../engine/mobile/device/session.js";
import type { DeviceSession, OpenDeviceOptions, ScreenSnapshot } from "../engine/mobile/device/types.js";
import { PlatformError, type PlatformClient } from "./client.js";
import type { FileCache } from "./file-cache.js";
import { adbPath } from "../engine/mobile/toolchain.js";
import type { PhoneToolsSetup } from "./phone-tools.js";
import type { Logger } from "./log.js";

/** Without a good answer from the platform for this long, the session ends (a phone must not stay in use for nothing). */
export const DEVICE_PLATFORM_SILENCE_MS = 90_000;
const BEAT_MS = 1000;

export interface DeviceTaskDeps {
    client: PlatformClient;
    log: Logger;
    env: NodeJS.ProcessEnv;
    cache: FileCache;
    /** The agent's retrying poster of the normal result. */
    postResult(body: ResultRequest): Promise<void>;
    /** Tests: shorter intervals, and a replacement for the local session opener. */
    beatMs?: number;
    silenceMs?: number;
    open?: (opts: OpenDeviceOptions) => Promise<DeviceSession>;
    /** The runner's own Android phone tools (phone-tools.ts): fetched first when this computer has no adb. */
    phoneTools?: Pick<PhoneToolsSetup, "ensure">;
}

const toWire = (snap: ScreenSnapshot): DeviceSnapshotWire | undefined => {
    const r = DeviceSnapshotWire.safeParse(snap);
    return r.success ? r.data : undefined;
};

const NOT_SENT = "The agent could not send that screen.";

/**
 * The answer to one raw command from the platform. Never throws for a refused command (that is an answer); a DeviceSessionError from the session is the
 * phone or the link failing and passes through so the task can end.
 */
export async function answerDeviceCommand(session: Pick<DeviceSession, "snapshot" | "act">, raw: unknown): Promise<DeviceResultWire | undefined> {
    const id = (raw as { id?: unknown } | null)?.id;
    const safeId = typeof id === "string" && id.length >= 1 && id.length <= 40 ? id : undefined;
    const cmd = DeviceCommand.safeParse(raw);
    if (!cmd.success) return safeId ? { id: safeId, ok: false, error: "The agent refused that command: it is not one the phone accepts." } : undefined;
    if (cmd.data.type === "snapshot") {
        const snap = await session.snapshot({ screenshot: cmd.data.screenshot });
        const wire = toWire(snap);
        return wire ? { id: cmd.data.id, ok: true, snapshot: wire } : { id: cmd.data.id, ok: false, error: NOT_SENT };
    }
    const res = await session.act(cmd.data.action, { screenshot: cmd.data.screenshot === true });
    const wire = res.snapshot ? toWire(res.snapshot) : undefined;
    if (res.snapshot && !wire) return { id: cmd.data.id, ok: false, error: NOT_SENT };
    return { id: cmd.data.id, ok: res.ok, ...(res.error ? { error: res.error.slice(0, 400) } : {}), ...(wire ? { snapshot: wire } : {}) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DeviceTask {
    private readonly abort = new AbortController();
    private stopReason?: string;
    private session?: DeviceSession;
    private chain: Promise<unknown> = Promise.resolve();
    private readonly seen = new Set<string>();
    private pendingResults: DeviceResultWire[] = [];
    private notes: string[] = [];
    private status: "starting" | "ready" | "ended" | "failed" = "starting";
    private deviceName: string | undefined;
    private fatal: string | undefined;
    private dirty = true;
    private pushing = false;
    private platformGone = false;
    private lastGoodContact = Date.now();
    /** The platform said the session is over (a normal end, not a failure). */
    private platformEnded = false;
    private done: () => void = () => undefined;
    /** Resolves when something ends the session: a stop, the platform, a failure of the phone. */
    private readonly ended = new Promise<void>((resolve) => (this.done = resolve));

    constructor(
        private readonly task: TaskOffer,
        private readonly deps: DeviceTaskDeps,
    ) {}

    /** The agent is stopping, or something asked this task to end: the session is closed (and an emulator this task started is stopped) and the result says why. */
    cancel(reason: string): void {
        if (this.stopReason) return;
        this.stopReason = reason;
        this.abort.abort();
        this.done();
    }

    /** The phone or the link failed: the session ends, and the platform is told why. */
    private failWith(message: string): void {
        this.fatal ??= message;
        this.abort.abort();
        this.done();
    }

    private note(line: string): void {
        this.notes = [...this.notes, line.slice(0, 300)].slice(-20);
        this.dirty = true;
    }

    async run(): Promise<void> {
        const { client, log, deps } = { client: this.deps.client, log: this.deps.log, deps: this.deps };
        const short = this.task.taskId.slice(0, 12);
        const fail = (error: string) => deps.postResult({ ok: false, error, runs: [] });
        const parsed = DeviceTaskSchema.safeParse(this.task.device);
        if (!parsed.success) return fail("The phone session task has no usable settings.");
        const dev = parsed.data;
        const forget = log.addSecrets([dev.credentials?.password]);
        const pinned: string[] = [];

        const beatMs = Math.min(deps.beatMs ?? BEAT_MS, BEAT_MS);
        const silenceMs = deps.silenceMs ?? DEVICE_PLATFORM_SILENCE_MS;
        let beating = false;
        const beat = setInterval(() => {
            if (beating) return;
            beating = true;
            void this.beat(short, silenceMs).finally(() => void (beating = false));
        }, beatMs);
        const pump = setInterval(() => {
            if (this.dirty && !this.pushing && !this.platformGone) void this.push(short);
        }, 100);
        // A session that outlives its limit (a hung phone) is ended by force a little after the limit the platform set.
        const watchdog = setTimeout(() => this.cancel("The phone session reached its time limit."), dev.totalMinutes * 60_000 + 60_000);
        let apkPath: string | undefined;
        try {
            this.note("Preparing the phone");
            // No adb on this computer yet: the runner gets Google's phone tools first (they land in its own folder), each step a note the person sees.
            if (deps.phoneTools && !adbPath(deps.env)) {
                const got = await deps.phoneTools.ensure((line) => this.note(line), this.abort.signal);
                if (!got.ok) throw new DeviceSessionError(got.reason);
            }
            if (dev.apk) {
                const ref = dev.apk;
                this.note("Downloading the app file");
                apkPath = await deps.cache.get(ref, (dest) => client.download(this.task.taskId, ref, dest, this.abort.signal), ".apk");
                pinned.push(apkPath);
            }
            const open = deps.open ?? openLocalDeviceSession;
            this.session = await open({
                appPackage: dev.appPackage,
                ...(apkPath ? { apkPath } : {}),
                ...(dev.avd ? { avd: dev.avd } : {}),
                ...(dev.deviceSerial ? { serial: dev.deviceSerial } : {}),
                ...(dev.credentials ? { credentials: dev.credentials } : {}),
                // A person's own computer: the plugged-in phone only when its owner allowed it, and what this session installed on it is removed after.
                ...(dev.emulatorOnly ? { emulatorOnly: true } : {}),
                ...(dev.realPhone === false ? { noRealPhone: true } : {}),
                ...(dev.removeInstalledApp ? { removeInstalledApp: true } : {}),
                maxActions: dev.maxActions,
                maxMinutes: dev.totalMinutes,
                signal: this.abort.signal,
                env: deps.env,
                log: (line) => this.note(line),
            });
            this.deviceName = this.session.deviceName.slice(0, 80);
            this.status = "ready";
            this.note(`Opened ${dev.appPackage}`);
            this.dirty = true;
            log.info(`Phone session ${short} ready: ${this.deviceName}.`);
            // Commands are answered by the beat; the session stays open until something ends it.
            await this.ended;
        } catch (e) {
            if (!this.abort.signal.aborted) this.failWith(e instanceof DeviceSessionError ? e.message : e instanceof PlatformError ? "The app file could not be fetched from the platform." : "The agent could not open the phone.");
        }

        // End: everything this task started is stopped before the result is posted.
        clearInterval(beat);
        clearInterval(pump);
        clearTimeout(watchdog);
        this.abort.abort();
        await this.chain.catch(() => undefined);
        try {
            await this.session?.close();
        } catch {
            /* the session has already tried by serial and by process */
        }
        this.status = this.fatal ? "failed" : "ended";
        this.dirty = true;
        while (this.pushing) await sleep(25);
        // The last state is always sent: the platform may be waiting for the answer to the command that was running.
        if (!this.platformGone) for (let i = 0; i < 4 && this.dirty && !this.platformGone; i++) {
            await this.push(short, true);
            if (this.dirty) await sleep(300 * (i + 1));
        }
        if (apkPath) deps.cache.release(pinned);
        forget();
        const reason = this.fatal ?? this.stopReason;
        await deps.postResult(reason ? { ok: false, error: log.redact(reason).slice(0, 500), runs: [] } : { ok: true, runs: [] });
        log.info(`Phone session ${short} finished.`);
    }

    /** One heartbeat: it keeps the lease, brings the explorer's commands, and says whether to give up. */
    private async beat(short: string, silenceMs: number): Promise<void> {
        try {
            const res = await this.deps.client.heartbeat(this.task.taskId, {});
            this.lastGoodContact = Date.now();
            if (res.cancel && !this.stopReason && !this.platformEnded) {
                this.deps.log.info(`Phone session ${short}: the platform ended this session.`);
                this.platformEnded = true;
                this.abort.abort();
                this.done();
                return;
            }
            for (const raw of res.deviceCommands ?? []) {
                const id = (raw as { id?: string }).id;
                // The platform repeats a command until it has the answer: each is run once.
                if (typeof id !== "string" || this.seen.has(id)) continue;
                this.seen.add(id);
                if (this.status !== "ready" || !this.session) {
                    this.pendingResults.push({ id, ok: false, error: "The phone is not open yet." });
                    this.dirty = true;
                    continue;
                }
                const session = this.session;
                this.chain = this.chain.then(async () => {
                    if (this.abort.signal.aborted || this.fatal) return;
                    try {
                        const answer = await answerDeviceCommand(session, raw);
                        if (answer) this.pendingResults.push(answer);
                    } catch (e) {
                        // The phone or the link failed: the session ends, and the platform is told why in the same breath.
                        const message = e instanceof DeviceSessionError ? e.message : "The agent could not use the phone.";
                        this.pendingResults.push({ id, ok: false, error: message.slice(0, 400) });
                        this.failWith(message);
                    }
                    this.dirty = true;
                });
            }
        } catch (e) {
            if (e instanceof PlatformError && (e.status === 404 || e.status === 409 || e.status === 410)) {
                this.platformGone = true;
                this.deps.log.warn(`Phone session ${short}: the platform no longer has this session.`);
                this.cancel("The platform ended this session.");
            } else if (Date.now() - this.lastGoodContact > silenceMs && !this.stopReason) {
                this.deps.log.warn(`Phone session ${short}: the platform has not answered for a while, so the session was ended.`);
                this.cancel("The platform stopped answering, so the phone session was ended.");
            }
        }
    }

    private async push(short: string, final = false): Promise<void> {
        if (this.pushing) return;
        this.pushing = true;
        const sent = this.pendingResults.slice(0, 5);
        this.dirty = this.pendingResults.length > sent.length;
        const body: DevicePush = {
            status: this.status,
            ...(this.deviceName ? { deviceName: this.deviceName } : {}),
            ...(this.notes.length ? { notes: this.notes } : {}),
            ...(this.fatal ? { error: this.fatal.slice(0, 500) } : {}),
            ...(sent.length ? { results: sent } : {}),
        };
        const checked = DevicePush.safeParse(body);
        try {
            // An answer that does not fit the wire is replaced by a plain refusal, so the platform never waits for it.
            const out = checked.success ? checked.data : DevicePush.parse({ status: this.status, ...(this.fatal ? { error: this.fatal.slice(0, 500) } : {}), results: sent.map((r) => ({ id: r.id, ok: false, error: NOT_SENT })) });
            await this.deps.client.pushDevice(this.task.taskId, out);
            this.pendingResults = this.pendingResults.filter((r) => !sent.includes(r));
            this.lastGoodContact = Date.now();
        } catch (e) {
            this.dirty = true;
            if (e instanceof PlatformError && (e.status === 404 || e.status === 409 || e.status === 410)) {
                this.platformGone = true;
                this.dirty = false;
                this.deps.log.warn(`Phone session ${short}: the platform no longer takes this session's updates.`);
                this.cancel("The platform ended this session.");
            } else if (!final) {
                this.deps.log.warn(`Phone session ${short}: the platform did not take an update (${e instanceof Error ? e.message : "unknown problem"}). It is tried again.`);
            }
        } finally {
            this.pushing = false;
        }
    }
}
