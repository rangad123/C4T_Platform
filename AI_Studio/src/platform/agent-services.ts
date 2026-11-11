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
import { KEY_HAS_NO_RUNNER, NO_RUNNER_MESSAGE, RUNNER_NOT_SET_UP, RUNNER_OFFLINE, RUNNER_SETTINGS_LINK, runnerRefusal, runnersOnly, SCHEDULE_HAS_NO_OWNER, TEAM_RUNNER_REFUSED, TRIGGER_HAS_NO_OWNER, type RunnerRefusalCode } from "./runner-only.js";
import { isHandedOver, isLeaseLoss, parkForHandover } from "./runner-handover.js";
import fsp from "node:fs/promises";
import path from "node:path";
import { describeBrowser } from "../engine/browsers/choice.js";
import { LIVE_EVENT_KINDS, PROTOCOL_VERSION, ResultRequest, SafeName, SUPERSEDED, SUPPORTED_PROTOCOLS, TaskOffer, WebBrowserUsed, type Capabilities, type HelloRequest, type DeviceCommand, type DevicePush, type EventsRequest, type HeartbeatRequest, type LiveEvent, type RecordCommand, type RecordingPush, type RejectRequest, type AgentPhase, type RunnerConfigPush, type TaskPhase, type WireRun } from "../agent-protocol/schema.js";
import { CLEANUP_STATUSES, countItems, summaryLine, type CleanupStatus, type FinishedItem } from "../engine/cleanup/ledger.js";
import { parseEvidence } from "../engine/evidence/model.js";
import { adapterForSpec, defaultAdapterFor, getAdapter, IOS_ADAPTER_ID, setExecutorResolver } from "../engine/frameworks/index.js";
import type { ExecutionBatch, ExecutionEnv, ExecutionOptions, ExecutorScope, ScriptExecutor, ScriptRun } from "../engine/frameworks/types.js";
import { mobileAvailability } from "../engine/mobile/toolchain.js";
import type { TestSpec } from "../engine/spec/schema.js";
import { secretsOfRun } from "../engine/evidence/model.js";
import { scrubTraceFile, traceSecretsOfRun } from "../engine/evidence/trace-scrub.js";
import { agentDesktopProblem, assertHostDesktop, desktopApps } from "./desktop-guard.js";
import { desktopUnavailableReason, lastProbe, probeDesktop } from "../engine/desktop/probe.js";
import type { Platform } from "./bootstrap.js";
import { AgentStore, jobOwnerId, MAX_OFFERS, NEVER_ACCEPTED, OPEN_OWNER_ID, ownerIdOfActor, refusalsOf, ONLINE_MS, type AgentRecord, type AgentTokenRecord, type DeviceNeed, type SweepChange, type TaskFile, type TaskRecord } from "./agent-store.js";
import { currentActor } from "./auth/actor.js";
import { crowd4testFromConfig } from "./auth/crowd4test.js";
import { isPrivateHost } from "./net-guard.js";
import type { EnrollRequest, EnrollResponse, RotateResponse, WireRunEnv } from "../agent-protocol/schema.js";
import { androidSummary, bearerToken, capabilityProblem, deviceNeedOf, envSecrets, liveEventData, liveEventMessage, negotiateProtocol, phaseSentence, RateLimiter, scrubSecrets, toWireEnv } from "./agent-routing.js";
import { DeviceHub, deviceAgentOf, isDeviceAdapter } from "./agent-device.js";
import { isRecordAdapter, RecordHub, RemoteDriver, recordAdapterId, recordAgentOf, recordJobId, type RemoteInit } from "./agent-record.js";
import { IdentityStore } from "./identity-store.js";
import { CleanupStore } from "./cleanup-store.js";
import { HttpError } from "./http-error.js";
import { hashObject, keyOfStoredFile, localCopyIn, validKey } from "./object-store.js";
import { assertAllowedTarget } from "./net-guard.js";
import type { JobOptions, JobRow } from "./repo.js";
import { SecretBox } from "./secrets.js";

/** A step of a runbook started by hand, resumed after a restart: its starter is not known here, so no runner may take it. */
export const RUNBOOK_STARTER_UNKNOWN = "This runbook was started before the platform restarted, and who started it is not known any more. Start it again to run it on your computer.";
export { KEY_HAS_NO_RUNNER, RUNNER_NOT_SET_UP, RUNNER_OFFLINE, RUNNER_SETTINGS_LINK, runnerRefusal, SCHEDULE_HAS_NO_OWNER, TEAM_RUNNER_REFUSED, TRIGGER_HAS_NO_OWNER, type RunnerRefusalCode };
/** Live events kept per task attempt (whichever comes first); past them one note, and the rest only in the final result. */
export const LIVE_EVENTS_MAX = 5_000;
export const LIVE_EVENT_BYTES_MAX = 5 * 1024 * 1024;
export const LIVE_EVENTS_TRUNCATED = "Too many live events; the rest are in the final result.";
/** iOS tests never run on the platform server: they need a Mac with Xcode, which only a runner agent can be. */
export const IOS_NEEDS_AGENT_MESSAGE = "iOS tests need a runner on a Mac with Xcode. Set up your runner on a Mac in Settings.";

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
    /** Protocol 2: how long an agent has to accept a task it was handed before it goes back to the queue. */
    acceptSeconds: number;
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
        acceptSeconds: Math.round(num("AGENT_ACCEPT_SECONDS", 30, 1, 300)),
    };
}

/** The failure of the run itself, not of a test: the agent could not run the tests, or was lost. Never a test verdict. */
export class RunnerAgentError extends Error {}

/** Who a run is for, as eligibility needs it (round 45: the run goes to that person's runner, nowhere else). */
export interface RunContext {
    /** The person whose run it is (a schedule's or trigger's: the person who made it; OPEN_OWNER_ID on an open server); null: nobody's. */
    ownerId: string | null;
}

export { jobOwnerId, OPEN_OWNER_ID };

/** Whose a job about to be made is: its recorded starter, else the person acting now (createJob records them only after its gates). */
export function ownerOfNewJob(options: JobOptions): string | null {
    if (options.startedBy) return jobOwnerId(options);
    return ownerIdOfActor(currentActor());
}

/**
 * Is this address private or local from a tester's point of view: loopback, private ranges, link-local (169.254.x), and names only a local
 * network knows (no dot, .local, .lan, .internal, .home.arpa, .localhost). Names that resolve privately are caught on the runner itself
 * (BLOCK_PRIVATE_TARGETS in every test it runs).
 */
export function looksPrivateAddress(raw: string): boolean {
    let host: string;
    try {
        host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    } catch {
        return false;
    }
    if (!host) return false;
    if (isPrivateHost(host)) return true;
    if (/^[0-9a-f:]+$/.test(host) && host.includes(":")) return false;
    if (/^\d+(\.\d+){3}$/.test(host)) return false;
    return !host.includes(".") || /\.(local|lan|internal|home\.arpa|localhost|localdomain|intranet)$/.test(host);
}

