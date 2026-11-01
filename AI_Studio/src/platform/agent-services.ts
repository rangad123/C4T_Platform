/**
 * Runner agents, the platform side: who may connect (tokens), who is connected (registry), the queue of tasks, the executor that
 * sends a run's scripts to an agent and brings the result back, and the rules that route a project's runs there or refuse them.
 *
 * Only script EXECUTION goes to the agent. Analysis (discovery, planning, writing tests), plain-English authoring, repair, healing
 * and vision judging still run on the platform: they need the model and the browser-driving loop.
 *
 * Security notes (the doc has the long version): a token belongs to one runner, which serves only the projects given access to it (runner_access); only the agent that claimed a task may heartbeat,
 * download for, upload to or answer it; every file name is checked and anchored under the task's own folder; uploads are streamed
 * with a size cap and hashed here; the task payload and the result are encrypted at rest and every credential of the run is scrubbed
 * from whatever the agent sends back before it is stored.
 */
import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { describeBrowser } from "../engine/browsers/choice.js";
import { PROTOCOL_VERSION, ResultRequest, SafeName, TaskOffer, WebBrowserUsed, type Capabilities, type HelloRequest, type DeviceCommand, type DevicePush, type HeartbeatRequest, type RecordCommand, type RecordingPush, type WireRun } from "../agent-protocol/schema.js";
import { CLEANUP_STATUSES, countItems, summaryLine, type CleanupStatus, type FinishedItem } from "../engine/cleanup/ledger.js";
import { parseEvidence } from "../engine/evidence/model.js";
import { adapterForSpec, defaultAdapterFor, getAdapter, IOS_ADAPTER_ID, setExecutorResolver } from "../engine/frameworks/index.js";
import type { ExecutionBatch, ExecutionEnv, ExecutionOptions, ExecutorScope, ScriptExecutor, ScriptRun } from "../engine/frameworks/types.js";
import { mobileAvailability } from "../engine/mobile/toolchain.js";
import type { TestSpec } from "../engine/spec/schema.js";
import { secretsOfRun } from "../engine/evidence/model.js";
import { agentDesktopProblem, assertHostDesktop, desktopApps } from "./desktop-guard.js";
import { desktopUnavailableReason, lastProbe, probeDesktop } from "../engine/desktop/probe.js";
import type { Platform } from "./bootstrap.js";
import { AgentStore, MAX_OFFERS, ONLINE_MS, type AgentRecord, type AgentTokenRecord, type DeviceNeed, type RunnerSetting, type TaskFile, type TaskRecord } from "./agent-store.js";
import { androidSummary, bearerToken, capabilityProblem, deviceNeedOf, envSecrets, RateLimiter, scrubSecrets, toWireEnv } from "./agent-routing.js";
import { DeviceHub, deviceAgentOf, isDeviceAdapter } from "./agent-device.js";
import { isRecordAdapter, RecordHub, RemoteDriver, recordAdapterId, recordAgentOf, recordJobId, type RemoteInit } from "./agent-record.js";
import { IdentityStore } from "./identity-store.js";
import { CleanupStore } from "./cleanup-store.js";
import { HttpError } from "./http-error.js";
import { hashObject, keyOfStoredFile, localCopyIn, validKey } from "./object-store.js";
import { assertAllowedTarget } from "./net-guard.js";
import type { JobOptions, JobRow } from "./repo.js";
import { SecretBox } from "./secrets.js";

export const NO_AGENT_MESSAGE = "No runner agent is connected for this project. Start one, or switch the project back to running here.";
/** iOS tests never run on the platform server: they need a Mac with Xcode, which only a runner agent can be. */
export const IOS_NEEDS_AGENT_MESSAGE = "iOS tests need a runner agent on a Mac with Xcode. Connect one and choose it for this project.";

/** Knobs, readable from the environment so tests (and unusual installs) can shorten the waits. */
export interface AgentLimits {
    pollSeconds: number;
    heartbeatSeconds: number;
    leaseSeconds: number;
    maxFileBytes: number;
    /** Everything one task may upload. */
    taskMaxBytes: number;
    taskMaxFiles: number;
    /** A queued task fails when no capable agent has been online for this long. */
    noAgentGraceMs: number;
    /** How often the executor looks at its task. */
    watchMs: number;
}

export function agentLimits(env: NodeJS.ProcessEnv = process.env): AgentLimits {
    const num = (name: string, def: number, min: number, max: number) => {
        const n = Number(env[name]);
        return Number.isFinite(n) && env[name] !== undefined && env[name] !== "" ? Math.min(max, Math.max(min, n)) : def;
    };
    return {
        pollSeconds: Math.round(num("AGENT_POLL_SECONDS", 25, 1, 55)),
        heartbeatSeconds: Math.round(num("AGENT_HEARTBEAT_SECONDS", 10, 1, 30)),
        leaseSeconds: Math.round(num("AGENT_LEASE_SECONDS", 60, 2, 600)),
        maxFileBytes: Math.round(num("AGENT_MAX_FILE_BYTES", 64 * 1024 * 1024, 1024, 512 * 1024 * 1024)),
        taskMaxBytes: Math.round(num("AGENT_TASK_MAX_BYTES", 512 * 1024 * 1024, 1024, 4 * 1024 * 1024 * 1024)),
        taskMaxFiles: Math.round(num("AGENT_TASK_MAX_FILES", 300, 1, 2000)),
        noAgentGraceMs: Math.round(num("AGENT_NO_AGENT_GRACE_SECONDS", 90, 0, 1800)) * 1000,
        watchMs: Math.round(num("AGENT_WATCH_MS", 1000, 20, 5000)),
    };
}

/** The failure of the run itself, not of a test: the agent could not run the tests, or was lost. Never a test verdict. */
export class RunnerAgentError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });

