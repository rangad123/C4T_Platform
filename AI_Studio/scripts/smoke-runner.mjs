// The runner, end to end, on the computer this runs on: the same steps a tester takes, checked by a script.
//   node scripts/smoke-runner.mjs [--kit files|installer|complete] [--port 6950] [--no-node-on-path] [--out <dir>] ...
//   node scripts/smoke-runner.mjs --help
//
// 1. Starts the sample app (examples/sample-app) and the platform (src/main.ts, EXECUTION_MODE=runners: it never runs a test itself) on a
//    new temporary data folder with a new access key, and signs up its first person (an owner) the way the setup page does.
// 2. Creates a project with one web test and one API test, imported through the API (no AI, no model key).
// 3. Downloads that person's runner the way Settings, Your runner does (POST /api/me/runner/download with this computer's system and
//    processor: the installer on Windows and a Mac, the plain files on Linux, with its own Node.js when the platform built it), unpacks it
//    with the computer's own unzip tool (Windows' tar.exe, macOS' ditto, unzip on Linux) into a folder with a space and brackets in its
//    name, and starts it the way the README says (the installer's --silent switch, or start-runner.cmd / sh start-runner.sh).
// 4. Waits for the person's runner to be connected, runs both tests as that person and checks they passed ON THE RUNNER.
// 5. With --lifecycle (installer only): stops the runner the way a person does (Windows: --stop; Mac: the window's Ctrl-C), starts it
//    again (it now uses the credential it saved, the one-time code is used up) and waits for it to be online again.
// 6. Removes the computer (Settings, Your runner, Remove this computer) and checks the runner ends with the plain "no longer accepts this
//    runner" message. With --lifecycle,
//    uninstalls with the installer's own --uninstall and checks that nothing is left: no install folder, no sign-in start.
// 6. Stops what it started: only its own child processes, by the handles it holds (a Windows process tree by the id of the child it
//    started, a Unix process group it created). Never anything by name or by port. Deletes its temporary folder.
// It prints a short report and writes report.json, report.md and the logs (secrets removed) to --out. Exit code: 0 passed or skipped
// (for example: the complete download was not built on this platform), 1 failed, 2 wrong arguments.
// See docs/features/real-machine-checks.md. CI: .github/workflows/runner-matrix.yml.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";

export const KITS = ["files", "installer", "complete"];
export const DEFAULT_PORT = 6950;
/** Kept per child process (the end of what it printed); older output is dropped so a chatty run cannot fill the memory. */
export const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

export const HELP = `Runner smoke check: start the platform and a sample app, download your runner from Settings, start it like a person, run a web and an API test on it.

  node scripts/smoke-runner.mjs [options]

  --kit files|installer|complete   how to start this computer's one download (default files): files with its start script, installer with
                                   the installer (Windows and Mac), complete with the start script and the Node.js inside the download.
                                   Skipped plainly when the download cannot be started that way here.
  --port <n>                       the platform's port (default ${DEFAULT_PORT}); the sample app uses the next one
  --no-node-on-path                start the runner with no Node.js on the PATH (only with --kit complete)
  --link-node-modules              use this checkout's node_modules instead of npm install (only with --kit files; no internet needed)
  --build-runner                   build the runner bundle into the temporary folder first (otherwise dist/runner is used)
  --runner-kit-dir <dir>           a runner bundle somewhere else (RUNNER_KIT_DIR)
  --installer-dir <dir>            an installer build somewhere else (RUNNER_INSTALLER_DIR)
  --online-timeout <seconds>       how long the runner may take to come online (default 900, or 180 with --link-node-modules)
  --test-timeout <seconds>         how long one test may take (default 300)
  --out <dir>                      where the report and logs go (default .scratch/smoke-runner/<time>)
  --lifecycle                      (installer only) also stop, start again, uninstall, and check nothing is left
  --keep                           keep the temporary folder (its path is printed)
  --help                           this text

Exit code: 0 passed or skipped, 1 failed, 2 wrong arguments.`;

export class UsageError extends Error {}
/** A plain, expected reason not to go on (for example: no complete download on this platform). The run ends as "skipped", exit 0. */
export class Skip extends Error {}

const intArg = (name, raw, min, max) => {
    if (raw === undefined || !/^\d+$/.test(raw)) throw new UsageError(`${name} needs a whole number.`);
    const n = Number(raw);
    if (n < min || n > max) throw new UsageError(`${name} must be between ${min} and ${max}.`);
    return n;
};

