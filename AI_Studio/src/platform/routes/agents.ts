/**
 * Runner routes.
 *
 * Project routes (API key or a person, like every other route): the caller's own runner as the project sees it, where a project's tests run.
 * Runner routes (/api/agent/*, the six of the protocol): no API key, the agent token is the credential. The server's API-key hook skips
 * exactly those six (see agent-routing.ts) and EVERY handler registered below authenticates with the token first (one hook on the
 * encapsulated scope, so a handler cannot forget). An API key is never accepted instead of the token.
 */
import { PassThrough, Transform } from "node:stream";
import { PLATFORM_SETTING_REFUSED, runnersOnly } from "../runner-only.js";
import { pipeline } from "node:stream/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AcceptRequest, ATTEMPT_HEADER, DevicePush, EventsRequest, HeartbeatRequest, HelloRequest, PollRequest, RecordingPush, RejectRequest, ResultRequest, SafeName, type UploadResponse } from "../../agent-protocol/schema.js";
import { EnrollRequest } from "../../agent-protocol/schema.js";
import { MAX_DEVICE_PUSH_BYTES } from "../agent-device.js";
import { EXPLORE_LLM_MAX_BYTES } from "../../agent-protocol/explore-llm.js";
import { EXPLORE_SINK_BODY_MAX } from "../../agent-protocol/explore-sink.js";
import { EXPLORE_FRAME_MAX_BYTES, ExploreFrameRequest, type ExploreFrameAnswer } from "../../agent-protocol/explore-frame.js";
import { FRAME_LIMITS } from "../../engine/frames/shoot.js";
import { frameHub } from "../frame-hub.js";
import { handleExploreLlm } from "../explore-llm.js";
import { handleExploreSink } from "../explore-sink.js";
import { exploreLlmDeps } from "../explore-dispatch.js";
import { MAX_PUSH_BYTES } from "../agent-record.js";
import type { AgentRecord, AgentTokenRecord } from "../agent-store.js";
import { androidSummary } from "../agent-routing.js";
import { getAgentServices, MachineRefused, type AgentService } from "../agent-services.js";
import { HttpError } from "../http-error.js";
import { redactCredentials } from "../../engine/net/company-network.js";
import { RUNNER_UPDATE_HEADER } from "../../agent-protocol/schema.js";
import { runnerUpdatesFor } from "../runner-update.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { currentActor } from "../auth/actor.js";
import { ownerIdOfActor } from "../agent-store.js";
import { registerUpdateAgentRoutes } from "./runner-updates.js";
import type { RouteCtx } from "./types.js";

const JSON_CAP = 2_000_000;
const RESULT_CAP = 8_000_000;
/** Protocol 2: a batch of live events (at most 100 short events). */
const EVENTS_CAP = 1_000_000;

