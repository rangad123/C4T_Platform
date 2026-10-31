/**
 * iOS tests, the parts that need no Mac: the adapter, rendering (including that Android output is untouched), simulator choice, the
 * Taqwright config, the capability rule, framework settings, the simulator start and stop logic against a fake `xcrun`, and the
 * infrastructure/verdict split. Nothing here starts a simulator or Xcode; the one process it starts is the stand-in Taqwright CLI.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Capabilities, TaskOffer } from "../src/agent-protocol/schema.js";
import { CapabilityProbe, countIosSimulators, describeCapabilities, detectXcuitest } from "../src/agent/capabilities.js";
import { REPO_ROOT } from "../src/config.js";
import { adapterForSpec, getAdapter, listAdapters, needsDevice } from "../src/engine/frameworks/index.js";
import { clampSettings, defaultFrameworkSettings, describeDeviations, effectiveSettings, FrameworkSettingsInput, mergeSettings, normalizeSettings } from "../src/engine/frameworks/settings.js";
import { withFrameworkSettings } from "../src/engine/frameworks/settings-executor.js";
import type { ExecutionBatch, ExecutionEnv, ScriptExecutor } from "../src/engine/frameworks/types.js";
import { renderScript } from "../src/engine/generators/index.js";
import { IOS_CONFIG, iosChildEnv } from "../src/engine/mobile/ios-config.js";
import { iosCapabilityProblem } from "../src/engine/mobile/ios-capability.js";
import { classifyIosInfrastructure, ensureSimulator, PLATFORM_PROBLEM, runIosScripts, type Xcrun } from "../src/engine/mobile/ios-runner.js";
import { chooseSimulator, compareVersionsDesc, iosVersionOfRuntime, parseSimctlDevices } from "../src/engine/mobile/ios-simulators.js";
import { iosSpecIssues } from "../src/engine/mobile/ios-spec.js";
import { MobileTargetSchema } from "../src/engine/mobile/target.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { capabilityProblem } from "../src/platform/agent-routing.js";

const FAKE_CLI = path.join(REPO_ROOT, "tests/fixtures/fake-taqwright.mjs");
const OBSERVED = path.join(os.tmpdir(), "aitp-fake-taqwright-observed.json");
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const U3 = "33333333-3333-3333-3333-333333333333";
const U4 = "44444444-4444-4444-4444-444444444444";

const spec = (steps: unknown[], extra: Record<string, unknown> = {}) => TestSpecSchema.parse({ testId: "MOB-001", title: "Network settings are listed", kind: "mobile", category: "Mobile", steps, ...extra });
const visible = (text: string) => ({ action: "assert", check: "visible", locator: { by: "text", value: text } });
const ctx = { baseUrl: "ios-app://com.apple.Preferences" };

let tmp: string;
beforeAll(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ios-unit-"))));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const R16 = "com.apple.CoreSimulator.SimRuntime.iOS-16-4";
const R17 = "com.apple.CoreSimulator.SimRuntime.iOS-17-5";
const DEVICES = {
    devices: {
        [R16]: [{ udid: U1, name: "iPhone 14", state: "Shutdown", isAvailable: true }],
        [R17]: [
            { udid: U2, name: "iPhone 15", state: "Shutdown", isAvailable: true },
            { udid: U3, name: "iPad (10th generation)", state: "Shutdown", isAvailable: true },
            { udid: U4, name: "iPhone 15 Pro", state: "Shutdown", isAvailable: false },
        ],
        "com.apple.CoreSimulator.SimRuntime.watchOS-10-0": [{ udid: "55555555-5555-5555-5555-555555555555", name: "Apple Watch", state: "Booted", isAvailable: true }],
    } as Record<string, Array<{ udid: string; name: string; state: string; isAvailable: boolean }>>,
};

/** A fake `xcrun` holding simulator states in memory and recording every call. */
function fakeXcrun(devices = structuredClone(DEVICES), over: { failBoot?: boolean; failList?: boolean; failBootstatus?: boolean } = {}) {
    const calls: string[][] = [];
    const all = () => Object.values(devices.devices).flat();
    const xcrun: Xcrun = async (args) => {
        calls.push(args);
        const [, verb, udid] = args;
        if (verb === "list") return over.failList ? { ok: false, stdout: "", stderr: "xcrun: error: unable to find utility" } : { ok: true, stdout: JSON.stringify(devices), stderr: "" };
        if (verb === "boot") {
            if (over.failBoot) return { ok: false, stdout: "", stderr: "Unable to boot" };
            const d = all().find((x) => x.udid === udid);
            if (d) d.state = "Booted";
            return { ok: true, stdout: "", stderr: "" };
        }
        if (verb === "bootstatus") return over.failBootstatus ? { ok: false, stdout: "", stderr: "failed" } : { ok: true, stdout: "", stderr: "" };
        if (verb === "shutdown") {
            const d = all().find((x) => x.udid === udid);
            if (d) d.state = "Shutdown";
            return { ok: true, stdout: "", stderr: "" };
        }
        return { ok: false, stdout: "", stderr: "unknown" };
    };
    return { xcrun, calls, devices };
}

