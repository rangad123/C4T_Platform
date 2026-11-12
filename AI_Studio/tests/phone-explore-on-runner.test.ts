/**
 * Round 52: exploring a phone app runs on the person's runner in runners mode (docs/features/explore-on-runner.md), on the phone or emulator
 * attached to that runner, as the round-51 explore task (mode "mobile"), with the AI and the saving on the platform.
 *
 * A real platform on real HTTP in runners mode with its dispatch worker and a scripted phone model (never a real one). Hand-driven agents prove
 * the start refusals (a runner program too old for it, a runner with no phone) and the readiness flag; then the REAL agent from source explores
 * the mock shop app on the fake phone (tests/fixtures/fake-adb.mjs: no emulator, no adb server), the plan is kept on the platform, and the
 * server's guard refused nothing.
 *
 * Run: node scripts/with-lock.mjs browser -- npx vitest run tests/phone-explore-on-runner.test.ts
 * Port: platform 9173. No real model, no network beyond 127.0.0.1.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { modeNeedsUpdate } from "../src/platform/explore-task.js";
import { removeServerExecutionGuard, serverRunRefusals } from "../src/platform/runner-only.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { scriptedPhoneModel } from "./fixtures/phone-model.js";
import { personalRunner, testPerson } from "./helpers/personal-runner.js";

const PORT = 9173;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "phone-runner-admin-key-3a77";
const SHOP = "com.example.shop";
const PASS = "Fake-Pass-1234-Rn";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_ACCEPT_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const caps = (modes: string[], phone = true) => ({
    os: "linux",
    arch: "x64",
    node: "v24.0.0",
    browsers: ["chromium"],
    runnerSwitches: true,
    explore: true,
    exploreModes: modes,
    ...(phone ? { deviceSession: true, android: { adb: true, devices: [{ serial: "emulator-5554", state: "device", emulator: true }], avds: ["Pixel_Test"] } } : {}),
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dispatch: Worker;
let dataDir: string;
let work: string;
const model = scriptedPhoneModel([{ tap: "Sign in" }, { type: "Username", text: "tester" }, { type: "Password", text: "hunter2" }, { tap: "Log in" }, { tap: "Products" }, { finish: true }]);

const call = async (method: string, url: string, body?: unknown, key = API_KEY) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
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
const jobDone = async (jobId: string, ms = 180_000) => {
    let j: any;
    await until("the job to finish", () => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes((j = platform.repo.getJob(jobId)!).status), ms);
    return j;
};
async function person(name: string) {
    const who = testPerson(platform);
    const project = (await call("POST", "/api/projects", { name }, who.token)).body.id as string;
    expect((await call("PUT", `/api/projects/${project}/mobile-app`, { appPackage: SHOP }, who.token)).status).toBe(200);
    return { ...who, project };
}
const explore = (p: { project: string; token: string }) => call("POST", `/api/projects/${p.project}/test-generation`, { targets: ["mobile"], plan: true, credentials: { username: "tester", password: PASS } }, p.token);
async function hello(token: string, name: string, modes: string[], phone = true) {
    const r = await fetch(`${BASE}/api/agent/hello`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ protocol: 1, protocols: [1, 2], name, version: "52.0.0", concurrency: 1, capabilities: caps(modes, phone) }) });
    expect(r.status).toBe(200);
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "30", AGENT_ACCEPT_SECONDS: "20" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    work = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phone-runner-"));
    dataDir = path.join(work, "data");
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "phone-on-runner-secret-0123456789ab", DISPATCH_CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", LLM_PROVIDER: "anthropic" }));
    platform.llm = model;
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    dispatch = Worker.dispatch({ ...platform, makeLlm: () => model }, 100);
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
    fs.rmSync(work, { recursive: true, force: true });
});

describe("a phone app's exploration on the person's runner", () => {
    it("is refused at the start by a runner program too old for it, and by a runner with no phone; the page is told before the click", async () => {
        const old = await person("Old phone runner");
        await hello(personalRunner(platform, { ownerId: old.id, label: "Old laptop" }).secret, "Old laptop", ["plain", "agent"]);
        expect(await explore(old)).toMatchObject({ status: 409, body: { error: modeNeedsUpdate("Old laptop", "mobile"), details: { code: "RUNNER_CANNOT_RUN", link: "#/settings#runner" } } });
        expect((await call("GET", "/api/me/runner", undefined, old.token)).body.runner.can.phoneExplore).toEqual({ ok: false, why: modeNeedsUpdate("Old laptop", "mobile") });

        const bare = await person("No phone");
        await hello(personalRunner(platform, { ownerId: bare.id, label: "Bare laptop" }).secret, "Bare laptop", ["plain", "agent", "mobile", "assessment"], false);
        const refused = await explore(bare);
        expect(refused).toMatchObject({ status: 409, body: { details: { code: "RUNNER_CANNOT_RUN" } } });
        expect(refused.body.error).toMatch(/phone/i);
        expect((await call("GET", "/api/me/runner", undefined, bare.token)).body.runner.can.phoneExplore).toEqual({ ok: false, why: refused.body.error });
        for (const p of [old, bare]) expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generation_jobs WHERE project_id = ?", p.project)!.n).toBe(0);
    });

    it.skipIf(process.platform === "win32")("the real runner explores the app on its own (fake) phone; what it saw is saved on the platform; the server opened nothing", async () => {
        const p = await person("Phone shop");
        // "Use my connected phone" on: the fake device may be used (without it the runner needs an emulator, as for a phone session).
        const { secret } = personalRunner(platform, { ownerId: p.id, label: "Phone laptop", realPhone: true });
        const avdHome = path.join(work, "avd");
        fs.mkdirSync(avdHome, { recursive: true });
        const adbLog = path.join(work, "adb.jsonl");
        // The runner's task process gets only the phone variables a runner passes on (ANDROID_HOME...), so the fake phone is reached the way a
        // real one is: an Android SDK folder whose platform-tools/adb is (a small script starting) the fake adb, with its own settings inside.
        const sdk = path.join(work, "sdk");
        fs.mkdirSync(path.join(sdk, "platform-tools"), { recursive: true });
        const fake = {
            AITP_FAKE_STATE: path.join(work, "phone-state.json"),
            AITP_FAKE_ADB_LOG: adbLog,
            AITP_FAKE_APP: "shop",
            AITP_FAKE_DEVICES: "emulator",
            AITP_FAKE_PASSWORD: PASS,
        };
        const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
        const wrapper = path.join(sdk, "platform-tools", "adb");
        fs.writeFileSync(wrapper, `#!/bin/sh\n${Object.entries(fake).map(([k, v]) => `export ${k}=${q(v)}`).join("\n")}\nexec ${q(process.execPath)} ${q(path.resolve("tests/fixtures/fake-adb.mjs"))} "$@"\n`, { mode: 0o755 });
        const env: NodeJS.ProcessEnv = { ...process.env, ANDROID_HOME: sdk, ANDROID_AVD_HOME: avdHome, TAQWRIGHT_HOME: path.join(work, "no-taqwright"), PHONE_EXPLORER: "ai" };
        delete env.AITP_ADB_PATH;
        const dir = fs.mkdtempSync(path.join(work, "agent-"));
        const { log, lines } = memoryLogger();
        const agent = new Agent({ config: { baseUrl: BASE, token: secret, name: "Phone laptop", concurrency: 1, workDir: dir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, env, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 }, liveBatch: { maxDelayMs: 200 }, outboxMaxDelayMs: 2000 });
        const done = agent.run();
        const refusedBefore = serverRunRefusals();
        try {
            await until("the runner to connect", () => Boolean(svc().store.runnerOf(p.id)?.online && svc().store.runnerOf(p.id)?.agent?.capabilities.exploreModes?.includes("mobile")));
            expect((await call("GET", "/api/me/runner", undefined, p.token)).body.runner.can.phoneExplore).toEqual({ ok: true });
            const started = await explore(p);
            expect(started.status, started.text).toBe(202);
            const job = await jobDone(started.body.jobId);
            const events = platform.repo.listEvents(started.body.jobId);
            expect(job.status, JSON.stringify(events.filter((e) => e.level !== "info").map((e) => e.message))).toBe("COMPLETED");
            expect(events.find((e) => e.kind === "explore_on_runner")?.message).toBe("Exploring the phone app on your runner “Phone laptop”.");
            // The offer said "mobile" (an older runner is never offered it).
            const task = svc().store.tasksOfJob(started.body.jobId).find((t) => t.adapterId === "explore")!;
            expect(svc().exploreModeOf(task.jobId, task.payloadEnc)).toBe("mobile");
            // The phone that was driven is the runner's: its (fake) adb ran there; the AI answered on the platform.
            expect(fs.existsSync(adbLog) && fs.readFileSync(adbLog, "utf8").length > 0).toBe(true);
            // What it found was saved on the platform: the screens it saw, and the plan (it stops at a plan; nothing is created).
            const view = (await call("GET", `/api/test-generation/${started.body.jobId}`, undefined, p.token)).body;
            expect(view.ranOn).toMatchObject({ kind: "agent", name: "Phone laptop" });
            expect(view.counters?.pagesDiscovered ?? 0, JSON.stringify(view.counters)).toBeGreaterThan(0);
            expect((await call("GET", `/api/projects/${p.project}/tests`, undefined, p.token)).body).toEqual([]);
            // The test password never reached the runner's log.
            for (const l of lines) expect(l).not.toContain(PASS);
            expect(serverRunRefusals()).toBe(refusedBefore);
        } finally {
            agent.stop();
            await done;
        }
    }, 300_000);
});
