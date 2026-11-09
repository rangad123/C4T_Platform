/**
 * "Check this computer" for the runner (docs/features/runner-check.md).
 *
 * `node runner.mjs --check` (and check-computer.cmd / check-computer.sh in every download, which find Node.js the way the start scripts do)
 * prints one plain line per item, each ok, missing or optional, with how to fix what is not ok: Node.js, the runner's files against the
 * checksum in their version, the test tools, the browser web tests will use (and why), Firefox and WebKit, the proxy and certificates in use,
 * whether the platform answers and its certificate is trusted, whether it accepts the runner's token, free disk space, the clock, the Android
 * phone tools, and on a Mac the processor (Apple chip or Rosetta) and the quarantine flag. Exit code 0 when nothing required is missing,
 * 1 when something is, 2 when the check itself failed.
 *
 * It changes nothing: it downloads no browser or phone tools, starts no runner, makes no runner row on the platform (the token is checked
 * with POST /api/agent/check, which only says yes or no), and sends nothing anywhere except to the platform address the download names.
 * The token is never printed; a proxy password is shown as ***, and every line is masked against both before it is written.
 *
 * A running runner makes the same check of the parts that do not need the network when it starts (`startRunnerCheck`) and sends it with its
 * hello and polls (`runnerCheckReport`, additive protocol field `Capabilities.check`); the browser, network and phone lines are then read from
 * what the runner reports anyway, and the clock from the platform's time in the hello answer. Those lines never hold a path.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { RunnerCheck, type Capabilities, type RunnerCheckItem } from "../agent-protocol/schema.js";
import { BROWSER_LABEL, bundledChromium, bundledReady, chooseBrowser, describeBrowser, findInstalledBrowsers, isBrowserPolicy, type BrowserPolicy, type Decision, type FoundBrowser } from "../engine/browsers/choice.js";
import { bypassMatches, describeNetworkError, problemSentence, proxySecrets, redactCredentials, withLoopbackBypass, type ProxyAddress } from "../engine/net/company-network.js";
import { installedPhoneTools, phoneToolsHost } from "../engine/mobile/platform-tools.js";
import { adbPath, toolCwd } from "../engine/mobile/toolchain.js";
import { detectBrowsers, expectedRevisions, playwrightBrowsersDir, type ExecFn } from "./capabilities.js";
import { AGENT_VERSION, parseAgentArgs, type AgentConfig } from "./config.js";
import { loadCredential } from "./credential-store.js";
import { applyKitDefaults, KIT_CONFIG_FILE } from "./kit.js";
import { addWindowsProxy, applyRunnerNetwork, kitNetworkDefaults, type NetworkSettings } from "./net.js";
import { phoneToolsPolicy } from "./phone-tools.js";
import { phoneReadyLines } from "./phone-ready-lines.js";

/** Found in the runner program's text: an installer asks a runner for this check only when its program knows it (installer/win, installer/mac). */
export const CHECK_MARKER = "aitp-computer-check/1";
/** The Node.js the runner needs (the kit's engines.node; scripts/build-runner.mjs NODE_MIN). */
export const CHECK_NODE_MIN = 24;
/** The bundle files a download's version hash covers, sorted as scripts/build-runner.mjs hashes them. */
export const BUNDLE_FILES = ["LICENSES.txt", "package.json", "record-child.mjs", "runner.mjs", "task-child.mjs"] as const;
/** Covered too when the download has it (every build from round 39 on): the test tools' lock file. */
export const BUNDLE_LOCK_FILE = "package-lock.json";
/** Less free space than this in the runner's folder is "missing": a browser download alone is about 150 MB, and runs keep their files there. */
export const DISK_MIN_BYTES = 1024 ** 3;
/** A clock further off than this from the platform's is "missing": https certificates and tokens depend on the time. */
export const CLOCK_MAX_SKEW_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type CheckStatus = RunnerCheckItem["status"];
/** One line of the check. `notes` are printed on this computer only (they may name a folder); they never go to the platform. */
export interface CheckLine extends RunnerCheckItem {
    notes?: string[];
}

