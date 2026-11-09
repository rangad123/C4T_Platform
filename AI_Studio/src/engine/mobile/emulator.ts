/**
 * Starts (and stops) the Android emulator for a mobile run, instead of leaving that to Appium.
 *
 * Why the platform owns this: a test run is only as trustworthy as the device it starts from. A fresh
 * emulator on a modest machine is slow enough to trigger Android's "… isn't responding" dialogs, which then
 * cover the app under test. So the platform boots the emulator headless, switches off error dialogs and
 * animations, and — once, after the first successful boot — saves a clean snapshot that every later run
 * restores in seconds without saving anything back. The emulator is stopped afterwards if this run started it.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adbPath, androidSdk, commandFor, toolCwd } from "./toolchain.js";

const SNAPSHOT = "aitp-clean";
const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

export interface EmulatorHandle {
    serial: string;
    /** True when this run started the emulator (and so stops it). */
    started: boolean;
    stop(): Promise<void>;
}

export interface EmulatorOptions {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    bootTimeoutMs?: number;
    log?: (message: string) => void;
}

function sh(file: string, args: string[], timeout = 30_000, env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve) => {
        try {
            const c = commandFor(file, args);
            const cwd = toolCwd();
            execFile(c.file, c.args, { timeout, windowsHide: true, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }, (_e, out) => resolve(String(out ?? "")));
        } catch {
            resolve("");
        }
    });
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runningEmulators(adb: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
    const out = await sh(adb, ["devices"], 30_000, env);
    return out
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/))
        .filter(([s, state]) => s?.startsWith("emulator-") && state === "device")
        .map(([s]) => s!);
}

async function avdNameOf(adb: string, serial: string, env?: NodeJS.ProcessEnv): Promise<string> {
    // `adb emu avd name` prints the name, then "OK".
    return (await sh(adb, ["-s", serial, "emu", "avd", "name"], 30_000, env)).split(/\r?\n/)[0]?.trim() ?? "";
}

function avdDir(avd: string, env: NodeJS.ProcessEnv): string {
    return path.join(env.ANDROID_AVD_HOME || path.join(os.homedir(), ".android", "avd"), `${avd}.avd`);
}

/**
 * A freshly started adb server needs a few seconds to notice emulators that are already running, and
 * starting a second emulator on the same AVD fails. So start the server and look repeatedly before deciding.
 */
async function settledEmulators(adb: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
    await sh(adb, ["start-server"], 30_000, env);
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
        for (const s of await runningEmulators(adb, env)) seen.add(s);
        await sleep(1500);
    }
    return [...seen];
}

let lock: Promise<unknown> = Promise.resolve();
/** One device, one user at a time: concurrent jobs queue instead of fighting over the emulator. */
export function withDeviceLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = lock.then(fn, fn);
    lock = next.catch(() => undefined);
    return next;
}

