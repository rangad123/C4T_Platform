/**
 * Watch live for an exploration on a runner (docs/features/ux-explorer-view.md, explore-frame.ts): the runner asks whether anyone watches
 * (POST /api/agent/tasks/:id/explore/frame without a picture), sends pictures only while someone does, and the person's page reads them from
 * GET /api/projects/:id/jobs/:jobId/frame, said to be of the browser on their runner. Hand-driven agents prove the route's rules (fencing, the
 * watch rule, the size and JPEG checks, an older runner's sentence); the REAL runner from source then explores a slow local site while the
 * test watches, and its pictures arrive.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/explore-frames-on-runner.test.ts
 * Ports: platform 9430, sample site 9431. No real model, no network beyond 127.0.0.1.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { llmClientFromModel } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { frameHub, REASONS } from "../src/platform/frame-hub.js";
import { removeServerExecutionGuard } from "../src/platform/runner-only.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { personalRunner, testPerson } from "./helpers/personal-runner.js";

const PORT = 9430;
const SITE_PORT = 9431;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const API_KEY = "explore-frames-admin-key-7c21";
const PASSWORD = "Frames-Pass word/42&z";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_ACCEPT_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const caps = (frames = true) => ({ os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"], runnerSwitches: true, explore: true, ...(frames ? { explorerFrames: true } : {}) });
/** How long each page of the sample site takes to answer: long enough for the exploring phase to be watched. */
const SLOW_MS = 1500;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dispatch: Worker;
let dataDir: string;
let site: http.Server;
const work: string[] = [];

// ── the scripted model on the platform ───────────────────────────────────────
const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
/** Tool calls the authoring agent makes, queued when the plan is produced. */
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
/** Set to hold every model call until released (the cancel test). */
let hold: Promise<void> | undefined;
let modelCalls = 0;
const systemOf = (prompt: Array<{ role: string; content: unknown }>) => prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const model = new MockLanguageModelV3({
    provider: "scripted-provider",
    modelId: "scripted-model",
    doGenerate: async (o) => {
        modelCalls++;
        if (hold) await hold;
        if (o.tools?.length) {
            const next = toolQueue.shift() ?? { tool: "finish", input: { result: "complete", explanation: "checked" } };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${modelCalls}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        }
        const system = systemOf(o.prompt as Array<{ role: string; content: unknown }>);
        if (/analysing a web application/.test(system)) {
            return json({
                siteType: "ecommerce",
                purpose: "A small shop",
                features: ["Browse products"],
                pagePurposes: [],
                journeys: [{ name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false }],
                authenticationMechanisms: [],
            });
        }
        if (/planning a web test suite/.test(system)) {
            toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Products" } } }, { tool: "finish", input: { result: "complete", explanation: "checked" } });
            return json({ scenarios: [ScenarioSchema.omit({ scenarioId: true }).parse({ title: "Browse the product list", description: "Browse the product list", category: "Browsing", priority: "high", journey: "Browse products", startPath: "/products", expectedResults: ["Products is shown"] })] });
        }
        return json({});
    },
});

// ── helpers ──────────────────────────────────────────────────────────────────
const call = async (method: string, url: string, body?: unknown, key = API_KEY) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
const agentApi = async (token: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
};
const svc = () => getAgentServices(platform);
const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
};
const jobDone = async (jobId: string, ms = 120_000) => {
    let j: any;
    await until("the job to finish", () => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes((j = platform.repo.getJob(jobId)!).status), ms);
    return j;
};


/** A person with their own API token (they start explorations) and a project they own. */
async function person(name: string) {
    const who = testPerson(platform);
    const project = (await call("POST", "/api/projects", { name }, who.token)).body.id as string;
    return { ...who, project };
}
async function rawAgent(ownerId: string, name: string, frames = true) {
    const { secret } = personalRunner(platform, { ownerId, label: name });
    const hello = await agentApi(secret, "POST", "/api/agent/hello", { protocol: 1, protocols: [1, 2], name, version: "56.0.0", concurrency: 1, capabilities: caps(frames) });
    expect(hello.status).toBe(200);
    return { token: secret, agentId: hello.body.agentId as string, frames };
}
const poll = async (a: { token: string; agentId: string; frames: boolean }) => {
    for (let i = 0; i < 20; i++) {
        const r = await agentApi(a.token, "POST", "/api/agent/poll", { agentId: a.agentId, freeSlots: 1, capabilities: caps(a.frames) });
        if (r.status === 200 && r.body) return r.body;
    }
    throw new Error("no offer");
};
const explore = (p: { token: string; project: string }, over: Record<string, unknown> = {}) =>
    call("POST", `/api/projects/${p.project}/test-generation`, { url: SITE, targets: ["web"], maxPages: 3, credentials: { username: "shopper@example.test", password: PASSWORD }, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false, useMemory: false, ...over }, p.token);