/** Reads the command line. Throws UsageError with a plain sentence for anything it does not understand. */
export function parseArgs(argv) {
    const o = { kit: "files", port: DEFAULT_PORT, noNodeOnPath: false, linkNodeModules: false, buildRunner: false, keep: false, help: false, testTimeout: 300 };
    const value = (i, flag) => {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value.`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "--kit":
                o.kit = value(i++, a);
                if (!KITS.includes(o.kit)) throw new UsageError(`--kit must be one of: ${KITS.join(", ")}.`);
                break;
            case "--port":
                o.port = intArg("--port", value(i++, a), 1024, 65534);
                break;
            case "--online-timeout":
                o.onlineTimeout = intArg("--online-timeout", value(i++, a), 10, 7200);
                break;
            case "--test-timeout":
                o.testTimeout = intArg("--test-timeout", value(i++, a), 10, 3600);
                break;
            case "--out":
                o.out = path.resolve(value(i++, a));
                break;
            case "--runner-kit-dir":
                o.runnerKitDir = path.resolve(value(i++, a));
                break;
            case "--installer-dir":
                o.installerDir = path.resolve(value(i++, a));
                break;
            case "--no-node-on-path":
                o.noNodeOnPath = true;
                break;
            case "--link-node-modules":
                o.linkNodeModules = true;
                break;
            case "--build-runner":
                o.buildRunner = true;
                break;
            case "--lifecycle":
                o.lifecycle = true;
                break;
            case "--keep":
                o.keep = true;
                break;
            case "--help":
            case "-h":
                o.help = true;
                break;
            default:
                throw new UsageError(`Unknown option ${a}. Run with --help to see the options.`);
        }
    }
    if (o.noNodeOnPath && o.kit !== "complete") throw new UsageError("--no-node-on-path only makes sense with --kit complete: the other downloads need a Node.js on the computer.");
    if (o.linkNodeModules && o.kit !== "files") throw new UsageError("--link-node-modules only works with --kit files.");
    if (o.buildRunner && o.runnerKitDir) throw new UsageError("Use --build-runner or --runner-kit-dir, not both.");
    if (o.lifecycle && o.kit !== "installer") throw new UsageError("--lifecycle only works with --kit installer: it stops, restarts and uninstalls what the installer set up.");
    o.onlineTimeout ??= o.linkNodeModules ? 180 : 900;
    return o;
}

// ── the computer ────────────────────────────────────────────────────────────

/** The system and processor this runs on, in the platform's words (kit `platform`, `arch`) and in a person's. */
export function hostTarget(platform = process.platform, arch = process.arch) {
    const system = platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux";
    const cpu = arch === "arm64" ? "arm64" : "x64";
    const label = `${{ windows: "Windows", mac: "macOS", linux: "Linux" }[system]} ${cpu === "arm64" ? "ARM64" : "x64"}`;
    return { system, kitPlatform: system === "windows" ? "windows" : "unix", arch: cpu, id: `${system === "windows" ? "win" : system}-${cpu}`, label };
}

/** The PATH without any folder that holds Node.js or npm, for the "nothing installed" check. `removed` says which folders went. */
export function pathWithoutNode(value, { platform = process.platform, exists = fs.existsSync } = {}) {
    const win = platform === "win32";
    const sep = win ? ";" : ":";
    const join = win ? path.win32.join : path.posix.join;
    const names = win ? ["node.exe", "node.cmd", "node", "npm.cmd", "npx.cmd"] : ["node", "npm", "npx"];
    const kept = [];
    const removed = [];
    for (const dir of String(value ?? "").split(sep).filter(Boolean)) (names.some((n) => exists(join(dir, n))) ? removed : kept).push(dir);
    // The start script needs the system's own tools; a system folder that also holds node cannot be left out (say so rather than pretend).
    const essential = win ? [] : removed.filter((d) => ["/bin", "/usr/bin"].includes(d.replace(/\/+$/, "")));
    return { value: kept.join(sep), removed, essential };
}

/** What the platform is asked for (round 45): this computer's system and processor, nothing else. The kit only decides how it is started. */
export function kitRequestBody(target) {
    return { os: target.system, arch: target.arch };
}

/**
 * Decides what a download answer means: go on, a plain skip (this download cannot be started the asked way here), or a failure.
 * `answer` is { status, kind (x-runner-kit-kind), note (x-runner-kit-note), target (x-runner-kit-target), message (the server's own sentence) }.
 */
export function interpretKitAnswer(kit, target, answer) {
    const { status, kind, note, message = "" } = answer;
    if (kit === "installer" && target.system === "linux") return { skip: "There is no installer for Linux (the Mac app is for macOS): the Linux download is the plain files. Use --kit files or --kit complete." };
    if (status === 503) return { fail: `The platform has no runner download: ${message}` };
    if (status !== 200) return { fail: `The download was refused (${status}): ${message || "no reason given"}` };
    if (kit === "installer" && kind && kind !== "installer") return { skip: `This platform has no installer for ${target.label}, it sent plain files instead. ${note ?? ""}`.trim() };
    if (kit === "complete" && !answer.target) return { skip: `The download for ${target.id} does not carry its own Node.js: the complete build for it was not made on this platform (npm run build:runner -- --complete --targets ${target.id}).` };
    return { ok: true };
}

/** How the README says to start each download. `kitDir` is the unpacked folder, `installDir` where an installer may install. */
export function startCommand(kit, target, kitDir, installDir) {
    if (kit === "installer") {
        // No sign-in start: a check must not leave a Startup shortcut behind on the computer it runs on.
        if (target.system === "windows") return { command: path.join(kitDir, "AITestingRunnerSetup.exe"), args: ["--silent", "--no-start-at-sign-in", "--install-dir", installDir] };
        return { command: "sh", args: [path.join(kitDir, "AI Testing Runner.app", "Contents", "Resources", "runner-setup.sh"), "--silent", "--no-autostart", "--install-dir", installDir] };
    }
    if (target.system === "windows") return { command: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), args: ["/d", "/c", ".\\start-runner.cmd"] };
    return { command: "sh", args: ["start-runner.sh"] };
}

/**
 * Files under `dir` that hold a runner credential (aitg_...) or enrollment code (aite_...) as readable text (UTF-8 or UTF-16), as paths
 * relative to `dir`. After enrollment an installed runner keeps its credential only in the computer's store (DPAPI-protected file on
 * Windows, the login Keychain on macOS) and deletes the code, so the install and work folders must hold neither. Links are not followed;
 * `node_modules`, the private Node.js and files over 64 MB (no credential is written there) are skipped.
 */
export function plainCredentialsIn(dir, { skip = ["node_modules"], maxBytes = 64 * 1024 * 1024 } = {}) {
    const found = [];
    const shape = /ait[ge]_[A-Za-z0-9_-]{20,}/;
    const walk = (d) => {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (!skip.includes(e.name) && !(d === dir && e.name === "node")) walk(full);
                continue;
            }
            try {
                if (!e.isFile() || fs.statSync(full).size > maxBytes) continue;
                const bytes = fs.readFileSync(full);
                if (shape.test(bytes.toString("latin1")) || shape.test(bytes.toString("utf16le"))) found.push(path.relative(dir, full));
            } catch {
                /* a file in use or gone: nothing to read */
            }
        }
    };
    walk(dir);
    return found;
}

/** Secrets never reach a report or log: the access key, the runner token and anything that looks like a project token. */
export function redact(text, secrets = []) {
    let out = String(text);
    for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("***");
    return out.replace(/aitg_[A-Za-z0-9_-]{6,}/g, "aitg_***");
}

/** Did the start script say it used the Node.js inside the download? */
export function usedBundledNode(output, kitDir) {
    if (/came with this download/i.test(output)) return true;
    const m = /Using Node\.js v\d+\.\d+\.\d+ from (.+?)\.?\r?$/m.exec(output);
    if (!m) return false;
    const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
    return norm(m[1]).startsWith(norm(kitDir));
}

// ── child processes: only ours, by the handles we hold ─────────────────────

export class Children {
    constructor() {
        this.list = [];
    }

    /** Starts a process. On Unix it leads a new process group so it can be stopped with everything it started, and nothing else. */
    start(name, command, args, { cwd, env } = {}) {
        const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !WIN });
        const entry = { name, child, output: "", code: undefined, error: undefined };
        const add = (d) => {
            entry.output += String(d);
            if (entry.output.length > MAX_OUTPUT_CHARS) entry.output = entry.output.slice(-MAX_OUTPUT_CHARS);
        };
        child.stdout?.on("data", add);
        child.stderr?.on("data", add);
        entry.exited = new Promise((resolve) => {
            child.on("error", (e) => {
                entry.error = e.message;
                if (entry.code === undefined) entry.code = null;
                resolve(null);
            });
            child.on("exit", (code, signal) => {
                entry.code = code ?? (signal ? `signal ${signal}` : null);
                resolve(entry.code);
            });
        });
        this.list.push(entry);
        return entry;
    }

    static running(entry) {
        return entry.code === undefined;
    }

    /** Stops one of ours: its Windows process tree (by the id of the child we started) or its Unix process group. */
    async stop(entry) {
        const pid = entry.child.pid;
        if (pid && WIN) {
            if (Children.running(entry)) spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else if (pid) {
            // The group lives on while any member does, even after its leader has gone: always end the whole group.
            const group = (sig) => {
                try {
                    process.kill(-pid, sig);
                } catch {
                    /* the group is gone */
                }
            };
            group("SIGTERM");
            await Promise.race([entry.exited, sleep(5000)]);
            group("SIGKILL");
        }
        await Promise.race([entry.exited, sleep(10_000)]);
    }

    /** Stops everything this run started, newest first. */
    async stopAll() {
        for (const e of [...this.list].reverse()) await this.stop(e);
    }
}

// ── small helpers ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (text, lines = 25) => String(text).replace(/\r/g, "").trimEnd().split("\n").slice(-lines).join("\n");
export const fmtMs = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

async function until(what, probe, ms, every = 1000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v) return v;
        if (Date.now() > end) throw new Error(`Timed out after ${fmtMs(ms)} waiting for ${what}.`);
        await sleep(every);
    }
}

/** Requests as one caller: `auth` is the headers that say who (the access key, or a person's own API token). */
function client(base, auth) {
    return async (method, url, body) => {
        const res = await fetch(`${base}${url}`, {
            method,
            headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(120_000),
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.toString("utf8");
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }
        return { status: res.status, headers: res.headers, buf, text, json, message: json?.error ?? json?.message ?? (res.ok ? "" : text.slice(0, 300)) };
    };
}

/** The value of one cookie from a Set-Cookie answer. */
const cookieOf = (headers, name) => {
    const all = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];
    for (const c of all) {
        const m = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(c);
        if (m) return m[1];
    }
    return undefined;
};

/**
 * The first person on a new platform, the way the setup page makes them (the access key, then name, email and password), and their own
 * API token for the rest of the check (made from the signed-in session, as the Settings page does). Returns the token.
 */
export async function signUpFirstOwner(base, apiKey, password) {
    const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "x-api-key": apiKey, "content-type": "application/json" }, body: JSON.stringify({ email: "smoke-owner@example.com", name: "Smoke owner", password }), signal: AbortSignal.timeout(60_000) });
    if (setup.status !== 201) throw new Error(`Could not sign up the first person (${setup.status}): ${(await setup.text()).slice(0, 300)}`);
    const session = cookieOf(setup.headers, "aitp_session");
    const csrf = cookieOf(setup.headers, "aitp_csrf");
    if (!session || !csrf) throw new Error("Signing up did not start a session.");
    const made = await fetch(`${base}/api/me/tokens`, { method: "POST", headers: { cookie: `aitp_session=${session}; aitp_csrf=${csrf}`, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ name: "Runner smoke check" }), signal: AbortSignal.timeout(60_000) });
    const body = await made.json().catch(() => ({}));
    if (made.status !== 201 || !body.token) throw new Error(`Could not make the person's API token (${made.status}): ${body.error ?? body.message ?? ""}`);
    return body.token;
}

/** How long a runner may take to get a browser for web tests ready (it may download Chromium once, the first time it starts). */
export const BROWSER_READY_MS = 10 * 60_000;

/** The platform's refusal while the runner is still getting its browser: wait and ask again. Any other answer is final. */
export const isBrowserNotReady = (r) => r.status === 409 && /no browser ready|downloading (Chromium|a browser)/i.test(String(r.message ?? ""));

/**
 * Start a test's run once the runner can take it. A runner that is still downloading its browser is refused up front (409, "Your runner
 * cannot run web tests: it has no browser ready (The runner is downloading Chromium ...)"); that is correct, so this asks again every few
 * seconds until the browser is ready, at most BROWSER_READY_MS, and then answers with the last refusal (which the step reports as it is).
 */
export async function startWhenBrowserReady(api, testId, { waitMs = BROWSER_READY_MS, everyMs = 5000, sleepFn = sleep } = {}) {
    const end = Date.now() + waitMs;
    for (;;) {
        const r = await api("POST", `/api/tests/${testId}/validate`);
        if (!isBrowserNotReady(r) || Date.now() + everyMs > end) return r;
        await sleepFn(everyMs);
    }
}

/** A complete download can be a few hundred MB: it is written to the file as it arrives, never held in memory. Larger than this is refused. */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

async function downloadKit(base, auth, body, file) {
    const res = await fetch(`${base}/api/me/runner/download`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(900_000),
    });
    if (res.status !== 200 || !res.body) {
        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }
        return { status: res.status, headers: res.headers, bytes: 0, message: json?.error ?? json?.message ?? text.slice(0, 300) };
    }
    let bytes = 0;
    const out = fs.createWriteStream(file);
    try {
        for await (const chunk of res.body) {
            bytes += chunk.length;
            if (bytes > MAX_DOWNLOAD_BYTES) throw new Error(`The download is larger than ${MAX_DOWNLOAD_BYTES / 1048576} MB.`);
            if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        }
    } finally {
        await new Promise((r) => out.end(r));
    }
    return { status: res.status, headers: res.headers, bytes, message: "" };
}

