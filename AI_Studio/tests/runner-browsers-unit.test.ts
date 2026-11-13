/**
 * Which browser a runner uses for web tests, without opening one (fast tier): the install paths per system, versions read from the file
 * system (Windows version folders, a Mac app's Info.plist) or from a fake browser that answers --version (Linux), the age rule, the policy
 * order, the setting (flag beats AITP_BROWSER beats runner.json), the run's Playwright config with an installed browser (and unchanged
 * without one), the capabilities, and the runner's own decision against fake installs laid out under a temporary folder.
 *
 * Nothing here looks at running programs or at this laptop's real browsers: every folder the lookup sees comes from the environment the test
 * passes (LOCALAPPDATA, ProgramFiles, ProgramFiles(x86), HOMEDRIVE, HOME, PLAYWRIGHT_BROWSERS_PATH) or from a temporary root. No ports.
 */
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBrowserReport, execText } from "../src/agent/capabilities.js";
import { BrowserSetup, enginesOf, failureReason, hideCredentials } from "../src/agent/browser-setup.js";
import { parseAgentArgs } from "../src/agent/config.js";
import { applyKitDefaults } from "../src/agent/kit.js";
import { memoryLogger } from "../src/agent/log.js";
import { Capabilities, ResultRequest } from "../src/agent-protocol/schema.js";
import { bundledChromium, candidatePaths, chooseBrowser, describeBrowser, ffmpegReady, findInstalledBrowsers, judge, MAX_MAJORS_BEHIND, parsePlistVersion, parseVersionOutput, readInstalledVersion, type FoundBrowser } from "../src/engine/browsers/choice.js";
import { configFor } from "../src/engine/validation/runner.js";

