/**
 * A small, closed wrapper around `adb`: the only way the device session talks to a phone.
 *
 * Why closed: the explorer is driven by an AI model that reads text from the app under test. Nothing it says may become a command line, so this module
 * offers one method per thing the session needs (read the screen, tap, type, press a key, start or stop THE app under test) and every call passes through
 * `assertAllowed`, a second check on the final argument list. There is no method that takes a command string, no shell on this computer (`execFile` with an
 * argument array), and the text of `input text` is wrapped in single quotes so the phone's shell reads it as one literal word.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { adbPath, commandFor } from "../toolchain.js";
import { isComponent } from "../quality/startup.js";
import { allowedChangeCommand, allowedReadCommand } from "./setup-commands.js";

export type AdbErrorCode = "not-installed" | "no-device" | "offline" | "unauthorized" | "timeout" | "aborted" | "failed" | "too-large" | "refused";

/** An adb call that did not work. `message` is always plain words for a person and never holds an argument, a typed text or a secret. */
export class AdbError extends Error {
    constructor(
        readonly code: AdbErrorCode,
        message: string,
        /** Technical detail for a log (secrets removed), never shown to a person. */
        readonly detail?: string,
    ) {
        super(message);
        this.name = "AdbError";
    }
}

export const MESSAGES = {
    notInstalled: "The Android tools (adb) were not found on this computer. Run `npx @taqwright/taqwright install --with-avd`, or install the Android SDK platform-tools.",
    noDevice: "No phone or emulator is connected. Plug in a phone with USB debugging on, or start an emulator.",
    offline: "The phone is offline. Unplug it and plug it in again, or restart the emulator.",
    unauthorized: "USB debugging is off or not allowed on this phone. Unlock the phone and accept the prompt, or turn USB debugging on in Developer options.",
    timeout: "The phone did not answer in time.",
    aborted: "The session was stopped.",
    failed: "The phone could not do that.",
    tooLarge: "The phone sent more data than the explorer accepts.",
    locked: "The phone is locked. Unlock it, then try again.",
    cannotStart: "The Android tools (adb) on this computer could not be started. If the runner fetched them, delete the phone-tools folder in its work folder so it fetches them again.",
} as const;

export interface AdbDevice {
    serial: string;
    /** adb's state: "device" is ready; "offline", "unauthorized" and others are not. */
    state: string;
    model?: string;
    emulator: boolean;
}

export interface AdbOptions {
    env?: NodeJS.ProcessEnv;
    serial?: string;
    signal?: AbortSignal;
    /** Per-call time limit (default 20 s). */
    timeoutMs?: number;
    /** Exact strings that must never appear in an error detail (the password the session may type). */
    secrets?: string[];
    /** Also allow the calls that prepare a test run (allowedPrepareCommand). Set only by forPreparation(); the device session never has it. */
    prepare?: boolean;
    /** Also allow the calls that start and stop the installed UiAutomator2 server to read the screen (allowedServerCommand). Set only by forServerSource(). */
    server?: boolean;
    /** Also allow the read-only calls of "Is this phone ready?" (setup-commands.ts). Set only by forReadiness() / forPhoneSetup(). */
    ready?: boolean;
    /** Also allow the reversible setting changes a person asked for (animations, stay awake). Set only by forPhoneSetup(). */
    setup?: boolean;
}

const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SAFE_SERIAL = /^[A-Za-z0-9._:-]{1,80}$/;
const SAFE_KEYS = /^(KEYCODE_[A-Z_]{2,30}|\d{1,3})$/;
const SAFE_PROPS = new Set(["ro.product.model", "ro.product.manufacturer", "sys.boot_completed", /* screen density, for the phone accessibility checks */ "ro.sf.lcd_density", "qemu.sf.lcd_density"]);
const INT = /^-?\d{1,6}$/;
const MAX_TEXT_ARG = 1200;

/** Largest output kept from one call. A screenshot of a large phone is a few MB; a screen description under 2 MB. */
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;

