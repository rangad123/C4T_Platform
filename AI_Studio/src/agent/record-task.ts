/**
 * A record task, from the agent's side: open the browser on THIS computer (in its own process), keep the platform up to date with what was recorded,
 * apply the commands the web page sends in the heartbeat replies, and end it cleanly.
 *
 *  - state goes out as soon as it changes, at most once a second (a quarter of a second when a command was just applied or the status changed), and the
 *    final state is never dropped;
 *  - the heartbeat is every second while recording (the protocol's interval is a maximum), carries the commands and the cancel flag;
 *  - the session ends on a stop or discard command, a cancel, the agent being stopped, a closed window, a time limit, or a lost platform; whatever the reason,
 *    the browser this task started is closed and checked to be gone, and a normal result is posted;
 *  - nothing the person typed is logged, and the token never leaves the agent process.
 */
import { LiveResultWire, RecordingPush, RecStepWire, type RecordingPush as RecordingPushT, type ResultRequest, type TaskOffer } from "../agent-protocol/schema.js";
import { clip } from "../engine/recorder/model.js";
import { DEFAULT_CAPS, pidAlive, type RecState } from "../engine/recorder/session.js";
import type { RecordFromChild } from "./child-protocol.js";
import type { BrowserLaunch } from "../engine/browsers/choice.js";
import { PlatformError, type PlatformClient } from "./client.js";
import type { Logger } from "./log.js";
import { RecordProcess } from "./record-process.js";

/** Without a good answer from the platform for this long, the recording ends (a browser must not stay open on someone's desktop for nothing). */
export const PLATFORM_SILENCE_MS = 90_000;
const BEAT_MS = 1000;
const PUSH_MS = 1000;
const URGENT_PUSH_MS = 250;
/** After a stop is requested, how long the process gets to close the browser itself before it is killed. */
const STOP_GRACE_MS = 6000;

export interface RecordTaskDeps {
    client: PlatformClient;
    log: Logger;
    env: NodeJS.ProcessEnv;
    /** The agent's retrying poster of the normal result. */
    postResult(body: ResultRequest): Promise<void>;
    /** Tells the runner which process belongs to the task (diagnostics: the agent's status line). */
    setPid(pid: number | undefined): void;
    /** Tests: shorter intervals. */
    beatMs?: number;
    silenceMs?: number;
    /** The installed Chrome or Edge to record in (the runner's browser setting). Absent: Playwright's own Chromium. */
    browser?: BrowserLaunch;
}