const TOKEN = "aitg_BrowserUnitToken0123456789abcdefghij";
let tmp: string;
const bundled = bundledChromium()!;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-browsers-unit-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const fresh = (label: string) => {
    const d = path.join(tmp, `${label}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
};
const touch = (file: string, text = "fake") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
};
/** A Windows install the way Chrome and Edge lay theirs out: the program, and next to it a folder named after the version. */
const layWin = (prefix: string, name: "chrome" | "msedge", version?: string) => {
    const app = name === "chrome" ? path.join(prefix, "Google", "Chrome", "Application") : path.join(prefix, "Microsoft", "Edge", "Application");
    const exe = touch(path.join(app, name === "chrome" ? "chrome.exe" : "msedge.exe"));
    if (version) fs.mkdirSync(path.join(app, version), { recursive: true });
    fs.mkdirSync(path.join(app, "SetupMetrics"), { recursive: true }); // not a version: ignored
    return exe;
};
/** A fake browser program for Linux: a script that answers --version like the real one. Run through Node here (Windows cannot run a shebang file). */
const fakeBrowser = (file: string, line: string) => touch(file, `if (process.argv.includes("--version")) console.log(${JSON.stringify(line)}); else process.exit(3);\n`);
const viaNode = (file: string, args: string[], ms: number) => execText(process.execPath, [file, ...args], ms);
const winEnv = (root: string) => ({ LOCALAPPDATA: path.join(root, "local"), ProgramFiles: path.join(root, "pf"), "ProgramFiles(x86)": path.join(root, "pf86"), HOMEDRIVE: path.join(root, "drive") });
/** Playwright's own Chromium of the expected revision, complete (the folders and the marker Playwright writes). */
const layBundled = (dir: string) => {
    for (const f of ["chromium", "chromium_headless_shell"]) touch(path.join(dir, `${f}-${bundled.revision}`, "INSTALLATION_COMPLETE"), "");
    return dir;
};

describe("where installed browsers are looked for", () => {
    it("Windows: the per-user folder first, then Program Files, Program Files (x86) and the drive's own folders, as Playwright's channel lookup does", () => {
        const root = fresh("paths");
        const p = candidatePaths("msedge", "win32", { localappdata: path.join(root, "L"), PROGRAMFILES: path.join(root, "P"), "PROGRAMFILES(X86)": path.join(root, "X"), HOMEDRIVE: "C:" });
        expect(p.slice(0, 3)).toEqual([path.join(root, "L", "Microsoft", "Edge", "Application", "msedge.exe"), path.join(root, "P", "Microsoft", "Edge", "Application", "msedge.exe"), path.join(root, "X", "Microsoft", "Edge", "Application", "msedge.exe")]);
        expect(p.slice(3)).toEqual([path.join("C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"), path.join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")]);
        expect(candidatePaths("chrome", "win32", {})).toEqual([]);
    });
    it("Mac: /Applications, then the person's own Applications folder; Linux: /opt, then the /usr/bin names packages add", () => {
        expect(candidatePaths("chrome", "darwin", { HOME: "/Users/maya" }, "/")).toEqual(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Users/maya/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
        expect(candidatePaths("msedge", "linux", {}, "/")).toEqual(["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge-stable", "/usr/bin/microsoft-edge"]);
        expect(candidatePaths("chrome", "linux", {}, "/r")).toEqual(["/r/opt/google/chrome/chrome", "/r/usr/bin/google-chrome-stable", "/r/usr/bin/google-chrome"]);
    });
});

describe("reading the version without starting the browser", () => {
    it("Windows: the newest version folder next to the program; the program itself is never run", async () => {
        const root = fresh("winver");
        const exe = layWin(root, "chrome", "131.0.6778.85");
        fs.mkdirSync(path.join(path.dirname(exe), "131.0.6778.109"));
        fs.mkdirSync(path.join(path.dirname(exe), "99.0.1.2"));
        let ran = false;
        const exec = async () => ((ran = true), "Google Chrome 1.0.0.0");
        expect(await readInstalledVersion(exe, "win32", exec)).toBe("131.0.6778.109");
        const bare = touch(path.join(fresh("winbare"), "Microsoft", "Edge", "Application", "msedge.exe"));
        expect(await readInstalledVersion(bare, "win32", exec)).toBeUndefined();
        expect(ran).toBe(false);
    });
    it("Mac: CFBundleShortVersionString of the app; without a plist the program is asked for --version", async () => {
        const root = fresh("mac");
        const exe = touch(path.join(root, "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"));
        touch(path.join(root, "Applications", "Microsoft Edge.app", "Contents", "Info.plist"), `<?xml version="1.0"?><plist><dict>\n<key>CFBundleName</key><string>Microsoft Edge</string>\n<key>CFBundleShortVersionString</key>\n\t<string>131.0.2903.70</string></dict></plist>`);
        expect(await readInstalledVersion(exe, "darwin")).toBe("131.0.2903.70");
        const noPlist = fakeBrowser(path.join(fresh("mac2"), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"), "Google Chrome 130.0.6723.117 ");
        expect(await readInstalledVersion(noPlist, "darwin", viaNode)).toBe("130.0.6723.117");
        expect(parsePlistVersion("<key>CFBundleVersion</key><string>1</string>")).toBeUndefined();
    });
    it("Linux: the fake browser's own --version answer", async () => {
        const exe = fakeBrowser(path.join(fresh("linux"), "opt", "google", "chrome", "chrome"), "Google Chrome 131.0.6778.85 ");
        expect(await readInstalledVersion(exe, "linux", viaNode)).toBe("131.0.6778.85");
        expect(parseVersionOutput("Microsoft Edge 131.0.2903.70 beta")).toBe("131.0.2903.70");
        expect(parseVersionOutput("Chromium 129.0.6668.58 snap")).toBe("129.0.6668.58");
        expect(parseVersionOutput("nothing here")).toBeUndefined();
        // A program that does not answer (or fails) gives no version.
        expect(await readInstalledVersion(touch(path.join(fresh("linux2"), "chrome"), "process.exit(2)"), "linux", viaNode)).toBeUndefined();
    });
});

describe("the age rule", () => {
    it(`accepts at most ${MAX_MAJORS_BEHIND} major versions behind Playwright's own Chromium, any newer one, and refuses an unreadable version`, () => {
        const b = bundled.major;
        expect(b).toBeGreaterThan(100);
        expect(judge("chrome", "x", `${b - MAX_MAJORS_BEHIND}.0.1.2`, b).usable).toBe(true);
        expect(judge("chrome", "x", `${b + 5}.0.1.2`, b).usable).toBe(true);
        const old = judge("msedge", "x", `${b - MAX_MAJORS_BEHIND - 1}.0.1.2`, b);
        expect(old.usable).toBe(false);
        expect(old.reason).toBe(`Microsoft Edge ${b - MAX_MAJORS_BEHIND - 1} is too old: the test tools need version ${b - MAX_MAJORS_BEHIND} or newer (at most ${MAX_MAJORS_BEHIND} versions behind their own Chromium ${b}). Update Microsoft Edge to use it`);
        expect(judge("chrome", "x", undefined, b)).toMatchObject({ usable: false, reason: "Google Chrome was found, but its version could not be read, so the runner does not rely on it" });
    });
});

