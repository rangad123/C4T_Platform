/**
 * Driving a recording step by step on a REAL runner agent against the REAL platform: the agent program opens its own headless Chromium in a child process,
 * the platform's act and snapshot routes send commands in heartbeat replies, the agent answers in pushes. The saved test is then validated on the agent.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/live-session-agent.test.ts
 * Ports: platform 6173, fixture application 6174.
 */
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { pidAlive } from "../src/engine/recorder/session.js";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startRecorderApp } from "./fixtures/recorder-app.js";

const PLATFORM_PORT = 6173;
const APP_PORT = 6174;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "live-agent-e2e-key-5d02a7";
const PASSWORD = "LIVEE2E-Password-3c7b19";
const TYPED = "LIVEE2E-Typed-By-A-Tool-48ad";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let agentWork: string;
let appServer: http.Server;
let agent: Agent;
let agentDone: Promise<number>;
let agentLines: string[];
const sentByAgent: string[] = [];
const answers: string[] = [];

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    answers.push(text);
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 30_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}
const getRec = async (rid: string) => (await admin("GET", `/api/recordings/${rid}`)).body;
const act = (rid: string, body: Record<string, unknown>) => admin("POST", `/api/recordings/${rid}/act`, body);
async function waitJob(jobId: string) {
    for (let i = 0; i < 400; i++) {
        const job = (await admin("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        await sleep(300);
    }
    throw new Error("the validation job did not finish");
}

const EMAIL = { strategy: "label", value: "Email", exact: true };
const PW = { strategy: "label", value: "Password", exact: true };
const SIGN_IN = { strategy: "role", value: "button", name: "Sign in", exact: true };

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "30", AGENT_WATCH_MS: "100" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = await startRecorderApp(APP_PORT);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-liveagent-e2e-"));
    agentWork = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-liveagent-e2e-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
}, 60_000);

afterAll(async () => {
    agent?.stop();
    await agentDone;
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await worker?.stop();
    // The stopped agent can leave connections waiting for an answer; close() waits for those, so end them first.
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentWork, { recursive: true, force: true });
});

