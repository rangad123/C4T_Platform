/**
 * What this computer can run: operating system, Playwright browsers, Android devices and emulators, iOS simulators,
 * Windows UI Automation (desktop apps). Reported to the platform with `hello` and refreshed on every poll, so a phone plugged in later is noticed.
 *
 * Nothing here starts a long process: browsers are found by looking at the folder Playwright installs them in, Android by one
 * short `adb devices -l`, iOS by one `simctl list`. The probe caches its answer for 30 seconds.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Capabilities } from "../agent-protocol/schema.js";
import { adbPath, commandFor, listAvds, taqwrightHome, toolCwd } from "../engine/mobile/toolchain.js";
import { deviceSessionProblem } from "../engine/mobile/device/capability.js";
import { resolvedAllowList } from "../engine/desktop/policy.js";
import { probeDesktop, type DesktopProbeResult } from "../engine/desktop/probe.js";
import { describeBrowser } from "../engine/browsers/choice.js";
import type { BrowserReport } from "./browser-setup.js";
import type { PhoneToolsReport } from "./phone-tools.js";

export const CAPABILITY_CACHE_MS = 30_000;

type Android = NonNullable<Capabilities["android"]>;
type AndroidDevice = Android["devices"][number];

// ── adb ─────────────────────────────────────────────────────────────────────

const ADB_STATES = ["device", "offline", "unauthorized", "authorizing", "connecting", "recovery", "sideload", "bootloader", "rescue", "host", "no permissions"];

/** Parse the output of `adb devices -l`. Lines that are not devices (headers, daemon messages) are skipped. */
export function parseAdbDevices(text: string): AndroidDevice[] {
    const out: AndroidDevice[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
        const m = /^(\S+)\s+(.+)$/.exec(line);
        if (!m) continue;
        const serial = m[1]!;
        const rest = m[2]!;
        const state = ADB_STATES.find((s) => rest === s || rest.startsWith(`${s} `) || rest.startsWith(`${s}\t`));
        if (!state) continue;
        const model = /\bmodel:(\S+)/.exec(rest)?.[1]?.replace(/_/g, " ");
        out.push({ serial: serial.slice(0, 80), ...(model ? { model: model.slice(0, 80) } : {}), state, emulator: serial.startsWith("emulator-") });
    }
    return out.slice(0, 40);
}

// ── iOS ─────────────────────────────────────────────────────────────────────

/** Names of available simulators from `xcrun simctl list devices -j`, booted ones first, as "iPhone 15 (Booted)". */
export function parseSimctl(json: unknown): string[] {
    const devices = (json as { devices?: Record<string, unknown> } | null)?.devices;
    if (!devices || typeof devices !== "object") return [];
    const booted: string[] = [];
    const others: string[] = [];
    for (const list of Object.values(devices)) {
        if (!Array.isArray(list)) continue;
        for (const d of list as Array<{ name?: unknown; state?: unknown; isAvailable?: unknown }>) {
            if (typeof d?.name !== "string" || d.isAvailable === false) continue;
            const label = `${d.name}${typeof d.state === "string" ? ` (${d.state})` : ""}`.slice(0, 80);
            (d.state === "Booted" ? booted : others).push(label);
        }
    }
    return [...new Set([...booted, ...others])].slice(0, 40);
}

/** How many of the simulators simctl lists run iOS (the others are tvOS, watchOS, visionOS). */
export function countIosSimulators(json: unknown): number {
    const devices = (json as { devices?: Record<string, unknown> } | null)?.devices;
    if (!devices || typeof devices !== "object") return 0;
    let n = 0;
    for (const [runtime, list] of Object.entries(devices)) {
        if (!/SimRuntime.iOS-/.test(runtime) || !Array.isArray(list)) continue;
        n += (list as Array<{ isAvailable?: unknown }>).filter((d) => d?.isAvailable !== false).length;
    }
    return n;
}

/**
 * Is the Appium XCUITest driver installed? Taqwright's own install keeps it under its Appium home; a driver the person installed
 * themselves shows in `appium driver list --installed`. Looking at a folder or asking appium once; nothing is started.
 */
export async function detectXcuitest(env: NodeJS.ProcessEnv, exec: ExecFn): Promise<boolean> {
    const homes = [env.APPIUM_HOME?.trim(), path.join(taqwrightHome(env), "appium-home")].filter((h): h is string => Boolean(h));
    if (homes.some((h) => fs.existsSync(path.join(h, "node_modules", "appium-xcuitest-driver")))) return true;
    const out = await exec("appium", ["driver", "list", "--installed", "--json"], 20_000);
    return out !== undefined && /xcuitest/i.test(out);
}

// ── Playwright browsers ─────────────────────────────────────────────────────

const require = createRequire(import.meta.url);

