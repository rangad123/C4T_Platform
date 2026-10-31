/**
 * Runs rendered Taqwright scripts on an iOS simulator through Appium (XCUITest) and returns the same neutral results as the Android
 * runner (the Taqwright process and its report are handled by `runTaqwrightCli` in validation/mobile-runner.ts, shared).
 *
 * This can only work on a Mac with Xcode. It is never used by the platform server: an iOS task runs on a runner agent that reports
 * macOS, Xcode, a simulator and the XCUITest driver. The rules that matter:
 *
 *  - Xcode's tools are started only through `execFile` with argument arrays (`xcrun simctl ...`), never through a shell, and only here.
 *  - The simulator is chosen by pure functions (ios-simulators.ts). A simulator that is already running is used as it is and left
 *    running. A simulator this run boots is shut down afterwards by the id recorded at boot, never by name, never "all".
 *  - A problem with the machine (no Xcode, no simulator, boot failed, no Appium) is an error result with a plain sentence: never a
 *    failing test.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CHILD_ENV_ALLOW, type ScriptInput, type ScriptRun } from "../validation/runner.js";
import { failAll, freePort, MOBILE_ENV_ALLOW, runTaqwrightCli } from "../validation/mobile-runner.js";
import { IOS_CONFIG, IOS_ENV_ALLOW, iosChildEnv } from "./ios-config.js";
import { chooseSimulator, parseSimctlDevices, type Simulator } from "./ios-simulators.js";
import type { MobileTarget } from "./target.js";

export const DEFAULT_IOS_TEST_TIMEOUT_MS = 180_000;

/** Runs `xcrun <args>`; never throws. */
export type Xcrun = (args: string[], timeoutMs?: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export interface IosRunEnv {
    /** The app: `iosBundleId` (an app already installed on the simulator) and, when the project names one, `simulator`. */
    target: Pick<MobileTarget, "iosBundleId" | "simulator">;
    /** The simulator the project's framework settings prefer when the app does not name one. */
    defaultSimulator?: string;
    /** Leave a simulator this run booted running afterwards. Default: shut it down. */
    keepSimulator?: boolean;
    /** Boot and shut down simulators here (default). Tests that substitute the Taqwright CLI turn this off. */
    manageSimulator?: boolean;
    /** Override the Taqwright CLI entry point (tests use a stand-in; production resolves the installed package). */
    cliPath?: string;
    /** Environment the child may inherit from; defaults to process.env. */
    sourceEnv?: NodeJS.ProcessEnv;
    /** Replace `xcrun` (tests). */
    xcrun?: Xcrun;
    /** Replace the operating system check (tests). */
    platform?: NodeJS.Platform;
    /** Progress messages (a first simulator boot can take minutes). */
    log?: (message: string) => void;
}

export interface IosRunOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Per-test time limit in ms (project setting); unset = 180 s. */
    testTimeoutMs?: number;
    /** How long to wait for a simulator to finish booting (default 5 minutes). */
    bootTimeoutMs?: number;
}

/** Test seam: a node script that stands in for `xcrun` (it receives the arguments after `xcrun`). */
export const XCRUN_SEAM = "IOS_XCRUN_CLI";

export const PLATFORM_PROBLEM = "iOS tests can only run on a Mac with Xcode.";

/**
 * The environment `xcrun` is started with: the same short list of variables the test process gets (path, home, temp, proxy, the Xcode folder), never the
 * agent's token or any other variable of the machine. Xcode's tools have no use for them.
 */
export function xcrunEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(source).filter(([k]) => CHILD_ENV_ALLOW.has(k.toUpperCase()) || IOS_ENV_ALLOW.has(k.toUpperCase())));
}

