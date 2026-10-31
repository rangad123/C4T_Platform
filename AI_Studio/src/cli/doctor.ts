/**
 * `npm run doctor`: a preflight check for a new machine. It answers "can this computer run the platform, and which optional
 * test kinds will work?" in plain sentences, each with what the thing is for and how to fix it.
 *
 * Safety rules, kept on purpose:
 *  - It starts no browser, emulator, simulator or server. The only thing it does beyond reading is to bind the configured port
 *    for a moment, and to create and remove one temp file inside the data folder.
 *  - It never prints a setting's value, only whether it is set. It does not read `.env` at all (the npm script lets Node load it
 *    into the environment, as for the other scripts); it only asks whether the file exists.
 *  - Every check is a pure function of `Probes`, so tests can feed a fake computer. `realProbes()` is the only code that touches
 *    this machine, and it only reads, except for the two things above.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT } from "../config.js";
import { checkPluginPath, splitPluginList } from "../engine/frameworks/plugin.js";
import { mobileAvailability } from "../engine/mobile/toolchain.js";

export type Status = "ok" | "missing" | "optional";

export interface Check {
    id: string;
    /** What was checked, with what was found ("Node.js 24.1.0"). */
    title: string;
    status: Status;
    /** What it is for. */
    purpose: string;
    /** How to fix it; only for something that is not ok. */
    fix?: string;
}

export type PortAnswer = { free: true } | { free: false; code: string };
export type WriteAnswer = { ok: true; exists: boolean } | { ok: false; reason: string };

/** Everything the checks may ask about the computer. Each answer is a plain value, never a secret. */
export interface Probes {
    platform: NodeJS.Platform;
    /** `process.versions.node`, for example "24.1.0". */
    nodeVersion: string;
    /** The `engines.node` range from package.json, for example ">=24". */
    enginesNode: string | undefined;
    /** The environment the platform would start with. Only "is it set" is ever looked at, except for the plain choices named below. */
    env: Record<string, string | undefined>;
    /** The installed version of a package the platform depends on, or undefined when it cannot be found. */
    packageVersion(name: string): string | undefined;
    /** Is the browser build for this Playwright browser on disk? Nothing is launched. */
    browserInstalled(name: "chromium" | "firefox" | "webkit"): boolean;
    /** The full path of a program on PATH, or undefined. */
    onPath(program: string): string | undefined;
    fileExists(file: string): boolean;
    /** Is there a `.env` file in the folder the platform starts from? Its contents are not read. */
    envFileExists(): boolean;
    /** The folder the platform keeps its data in (DATA_DIR as the platform resolves it). */
    dataDir(): string;
    /** Can this folder be written? Creates and removes one temp file inside it; if it does not exist yet, asks about the nearest folder that does. */
    dataDirWritable(dir: string): WriteAnswer;
    /** Briefly bind the port, then let it go. */
    portFree(port: number, host: string): Promise<PortAnswer>;
    /** The names (never the values) of settings the platform would refuse to start with. */
    invalidSettings(env: Record<string, string | undefined>): string[];
    /** What the Android tools on this computer allow (reads files only, starts nothing). */
    android(env: Record<string, string | undefined>): { available: boolean; reason?: string; avds: string[] };
    /** The folder with the web build, `web/dist`. */
    webDist(): string;
}

const set = (env: Probes["env"], name: string): boolean => (env[name] ?? "").trim() !== "";
const major = (v: string): number => Number.parseInt(v.replace(/^v/, ""), 10);

/** ">=24" -> 24. Anything else means "no rule we can read". */
export function requiredNodeMajor(range: string | undefined): number | undefined {
    const m = /^\s*>=\s*v?(\d+)/.exec(range ?? "");
    return m ? Number(m[1]) : undefined;
}

const KEY_FOR: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    "openai-compatible": "LLM_BASE_URL",
};