/** What a push carries: the state, made to fit the wire (a step that does not fit is left out and the person is told). */
export function toPush(state: RecState, acked: string[], results: LiveResultWire[] = []): RecordingPushT {
    const steps = [];
    let skipped = 0;
    for (const s of state.steps) {
        const ok = RecStepWire.safeParse(s);
        if (ok.success) steps.push(ok.data);
        else skipped++;
    }
    const notes = state.notes.map((n) => clip(n, 300)).slice(0, 20);
    if (skipped > 0 && notes.length < 20) notes.push(`${skipped} step${skipped === 1 ? "" : "s"} could not be sent to the platform and ${skipped === 1 ? "was" : "were"} left out.`);
    const body: RecordingPushT = {
        status: state.status,
        ...(state.currentUrl ? { currentUrl: clip(state.currentUrl, 2000) } : {}),
        steps: steps.slice(0, 1000),
        inspect: { on: state.inspect.on, mode: state.inspect.mode, ...(state.inspect.assertCheck ? { check: state.inspect.assertCheck } : {}) },
        ...(state.picked ? { picked: { ...state.picked, ...(state.picked.text !== undefined ? { text: clip(state.picked.text, 200) } : {}) } } : {}),
        notes,
        ...(state.error ? { error: clip(state.error, 500) } : {}),
        acked: acked.slice(0, 40),
        // An answer that does not fit the wire (a picture too large) is replaced by a plain refusal, so the platform never waits for it.
        ...(results.length ? { results: results.slice(0, 5).map((r) => (LiveResultWire.safeParse(r).success ? r : { id: r.id, ok: false, status: 422, error: "The agent could not send that page." })) } : {}),
    };
    const checked = RecordingPush.safeParse(body);
    if (checked.success) return checked.data;
    // The picked element is the one thing that may not fit; the steps matter more.
    const { picked: _picked, results: _results, ...rest } = body;
    const again = RecordingPush.safeParse(rest);
    return again.success ? again.data : { status: state.status, steps: [], acked: acked.slice(0, 40) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RecordTask {
    private proc?: RecordProcess;
    private stopReason?: string;
    private stopping = false;
    private killTimer?: NodeJS.Timeout;

    private latest?: RecState;
    private browserPid?: number;
    private readonly pendingAcked = new Set<string>();
    /** Answers to act and snapshot commands, until a push has carried them. */
    private pendingResults: LiveResultWire[] = [];
    private dirty = false;
    private urgent = false;
    private pushing = false;
    private lastPushAt = 0;
    private platformGone = false;
    private lastGoodContact = Date.now();
    private readonly seen = new Set<string>();
    private warnedPush = false;

    constructor(
        private readonly task: TaskOffer,
        private readonly deps: RecordTaskDeps,
    ) {}

    /** The agent is stopping, or something asked this task to end: the session is stopped (the browser closed) and the result says why. */
    cancel(reason: string): void {
        if (this.stopReason) return;
        this.stopReason = reason;
        this.requestStop();
    }

    private requestStop(): void {
        if (this.stopping) return;
        this.stopping = true;
        const p = this.proc;
        if (!p) return;
        p.send({ type: "stop" });
        // The process closes its browser itself and exits; if it does not do that in time, the whole tree is killed.
        this.killTimer = setTimeout(() => p.kill(), STOP_GRACE_MS);
    }

    async run(): Promise<void> {
        const { client, log, deps } = { client: this.deps.client, log: this.deps.log, deps: this.deps };
        const rec = this.task.record;
        const short = this.task.taskId.slice(0, 12);
        const fail = (error: string) => deps.postResult({ ok: false, error, runs: [] });
        if (!rec) return fail("The recording task has no settings.");
        try {
            const u = new URL(rec.startUrl);
            if (!/^https?:$/.test(u.protocol)) return fail("Only http and https pages can be recorded.");
            if (u.username || u.password) return fail("The address must not contain a user name or password.");
        } catch {
            return fail("The recording address is not valid.");
        }
        // The platform's limits, never longer than this agent's own.
        const idleMs = Math.min(rec.idleMinutes * 60_000, DEFAULT_CAPS.idleMs);
        const totalMs = Math.min(rec.totalMinutes * 60_000, DEFAULT_CAPS.totalMs);
        const maxSteps = Math.min(rec.maxSteps, DEFAULT_CAPS.maxSteps);

        let proc: RecordProcess;
        try {
            proc = new RecordProcess(deps.env, (m) => this.onChild(m, short));
        } catch (e) {
            log.warn(`Recording ${short} could not be started: ${e instanceof Error ? e.message.split("\n")[0] : "unknown problem"}`);
            return fail("The agent could not start the recording process.");
        }
        this.proc = proc;
        deps.setPid(proc.pid);
        if (this.stopping) proc.send({ type: "stop" });
        proc.send({ type: "record", startUrl: rec.startUrl, headed: rec.headed, idleMs, totalMs, maxSteps, ...(deps.browser && (deps.browser.channel || deps.browser.executablePath) ? { browser: deps.browser } : {}) });
        log.info(`Recording ${short} started: the browser window is ${rec.headed ? "shown on this computer" : "not shown (headless)"}.`);

        const beatMs = Math.min(deps.beatMs ?? BEAT_MS, BEAT_MS);
        const silenceMs = deps.silenceMs ?? PLATFORM_SILENCE_MS;
        let beating = false;
        const beat = setInterval(() => {
            if (beating || proc.hasExited) return;
            beating = true;
            void this.beat(client, silenceMs, short).finally(() => void (beating = false));
        }, beatMs);
        const pump = setInterval(() => {
            if (!this.dirty || this.pushing || this.platformGone) return;
            if (Date.now() - this.lastPushAt < (this.urgent ? URGENT_PUSH_MS : PUSH_MS)) return;
            void this.push(false, short);
        }, 100);
        // A recording that outlives its limit (a hung page) is ended by force a little after the limit the platform set.
        const watchdog = setTimeout(() => this.requestStop(), totalMs + 120_000);

        const exit = await proc.exit;
        clearInterval(beat);
        clearInterval(pump);
        clearTimeout(watchdog);
        clearTimeout(this.killTimer);
        // Nothing the recording process started is left: its tree is ended (a no-op when it exited by itself).
        if (!proc.hasExited) proc.kill();
        while (this.pushing) await sleep(25);

        // The last state is always sent: the steps are the person's work.
        let finalState = this.latest;
        const ended = finalState && (finalState.status === "stopped" || finalState.status === "failed");
        if (!ended) {
            const why = this.stopReason ? undefined : "The recording browser stopped unexpectedly. The steps recorded so far are kept.";
            const base: RecState = finalState ?? { status: "starting", startUrl: rec.startUrl, headed: rec.headed, steps: [], inspect: { on: false, mode: "locator" }, startedAt: new Date().toISOString(), notes: [] };
            finalState = { ...base, status: base.steps.some((s) => s.kind !== "goto") || base.status === "recording" ? "stopped" : "failed", ...(why ? { error: why } : {}), stoppedAt: new Date().toISOString() };
            this.latest = finalState;
            if (!this.stopReason) log.warn(`Recording ${short}: the recording process ended unexpectedly (${exit.signal ?? `exit code ${exit.code}`}).`);
        }
        if (!this.platformGone) {
            this.dirty = true;
            for (let i = 0; i < 4 && this.dirty && !this.platformGone; i++) {
                await this.push(true, short);
                if (this.dirty) await sleep(300 * (i + 1));
            }
        }

        await this.verifyBrowserGone(short);
        await deps.postResult(this.stopReason ? { ok: false, error: clip(this.stopReason, 500), runs: [] } : { ok: true, runs: [] });
        deps.setPid(undefined);
        log.info(`Recording ${short} finished: ${this.latest?.steps.length ?? 0} step${(this.latest?.steps.length ?? 0) === 1 ? "" : "s"} kept.`);
    }

    private onChild(m: RecordFromChild, short: string): void {
        if (m.type === "log") return void this.deps.log.warn(`Recording ${short}: ${m.line}`);
        if (m.type === "result") {
            this.pendingResults.push(m.result);
            this.dirty = true;
            this.urgent = true;
            return;
        }
        const was = this.latest?.status;
        this.latest = m.state;
        if (m.pid && m.pid !== this.browserPid) {
            this.browserPid = m.pid;
            this.deps.log.info(`Recording ${short}: browser process ${m.pid}.`);
        }
        for (const id of m.acked) this.pendingAcked.add(id);
        this.dirty = true;
        if (m.acked.length > 0 || was !== m.state.status) this.urgent = true;
    }

    /** One heartbeat: it keeps the lease, brings the page's commands, and says whether to give up. */
    private async beat(client: PlatformClient, silenceMs: number, short: string): Promise<void> {
        try {
            const res = await client.heartbeat(this.task.taskId, {});
            this.lastGoodContact = Date.now();
            for (const c of res.commands ?? []) {
                // The platform repeats a command until it has seen it confirmed: each is applied once.
                if (this.seen.has(c.id)) continue;
                this.seen.add(c.id);
                this.proc?.send({ type: "command", command: c });
            }
            if (res.cancel && !this.stopping) {
                this.deps.log.info(`Recording ${short}: the platform ended this recording.`);
                this.requestStop();
            }
        } catch (e) {
            if (e instanceof PlatformError && (e.status === 404 || e.status === 409 || e.status === 410)) {
                this.platformGone = true;
                this.deps.log.warn(`Recording ${short}: the platform no longer has this recording.`);
                this.requestStop();
            } else if (Date.now() - this.lastGoodContact > silenceMs && !this.stopping) {
                this.deps.log.warn(`Recording ${short}: the platform has not answered for a while, so the recording was ended.`);
                this.requestStop();
            }
        }
    }

    private async push(final: boolean, short: string): Promise<void> {
        const state = this.latest;
        if (!state || this.pushing) return;
        this.pushing = true;
        const sent = [...this.pendingAcked];
        const sentResults = this.pendingResults.slice(0, 5);
        this.dirty = this.pendingResults.length > sentResults.length;
        this.urgent = this.dirty;
        this.lastPushAt = Date.now();
        try {
            await this.deps.client.pushRecording(this.task.taskId, toPush(state, sent, sentResults));
            for (const id of sent) this.pendingAcked.delete(id);
            this.pendingResults = this.pendingResults.filter((r) => !sentResults.includes(r));
            this.lastGoodContact = Date.now();
            this.warnedPush = false;
        } catch (e) {
            this.dirty = true;
            if (e instanceof PlatformError && (e.status === 404 || e.status === 409 || e.status === 410)) {
                // The platform no longer wants this recording (it ended there, or it was restarted): end the browser, do not keep trying.
                this.platformGone = true;
                this.dirty = false;
                this.deps.log.warn(`Recording ${short}: the platform no longer takes this recording's updates.`);
                this.requestStop();
            } else if (!this.warnedPush && !final) {
                this.warnedPush = true;
                this.deps.log.warn(`Recording ${short}: the platform did not take an update (${e instanceof Error ? e.message : "unknown problem"}). It is tried again.`);
            }
        } finally {
            this.pushing = false;
        }
    }

    /** The browser this task started must be gone: it is checked by the process id the recorder reported, and ended if it is not. */
    private async verifyBrowserGone(short: string): Promise<void> {
        const pid = this.browserPid;
        if (!pid) return;
        for (let i = 0; i < 30 && pidAlive(pid); i++) {
            if (i === 10) {
                try {
                    process.kill(pid);
                } catch {
                    /* gone */
                }
            }
            await sleep(100);
        }
        if (pidAlive(pid)) this.deps.log.warn(`Recording ${short}: the browser process ${pid} could not be ended. Close its window by hand.`);
    }
}
