/**
 * A fake platform for the runner-agent tests: a small HTTP server that speaks the agent protocol
 * (src/agent-protocol/schema.ts) and holds canned tasks. It runs nothing itself; it records what the agent sends so tests can
 * check hellos, heartbeats, uploaded bytes and results. The agent under test is the real one.
 */
import crypto from "node:crypto";
import http from "node:http";
import { HeartbeatRequest, HelloRequest, PollRequest, ResultRequest, SafeName, type TaskOffer } from "../../src/agent-protocol/schema.js";

export interface FakeTask {
    offer: TaskOffer;
    /** Files the agent may download for this task, by ref (baselines, the APK). */
    files?: Map<string, Buffer>;
}

export interface Upload {
    bytes: Buffer;
    sha256: string;
    declaredLength: number | undefined;
}

export interface FakeOptions {
    token: string;
    pollWaitMs?: number;
    heartbeatSeconds?: number;
    maxFileBytes?: number;
    protocol?: number;
}

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

export class FakePlatform {
    readonly hellos: HelloRequest[] = [];
    readonly polls: PollRequest[] = [];
    readonly heartbeats = new Map<string, HeartbeatRequest[]>();
    readonly results = new Map<string, ResultRequest>();
    readonly uploads = new Map<string, Map<string, Upload>>();
    readonly downloads: string[] = [];
    readonly badResults: string[] = [];
    readonly authFailures: number[] = [];
    /** Task ids whose next heartbeat says cancel. */
    readonly cancel = new Set<string>();
    /** Answer to hello/poll for a token the platform does not accept: 404 (revoked) or 401. */
    rejectToken: 401 | 404 | 409 | undefined;
    /** Answer the next N polls with something that is not a task. */
    garbagePolls = 0;
    /** Make the next N uploads fail with HTTP 500 (the agent retries). */
    failUploads = 0;
    protocol: number;
    private readonly queue: FakeTask[] = [];
    private readonly tasks = new Map<string, FakeTask>();
    private server?: http.Server;
    private readonly waiters = new Map<string, Array<(r: ResultRequest) => void>>();

    constructor(
        readonly port: number,
        readonly opts: FakeOptions,
    ) {
        this.protocol = opts.protocol ?? 1;
    }