/** Where Playwright keeps its browsers (the same rules Playwright itself uses). */
export function playwrightBrowsersDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
    const set = env.PLAYWRIGHT_BROWSERS_PATH;
    if (set === "0") {
        try {
            return path.join(path.dirname(require.resolve("playwright-core/package.json")), ".local-browsers");
        } catch {
            return "";
        }
    }
    if (set) return path.resolve(set);
    if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright");
    if (platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
    return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright");
}

interface BrowserRevisions {
    chromium: string[];
    firefox: string[];
    webkit: string[];
}

/** The browser revisions the installed Playwright expects (so an old leftover browser is not counted). Undefined if unreadable. */
export function expectedRevisions(): BrowserRevisions | undefined {
    try {
        const file = path.join(path.dirname(require.resolve("playwright-core/package.json")), "browsers.json");
        const list = (JSON.parse(fs.readFileSync(file, "utf8")) as { browsers: Array<{ name: string; revision: string; revisionOverrides?: Record<string, string> }> }).browsers;
        const revs = (...names: string[]) => list.filter((b) => names.includes(b.name)).flatMap((b) => [b.revision, ...Object.values(b.revisionOverrides ?? {})]);
        return { chromium: revs("chromium", "chromium-headless-shell"), firefox: revs("firefox"), webkit: revs("webkit") };
    } catch {
        return undefined;
    }
}

/** Installed engines, judged by the folders Playwright creates (`chromium-1243` with an INSTALLATION_COMPLETE marker). */
export function detectBrowsers(dir: string, expected: BrowserRevisions | undefined = expectedRevisions()): Capabilities["browsers"] {
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const complete = (folder: string) => fs.existsSync(path.join(dir, folder, "INSTALLATION_COMPLETE"));
    const has = (prefixes: string[], revisions: string[] | undefined) =>
        entries.some((f) => {
            const m = /^(.+)-(\d+)$/.exec(f);
            if (!m || !prefixes.includes(m[1]!)) return false;
            if (revisions && revisions.length > 0 && !revisions.includes(m[2]!)) return false;
            return complete(f);
        });
    const found: Capabilities["browsers"] = [];
    if (has(["chromium", "chromium_headless_shell"], expected?.chromium)) found.push("chromium");
    if (has(["firefox"], expected?.firefox)) found.push("firefox");
    if (has(["webkit"], expected?.webkit)) found.push("webkit");
    return found;
}

// ── recording ───────────────────────────────────────────────────────────────

/** Can a person watch a window here? Windows: an interactive session (not a service); macOS: yes; Linux: a display server is running. */
export function hasDisplay(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, interactive?: boolean): boolean {
    if (platform === "win32") return interactive !== false;
    if (platform === "darwin") return true;
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// ── the probe ───────────────────────────────────────────────────────────────

export type ExecFn = (file: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<string | undefined>;

/** Run a short command; undefined when it is missing, fails or times out. Started outside the runner's folder (toolCwd: adb leaves a server behind). */
export const execText: ExecFn = (file, args, timeoutMs, env) =>
    new Promise((resolve) => {
        try {
            const cwd = toolCwd();
            execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }, (error, stdout) => resolve(error ? undefined : String(stdout)));
        } catch {
            resolve(undefined);
        }
    });

export interface ProbeOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exec?: ExecFn;
    cacheMs?: number;
    now?: () => number;
    /** Replace the browser folder lookup (tests). */
    browsers?: () => Capabilities["browsers"];
    /** Replace the Windows UI Automation probe (tests). */
    desktop?: () => Promise<DesktopProbeResult>;
    /** The applications this agent was told it may start for desktop tests (--allow-app); reported so the platform can refuse a run early. */
    allowApps?: readonly string[];
    /** The owner agreed to run hand-written scripts (--allow-custom-scripts): reported as `customScripts` so the platform may offer them. */
    allowCustomScripts?: boolean;
    /** Set when the agent was started from a downloaded runner kit (its runner.json): reported as `kitVersion`. */
    kitVersion?: string;
    /** The runner's browser choice (browser-setup.ts): which browser web tests use, the installed Chrome and Edge, a sentence while none is ready. */
    browserSetup?: { report(): BrowserReport };
    /** The runner's own Android phone tools (phone-tools.ts): reported as `phoneTools`, and "can-fetch" counts for a phone session. */
    phoneTools?: { report(): PhoneToolsReport | undefined };
}

/** Apply the browser choice to the folder-based answer: a usable installed Chrome or Edge counts as a Chromium; an explicit choice the computer cannot meet does not. */
export function applyBrowserReport(caps: Capabilities, r: BrowserReport): void {
    if (r.chromium === "ready" && !caps.browsers.includes("chromium")) caps.browsers = ["chromium", ...caps.browsers];
    if (r.chromium === "missing") caps.browsers = caps.browsers.filter((b) => b !== "chromium");
    if (r.browser) caps.browser = r.browser;
    if (r.installed.length) caps.installedBrowsers = r.installed;
    if (r.note) caps.browserNote = r.note;
}