const SAFE_PATH = /^\/[^\s?#\u0000-\u001f]*$/;

/**
 * The cleanup ledger an agent reports for one test. A line that already says what became of the record (status) is kept as is.
 * A raw "created" line (the agent did not remove it) is kept as "failed": the record is still in the application.
 */
export function ledgerFromAgent(lines: Array<Record<string, unknown>> | undefined, testId: string, defaults: { origin?: string; environment?: string }, firstSeq: number): FinishedItem[] {
    const items: FinishedItem[] = [];
    let seq = firstSeq;
    const okPath = (v: unknown): v is string => typeof v === "string" && v.length <= 1000 && SAFE_PATH.test(v) && !v.startsWith("//");
    for (const o of lines ?? []) {
        if (!o || typeof o !== "object") continue;
        const idRaw = typeof o.id === "string" ? o.id : typeof o.recordId === "string" ? o.recordId : undefined;
        if (!okPath(o.path) || !idRaw || idRaw.length > 200 || /[\u0000-\u001f]/.test(idRaw)) continue;
        const at = typeof o.createdAt === "string" ? o.createdAt : typeof o.at === "string" ? o.at : undefined;
        const createdAt = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
        const base = { testId, seq: seq++, method: "POST" as const, path: o.path, id: idRaw, createdAt, ...(defaults.origin ? { origin: defaults.origin } : {}), ...(defaults.environment ? { environment: defaults.environment } : {}) };
        if (typeof o.status === "string" && (CLEANUP_STATUSES as string[]).includes(o.status)) {
            items.push({ ...base, ...(okPath(o.deletePath) ? { deletePath: o.deletePath } : {}), status: o.status as CleanupStatus, ...(typeof o.reason === "string" && o.reason ? { reason: o.reason.slice(0, 300) } : {}) });
        } else if (o.k === "created") {
            items.push({ ...base, status: "failed", reason: "The runner agent did not say whether this record was removed, so it may still be in the application." });
        } else seq--;
    }
    return items;
}

const FILE_NAME_SHA = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** How often a poll may sweep expired leases (a lease is a minute or more, so a few seconds late changes nothing). */
export const SWEEP_EVERY_MS = 5_000;

export class AgentService {
    readonly store: AgentStore;
    readonly limits: AgentLimits;
    private readonly secrets: SecretBox;
    private readonly helloLimit: RateLimiter;
    private readonly generalLimit: RateLimiter;
    /** The long-poll in flight per agent: a new poll replaces the old one (one at a time per agent). */
    private readonly polls = new Map<string, () => void>();
    /** When offerTo last swept expired leases: polling runners ask four times a second, the sweep (a write transaction) runs at most every SWEEP_EVERY_MS. */
    private lastSweepMs = Number.NEGATIVE_INFINITY;
    private apkHashes = new Map<string, { size: number; mtimeMs: number; sha: string }>();
    private lastPrune = 0;
    /** Recordings that live on an agent, by record task id (see agent-record.ts). */
    readonly records = new RecordHub();
    /** Phone sessions that live on an agent, by device task id (see agent-device.ts). */
    readonly devices = new DeviceHub();

    constructor(
        readonly p: Platform,
        opts: { clock?: () => number; limits?: Partial<AgentLimits> } = {},
    ) {
        this.clock = opts.clock ?? Date.now;
        this.store = new AgentStore(p.db, this.clock);
        this.limits = { ...agentLimits(), ...opts.limits };
        this.secrets = new SecretBox(p.config.dataDir, p.config.SECRET_KEY);
        this.helloLimit = new RateLimiter(6, 60_000, this.clock);
        this.generalLimit = new RateLimiter(900, 60_000, this.clock);
    }
    readonly clock: () => number;

    // ── who may connect ─────────────────────────────────────────────────────

    /** The token behind an `Authorization` header. Missing or malformed: 401. Unknown or revoked: 404 (the two look the same). */
    authenticate(header: string | string[] | undefined): AgentTokenRecord {
        const presented = bearerToken(header);
        if (!presented) throw new HttpError(401, "Missing runner agent token (send Authorization: Bearer aitg_...)");
        const token = this.store.findToken(presented);
        if (!token) throw new HttpError(404, "This runner agent token is not valid or was revoked.");
        this.store.touchToken(token.id);
        return token;
    }

    /** Per-token request budget (polls are limited separately: one at a time per agent). */
    throttle(token: AgentTokenRecord, kind: "hello" | "other"): void {
        const ok = kind === "hello" ? this.helloLimit.take(token.id) : this.generalLimit.take(token.id);
        if (!ok) throw new HttpError(429, kind === "hello" ? "Too many connection attempts from this runner agent. Wait a minute." : "Too many requests from this runner agent. Slow down.");
    }

    hello(token: AgentTokenRecord, body: HelloRequest) {
        if (body.protocol !== PROTOCOL_VERSION) throw new HttpError(409, `This runner agent speaks protocol ${body.protocol} and the platform speaks protocol ${PROTOCOL_VERSION}. Update the agent.`);
        // One token stands for one agent: it is what ties a task to the agent that claimed it.
        const other = this.store.agentsOfToken(token.id).find((a) => a.name !== body.name && this.clock() - a.lastSeenMs <= ONLINE_MS);
        if (other) throw new HttpError(409, `This token is already used by the agent “${other.name}”, which is online. Make a token for each machine.`);
        const agent = this.store.upsertAgent(token, body);
        return {
            agentId: agent.id,
            // Always a string, as protocol 1 says. An installed runner only prints it; a runner registered on the Runners page has no project of its own.
            projectId: token.projectId ?? "shared",
            protocol: PROTOCOL_VERSION,
            pollSeconds: this.limits.pollSeconds,
            heartbeatSeconds: this.limits.heartbeatSeconds,
            maxFileBytes: this.limits.maxFileBytes,
            serverTime: new Date(this.clock()).toISOString(),
        };
    }

    /** The agent a token's poll speaks for (it must be one this token registered). */
    agentOf(token: AgentTokenRecord, agentId: string): AgentRecord {
        const a = this.store.getAgent(agentId);
        if (!a || a.tokenId !== token.id) throw new HttpError(404, "This runner agent is not registered. Connect again.");
        return a;
    }

    /**
     * Hand this agent the oldest queued task it can run, from any project its runner has access to, or nothing. A task whose device
     * another task holds stays queued and the next one is tried, so a busy phone does not hold up browser work.
     */
    offerTo(agent: AgentRecord, freeSlots: number): TaskOffer | undefined {
        if (freeSlots < 1) return undefined;
        if (this.clock() - this.lastSweepMs >= SWEEP_EVERY_MS) {
            this.lastSweepMs = this.clock();
            this.store.sweep();
        }
        if (this.store.runningCount(agent.id) >= agent.concurrency) return undefined;
        for (const t of this.store.queuedFor(agent.tokenId)) {
            const setting = this.store.getRunner(t.projectId);
            const pinnedElsewhere = setting.runOn === "agent" && Boolean(setting.agentId) && setting.agentId !== agent.id;
            // A record task goes only to the agent the recording was started on (and only if it can record), whatever the project's runner setting says.
            if (isRecordAdapter(t.adapterId)) {
                if (recordAgentOf(t.adapterId) !== agent.id || agent.capabilities.record !== true) continue;
                const rec = this.store.claimFor(t.id, agent, this.limits.leaseSeconds * 1000);
                if (!rec) continue;
                return { ...this.secrets.decrypt<TaskOffer>(rec.payloadEnc), leaseSeconds: this.limits.leaseSeconds };
            }
            // A phone session likewise goes only to the agent it was started on, and only if that agent reports it can host one (an older agent never sees it).
            if (isDeviceAdapter(t.adapterId)) {
                if (deviceAgentOf(t.adapterId) !== agent.id || agent.capabilities.deviceSession !== true) continue;
                const dev = this.store.claimFor(t.id, agent, this.limits.leaseSeconds * 1000, this.deviceOf(t));
                if (!dev) continue;
                return { ...this.secrets.decrypt<TaskOffer>(dev.payloadEnc), leaseSeconds: this.limits.leaseSeconds };
            }
            if (pinnedElsewhere) continue;
            const adapter = this.adapterOrUndefined(t.adapterId);
            if (!adapter || capabilityProblem(adapter, agent.capabilities)) continue;
            // A task with hand-written scripts goes only to an agent whose owner agreed to run them (it reports customScripts), and never to a
            // shared runner (no organisation, no project): one customer's code must not run on a machine that serves others.
            if ((agent.capabilities.customScripts !== true || this.isSharedRunner(agent)) && this.hasCustomScripts(t)) continue;
            const claimed = this.store.claimFor(t.id, agent, this.limits.leaseSeconds * 1000, this.deviceOf(t));
            if (!claimed) continue;
            const offer = this.secrets.decrypt<TaskOffer>(claimed.payloadEnc);
            return { ...offer, leaseSeconds: this.limits.leaseSeconds };
        }
        return undefined;
    }

    /** A Crowd4Test shared runner: its token belongs to no organisation and no project. An unknown token counts as shared (fail closed). */
    private isSharedRunner(agent: AgentRecord): boolean {
        const t = this.store.getToken(agent.tokenId);
        return !t || (t.organizationId === null && t.projectId === null);
    }

    /** The device a queued task will hold on its runner. An unreadable task holds them all: it can never share a phone by accident. */
    private deviceOf(t: TaskRecord): DeviceNeed | undefined {
        const family = t.adapterId === IOS_ADAPTER_ID ? "ios" : t.adapterId === "taqwright" || isDeviceAdapter(t.adapterId) ? "android" : undefined;
        if (!family) return undefined;
        try {
            return deviceNeedOf(this.secrets.decrypt<TaskOffer>(t.payloadEnc));
        } catch {
            return { family, device: "*" };
        }
    }

    /** Register a long-poll; the returned function says whether a newer poll of the same agent replaced it. */
    beginPoll(agentId: string): { superseded: () => boolean; end: () => void } {
        this.polls.get(agentId)?.();
        let gone = false;
        const mark = () => void (gone = true);
        this.polls.set(agentId, mark);
        return { superseded: () => gone, end: () => void (this.polls.get(agentId) === mark && this.polls.delete(agentId)) };
    }

    private adapterOrUndefined(id: string) {
        try {
            return getAdapter(id);
        } catch {
            return undefined;
        }
    }

    /** The task, if this token's agent is the one that claimed it. Everything else (unknown, another project's, someone else's) is "not found". */
    ownedTask(token: AgentTokenRecord, taskId: string): TaskRecord {
        const t = this.store.getTask(taskId);
        const owner = t?.agentId ? this.store.getAgent(t.agentId) : undefined;
        if (!t || !owner || owner.tokenId !== token.id) throw new HttpError(404, "Task not found.");
        this.store.touchAgent(owner.id);
        return t;
    }

    heartbeat(token: AgentTokenRecord, taskId: string, beat: HeartbeatRequest): { cancel: boolean; leaseSeconds: number; commands?: RecordCommand[]; deviceCommands?: DeviceCommand[] } {
        const t = this.ownedTask(token, taskId);
        const leaseSeconds = this.limits.leaseSeconds;
        if (t.status !== "running") return { cancel: true, leaseSeconds };
        // A recording shows no progress lines: whatever an agent puts in `log` for one is not kept.
        this.store.heartbeat(taskId, t.agentId!, leaseSeconds * 1000, { done: beat.done, total: beat.total, log: isRecordAdapter(t.adapterId) || isDeviceAdapter(t.adapterId) ? undefined : beat.log });
        if (isDeviceAdapter(t.adapterId)) {
            // A phone session: the reply carries what the explorer asked. A session the platform no longer knows (it restarted) is given up.
            const session = this.devices.get(taskId);
            if (!session) return { cancel: true, leaseSeconds };
            const r = session.onHeartbeat();
            return { cancel: r.cancel, leaseSeconds, ...(r.commands.length ? { deviceCommands: r.commands } : {}) };
        }
        if (isRecordAdapter(t.adapterId)) {
            // A recording: the reply carries the page's commands. A recording the platform no longer knows (it restarted) is given up.
            const driver = this.records.get(taskId);
            if (!driver) return { cancel: true, leaseSeconds };
            const r = driver.onHeartbeat();
            return { cancel: r.cancel, leaseSeconds, ...(r.commands.length ? { commands: r.commands } : {}) };
        }
        this.surfaceProgress(t, beat.log);
        return { cancel: this.store.getTask(taskId)?.cancelRequested ?? false, leaseSeconds };
    }

    /** The registered file an agent asks to download for its own running task. */
    downloadable(token: AgentTokenRecord, taskId: string, ref: string): { file: TaskFile; key: string } {
        const t = this.ownedTask(token, taskId);
        if (t.status !== "running") throw new HttpError(404, "Task not found.");
        const file = this.store.getFile(taskId, "in", ref);
        if (!file) throw new HttpError(404, "File not found.");
        return { file, key: validKey(file.path) };
    }

    /** Where an upload for this task goes, after every check that does not need the bytes. */
    uploadTarget(token: AgentTokenRecord, taskId: string, name: string): { task: TaskRecord; key: string } {
        const t = this.ownedTask(token, taskId);
        if (t.status !== "running") throw new HttpError(409, "This task is no longer running; nothing more can be uploaded.");
        const relDir = path.posix.join(t.projectId, "_agent", t.id, "out");
        let key: string;
        try {
            if (!SafeName.safeParse(name).success) throw new Error("unsafe file name");
            key = validKey(path.posix.join(relDir, name));
        } catch {
            throw new HttpError(400, "Unsafe file name.");
        }
        const totals = this.store.uploadedTotals(taskId);
        if (totals.count >= this.limits.taskMaxFiles && !this.store.getFile(taskId, "out", name)) throw new HttpError(413, "This task has uploaded too many files.");
        return { task: t, key };
    }

    recordUpload(task: TaskRecord, name: string, rel: string, size: number, sha256: string): void {
        this.store.addFile({ taskId: task.id, direction: "out", ref: name, path: rel, size, sha256 });
    }

    /** The agent's final word. Accepted once; the cleanup and files are looked at by the executor that waits for it. */
    result(token: AgentTokenRecord, taskId: string, body: ResultRequest): { ok: true } {
        const t = this.ownedTask(token, taskId);
        if (t.status === "cancelled") return { ok: true };
        if (t.status !== "running") throw new HttpError(409, "A result for this task was already received.");
        if (isRecordAdapter(t.adapterId)) this.records.get(taskId)?.onResult(body);
        if (isDeviceAdapter(t.adapterId)) this.devices.get(taskId)?.onResult(body);
        const secrets = this.secretsOf(t);
        if (!body.ok) {
            const msg = scrubSecrets((body.error ?? "The runner agent could not run the tests.").slice(0, 500), secrets);
            if (!this.store.finish(taskId, t.agentId!, { status: "failed", error: msg })) throw new HttpError(409, "A result for this task was already received.");
            return { ok: true };
        }
        const clean = scrubSecrets(body, secrets);
        if (!this.store.finish(taskId, t.agentId!, { status: "done", resultEnc: this.secrets.encrypt(clean) })) throw new HttpError(409, "A result for this task was already received.");
        return { ok: true };
    }

    // ── recording on an agent ───────────────────────────────────────────────

    /** The agent's push of a recording's state. Only the claiming agent, only a record task that is still running, at most a few per second. */
    pushRecording(token: AgentTokenRecord, taskId: string, body: RecordingPush): { ok: true } {
        const t = this.ownedTask(token, taskId);
        if (!isRecordAdapter(t.adapterId)) throw new HttpError(409, "This task is not a recording.");
        if (t.status !== "running") throw new HttpError(409, "This recording has already ended.");
        const driver = this.records.get(taskId);
        if (!driver) throw new HttpError(404, "The platform no longer has this recording. The agent should stop it.");
        if (!driver.allowPush()) throw new HttpError(429, "Too many recording updates. Slow down.");
        driver.onPush(body);
        return { ok: true };
    }

    /** The agent's push about a phone session (its state and its answers). Only the claiming agent, only a device task that is still running, at most a few per second. */
    pushDevice(token: AgentTokenRecord, taskId: string, body: DevicePush): { ok: true } {
        const t = this.ownedTask(token, taskId);
        if (!isDeviceAdapter(t.adapterId)) throw new HttpError(409, "This task is not a phone session.");
        if (t.status !== "running") throw new HttpError(409, "This phone session has already ended.");
        const session = this.devices.get(taskId);
        if (!session) throw new HttpError(404, "The platform no longer has this phone session. The agent should stop it.");
        if (!session.allowPush()) throw new HttpError(429, "Too many phone session updates. Slow down.");
        session.onPush(body);
        return { ok: true };
    }

    /** Credentials the project knows, as exact strings: they are scrubbed from whatever an agent pushes about a recording. */
    projectSecrets(projectId: string): string[] {
        const out: string[] = [];
        try {
            const app = this.p.repo.getLatestApplicationPublic(projectId);
            const c = app ? this.p.repo.getApplication(String(app.id))?.credentials : undefined;
            if (c) out.push(c.password ?? "", c.totpSecret ?? "", c.apiToken ?? "", c.apiAuthHeader ?? "", c.oauth2?.clientSecret ?? "");
            for (const r of new IdentityStore(this.p.db, this.secrets).get(projectId)) out.push(r.password ?? "", r.totpSecret ?? "", r.apiToken ?? "");
        } catch {
            /* a project without credentials has nothing to scrub */
        }
        return out.filter((s) => s.length >= 4);
    }

    /** Asks an agent to record: queues the record task and returns the driver that mirrors the session for the web page. */
    startRecording(o: { projectId: string; agent: AgentRecord; startUrl: string; headed: boolean; environment?: string; caps: { idleMs: number; totalMs: number; maxSteps: number }; remote?: { lostContactMs?: number; claimWaitMs?: number; settleMs?: number; liveWaitMs?: number } }): RemoteDriver {
        const id = randomUUID();
        const taskId = randomUUID();
        const offer = TaskOffer.parse({
            taskId,
            jobId: recordJobId(id),
            adapterId: recordAdapterId(o.agent.id),
            leaseSeconds: this.limits.leaseSeconds,
            workers: 1,
            kind: "record",
            scripts: [],
            env: { baseUrl: o.startUrl, headless: !o.headed },
            record: {
                recordingId: id,
                startUrl: o.startUrl,
                headed: o.headed,
                idleMinutes: Math.min(120, Math.max(1, Math.ceil(o.caps.idleMs / 60_000))),
                totalMinutes: Math.min(480, Math.max(1, Math.ceil(o.caps.totalMs / 60_000))),
                maxSteps: Math.min(1000, Math.max(1, o.caps.maxSteps)),
            },
        });
        this.store.enqueue({ id: taskId, projectId: o.projectId, jobId: offer.jobId, adapterId: offer.adapterId, payloadEnc: this.encrypt(offer), files: [] });
        const init: RemoteInit = { id, projectId: o.projectId, taskId, agent: { id: o.agent.id, name: o.agent.name }, startUrl: o.startUrl, headed: o.headed, ...(o.environment ? { environment: o.environment } : {}), maxSteps: o.caps.maxSteps, ...(o.agent.capabilities.liveSession === true ? { live: true } : {}) };
        const driver = new RemoteDriver(
            {
                clock: this.clock,
                task: (tid) => this.store.getTask(tid),
                cancel: (tid) => this.store.requestCancel(tid),
                secrets: () => this.projectSecrets(o.projectId),
                ...(o.remote ?? {}),
            },
            init,
        );
        this.records.add(driver);
        return driver;
    }

    /**
     * The progress lines of a beat become job events right away (the live stream and the activity log show them as they arrive),
     * named after the agent, scrubbed of every credential of the run. An event is a convenience: a failure to write one never fails the beat.
     */
    private surfaceProgress(t: TaskRecord, lines: string[] | undefined): void {
        if (!lines?.length) return;
        try {
            const name = this.store.getAgent(t.agentId!)?.name ?? "agent";
            const secrets = this.secretsOf(t);
            for (const line of lines) {
                const text = scrubSecrets(line, secrets).replace(/\s+/g, " ").trim();
                if (text) this.p.repo.addEvent(t.jobId, { stage: "validation", kind: "agent_progress", level: "info", message: `${name}: ${text}`.slice(0, 400) });
            }
        } catch {
            /* the job may be gone; the beat itself still counts */
        }
    }

    private secretsOf(t: TaskRecord): string[] {
        try {
            const offer = this.secrets.decrypt<TaskOffer>(t.payloadEnc);
            const e = offer.env;
            return envSecrets({ credentials: e.credentials, roles: e.roles, apiToken: e.apiToken, apiAuthHeader: e.apiAuthHeader });
        } catch {
            return [];
        }
    }

    // ── where a project's runs go ───────────────────────────────────────────

    routesToAgent(projectId: string): boolean {
        return this.store.getRunner(projectId).runOn === "agent";
    }

    /** Does the queued task carry hand-written scripts? An unreadable task counts as yes: it is not offered to an agent that has not agreed. */
    private hasCustomScripts(t: { payloadEnc: string }): boolean {
        try {
            return this.secrets.decrypt<TaskOffer>(t.payloadEnc).scripts.some((s) => s.custom === true);
        } catch {
            return true;
        }
    }

    /** Online agents that may take this project's work (the chosen one, or any). */
    eligibleAgents(projectId: string, setting: RunnerSetting = this.store.getRunner(projectId)) {
        return this.store.listAgents(projectId).filter((a) => a.online && (!setting.agentId || a.id === setting.agentId));
    }

    /** Adapter ids a job's script execution will use. */
    adaptersFor(options: JobOptions): string[] {
        const ids = new Set<string>();
        const mode = options.mode ?? "generate";
        if (mode === "validate" || mode === "environment") {
            for (const id of options.testIds ?? []) {
                const t = this.p.repo.getTest(id);
                if (t) ids.add(adapterForSpec(t.spec).id);
            }
        } else if (mode === "variants") ids.add("playwright");
        else if (mode === "plain") {
            const kind = options.plainKind ?? (options.rewriteTestId ? this.p.repo.getTest(options.rewriteTestId)?.spec.kind : undefined) ?? "web";
            ids.add(defaultAdapterFor(kind === "api" ? "api" : "web").id);
        } else {
            const targets: Array<"web" | "api" | "mobile"> = options.targets?.length ? options.targets : ["web", "api"];
            for (const k of targets) ids.add(defaultAdapterFor(k).id);
        }
        return [...ids].filter((id) => this.adapterOrUndefined(id)?.executable);
    }

    /** The specs of the tests a job will run (validation-style jobs only). */
    private specsOf(options: JobOptions): TestSpec[] {
        const mode = options.mode ?? "generate";
        if (mode !== "validate" && mode !== "environment") return [];
        return (options.testIds ?? []).flatMap((id) => {
            const t = this.p.repo.getTest(id);
            return t ? [t.spec] : [];
        });
    }

    /** Refuse a job that cannot run where its project runs. Called by `Repo.createJob`. */
    assertJobAllowed(projectId: string, options: JobOptions): void {
        // An agent run uses the worker's own browser and cannot go to a runner yet (agent-run.ts), so no runner is needed for it.
        if (options.mode === "agent") return;
        const setting = this.store.getRunner(projectId);
        // Windows desktop tests start an application: the computer that runs them must be set up for it (allow-list), whoever runs them.
        const desktop = this.adaptersFor(options).includes("windows-uia") ? desktopApps(this.specsOf(options)) : [];
        const runsIos = this.adaptersFor(options).includes(IOS_ADAPTER_ID);
        if (setting.runOn !== "agent") {
            assertHostDesktop(desktop);
            if (runsIos) throw new HttpError(409, IOS_NEEDS_AGENT_MESSAGE);
            return;
        }
        const agents = this.eligibleAgents(projectId, setting);
        if (agents.length === 0) throw new HttpError(409, runsIos ? IOS_NEEDS_AGENT_MESSAGE : NO_AGENT_MESSAGE);
        for (const id of this.adaptersFor(options)) {
            const adapter = this.adapterOrUndefined(id)!;
            const problems = agents.map((a) => ({ a, why: capabilityProblem(adapter, a.capabilities) }));
            if (problems.every((x) => x.why)) {
                if (adapter.id === IOS_ADAPTER_ID) throw new HttpError(409, `iOS tests need a runner agent on a Mac with Xcode. ${agents.length === 1 ? `The connected runner agent “${agents[0]!.name}” can't run them` : "None of the connected runner agents can run them"}: ${problems[0]!.why}.`);
                const kind = adapter.kinds[0] === "api" ? "API" : (adapter.kinds[0] ?? adapter.id);
                throw new HttpError(409, agents.length === 1 ? `The connected runner agent “${agents[0]!.name}” can't run ${kind} tests: ${problems[0]!.why}.` : `None of the connected runner agents can run ${kind} tests: ${problems[0]!.why}.`);
            }
        }
        if (desktop.length > 0) {
            const capable = agents.filter((a) => !capabilityProblem(this.adapterOrUndefined("windows-uia")!, a.capabilities));
            const why = agentDesktopProblem(desktop, capable);
            if (why) throw new HttpError(409, why);
        }
        options.runOn = "agent";
    }

    /** What the Agents page shows about where this project's tests run. */
    runnerStatus(projectId: string) {
        const setting = this.store.getRunner(projectId);
        const all = this.store.listAgents(projectId);
        const eligible = all.filter((a) => a.online && (!setting.agentId || a.id === setting.agentId));
        const chosen = setting.agentId ? all.find((a) => a.id === setting.agentId) : undefined;
        if (setting.runOn === "platform") {
            const mobile = mobileAvailability();
            if (process.platform === "win32" && !lastProbe()) void probeDesktop();
            const windowsWhy = desktopUnavailableReason(process.platform, lastProbe());
            const phonesText = mobile.available ? "Phone tests can run on this server (Android tools were found)." : `Phone tests can't run on this server: ${mobile.reason ?? "no Android tools were found"}.`;
            return { runOn: "platform" as const, agentId: null, status: "Runs on this platform.", canRunWeb: true, canRunMobile: mobile.available, canRunWindows: !windowsWhy, canRunIos: false, phones: { canRun: mobile.available, text: phonesText }, unavailableReason: mobile.available ? null : `Mobile tests can't run here: ${mobile.reason ?? "no Android tools were found"}` };
        }
        const canWeb = eligible.some((a) => !capabilityProblem(getAdapter("playwright"), a.capabilities));
        const canMobile = eligible.some((a) => !capabilityProblem(getAdapter("taqwright"), a.capabilities));
        const canWindows = eligible.some((a) => !capabilityProblem(getAdapter("windows-uia"), a.capabilities));
        const canIos = eligible.some((a) => !capabilityProblem(getAdapter(IOS_ADAPTER_ID), a.capabilities));
        let status: string;
        if (chosen) status = `Runs on ${chosen.name} (${chosen.online ? "online" : "offline"}).`;
        else if (setting.agentId) status = "The agent chosen for this project no longer exists.";
        else status = eligible.length ? `Runs on any connected agent (${eligible.length} online).` : "No agent is connected.";
        let reason: string | null = null;
        if (eligible.length === 0) reason = chosen ? `${chosen.name} is offline.` : "No agent is connected.";
        else {
            const parts: string[] = [];
            if (!canWeb) parts.push(`Web and API tests can't run: ${capabilityProblem(getAdapter("playwright"), eligible[0]!.capabilities)}.`);
            if (!canMobile) parts.push(`Mobile tests can't run: ${capabilityProblem(getAdapter("taqwright"), eligible[0]!.capabilities)}.`);
            reason = parts.length ? parts.join(" ") : null;
        }
        // One sentence about phone tests, made from the same rule the agent card uses, so the two always agree.
        const phoneAgent = eligible.find((a) => !capabilityProblem(getAdapter("taqwright"), a.capabilities));
        const phonesText = phoneAgent
            ? `Phone tests can run on ${phoneAgent.name}. ${androidSummary(phoneAgent.capabilities.android).summary}.`
            : `Phone tests can't run: ${eligible.length === 0 ? (chosen ? `${chosen.name} is offline` : "no agent is connected") : capabilityProblem(getAdapter("taqwright"), eligible[0]!.capabilities)}.`;
        return { runOn: "agent" as const, agentId: setting.agentId, status, canRunWeb: canWeb, canRunMobile: canMobile, canRunWindows: canWindows, canRunIos: canIos, phones: { canRun: canMobile, text: phonesText }, unavailableReason: reason };
    }

    /** Where did this job run? Present for the kinds of job that run scripts. */
    ranOn(job: JobRow): { kind: "platform" } | { kind: "agent"; agentId: string; name: string; browser?: WebBrowserUsed } | undefined {
        const mode = job.options.mode ?? "generate";
        if (mode !== "validate" && mode !== "variants" && mode !== "environment") return undefined;
        const task = this.store.tasksOfJob(job.id).find((t) => t.agentId);
        const agentId = task?.agentId ?? (job.options.runOn === "agent" ? this.store.getRunner(job.projectId).agentId : null);
        if (!task && job.options.runOn !== "agent") return { kind: "platform" };
        const agent = agentId ? this.store.getAgent(agentId) : undefined;
        const browser = this.browserOfJob(job.id);
        return { kind: "agent", agentId: agentId ?? "", name: agent?.name ?? "A runner agent", ...(browser ? { browser } : {}) };
    }

    /** The browser the runner said its web tests used (the job's latest `agent_browser` event; see collect). Kept with the job's events, so it outlives the task. */
    private browserOfJob(jobId: string): WebBrowserUsed | undefined {
        try {
            const row = this.p.db.get<{ data_json: string | null }>("SELECT data_json FROM agent_events WHERE job_id = ? AND kind = 'agent_browser' ORDER BY id DESC LIMIT 1", jobId);
            const parsed = row?.data_json ? WebBrowserUsed.safeParse((JSON.parse(row.data_json) as { browser?: unknown }).browser) : undefined;
            return parsed?.success ? parsed.data : undefined;
        } catch {
            return undefined;
        }
    }

    executorFor(scope: ExecutorScope): ScriptExecutor {
        return new RemoteExecutor(this, scope);
    }

    // ── housekeeping ────────────────────────────────────────────────────────

    /** The scheduler's tick: expire leases, fail stale tasks, and once in a while remove old finished ones with their files. */
    async maintain(): Promise<void> {
        this.store.sweep();
        const now = this.clock();
        if (now - this.lastPrune < 10 * 60_000) return;
        this.lastPrune = now;
        for (const t of this.store.pruneTasks()) {
            await this.p.store.deletePrefix(path.posix.join(t.projectId, "_agent", t.id)).catch(() => undefined);
            // Copies of its uploads made on this machine for another store (localCopyIn in collect): none on local disk.
            await fsp.rm(path.join(this.p.config.scratchDir, "agent-files", t.id), { recursive: true, force: true }).catch(() => undefined);
        }
        this.store.pruneAgents();
        // A phone session that ended long ago no longer needs its driver here.
        this.devices.prune((d) => {
            const t = this.store.getTask(d.taskId);
            return Boolean(t) && (t!.status === "queued" || t!.status === "running" || this.clock() - (t!.finishedMs ?? 0) < 60 * 60_000);
        });
        // A recording that ended long ago no longer needs its driver here.
        this.records.prune((d) => {
            const t = this.store.getTask(d.taskId);
            return Boolean(t) && (t!.status === "queued" || t!.status === "running" || this.clock() - (t!.finishedMs ?? 0) < 60 * 60_000);
        });
    }

    // ── used by the executor ────────────────────────────────────────────────

    /** sha256 of the stored app file (its key), cached while the file does not change. */
    async apkHash(key: string): Promise<{ sha: string; size: number }> {
        const st = await this.p.store.head(key);
        if (!st) throw new Error("The app file is not stored.");
        const hit = this.apkHashes.get(key);
        if (hit && hit.size === st.size && hit.mtimeMs === st.modifiedMs) return { sha: hit.sha, size: st.size };
        const sha = await hashObject(this.p.store, key);
        this.apkHashes.set(key, { size: st.size, mtimeMs: st.modifiedMs, sha });
        return { sha, size: st.size };
    }

    encrypt(v: unknown): string {
        return this.secrets.encrypt(v);
    }
    decrypt<T>(blob: string): T {
        return this.secrets.decrypt<T>(blob);
    }
}

// ── the executor ────────────────────────────────────────────────────────────

class RemoteExecutor implements ScriptExecutor {
    readonly name = "agent";
    /** Tells the engine that scripts run elsewhere: a mobile run is planned against the agent's devices, not this machine's. */
    readonly remote = true;
    private seq = 0;

    constructor(
        private readonly svc: AgentService,
        private readonly scope: ExecutorScope,
    ) {}

    async execute(adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        const { svc } = this;
        const { projectId, jobId } = this.scope;
        if (!projectId || !jobId) throw new RunnerAgentError("This run cannot be sent to a runner agent because it does not belong to a project job.");
        if (opts.signal?.aborted) throw new Error("Job cancelled");
        const adapter = getAdapter(adapterId);
        // Same answer as a local run without a device.
        if (adapter.needs.android && !env.mobile) return batch.scripts.map((s): ScriptRun => ({ testId: s.testId, status: "error", durationMs: 0, error: "No Android device is set up for this run.", failedStepIndex: -1, steps: [], artifacts: [], responses: [] }));
        if (adapter.needs.ios && !env.ios) return batch.scripts.map((s): ScriptRun => ({ testId: s.testId, status: "error", durationMs: 0, error: "No iOS simulator is set up for this run.", failedStepIndex: -1, steps: [], artifacts: [], responses: [] }));

        const taskId = randomUUID();
        const files: Array<Omit<TaskFile, "taskId">> = [];
        const relIn = path.posix.join(projectId, "_agent", taskId, "in");
        let offer: TaskOffer;
        try {
            const scripts = [];
            let n = 0;
            for (const s of batch.scripts) {
                const baselines = [];
                for (const b of s.baselines ?? []) {
                    let bytes: Buffer;
                    try {
                        bytes = await fsp.readFile(b.path);
                    } catch {
                        throw new RunnerAgentError(`A saved baseline image for ${s.testId} could not be read, so the run was not sent to the agent.`);
                    }
                    const sha = FILE_NAME_SHA(bytes);
                    const ref = `b${n++}-${sha.slice(0, 12)}.png`;
                    await svc.p.store.put(path.posix.join(relIn, ref), bytes, { contentType: "image/png" });
                    files.push({ direction: "in", ref, path: path.posix.join(relIn, ref), size: bytes.length, sha256: sha });
                    baselines.push({ name: b.name, file: { ref, size: bytes.length, sha256: sha } });
                }
                scripts.push({ testId: s.testId, filename: s.filename, content: s.content, ...(baselines.length ? { baselines } : {}), ...(s.custom ? { custom: true } : {}), ...(s.session ? { session: true } : {}) });
            }
            let mobile: TaskOffer["mobile"];
            if (adapter.needs.android && env.mobile) {
                const t = env.mobile.target;
                let apk: NonNullable<TaskOffer["mobile"]>["apk"];
                if (t.apkPath) {
                    // Only a file inside the platform's own store is ever offered to an agent.
                    const rel = keyOfStoredFile(svc.p.store, t.apkPath, projectId);
                    if (!rel) throw new RunnerAgentError("The app file is not in this project's storage, so it cannot be sent to a runner agent. Upload it again.");
                    const { sha, size } = await svc.apkHash(rel).catch(() => {
                        throw new RunnerAgentError("The app file could not be read, so the run was not sent to the agent.");
                    });
                    const ref = `app-${sha.slice(0, 12)}.apk`;
                    apk = { ref, size, sha256: sha };
                    files.push({ direction: "in", ref, path: rel, size, sha256: sha });
                }
                mobile = { ...(t.appPackage ? { appPackage: t.appPackage } : {}), ...((env.mobile.avd || t.avd) ? { avd: env.mobile.avd || t.avd } : {}), ...(apk ? { apk } : {}), ...(env.mobile.keepEmulator ? { keepEmulator: true } : {}),
                    // Round 24: the runner applies the project's device choice itself (the phone the AI explored on, a named phone, an emulator).
                    ...(t.runsOn && t.runsOn.kind !== "auto" && t.runsOn.kind !== "farm" ? { runsOn: t.runsOn } : {}),
                    ...(t.exploredOn ? { exploredOn: { serial: t.exploredOn.serial, ...(t.exploredOn.model ? { model: t.exploredOn.model } : {}), emulator: t.exploredOn.emulator } } : {}) };
            }
            // iOS: the app (already installed on the simulator) and which simulator; no file travels.
            let ios: TaskOffer["ios"];
            if (adapter.needs.ios && env.ios) {
                const t = env.ios.target;
                ios = { ...(t.iosBundleId ? { bundleId: t.iosBundleId } : {}), ...(t.simulator ? { simulator: t.simulator } : {}), ...(env.ios.defaultSimulator ? { defaultSimulator: env.ios.defaultSimulator } : {}), ...(env.ios.keepSimulator ? { keepSimulator: true } : {}) };
            }
            // A device framework never gets the web credentials (the local mobile runner does not pass them either).
            const wireEnv = toWireEnv(adapter.needs.android || adapter.needs.ios ? { baseUrl: env.run.baseUrl, headless: env.run.headless } : env.run);
            offer = TaskOffer.parse({
                taskId,
                jobId,
                adapterId,
                leaseSeconds: svc.limits.leaseSeconds,
                workers: Math.min(8, Math.max(1, Math.round(opts.workers || 1))),
                ...(opts.timeoutMs !== undefined ? { timeoutMs: Math.round(opts.timeoutMs) } : {}),
                ...(opts.testTimeoutMs !== undefined ? { testTimeoutMs: Math.round(opts.testTimeoutMs) } : {}),
                ...(opts.startTimeoutMs !== undefined ? { startTimeoutMs: Math.round(opts.startTimeoutMs) } : {}),
                ...(opts.projects?.length ? { projects: opts.projects.map((p) => ({ name: p.name, device: p.device, ...(p.viewport ? { viewport: p.viewport } : {}) })) } : {}),
                scripts,
                // Shared helper modules of hand-written scripts; the agent writes them next to the scripts (and only if it was started with --allow-custom-scripts).
                ...(batch.helpers?.length && batch.scripts.some((s) => s.custom) ? { helpers: batch.helpers } : {}),
                env: wireEnv,
                ...(mobile ? { mobile } : {}),
                ...(ios ? { ios } : {}),
            });
        } catch (e) {
            if (e instanceof RunnerAgentError) throw e;
            throw new RunnerAgentError(`These tests cannot be sent to a runner agent: ${e instanceof Error ? e.message.split("\n")[0] : "invalid run"}`);
        }

        const secrets = envSecrets(env.run);
        svc.store.enqueue({ id: taskId, projectId, jobId, adapterId, payloadEnc: svc.encrypt(offer), files });
        const emit = (message: string, level: "info" | "warn" = "info", kind = "agent_task") => {
            try {
                svc.p.repo.addEvent(jobId, { stage: "validation", kind, level, message });
            } catch {
                /* an event is a convenience */
            }
        };
        emit(`Sent ${batch.scripts.length} script(s) to a runner agent.`, "info", "agent_task_queued");

        const deadline = svc.clock() + (opts.timeoutMs ? opts.timeoutMs + 5 * 60_000 : 4 * 3_600_000);
        let announced = false;
        let logSeen = 0;
        let noAgentSince: number | undefined;
        for (;;) {
            if (opts.signal?.aborted) {
                svc.store.requestCancel(taskId);
                throw new Error("Job cancelled");
            }
            svc.store.sweep();
            const t = svc.store.getTask(taskId);
            if (!t) throw new RunnerAgentError("The run was removed before it finished.");
            if (t.status === "queued") {
                // A task with hand-written scripts waits for an agent that was started with --allow-custom-scripts.
                const needsCustom = batch.scripts.some((s) => s.custom);
                const capable = svc.eligibleAgents(projectId).some((a) => !capabilityProblem(adapter, a.capabilities) && (!needsCustom || a.capabilities.customScripts === true));
                if (capable) noAgentSince = undefined;
                else {
                    noAgentSince ??= svc.clock();
                    if (svc.clock() - noAgentSince >= svc.limits.noAgentGraceMs) {
                        svc.store.failQueuedOrRunning(taskId, "No runner agent that can run these tests is connected. Start one, or switch the project back to running here.");
                    }
                }
            } else if (t.status === "running") {
                if (!announced) {
                    announced = true;
                    const a = t.agentId ? svc.store.getAgent(t.agentId) : undefined;
                    emit(`Running on the runner agent “${a?.name ?? "agent"}”.`, "info", "agent_task_started");
                }
                for (const line of t.log.slice(logSeen)) (env.mobile ?? env.ios)?.log?.(scrubSecrets(line, secrets));
                logSeen = t.log.length;
            } else if (t.status === "done") {
                return this.collect(t, batch, env, opts, secrets);
            } else if (t.status === "cancelled") {
                throw new Error("Job cancelled");
            } else {
                throw new RunnerAgentError(t.error ?? "The runner agent could not run the tests.");
            }
            if (svc.clock() > deadline) {
                svc.store.requestCancel(taskId);
                svc.store.failQueuedOrRunning(taskId, "The runner agent did not finish in time.");
                throw new RunnerAgentError("The runner agent did not finish in time.");
            }
            await sleep(svc.limits.watchMs, opts.signal);
        }
    }

    /** Turn the agent's wire result into the ScriptRun[] a local run would have returned: files rewritten to local paths, the cleanup ledger stored. */
    private async collect(task: TaskRecord, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions, secrets: string[]): Promise<ScriptRun[]> {
        const { svc } = this;
        const result = svc.decrypt<ResultRequest>(task.resultEnc!);
        // Which browser the runner's web tests used (additive in protocol 1): one plain line among the run's events, which the job's `ranOn` reads back.
        const used = result.browser === undefined ? undefined : WebBrowserUsed.safeParse(result.browser);
        if (used?.success) {
            try {
                const where = (task.agentId ? svc.store.getAgent(task.agentId)?.name : undefined) ?? "the runner's computer";
                svc.p.repo.addEvent(task.jobId, { stage: "validation", kind: "agent_browser", level: "info", message: `Ran in ${describeBrowser(used.data, where)}.`, data: { browser: used.data } });
            } catch {
                /* an event is a convenience */
            }
        }
        // The run's result names files on this machine (what a local run returns): on local disk the uploads themselves, otherwise copies
        // in the scratch folder that maintain() removes with the task (object-store.ts, localCopyIn).
        const scratch = path.join(svc.p.config.scratchDir, "agent-files", task.id);
        const localFiles = new Map<string, string>();
        for (const f of svc.store.filesOf(task.id, "out")) {
            try {
                localFiles.set(f.ref, await localCopyIn(svc.p.store, f.path, scratch));
            } catch {
                /* a bad path, or a file that vanished: as if it was never uploaded */
            }
        }
        const local = (ref: string): string | undefined => localFiles.get(ref);
        const known = new Set(batch.scripts.map((s) => s.testId));
        const evidenceSecrets = secretsOfRun(env.run);
        const cleanupOn = Boolean(env.run.cleanup);
        const origin = (() => {
            try {
                return new URL(env.run.apiBaseUrl ?? env.run.baseUrl).origin;
            } catch {
                return undefined;
            }
        })();
        const environment = svc.p.repo.getJob(task.jobId)?.options.environment;
        const ledger: FinishedItem[] = [];

        const runs: ScriptRun[] = [];
        for (const w of result.runs as WireRun[]) {
            if (!known.has(w.testId)) continue;
            const artifacts: ScriptRun["artifacts"] = [];
            for (const a of w.artifacts) {
                const file = local(a.ref);
                if (!file) continue; // named but never uploaded: skipped, as a missing file is for a local run
                if (a.kind === "evidence") {
                    // Defence in depth: the agent already masked it; it is parsed and masked again here before it is kept.
                    try {
                        const evidence = parseEvidence(await fsp.readFile(file, "utf8"), evidenceSecrets);
                        if (!evidence) continue;
                        await fsp.writeFile(file, JSON.stringify(evidence));
                    } catch {
                        continue;
                    }
                }
                artifacts.push({ kind: a.kind, path: file });
            }
            const run: ScriptRun = {
                testId: w.testId,
                status: w.status,
                durationMs: w.durationMs,
                ...(w.error !== undefined ? { error: w.error } : {}),
                failedStepIndex: w.failedStepIndex,
                steps: w.steps.map((s) => ({ index: s.index, title: s.title, status: s.status, ...(s.error !== undefined ? { error: s.error } : {}) })),
                artifacts,
                responses: w.responses.map((r) => ({ method: r.method, path: r.path, status: r.status, ...(r.obs !== undefined ? { obs: r.obs } : {}) })),
                ...(w.vision ? { vision: w.vision.flatMap((v) => (local(v.ref) ? [{ step: v.step, path: local(v.ref)!, ...(v.expected !== undefined ? { expected: v.expected } : {}) }] : [])) } : {}),
                ...(w.notes ? { notes: w.notes } : {}),
                ...(w.newBaselines ? { newBaselines: w.newBaselines.flatMap((b) => (local(b.ref) ? [{ name: b.name, path: local(b.ref)! }] : [])) } : {}),
                ...(w.metrics ? { metrics: w.metrics } : {}),
                ...(w.variant !== undefined ? { variant: w.variant } : {}),
            };
            if (run.vision && run.vision.length === 0) delete run.vision;
            if (run.newBaselines && run.newBaselines.length === 0) delete run.newBaselines;
            // The agent already removed (or tried to remove) what the test created; the platform stores that ledger and sends no DELETE of its own.
            if (cleanupOn && w.created?.length) ledger.push(...ledgerFromAgent(w.created, w.testId, { origin, ...(environment ? { environment } : {}) }, this.seq + ledger.length));
            runs.push(run);
        }
        this.seq += ledger.length;
        if (ledger.length) this.storeLedger(task, ledger);

        if (opts.projects?.length) return runs;
        return batch.scripts.map((s): ScriptRun => runs.find((r) => r.testId === s.testId) ?? { testId: s.testId, status: "error", durationMs: 0, error: "The runner agent returned no result for this script.", failedStepIndex: -1, steps: [], artifacts: [], responses: [] });
    }

    private storeLedger(task: TaskRecord, items: FinishedItem[]): void {
        const { svc } = this;
        try {
            new CleanupStore(svc.p.db).record({ projectId: task.projectId, jobId: task.jobId, items });
            const counts = countItems(items);
            svc.p.repo.addEvent(task.jobId, { stage: "validation", kind: "cleanup_finished", level: counts.leftBehind > 0 ? "warn" : "info", message: summaryLine(counts), data: { created: counts.created, removed: counts.removed, leftBehind: counts.leftBehind } });
        } catch (err) {
            console.error(`[agent] could not store the cleanup ledger of job ${task.jobId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
        }
    }
}

// ── wiring ──────────────────────────────────────────────────────────────────

const installed = new Map<Platform, AgentService>();

/** The agent services of a platform (created and wired once): the executor resolver, the job gate on its repo. */
export function getAgentServices(p: Platform, opts?: { clock?: () => number; limits?: Partial<AgentLimits> }): AgentService {
    const hit = installed.get(p);
    if (hit) return hit;
    const svc = new AgentService(p, opts);
    installed.set(p, svc);
    p.repo.jobGate = async (projectId, options) => svc.assertJobAllowed(projectId, options);
    // One process may hold several platforms (tests); each project belongs to the one whose database knows it.
    setExecutorResolver((scope) => {
        if (!scope.projectId) return undefined;
        for (const s of installed.values()) {
            try {
                if (s.routesToAgent(scope.projectId)) return s.executorFor(scope);
            } catch {
                /* a platform whose database is closed has no projects */
            }
        }
        return undefined;
    });
    return svc;
}

/** Forget a platform (tests that close their database). */
export function forgetAgentServices(p: Platform): void {
    installed.delete(p);
}

/** Where a job ran, for job objects. Undefined when this process has no agent services or the job is of a kind that runs no scripts. */
export function jobRanOn(job: JobRow): ReturnType<AgentService["ranOn"]> {
    for (const s of installed.values()) {
        try {
            if (s.p.repo.getJob(job.id)) return s.ranOn(job);
        } catch {
            /* closed database */
        }
    }
    return undefined;
}

/**
 * Is this project's work run on an agent? Then the address of the application is reached from the agent's network, so private and
 * loopback addresses are allowed for it (still http/https only, no credentials in the address). Every outbound call the platform makes
 * itself keeps the usual guard.
 */
export function projectRunsOnAgent(projectId: string): boolean {
    for (const s of installed.values()) {
        try {
            if (s.routesToAgent(projectId)) return true;
        } catch {
            /* closed database */
        }
    }
    return false;
}

export { MAX_OFFERS, ONLINE_MS };

/** Same question for iOS tests. Undefined for a project that runs here (iOS tests never run on the platform server). */
export function agentCanRunIos(projectId: string): boolean | undefined {
    for (const s of installed.values()) {
        try {
            if (s.routesToAgent(projectId)) return s.runnerStatus(projectId).canRunIos;
        } catch {
            /* closed database */
        }
    }
    return undefined;
}

/** The agent services that know this project (the phone explorer asks a runner for a phone through them). Undefined when this process has none. */
export function agentServiceOf(projectId: string): AgentService | undefined {
    for (const s of installed.values()) {
        try {
            if (s.p.repo.getProject(projectId)) return s;
        } catch {
            /* closed database */
        }
    }
    return undefined;
}

/**
 * For a project whose scripts run on a runner agent: can a connected agent run mobile tests? Undefined for a project that runs here
 * (the caller then asks this machine's own toolchain).
 */
export function agentCanRunMobile(projectId: string): boolean | undefined {
    for (const s of installed.values()) {
        try {
            if (s.routesToAgent(projectId)) return s.runnerStatus(projectId).canRunMobile;
        } catch {
            /* closed database */
        }
    }
    return undefined;
}

/**
 * The address a project's tests are run against. Run on a runner agent: reached from the agent's network, so private and loopback
 * addresses are fine (http/https only, no credentials in the address). Run here: the platform's usual outbound guard.
 */
export async function assertRunTarget(projectId: string, raw: string): Promise<void> {
    if (!projectRunsOnAgent(projectId)) return assertAllowedTarget(raw);
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new HttpError(400, "That is not a valid address.");
    }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "Only http(s) URLs can be tested");
    if (u.username || u.password) throw new HttpError(400, "The address must not contain a user name or password. Put credentials in the project's settings instead.");
}
