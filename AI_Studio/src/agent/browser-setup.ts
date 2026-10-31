/**
 * The runner makes sure it has a browser for web tests (see docs/features/runner-browsers.md and ../engine/browsers/choice.ts).
 *
 * At start (`prepare`, before the runner says it is ready for web tests) it looks for Playwright's own Chromium and for an installed
 * Google Chrome or Microsoft Edge, and picks one by the browser setting (`--browser`, AITP_BROWSER, runner.json `browser`; default auto).
 * When nothing usable is there it downloads Playwright's Chromium in the background, with Playwright's own installer and a time limit; the
 * download honours HTTPS_PROXY and the other proxy variables through the environment. Firefox and WebKit, needed only by "Ran on other
 * browsers" runs, are downloaded when the first such run arrives (`engine`); when they cannot be, that run is a runner problem with a
 * plain sentence, never a failing test.
 *
 * Every step is one plain line in the runner's window. Paths stay in that window: what goes to the platform is the browser's name,
 * version and where it came from.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { BROWSER_LABEL, bundledChromium, bundledReady, chooseBrowser, describeBrowser, findInstalledBrowsers, type BrowserLaunch, type BrowserPolicy, type EngineName, type FoundBrowser, type InstalledName, type VersionExec, type WebBrowserName } from "../engine/browsers/choice.js";
import { detectBrowsers, execText, expectedRevisions, playwrightBrowsersDir } from "./capabilities.js";
import type { Logger } from "./log.js";
import { killTree } from "./task-process.js";

export type { BrowserLaunch };

export interface BrowserInUse {
    name: WebBrowserName;
    version?: string;
    source: "installed" | "downloaded" | "bundled";
    launch: BrowserLaunch;
}

/** What the capabilities report about browsers (additive protocol fields; no paths). */
export interface BrowserReport {
    browser?: { name: WebBrowserName; version?: string; source: BrowserInUse["source"] };
    installed: Array<{ name: InstalledName; version?: string; usable: boolean; reason?: string }>;
    /** A plain sentence while no browser is ready (downloading, or the chosen one is missing). */
    note?: string;
    /** ready: a Chromium-family browser can be used; missing: the setting asks for one this computer does not have; pending: not decided or downloading. */
    chromium: "ready" | "missing" | "pending";
}

/** Longest a browser download may take before it is stopped. */
export const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** Remembers which Chromium revisions this runner downloaded itself (so a later start still says "downloaded by the runner"). */
const MARKER = "browser-downloads.json";
/** Proxy and certificate settings a download needs even if they were exported into this process after the agent's environment was copied. */
const NETWORK_ENV = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_USE_SYSTEM_CA"];

type State = { kind: "idle" } | { kind: "ready"; browser: BrowserInUse } | { kind: "downloading" } | { kind: "missing"; reason: string } | { kind: "failed"; reason: string };

export interface BrowserSetupOptions {
    policy?: BrowserPolicy;
    env: NodeJS.ProcessEnv;
    log: Logger;
    /** The runner's work folder (the download marker lives there). */
    workDir: string;
    platform?: NodeJS.Platform;
    /** Tests: a folder that stands for "/" when looking for installed browsers on a Mac or Linux. */
    root?: string;
    /** How a Linux (or plist-less Mac) browser is asked for its version. Tests replace it. */
    exec?: VersionExec;
    downloadTimeoutMs?: number;
    /** Playwright's command line. Default: the cli.js of the installed playwright-core. */
    cli?: string;
    /** Called when what the runner can offer changed (a download finished or failed), so capabilities are sent again. */
    onChange?: () => void;
}

export { describeBrowser };

/** Hide a user name and password inside any address in a line (a proxy address can carry them). */
export const hideCredentials = (s: string): string => s.replace(/\/\/[^\s/@:]+:[^\s/@]*@/g, "//***:***@");

function playwrightCli(): string {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
}

export class BrowserSetup {
    private state: State = { kind: "idle" };
    private installed: FoundBrowser[] = [];
    private prepared?: Promise<void>;
    private download?: Promise<void>;
    private readonly engines = new Map<EngineName, Promise<{ ok: true } | { ok: false; error: string }>>();
    private readonly children = new Set<ChildProcess>();
    private stopped = false;
    readonly policy: BrowserPolicy;

    constructor(private readonly o: BrowserSetupOptions) {
        this.policy = o.policy ?? "auto";
    }