export class CapabilityProbe {
    private cached?: { at: number; value: Capabilities };
    private pending?: Promise<Capabilities>;

    constructor(private readonly opts: ProbeOptions = {}) {}

    /** The capabilities, from the cache when they are younger than 30 seconds. */
    async get(force = false): Promise<Capabilities> {
        const now = (this.opts.now ?? Date.now)();
        if (!force && this.cached && now - this.cached.at < (this.opts.cacheMs ?? CAPABILITY_CACHE_MS)) return this.cached.value;
        this.pending ??= this.discover().finally(() => (this.pending = undefined));
        const value = await this.pending;
        this.cached = { at: (this.opts.now ?? Date.now)(), value };
        return value;
    }

    async discover(): Promise<Capabilities> {
        const env = this.opts.env ?? process.env;
        const platform = this.opts.platform ?? process.platform;
        const exec = this.opts.exec ?? execText;
        const caps: Capabilities = {
            os: platform === "win32" || platform === "darwin" ? platform : "linux",
            arch: process.arch,
            node: process.version.slice(0, 40),
            browsers: this.opts.browsers ? this.opts.browsers() : detectBrowsers(playwrightBrowsersDir(env, platform)),
        };
        if (this.opts.browserSetup) applyBrowserReport(caps, this.opts.browserSetup.report());

        // Android: adb from the managed toolchain or ANDROID_HOME, else whatever is on the PATH.
        const avds = listAvds(env);
        const managedAdb = adbPath(env);
        const adb = managedAdb ?? ((await exec("adb", ["version"], 5000)) !== undefined ? "adb" : undefined);
        if (adb || avds.length > 0) {
            const call = adb ? commandFor(adb, ["devices", "-l"]) : undefined;
            const text = call ? await exec(call.file, call.args, 8000, env) : undefined;
            caps.android = { adb: Boolean(adb), devices: text ? parseAdbDevices(text) : [], avds: avds.map((a) => a.slice(0, 64)).slice(0, 40) };
        }

        // AI phone exploration: adb and a phone that is ready or an emulator that can be started (see deviceSessionProblem for the reason when not).
        const phoneTools = this.opts.phoneTools?.report();
        if (phoneTools) caps.phoneTools = phoneTools;
        if (!deviceSessionProblem(caps)) caps.deviceSession = true;

        if (platform === "darwin") {
            const xcode = (await exec("xcode-select", ["-p"], 5000)) !== undefined;
            if (xcode) {
                const json = await exec("xcrun", ["simctl", "list", "devices", "-j"], 15_000);
                let sims: string[] = [];
                let iosSims = 0;
                try {
                    const parsed = json ? JSON.parse(json) : null;
                    sims = parsed ? parseSimctl(parsed) : [];
                    iosSims = parsed ? countIosSimulators(parsed) : 0;
                } catch {
                    /* unreadable simctl output: report Xcode without simulators */
                }
                caps.ios = { xcode: true, simulators: sims, iosSimulators: iosSims, xcuitest: await detectXcuitest(env, exec) };
            }
        }

        if (platform === "win32") {
            const roots = [env["ProgramFiles(x86)"], env.ProgramFiles].filter((x): x is string => Boolean(x));
            const winappdriver = roots.some((r) => fs.existsSync(path.join(r, "Windows Application Driver", "WinAppDriver.exe")));
            // UI Automation is built into Windows; the probe loads its assemblies once (no window is opened) and reads whether this session is interactive and elevated.
            const desktop = await (this.opts.desktop ?? (() => probeDesktop({ platform, env })))();
            const allowed = resolvedAllowList(this.opts.allowApps ?? []).map((p) => p.slice(0, 300)).slice(0, 60);
            caps.windows = { ...(winappdriver ? { winappdriver: true } : {}), uiautomation: desktop.uiautomation, interactive: desktop.interactive, elevated: desktop.elevated, ...(allowed.length ? { allowedApps: allowed } : {}) };
        }

        // Recording: a Chromium it can launch (the browser discovery above), and a display when a person is meant to watch the window.
        if (caps.browsers.includes("chromium")) {
            caps.record = true;
            // This agent program answers the act and snapshot commands of a session driven step by step.
            caps.liveSession = true;
            if (hasDisplay(platform, env, caps.windows?.interactive)) caps.recordHeaded = true;
        }

        if (this.opts.allowCustomScripts === true) caps.customScripts = true;
        if (this.opts.kitVersion) caps.kitVersion = this.opts.kitVersion;
        // Who the machine is (round 39): operating system version, memory, processors, the test tool's version, what this program can run.
        Object.assign(caps, machineIdentity(platform));
        // This agent applies the platform's switches for it (code scripts, private addresses; hello `runner` and heartbeats).
        caps.runnerSwitches = true;

        const parsed = Capabilities.safeParse(caps);
        // A value the protocol cannot carry is a bug here, not a reason to stop: fall back to the part that is certainly valid.
        return parsed.success ? parsed.data : { os: caps.os, arch: caps.arch, node: caps.node, browsers: caps.browsers };
    }