describe("a session on the real agent, driven step by step", () => {
    let projectId = "";
    let rid = "";
    let browserPid = 0;

    it("the agent connects and reports that it can be driven", async () => {
        projectId = (await admin("POST", "/api/projects", { name: "Live on the real agent" })).body.id;
        platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, { username: "tester@example.test", password: PASSWORD });
        const token = personalRunner(platform, { label: "e2e", replace: true }).secret;
        const { log, lines } = memoryLogger();
        agentLines = lines;
        agent = new Agent({
            config: { baseUrl: BASE, token, name: "Maya's laptop", concurrency: 1, workDir: agentWork, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" },
            log,
            env: { ...process.env },
            heartbeatMs: 500,
            backoff: { baseMs: 100, maxMs: 500 },
            fetchImpl: async (input, init) => {
                if (typeof init?.body === "string") sentByAgent.push(init.body);
                return fetch(input, init);
            },
        });
        agentDone = agent.run();
        const me = await until(async () => {
            const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ online: boolean; capabilities: { record?: boolean; liveSession?: boolean } }>;
            return list.find((a) => a.online && a.capabilities.record !== undefined);
        }, "the agent");
        expect(me.capabilities).toMatchObject({ record: true, liveSession: true });
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
    }, 90_000);

    it("opens a session on the agent and reads the page: elements with ranked locators, the password field hidden, a real picture", async () => {
        const r = await admin("POST", `/api/projects/${projectId}/recordings`, { url: `${APP}/login`, headed: false });
        expect(r.status, r.text).toBe(201);
        rid = r.body.id;
        await until(async () => (await getRec(rid)).status === "recording", "the recording to start");
        const m = await until(() => agentLines.map((l) => /browser process (\d+)/.exec(l)?.[1]).find(Boolean), "the browser process");
        browserPid = Number(m);
        expect(pidAlive(browserPid)).toBe(true);
        const s = await admin("GET", `/api/recordings/${rid}/snapshot?image=1`);
        expect(s.status, s.text).toBe(200);
        expect(s.body).toMatchObject({ url: `${APP}/login`, title: "Log in", imageType: "image/png" });
        const els = s.body.elements as Array<Record<string, any>>;
        expect(els.find((e) => e.name === "Email")).toMatchObject({ role: "textbox", matches: 1, locator: { strategy: "role", value: "textbox", name: "Email", exact: true } });
        expect(els.find((e) => e.name === "Password")).toMatchObject({ secret: true, value: "[hidden]" });
        expect(Buffer.from(s.body.image, "base64").subarray(1, 4).toString()).toBe("PNG");
    }, 90_000);

    it("a real password is refused on the agent; the stand-ins are typed there from the stored details and never come back", async () => {
        const before = (await getRec(rid)).steps.length;
        const real = await act(rid, { action: "fill", locator: PW, value: TYPED });
        expect(real.status, real.text).toBe(422);
        expect(real.body.error).toMatch(/can only be filled with \{\{credentials\.password\}\}/);
        expect((await getRec(rid)).steps).toHaveLength(before);

        const email = await act(rid, { action: "fill", locator: EMAIL, value: "{{credentials.username}}" });
        expect(email.status, email.text).toBe(200);
        expect(email.body).toMatchObject({ recorded: true, step: { kind: "fill", value: "{{credentials.username}}" } });
        const pw = await act(rid, { action: "fill", locator: PW, value: "{{credentials.password}}" });
        expect(pw.body).toMatchObject({ recorded: true, step: { kind: "fill", secret: true, value: "{{credentials.password}}" } });
        const click = await act(rid, { action: "click", locator: SIGN_IN, image: true });
        expect(click.status, click.text).toBe(200);
        expect(click.body).toMatchObject({ recorded: true, step: { kind: "click" }, snapshot: { url: `${APP}/welcome`, title: "Welcome" } });
        expect(click.body.snapshot.image).toBeTruthy();
        const nav = await act(rid, { action: "navigate", url: "/shop" });
        expect(nav.body).toMatchObject({ recorded: true, step: { kind: "goto", url: `${APP}/shop` } });
        const add = await act(rid, { action: "click", locator: { strategy: "role", value: "button", name: "Add to cart", exact: true } });
        expect(add.body.snapshot.text).toContain("Cart: 1 item");
        const rec = await getRec(rid);
        expect(rec.steps.map((s: { kind: string }) => s.kind)).toEqual(["goto", "fill", "fill", "click", "goto", "click"]);
    }, 120_000);

    it("the agent refuses an address with credentials, and a second action while one runs is a 409", async () => {
        const creds = await act(rid, { action: "navigate", url: "http://user:pw@127.0.0.1:6174/shop" });
        expect(creds.status).toBe(400);
        const slow = act(rid, { action: "waitForText", value: "This text never appears", timeoutMs: 3000 });
        await sleep(400);
        expect((await act(rid, { action: "scroll" })).status).toBe(409);
        expect((await slow).status).toBe(422);
    }, 60_000);

    it("stop closes the agent's browser; the exploration is saved as a test that validates on the agent", async () => {
        expect((await admin("POST", `/api/recordings/${rid}/stop`)).status).toBe(200);
        await until(async () => (await getRec(rid)).status === "stopped", "the recording to stop");
        await until(() => !pidAlive(browserPid), "the browser to end", 15_000);
        expect((await act(rid, { action: "scroll" })).status).toBe(409);
        const saved = await admin("POST", `/api/recordings/${rid}/save`, { title: "Explored on the agent", category: "Explored" });
        expect(saved.status, saved.text).toBe(201);
        const test = (await admin("GET", `/api/tests/${saved.body.testId}`)).body;
        expect(JSON.stringify(test)).not.toContain(PASSWORD);
        expect(JSON.stringify(test.spec)).toContain("{{credentials.username}}");
        const job = await waitJob(saved.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        const after = (await admin("GET", `/api/tests/${saved.body.testId}`)).body;
        expect(after.validationStatus, JSON.stringify(after.validationReason)).toBe("VALIDATED");
    }, 240_000);

    it("the stored password and the refused value are nowhere the platform answered, the agent sent or said, or the database holds", async () => {
        for (const secret of [PASSWORD, TYPED]) {
            expect(answers.join("\n"), secret).not.toContain(secret);
            expect(sentByAgent.join("\n"), secret).not.toContain(secret);
            expect(agentLines.join("\n"), secret).not.toContain(secret);
            for (const f of [platform.config.dbPath, `${platform.config.dbPath}-wal`].filter((x) => fs.existsSync(x))) expect(fs.readFileSync(f).includes(Buffer.from(secret)), f).toBe(false);
        }
        const audit = (await admin("GET", `/api/projects/${projectId}/live-sessions`)).body.sessions as Array<Record<string, any>>;
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ runner: "agent:Maya's laptop" });
    });
});