/** Is this exactly one of the argument lists the session may run? (After `-s <serial>` has been taken off.) */
export function allowedCommand(a: readonly string[]): boolean {
    const [c0, c1, c2] = a;
    if (c0 === "devices") return a.length === 1 || (a.length === 2 && c1 === "-l");
    if (c0 === "install") return a.length === 3 && c1 === "-r" && /\.apk$/i.test(c2 ?? "") && !c2!.startsWith("-");
    if (c0 === "exec-out") {
        if (a.length === 3 && c1 === "screencap" && c2 === "-p") return true;
        if (a.length === 4 && c1 === "uiautomator" && c2 === "dump" && a[3] === "/dev/tty") return true;
        // R24: the same description without the views Android calls unimportant (a fallback when the plain dump fails).
        return a.length === 5 && c1 === "uiautomator" && c2 === "dump" && a[3] === "--compressed" && a[4] === "/dev/tty";
    }
    // Phone quality checks (mobile/quality): the crash and system log, read only, one fixed form.
    if (c0 === "logcat") return logcatOk(a);
    if (c0 !== "shell") return false;
    const rest = a.slice(1);
    const [s0, s1, s2] = rest;
    if (s0 === "getprop") return rest.length === 2 && SAFE_PROPS.has(s1 ?? "");
    if (s0 === "dumpsys") return rest.length === 2 && (s1 === "window" || s1 === "input_method");
    // Phone quality checks: the phone's clock, the app's launcher activity, and a measured cold start of THAT activity (see mobile/quality).
    if (s0 === "date") return rest.length === 2 && s1 === "+%s";
    if (s0 === "cmd") return rest.length === 7 && s1 === "package" && s2 === "resolve-activity" && rest[3] === "--brief" && rest[4] === "-c" && rest[5] === "android.intent.category.LAUNCHER" && SAFE_PACKAGE.test(rest[6] ?? "");
    if (s0 === "am" && s1 === "start") return rest.length === 6 && rest[2] === "-S" && rest[3] === "-W" && rest[4] === "-n" && isComponent(rest[5] ?? "");
    if (s0 === "pm") return rest.length === 3 && s1 === "list" && s2 === "packages"; // the list is filtered here, never by an argument
    if (s0 === "am" && s1 === "broadcast") return adbKeyboardOk(rest);
    if (s0 === "am") return rest.length === 3 && s1 === "force-stop" && SAFE_PACKAGE.test(s2 ?? "");
    // Dismiss an emulator's default swipe keyguard. On a secured lock this only shows the PIN prompt — it cannot bypass it — so it is safe.
    if (s0 === "wm") return rest.length === 2 && s1 === "dismiss-keyguard";
    if (s0 === "monkey") return monkeyOk(rest);
    if (s0 === "input") {
        if (s1 === "tap") return rest.length === 4 && INT.test(rest[2]!) && INT.test(rest[3]!);
        if (s1 === "swipe") return rest.length === 7 && rest.slice(2).every((x) => INT.test(x));
        if (s1 === "keyevent") return rest.length >= 3 && rest.length <= 120 && rest.slice(2).every((k) => SAFE_KEYS.test(k));
        if (s1 === "text") return rest.length === 3 && typeof s2 === "string" && s2.length <= MAX_TEXT_ARG && /^'(?:[^']|'\\'')*'$/.test(s2) && /^[\x20-\x7e]*$/.test(s2);
    }
    return false;
}
/** Text for the ADBKeyboard keyboard travels base64-encoded: only letters, digits, + / and =, nothing a shell reads (see mobile/state/unicode.ts). */
const BASE64_ARG = /^[A-Za-z0-9+/]{4,6000}={0,2}$/;
function adbKeyboardOk(rest: readonly string[]): boolean {
    // am broadcast -a ADB_INPUT_B64 --es msg <base64>
    return rest.length === 7 && rest[2] === "-a" && rest[3] === "ADB_INPUT_B64" && rest[4] === "--es" && rest[5] === "msg" && BASE64_ARG.test(rest[6] ?? "") && (rest[6] ?? "").length % 4 === 0;
}

const SAFE_PERMISSION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.permission\.[A-Z][A-Z0-9_]{1,80}$/;

/**
 * The calls that PREPARE a test run, never available to the explorer: clear the data of the configured package, grant one runtime permission to it, and
 * read its package description (to list the permissions it asks for). Only an `Adb` made with `forPreparation()` may run them (see mobile/state/).
 */