    /** Forget the cached answer (a browser download finished): the next poll sends fresh capabilities. */
    invalidate(): void {
        this.cached = undefined;
    }
}

/** The frameworks this runner program runs (whether this computer has what each needs is the rest of the capabilities). */
export const RUNNER_ADAPTERS = ["playwright", "api", "taqwright", "taqwright-ios", "windows-uia"];

let identityCache: Pick<Capabilities, "osVersion" | "memoryMb" | "cpus" | "playwrightVersion" | "adapters"> | undefined;

/** OS version, memory, processors and Playwright's version, read once (they do not change while the runner runs). */
export function machineIdentity(platform: NodeJS.Platform = process.platform): Pick<Capabilities, "osVersion" | "memoryMb" | "cpus" | "playwrightVersion" | "adapters"> {
    if (identityCache && platform === process.platform) return identityCache;
    let osVersion: string | undefined;
    if (platform === "darwin") {
        try {
            osVersion = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 3000, windowsHide: true }).trim();
        } catch {
            osVersion = undefined;
        }
    }
    osVersion ||= os.release();
    let playwrightVersion: string | undefined;
    try {
        playwrightVersion = (createRequire(import.meta.url)("@playwright/test/package.json") as { version?: string }).version;
    } catch {
        playwrightVersion = undefined;
    }
    const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    const out = {
        ...(osVersion ? { osVersion: osVersion.replace(/[^\x20-\x7e]/g, "").slice(0, 60) } : {}),
        memoryMb: Math.round(os.totalmem() / (1024 * 1024)),
        cpus,
        ...(playwrightVersion ? { playwrightVersion: playwrightVersion.slice(0, 40) } : {}),
        adapters: RUNNER_ADAPTERS,
    };
    if (platform === process.platform) identityCache = out;
    return out;
}

/** One plain sentence about what was found, for the log. */
export function describeCapabilities(c: Capabilities): string {
    const parts = [`${c.os}/${c.arch}`, `node ${c.node}`, c.browsers.length ? `browsers: ${c.browsers.join(", ")}` : "no Playwright browsers installed (web tests cannot run; install with: npx playwright install chromium)"];
    if (c.browser) parts.push(`web tests use ${describeBrowser(c.browser)}`);
    else if (c.browserNote) parts.push(`web tests: ${c.browserNote.replace(/\.$/, "")}`);
    if (c.android) {
        const ready = c.android.devices.filter((d) => d.state === "device");
        parts.push(`Android: ${c.android.adb ? `adb found, ${ready.length} device${ready.length === 1 ? "" : "s"} ready` : "adb not found"}${c.android.avds.length ? `, emulators: ${c.android.avds.join(", ")}` : ""}`);
    }
    if (c.android) parts.push(`AI phone exploration: ${c.deviceSession ? "available" : `not available (${deviceSessionProblem(c) ?? "unknown reason"})`}`);
    if (c.phoneTools) parts.push(c.phoneTools.state === "ready" ? `Android phone tools: the runner's own, version ${c.phoneTools.version ?? "unknown"}` : `Android phone tools: ${(c.phoneTools.note ?? c.phoneTools.state).replace(/\.$/, "")}`);
    if (c.ios) {
        const sims = c.ios.iosSimulators ?? c.ios.simulators.length;
        parts.push(`iOS: Xcode found, ${sims} iOS simulator${sims === 1 ? "" : "s"}, ${c.ios.xcuitest ? "XCUITest driver found (iOS tests can run)" : "XCUITest driver not found (iOS tests cannot run; run npx @taqwright/taqwright install)"}`);
    }
    if (c.windows) {
        const w = c.windows;
        parts.push(`Windows desktop apps: ${w.uiautomation ? (w.elevated ? "UI Automation found, but this agent runs as administrator (desktop tests do not run elevated)" : w.interactive === false ? "UI Automation found, but this is not an interactive session" : `ready${w.allowedApps?.length ? `, may start: ${w.allowedApps.join(", ")}` : ", no application is allowed yet (use --allow-app)"}`) : "UI Automation not available"}`);
    }
    if (c.customScripts) parts.push("hand-written scripts: allowed (--allow-custom-scripts)");
    return parts.join("; ");
}
