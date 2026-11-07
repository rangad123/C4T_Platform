/**
 * Recordings, live sessions and phone sessions on a person's own computer (personal runner): only its owner may pick it, see the session or
 * drive it; another person's session is never offered to it; a real phone is used only when the owner allowed it, and what the session
 * installed on it is removed after; a session ends within one heartbeat when its starter loses access. Team runners keep the project's rules.
 *
 * A real platform through inject (no ports), FAKE AGENTS written in plain requests (tests/fixtures/fake-agent.ts), and the device session
 * opener against the fake adb (tests/fixtures/fake-adb.mjs). No browser, no phone, no network.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskOffer } from "../src/agent-protocol/schema.js";
import { DeviceTask } from "../src/agent/device-task.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { NO_REAL_PHONE, openLocalDeviceSession } from "../src/engine/mobile/device/session.js";
import type { OpenDeviceOptions } from "../src/engine/mobile/device/types.js";
import { chooseDeviceHost, startDeviceTask } from "../src/platform/agent-device.js";
import { chooseRecorder, sessionHosts } from "../src/platform/agent-record.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { HttpError } from "../src/platform/http-error.js";
import { buildServer } from "../src/platform/server.js";
import { UserStore } from "../src/platform/user-store.js";
import { defaultCaps, FakeAgent, viaInject } from "./fixtures/fake-agent.js";

const API_KEY = "s1-sessions-admin-key-0123456789";
const APP = "http://shop.example.test/";
const PKG = "com.example.shop";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let users: UserStore;
let annId = "";
let benId = "";
const tokenOf: Record<string, string> = {};
let projectId = "";
let annLaptop: FakeAgent;
let annTokenId = "";
let team: FakeAgent;

const svc = () => getAgentServices(platform);
const call = async (who: string, method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers: { "x-api-key": who === "key" ? API_KEY : tokenOf[who]!, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};
const startRec = (who: string, body: Record<string, unknown>) => call(who, "POST", `/api/projects/${projectId}/recordings`, { url: APP, on: "agent", headed: false, ...body });
const phoneCaps = (over: Record<string, unknown> = {}) =>
    defaultCaps({ record: true, liveSession: true, deviceSession: true, runnerSwitches: true, android: { adb: true, devices: [{ serial: "R58M12ABCDE", state: "device", emulator: false, model: "Pixel 7" }], avds: [] }, ...over } as never);

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "30", AGENT_WATCH_MS: "50" });
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-s1-sessions-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, API_KEY, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "s1-sessions-secret-0123456789abcdef" }));
    app = await buildServer(platform);
    await app.ready();
    users = new UserStore(platform.db);
    annId = users.create({ email: "ann@people.example", name: "Ann", role: "editor" }).id;
    benId = users.create({ email: "ben@people.example", name: "Ben", role: "editor" }).id;
    tokenOf.ann = users.createToken(annId, { name: "t", role: "editor" }).token;
    tokenOf.ben = users.createToken(benId, { name: "t", role: "editor" }).token;
    projectId = (await call("key", "POST", "/api/projects", { name: "Sessions" })).body.id;
    const made = svc().store.createPersonalToken({ ownerId: annId, label: "Ann's laptop", createdBy: "test" });
    annTokenId = made.record.id;
    // Two slots, so "not offered" below is never just "busy".
    annLaptop = new FakeAgent(viaInject(app), made.secret, { name: "Ann's laptop", capabilities: phoneCaps(), concurrency: 2 });
    expect((await annLaptop.hello()).status).toBe(200);
    const teamSecret = (await call("key", "POST", `/api/projects/${projectId}/agent-tokens`, { label: "Lab" })).body.secret as string;
    team = new FakeAgent(viaInject(app), teamSecret, { name: "Lab machine", capabilities: phoneCaps() });
    expect((await team.hello()).status).toBe(200);
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("recordings and live sessions on a person's own computer", () => {
    let rid = "";
    let offer: TaskOffer | undefined;

    it("another person never sees it in the chooser and cannot pick it by name", async () => {
        const forBen = sessionHosts(svc().store, projectId, benId);
        expect(forBen.map((a) => a.id)).not.toContain(annLaptop.agentId);
        expect(sessionHosts(svc().store, projectId, annId).map((a) => a.id)).toContain(annLaptop.agentId);
        // Even handed in by mistake, the pure chooser drops it.
        const leaked = sessionHosts(svc().store, projectId, annId);
        expect(() => chooseRecorder({ on: "agent", agentId: annLaptop.agentId, headed: false, runner: svc().store.getRunner(projectId), agents: leaked, caller: benId })).toThrow(HttpError);
        expect(await startRec("ben", { agentId: annLaptop.agentId })).toMatchObject({ status: 404 });
        expect(await startRec("key", { agentId: annLaptop.agentId })).toMatchObject({ status: 404 });
        expect(svc().store.queued(projectId)).toHaveLength(0);
    });

    it("its owner records on it; the task goes to that computer only", async () => {
        const r = await startRec("ann", { agentId: annLaptop.agentId });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        rid = r.body.id;
        expect(await team.poll(1)).toMatchObject({ status: 204 });
        offer = await annLaptop.next(10_000);
        expect(offer?.kind).toBe("record");
        expect((await annLaptop.recording(offer!.taskId, { status: "recording", currentUrl: APP, steps: [] })).status).toBe(200);
    });

    it("only its owner may read or drive the session; everyone else is told it does not exist", async () => {
        expect((await call("ann", "GET", `/api/recordings/${rid}`)).status).toBe(200);
        for (const who of ["ben", "key"]) {
            expect((await call(who, "GET", `/api/recordings/${rid}`)).status, who).toBe(404);
            expect((await call(who, "GET", `/api/recordings/${rid}/snapshot`)).status, who).toBe(404);
            expect((await call(who, "POST", `/api/recordings/${rid}/act`, { action: "click", ref: 1 })).status, who).toBe(404);
            expect((await call(who, "POST", `/api/recordings/${rid}/inspect`, { on: true })).status, who).toBe(404);
            expect((await call(who, "POST", `/api/recordings/${rid}/stop`, {})).status, who).toBe(404);
            expect((await call(who, "DELETE", `/api/recordings/${rid}`)).status, who).toBe(404);
        }
        // Still recording: nothing anyone else sent reached it.
        expect((await call("ann", "GET", `/api/recordings/${rid}`)).body.status).toBe("recording");
    });

    it("a session someone else started is never handed to the person's computer", async () => {
        const a = svc().store.agentsOfToken(annTokenId)[0]!;
        const foreign = svc().startRecording({ projectId, agent: a, startUrl: APP, headed: false, caps: { idleMs: 60_000, totalMs: 60_000, maxSteps: 50 }, startedBy: benId });
        expect(await annLaptop.poll(1)).toMatchObject({ status: 204 });
        expect(svc().store.getTask(foreign.taskId)?.status).toBe("queued");
        await foreign.dispose();
    });

    it("ends within one heartbeat when its starter loses access", async () => {
        expect((await annLaptop.heartbeat(offer!.taskId, {})).json).toMatchObject({ cancel: false });
        users.update(annId, { status: "disabled" });
        try {
            expect((await annLaptop.heartbeat(offer!.taskId, {})).json).toMatchObject({ cancel: true });
            const d = svc().records.byRecording(rid)!;
            expect(d.snapshot()).toMatchObject({ status: "stopped", error: expect.stringMatching(/can no longer use this project/) });
        } finally {
            users.update(annId, { status: "active" });
        }
        // The agent gives the task up, as a real one does on cancel.
        expect((await annLaptop.result(offer!.taskId, { ok: false, error: "The platform ended this session.", runs: [] })).status).toBe(200);
    });

    it("a team runner keeps the project's rules: another project member may read it", async () => {
        const r = await startRec("ann", { agentId: team.agentId });
        expect(r.status).toBe(201);
        expect((await call("ben", "GET", `/api/recordings/${r.body.id}`)).status).toBe(200);
        await call("ann", "DELETE", `/api/recordings/${r.body.id}`);
    });
});

describe("phone sessions on a person's own computer", () => {
    it("another person cannot choose it; its owner can, emulators only until they allow their phone", () => {
        const runner = svc().store.getRunner(projectId);
        const ask = (caller: string) => chooseDeviceHost({ on: "agent", agentId: annLaptop.agentId, runner, agents: sessionHosts(svc().store, projectId, caller), caller });
        expect(() => ask(benId)).toThrow(/does not belong/);
        // No emulator on it and "Use my connected phone" off: refused with what to do.
        expect(() => ask(annId)).toThrow(/no emulator, and “Use my connected phone” is off/);
        svc().store.setTokenSwitches(annTokenId, { allowRealPhone: true });
        expect(ask(annId)).toMatchObject({ kind: "agent", agent: { id: annLaptop.agentId } });
        svc().store.setTokenSwitches(annTokenId, { allowRealPhone: false });
    });

    it("the offer says: no real phone, remove what was installed; a colleague's session is never offered", async () => {
        const a = svc().store.agentsOfToken(annTokenId)[0]!;
        const bens = await startDeviceTask(svc(), { projectId, agent: a, appPackage: PKG, startedBy: benId });
        expect(await annLaptop.poll(1)).toMatchObject({ status: 204 });
        await bens.close().catch(() => undefined);

        const anns = await startDeviceTask(svc(), { projectId, agent: a, appPackage: PKG, startedBy: annId });
        const offer = await annLaptop.next(10_000);
        expect(offer?.kind).toBe("device");
        expect(offer!.device).toMatchObject({ realPhone: false, removeInstalledApp: true });
        expect(svc().store.getTask(bens.taskId)?.status).not.toBe("running");
        // The project stops allowing people's own computers: the session ends within one heartbeat.
        expect((await annLaptop.heartbeat(offer!.taskId, {})).json).toMatchObject({ cancel: false });
        svc().store.setAllowPersonal(projectId, false);
        try {
            expect((await annLaptop.heartbeat(offer!.taskId, {})).json).toMatchObject({ cancel: true });
            expect(anns.state).toMatchObject({ status: "failed", error: expect.stringMatching(/no longer allows people's own computers/) });
        } finally {
            svc().store.setAllowPersonal(projectId, true);
        }
        await annLaptop.result(offer!.taskId, { ok: false, error: "The platform ended this session.", runs: [] });
    });

    it("with the switch on, the offer allows the connected phone", async () => {
        svc().store.setTokenSwitches(annTokenId, { allowRealPhone: true });
        const a = svc().store.agentsOfToken(annTokenId)[0]!;
        const d = await startDeviceTask(svc(), { projectId, agent: a, appPackage: PKG, startedBy: annId });
        const offer = await annLaptop.next(10_000);
        expect(offer!.device).not.toHaveProperty("realPhone");
        expect(offer!.device).toMatchObject({ removeInstalledApp: true });
        await d.close().catch(() => undefined);
        svc().store.setTokenSwitches(annTokenId, { allowRealPhone: false });
    });

    it("the agent passes the owner's rules to the phone session", async () => {
        let seen: OpenDeviceOptions | undefined;
        const offer = { taskId: "t-1", jobId: "j-1", adapterId: "device:x", leaseSeconds: 30, workers: 1, kind: "device", scripts: [], env: { baseUrl: "device:", headless: true }, device: { sessionId: "s", appPackage: PKG, maxActions: 5, totalMinutes: 1, realPhone: false, removeInstalledApp: true } } as unknown as TaskOffer;
        const results: unknown[] = [];
        const client = { heartbeat: async () => ({ cancel: true }), pushDevice: async () => undefined } as never;
        const task = new DeviceTask(offer, {
            client,
            log: memoryLogger().log,
            env: {},
            cache: {} as never,
            postResult: async (b) => void results.push(b),
            beatMs: 20,
            open: async (o) => {
                seen = o;
                throw new Error("stop here");
            },
        });
        await task.run();
        expect(seen).toMatchObject({ noRealPhone: true, removeInstalledApp: true });
    });
});

describe("the phone session on the runner (fake adb)", () => {
    const FAKE_ADB = path.resolve("tests/fixtures/fake-adb.mjs");
    const FAKE_EMULATOR = path.resolve("tests/fixtures/fake-emulator.mjs");
    let n = 0;
    let state = "";
    let apk = "";
    const fakeEnv = (devices: "phone" | "both"): NodeJS.ProcessEnv => {
        n++;
        state = path.join(dir, `adb-state-${n}.json`);
        return { ...process.env, AITP_ADB_PATH: FAKE_ADB, AITP_EMULATOR_PATH: FAKE_EMULATOR, AITP_FAKE_STATE: state, AITP_FAKE_DEVICES: devices, AITP_FAKE_APP: "shop", ANDROID_AVD_HOME: path.join(dir, "no-avds"), TAQWRIGHT_HOME: "/nonexistent-taqwright", ANDROID_HOME: "" };
    };
    const readState = () => JSON.parse(fs.readFileSync(state, "utf8")) as { installed: string[]; uninstalled?: string[] };
    /** The phone starts without the app under test. */
    const withoutApp = (env: NodeJS.ProcessEnv) => {
        execFileSync(process.execPath, [FAKE_ADB, "uninstall", PKG], { env });
        fs.writeFileSync(state, JSON.stringify({ ...readState(), uninstalled: [] }));
    };
    beforeAll(() => {
        apk = path.join(dir, "shop.apk");
        fs.writeFileSync(apk, "not really an apk");
    });

    it("never uses a connected real phone when the owner did not allow it", async () => {
        await expect(openLocalDeviceSession({ appPackage: PKG, env: fakeEnv("phone"), noRealPhone: true })).rejects.toThrow(NO_REAL_PHONE);
        await expect(openLocalDeviceSession({ appPackage: PKG, env: fakeEnv("phone"), serial: "R58M12ABCDE", noRealPhone: true })).rejects.toThrow(NO_REAL_PHONE);
        const s = await openLocalDeviceSession({ appPackage: PKG, env: fakeEnv("both"), noRealPhone: true });
        try {
            expect(s.emulator).toBe(true);
        } finally {
            await s.close();
        }
    });

    it("removes the app from a real phone after the session when the session installed it, and only then", async () => {
        const env = fakeEnv("phone");
        withoutApp(env);
        const s = await openLocalDeviceSession({ appPackage: PKG, env, apkPath: apk, removeInstalledApp: true });
        expect(readState().installed).toContain(PKG);
        await s.close();
        expect(readState()).toMatchObject({ uninstalled: [PKG] });
        expect(readState().installed).not.toContain(PKG);

        // The app was already on the phone: it stays.
        const env2 = fakeEnv("phone");
        const s2 = await openLocalDeviceSession({ appPackage: PKG, env: env2, apkPath: apk, removeInstalledApp: true });
        await s2.close();
        expect(readState().uninstalled ?? []).toHaveLength(0);
        expect(readState().installed).toContain(PKG);
    });
});