/** The checks, in the order a new person fixes things. */
export async function runChecks(p: Probes): Promise<Check[]> {
    const out: Check[] = [];
    const add = (c: Check) => out.push(c);
    const env = p.env;

    // Node.js
    const need = requiredNodeMajor(p.enginesNode);
    const nodeOk = need === undefined || major(p.nodeVersion) >= need;
    add({
        id: "node",
        title: `Node.js ${p.nodeVersion}${need ? `, needs ${need} or newer` : ""}`,
        status: nodeOk ? "ok" : "missing",
        purpose: "Runs the platform, the command line and the runner agent.",
        ...(nodeOk ? {} : { fix: `Install Node.js ${need} or newer from https://nodejs.org, then open a new terminal.` }),
    });

    // Installed dependencies
    const pwVersion = p.packageVersion("playwright");
    add({
        id: "dependencies",
        title: pwVersion ? `Dependencies are installed (Playwright ${pwVersion})` : "Dependencies are not installed",
        status: pwVersion ? "ok" : "missing",
        purpose: "The platform's packages, including Playwright, which runs web and API tests.",
        ...(pwVersion ? {} : { fix: "Run `npm install` in the platform folder." }),
    });

    // Browsers
    const browsers: Array<["chromium" | "firefox" | "webkit", string, string, boolean]> = [
        ["chromium", "Chromium", "Runs every web test, and takes the screenshots in reports.", true],
        ["firefox", "Firefox", "Lets you run web tests in Firefox as well (cross-browser runs).", false],
        ["webkit", "WebKit (Safari engine)", "Lets you run web tests in the Safari engine as well (cross-browser runs).", false],
    ];
    for (const [id, label, purpose, required] of browsers) {
        const found = pwVersion ? p.browserInstalled(id) : false;
        add({
            id,
            title: found ? `${label} is installed` : `${label} is not installed`,
            status: found ? "ok" : required ? "missing" : "optional",
            purpose,
            ...(found ? {} : { fix: `Run \`npx playwright install ${id}\`${pwVersion ? "" : " after npm install"}.` }),
        });
    }

    // TypeScript (the custom-script guard reads scripts with it)
    const ts = p.packageVersion("typescript");
    add({
        id: "typescript",
        title: ts ? `TypeScript ${ts} is installed` : "TypeScript is not installed",
        status: ts ? "ok" : "missing",
        purpose: "Checks hand-written test scripts before they are saved or run.",
        ...(ts ? {} : { fix: "Run `npm install` in the platform folder." }),
    });

    // git
    const git = p.onPath("git");
    add({
        id: "git",
        title: git ? "git is installed" : "git is not installed",
        status: git ? "ok" : "optional",
        purpose: "Imports hand-written tests from a Git repository.",
        ...(git ? {} : { fix: "Install git from https://git-scm.com, then open a new terminal. Only needed for Git import." }),
    });

    // Settings file and values
    const envFile = p.envFileExists();
    add({
        id: "env-file",
        title: envFile ? "The settings file (.env) exists" : "There is no settings file (.env)",
        status: envFile ? "ok" : "optional",
        purpose: "Holds your settings, such as the AI provider key. Real environment variables work too.",
        ...(envFile ? {} : { fix: "Copy `.env.example` to `.env` and fill in the settings you need." }),
    });
    const invalid = p.invalidSettings(env);
    add({
        id: "settings",
        title: invalid.length ? `These settings have a value the platform cannot use: ${invalid.join(", ")}` : "The settings that are set are valid",
        status: invalid.length ? "missing" : "ok",
        purpose: "The platform refuses to start with a setting it cannot read.",
        ...(invalid.length ? { fix: "Correct them in `.env` (see `.env.example` for the allowed values). Their values are not shown here." } : {}),
    });

    // AI provider key (only "set" or "not set")
    const provider = (env.LLM_PROVIDER ?? "anthropic").trim() || "anthropic";
    const keyName = KEY_FOR[provider];
    const hasKey = set(env, "LLM_API_KEY") || (keyName === "LLM_BASE_URL" ? set(env, "LLM_BASE_URL") : keyName ? set(env, keyName) : false);
    add({
        id: "ai-key",
        title: hasKey ? `An AI provider key is set (provider: ${provider})` : `No AI provider key is set (provider: ${provider})`,
        status: hasKey ? "ok" : "optional",
        purpose: "Lets the platform write web tests from your site. API tests from an OpenAPI file work without it.",
        ...(hasKey ? {} : { fix: `Set ${keyName ?? "LLM_API_KEY"} (or LLM_API_KEY) in \`.env\`.` }),
    });

    // Network exposure without an API key
    const host = (env.HOST ?? "127.0.0.1").trim() || "127.0.0.1";
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!loopback) {
        const hasApiKey = set(env, "API_KEY");
        add({
            id: "api-key",
            title: hasApiKey ? "API_KEY is set for a network address" : "API_KEY is not set, but HOST is not a local address",
            status: hasApiKey ? "ok" : "missing",
            purpose: "Anyone who can reach the platform's address could otherwise use it.",
            ...(hasApiKey ? {} : { fix: "Set API_KEY in `.env`, or set HOST=127.0.0.1." }),
        });
    }

    // Data folder
    const dir = p.dataDir();
    const w = p.dataDirWritable(dir);
    add({
        id: "data-dir",
        title: w.ok ? (w.exists ? `The data folder is writable (${dir})` : `The data folder does not exist yet and can be created (${dir})`) : `The data folder cannot be written (${dir})`,
        status: w.ok ? "ok" : "missing",
        purpose: "Holds the database, the generated tests and the evidence files.",
        ...(w.ok ? {} : { fix: `${w.reason} Choose another folder with DATA_DIR in \`.env\`, or fix the folder's permissions.` }),
    });

    // Port
    const portText = (env.PORT ?? "").trim();
    const port = portText && Number.isInteger(Number(portText)) && Number(portText) > 0 && Number(portText) < 65536 ? Number(portText) : 4000;
    const bound = await p.portFree(port, host);
    add({
        id: "port",
        title: bound.free ? `Port ${port} is free` : `Port ${port} is not available (${bound.code === "EADDRINUSE" ? "in use" : bound.code === "EACCES" ? "not allowed" : bound.code})`,
        status: bound.free ? "ok" : "missing",
        purpose: "The address the platform's web page and API listen on.",
        ...(bound.free ? {} : { fix: bound.code === "EADDRINUSE" ? `Something is already listening there. If that is this platform, nothing is wrong; otherwise stop it or set PORT to another number in \`.env\`.` : "Set PORT to another number in `.env`." }),
    });

    // Web build
    const built = p.fileExists(path.join(p.webDist(), "index.html"));
    add({
        id: "web-build",
        title: built ? "The web interface is built" : "The web interface is not built",
        status: built ? "ok" : "optional",
        purpose: "The pages you open in a browser. The API and command line work without it.",
        ...(built ? {} : { fix: "Run `npm run build:web`." }),
    });

    // Android
    const mobile = p.android(env);
    const adb = p.onPath("adb");
    const java = p.onPath("java") ?? (set(env, "JAVA_HOME") ? "JAVA_HOME" : undefined);
    add({
        id: "android",
        title: mobile.available
            ? `Android tests can run (${mobile.avds.length} ${mobile.avds.length === 1 ? "emulator" : "emulators"} found)`
            : `Android tests cannot run yet (ANDROID_HOME ${set(env, "ANDROID_HOME") ? "is set" : "is not set"}, adb ${adb ? "found" : "not found"}, Java ${java ? "found" : "not found"})`,
        status: mobile.available ? "ok" : "optional",
        purpose: "Runs mobile app tests on an Android emulator.",
        ...(mobile.available ? {} : { fix: mobile.reason ?? "Run `npx @taqwright/taqwright install --with-avd`." }),
    });

    // Xcode / iOS
    if (p.platform === "darwin") {
        const xcode = p.fileExists("/Applications/Xcode.app") || p.fileExists("/Library/Developer/CommandLineTools");
        add({
            id: "xcode",
            title: xcode ? "Xcode tools are installed" : "Xcode tools are not installed",
            status: xcode ? "ok" : "optional",
            purpose: "Runs iOS app tests on a simulator (on a runner agent on this Mac).",
            ...(xcode ? {} : { fix: "Install Xcode from the App Store, then run `xcode-select --install`." }),
        });
    } else {
        add({ id: "xcode", title: "iOS tests need a Mac, and this computer is not one", status: "optional", purpose: "Runs iOS app tests on a simulator.", fix: "Run a runner agent on a Mac if you need iOS tests." });
    }

    // Windows desktop tests
    if (p.platform === "win32") {
        const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
        const ps = p.fileExists(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
        add({
            id: "windows-ui",
            title: ps ? "Windows PowerShell is available" : "Windows PowerShell was not found",
            status: ps ? "ok" : "optional",
            purpose: "Drives Windows desktop applications for desktop tests (needs a signed-in session, not an administrator one).",
            ...(ps ? {} : { fix: "Restore Windows PowerShell 5.1 (it ships with Windows). Only needed for desktop tests." }),
        });
    } else {
        add({ id: "windows-ui", title: "Desktop tests need Windows, and this computer is not Windows", status: "optional", purpose: "Drives Windows desktop applications.", fix: "Run a runner agent on a Windows computer if you need desktop tests." });
    }

    // How hand-written scripts and desktop apps are allowed (state in words)
    const customRequested = (env.ALLOW_CUSTOM_SCRIPTS ?? "").trim().toLowerCase() === "true";
    const hasApiKey = (env.API_KEY ?? "").trim() !== "";
    const custom = customRequested && hasApiKey;
    add({
        id: "custom-scripts",
        title: custom
            ? "Hand-written scripts may run on this computer (ALLOW_CUSTOM_SCRIPTS is true)"
            : customRequested
              ? "Hand-written scripts do not run on this computer, because ALLOW_CUSTOM_SCRIPTS is true but API_KEY is not set"
              : "Hand-written scripts do not run on this computer (the default)",
        status: customRequested && !hasApiKey ? "optional" : "ok",
        purpose: custom ? "Anyone who can edit tests can run code here, so only turn this on among people you trust." : "They run on a runner agent whose owner allowed them. Set ALLOW_CUSTOM_SCRIPTS=true only if everyone who edits tests may run code here.",
        ...(customRequested && !hasApiKey ? { fix: "Set API_KEY in .env so that running code on this computer needs a key, or remove ALLOW_CUSTOM_SCRIPTS." } : {}),
    });
    // Adapter plug-ins: code that runs inside the server, so the same two-part rule as hand-written scripts (the switch and an API key).
    const pluginsRequested = (env.ALLOW_ADAPTER_PLUGINS ?? "").trim().toLowerCase() === "true";
    const pluginPaths = splitPluginList(env.ADAPTER_PLUGINS);
    const pluginsOn = pluginsRequested && hasApiKey;
    const pluginsNotFound = pluginsOn ? pluginPaths.filter((raw) => { const c = checkPluginPath(raw); return !c.ok || !p.fileExists(c.path); }).length : 0;
    const noun = (n: number) => `${n} plug-in${n === 1 ? "" : "s"}`;
    add({
        id: "adapter-plugins",
        title: pluginsOn
            ? `Adapter plug-ins may load on this computer (ALLOW_ADAPTER_PLUGINS is true; ${noun(pluginPaths.length)} listed${pluginsNotFound ? `, ${pluginsNotFound} not found` : ""})`
            : pluginsRequested
              ? "Adapter plug-ins do not load on this computer, because ALLOW_ADAPTER_PLUGINS is true but API_KEY is not set"
              : pluginPaths.length > 0
                ? `Adapter plug-ins do not load on this computer: ADAPTER_PLUGINS lists ${noun(pluginPaths.length)}, but ALLOW_ADAPTER_PLUGINS is not true`
                : "Adapter plug-ins do not load on this computer (the default)",
        status: (pluginsRequested && !hasApiKey) || pluginsNotFound > 0 ? "optional" : "ok",
        purpose: pluginsOn ? "A plug-in runs inside the platform with all its power, so only load plug-ins you wrote or reviewed." : "A plug-in adds a testing framework as code that runs inside the platform. Set ALLOW_ADAPTER_PLUGINS=true, API_KEY and ADAPTER_PLUGINS only if you need one.",
        ...(pluginsRequested && !hasApiKey ? { fix: "Set API_KEY in .env so that loading code into the platform needs a key, or remove ALLOW_ADAPTER_PLUGINS." } : {}),
        ...(pluginsNotFound > 0 ? { fix: "Check the paths in ADAPTER_PLUGINS: each must be the full path of a plug-in file or folder that exists." } : {}),
    });
    const apps = (env.DESKTOP_ALLOWED_APPS ?? "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean).length;
    add({
        id: "desktop-apps",
        title: apps ? `Desktop tests may start ${apps} ${apps === 1 ? "application" : "applications"} on this computer` : "Desktop tests may not start any application on this computer (the default)",
        status: "ok",
        purpose: "DESKTOP_ALLOWED_APPS lists the programs a desktop test may start here. A runner agent keeps its own list (--allow-app).",
    });

    return out;
}

/** The report, as plain lines. Nothing in it comes from a setting's value. */
export function formatReport(checks: Check[]): string {
    const lines: string[] = ["AI Testing Platform: preflight check", ""];
    for (const c of checks) {
        lines.push(`${c.status.padEnd(9)} ${c.title}`);
        lines.push(`${" ".repeat(10)}For: ${c.purpose}`);
        if (c.fix && c.status !== "ok") lines.push(`${" ".repeat(10)}To fix: ${c.fix}`);
    }
    lines.push("", summary(checks));
    return lines.join("\n") + "\n";
}

export function summary(checks: Check[]): string {
    const missing = checks.filter((c) => c.status === "missing").length;
    const optional = checks.filter((c) => c.status === "optional").length;
    if (missing === 0) {
        if (!optional) return "Ready to run. Everything is set up.";
        return optional === 1 ? "Ready to run. 1 optional thing is not set up; it only matters if you need that kind of test." : `Ready to run. ${optional} optional things are not set up; they only matter if you need those kinds of tests.`;
    }
    return `${missing} required ${missing === 1 ? "thing is" : "things are"} missing. Fix ${missing === 1 ? "it" : "them"} and run this check again.`;
}

export const exitCodeFor = (checks: Check[]): number => (checks.some((c) => c.status === "missing") ? 1 : 0);

// ── the real computer ───────────────────────────────────────────────────────

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function nearestExisting(dir: string): string {
    let cur = dir;
    while (!fs.existsSync(cur)) {
        const up = path.dirname(cur);
        if (up === cur) return cur;
        cur = up;
    }
    return cur;
}

export function realProbes(env: NodeJS.ProcessEnv = process.env, root = REPO_ROOT): Probes {
    const require = createRequire(path.join(root, "package.json"));
    let engines: string | undefined;
    try {
        engines = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { engines?: { node?: string } }).engines?.node;
    } catch {
        /* no rule to check */
    }
    return {
        platform: process.platform,
        nodeVersion: process.versions.node,
        enginesNode: engines,
        env,
        packageVersion: (name) => {
            try {
                return (JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), "utf8")) as { version?: string }).version;
            } catch {
                return undefined;
            }
        },
        browserInstalled: (name) => {
            try {
                // `executablePath()` only works out where Playwright keeps the browser; nothing is launched.
                const pw = require("playwright") as Record<string, { executablePath(): string }>;
                const exe = pw[name]?.executablePath();
                return !!exe && isFile(exe);
            } catch {
                return false;
            }
        },
        onPath: (program) => {
            const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
            for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
                for (const ext of exts) {
                    const full = path.join(dir, program + ext.toLowerCase());
                    if (isFile(full)) return full;
                    const upper = path.join(dir, program + ext);
                    if (upper !== full && isFile(upper)) return upper;
                }
            }
            return undefined;
        },
        fileExists: (f) => fs.existsSync(f),
        envFileExists: () => isFile(path.resolve(".env")),
        dataDir: () => path.resolve((env.DATA_DIR ?? "").trim() || "./data"),
        dataDirWritable: (dir) => {
            const exists = fs.existsSync(dir);
            if (!exists) {
                const parent = nearestExisting(dir);
                try {
                    fs.accessSync(parent, fs.constants.W_OK);
                    return { ok: true, exists: false };
                } catch {
                    return { ok: false, reason: "The folder does not exist and its parent cannot be written." };
                }
            }
            const probe = path.join(dir, `.doctor-${process.pid}-${Date.now().toString(36)}.tmp`);
            try {
                fs.writeFileSync(probe, "doctor", { flag: "wx" });
                return { ok: true, exists: true };
            } catch (e) {
                return { ok: false, reason: `Writing a test file failed (${(e as NodeJS.ErrnoException).code ?? "error"}).` };
            } finally {
                try {
                    fs.rmSync(probe, { force: true });
                } catch {
                    /* it is our own temp file; nothing else to clean */
                }
            }
        },
        portFree: (port, host) =>
            new Promise((resolve) => {
                const srv = net.createServer();
                srv.once("error", (e: NodeJS.ErrnoException) => resolve({ free: false, code: e.code ?? "ERROR" }));
                srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve({ free: true })));
            }),
        invalidSettings: (e) => {
            try {
                loadConfig(e);
                return [];
            } catch (err) {
                const issues = (err as { issues?: Array<{ path: Array<string | number> }> }).issues;
                return [...new Set((issues ?? []).map((i) => String(i.path[0] ?? "settings")))];
            }
        },
        android: (e) => mobileAvailability(e),
        webDist: () => path.join(root, "web", "dist"),
    };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
    if (argv.includes("--help") || argv.includes("-h")) {
        process.stdout.write("Usage: npm run doctor\n\nChecks that this computer can run the AI Testing Platform and says how to fix what is missing.\nIt starts no browser, emulator or server, and never prints the value of a setting.\nExit code 1 means something required is missing.\n");
        return 0;
    }
    const checks = await runChecks(realProbes());
    process.stdout.write(formatReport(checks));
    return exitCodeFor(checks);
}

// Run when started directly (`npm run doctor`), not when a test imports the checks.
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
    main().then(
        (code) => process.exit(code),
        (e) => {
            process.stderr.write(`The check itself failed: ${e instanceof Error ? e.message : String(e)}\n`);
            process.exit(2);
        },
    );
}