    private get dir(): string {
        return playwrightBrowsersDir(this.o.env, this.o.platform ?? process.platform);
    }

    /** Decide which browser web tests use; starts a download in the background when one is needed. Resolves once decided (fast). */
    prepare(): Promise<void> {
        this.prepared ??= this.decide();
        return this.prepared;
    }

    private async decide(): Promise<void> {
        const { log } = this.o;
        const bundled = bundledChromium();
        const platform = this.o.platform ?? process.platform;
        log.info(`Looking for a browser for web tests (setting: ${this.policy}${this.policy === "auto" ? ", the default" : ""}).`);
        this.installed = await findInstalledBrowsers({ platform, env: this.o.env, ...(this.o.root ? { root: this.o.root } : {}), exec: this.o.exec ?? execText, ...(bundled ? { bundledMajor: bundled.major } : {}) }).catch(() => []);
        // Installed browsers matter for the auto, chrome and msedge settings; with "bundled" they are only reported.
        if (this.policy !== "bundled") for (const b of this.installed.filter((x) => !x.usable)) log.warn(`Not using ${BROWSER_LABEL[b.name]} at ${b.path}: ${b.reason}.`);
        const ready = bundledReady(this.dir, bundled?.revision);
        const decision = chooseBrowser(this.policy, { bundledReady: ready, installed: this.installed });
        if (decision.use === "bundled") {
            const downloaded = this.downloadedBefore(bundled?.revision);
            this.setReady({ name: "chromium", ...(bundled ? { version: bundled.version } : {}), source: downloaded ? "downloaded" : "bundled", launch: {} });
        } else if (decision.use === "installed") {
            const b = decision.browser;
            this.setReady({ name: b.name, ...(b.version ? { version: b.version } : {}), source: "installed", launch: { channel: b.name, executablePath: b.path } });
        } else if (decision.use === "none") {
            this.state = { kind: "missing", reason: decision.reason };
            log.warn(`${decision.reason} The browser setting is ${this.policy}, so the runner does not use another browser. Install it, or start the runner with --browser auto. Web tests cannot run here until then.`);
        } else {
            this.state = { kind: "downloading" };
            const what = `Chromium${bundled ? ` ${bundled.major}` : ""}`;
            log.info(this.policy === "bundled" ? `Playwright's ${what} is not on this computer yet. Downloading it for web tests (about 150 MB, only once).` : `No usable Google Chrome, Microsoft Edge or Playwright Chromium was found. Downloading ${what} for web tests (about 150 MB, only once).`);
            this.download = this.downloadChromium(bundled);
        }
    }

    private setReady(browser: BrowserInUse): void {
        this.state = { kind: "ready", browser };
        this.o.log.info(`Ready for web tests in ${describeBrowser(browser)}.`);
    }

    /** Was this Chromium revision downloaded by a runner using this work folder? */
    private downloadedBefore(revision: string | undefined): boolean {
        if (!revision) return false;
        try {
            const list = (JSON.parse(fs.readFileSync(path.join(this.o.workDir, MARKER), "utf8")) as { chromium?: unknown }).chromium;
            return Array.isArray(list) && list.includes(revision);
        } catch {
            return false;
        }
    }

    private remember(revision: string): void {
        try {
            fs.mkdirSync(this.o.workDir, { recursive: true });
            fs.writeFileSync(path.join(this.o.workDir, MARKER), JSON.stringify({ chromium: [revision] }));
        } catch {
            /* only changes one word in the run details */
        }
    }

    private async downloadChromium(bundled: ReturnType<typeof bundledChromium>): Promise<void> {
        const r = await this.install("chromium", "Chromium");
        if (this.stopped) return;
        if (r.ok && bundledReady(this.dir, bundled?.revision)) {
            if (bundled) this.remember(bundled.revision);
            this.setReady({ name: "chromium", ...(bundled ? { version: bundled.version } : {}), source: "downloaded", launch: {} });
        } else {
            const reason = r.ok ? "the download finished, but the browser is not where Playwright keeps it" : r.reason;
            this.state = { kind: "failed", reason: `Chromium could not be downloaded (${reason})` };
            this.o.log.error(`Chromium could not be downloaded: ${reason}. Web tests cannot run on this computer yet. Check the internet connection or the proxy settings, or install Google Chrome or Microsoft Edge, then start the runner again.`);
        }
        this.o.onChange?.();
    }

