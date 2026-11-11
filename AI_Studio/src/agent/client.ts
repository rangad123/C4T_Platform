/**
 * The agent's connection to the platform: the six routes of the protocol, nothing else.
 *
 * Every answer is checked against the protocol's zod schema; one that does not fit is reported as a plain error (the agent
 * logs it and carries on), never trusted. The token goes only into the Authorization header; error messages are built from
 * the status and the platform's own error sentence, never from a request or a header.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
    AcceptResponse,
    ATTEMPT_HEADER,
    EventsResponse,
    HeartbeatResponse,
    HelloResponse,
    EnrollResponse,
    RotateResponse,
    type EnrollRequest,
    ResultResponse,
    TaskOffer,
    UploadResponse,
    type EventsRequest,
    type RejectRequest,
    type DevicePush,
    type FileRef,
    type HeartbeatRequest,
    type HelloRequest,
    type PollRequest,
    type RecordingPush,
    type ResultRequest,
    RUNNER_UPDATE_HEADER,
    RunnerUpdateOffer,
    type RunnerUpdateState,
} from "../agent-protocol/schema.js";
import { z } from "zod";
import { describeNetworkError, problemSentence, type NetworkProblem } from "../engine/net/company-network.js";
import { AGENT_VERSION } from "./config.js";
import { noteServerTime, runnerCheckReport } from "./computer-check.js";
import { networkCapabilities, noteNetworkProblem, proxyUsedFor } from "./net.js";

/** What the runner says when the platform refuses its credential without a sentence of its own. */
export const ACCESS_REMOVED = "The platform no longer accepts this runner: it was removed, or another computer was set up in its place. Set up your runner again from Settings, Your runner.";

/**
 * auth       the credential is not accepted any more: retired, replaced by another computer, or a team credential (stop)
 * conflict   the platform refuses this agent (stop)
 * protocol   the platform speaks another protocol version (stop)
 * network    could not reach the platform, or a server error, or rate limited (retry)
 * invalid    the platform answered something the protocol does not allow (log, carry on)
 * rejected   any other refusal of one request (a task that no longer exists, a file that is too big)
 */
export type PlatformErrorKind = "auth" | "conflict" | "protocol" | "network" | "invalid" | "rejected";

export class PlatformError extends Error {
    constructor(
        readonly kind: PlatformErrorKind,
        message: string,
        readonly status?: number,
        /** Seconds the platform asked us to wait (Retry-After). */
        readonly retryAfter?: number,
    ) {
        super(message);
        this.name = "PlatformError";
    }
}

export interface ClientOptions {
    baseUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
    /** Long-poll wait the platform announced; the HTTP timeout of a poll is this plus a margin. */
    pollSeconds?: number;
}

/** The platform's own sentence from an error body ({error} or {message}), made safe to print. Empty when there is none. */
function sentenceOf(body: string): string {
    try {
        const v = JSON.parse(body) as { message?: unknown; error?: unknown };
        const s = typeof v.message === "string" ? v.message : typeof v.error === "string" ? v.error : "";
        return s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240);
    } catch {
        return "";
    }
}

/**
 * What went wrong with a network call, in words, with what to do (a proxy that wants a password, an untrusted company certificate,
 * an unreachable proxy, ...; see engine/net/company-network.ts). Never the request, a header or the proxy password.
 */
function networkProblem(e: unknown, url: string, host: string): NetworkProblem {
    const used = proxyUsedFor(url);
    return describeNetworkError(e, { target: host, ...(used ? { proxy: used.proxy, proxySource: used.source } : {}) });
}

export class PlatformClient {
    private readonly fetchImpl: typeof fetch;
    private readonly base: string;
    private pollSeconds: number;
    /** The x-runner-update header of the last poll answer, if any. */
    updateHint?: string;
    /** Set by the updater (updater.ts): what this runner reports about its updates in hello and poll. */
    updateState?: () => RunnerUpdateState | undefined;

    /** The runner credential sent with every request (empty before enrollment; replaced after a rotation). */
    private token: string;

    /** Use another credential from now on (after enrollment or a rotation). */
    setToken(token: string): void {
        this.token = token;
    }

