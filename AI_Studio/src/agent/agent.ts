/**
 * The agent: connects out to the platform, announces what this computer can run, and loops "ask for a task, run it".
 *
 * Connection rules:
 *  - `hello` first. A token that is not valid or was revoked, a protocol the agent cannot speak, or a refusal stops the agent
 *    with a plain message and its own exit code (no retry would help).
 *  - Then a long-poll for tasks, offering as many free slots as the concurrency setting leaves.
 *  - Network trouble, a restarting platform or a server error: wait (1 s growing to 30 s, with jitter), say hello again, carry on.
 *    Tasks that are running are not affected by a lost connection; their heartbeats and results retry on their own.
 *  - An answer that does not fit the protocol is logged and skipped; it never crashes the agent.
 *  - Stopping (`stop()`, called on SIGINT/SIGTERM) cancels running tasks, tells the platform "The agent was stopped" and returns.
 */
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { SUPPORTED_PROTOCOLS, type Capabilities, type HelloRequest, type HelloResponse } from "../agent-protocol/schema.js";
import { REPO_ROOT } from "../config.js";
import { backoffDelay, sleep, type BackoffOptions } from "./backoff.js";
import { BrowserSetup } from "./browser-setup.js";
import { PhoneToolsSetup, phoneToolsPolicy } from "./phone-tools.js";
import { CapabilityProbe, describeCapabilities } from "./capabilities.js";
import { PlatformClient, PlatformError } from "./client.js";
import { AGENT_VERSION, type AgentConfig } from "./config.js";
import { FileCache } from "./file-cache.js";
import { machineIdFor, saveCredential, type StoreDeps } from "./credential-store.js";

/** A runner that stays connected says hello again this often, so a credential due for renewal is renewed (round 39). */
const ROTATION_CHECK_MS = 24 * 60 * 60_000;
import type { Logger } from "./log.js";
import { ResultOutbox } from "./outbox.js";
import { clearStopRequest, watchStopFile } from "./stop-file.js";
import { TaskRunner } from "./task-runner.js";
import type { RunnerUpdater } from "./updater.js";

export const EXIT = { stopped: 0, failed: 1, usage: 2, token: 3, protocol: 4, refused: 5 } as const;

export interface AgentOptions {
    config: AgentConfig;
    log: Logger;
    /** The agent's environment (default process.env). */
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    /** A runner from a download keeps itself up to date (updater.ts); absent for a checkout-based runner. */
    updater?: RunnerUpdater;
    probe?: CapabilityProbe;
    /**
     * The browser choice (browser-setup.ts). Default: made from the config, unless a `probe` is given (then the caller decides what this
     * computer reports, and runs use Playwright's own Chromium as before). `false`: none.
     */
    browsers?: BrowserSetup | false;
    backoff?: BackoffOptions;
    random?: () => number;
    /** Tests: a stand-in for the computer's credential store commands (credential-store.ts). */
    credentialStore?: StoreDeps;
    /** Tests: heartbeat period and DELETE timeout overrides. */
    heartbeatMs?: number;
    deleteTimeoutMs?: number;
    /** Tests: the protocol versions this agent offers (default: every version it speaks). [1] makes it a protocol-1 agent. */
    protocols?: readonly number[];
    /** Tests: live event batching (default 50 events, 1 s). */
    liveBatch?: { maxBatch?: number; maxDelayMs?: number };
    /** Tests: the outbox's longest wait between tries (default a minute). */
    outboxMaxDelayMs?: number;
    /**
     * Where a launcher may write `stop.request` (stop-file.ts) to stop the agent gracefully, as SIGTERM does. Default: the work folder. The
     * program's entry (index.ts) also watches the folder of runner.mjs, which is where the Windows host writes it.
     */
    stopDir?: string;
}