/** A credential presented from a computer other than the one it is bound to (the route adds an Activity entry). */
export class MachineRefused extends HttpError {
    constructor(readonly token: AgentTokenRecord) {
        super(409, "This runner's credential belongs to another computer, so this one was refused. Set up this computer from Settings to give it its own.");
    }
}

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
    /** Who each job is for, and the runner chosen for it (jobContext). */
    private readonly jobContexts = new Map<string, RunContext>();
    /** POST /api/agent/enroll, per address and per code (enroll). */
    private readonly enrollLimit: RateLimiter;
    private readonly enrollCodeLimit: RateLimiter;
    /** Recordings that live on an agent, by record task id (see agent-record.ts). */
    readonly records = new RecordHub();
    /** Phone sessions that live on an agent, by device task id (see agent-device.ts). */
    readonly devices = new DeviceHub();
    /**
     * The platform is stopping (a deploy): nothing new is handed to a runner, open polls end, and every job waiting for a runner parks so
     * it can be handed over to the next process with its runner task left running (runner-handover.ts). Never undone in this process.
     */
    draining = false;
    /** Runner tasks an executor in this process is waiting for right now: never picked up or stopped by another executor (RemoteExecutor). */
    readonly following = new Set<string>();

    drain(): void {
        this.draining = true;
    }

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
        // Per address (an office may add several computers at once) and, separately, per code (enroll keys them apart).
        this.enrollLimit = new RateLimiter(30, 60_000, this.clock);
        this.enrollCodeLimit = new RateLimiter(5, 60_000, this.clock);
        // The open server acts as one person (OPEN_OWNER_ID): its runner takes runs only while the server is open.
        this.store.openMode = () => !crowd4testFromConfig(p.config) && !p.config.API_KEY && Number(p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role IS NOT NULL")?.n ?? 0) === 0;
    }
    readonly clock: () => number;

    // ── who may connect ─────────────────────────────────────────────────────

    /** The token behind an `Authorization` header. Missing or malformed: 401. Unknown or revoked: 404 (the two look the same). */
    authenticate(header: string | string[] | undefined): AgentTokenRecord {
        const presented = bearerToken(header);
        if (!presented) throw new HttpError(401, "Missing runner agent token (send Authorization: Bearer aitg_...)");
        const token = this.store.findToken(presented);
        if (!token) throw new HttpError(404, "This runner agent token is not valid or was revoked.");
        // Round 45: only a person's own runner works. A team, shared or project runner is refused with the sentence (the runner stops, exit 3).
        if (token.kind !== "personal") throw new HttpError(401, TEAM_RUNNER_REFUSED);
        this.store.touchToken(token.id);
        return token;
    }

    /** Per-token request budget (polls are limited separately: one at a time per agent). */
    throttle(token: AgentTokenRecord, kind: "hello" | "other"): void {
        const ok = kind === "hello" ? this.helloLimit.take(token.id) : this.generalLimit.take(token.id);
        if (!ok) throw new HttpError(429, kind === "hello" ? "Too many connection attempts from this runner agent. Wait a minute." : "Too many requests from this runner agent. Slow down.");
    }

    hello(token: AgentTokenRecord, body: HelloRequest) {
        // Version negotiation (protocol 2): the highest version both speak. An agent that names no list speaks only `protocol` (every protocol-1 agent).
        const speak = negotiateProtocol(body);
        if (speak === undefined) throw new HttpError(409, `This runner agent speaks protocol ${body.protocol} and the platform speaks protocol ${PROTOCOL_VERSION}. Update the agent.`);
        // One token stands for one agent: it is what ties a task to the agent that claimed it.
        // The computer a credential is bound to (migration 51): the first install id it was used with. Another computer is refused; a runner
        // that sends no id keeps today's behaviour, unless its credential came from an enrollment code (such a runner always sends one).
        if (body.machineId) {
            if (token.machineId && token.machineId !== body.machineId) throw new MachineRefused(token);
            if (!token.machineId) this.store.bindMachine(token.id, body.machineId);
        } else if (token.machineId && token.kind === "personal") throw new MachineRefused(token);
        const other = this.store.agentsOfToken(token.id).find((a) => a.name !== body.name && (!body.machineId || a.machineId !== body.machineId) && this.clock() - a.lastSeenMs <= ONLINE_MS);
        if (other) throw new HttpError(409, `This runner's credential is already used by “${other.name}”, which is online. Set up each computer from Settings.`);
        const agent = this.store.upsertAgent(token, body);
        this.store.setAgentProtocol(agent.id, speak);
        return {
            agentId: agent.id,
            // Always a string, as protocol 1 says (the wire format is kept). An installed runner only prints it; a person's runner has no project of its own.
            projectId: token.projectId ?? "shared",
            protocol: speak,
            pollSeconds: this.limits.pollSeconds,
            heartbeatSeconds: this.limits.heartbeatSeconds,
            maxFileBytes: this.limits.maxFileBytes,
            serverTime: new Date(this.clock()).toISOString(),
            // What this runner is and what its switches allow (additive; an older agent ignores it), and whether its credential is due for a new one.
            runner: { id: token.id, kind: token.kind, ...this.runnerSwitches(token.id) },
            ...(this.store.rotationDue(token) || token.viaPrevious ? { rotate: true } : {}),
        };
    }

    /**
     * POST /api/agent/enroll: trade a single-use enrollment code for a runner credential. Limited per address and per code, so codes cannot be
     * guessed (they are 32 random bytes anyway). The answers say what to do in plain words; the code is never logged.
     */
    enroll(body: EnrollRequest, address: string): EnrollResponse {
        if (!this.enrollLimit.take(`ip:${address}`) || !this.enrollCodeLimit.take(createHash("sha256").update(body.code).digest("hex"))) {
            throw new HttpError(429, "Too many attempts to add a runner from this address. Wait a minute and try again.");
        }
        const out = this.store.redeemEnrollment(body.code, { name: body.name, machineId: body.machineId });
        if (!out.ok) {
            if (out.reason === "expired") throw new HttpError(410, "This code has expired. Download the runner again from Settings.");
            if (out.reason === "used") throw new HttpError(410, "This code was already used. Download the runner again from Settings.");
            if (out.reason === "team") throw new HttpError(410, TEAM_RUNNER_REFUSED);
            throw new HttpError(404, "This enrollment code is not valid. Download the runner again from Settings.");
        }
        return { token: out.secret, runnerId: out.token.id, kind: out.token.kind };
    }

    /** POST /api/agent/rotate: a new credential; the presented one keeps working until the new one is first used, at most 24 hours. */
    rotate(token: AgentTokenRecord, header: string | string[] | undefined): RotateResponse {
        const presented = bearerToken(header);
        const out = presented ? this.store.rotateToken(token.id, presented) : undefined;
        if (!out) throw new HttpError(404, "This runner agent token is not valid or was revoked.");
        return { token: out.secret, previousValidUntil: new Date(out.previousUntilMs).toISOString() };
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
        if (freeSlots < 1 || this.draining) return undefined;
        if (this.clock() - this.lastSweepMs >= SWEEP_EVERY_MS) {
            this.lastSweepMs = this.clock();
            this.sweep();
        }
        if (this.store.runningCount(agent.id) >= agent.concurrency) return undefined;
        const token = this.store.getToken(agent.tokenId);
        if (!token || token.revokedAt || token.kind !== "personal" || !token.ownerId) return undefined;
        // A person's runner looks at its owner's runs, wherever they are (round 45: the only runner there is).
        const candidates = this.store.queuedOfOwner(token.ownerId);
        for (const t of candidates) {
            // A runner that said no to a task (protocol 2 reject) is never offered it again.
            if (refusalsOf(t).some((r) => r.agentId === agent.id)) continue;
            // Recordings, live sessions and phone sessions: only the machine they were started on, and a person's own computer only for its owner's own sessions.
            if (isRecordAdapter(t.adapterId) || isDeviceAdapter(t.adapterId)) {
                const session = this.offerSession(agent, token, t);
                if (session) return session;
                continue;
            }
            if (!this.personalMayTake(token, t)) continue;
            const adapter = this.adapterOrUndefined(t.adapterId);
            if (!adapter || capabilityProblem(adapter, agent.capabilities)) continue;
            // A task with hand-written scripts goes only where its owner agreed to run them (mayRunCodeScripts).
            if (this.hasCustomScripts(t) && !this.mayRunCodeScripts(agent, token)) continue;
            // A private or local address only to a runner that allows them.
            if (!this.targetAllowed(token, t)) continue;
            const claimed = this.store.claimFor(t.id, agent, this.limits.leaseSeconds * 1000, this.deviceOf(t));
            if (!claimed) continue;
            return this.handOut(agent, claimed);
        }
        return undefined;
    }

    /**
     * A record or device task (a recording, a live session, a phone session) for this machine, or nothing: it goes only to the machine it
     * was started on, if that machine can host it, only when its owner started it and may still run the project's tests (a phone session
     * also needs a runner that understands the phone switches).
     */
    private offerSession(agent: AgentRecord, token: AgentTokenRecord, t: TaskRecord): TaskOffer | undefined {
        const record = isRecordAdapter(t.adapterId);
        if ((record ? recordAgentOf(t.adapterId) : deviceAgentOf(t.adapterId)) !== agent.id) return undefined;
        if (record ? agent.capabilities.record !== true : agent.capabilities.deviceSession !== true) return undefined;
        const starter = (record ? this.records.get(t.id) : this.devices.get(t.id))?.startedBy ?? null;
        if (token.kind !== "personal" || !token.ownerId || starter !== token.ownerId || !this.store.ownerMayRun(token.ownerId, t.projectId)) return undefined;
        if (!record && agent.capabilities.runnerSwitches !== true) return undefined;
        const claimed = this.store.claimFor(t.id, agent, this.limits.leaseSeconds * 1000, record ? undefined : this.deviceOf(t));
        return claimed ? this.handOut(agent, claimed) : undefined;
    }

    /**
     * Why an open recording, live session or phone session must end now: its starter can no longer run this project's tests, or the
     * computer was retired (removed, or another computer set up). Undefined: it may go on.
     * Asked on every beat of the session, so it ends within one heartbeat.
     */
    sessionAccessProblem(s: { projectId: string; startedBy: string | null; tokenId: string; personal: boolean }): string | undefined {
        if (s.personal) {
            const token = this.store.getToken(s.tokenId);
            if (!token || token.revokedAt) return "This computer was removed as a runner, so the session ended.";
        }
        if (s.startedBy && !this.store.ownerMayRun(s.startedBy, s.projectId)) return "The person who started this session can no longer use this project, so the session ended.";
        return undefined;
    }

    /**
     * The offer for a task this agent just claimed: a new attempt (fencing), and for a protocol-2 agent its attempt id and how long it has
     * to accept. A protocol-1 agent gets exactly the offer it always got. Where the job's scripts run is written down with the job.
     */
    private handOut(agent: AgentRecord, claimed: TaskRecord): TaskOffer {
        const protocol = this.store.agentProtocol(agent.id);
        const attempt = this.store.beginAttempt(claimed.id, agent.id, { protocol, acceptMs: this.limits.acceptSeconds * 1000 }) ?? claimed;
        const offer = { ...this.secrets.decrypt<TaskOffer>(claimed.payloadEnc), leaseSeconds: this.limits.leaseSeconds };
        this.noteRanOn(attempt, agent);
        if (attempt !== claimed && attempt.attempt > 1) this.emitTask(attempt, "runner_attempt", "info", `Offered to the runner “${agent.name}” (attempt ${attempt.attempt}).`, { attempt: attempt.attempt, agentId: agent.id });
        if (protocol < 2 || !attempt.attemptId) return offer;
        // The switches as they are now: one changed while this runner was idle reaches it with the task, not only at its next hello.
        const config = this.runnerConfig(agent);
        return { ...offer, attemptId: attempt.attemptId, attempt: attempt.attempt, acceptSeconds: this.limits.acceptSeconds, ...(config ? { config } : {}) };
    }

    // ── who a run is for, and which runners may take it (migration 51) ─────

    /** Who a job belongs to, read once per job (a job's options never change it). */
    jobContext(jobId: string): RunContext {
        const hit = this.jobContexts.get(jobId);
        if (hit) return hit;
        let ctx: RunContext = { ownerId: null };
        try {
            const job = this.p.repo.getJob(jobId);
            if (job) ctx = { ownerId: jobOwnerId(job.options) };
        } catch {
            /* a job that cannot be read is nobody's: no personal runner takes it */
        }
        if (this.jobContexts.size > 5000) this.jobContexts.clear();
        this.jobContexts.set(jobId, ctx);
        return ctx;
    }

    /** May hand-written (code) scripts go to this machine? The same rule for offering, the check when a run is made, and the executor's wait. */
    mayRunCodeScripts(agent: Pick<AgentRecord, "tokenId" | "capabilities">, token: AgentTokenRecord | undefined = this.store.getToken(agent.tokenId)): boolean {
        if (!token || token.revokedAt || token.kind !== "personal") return false;
        // Its owner's switch, applied by a runner that understands it (an older runner never gets them).
        return token.allowCodeScripts && agent.capabilities.runnerSwitches === true;
    }

    /** The switches as the platform holds them for a runner (the hello answer and, for protocol 2, heartbeats send them to it). */
    runnerSwitches(tokenId: string): { customScripts: boolean; privateTargets: boolean } {
        const t = this.store.getToken(tokenId);
        if (!t || t.revokedAt) return { customScripts: false, privateTargets: false };
        return { customScripts: t.kind === "personal" && t.allowCodeScripts, privateTargets: t.allowPrivateTargets };
    }

    /**
     * May this person's runner take this task? It is its owner's run (the candidates are read by agent_tasks.owner_id, and the claim checks
     * it again), and the owner may still run the project's tests (ownerMayRun also checks their role here).
     */
    private personalMayTake(token: AgentTokenRecord, t: { projectId: string }): boolean {
        if (token.kind !== "personal" || !token.ownerId) return false;
        return this.store.ownerMayRun(token.ownerId, t.projectId);
    }

    /** A run against a private or local address goes only to a runner that allows those (a runner whose owner did not switch them on refuses them too). */
    private targetAllowed(token: AgentTokenRecord, t: { payloadEnc: string }): boolean {
        if (token.allowPrivateTargets) return true;
        try {
            const env = this.secrets.decrypt<TaskOffer>(t.payloadEnc).env;
            return !looksPrivateAddress(env.baseUrl) && !(env.apiBaseUrl && looksPrivateAddress(env.apiBaseUrl));
        } catch {
            return false;
        }
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
        // A stopping platform ends every open poll at once, so a deploy does not wait for them (drain).
        return { superseded: () => gone || this.draining, end: () => void (this.polls.get(agentId) === mark && this.polls.delete(agentId)) };
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

    heartbeat(token: AgentTokenRecord, taskId: string, beat: HeartbeatRequest): { cancel: boolean; leaseSeconds: number; commands?: RecordCommand[]; deviceCommands?: DeviceCommand[]; timeout?: boolean; shutdown?: boolean; config?: RunnerConfigPush } {
        const t = this.ownedTask(token, taskId);
        this.assertAttempt(t, beat.attemptId);
        const leaseSeconds = this.limits.leaseSeconds;
        // Protocol 2: the platform's own time limit ended the run (the executor's deadline): stop now.
        if (t.status !== "running") return { cancel: true, leaseSeconds, ...(beat.attemptId && t.phase === "timed_out" ? { timeout: true } : {}) };
        // A recording shows no progress lines: whatever an agent puts in `log` for one is not kept. The lines are scrubbed before they are kept (they sit in the task for a day).
        const lines = isRecordAdapter(t.adapterId) || isDeviceAdapter(t.adapterId) ? undefined : beat.log ? this.scrubLines(t, beat.log) : undefined;
        // A protocol-1 beat means the scripts are running; a protocol-2 one says what the agent is doing.
        this.store.heartbeat(taskId, t.agentId!, leaseSeconds * 1000, { done: beat.done, total: beat.total, log: lines }, beat.attemptId ? beat.phase : "running");
        this.notePhase(t);
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
        this.surfaceProgress(t, lines);
        const cancel = this.store.getTask(taskId)?.cancelRequested ?? false;
        if (!beat.attemptId) return { cancel, leaseSeconds };
        // Protocol 2 only: the runner was retired (finish and exit), and its switches when they changed since this task was handed out.
        const agent = this.store.getAgent(t.agentId!);
        const shutdown = agent ? this.shutdownWanted(agent) : false;
        const config = agent ? this.configChange(t, agent) : undefined;
        return { cancel, leaseSeconds, ...(shutdown ? { shutdown: true } : {}), ...(config ? { config } : {}) };
    }

    /**
     * Protocol 2 hooks for the runner's own settings (owned by the runner identity code): should this runner finish and exit (it was retired
     * while working), and what its switches say now. Defaults: never, and nothing to tell.
     */
    shutdownWanted: (agent: AgentRecord) => boolean = (agent) => {
        // Retired (or unknown), or a person's own computer whose owner is gone or switched off here: finish what runs, take nothing new, exit.
        const t = this.store.getToken(agent.tokenId);
        if (!t || t.revokedAt) return true;
        if (t.kind !== "personal") return true;
        // The open server's runner: while the server is open (it acts as one person).
        if (t.ownerId === OPEN_OWNER_ID) return !this.store.openMode();
        const owner = t.ownerId ? this.p.db.get<{ status: string | null }>("SELECT status FROM users WHERE id = ? AND role IS NOT NULL", t.ownerId) : undefined;
        return !owner || owner.status !== "active";
    };
    runnerConfig: (agent: AgentRecord) => RunnerConfigPush | undefined = (agent) => {
        // What the runner should apply now: code scripts by the same rule as offering, and private addresses.
        const t = this.store.getToken(agent.tokenId);
        if (!t || t.revokedAt) return undefined;
        return { customScripts: this.mayRunCodeScripts(agent, t), privateTargets: t.allowPrivateTargets };
    };
    private readonly sentConfig = new Map<string, string>();
    /** Bytes of live events kept per "task:attempt" (the cap in `events`); bounded, oldest forgotten first. */
    private readonly liveEventBytes = new Map<string, number>();

    /** The runner's switches, when they differ from what this task was last told (the first beat records them without sending). */
    private configChange(t: TaskRecord, agent: AgentRecord): RunnerConfigPush | undefined {
        const now = this.runnerConfig(agent);
        if (!now) return undefined;
        const key = `${t.id}:${t.attemptId ?? ""}`;
        const text = JSON.stringify(now);
        const before = this.sentConfig.get(key);
        this.sentConfig.set(key, text);
        if (this.sentConfig.size > 2000) this.sentConfig.delete(this.sentConfig.keys().next().value!);
        return before !== undefined && before !== text ? now : undefined;
    }

    /** A message that names an attempt which is no longer the task's current one is refused (409, code "superseded"). Protocol 1 names none. */
    private assertAttempt(t: TaskRecord, attemptId: string | undefined): void {
        if (attemptId === undefined) return;
        if (t.attemptId !== attemptId) throw new HttpError(409, "This attempt of the task was replaced by a newer one. Stop it.", { code: SUPERSEDED });
    }

    /** Lines from an agent, scrubbed of the run's credentials (in every encoded form) before they are kept anywhere. */
    private scrubLines(t: TaskRecord, lines: string[]): string[] {
        const secrets = this.secretsOf(t);
        return lines.map((l) => scrubSecrets(l, secrets).slice(0, 300));
    }

    // ── protocol 2: accept, reject, live events ─────────────────────────────

    accept(token: AgentTokenRecord, taskId: string, attemptId: string): { ok: true; leaseSeconds: number } {
        const t = this.ownedTask(token, taskId);
        const leaseSeconds = this.limits.leaseSeconds;
        const r = this.store.accept(taskId, t.agentId!, attemptId, leaseSeconds * 1000);
        if (r === "superseded") throw new HttpError(409, "This attempt of the task was replaced by a newer one. Stop it.", { code: SUPERSEDED });
        if (r === "gone") throw new HttpError(410, "The platform no longer expects this task to run.");
        if (r === "accepted") this.notePhase(t);
        return { ok: true, leaseSeconds };
    }

    /** The runner will not run this attempt: it goes to another runner, and the run fails only when no runner that may take it is left. */
    reject(token: AgentTokenRecord, taskId: string, body: RejectRequest): { ok: true } {
        const t = this.ownedTask(token, taskId);
        const name = this.store.getAgent(t.agentId!)?.name ?? "A runner";
        const message = scrubSecrets(body.message, this.secretsOf(t)).replace(/\s+/g, " ").trim().slice(0, 300);
        const r = this.store.reject(taskId, t.agentId!, body.attemptId, { reason: body.reason, message });
        if (r.outcome === "superseded") throw new HttpError(409, "This attempt of the task was replaced by a newer one. Stop it.", { code: SUPERSEDED });
        if (r.outcome === "gone") return { ok: true };
        this.emitTask(t, "runner_rejected", "warn", `${name} did not take the run: ${message}`, { agentId: t.agentId, reason: body.reason, attempt: t.attempt });
        if (r.task) this.notePhase(t);
        return { ok: true };
    }

    /**
     * Live events of an attempt: each (task, attempt, seq) is kept once, scrubbed, as a job event the run's stream carries (and a refresh
     * replays). A screenshot event must name a file this attempt uploaded. A log line is also kept with the task, as heartbeat lines are.
     */
    events(token: AgentTokenRecord, taskId: string, body: EventsRequest): { ok: true; stored: number; duplicates: number } {
        const t = this.ownedTask(token, taskId);
        this.assertAttempt(t, body.attemptId);
        if (t.status !== "running") throw new HttpError(410, "The platform no longer expects events for this task.");
        if (isRecordAdapter(t.adapterId) || isDeviceAdapter(t.adapterId)) throw new HttpError(409, "Recordings and phone sessions send no live run events.");
        const secrets = this.secretsOf(t);
        const ag = t.agentId ? this.store.getAgent(t.agentId) : undefined;
        const name = (ag ? this.runnerName(ag) : undefined) ?? "agent";
        let stored = 0;
        let duplicates = 0;
        const lines: string[] = [];
        let phase: AgentPhase | undefined;
        // At most LIVE_EVENTS_MAX events or LIVE_EVENT_BYTES_MAX bytes per attempt (rows counted in the database, bytes in this process): past
        // that one note is kept and the rest are dropped with a 200, so the runner does not send them again. The final result has everything.
        const key = `${taskId}:${body.attemptId}`;
        let count = this.store.liveEventCount(taskId, body.attemptId);
        let bytes = this.liveEventBytes.get(key) ?? 0;
        let full = count >= LIVE_EVENTS_MAX || bytes >= LIVE_EVENT_BYTES_MAX;
        this.p.db.tx(() => {
            for (const raw of [...body.events].sort((a, b) => a.seq - b.seq)) {
                if (full) break;
                if (raw.type === "screenshot" && !this.store.getFile(taskId, "out", raw.ref)) continue; // never a file that is not there
                if (!this.store.noteLiveEvent(taskId, body.attemptId, raw.seq)) {
                    duplicates++;
                    continue;
                }
                const e = scrubSecrets(raw, secrets) as LiveEvent;
                if (e.type === "log") lines.push(e.line.slice(0, 300));
                if (e.type === "phase") phase = e.phase;
                const level = (e.type === "test_finished" && e.status !== "passed" && e.status !== "skipped") || (e.type === "step_finished" && e.status === "failed") ? "warn" : "info";
                const message = liveEventMessage(e, name).slice(0, 400);
                const data = { ...liveEventData(e), taskId, attempt: t.attempt };
                this.p.repo.addEvent(t.jobId, { stage: "validation", kind: LIVE_EVENT_KINDS[e.type], level, message, data });
                stored++;
                count++;
                bytes += message.length + JSON.stringify(data).length;
                full = count >= LIVE_EVENTS_MAX || bytes >= LIVE_EVENT_BYTES_MAX;
            }
            // Once per attempt (seq -1 is never sent by a runner): say the live view stops here.
            if (full && this.store.noteLiveEvent(taskId, body.attemptId, -1)) {
                this.p.repo.addEvent(t.jobId, { stage: "validation", kind: "runner_events_truncated", level: "warn", message: LIVE_EVENTS_TRUNCATED, data: { taskId, attempt: t.attempt } });
            }
        });
        if (this.liveEventBytes.size >= 5_000 && !this.liveEventBytes.has(key)) this.liveEventBytes.delete(this.liveEventBytes.keys().next().value!);
        this.liveEventBytes.set(key, bytes);
        if (lines.length || phase) this.store.heartbeat(taskId, t.agentId!, this.limits.leaseSeconds * 1000, { log: lines.length ? lines : undefined }, phase);
        if (phase) this.notePhase(t);
        return { ok: true, stored, duplicates };
    }

    /** A job event about a task (a convenience: a failure to write one changes nothing). */
    private emitTask(t: { jobId: string; id: string }, kind: string, level: "info" | "warn", message: string, data?: Record<string, unknown>): void {
        try {
            this.p.repo.addEvent(t.jobId, { stage: "validation", kind, level, message: message.slice(0, 400), data: { taskId: t.id, ...(data ?? {}) } });
        } catch {
            /* the job may be gone */
        }
    }

    /** Where the job ran and the task's phase, kept with the job (so "where it ran" outlives the 24 h task prune), plus a phase event when it moved. */
    private notePhase(before: TaskRecord): void {
        const t = this.store.getTask(before.id);
        if (!t || (t.phase === before.phase && t.attempt === before.attempt)) return;
        const agent = t.agentId ? this.store.getAgent(t.agentId) : undefined;
        this.noteRanOn(t, agent);
        this.emitTask(t, "runner_phase", "info", phaseSentence(t.phase, agent ? this.runnerName(agent) : undefined), { phase: t.phase, attempt: t.attempt, ...(agent ? { agentId: agent.id } : {}) });
    }

    private noteRanOn(t: TaskRecord, agent: AgentRecord | undefined): void {
        try {
            const prev = this.store.ranOnOf(t.jobId);
            const who = agent ? { agentId: agent.id, tokenId: agent.tokenId, name: this.runnerName(agent) } : { agentId: prev?.agentId, tokenId: prev?.tokenId, name: prev?.name };
            this.store.setRanOn(t.jobId, { ...who, taskId: t.id, attempt: t.attempt, phase: t.phase, at: new Date(this.clock()).toISOString() });
        } catch {
            /* the job may be gone */
        }
    }

    /** The store's housekeeping, plus a plain event in each run whose task it moved (back to the queue, lost, never picked up). */
    sweep(): ReturnType<AgentStore["sweep"]> {
        const r = this.store.sweep();
        for (const c of r.changes) this.reportSweep(c);
        return r;
    }

    private reportSweep(c: SweepChange): void {
        const name = c.agentId ? this.store.getAgent(c.agentId)?.name : undefined;
        const who = name ? `The runner “${name}”` : "The runner";
        const t = this.store.getTask(c.taskId);
        if (c.kind === "accept_timeout") this.emitTask({ jobId: c.jobId, id: c.taskId }, "runner_requeued", "warn", `${who} did not accept the run in time; offering it again.`, { reason: "accept_timeout", attempt: c.attempt });
        else if (c.kind === "never_accepted") this.emitTask({ jobId: c.jobId, id: c.taskId }, "runner_lost", "warn", `${who} did not accept the run in time. ${NEVER_ACCEPTED}`, { reason: "never_accepted", attempt: c.attempt });
        else if (c.kind === "requeued") this.emitTask({ jobId: c.jobId, id: c.taskId }, "runner_requeued", "warn", `${who} stopped answering; offering the run again.`, { reason: "lost", attempt: c.attempt });
        else if (c.kind === "lost") this.emitTask({ jobId: c.jobId, id: c.taskId }, "runner_lost", "warn", `${who} stopped answering while it was running these tests.`, { attempt: c.attempt });
        else if (c.kind === "stale") this.emitTask({ jobId: c.jobId, id: c.taskId }, "runner_lost", "warn", "No runner picked up this run within 30 minutes.", { attempt: c.attempt });
        if (t) this.noteRanOn(t, undefined);
    }

    /** The registered file an agent asks to download for its own running task. */
    downloadable(token: AgentTokenRecord, taskId: string, ref: string): { file: TaskFile; key: string } {
        const t = this.ownedTask(token, taskId);
        if (t.status !== "running") throw new HttpError(404, "Task not found.");
        const file = this.store.getFile(taskId, "in", ref);
        if (!file) throw new HttpError(404, "File not found.");
        return { file, key: validKey(file.path) };
    }

    /**
     * Where an upload for this task goes, after every check that does not need the bytes, and how many bytes it may have. The task's file
     * and byte budget is reserved here until `release` (uploads of one task may run side by side; all go through this one process), so two
     * uploads at once cannot together pass the limits. Protocol 2: `attemptId` (header x-attempt-id) must be the current attempt.
     */
    uploadTarget(token: AgentTokenRecord, taskId: string, name: string, attemptId?: string, declared = 0): { task: TaskRecord; key: string; cap: number; release: () => void } {
        const t = this.ownedTask(token, taskId);
        this.assertAttempt(t, attemptId);
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
        const held = this.uploadsInFlight.get(taskId) ?? { files: 0, bytes: 0 };
        const replaces = Boolean(this.store.getFile(taskId, "out", name));
        if (totals.count + held.files >= this.limits.taskMaxFiles && !replaces) throw new HttpError(413, "This task has uploaded too many files.");
        const cap = Math.min(this.limits.maxFileBytes, Math.max(0, this.limits.taskMaxBytes - totals.bytes - held.bytes));
        const mine = { files: replaces ? 0 : 1, bytes: declared > 0 ? Math.min(declared, cap) : cap };
        this.uploadsInFlight.set(taskId, { files: held.files + mine.files, bytes: held.bytes + mine.bytes });
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            const cur = this.uploadsInFlight.get(taskId);
            if (!cur) return;
            const next = { files: cur.files - mine.files, bytes: cur.bytes - mine.bytes };
            if (next.files <= 0 && next.bytes <= 0) this.uploadsInFlight.delete(taskId);
            else this.uploadsInFlight.set(taskId, next);
        };
        return { task: t, key, cap, release };
    }

    /** Upload budget held by uploads that are still streaming, per task. */
    private readonly uploadsInFlight = new Map<string, { files: number; bytes: number }>();

    recordUpload(task: TaskRecord, name: string, rel: string, size: number, sha256: string): void {
        this.store.addFile({ taskId: task.id, direction: "out", ref: name, path: rel, size, sha256 });
    }

    /**
     * The agent's final word. Accepted once; the cleanup and files are looked at by the executor that waits for it. Protocol 2: the same
     * result posted again for the same attempt is answered 200 `alreadyReceived` (an agent repeats it until it hears an answer); one for an
     * attempt that is no longer current gets 409 "superseded"; one for a task the platform already ended (timed out, lost) gets 410.
     * Protocol 1 keeps its answers (409 for a second result).
     */
    result(token: AgentTokenRecord, taskId: string, body: ResultRequest): { ok: true; alreadyReceived?: boolean } {
        const t = this.ownedTask(token, taskId);
        if (t.status === "cancelled") return { ok: true };
        if (body.attemptId !== undefined) {
            this.assertAttempt(t, body.attemptId);
            if (t.status !== "running") {
                if (t.resultAttemptId === body.attemptId) return { ok: true, alreadyReceived: true };
                throw new HttpError(410, "The platform stopped waiting for this run, so its result is not needed any more.");
            }
        }
        if (t.status !== "running") throw new HttpError(409, "A result for this task was already received.");
        if (isRecordAdapter(t.adapterId)) this.records.get(taskId)?.onResult(body);
        if (isDeviceAdapter(t.adapterId)) this.devices.get(taskId)?.onResult(body);
        const secrets = this.secretsOf(t);
        if (!body.ok) {
            const msg = scrubSecrets((body.error ?? "The runner agent could not run the tests.").slice(0, 500), secrets);
            if (!this.store.finish(taskId, t.agentId!, { status: "failed", error: msg, ...(body.attemptId ? { attemptId: body.attemptId } : {}) })) throw new HttpError(409, "A result for this task was already received.");
            this.notePhase(t);
            return { ok: true };
        }
        const clean = scrubSecrets(body, secrets);
        if (!this.store.finish(taskId, t.agentId!, { status: "done", resultEnc: this.secrets.encrypt(clean), ...(body.attemptId ? { attemptId: body.attemptId } : {}) })) throw new HttpError(409, "A result for this task was already received.");
        this.notePhase(t);
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
    startRecording(o: { projectId: string; agent: AgentRecord; startUrl: string; headed: boolean; environment?: string; caps: { idleMs: number; totalMs: number; maxSteps: number }; remote?: { lostContactMs?: number; claimWaitMs?: number; settleMs?: number; liveWaitMs?: number }; startedBy?: string | null }): RemoteDriver {
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
        // Who started it is kept with the task (a person's own computer claims only its owner's) and with the session (only they may drive it there).
        const startedBy = o.startedBy ?? null;
        const personal = this.store.getToken(o.agent.tokenId)?.kind === "personal";
        this.store.enqueue({ id: taskId, projectId: o.projectId, jobId: offer.jobId, adapterId: offer.adapterId, payloadEnc: this.encrypt(offer), files: [], ownerId: startedBy });
        const init: RemoteInit = { id, projectId: o.projectId, taskId, agent: { id: o.agent.id, name: o.agent.name }, startUrl: o.startUrl, headed: o.headed, ...(o.environment ? { environment: o.environment } : {}), maxSteps: o.caps.maxSteps, ...(o.agent.capabilities.liveSession === true ? { live: true } : {}), startedBy, personal };
        const driver = new RemoteDriver(
            {
                clock: this.clock,
                task: (tid) => this.store.getTask(tid),
                cancel: (tid) => this.store.requestCancel(tid),
                secrets: () => this.projectSecrets(o.projectId),
                accessProblem: () => this.sessionAccessProblem({ projectId: o.projectId, startedBy, tokenId: o.agent.tokenId, personal }),
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
            const ag = t.agentId ? this.store.getAgent(t.agentId) : undefined;
            const name = (ag ? this.runnerName(ag) : undefined) ?? "agent";
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

    /**
     * The computer that may take this project's work for `who` (round 45: only the run's owner's own runner, while they may still run the
     * project's tests), online, as a list of at most one. `who` absent: the person asking now (a page's view of their own runner); nobody's
     * run (no owner): none.
     */
    eligibleAgents(projectId: string, who: RunContext = { ownerId: ownerIdOfActor(currentActor()) }): Array<AgentRecord & { online: boolean; activeTasks: number }> {
        const own = who?.ownerId ? this.ownRunner(who.ownerId, projectId) : undefined;
        return own?.agent && own.online ? [{ ...own.agent, online: true, activeTasks: this.store.runningCount(own.agent.id) }] : [];
    }

    /**
     * The owner's runner as it last reported itself, online or not (what code scripts and capabilities are judged by when the run is made:
     * a schedule that fires while the computer is off keeps its code tests and waits for it). `who` absent: the person asking now.
     */
    lastKnownRunner(projectId: string, who: RunContext = { ownerId: ownerIdOfActor(currentActor()) }): AgentRecord[] {
        const own = who.ownerId ? this.ownRunner(who.ownerId, projectId) : undefined;
        return own?.agent ? [own.agent] : [];
    }

    /** The person's runner as seen for this project: undefined when they have none or may not run its tests. */
    private ownRunner(ownerId: string, projectId: string) {
        if (!this.store.ownerMayRun(ownerId, projectId)) return undefined;
        return this.store.runnerOf(ownerId);
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

    /**
     * Refuse a job that cannot run where its project runs. Called by `Repo.createJob`. On a runner (round 45): the job's owner's runner,
     * nowhere else. A person's run is refused up front when their runner is not set up or offline; a schedule's or deploy trigger's run whose
     * owner's runner is off is made and waits for it (it fails at the wait limit with a sentence naming the owner, RemoteExecutor.waitFor).
     */
    assertJobAllowed(projectId: string, options: JobOptions): void {
        // An agent run uses the worker's own browser and cannot go to a runner yet (agent-run.ts), so no runner is needed for it.
        if (options.mode === "agent") return;
        // Windows desktop tests start an application: the computer that runs them must be set up for it (allow-list), whoever runs them.
        const desktop = this.adaptersFor(options).includes("windows-uia") ? desktopApps(this.specsOf(options)) : [];
        const runsIos = this.adaptersFor(options).includes(IOS_ADAPTER_ID);
        if (!this.routesToAgent(projectId)) {
            assertHostDesktop(desktop);
            if (runsIos) throw new HttpError(409, IOS_NEEDS_AGENT_MESSAGE);
            return;
        }
        // Only the kinds of job that run scripts need the runner now; the others never reach one.
        const kind = options.startedBy?.kind ?? (options.trigger === "schedule" ? "schedule" : undefined);
        // A schedule or trigger the open server made, once the server is no longer open, has nobody to run it: refused like one with no owner.
        const named = ownerOfNewJob(options);
        const ownerId = named === OPEN_OWNER_ID && !this.store.openMode() ? null : named;
        // A schedule firing or a deploy trigger waits for its owner's computer; "Run now" (a person clicking, so a person acts now) is told now.
        const acting = currentActor().kind;
        const automated = (kind === "schedule" || kind === "trigger") && acting !== "user" && acting !== "open" && acting !== "key";
        if (!ownerId) {
            if (kind === "schedule") throw runnerRefusal("RUNNER_NOT_SET_UP", SCHEDULE_HAS_NO_OWNER);
            if (kind === "trigger") throw runnerRefusal("RUNNER_NOT_SET_UP", TRIGGER_HAS_NO_OWNER);
            if (kind === "key" || (!options.startedBy && currentActor().kind === "key")) throw runnerRefusal("RUNNER_NOT_SET_UP", KEY_HAS_NO_RUNNER);
            // A runbook started by hand and resumed after the platform restarted: who started it was kept only in memory.
            if (options.runbookRunId && !options.startedBy) throw runnerRefusal("RUNNER_NOT_SET_UP", RUNBOOK_STARTER_UNKNOWN);
            throw runnerRefusal("RUNNER_NOT_SET_UP", RUNNER_NOT_SET_UP);
        }
        const own = this.ownRunner(ownerId, projectId);
        if (!own) throw runnerRefusal("RUNNER_NOT_SET_UP", automated ? `${this.ownerName(ownerId)} has no runner set up for this project's tests. Set up the runner in Settings.` : RUNNER_NOT_SET_UP);
        // Automated runs wait for the owner's computer; a person is told now. What it can run is read from what it last reported.
        if (!own.online && !automated) throw runnerRefusal("RUNNER_OFFLINE", RUNNER_OFFLINE);
        const agent = own.agent;
        if (!agent) {
            if (automated) return void (options.runOn = "agent");
            throw runnerRefusal("RUNNER_OFFLINE", RUNNER_OFFLINE);
        }
        // Code scripts are checked next by the custom gate (custom-policy.ts), with the same rule as offering (mayRunCodeScripts).
        // A private or local address: only when the owner switched private addresses on for their runner.
        const address = this.projectAddress(projectId);
        if (address && looksPrivateAddress(address) && !own.token.allowPrivateTargets) {
            throw runnerRefusal("RUNNER_CANNOT_RUN", "This project's address is a private or local one (such as localhost or a computer on your network), and your runner does not open those. Switch on private addresses for your runner in Settings.");
        }
        for (const id of this.adaptersFor(options)) {
            const adapter = this.adapterOrUndefined(id)!;
            const why = capabilityProblem(adapter, agent.capabilities);
            if (!why) continue;
            if (adapter.id === IOS_ADAPTER_ID) throw runnerRefusal("RUNNER_CANNOT_RUN", `iOS tests need a runner on a Mac with Xcode. Your runner “${agent.name}” can't run them: ${why}.`);
            const what = adapter.id === "taqwright" ? "phone" : adapter.kinds[0] === "api" ? "API" : (adapter.kinds[0] ?? adapter.id);
            throw runnerRefusal("RUNNER_CANNOT_RUN", `Your runner cannot run ${what} tests: ${why}.`);
        }
        if (desktop.length > 0) {
            const why = agentDesktopProblem(desktop, [agent]);
            if (why) throw runnerRefusal("RUNNER_CANNOT_RUN", why);
        }
        options.runOn = "agent";
    }

    /** Why a queued run of this job failed waiting for its owner's computer, in one sentence. */
    noRunnerSentence(jobId: string): string {
        let kind: string | undefined;
        try {
            kind = this.p.repo.getJob(jobId)?.options.startedBy?.kind;
        } catch {
            kind = undefined;
        }
        const owner = this.jobContext(jobId).ownerId;
        if (owner && (kind === "schedule" || kind === "trigger")) return `${this.ownerName(owner)}'s computer was off when this ${kind === "schedule" ? "schedule" : "deploy trigger"} ran.`;
        return runnersOnly(this.p.config) ? `${RUNNER_OFFLINE} Your runner was not online, or cannot run these tests.` : "Your runner is not connected or cannot run these tests. Start it on your computer, or switch the project back to running here.";
    }

    /**
     * A person's name for a sentence ("Asha's computer was off …"): their name only, never their email (a deploy trigger's refusal ends up
     * in CI logs). No name, or the open server: a neutral word.
     */
    ownerName(ownerId: string): string {
        if (ownerId === OPEN_OWNER_ID) return "The owner";
        try {
            const r = this.p.db.get<{ name: string | null }>("SELECT name FROM users WHERE id = ?", ownerId);
            const name = (r?.name ?? "").trim();
            return name && !name.includes("@") ? name.slice(0, 80) : "The owner";
        } catch {
            return "The owner";
        }
    }

    /** What the project's pages show about where this project's tests run, for the person asking (their own runner). */
    runnerStatus(projectId: string, ownerId: string | null = ownerIdOfActor(currentActor())) {
        return this.runnerStatusOf(projectId, ownerId);
    }

    /** The address the project's tests run against: its latest application's (an environment of it may differ; the runner checks every address itself). */
    private projectAddress(projectId: string): string | undefined {
        try {
            return this.p.db.get<{ url: string }>(`SELECT url FROM applications WHERE project_id = ? ORDER BY created_at DESC, ${this.p.db.dialect.insertionOrder()} DESC LIMIT 1`, projectId)?.url;
        } catch {
            return undefined;
        }
    }

    private runnerStatusOf(projectId: string, ownerId: string | null) {
        const setting = this.store.getRunner(projectId);
        if (setting.runOn === "platform") {
            const mobile = mobileAvailability();
            if (process.platform === "win32" && !lastProbe()) void probeDesktop();
            const windowsWhy = desktopUnavailableReason(process.platform, lastProbe());
            const phonesText = mobile.available ? "Phone tests can run on this server (Android tools were found)." : `Phone tests can't run on this server: ${mobile.reason ?? "no Android tools were found"}.`;
            return { runOn: "platform" as const, agentId: null, status: "Runs on this platform.", canRunWeb: true, canRunMobile: mobile.available, canRunWindows: !windowsWhy, canRunIos: false, phones: { canRun: mobile.available, text: phonesText }, unavailableReason: mobile.available ? null : `Mobile tests can't run here: ${mobile.reason ?? "no Android tools were found"}` };
        }
        // What the owner's runner can run, from what it last reported (also while it is off: a schedule waits for it).
        const own = ownerId ? this.ownRunner(ownerId, projectId) : undefined;
        const a = own?.agent;
        const can = (id: string) => Boolean(a) && !capabilityProblem(getAdapter(id), a!.capabilities);
        const status = !own ? RUNNER_NOT_SET_UP : !a ? "Your runner has not connected yet." : `Runs on your runner “${a.name}” (${own.online ? "online" : "offline"}).`;
        let reason: string | null = null;
        if (!own) reason = RUNNER_NOT_SET_UP;
        else if (!a || !own.online) reason = RUNNER_OFFLINE;
        else {
            const parts: string[] = [];
            if (!can("playwright")) parts.push(`Web and API tests can't run: ${capabilityProblem(getAdapter("playwright"), a.capabilities)}.`);
            if (!can("taqwright")) parts.push(`Mobile tests can't run: ${capabilityProblem(getAdapter("taqwright"), a.capabilities)}.`);
            reason = parts.length ? parts.join(" ") : null;
        }
        const phonesText = a && can("taqwright") ? `Phone tests can run on ${a.name}. ${androidSummary(a.capabilities.android).summary}.` : `Phone tests can't run: ${!own ? "your runner is not set up" : !a ? "your runner has not connected yet" : capabilityProblem(getAdapter("taqwright"), a.capabilities)}.`;
        return { runOn: "agent" as const, agentId: a?.id ?? null, status, canRunWeb: can("playwright"), canRunMobile: can("taqwright"), canRunWindows: can("windows-uia"), canRunIos: can(IOS_ADAPTER_ID), phones: { canRun: can("taqwright"), text: phonesText }, unavailableReason: reason };
    }

    /**
     * Where did this job run? Present for the kinds of job that run scripts. For a runner: the machine (agentId, name), the runner it
     * belongs to (runnerId, an agent_tokens id), the latest task's phase and attempt. Read from the live task while it exists, and after the
     * 24 h task prune from what was kept with the job (generation_jobs.ran_on_json), so an old run never names the project's current runner.
     */
    ranOn(job: JobRow): { kind: "platform" } | { kind: "agent"; agentId: string; name: string; browser?: WebBrowserUsed; runnerId?: string; phase?: TaskPhase; attempt?: number } | undefined {
        const mode = job.options.mode ?? "generate";
        if (mode !== "validate" && mode !== "variants" && mode !== "environment") return undefined;
        const tasks = this.store.tasksOfJob(job.id);
        const latest = tasks[tasks.length - 1];
        const stored = this.store.ranOnOf(job.id);
        if (!latest && !stored && job.options.runOn !== "agent") return { kind: "platform" };
        const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
        const agentId = latest?.agentId ?? [...tasks].reverse().find((t) => t.agentId)?.agentId ?? str(stored?.agentId) ?? null;
        const agent = (agentId ? this.store.getAgent(agentId) : undefined) ?? (str(stored?.agentId) ? this.store.getAgent(str(stored?.agentId)!) : undefined);
        const browser = this.browserOfJob(job.id);
        const phase = (latest?.phase ?? str(stored?.phase)) as TaskPhase | undefined;
        const attempt = latest?.attempt ?? (typeof stored?.attempt === "number" ? stored.attempt : undefined);
        const runnerId = agent?.tokenId ?? str(stored?.tokenId);
        // Named as Settings names the runner (its name there, else what the computer calls itself); the stored name once the rows are gone.
        const byToken = !agent && runnerId ? this.store.agentsOfToken(runnerId)[0] : undefined;
        const known = agent ?? byToken;
        const name = (known ? this.runnerName(known) : undefined) ?? str(stored?.name) ?? (runnerId ? str(this.store.getToken(runnerId)?.label) : undefined) ?? "A runner agent";
        return { kind: "agent", agentId: agentId ?? known?.id ?? "", name, ...(browser ? { browser } : {}), ...(runnerId ? { runnerId } : {}), ...(phase ? { phase } : {}), ...(attempt ? { attempt } : {}) };
    }

    /** A runner's name as Settings shows it: the name its person gave it, else what the computer calls itself (GET /api/me/runner). */
    runnerName(agent: Pick<AgentRecord, "tokenId" | "name">): string | undefined {
        const label = this.store.getToken(agent.tokenId)?.label?.trim();
        return label || agent.name?.trim() || undefined;
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
        this.sweep();
        const now = this.clock();
        if (now - this.lastPrune < 10 * 60_000) return;
        this.lastPrune = now;
        for (const t of this.store.pruneTasks()) {
            await this.p.store.deletePrefix(path.posix.join(t.projectId, "_agent", t.id)).catch(() => undefined);
            // Copies of its uploads made on this machine for another store (localCopyIn in collect): none on local disk.
            await fsp.rm(path.join(this.p.config.scratchDir, "agent-files", t.id), { recursive: true, force: true }).catch(() => undefined);
        }
        this.store.pruneAgents();
        // Enrollment codes nobody used, a day after they expired (migration 51).
        this.store.pruneEnrollments();
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

type EmitFn = (message: string, level?: "info" | "warn", kind?: string) => void;

/**
 * What makes two runner tasks of one job the same work, for the pick-up after a restart (RemoteExecutor.earlierTask): everything the task
 * offer sends except its id, its time limits and the environment's secret values. That is the framework; each script's test, file name
 * and content (sha256), whether it is a code script or starts signed in, and its baselines and test files (sha256); the helpers (sha256);
 * the environment without its secret values (envKey); the phone or iOS part (the app file by its sha256); each browser variant with its
 * device and screen size. Made from the offer on both sides, so a task an earlier version of the platform sent is compared the same way.
 */
function batchKey(offer: Pick<TaskOffer, "adapterId" | "scripts" | "helpers" | "projects" | "mobile" | "ios"> & { env?: WireRunEnv }): string {
    return JSON.stringify([
        offer.adapterId,
        (offer.scripts ?? []).map((s) => [s.testId, s.filename, sha256Of(s.content), s.custom === true, s.session === true, (s.baselines ?? []).map((b) => [b.name, b.file.sha256])]),
        (offer.helpers ?? []).map((h) => [h.name, sha256Of(h.content)]),
        envKey(offer.env),
        stableJson(offer.mobile ?? null),
        stableJson(offer.ios ?? null),
        stableJson(offer.projects ?? []),
    ]);
}

/**
 * The run's environment as sent, without its secret values: a fetched API token or a refreshed saved sign-in differs from one attempt to the
 * next, and a password never needs comparing. Account names, whether each secret is there, the auth header's name, the addresses, headed or
 * not, cleanup and the variables (not secret: environments-store.ts) count. A sha256, so no secret-shaped text is kept in the key.
 */
function envKey(env: WireRunEnv | undefined): string {
    if (!env) return "";
    const { credentials, roles, apiToken, apiAuthHeader, storageState, vars, ...plain } = env;
    const headerName = apiAuthHeader === undefined ? null : apiAuthHeader.includes(":") ? apiAuthHeader.slice(0, apiAuthHeader.indexOf(":")).trim() : true;
    return sha256Of(
        stableJson({
            plain,
            credentials: credentials ? { username: credentials.username, totp: credentials.totpSecret !== undefined } : null,
            roles: (roles ?? []).map((r) => ({ name: r.name, username: r.username, totp: r.totpSecret !== undefined, apiToken: r.apiToken !== undefined })),
            apiToken: apiToken !== undefined,
            apiAuthHeader: headerName,
            storageState: storageState !== undefined,
            vars: vars ?? {},
        }),
    );
}

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");

/** JSON with every object's keys in order, so the same value always gives the same text. */
function stableJson(v: unknown): string {
    const order = (x: unknown): unknown => (Array.isArray(x) ? x.map(order) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, order((x as Record<string, unknown>)[k])])) : x);
    return JSON.stringify(order(v));
}

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
        // A stopping platform sends nothing new to a runner: the job parks and the next platform process carries on (runner-handover.ts).
        if (svc.draining) return parkForHandover(jobId);
        const emit: EmitFn = (message, level = "info", kind = "agent_task") => {
            // Handed over to the next platform process (runner-handover.ts): it writes this job's events now.
            if (isHandedOver(jobId)) return;
            try {
                svc.p.repo.addEvent(jobId, { stage: "validation", kind, level, message });
            } catch {
                /* an event is a convenience */
            }
        };
        const secrets = envSecrets(env.run);

        const taskId = randomUUID();
        const files: Array<Omit<TaskFile, "taskId">> = [];
        const relIn = path.posix.join(projectId, "_agent", taskId, "in");
        // Baseline images are stored with the task only when it is sent: a task that is picked up again needs no copy of them.
        const toStore: Array<{ key: string; bytes: Buffer }> = [];
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
                    toStore.push({ key: path.posix.join(relIn, ref), bytes });
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

        // Taken up again after a restart of the platform, or after the worker that looked after the job was lost: the runner task an earlier
        // attempt left for exactly this work (still waiting, still going, or finished with its result stored) is followed, not sent a second
        // time. Exactly: the same scripts with the same content, flags, baselines and helpers (batchKey), so a result is never attached to a
        // script that did not run.
        const earlier = this.earlierTask(batchKey(offer));
        if (earlier) {
            this.taken.add(earlier.id);
            const n = batch.scripts.length;
            emit(earlier.status === "done" ? `Picked up again: the runner had already finished ${n === 1 ? "this script" : `these ${n} scripts`}, so its stored result is used.` : `Picked up again: the runner carries on with ${n === 1 ? "this script" : `these ${n} scripts`}; nothing is sent or run a second time.`, "info", "runner_task_resumed");
            return this.follow(earlier.id, earlier.createdMs, adapter, batch, env, opts, secrets, emit);
        }
        if (svc.draining) return parkForHandover(jobId);
        try {
            for (const f of toStore) await svc.p.store.put(f.key, f.bytes, { contentType: "image/png" });
        } catch (e) {
            throw new RunnerAgentError(`These tests cannot be sent to a runner agent: ${e instanceof Error ? e.message.split("\n")[0] : "invalid run"}`);
        }

        // A runner task of an earlier attempt for any of these tests that this one did not pick up is stopped before a new one is sent: a test
        // never runs twice at once.
        await this.stopLeftovers(batch.scripts, opts, emit);
        svc.store.enqueue({ id: taskId, projectId, jobId, adapterId, payloadEnc: svc.encrypt(offer), files });
        this.taken.add(taskId);
        emit(`Sent ${batch.scripts.length} script(s) to a runner agent.`, "info", "agent_task_queued");
        return this.follow(taskId, svc.clock(), adapter, batch, env, opts, secrets, emit);
    }

    /** Runner tasks this attempt of the job sent or picked up (a later call never picks them up again). */
    private readonly taken = new Set<string>();

    /**
     * The runner task an earlier attempt of this job left for the same work (`want`: batchKey of what would be sent now) that can still give
     * a result: queued, running and not being stopped, or finished with its result stored. Oldest first, each one once.
     */
    private earlierTask(want: string): TaskRecord | undefined {
        const { svc } = this;
        svc.sweep();
        for (const t of svc.store.tasksOfJob(this.scope.jobId!)) {
            if (this.taken.has(t.id) || svc.following.has(t.id) || isRecordAdapter(t.adapterId) || isDeviceAdapter(t.adapterId)) continue;
            const usable = t.status === "queued" || (t.status === "running" && !t.cancelRequested) || (t.status === "done" && t.resultEnc !== null);
            if (!usable) continue;
            let offer: TaskOffer;
            try {
                offer = svc.decrypt<TaskOffer>(t.payloadEnc);
            } catch {
                continue;
            }
            if (batchKey(offer) === want) return t;
        }
        return undefined;
    }

    /**
     * Stop the runner tasks of earlier attempts this one did not pick up that hold any of these tests, and wait until none of them runs any
     * more (a lease at most). A task of an earlier attempt for other tests only is left alone: this attempt picks it up when it gets to
     * them, or it is stopped when the job ends (the sweep's rule for a finished job), so those tests are not run a second time.
     */
    private async stopLeftovers(scripts: ReadonlyArray<{ testId: string }>, opts: ExecutionOptions, emit: EmitFn): Promise<void> {
        const { svc } = this;
        const jobId = this.scope.jobId!;
        const testIds = new Set(scripts.map((s) => s.testId));
        const left = svc.store.tasksOfJob(jobId).filter((t) => !this.taken.has(t.id) && !svc.following.has(t.id) && !isRecordAdapter(t.adapterId) && !isDeviceAdapter(t.adapterId) && (t.status === "queued" || t.status === "running") && this.holdsAnyOf(t, testIds));
        if (left.length === 0) return;
        for (const t of left) svc.store.requestCancel(t.id);
        emit(`The runner was told to stop ${left.length === 1 ? "a task" : `${left.length} tasks`} of an earlier attempt of this run for the same tests before they are sent again, so a test never runs twice at once.`, "warn", "runner_attempt_cancelled");
        const ids = new Set(left.map((t) => t.id));
        const until = svc.clock() + svc.limits.leaseSeconds * 1000 + 30_000;
        while (svc.clock() < until) {
            if (opts.signal?.aborted) throw new Error("Job cancelled");
            if (svc.draining) return parkForHandover(jobId);
            svc.sweep();
            if (!svc.store.tasksOfJob(jobId).some((t) => ids.has(t.id) && t.status === "running")) return;
            await sleep(svc.limits.watchMs, opts.signal);
        }
    }

    /** Whether a task holds any of these tests. One whose offer cannot be read counts as holding them all (it is stopped: never two at once). */
    private holdsAnyOf(t: TaskRecord, testIds: ReadonlySet<string>): boolean {
        try {
            return (this.svc.decrypt<TaskOffer>(t.payloadEnc).scripts ?? []).some((s) => testIds.has(s.testId));
        } catch {
            return true;
        }
    }

    /** Wait for the task and turn its result into the run's results. `sentMs`: when it was sent (the deadline counts from then, across restarts). */
    private async follow(taskId: string, sentMs: number, adapter: ReturnType<typeof getAdapter>, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions, secrets: string[], emit: EmitFn): Promise<ScriptRun[]> {
        this.svc.following.add(taskId);
        try {
            return await this.waitFor(taskId, sentMs, adapter, batch, env, opts, secrets, emit);
        } finally {
            this.svc.following.delete(taskId);
        }
    }

    private async waitFor(taskId: string, sentMs: number, adapter: ReturnType<typeof getAdapter>, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions, secrets: string[], emit: EmitFn): Promise<ScriptRun[]> {
        const { svc } = this;
        const projectId = this.scope.projectId!;
        const jobId = this.scope.jobId!;
        const deadline = sentMs + (opts.timeoutMs ? opts.timeoutMs + 5 * 60_000 : 4 * 3_600_000);
        let announced = false;
        let logSeen = 0;
        let noAgentSince: number | undefined;
        for (;;) {
            if (opts.signal?.aborted) {
                // A lost lease: the job, and its runner task with it, belong to the attempt that takes it next (runner-handover.ts). Anything
                // else (a person's stop, the job's time limit, the platform shutting the job down) stops the task.
                if (!isLeaseLoss(opts.signal.reason)) svc.store.requestCancel(taskId);
                throw new Error("Job cancelled");
            }
            // Handed over (another test of this job parked first): nothing more is collected or written here; the next process does it.
            if (isHandedOver(jobId)) return parkForHandover(jobId);
            svc.sweep();
            const t = svc.store.getTask(taskId);
            if (!t) throw new RunnerAgentError("The run was removed before it finished.");
            // A stopping platform leaves the runner going and hands the job over; a finished task is collected first.
            if (svc.draining && (t.status === "queued" || t.status === "running")) return parkForHandover(jobId);
            if (t.status === "queued") {
                // A task with hand-written scripts waits for an agent that was started with --allow-custom-scripts.
                const needsCustom = batch.scripts.some((s) => s.custom);
                // A runner that said no (protocol 2 reject) is not counted: the task is never offered to it again.
                const refused = new Set(refusalsOf(t).map((r) => r.agentId));
                // The same rules as offering (migration 51): the job's owner's own computers count, and code scripts only where they may run.
                const capable = svc.eligibleAgents(projectId, svc.jobContext(jobId)).some((a) => !refused.has(a.id) && !capabilityProblem(adapter, a.capabilities) && (!needsCustom || svc.mayRunCodeScripts(a)));
                if (capable) noAgentSince = undefined;
                else if (refusalsOf(t).length > 0) {
                    // Every runner that could take it said no: the run fails now, with their reasons (each is also in the run's events).
                    const reasons = [...new Map(refusalsOf(t).map((r) => [r.agentId, r.message])).values()].join(" ");
                    svc.store.failQueuedOrRunning(taskId, `No runner that may take this run can run it. ${reasons}`.slice(0, 1000), "rejected");
                } else {
                    noAgentSince ??= svc.clock();
                    if (svc.clock() - noAgentSince >= svc.limits.noAgentGraceMs) svc.store.failQueuedOrRunning(taskId, svc.noRunnerSentence(jobId));
                }
            } else if (t.status === "running") {
                if (!announced) {
                    announced = true;
                    const a = t.agentId ? svc.store.getAgent(t.agentId) : undefined;
                    emit(`Running on the runner “${(a ? svc.runnerName(a) : undefined) ?? "agent"}”.`, "info", "agent_task_started");
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
                svc.store.failQueuedOrRunning(taskId, "The runner agent did not finish in time.", "timed_out");
                throw new RunnerAgentError("The runner agent did not finish in time.");
            }
            await sleep(svc.limits.watchMs, opts.signal);
        }
    }

    /** Turn the agent's wire result into the ScriptRun[] a local run would have returned: files rewritten to local paths, the cleanup ledger stored. */
    private async collect(task: TaskRecord, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions, secrets: string[]): Promise<ScriptRun[]> {
        const { svc } = this;
        // Handed over (runner-handover.ts): the next platform process collects this result and writes its events.
        if (isHandedOver(task.jobId)) return parkForHandover(task.jobId);
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
        const storedKeys = new Map<string, string>();
        for (const f of svc.store.filesOf(task.id, "out")) {
            try {
                localFiles.set(f.ref, await localCopyIn(svc.p.store, f.path, scratch));
                storedKeys.set(f.ref, f.path);
            } catch {
                /* a bad path, or a file that vanished: as if it was never uploaded */
            }
        }
        const local = (ref: string): string | undefined => localFiles.get(ref);
        const known = new Set(batch.scripts.map((s) => s.testId));
        const evidenceSecrets = secretsOfRun(env.run);
        const traceSecrets = [...traceSecretsOfRun(env.run), ...secrets];
        const withheld: string[] = [];
        // Traces that are not kept: deleted only after the run's events say so (below), so a hand-over in between leaves them for the next
        // process to withhold and report, instead of a trace gone without a word.
        const dropped: Array<{ file: string; key: string | undefined }> = [];
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
        const missing: string[] = [];
        // A finished task picked up again whose trace an earlier collection did not keep (and deleted): that trace is not "never uploaded".
        const tracesWithheldBefore = eventOfTask(svc, task, "runner_trace_withheld") !== undefined;

        const runs: ScriptRun[] = [];
        for (const w of result.runs as WireRun[]) {
            if (!known.has(w.testId)) continue;
            const artifacts: ScriptRun["artifacts"] = [];
            for (const a of w.artifacts) {
                const file = local(a.ref);
                // A trace an earlier collection of this task did not keep is gone (deleted then, and said so then): not reported again.
                if (a.kind === "trace" && tracesWithheldBefore && !(file && (await fsp.stat(file).catch(() => null)))) continue;
                if (!file) {
                    // Named but never uploaded: left out, as a missing file is for a local run, and the run says so.
                    missing.push(`${a.kind} of ${w.testId}`);
                    continue;
                }
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
                if (a.kind === "trace") {
                    // A failure trace holds what the test typed and what the browser sent. A runner from round 40 on masks the run's secrets in it
                    // before it uploads; older runners do not. It is masked here too, and one that cannot be cleaned is not kept at all.
                    const key = storedKeys.get(a.ref);
                    const clean = await scrubTraceFile(file, traceSecrets);
                    if (!clean.ok) {
                        withheld.push(`${w.testId}: ${clean.reason}`);
                        dropped.push({ file, key });
                        continue;
                    }
                    // On a store that is not this disk, the upload itself is replaced by the cleaned copy (it is kept with the task for a day);
                    // when that fails, the upload is removed rather than kept as it came (the run keeps the cleaned copy).
                    if (clean.masked > 0 && key && svc.p.store.kind !== "local") {
                        const store = svc.p.store;
                        await store.putFile(key, file).catch(() => store.delete(key).catch(() => false));
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
        // Handed over while the files were looked at (runner-handover.ts): the next platform process collects this result; nothing is written here.
        if (isHandedOver(task.jobId)) return parkForHandover(task.jobId);
        this.seq += ledger.length;
        if (ledger.length) this.storeLedger(task, ledger);
        if (withheld.length) {
            try {
                svc.p.repo.addEvent(task.jobId, { stage: "validation", kind: "runner_trace_withheld", level: "warn", message: `${withheld.length === 1 ? "A trace was" : `${withheld.length} traces were`} not kept: ${withheld.length === 1 ? "it" : "they"} could not be cleaned of the run's passwords and tokens safely (${withheld.slice(0, 3).join("; ")}).`.slice(0, 400), data: { taskId: task.id } });
            } catch {
                /* an event is a convenience */
            }
        }
        if (missing.length) {
            try {
                svc.p.repo.addEvent(task.jobId, { stage: "validation", kind: "runner_file_missing", level: "warn", message: `The runner named ${missing.length} file${missing.length === 1 ? "" : "s"} it never uploaded, so ${missing.length === 1 ? "it is" : "they are"} not attached: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}.`.slice(0, 400), data: { taskId: task.id, files: missing.slice(0, 50) } });
            } catch {
                /* an event is a convenience */
            }
        }
        for (const d of dropped) {
            await fsp.rm(d.file, { force: true }).catch(() => undefined);
            if (d.key) await svc.p.store.delete(d.key).catch(() => false);
        }

        if (opts.projects?.length) return runs;
        return batch.scripts.map((s): ScriptRun => runs.find((r) => r.testId === s.testId) ?? { testId: s.testId, status: "error", durationMs: 0, error: "The runner agent returned no result for this script.", failedStepIndex: -1, steps: [], artifacts: [], responses: [] });
    }

    private storeLedger(task: TaskRecord, items: FinishedItem[]): void {
        const { svc } = this;
        try {
            // A finished task picked up again (after a restart or a lost worker) was collected before: its ledger is stored once.
            if (eventOfTask(svc, task, "cleanup_finished")) return;
            new CleanupStore(svc.p.db).record({ projectId: task.projectId, jobId: task.jobId, items });
            const counts = countItems(items);
            svc.p.repo.addEvent(task.jobId, { stage: "validation", kind: "cleanup_finished", level: counts.leftBehind > 0 ? "warn" : "info", message: summaryLine(counts), data: { created: counts.created, removed: counts.removed, leftBehind: counts.leftBehind, taskId: task.id } });
        } catch (err) {
            console.error(`[agent] could not store the cleanup ledger of job ${task.jobId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
        }
    }
}

/** The data of the job's latest event of this kind written for this runner task (its `data.taskId`), if there is one. */
function eventOfTask(svc: AgentService, task: TaskRecord, kind: string): Record<string, unknown> | undefined {
    const rows = svc.p.db.all<{ data_json: string | null }>("SELECT data_json FROM agent_events WHERE job_id = ? AND kind = ? ORDER BY id DESC", task.jobId, kind);
    for (const r of rows) {
        try {
            const data = r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : null;
            if (data?.taskId === task.id) return data;
        } catch {
            /* not ours */
        }
    }
    return undefined;
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
export function agentCanRunIos(projectId: string, ownerId?: string | null): boolean | undefined {
    for (const s of installed.values()) {
        try {
            if (s.routesToAgent(projectId)) return (ownerId === undefined ? s.runnerStatus(projectId) : s.runnerStatus(projectId, ownerId)).canRunIos;
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
export function agentCanRunMobile(projectId: string, ownerId?: string | null): boolean | undefined {
    for (const s of installed.values()) {
        try {
            if (s.routesToAgent(projectId)) return (ownerId === undefined ? s.runnerStatus(projectId) : s.runnerStatus(projectId, ownerId)).canRunMobile;
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
