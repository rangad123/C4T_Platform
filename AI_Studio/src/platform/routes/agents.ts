/**
 * Runner agent routes.
 *
 * Admin routes (API key, like every other route): tokens, the agent list, where a project's tests run.
 * Agent routes (/api/agent/*, the six of the protocol): no API key, the agent token is the credential. The server's API-key hook skips
 * exactly those six (see agent-routing.ts) and EVERY handler registered below authenticates with the token first (one hook on the
 * encapsulated scope, so a handler cannot forget). An API key is never accepted instead of the token.
 */
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { DevicePush, HeartbeatRequest, HelloRequest, PollRequest, RecordingPush, ResultRequest, SafeName, type UploadResponse } from "../../agent-protocol/schema.js";
import { MAX_DEVICE_PUSH_BYTES } from "../agent-device.js";
import { MAX_PUSH_BYTES } from "../agent-record.js";
import type { AgentTokenRecord } from "../agent-store.js";
import { androidSummary } from "../agent-routing.js";
import { getAgentServices, type AgentService } from "../agent-services.js";
import { HttpError } from "../http-error.js";
import { redactCredentials } from "../../engine/net/company-network.js";
import { RUNNER_UPDATE_HEADER } from "../../agent-protocol/schema.js";
import { runnerUpdatesFor } from "../runner-update.js";
import { maxTokensFrom, runnerLimitMessage } from "../runner-kit.js";
import { registerUpdateAgentRoutes } from "./runner-updates.js";
import type { RouteCtx } from "./types.js";

const JSON_CAP = 2_000_000;
const RESULT_CAP = 8_000_000;

const publicToken = (t: AgentTokenRecord) => ({ id: t.id, label: t.label, hint: `aitg_…${t.hint}`, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, revokedAt: t.revokedAt });

function publicAgent(a: ReturnType<AgentService["store"]["listAgents"]>[number]) {
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

function tooLarge(_req: FastifyRequest): HttpError {
    return new HttpError(413, "The request is too large.");
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    const i = r.error.issues[0];
    throw new HttpError(400, `The ${what} is not in the expected format${i ? ` (${i.path.join(".") || "body"}: ${i.message})` : ""}.`);
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

    // ── admin: tokens ───────────────────────────────────────────────────────
    app.get("/api/projects/:id/agent-tokens", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return svc.store.listTokens(id).map(publicToken);
    });

    app.post("/api/projects/:id/agent-tokens", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = z.object({ label: z.string().trim().max(60).optional() }).parse(req.body ?? {});
        // One runner per project (same limit as the kit download): refuse a new token until the current runner is removed.
        const max = maxTokensFrom();
        if (svc.store.countActiveTokens(id) >= max) throw new HttpError(409, runnerLimitMessage(max));
        const { secret, record } = svc.store.createToken(id, body.label);
        // The only time the token is shown. It is not stored, logged or returned again.
        return reply.code(201).send({ token: publicToken(record), secret });
    });

    app.delete("/api/projects/:id/agent-tokens/:tid", async (req) => {
        const { id, tid } = req.params as { id: string; tid: string };
        ctx.project(id);
        if (!svc.store.revokeToken(id, tid)) throw new HttpError(404, "Token not found, or already revoked.");
        return { ok: true };
    });

    // ── admin: agents and where tests run ───────────────────────────────────
    app.get("/api/projects/:id/agents", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        // Runner updates (runner-update.ts): only for a runner started from a download, so a checkout-based runner's answer is unchanged.
        return svc.store.listAgents(id).map((a) => (a.capabilities.kitVersion || a.capabilities.update ? { ...publicAgent(a), update: updates.publicView(a) } : publicAgent(a)));
    });

    app.get("/api/projects/:id/runner", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return svc.runnerStatus(id);
    });

    app.put("/api/projects/:id/runner", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = z.object({ runOn: z.enum(["platform", "agent"]), agentId: z.string().max(64).nullable().optional() }).parse(req.body ?? {});
        await ctx.assertNoActiveJob(id);
        if (body.runOn === "agent") {
            const agentId = body.agentId ?? null;
            if (agentId && svc.store.getAgent(agentId)?.projectId !== id) throw new HttpError(404, "That runner agent does not belong to this project.");
            const online = svc.eligibleAgents(id, { runOn: "agent", agentId });
            if (online.length === 0) throw new HttpError(409, agentId ? "That runner agent is not online. Start it, then try again." : "No runner agent is online for this project. Start one, then try again.");
            svc.store.setRunner(id, { runOn: "agent", agentId });
        } else svc.store.setRunner(id, { runOn: "platform", agentId: null });
        return svc.runnerStatus(id);
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
        scope.post("/api/agent/hello", async (req) => {
            svc.throttle(token(req), "hello");
            const body = parse(HelloRequest, await readJson(req, JSON_CAP), "hello message");
            const answer = svc.hello(token(req), body);
            // Runner updates: record what it reports, and offer the platform's runner files when it should move to them.
            const registered = svc.store.getAgent(answer.agentId);
            if (!registered) return answer;
            updates.observe(registered, body.capabilities);
            const offer = updates.offer(registered);
            return offer ? { ...answer, update: offer } : answer;
        });

        // "Check this computer" (docs/features/runner-check.md): the hook above already decided whether the token is accepted. Nothing is made or
        // changed (no runner row); the answer names the project so the check can say which one the download belongs to.
        scope.post("/api/agent/check", async (req) => {
            other(req);
            let project = "";
            try {
                project = String((ctx.project(token(req).projectId) as { name?: unknown }).name ?? "").slice(0, 120);
            } catch {
                /* the name is only for the sentence */
            }
            return { ok: true, ...(project ? { project } : {}) };
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
                    if (closed || poll.superseded()) return reply.code(204).send();
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
            const target = svc.uploadTarget(token(req), id, name);
            const cap = Math.min(svc.limits.maxFileBytes, Math.max(0, svc.limits.taskMaxBytes - svc.store.uploadedTotals(id).bytes));
            const declared = Number(req.headers["content-length"] ?? 0);
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
                        if (claimed && claimed !== r.sha256) throw new HttpError(400, "The uploaded bytes do not match the hash the agent announced.");
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

        // Runner updates: the offer and its files (routes/runner-updates.ts), behind the same token check.
        registerUpdateAgentRoutes(scope, { svc, updates, token, other });

        scope.post("/api/agent/tasks/:id/result", async (req) => {
            other(req);
            const { id } = req.params as { id: string };
            return svc.result(token(req), id, parse(ResultRequest, await readJson(req, RESULT_CAP), "result"));
        });
    });
}