/** Make sure scripts under `workDir` can resolve `@playwright/test`: if the folder is outside a Node project, link this checkout's node_modules into it. */
export async function ensureResolvable(workDir: string): Promise<void> {
    const can = (dir: string): boolean => {
        try {
            createRequire(path.join(dir, "resolve.js")).resolve("@playwright/test");
            return true;
        } catch {
            return false;
        }
    };
    await fs.mkdir(workDir, { recursive: true });
    if (can(workDir)) return;
    const target = path.join(REPO_ROOT, "node_modules");
    const link = path.join(workDir, "node_modules");
    const exists = await fs.lstat(link).then(() => true, () => false);
    if (!exists) {
        try {
            await fs.symlink(target, link, "junction");
        } catch {
            /* reported below */
        }
    }
    if (!can(workDir)) throw new Error(`The work folder ${workDir} cannot find @playwright/test. Use a folder inside the platform checkout (the default), or one whose parent has node_modules with the platform's dependencies.`);
}

export interface AgentStatus {
    state: "starting" | "connected" | "reconnecting" | "stopping" | "stopped";
    agentId?: string;
    running: Array<{ taskId: string; pid?: number }>;
    peakRunning: number;
}

export class Agent {
    private readonly log: Logger;
    private readonly cfg: AgentConfig;
    private readonly env: NodeJS.ProcessEnv;
    private readonly client: PlatformClient;
    private readonly probe: CapabilityProbe;
    /** The runner's browser choice (undefined when the caller supplied its own probe). */
    readonly browsers?: BrowserSetup;
    /** The runner's own Android phone tools (phone-tools.ts; undefined when the caller supplied its own probe). */
    readonly phoneTools?: PhoneToolsSetup;
    private cache!: FileCache;
    private runner?: TaskRunner;
    private state: AgentStatus["state"] = "starting";
    private agentId?: string;
    private stopping = false;
    private readonly stopSignal = new AbortController();
    private readonly tasks = new Set<Promise<void>>();
    private slotWaiters: Array<() => void> = [];
    private lastCapsKey = "";
    /** Failed connection attempts in a row (drives the backoff); back to 0 once a poll works. */
    private retries = 0;
    private fatal?: { code: number; message: string };
    /** Set when the runner switched to a new version and must be started again (RUNNER_UPDATE_EXIT). */
    private exitWith?: number;
    /** This installation's id (credential-store.ts), sent with hello and enroll; undefined for a token given by hand. */
    private readonly machineId?: string;
    /** BLOCK_PRIVATE_TARGETS as this computer's environment had it, restored when the owner allows private addresses again. */
    private readonly ownBlockSetting?: string;
    /** When to say hello again to learn whether the credential is due for renewal (a long-connected runner). */
    private nextRotationCheck = Number.POSITIVE_INFINITY;
    /** Results waiting for the platform (outbox.ts). */
    private outbox?: ResultOutbox;
    /** The protocol spoken with the platform since the last hello. */
    private protocol = 1;
    /** The platform retired this runner (protocol 2 `shutdown`): take nothing new, finish, exit. */
    private retiring = false;
    private unwatchStop?: () => void;
    /** What the last hello said about this runner (kind and switches), so a heartbeat's `config` is applied with the same rules. */
    private lastRunnerSwitches?: HelloResponse["runner"];