describe("the policy", () => {
    const chrome = (usable: boolean): FoundBrowser => ({ name: "chrome", path: "/c", version: "150.0.0.0", usable, ...(usable ? {} : { reason: "Google Chrome 120 is too old" }) });
    const edge: FoundBrowser = { name: "msedge", path: "/e", version: "155.0.0.0", usable: true };
    it("auto: Playwright's Chromium if it is here, else Chrome, else Edge, else download", () => {
        expect(chooseBrowser("auto", { bundledReady: true, installed: [chrome(true), edge] })).toEqual({ use: "bundled" });
        expect(chooseBrowser("auto", { bundledReady: false, installed: [chrome(true), edge] })).toEqual({ use: "installed", browser: chrome(true) });
        expect(chooseBrowser("auto", { bundledReady: false, installed: [chrome(false), edge] })).toEqual({ use: "installed", browser: edge });
        expect(chooseBrowser("auto", { bundledReady: false, installed: [chrome(false)] })).toEqual({ use: "download" });
        expect(chooseBrowser("auto", { bundledReady: false, installed: [] })).toEqual({ use: "download" });
    });
    it("bundled never uses an installed browser; chrome and msedge use only that one and say why not", () => {
        expect(chooseBrowser("bundled", { bundledReady: false, installed: [edge] })).toEqual({ use: "download" });
        expect(chooseBrowser("bundled", { bundledReady: true, installed: [] })).toEqual({ use: "bundled" });
        expect(chooseBrowser("msedge", { bundledReady: true, installed: [chrome(true), edge] })).toEqual({ use: "installed", browser: edge });
        expect(chooseBrowser("chrome", { bundledReady: true, installed: [chrome(false), edge] })).toEqual({ use: "none", reason: "Google Chrome 120 is too old." });
        expect(chooseBrowser("msedge", { bundledReady: true, installed: [] })).toEqual({ use: "none", reason: "Microsoft Edge is not installed on this computer (looked in the usual install folders)." });
    });
    it("finds fake installs under the folders the environment names, each at the first place that has it", async () => {
        const root = fresh("find");
        const env = winEnv(root);
        layWin(env.ProgramFiles, "chrome", "120.0.6099.71");
        layWin(env["ProgramFiles(x86)"], "msedge", "155.0.4283.62");
        layWin(env.HOMEDRIVE + "\\Program Files (x86)", "msedge", "160.0.1.1"); // a later place: not used
        const found = await findInstalledBrowsers({ platform: "win32", env, bundledMajor: 153 });
        expect(found.map((f) => [f.name, f.version, f.usable])).toEqual([["chrome", "120.0.6099.71", false], ["msedge", "155.0.4283.62", true]]);
        expect(found[1]!.path).toBe(path.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"));
        const linuxRoot = fresh("findlinux");
        fakeBrowser(path.join(linuxRoot, "usr", "bin", "microsoft-edge-stable"), "Microsoft Edge 154.0.1.2");
        expect((await findInstalledBrowsers({ platform: "linux", env: {}, root: linuxRoot, exec: viaNode, bundledMajor: 153 })).map((f) => [f.name, f.version, f.usable])).toEqual([["msedge", "154.0.1.2", true]]);
    });
});

describe("the browser setting", () => {
    const base = ["--url", "http://127.0.0.1:9", "--token", TOKEN];
    it("comes from --browser, else AITP_BROWSER, else runner.json; anything else is a plain usage error", () => {
        const cfg = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseAgentArgs([...base, ...argv], env);
        expect(cfg([])).toMatchObject({ kind: "run" });
        expect((cfg([]) as { config: { browser?: string } }).config.browser).toBeUndefined();
        expect(cfg(["--browser", "msedge"])).toMatchObject({ kind: "run", config: { browser: "msedge" } });
        expect(cfg([], { AITP_BROWSER: "Chrome" })).toMatchObject({ kind: "run", config: { browser: "chrome" } });
        expect(cfg(["--browser", "bundled"], { AITP_BROWSER: "chrome" })).toMatchObject({ kind: "run", config: { browser: "bundled" } });
        expect(cfg(["--browser", "safari"])).toEqual({ kind: "error", message: "--browser must be one of auto, bundled, chrome, msedge." });
        expect(cfg([], { AITP_BROWSER: "firefox" })).toEqual({ kind: "error", message: "AITP_BROWSER must be one of auto, bundled, chrome, msedge." });
    });
    it("runner.json's browser fills AITP_BROWSER only when it is not set; a value it does not know is refused in plain words", () => {
        const dir = fresh("kit");
        fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ url: "https://tests.example.com", name: "Maya", browser: "msedge" }));
        expect((applyKitDefaults({}, dir) as { env: NodeJS.ProcessEnv }).env.AITP_BROWSER).toBe("msedge");
        expect((applyKitDefaults({ AITP_BROWSER: "chrome" }, dir) as { env: NodeJS.ProcessEnv }).env.AITP_BROWSER).toBe("chrome");
        fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ url: "https://tests.example.com", name: "Maya", browser: "opera" }));
        expect(applyKitDefaults({}, dir)).toEqual({ kit: "broken", message: 'runner.json has a "browser" the runner does not know. Use "auto", "bundled", "chrome" or "msedge", or remove the line.' });
        fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ url: "https://tests.example.com", name: "Maya" }));
        expect((applyKitDefaults({}, dir) as { env: NodeJS.ProcessEnv }).env.AITP_BROWSER).toBeUndefined();
    });
});

