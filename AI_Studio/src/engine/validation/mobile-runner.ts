/**
 * Executes rendered Taqwright scripts on an Android phone or emulator through Appium and parses the result.
 * Same contract as runner.ts: a script is "passed" only if the runner says so, and a run that cannot
 * happen (no device, no report) is reported as an error, never as a pass.
 *
 * Differences from the browser runner: one device means one worker; the first boot of an emulator is
 * slow, so limits are generous; and an emulator that this run started is stopped afterwards, because
 * leaving a multi-gigabyte VM running on someone's machine is not a courtesy to assume.
 *
 * Which device (mobile/device/choose.ts): the project's choice (the phone the AI explored on, a named phone, an emulator), else a connected real phone
 * that has the app, else an emulator; an emulator is never started when a ready phone with the app is chosen. Before the tests a pre-flight checks the
 * device and resolves the screen that opens the app ON the phone (device/preflight.ts, device/launcher.ts); the tests start exactly that screen. A test
 * that hit a problem of the phone itself (the UiAutomator2 helper crashed, the connection dropped) runs once more and, if it happens again, is reported
 * as "the phone could not run the test" (device/infra.ts), never as a failing test of the app.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import type { MobileTarget } from "../mobile/target.js";
import { ensureEmulator, withDeviceLock } from "../mobile/emulator.js";
import { Adb } from "../mobile/device/adb.js";
import { needsPreparation, runEachPrepared } from "../mobile/state/clean-start.js";
import { runOnConnectedPhones } from "../mobile/cloud/local-parallel.js";
import { withPhoneChecks } from "../mobile/quality/run-checks.js";
import { pickRunDevice, ranOnSentence, type RunDevice } from "../mobile/device/choose.js";
import { preflight, preflightCall } from "../mobile/device/preflight.js";
import { asInfrastructure, infraKind, PHONE_INFRA_PREFIX } from "../mobile/device/infra.js";
import { HELPER_PACKAGES } from "../mobile/device/ready.js";
import { LAUNCH_APP_PATCH } from "../mobile/device/start-script.js";
import { effectiveRunsOn } from "../mobile/phone-settings.js";
import type { AdbDevice } from "../mobile/device/adb.js";
import { CHILD_ENV_ALLOW, parseReport, type ScriptInput, type ScriptRun } from "./runner.js";
import { scrubRunTraces, traceSecretsOfChildEnv } from "../evidence/trace-scrub.js";

const require = createRequire(import.meta.url);

export interface MobileRunEnv {
    target: MobileTarget;
    /** Emulator to run on (resolved by the caller: target.avd, MOBILE_AVD, or the first AVD found). */
    avd: string;
    /** Environment variables for the child; defaults to process.env. Exposed for tests. */
    sourceEnv?: NodeJS.ProcessEnv;
    /** Override the Taqwright CLI entry point (tests use a stand-in; production resolves the installed package). */
    cliPath?: string;
    /** Leave an emulator this run started running afterwards. Default: stop it. */
    keepEmulator?: boolean;
    /** Start/stop the emulator here (default). Tests that substitute the runner CLI turn this off. */
    manageEmulator?: boolean;
    /** Progress messages (emulator start-up can take minutes). */
    log?: (message: string) => void;
    /** The project's test account, for steps that type {{credentials.username}} / {{credentials.password}}. Goes to the child's environment only, never into a script. */
    credentials?: { username: string; password: string };
    /** Several phone tests at once on several connected phones (project setting, see mobile/cloud/local-parallel.ts). Unset or 1: one device, as always. */
    parallel?: number;
    /** Where the run happens, for the sentence that names the device ("a phone on this computer"). Runners say whose computer. */
    where?: string;
    /** Told the device a run used and the screen that opens the app there (the platform keeps the launcher activity with the project's app). */
    onDevice?: (d: UsedDevice) => void | Promise<void>;
}

/** The device a run used, as the run found it. */
export interface UsedDevice {
    serial: string;
    model?: string | undefined;
    emulator: boolean;
    /** `package/activity` that opens the app, resolved on the device; absent for an APK-only project. */
    component?: string | undefined;
    /** The Android user the app runs as. */
    user?: number | undefined;
    sentence: string;
}