    get url(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    /** Offer a task to the next poll that has a free slot. */
    enqueue(task: FakeTask): void {
        this.tasks.set(task.offer.taskId, task);
        this.queue.push(task);
    }

    result(taskId: string, timeoutMs = 120_000): Promise<ResultRequest> {
        const done = this.results.get(taskId);
        if (done) return Promise.resolve(done);
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`no result for task ${taskId} within ${timeoutMs} ms`)), timeoutMs);
            const list = this.waiters.get(taskId) ?? [];
            list.push((r) => (clearTimeout(t), resolve(r)));
            this.waiters.set(taskId, list);
        });
    }

    start(): Promise<void> {
        this.server = http.createServer((req, res) => void this.handle(req, res).catch(() => (res.headersSent ? res.end() : (res.writeHead(500), res.end()))));
        return new Promise((resolve) => this.server!.listen(this.port, "127.0.0.1", () => resolve()));
    }

    /** Stop listening and drop every connection (a crashed or restarting platform). */
    stop(): Promise<void> {
        const s = this.server;
        this.server = undefined;
        return new Promise((resolve) => {
            if (!s) return resolve();
            s.closeAllConnections();
            s.close(() => resolve());
        });
    }

    private json(res: http.ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    }

    private async body(req: http.IncomingMessage): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return Buffer.concat(chunks);
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", this.url);
        const auth = String(req.headers.authorization ?? "");
        if (this.rejectToken || auth !== `Bearer ${this.opts.token}`) {
            await this.body(req);
            const status = this.rejectToken ?? 401;
            this.authFailures.push(status);
            return this.json(res, status, { error: status === 409 ? "Another agent with this name is already connected." : "Token is not valid." });
        }
        const route = `${req.method} ${url.pathname}`;
        if (route === "POST /api/agent/hello") {
            const parsed = HelloRequest.safeParse(JSON.parse((await this.body(req)).toString("utf8")));
            if (!parsed.success) return this.json(res, 400, { error: "bad hello" });
            this.hellos.push(parsed.data);
            return this.json(res, 200, {
                agentId: "agent-fake-0001",
                projectId: "project-fake-0001",
                protocol: this.protocol,
                pollSeconds: 1,
                heartbeatSeconds: this.opts.heartbeatSeconds ?? 1,
                maxFileBytes: this.opts.maxFileBytes ?? 64 * 1024 * 1024,
                serverTime: new Date().toISOString(),
            });
        }
        if (route === "POST /api/agent/poll") {
            const parsed = PollRequest.safeParse(JSON.parse((await this.body(req)).toString("utf8")));
            if (!parsed.success) return this.json(res, 400, { error: "bad poll" });
            this.polls.push(parsed.data);
            if (this.garbagePolls > 0) {
                this.garbagePolls--;
                res.writeHead(200, { "content-type": "application/json" });
                return void res.end(this.garbagePolls % 2 === 0 ? "{ this is not json" : JSON.stringify({ taskId: "garbage-task", nonsense: true }));
            }
            const wait = this.opts.pollWaitMs ?? 300;
            const deadline = Date.now() + wait;
            while (Date.now() < deadline && !(this.queue.length > 0 && parsed.data.freeSlots >= 1) && !req.destroyed) await new Promise((r) => setTimeout(r, 25));
            if (this.queue.length > 0 && parsed.data.freeSlots >= 1) return this.json(res, 200, this.queue.shift()!.offer);
            res.writeHead(204);
            return void res.end();
        }
        const m = /^\/api\/agent\/tasks\/([^/]+)\/(heartbeat|result|files\/([^/]+))$/.exec(url.pathname);
        if (!m) return this.json(res, 404, { error: "not found" });
        const taskId = decodeURIComponent(m[1]!);
        const task = this.tasks.get(taskId);
        if (!task) {
            await this.body(req);
            return this.json(res, 404, { error: "No such task." });
        }
        if (m[2] === "heartbeat" && req.method === "POST") {
            const parsed = HeartbeatRequest.safeParse(JSON.parse((await this.body(req)).toString("utf8")));
            if (!parsed.success) return this.json(res, 400, { error: "bad heartbeat" });
            this.heartbeats.set(taskId, [...(this.heartbeats.get(taskId) ?? []), parsed.data]);
            return this.json(res, 200, { cancel: this.cancel.has(taskId), leaseSeconds: 60 });
        }
        if (m[2] === "result" && req.method === "POST") {
            const raw = (await this.body(req)).toString("utf8");
            const parsed = ResultRequest.safeParse(JSON.parse(raw));
            if (!parsed.success) {
                this.badResults.push(JSON.stringify(parsed.error.issues[0]));
                return this.json(res, 400, { error: "bad result" });
            }
            if (this.results.has(taskId)) return this.json(res, 409, { error: "A result was already accepted." });
            this.results.set(taskId, parsed.data);
            for (const w of this.waiters.get(taskId) ?? []) w(parsed.data);
            return this.json(res, 200, { ok: true });
        }
        if (m[3] && req.method === "GET") {
            const ref = decodeURIComponent(m[3]);
            const bytes = task.files?.get(ref);
            if (!bytes) return this.json(res, 404, { error: "No such file." });
            this.downloads.push(`${taskId}/${ref}`);
            res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
            return void res.end(bytes);
        }
        if (m[3] && req.method === "PUT") {
            const name = decodeURIComponent(m[3]);
            const bytes = await this.body(req);
            if (!SafeName.safeParse(name).success) return this.json(res, 400, { error: "unsafe file name" });
            if (bytes.length > (this.opts.maxFileBytes ?? 64 * 1024 * 1024)) return this.json(res, 413, { error: "File too large." });
            if (this.failUploads > 0) {
                this.failUploads--;
                return this.json(res, 500, { error: "storage hiccup" });
            }
            const entry: Upload = { bytes, sha256: sha(bytes), declaredLength: req.headers["content-length"] ? Number(req.headers["content-length"]) : undefined };
            const files = this.uploads.get(taskId) ?? new Map<string, Upload>();
            files.set(name, entry);
            this.uploads.set(taskId, files);
            return this.json(res, 200, { ref: name, size: bytes.length, sha256: entry.sha256 });
        }
        return this.json(res, 405, { error: "method not allowed" });
    }
}

export const sha256Hex = sha;