    /**
     * Run Playwright's own installer for one browser, with a time limit. Only the process started here is ever stopped, by its handle.
     * Output is read for a few progress lines and, on failure, the reason.
     */
    private install(what: "chromium" | EngineName, label: string): Promise<{ ok: true } | { ok: false; reason: string }> {
        const { log } = this.o;
        const env: NodeJS.ProcessEnv = {};
        for (const [k, v] of Object.entries(this.o.env)) if (v !== undefined && !k.toUpperCase().startsWith("AITP_")) env[k] = v; // the runner's own settings (the token) stay out
        for (const k of NETWORK_ENV) if (env[k] === undefined && process.env[k] !== undefined) env[k] = process.env[k];
        delete env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
        // A slow line can be given more time (AITP_BROWSER_DOWNLOAD_MINUTES, 1 to 120); the default is 15 minutes.
        const minutes = Number(this.o.env.AITP_BROWSER_DOWNLOAD_MINUTES);
        const limit = this.o.downloadTimeoutMs ?? (Number.isInteger(minutes) && minutes >= 1 && minutes <= 120 ? minutes * 60_000 : DOWNLOAD_TIMEOUT_MS);
        return new Promise((resolve) => {
            let child: ChildProcess;
            try {
                child = spawn(process.execPath, [this.o.cli ?? playwrightCli(), "install", what], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
            } catch (e) {
                resolve({ ok: false, reason: e instanceof Error ? e.message : "the installer could not be started" });
                return;
            }
            this.children.add(child);
            let tail = "";
            let buf = "";
            let shown = 0;
            const read = (d: Buffer) => {
                const text = String(d);
                tail = `${tail}${text}`.slice(-4000);
                buf = `${buf}${text}`.slice(-2000);
                // Progress lines look like "|■■■■     |  40% of 170.3 MiB" (one every 10% when the output is not a terminal).
                for (const m of buf.matchAll(/(\d{1,3})% of ([\d.]+ ?[KMG]i?B)/g)) {
                    const pct = Number(m[1]);
                    if (pct >= 100) continue; // "Downloaded" says that
                    const step = [25, 50, 75].filter((s) => pct >= s).pop() ?? 0;
                    if (step > shown) {
                        shown = step;
                        log.info(`${label} download: ${step}% of ${m[2]}.`);
                    }
                }
                buf = buf.slice(Math.max(0, buf.lastIndexOf("\n")));
            };
            child.stdout?.on("data", read);
            child.stderr?.on("data", read);
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                killTree(child);
            }, limit);
            const done = (code: number | null, error?: Error) => {
                clearTimeout(timer);
                this.children.delete(child);
                if (this.stopped) return resolve({ ok: false, reason: "the runner was stopped" });
                if (timedOut) return resolve({ ok: false, reason: `it took longer than ${limit < 60_000 ? `${Math.round(limit / 1000)} seconds` : `${Math.round(limit / 60_000)} minute${Math.round(limit / 60_000) === 1 ? "" : "s"}`} and was stopped` });
                if (code === 0 && !error) {
                    log.info(`Downloaded ${label}.`);
                    return resolve({ ok: true });
                }
                resolve({ ok: false, reason: error ? error.message : failureReason(tail) });
            };
            child.on("error", (e) => done(null, e));
            child.on("close", (code) => done(code));
        });
    }

    /** The browser web tests use, waiting for a download that is under way. A plain sentence when there is none. */
    async forWeb(): Promise<{ ok: true; browser: BrowserInUse } | { ok: false; error: string }> {
        await this.prepare();
        if (this.download) await this.download;
        const s = this.state;
        if (s.kind === "ready") return { ok: true, browser: s.browser };
        if (s.kind === "missing") return { ok: false, error: `${s.reason} This runner is set to use only ${BROWSER_LABEL[this.policy as InstalledName] ?? this.policy} (--browser ${this.policy}). Install it, or start the runner with --browser auto.` };
        if (s.kind === "failed") return { ok: false, error: `${s.reason}. Web tests cannot run on this computer until a browser is available: check its internet connection or proxy, or install Google Chrome or Microsoft Edge, then start the runner again.` };
        return { ok: false, error: "The runner has not finished setting up its browser." };
    }

    /**
     * Firefox or WebKit for a run on other browsers: used when Playwright's copy is already here, downloaded once otherwise (one download
     * at a time per browser, shared by the runs that wait for it).
     */
    engine(name: EngineName): Promise<{ ok: true } | { ok: false; error: string }> {
        const has = () => detectBrowsers(this.dir, expectedRevisions()).includes(name);
        if (has()) return Promise.resolve({ ok: true });
        const pending = this.engines.get(name);
        if (pending) return pending;
        const label = BROWSER_LABEL[name];
        this.o.log.info(`A run needs ${label}, which is not on this computer yet. Downloading it (only once).`);
        const p = this.install(name, label).then((r): { ok: true } | { ok: false; error: string } => {
            this.engines.delete(name);
            if (r.ok && has()) {
                this.o.onChange?.();
                return { ok: true };
            }
            const why = r.ok ? "the download finished, but the browser is not where Playwright keeps it" : r.reason;
            this.o.log.warn(`${label} could not be downloaded: ${why}.`);
            return { ok: false, error: `This run needs ${label}, and the runner could not download it (${why}). Check this computer's internet connection or proxy, then run it again. Runs in ${this.webLabel()} are not affected.` };
        });
        this.engines.set(name, p);
        return p;
    }

    private webLabel(): string {
        return this.state.kind === "ready" ? BROWSER_LABEL[this.state.browser.name] : "Chromium";
    }

    /** For the capabilities: what is in use, what is installed, and a sentence while nothing is ready. */
    report(): BrowserReport {
        const installed = this.installed.map((b) => ({ name: b.name, ...(b.version ? { version: b.version } : {}), usable: b.usable, ...(b.reason ? { reason: b.reason.slice(0, 200) } : {}) }));
        const s = this.state;
        if (s.kind === "ready") return { browser: { name: s.browser.name, ...(s.browser.version ? { version: s.browser.version } : {}), source: s.browser.source }, installed, chromium: "ready" };
        if (s.kind === "missing") return { installed, note: s.reason.slice(0, 300), chromium: "missing" };
        if (s.kind === "failed") return { installed, note: `${s.reason}.`.slice(0, 300), chromium: "pending" };
        if (s.kind === "downloading") return { installed, note: "The runner is downloading Chromium for web tests.", chromium: "pending" };
        return { installed, chromium: "pending" };
    }

    /** Stop a download that is under way (the runner is stopping). Only the installer this object started is touched. */
    stop(): void {
        this.stopped = true;
        for (const c of this.children) killTree(c);
    }
}

