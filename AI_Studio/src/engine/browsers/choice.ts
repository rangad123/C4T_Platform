/**
 * Which browser a runner uses for web tests: the Chromium that Playwright downloads for itself, or the Google Chrome or Microsoft
 * Edge the computer already has (see docs/features/runner-browsers.md).
 *
 * Everything here is found by looking at files, never at running programs:
 *  - an installed Chrome or Edge is found at the usual install paths of each system (the same places Playwright's own `channel`
 *    lookup uses, plus the /usr/bin names Linux packages add), in that order;
 *  - its version comes from the file system where the system keeps one: on Windows the version-numbered folder next to the program
 *    (`Application\155.0.4283.62\`), on a Mac the app's `Contents/Info.plist`. Only on Linux, which keeps neither, the program itself is
 *    asked (`--version`, a few seconds at most; it prints and exits without opening a window). On Windows the program is never run:
 *    `chrome.exe --version` may open a browser window there.
 *  - Playwright's own Chromium counts as present when the folders of the revision this Playwright expects are complete
 *    (`chromium-<rev>` and `chromium_headless_shell-<rev>` with Playwright's INSTALLATION_COMPLETE marker).
 *
 * Pure decisions (`chooseBrowser`, `judge`) are separate from the file lookups so the order and the age rule are tested on their own.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export type InstalledName = "chrome" | "msedge";
/** A Chromium-family browser web tests can run in. */
export type WebBrowserName = "chromium" | InstalledName;
export type EngineName = "firefox" | "webkit";

/**
 * How a run opens an installed Chrome or Edge: Playwright's `channel` plus the exact program that was found (the program wins, so the run
 * does not depend on the test process seeing the same environment variables as the runner). Absent: Playwright's own Chromium.
 */
export interface BrowserLaunch {
    channel?: InstalledName;
    executablePath?: string;
}

export const BROWSER_POLICIES = ["auto", "bundled", "chrome", "msedge"] as const;
export type BrowserPolicy = (typeof BROWSER_POLICIES)[number];

export const BROWSER_LABEL: Record<WebBrowserName | EngineName, string> = { chromium: "Chromium", chrome: "Google Chrome", msedge: "Microsoft Edge", firefox: "Firefox", webkit: "WebKit" };

/**
 * The age rule: an installed Chrome or Edge may be at most this many major versions older than the Chromium this Playwright ships with.
 * Playwright drives Chrome through the DevTools protocol of its own Chromium; Microsoft supports the current stable and beta channels,
 * which are normally within a version or two of it. Three gives a computer that updates a little late some room; anything older is
 * skipped with a plain reason. Newer versions are always accepted (stable Chrome is often ahead of Playwright's Chromium).
 */
export const MAX_MAJORS_BEHIND = 3;

export function isBrowserPolicy(v: string): v is BrowserPolicy {
    return (BROWSER_POLICIES as readonly string[]).includes(v);
}

/** An environment variable, ignoring case (a copied Windows environment keeps names like `ProgramFiles(x86)` and `LOCALAPPDATA` as they were). */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
    if (env[name] !== undefined) return env[name];
    const want = name.toUpperCase();
    for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === want) return v;
    return undefined;
}

const WIN_SUFFIX: Record<InstalledName, string[]> = { chrome: ["Google", "Chrome", "Application", "chrome.exe"], msedge: ["Microsoft", "Edge", "Application", "msedge.exe"] };
const MAC_APP: Record<InstalledName, string> = { chrome: "Google Chrome.app/Contents/MacOS/Google Chrome", msedge: "Microsoft Edge.app/Contents/MacOS/Microsoft Edge" };
const LINUX_PATHS: Record<InstalledName, string[]> = {
    chrome: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"],
    msedge: ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge-stable", "/usr/bin/microsoft-edge"],
};

/**
 * Where a stable Chrome or Edge is normally installed, in the order they are tried. `root` stands for "/" on a Mac or Linux (a test lays
 * fake installs out under a temporary folder); on Windows the folders come from the environment (LOCALAPPDATA, ProgramFiles,
 * ProgramFiles(x86), and HOMEDRIVE as Playwright's own lookup does).
 */