/** Process environment for the platform: the computer's basics only, so a developer's own settings (DATA_DIR, model keys, ...) never leak in. */
const BASIC_ENV = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES.*|USERNAME|USER|LOGNAME|SHELL|LANG|LC_.*|TZ|NUMBER_OF_PROCESSORS|PROCESSOR_.*|OS|XDG_.*|PLAYWRIGHT_BROWSERS_PATH|CI|GITHUB_ACTIONS|HTTPS?_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS)$/i;

export function platformEnv(base, s) {
    const env = Object.fromEntries(Object.entries(base).filter(([k, v]) => v !== undefined && BASIC_ENV.test(k)));
    Object.assign(env, {
        DATA_DIR: s.dataDir,
        API_KEY: s.apiKey,
        HOST: "127.0.0.1",
        PORT: String(s.port),
        PUBLIC_URL: `http://127.0.0.1:${s.port}`,
        // The hosted platform's mode: tests run only on runners, so a test that passed here passed on the runner.
        EXECUTION_MODE: "runners",
        LLM_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
        LLM_API_KEY: "",
        WORKER_EMBEDDED: "true",
        SCHEDULER_ENABLED: "false",
        CONCURRENCY: "2",
        MAX_REPAIR_ATTEMPTS: "0",
        // A quicker runner conversation than the defaults; the protocol is the same.
        AGENT_POLL_SECONDS: "2",
        AGENT_LEASE_SECONDS: "30",
        AGENT_NO_AGENT_GRACE_SECONDS: "60",
    });
    if (s.runnerKitDir) env.RUNNER_KIT_DIR = s.runnerKitDir;
    if (s.installerDir) env.RUNNER_INSTALLER_DIR = s.installerDir;
    return env;
}

