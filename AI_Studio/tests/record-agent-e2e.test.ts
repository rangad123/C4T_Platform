/**
 * Recording on a REAL runner agent against the REAL platform: the agent program (its record task opens its own headless Chromium in a child process),
 * a project whose runner is the agent, a fixture application, and the test plays the person by driving the agent's recorded page through Playwright
 * (connected over the DevTools port the agent publishes for tests only). Then the recording is saved and the validation job runs on the agent and ends VALIDATED.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/record-agent-e2e.test.ts
 * Ports: platform 6032, fixture application 6033, the agent's recorded browser (DevTools, tests only) 6034.
 */
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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

const PLATFORM_PORT = 6032;
const APP_PORT = 6033;
const DEBUG_PORT = 6034;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "ao-e2e-admin-key-6c0d92";
const SENTINEL = "AOE2E-TypedPassword-3f9a71";
const PROJECT_PASSWORD = "project-pw-aoe2e-81";
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
let cdp: Browser | undefined;
/** Every body the agent sent to the platform (to prove what never left the page). */
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
const stepsAre = (rid: string, n: number) => until(async () => ((await getRec(rid)).steps.length >= n ? await getRec(rid) : undefined), `${n} steps`);
async function waitJob(jobId: string) {
    for (let i = 0; i < 400; i++) {
        const job = (await admin("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        await sleep(300);
    }
    throw new Error("the validation job did not finish");
}
/** The page the agent's browser shows (found over the DevTools port), once its address contains `part`. */
async function agentPage(part: string): Promise<Page> {
    cdp ??= await until(() => chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`).catch(() => undefined), "the agent's browser");
    const b = cdp;
    return until(() => b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes(part)), `the agent's page ${part}`);
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "30", AGENT_WATCH_MS: "100" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = await startRecorderApp(APP_PORT);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-recagent-e2e-"));
    agentWork = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-recagent-e2e-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
}, 60_000);

afterAll(async () => {
    await cdp?.close().catch(() => undefined);
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

describe("recording on the real agent program", () => {
    let projectId = "";
    let rid = "";
    let page: Page;
    let browserPid: number;
    let savedTestId = "";

    it("the agent connects and reports that it can record", async () => {
        projectId = (await admin("POST", "/api/projects", { name: "Record on the real agent" })).body.id;
        platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, { username: "tester", password: PROJECT_PASSWORD });
        const token = personalRunner(platform, { label: "e2e", replace: true }).secret;
        const { log, lines } = memoryLogger();
        agentLines = lines;
        agent = new Agent({
            config: { baseUrl: BASE, token, name: "Maya's laptop", concurrency: 1, workDir: agentWork, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" },
            log,
            env: { ...process.env, AITP_AGENT_RECORD_DEBUG_PORT: String(DEBUG_PORT) },
            heartbeatMs: 500,
            backoff: { baseMs: 100, maxMs: 500 },
            fetchImpl: async (input, init) => {
                if (typeof init?.body === "string") sentByAgent.push(init.body);
                return fetch(input, init);
            },
        });
        agentDone = agent.run();
        const me = await until(async () => {
            const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; online: boolean; capabilities: { record?: boolean } }>;
            return list.find((a) => a.online && a.capabilities.record !== undefined);
        }, "the agent");
        expect(me.capabilities.record).toBe(true);
        // The runner is the agent: a recording with nothing said about where goes there, and so does the validation run later.
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
    }, 90_000);

    it("starts on the agent, the agent opens its own browser, and the page the person sees follows it", async () => {
        const r = await admin("POST", `/api/projects/${projectId}/recordings`, { url: `${APP}/login`, headed: false });
        expect(r.status, r.text).toBe(201);
        rid = r.body.id;
        expect(r.body.runner).toMatchObject({ kind: "agent", name: "Maya's laptop" });
        await until(async () => (await getRec(rid)).status === "recording", "the recording to start");
        const rec = await getRec(rid);
        expect(rec).toMatchObject({ status: "recording", startUrl: `${APP}/login`, headed: false, runner: { kind: "agent" }, pendingCommands: 0 });
        expect(rec.steps).toHaveLength(1);
        expect(rec.steps[0]).toMatchObject({ kind: "goto", url: `${APP}/login` });
        page = await agentPage("/login");
        const m = agentLines.map((l) => /browser process (\d+)/.exec(l)?.[1]).find(Boolean);
        expect(m, agentLines.join("\n")).toBeTruthy();
        browserPid = Number(m);
        expect(pidAlive(browserPid)).toBe(true);
        expect((await admin("POST", `/api/projects/${projectId}/recordings`, { url: APP, headed: false })).status).toBe(409);
    }, 90_000);

    it("records a login on the agent's page; a typed password never leaves the page", async () => {
        await page.fill("#email", "tester@example.test");
        await page.fill("#pw", SENTINEL);
        await page.click("text=Sign in");
        await page.waitForURL("**/welcome");
        await stepsAre(rid, 4);
        await sleep(1500);
        const r = await getRec(rid);
        expect(r.steps.map((s: { kind: string }) => s.kind)).toEqual(["goto", "fill", "fill", "click"]);
        expect(r.steps[1]).toMatchObject({ value: "tester@example.test", locator: { strategy: "role", value: "textbox", name: "Email" } });
        expect(r.steps[2]).toMatchObject({ secret: true, value: "{{credentials.password}}", describe: 'Type the password into the field labelled "Password"' });
        expect(r.currentUrl).toContain("/welcome");
        // Not on the platform, not in anything the agent sent, not in the agent's own output.
        expect(JSON.stringify(r)).not.toContain(SENTINEL);
        expect(sentByAgent.length).toBeGreaterThan(2);
        expect(sentByAgent.join("\n")).not.toContain(SENTINEL);
        expect(sentByAgent.join("\n")).toContain("tester@example.test"); // ordinary fields are recorded as typed
        expect(agentLines.join("\n")).not.toContain(SENTINEL);
    }, 90_000);

    it("inspect and pick: the platform's switch reaches the page, a click only picks and does not act on it", async () => {
        await page.click("a"); // to the shop (recorded as a click)
        await page.waitForURL("**/shop");
        await stepsAre(rid, 5);
        const on = await admin("POST", `/api/recordings/${rid}/inspect`, { on: true, mode: "locator" });
        expect(on.status).toBe(200);
        expect(on.body.pendingCommands).toBeGreaterThanOrEqual(0);
        await until(async () => (await getRec(rid)).inspect.on === true, "inspect to be on");
        await sleep(600);
        await page.click("#add");
        const r = await until(async () => ((await getRec(rid)).picked ? await getRec(rid) : undefined), "a pick");
        expect(r.picked.locator).toMatchObject({ strategy: "role", value: "button", name: "Add to cart" });
        expect(r.steps).toHaveLength(5);
        expect(await page.textContent("#status")).toBe("Nothing in the cart");
        await admin("POST", `/api/recordings/${rid}/inspect`, { on: false });
        await until(async () => (await getRec(rid)).inspect.on === false, "inspect to be off");
        await sleep(600);
    }, 90_000);

    it("records a click and an assertion, and an edit from the page is applied on the agent and shown after it confirms", async () => {
        await page.click("#add");
        await stepsAre(rid, 6);
        await admin("POST", `/api/recordings/${rid}/inspect`, { on: true, mode: "assertion", check: "text" });
        await until(async () => (await getRec(rid)).inspect.on === true, "assertion mode");
        await sleep(600);
        await page.click("#status");
        const r = await stepsAre(rid, 7);
        expect(r.steps[6]).toMatchObject({ kind: "assert", assert: { check: "text", expected: "Cart: 1 item" } });
        await admin("POST", `/api/recordings/${rid}/inspect`, { on: false });
        await until(async () => (await getRec(rid)).inspect.on === false, "inspect off");
        await sleep(600);
        await page.click("#add"); // an extra click, then removed from the page
        await stepsAre(rid, 8);
        const del = await admin("DELETE", `/api/recordings/${rid}/steps/7`);
        expect(del.status).toBe(200);
        const after = await until(async () => {
            const x = await getRec(rid);
            return x.steps.length === 7 && x.pendingCommands === 0 ? x : undefined;
        }, "the delete to be applied");
        expect(after.steps.map((s: { kind: string }) => s.kind).slice(-2)).toEqual(["click", "assert"]);
        expect(after.steps.map((s: { index: number }) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }, 90_000);

    it("stop closes the agent's browser: the status is stopped, the process is gone, the agent is free again", async () => {
        const stop = await admin("POST", `/api/recordings/${rid}/stop`);
        expect(stop.status).toBe(200);
        const r = await until(async () => {
            const x = await getRec(rid);
            return x.status === "stopped" ? x : undefined;
        }, "the recording to stop");
        expect(r).toMatchObject({ steps: expect.any(Array), canSave: true, pendingCommands: 0 });
        expect(r.steps).toHaveLength(7);
        await until(() => !pidAlive(browserPid), "the agent's browser process to end", 15_000);
        await until(() => agent.status().running.length === 0, "the agent to be free", 15_000);
        expect(agentLines.some((l) => /Recording .* finished: 7 steps kept/.test(l)), agentLines.join("\n")).toBe(true);
        cdp = undefined;
    }, 90_000);

    it("saves a normal test; the validation job runs where the project's runner says (the agent) and ends VALIDATED", async () => {
        const saved = await admin("POST", `/api/recordings/${rid}/save`, { title: "Recorded on the agent: sign in and shop", category: "Recorded flows" });
        expect(saved.status, saved.text).toBe(201);
        savedTestId = saved.body.testId;
        expect(saved.body.jobId).toBeTruthy();
        expect((await getRec(rid))).toMatchObject({ status: "saved", savedTestId });
        const test = (await admin("GET", `/api/tests/${savedTestId}`)).body;
        expect(test.spec).toMatchObject({ kind: "web", source: { origin: "recorded" } });
        expect(JSON.stringify(test)).not.toContain(SENTINEL);
        expect(JSON.stringify(test.spec)).toContain("{{credentials.password}}");
        const job = await waitJob(saved.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        const after = (await admin("GET", `/api/tests/${savedTestId}`)).body;
        expect(after.validationStatus, JSON.stringify(after.validationReason)).toBe("VALIDATED");
        expect((await admin("GET", `/api/test-generation/${saved.body.jobId}`)).body.ranOn).toMatchObject({ kind: "agent", name: "Maya's laptop" });
    }, 180_000);

    it("the typed password is nowhere in the platform's database, its answers, or what the agent sent or said", async () => {
        for (const f of [platform.config.dbPath, `${platform.config.dbPath}-wal`].filter((x) => fs.existsSync(x))) expect(fs.readFileSync(f).includes(Buffer.from(SENTINEL))).toBe(false);
        expect(answers.join("\n")).not.toContain(SENTINEL);
        expect(sentByAgent.join("\n")).not.toContain(SENTINEL);
        expect(agentLines.join("\n")).not.toContain(SENTINEL);
        expect(agentLines.join("\n")).not.toContain(PROJECT_PASSWORD);
    });

    it("a discarded recording closes the agent's browser too, and an agent stopped mid-recording leaves nothing running", async () => {
        const r = await admin("POST", `/api/projects/${projectId}/recordings`, { url: `${APP}/shop`, headed: false });
        expect(r.status, r.text).toBe(201);
        const second = r.body.id as string;
        await until(async () => (await getRec(second)).status === "recording", "the second recording");
        const before = agentLines.length;
        const pid2 = await until(() => {
            const m = agentLines.slice(before - 1).map((l) => /browser process (\d+)/.exec(l)?.[1]).filter(Boolean).pop();
            return m ? Number(m) : undefined;
        }, "the second browser's process id");
        expect(pidAlive(pid2)).toBe(true);
        expect((await admin("DELETE", `/api/recordings/${second}`)).status).toBe(200);
        await until(() => !pidAlive(pid2), "the discarded recording's browser to end", 15_000);
        await until(() => agent.status().running.length === 0, "the agent to be free", 15_000);

        // The agent itself is stopped while a recording runs: its browser is closed before it leaves.
        const third = await admin("POST", `/api/projects/${projectId}/recordings`, { url: `${APP}/shop`, headed: false });
        expect(third.status, third.text).toBe(201);
        await until(async () => (await getRec(third.body.id)).status === "recording", "the third recording");
        const mark = agentLines.length;
        const pid3 = await until(() => {
            const m = agentLines.slice(mark - 1).map((l) => /browser process (\d+)/.exec(l)?.[1]).filter(Boolean).pop();
            return m ? Number(m) : undefined;
        }, "the third browser's process id");
        agent.stop();
        expect(await agentDone).toBe(0);
        expect(pidAlive(pid3)).toBe(false);
        expect(agent.status().running).toEqual([]);
        const last = await until(async () => {
            const x = await getRec(third.body.id);
            return x.status === "stopped" || x.status === "failed" ? x : undefined;
        }, "the platform to notice");
        expect(["stopped", "failed"]).toContain(last.status);
    }, 120_000);
});