describe("the iOS adapter", () => {
    it("describes itself, needs a Mac and a device", () => {
        const a = getAdapter("taqwright-ios");
        expect(a.describe()).toEqual({ id: "taqwright-ios", label: "Taqwright iOS (Appium, TypeScript)", kinds: ["mobile"], executable: true, runtime: "taqwright-ios", needs: { node: true, ios: true }, traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false } });
        expect(needsDevice(a)).toBe(true);
        expect(JSON.parse(JSON.stringify(a.describe()))).toEqual(a.describe());
        expect(listAdapters().map((x) => x.id)).toContain("taqwright");
    });

    it("a mobile spec with platform ios belongs to it; everything else keeps its old adapter", () => {
        expect(adapterForSpec(spec([visible("x")], { platform: "ios" })).id).toBe("taqwright-ios");
        expect(adapterForSpec(spec([visible("x")], { platform: "android" })).id).toBe("taqwright");
        expect(adapterForSpec(spec([visible("x")])).id).toBe("taqwright");
        expect(adapterForSpec({ kind: "web" }).id).toBe("playwright");
        expect(adapterForSpec({ kind: "api" }).id).toBe("playwright-api");
    });

    it("without a simulator set up for the run it answers with an error result, never a pass", async () => {
        const a = getAdapter("taqwright-ios");
        const runs = await a.execute({ scratchDir: tmp, scripts: [{ testId: "MOB-001", filename: "MOB-001.mobile.spec.ts", content: "" }] }, { run: { baseUrl: "x", headless: true } }, { workers: 1 });
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ testId: "MOB-001", status: "error", error: "No iOS simulator is set up for this run." });
    });
});