    constructor(private readonly opts: AgentOptions) {
        this.log = opts.log;
        this.cfg = opts.config;
        this.env = opts.env ?? process.env;
        this.ownBlockSetting = this.env.BLOCK_PRIVATE_TARGETS;
        // Only a runner whose credential lives in the computer's store (added with an enrollment code) says which installation it is; a token
        // given by hand keeps today's behaviour (round 39).
        this.machineId = this.cfg.tokenSource === "store" ? machineIdFor(this.cfg.credentialDir ?? this.cfg.workDir) : undefined;
        this.client = new PlatformClient({ baseUrl: this.cfg.baseUrl, token: this.cfg.token, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
        this.browsers = opts.browsers === false ? undefined : (opts.browsers ?? (opts.probe ? undefined : new BrowserSetup({ ...(this.cfg.browser ? { policy: this.cfg.browser } : {}), env: this.env, log: this.log, workDir: this.cfg.workDir, onChange: () => this.probe.invalidate() })));
        // Android phone tools: a kit runner fetches Google's platform-tools itself when a phone session needs them (AITP_PHONE_TOOLS, runner.json phoneTools).
        this.phoneTools = opts.probe ? undefined : new PhoneToolsSetup({ policy: phoneToolsPolicy(this.env, Boolean(this.cfg.kitVersion)), env: this.env, log: this.log, workDir: this.cfg.workDir, onChange: () => this.probe.invalidate() });
        this.probe = opts.probe ?? new CapabilityProbe({ env: this.env, allowApps: this.cfg.allowApps ?? [], ...(this.cfg.allowCustomScripts ? { allowCustomScripts: true } : {}), ...(this.cfg.kitVersion ? { kitVersion: this.cfg.kitVersion } : {}), ...(this.browsers ? { browserSetup: this.browsers } : {}), ...(this.phoneTools ? { phoneTools: this.phoneTools } : {}) });
        opts.updater?.attach(this.client, this.log);
    }

    status(): AgentStatus {
        return { state: this.state, ...(this.agentId ? { agentId: this.agentId } : {}), running: [...(this.runner?.active.values() ?? [])].map((t) => ({ taskId: t.taskId, ...(t.pid ? { pid: t.pid } : {}) })), peakRunning: this.runner?.peak ?? 0 };
    }

    /** Ask the agent to stop: running tasks are cancelled and reported as stopped. `run()` returns once they are. */
    stop(): void {
        if (this.stopping) return;
        this.stopping = true;
        this.state = "stopping";
        this.log.info("Stopping: running tasks are being cancelled.");
        this.stopSignal.abort();
        this.unwatchStop?.();
        this.runner?.cancelAll("The agent was stopped.");
        this.browsers?.stop();
        this.opts.updater?.stop();
        this.wake();
    }

    private wake(): void {
        const waiting = this.slotWaiters;
        this.slotWaiters = [];
        for (const w of waiting) w();
    }

    private waitForSlot(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const t = setTimeout(resolve, ms);
            this.slotWaiters.push(() => {
                clearTimeout(t);
                resolve();
            });
        });
    }

    /**
     * The capabilities, unless the agent is stopped first (then undefined). A probe can take many seconds (the Windows UI Automation
     * probe starts PowerShell, up to its 20 s limit on a busy machine); stop() must not wait for it. The probe's own commands end by
     * their own time limits.
     */
    private probeUnlessStopped(force = false): Promise<Capabilities | undefined> {
        if (this.stopping) return Promise.resolve(undefined);
        const signal = this.stopSignal.signal;
        let onAbort = (): void => undefined;
        const stopped = new Promise<undefined>((resolve) => {
            onAbort = () => resolve(undefined);
            signal.addEventListener("abort", onAbort, { once: true });
        });
        // The listener goes when the probe answers: the poll loop calls this every few seconds for hours.
        return Promise.race([this.probe.get(force), stopped]).finally(() => signal.removeEventListener("abort", onAbort));
    }