    /**
     * Trade a single-use enrollment code for this runner's credential (POST /api/agent/enroll, no Authorization header). A used, expired or
     * unknown code is an "auth" error with the platform's sentence (make a new code); a refusal is "conflict"; network trouble is retried by the caller.
     */
    async enroll(req: EnrollRequest): Promise<EnrollResponse> {
        const res = await this.send("POST", "/api/agent/enroll", { body: JSON.stringify(req), headers: { "content-type": "application/json" }, timeoutMs: 30_000, anonymous: true });
        if (res.status === 404 || res.status === 410) {
            const sentence = sentenceOf(await res.text().catch(() => ""));
            return Promise.reject(new PlatformError("auth", sentence || "This one-time code is not valid. Download the runner again from Settings, Your runner.", res.status));
        }
        if (!res.ok) throw await this.failure(res, "add this computer", true);
        return this.json(res, EnrollResponse, "enroll");
    }

    /** A new credential (POST /api/agent/rotate). The current one keeps working until the new one is first used, at most 24 hours. */
    async rotate(): Promise<RotateResponse> {
        const res = await this.send("POST", "/api/agent/rotate", { body: "{}", headers: { "content-type": "application/json" }, timeoutMs: 20_000 });
        if (!res.ok) throw await this.failure(res, "get a new credential");
        return this.json(res, RotateResponse, "rotate");
    }

    constructor(private readonly opts: ClientOptions) {
        this.token = opts.token;
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.base = opts.baseUrl.replace(/\/+$/, "");
        this.pollSeconds = opts.pollSeconds ?? 30;
    }

    setPollSeconds(n: number): void {
        this.pollSeconds = n;
    }

    get host(): string {
        try {
            return new URL(this.base).host;
        } catch {
            return "the platform";
        }
    }