describe("the run's Playwright config", () => {
    const edge = { channel: "msedge" as const, executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" };
    const projects = [
        { name: "firefox", device: "Desktop Firefox" },
        { name: "mobile-chrome", device: "Pixel 7", viewport: { width: 390, height: 844 } },
    ];
    it("is exactly today's config without an installed browser", () => {
        expect(configFor([], undefined, undefined)).toBe(configFor([]));
        expect(configFor(projects, 90_000, {})).toBe(configFor(projects, 90_000));
    });
    it("names the channel and the exact program for Chromium tests, and leaves Firefox and WebKit variants on their own engine", () => {
        const plain = configFor([], undefined, edge);
        expect(plain).toContain(`    use: {\n        channel: "msedge", launchOptions: { executablePath: "C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe" },\n        headless:`);
        expect(plain.replace(/        channel: [^\n]+\n/, "")).toBe(configFor([]));
        const variants = configFor(projects, undefined, edge);
        expect(variants).toContain(`{ name: "firefox", use: { ...devices["Desktop Firefox"], ...(devices["Desktop Firefox"]?.defaultBrowserType === "firefox" || devices["Desktop Firefox"]?.defaultBrowserType === "webkit" ? {} : { channel: "msedge", launchOptions:`);
        // Only the projects carry it: the shared `use` block stays as it was, so a Firefox project never inherits a Chromium channel.
        expect(variants.split("projects: [")[1]!.split("    ],")[1]).toBe(configFor(projects).split("projects: [")[1]!.split("    ],")[1]);
    });
    it("keeps no failure video when the computer has no video tool, instead of failing every test at its first page", () => {
        const noVideo = configFor([], undefined, { ...edge, video: false });
        expect(noVideo).toContain('video: "off",');
        expect(noVideo).not.toContain('video: { mode: "retain-on-failure"');
        expect(noVideo).toContain('trace: { mode: "retain-on-failure-and-retries"'); // traces need no video tool
        expect(noVideo.replace('video: "off",', () => 'video: { mode: "retain-on-failure", show: { actions: {}, test: { level: "step" } } },')).toBe(configFor([], undefined, edge));
        expect(configFor(projects, undefined, { ...edge, video: false })).toContain('video: "off",');
        // With the tool there (or no installed browser at all) videos are kept as before.
        expect(configFor([], undefined, { ...edge, video: true })).toBe(configFor([], undefined, edge));
        expect(configFor([])).toContain('video: { mode: "retain-on-failure", show: { actions: {}, test: { level: "step" } } },');
    });
    it("finds Playwright's video tool only where Playwright keeps a finished install of it", () => {
        const dir = fresh("ffmpeg");
        expect(ffmpegReady(dir)).toBe(false);
        expect(ffmpegReady("")).toBe(false);
        const rev = (JSON.parse(fs.readFileSync(path.join(path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "browsers.json"), "utf8")) as { browsers: Array<{ name: string; revision: string }> }).browsers.find((b) => b.name === "ffmpeg")!.revision;
        fs.mkdirSync(path.join(dir, `ffmpeg-${rev}`), { recursive: true });
        expect(ffmpegReady(dir)).toBe(false); // half downloaded
        fs.writeFileSync(path.join(dir, `ffmpeg-${rev}`, "INSTALLATION_COMPLETE"), "");
        expect(ffmpegReady(dir)).toBe(true);
    });
    it("knows which engines a run on other browsers needs", async () => {
        expect(await enginesOf([])).toEqual({ chromium: true, engines: [] });
        expect(await enginesOf([{ device: "Desktop Firefox" }, { device: "Desktop Safari" }, { device: "Pixel 7" }])).toEqual({ chromium: true, engines: ["firefox", "webkit"] });
        expect(await enginesOf([{ device: "iPhone 15" }])).toEqual({ chromium: false, engines: ["webkit"] });
    });
});

describe("what the runner reports", () => {
    const caps = (browsers: Capabilities["browsers"]): Capabilities => ({ os: "win32", arch: "x64", node: "v24.0.0", browsers });
    it("an installed Chrome or Edge counts as a Chromium; a setting the computer cannot meet does not; nothing carries a path", () => {
        const c = caps(["firefox"]);
        applyBrowserReport(c, { browser: { name: "msedge", version: "155.0.4283.62", source: "installed" }, installed: [{ name: "msedge", version: "155.0.4283.62", usable: true }], chromium: "ready" });
        expect(c).toMatchObject({ browsers: ["chromium", "firefox"], browser: { name: "msedge", source: "installed" }, installedBrowsers: [{ name: "msedge", usable: true }] });
        expect(Capabilities.safeParse(c).success).toBe(true);
        const m = caps(["chromium", "webkit"]);
        applyBrowserReport(m, { installed: [], note: "Google Chrome is not installed on this computer (looked in the usual install folders).", chromium: "missing" });
        expect(m.browsers).toEqual(["webkit"]);
        expect(m.browserNote).toMatch(/^Google Chrome is not installed/);
        // A result says which browser web tests used (additive); an older result without it is still valid.
        expect(ResultRequest.safeParse({ ok: true, runs: [], browser: { name: "chrome", version: "131.0.6778.85", source: "installed" } }).success).toBe(true);
        expect(ResultRequest.safeParse({ ok: true, runs: [], browser: { name: "opera", source: "installed" } }).success).toBe(false);
        expect(ResultRequest.safeParse({ ok: true, runs: [] }).success).toBe(true);
    });
    it("says it in plain words", () => {
        expect(describeBrowser({ name: "msedge", version: "155.0.4283.62", source: "installed" })).toBe("Microsoft Edge 155, installed on this computer");
        expect(describeBrowser({ name: "msedge", version: "155.0.4283.62", source: "installed" }, "maya-laptop")).toBe("Microsoft Edge 155, installed on maya-laptop");
        expect(describeBrowser({ name: "chromium", version: "153.0.8010.12", source: "downloaded" })).toBe("Chromium 153, downloaded by the runner");
        expect(describeBrowser({ name: "chromium", source: "bundled" })).toBe("Chromium, the browser that comes with the test tools");
    });
    it("turns Playwright's installer output into one reason, without credentials", () => {
        const out = [
            "Downloading Chrome for Testing 153.0.8010.12 (playwright chromium v1243)\u001b[2m from http://maya:s3cret@proxy.local:3128/builds/cft/x.zip\u001b[22m",
            "Error: Download failed: server returned code 407 body 'Proxy Authentication Required'. URL: http://maya:s3cret@proxy.local:3128/builds/cft/x.zip",
            "    at IncomingMessage.handleError (coreBundle.js:32551:23)",
            "Failed to install browsers",
            "Error: Failed to download Chrome for Testing, caused by",
            "Error: Download failure, code=1",
        ].join("\n");
        const r = failureReason(out);
        expect(r).toMatch(/^Download failed: server returned code 407/);
        expect(r).not.toContain("s3cret");
        expect(hideCredentials("http://u:p@h:1/x and https://a:b@c")).toBe("http://***:***@h:1/x and https://***:***@c");
        expect(failureReason("")).toBe("the installer stopped without saying why");
    });
});

describe("the runner's own decision (no download)", () => {
    const setup = (env: NodeJS.ProcessEnv, policy?: "auto" | "bundled" | "chrome" | "msedge") => {
        const { log, lines } = memoryLogger();
        const workDir = fresh("work");
        // A download must not happen in these tests: an installer that cannot start makes any attempt fail at once.
        const s = new BrowserSetup({ ...(policy ? { policy } : {}), env, log, workDir, platform: "win32", cli: path.join(tmp, "no-such-cli.js") });
        return { s, lines, workDir };
    };
    it("auto uses Playwright's Chromium when it is here, says so, and reports it", async () => {
        const root = fresh("dec1");
        const env = { ...winEnv(root), PLAYWRIGHT_BROWSERS_PATH: layBundled(path.join(root, "pw")) };
        layWin(env["ProgramFiles(x86)"], "msedge", "155.0.4283.62");
        const { s, lines } = setup(env);
        await s.prepare();
        const w = await s.forWeb();
        expect(w).toEqual({ ok: true, browser: { name: "chromium", version: bundled.version, source: "bundled", launch: {} } });
        expect(lines.join("\n")).toContain(`Ready for web tests in Chromium ${bundled.major}, the browser that comes with the test tools.`);
        expect(s.report()).toEqual({ browser: { name: "chromium", version: bundled.version, source: "bundled" }, installed: [{ name: "msedge", version: "155.0.4283.62", usable: true }], chromium: "ready" });
    });
    it("auto uses the installed Edge when Playwright's Chromium is missing and Chrome is too old, with one plain line for the skipped one", async () => {
        const root = fresh("dec2");
        const env = { ...winEnv(root), PLAYWRIGHT_BROWSERS_PATH: path.join(root, "empty") };
        const chromeExe = layWin(env.LOCALAPPDATA, "chrome", "100.0.4896.60");
        const edgeExe = layWin(env["ProgramFiles(x86)"], "msedge", "155.0.4283.62");
        const { s, lines } = setup(env);
        const w = await s.forWeb();
        // No Playwright video tool in that folder: tests run without failure videos rather than not at all, and the runner says so.
        expect(w).toEqual({ ok: true, browser: { name: "msedge", version: "155.0.4283.62", source: "installed", launch: { channel: "msedge", executablePath: edgeExe, video: false } } });
        const text = lines.join("\n");
        expect(text).toContain("Failure videos are off until Playwright's video tool is downloaded");
        expect(text).toContain("Looking for a browser for web tests (setting: auto, the default).");
        expect(text).toContain(`Not using Google Chrome at ${chromeExe}: Google Chrome 100 is too old`);
        expect(text).toContain("Ready for web tests in Microsoft Edge 155, installed on this computer.");
        // The paths stay in the runner's window: the report has none.
        expect(JSON.stringify(s.report())).not.toContain(root.slice(3));
    });
    it("an installed browser keeps failure videos when Playwright's video tool is already on the computer", async () => {
        const root = fresh("dec2v");
        const pw = path.join(root, "empty");
        const rev = (JSON.parse(fs.readFileSync(path.join(path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "browsers.json"), "utf8")) as { browsers: Array<{ name: string; revision: string }> }).browsers.find((b) => b.name === "ffmpeg")!.revision;
        fs.mkdirSync(path.join(pw, `ffmpeg-${rev}`), { recursive: true });
        fs.writeFileSync(path.join(pw, `ffmpeg-${rev}`, "INSTALLATION_COMPLETE"), "");
        const env = { ...winEnv(root), PLAYWRIGHT_BROWSERS_PATH: pw };
        const edgeExe = layWin(env["ProgramFiles(x86)"], "msedge", "155.0.4283.62");
        const { s, lines } = setup(env);
        expect(await s.forWeb()).toEqual({ ok: true, browser: { name: "msedge", version: "155.0.4283.62", source: "installed", launch: { channel: "msedge", executablePath: edgeExe } } });
        expect(lines.join("\n")).not.toContain("Failure videos are off");
    });
    it("fetches the video tool from the system's temporary folder, so a download still going never holds the runner's folder", async () => {
        const root = fresh("dec2cwd");
        const env = { ...winEnv(root), PLAYWRIGHT_BROWSERS_PATH: path.join(root, "empty") };
        layWin(env["ProgramFiles(x86)"], "msedge", "155.0.4283.62");
        // A stand-in for Playwright's installer: it writes where it was started, and what it was asked for, then fails.
        const said = path.join(root, "installer-said.json");
        const cli = touch(path.join(root, "fake-cli.js"), `require("fs").writeFileSync(${JSON.stringify(said)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })); process.exit(1);\n`);
        const { log, lines } = memoryLogger();
        const s = new BrowserSetup({ env, log, workDir: fresh("workcwd"), platform: "win32", cli });
        await s.prepare();
        for (let i = 0; i < 100 && !lines.join("\n").includes("could not be downloaded"); i++) await new Promise((r) => setTimeout(r, 50));
        const run = JSON.parse(fs.readFileSync(said, "utf8")) as { cwd: string; args: string[] };
        expect(run.args).toEqual(["install", "ffmpeg"]);
        expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(os.tmpdir()));
        expect(lines.join("\n")).toContain("Tests still run, without failure videos.");
        s.stop();
    });
    it("a setting of msedge on a computer without Edge uses nothing else and says what to do", async () => {
        const root = fresh("dec3");
        const env = { ...winEnv(root), PLAYWRIGHT_BROWSERS_PATH: layBundled(path.join(root, "pw")) };
        layWin(env.ProgramFiles, "chrome", "150.0.1.1");
        const { s, lines } = setup(env, "msedge");
        const w = await s.forWeb();
        expect(w).toEqual({ ok: false, error: "Microsoft Edge is not installed on this computer (looked in the usual install folders). This runner is set to use only Microsoft Edge (--browser msedge). Install it, or start the runner with --browser auto." });
        expect(lines.join("\n")).toContain("The browser setting is msedge, so the runner does not use another browser.");
        expect(s.report()).toMatchObject({ chromium: "missing", note: "Microsoft Edge is not installed on this computer (looked in the usual install folders)." });
    });
    it("remembers a Chromium the runner downloaded itself, so a later start still says so", async () => {
        const root = fresh("dec4");
        const env = { ...winEnv(root), PLAYWRIGHT_BROWSERS_PATH: layBundled(path.join(root, "pw")) };
        const { s, workDir } = setup(env, "bundled");
        fs.writeFileSync(path.join(workDir, "browser-downloads.json"), JSON.stringify({ chromium: [bundled.revision] }));
        expect(await s.forWeb()).toMatchObject({ ok: true, browser: { name: "chromium", source: "downloaded" } });
    });
});