/** Environment for the runner: the computer's own, as a person's window has it, without the platform's settings or our test switches. */
export function runnerEnv(base, { linkNodeModules = false, path: pathValue } = {}) {
    const env = Object.fromEntries(Object.entries(base).filter(([k, v]) => v !== undefined && !/^(AGENT_|RUNNER_|AITP_)/i.test(k) && !/^(API_KEY|DATA_DIR|PUBLIC_URL|SECRET_KEY)$/i.test(k)));
    // No "press a key" pause and no window: the script must end on its own when the runner stops.
    Object.assign(env, { AITP_KIT_NO_PAUSE: "1", AITP_INSTALLER_NO_PAUSE: "1", AITP_INSTALLER_NO_UI: "1" });
    if (linkNodeModules) env.AITP_KIT_SKIP_INSTALL = "1";
    if (pathValue !== undefined) {
        for (const k of Object.keys(env)) if (k.toUpperCase() === "PATH") delete env[k];
        env.PATH = pathValue;
    }
    return env;
}

// ── unpacking like a person ─────────────────────────────────────────────────

/** The Unix permission bits each zip entry carries (central directory, external attributes), for the unpacker without a system tool. */
export function zipModes(buf) {
    const modes = new Map();
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 65_600; i--) {
        if (buf.readUInt32LE(i) !== 0x06054b50) continue;
        let p = buf.readUInt32LE(i + 16);
        const count = buf.readUInt16LE(i + 10);
        for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
            const madeOnUnix = buf[p + 5] === 3;
            const nameLen = buf.readUInt16LE(p + 28);
            const extraLen = buf.readUInt16LE(p + 30);
            const commentLen = buf.readUInt16LE(p + 32);
            const attrs = buf.readUInt32LE(p + 38);
            const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
            if (madeOnUnix && attrs >>> 16) modes.set(name, (attrs >>> 16) & 0o777);
            p += 46 + nameLen + extraLen + commentLen;
        }
        break;
    }
    return modes;
}

