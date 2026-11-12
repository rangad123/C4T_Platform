/**
 * iOS tests end to end with a FAKE toolchain: the real platform (API, worker, job gate, remote executor) and the real agent program
 * (task runner, child process, iOS adapter, simulator start and stop logic), with the Taqwright CLI replaced by
 * tests/fixtures/fake-taqwright.mjs (IOS_RUNNER_CLI) and `xcrun` by tests/fixtures/fake-xcrun.mjs (IOS_XCRUN_CLI). The "Mac" is a
 * capability probe that says darwin, Xcode, simulators and the XCUITest driver. No simulator, Xcode or Appium is involved, so this
 * proves the routing, gating, result handling and simulator bookkeeping, not that a real iPhone simulator passes a test.
 *
 * Starts only node processes (no browser). Ports: platform 6150.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { CapabilityProbe } from "../src/agent/capabilities.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner, runOwner, testPerson } from "./helpers/personal-runner.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 6150;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "ios-admin-key-77d1";
let RUN_AS = API_KEY;
const FAKE_TAQWRIGHT = path.join(REPO_ROOT, "tests/fixtures/fake-taqwright.mjs");
const FAKE_XCRUN = path.join(REPO_ROOT, "tests/fixtures/fake-xcrun.mjs");
const XCRUN_STATE = path.join(os.tmpdir(), "aitp-fake-xcrun-state.json");
const OBSERVED = path.join(os.tmpdir(), "aitp-fake-taqwright-observed.json");
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const U_NEW = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const U_OLD = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const U_OTHER = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let tmp: string;
const agents: Array<{ agent: Agent; done: Promise<number>; lines: string[] }> = [];

const admin = async (method: string, url: string, body?: unknown, key: string | null = RUN_AS) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...(key ? { "x-api-key": key } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};

async function jobDone(jobId: string): Promise<any> {
    for (let i = 0; i < 300; i++) {
        const j = (await admin("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("job did not finish");
}

/** The fake `xcrun`'s world: two iOS simulators, none running, nothing called yet. */
function resetSimulators(over: Record<string, unknown> = {}) {
    fs.writeFileSync(
        XCRUN_STATE,
        JSON.stringify({
            calls: [],
            devices: {
                "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
                    { udid: U_NEW, name: "iPhone 15", state: "Shutdown", isAvailable: true },
                    { udid: U_OTHER, name: "iPad (10th generation)", state: "Shutdown", isAvailable: true },
                ],
                "com.apple.CoreSimulator.SimRuntime.iOS-16-4": [{ udid: U_OLD, name: "iPhone 14", state: "Shutdown", isAvailable: true }],
            },
            ...over,
        }),
    );
}
const xcrunCalls = (): string[] => (JSON.parse(fs.readFileSync(XCRUN_STATE, "utf8")).calls as string[][]).map((c) => c.slice(1).join(" ")).filter((c) => !c.startsWith("list"));

const macProbe = (over: { xcuitest?: boolean } = {}) =>
    new CapabilityProbe({
        platform: "darwin",
        env: { TAQWRIGHT_HOME: path.join(tmp, "no-taqwright") },
        browsers: () => [],
        exec: async (file, args) => (file === "xcode-select" ? "/Applications/Xcode.app/Contents/Developer" : args[0] === "simctl" ? JSON.stringify({ devices: JSON.parse(fs.readFileSync(XCRUN_STATE, "utf8")).devices }) : file === "appium" && over.xcuitest !== false ? '{"xcuitest":{}}' : undefined),
    });
const windowsProbe = () => new CapabilityProbe({ platform: "win32", browsers: () => ["chromium"], exec: async () => undefined, desktop: async () => ({ uiautomation: true, interactive: true, elevated: false }) });

async function startAgent(projectId: string, name: string, probe: CapabilityProbe, env: NodeJS.ProcessEnv = {}) {
    const made = { status: 201, body: { secret: personalRunner(platform, { label: name, replace: true }).secret } };
    expect(made.status).toBe(201);
    const { log, lines } = memoryLogger();
    const agent = new Agent({
        config: { baseUrl: BASE, token: made.body.secret, name, concurrency: 1, workDir: fs.mkdtempSync(path.join(tmp, "agent-")), allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" },
        log,
        env: { ...process.env, IOS_RUNNER_CLI: FAKE_TAQWRIGHT, IOS_XCRUN_CLI: FAKE_XCRUN, ...env },
        probe,
        heartbeatMs: 400,
        backoff: { baseMs: 100, maxMs: 500 },
    });
    const done = agent.run();
    agents.push({ agent, done, lines });
    for (let i = 0; i < 100; i++) {
        const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; online: boolean }>;
        if (list.some((a) => a.name === name && a.online)) return { token: made.body.secret as string, lines };
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`agent ${name} did not connect`);
}