export async function ensureEmulator(avd: string, opts: EmulatorOptions = {}): Promise<EmulatorHandle> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? (() => undefined);
    const adb = adbPath(env);
    const sdk = androidSdk(env);
    // AITP_ADB_PATH / AITP_EMULATOR_PATH: stand-in tools of the platform's own tests (no SDK needed); unset, nothing changes.
    const standIn = Boolean(env.AITP_ADB_PATH?.trim());
    if (!adb || (!sdk && !standIn)) throw new Error("No Android toolchain found");
    const emulatorBin = env.AITP_EMULATOR_PATH?.trim() || path.join(sdk ?? "", "emulator", exe("emulator"));
    if (!fs.existsSync(emulatorBin)) throw new Error("The Android emulator program is not installed");

    // An emulator for this AVD is already running (the user's, or left by a previous run): use it as is.
    const existing = await settledEmulators(adb, env);
    for (const serial of existing) {
        if ((await avdNameOf(adb, serial, env)) === avd) {
            log(`Using the emulator that is already running (${serial})`);
            return { serial, started: false, stop: async () => undefined };
        }
    }

    const before = new Set(existing);
    const haveSnapshot = fs.existsSync(path.join(avdDir(avd, env), "snapshots", SNAPSHOT));
    const args = ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-metrics", "-netfast", "-gpu", "swiftshader_indirect", "-no-snapshot-save", ...(haveSnapshot ? ["-snapshot", SNAPSHOT] : ["-no-snapshot-load"])];
    log(haveSnapshot ? "Starting the emulator from its clean snapshot" : "Starting the emulator (first start: a full boot, which takes a few minutes)");

    const childEnv: NodeJS.ProcessEnv = sdk ? { ...env, ANDROID_SDK_ROOT: sdk, ANDROID_HOME: sdk } : { ...env };
    const launch = commandFor(emulatorBin, args);
    const cwd = toolCwd();
    // Outside the runner's folder: the emulator starts adb's server if none runs, and that server keeps the folder it was started from.
    const child: ChildProcess = spawn(launch.file, launch.args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(cwd ? { cwd } : {}) });
    // Keep the emulator's own words for the error message if it dies; it says exactly what is wrong.
    let output = "";
    const keep = (d: Buffer) => {
        output = `${output}${d}`.slice(-3000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    let exited: number | null | undefined;
    child.on("exit", (code) => (exited = code));
    child.on("error", () => (exited = -1));

    const kill = async (serial?: string) => {
        if (serial) await sh(adb, ["-s", serial, "emu", "kill"], 30_000, env);
        for (let i = 0; i < 20 && exited === undefined; i++) await sleep(1000);
        if (exited === undefined && child.pid) {
            if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
            else child.kill("SIGKILL");
        }
    };

    const deadline = Date.now() + (opts.bootTimeoutMs ?? 10 * 60_000);
    let serial: string | undefined;
    try {
        while (Date.now() < deadline) {
            if (opts.signal?.aborted) throw new Error("Job cancelled");
            if (exited !== undefined) {
                const why = output
                    .split(/\r?\n/)
                    .filter((l) => /ERROR|FATAL|PANIC|already|cannot|fail/i.test(l))
                    .slice(-3)
                    .join(" | ");
                throw new Error(`The emulator exited while starting (code ${exited})${why ? `: ${why}` : ""}`);
            }
            serial ??= (await runningEmulators(adb, env)).find((s) => !before.has(s));
            if (serial && (await sh(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], 30_000, env)).trim() === "1") break;
            await sleep(3000);
        }
        if (!serial || (await sh(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], 30_000, env)).trim() !== "1") throw new Error("The emulator did not finish starting in time");

        // A device that cannot be bothered by "isn't responding" dialogs and animations is one tests can trust.
        const put = (ns: string, key: string, value: string) => sh(adb, ["-s", serial!, "shell", "settings", "put", ns, key, value], 30_000, env);
        await put("global", "hide_error_dialogs", "1");
        for (const key of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) await put("global", key, "0");
        await put("global", "stay_on_while_plugged_in", "7");

        if (!haveSnapshot) {
            // Let the first boot finish its housekeeping, then keep this state for every later run.
            log("Saving a clean snapshot so later runs start in seconds");
            await sleep(45_000);
            await sh(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_HOME"], 30_000, env);
            await sh(adb, ["-s", serial, "emu", "avd", "snapshot", "save", SNAPSHOT], 120_000, env);
        }
        // boot_completed fires before the UI is actually drawable: a first screen read right away can fail "could not get idle state". Wait
        // until the screen can be dumped (up to ~24 s), so exploration's first read does not hit a still-settling emulator.
        for (let i = 0; i < 12; i++) {
            const dump = await sh(adb, ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"], 15_000, env).catch(() => "");
            if (/<hierarchy|<node/.test(dump)) break;
            await sleep(2000);
        }
        log(`Emulator ready (${serial})`);
        return { serial, started: true, stop: () => kill(serial) };
    } catch (e) {
        await kill(serial);
        throw e;
    }
}