/** An exploration accepted by a hand-driven runner and in its exploring phase. */
async function exploring(name: string, frames = true) {
    const p = await person(name);
    const a = await rawAgent(p.id, `${name} laptop`, frames);
    const started = await explore(p);
    expect(started.status, started.text).toBe(202);
    const offer = await poll(a);
    expect((await agentApi(a.token, "POST", `/api/agent/tasks/${offer.taskId}/accept`, { attemptId: offer.attemptId })).status).toBe(200);
    const sink = await agentApi(a.token, "POST", `/api/agent/tasks/${offer.taskId}/explore/sink`, { calls: [{ method: "phase", status: "DISCOVERING", phase: "discovery", state: "running" }] }, { "x-attempt-id": offer.attemptId });
    expect(sink.status).toBe(200);
    await until("the job to be exploring", () => platform.repo.getJob(started.body.jobId)!.status === "DISCOVERING");
    const jobId = started.body.jobId as string;
    const frame = (body: unknown, attempt: string | null = offer.attemptId, token = a.token) => agentApi(token, "POST", `/api/agent/tasks/${offer.taskId}/explore/frame`, body, attempt ? { "x-attempt-id": attempt } : {});
    const watch = () => call("GET", `/api/projects/${p.project}/jobs/${jobId}/frame`, undefined, p.token);
    const stop = async () => {
        await call("DELETE", `/api/test-generation/${jobId}`, undefined, p.token);
        await jobDone(jobId);
    };
    return { p, a, offer, jobId, frame, watch, stop };
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const picture = (over: Record<string, unknown> = {}) => ({ frame: { imageBase64: JPEG.toString("base64"), url: `${SITE}/products`, title: "Products", note: "Opened /products", phase: "exploring", pagesSeen: 2, at: new Date().toISOString(), ...over } });

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "30", AGENT_ACCEPT_SECONDS: "20" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = http.createServer(async (req, res) => {
        await new Promise((r) => setTimeout(r, SLOW_MS));
        const page = (title: string, body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`);
        if (req.url === "/products") return page("Products", `<h1>Products</h1><ul><li>Backpack</li><li>Tent</li></ul><a href="/">Home</a>`);
        if (req.url === "/" || req.url === "") return page("Sample shop", `<h1>Sample shop</h1><a href="/products">Products</a>`);
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    });
    await new Promise<void>((r) => site.listen(SITE_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-frames-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "explore-frames-secret-0123456789ab", DISPATCH_CONCURRENCY: "4", MAX_REPAIR_ATTEMPTS: "0", LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    dispatch = Worker.dispatch({ ...platform, makeLlm: () => llmClientFromModel(model as unknown as LanguageModel, "scripted-model") }, 100);
    dispatch.start();
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await dispatch?.stop();
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    removeServerExecutionGuard();
    await new Promise((r) => site.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const d of work) fs.rmSync(d, { recursive: true, force: true });
});

describe("the frame route (hand-driven runners)", () => {
    it("takes no picture while nobody watches; once the page watches, the runner is told and its picture reaches the page, said to be on the runner", async () => {
        const x = await exploring("Watched");
        try {
            expect((await x.frame({})).body).toEqual({ watched: false });
            // A picture sent while nobody watches is not kept.
            const before = frameHub.accepted;
            expect((await x.frame(picture())).body).toEqual({ watched: false });
            expect(frameHub.accepted).toBe(before);
            // The page opens Watch live: it waits for the first picture of the browser on the runner.
            expect((await x.watch()).body).toMatchObject({ available: false, why: "waiting", onRunner: true });
            expect((await x.frame({})).body).toEqual({ watched: true });
            expect((await x.frame(picture())).body).toEqual({ watched: true });
            const seen = (await x.watch()).body;
            expect(seen).toMatchObject({ available: true, onRunner: true, url: `${SITE}/products`, title: "Products", note: "Opened /products", phase: "exploring", pagesSeen: 2 });
            expect(seen.imageBase64).toBe(JPEG.toString("base64"));
        } finally {
            await x.stop();
        }
    }, 60_000);

    it("refuses another runner, a missing or old attempt, a picture over the limit and one that is not a JPEG", async () => {
        const x = await exploring("Fenced");
        const other = await rawAgent((await person("Other")).id, "Other laptop");
        try {
            expect((await x.watch()).status).toBe(200);
            expect((await x.frame({}, null)).status).toBe(409);
            expect((await x.frame({}, "not-this-attempt-0001")).status).toBe(409);
            expect((await x.frame({}, x.offer.attemptId, other.token)).status).toBe(404);
            const big = Buffer.alloc(121 * 1024, 1);
            big[0] = 0xff;
            big[1] = 0xd8;
            expect((await x.frame(picture({ imageBase64: big.toString("base64") }))).status).toBe(400);
            const over = Buffer.alloc(120 * 1024 + 1, 1);
            over[0] = 0xff;
            over[1] = 0xd8;
            expect((await x.frame(picture({ imageBase64: over.toString("base64") }))).status).toBe(413);
            expect((await x.frame(picture({ imageBase64: Buffer.from("not a jpeg at all").toString("base64") }))).status).toBe(400);
            expect((await x.frame({ frame: { ...picture().frame, extra: 1 } })).status).toBe(400);
            expect((await x.watch()).body).toMatchObject({ available: false, why: "waiting" });
        } finally {
            await x.stop();
        }
        // Once the job is over, nothing more is taken.
        expect((await x.frame({})).status).toBe(409);
    }, 60_000);

    it("an older runner that sends no pictures: the page says to download the runner again, instead of waiting for ever", async () => {
        const x = await exploring("Older", false);
        try {
            expect((await x.watch()).body).toMatchObject({ available: false, why: "elsewhere", reason: REASONS.oldRunner });
            expect((await x.frame({})).body).toEqual({ watched: false });
        } finally {
            await x.stop();
        }
    }, 60_000);
});

describe("the real runner sends pictures while the page watches", () => {
    it("an exploration on the runner shows its browser live, and takes none for a job nobody watches", async () => {
        const p = await person("Real watched");
        const { secret } = personalRunner(platform, { ownerId: p.id, label: "Real laptop" });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-frames-agent-"));
        work.push(dir);
        const { log } = memoryLogger();
        const agent = new Agent({ config: { baseUrl: BASE, token: secret, name: "Real laptop", concurrency: 1, workDir: dir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 }, liveBatch: { maxDelayMs: 200 }, outboxMaxDelayMs: 2000 });
        const done = agent.run();
        try {
            await until("the runner to connect", () => Boolean(svc().store.runnerOf(p.id)?.online && svc().store.runnerOf(p.id)?.agent?.capabilities.explorerFrames));
            // Nobody watches the first exploration: no picture of it ever reaches the platform.
            const putsBefore = frameHub.accepted;
            const quiet = await explore(p);
            expect(quiet.status, quiet.text).toBe(202);
            const q = await jobDone(quiet.body.jobId, 240_000);
            expect(q.status).toMatch(/COMPLETED/);
            expect(frameHub.accepted).toBe(putsBefore);

            // The second is watched, as the page does: a read about every second while the panel is open.
            const started = await explore(p);
            expect(started.status, started.text).toBe(202);
            const jobId = started.body.jobId as string;
            const pictures: any[] = [];
            await until(
                "a picture of the runner's browser",
                async () => {
                    const r = await call("GET", `/api/projects/${p.project}/jobs/${jobId}/frame`, undefined, p.token);
                    if (r.body?.available && r.body.imageBase64) pictures.push(r.body);
                    await new Promise((res) => setTimeout(res, 700));
                    return pictures.length > 0 || ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(platform.repo.getJob(jobId)!.status);
                },
                240_000,
            );
            expect(pictures.length, "no picture arrived while the exploration ran").toBeGreaterThan(0);
            const first = pictures[0];
            expect(first).toMatchObject({ onRunner: true, mime: "image/jpeg" });
            expect(first.url.startsWith(SITE)).toBe(true);
            const jpeg = Buffer.from(first.imageBase64, "base64");
            expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
            expect(jpeg.byteLength).toBeLessThanOrEqual(120 * 1024);
            expect(JSON.stringify(first)).not.toContain(PASSWORD);
            const job = await jobDone(jobId, 240_000);
            expect(job.status).toMatch(/COMPLETED/);
            // The job is over: the platform holds no picture of it.
            expect(frameHub.latest(jobId)).toBeUndefined();
        } finally {
            agent.stop();
            await done;
        }
    }, 480_000);
});