describe("rendering", () => {
    const steps = [{ action: "click", locator: { by: "text", value: "Network" } }, { action: "fill", locator: { by: "label", value: "Search" }, value: "wifi" }, { action: "press", key: "device:back" }, { action: "press", key: "Enter" }, visible("Network & internet")];

    it("Android output is byte for byte what it was before iOS existed (stored hash)", () => {
        const r = renderScript(spec(steps), "taqwright", { baseUrl: "android-app://com.android.settings" });
        // Round 24 (RUN), on purpose: every phone test now starts the launcher activity the runner resolved on the phone (`mobile: startActivity`, not
        // Taqwright's launchApp / activateApp) and watches system dialogs (mobile/device/start-script.ts: the hooks block and its `import type { Mobile }`).
        // Putting the old hooks back and dropping that import gives exactly the previous hash 000063767178af83…126ea: nothing else of the output changed.
        expect(crypto.createHash("sha256").update(r.content).digest("hex")).toBe("50e96632a35518cf06fab2fd90c618f110622f95379c1a77d4335a64513ab3b8");
        expect(r.framework).toBe("taqwright");
    });

    it("a spec without a platform parses and stores exactly as before (no platform key appears)", () => {
        expect(Object.keys(spec(steps))).not.toContain("platform");
        expect(JSON.stringify(spec(steps))).not.toContain("platform");
    });

    it("an iOS test renders the same script text as Android, labelled as the iOS framework", () => {
        const android = renderScript(spec(steps), "taqwright", ctx);
        const ios = getAdapter("taqwright-ios").render(spec(steps, { platform: "ios" }), ctx);
        expect(ios.framework).toBe("taqwright-ios");
        expect(ios.content).toBe(android.content);
        expect(ios.content).toContain("await mobile.goBack();");
        expect(ios.filename).toBe("MOB-001.mobile.spec.ts");
    });

    it("refuses what iOS cannot do, in plain words, at render time and at import time", () => {
        const bad = spec([{ action: "press", key: "Space" }, { action: "press", key: "device:fly" }, visible("x")], { platform: "ios" });
        const issues = iosSpecIssues(bad);
        expect(issues).toHaveLength(2);
        expect(issues[0]).toBe('Step 1: iOS can\'t press the key "Space". It understands Enter, Tab, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Escape.');
        expect(issues[1]).toContain('"device:fly" is not a device action');
        expect(() => getAdapter("taqwright-ios").render(bad, ctx)).toThrow(/iOS can't press the key "Space"/);
        // the same step is fine on Android (it is the Android keycode table's business)
        expect(iosSpecIssues(spec([{ action: "press", key: "Space" }, visible("x")], { platform: "android" }))).toEqual([]);
        expect(iosSpecIssues(spec([{ action: "press", key: "device:scroll:down" }, { action: "press", key: "device:home" }, visible("x")], { platform: "ios" }))).toEqual([]);
        expect(iosSpecIssues({ kind: "web", steps: [], platform: "ios" })).toEqual(["Only mobile tests have a platform."]);
        expect(() => getAdapter("taqwright-ios").render(spec([visible("x")]), ctx)).toThrow(/platform "ios"/);
    });
});

describe("choosing a simulator", () => {
    const sims = parseSimctlDevices(DEVICES);

    it("reads only available iOS simulators", () => {
        expect(sims.map((s) => s.name).sort()).toEqual(["iPad (10th generation)", "iPhone 14", "iPhone 15"]);
        expect(iosVersionOfRuntime(R17)).toBe("17.5");
        expect(iosVersionOfRuntime("com.apple.CoreSimulator.SimRuntime.tvOS-17-0")).toBeUndefined();
        expect(parseSimctlDevices(null)).toEqual([]);
        expect(parseSimctlDevices({ devices: { [R17]: [{ udid: "not-a-udid", name: "x" }] } })).toEqual([]);
        expect(compareVersionsDesc("17.5", "16.4")).toBeLessThan(0);
        expect(compareVersionsDesc("17.10", "17.9")).toBeLessThan(0);
    });

    it("with no name: the newest iOS, iPhone before iPad", () => {
        const c = chooseSimulator(sims);
        expect(c.ok && c.simulator.name).toBe("iPhone 15");
        expect(c.ok && c.running).toBe(false);
    });

    it("a simulator that is already running wins over a newer one, and is reported as running", () => {
        const c = chooseSimulator(sims.map((s) => (s.udid === U1 ? { ...s, state: "Booted" } : s)));
        expect(c.ok && c.simulator.udid).toBe(U1);
        expect(c.ok && c.running).toBe(true);
    });

    it("a name picks exactly that simulator (ignoring case), and an unknown name says what exists", () => {
        const c = chooseSimulator(sims, "  IPHONE 14 ");
        expect(c.ok && c.simulator.udid).toBe(U1);
        expect(chooseSimulator(sims, "iPhone 99")).toEqual({ ok: false, message: 'The iOS simulator "iPhone 99" does not exist on this Mac (available: iPhone 15, iPad (10th generation), iPhone 14).' });
        expect(chooseSimulator([])).toMatchObject({ ok: false, message: expect.stringContaining("No iOS simulator is set up on this Mac") });
    });

    it("does not depend on the order of the list", () => {
        expect(chooseSimulator(sims)).toEqual(chooseSimulator([...sims].reverse()));
    });
});

describe("the Taqwright config for iOS", () => {
    it("is fixed text for Platform.IOS that reads everything variable from the environment", () => {
        expect(IOS_CONFIG).toContain("Platform.IOS");
        expect(IOS_CONFIG).toContain("process.env.MOBILE_SIMULATOR");
        expect(IOS_CONFIG).toContain("autoStartDevice: false");
        expect(IOS_CONFIG).not.toMatch(/password|secret|token/i);
        expect(IOS_CONFIG).not.toContain(tmp);
    });

    it("the environment carries names and numbers only, with empty credentials", () => {
        const env = iosChildEnv({ simulatorName: "iPhone 15", udid: U2, version: "17.5", bundleId: "com.apple.Preferences", port: 4812, testTimeoutMs: 123456.4 });
        expect(env).toEqual({ FORCE_COLOR: "0", MOBILE_SIMULATOR: "iPhone 15", MOBILE_UDID: U2, MOBILE_IOS_VERSION: "17.5", MOBILE_APPIUM_PORT: "4812", MOBILE_APP_PACKAGE: "com.apple.Preferences", MOBILE_TEST_TIMEOUT_MS: "123456", TEST_USERNAME: "", TEST_PASSWORD: "" });
    });

    it("the app target accepts a bundle id and a simulator name, and refuses anything that is not one", () => {
        expect(MobileTargetSchema.safeParse({ iosBundleId: "com.apple.Preferences", simulator: "iPhone 15 Pro" }).success).toBe(true);
        expect(MobileTargetSchema.safeParse({ appPackage: "com.android.settings" }).success).toBe(true);
        for (const bad of [{ iosBundleId: "nodots" }, { iosBundleId: "com.x; rm -rf /" }, { iosBundleId: "com.x.y", simulator: "$(reboot)" }, { iosBundleId: "com.x.y", simulator: "a/b" }, {}]) expect(MobileTargetSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    });
});

describe("which computers can run iOS tests", () => {
    const mac = { os: "darwin", ios: { xcode: true, simulators: ["iPhone 15 (Shutdown)"], iosSimulators: 1, xcuitest: true } };

    it("needs a Mac, Xcode, an iOS simulator and the XCUITest driver, and says which is missing", () => {
        expect(iosCapabilityProblem(mac)).toBeUndefined();
        expect(iosCapabilityProblem({ ...mac, os: "linux" })).toBe("it is not a Mac");
        expect(iosCapabilityProblem({ os: "darwin" })).toMatch(/^Xcode is not installed/);
        expect(iosCapabilityProblem({ os: "darwin", ios: { xcode: false, simulators: [] } })).toMatch(/^Xcode is not installed/);
        expect(iosCapabilityProblem({ os: "darwin", ios: { ...mac.ios, iosSimulators: 0 } })).toMatch(/no iOS simulator/);
        // simctl also lists watches and TVs: only iOS simulators count
        expect(iosCapabilityProblem({ os: "darwin", ios: { xcode: true, simulators: ["Apple Watch (Booted)"], iosSimulators: 0, xcuitest: true } })).toMatch(/no iOS simulator/);
        expect(iosCapabilityProblem({ os: "darwin", ios: { ...mac.ios, xcuitest: false } })).toMatch(/XCUITest driver is not installed/);
        // an agent built before iOS support reports neither field
        expect(iosCapabilityProblem({ os: "darwin", ios: { xcode: true, simulators: ["iPhone 15 (Shutdown)"] } })).toMatch(/XCUITest driver/);
    });

    it("the platform's routing rule uses it for the iOS adapter only, and Android is not affected", () => {
        const ios = getAdapter("taqwright-ios");
        const caps = (o: object) => Capabilities.parse({ arch: "arm64", node: "v24", browsers: [], ...o });
        expect(capabilityProblem(ios, caps({ os: "darwin", ios: mac.ios }))).toBeUndefined();
        expect(capabilityProblem(ios, caps({ os: "win32" }))).toBe("it is not a Mac");
        expect(capabilityProblem(ios, caps({ os: "darwin", ios: { xcode: true, simulators: ["x"] } }))).toMatch(/XCUITest/);
        // a Mac with an Android emulator but no Xcode: Android yes, iOS no
        const androidMac = caps({ os: "darwin", android: { adb: true, devices: [], avds: ["Pixel"] } });
        expect(capabilityProblem(getAdapter("taqwright"), androidMac)).toBeUndefined();
        expect(capabilityProblem(ios, androidMac)).toMatch(/^Xcode/);
        // an iOS Mac without Android tools
        expect(capabilityProblem(getAdapter("taqwright"), caps({ os: "darwin", ios: mac.ios }))).toMatch(/Android tools/);
    });

    it("the protocol carries the new fields as optional extras", () => {
        expect(Capabilities.safeParse({ os: "darwin", arch: "arm64", node: "v24", browsers: [], ios: { xcode: true, simulators: [] } }).success).toBe(true);
        const offer = TaskOffer.parse({ taskId: "t", jobId: "j", adapterId: "taqwright-ios", leaseSeconds: 60, workers: 1, scripts: [], env: { baseUrl: "x", headless: true }, ios: { bundleId: "com.apple.Preferences", simulator: "iPhone 15" } });
        expect(offer.ios).toEqual({ bundleId: "com.apple.Preferences", simulator: "iPhone 15" });
        // an agent built before iOS support ignores the field
        expect(TaskOffer.omit({ ios: true }).parse(offer)).not.toHaveProperty("ios");
    });

    it("the agent reports Xcode, iOS simulators and the XCUITest driver, and describes them", async () => {
        expect(countIosSimulators(DEVICES)).toBe(3);
        const home = path.join(tmp, "taq");
        const exec = async (file: string, args: string[]) => (file === "xcode-select" ? "/Applications/Xcode.app/Contents/Developer" : args[0] === "simctl" ? JSON.stringify(DEVICES) : file === "appium" ? '{"xcuitest":{"version":"7.0.0"}}' : undefined);
        const caps = await new CapabilityProbe({ platform: "darwin", env: { TAQWRIGHT_HOME: home }, exec, browsers: () => [] }).discover();
        expect(caps.os).toBe("darwin");
        expect(caps.ios).toMatchObject({ xcode: true, iosSimulators: 3, xcuitest: true });
        expect(iosCapabilityProblem(caps)).toBeUndefined();
        expect(describeCapabilities(caps)).toContain("XCUITest driver found (iOS tests can run)");
        // Taqwright's own install is found by its folder, without asking appium
        fs.mkdirSync(path.join(home, "appium-home", "node_modules", "appium-xcuitest-driver"), { recursive: true });
        expect(await detectXcuitest({ TAQWRIGHT_HOME: home }, async () => undefined)).toBe(true);
        expect(await detectXcuitest({ TAQWRIGHT_HOME: path.join(tmp, "none") }, async () => undefined)).toBe(false);
        const noDriver = await new CapabilityProbe({ platform: "darwin", env: { TAQWRIGHT_HOME: path.join(tmp, "none") }, exec: async (file, args) => (file === "xcode-select" ? "/x" : args[0] === "simctl" ? JSON.stringify(DEVICES) : undefined), browsers: () => [] }).discover();
        expect(noDriver.ios?.xcuitest).toBe(false);
        expect(describeCapabilities(noDriver)).toContain("XCUITest driver not found");
        // not a Mac: nothing is reported
        const win = await new CapabilityProbe({ platform: "win32", exec: async () => undefined, browsers: () => [], desktop: async () => ({ uiautomation: false, interactive: true, elevated: false }) }).discover();
        expect(win.ios).toBeUndefined();
    });
});

describe("framework settings for iOS", () => {
    it("defaults are on, no default simulator, 180 s, and a project stored before iOS existed still reads", () => {
        const d = defaultFrameworkSettings();
        expect(d.enabled["taqwright-ios"]).toBe(true);
        expect(d.ios).toEqual({ defaultSimulator: "", keepSimulator: false, testTimeoutSeconds: 180 });
        const old = normalizeSettings({ enabled: { playwright: false }, web: { headless: true, workers: null, testTimeoutSeconds: 60 } });
        expect(old.ios).toEqual(d.ios);
        expect(old.enabled.playwright).toBe(false);
        expect(describeDeviations(d, effectiveSettings(d, { onAgent: true, platformWorkers: 2 }))).toEqual([]);
    });

    it("validates the simulator name and clamps the time limit; unknown fields are refused", () => {
        expect(FrameworkSettingsInput.safeParse({ ios: { defaultSimulator: "iPhone 15" } }).success).toBe(true);
        expect(FrameworkSettingsInput.safeParse({ ios: { defaultSimulator: "bad/name" } }).success).toBe(false);
        expect(FrameworkSettingsInput.safeParse({ ios: { surprise: 1 } }).success).toBe(false);
        const { settings, adjusted } = clampSettings(mergeSettings(defaultFrameworkSettings(), { ios: { testTimeoutSeconds: 9999 } }));
        expect(settings.ios.testTimeoutSeconds).toBe(300);
        expect(adjusted).toEqual(["The iOS test time limit was set to 300 seconds, the most allowed."]);
        const s = mergeSettings(defaultFrameworkSettings(), { ios: { defaultSimulator: "iPhone 15", keepSimulator: true, testTimeoutSeconds: 240 }, enabled: { "taqwright-ios": false } });
        expect(describeDeviations(s, effectiveSettings(s, { onAgent: true, platformWorkers: 2 }))).toEqual(["ios tests turned off", "a 240 s test timeout for iOS tests", "the simulator kept running", "the simulator iPhone 15"]);
    });

    it("the settings wrapper hands the project's simulator, keep-running choice and time limit to iOS runs, and a switched-off framework gets a plain refusal", async () => {
        const seen: Array<{ env: ExecutionEnv; testTimeoutMs?: number; id: string }> = [];
        const inner: ScriptExecutor = { name: "t", remote: true, execute: async (id, batch: ExecutionBatch, env, opts) => (seen.push({ env, id, ...(opts.testTimeoutMs !== undefined ? { testTimeoutMs: opts.testTimeoutMs } : {}) }), batch.scripts.map((s): ScriptRun => ({ testId: s.testId, status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] }))) };
        const settings = mergeSettings(defaultFrameworkSettings(), { ios: { defaultSimulator: "iPhone 15", keepSimulator: true, testTimeoutSeconds: 240 } });
        const ex = withFrameworkSettings(inner, effectiveSettings(settings, { onAgent: true, platformWorkers: 2 }), true);
        const batch = { scratchDir: tmp, scripts: [{ testId: "MOB-001", filename: "a.mobile.spec.ts", content: "" }] };
        const env: ExecutionEnv = { run: { baseUrl: "x", headless: true }, ios: { target: { iosBundleId: "com.apple.Preferences" } } };
        await ex.execute("taqwright-ios", batch, env, { workers: 1 });
        expect(seen[0]!.env.ios).toMatchObject({ defaultSimulator: "iPhone 15", keepSimulator: true });
        expect(seen[0]!.testTimeoutMs).toBe(240_000);
        // the app's own simulator wins over the project's default
        await ex.execute("taqwright-ios", batch, { ...env, ios: { target: { iosBundleId: "com.x.y", simulator: "iPad (10th generation)" } } }, { workers: 1 });
        expect(seen[1]!.env.ios!.defaultSimulator).toBeUndefined();
        const off = withFrameworkSettings(inner, effectiveSettings(mergeSettings(defaultFrameworkSettings(), { enabled: { "taqwright-ios": false } }), { onAgent: true, platformWorkers: 2 }), true);
        const refused = await off.execute("taqwright-ios", batch, env, { workers: 1 });
        expect(refused[0]).toMatchObject({ status: "error", error: "iOS tests are turned off for this project. Turn them on under Runners, Frameworks." });
        expect(seen).toHaveLength(2);
    });
});

describe("starting and stopping the simulator", () => {
    it("boots a shut-down simulator and shuts down that one by its id, only", async () => {
        const f = fakeXcrun();
        const h = await ensureSimulator("iPhone 15", f.xcrun);
        expect(h.started).toBe(true);
        expect(h.simulator.udid).toBe(U2);
        await h.stop();
        expect(f.calls).toEqual([["simctl", "list", "devices", "-j"], ["simctl", "boot", U2], ["simctl", "bootstatus", U2], ["simctl", "shutdown", U2]]);
    });

    it("a simulator that was already running is used and never booted or shut down", async () => {
        const dev = structuredClone(DEVICES);
        dev.devices[R16]![0]!.state = "Booted";
        const f = fakeXcrun(dev);
        const h = await ensureSimulator(undefined, f.xcrun);
        expect(h.started).toBe(false);
        expect(h.simulator.udid).toBe(U1);
        await h.stop();
        expect(f.calls.map((c) => c[1])).toEqual(["list"]);
        expect(f.devices.devices[R16]![0]!.state).toBe("Booted");
    });

    it("a simulator that is still starting (by someone else) is waited for, not booted, and not shut down", async () => {
        const dev = structuredClone(DEVICES);
        dev.devices[R17]![0]!.state = "Booting";
        const f = fakeXcrun(dev);
        const h = await ensureSimulator("iPhone 15", f.xcrun);
        await h.stop();
        expect(f.calls.map((c) => c[1])).toEqual(["list", "bootstatus"]);
        expect(h.started).toBe(false);
    });

    it("a simulator that never finishes starting is shut down again (it was ours), and the reason is plain", async () => {
        const f = fakeXcrun(undefined, { failBootstatus: true });
        await expect(ensureSimulator("iPhone 15", f.xcrun)).rejects.toThrow("The simulator iPhone 15 did not finish starting");
        expect(f.calls.map((c) => c.slice(1).join(" "))).toEqual(["list devices -j", `boot ${U2}`, `bootstatus ${U2}`, `shutdown ${U2}`]);
    });

    it("problems with Xcode or the simulator list are plain sentences", async () => {
        await expect(ensureSimulator(undefined, fakeXcrun(undefined, { failList: true }).xcrun)).rejects.toThrow(/Xcode's simulator tool did not answer/);
        await expect(ensureSimulator("Nope", fakeXcrun().xcrun)).rejects.toThrow(/does not exist on this Mac/);
        const f = fakeXcrun(undefined, { failBoot: true });
        await expect(ensureSimulator(undefined, f.xcrun)).rejects.toThrow(/could not be started/);
        expect(f.calls.some((c) => c[1] === "shutdown")).toBe(false);
        await expect(ensureSimulator(undefined, async () => ({ ok: true, stdout: "{not json", stderr: "" }))).rejects.toThrow(/could not read/);
    });

    it("a cancelled run stops what it started", async () => {
        const f = fakeXcrun();
        const stop = new AbortController();
        const xcrun: Xcrun = async (args) => {
            if (args[1] === "bootstatus") stop.abort();
            return f.xcrun(args);
        };
        await expect(ensureSimulator(undefined, xcrun, { signal: stop.signal })).rejects.toThrow("Job cancelled");
        expect(f.calls.at(-1)).toEqual(["simctl", "shutdown", U2]);
    });
});

describe("running scripts through the stand-in Taqwright CLI", () => {
    const script = () => {
        const r = getAdapter("taqwright-ios").render(spec([visible("Network")], { platform: "ios" }), ctx);
        return { testId: "MOB-001", filename: r.filename, content: r.content };
    };
    const failing = () => {
        const r = getAdapter("taqwright-ios").render(spec([visible("Network [fail]")], { platform: "ios", testId: "MOB-002" }), ctx);
        return { testId: "MOB-002", filename: r.filename, content: r.content };
    };
    const dir = () => fs.mkdtempSync(path.join(tmp, "run-"));
    const PATH_ONLY = () => ({ PATH: process.env.PATH });

    it("boots the simulator, runs with the iOS config and environment, stops what it started, and returns the neutral results", async () => {
        const f = fakeXcrun();
        const logs: string[] = [];
        const runs = await runIosScripts(dir(), [script(), failing()], { target: { iosBundleId: "com.apple.Preferences" }, defaultSimulator: "iPhone 14", cliPath: FAKE_CLI, xcrun: f.xcrun, platform: "darwin", log: (m) => logs.push(m), sourceEnv: { ...PATH_ONLY(), ANTHROPIC_API_KEY: "sk-leak-me", AITP_AGENT_TOKEN: "aitg_leak" } });
        expect(runs.map((r) => [r.testId, r.status])).toEqual([["MOB-001", "passed"], ["MOB-002", "failed"]]);
        const seen = JSON.parse(fs.readFileSync(OBSERVED, "utf8"));
        expect(seen.config).toContain("Platform.IOS");
        expect(seen.env).toMatchObject({ MOBILE_SIMULATOR: "iPhone 14", MOBILE_UDID: U1, MOBILE_IOS_VERSION: "16.4", MOBILE_APP_PACKAGE: "com.apple.Preferences", MOBILE_TEST_TIMEOUT_MS: "180000", TEST_PASSWORD: "" });
        expect(JSON.stringify(seen.env)).not.toContain("sk-leak-me");
        expect(JSON.stringify(seen.env)).not.toContain("aitg_leak");
        expect(f.calls.map((c) => c.slice(1).join(" "))).toEqual(["list devices -j", `boot ${U1}`, `bootstatus ${U1}`, `shutdown ${U1}`]);
        expect(logs.join("\n")).toContain("Starting the simulator iPhone 14 (iOS 16.4)");
    });

    it("keepSimulator leaves a simulator this run booted running", async () => {
        const f = fakeXcrun();
        await runIosScripts(dir(), [script()], { target: { iosBundleId: "com.apple.Preferences" }, keepSimulator: true, cliPath: FAKE_CLI, xcrun: f.xcrun, platform: "darwin", sourceEnv: PATH_ONLY() });
        expect(f.calls.some((c) => c[1] === "shutdown")).toBe(false);
    });

    it("the app's own simulator wins over the project's default; a stand-in CLI alone touches no simulator", async () => {
        const f = fakeXcrun();
        await runIosScripts(dir(), [script()], { target: { iosBundleId: "com.x.y", simulator: "iPad (10th generation)" }, defaultSimulator: "iPhone 14", cliPath: FAKE_CLI, xcrun: f.xcrun, platform: "darwin", sourceEnv: PATH_ONLY() });
        expect(JSON.parse(fs.readFileSync(OBSERVED, "utf8")).env.MOBILE_SIMULATOR).toBe("iPad (10th generation)");
        const g = fakeXcrun();
        const runs = await runIosScripts(dir(), [script()], { target: { iosBundleId: "com.x.y" }, manageSimulator: false, cliPath: FAKE_CLI, xcrun: g.xcrun, sourceEnv: PATH_ONLY() });
        expect(runs[0]!.status).toBe("passed");
        expect(g.calls).toEqual([]);
    });

    it("a problem with the Mac is an error result with a plain sentence for every script, never a test failure", async () => {
        const base = { target: { iosBundleId: "com.apple.Preferences" }, cliPath: FAKE_CLI, sourceEnv: PATH_ONLY() };
        const notMac = await runIosScripts(dir(), [script()], { ...base, platform: "win32" });
        expect(notMac[0]).toMatchObject({ status: "error", error: PLATFORM_PROBLEM });
        const none = await runIosScripts(dir(), [script(), failing()], { ...base, platform: "darwin", xcrun: fakeXcrun({ devices: {} }).xcrun });
        expect(none.map((r) => r.status)).toEqual(["error", "error"]);
        expect(none[0]!.error).toContain("No iOS simulator is set up on this Mac");
        const noXcode = await runIosScripts(dir(), [script()], { ...base, platform: "darwin", xcrun: fakeXcrun(undefined, { failList: true }).xcrun });
        expect(noXcode[0]).toMatchObject({ status: "error" });
        expect(noXcode[0]!.error).toContain("Xcode's simulator tool did not answer");
    });

    it("a cancelled run before it starts throws instead of reporting results", async () => {
        const stop = new AbortController();
        stop.abort();
        await expect(runIosScripts(dir(), [script()], { target: { iosBundleId: "a.b" } }, { signal: stop.signal })).rejects.toThrow("Job cancelled");
    });
});

describe("infrastructure is not a verdict", () => {
    const run = (over: Partial<ScriptRun>): ScriptRun => ({ testId: "MOB-001", status: "failed", durationMs: 5, failedStepIndex: -1, steps: [], artifacts: [], responses: [], ...over });

    it("a failure before any step, about the iOS session, becomes an error result", () => {
        for (const error of ["Could not create a new session: WebDriverAgent failed to start", "SessionNotCreated: xcuitest driver is not installed", "Unable to find a device matching the provided name"]) {
            const out = classifyIosInfrastructure(run({ error }));
            expect(out.status, error).toBe("error");
            expect(out.error).toMatch(/^The iOS session could not be started: /);
        }
    });

    it("a failing step, a passing run, or an ordinary error stays what it was", () => {
        const failedStep = run({ failedStepIndex: 0, error: "WebDriverAgent mentioned in a step", steps: [{ index: 0, title: "1. x", status: "failed" }] });
        expect(classifyIosInfrastructure(failedStep)).toBe(failedStep);
        const passed = run({ status: "passed" });
        expect(classifyIosInfrastructure(passed)).toBe(passed);
        const other = run({ error: "expect(locator).toBeVisible() failed" });
        expect(classifyIosInfrastructure(other)).toBe(other);
    });
});