const line = (id: string, status: CheckStatus, title: string, fix?: string, notes?: string[]): CheckLine => ({ id, status, title: title.slice(0, 300), ...(fix && status !== "ok" ? { fix: fix.slice(0, 400) } : {}), ...(notes?.length ? { notes } : {}) });
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const majorMinor = (v: string): [number, number] => {
    const m = /^v?(\d+)\.(\d+)/.exec(v);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

// ── the parts, one pure function each (tests feed them a fake computer) ─────

/** Node.js: new enough, and whether it came with the download. */
export function nodeLine(version: string, bundled: boolean): CheckLine {
    const [major] = majorMinor(version);
    if (major < CHECK_NODE_MIN) return line("node", "missing", `Node.js ${version} is too old: the runner needs ${CHECK_NODE_MIN} or newer`, "Install the LTS version from https://nodejs.org, or download the complete runner from the platform: it brings its own Node.js.");
    return line("node", "ok", `Node.js ${version}, ${bundled ? "came with this download" : "installed on this computer"}`);
}

/** Is `execPath` the Node.js inside this download (node/node.exe, node/bin/node)? */
export function isBundledNode(execPath: string, kitDir: string): boolean {
    const rel = path.relative(path.join(kitDir, "node"), execPath);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The runner files against their download's version: runner.json's kitVersion ends in the first 10 hex characters of the SHA-256 of
 * "name\0sha256\n" for each bundle file in name order (scripts/build-runner.mjs), package-lock.json included when the download has it, so a
 * damaged or changed file is found without a manifest.
 */
export function filesLine(kitVersion: string | undefined, read: (name: string) => Buffer | undefined): CheckLine {
    const missing: string[] = [];
    const parts = new Map<string, string>();
    for (const name of BUNDLE_FILES) {
        const bytes = read(name);
        if (!bytes) missing.push(name);
        else parts.set(name, `${name}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
    }
    const lock = read(BUNDLE_LOCK_FILE);
    const again = "Unzip the whole download again, or download a new runner from the platform (Settings, Runners, Add a runner).";
    if (missing.length) return line("files", "missing", `Runner files: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing`, again);
    const want = /\+([0-9a-f]{10})$/.exec(kitVersion ?? "")?.[1];
    if (!want) return line("files", "optional", "Runner files are all here; this download has no checksum to compare them with", "Nothing to do unless the runner behaves oddly; then download a new runner from the platform.");
    // The build hashes the lock file with the others, in the same name order, when the download has one. A download built without one gets a
    // lock file from npm install on this computer, so the files also match without it; a download whose version covers its lock file still
    // fails when that file is changed or deleted (neither sum matches then).
    const sum = (withLock: boolean): string => {
        const m = new Map(parts);
        if (withLock && lock) m.set(BUNDLE_LOCK_FILE, `${BUNDLE_LOCK_FILE}\0${createHash("sha256").update(lock).digest("hex")}\n`);
        return createHash("sha256").update([...m.keys()].sort().map((n) => m.get(n)!).join("")).digest("hex").slice(0, 10);
    };
    if (sum(true) !== want && sum(false) !== want) return line("files", "missing", `Runner files do not match this download (version ${kitVersion}): one of them was changed or is damaged`, again);
    return line("files", "ok", `Runner files match this download (version ${kitVersion})`);
}

interface KitPackage {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

/** The test tools (the kit's pinned packages) in the download's node_modules. */
export function toolsLine(pkg: KitPackage | undefined, installed: (name: string) => string | undefined, complete: boolean): CheckLine {
    if (!pkg) return line("tools", "missing", "The runner's package.json could not be read, so the test tools cannot be checked", "Unzip the whole download again, or download a new runner from the platform.");
    const needed = Object.entries(pkg.dependencies ?? {});
    const absent = needed.filter(([n]) => !installed(n)).map(([n]) => n);
    const wrong = needed.filter(([n, v]) => installed(n) && installed(n) !== v);
    if (absent.length) {
        return line(
            "tools",
            "missing",
            `The test tools are not installed (${absent[0]}${absent.length > 1 ? ` and ${absent.length - 1} more` : ""})`,
            complete
                ? "This download is incomplete. Unzip the whole download again, or download a new runner from the platform."
                : "Start the runner once with start-runner: it installs them (this needs the internet; on a company network see the network line). The complete download from the platform already holds them.",
        );
    }
    if (wrong.length) {
        const [n, v] = wrong[0]!;
        return line("tools", "missing", `The test tools are not the versions this runner needs (${n} ${installed(n)}, needs ${v})`, complete ? "Unzip the whole download again, or download a new runner from the platform." : "Delete the node_modules folder in the runner's folder and start the runner again: it installs the right versions.");
    }
    const pw = pkg.dependencies?.["@playwright/test"];
    const phones = Object.keys(pkg.optionalDependencies ?? {}).filter((n) => !installed(n));
    return line("tools", "ok", `Test tools are installed${pw ? ` (Playwright ${pw})` : ""}${complete ? ", came with this download" : ""}${phones.length ? "; the phone test tools are not (only phone tests need them)" : ""}`);
}

export interface BrowserAnswer {
    policy: BrowserPolicy;
    decision: Decision;
    installed: FoundBrowser[];
    bundled?: { version: string; major: number };
    /** The runner downloaded Playwright's Chromium itself on an earlier start. */
    downloadedBefore?: boolean;
}

/** The browser web tests will use, and why (the same rule the runner applies when it starts: runner-browsers.md). */
export function browserLine(a: BrowserAnswer): CheckLine {
    const setting = `browser setting: ${a.policy}${a.policy === "auto" ? ", the default" : ""}`;
    const notUsed = a.installed.filter((b) => !b.usable && b.reason).map((b) => `${b.reason}.`);
    const d = a.decision;
    if (d.use === "installed") return line("browser", "ok", `Web tests will use ${describeBrowser({ name: d.browser.name, ...(d.browser.version ? { version: d.browser.version } : {}), source: "installed" })} (${setting})`, undefined, notUsed);
    if (d.use === "bundled") return line("browser", "ok", `Web tests will use ${describeBrowser({ name: "chromium", ...(a.bundled ? { version: a.bundled.version } : {}), source: a.downloadedBefore ? "downloaded" : "bundled" })} (${setting})`, undefined, notUsed);
    if (d.use === "none") return line("browser", "missing", d.reason, `Install ${BROWSER_LABEL[a.policy as "chrome" | "msedge"] ?? "it"}, or let the runner choose: start it with --browser auto, or remove "browser" from runner.json.`, notUsed);
    const what = `Chromium${a.bundled ? ` ${a.bundled.major}` : ""}`;
    const why = a.policy === "bundled" ? `Playwright's ${what} is not here yet` : "No usable Google Chrome or Microsoft Edge is installed";
    return line("browser", "ok", `${why}: the runner downloads ${what} once when it starts (about 150 MB, needs the internet; ${setting})`, undefined, notUsed);
}

/** Firefox and WebKit, used only by runs on other browsers; the runner downloads them when such a run needs them. */
export function enginesLine(present: ReadonlyArray<string>): CheckLine {
    const missing = (["firefox", "webkit"] as const).filter((e) => !present.includes(e)).map((e) => BROWSER_LABEL[e]);
    if (!missing.length) return line("engines", "ok", "Firefox and WebKit are here (for runs on other browsers)");
    return line("engines", "optional", `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not here yet (only runs on other browsers need ${missing.length === 1 ? "it" : "them"})`, `Nothing to do: the runner downloads ${missing.length === 1 ? "it" : "them"} when such a run arrives.`);
}

const SOURCE_WORDS: Record<string, string> = { flag: "--proxy", env: "HTTPS_PROXY / HTTP_PROXY", file: "runner.json", windows: "the Windows proxy setting" };

/** The proxy and certificates the runner uses (the address with its password as ***). */
export function networkLine(s: NetworkSettings, o: { nodeVersion: string; systemCertificates?: number; extraCertificates?: boolean }): CheckLine {
    const trusts = ["Node.js's own certificates"];
    if (s.systemCa) trusts.push(o.systemCertificates !== undefined ? `this computer's certificate store (${o.systemCertificates})` : "this computer's certificate store");
    if (s.caFile) trusts.push(`${path.basename(s.caFile.path)} (${plural(s.caFile.pems.length, "certificate")})`);
    if (o.extraCertificates) trusts.push("NODE_EXTRA_CA_CERTS");
    const [maj, min] = majorMinor(o.nodeVersion);
    const proxy = s.proxy?.https ?? s.proxy?.http;
    const how = proxy ? `through the proxy ${proxy.display}, from ${SOURCE_WORDS[s.proxy!.source] ?? s.proxy!.source}` : s.proxyNone ? "directly (--proxy none)" : "directly, no proxy set";
    const title = `Network: connects ${how}; trusts ${trusts.join(", ")}`;
    if (proxy && (maj < 24 || (maj === 24 && min < 14))) return line("network", "missing", `${title}. This Node.js (${o.nodeVersion}) cannot use a proxy: that needs 24.14 or newer`, "Download the complete runner from the platform (it brings a new enough Node.js), or update Node.js.", s.notes);
    return line("network", "ok", title, undefined, s.notes);
}

/** What happened when the platform's open health route was asked for. */
export type PlatformAnswer =
    | { reached: true; status: number; https: boolean; date?: string; html?: boolean; location?: string }
    | { reached: false; sentence: string };

export function platformLine(host: string, a: PlatformAnswer): CheckLine {
    if (!a.reached) {
        const [lead, ...rest] = a.sentence.split(/(?<=\.) /);
        return line("platform", "missing", (lead ?? a.sentence).replace(/\.$/, ""), rest.join(" ") || "Check the address in runner.json, that this computer is online (or on the right network or VPN), and that the platform is running.");
    }
    if (a.status === 407) return line("platform", "missing", `Could not reach ${host}: a proxy asks for a user name and password (HTTP 407)`, "Add them to the proxy address, for example --proxy http://user:password@host:port. The password is never shown or sent to the platform.");
    if (a.status === 403 && a.html) return line("platform", "missing", `Something between this computer and ${host} blocked the request (HTTP 403, a web page instead of the platform's answer)`, `A company web filter may block ${host}: ask IT to allow it.`);
    if (a.status >= 300 && a.status < 400) return line("platform", "missing", `${host} answers with a redirect (HTTP ${a.status}${a.location ? ` to ${a.location}` : ""}), which the runner does not follow`, "Download a new runner from the platform's own address, or ask whoever runs the platform to set PUBLIC_URL to the address people use.");
    if (a.status >= 500) return line("platform", "missing", `${host} answered with an error (HTTP ${a.status})`, "The platform, or a proxy in front of it, has a problem. Try again in a few minutes; if it repeats, tell whoever runs the platform.");
    return line("platform", "ok", a.https ? `The platform at ${host} answers, and its certificate is trusted` : `The platform at ${host} answers (plain http, on this computer or a private network)`);
}

export type TokenAnswer = { status: number; project?: string; sentence?: string } | { error: string } | { skipped: true };

export function tokenLine(a: TokenAnswer): CheckLine {
    if ("skipped" in a) return line("token", "optional", "The token was not checked, because the platform could not be reached", "Fix the platform line first, then run this check again.");
    if ("error" in a) return line("token", "missing", a.error.replace(/\.$/, ""), "Check the network, then run this check again.");
    if (a.status >= 200 && a.status < 300) return line("token", "ok", `The platform accepts this runner's token${a.project ? ` (project "${a.project}")` : ""}; the token is not shown`);
    if ((a.status === 404 || a.status === 401) && /token/i.test(a.sentence ?? "")) return line("token", "missing", "The platform does not accept this runner's token: it was revoked, or the project was deleted", "Download a new runner from the platform (Settings, Runners, Add a runner).");
    if (a.status === 429) return line("token", "optional", "The platform asked to slow down, so the token was not checked", "Run this check again in a minute.");
    return line("token", "optional", `The platform cannot check the token without connecting (it answered HTTP ${a.status}; it may be an older version)`, "Start the runner: it says plainly when the token is not accepted.");
}

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function diskLine(free: number | undefined): CheckLine {
    if (free === undefined) return line("disk", "optional", "Free disk space could not be read", "Make sure the disk that holds the runner's folder has at least 1 GB free.");
    if (free < DISK_MIN_BYTES) return line("disk", "missing", `Only ${gb(free)} free on the disk that holds the runner's folder: it needs at least 1 GB`, "Free some space (a browser download alone is about 150 MB, and runs keep their screenshots and traces there), then start the runner again.");
    return line("disk", "ok", `${gb(free)} free on the disk that holds the runner's folder`);
}

const span = (ms: number): string => {
    const m = Math.round(ms / 60_000);
    if (m < 120) return plural(m, "minute");
    const h = Math.round(ms / 3_600_000);
    return h < 48 ? plural(h, "hour") : plural(Math.round(ms / 86_400_000), "day");
};

/** This computer's clock against the platform's. `serverTime` is an HTTP Date header or an ISO time; undefined when the platform was not reached. */
export function clockLine(serverTime: string | undefined, now: number): CheckLine {
    const server = serverTime ? Date.parse(serverTime) : Number.NaN;
    if (!Number.isFinite(server)) return line("clock", "optional", "The clock was not compared with the platform's (the platform was not reached)", "Make sure this computer sets its date and time automatically.");
    const skew = now - server;
    if (Math.abs(skew) > CLOCK_MAX_SKEW_MS) return line("clock", "missing", `This computer's clock is ${span(Math.abs(skew))} ${skew > 0 ? "ahead of" : "behind"} the platform's: a clock that far off breaks https connections`, "Set the date and time to be set automatically (Windows: Settings, Time and language; Mac: System Settings, General, Date and Time), then run this check again.");
    return line("clock", "ok", "The clock agrees with the platform's");
}

export interface PhoneAnswer {
    /** adb from ANDROID_HOME, Taqwright, AITP_ADB_PATH or the PATH. */
    adb: boolean;
    /** The runner's own phone tools fetched earlier (their version). */
    own?: string;
    policy: "auto" | "now" | "off";
    unsupported?: string;
}

/** The Android phone tools (optional: only phone tests need them; the runner fetches Google's when a phone session needs them). */
export function phoneLine(a: PhoneAnswer): CheckLine {
    if (a.adb) return line("phone", "ok", "Android phone tools (adb) are on this computer");
    if (a.own) return line("phone", "ok", `Android phone tools: the runner's own, version ${a.own}`);
    if (a.unsupported) return line("phone", "optional", "Android phone tools are not on this computer, and Google has none for it", a.unsupported);
    if (a.policy === "off") return line("phone", "optional", "Android phone tools are not on this computer (only phone tests need them)", "Install Android's platform-tools, or let the runner fetch them: set AITP_PHONE_TOOLS=auto (or \"phoneTools\": \"auto\" in runner.json).");
    return line("phone", "optional", "Android phone tools are not on this computer yet (only phone tests need them)", "Nothing to do: the runner gets them from Google when a phone test needs them.");
}

/** On a Mac: the processor, and whether this Node.js runs natively or through Rosetta. */
export function macChipLine(o: { arch: string; translated: boolean; appleChip: boolean }): CheckLine {
    if (o.arch === "arm64") return line("mac-chip", "ok", "Apple chip, and this Node.js is made for it");
    if (o.translated || o.appleChip) return line("mac-chip", "optional", "This Node.js is the Intel version, running through Rosetta on an Apple chip", "It works, but more slowly. Download the runner for a Mac with an Apple chip from the platform.");
    return line("mac-chip", "ok", "Intel processor, and this Node.js is made for it");
}

/** On a Mac: the quarantine flag macOS puts on what came from the internet. */
export function quarantineLine(flagged: boolean, folder?: string): CheckLine {
    if (!flagged) return line("mac-quarantine", "ok", "The runner's folder is not marked as downloaded from the internet (no quarantine flag)");
    return line(
        "mac-quarantine",
        "optional",
        "macOS marks the runner's folder as downloaded from the internet (quarantine), which can block the programs in it",
        "start-runner.sh clears the flag when it starts. If macOS still blocks a file, run xattr -dr com.apple.quarantine on the runner's folder in Terminal.",
        folder ? [`In Terminal: xattr -dr com.apple.quarantine "${folder}"`] : undefined,
    );
}

// ── reading this computer ───────────────────────────────────────────────────

export interface CheckDeps {
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
    execPath: string;
    now(): number;
    fetchImpl: typeof fetch;
    /** Short commands: sysctl and xattr on a Mac, a Linux browser's --version. Undefined when one fails. */
    exec: ExecFn;
    /** Free bytes on the disk that holds `dir`. */
    freeBytes(dir: string): number | undefined;
    /** Certificates in this computer's store (undefined when this Node.js cannot read it). */
    systemCertificates(): number | undefined;
    /** Tests: a folder standing for "/" when looking for installed browsers on a Mac or Linux. */
    browserRoot?: string;
    /** The real program: the proxy and certificates also apply to this process's own requests. Tests leave the process alone. */
    applyNetwork: boolean;
}

const execShort: ExecFn = (file, args, timeoutMs, env) =>
    new Promise((resolve) => {
        try {
            const cwd = toolCwd();
            execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }, (error, stdout) => resolve(error ? undefined : String(stdout)));
        } catch {
            resolve(undefined);
        }
    });

function nearestExisting(dir: string): string {
    let cur = path.resolve(dir);
    while (!fs.existsSync(cur)) {
        const up = path.dirname(cur);
        if (up === cur) return cur;
        cur = up;
    }
    return cur;
}

export function realDeps(): CheckDeps {
    return {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        execPath: process.execPath,
        now: Date.now,
        fetchImpl: fetch,
        exec: execShort,
        freeBytes: (dir) => {
            try {
                const s = fs.statfsSync(nearestExisting(dir));
                return Number(s.bavail) * Number(s.bsize);
            } catch {
                return undefined;
            }
        },
        systemCertificates: () => {
            const t = tls as unknown as { getCACertificates?: (kind?: string) => string[] };
            try {
                return typeof t.getCACertificates === "function" ? t.getCACertificates("system").length : undefined;
            } catch {
                return undefined;
            }
        },
        applyNetwork: true,
    };
}

const readFile = (file: string): Buffer | undefined => {
    try {
        return fs.statSync(file).isFile() ? fs.readFileSync(file) : undefined;
    } catch {
        return undefined;
    }
};
const readJson = <T>(file: string): T | undefined => {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as T;
    } catch {
        return undefined;
    }
};
const versionIn = (modules: string) => (name: string): string | undefined => {
    const v = readJson<{ version?: unknown }>(path.join(modules, ...name.split("/"), "package.json"))?.version;
    return typeof v === "string" ? v : undefined;
};

function filesAndTools(kitDir: string, kitVersion: string | undefined): CheckLine[] {
    const files = filesLine(kitVersion, (n) => readFile(path.join(kitDir, n)));
    const complete = fs.existsSync(path.join(kitDir, "complete-kit.json")) || fs.existsSync(path.join(kitDir, "node_modules", ".aitp-complete"));
    return [files, toolsLine(readJson<KitPackage>(path.join(kitDir, "package.json")), versionIn(path.join(kitDir, "node_modules")), complete)];
}

/** adb as the runner would find it, by looking for the file (never by running it). */
function adbFound(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
    if (adbPath(env)) return true;
    const name = platform === "win32" ? "adb.exe" : "adb";
    const sep = platform === "win32" ? ";" : ":";
    return (env.PATH ?? env.Path ?? "").split(sep).some((d) => d.trim() && fs.existsSync(path.join(d.trim().replace(/^"|"$/g, ""), name)));
}

async function macLines(d: CheckDeps, kitDir: string | undefined): Promise<CheckLine[]> {
    if (d.platform !== "darwin") return [];
    const yes = async (file: string, args: string[]) => (await d.exec(file, args, 5000))?.trim() === "1";
    const out = [macChipLine({ arch: d.arch, translated: await yes("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"]), appleChip: await yes("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"]) })];
    if (kitDir) {
        const flagged = async (p: string) => fs.existsSync(p) && (await d.exec("/usr/bin/xattr", ["-p", "com.apple.quarantine", p], 5000)) !== undefined;
        out.push(quarantineLine((await flagged(kitDir)) || (await flagged(path.join(kitDir, "node", "bin", "node"))), kitDir));
    }
    return out;
}