export function candidatePaths(name: InstalledName, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, root = "/"): string[] {
    if (platform === "win32") {
        const drive = envValue(env, "HOMEDRIVE");
        const prefixes = [envValue(env, "LOCALAPPDATA"), envValue(env, "PROGRAMFILES"), envValue(env, "PROGRAMFILES(X86)"), drive ? `${drive}\\Program Files` : undefined, drive ? `${drive}\\Program Files (x86)` : undefined].filter((p): p is string => Boolean(p?.trim()));
        // Joined with this computer's own separator (on Windows that is the Windows one), so a test can lay the same folders out anywhere.
        return [...new Set(prefixes.map((p) => path.join(p, ...WIN_SUFFIX[name])))];
    }
    if (platform === "darwin") {
        const home = envValue(env, "HOME");
        return [path.posix.join(root, "Applications", MAC_APP[name]), ...(home ? [path.posix.join(home, "Applications", MAC_APP[name])] : [])];
    }
    return LINUX_PATHS[name].map((p) => path.posix.join(root, p));
}

/** Compare two dotted version strings numerically ("155.0.10.1" > "155.0.9.99"). */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

export const majorOf = (version: string | undefined): number | undefined => {
    const m = /^(\d{1,4})\./.exec(version ?? "");
    return m ? Number(m[1]) : undefined;
};

/** The version in a line such as "Google Chrome 131.0.6778.85" or "Microsoft Edge 131.0.2903.70 ". */
export function parseVersionOutput(text: string): string | undefined {
    return /\b(\d{2,4}\.\d+\.\d+(?:\.\d+)?)\b/.exec(text)?.[1];
}

/** CFBundleShortVersionString of an app's Info.plist (XML form, as Chrome and Edge ship it). */
export function parsePlistVersion(text: string): string | undefined {
    const m = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([0-9.]{1,40})\s*<\/string>/.exec(text);
    return m?.[1];
}

/** Runs a short command and gives back its output, or undefined (missing, failed, too slow). */
export type VersionExec = (file: string, args: string[], timeoutMs: number) => Promise<string | undefined>;

/**
 * The version of an installed browser, from the file system where possible (see the top of this file). Undefined when it cannot be told.
 * `exec` is used only on Linux, and on a Mac whose app has no readable Info.plist.
 */
export async function readInstalledVersion(file: string, platform: NodeJS.Platform, exec?: VersionExec): Promise<string | undefined> {
    if (platform === "win32") {
        let best: string | undefined;
        try {
            for (const e of fs.readdirSync(path.dirname(file), { withFileTypes: true })) {
                if (e.isDirectory() && /^\d{1,4}\.\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(e.name) && (!best || compareVersions(e.name, best) > 0)) best = e.name;
            }
        } catch {
            return undefined;
        }
        return best;
    }
    if (platform === "darwin") {
        try {
            const plist = path.join(path.dirname(path.dirname(file)), "Info.plist");
            if (fs.statSync(plist).size < 1024 * 1024) {
                const v = parsePlistVersion(fs.readFileSync(plist, "utf8"));
                if (v) return v;
            }
        } catch {
            /* no plist: ask the program below */
        }
    }
    if (!exec) return undefined;
    const out = await exec(file, ["--version"], 5000);
    return out ? parseVersionOutput(out.slice(0, 400)) : undefined;
}

export interface FoundBrowser {
    name: InstalledName;
    /** Where it was found. Stays on this computer: never sent to the platform. */
    path: string;
    version?: string;
    usable: boolean;
    /** Why it is not used (plain words), when it is not usable. */
    reason?: string;
}

/** The Chromium this Playwright ships with: its revision (the folder name) and its version. Undefined when Playwright cannot be read. */
export function bundledChromium(): { revision: string; version: string; major: number } | undefined {
    try {
        const require = createRequire(import.meta.url);
        const file = path.join(path.dirname(require.resolve("playwright-core/package.json")), "browsers.json");
        const list = (JSON.parse(fs.readFileSync(file, "utf8")) as { browsers: Array<{ name: string; revision: string; browserVersion?: string }> }).browsers;
        const c = list.find((b) => b.name === "chromium");
        const major = majorOf(c?.browserVersion);
        return c && c.browserVersion && major !== undefined ? { revision: c.revision, version: c.browserVersion, major } : undefined;
    } catch {
        return undefined;
    }
}