async function unpackBuiltIn(zipFile, dest) {
    const { unzipSync } = await import("fflate");
    const buf = fs.readFileSync(zipFile);
    const modes = zipModes(buf);
    for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(buf)))) {
        if (name.endsWith("/")) continue;
        const target = path.resolve(dest, name);
        if (!target.startsWith(path.resolve(dest) + path.sep)) throw new Error(`The zip holds a path outside its folder: ${name}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes, { mode: modes.get(name) ?? 0o644 });
    }
}

/** Unpacks with the tool a person's computer has (Windows' tar.exe, macOS' ditto, unzip), or the built-in reader when it is missing. */
export async function unpackZip(zipFile, dest, { platform = process.platform, builtInOnly = false } = {}) {
    fs.mkdirSync(dest, { recursive: true });
    const tool = builtInOnly
        ? undefined
        : platform === "win32"
          ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", zipFile, "-C", dest]]
          : platform === "darwin"
            ? ["/usr/bin/ditto", ["-x", "-k", zipFile, dest]]
            : ["unzip", ["-q", "-o", zipFile, "-d", dest]];
    if (tool && (path.isAbsolute(tool[0]) ? fs.existsSync(tool[0]) : spawnSync(tool[0], ["-v"], { stdio: "ignore" }).status === 0)) {
        const r = spawnSync(tool[0], tool[1], { encoding: "utf8", windowsHide: true, timeout: 600_000 });
        if (r.status !== 0) throw new Error(`Unpacking with ${path.basename(tool[0])} failed: ${(r.stderr || r.stdout || r.error?.message || "").trim().slice(0, 300)}`);
        return path.basename(tool[0]);
    }
    await unpackBuiltIn(zipFile, dest);
    return "built-in unzip";
}

// ── the report ──────────────────────────────────────────────────────────────

const KIT_WORDS = { files: "plain files", installer: "installer", complete: "complete download" };

export function renderReport(r) {
    const lines = [];
    const verdict = { passed: "passed", failed: "FAILED", skipped: "skipped" }[r.verdict] ?? r.verdict;
    lines.push(`Runner smoke check ${verdict}: ${KIT_WORDS[r.kit] ?? r.kit}${r.noNodeOnPath ? " with no Node.js on the PATH" : ""}, ${r.target?.label ?? "unknown computer"}, Node.js ${r.node}, ${fmtMs(r.durationMs ?? 0)}.`);
    if (r.skipReason) lines.push(`Skipped: ${r.skipReason}`);
    if (r.error) lines.push(`Problem: ${r.error}`);
    for (const s of r.steps ?? []) lines.push(`  ${s.status === "ok" ? "ok  " : s.status === "skipped" ? "skip" : "FAIL"}  ${s.name} (${fmtMs(s.ms)})${s.detail ? `: ${s.detail}` : ""}`);
    if (r.tests?.length) {
        lines.push("Tests:");
        for (const t of r.tests) lines.push(`  ${t.status === "passed" ? "ok  " : "FAIL"}  ${t.title} (${t.kind}): ${t.status}, ${t.where}${t.browser ? `, ${t.browser}` : ""}`);
    }
    for (const n of r.notes ?? []) lines.push(`Note: ${n}`);
    if (r.outDir) lines.push(`Report and logs: ${r.outDir}`);
    if (r.kept) lines.push(`Temporary folder kept: ${r.kept}`);
    return lines.join("\n");
}

// ── the run ─────────────────────────────────────────────────────────────────

/** The two tests: the sample app's home page in a browser, and its product list over HTTP. No AI is involved. */
export function smokeSpecs(appUrl) {
    return [
        { title: "The home page welcomes people", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${appUrl}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Welcome to DemoShop" } }] },
        { title: "The product list answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/products" }, { action: "assertResponse", check: "status", expected: 200 }] },
    ];
}

async function defaultStartApp({ children, port }) {
    const entry = children.start("sample app", process.execPath, [path.join(REPO, "examples", "sample-app", "server.mjs"), String(port)], { cwd: REPO, env: { ...process.env, PORT: String(port) } });
    const url = `http://127.0.0.1:${port}`;
    await until("the sample app to answer", async () => {
        if (!Children.running(entry)) throw new Error(`The sample app stopped (code ${entry.code}). Is port ${port} in use?\n${tail(entry.output)}`);
        return fetch(`${url}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    }, 30_000, 300);
    return { url, entry };
}

async function defaultStartPlatform({ children, port, env }) {
    const entry = children.start("platform", process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join("src", "main.ts")], { cwd: REPO, env });
    const base = `http://127.0.0.1:${port}`;
    await until("the platform to answer", async () => {
        if (!Children.running(entry)) throw new Error(`The platform stopped while starting (code ${entry.code}). Is port ${port} in use?\n${tail(entry.output)}`);
        return fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    }, 180_000, 500);
    return { base, entry };
}

/**
 * Runs the whole check and returns the report (it never throws for a failed check). `deps` replaces the parts that start the platform and
 * the sample app (the unit test uses a small stand-in platform).
 */
export async function runSmoke(opts, deps = {}) {
    const startApp = deps.startApp ?? defaultStartApp;
    const startPlatform = deps.startPlatform ?? defaultStartPlatform;
    const target = deps.target ?? hostTarget();
    const children = deps.children ?? new Children();
    const started = Date.now();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outDir = opts.out ?? path.join(REPO, ".scratch", "smoke-runner", `${opts.kit}-${stamp}`);
    const apiKey = `smoke-${randomBytes(18).toString("hex")}`;
    const password = `Smoke-${randomBytes(12).toString("hex")}-Pw`;
    const secrets = [apiKey, password];
    const report = { tool: "smoke-runner", format: 1, verdict: "failed", kit: opts.kit, noNodeOnPath: opts.noNodeOnPath, linkNodeModules: opts.linkNodeModules, target, node: process.version, startedAt: new Date(started).toISOString(), steps: [], tests: [], notes: [], outDir };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-smoke-"));
    const links = [];
    let runner;
    let kitDir;

    const step = async (name, fn) => {
        const t0 = Date.now();
        try {
            const detail = await fn();
            report.steps.push({ name, status: "ok", ms: Date.now() - t0, ...(detail ? { detail: redact(detail, secrets) } : {}) });
            return detail;
        } catch (e) {
            report.steps.push({ name, status: e instanceof Skip ? "skipped" : "failed", ms: Date.now() - t0, detail: redact(e.message, secrets) });
            throw e;
        }
    };

    try {
        let runnerKitDir = opts.runnerKitDir;
        if (opts.buildRunner) {
            await step("Build the runner bundle", async () => {
                const { buildRunner } = await import(pathToFileURL(path.join(REPO, "scripts", "build-runner.mjs")).href);
                runnerKitDir = path.join(tmp, "dist-runner");
                await buildRunner({ outDir: runnerKitDir });
                return "built into the temporary folder";
            });
        }
        let app;
        await step("Start the sample app", async () => {
            app = await startApp({ children, port: opts.port + 1 });
            return app.url;
        });
        let platform;
        await step("Start the platform on a new data folder", async () => {
            const env = platformEnv(process.env, { dataDir: path.join(tmp, "data"), apiKey, port: opts.port, runnerKitDir, installerDir: opts.installerDir });
            platform = await startPlatform({ children, port: opts.port, env, apiKey });
            return platform.base;
        });
        let auth;
        await step("Sign up the first person (an owner), as the setup page does", async () => {
            const token = await signUpFirstOwner(platform.base, apiKey, password);
            secrets.push(token);
            auth = { authorization: `Bearer ${token}` };
            return "with their own API token for the rest of the check";
        });
        // Everything from here on is that person: the download is theirs, and so are the runs (each run goes to its starter's runner).
        const api = client(platform.base, auth);
        /** The person's runner as Settings shows it (GET /api/me/runner), when it is connected. */
        const myRunner = async () => {
            const r = (await api("GET", "/api/me/runner")).json?.runner;
            return r && (r.status === "online" || r.status === "busy") ? r : undefined;
        };

        let projectId;
        let testIds = [];
        const specs = smokeSpecs(app.url);
        await step("Create a project with a web test and an API test (no AI)", async () => {
            const p = await api("POST", "/api/projects", { name: `Runner smoke ${target.id}` });
            if (p.status >= 300 || !p.json?.id) throw new Error(`Could not create the project (${p.status}): ${p.message}`);
            projectId = p.json.id;
            const imp = await api("POST", `/api/projects/${projectId}/specs`, { baseUrl: app.url, validate: false, specs });
            if (imp.status !== 202 && imp.status !== 200) throw new Error(`Could not import the two tests (${imp.status}): ${imp.message}`);
            testIds = (imp.json?.tests ?? []).map((t) => t.id);
            if (testIds.length !== specs.length) throw new Error(`The import made ${testIds.length} tests, expected ${specs.length}.`);
            return `project ${projectId}`;
        });

        let tokenId;
        let runnerName;
        let zipFile;
        await step(`Download the runner (${KIT_WORDS[opts.kit]})`, async () => {
            const downloads = path.join(tmp, "Downloads");
            fs.mkdirSync(downloads, { recursive: true });
            const res = await downloadKit(platform.base, auth, kitRequestBody(target), path.join(downloads, "download.part"));
            const decision = interpretKitAnswer(opts.kit, target, { status: res.status, kind: res.headers.get("x-runner-kit-kind") ?? undefined, note: res.headers.get("x-runner-kit-note") ?? undefined, target: res.headers.get("x-runner-kit-target") ?? undefined, message: res.message });
            if (decision.skip) throw new Skip(decision.skip);
            if (decision.fail) throw new Error(decision.fail);
            // The download holds the person's one-time code; their runner is made when the runner trades it, and found once it is connected.
            const fileName = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "runner.zip";
            if (!/^[A-Za-z0-9._-]+\.zip$/.test(fileName)) throw new Error(`Unexpected file name ${fileName}`);
            zipFile = path.join(downloads, fileName);
            fs.renameSync(path.join(downloads, "download.part"), zipFile);
            return `${fileName}, ${(res.bytes / 1048576).toFixed(1)} MB`;
        });

        await step("Unpack it", async () => {
            // A space and brackets on purpose: that is what a second download in a Downloads folder looks like.
            const dest = path.join(tmp, "Downloads", "smoke runner (1)");
            const tool = await unpackZip(zipFile, dest);
            const top = fs.readdirSync(dest);
            if (top.length !== 1 || !fs.statSync(path.join(dest, top[0])).isDirectory()) throw new Error(`The zip should hold one folder, it holds: ${top.join(", ")}`);
            kitDir = path.join(dest, top[0]);
            const credential = ["runner.enroll", "runner.token"].map((f) => path.join(kitDir, f)).find((f) => fs.existsSync(f));
            if (!credential) throw new Error("The download has neither runner.enroll nor runner.token.");
            secrets.push(fs.readFileSync(credential, "utf8").trim());
            if (opts.kit === "complete") {
                const own = ["node.exe", path.join("bin", "node")].some((f) => fs.existsSync(path.join(kitDir, "node", f)));
                if (!own) throw new Error("The complete download has no Node.js of its own (no node folder with node.exe or bin/node).");
            }
            // Windows and a Mac get the installer; its start scripts are there only when the download carries its own Node.js.
            if (opts.kit !== "installer" && !fs.existsSync(path.join(kitDir, target.system === "windows" ? "start-runner.cmd" : "start-runner.sh"))) throw new Skip(`The download for ${target.label} is the installer and has no start script here (the platform built no complete download for ${target.id}). Use --kit installer.`);
            if (opts.linkNodeModules) {
                const link = path.join(kitDir, "node_modules");
                fs.symlinkSync(path.join(REPO, "node_modules"), link, WIN ? "junction" : "dir");
                links.push(link);
            }
            return `with ${tool}${opts.linkNodeModules ? ", node_modules linked to this checkout" : ""}`;
        });

        let pathValue;
        if (opts.noNodeOnPath) {
            await step("Build a PATH without Node.js", async () => {
                const clean = pathWithoutNode(process.env.PATH ?? process.env.Path ?? "");
                if (clean.essential.length) throw new Error(`Node.js is in ${clean.essential.join(", ")}, which the start script also needs for its own tools, so a PATH without Node.js cannot be made on this computer.`);
                pathValue = clean.value;
                return clean.removed.length ? `left out ${clean.removed.length} folder(s): ${clean.removed.join(", ")}` : "no folder on the PATH held Node.js";
            });
        }

        const cmd = startCommand(opts.kit, target, kitDir, path.join(tmp, "install folder"));
        report.lifecycle = Boolean(opts.lifecycle);
        await step(`Start it (${[path.basename(cmd.command), ...cmd.args.map((a) => (a.length > 3 && path.isAbsolute(a) ? path.basename(a) : a))].join(" ")})`, async () => {
            const program = opts.kit === "installer" ? (target.system === "windows" ? cmd.command : cmd.args[0]) : path.join(kitDir, target.system === "windows" ? "start-runner.cmd" : "start-runner.sh");
            if (!fs.existsSync(program)) throw new Error(`${path.basename(program)} is not in the download.`);
            runner = children.start("runner", cmd.command, cmd.args, { cwd: kitDir, env: runnerEnv(process.env, { linkNodeModules: opts.linkNodeModules, path: pathValue }) });
            return undefined;
        });

        await step("Wait for the runner to be online", async () => {
            const t0 = Date.now();
            await until("the runner to be online", async () => {
                if (!Children.running(runner)) throw new Error(`The runner stopped before it was online (code ${runner.code}${runner.error ? `, ${runner.error}` : ""}).\n${tail(runner.output)}`);
                return myRunner();
            }, opts.onlineTimeout * 1000, 2000).catch((e) => {
                throw new Error(`${e.message}${Children.running(runner) ? `\nLast lines from the runner window:\n${tail(runner.output)}` : ""}`);
            });
            const nodeLine = /^.*(Using (the )?Node\.js[^\r\n]*)$/m.exec(runner.output)?.[1];
            const mine = await myRunner();
            tokenId = mine?.id;
            runnerName = mine?.name;
            if (!tokenId || !runnerName) throw new Error("The runner is connected, but Settings does not show it (GET /api/me/runner has no id or name).");
            return `as "${runnerName}" after ${fmtMs(Date.now() - t0)}${nodeLine ? `; ${nodeLine.trim()}` : ""}`;
        });

        await step("Allow private addresses for this runner (the sample app is on this computer), as Settings does", async () => {
            // A person's runner refuses private and local addresses by default; the sample app is on 127.0.0.1.
            const r = await api("PATCH", "/api/me/runner", { switches: { privateTargets: true } });
            if (r.status !== 200) throw new Error(`The switch was refused (${r.status}): ${r.message}`);
            const now = (await api("GET", "/api/me/runner")).json?.runner?.switches;
            if (now?.privateTargets !== true) throw new Error(`Settings does not show private addresses as allowed (switches: ${JSON.stringify(now ?? null)}).`);
            return "switched on, and Settings shows it";
        });

        if (opts.kit === "complete") {
            await step("Check it used the Node.js inside the download", async () => {
                if (!usedBundledNode(runner.output, kitDir)) throw new Error("The start script did not say it used the Node.js that came with the download.");
                return undefined;
            });
        }

        for (let i = 0; i < testIds.length; i++) {
            const spec = specs[i];
            await step(`Run the ${spec.kind === "web" ? "web" : "API"} test`, async () => {
                const run = await startWhenBrowserReady(api, testIds[i]);
                if (run.status !== 202) throw new Error(`The run did not start (${run.status}): ${run.message}`);
                const job = await until(`the ${spec.kind} test to finish`, async () => {
                    const j = (await api("GET", `/api/test-generation/${run.json.jobId}`)).json;
                    return j && ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"].includes(j.status) ? j : undefined;
                }, opts.testTimeout * 1000, 1000);
                const exec = (await api("GET", `/api/tests/${testIds[i]}/executions`)).json?.[0];
                const where = job.ranOn?.kind === "agent" ? `ran on the runner "${job.ranOn.name}"` : job.ranOn?.kind === "platform" ? "ran on the platform" : "where it ran is not known";
                const b = exec?.browser ?? job.browser;
                const browser = b && typeof b === "object" ? `${b.name ?? "browser"} ${b.version ?? ""} (${b.source ?? "unknown source"})`.replace(/\s+/g, " ") : undefined;
                const status = exec?.status ?? `no result (job ${job.status})`;
                report.tests.push({ title: spec.title, kind: spec.kind, status, where, ...(browser ? { browser } : {}), jobStatus: job.status, ...(exec?.error ? { error: redact(String(exec.error).slice(0, 500), secrets) } : {}) });
                if (job.ranOn?.kind !== "agent" || job.ranOn.name !== runnerName) throw new Error(`It ${where}, not on the runner "${runnerName}".`);
                if (status !== "passed") throw new Error(`It ended ${status}${exec?.error ? `: ${String(exec.error).slice(0, 300)}` : ""}.`);
                return where;
            });
        }

        const installDir = path.join(tmp, "install folder");
        if (opts.lifecycle) {
            await step("Check the install folder holds no credential or one-time code as plain text", async () => {
                const plain = plainCredentialsIn(installDir);
                if (plain.length) throw new Error(`A runner credential or one-time code is readable in: ${plain.join(", ")}`);
                return "the credential is only in the computer's own store";
            });
            await step("Stop the runner the way a person does", async () => {
                if (target.system === "windows") {
                    const r = spawnSync(cmd.command, ["--stop", "--install-dir", installDir], { cwd: kitDir, encoding: "utf8", timeout: 90_000, windowsHide: true });
                    if (r.status !== 0) throw new Error(`--stop ended with code ${r.status}: ${redact(`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-400), secrets)}`);
                } else process.kill(-runner.child.pid, "SIGINT");
                await Promise.race([runner.exited, sleep(60_000)]);
                if (Children.running(runner)) throw new Error(`The runner was still running a minute after it was asked to stop.\n${tail(runner.output)}`);
                return `ended with code ${runner.code}${(await myRunner()) ? " (the platform still shows it online until its last poll times out)" : ""}`;
            });
            await step("Start it again (its saved credential, no new code)", async () => {
                if (fs.existsSync(path.join(installDir, "app", "runner.enroll")) || fs.existsSync(path.join(installDir, "runner", "runner.enroll"))) throw new Error("The one-time code is still in the install folder after the runner used it.");
                runner = children.start("runner (again)", cmd.command, cmd.args, { cwd: kitDir, env: runnerEnv(process.env, { linkNodeModules: opts.linkNodeModules, path: pathValue }) });
                const t0 = Date.now();
                await until("the runner to be online again", async () => {
                    if (!Children.running(runner)) throw new Error(`The runner stopped before it was online again (code ${runner.code}).\n${tail(runner.output)}`);
                    return (await myRunner())?.id === tokenId;
                }, opts.onlineTimeout * 1000, 2000);
                return `online again after ${fmtMs(Date.now() - t0)}, with the same access`;
            });
            // A renewal (every 30 days, or when the platform asks), made due now in the platform's own database, then two restarts: the first
            // renews and keeps the new credential in the computer's store; the second can only come online if it reads the new one back,
            // because the old one stopped working when the new one was first used. Only with the platform this check started itself.
            const dbFile = path.join(tmp, "data", "platform.db");
            if (!deps.startPlatform && fs.existsSync(dbFile)) {
                const tokenRow = async (update) => {
                    const { DatabaseSync } = await import("node:sqlite");
                    const db = new DatabaseSync(dbFile);
                    try {
                        db.exec("PRAGMA busy_timeout = 10000");
                        if (update) db.prepare("UPDATE agent_tokens SET rotated_at = ? WHERE id = ?").run(update, tokenId);
                        return db.prepare("SELECT rotated_at, previous_hash FROM agent_tokens WHERE id = ?").get(tokenId);
                    } finally {
                        db.close();
                    }
                };
                const stopRunner = async () => {
                    if (target.system === "windows") {
                        const r = spawnSync(cmd.command, ["--stop", "--install-dir", installDir], { cwd: kitDir, encoding: "utf8", timeout: 90_000, windowsHide: true });
                        if (r.status !== 0) throw new Error(`--stop ended with code ${r.status}: ${redact(`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-400), secrets)}`);
                    } else process.kill(-runner.child.pid, "SIGINT");
                    await Promise.race([runner.exited, sleep(60_000)]);
                    if (Children.running(runner)) throw new Error(`The runner was still running a minute after it was asked to stop.\n${tail(runner.output)}`);
                };
                const startRunner = async (name) => {
                    runner = children.start(name, cmd.command, cmd.args, { cwd: kitDir, env: runnerEnv(process.env, { linkNodeModules: opts.linkNodeModules, path: pathValue }) });
                    await until("the runner to be online again", async () => {
                        if (!Children.running(runner)) throw new Error(`The runner stopped before it was online again (code ${runner.code}).\n${tail(runner.output)}`);
                        return (await myRunner())?.id === tokenId;
                    }, opts.onlineTimeout * 1000, 2000);
                };
                await step("Renew its credential (made due now) and start it again", async () => {
                    const due = new Date(Date.now() - 31 * 24 * 3600_000).toISOString();
                    await stopRunner();
                    await tokenRow(due);
                    await startRunner("runner (renewing)");
                    // Renewed (a new rotation time), and the new credential is in use (the old one's grace ended).
                    const row = await until("the runner to renew its credential", async () => {
                        if (!Children.running(runner)) throw new Error(`The runner stopped while renewing its credential (code ${runner.code}).\n${tail(runner.output)}`);
                        const r = await tokenRow();
                        return r && r.rotated_at !== due && r.previous_hash === null ? r : undefined;
                    }, 120_000, 2000);
                    const plain = plainCredentialsIn(installDir);
                    if (plain.length) throw new Error(`After the renewal a runner credential is readable in: ${plain.join(", ")}`);
                    return `renewed at ${row.rotated_at}; the old credential no longer works`;
                });
                await step("Start it again on the renewed credential (read back from the computer's store)", async () => {
                    await stopRunner();
                    await startRunner("runner (renewed)");
                    // A runner that read back the old credential would be refused at once and stop.
                    await sleep(20_000);
                    if (!Children.running(runner)) throw new Error(`The runner stopped after starting on its renewed credential (code ${runner.code}).\n${tail(runner.output)}`);
                    return "online with the renewed credential, still running 20 s later";
                });
            }
        }

        await step("Remove this computer (Settings, Your runner) and check the runner stops with a plain message", async () => {
            const r = await api("POST", "/api/me/runner/retire");
            if (r.status !== 200) throw new Error(`Removing the computer failed (${r.status}): ${r.message}`);
            await Promise.race([runner.exited, sleep(120_000)]);
            if (Children.running(runner)) throw new Error(`The runner was still running 2 minutes after its access was revoked.\n${tail(runner.output)}`);
            if (!/no longer accepts this runner/i.test(runner.output)) throw new Error(`The runner stopped (code ${runner.code}) without the plain "no longer accepts this runner" message.\n${tail(runner.output)}`);
            return `ended with code ${runner.code}`;
        });

        await step("Check no secret was printed", async () => {
            const leaks = children.list.filter((c) => secrets.slice(1).some((s) => s && c.output.includes(s))).map((c) => c.name);
            if (leaks.length) throw new Error(`The runner token appeared in the output of: ${leaks.join(", ")}.`);
            return undefined;
        });

        if (opts.lifecycle) {
            await step("Uninstall it and check nothing is left", async () => {
                const un = target.system === "windows" ? spawnSync(cmd.command, ["--uninstall", "--silent", "--install-dir", installDir], { cwd: kitDir, encoding: "utf8", timeout: 120_000, windowsHide: true }) : spawnSync("sh", [cmd.args[0], "--uninstall", "--silent", "--install-dir", installDir], { cwd: kitDir, encoding: "utf8", timeout: 120_000 });
                if (un.status !== 0) throw new Error(`--uninstall ended with code ${un.status}: ${redact(`${un.stdout ?? ""}${un.stderr ?? ""}`.slice(-400), secrets)}`);
                // A copy of the Windows program that runs from the install folder removes itself a few seconds after it exits; nothing else is
                // removed later, so a folder still here after 30 s is a finding (the report below says what could hold it).
                const goneT0 = Date.now();
                await until("the install folder to be gone", async () => !fs.existsSync(installDir), 30_000, 1000).catch(() => undefined);
                const goneAfter = fs.existsSync(installDir) ? null : Math.round((Date.now() - goneT0) / 1000);
                const left = [installDir, ...(target.system === "mac" ? [path.join(os.homedir(), "Library", "LaunchAgents", "app.aitesting.runner.plist")] : []), ...(target.system === "windows" && process.env.APPDATA ? [path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "AI Testing Runner.lnk")] : [])].filter((f) => fs.existsSync(f));
                if (left.length) {
                    // Say what is still there and what the uninstall said, so a failure on a machine nobody can log in to explains itself.
                    const inside = (dir, depth = 0) => {
                        try {
                            return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => [path.join(dir, e.name).slice(installDir.length + 1) + (e.isDirectory() ? "/" : ""), ...(e.isDirectory() && depth < 2 ? inside(path.join(dir, e.name), depth + 1) : [])]);
                        } catch {
                            return [];
                        }
                    };
                    const contents = fs.existsSync(installDir) ? inside(installDir).slice(0, 40) : [];
                    const said = redact(`${un.stdout ?? ""}${un.stderr ?? ""}`.trim().slice(-600), secrets);
                    // On Windows a folder stays when a process still has it (or something in it) open, or as its current folder: name the
                    // processes whose program or command line points into the install folder, and what removing what is left answers now.
                    let holders = "";
                    if (target.system === "windows" && fs.existsSync(installDir)) {
                        // Which processes could hold it: a process whose current folder is in there does not show the path in its command line,
                        // so list every runner-related program (this is GitHub's throwaway machine, not a person's computer), with its parent.
                        const ps = spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|powershell|pwsh|chrome|msedge|chrome_crashpad_handler|AITestingRunner.*|cmd|conhost|npm.*|adb|emulator.*|qemu.*|ffmpeg.*)\\.exe$' -and $_.ProcessId -ne $PID } | ForEach-Object { \"$($_.ProcessId)/$($_.ParentProcessId) $($_.Name): $($_.CommandLine)\" }"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
                        const list = redact(`${ps.stdout ?? ""}`.trim().replace(/\r?\n/g, " | "), secrets).slice(0, 2500);
                        const tries = contents.filter((c) => c.endsWith("/")).map((c) => {
                            try {
                                fs.rmdirSync(path.join(installDir, c));
                                return `${c} removed now`;
                            } catch (e) {
                                return `${c} ${e && typeof e === "object" && "code" in e ? e.code : "error"}`;
                            }
                        });
                        holders = `; processes using it: ${list || "none found"}${tries.length ? `; removing now: ${tries.join(", ")}` : ""}`;
                    }
                    throw new Error(`Left behind after uninstalling: ${left.join(", ")}${contents.length ? `; still in the install folder: ${contents.join(", ")}` : ""}${said ? `; the uninstall said: ${said}` : ""}${holders}`);
                }
                return `no install folder, no sign-in start${goneAfter !== null && goneAfter > 2 ? ` (the folder went ${goneAfter} s after the uninstall ended)` : ""}`;
            });
        }
        report.verdict = "passed";
    } catch (e) {
        if (e instanceof Skip) {
            report.verdict = "skipped";
            report.skipReason = e.message;
        } else {
            report.verdict = "failed";
            report.error = redact(String(e?.message ?? e).split("\n")[0], secrets);
        }
    } finally {
        const t0 = Date.now();
        let cleanup = "stopped what this run started";
        try {
            await children.stopAll();
            // The link to this checkout's node_modules goes first, and only the link (rmdir of a junction, unlink of a symlink): a recursive
            // delete must never walk into the real folder.
            for (const l of links) {
                if (WIN) fs.rmdirSync(l);
                else fs.unlinkSync(l);
            }
            if (links.some((l) => fs.existsSync(l))) throw new Error(`The link ${links.find((l) => fs.existsSync(l))} could not be removed, so the temporary folder was kept.`);
            if (opts.linkNodeModules && !fs.existsSync(path.join(REPO, "node_modules", "playwright", "package.json"))) throw new Error("This checkout's node_modules is damaged after the clean-up.");
            if (opts.keep) report.kept = tmp;
            else {
                try {
                    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
                } catch {
                    report.notes.push(`The temporary folder ${tmp} could not be deleted completely; the system cleans it up later.`);
                }
            }
        } catch (e) {
            cleanup = e.message;
            report.verdict = "failed";
            report.error ??= e.message;
        }
        report.steps.push({ name: "Clean up", status: cleanup.startsWith("stopped") ? "ok" : "failed", ms: Date.now() - t0, detail: cleanup });
        report.durationMs = Date.now() - started;
        writeReport(report, children, outDir, secrets);
    }
    return report;
}