async function browserAnswer(d: CheckDeps, env: NodeJS.ProcessEnv, policy: BrowserPolicy, workDir: string): Promise<BrowserAnswer> {
    const bundled = bundledChromium();
    const installed = await findInstalledBrowsers({ platform: d.platform, env, exec: d.exec, ...(d.browserRoot ? { root: d.browserRoot } : {}), ...(bundled ? { bundledMajor: bundled.major } : {}) }).catch(() => []);
    const ready = bundledReady(playwrightBrowsersDir(env, d.platform), bundled?.revision);
    const marker = readJson<{ chromium?: unknown }>(path.join(workDir, "browser-downloads.json"))?.chromium;
    return {
        policy,
        decision: chooseBrowser(policy, { bundledReady: ready, installed }),
        installed,
        ...(bundled ? { bundled: { version: bundled.version, major: bundled.major } } : {}),
        ...(bundled && Array.isArray(marker) && marker.includes(bundled.revision) ? { downloadedBefore: true } : {}),
    };
}

/** The proxy a request to `url` goes through under these settings (undefined: directly). */
function proxyFor(url: string, s: NetworkSettings): ProxyAddress | undefined {
    if (!s.proxy) return undefined;
    const u = new URL(url);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (bypassMatches(u.hostname, port, withLoopbackBypass(s.bypass))) return undefined;
    return u.protocol === "https:" ? (s.proxy.https ?? s.proxy.http) : s.proxy.http;
}