/** Is a found browser recent enough? (the age rule above). */
export function judge(name: InstalledName, file: string, version: string | undefined, bundledMajor: number | undefined): FoundBrowser {
    const major = majorOf(version);
    const label = BROWSER_LABEL[name];
    if (major === undefined) return { name, path: file, usable: false, reason: `${label} was found, but its version could not be read, so the runner does not rely on it` };
    if (bundledMajor !== undefined && major < bundledMajor - MAX_MAJORS_BEHIND) {
        return { name, path: file, version, usable: false, reason: `${label} ${major} is too old: the test tools need version ${bundledMajor - MAX_MAJORS_BEHIND} or newer (at most ${MAX_MAJORS_BEHIND} versions behind their own Chromium ${bundledMajor}). Update ${label} to use it` };
    }
    return { name, path: file, version, usable: true };
}

export interface FindOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    root?: string;
    exec?: VersionExec;
    bundledMajor?: number;
}

/** The installed stable Chrome and Edge (each at most once: the first install path that exists), judged by the age rule. */
export async function findInstalledBrowsers(o: FindOptions = {}): Promise<FoundBrowser[]> {
    const platform = o.platform ?? process.platform;
    const env = o.env ?? process.env;
    const out: FoundBrowser[] = [];
    for (const name of ["chrome", "msedge"] as const) {
        const file = candidatePaths(name, platform, env, o.root).find((p) => {
            try {
                return fs.statSync(p).isFile();
            } catch {
                return false;
            }
        });
        if (!file) continue;
        out.push(judge(name, file, await readInstalledVersion(file, platform, o.exec), o.bundledMajor));
    }
    return out;
}

/** Playwright's own Chromium of `revision` is complete in `dir` (both the full browser, for windows people watch, and the headless shell). */
export function bundledReady(dir: string, revision: string | undefined): boolean {
    if (!dir || !revision) return false;
    return ["chromium", "chromium_headless_shell"].every((f) => fs.existsSync(path.join(dir, `${f}-${revision}`, "INSTALLATION_COMPLETE")));
}

/** "Microsoft Edge 155, installed on this computer" (the runner's window; the web UI says the same in web/src/features/agents/agents.ts). */
export function describeBrowser(b: { name: WebBrowserName; version?: string; source: "installed" | "downloaded" | "bundled" }, where = "this computer"): string {
    const major = majorOf(b.version);
    const name = `${BROWSER_LABEL[b.name]}${major !== undefined ? ` ${major}` : ""}`;
    if (b.source === "installed") return `${name}, installed on ${where}`;
    if (b.source === "downloaded") return `${name}, downloaded by the runner`;
    return `${name}, the browser that comes with the test tools`;
}

export type Decision =
    | { use: "bundled" }
    | { use: "installed"; browser: FoundBrowser }
    | { use: "download" }
    /** An explicit choice (chrome or msedge) that this computer cannot satisfy: nothing is used instead, the person decides. */
    | { use: "none"; reason: string };

/**
 * The policy, in one place:
 *  - auto:    Playwright's Chromium if it is already here, else installed Chrome, else installed Edge, else download Playwright's Chromium.
 *  - bundled: Playwright's Chromium, downloaded when missing (installed browsers are never used).
 *  - chrome / msedge: that installed browser; when it is missing or too old the runner says so and does not quietly use another one.
 */
export function chooseBrowser(policy: BrowserPolicy, state: { bundledReady: boolean; installed: FoundBrowser[] }): Decision {
    const usable = (n: InstalledName) => state.installed.find((b) => b.name === n && b.usable);
    if (policy === "bundled") return state.bundledReady ? { use: "bundled" } : { use: "download" };
    if (policy === "chrome" || policy === "msedge") {
        const b = usable(policy);
        if (b) return { use: "installed", browser: b };
        const found = state.installed.find((x) => x.name === policy);
        const label = BROWSER_LABEL[policy];
        return { use: "none", reason: found?.reason ? `${found.reason}.` : `${label} is not installed on this computer (looked in the usual install folders).` };
    }
    if (state.bundledReady) return { use: "bundled" };
    const b = usable("chrome") ?? usable("msedge");
    return b ? { use: "installed", browser: b } : { use: "download" };
}