const iosSpec = (title: string, text: string, extra: Record<string, unknown> = {}) => ({ title, kind: "mobile", platform: "ios", category: "iOS", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: text } }], ...extra });

beforeAll(async () => {
    // Several runners in one project here; the one-runner default is covered in runner-limit-unit.test.ts.
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "3" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ios-int-"));
    dataDir = path.join(tmp, "data");
    resetSimulators();
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    // Round 45: runs started with the shared key have no owner, so the test acts as a person whose runner takes them.
    RUN_AS = testPerson(platform).token;
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
}, 60_000);

afterAll(async () => {
    for (const a of agents) a.agent.stop();
    await Promise.all(agents.map((a) => a.done));
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(XCRUN_STATE, { force: true });
});

describe("iOS tests on a runner agent that is a Mac (fake toolchain)", () => {
    let projectId = "";
    let macToken = "";
    let macLines: string[] = [];
    const ids: Record<string, string> = {};

    it("lists the iOS framework in the platform's configuration", async () => {
        const cfg = (await admin("GET", "/api/config")).body;
        const ios = cfg.adapters.find((a: { id: string }) => a.id === "taqwright-ios");
        expect(ios).toMatchObject({ id: "taqwright-ios", kinds: ["mobile"], executable: true, needs: { node: true, ios: true } });
        expect(cfg.frameworks).toContainEqual({ framework: "taqwright-ios", kind: "mobile", executable: true });
    });

    it("imports iOS tests: they get the iOS framework, the project gets its iOS app, and Android tests next to them keep theirs", async () => {
        projectId = (await admin("POST", "/api/projects", { name: "iOS project" })).body.id;
        // The test acts as a person (round 45), whose changes would wait for approval: these tests are about running them.
        await admin("PUT", `/api/projects/${projectId}/review-policy`, { edits: false });
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, {
            mobile: { iosBundleId: "com.apple.Preferences" },
            validate: false,
            specs: [iosSpec("Settings shows General", "General"), iosSpec("A missing row is reported", "Nothing like this [fail]"), { title: "Android settings", kind: "mobile", category: "Android", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Network" } }] }],
        });
        expect(imp.status, imp.text).toBe(202);
        const tests = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string; framework: string }>;
        const byTitle = Object.fromEntries(tests.map((t) => [t.title, t]));
        expect(byTitle["Settings shows General"]!.framework).toBe("taqwright-ios");
        expect(byTitle["A missing row is reported"]!.framework).toBe("taqwright-ios");
        expect(byTitle["Android settings"]!.framework).toBe("taqwright");
        ids.general = byTitle["Settings shows General"]!.id;
        ids.missing = byTitle["A missing row is reported"]!.id;
        ids.android = byTitle["Android settings"]!.id;
        const detail = (await admin("GET", `/api/projects/${projectId}`)).body;
        expect(detail.mobile).toEqual({ appPackage: null, apk: null, avd: null, iosBundleId: "com.apple.Preferences" });
        expect(detail.application.url).toBe("ios-app://com.apple.Preferences");
        // the export carries the platform, so a round trip keeps the test an iOS test
        const exported = (await admin("GET", `/api/projects/${projectId}/specs`)).body.specs as Array<{ title: string; platform?: string }>;
        expect(exported.find((s) => s.title === "Settings shows General")!.platform).toBe("ios");
        expect(exported.find((s) => s.title === "Android settings")!.platform).toBeUndefined();
    });

    it("an iOS spec that iOS cannot run is refused at import with the reason", async () => {
        const bad = await admin("POST", `/api/projects/${projectId}/specs`, { validate: false, specs: [iosSpec("Press space", "x", { steps: [{ action: "press", key: "Space" }] })] });
        expect(bad.status).toBe(400);
        expect(bad.text).toContain("iOS can't press the key");
        const web = await admin("POST", `/api/projects/${projectId}/specs`, { validate: false, specs: [{ title: "A web test", kind: "web", platform: "ios", category: "x", steps: [{ action: "navigate", url: "https://example.com/" }] }] });
        expect(web.status).toBe(400);
        expect(web.text).toContain("Only mobile tests have a platform");
    });

    it("with the project running here, an iOS run is refused early with plain wording (no job, no verdict)", async () => {
        const here = await admin("POST", `/api/tests/${ids.general}/validate`);
        expect(here.status).toBe(409);
        expect(here.body.error).toBe("iOS tests need a runner on a Mac with Xcode. Set up your runner on a Mac in Settings.");
        const tests = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; validationStatus: string }>;
        expect(tests.find((t) => t.id === ids.general)!.validationStatus).toBe("PENDING");
    });

    it("a Mac without the XCUITest driver is not capable: the refusal names what is missing", async () => {
        const noDriver = await startAgent(projectId, "Mac without driver", macProbe({ xcuitest: false }));
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
        const r = await admin("POST", `/api/tests/${ids.general}/validate`);
        expect(r.status).toBe(409);
        expect(r.body.error).toContain("iOS tests need a runner on a Mac with Xcode");
        expect(r.body.error).toContain("XCUITest driver is not installed");
        const status = (await admin("GET", `/api/projects/${projectId}/runner`)).body;
        expect(status.canRunIos).toBe(false);
        expect(noDriver.token.startsWith("aitg_")).toBe(true);
        agents[0]!.agent.stop();
        await new Promise((r) => setTimeout(r, 300));
    }, 60_000);

    it("connects a Mac agent; the project shows iOS as possible", async () => {
        resetSimulators();
        const mac = await startAgent(projectId, "The Mac", macProbe());
        macToken = mac.token;
        macLines = mac.lines;
        const status = (await admin("GET", `/api/projects/${projectId}/runner`)).body;
        expect(status.canRunIos).toBe(true);
        const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; online: boolean; capabilities: { ios?: { xcuitest?: boolean; iosSimulators?: number } } }>;
        expect(list.find((a) => a.name === "The Mac" && a.online)!.capabilities.ios).toMatchObject({ xcuitest: true, iosSimulators: 3 });
    }, 60_000);

    it("a passing iOS test is VALIDATED by the Mac agent, which started the simulator and stopped that one by its id", async () => {
        resetSimulators();
        const started = await admin("POST", `/api/tests/${ids.general}/validate`);
        expect(started.status, started.text).toBe(202);
        const job = await jobDone(started.body.jobId);
        expect(job.ranOn).toMatchObject({ kind: "agent", name: "The Mac" });
        const exec = (await admin("GET", `/api/tests/${ids.general}/executions`)).body;
        expect(exec[0]).toMatchObject({ status: "passed" });
        const tests = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; validationStatus: string }>;
        expect(tests.find((t) => t.id === ids.general)!.validationStatus).toBe("VALIDATED");
        // newest iOS first, iPhone before iPad: iPhone 15; booted once, waited for, shut down by its id, nothing else touched
        expect(xcrunCalls()).toEqual([`boot ${U_NEW}`, `bootstatus ${U_NEW}`, `shutdown ${U_NEW}`]);
        const seen = JSON.parse(fs.readFileSync(OBSERVED, "utf8"));
        expect(seen.config).toContain("Platform.IOS");
        expect(seen.env).toMatchObject({ MOBILE_SIMULATOR: "iPhone 15", MOBILE_UDID: U_NEW, MOBILE_APP_PACKAGE: "com.apple.Preferences" });
        expect(JSON.stringify(seen.env)).not.toContain(macToken);
        expect(macLines.join("\n")).not.toContain(macToken);
    }, 120_000);

    it("a failing iOS step is a failed verdict with the failing step, and the simulator is still stopped", async () => {
        resetSimulators();
        const started = await admin("POST", `/api/tests/${ids.missing}/validate`);
        expect(started.status, started.text).toBe(202);
        await jobDone(started.body.jobId);
        const exec = (await admin("GET", `/api/tests/${ids.missing}/executions`)).body;
        expect(exec[0].status).not.toBe("passed");
        expect(exec[0].error).toBeTruthy(); // the stand-in CLI reports "step failed"
        const tests = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; validationStatus: string }>;
        expect(tests.find((t) => t.id === ids.missing)!.validationStatus).not.toBe("VALIDATED");
        expect(xcrunCalls()).toEqual([`boot ${U_NEW}`, `bootstatus ${U_NEW}`, `shutdown ${U_NEW}`]);
    }, 120_000);

    it("a simulator that was already running is used and left running", async () => {
        resetSimulators();
        const state = JSON.parse(fs.readFileSync(XCRUN_STATE, "utf8"));
        state.devices["com.apple.CoreSimulator.SimRuntime.iOS-16-4"][0].state = "Booted";
        fs.writeFileSync(XCRUN_STATE, JSON.stringify(state));
        const started = await admin("POST", `/api/tests/${ids.general}/validate`);
        await jobDone(started.body.jobId);
        expect((await admin("GET", `/api/tests/${ids.general}/executions`)).body[0]).toMatchObject({ status: "passed" });
        expect(xcrunCalls()).toEqual([]);
        expect(JSON.parse(fs.readFileSync(OBSERVED, "utf8")).env.MOBILE_UDID).toBe(U_OLD);
    }, 120_000);

    it("the project's framework settings choose the simulator and can switch iOS off", async () => {
        resetSimulators();
        const put = await admin("PUT", `/api/projects/${projectId}/framework-settings`, { settings: { ios: { defaultSimulator: "iPad (10th generation)" } } });
        expect(put.status, put.text).toBe(200);
        expect(put.body.settings.ios.defaultSimulator).toBe("iPad (10th generation)");
        expect(put.body.adapters.find((a: { id: string }) => a.id === "taqwright-ios")).toMatchObject({ label: "Taqwright iOS (Appium, TypeScript)", enabled: true, available: { agent: true } });
        const started = await admin("POST", `/api/tests/${ids.general}/validate`);
        await jobDone(started.body.jobId);
        expect(xcrunCalls()).toEqual([`boot ${U_OTHER}`, `bootstatus ${U_OTHER}`, `shutdown ${U_OTHER}`]);
        expect(JSON.parse(fs.readFileSync(OBSERVED, "utf8")).env.MOBILE_SIMULATOR).toBe("iPad (10th generation)");
        const off = await admin("PUT", `/api/projects/${projectId}/framework-settings`, { settings: { enabled: { "taqwright-ios": false } } });
        expect(off.status).toBe(200);
        const refused = await admin("POST", `/api/tests/${ids.general}/validate`);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toBe("iOS tests are turned off for this project. Turn them on under Runners, Frameworks.");
        await admin("PUT", `/api/projects/${projectId}/framework-settings`, { settings: { enabled: { "taqwright-ios": true }, ios: { defaultSimulator: "" } } });
    }, 120_000);

    it("a problem with the Mac (no simulator, Xcode not answering) is an infrastructure error, never a failed test", async () => {
        const before = (await admin("GET", `/api/tests/${ids.general}/executions`)).body.length;
        resetSimulators({ failList: true });
        const started = await admin("POST", `/api/tests/${ids.general}/validate`);
        expect(started.status).toBe(202);
        const job = await jobDone(started.body.jobId);
        expect(job.status).not.toBe("COMPLETED");
        const events = JSON.stringify((await admin("GET", `/api/test-generation/${started.body.jobId}/events`)).body);
        expect(events).toContain("Xcode's simulator tool did not answer");
        // no run is recorded in the test's history for this problem; the test shows the plain reason (the platform's usual
        // "Validation interrupted" handling for any runner problem), not a failing step
        expect((await admin("GET", `/api/tests/${ids.general}/executions`)).body.length).toBe(before);
        const tests = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<Record<string, unknown>>;
        const item = tests.find((t) => t.id === ids.general)!;
        expect(JSON.stringify(item)).toContain("Xcode's simulator tool did not answer");
        expect(xcrunCalls()).toEqual([]);
    }, 120_000);

    it("Android tests are unaffected by the iOS agent: a Mac with no Android tools is refused for them as before", async () => {
        resetSimulators();
        const r = await admin("POST", `/api/tests/${ids.android}/validate`);
        expect(r.status).toBe(409);
        expect(r.body.error).toContain("cannot run phone tests");
        expect(r.body.error).toContain("Android tools");
        expect(xcrunCalls()).toEqual([]);
    });
});