    /** Runs until stopped or until something makes continuing pointless. Resolves with the process exit code. */
    async run(): Promise<number> {
        this.log.addSecrets([this.cfg.token, this.cfg.enroll?.code ?? ""].filter(Boolean));
        try {
            await this.prepare();
        } catch (e) {
            this.log.error(e instanceof Error ? e.message : "The agent could not prepare its work folder.");
            return EXIT.failed;
        }
        if (this.cfg.insecureWarning) this.log.warn(this.cfg.insecureWarning);
        for (const note of this.cfg.allowAppNotes ?? []) this.log.warn(note);
        if (this.cfg.allowCustomScripts) this.log.warn("Hand-written scripts are allowed on this agent (--allow-custom-scripts): code written by people on the project runs here with this user's rights.");
        if (this.cfg.tokenSource === "flag") this.log.warn("The token was given on the command line, where other users of this computer can see it. Prefer AITP_AGENT_TOKEN or --token-file.");
        this.log.info(`ai-test-agent ${AGENT_VERSION} starting. Platform: ${this.client.host}. Work folder: ${this.cfg.workDir}. Concurrency: ${this.cfg.concurrency}.`);
        // Which browser web tests use, before the runner says it is ready for them (a download, when one is needed, carries on in the background).
        await this.browsers?.prepare().catch((e) => this.log.warn(`The runner could not look for a browser: ${e instanceof Error ? e.message : "unknown problem"}.`));
        // Phone tools fetched on an earlier day are used again; with AITP_PHONE_TOOLS=now a missing set is fetched in the background.
        this.phoneTools?.prepare();
        // A launcher's graceful stop (stop-file.ts): handled exactly like SIGTERM.
        this.unwatchStop = watchStopFile(this.opts.stopDir ?? this.cfg.workDir, () => {
            this.log.info("A stop was asked for (stop.request).");
            this.stop();
        });
        // Round 39: a runner added with an enrollment code trades it for its own credential first (retried while the network is down).
        if (!this.cfg.token && this.cfg.enroll) {
            const code = await this.enroll(this.cfg.enroll);
            if (code !== undefined) {
                this.unwatchStop?.();
                return code;
            }
        }

        while (!this.stopping && !this.fatal && this.exitWith === undefined) {
            try {
                await this.connect();
                await this.pollLoop();
            } catch (e) {
                if (this.stopping) break;
                const err = e instanceof PlatformError ? e : undefined;
                if (err && (err.kind === "auth" || err.kind === "conflict" || err.kind === "protocol")) {
                    this.fatal = { code: err.kind === "auth" ? EXIT.token : err.kind === "protocol" ? EXIT.protocol : EXIT.refused, message: err.message };
                    break;
                }
                const delay = Math.max(backoffDelay(this.retries, this.opts.backoff, this.opts.random), (err?.retryAfter ?? 0) * 1000);
                this.retries++;
                this.state = "reconnecting";
                this.log.warn(`${err?.message ?? "The connection to the platform failed."} Trying again in ${Math.max(1, Math.round(delay / 1000))} s.`);
                await sleep(delay, this.stopSignal.signal);
            }
        }

        // Leave nothing running: on a fatal error the platform cannot take results any more, so just stop the work.
        if (this.fatal) {
            this.log.error(this.fatal.message);
            this.runner?.cancelAll("The agent stopped.");
        }
        await this.drain(20_000);
        await this.outbox?.stop();
        this.unwatchStop?.();
        this.state = "stopped";
        return this.fatal ? this.fatal.code : (this.exitWith ?? EXIT.stopped);
    }

