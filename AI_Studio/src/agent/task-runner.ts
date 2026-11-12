/**
 * Runs one task from start to finish and reports it. `TaskRunner.run` never throws: whatever goes wrong becomes a result
 * with ok=false and a plain sentence (an infrastructure problem), never an invented failing test.
 *
 *   1. check the adapter and the scripts, make a scratch folder for this task
 *   2. download baselines and the APK into the content-addressed cache (verified by sha256)
 *   3. run the scripts in their own process with the platform's own adapter code (heartbeats keep the lease alive and carry cancel)
 *   4. if the task asks for it, remove the records the run created (cleanup.ts)
 *   5. upload every artifact the runs refer to, then post the result with the local paths replaced by the uploaded names
 *   6. delete the scratch folder
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { ResultRequest, type AgentPhase, type HelloResponse, type RejectRequest, type RunnerConfigPush, type TaskOffer, type WebBrowserUsed, type WireRun } from "../agent-protocol/schema.js";
import { enginesOf, type BrowserInUse, type BrowserLaunch, type BrowserSetup } from "./browser-setup.js";
import { withDeviceLock } from "../engine/mobile/emulator.js";
import { iosCapabilityProblem } from "../engine/mobile/ios-capability.js";
import { withSimulatorLock } from "../engine/mobile/ios-runner.js";
import { MobileTargetSchema, SIMULATOR_NAME } from "../engine/mobile/target.js";
import { scriptRefusal } from "../engine/desktop/policy.js";
import { desktopUnavailableReason } from "../engine/desktop/probe.js";
import type { LiveRunEvent, ScriptInput, ScriptRun } from "../engine/validation/runner.js";
import { sleep } from "./backoff.js";
import { BeatPacer } from "./beat-pacer.js";
import { hasDisplay, type CapabilityProbe } from "./capabilities.js";
import type { ChildRun, IosDescriptor, MobileDescriptor } from "./child-protocol.js";
import { PlatformError, type PlatformClient } from "./client.js";
import { DeviceTask } from "./device-task.js";
import type { PhoneToolsSetup } from "./phone-tools.js";
import { RecordTask } from "./record-task.js";
import { runAgentCleanup } from "./cleanup.js";
import { sha256OfFile, type FileCache } from "./file-cache.js";
import type { Logger } from "./log.js";
import { LiveEventSender, type LiveEventInput } from "./live-events.js";
import type { ResultOutbox } from "./outbox.js";
import { maskRun, planUploads, secretsOfEnv, toRunEnv, toWireRun, type UploadOutcome } from "./mapping.js";
import { scrubTraceFile, traceSecretsOfRun } from "../engine/evidence/trace-scrub.js";
import { resolveInside, sanitizeName } from "./names.js";
import { TaskProcess } from "./task-process.js";
import { lowDiskRefusal, overMemory, resourceLimits, watchMemory } from "./resources.js";
import { guardedEnv, proxyTestsConflict, refusesPrivateAddresses, runAddressRefusal, startAddressGuard } from "./address-guard.js";
import { checkScript, describeErrors } from "../engine/custom/guard.js";

const require = createRequire(import.meta.url);

/** Adapter id to the runtime it needs. Protocol 1: Playwright (web and API together), Taqwright (Android) and Windows UI Automation (desktop apps). */
const SUPPORTED: Record<string, "playwright" | "taqwright" | "windows" | "ios"> = { playwright: "playwright", "playwright-api": "playwright", taqwright: "taqwright", "windows-uia": "windows", "taqwright-ios": "ios" };

/** Extra time on top of the task's own limit before the agent kills the process tree itself. */
const WATCHDOG_GRACE_MS = 90_000;

/** How a run says its trace was held back (it could not be cleaned of the run's secrets). */
const TRACE_HELD_BACK = "The trace was not sent because it could not be cleaned of the run's passwords and tokens";
const UPLOAD_ATTEMPTS = 3;
const RESULT_ATTEMPTS = 6;

/** Errors that mean the machine, not the test, is the problem. */
const NO_BROWSER = /Executable doesn't exist|npx playwright install|Looks like Playwright (Test|Library) was just installed/i;
const NO_REPORT = /produced no report|could not be started|No Android device is set up|No iOS simulator|iOS simulator tool|simulator tool|did not finish starting|iOS tests can only run|iOS session could not be started/i;

export interface TaskRunnerDeps {
    client: PlatformClient;
    cache: FileCache;
    log: Logger;
    workDir: string;
    hello: HelloResponse;
    probe: CapabilityProbe;
    /** The agent's own environment (what the runner may inherit is filtered in task-process.ts). */
    env: NodeJS.ProcessEnv;
    /** Applications Windows desktop tests may start on this computer (--allow-app). The platform and the task can never add to it. */
    allowApps?: readonly string[];
    /** --allow-custom-scripts: this computer's owner agreed to run hand-written scripts. Without it a script marked custom is refused. */
    allowCustomScripts?: boolean;
    /** The runner's browser choice (browser-setup.ts). Absent: Playwright's own Chromium, and Firefox/WebKit only if already installed (as before). */
    browsers?: BrowserSetup;
    /** The runner's own Android phone tools (phone-tools.ts): fetched when a phone task arrives and this computer has no adb. */
    phoneTools?: PhoneToolsSetup;
    /** Heartbeat period override (tests); default is what the platform announced. */
    heartbeatMs?: number;
    deleteTimeoutMs?: number;
    /** Results are kept here until the platform answers (outbox.ts). Absent (tests of older shape): posted with a few retries, as before. */
    outbox?: ResultOutbox;
    /** Protocol 2: the platform retired this runner while it worked (heartbeat `shutdown`): finish, take nothing new, exit. */
    onShutdown?(): void;
    /** Live events: largest batch and longest wait (tests); default 50 events, 1 s. */
    liveBatch?: { maxBatch?: number; maxDelayMs?: number };
    /** Protocol 2: the runner's switches changed (heartbeat `config`); the agent applies them with its own rules. Absent: applyConfig as they are. */
    onConfig?(c: RunnerConfigPush): void;
}

/** Why this computer will not take a task, before anything is downloaded or started (protocol 2: a reject; protocol 1: ok=false). */
interface Refusal {
    reason: RejectRequest["reason"];
    message: string;
    /** Too little free disk space: protocol 1 is answered at once too. */
    lowDisk?: true;
}

export interface ActiveTask {
    taskId: string;
    pid?: number;
    adapterId: string;
    /** Stop this task and post "ok: false" with the given reason. */
    cancel(reason: string): void;
    /** Stop this task without posting anything: the platform handed it out again (a script task only). */
    supersede?(): void;
}

class TaskStopped extends Error {}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