/** Variables the Android toolchain reads that the browser runner has no reason to pass. */
export const MOBILE_ENV_ALLOW = new Set(["TAQWRIGHT_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_AVD_HOME", "ANDROID_USER_HOME", "JAVA_HOME", "APPIUM_HOME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]);

const CONFIG = `import { defineConfig, Platform, Mobile } from "@taqwright/taqwright";
const apk = process.env.MOBILE_APK_PATH;
const pkg = process.env.MOBILE_APP_PACKAGE;
// The screen that opens the app, resolved on the device before the run (package/activity), and the Android user it runs as.
const component = process.env.MOBILE_APP_COMPONENT;
const activity = component ? component.slice(component.indexOf("/") + 1) : "";
const appUser = process.env.MOBILE_APP_USER;
${LAUNCH_APP_PATCH}
export default defineConfig({
    testDir: ".",
    testMatch: /.*\\.spec\\.ts$/,
    timeout: Number(process.env.MOBILE_TEST_TIMEOUT_MS ?? 180000),
    workers: 1,
    retries: 0,
    reporter: [["json", { outputFile: "report.json" }]],
    outputDir: "artifacts",
    projects: [
        {
            name: "android",
            use: {
                platform: Platform.ANDROID,
                // The platform picks the device (a real phone, or an emulator it started itself: see mobile/device/choose.ts, mobile/emulator.ts) and names it.
                device: { provider: process.env.MOBILE_DEVICE_KIND === "phone" ? "local-device" : "emulator", name: process.env.MOBILE_AVD as string, ...(process.env.MOBILE_UDID ? { udid: process.env.MOBILE_UDID } : {}) },
                ...(apk ? { buildPath: apk } : {}),
                ...(pkg ? { appBundleId: pkg } : {}),
                // Each run has its own Appium port: the previous run's server may still be shutting down on the usual one.
                appium: { autoStart: true, autoStartDevice: false, connectionTimeout: 300000, ...(process.env.MOBILE_APPIUM_PORT ? { port: Number(process.env.MOBILE_APPIUM_PORT) } : {}) },
                capabilities: {
                    // Only when several phones run at once (device farms feature): each session forwards its own UiAutomator2 port.
                    ...(process.env.MOBILE_SYSTEM_PORT ? { "appium:systemPort": Number(process.env.MOBILE_SYSTEM_PORT) } : {}),
                    // The session opens exactly the resolved screen (never Appium's own resolution), waits for any screen of the app, and restarts it.
                    ...(activity ? { "appium:appActivity": activity, "appium:appWaitActivity": "*", "appium:appWaitDuration": 30000, "appium:forceAppLaunch": true } : {}),
                    ...(appUser && appUser !== "0" ? { "appium:userProfile": Number(appUser) } : {}),
                    // Keep the app's data (a signed-in app stays signed in); a clean start is done by the platform before a test when asked.
                    "appium:noReset": true,
                    // Feeds and videos never go idle: do not wait for it (the tests wait for their elements instead), and draw without animations.
                    "appium:settings": { waitForIdleTimeout: 100 },
                    "appium:disableWindowAnimation": true,
                    // The same tree the exploration read: unimportant views are kept, so locators match.
                    "appium:ignoreUnimportantViews": false,
                    "appium:uiautomator2ServerLaunchTimeout": 60000,
                },
                // Recorded for every test, kept only when one fails so reviewers can watch what happened.
                video: "on-failure",
                trace: "on-failure",
                expectTimeout: 15000,
            },
        },
    ],
});
`;

/** The run configuration every phone run writes (exported for the tests that run real Taqwright against a scripted Appium). */
export const MOBILE_RUN_CONFIG = CONFIG;

function taqwrightCli(): string {
    // The package's "exports" only exposes ".", so locate the CLI relative to its main entry.
    return path.join(path.dirname(require.resolve("@taqwright/taqwright")), "bin", "index.js");
}

/** A TCP port nothing is using right now. */
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address() as net.AddressInfo;
            srv.close(() => resolve(port));
        });
    });
}

function killTree(pid: number | undefined) {
    if (!pid) return;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            /* already gone */
        }
    }
}

export const failAll = (scripts: ScriptInput[], error: string): ScriptRun[] =>
    scripts.map((s) => ({ testId: s.testId, status: "error", durationMs: 0, error, failedStepIndex: -1, steps: [], artifacts: [], responses: [] }));