    private async prepare(): Promise<void> {
        await ensureResolvable(this.cfg.workDir);
        // Whatever an earlier run of the agent left (it was killed mid-task): task folders and half-finished downloads.
        await fs.rm(path.join(this.cfg.workDir, "tasks"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await fs.mkdir(path.join(this.cfg.workDir, "tasks"), { recursive: true });
        this.cache = new FileCache(path.join(this.cfg.workDir, "cache"), this.cfg.cacheBytes);
        await this.cache.init();
        // Results an earlier run of the agent could not deliver are kept (unlike the task folders) and sent once connected.
        this.outbox = new ResultOutbox(this.cfg.workDir, { client: this.client, log: this.log, ...(this.opts.outboxMaxDelayMs ? { maxDelayMs: this.opts.outboxMaxDelayMs } : {}) });
        await this.outbox.init();
        // A stop asked of an earlier run must not stop this one.
        try {
            clearStopRequest(this.opts.stopDir ?? this.cfg.workDir);
        } catch {
            /* nothing to clear */
        }
    }

    /** Protocol 2: the platform retired this runner while it worked. Running tasks finish; nothing new is taken; then the agent exits. */
    private retire(): void {
        if (this.retiring || this.stopping) return;
        this.retiring = true;
        this.log.warn("This runner was retired on the platform. It finishes what it is running, takes nothing new, and then stops.");
        this.wake();
    }

    /** Hello, offering every protocol this agent speaks; a platform that refuses the offer is asked once more with protocol 1 only. */
    private async sayHello(req: Omit<HelloRequest, "protocol" | "protocols">): Promise<HelloResponse> {
        const offered = [...(this.opts.protocols ?? SUPPORTED_PROTOCOLS)].sort((a, b) => a - b);
        // `protocol` is the oldest version offered (1), so a protocol-1 platform, which reads only that field, accepts the hello as it always did.
        const first: HelloRequest = { ...req, protocol: offered[0] ?? 1, ...(offered.length > 1 ? { protocols: offered } : {}) };
        try {
            return await this.client.hello(first);
        } catch (e) {
            if (!(e instanceof PlatformError) || e.kind !== "protocol" || offered.length < 2 || !offered.includes(1)) throw e;
            this.log.warn("The platform did not accept the newer protocol; connecting again with protocol 1.");
            return this.client.hello({ ...req, protocol: 1 });
        }
    }

    private async connect(): Promise<void> {
        const capabilities = await this.probeUnlessStopped(true);
        if (!capabilities) return; // stopped meanwhile: run() ends
        this.noteCapabilities(capabilities);
        const hello = await this.sayHello({ name: this.cfg.name, version: AGENT_VERSION, capabilities, concurrency: this.cfg.concurrency, ...(this.machineId ? { machineId: this.machineId } : {}) });
        const speaks = this.opts.protocols ?? SUPPORTED_PROTOCOLS;
        if (!speaks.includes(hello.protocol)) {
            throw new PlatformError("protocol", `This agent speaks protocol ${speaks.join(" and ")} but the platform speaks protocol ${hello.protocol}. Update the agent (or the platform) so both speak the same version.`);
        }
        this.protocol = hello.protocol;
        this.client.setPollSeconds(hello.pollSeconds);
        this.agentId = hello.agentId;
        if (this.runner) this.runner.setHello(hello);
        else
            this.runner = new TaskRunner({
                client: this.client,
                cache: this.cache,
                log: this.log,
                workDir: this.cfg.workDir,
                hello,
                probe: this.probe,
                env: this.env,
                allowApps: this.cfg.allowApps ?? [],
                ...(this.cfg.allowCustomScripts ? { allowCustomScripts: true } : {}),
                ...(this.browsers ? { browsers: this.browsers } : {}),
                ...(this.phoneTools && this.phoneTools.policy !== "off" ? { phoneTools: this.phoneTools } : {}),
                ...(this.opts.heartbeatMs ? { heartbeatMs: this.opts.heartbeatMs } : {}),
                ...(this.opts.deleteTimeoutMs ? { deleteTimeoutMs: this.opts.deleteTimeoutMs } : {}),
                ...(this.outbox ? { outbox: this.outbox } : {}),
                ...(this.opts.liveBatch ? { liveBatch: this.opts.liveBatch } : {}),
                onShutdown: () => this.retire(),
                // A heartbeat's `config` (protocol 2) goes through the same rules as hello `runner` (a team runner keeps --allow-custom-scripts).
                onConfig: (c) => (this.lastRunnerSwitches ? this.applyRunnerSwitches({ ...this.lastRunnerSwitches, ...c }) : this.runner?.applyConfig(c)),
            });
        this.state = "connected";
        // Results kept from before (a platform that was away, an agent that was restarted) go first, before any new task is taken.
        if (this.outbox) {
            const left = await this.outbox.flush().catch(() => 1);
            if (left > 0) this.log.warn(`${left} result${left === 1 ? " is" : "s are"} still waiting for the platform; the agent keeps trying.`);
            this.outbox.start();
        }
        this.log.info(`${this.retries > 0 ? "Reconnected to the platform" : "Connected to the platform"} as "${this.cfg.name}" (agent ${hello.agentId.slice(0, 12)}, project ${hello.projectId.slice(0, 12)}, protocol ${hello.protocol}).`);
        this.opts.updater?.connected(hello.agentId, hello.update);
        // Round 39: what this runner is and what its owner allows, and a new credential when the platform says it is due.
        this.lastRunnerSwitches = hello.runner;
        if (hello.runner) this.applyRunnerSwitches(hello.runner);
        if (hello.rotate) await this.rotateCredential();
        this.nextRotationCheck = Date.now() + ROTATION_CHECK_MS;
    }

    /**
     * The platform's switches for this runner (hello `runner`): a personal runner follows its owner's code-script switch alone; a team runner
     * also runs them when it was started with --allow-custom-scripts. Private addresses off: every test this runner starts gets
     * BLOCK_PRIVATE_TARGETS (the address check generated scripts make on every step); on: whatever this computer's environment said.
     */
    private applyRunnerSwitches(r: NonNullable<HelloResponse["runner"]>): void {
        const customScripts = r.kind === "personal" ? r.customScripts : this.cfg.allowCustomScripts === true || r.customScripts;
        this.runner?.applyConfig({ customScripts, privateTargets: r.privateTargets });
        if (!r.privateTargets) this.env.BLOCK_PRIVATE_TARGETS = "true";
        else if (this.ownBlockSetting === undefined) delete this.env.BLOCK_PRIVATE_TARGETS;
        else this.env.BLOCK_PRIVATE_TARGETS = this.ownBlockSetting;
    }

    /** Trade the enrollment code for this runner's credential, keep it in the computer's store, delete the code file. Undefined: carry on; a number: exit with it. */
    private async enroll(e: NonNullable<AgentConfig["enroll"]>): Promise<number | undefined> {
        const dir = this.cfg.credentialDir ?? this.cfg.workDir;
        let attempt = 0;
        while (!this.stopping) {
            try {
                const capabilities = await this.probeUnlessStopped(true);
                if (!capabilities) return EXIT.stopped;
                const out = await this.client.enroll({ code: e.code, name: this.cfg.name, machineId: this.machineId ?? machineIdFor(dir), version: AGENT_VERSION, capabilities });
                this.log.addSecrets([out.token]);
                try {
                    await saveCredential(dir, out.token, this.opts.credentialStore);
                } catch (err) {
                    // Not used, so within the code's 30 minutes this computer may ask again with the same code (the platform allows that once the answer is lost).
                    this.log.error(`${err instanceof Error ? err.message : "The runner could not keep its credential."} The code still works for this computer for a while: start the runner again.`);
                    return EXIT.failed;
                }
                if (e.file) await fs.rm(e.file, { force: true }).catch(() => undefined);
                this.client.setToken(out.token);
                this.cfg.token = out.token;
                this.cfg.tokenSource = "store";
                this.log.info(`This computer was added as ${out.kind === "personal" ? "your own runner" : "a team runner"}. Its credential is kept in this computer's store; the code is used up.`);
                return undefined;
            } catch (err) {
                if (this.stopping) return EXIT.stopped;
                const pe = err instanceof PlatformError ? err : undefined;
                if (pe && (pe.kind === "auth" || pe.kind === "conflict" || pe.kind === "protocol" || pe.kind === "rejected")) {
                    this.log.error(pe.message);
                    return pe.kind === "protocol" ? EXIT.protocol : pe.kind === "conflict" ? EXIT.refused : EXIT.token;
                }
                const delay = Math.max(backoffDelay(attempt++, this.opts.backoff, this.opts.random), (pe?.retryAfter ?? 0) * 1000);
                this.log.warn(`${pe?.message ?? "Could not reach the platform to add this computer."} Trying again in ${Math.max(1, Math.round(delay / 1000))} s.`);
                await sleep(delay, this.stopSignal.signal);
            }
        }
        return EXIT.stopped;
    }

    /** Ask for a new credential and keep it. On any trouble the current one keeps working (24 hours at least), and the next hello asks again. */
    private async rotateCredential(): Promise<void> {
        if (this.cfg.tokenSource !== "store") return; // a token from the command line, the environment or a file is the person's to change
        try {
            const out = await this.client.rotate();
            this.log.addSecrets([out.token]);
            await saveCredential(this.cfg.credentialDir ?? this.cfg.workDir, out.token, this.opts.credentialStore);
            this.client.setToken(out.token);
            this.cfg.token = out.token;
            this.log.info("The runner renewed its credential (they are renewed every 30 days).");
        } catch (e) {
            this.log.warn(`The runner could not renew its credential (${e instanceof Error ? e.message : "unknown problem"}). It keeps the current one and tries again later.`);
        }
    }

    /** A runner that stays connected for days still renews its credential: once a day it says hello again, and rotates when told. */
    private async checkRotation(): Promise<void> {
        this.nextRotationCheck = Date.now() + ROTATION_CHECK_MS;
        if (this.cfg.tokenSource !== "store") return;
        const capabilities = await this.probeUnlessStopped();
        if (!capabilities) return;
        const hello = await this.sayHello({ name: this.cfg.name, version: AGENT_VERSION, capabilities, concurrency: this.cfg.concurrency, ...(this.machineId ? { machineId: this.machineId } : {}) }).catch(() => undefined);
        if (hello?.runner) this.applyRunnerSwitches(hello.runner);
        if (hello?.rotate) await this.rotateCredential();
    }

    /** While an update is prepared: a poll that cannot be given a task, so the runner stays online (runner-updates.md). */
    private async keepAlive(): Promise<void> {
        const capabilities = await this.probeUnlessStopped();
        if (!capabilities || !this.agentId) return;
        await this.client.poll({ agentId: this.agentId, capabilities, freeSlots: 0 }, AbortSignal.any([this.stopSignal.signal, AbortSignal.timeout(3000)]));
    }

    /** Log what was found the first time and whenever it changes (a phone plugged in, a browser installed). */
    private noteCapabilities(c: Capabilities): void {
        const key = JSON.stringify(c);
        if (key === this.lastCapsKey) return;
        this.log.info(this.lastCapsKey ? `This computer's capabilities changed: ${describeCapabilities(c)}` : `Capabilities: ${describeCapabilities(c)}`);
        this.lastCapsKey = key;
    }

    /** Poll until stopped; throws to make the caller reconnect. */
    private async pollLoop(): Promise<void> {
        while (!this.stopping) {
            if (Date.now() >= this.nextRotationCheck) await this.checkRotation();
            // Retired (protocol 2 `shutdown`): wait for the running tasks, then stop like a person's stop (nothing is running any more).
            if (this.retiring) {
                if ((this.runner?.active.size ?? 0) === 0) {
                    this.stop();
                    return;
                }
                await this.waitForSlot(5000);
                continue;
            }
            // An update is being prepared or waits for the running tasks: no new claims (updater.ts).
            const updater = this.opts.updater;
            if (updater?.holding()) {
                const code = await updater.hold({ active: () => this.runner?.active.size ?? 0, keepAlive: () => this.keepAlive(), wait: (ms) => this.waitForSlot(ms) });
                if (code !== undefined) {
                    this.exitWith = code;
                    return;
                }
                continue;
            }
            const free = this.cfg.concurrency - (this.runner?.active.size ?? 0);
            if (free <= 0) {
                // Running tasks heartbeat, which keeps this agent visible; wait for a slot to open.
                await this.waitForSlot(5000);
                continue;
            }
            const started = Date.now();
            const capabilities = await this.probeUnlessStopped();
            if (!capabilities) return;
            this.noteCapabilities(capabilities);
            let offer;
            try {
                offer = await this.client.poll({ agentId: this.agentId!, capabilities, freeSlots: free }, this.stopSignal.signal);
            } catch (e) {
                if (this.stopping) return;
                if (e instanceof PlatformError && e.kind === "invalid") {
                    this.log.warn(`${e.message} The agent carries on.`);
                    await sleep(2000, this.stopSignal.signal);
                    continue;
                }
                throw e;
            }
            this.retries = 0; // the platform answered: the connection works
            this.opts.updater?.noteHint(this.client.updateHint);
            if (offer === null) {
                if (Date.now() - started < 200) await sleep(200, this.stopSignal.signal);
                continue;
            }
            if ("unreadable" in offer) {
                this.log.warn(`${offer.unreadable} The agent and the platform may be different versions.`);
                if (offer.taskId) {
                    await this.client.result(offer.taskId, { ok: false, error: "The agent could not read this task. The agent and the platform may be different versions.", runs: [] }).catch(() => undefined);
                }
                await sleep(1000, this.stopSignal.signal);
                continue;
            }
            const p = this.runner!.run(offer)
                .catch((e) => this.log.error(`Task ${offer.taskId.slice(0, 12)} failed unexpectedly: ${e instanceof Error ? e.message : "unknown problem"}`))
                .finally(() => {
                    this.tasks.delete(p);
                    this.wake();
                });
            this.tasks.add(p);
        }
    }

    private async drain(timeoutMs: number): Promise<void> {
        if (this.tasks.size === 0) return;
        await Promise.race([Promise.allSettled([...this.tasks]), sleep(timeoutMs)]);
    }
}