export function publicAgent(a: AgentRecord & { online: boolean; activeTasks: number }) {
    const c = a.capabilities;
    return {
        id: a.id,
        name: a.name,
        version: a.version,
        tokenId: a.tokenId,
        os: a.os,
        arch: a.arch,
        node: a.node,
        online: a.online,
        lastSeenAt: new Date(a.lastSeenMs).toISOString(),
        firstSeenAt: new Date(a.firstSeenMs).toISOString(),
        activeTasks: a.activeTasks,
        concurrency: a.concurrency,
        capabilities: {
            browsers: c.browsers,
            ...(c.record !== undefined ? { record: c.record } : {}),
            ...(c.recordHeaded !== undefined ? { recordHeaded: c.recordHeaded } : {}),
            ...(c.liveSession === true ? { liveSession: true } : {}),
            // AI phone exploration: present only when this agent can host a phone session (an older agent's answer is unchanged).
            ...(c.deviceSession === true ? { deviceSession: true } : {}),
            // The runner's own Android phone tools (only from a runner that fetches them itself; never a path).
            ...(c.phoneTools ? { phoneTools: c.phoneTools } : {}),
            // `state` and `summary` come from the one rule that also decides whether phone tests can run (see androidSummary).
            ...(c.android ? { android: { adb: c.android.adb, devices: c.android.devices.map((d) => ({ serial: d.serial, ...(d.model ? { model: d.model } : {}), state: d.state, emulator: d.emulator })), avds: c.android.avds, state: androidSummary(c.android).state, summary: androidSummary(c.android).summary } } : {}),
            ...(c.ios ? { ios: c.ios } : {}),
            ...(c.windows ? { windows: c.windows } : {}),
            // Only present when the agent was started with --allow-custom-scripts (it will run hand-written scripts).
            ...(c.customScripts === true ? { customScripts: true } : {}),
            // Only present for a runner started from a downloaded runner kit (platform version and bundle hash).
            ...(c.kitVersion ? { kitVersion: c.kitVersion } : {}),
            // Which browser web tests use there, the Chrome and Edge it found, and a sentence while none is ready (only from a runner that reports them).
            ...(c.browser ? { browser: c.browser } : {}),
            ...(c.installedBrowsers?.length ? { installedBrowsers: c.installedBrowsers } : {}),
            ...(c.browserNote ? { browserNote: c.browserNote } : {}),
            // The runner's proxy (host:port only), its trusted certificates and its last network problem (only from a runner that reports them).
            // The problem text is masked once more here in case a sign-in ever slipped into it.
            ...(c.network ? { network: { ...c.network, ...(c.network.problem ? { problem: redactCredentials(c.network.problem) } : {}) } } : {}),
            // "Check this computer": what the runner found when it started (only from a runner that reports it; docs/features/runner-check.md).
            // The lines are masked once more here in case a sign-in ever slipped into one.
            ...(c.check ? { check: { at: c.check.at, items: c.check.items.map((i) => ({ ...i, title: redactCredentials(i.title), ...(i.fix ? { fix: redactCredentials(i.fix) } : {}) })) } } : {}),
        },
    };
}

/** Read a request body of JSON, never more than `cap` bytes. */
async function readJson(req: FastifyRequest, cap: number): Promise<unknown> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > cap) throw tooLarge(req);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.raw) {
        size += (chunk as Buffer).length;
        if (size > cap) throw tooLarge(req);
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw new HttpError(400, "Malformed JSON body");
    }
}

/** The caller's address, for the enrollment rate limit and Activity (a proxy in front is trusted only as the server is configured to). */
const clientAddress = (req: FastifyRequest): string => String(req.ip ?? "unknown").slice(0, 64);

function tooLarge(_req: FastifyRequest): HttpError {
    return new HttpError(413, "The request is too large.");
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    const i = r.error.issues[0];
    throw new HttpError(400, `The ${what} is not in the expected format${i ? ` (${i.path.join(".") || "body"}: ${i.message})` : ""}.`);
}

/**
 * Watch live, a runner's side (explore-frame.ts): the answer says whether anyone watches the job; a picture is kept (in memory only) only while
 * someone does, and only a JPEG within the Explorer view's size limit.
 */
function runnerFrame(jobId: string, req: ExploreFrameRequest): ExploreFrameAnswer {
    const watched = frameHub.isWatched(jobId);
    const f = req.frame;
    if (f && watched) {
        const jpeg = Buffer.from(f.imageBase64, "base64");
        if (jpeg.byteLength > FRAME_LIMITS.maxBytes) throw new HttpError(413, "The picture is larger than the Explorer view allows.");
        if (jpeg.byteLength < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new HttpError(400, "The picture is not a JPEG.");
        frameHub.put(jobId, { jpeg: new Uint8Array(jpeg), url: f.url, title: f.title, note: f.note, phase: f.phase, pagesSeen: f.pagesSeen, at: f.at }, { fromRunner: true });
    }
    return { watched };
}

/** Counts what passes through, and stops at the cap (the store hashes it). */
class CapturingLimit extends Transform {
    size = 0;
    constructor(private readonly cap: number) {
        super();
    }
    override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
        this.size += chunk.length;
        if (this.size > this.cap) return cb(new HttpError(413, `The file is larger than the ${Math.round(this.cap / 1024 / 1024)} MB this platform accepts.`));
        cb(null, chunk);
    }
}