    private headers(extra: Record<string, string> = {}): Record<string, string> {
        return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), "user-agent": `ai-test-agent/${AGENT_VERSION}`, accept: "application/json", ...extra };
    }

    private async send(method: string, route: string, init: { body?: BodyInit; headers?: Record<string, string>; timeoutMs: number; signal?: AbortSignal; duplex?: boolean; anonymous?: boolean }): Promise<Response> {
        const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs)]) : AbortSignal.timeout(init.timeoutMs);
        try {
            return await this.fetchImpl(`${this.base}${route}`, {
                method,
                // Enrollment sends no credential: the single-use code in the body is the only one.
                headers: init.anonymous ? Object.fromEntries(Object.entries(this.headers(init.headers)).filter(([k]) => k !== "authorization")) : this.headers(init.headers),
                ...(init.body !== undefined ? { body: init.body } : {}),
                ...(init.duplex ? ({ duplex: "half" } as object) : {}),
                signal,
                redirect: "error",
            });
        } catch (e) {
            if (init.signal?.aborted) throw new PlatformError("rejected", "The request was stopped.");
            const message = problemSentence(`Could not reach ${this.host}`, networkProblem(e, `${this.base}${route}`, this.host));
            noteNetworkProblem(message);
            throw new PlatformError("network", message);
        }
    }

    /** Turn a non-2xx answer into the right error. */
    private async failure(res: Response, what: string, entry = false): Promise<PlatformError> {
        const sentence = sentenceOf(await res.text().catch(() => ""));
        const said = sentence ? ` The platform said: ${sentence}` : "";
        const retry = Number(res.headers.get("retry-after"));
        const retryAfter = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 120) : undefined;
        // The credential was retired, replaced by another computer of the same person, or is a team or project credential (round 45): the
        // platform's own sentence says which and what to do, so it is shown as it is. The runner then stops (exit code 3).
        if (res.status === 401 || (res.status === 404 && entry)) return new PlatformError("auth", sentence ? `The platform no longer accepts this runner. ${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`}` : ACCESS_REMOVED, res.status);
        // A protocol refusal comes first: the platform answers it with 409 on hello, and it must end with the protocol exit code (4), not 5.
        if (res.status === 426 || ((res.status === 400 || res.status === 409) && /\bprotocol\b/i.test(sentence))) return new PlatformError("protocol", `The platform does not accept this agent's protocol version.${said} Update the agent (or the platform) so both speak the same version.`, res.status);
        if (res.status === 409 && entry) return new PlatformError("conflict", `The platform refused this agent.${said}`, res.status);
        // Answers that come from something between this computer and the platform (a company proxy or web filter), not from the platform.
        if (res.status === 407) {
            const message = `Could not reach ${this.host}: a proxy asks for a user name and password (HTTP 407). Add them to the proxy address, for example --proxy http://user:password@host:port. The password is never shown or sent to the platform.`;
            noteNetworkProblem(message);
            return new PlatformError("network", message, res.status);
        }
        if (res.status === 403 && !sentence && /text\/html/i.test(res.headers.get("content-type") ?? "")) {
            const message = `Something between this computer and the platform blocked the request (HTTP 403, a web page instead of the platform's answer). A company web filter may block ${this.host}: ask IT to allow it.`;
            noteNetworkProblem(message);
            return new PlatformError("network", message, res.status);
        }
        if (res.status === 429) return new PlatformError("network", "The platform is asking the agent to slow down.", res.status, retryAfter);
        if (res.status >= 500) return new PlatformError("network", `The platform had a problem (HTTP ${res.status}).${said}`, res.status, retryAfter);
        return new PlatformError("rejected", `The platform refused a request to ${what} (HTTP ${res.status}).${said}`, res.status);
    }

    private async json<T>(res: Response, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, what: string): Promise<T> {
        let value: unknown;
        try {
            value = await res.json();
        } catch {
            throw new PlatformError("invalid", `The platform's answer to "${what}" was not readable.`);
        }
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new PlatformError("invalid", `The platform's answer to "${what}" does not match the protocol (${issue ? `${issue.path.map(String).join(".") || "answer"}: ${issue.message}` : "unknown problem"}).`);
        }
        return parsed.data;
    }

    /** The capabilities plus what the runner knows about its network (proxy as host:port, certificates, the last problem); unchanged when the network was not set up. */
    private withNetwork<T extends { capabilities: HelloRequest["capabilities"] }>(req: T): T {
        const network = networkCapabilities();
        // What the runner says about its own updates (updater.ts); absent on a runner that cannot update itself.
        const update = this.updateState?.();
        // "Check this computer" (computer-check.ts): the runner's start-up check plus the lines read from these capabilities; absent before it ran.
        const check = runnerCheckReport(network ? { ...req.capabilities, network } : req.capabilities);
        if (!network && !update && !check) return req;
        return { ...req, capabilities: { ...req.capabilities, ...(network ? { network } : {}), ...(update ? { update } : {}), ...(check ? { check } : {}) } };
    }

    async hello(req: HelloRequest): Promise<HelloResponse> {
        const res = await this.send("POST", "/api/agent/hello", { body: JSON.stringify(this.withNetwork(req)), headers: { "content-type": "application/json" }, timeoutMs: 20_000 });
        if (!res.ok) throw await this.failure(res, "connect", true);
        const answer = await this.json(res, HelloResponse, "hello");
        // The clock line of the check: this computer's time against the platform's.
        noteServerTime(answer.serverTime);
        return answer;
    }

    /** Long-poll for a task. Returns the offer, `null` for "nothing yet", or `{ unreadable }` with the task id when the offer did not fit the protocol. */
    async poll(req: PollRequest, signal?: AbortSignal): Promise<TaskOffer | null | { unreadable: string; taskId?: string }> {
        const res = await this.send("POST", "/api/agent/poll", { body: JSON.stringify(req.capabilities ? this.withNetwork(req as PollRequest & { capabilities: HelloRequest["capabilities"] }) : req), headers: { "content-type": "application/json" }, timeoutMs: (this.pollSeconds + 20) * 1000, ...(signal ? { signal } : {}) });
        // The platform wants this runner on its version ("auto 1.2.0+abc" / "requested ..."); see updater.ts.
        this.updateHint = res.ok ? (res.headers.get(RUNNER_UPDATE_HEADER) ?? undefined) : undefined;
        if (res.status === 204) return null;
        if (!res.ok) throw await this.failure(res, "poll for tasks", true);
        let value: unknown;
        try {
            value = await res.json();
        } catch {
            throw new PlatformError("invalid", 'The platform\'s answer to "poll" was not readable.');
        }
        const parsed = TaskOffer.safeParse(value);
        if (parsed.success) return parsed.data;
        const issue = parsed.error.issues[0];
        const taskId = typeof (value as { taskId?: unknown } | null)?.taskId === "string" ? (value as { taskId: string }).taskId : undefined;
        return { unreadable: `A task from the platform does not match the protocol (${issue ? `${issue.path.join(".") || "task"}: ${issue.message}` : "unknown problem"}).`, ...(taskId ? { taskId } : {}) };
    }

    async heartbeat(taskId: string, req: HeartbeatRequest, signal?: AbortSignal): Promise<HeartbeatResponse> {
        const res = await this.send("POST", `/api/agent/tasks/${encodeURIComponent(taskId)}/heartbeat`, { body: JSON.stringify(req), headers: { "content-type": "application/json" }, timeoutMs: 15_000, ...(signal ? { signal } : {}) });
        if (!res.ok) throw await this.failure(res, "send a heartbeat");
        return this.json(res, HeartbeatResponse, "heartbeat");
    }

    /** A record task's state (the whole recording, at most about once a second). Nothing is read from the answer. */
    async pushRecording(taskId: string, req: RecordingPush, signal?: AbortSignal): Promise<void> {
        const res = await this.send("POST", `/api/agent/tasks/${encodeURIComponent(taskId)}/recording`, { body: JSON.stringify(req), headers: { "content-type": "application/json" }, timeoutMs: 15_000, ...(signal ? { signal } : {}) });
        if (!res.ok) throw await this.failure(res, "send the recording");
        await res.body?.cancel().catch(() => undefined);
    }

    /** A device task's state and answers (at most a few per second). Nothing is read from the answer. */
    async pushDevice(taskId: string, req: DevicePush, signal?: AbortSignal): Promise<void> {
        const res = await this.send("POST", `/api/agent/tasks/${encodeURIComponent(taskId)}/device`, { body: JSON.stringify(req), headers: { "content-type": "application/json" }, timeoutMs: 15_000, ...(signal ? { signal } : {}) });
        if (!res.ok) throw await this.failure(res, "send the phone session update");
        await res.body?.cancel().catch(() => undefined);
    }

    /** Stream a file the task refers to into `destination`, hashing as it goes. Refuses more bytes than `ref.size`. */
    async download(taskId: string, ref: Pick<FileRef, "ref" | "size">, destination: string, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
        return this.streamTo(`/api/agent/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(ref.ref)}`, ref, destination, signal);
    }

    /** What the platform wants this runner to update to (POST /api/agent/update), or undefined. */
    async updateOffer(agentId: string, signal?: AbortSignal): Promise<RunnerUpdateOffer | undefined> {
        const res = await this.send("POST", "/api/agent/update", { body: JSON.stringify({ agentId }), headers: { "content-type": "application/json" }, timeoutMs: 20_000, ...(signal ? { signal } : {}) });
        if (!res.ok) throw await this.failure(res, "ask for an update");
        return (await this.json(res, z.object({ update: RunnerUpdateOffer.optional() }), "update")).update;
    }

    /** One file of an update, streamed into `destination` and hashed; never more than `size` bytes. The caller compares the hash with the offer. */
    async updateFile(name: string, size: number, destination: string, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
        return this.streamTo(`/api/agent/update/files/${encodeURIComponent(name)}`, { ref: name, size }, destination, signal);
    }

    private async streamTo(route: string, ref: Pick<FileRef, "ref" | "size">, destination: string, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
        const res = await this.send("GET", route, { timeoutMs: 30 * 60_000, headers: { accept: "application/octet-stream" }, ...(signal ? { signal } : {}) });
        if (!res.ok || !res.body) throw await this.failure(res, `download ${ref.ref}`);
        const hash = crypto.createHash("sha256");
        let size = 0;
        const meter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
                size += chunk.length;
                if (size > ref.size) return cb(new PlatformError("rejected", `The platform sent more bytes than the file ${ref.ref} should have, so the download was stopped.`));
                hash.update(chunk);
                cb(null, chunk);
            },
        });
        try {
            await pipeline(Readable.fromWeb(res.body as never), meter, fs.createWriteStream(destination));
        } catch (e) {
            if (e instanceof PlatformError) throw e;
            if (signal?.aborted) throw new PlatformError("rejected", "The download was stopped.");
            const message = problemSentence(`The download of ${ref.ref} was interrupted`, networkProblem(e, this.base, this.host));
            noteNetworkProblem(message);
            throw new PlatformError("network", message);
        }
        return { size, sha256: hash.digest("hex") };
    }

    /** Stream a local file up as an artifact. The platform's answer (size, sha256) is returned for the caller to compare. Protocol 2: `attemptId` goes in the x-attempt-id header. */
    async upload(taskId: string, name: string, file: string, size: number, signal?: AbortSignal, attemptId?: string): Promise<UploadResponse> {
        const body = Readable.toWeb(fs.createReadStream(file)) as unknown as BodyInit;
        const res = await this.send("PUT", `/api/agent/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(name)}`, {
            body,
            headers: { "content-type": "application/octet-stream", "content-length": String(size), ...(attemptId ? { [ATTEMPT_HEADER]: attemptId } : {}) },
            timeoutMs: 30 * 60_000,
            duplex: true,
            ...(signal ? { signal } : {}),
        });
        if (!res.ok) throw await this.failure(res, `upload ${name}`);
        return this.json(res, UploadResponse, "upload");
    }

    /** Post a task's result. Protocol 2: `alreadyReceived` is true when the platform had it already (an earlier try did arrive). */
    async result(taskId: string, req: ResultRequest, signal?: AbortSignal): Promise<{ alreadyReceived: boolean }> {
        const res = await this.send("POST", `/api/agent/tasks/${encodeURIComponent(taskId)}/result`, { body: JSON.stringify(req), headers: { "content-type": "application/json" }, timeoutMs: 60_000, ...(signal ? { signal } : {}) });
        if (!res.ok) throw await this.failure(res, "post the result");
        const answer = ResultResponse.safeParse(await res.json().catch(() => undefined));
        return { alreadyReceived: answer.success && answer.data.alreadyReceived === true };
    }

    // ── protocol 2 ──────────────────────────────────────────────────────────

    /** Take the task this agent was handed (within the offer's acceptSeconds). */
    async accept(taskId: string, attemptId: string, signal?: AbortSignal): Promise<AcceptResponse> {
        const res = await this.send("POST", `/api/agent/tasks/${encodeURIComponent(taskId)}/accept`, { body: JSON.stringify({ attemptId }), headers: { "content-type": "application/json" }, timeoutMs: 15_000, ...(signal ? { signal } : {}) });
        if (!res.ok) throw await this.failure(res, "accept the task");
        return this.json(res, AcceptResponse, "accept");
    }

    /** Turn the task down with a reason; the platform offers it to another runner. */
    async reject(taskId: string, req: RejectRequest, signal?: AbortSignal): Promise<void> {
        const res = await this.send("POST", `/api/agent/tasks/${encodeURIComponent(taskId)}/reject`, { body: JSON.stringify(req), headers: { "content-type": "application/json" }, timeoutMs: 15_000, ...(signal ? { signal } : {}) });
        if (!res.ok) throw await this.failure(res, "turn the task down");
        await res.body?.cancel().catch(() => undefined);
    }

    /** A batch of live events (the platform keeps each sequence number once, so a batch may be sent again). */
    async events(taskId: string, req: EventsRequest, signal?: AbortSignal): Promise<EventsResponse> {
        const res = await this.send("POST", `/api/agent/tasks/${encodeURIComponent(taskId)}/events`, { body: JSON.stringify(req), headers: { "content-type": "application/json" }, timeoutMs: 15_000, ...(signal ? { signal } : {}) });
        if (!res.ok) throw await this.failure(res, "send live events");
        return this.json(res, EventsResponse, "events");
    }
}