/** The default `xcrun`: real Xcode on a Mac, or the stand-in script named by IOS_XCRUN_CLI. Arguments are an array: no shell. */
export function defaultXcrun(source: NodeJS.ProcessEnv = process.env): Xcrun {
    const seam = source[XCRUN_SEAM]?.trim();
    const env = xcrunEnv(source);
    return (args, timeoutMs = 30_000) =>
        new Promise((resolve) => {
            const [file, argv] = seam ? [process.execPath, [seam, ...args]] : ["xcrun", args];
            try {
                execFile(file, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env }, (e, stdout, stderr) => resolve({ ok: !e, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
            } catch (e) {
                resolve({ ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
            }
        });
}

let lock: Promise<unknown> = Promise.resolve();
/** One simulator at a time: concurrent tasks queue instead of fighting over it. */
export function withSimulatorLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = lock.then(fn, fn);
    lock = next.catch(() => undefined);
    return next;
}

export interface SimulatorHandle {
    simulator: Simulator;
    /** True when this run booted it (and so shuts it down). */
    started: boolean;
    stop(): Promise<void>;
}

/** The first line of a tool's complaint, short enough to show a person. */
const why = (r: { stderr: string; stdout: string }): string => (r.stderr || r.stdout).replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Find the simulator to use and make sure it is running. Throws an Error with a plain sentence when that is not possible.
 * Boots only a simulator that is shut down; shuts down (in `stop`) only one it booted, by the udid it recorded.
 */
export async function ensureSimulator(wanted: string | undefined, xcrun: Xcrun, opts: { signal?: AbortSignal; bootTimeoutMs?: number; log?: (m: string) => void } = {}): Promise<SimulatorHandle> {
    const log = opts.log ?? (() => undefined);
    const listed = await xcrun(["simctl", "list", "devices", "-j"], 30_000);
    if (!listed.ok) throw new Error(`Xcode's simulator tool did not answer (${why(listed) || "xcrun simctl failed"}). Check that Xcode is installed and its license accepted.`);
    let json: unknown;
    try {
        json = JSON.parse(listed.stdout);
    } catch {
        throw new Error("Xcode's simulator tool gave an answer the agent could not read.");
    }
    const choice = chooseSimulator(parseSimctlDevices(json), wanted);
    if (!choice.ok) throw new Error(choice.message);
    const sim = choice.simulator;

    if (sim.state === "Booted") {
        log(`Using the simulator that is already running (${sim.name}, iOS ${sim.version})`);
        return { simulator: sim, started: false, stop: async () => undefined };
    }

    // From here the udid is the only handle on this simulator: it is what boot, wait and shutdown all use.
    let booted = false;
    if (sim.state === "Booting") log(`Waiting for the simulator that is starting (${sim.name}, iOS ${sim.version})`);
    else {
        log(`Starting the simulator ${sim.name} (iOS ${sim.version})`);
        const b = await xcrun(["simctl", "boot", sim.udid], 60_000);
        if (!b.ok) throw new Error(`The simulator ${sim.name} could not be started (${why(b) || "simctl boot failed"}).`);
        booted = true;
    }
    const shutdown = async () => void (await xcrun(["simctl", "shutdown", sim.udid], 60_000));
    try {
        if (opts.signal?.aborted) throw new Error("Job cancelled");
        const deadline = opts.bootTimeoutMs ?? 5 * 60_000;
        const ready = await xcrun(["simctl", "bootstatus", sim.udid], deadline);
        if (!ready.ok) throw new Error(`The simulator ${sim.name} did not finish starting (${why(ready) || "it took too long"}).`);
        if (opts.signal?.aborted) throw new Error("Job cancelled");
        log(`Simulator ready (${sim.name})`);
        return { simulator: sim, started: booted, stop: booted ? shutdown : async () => undefined };
    } catch (e) {
        if (booted) await shutdown();
        throw e;
    }
}

/** Taqwright/Appium errors that mean the iOS session never started (driver missing, WebDriverAgent could not be built, no such device). */
const SESSION_PROBLEM = /could not create (?:a |the )?(?:new )?session|session not created|SessionNotCreated|WebDriverAgent|xcuitest driver|unable to (?:find|locate) (?:a )?(?:device|simulator)|(?:appium|driver).{0,60}(?:not found|not installed|ENOENT)|failed to (?:start|launch) appium/i;

/**
 * A test that failed before any step ran, with an error that is about the iOS session itself, is a problem with the Mac and not a
 * verdict on the app: it becomes an error result (like a missing simulator). A failure inside a step is always a verdict.
 */
export function classifyIosInfrastructure(run: ScriptRun): ScriptRun {
    if ((run.status !== "failed" && run.status !== "timedOut") || run.failedStepIndex >= 0) return run;
    const text = run.error ?? "";
    if (!SESSION_PROBLEM.test(text)) return run;
    return { ...run, status: "error", error: `The iOS session could not be started: ${text.replace(/\s+/g, " ").trim().slice(0, 300)}`, steps: [], failedStepIndex: -1 };
}

export async function runIosScripts(scratchDir: string, scripts: ScriptInput[], env: IosRunEnv, opts: IosRunOptions = {}): Promise<ScriptRun[]> {
    if (scripts.length === 0) return [];
    if (opts.signal?.aborted) throw new Error("Job cancelled");
    const source = env.sourceEnv ?? process.env;
    const managed = env.manageSimulator !== false;
    if (managed) {
        const platform = env.platform ?? process.platform;
        if (platform !== "darwin" && !source[XCRUN_SEAM]?.trim()) return failAll(scripts, PLATFORM_PROBLEM);
    }
    const wanted = env.target.simulator ?? env.defaultSimulator;
    return withSimulatorLock(async () => {
        let handle: SimulatorHandle | undefined;
        if (managed) {
            try {
                handle = await ensureSimulator(wanted, env.xcrun ?? defaultXcrun(source), { signal: opts.signal, ...(opts.bootTimeoutMs !== undefined ? { bootTimeoutMs: opts.bootTimeoutMs } : {}), log: env.log });
            } catch (e) {
                if (opts.signal?.aborted) throw e;
                return failAll(scripts, e instanceof Error ? e.message : String(e));
            }
        }
        try {
            return (await execute(scratchDir, scripts, env, opts, source, handle?.simulator, wanted)).map(classifyIosInfrastructure);
        } finally {
            if (handle?.started && !env.keepSimulator) await handle.stop();
        }
    });
}

async function execute(scratchDir: string, scripts: ScriptInput[], env: IosRunEnv, opts: IosRunOptions, source: NodeJS.ProcessEnv, sim: Simulator | undefined, wanted: string | undefined): Promise<ScriptRun[]> {
    const runDir = path.join(scratchDir, `run-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "taqwright.config.ts"), IOS_CONFIG);
    for (const s of scripts) await fs.writeFile(path.join(runDir, s.filename), s.content);

    // Like the other runners, the child gets only what it needs: never the platform's or the agent's secrets.
    const passthrough = Object.fromEntries(Object.entries(source).filter(([k]) => CHILD_ENV_ALLOW.has(k.toUpperCase()) || MOBILE_ENV_ALLOW.has(k.toUpperCase()) || IOS_ENV_ALLOW.has(k.toUpperCase())));
    const childEnv: NodeJS.ProcessEnv = {
        ...passthrough,
        ...iosChildEnv({
            simulatorName: sim?.name ?? wanted ?? "",
            ...(sim ? { udid: sim.udid, version: sim.version } : {}),
            ...(env.target.iosBundleId ? { bundleId: env.target.iosBundleId } : {}),
            port: await freePort(),
            testTimeoutMs: opts.testTimeoutMs !== undefined ? opts.testTimeoutMs : Math.min(opts.timeoutMs ?? DEFAULT_IOS_TEST_TIMEOUT_MS, DEFAULT_IOS_TEST_TIMEOUT_MS),
        }),
    };
    return runTaqwrightCli({ runDir, childEnv, cliPath: env.cliPath, scripts, timeoutMs: opts.timeoutMs, testTimeoutMs: opts.testTimeoutMs, signal: opts.signal });
}