/** A device's browser engine by its name, for when Playwright's device list cannot be read (the platform's own variants use these names). */
const engineByName = (device: string): "chromium" | EngineName => (/firefox/i.test(device) ? "firefox" : /safari|iphone|ipad/i.test(device) ? "webkit" : "chromium");

/**
 * Which engines a run needs: Chromium for a plain run and for Chromium device profiles, Firefox and WebKit for the "Ran on other browsers"
 * variants that use them (by Playwright's own device list, read only when there are variants).
 */
export async function enginesOf(projects: ReadonlyArray<{ device: string }>): Promise<{ chromium: boolean; engines: EngineName[] }> {
    if (projects.length === 0) return { chromium: true, engines: [] };
    let devices: Record<string, { defaultBrowserType?: string }> | undefined;
    try {
        devices = (await import("playwright-core")).devices as Record<string, { defaultBrowserType?: string }>;
    } catch {
        devices = undefined;
    }
    const kinds = new Set(projects.map((p) => {
        const t = devices?.[p.device]?.defaultBrowserType;
        return t === "firefox" || t === "webkit" || t === "chromium" ? t : engineByName(p.device);
    }));
    return { chromium: kinds.has("chromium"), engines: (["firefox", "webkit"] as const).filter((e) => kinds.has(e)) };
}

/** The last line of the installer's output that says what went wrong (credentials in addresses hidden, short). */
export function failureReason(output: string): string {
    const lines = output
        .split(/\r?\n|\r/)
        .map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").replace(/[│║╔╗╚╝═─┌┐└┘|■]/g, " ").replace(/\s+/g, " ").trim())
        .filter((l) => l && !/% of /.test(l) && !/^at /.test(l) && !/<3 Playwright Team/.test(l));
    const latest = (re: RegExp) => [...lines].reverse().find((l) => re.test(l));
    // The line that names the cause (a server answer, a network error) beats Playwright's closing summary ("Failed to install browsers").
    const telling = latest(/Download failed|server returned|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|certificate|self[- ]signed|proxy|socket|\b40[37]\b/i) ?? latest(/error|fail|refused|timed? ?out/i) ?? lines[lines.length - 1];
    return hideCredentials((telling ?? "the installer stopped without saying why").replace(/^Error:\s*/, "")).slice(0, 240);
}
