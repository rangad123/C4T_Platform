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
import { PROTOCOL_VERSION, type Capabilities, type HelloResponse } from "../agent-protocol/schema.js";
import { REPO_ROOT } from "../config.js";
import { backoffDelay, sleep, type BackoffOptions } from "./backoff.js";
import { BrowserSetup } from "./browser-setup.js";
import { PhoneToolsSetup, phoneToolsPolicy } from "./phone-tools.js";
import { CapabilityProbe, describeCapabilities } from "./capabilities.js";
import { PlatformClient, PlatformError } from "./client.js";
import { AGENT_VERSION, type AgentConfig } from "./config.js";
import { FileCache } from "./file-cache.js";
import type { Logger } from "./log.js";
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
    /** Tests: heartbeat period and DELETE timeout overrides. */
    heartbeatMs?: number;
    deleteTimeoutMs?: number;
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

    constructor(private readonly opts: AgentOptions) {
        this.log = opts.log;
        this.cfg = opts.config;
        this.env = opts.env ?? process.env;
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
        this.log.addSecrets([this.cfg.token]);
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
    }

    private async connect(): Promise<void> {
        const capabilities = await this.probeUnlessStopped(true);
        if (!capabilities) return; // stopped meanwhile: run() ends
        this.noteCapabilities(capabilities);
        const hello = await this.client.hello({ protocol: PROTOCOL_VERSION, name: this.cfg.name, version: AGENT_VERSION, capabilities, concurrency: this.cfg.concurrency });
        if (hello.protocol !== PROTOCOL_VERSION) {
            throw new PlatformError("protocol", `This agent speaks protocol ${PROTOCOL_VERSION} but the platform speaks protocol ${hello.protocol}. Update the agent (or the platform) so both are the same version.`);
        }
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
            });
        this.state = "connected";
        this.log.info(`${this.retries > 0 ? "Reconnected to the platform" : "Connected to the platform"} as "${this.cfg.name}" (agent ${hello.agentId.slice(0, 12)}, project ${hello.projectId.slice(0, 12)}).`);
        this.opts.updater?.connected(hello.agentId, hello.update);
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
