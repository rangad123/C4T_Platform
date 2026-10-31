/**
 * UXP item 6: the runner agent card and the "where tests run" setting never contradict each other. The audit saw "Android: no
 * devices connected" next to "PHONE TESTS CAN RUN": the agent had an emulator it could start. Now one rule decides whether phone
 * tests can run, and the platform's answer carries that decision and the words for it, so the card and the setting say the same.
 * Browser-free: a real platform, a fake agent speaking the protocol through the server (no ports).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { androidSummary } from "../src/platform/agent-routing.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaInject } from "./fixtures/fake-agent.js";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dir: string;

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ux-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir }));
    server = await buildServer(platform);
});
afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};

type Android = NonNullable<ReturnType<typeof defaultCaps>["android"]>;
const phone = (state: string, emulator = false) => ({ serial: `s-${Math.random().toString(36).slice(2, 7)}`, state, emulator });

/** A project with one online agent that reports `android`, set to run there; returns the agents list and the runner status. */
async function withAgent(name: string, android: Android | undefined) {
    const project = (await call("POST", "/api/projects", { name })).body.id as string;
    const token = (await call("POST", `/api/projects/${project}/agent-tokens`, { label: name })).body.secret as string;
    const agent = new FakeAgent(viaInject(server), token, { name, capabilities: defaultCaps({ ...(android ? { android } : {}) }) });
    expect((await agent.hello()).status).toBe(200);
    const set = await call("PUT", `/api/projects/${project}/runner`, { runOn: "agent", agentId: null });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const agents = (await call("GET", `/api/projects/${project}/agents`)).body as any[];
    const runner = (await call("GET", `/api/projects/${project}/runner`)).body;
    return { agent: agents[0], runner };
}

describe("one decision, one set of words", () => {
    it("an agent with an emulator it can start: the card says so, and phone tests can run", async () => {
        const { agent, runner } = await withAgent("Maya", { adb: true, devices: [], avds: ["Pixel_6"] });
        expect(agent.capabilities.android).toMatchObject({ state: "emulator", summary: "Android: no phone connected, 1 emulator can be started" });
        expect(runner.canRunMobile).toBe(true);
        expect(runner.phones).toEqual({ canRun: true, text: "Phone tests can run on Maya. Android: no phone connected, 1 emulator can be started." });
        // The old card said "no devices connected" here, which a reader could not square with "phone tests can run".
        expect(agent.capabilities.android.summary).not.toMatch(/no devices connected/);
    });

    it("an agent with no phone and no emulator: the card and the setting both say phone tests cannot run, and why", async () => {
        const { agent, runner } = await withAgent("Bare", { adb: true, devices: [], avds: [] });
        expect(agent.capabilities.android).toMatchObject({ state: "none", summary: "Android: no devices connected" });
        expect(runner.canRunMobile).toBe(false);
        expect(runner.phones.canRun).toBe(false);
        expect(runner.phones.text).toBe("Phone tests can't run: it has no Android phone connected and no emulator set up.");
        expect(runner.unavailableReason).toContain("it has no Android phone connected and no emulator set up");
    });

    it("a phone that waits for permission is not ready, and the card says that", async () => {
        const { agent, runner } = await withAgent("Waiting", { adb: true, devices: [phone("unauthorized")], avds: [] });
        expect(agent.capabilities.android).toMatchObject({ state: "none", summary: "Android: 1 device, none ready" });
        expect(runner.canRunMobile).toBe(false);
        expect(runner.phones.canRun).toBe(false);
    });

    it("a connected phone (and an emulator)", async () => {
        const { agent, runner } = await withAgent("Busy", { adb: true, devices: [phone("device"), phone("device", true)], avds: [] });
        expect(agent.capabilities.android).toMatchObject({ state: "phone", summary: "Android: 2 devices, 1 emulator" });
        expect(runner.phones).toEqual({ canRun: true, text: "Phone tests can run on Busy. Android: 2 devices, 1 emulator." });
    });

    it("no Android tools at all", async () => {
        const { agent, runner } = await withAgent("Plain", { adb: false, devices: [], avds: [] });
        expect(agent.capabilities.android).toMatchObject({ state: "no-tools", summary: "Android: adb not found" });
        expect(runner.phones).toEqual({ canRun: false, text: "Phone tests can't run: it has no Android tools (adb) installed." });
        const none = await withAgent("Web only", undefined);
        expect(none.agent.capabilities.android).toBeUndefined();
        expect(none.runner.phones.canRun).toBe(false);
    });

    it("the rule is the same everywhere: the summary's verdict always equals what routing decides", () => {
        const cases: Array<Android | undefined> = [
            undefined,
            { adb: false, devices: [], avds: [] },
            { adb: true, devices: [], avds: [] },
            { adb: true, devices: [], avds: ["a"] },
            { adb: true, devices: [phone("offline")], avds: [] },
            { adb: true, devices: [phone("offline")], avds: ["a", "b"] },
            { adb: true, devices: [phone("device")], avds: [] },
        ];
        const expected = [false, false, false, true, false, true, true];
        cases.forEach((c, i) => expect(androidSummary(c).canRun, JSON.stringify(c)).toBe(expected[i]));
    });

    it("a project that runs tests on this server has the same fields", async () => {
        const project = (await call("POST", "/api/projects", { name: "Local" })).body.id as string;
        const runner = (await call("GET", `/api/projects/${project}/runner`)).body;
        expect(runner.phones).toMatchObject({ canRun: runner.canRunMobile });
        expect(typeof runner.phones.text).toBe("string");
        expect(runner.phones.text.length).toBeGreaterThan(10);
    });
});