function writeReport(report, children, outDir, secrets) {
    try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
        fs.writeFileSync(path.join(outDir, "report.md"), `# Runner smoke check\n\n\`\`\`\n${renderReport(report)}\n\`\`\`\n`);
        for (const c of children.list) fs.writeFileSync(path.join(outDir, `${c.name.replace(/[^a-z0-9]+/gi, "-")}.log`), redact(c.output, secrets));
    } catch (e) {
        report.notes.push(`The report could not be written to ${outDir}: ${e.message}`);
    }
}

// ── command line ────────────────────────────────────────────────────────────

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        if (!(e instanceof UsageError)) throw e;
        console.error(e.message);
        process.exit(2);
    }
    if (opts.help) {
        console.log(HELP);
        return;
    }
    const children = new Children();
    // Ctrl-C: stop only what this run started, then leave.
    const interrupt = async () => {
        await children.stopAll();
        process.exit(1);
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    console.log(`Runner smoke check: ${KIT_WORDS[opts.kit]}${opts.noNodeOnPath ? ", no Node.js on the PATH" : ""}, port ${opts.port}. This takes a few minutes.`);
    const report = await runSmoke(opts, { children });
    console.log(renderReport(report));
    process.exit(report.verdict === "failed" ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((e) => {
        console.error(`The smoke check itself could not run: ${e?.stack ?? e}`);
        process.exit(1);
    });
}
