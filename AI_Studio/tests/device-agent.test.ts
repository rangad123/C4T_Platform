/**
 * A phone session on a runner agent, against a REAL platform on real HTTP:
 *  - the REAL agent program (src/agent) opens the fake phone (tests/fixtures/fake-adb.mjs, no emulator) and answers the explorer's commands that
 *    `openDeviceSession` sends through the platform's routing, the heartbeat replies and the pushes;
 *  - a FAKE agent written in the test (plain HTTP) for the protocol edges: an agent without the capability is never offered a device task, an agent that
 *    sends rubbish, a push for a task that is not a device task, a revoked token.
 * Browser-free. Ports: platform 6651.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskOffer } from "../src/agent-protocol/schema.js";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { DeviceSessionError } from "../src/engine/mobile/device/errors.js";
import type { DeviceSession, ScreenSnapshot } from "../src/engine/mobile/device/types.js";
import { deviceOptions, openDeviceSession } from "../src/platform/agent-device.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { OPEN_OWNER_ID } from "../src/platform/agent-store.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";

const PORT = 6651;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "device-agent-admin-key-5d21";
const SHOP = "com.example.shop";
const PASS = "Fake-Pass-1234-Zq";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "BLOCK_PRIVATE_TARGETS", "AGENT_MAX_TOKENS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let work: string;
let n = 0;
const answers: string[] = [];
const sentByAgent: string[] = [];

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

/** A fresh fake phone and its environment (given to the agent only: nothing is set in this process). */
function phoneEnv(o: { devices?: string; faults?: string; avd?: boolean } = {}): NodeJS.ProcessEnv {
    n++;
    const avdHome = path.join(work, `avd-${n}`);
    fs.mkdirSync(avdHome, { recursive: true });
    if (o.avd) {
        fs.mkdirSync(path.join(avdHome, "Fake_AVD.avd", "snapshots", "aitp-clean"), { recursive: true });
        fs.writeFileSync(path.join(avdHome, "Fake_AVD.ini"), "path=x\n");
    }
    return {
        ...process.env,
        AITP_ADB_PATH: path.resolve("tests/fixtures/fake-adb.mjs"),
        AITP_EMULATOR_PATH: path.resolve("tests/fixtures/fake-emulator.mjs"),
        AITP_FAKE_STATE: path.join(work, `state-${n}.json`),
        AITP_FAKE_ADB_LOG: path.join(work, `adb-${n}.jsonl`),
        AITP_FAKE_APP: "shop",
        AITP_FAKE_DEVICES: o.devices ?? "emulator",
        AITP_FAKE_FAULTS: o.faults ?? "",
        AITP_FAKE_PASSWORD: PASS,
        ANDROID_AVD_HOME: avdHome,
        TAQWRIGHT_HOME: path.join(work, "no-taqwright"),
        ANDROID_HOME: "",
    };
}
const phoneState = (env: NodeJS.ProcessEnv) => JSON.parse(fs.readFileSync(env.AITP_FAKE_STATE!, "utf8")) as { devices: Array<{ serial: string }>; typed: Array<{ field: string | null; text: string }>; emulatorPid?: number; emulatorStarts?: number };
const adbLog = (env: NodeJS.ProcessEnv): string[][] => (fs.existsSync(env.AITP_FAKE_ADB_LOG!) ? fs.readFileSync(env.AITP_FAKE_ADB_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function newProject(name: string): Promise<string> {
    return (await admin("POST", "/api/projects", { name })).body.id as string;
}

/** The real agent program for a project, with its phone. */
async function realAgent(projectId: string, env: NodeJS.ProcessEnv, name = "Maya's laptop") {
    // Round 45: the open server's own runner (setting it up again retires the one before).
    const token = personalRunner(platform, { label: name, replace: true, realPhone: true }).secret;
    const { log, lines } = memoryLogger();
    const agent = new Agent({
        config: { baseUrl: BASE, token, name, concurrency: 1, workDir: fs.mkdtempSync(path.join(work, "agent-")), allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" },
        log,
        env,
        heartbeatMs: 300,
        backoff: { baseMs: 100, maxMs: 500 },
        fetchImpl: async (input, init) => {
            if (typeof init?.body === "string") sentByAgent.push(init.body);
            return fetch(input, init);
        },
    });
    const done = agent.run();
    const me = await until(async () => {
        const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ id: string; name: string; online: boolean; capabilities: { deviceSession?: boolean } }>;
        return list.find((a) => a.online && a.name === name);
    }, "the agent to connect");
    return { agent, done, lines, me, token };
}
async function pin(projectId: string, agentId: string) {
    expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent", agentId })).status).toBe(200);
}
const texts = (s: ScreenSnapshot) => s.elements.map((e) => e.text || e.desc);
const by = (s: ScreenSnapshot, f: (e: ScreenSnapshot["elements"][number]) => boolean) => {
    const e = s.elements.find(f);
    if (!e) throw new Error(`not on the screen: ${texts(s).join(" | ")}`);
    return e;
};
const host = (projectId: string, over: Record<string, unknown> = {}) => ({ agents: getAgentServices(platform), projectId, startedBy: OPEN_OWNER_ID, ...over });

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "30", AGENT_WATCH_MS: "100", AGENT_MAX_TOKENS: "25" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-devagent-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-devagent-work-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    Object.assign(deviceOptions, { remote: { lostContactMs: 20_000, claimWaitMs: 6_000, startWaitMs: 40_000, commandWaitMs: 20_000, settleMs: 8_000 } });
}, 60_000);