async function askPlatform(d: CheckDeps, cfg: AgentConfig, s: NetworkSettings, host: string): Promise<PlatformAnswer> {
    const url = `${cfg.baseUrl}/api/health`;
    try {
        const res = await d.fetchImpl(url, { headers: { accept: "application/json", "user-agent": `ai-test-agent/${AGENT_VERSION} (${CHECK_MARKER})`, connection: "close" }, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        await res.body?.cancel().catch(() => undefined);
        let location: string | undefined;
        try {
            const raw = res.headers.get("location");
            location = raw ? new URL(raw, url).host : undefined;
        } catch {
            location = undefined;
        }
        const date = res.headers.get("date") ?? undefined;
        return { reached: true, status: res.status, https: url.startsWith("https:"), ...(date ? { date } : {}), ...(/text\/html/i.test(res.headers.get("content-type") ?? "") ? { html: true } : {}), ...(location ? { location } : {}) };
    } catch (e) {
        const proxy = proxyFor(url, s);
        return { reached: false, sentence: problemSentence(`Could not reach ${host}`, describeNetworkError(e, { target: host, ...(proxy ? { proxy, proxySource: s.proxy?.source } : {}) })) };
    }
}

async function askToken(d: CheckDeps, cfg: AgentConfig, s: NetworkSettings, host: string): Promise<TokenAnswer> {
    const url = `${cfg.baseUrl}/api/agent/check`;
    try {
        const res = await d.fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json", "user-agent": `ai-test-agent/${AGENT_VERSION} (${CHECK_MARKER})`, connection: "close" }, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        let body: { project?: unknown; message?: unknown; error?: unknown } = {};
        try {
            body = (await res.json()) as typeof body;
        } catch {
            body = {};
        }
        const said = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "";
        const project = typeof body.project === "string" ? body.project.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120) : undefined;
        return { status: res.status, ...(project ? { project } : {}), ...(said ? { sentence: said.slice(0, 240) } : {}) };
    } catch (e) {
        const proxy = proxyFor(url, s);
        return { error: problemSentence(`Could not ask ${host} about the token`, describeNetworkError(e, { target: host, ...(proxy ? { proxy, proxySource: s.proxy?.source } : {}) })) };
    }
}

export interface CheckResult {
    /** "Check this computer for the runner "Office PC" (platform tests.example.com)." */
    header: string;
    lines: CheckLine[];
    /** Values that must never be printed: the token and a proxy password. */
    secrets: string[];
}

/**
 * Check this computer. `argv` is the runner's command line without --check (the same flags work: --url, --token-file, --proxy, --ca-file,
 * --browser ...), `env` the environment as the runner would start with it, `kitDir` the folder of runner.mjs.
 */
export async function checkComputer(input: { argv: string[]; env: NodeJS.ProcessEnv; kitDir: string; deps?: Partial<CheckDeps> }): Promise<CheckResult> {
    const d: CheckDeps = { ...realDeps(), ...input.deps };
    const lines: CheckLine[] = [nodeLine(d.nodeVersion, isBundledNode(d.execPath, input.kitDir))];
    const secrets: string[] = [];
    let header = "Check this computer for the AI Testing Platform runner.";

    // The settings, read exactly as the runner reads them: runner.json, then its network lines, then the command line and the environment.
    const kit = applyKitDefaults(input.env, input.kitDir);
    const kitNet = kit.kit === "broken" ? undefined : kitNetworkDefaults(kit.env, input.kitDir);
    const env = kitNet?.ok ? kitNet.env : kit.kit === "broken" ? input.env : kit.env;
    const parsed = kit.kit === "broken" || (kitNet && !kitNet.ok) ? undefined : parseAgentArgs(input.argv.filter((a) => a !== "--check"), env);
    const cfg = parsed?.kind === "run" ? parsed.config : undefined;
    // Round 39: a runner added with an enrollment code keeps its credential in this computer's store (credential-store.ts).
    if (cfg && cfg.tokenSource === "store") {
        cfg.token = (await loadCredential(cfg.credentialDir ?? cfg.workDir).catch(() => null)) ?? "";
        if (cfg.enroll) secrets.push(cfg.enroll.code);
    }
    if (cfg?.token) secrets.push(cfg.token);
    if (kit.kit === "broken") lines.push(line("settings", "missing", "The runner's settings (runner.json) cannot be used", kit.message));
    else if (kitNet && !kitNet.ok) lines.push(line("settings", "missing", "runner.json has a network line the runner cannot use", kitNet.message));
    else if (!cfg) lines.push(line("settings", "missing", "The runner's settings are not complete", parsed?.kind === "error" ? parsed.message : "Give the platform address and the token (see ai-test-agent --help)."));
    else {
        const host = new URL(cfg.baseUrl).host;
        header = `Check this computer for the AI Testing Platform runner "${cfg.name}" (platform ${host}).`;
        const tokenFrom = cfg.tokenSource === "store" ? (cfg.token ? "kept in this computer's credential store" : cfg.enroll ? "not made yet: the runner trades its enrollment code when it starts" : "missing: add this computer on the Runners page") : cfg.tokenSource === "file" ? `read from ${path.basename(env.AITP_AGENT_TOKEN_FILE ?? "the token file")}` : cfg.tokenSource === "flag" ? "given with --token" : "from AITP_AGENT_TOKEN";
        lines.push(line("settings", "ok", `Settings: platform ${host}, runner name "${cfg.name}", token ${tokenFrom} (not shown)`, undefined, kit.kit === false ? ["Not started from a download (no runner.json next to the runner): the settings come from the command line and the environment."] : undefined));
    }
    const workDir = cfg?.workDir ?? path.join(input.kitDir, "work");
    if (kit.kit === true) lines.push(...filesAndTools(input.kitDir, kit.file.kitVersion));

    // The browser, as the runner would choose it (nothing is downloaded here).
    const policyRaw = (cfg?.browser ?? env.AITP_BROWSER ?? "auto").trim().toLowerCase();
    const policy: BrowserPolicy = isBrowserPolicy(policyRaw) ? policyRaw : "auto";
    lines.push(browserLine(await browserAnswer(d, env, policy, workDir)));
    lines.push(enginesLine(detectBrowsers(playwrightBrowsersDir(env, d.platform), expectedRevisions())));

    // The network: the proxy and certificates the runner would use, then the platform and the token through them.
    let serverDate: string | undefined;
    if (cfg?.network) {
        const s = d.platform === "win32" ? await addWindowsProxy(cfg.network, env, d.platform) : cfg.network;
        secrets.push(...proxySecrets(s.proxy?.https), ...proxySecrets(s.proxy?.http));
        if (d.applyNetwork) applyRunnerNetwork(s, { envs: [env], global: true, workDir, platformUrl: cfg.baseUrl, platform: d.platform });
        lines.push(networkLine(s, { nodeVersion: d.nodeVersion, systemCertificates: s.systemCa ? d.systemCertificates() : undefined, extraCertificates: Boolean(env.NODE_EXTRA_CA_CERTS?.trim()) }));
        const host = new URL(cfg.baseUrl).host;
        const platform = await askPlatform(d, cfg, s, host);
        lines.push(platformLine(host, platform));
        const reached = platform.reached && platform.status < 300;
        if (platform.reached) serverDate = platform.date;
        if (!cfg.token) lines.push(line("token", cfg.enroll ? "optional" : "missing", cfg.enroll ? "This runner has no credential yet; it trades its enrollment code when it starts" : "This runner has no credential and no enrollment code", cfg.enroll ? "Start the runner within 30 minutes of the download, or make a new code on the Runners page." : "Add this computer on the Runners page."));
        else lines.push(tokenLine(reached ? await askToken(d, cfg, s, host) : { skipped: true }));
    }

    lines.push(diskLine(d.freeBytes(workDir)));
    lines.push(clockLine(serverDate, d.now()));
    const own = installedPhoneTools(path.join(workDir, "phone-tools"), d.platform);
    const host = phoneToolsHost(d.platform, d.arch);
    lines.push(phoneLine({ adb: adbFound(env, d.platform), ...(own ? { own: own.version } : {}), policy: phoneToolsPolicy(env, kit.kit === true), ...(host.ok ? {} : { unsupported: host.reason }) }));
    // Each connected phone: "Is this phone ready?" (read-only; engine/mobile/device/ready.ts), only when this computer has adb.
    lines.push(...(await phoneReadyLines(env)));
    lines.push(...(await macLines(d, kit.kit === true ? input.kitDir : undefined)));
    return { header, lines, secrets: secrets.filter((x) => x && x.length >= 4) };
}

/** Replace every secret in a text with ***, and any user:password@ in an address. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const s of secrets) if (s) out = out.split(s).join("***");
    return redactCredentials(out);
}

/** The check as plain lines, in the shape of `npm run doctor`. */
export function formatCheck(r: Pick<CheckResult, "header" | "lines">): string {
    const out = [r.header, ""];
    for (const l of r.lines) {
        out.push(`${l.status.padEnd(9)} ${l.title}`);
        if (l.fix && l.status !== "ok") out.push(`${" ".repeat(10)}To fix: ${l.fix}`);
        for (const n of l.notes ?? []) out.push(`${" ".repeat(10)}Note: ${n}`);
    }
    out.push("", checkSummary(r.lines));
    return `${out.join("\n")}\n`;
}

/** "Everything the runner needs is here." or "2 things need a look. ..." */
export function checkSummary(lines: ReadonlyArray<Pick<CheckLine, "status">>): string {
    const missing = lines.filter((l) => l.status === "missing").length;
    const optional = lines.filter((l) => l.status === "optional").length;
    if (missing === 0) return `Everything the runner needs is here.${optional ? ` ${optional === 1 ? "1 optional thing is" : `${optional} optional things are`} not set up; ${optional === 1 ? "it only matters" : "they only matter"} for those kinds of tests.` : ""}`;
    return `${missing === 1 ? "1 thing needs" : `${missing} things need`} a look. Fix ${missing === 1 ? "it" : "them"}, then run this check again.`;
}

/** `node runner.mjs --check`: print the check and return the exit code (0 ready, 1 something required is missing, 2 the check itself failed). */
export async function runCheckProgram(o: { argv: string[]; env: NodeJS.ProcessEnv; kitDir: string; out(text: string): void; deps?: Partial<CheckDeps> }): Promise<number> {
    let secrets: string[] = [];
    try {
        const r = await checkComputer({ argv: o.argv, env: o.env, kitDir: o.kitDir, ...(o.deps ? { deps: o.deps } : {}) });
        secrets = r.secrets;
        o.out(maskSecrets(formatCheck(r), secrets));
        return r.lines.some((l) => l.status === "missing") ? 1 : 0;
    } catch (e) {
        o.out(maskSecrets(`The check could not finish: ${e instanceof Error ? e.message : "unknown problem"}\n`, secrets));
        return 2;
    }
}

// ── the running runner: the same check, sent with its hello ──────────────────

let startup: { at: string; lines: RunnerCheckItem[] } | undefined;
let clock: RunnerCheckItem | undefined;

/** The folder of the running program (runner.mjs in a download). */
const programDir = (): string => path.dirname(fileURLToPath(import.meta.url));
const forPlatform = (l: CheckLine): RunnerCheckItem => ({ id: l.id, status: l.status, title: l.title, ...(l.fix ? { fix: l.fix } : {}) });

/** At start (main.ts): the parts of the check that need no network. Never throws, never blocks for long. */
export async function startRunnerCheck(config: Pick<AgentConfig, "workDir" | "kitVersion">, deps: Partial<CheckDeps> = {}, kitDir = programDir()): Promise<void> {
    try {
        const d: CheckDeps = { ...realDeps(), ...deps };
        const kit = Boolean(config.kitVersion) && fs.existsSync(path.join(kitDir, KIT_CONFIG_FILE));
        const lines: CheckLine[] = [nodeLine(d.nodeVersion, isBundledNode(d.execPath, kitDir))];
        if (kit) lines.push(...filesAndTools(kitDir, config.kitVersion));
        lines.push(diskLine(d.freeBytes(config.workDir)));
        lines.push(...(await macLines(d, kit ? kitDir : undefined)));
        startup = { at: new Date(d.now()).toISOString(), lines: lines.map(forPlatform) };
    } catch {
        startup = undefined;
    }
}

/** The platform's time from the hello answer (client.ts). */
export function noteServerTime(serverTime: string, now = Date.now()): void {
    clock = forPlatform(clockLine(serverTime, now));
}

/** Tests: forget what an earlier start in this process found. */
export function resetRunnerCheck(): void {
    startup = undefined;
    clock = undefined;
}

/** The browser line from what the runner reports about its browser. */
function browserFromCaps(c: Capabilities): CheckLine {
    if (c.browser) return line("browser", "ok", `Web tests use ${describeBrowser(c.browser)}`);
    if (c.browserNote && /downloading/i.test(c.browserNote)) return line("browser", "ok", c.browserNote.replace(/\.$/, ""));
    if (!c.browsers.includes("chromium")) return line("browser", "missing", (c.browserNote ?? "There is no browser for web tests").replace(/\.$/, ""), "Install Google Chrome or Microsoft Edge, or check the internet connection and proxy so the runner can download Chromium, then start the runner again.");
    return line("browser", "ok", "Web tests use Chromium");
}

function networkFromCaps(n: Capabilities["network"]): CheckLine {
    const trusts = ["Node.js's own certificates"];
    if (n?.certificates?.includes("system")) trusts.push("this computer's certificate store");
    if (n?.certificates?.includes("file")) trusts.push("a company certificate file");
    if (n?.certificates?.includes("extra")) trusts.push("NODE_EXTRA_CA_CERTS");
    const how = n?.proxy ? `through the proxy ${n.proxy}${n.proxySource ? `, from ${SOURCE_WORDS[n.proxySource]}` : ""}` : "directly, no proxy";
    return line("network", "ok", `Network: connects ${how}; trusts ${trusts.join(", ")}`);
}

function phoneFromCaps(c: Capabilities): CheckLine {
    if (c.android?.adb) return phoneLine({ adb: true, policy: "auto" });
    const t = c.phoneTools;
    if (t?.state === "ready") return phoneLine({ adb: false, ...(t.version ? { own: t.version } : {}), policy: "auto" });
    if (t?.state === "unsupported") return phoneLine({ adb: false, policy: "auto", unsupported: t.note ?? "Google has no phone tools for this computer." });
    if (t?.state === "fetching") return line("phone", "optional", "The runner is getting the Android phone tools from Google");
    if (t?.state === "failed") return line("phone", "optional", (t.note ?? "The Android phone tools could not be fetched").replace(/\.$/, ""), "Check the internet connection or proxy; the runner tries again when a phone test needs them.");
    return phoneLine({ adb: false, policy: t ? "auto" : "off" });
}

/** What the runner sends with its hello and polls (client.ts): its start-up check plus the lines read from its capabilities. Undefined before the start-up check. */
export function runnerCheckReport(c: Capabilities): RunnerCheck | undefined {
    if (!startup) return undefined;
    const [node, ...rest] = startup.lines;
    const mac = rest.filter((l) => l.id.startsWith("mac-"));
    const local = rest.filter((l) => !l.id.startsWith("mac-") && l.id !== "disk");
    const disk = rest.filter((l) => l.id === "disk");
    const items: RunnerCheckItem[] = [
        ...(node ? [node] : []),
        ...local,
        forPlatform(browserFromCaps(c)),
        forPlatform(enginesLine(c.browsers)),
        forPlatform(networkFromCaps(c.network)),
        ...disk,
        ...(clock ? [clock] : []),
        forPlatform(phoneFromCaps(c)),
        ...mac,
    ];
    const parsed = RunnerCheck.safeParse({ at: startup.at, items });
    return parsed.success ? parsed.data : undefined;
}