export function allowedPrepareCommand(a: readonly string[]): boolean {
    if (a[0] !== "shell") return false;
    const rest = a.slice(1);
    const [s0, s1, s2] = rest;
    if (s0 === "pm" && s1 === "clear") return rest.length === 3 && SAFE_PACKAGE.test(s2 ?? "");
    if (s0 === "pm" && s1 === "grant") return rest.length === 4 && SAFE_PACKAGE.test(s2 ?? "") && SAFE_PERMISSION.test(rest[3] ?? "");
    if (s0 === "dumpsys" && s1 === "package") return rest.length === 3 && SAFE_PACKAGE.test(s2 ?? "");
    return false;
}

/** The UiAutomator2 server Appium installs on a phone (its two packages) and how it is started (R24, device/uia2-source.ts). */
export const UIA2_SERVER_PACKAGE = "io.appium.uiautomator2.server";
export const UIA2_TEST_PACKAGE = "io.appium.uiautomator2.server.test";
export const UIA2_INSTRUMENTATION = `${UIA2_TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner`;
export const UIA2_DEVICE_PORT = 6790;
const UIA2_START = ["shell", "am", "instrument", "-w", "-e", "disableAnalytics", "true", UIA2_INSTRUMENTATION] as const;

/**
 * The calls that read the screen through the UiAutomator2 server already installed on the phone (R24), never available to the explorer's
 * own adb: forward one local port to the server's port on the phone (and remove that forward), and start the server's instrumentation in its
 * one fixed form. Only an `Adb` made with `forServerSource()` may run them. Nothing is installed.
 */
export function allowedServerCommand(a: readonly string[]): boolean {
    const port = (v: string | undefined) => /^tcp:\d{4,5}$/.test(v ?? "") && Number(v!.slice(4)) >= 1024 && Number(v!.slice(4)) <= 65535;
    if (a[0] === "forward") return a.length === 3 && ((port(a[1]) && a[2] === `tcp:${UIA2_DEVICE_PORT}`) || (a[1] === "--remove" && port(a[2])));
    return a.length === UIA2_START.length && UIA2_START.every((x, i) => a[i] === x);
}

/** `logcat -d -b crash -b system -v epoch -t <count | time>`: dump (never follow) the crash and system log since a mark. Nothing else of logcat. */
function logcatOk(a: readonly string[]): boolean {
    const fixed = ["logcat", "-d", "-b", "crash", "-b", "system", "-v", "epoch", "-t"];
    return a.length === 10 && fixed.every((x, i) => a[i] === x) && /^(\d{1,3}|\d{1,12}\.\d{3})$/.test(a[9] ?? "");
}

function monkeyOk(rest: readonly string[]): boolean {
    // monkey -p <package> -c android.intent.category.LAUNCHER 1
    return rest.length === 6 && rest[1] === "-p" && SAFE_PACKAGE.test(rest[2] ?? "") && rest[3] === "-c" && rest[4] === "android.intent.category.LAUNCHER" && rest[5] === "1";
}

/** `'text'` for the phone's shell, with a quote inside written as '\'' and a space written as %s (what `input text` turns back into a space). */
export function shellQuoteForInput(text: string): string {
    return `'${text.replace(/ /g, "%s").replace(/'/g, "'\\''")}'`;
}

function scrub(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const s of secrets) if (s.length >= 1) out = out.split(s).join("***");
    return out;
}

export class Adb {
    private constructor(
        readonly file: string,
        private readonly o: AdbOptions,
    ) {}

    /** The adb of this computer's toolchain (or the stand-in named by AITP_ADB_PATH), or undefined when there is none. */
    static locate(opts: AdbOptions = {}): Adb | undefined {
        const file = adbPath(opts.env ?? process.env);
        return file ? new Adb(file, opts) : undefined;
    }

    /** The same adb talking to one device. */
    forSerial(serial: string): Adb {
        if (!SAFE_SERIAL.test(serial)) throw new AdbError("refused", "That device name is not usable.");
        return new Adb(this.file, { ...this.o, serial });
    }

    get serial(): string | undefined {
        return this.o.serial;
    }