export function registerAgentRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const svc = getAgentServices(p);
    const updates = runnerUpdatesFor(p);

    // ── a project's view of where its tests run (the caller's own runner) ──
    /**
     * The caller's own computer as a list of at most one, with its raw capabilities, never anyone else's. The website reads GET /api/me/runner
     * (with `can`) instead; this stays for the integration tests that check what a runner reported.
     */
    app.get("/api/projects/:id/agents", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const owner = ownerIdOfActor(actorOf(req) ?? currentActor());
        const own = owner && svc.store.ownerMayRun(owner, id) ? svc.store.runnerOf(owner) : undefined;
        if (!own?.agent) return [];
        const a = { ...own.agent, online: own.online, activeTasks: svc.store.runningCount(own.agent.id) };
        // Runner updates (runner-update.ts): only for a runner started from a download, so a checkout-based runner's answer is unchanged.
        return [a.capabilities.kitVersion || a.capabilities.update ? { ...publicAgent(a), update: updates.publicView(a) } : publicAgent(a)];
    });

    app.get("/api/projects/:id/runner", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return svc.runnerStatus(id);
    });

    /** EXECUTION_MODE=local only: whether the project's tests run on this server or on runners (each run on its owner's own runner). */
    app.put("/api/projects/:id/runner", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        // agentId and allowPersonal are accepted and ignored (round 45: no pinned runner, no project switch).
        const body = z.object({ runOn: z.enum(["platform", "agent"]).optional(), agentId: z.string().max(64).nullable().optional(), allowPersonal: z.boolean().optional() }).parse(req.body ?? {});
        if (body.runOn === undefined) return svc.runnerStatus(id);
        // EXECUTION_MODE=runners: nothing runs on this server, so a project cannot be set to run here (runner-only.ts).
        if (body.runOn === "platform" && runnersOnly(ctx.p.config)) throw new HttpError(409, PLATFORM_SETTING_REFUSED, { executionMode: "runners" });
        await ctx.assertNoActiveJob(id);
        svc.store.setRunner(id, { runOn: body.runOn });
        return svc.runnerStatus(id);
    });

    // ── a run's live pictures (protocol 2) ─────────────────────────────────
    // A screenshot a runner uploaded during a run (named by a runner_screenshot event), shown on the run page before the run's results are
    // stored. Only an image of a task of this job of this project; kept with the task for a day, after which the run's own artifacts remain.
    app.get("/api/projects/:id/runs/:jobId/runner-files/:taskId/:name", async (req, reply) => {
        const { id, jobId, taskId, name } = req.params as { id: string; jobId: string; taskId: string; name: string };
        ctx.project(id);
        const job = p.repo.getJob(jobId);
        if (!job || job.projectId !== id) throw new HttpError(404, "Run not found.");
        const type = /\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : undefined;
        if (!SafeName.safeParse(name).success || !type) throw new HttpError(404, "File not found.");
        const task = svc.store.getTask(taskId);
        if (!task || task.jobId !== jobId || task.projectId !== id) throw new HttpError(410, "This live picture is no longer kept. The run's own screenshots are with its results.");
        const file = svc.store.getFile(taskId, "out", name);
        if (!file) throw new HttpError(404, "File not found.");
        const body = await p.store.get(file.path).catch(() => undefined);
        if (!body) throw new HttpError(404, "File not found.");
        return reply.header("content-type", type).header("cache-control", "private, max-age=300").header("x-content-type-options", "nosniff").send(body);
    });

    // ── enrollment: the one agent route without a runner credential (the single-use code in the body is the credential) ──
    void app.register(async (scope) => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser("*", (_req, _payload, done) => done(null));
        scope.post("/api/agent/enroll", async (req, reply) => {
            // Never an Authorization header here: a runner credential is not a code, and a code is never sent as one.
            if (req.headers.authorization) throw new HttpError(400, "Send the enrollment code in the body, without an Authorization header.");
            const body = parse(EnrollRequest, await readJson(req, 64_000), "enrollment request");
            const out = svc.enroll(body, clientAddress(req));
            const t = svc.store.getToken(out.runnerId);
            // Who added which runner, where people look (Activity); the code and the credential are never written anywhere.
            if (t) accessControlOf(app).users.addActivity({ actorKind: "runner", actorId: null, actorName: t.label ?? `Runner …${t.hint}`, action: "runner-enrolled", detail: `Their runner “${t.label ?? body.name.slice(0, 64)}” connected with its one-time code. Any runner they had before was removed.`, projectId: null });
            req.log.info({ audit: "runner-enrolled", tokenId: out.runnerId, kind: out.kind }, "runner enrolled");
            return reply.code(201).send(out);
        });
    });

    // ── the agent protocol ──────────────────────────────────────────────────
    // Its own scope: the raw body is read by the handlers (JSON with a cap, or a file streamed to disk with a cap), and the token check
    // runs before any handler, for these routes and for nothing else.
    void app.register(async (scope) => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser("*", (_req, _payload, done) => done(null));

        const tokenOf = new WeakMap<FastifyRequest, AgentTokenRecord>();
        scope.addHook("onRequest", async (req) => {
            tokenOf.set(req, svc.authenticate(req.headers.authorization));
        });
        const token = (req: FastifyRequest): AgentTokenRecord => tokenOf.get(req)!;
        const other = (req: FastifyRequest) => svc.throttle(token(req), "other");

        // A new credential (migration 51): the presented one keeps working until the new one is first used, at most 24 hours.
        scope.post("/api/agent/rotate", async (req) => {
            svc.throttle(token(req), "hello");
            await readJson(req, JSON_CAP);
            const out = svc.rotate(token(req), req.headers.authorization);
            // Where people look (Activity): which runner changed its credential. Never the credential itself.
            const t = token(req);
            accessControlOf(app).users.addActivity({ actorKind: "runner", actorId: null, actorName: t.label ?? `Runner …${t.hint}`, action: "runner-credential-rotated", detail: `The runner “${t.label ?? `…${t.hint}`}” changed its credential. The previous one stops working once the new one is used, or after 24 hours.`, projectId: null });
            req.log.info({ audit: "runner-credential-rotated", tokenId: t.id }, "runner credential rotated");
            return out;
        });
        scope.post("/api/agent/hello", async (req) => {
            svc.throttle(token(req), "hello");
            const body = parse(HelloRequest, await readJson(req, JSON_CAP), "hello message");
            let answer: ReturnType<AgentService["hello"]>;
            try {
                answer = svc.hello(token(req), body);
            } catch (e) {
                // A credential used from another computer: refused, and written down where people look (Activity). Never the credential.
                if (e instanceof MachineRefused) {
                    const t = e.token;
                    accessControlOf(app).users.addActivity({ actorKind: "runner", actorId: null, actorName: t.label ?? `Runner …${t.hint}`, action: "runner-refused", detail: `Runner “${t.label ?? t.hint}” was refused: its credential was used from another computer (“${body.name.slice(0, 64)}”, ${clientAddress(req)}).`, projectId: null });
                }
                throw e;
            }
            // Runner updates: record what it reports, and offer the platform's runner files when it should move to them.
            const registered = svc.store.getAgent(answer.agentId);
            if (!registered) return answer;
            updates.observe(registered, body.capabilities);
            const offer = updates.offer(registered);
            return offer ? { ...answer, update: offer } : answer;
        });

        // "Check this computer" (docs/features/runner-check.md): the hook above already decided whether the token is accepted. Nothing is made or
        // changed (no runner row).
        scope.post("/api/agent/check", async (req) => {
            other(req);
            return { ok: true };
        });

        scope.post("/api/agent/poll", async (req, reply) => {
            other(req);
            const body = parse(PollRequest, await readJson(req, JSON_CAP), "poll message");
            const agent = svc.agentOf(token(req), body.agentId);
            svc.store.touchAgent(agent.id, body.capabilities);
            const fresh = svc.store.getAgent(agent.id)!;
            updates.observe(fresh, body.capabilities);
            // Tells an idle runner that it should update (it then asks POST /api/agent/update); an older runner ignores the header.
            const hint = updates.hint(fresh);
            if (hint) reply.header(RUNNER_UPDATE_HEADER, hint);
            const poll = svc.beginPoll(agent.id);
            let closed = false;
            reply.raw.on("close", () => void (closed = true));
            const until = svc.clock() + svc.limits.pollSeconds * 1000;
            let lastSeen = svc.clock();
            try {
                for (;;) {
                    // A runner retired while its poll was open gets nothing more: the token is read again on every turn.
                    if (closed || poll.superseded() || !svc.store.tokenLive(token(req).id)) return reply.code(204).send();
                    const offer = svc.offerTo(svc.store.getAgent(agent.id) ?? fresh, body.freeSlots);
                    if (offer) return reply.code(200).send(offer);
                    if (svc.clock() >= until) return reply.code(204).send();
                    if (svc.clock() - lastSeen > 5000) {
                        svc.store.touchAgent(agent.id);
                        lastSeen = svc.clock();
                    }
                    await new Promise((r) => setTimeout(r, 250));
                }
            } finally {
                poll.end();
            }
        });

        scope.post("/api/agent/tasks/:id/heartbeat", async (req) => {
            other(req);
            const { id } = req.params as { id: string };
            return svc.heartbeat(token(req), id, parse(HeartbeatRequest, await readJson(req, JSON_CAP), "heartbeat"));
        });

        scope.get("/api/agent/tasks/:id/files/:ref", async (req, reply) => {
            other(req);
            const { id, ref } = req.params as { id: string; ref: string };
            if (!SafeName.safeParse(ref).success) throw new HttpError(400, "Unsafe file name.");
            const { file, key } = svc.downloadable(token(req), id, ref);
            const st = await p.store.head(key).catch(() => undefined);
            if (!st) throw new HttpError(404, "File not found.");
            if (st.size !== file.size) throw new HttpError(409, "The file changed after the task was created. Run the tests again.");
            // Streamed from the store, never read into memory (an app can be hundreds of megabytes).
            const body = await p.store.get(key).catch(() => undefined);
            if (!body) throw new HttpError(404, "File not found.");
            return reply.header("content-type", "application/octet-stream").header("content-length", String(st.size)).header("x-content-sha256", file.sha256).send(body);
        });

        scope.put("/api/agent/tasks/:id/files/:name", async (req, reply) => {
            other(req);
            const { id, name } = req.params as { id: string; name: string };
            const declared = Number(req.headers["content-length"] ?? 0);
            const attempt = req.headers[ATTEMPT_HEADER];
            // The task's upload budget is reserved for this upload until it ends (two uploads at once cannot pass the limits together).
            const target = svc.uploadTarget(token(req), id, name, typeof attempt === "string" ? attempt : undefined, Number.isFinite(declared) ? declared : 0);
            try {
                const cap = target.cap;
                if (declared > cap) {
                    reply.header("connection", "close");
                    throw new HttpError(413, `The file is larger than the ${Math.round(svc.limits.maxFileBytes / 1024 / 1024)} MB this platform accepts.`);
                }
                const claimed = String(req.headers["x-content-sha256"] ?? "").toLowerCase();
                if (claimed && !/^[0-9a-f]{64}$/.test(claimed)) throw new HttpError(400, "X-Content-SHA256 must be 64 hexadecimal characters.");
                // Streamed into the store, which never shows a half-sent file under the final name (object-store.ts, put).
                const counter = new CapturingLimit(cap);
                const body = new PassThrough();
                const feeding = pipeline(req.raw, counter, body);
                feeding.catch(() => undefined); // its outcome is read below
                let saved: { size: number; sha256?: string };
                try {
                    saved = await p.store.put(target.key, body, {
                        contentType: "application/octet-stream",
                        ...(declared > 0 ? { size: declared } : {}),
                        // The platform's own hash is the truth; a client claim that disagrees means the bytes were damaged on the way, and the file is not kept.
                        verify: (r) => {
                            if (claimed && claimed !== r.sha256) throw new HttpError(400, "The uploaded bytes do not match the hash the runner announced.");
                        },
                    });
                } catch (e) {
                    body.destroy();
                    const fed = await feeding.then(
                        () => undefined,
                        (err: unknown) => err,
                    );
                    if (fed instanceof HttpError) {
                        reply.header("connection", "close");
                        throw fed;
                    }
                    if (e instanceof HttpError) throw e;
                    throw new HttpError(400, "The upload was interrupted.");
                }
                const sha256 = saved.sha256!;
                svc.recordUpload(target.task, name, target.key, saved.size, sha256);
                const out: UploadResponse = { ref: name, size: saved.size, sha256 };
                return out;
            } finally {
                target.release();
            }
        });

        // Protocol 2 (docs/features/runner-protocol-2.md): accept or turn down a task that was handed out, and the run's live events.
        scope.post("/api/agent/tasks/:id/accept", async (req) => {
            other(req);
            const { id } = req.params as { id: string };
            return svc.accept(token(req), id, parse(AcceptRequest, await readJson(req, JSON_CAP), "accept message").attemptId);
        });

        scope.post("/api/agent/tasks/:id/reject", async (req) => {
            other(req);
            const { id } = req.params as { id: string };
            return svc.reject(token(req), id, parse(RejectRequest, await readJson(req, JSON_CAP), "reject message"));
        });

        scope.post("/api/agent/tasks/:id/events", async (req) => {
            other(req);
            const { id } = req.params as { id: string };
            return svc.events(token(req), id, parse(EventsRequest, await readJson(req, EVENTS_CAP), "events message"));
        });

        // A recording's state (record tasks only). The body is capped and validated; nothing in it is logged.
        scope.post("/api/agent/tasks/:id/recording", async (req) => {
            other(req);
            const { id } = req.params as { id: string };
            return svc.pushRecording(token(req), id, parse(RecordingPush, await readJson(req, MAX_PUSH_BYTES), "recording update"));
        });

        // A phone session's state and answers (device tasks only). The body is capped and validated; nothing in it is logged.
        scope.post("/api/agent/tasks/:id/device", async (req) => {
            other(req);
            const { id } = req.params as { id: string };
            return svc.pushDevice(token(req), id, parse(DevicePush, await readJson(req, MAX_DEVICE_PUSH_BYTES), "phone session update"));
        });

        // Round 51: an exploration on a runner asks the job's AI and saves what it finds. Fenced to this runner's own running explore task and
        // its current attempt (AgentService.exploreTask), then the body is read with its cap and handed over (explore-llm.ts, explore-sink.ts).
        const exploreCall = async (req: FastifyRequest, reply: FastifyReply, route: "llm" | "sink" | "frame") => {
            other(req);
            const { id } = req.params as { id: string };
            const attempt = req.headers[ATTEMPT_HEADER];
            const task = svc.exploreTask(token(req), id, typeof attempt === "string" ? attempt : undefined);
            // Round 52: a restarting platform takes no new call; the runner sends it again to the next process (explore-transport.ts).
            if (svc.draining) throw new HttpError(503, "The platform is restarting. The runner sends this again in a moment.");
            const body = await readJson(req, route === "llm" ? EXPLORE_LLM_MAX_BYTES : route === "frame" ? EXPLORE_FRAME_MAX_BYTES : EXPLORE_SINK_BODY_MAX);
            if (route === "frame") return runnerFrame(task.jobId, parse(ExploreFrameRequest, body, "picture"));
            if (route === "sink") return handleExploreSink(p, task, body);
            // The request closing before its answer (the runner gone, the task stopped or handed out again) stops the provider call.
            const gone = new AbortController();
            reply.raw.once("close", () => {
                if (!reply.raw.writableFinished) gone.abort();
            });
            // The job's model is built from the job's own worker deps (explore-dispatch.ts), as runJobAs builds it.
            return handleExploreLlm(exploreLlmDeps(task.taskId) ?? p, task, body, gone.signal);
        };
        scope.post("/api/agent/tasks/:id/explore/llm", async (req, reply) => exploreCall(req, reply, "llm"));
        scope.post("/api/agent/tasks/:id/explore/sink", async (req, reply) => exploreCall(req, reply, "sink"));
        scope.post("/api/agent/tasks/:id/explore/frame", async (req, reply) => exploreCall(req, reply, "frame"));

        // Runner updates: the offer and its files (routes/runner-updates.ts), behind the same token check.
        registerUpdateAgentRoutes(scope, { svc, updates, token, other });

        scope.post("/api/agent/tasks/:id/result", async (req) => {
            other(req);
            const { id } = req.params as { id: string };
            return svc.result(token(req), id, parse(ResultRequest, await readJson(req, RESULT_CAP), "result"));
        });
    });
}
