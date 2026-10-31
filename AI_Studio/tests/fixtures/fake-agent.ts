/**
 * A runner agent written for tests: plain HTTP speaking the protocol, running nothing. It claims tasks, downloads what they name,
 * uploads canned artifact bytes and posts canned results. Works over real HTTP (`viaFetch`) or Fastify's `inject` (`viaInject`).
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Capabilities, ResultRequest, TaskOffer, WireRun } from "../../src/agent-protocol/schema.js";

export interface Reply {
    status: number;
    headers: Record<string, string>;
    bytes: Buffer;
    text: string;
    json: any;
}
export type Send = (method: string, path: string, opts?: { headers?: Record<string, string>; body?: Buffer | string }) => Promise<Reply>;

const toReply = (status: number, headers: Record<string, string>, bytes: Buffer): Reply => {
    const text = bytes.toString("utf8");
    let json: any;
    try {
        json = text ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    return { status, headers, bytes, text, json };
};

export const viaFetch =
    (base: string): Send =>
    async (method, path, opts = {}) => {
        const res = await fetch(`${base}${path}`, { method, headers: opts.headers, body: opts.body === undefined ? undefined : (opts.body as never) });
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
            headers[key] = value;
        });
        return toReply(res.status, headers, Buffer.from(await res.arrayBuffer()));
    };

export const viaInject =
    (server: FastifyInstance): Send =>
    async (method, path, opts = {}) => {
        const res = await server.inject({ method: method as "GET", url: path, headers: opts.headers, payload: opts.body as never });
        return toReply(res.statusCode, Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])), res.rawPayload);
    };

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export const defaultCaps = (over: Partial<Capabilities> = {}): Capabilities => ({ os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"], ...over });

/** What a canned task answer looks like: the runs, plus artifacts to upload first (name to bytes). */
export interface Canned {
    ok?: boolean;
    error?: string;
    runs?: WireRun[];
    uploads?: Record<string, Buffer | string>;
}

export const passedRun = (testId: string, over: Partial<WireRun> = {}): WireRun => ({ testId, status: "passed", durationMs: 120, failedStepIndex: -1, steps: [{ index: 0, title: "1. Call the endpoint", status: "passed" }], artifacts: [], responses: [], ...over });
export const failedRun = (testId: string, error: string, over: Partial<WireRun> = {}): WireRun => ({ testId, status: "failed", durationMs: 340, error, failedStepIndex: 0, steps: [{ index: 0, title: "1. Call the endpoint", status: "failed", error }], artifacts: [], responses: [], ...over });

export class FakeAgent {
    agentId = "";
    constructor(
        readonly send: Send,
        readonly token: string,
        readonly opts: { name?: string; capabilities?: Capabilities; concurrency?: number } = {},
    ) {}

    private auth(extra: Record<string, string> = {}): Record<string, string> {
        return { authorization: `Bearer ${this.token}`, ...extra };
    }
    private json(body: unknown): { headers: Record<string, string>; body: string } {
        return { headers: this.auth({ "content-type": "application/json" }), body: JSON.stringify(body) };
    }

    async hello(over: Record<string, unknown> = {}): Promise<Reply> {
        const r = await this.send("POST", "/api/agent/hello", this.json({ protocol: 1, name: this.opts.name ?? "fake-agent", version: "0.0.0-test", capabilities: this.opts.capabilities ?? defaultCaps(), concurrency: this.opts.concurrency ?? 1, ...over }));
        if (r.status === 200) this.agentId = r.json.agentId;
        return r;
    }

    async poll(freeSlots = 1, over: Record<string, unknown> = {}): Promise<Reply & { offer?: TaskOffer }> {
        const r = await this.send("POST", "/api/agent/poll", this.json({ agentId: this.agentId, freeSlots, ...over }));
        return Object.assign(r, r.status === 200 ? { offer: r.json as TaskOffer } : {});
    }

    heartbeat(taskId: string, body: Record<string, unknown> = {}): Promise<Reply> {
        return this.send("POST", `/api/agent/tasks/${taskId}/heartbeat`, this.json(body));
    }

    download(taskId: string, ref: string): Promise<Reply> {
        return this.send("GET", `/api/agent/tasks/${taskId}/files/${ref}`, { headers: this.auth() });
    }

    upload(taskId: string, name: string, bytes: Buffer | string, headers: Record<string, string> = {}): Promise<Reply> {
        return this.send("PUT", `/api/agent/tasks/${taskId}/files/${name}`, { headers: this.auth({ "content-type": "application/octet-stream", ...headers }), body: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) });
    }

    /** A record task's state (RecordingPush). */
    recording(taskId: string, body: Record<string, unknown>): Promise<Reply> {
        return this.send("POST", `/api/agent/tasks/${taskId}/recording`, this.json(body));
    }

    result(taskId: string, body: ResultRequest | Record<string, unknown>): Promise<Reply> {
        return this.send("POST", `/api/agent/tasks/${taskId}/result`, this.json(body));
    }

    /** Claim the next task, waiting up to `ms` (the platform long-polls for a short time in tests). */
    async next(ms = 20_000, freeSlots = 1): Promise<TaskOffer | undefined> {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const r = await this.poll(freeSlots);
            if (r.offer) return r.offer;
            if (r.status !== 204) throw new Error(`poll answered ${r.status}: ${r.text}`);
        }
        return undefined;
    }

    /** Upload the canned files, then post the canned result. Returns the result reply. */
    async answer(offer: TaskOffer, canned: Canned): Promise<Reply> {
        for (const [name, bytes] of Object.entries(canned.uploads ?? {})) {
            const up = await this.upload(offer.taskId, name, bytes);
            if (up.status !== 200) throw new Error(`upload of ${name} answered ${up.status}: ${up.text}`);
        }
        return this.result(offer.taskId, canned.ok === false ? { ok: false, error: canned.error ?? "The agent could not run the tests.", runs: [] } : { ok: true, runs: canned.runs ?? offer.scripts.map((s) => passedRun(s.testId)) });
    }

    /** Serve tasks until `done()` says stop: each task is answered by `handler`. */
    async serve(handler: (offer: TaskOffer) => Promise<Canned | "silent"> | Canned | "silent", done: () => boolean, seen: TaskOffer[] = []): Promise<TaskOffer[]> {
        while (!done()) {
            const r = await this.poll(1);
            if (!r.offer) continue;
            seen.push(r.offer);
            const canned = await handler(r.offer);
            if (canned !== "silent") await this.answer(r.offer, canned);
        }
        return seen;
    }
}