export async function runMobileScripts(scratchDir: string, scripts: ScriptInput[], env: MobileRunEnv, opts: { timeoutMs?: number; signal?: AbortSignal; /** Per-test time limit in ms (project setting); unset = 180 s. */ testTimeoutMs?: number } = {}): Promise<ScriptRun[]> {
    if (scripts.length === 0) return [];
    if (opts.signal?.aborted) throw new Error("Job cancelled");
    // One emulator: concurrent jobs wait their turn.
    return withDeviceLock(async () => {
        const source = env.sourceEnv ?? process.env;
        // Phone quality checks around every run on a phone (mobile/quality/run-checks.ts): crashes and freezes, start-up time, accessibility check tests.
        const phoneChecks = (group: ScriptInput[], serial: string | undefined, run: (batch: ScriptInput[]) => Promise<ScriptRun[]>) =>
            withPhoneChecks({ scripts: group, target: env.target, sourceEnv: source, serial, signal: opts.signal, log: env.log, secrets: env.credentials?.password ? [env.credentials.password] : [] }, run);
        // Several connected phones at once, when the project allows it and more than one is ready (mobile/cloud/local-parallel.ts). Otherwise undefined: as always.
        const spread = await runOnConnectedPhones(scripts, env, (group, serial, systemPort) =>
            phoneChecks(group, serial, async (batch) => {
                const start = await prepareDevice(env, source, opts.signal, { serial, state: "device", emulator: serial.startsWith("emulator-") });
                if (start.problem) return failAll(batch, `${PHONE_INFRA_PREFIX}${start.problem}`);
                return withInfraRetry(batch, (b) => execute(scratchDir, b, env, opts, serial, systemPort, start.launch, !serial.startsWith("emulator-")), env, source, serial, opts.signal);
            }),
        );
        if (spread) return spread;

        // Which device (mobile/device/choose.ts). Decided here whenever the platform manages the device, or the project named one; a stand-in runner
        // with no choice made (the platform's own tests) keeps the device it was given, exactly as before.
        const adb = Adb.locate({ env: source, ...(opts.signal ? { signal: opts.signal } : {}) });
        const where = env.where ?? "this computer";
        let device: RunDevice | undefined;
        let listed: AdbDevice[] = [];
        if (adb && (env.manageEmulator !== false || effectiveRunsOn(env.target).kind !== "auto")) {
            const picked = await pickRunDevice({ adb, appPackage: env.target.appPackage, runsOn: env.target.runsOn, exploredOn: env.target.exploredOn, avd: env.avd, canStartEmulator: env.manageEmulator !== false, where });
            device = picked.device;
            listed = picked.devices;
            if (device.kind === "none") return failAll(scripts, `${PHONE_INFRA_PREFIX}${device.problem}`);
            env.log?.(device.why);
        }

        let handle: Awaited<ReturnType<typeof ensureEmulator>> | undefined;
        let serial: string | undefined = device && device.kind !== "none" ? device.serial : undefined;
        if (env.manageEmulator !== false && !serial) {
            try {
                handle = await ensureEmulator(device?.kind === "emulator" && device.avd ? device.avd : env.avd, { env: source, signal: opts.signal, log: env.log });
                serial = handle.serial;
            } catch (e) {
                if (opts.signal?.aborted) throw e;
                return failAll(scripts, `The Android emulator could not be started: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        try {
            // Pre-flight on the device the run uses, and the screen that opens the app there (only when the device is known).
            const facts: AdbDevice | undefined = serial && device ? (listed.find((d) => d.serial === serial) ?? { serial, state: "device", emulator: serial.startsWith("emulator-") }) : undefined;
            const start = facts ? await prepareDevice(env, source, opts.signal, facts) : {};
            if (start.problem) return failAll(scripts, `${PHONE_INFRA_PREFIX}${start.problem}`);
            const phone = device?.kind === "phone";
            let ran: string | undefined;
            if (facts && device && device.kind === "phone") ran = ranOnSentence(device, where);
            else if (facts && device && device.kind === "emulator") ran = ranOnSentence({ kind: "emulator", serial: facts.serial, ...(device.avd ? { avd: device.avd } : {}), why: "" }, where, Boolean(handle?.started));
            if (facts && ran) await env.onDevice?.({ serial: facts.serial, ...(facts.model ? { model: facts.model } : {}), emulator: facts.emulator, ...(start.launch ? { component: start.launch.component, user: start.launch.user } : {}), sentence: ran });
            const runs = await phoneChecks(scripts, serial, (batch) => withInfraRetry(batch, (b) => execute(scratchDir, b, env, opts, serial, undefined, start.launch, phone), env, source, serial, opts.signal));
            if (ran) env.log?.(ran);
            // On a real phone each passing result says which phone it ran on (an emulator run reads as before).
            return phone && ran ? runs.map((r) => (r.status === "passed" ? { ...r, notes: [...(r.notes ?? []), ran!] } : r)) : runs;
        } finally {
            if (handle?.started && !env.keepEmulator) await handle.stop();
        }
    });
}

/** What pre-flight found on the device: the problem that stops the run, or the screen that opens the app. Notes are said in the run's log. */
async function prepareDevice(env: MobileRunEnv, source: NodeJS.ProcessEnv, signal: AbortSignal | undefined, facts: AdbDevice): Promise<{ problem?: string; launch?: { component: string; user: number } }> {
    const adb = Adb.locate({ env: source, ...(signal ? { signal } : {}) });
    if (!adb) return {};
    const pf = await preflight(preflightCall(adb.forSerial(facts.serial)), { device: facts, appPackage: env.target.appPackage, apkGiven: Boolean(env.target.apkPath) });
    for (const n of pf.notes) env.log?.(n);
    if (!pf.ok) return { problem: pf.problem ?? "The phone is not ready to run tests." };
    if (pf.launch?.component) {
        const how = pf.launch.via === "resolve-activity" ? "asking the phone" : pf.launch.via === "dumpsys" ? "reading the app's description on the phone" : "opening the app once";
        env.log?.(`The app opens with ${pf.launch.component}${pf.launch.user ? ` for user ${pf.launch.user}` : ""} (found by ${how}).`);
        return { launch: { component: pf.launch.component, user: pf.launch.user } };
    }
    return {};
}

/**
 * Runs the batch; a test that hit a problem of the phone itself (device/infra.ts) runs once more, after the test helper on the phone is stopped so it
 * starts fresh. A second problem of the same kind is reported as "the phone could not run the test".
 */
async function withInfraRetry(batch: ScriptInput[], run: (b: ScriptInput[]) => Promise<ScriptRun[]>, env: MobileRunEnv, source: NodeJS.ProcessEnv, serial: string | undefined, signal: AbortSignal | undefined): Promise<ScriptRun[]> {
    const first = await run(batch);
    const hit = first.map((r, i) => ({ i, words: infraKind(r) })).filter((x): x is { i: number; words: string } => Boolean(x.words));
    if (hit.length === 0 || signal?.aborted) return first;
    const what = hit[0]!.words.replace(/[.]$/, "");
    env.log?.(`${hit.length === 1 ? "A test" : `${hit.length} tests`} could not run because of the phone (${what}); running ${hit.length === 1 ? "it" : "them"} once more.`);
    const adb = Adb.locate({ env: source, ...(signal ? { signal } : {}) });
    if (adb && serial) for (const p of HELPER_PACKAGES) await adb.forSerial(serial).forceStop(p).catch(() => undefined);
    const again = await run(hit.map((x) => batch[x.i]!));
    const out = [...first];
    hit.forEach((x, k) => {
        const r = again[k] ?? first[x.i]!;
        const words = infraKind(r);
        out[x.i] = words ? asInfrastructure(r, words, 2) : r;
    });
    return out;
}

async function execute(scratchDir: string, scripts: ScriptInput[], env: MobileRunEnv, opts: { timeoutMs?: number; signal?: AbortSignal; testTimeoutMs?: number }, serial: string | undefined, systemPort?: number, launch?: { component: string; user: number }, phone?: boolean): Promise<ScriptRun[]> {
    const source = env.sourceEnv ?? process.env;
    const runDir = path.join(scratchDir, `run-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "taqwright.config.ts"), CONFIG);
    for (const s of scripts) await fs.writeFile(path.join(runDir, s.filename), s.content);

    // Like the browser runner, the child gets only what it needs — never the platform's secrets.
    const passthrough = Object.fromEntries(Object.entries(source).filter(([k]) => CHILD_ENV_ALLOW.has(k.toUpperCase()) || MOBILE_ENV_ALLOW.has(k.toUpperCase())));
    const childEnv: NodeJS.ProcessEnv = {
        ...passthrough,
        FORCE_COLOR: "0",
        MOBILE_AVD: env.avd,
        MOBILE_UDID: serial ?? "",
        MOBILE_APPIUM_PORT: String(await freePort()),
        MOBILE_APP_PACKAGE: env.target.appPackage ?? "",
        MOBILE_APK_PATH: env.target.apkPath ?? "",
        MOBILE_TEST_TIMEOUT_MS: String(opts.testTimeoutMs !== undefined ? Math.round(opts.testTimeoutMs) : Math.min(opts.timeoutMs ?? 180_000, 180_000)),
        TEST_USERNAME: env.credentials?.username ?? "",
        TEST_PASSWORD: env.credentials?.password ?? "",
        ...(systemPort ? { MOBILE_SYSTEM_PORT: String(systemPort) } : {}),
        // Round 24: the screen that opens the app on this device and the user it runs as (pre-flight), how a permission question still showing is
        // answered by the test's dialog watch, and whether the device is a real phone (never an emulator Taqwright might start).
        ...(launch ? { MOBILE_APP_COMPONENT: launch.component, MOBILE_APP_USER: String(launch.user) } : {}),
        MOBILE_PERMISSION_ANSWER: "allow",
        ...(phone ? { MOBILE_DEVICE_KIND: "phone" } : {}),
    };

    // Clean start and permissions before each test (mobile/state/clean-start.ts): one run per test, the phone prepared in front of each. Off: as before.
    if (needsPreparation(env.target)) {
        const adb = Adb.locate({ env: source, ...(opts.signal ? { signal: opts.signal } : {}) });
        return runEachPrepared({
            scripts,
            target: env.target,
            adb: adb && serial ? adb.forSerial(serial) : adb,
            signal: opts.signal,
            log: env.log,
            notPrepared: (s, reason) => failAll([s], reason)[0]!,
            runOne: async (s, i) => {
                const dir = path.join(runDir, `test-${i + 1}`);
                await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(path.join(dir, "taqwright.config.ts"), CONFIG);
                await fs.writeFile(path.join(dir, s.filename), s.content);
                return runTaqwrightCli({ runDir: dir, childEnv: { ...childEnv, MOBILE_APPIUM_PORT: String(await freePort()) }, cliPath: env.cliPath, scripts: [s], timeoutMs: opts.timeoutMs, testTimeoutMs: opts.testTimeoutMs, signal: opts.signal });
            },
        });
    }

    return runTaqwrightCli({ runDir, childEnv, cliPath: env.cliPath, scripts, timeoutMs: opts.timeoutMs, testTimeoutMs: opts.testTimeoutMs, signal: opts.signal });
}

/** What `runTaqwrightCli` needs: a prepared run folder (config and scripts already written) and the child's environment. Shared by the Android and iOS runners. */
export interface TaqwrightCliRun {
    runDir: string;
    childEnv: NodeJS.ProcessEnv;
    /** Override the Taqwright CLI entry point (tests); unset: the installed package. */
    cliPath?: string | undefined;
    scripts: ScriptInput[];
    timeoutMs?: number | undefined;
    testTimeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
}

/** Runs `taqwright test` in a prepared folder and parses its report. A run that produced no report is an error result, never a pass. */
export async function runTaqwrightCli(o: TaqwrightCliRun): Promise<ScriptRun[]> {
    const { stderr, timedOut } = await new Promise<{ stderr: string; timedOut: boolean }>((resolve) => {
        const child = spawn(process.execPath, [o.cliPath ?? taqwrightCli(), "test", "--config", "taqwright.config.ts", "--workers=1"], {
            cwd: o.runDir,
            env: o.childEnv,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        let err = "";
        // Taqwright is chatty (every adb call); keep only the tail for diagnostics.
        const NOISE = /\[(ADB|HTTP)\]|AndroidUiautomator2Driver|\[Appium\]|\[BaseDriver/;
        const keep = (d: Buffer) => {
            const useful = String(d)
                .split(/\r?\n/)
                .filter((l) => l.trim() && !NOISE.test(l))
                .join("\n");
            if (useful) err = `${err}\n${useful}`.slice(-6000);
        };
        child.stderr.on("data", keep);
        child.stdout.on("data", keep);
        // First emulator boot + session creation can take several minutes on a modest machine.
        const limit = o.timeoutMs ?? Math.max(10 * 60_000, o.scripts.length * (o.testTimeoutMs !== undefined ? Math.max(4 * 60_000, o.testTimeoutMs + 60_000) : 4 * 60_000));
        let killed = false;
        const timer = setTimeout(() => {
            killed = true;
            killTree(child.pid);
        }, limit);
        const onAbort = () => killTree(child.pid);
        o.signal?.addEventListener("abort", onAbort, { once: true });
        child.on("close", () => {
            clearTimeout(timer);
            o.signal?.removeEventListener("abort", onAbort);
            resolve({ stderr: err, timedOut: killed });
        });
        child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ stderr: String(e), timedOut: false });
        });
    });

    const runs = await parseReport(o.runDir, o.scripts, stderr, timedOut, "Taqwright");
    // Taqwright's failure trace (one HTML file) keeps what the test typed: masked with the run's secrets, or not kept (../evidence/trace-scrub.ts).
    await scrubRunTraces(runs, traceSecretsOfChildEnv(o.childEnv));
    return runs;
}