afterAll(async () => {
    delete deviceOptions.remote;
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
});

describe("the real agent program drives the fake phone for the platform", { timeout: 120_000 }, () => {
    it("reports that it can host a phone session, and opens, reads and acts through the platform", async () => {
        const projectId = await newProject("Phone on the real agent");
        const env = phoneEnv();
        const a = await realAgent(projectId, env);
        let session: DeviceSession | undefined;
        try {
            expect(a.me.capabilities.deviceSession).toBe(true);
            await pin(projectId, a.me.id);
            const log: string[] = [];
            session = await openDeviceSession({ appPackage: SHOP, credentials: { username: "tester", password: PASS }, log: (l) => log.push(l) }, host(projectId));
            expect(session.kind).toBe("agent");
            expect(session.deviceName).toContain("emulator-5554");

            const dialog = await session.snapshot({ screenshot: true });
            expect(dialog.outsideApp).toBe(true);
            expect(dialog.package).toBe("com.google.android.permissioncontroller");
            expect(dialog.screenshot).toBeDefined();
            expect(Buffer.from(dialog.screenshot!, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
            const taken = await session.act({ kind: "tap", index: by(dialog, (e) => e.text === "Allow").index });
            expect(taken.ok).toBe(true);
            const home = taken.snapshot!;
            expect(home.package).toBe(SHOP);
            expect(home.outsideApp).toBe(false);
            expect(texts(home)).toEqual(expect.arrayContaining(["Shop", "Sign in", "Products"]));
            // the platform computed the fingerprint itself: the same screen reads the same
            expect((await session.snapshot()).fingerprint).toBe(home.fingerprint);

            // sign in with the stand-ins: the agent's computer types the real value, nobody else ever sees it
            const si = (await session.act({ kind: "tap", index: by(home, (e) => e.text === "Sign in").index })).snapshot!;
            const u = await session.act({ kind: "type", index: by(si, (e) => e.id === "username_field").index, text: "{{credentials.username}}" });
            expect(u.ok).toBe(true);
            const pw = by(u.snapshot!, (e) => e.id === "password_field");
            expect(pw.password).toBe(true);
            const wrong = await session.act({ kind: "type", index: pw.index, text: "typed-by-the-model" });
            expect(wrong).toMatchObject({ ok: false, error: expect.stringContaining("only be filled with") });
            const p = await session.act({ kind: "type", index: pw.index, text: "{{credentials.password}}" });
            expect(p.ok).toBe(true);
            const done = await session.act({ kind: "tap", index: by(p.snapshot!, (e) => e.text === "Log in").index });
            expect(texts(done.snapshot!)).toContain("Hello, tester");
            expect(phoneState(env).typed.at(-1)).toEqual({ field: "password", text: PASS });

            // a stale number is refused by the phone side and comes back as an ordinary answer
            expect((await session.act({ kind: "tap", index: 99 })).ok).toBe(false);
            // an action the schema does not know never reaches the agent (nothing is queued for it)
            expect((await session.act({ kind: "launch", package: "com.evil.app" } as never)).ok).toBe(false);

            // the password is nowhere: not in what the platform answered, not in what the agent sent over the wire, not in the agent's log, not at rest
            for (const t of [...answers, ...sentByAgent, ...a.lines, ...log]) expect(t).not.toContain(PASS);
            const stored = platform.db.all<{ payload_enc: string }>("SELECT payload_enc FROM agent_tasks WHERE adapter_id LIKE 'device:%'");
            expect(stored.length).toBeGreaterThan(0);
            for (const row of stored) expect(row.payload_enc).not.toContain(PASS);
            // only this package was ever started or stopped
            for (const argv of adbLog(env)) if (argv.includes("monkey") || argv.includes("force-stop")) expect(argv.join(" ")).toContain(SHOP);
        } finally {
            await session?.close();
            a.agent.stop();
            await a.done;
        }
        // closing the session ended the agent's task and freed its slot
        const tasks = platform.db.all<{ status: string }>("SELECT status FROM agent_tasks WHERE adapter_id LIKE 'device:%'");
        expect(tasks.every((t) => ["cancelled", "done", "failed"].includes(t.status))).toBe(true);
        await expect(session!.snapshot()).rejects.toBeInstanceOf(DeviceSessionError);
    });

    it("an emulator the agent started for the session is stopped by its serial when the session ends; the agent stopping ends the session", async () => {
        const projectId = await newProject("Emulator on the agent");
        const env = phoneEnv({ devices: "none", avd: true });
        const a = await realAgent(projectId, env, "Emulator agent");
        let session: DeviceSession | undefined;
        try {
            await pin(projectId, a.me.id);
            session = await openDeviceSession({ appPackage: SHOP, avd: "Fake_AVD" }, host(projectId));
            const st = phoneState(env);
            expect(st.emulatorStarts).toBe(1);
            const pid = st.emulatorPid!;
            expect(() => process.kill(pid, 0)).not.toThrow();
            expect((await session.snapshot()).package).toBe("com.google.android.permissioncontroller");
            // the agent program is stopped by its owner in the middle of the session
            a.agent.stop();
            await a.done;
            await until(() => {
                try {
                    process.kill(pid, 0);
                    return false;
                } catch {
                    return true;
                }
            }, "the emulator to be gone");
            expect(phoneState(env).devices).toEqual([]);
            expect(adbLog(env).filter((x) => x.includes("kill"))).toEqual([["-s", "emulator-5554", "emu", "kill"]]);
            // the explorer is told in plain words and it is not a test result
            const e = await session.snapshot().then(() => undefined, (x: unknown) => x as Error);
            expect(e).toBeInstanceOf(DeviceSessionError);
            expect(e!.message).toMatch(/stopped|ended|Lost contact|did not answer/i);
        } finally {
            await session?.close().catch(() => undefined);
            a.agent.stop();
            await a.done;
        }
    });

    it("a phone that is not there gives the person the plain sentence, from the agent's own words", async () => {
        const projectId = await newProject("No phone on the agent");
        const env = phoneEnv({ devices: "none" });
        const a = await realAgent(projectId, env, "Empty agent");
        try {
            await pin(projectId, a.me.id);
            // the agent has adb but no phone and no emulator: the platform refuses before anything is queued
            expect(a.me.capabilities.deviceSession).toBeFalsy();
            await expect(openDeviceSession({ appPackage: SHOP }, host(projectId))).rejects.toThrow(/No phone is connected and no emulator exists/);
            // ask for an emulator that does not exist on a machine that has none: the agent says what went wrong
            const e = await openDeviceSession({ appPackage: SHOP, avd: "Missing_AVD" }, { ...host(projectId), on: "agent" }).then(() => undefined, (x: unknown) => x as Error);
            expect(e).toBeInstanceOf(DeviceSessionError);
        } finally {
            a.agent.stop();
            await a.done;
        }
    });

    it("an abort from the explorer ends the session on the agent", async () => {
        const projectId = await newProject("Abort");
        const env = phoneEnv();
        const a = await realAgent(projectId, env, "Abort agent");
        try {
            await pin(projectId, a.me.id);
            const ac = new AbortController();
            const session = await openDeviceSession({ appPackage: SHOP, signal: ac.signal }, host(projectId));
            expect((await session.snapshot()).package).toBeTruthy();
            ac.abort();
            await until(() => platform.db.all<{ status: string }>("SELECT status FROM agent_tasks WHERE project_id = ?", projectId).every((t) => t.status !== "running" && t.status !== "queued"), "the task to end");
            await expect(session.snapshot()).rejects.toBeInstanceOf(DeviceSessionError);
        } finally {
            a.agent.stop();
            await a.done;
        }
    });
});

describe("agents that cannot or should not host a phone", { timeout: 60_000 }, () => {
    /** The open server's runner (or, with `ownerId`, another person's computer, which never hosts the open server's sessions). */
    const connect = async (_projectId: string, name: string, caps: Record<string, unknown>, ownerId?: string) => {
        const secret = personalRunner(platform, { label: name, realPhone: true, ...(ownerId ? { ownerId } : { replace: true }) }).secret;
        const agent = new FakeAgent(viaFetch(BASE), secret, { name, capabilities: defaultCaps({ runnerSwitches: true, ...caps } as never) });
        expect((await agent.hello()).status).toBe(200);
        return { agent, secret };
    };
    const android = { adb: true, devices: [{ serial: "R58M", state: "device", emulator: false }], avds: [] };

    it("an agent that does not report the capability is never offered a device task, and the person is told why", async () => {
        const projectId = await newProject("Old agent");
        const old = await connect(projectId, "Old agent", { android });
        await pin(projectId, old.agent.agentId);
        await expect(openDeviceSession({ appPackage: SHOP }, host(projectId))).rejects.toThrow(/too old/);
        // even if a device task is queued for it by some other route, the platform does not hand it over
        const svc = getAgentServices(platform);
        const { startDeviceTask } = await import("../src/platform/agent-device.js");
        const driver = await startDeviceTask(svc, { projectId, agent: svc.store.getAgent(old.agent.agentId)!, appPackage: SHOP, timeouts: { claimWaitMs: 1500 }, startedBy: OPEN_OWNER_ID });
        expect(await old.agent.next(2500)).toBeUndefined();
        expect(driver.state.status).toMatch(/queued|failed/);
        await driver.close();
    });

    it("another agent of the project never sees a task made for this one; only the owner may push or be answered", async () => {
        const projectId = await newProject("Two agents");
        const a = await connect(projectId, "Agent A", { android, deviceSession: true });
        const b = await connect(projectId, "Agent B", { android, deviceSession: true }, "someone-else");
        const svc = getAgentServices(platform);
        const { startDeviceTask } = await import("../src/platform/agent-device.js");
        const driver = await startDeviceTask(svc, { projectId, agent: svc.store.getAgent(a.agent.agentId)!, appPackage: SHOP, credentials: { username: "u", password: PASS }, startedBy: OPEN_OWNER_ID });
        expect(await b.agent.next(1500)).toBeUndefined();
        const offer = (await a.agent.next(10_000)) as TaskOffer;
        expect(offer).toMatchObject({ kind: "device", adapterId: `device:${a.agent.agentId}`, device: { appPackage: SHOP, credentials: { password: PASS } } });
        // B can not push for, beat for or finish A's task
        expect((await b.agent.send("POST", `/api/agent/tasks/${offer.taskId}/device`, { headers: { authorization: `Bearer ${b.secret}`, "content-type": "application/json" }, body: JSON.stringify({ status: "ready" }) })).status).toBe(404);
        expect((await b.agent.heartbeat(offer.taskId, {})).status).toBe(404);
        // A pushes: bad shapes are refused, good ones are taken
        const push = (body: unknown) => a.agent.send("POST", `/api/agent/tasks/${offer.taskId}/device`, { headers: { authorization: `Bearer ${a.secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        expect((await push({ status: "nonsense" })).status).toBe(400);
        expect((await push({ status: "ready", results: Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, ok: true })) })).status).toBe(400);
        expect((await push({ status: "ready", deviceName: "Pixel 7" })).status).toBe(200);
        await driver.waitReady();
        // the explorer's command reaches the heartbeat reply, strictly shaped; an answer with rubbish in it is refused, a good one resolves it
        const pending = driver.snapshot(false);
        const cmd = await until(async () => (await a.agent.heartbeat(offer.taskId, {})).json?.deviceCommands?.[0], "a command");
        expect(cmd).toEqual({ id: "d1", type: "snapshot", screenshot: false });
        expect((await push({ status: "ready", results: [{ id: "d1", ok: true, snapshot: { package: SHOP, elements: [{ index: 0 }] } }] })).status).toBe(400);
        const snap = { package: SHOP, width: 360, height: 640, elements: [], fingerprint: "x", keyboard: false, outsideApp: false };
        expect((await push({ status: "ready", results: [{ id: "d1", ok: true, snapshot: snap }] })).status).toBe(200);
        expect((await pending).package).toBe(SHOP);
        // finishing: a normal result ends the session; later pushes are refused
        expect((await a.agent.result(offer.taskId, { ok: true, runs: [] })).status).toBe(200);
        expect(driver.state.status).toBe("ended");
        expect((await push({ status: "ready" })).status).toBe(409);
    });

    it("a revoked token ends everything: the agent is refused and the explorer is told in words", async () => {
        const projectId = await newProject("Revoked");
        const a = await connect(projectId, "Agent R", { android, deviceSession: true });
        const svc = getAgentServices(platform);
        const { startDeviceTask } = await import("../src/platform/agent-device.js");
        const driver = await startDeviceTask(svc, { projectId, agent: svc.store.getAgent(a.agent.agentId)!, appPackage: SHOP, startedBy: OPEN_OWNER_ID });
        const offer = (await a.agent.next(10_000)) as TaskOffer;
        // "Remove this computer" (Settings): the credential stops working at once.
        expect(svc.store.retireOtherPersonal(OPEN_OWNER_ID, null)).toBeGreaterThan(0);
        const r = await a.agent.send("POST", `/api/agent/tasks/${offer.taskId}/device`, { headers: { authorization: `Bearer ${a.secret}`, "content-type": "application/json" }, body: JSON.stringify({ status: "ready" }) });
        expect(r.status).toBe(404);
        // the platform side: nothing is heard from the agent any more, so the session ends in words (the claim and contact limits are short in tests)
        await expect(driver.waitReady()).rejects.toBeInstanceOf(DeviceSessionError);
    });
});