/** The promise's answer, or nothing after `ms`; the timer never outlives the call. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | void> {
    const stop = new AbortController();
    try {
        return await Promise.race([p, sleep(ms, stop.signal)]);
    } finally {
        stop.abort();
    }
}

export class TaskRunner {
    readonly active = new Map<string, ActiveTask>();
    /** Highest number of tasks that were running at the same time (a fact the tests and the status line use). */
    peak = 0;

    constructor(private deps: TaskRunnerDeps) {
        this.ownCustomScripts = deps.allowCustomScripts;
    }

    /** A new hello after a reconnect can change the limits (file size, heartbeat period). */
    setHello(hello: HelloResponse): void {
        this.deps = { ...this.deps, hello, allowCustomScripts: this.ownCustomScripts };
        // A new hello says the switches afresh (hello `runner`): what an older heartbeat said no longer counts.
        delete this.switches.customScripts;
        delete this.switches.privateTargets;
    }

    /** --allow-custom-scripts as this computer was started (the switches from the platform are applied on top of it). */
    private readonly ownCustomScripts: boolean | undefined;

    cancelAll(reason: string): void {
        for (const t of this.active.values()) t.cancel(reason);
    }

    /** The runner's switches as the platform last said them (heartbeat `config`, protocol 2): they apply to the next task. */
    readonly switches: { customScripts?: boolean; privateTargets?: boolean } = {};

    applyConfig(c: RunnerConfigPush): void {
        if (c.customScripts !== undefined && this.switches.customScripts !== c.customScripts) {
            this.switches.customScripts = c.customScripts;
            this.deps = { ...this.deps, allowCustomScripts: c.customScripts };
            this.deps.log.info(`The runner's owner ${c.customScripts ? "allowed" : "switched off"} code scripts on this computer; it applies to the next task.`);
        }
        if (c.privateTargets !== undefined && this.switches.privateTargets !== c.privateTargets) {
            this.switches.privateTargets = c.privateTargets;
            this.deps.log.info(`The runner's owner ${c.privateTargets ? "allowed" : "switched off"} private and local addresses on this computer; it applies to the next task.`);
        }
    }

    /** Does this runner refuse private and local addresses now (the platform's switch, or BLOCK_PRIVATE_TARGETS=true here)? See address-guard.ts. */
    private refusesPrivate(): boolean {
        return refusesPrivateAddresses(this.deps.hello, this.switches, this.deps.env);
    }

    /** Protocol 2 is spoken with the platform and this offer is a protocol-2 attempt. */
    private v2(task: TaskOffer): task is TaskOffer & { attemptId: string } {
        return this.deps.hello.protocol >= 2 && typeof task.attemptId === "string";
    }

    /**
     * Can this computer take the task at all? Decided before anything is downloaded, so a protocol-2 platform can offer it to another runner:
     * a runtime it does not have, code scripts its owner did not allow, a visible browser window where there is no display.
     */
    private async refusalOf(task: TaskOffer): Promise<Refusal | undefined> {
        if (task.kind === "record" || task.kind === "device") return undefined;
        const runtime = SUPPORTED[task.adapterId];
        if (!runtime) return { reason: "unsupported", message: `This agent can't run ${task.adapterId} tasks yet.` };
        if (task.scripts.some((s) => s.custom) && this.deps.allowCustomScripts !== true) return { reason: "code-scripts-off", message: "This task has hand-written scripts, and code scripts are switched off for this runner, so it did not run them. Switch them on for your runner in Settings." };
        // Private and local addresses (address-guard.ts): the run's addresses are looked up on THIS computer's network, before anything is downloaded.
        if (runtime === "playwright" && this.refusesPrivate()) {
            const why = proxyTestsConflict(this.deps.env) ?? (await runAddressRefusal(task.env));
            if (why) return { reason: "private-target", message: why };
        }
        // Decision 8: a visible browser only where a person can see it. Without a display the run is refused with a sentence, not left to fail inside the browser.
        if (runtime === "playwright" && task.env.headless === false) {
            const caps = await this.deps.probe.get();
            if (!hasDisplay(caps.os === "win32" ? "win32" : caps.os === "darwin" ? "darwin" : "linux", this.deps.env, caps.windows?.interactive)) {
                return { reason: "no-display", message: "This run asks for a visible browser window, and this computer has no screen the runner can show it on (no signed-in desktop). Run it with the browser hidden, or start the runner from a signed-in session." };
            }
        }
        // A run writes screenshots, traces and videos: none is taken while the work folder's disk is nearly full (resources.ts).
        const disk = await lowDiskRefusal(this.deps.workDir, resourceLimits(this.deps.env).minFreeMb);
        if (disk) return { reason: "other", message: disk, lowDisk: true };
        return undefined;
    }

    /** Protocol 2: take the task (within the offer's acceptSeconds). False when the platform already took it back; network trouble carries on (a heartbeat accepts it too). */
    private async acceptTask(task: TaskOffer & { attemptId: string }, short: string): Promise<boolean> {
        const { client, log } = this.deps;
        for (let i = 1; i <= 3; i++) {
            try {
                await client.accept(task.taskId, task.attemptId);
                return true;
            } catch (e) {
                if (e instanceof PlatformError && e.kind !== "network") {
                    log.warn(`Task ${short}: the platform took the task back before it was accepted (${e.message})`);
                    return false;
                }
                await sleep(1000 * i);
            }
        }
        log.warn(`Task ${short}: the platform did not answer the accept; the run starts, and stops if the platform gave it to another runner.`);
        return true;
    }

    /** Protocol 2: turn the task down so the platform offers it to another runner. */
    private async rejectTask(task: TaskOffer & { attemptId: string }, r: Refusal, short: string): Promise<void> {
        const { client, log } = this.deps;
        for (let i = 1; i <= 3; i++) {
            try {
                await client.reject(task.taskId, { attemptId: task.attemptId, reason: r.reason, message: r.message.slice(0, 300) });
                log.info(`Task ${short} turned down: ${r.message}`);
                return;
            } catch (e) {
                if (e instanceof PlatformError && e.kind !== "network") return;
                await sleep(1000 * i);
            }
        }
        log.warn(`Task ${short}: the platform did not hear that this computer turned the task down; it offers it again after a short wait.`);
    }

    /** Each task's run on this computer, by task id, until it has ended (folder removed, result handed to the outbox). `n` tells runs apart. */
    private readonly runs = new Map<string, { n: number; done: Promise<void> }>();
    private runCount = 0;

    /**
     * Run a task. The platform hands a task out again when it stopped hearing from its run (the lease ran out); if that run is still going
     * here, it is stopped without a result and has ended before the new one starts, so the same task never runs twice at once on this computer.
     */
    async run(task: TaskOffer): Promise<void> {
        const before = this.runs.get(task.taskId)?.done;
        if (before) {
            this.deps.log.warn(`Task ${task.taskId.slice(0, 12)}: the platform handed this task out again while it was still running here; the earlier run is stopped first and sends no result.`);
            const old = this.active.get(task.taskId);
            if (old?.supersede) old.supersede();
            else old?.cancel("The platform handed this task out again.");
            await before.catch(() => undefined);
        }
        const n = ++this.runCount;
        const done = this.runOnce(task).finally(() => {
            if (this.runs.get(task.taskId)?.n === n) this.runs.delete(task.taskId);
        });
        this.runs.set(task.taskId, { n, done });
        await done;
    }

    private async runOnce(task: TaskOffer): Promise<void> {
        const short0 = task.taskId.slice(0, 12);
        // Protocol 2: the switches as the platform holds them now (one changed while this runner was idle), applied with the agent's own rules.
        if (task.config) (this.deps.onConfig ?? ((c: RunnerConfigPush) => this.applyConfig(c)))(task.config);
        // Protocol 2: a task this computer cannot take is turned down at once (another runner gets it); one it can take is accepted first.
        const refusal = await this.refusalOf(task);
        if (this.v2(task)) {
            if (refusal) return this.rejectTask(task, refusal, short0);
            if (!(await this.acceptTask(task, short0))) return;
        } else if (refusal?.reason === "no-display" || refusal?.reason === "private-target" || refusal?.lowDisk) {
            // Protocol 1 has no reject: the run ends with the same sentence (the other refusals are answered in execute(), as before).
            return this.postResult(task.taskId, { ok: false, error: refusal.message, runs: [] }, short0);
        }
        // A record task hosts a recording session instead of running scripts (see record-task.ts).
        if (task.kind === "record") return this.runRecord(task);
        // A device task opens the app under test on a phone or emulator of this computer and answers the explorer's commands (see device-task.ts).
        if (task.kind === "device") return this.runDevice(task);
        const { client, log, cache } = this.deps;
        const short = task.taskId.slice(0, 12);
        const forgetSecrets = log.addSecrets(secretsOfEnv(task.env));
        const v2 = this.v2(task);
        const attemptId = v2 ? task.attemptId : undefined;
        const abort = new AbortController();
        let stopReason: string | undefined;
        let lost = false;
        let proc: TaskProcess | undefined;
        const pendingLogs: string[] = [];
        let done = 0;
        const pinned: string[] = [];
        const dir = resolveInside(path.join(this.deps.workDir, "tasks"), sanitizeName(task.taskId, 64, "task"));

        const entry: ActiveTask = {
            taskId: task.taskId,
            adapterId: task.adapterId,
            cancel: (reason) => {
                if (stopReason) return;
                stopReason = reason;
                abort.abort();
                proc?.kill();
            },
            supersede: () => {
                lost = true;
                entry.cancel("The platform handed this task out again.");
            },
        };
        this.active.set(task.taskId, entry);
        this.peak = Math.max(this.peak, this.active.size);

        // Protocol 2: the run's live events (tests, steps, screenshots, lines, phases), batched and numbered (live-events.ts).
        let phase: AgentPhase = "preparing";
        const live = v2
            ? new LiveEventSender({
                  send: async (events) => {
                      await client.events(task.taskId, { attemptId: attemptId!, events });
                  },
                  redact: (t) => log.redact(t),
                  onGone: () => {
                      lost = true;
                      entry.cancel("The platform no longer expects a result for this task.");
                  },
                  ...(this.deps.liveBatch ?? {}),
              })
            : undefined;

        // Heartbeats: keep the lease, send progress and emulator messages, and learn about cancel.
        const beatStop = new AbortController();
        const heartbeatMs = this.deps.heartbeatMs ?? Math.max(1000, this.deps.hello.heartbeatSeconds * 1000);
        let beatFailures = 0;
        // Progress lines go out within about a second (never more often than once a second, never later than the platform's interval).
        const pacer = new BeatPacer(heartbeatMs);
        const heart = (async () => {
            while (!beatStop.signal.aborted) {
                const lines = pendingLogs.splice(0, 20);
                pacer.markBeat();
                try {
                    const res = await client.heartbeat(task.taskId, { done, total: task.scripts.length, ...(lines.length ? { log: lines.map((l) => log.redact(l).slice(0, 300)) } : {}), ...(attemptId ? { attemptId, phase } : {}) });
                    beatFailures = 0;
                    if (res.cancel) entry.cancel(res.timeout ? "The run took longer than the platform allows, so the platform stopped it." : "The run was cancelled.");
                    if (res.config) (this.deps.onConfig ?? ((c: RunnerConfigPush) => this.applyConfig(c)))(res.config);
                    if (res.shutdown) this.deps.onShutdown?.();
                } catch (e) {
                    pendingLogs.unshift(...lines); // not delivered: they go with the next beat
                    if (e instanceof PlatformError && (e.status === 404 || e.status === 409 || e.status === 410)) {
                        // The platform no longer has this task for us (finished, re-offered elsewhere, or the job was removed).
                        lost = true;
                        entry.cancel("The platform no longer expects a result for this task.");
                    } else if (++beatFailures === 3) {
                        log.warn(`Task ${short}: the platform has not answered the last heartbeats (${e instanceof Error ? e.message : "unknown problem"}). The run continues.`);
                    }
                }
                await pacer.wait(beatStop.signal, () => pendingLogs.length > 0);
            }
        })();

        let result: { ok: boolean; error?: string; runs: WireRun[]; browser?: WebBrowserUsed };
        try {
            log.info(`Task ${short} started: ${task.adapterId}, ${task.scripts.length} script${task.scripts.length === 1 ? "" : "s"}${task.projects?.length ? `, ${task.projects.length} variants` : ""}.`);
            live?.push({ type: "phase", phase });
            result = await this.execute(task, dir, { abort, isStopped: () => stopReason, setProc: (p) => (proc = p), pushLog: (l) => {
                    // Protocol 2: a line is a live event; protocol 1: it goes with the next heartbeat, as before.
                    if (live) return live.push({ type: "log", line: log.redact(l).slice(0, 300) }); // masked before it is cut: a cut secret is not found
                    pendingLogs.push(l);
                    if (pendingLogs.length > 400) pendingLogs.splice(0, pendingLogs.length - 400); // a flood keeps the newest
                    pacer.nudge();
                }, setDone: (n) => (done = n), pinned, entry, ...(live ? { live, attemptId: attemptId!, setPhase: (p: AgentPhase) => {
                    if (p === phase) return;
                    phase = p;
                    live.push({ type: "phase", phase: p });
                    pacer.nudge();
                } } : {}) });
        } catch (e) {
            if (e instanceof TaskStopped || stopReason) result = { ok: false, error: stopReason ?? "The run was stopped.", runs: [] };
            else {
                const why = e instanceof Error ? e.message : String(e);
                log.warn(`Task ${short} could not be run: ${why}`);
                result = { ok: false, error: `The agent could not run this task: ${why}`, runs: [] };
            }
        }
        // A task stopped during or after its run is reported as stopped, whatever finished first.
        if (stopReason) result = { ok: false, error: stopReason, runs: [] };

        beatStop.abort();
        // Lines still waiting (the last tests finishing, the uploads) go out now, before the result, so a viewer sees them in order.
        // Bounded: a platform that does not answer must not hold the result back.
        await within(heart.catch(() => undefined), 3000);
        for (let i = 0; i < 5 && pendingLogs.length > 0 && !lost && !stopReason; i++) {
            const lines = pendingLogs.splice(0, 20);
            try {
                await within(client.heartbeat(task.taskId, { done, total: task.scripts.length, log: lines.map((l) => log.redact(l).slice(0, 300)) }), 3000);
            } catch {
                break;
            }
        }
        // Protocol 2: the live events still waiting go before the result (bounded: a platform that does not answer must not hold it back).
        await live?.close(5000);
        if (!lost) await this.postResult(task.taskId, { ok: result.ok, ...(result.error ? { error: log.redact(result.error).slice(0, 500) } : {}), runs: result.runs, ...(result.ok && result.browser ? { browser: result.browser } : {}), ...(attemptId ? { attemptId } : {}) }, short);
        else log.warn(`Task ${short} was taken away by the platform; its result was not sent.`);

        this.active.delete(task.taskId);
        cache.release(pinned);
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
        forgetSecrets();
    }

    /** A record task: the browser opens on this computer, the platform is kept up to date, and a normal result ends it. Never throws. */
    private async runRecord(task: TaskOffer): Promise<void> {
        const { client, log } = this.deps;
        const short = task.taskId.slice(0, 12);
        // The recording opens in the browser this runner uses for web tests.
        let browser: BrowserLaunch | undefined;
        if (this.deps.browsers) {
            const w = await this.deps.browsers.forWeb();
            if (!w.ok) return this.postResult(task.taskId, { ok: false, error: w.error.slice(0, 500), runs: [] }, short);
            browser = w.browser.launch;
        }
        const entry: ActiveTask = { taskId: task.taskId, adapterId: task.adapterId, cancel: (reason) => rec.cancel(reason) };
        const rec = new RecordTask(task, {
            client,
            log,
            env: this.deps.env,
            ...(browser ? { browser } : {}),
            ...(this.refusesPrivate() ? { refusePrivate: true } : {}),
            postResult: (body) => this.postResult(task.taskId, body, short),
            setPid: (pid) => void (entry.pid = pid),
            ...(this.deps.heartbeatMs ? { beatMs: this.deps.heartbeatMs } : {}),
        });
        this.active.set(task.taskId, entry);
        this.peak = Math.max(this.peak, this.active.size);
        try {
            await rec.run();
        } catch (e) {
            log.warn(`Recording ${short} failed unexpectedly: ${e instanceof Error ? e.message.split("\n")[0] : "unknown problem"}`);
            await this.postResult(task.taskId, { ok: false, error: "The agent could not run this recording.", runs: [] }, short);
        } finally {
            this.active.delete(task.taskId);
        }
    }

    /** A device task: the phone is opened on this computer, the explorer's commands are answered, and a normal result ends it. Never throws. */
    private async runDevice(task: TaskOffer): Promise<void> {
        const { client, log } = this.deps;
        const short = task.taskId.slice(0, 12);
        const entry: ActiveTask = { taskId: task.taskId, adapterId: task.adapterId, cancel: (reason) => dev.cancel(reason) };
        const dev = new DeviceTask(task, {
            client,
            log,
            env: this.deps.env,
            cache: this.deps.cache,
            ...(this.deps.phoneTools ? { phoneTools: this.deps.phoneTools } : {}),
            postResult: (body) => this.postResult(task.taskId, body, short),
            ...(this.deps.heartbeatMs ? { beatMs: this.deps.heartbeatMs } : {}),
        });
        this.active.set(task.taskId, entry);
        this.peak = Math.max(this.peak, this.active.size);
        try {
            await dev.run();
        } catch (e) {
            log.warn(`Phone session ${short} failed unexpectedly: ${e instanceof Error ? e.message.split("\n")[0] : "unknown problem"}`);
            await this.postResult(task.taskId, { ok: false, error: "The agent could not run this phone session.", runs: [] }, short);
        } finally {
            this.active.delete(task.taskId);
        }
    }

    private async execute(
        task: TaskOffer,
        dir: string | undefined,
        ctl: {
            abort: AbortController;
            isStopped(): string | undefined;
            setProc(p: TaskProcess): void;
            pushLog(line: string): void;
            setDone(n: number): void;
            pinned: string[];
            entry: ActiveTask;
            /** Protocol 2 only. */
            live?: LiveEventSender;
            attemptId?: string;
            setPhase?(p: AgentPhase): void;
        },
    ): Promise<{ ok: boolean; error?: string; runs: WireRun[]; browser?: WebBrowserUsed }> {
        const { client, cache, log, hello } = this.deps;
        const short = task.taskId.slice(0, 12);
        const fail = (error: string) => ({ ok: false, error, runs: [] as WireRun[] });

        const runtime = SUPPORTED[task.adapterId];
        if (!runtime) return fail(`This agent can't run ${task.adapterId} tasks yet.`);
        if (!dir) return fail("The task has an id the agent cannot use as a folder name.");
        const names = new Set<string>();
        for (const s of task.scripts) {
            if (names.has(s.filename.toLowerCase())) return fail(`Two scripts in this task share the file name ${s.filename}.`);
            names.add(s.filename.toLowerCase());
        }

        await fs.mkdir(dir, { recursive: true });
        const stopCheck = () => {
            if (ctl.isStopped()) throw new TaskStopped();
        };

        // 2. files
        const download = (ref: { ref: string; size: number; sha256: string }) => (destination: string) => client.download(task.taskId, ref, destination, ctl.abort.signal);
        let files = 0;
        const scripts: ScriptInput[] = [];
        // What a person watching the run sees, in plain words (these travel with the next heartbeat and become events on the platform).
        const wanted = task.scripts.reduce((n, sc) => n + (sc.baselines?.length ?? 0), 0);
        if (wanted > 0) ctl.pushLog(`Downloading ${wanted} baseline image${wanted === 1 ? "" : "s"}`);
        if (runtime === "taqwright" && task.mobile?.apk) ctl.pushLog("Downloading the app file");
        for (const s of task.scripts) {
            const baselines: NonNullable<ScriptInput["baselines"]> = [];
            for (const b of s.baselines ?? []) {
                stopCheck();
                const p = await cache.get(b.file, download(b.file), path.extname(b.name));
                ctl.pinned.push(p);
                baselines.push({ name: b.name, path: p });
                files++;
            }
            scripts.push({ testId: s.testId, filename: s.filename, content: s.content, ...(baselines.length ? { baselines } : {}), ...(s.custom ? { custom: true } : {}), ...(s.session ? { session: true } : {}) });
        }
        // Hand-written scripts are code people wrote: this computer runs them only when its owner agreed, and only after its own safety check.
        const hand = scripts.filter((s) => s.custom);
        if (hand.length > 0) {
            if (this.deps.allowCustomScripts !== true) return fail("This task has hand-written scripts, and code scripts are switched off for this runner, so it did not run them. Switch them on for your runner in Settings.");
            for (const s of hand) {
                const r = checkScript(s.content, { kind: "test" });
                if (!r.ok) return fail(`The script ${s.filename} did not pass this agent's safety check, so nothing was run: ${describeErrors(r.diagnostics)}`);
            }
            for (const h of task.helpers ?? []) {
                const r = checkScript(h.content, { kind: "helper" });
                if (!r.ok) return fail(`The helper ${h.name} did not pass this agent's safety check, so nothing was run: ${describeErrors(r.diagnostics)}`);
            }
        }
        let mobile: MobileDescriptor | undefined;
        if (runtime === "taqwright") {
            const m = await this.prepareMobile(task, dir, ctl, download);
            if ("error" in m) return fail(m.error);
            mobile = m.descriptor;
            files += task.mobile?.apk ? 1 : 0;
        }
        // iOS tests run on a simulator of this Mac; this computer decides whether it can, before anything is started.
        let ios: IosDescriptor | undefined;
        if (runtime === "ios") {
            const m = await this.prepareIos(task);
            if ("error" in m) return fail(m.error);
            ios = m.descriptor;
        }
        if (files > 0) log.info(`Task ${short}: ${files} file${files === 1 ? "" : "s"} ready.`);
        // Web tests run in the browser this runner chose (an installed Chrome or Edge, or Playwright's Chromium). Firefox and WebKit, for runs
        // on other browsers, are downloaded here the first time a run needs them; when that fails it is this computer's problem, not a test result.
        let web: BrowserInUse | undefined;
        if (runtime === "playwright" && task.adapterId === "playwright" && this.deps.browsers) {
            const need = await enginesOf(task.projects ?? []);
            if (need.chromium) {
                const w = await this.deps.browsers.forWeb();
                if (!w.ok) return fail(w.error);
                web = w.browser;
            }
            for (const e of need.engines) {
                stopCheck();
                const r = await this.deps.browsers.engine(e);
                if (!r.ok) return fail(r.error);
            }
        }
        // Desktop tests start an application: this computer decides whether it may, before anything is started. A refusal is an infrastructure answer, never a test result.
        if (runtime === "windows") {
            const refusal = await this.desktopRefusal(scripts);
            if (refusal) return fail(refusal);
        }
        stopCheck();

        // 3. run
        ctl.pushLog(`Running ${task.scripts.length} script${task.scripts.length === 1 ? "" : "s"}${task.projects?.length ? ` on ${task.projects.length} variants` : ""}`);
        const runEnv = toRunEnv(task.env);
        const message: ChildRun = {
            type: "run",
            adapterId: task.adapterId,
            scratchDir: dir,
            scripts,
            run: runEnv,
            ...(mobile ? { mobile } : {}),
            ...(ios ? { ios } : {}),
            ...(runtime === "windows" ? { desktop: { allowApps: [...(this.deps.allowApps ?? [])] } } : {}),
            ...(hand.length > 0 ? { allowCustom: true, ...(task.helpers?.length ? { helpers: task.helpers } : {}) } : {}),
            ...(web && (web.launch.channel || web.launch.executablePath) ? { browser: web.launch } : {}),
            opts: { workers: task.workers, ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}), ...(task.projects ? { projects: task.projects } : {}), ...(task.testTimeoutMs !== undefined ? { testTimeoutMs: task.testTimeoutMs } : {}), ...(task.startTimeoutMs !== undefined ? { startTimeoutMs: task.startTimeoutMs } : {}) },
        };
        // Protocol 2: the child reports each test and step as it happens; a failure screenshot is uploaded at once and then named in an event.
        const liveShots = new Map<string, string>();
        let shots: Promise<void> = Promise.resolve();
        let sawTests = false;
        if (ctl.live) message.live = true;
        const onChildLive = (e: LiveRunEvent): void => {
            if (!ctl.live) return;
            if (e.type === "screenshot") {
                shots = shots.then(() => this.liveScreenshot(task.taskId, e, liveShots, ctl.attemptId, ctl.abort.signal, ctl.live!)).catch(() => undefined);
                return;
            }
            if (e.type === "test_started" || e.type === "test_finished") sawTests = true;
            ctl.live.push(e as LiveEventInput);
        };
        const runChild = async () => {
            stopCheck();
            // A runner that refuses private addresses sends every request of the run through its own address guard (address-guard.ts), closed with the run.
            const guard = runtime === "playwright" && this.refusesPrivate() ? await startAddressGuard() : undefined;
            try {
            // Below-normal priority and a capped heap for the test processes; the memory of the whole tree only where a limit is set (resources.ts).
            const limits = resourceLimits(this.deps.env);
            const proc = new TaskProcess(guard ? guardedEnv(this.deps.env, guard) : this.deps.env, (line) => ctl.pushLog(line), undefined, { ...(limits.priority !== undefined ? { priority: limits.priority } : {}), heapMb: limits.heapMb });
            proc.onLive = onChildLive;
            ctl.setPhase?.("running");
            ctl.setProc(proc);
            ctl.entry.pid = proc.pid;
            proc.start(message);
            // A project's own per-test limit (task.testTimeoutMs) stretches the overall limit with it, so the watchdog never ends a test early.
            const perTest = task.testTimeoutMs ?? (runtime === "windows" && task.startTimeoutMs !== undefined ? Math.max(120, Math.ceil(task.startTimeoutMs / 1000) + 90) * 1000 : undefined);
            const limit = (task.timeoutMs ?? (runtime === "taqwright" || runtime === "ios" ? Math.max(10 * 60_000, scripts.length * (perTest !== undefined ? Math.max(4 * 60_000, perTest + 60_000) : 4 * 60_000)) : Math.max(120_000, scripts.length * Math.max(1, task.projects?.length ?? 1) * (perTest ?? 60_000)))) + WATCHDOG_GRACE_MS;
            let watchdogFired = false;
            const timer = setTimeout(() => {
                watchdogFired = true;
                proc.kill();
            }, limit);
            let overLimit: string | undefined;
            const stopWatch = watchMemory(proc.pid, limits.memoryMb, (used) => {
                overLimit = overMemory(limits.memoryMb, used);
                proc.kill();
            });
            const outcome = await proc.done;
            clearTimeout(timer);
            stopWatch();
            if (outcome.kind !== "result") proc.kill(); // sweep whatever the runner left behind
            return { outcome, watchdogFired, overLimit, output: proc.output };
            } finally {
                await guard?.close().catch(() => undefined);
            }
        };
        // One device runs one task at a time, whatever the concurrency setting says.
        const ran = runtime === "taqwright" ? await withDeviceLock(runChild) : runtime === "ios" ? await withSimulatorLock(runChild) : await runChild();
        stopCheck();
        if (ran.watchdogFired) return fail("The run took longer than its time limit and was stopped.");
        if (ran.overLimit) return fail(ran.overLimit);
        if (ran.outcome.kind === "crashed") {
            const tail = log.redact(ran.output).replace(/\s+/g, " ").trim().slice(-200);
            return fail(`${ran.outcome.detail}${tail ? ` Last output: ${tail}` : ""}`);
        }
        if (ran.outcome.kind === "error") return fail(`The test runner could not run the scripts: ${ran.outcome.message}`);
        const runs = ran.outcome.runs;
        // A run on other browsers has one result per script and variant.
        const expected = scripts.length * Math.max(1, task.projects?.length ?? 0);
        if (runs.length !== expected) return fail(`The test runner returned ${runs.length} results for ${scripts.length} scripts${task.projects?.length ? ` on ${task.projects.length} variants` : ""}.`);

        // A problem with this machine must not look like failing tests.
        const infra = this.infrastructureProblem(runs);
        if (infra) return fail(infra);
        ctl.setDone(runs.length);
        // Frameworks that report no live tests (phones, iOS, Windows desktop): each test's outcome now, before the files are sent.
        if (ctl.live && !sawTests) for (const r of runs) ctl.live.push({ type: "test_finished", testId: r.testId, ...(r.variant ? { variant: r.variant } : {}), status: r.status, durationMs: Number.isFinite(r.durationMs) ? Math.max(0, r.durationMs) : 0, ...(r.error ? { error: log.redact(r.error).slice(0, 2000) } : {}) });

        // 4. cleanup of the records the run created
        if (task.env.cleanup === "agent") {
            if (runs.some((r) => (r.created?.length ?? 0) > 0)) ctl.pushLog("Removing the test data the run created");
            const c = await runAgentCleanup(runs, scripts, runEnv, { signal: ctl.abort.signal, ...(this.refusesPrivate() ? { refusePrivate: true } : {}), ...(this.deps.deleteTimeoutMs ? { deleteTimeoutMs: this.deps.deleteTimeoutMs } : {}) });
            if (c.created > 0) log.info(`Task ${short}: ${c.summary}`);
        }
        stopCheck();

        // 5. upload and describe
        ctl.setPhase?.("uploading");
        await shots; // the live screenshots finish first: they are not sent twice
        if (runs.some((r) => r.artifacts.length > 0)) ctl.pushLog("Uploading screenshots and other files");
        const outcome = await this.uploadAll(task.taskId, runs, hello.maxFileBytes, ctl.abort.signal, short, liveShots, ctl.attemptId, traceSecretsOfRun(task.env));
        // A trace that could not be cleaned of the run's secrets was not sent: the run's events say so (the run's notes say it too).
        for (const why of new Set([...outcome.skipped.values()].filter((w) => w.startsWith(TRACE_HELD_BACK)))) ctl.pushLog(why);
        stopCheck();
        const wire = runs.map((r) => maskRun(toWireRun(r, outcome), (text) => log.redact(text)));
        const body = { ok: true, runs: wire };
        const checked = ResultRequest.safeParse(body);
        if (!checked.success) {
            const issue = checked.error.issues[0];
            return fail(`The agent could not describe the results in the platform's format (${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown problem"}).`);
        }
        const counts = runs.reduce<Record<string, number>>((n, r) => ((n[r.status] = (n[r.status] ?? 0) + 1), n), {});
        log.info(`Task ${short} finished: ${runs.length} result${runs.length === 1 ? "" : "s"} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}), ${outcome.uploaded.size} file${outcome.uploaded.size === 1 ? "" : "s"} uploaded.`);
        return { ok: true, runs: checked.data.runs, ...(web ? { browser: { name: web.name, ...(web.version ? { version: web.version } : {}), source: web.source } } : {}) };
    }

    /** Why this computer will not run these desktop scripts (not Windows, not interactive, elevated, an application it may not start), or undefined. */
    private async desktopRefusal(scripts: ScriptInput[]): Promise<string | undefined> {
        const caps = await this.deps.probe.get();
        const w = caps.windows;
        const why = caps.os !== "win32" ? "Windows desktop tests can only run on a Windows computer." : desktopUnavailableReason("win32", w ? { uiautomation: w.uiautomation === true, interactive: w.interactive !== false, elevated: w.elevated === true } : undefined) ?? (w ? undefined : "Windows UI Automation is not available on this computer.");
        if (why) return why;
        for (const s of scripts) {
            const why = scriptRefusal(s.content, this.deps.allowApps ?? [], "agent", caps.os);
            if (why) return why;
        }
        return undefined;
    }

    /** Is the machine the problem? Returns the plain sentence if so. */
    private infrastructureProblem(runs: ScriptRun[]): string | undefined {
        if (runs.some((r) => r.error && NO_BROWSER.test(r.error))) return "Playwright browsers are not installed on this agent. Run `npx playwright install chromium` in the platform folder on this computer, then try again.";
        const unusable = runs.filter((r) => r.status === "error" && r.error && NO_REPORT.test(r.error));
        if (unusable.length > 0 && unusable.length === runs.length) return `The test runner could not run on this agent: ${unusable[0]!.error!.replace(/\s+/g, " ").slice(0, 400)}`;
        return undefined;
    }

    private async prepareMobile(
        task: TaskOffer,
        dir: string,
        ctl: { pinned: string[]; abort: AbortController; pushLog?(line: string): void },
        download: (ref: { ref: string; size: number; sha256: string }) => (destination: string) => Promise<{ size: number; sha256: string }>,
    ): Promise<{ descriptor: MobileDescriptor } | { error: string }> {
        const m = task.mobile;
        if (!m) return { error: "The task has no mobile app settings." };
        let caps = await this.deps.probe.get();
        // No adb yet: a runner allowed to (phone-tools.ts) fetches Google's phone tools first, then looks at the phones again.
        if (this.deps.phoneTools && !caps.android?.adb) {
            const got = await this.deps.phoneTools.ensure((line) => ctl.pushLog?.(line), ctl.abort.signal);
            if (got.ok) caps = await this.deps.probe.get(true);
        }
        const android = caps.android;
        let apkPath: string | undefined;
        if (m.apk) {
            apkPath = await this.deps.cache.get(m.apk, download(m.apk), ".apk");
            ctl.pinned.push(apkPath);
        }
        // Round 24: the project's device choice travels with the app, so this runner picks the same device the platform would (mobile/device/choose.ts).
        const target = MobileTargetSchema.safeParse({ ...(m.appPackage ? { appPackage: m.appPackage } : {}), ...(apkPath ? { apkPath } : {}), ...(m.avd ? { avd: m.avd } : {}), ...(m.runsOn ? { runsOn: m.runsOn } : {}), ...(m.exploredOn ? { exploredOn: m.exploredOn } : {}) });
        if (!target.success) return { error: `The mobile app settings are not usable (${target.error.issues[0]?.message ?? "unknown problem"}).` };

        // MOBILE_RUNNER_CLI replaces the Taqwright entry point (the platform's own tests use it to run without an emulator).
        const seam = this.deps.env.MOBILE_RUNNER_CLI || undefined;
        let avd: string;
        let cliPath = seam;
        let manageEmulator = !seam;
        if (m.deviceSerial) {
            const device = android?.devices.find((d) => d.serial === m.deviceSerial);
            if (!device || device.state !== "device") return { error: `The Android device ${m.deviceSerial} is not connected to this agent or is not ready (state: ${device?.state ?? "not found"}).` };
            if (!/^[A-Za-z0-9._:-]{1,80}$/.test(m.deviceSerial)) return { error: "The device serial has characters the agent does not accept." };
            avd = m.avd ?? device.model ?? "device";
            manageEmulator = false;
            cliPath = await this.writeDeviceWrapper(dir, m.deviceSerial, seam);
        } else {
            const avds = android?.avds ?? [];
            avd = m.avd ?? avds[0] ?? "";
            // A ready phone is enough without any emulator: the run chooses the device and says which one it used (mobile/device/choose.ts).
            const phoneReady = (android?.devices ?? []).some((d) => d.state === "device" && !d.emulator);
            const named = m.runsOn?.kind === "phone" || m.runsOn?.kind === "explored" || (m.exploredOn !== undefined && !m.exploredOn.emulator && (m.runsOn === undefined || m.runsOn.kind === "auto"));
            if (!avd && !phoneReady) return { error: "No Android emulator or device is set up on this agent." };
            if (avd && !avds.includes(avd)) {
                if (!(named || (phoneReady && !m.avd))) return { error: `The emulator "${avd}" does not exist on this agent (available: ${avds.join(", ") || "none"}).` };
                avd = "";
            }
        }
        return { descriptor: { target: target.data, avd, manageEmulator, where: "the runner's computer", ...(cliPath ? { cliPath } : {}), ...(m.keepEmulator !== undefined ? { keepEmulator: m.keepEmulator } : {}) } };
    }

    /**
     * The app and simulator choice of an iOS task, after checking that THIS Mac can run it (macOS, Xcode, an iOS simulator, the XCUITest
     * driver). The platform checked too; the agent decides. IOS_RUNNER_CLI replaces the Taqwright entry point (the platform's own tests
     * use it, with a stand-in); with it no simulator is touched, unless IOS_XCRUN_CLI also stands in for `xcrun`.
     */
    private async prepareIos(task: TaskOffer): Promise<{ descriptor: IosDescriptor } | { error: string }> {
        const m = task.ios;
        if (!m?.bundleId) return { error: "The task has no iOS app settings." };
        const caps = await this.deps.probe.get();
        const problem = iosCapabilityProblem(caps);
        if (problem) return { error: `This agent can't run iOS tests: ${problem}.` };
        const target = MobileTargetSchema.safeParse({ iosBundleId: m.bundleId, ...(m.simulator ? { simulator: m.simulator } : {}) });
        if (!target.success) return { error: `The iOS app settings are not usable (${target.error.issues[0]?.message ?? "unknown problem"}).` };
        if (m.defaultSimulator && !SIMULATOR_NAME.test(m.defaultSimulator)) return { error: "The default simulator name has characters the agent does not accept." };
        const seam = this.deps.env.IOS_RUNNER_CLI || undefined;
        const manageSimulator = !seam || Boolean(this.deps.env.IOS_XCRUN_CLI);
        return {
            descriptor: {
                target: { iosBundleId: target.data.iosBundleId, ...(target.data.simulator ? { simulator: target.data.simulator } : {}) },
                manageSimulator,
                ...(m.defaultSimulator ? { defaultSimulator: m.defaultSimulator } : {}),
                ...(m.keepSimulator !== undefined ? { keepSimulator: m.keepSimulator } : {}),
                ...(seam ? { cliPath: seam } : {}),
            },
        };
    }

    /**
     * A phone is selected by Taqwright through MOBILE_UDID, which the platform's runner fills in itself. A tiny entry point in the
     * task folder sets it and then hands over to the real Taqwright CLI, so the platform's runner needs no change.
     */
    private async writeDeviceWrapper(dir: string, serial: string, seam: string | undefined): Promise<string> {
        const real = seam ?? path.join(path.dirname(require.resolve("@taqwright/taqwright")), "bin", "index.js");
        const file = path.join(dir, `device-${crypto.randomBytes(4).toString("hex")}.mjs`);
        const code = `import { pathToFileURL } from "node:url";\nprocess.env.MOBILE_UDID = ${JSON.stringify(serial)};\nprocess.argv[1] = ${JSON.stringify(real)};\nawait import(pathToFileURL(${JSON.stringify(real)}).href);\n`;
        await fs.writeFile(file, code);
        return file;
    }

    /**
     * Protocol 2: a failure screenshot, uploaded the moment Playwright wrote it (under a name of its own, `live-<n>-...`) and then named in a
     * `screenshot` event, so the run page shows it before the run ends. The final upload round reuses it instead of sending it again.
     */
    private async liveScreenshot(taskId: string, e: Extract<LiveRunEvent, { type: "screenshot" }>, done: Map<string, string>, attemptId: string | undefined, signal: AbortSignal, live: LiveEventSender): Promise<void> {
        if (done.has(e.path) || signal.aborted || live.isGone) return;
        const st = await fs.stat(e.path).catch(() => undefined);
        if (!st?.isFile() || st.size > this.deps.hello.maxFileBytes) return;
        const ext = path.extname(e.path).toLowerCase() === ".jpg" || path.extname(e.path).toLowerCase() === ".jpeg" ? ".jpg" : ".png";
        const name = `live-${done.size + 1}-${sanitizeName(e.testId, 40, "test")}${ext}`;
        try {
            const local = await sha256OfFile(e.path);
            const res = await this.deps.client.upload(taskId, name, e.path, st.size, signal, attemptId);
            if (res.size !== local.size || res.sha256.toLowerCase() !== local.sha256) return;
            done.set(e.path, res.ref);
            live.push({ type: "screenshot", testId: e.testId, ...(e.variant ? { variant: e.variant } : {}), ref: res.ref, kind: "screenshot" });
        } catch {
            /* a live picture is a bonus: the final upload round sends the file */
        }
    }

    /** Upload every file the runs name. A file that cannot be uploaded is left out and the run says so; it never fails the task. */
    private async uploadAll(taskId: string, runs: ScriptRun[], maxBytes: number, signal: AbortSignal, short: string, already: ReadonlyMap<string, string> = new Map(), attemptId?: string, secrets: readonly string[] = []): Promise<UploadOutcome> {
        const { client, log } = this.deps;
        const out: UploadOutcome = { uploaded: new Map(), skipped: new Map() };
        let bytes = 0;
        for (const item of planUploads(runs)) {
            if (signal.aborted) break;
            // Sent already while the run was going (a live screenshot): the same file under the name it has on the platform.
            const sent = already.get(item.path);
            if (sent) {
                out.uploaded.set(item.path, sent);
                continue;
            }
            let st = await fs.stat(item.path).catch(() => undefined);
            if (!st?.isFile()) {
                out.skipped.set(item.path, "a file was missing when it should have been uploaded");
                continue;
            }
            if (st.size > maxBytes) {
                out.skipped.set(item.path, `${item.name} (${mb(st.size)}) is larger than the ${mb(maxBytes)} limit`);
                log.warn(`Task ${short}: ${item.name} is ${mb(st.size)}, over the platform's limit of ${mb(maxBytes)}; it was not uploaded.`);
                continue;
            }
            // A failure trace holds what the test typed and what the browser sent (a password, a token, a cookie): it leaves this computer
            // only with the run's secrets masked (engine/evidence/trace-scrub.ts), or not at all.
            if (item.kind === "trace") {
                const clean = await scrubTraceFile(item.path, secrets);
                if (!clean.ok) {
                    out.skipped.set(item.path, `${TRACE_HELD_BACK}: ${clean.reason}`);
                    log.warn(`Task ${short}: ${item.name} was not uploaded: ${clean.reason}.`);
                    await fs.rm(item.path, { force: true }).catch(() => undefined);
                    continue;
                }
                // Cleaning rewrites the file (a masked value changes its length): the size sent with the upload is the cleaned file's.
                if (clean.masked > 0) {
                    st = await fs.stat(item.path).catch(() => undefined);
                    if (!st?.isFile()) {
                        out.skipped.set(item.path, "a file could not be read");
                        continue;
                    }
                    if (st.size > maxBytes) {
                        out.skipped.set(item.path, `${item.name} (${mb(st.size)}) is larger than the ${mb(maxBytes)} limit`);
                        continue;
                    }
                }
            }
            const local = await sha256OfFile(item.path).catch(() => undefined);
            if (!local) {
                out.skipped.set(item.path, "a file could not be read");
                continue;
            }
            let reason = "";
            for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS && !signal.aborted; attempt++) {
                try {
                    const res = await client.upload(taskId, item.name, item.path, st.size, signal, attemptId);
                    if (res.size === local.size && res.sha256.toLowerCase() === local.sha256) {
                        out.uploaded.set(item.path, res.ref);
                        bytes += st.size;
                        reason = "";
                        break;
                    }
                    reason = `${item.name} arrived damaged`;
                } catch (e) {
                    reason = e instanceof PlatformError ? e.message : `${item.name} could not be sent`;
                    // A refusal that repeating cannot change (too big, bad name, task gone) is not retried.
                    if (e instanceof PlatformError && e.kind === "rejected") break;
                }
                if (attempt < UPLOAD_ATTEMPTS) await sleep(400 * attempt, signal);
            }
            if (!out.uploaded.has(item.path) && !signal.aborted) {
                out.skipped.set(item.path, `${item.name} could not be uploaded`);
                log.warn(`Task ${short}: ${reason || `${item.name} could not be uploaded`}`);
            }
        }
        if (out.uploaded.size > 0) log.info(`Task ${short}: uploaded ${out.uploaded.size} file${out.uploaded.size === 1 ? "" : "s"} (${mb(bytes)}).`);
        return out;
    }

    /**
     * Deliver a result. With an outbox (every agent program; outbox.ts) it is kept on disk first and only removed once the platform answered;
     * after a few quick tries the outbox keeps trying in the background (across a restart of the agent), so the task's slot is free again.
     */
    private async postResult(taskId: string, body: ResultRequest, short: string): Promise<void> {
        const { log, outbox } = this.deps;
        if (outbox) {
            try {
                await outbox.put(taskId, body);
            } catch (e) {
                log.warn(`Task ${short}: the result could not be kept on this computer (${e instanceof Error ? e.message : "unknown problem"}); it is sent directly.`);
                return this.postDirect(taskId, body, short);
            }
            for (let attempt = 1; attempt <= 3; attempt++) {
                if ((await outbox.deliver(taskId)) !== "pending") return;
                if (attempt < 3) await sleep(500 * 2 ** attempt);
            }
            log.warn(`Task ${short}: the platform did not answer; the result is kept on this computer and is sent as soon as the platform answers.`);
            outbox.wake();
            return;
        }
        return this.postDirect(taskId, body, short);
    }

    private async postDirect(taskId: string, body: ResultRequest, short: string): Promise<void> {
        const { client, log } = this.deps;
        for (let attempt = 1; attempt <= RESULT_ATTEMPTS; attempt++) {
            try {
                await client.result(taskId, body);
                log.info(`Task ${short}: result sent (${body.ok ? "ok" : `not run: ${body.error ?? "stopped"}`}).`);
                return;
            } catch (e) {
                const err = e instanceof PlatformError ? e : undefined;
                // The platform answered and said no (task gone, already finished, not ours): sending again will not change that.
                if (err && (err.kind === "rejected" || err.kind === "auth" || err.kind === "conflict")) {
                    log.warn(`Task ${short}: the platform did not accept the result (${err.message})`);
                    return;
                }
                if (attempt === RESULT_ATTEMPTS) log.error(`Task ${short}: the result could not be delivered (${err?.message ?? "unknown problem"}). The platform will give the task up when its lease runs out.`);
                else await sleep(Math.min(8000, 500 * 2 ** attempt));
            }
        }
    }
}