describe("agents that are not Macs, other projects, and keys", () => {
    it("an agent without iOS is never offered an iOS task, and a project with only such an agent is refused early", async () => {
        resetSimulators();
        const projectId = (await admin("POST", "/api/projects", { name: "Windows agent only" })).body.id;
        await admin("PUT", `/api/projects/${projectId}/review-policy`, { edits: false });
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { mobile: { iosBundleId: "com.apple.Preferences" }, validate: false, specs: [iosSpec("Settings shows General", "General")] });
        expect(imp.status, imp.text).toBe(202);
        const testId = imp.body.tests[0].id;
        await startAgent(projectId, "Windows box", windowsProbe());
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
        const r = await admin("POST", `/api/tests/${testId}/validate`);
        expect(r.status).toBe(409);
        expect(r.body.error).toContain("iOS tests need a runner on a Mac with Xcode");
        expect(r.body.error).toContain("it is not a Mac");
        expect((await admin("GET", `/api/projects/${projectId}/runner`)).body.canRunIos).toBe(false);
        // the Mac of the other project never saw it
        expect(xcrunCalls()).toEqual([]);
    }, 60_000);

    it("the platform's API and the agent's routes stay protected", async () => {
        const pid = (await admin("GET", "/api/projects")).body[0].id;
        expect((await admin("GET", `/api/projects/${pid}`, undefined, null)).status).toBe(401);
        expect((await admin("GET", `/api/projects/${pid}`, undefined, "wrong")).status).toBe(401);
        const noToken = await fetch(`${BASE}/api/agent/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "x", freeSlots: 1 }) });
        expect(noToken.status).toBe(401);
        const withKeyOnly = await fetch(`${BASE}/api/agent/poll`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": API_KEY }, body: JSON.stringify({ agentId: "x", freeSlots: 1 }) });
        expect(withKeyOnly.status).toBe(401);
    });
});