    withSecrets(secrets: string[]): Adb {
        return new Adb(this.file, { ...this.o, secrets: [...(this.o.secrets ?? []), ...secrets] });
    }

    withSignal(signal: AbortSignal | undefined): Adb {
        return new Adb(this.file, { ...this.o, ...(signal ? { signal } : {}) });
    }

    private run(args: string[], opt: { timeoutMs?: number } = {}): Promise<Buffer> {
        if (!allowedCommand(args) && !(this.o.prepare && allowedPrepareCommand(args)) && !(this.o.ready && allowedReadCommand(args)) && !(this.o.setup && allowedChangeCommand(args)) && !(this.o.server && allowedServerCommand(args))) return Promise.reject(new AdbError("refused", "That is not something the explorer may ask the phone."));
        if (this.o.signal?.aborted) return Promise.reject(new AdbError("aborted", MESSAGES.aborted));
        const full = this.o.serial ? ["-s", this.o.serial, ...args] : args;
        const call = commandFor(this.file, full);
        const secrets = this.o.secrets ?? [];
        return new Promise((resolve, reject) => {
            try {
                execFile(
                    call.file,
                    call.args,
                    { timeout: opt.timeoutMs ?? this.o.timeoutMs ?? 20_000, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "buffer", env: this.o.env ?? process.env, ...(this.o.signal ? { signal: this.o.signal } : {}) },
                    (error, stdout, stderr) => {
                        if (!error) return resolve(stdout);
                        const text = scrub(`${stderr?.toString("utf8") ?? ""}\n${stdout?.toString("utf8").slice(0, 600) ?? ""}`, secrets);
                        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number; name?: string };
                        if (this.o.signal?.aborted || e.name === "AbortError") return reject(new AdbError("aborted", MESSAGES.aborted));
                        if (e.code === "ENOENT") return reject(new AdbError("not-installed", MESSAGES.notInstalled));
                        // A file that is there but cannot be started (damaged, the download for another system, no run permission).
                        if (typeof e.code === "string" && ["EACCES", "ENOEXEC", "EFTYPE", "UNKNOWN", "EPERM", "EBADEXEC", "EBADARCH"].includes(e.code)) return reject(new AdbError("not-installed", MESSAGES.cannotStart));
                        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new AdbError("too-large", MESSAGES.tooLarge));
                        if (e.killed || e.code === "ETIMEDOUT") return reject(new AdbError("timeout", MESSAGES.timeout));
                        const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
                        if (/unauthorized|insufficient permissions|no permissions/i.test(text)) return reject(new AdbError("unauthorized", MESSAGES.unauthorized, detail));
                        if (/device offline|offline/i.test(text)) return reject(new AdbError("offline", MESSAGES.offline, detail));
                        if (/no devices\/emulators found|device '.*' not found|no devices found|device not found|more than one device/i.test(text)) return reject(new AdbError("no-device", MESSAGES.noDevice, detail));
                        reject(new AdbError("failed", MESSAGES.failed, detail));
                    },
                );
            } catch (e) {
                // Windows refuses a file that is not a program before anything starts (spawn UNKNOWN): that adb is there but cannot run.
                const code = (e as NodeJS.ErrnoException | undefined)?.code;
                reject(new AdbError("not-installed", code && code !== "ENOENT" ? MESSAGES.cannotStart : MESSAGES.notInstalled));
            }
        });
    }

    private async text(args: string[], opt?: { timeoutMs?: number }): Promise<string> {
        return (await this.run(args, opt)).toString("utf8");
    }

    // ── looking ──────────────────────────────────────────────────────────────

    async devices(): Promise<AdbDevice[]> {
        const out = await this.text(["devices", "-l"], { timeoutMs: 8000 });
        const list: AdbDevice[] = [];
        for (const raw of out.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
            const m = /^(\S+)\s+(device|offline|unauthorized|authorizing|connecting|recovery|sideload|bootloader|rescue|host|no permissions)\b(.*)$/.exec(line);
            if (!m || !SAFE_SERIAL.test(m[1]!)) continue;
            const model = /\bmodel:(\S+)/.exec(m[3]!)?.[1]?.replace(/_/g, " ");
            list.push({ serial: m[1]!, state: m[2]!, ...(model ? { model: model.slice(0, 60) } : {}), emulator: m[1]!.startsWith("emulator-") });
        }
        return list.slice(0, 40);
    }

    async prop(name: "ro.product.model" | "ro.product.manufacturer" | "sys.boot_completed"): Promise<string> {
        return (await this.text(["shell", "getprop", name], { timeoutMs: 8000 })).trim();
    }

    windowDump(): Promise<string> {
        return this.text(["shell", "dumpsys", "window"], { timeoutMs: 10_000 });
    }

    inputMethodDump(): Promise<string> {
        return this.text(["shell", "dumpsys", "input_method"], { timeoutMs: 10_000 });
    }

    /** The screen description (UI Automator XML). */
    uiDump(compressed = false): Promise<string> {
        return this.text(compressed ? ["exec-out", "uiautomator", "dump", "--compressed", "/dev/tty"] : ["exec-out", "uiautomator", "dump", "/dev/tty"], { timeoutMs: 15_000 });
    }

    screencap(): Promise<Buffer> {
        return this.run(["exec-out", "screencap", "-p"], { timeoutMs: 15_000 });
    }

    /** Is this package on the phone? (The list is read and searched here; no package name is sent as an argument.) */
    async hasPackage(pkg: string): Promise<boolean> {
        if (!SAFE_PACKAGE.test(pkg)) return false;
        const out = await this.text(["shell", "pm", "list", "packages"], { timeoutMs: 15_000 });
        return out.split(/\r?\n/).some((l) => l.trim() === `package:${pkg}`);
    }

    // ── phone quality checks (see mobile/quality) ─────────────────────────────

    /** The crash and system log since `since` (a count of newest entries such as "1", or a time "1697040000.123"), as `-v epoch` text. */
    logcat(since: string): Promise<string> {
        return this.text(["logcat", "-d", "-b", "crash", "-b", "system", "-v", "epoch", "-t", since], { timeoutMs: 15_000 });
    }

    /** The phone's clock, in seconds since 1970. */
    async deviceSeconds(): Promise<number | undefined> {
        const n = Number((await this.text(["shell", "date", "+%s"], { timeoutMs: 8000 })).trim());
        return Number.isFinite(n) && n > 0 ? n : undefined;
    }

    /** The screen density in dpi (160 = one pixel per dp), or undefined when the phone does not say. */
    async densityDpi(): Promise<number | undefined> {
        for (const name of ["ro.sf.lcd_density", "qemu.sf.lcd_density"]) {
            const v = Number((await this.text(["shell", "getprop", name], { timeoutMs: 8000 }).catch(() => "")).trim());
            if (Number.isFinite(v) && v >= 80 && v <= 1000) return v;
        }
        return undefined;
    }

    /** `cmd package resolve-activity --brief -c LAUNCHER <package>`: the text naming the app's launcher activity. */
    resolveLauncher(pkg: string): Promise<string> {
        return this.text(["shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", pkg], { timeoutMs: 15_000 });
    }

    /** `am start -S -W -n <component>`: stops the app, starts that activity and waits until it has drawn; the text has TotalTime. */
    startAndWait(component: string): Promise<string> {
        return this.text(["shell", "am", "start", "-S", "-W", "-n", component], { timeoutMs: 90_000 });
    }

    // ── doing ────────────────────────────────────────────────────────────────

    async tap(x: number, y: number): Promise<void> {
        await this.run(["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
    }

    async swipe(x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void> {
        await this.run(["shell", "input", "swipe", ...[x1, y1, x2, y2, ms].map((n) => String(Math.round(n)))]);
    }

    async keys(...keys: string[]): Promise<void> {
        await this.run(["shell", "input", "keyevent", ...keys]);
    }

    /** Dismiss an insecure (swipe/none) keyguard, used for a freshly booted emulator. A secured lock is not bypassed (the PIN prompt shows). */
    async dismissKeyguard(): Promise<void> {
        await this.run(["shell", "wm", "dismiss-keyguard"]);
    }

    /** Types text the caller has already checked (printable ASCII, no `%s`). It travels as ONE single-quoted word. */
    async typeText(text: string): Promise<void> {
        await this.run(["shell", "input", "text", shellQuoteForInput(text)]);
    }

    /** Starts the launcher activity of this package (it is the only package the session ever starts). */
    async launch(pkg: string): Promise<void> {
        await this.run(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], { timeoutMs: 30_000 });
    }

    async forceStop(pkg: string): Promise<void> {
        await this.run(["shell", "am", "force-stop", pkg]);
    }

    async install(apkFile: string): Promise<void> {
        const out = await this.text(["install", "-r", apkFile], { timeoutMs: 180_000 });
        if (!/Success/i.test(out)) throw new AdbError("failed", "The app file could not be installed on the phone.", out.slice(0, 200));
    }

    /** Types text through the ADBKeyboard keyboard (any characters): the caller has checked that it is the phone's current keyboard. */
    async typeWithAdbKeyboard(base64: string): Promise<void> {
        await this.run(["shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", base64]);
    }

    // ── preparing a test run (only on an Adb made with forPreparation) ─────────

    /** The same adb, also allowed to clear the data of, and grant permissions to, the configured package before a test. Never handed to the explorer. */
    /** The same adb, also allowed to start and stop the installed UiAutomator2 server to read the screen (device/uia2-source.ts). Never handed to the explorer. */
    forServerSource(): Adb {
        return new Adb(this.file, { ...this.o, server: true });
    }

    /** `forward tcp:<port> tcp:6790`, or `forward --remove tcp:<port>`. */
    async forwardServer(port: number, remove = false): Promise<void> {
        await this.run(remove ? ["forward", "--remove", `tcp:${port}`] : ["forward", `tcp:${port}`, `tcp:${UIA2_DEVICE_PORT}`], { timeoutMs: 10_000 });
    }

    /**
     * Starts the UiAutomator2 server's instrumentation (`am instrument -w`, which runs until it is stopped). The caller owns the process and
     * kills exactly it. Undefined when this adb may not (not made with forServerSource) or cannot start it.
     */
    spawnServer(): ChildProcess | undefined {
        if (!this.o.server || !allowedServerCommand(UIA2_START) || this.o.signal?.aborted) return undefined;
        const call = commandFor(this.file, this.o.serial ? ["-s", this.o.serial, ...UIA2_START] : [...UIA2_START]);
        try {
            return spawn(call.file, call.args, { windowsHide: true, stdio: "ignore", env: this.o.env ?? process.env });
        } catch {
            return undefined;
        }
    }

    forPreparation(): Adb {
        return new Adb(this.file, { ...this.o, prepare: true });
    }

    /** `pm clear <package>`: the app's data and caches are removed, as after a fresh install. */
    async clearAppData(pkg: string): Promise<void> {
        const out = await this.text(["shell", "pm", "clear", pkg], { timeoutMs: 30_000 });
        if (!/Success/i.test(out)) throw new AdbError("failed", "The app's data could not be cleared on the phone.", out.slice(0, 200));
    }

    /** `pm grant <package> <permission>`. */
    async grantPermission(pkg: string, permission: string): Promise<void> {
        await this.run(["shell", "pm", "grant", pkg, permission], { timeoutMs: 15_000 });
    }

    // ── is this phone ready? (mobile/device/ready.ts) ─────────────────────────

    /** The same adb, also allowed the read-only calls of the ready check (setup-commands.ts READ list). Never handed to the explorer. */
    forReadiness(): Adb {
        return new Adb(this.file, { ...this.o, ready: true });
    }

    /** The same adb, also allowed the reversible changes a person asked for (setup-commands.ts CHANGE list). Never handed to the explorer. */
    forPhoneSetup(): Adb {
        return new Adb(this.file, { ...this.o, ready: true, setup: true });
    }

    /** One call of those lists (anything else is refused by run()). The text of the answer. */
    setupCall(args: string[], timeoutMs = 10_000): Promise<string> {
        return this.text(args, { timeoutMs });
    }

    /** `dumpsys package <package>`: what the app asks for (read by mobile/state/permissions.ts). */
    packageDump(pkg: string): Promise<string> {
        return this.text(["shell", "dumpsys", "package", pkg], { timeoutMs: 15_000 });
    }
}
