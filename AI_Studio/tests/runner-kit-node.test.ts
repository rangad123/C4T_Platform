/**
 * The runner kit's start scripts find Node.js, against a REAL platform: each unzipped kit is started the way a tester starts it, on a
 * computer where `node` is NOT on the PATH of the window and Node.js lives where nvm, Volta, Homebrew, fnm or nvm-windows put it. The
 * script must say which Node.js it uses ("Using Node.js v26.0.0 from ..."), trade the one-time code inside the person's download
 * (POST /api/me/runner/download, round 45) for their runner credential, show up as connected in Settings and run a real API test the
 * person starts. A Node.js that is too old is reported as too old (with its version and place), and with no
 * Node.js at all the message lists where the script looked; neither starts a runner.
 *
 * "Fake" Node.js installs: on Unix a small shim that answers --version with the version it claims and otherwise runs this computer's
 * Node.js (so the runner really runs under it); on Windows a hard link to this computer's node.exe in a folder named the way the
 * installer, nvm-windows, Volta or fnm name theirs, and a node.cmd that only prints an old version. The real Node.js of this computer is
 * hidden from the scripts by an explicit PATH, HOME and (Windows) the folder variables; no process is touched but the ones started here.
 * What is NOT covered: a real Mac, a real nvm/fnm/Volta install, Gatekeeper, Apple Silicon. The same scripts are exercised without a
 * platform in tests/runner-kit-node-unit.test.ts.
 *
 * Run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-kit-node.test.ts
 * (it starts no browser, but the machine is small). Ports: platform 8807, fixture application 8808.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { buildServer } from "../src/platform/server.js";
import { allowPrivateAddresses, downloadRunner, myOnlineRunner, personToken, retireMyRunner } from "./fixtures/runner-person.js";
import { Worker } from "../src/platform/worker.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLATFORM_PORT = 8807;
const APP_PORT = 8808;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "kit-node-admin-key-5b21e9c4a7";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS", "RUNNER_KIT_DIR", "RUNNER_KIT_RATE_PER_MINUTE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let tmp: string;
let appServer: http.Server;
const children: ChildProcess[] = [];
const links: string[] = [];

const fwd = (p: string) => p.replaceAll("\\", "/");
/** The form Git Bash uses inside a colon separated list (C:/x/y would be split at the colon). */
const msys = (p: string) => (process.platform === "win32" ? fwd(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`) : p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, ms = 60_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v) return v;
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
        await sleep(250);
    }
}

/** The person whose runner this is: an owner with their own API token (made in beforeAll). */
let person = { id: "", token: "" };
let stopBeat: (() => void) | undefined;
/** The runner takes the computer's own name (the download names none). */
const NAME = os.hostname().trim().slice(0, 64) || "agent";
const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${person.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    return { status: res.status, headers: res.headers, buf, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; headers: Headers; buf: Buffer; text: string; body: any };
};
/** A project whose imported tests run at once (no approval step: this file is about finding Node.js). */
const newProject = async (name: string) => {
    const id = (await admin("POST", "/api/projects", { name })).body.id as string;
    expect((await admin("PUT", `/api/projects/${id}/review-policy`, { aiGenerated: false, edits: false, healing: false })).status).toBe(200);
    return id;
};
/**
 * The person's download: plain files (no installer or complete build here, so a Mac gets them; Linux is one script since round 50), all three start scripts inside. One runner per person: the
 * one the last test left (stopped, maybe still shown online for a while) is removed first, so "online" always means this download's runner.
 */
const download = async (_projectId: string, _label: string, platformName: "windows" | "unix") => {
    await retireMyRunner(BASE, person.token);
    return downloadRunner(BASE, person.token, platformName === "windows" ? "windows" : "mac");
};
/** The person's runner while it is connected (as a one-element list, so "none" reads as empty). */
const onlineAgents = async (_projectId?: string) => {
    const r = await myOnlineRunner(BASE, person.token);
    return r ? [r] : [];
};

/** Unzip a kit into  <tmp>/<n>/Maya Singh/runner (1)  (spaces and brackets on purpose) and give it this repository's node_modules (a junction). */
let counter = 0;
function unpack(zip: Buffer): string {
    const parent = path.join(tmp, String(++counter), "Maya Singh");
    fs.mkdirSync(parent, { recursive: true });
    const kit = path.join(parent, "runner (1)");
    for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(zip)))) {
        const dest = path.join(kit, name.split("/").slice(1).join("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
    }
    const link = path.join(kit, "node_modules");
    fs.symlinkSync(path.join(REPO, "node_modules"), link, "junction");
    links.push(link);
    return kit;
}

interface Running {
    child: ChildProcess;
    out: string[];
    exited: Promise<number | null>;
}
function launch(command: string, args: string[], cwd: string, extraEnv: Record<string, string | undefined>): Running {
    // Windows names are case-insensitive but this process's copy may spell them differently (PROGRAMFILES): an override replaces the name however it is spelled.
    const overridden = new Set(Object.keys(extraEnv).map((k) => k.toUpperCase()));
    const inherited = Object.entries(process.env).filter(([k]) => !overridden.has(k.toUpperCase()));
    const env: NodeJS.ProcessEnv = Object.fromEntries([...inherited, ...Object.entries(extraEnv)].filter(([k, v]) => v !== undefined && !/^(AGENT_|RUNNER_KIT_)/.test(k)));
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    const out: string[] = [];
    child.stdout?.on("data", (d) => out.push(String(d)));
    child.stderr?.on("data", (d) => out.push(String(d)));
    return { child, out, exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))) };
}
const output = (r: Running) => r.out.join("").replace(/\r/g, "");

/** Kill a process we started, and only that process tree. */
function killOurs(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null || child.signalCode) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGKILL");
}

function findBash(): string | undefined {
    for (const candidate of [process.env.KIT_TEST_BASH, "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "/bin/bash"]) {
        if (!candidate || !fs.existsSync(candidate)) continue;
        const r = spawnSync(candidate, ["-c", "echo kit-ok"], { encoding: "utf8", timeout: 20_000 });
        if (r.status === 0 && r.stdout.trim() === "kit-ok") return candidate;
    }
    return undefined;
}
const BASH = findBash();
const TOOLS = BASH ? (process.platform === "win32" ? msys(path.dirname(BASH)) : "/usr/bin:/bin") : "";
const HOST_HAS_UNIX_NODE = ["/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node", "/opt/local/bin/node"].some((p) => fs.existsSync(p));
const REAL_NODE = fwd(process.execPath);
const fresh = (...parts: string[]) => {
    const dir = path.join(tmp, `d${++counter}`, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

/** A "node" that says it is `version` and otherwise runs this computer's Node.js. */
function shim(file: string, version: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in\n    --version|-v) echo ${version} ;;\n    *) exec "${REAL_NODE}" "$@" ;;\nesac\n`, { mode: 0o755 });
    return file;
}
const tailInTmp = (file: string) => fwd(path.relative(tmp, file));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    process.env.RUNNER_KIT_RATE_PER_MINUTE = "100";
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-kit-node-api-"));
    const bundleDir = path.join(tmp, "dist-runner");
    await buildRunner({ outDir: bundleDir });
    process.env.RUNNER_KIT_DIR = bundleDir;
    process.env.RUNNER_INSTALLER_DIR = path.join(tmp, "no-installer");
    process.env.RUNNER_COMPLETE_DIR = path.join(tmp, "no-complete");
    appServer = http.createServer((req, res) => {
        if (req.url === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html lang=\"en\"><head><title>Fixture</title></head><body><main><h1>Fixture</h1></main></body></html>");
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-kit-node-data-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), PUBLIC_URL: BASE, CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", EXECUTION_MODE: "runners" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
    // EXECUTION_MODE=runners takes runs only while the part that hands them to runners is alive.
    stopBeat = startHeartbeat(platform.db);
    person = personToken(server);
}, 180_000);

afterAll(async () => {
    for (const c of children) killOurs(c);
    await sleep(500);
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    stopBeat?.();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    // Take the junctions away first (rmdir removes only the link), then the folders.
    for (const l of links) {
        try {
            fs.rmdirSync(l);
        } catch {
            /* already gone */
        }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    // A process we killed can hold its folder for a moment (Windows); retry, and leave a stray temp folder rather than fail the run for it.
    try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
    } catch {
        /* the operating system cleans the temp folder later */
    }
    if (!fs.existsSync(path.join(REPO, "node_modules", "@playwright", "test", "package.json"))) throw new Error("The repository's node_modules was damaged by the cleanup");
});

/** Start the kit's script, wait until the runner it starts is online under the platform, and return what the script printed. */
async function startAndWaitOnline(projectId: string, command: string, args: string[], kit: string, env: Record<string, string | undefined>): Promise<Running> {
    const run = launch(command, args, kit, env);
    await until("the runner to be online", async () => (await onlineAgents(projectId))[0], 90_000).catch((e) => {
        throw new Error(`${e.message}\n--- script output ---\n${output(run)}`);
    });
    return run;
}

/** Import an API test, send the project's runs to the runner, and check the verdict that comes back. */
async function runApiTest(projectId: string, runnerName: string): Promise<void> {
    const imp = await admin("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: APP,
        validate: false,
        specs: [{ title: "The health endpoint answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/health" }, { action: "assertResponse", check: "status", expected: 200 }] }],
    });
    expect(imp.status, imp.text).toBe(202);
    const id = (imp.body.tests as Array<{ id: string }>)[0]!.id;
    // No runner is chosen: the run goes to the person's own runner. The fixture application is on this computer: private addresses on.
    expect(await allowPrivateAddresses(BASE, person.token)).toBe(200);
    const started = await admin("POST", `/api/tests/${id}/validate`);
    expect(started.status, started.text).toBe(202);
    const job = await until("the job to finish", async () => {
        const j = (await admin("GET", `/api/test-generation/${started.body.jobId}`)).body;
        return ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status) ? j : undefined;
    }, 150_000);
    expect(job.ranOn, JSON.stringify({ status: job.status, error: job.error })).toMatchObject({ kind: "agent", name: runnerName });
    expect(((await admin("GET", `/api/tests/${id}/executions`)).body as Array<{ status: string }>)[0]).toMatchObject({ status: "passed" });
}

const gone = async (projectId: string) => (await onlineAgents(projectId)).length === 0;

// ── Mac and Linux: start-runner.sh under bash ───────────────────────────────

describe.skipIf(!BASH)("start-runner.sh finds a Node.js that is not on the PATH", () => {
    const env = (home: string, extra: Record<string, string> = {}) => ({ PATH: TOOLS, Path: TOOLS, HOME: fwd(home), TMPDIR: fwd(os.tmpdir()), AITP_KIT_SKIP_INSTALL: "1", AITP_KIT_NO_PAUSE: "1", AITP_KIT_SKIP_SHELL_SEARCH: "1", ...extra });

    it("nvm: says which Node.js it uses, connects, runs an API test, and ends with a plain message when the computer is removed", async () => {
        const p = await newProject("Kit sh nvm");
        const dl = await download(p, "nvm runner", "unix");
        const kit = unpack(dl.buf);
        const home = fresh("home");
        const node = shim(path.join(home, ".nvm", "versions", "node", "v26.0.0", "bin", "node"), "v26.0.0");
        const run = await startAndWaitOnline(p, BASH!, ["start-runner.sh"], kit, env(home));
        const text = output(run);
        expect(text).toMatch(new RegExp(`Using Node\\.js v26\\.0\\.0 from \\S*${escapeRe(tailInTmp(node))}\\.`));
        // Only the start script's Node.js messages: the runner's own capability line may say a phone tool "was not found".
        expect(text).not.toMatch(/Node\.js[^\n]*(not installed|was not found|too old)/);
        expect(text).toContain("Connected to the platform");
        await runApiTest(p, NAME);
        expect(await retireMyRunner(BASE, person.token)).toBe(200);
        expect(await Promise.race([run.exited, sleep(60_000).then(() => "timeout")]), output(run)).toBe(3);
        expect(output(run)).toMatch(/no longer accepts this runner/);
    }, 400_000);

    it("Volta: finds ~/.volta/bin/node and connects", async () => {
        const p = await newProject("Kit sh volta");
        const kit = unpack((await download(p, "volta runner", "unix")).buf);
        const home = fresh("home");
        const node = shim(path.join(home, ".volta", "bin", "node"), "v25.2.0");
        const run = await startAndWaitOnline(p, BASH!, ["start-runner.sh"], kit, env(home));
        expect(output(run)).toMatch(new RegExp(`Using Node\\.js v25\\.2\\.0 from \\S*${escapeRe(tailInTmp(node))}\\.`));
        killOurs(run.child);
    }, 150_000);

    it("Homebrew: finds a node in the folder it is told about (the script itself looks in /opt/homebrew/bin) and connects", async () => {
        const p = await newProject("Kit sh brew");
        const kit = unpack((await download(p, "brew runner", "unix")).buf);
        const brew = fresh("opt", "homebrew", "bin");
        const node = shim(path.join(brew, "node"), "v26.1.0");
        const run = await startAndWaitOnline(p, BASH!, ["start-runner.sh"], kit, env(fresh("home"), { AITP_KIT_EXTRA_NODE_DIRS: msys(brew) }));
        expect(output(run)).toMatch(new RegExp(`Using Node\\.js v26\\.1\\.0 from \\S*${escapeRe(tailInTmp(node))}\\.`));
        killOurs(run.child);
    }, 150_000);

    it("skips an old Node.js it meets first and connects with the newer one", async () => {
        const p = await newProject("Kit sh old and new");
        const kit = unpack((await download(p, "mixed runner", "unix")).buf);
        const home = fresh("home");
        shim(path.join(home, ".volta", "bin", "node"), "v20.11.0");
        const good = shim(path.join(home, ".nvm", "versions", "node", "v24.9.0", "bin", "node"), "v24.9.0");
        const run = await startAndWaitOnline(p, BASH!, ["start-runner.sh"], kit, env(home));
        expect(output(run)).toMatch(new RegExp(`Using Node\\.js v24\\.9\\.0 from \\S*${escapeRe(tailInTmp(good))}\\.`));
        killOurs(run.child);
    }, 150_000);

    it.skipIf(HOST_HAS_UNIX_NODE)("a Node.js that is too old is reported as too old, with its version and place, and no runner starts", async () => {
        const p = await newProject("Kit sh too old");
        const kit = unpack((await download(p, "old runner", "unix")).buf);
        const home = fresh("home");
        const old = shim(path.join(home, ".nvm", "versions", "node", "v20.11.0", "bin", "node"), "v20.11.0");
        const run = launch(BASH!, ["start-runner.sh"], kit, env(home));
        expect(await run.exited, output(run)).toBe(1);
        const text = output(run);
        expect(text).toMatch(new RegExp(`Found Node\\.js v20\\.11\\.0 at \\S*${escapeRe(tailInTmp(old))}\\. That is too old, the runner needs 24 or newer\\.`));
        expect(text).not.toMatch(/not installed|was not found/);
        expect(text).not.toMatch(/Connected|Starting the runner/);
        expect(fs.existsSync(path.join(kit, "work"))).toBe(false);
        expect(await gone(p)).toBe(true);
    }, 90_000);

    it.skipIf(HOST_HAS_UNIX_NODE)("with no Node.js anywhere the message lists where it looked, and no runner starts", async () => {
        const p = await newProject("Kit sh none");
        const kit = unpack((await download(p, "none runner", "unix")).buf);
        const run = launch(BASH!, ["start-runner.sh"], kit, env(fresh("home")));
        expect(await run.exited, output(run)).toBe(1);
        const text = output(run);
        expect(text).toContain("Node.js was not found on this computer. The runner needs Node.js 24 or newer.");
        expect(text).toContain("I looked on the PATH, in the Homebrew, nvm, fnm, Volta, asdf, mise, nodenv and n folders, and asked your login shell.");
        expect(text).toContain("brew install node");
        expect(text).toContain("nvm install 24");
        expect(text).not.toMatch(/Connected|Starting the runner|too old/);
        expect(await gone(p)).toBe(true);
    }, 90_000);
});

// ── Windows: start-runner.cmd under cmd.exe ─────────────────────────────────

const WIN = process.platform === "win32";
const SYS32 = WIN ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "";

/** Every place the script looks is an empty folder of ours; the PATH holds only Windows' own tools. */
function winEnv(root: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    const d = (...p: string[]) => {
        const x = path.join(root, ...p);
        fs.mkdirSync(x, { recursive: true });
        return x;
    };
    return {
        PATH: SYS32,
        Path: SYS32,
        // Windows hands a 64-bit process its ProgramFiles from ProgramW6432, so the two are one folder here too.
        ProgramFiles: d("pf64", "Program Files"),
        ProgramW6432: d("pf64", "Program Files"),
        "ProgramFiles(x86)": d("pf86", "Program Files (x86)"),
        LOCALAPPDATA: d("local"),
        APPDATA: d("roaming"),
        NVM_HOME: undefined,
        NVM_SYMLINK: undefined,
        VOLTA_HOME: undefined,
        // The runner finds its browsers under the real LOCALAPPDATA, which this environment replaced.
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright"),
        AITP_KIT_SKIP_INSTALL: "1",
        AITP_KIT_NO_PAUSE: "1",
        AITP_KIT_SKIP_SHELL_SEARCH: "1",
        ...extra,
    };
}
function realNodeExe(file: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
        fs.linkSync(process.execPath, file);
    } catch {
        fs.copyFileSync(process.execPath, file);
    }
    return file;
}
const startCmd = (kit: string, env: Record<string, string | undefined>) => launch(path.join(SYS32, "cmd.exe"), ["/d", "/c", ".\\start-runner.cmd"], kit, env);

describe.skipIf(!WIN)("start-runner.cmd finds a Node.js that is not on the PATH", () => {
    it("Program Files (x86): says which Node.js it uses, connects, runs an API test, and ends with a plain message when the computer is removed", async () => {
        const p = await newProject("Kit cmd x86");
        const dl = await download(p, "x86 runner", "windows");
        const kit = unpack(dl.buf);
        const env = winEnv(fresh("env"));
        const exe = realNodeExe(path.join(env["ProgramFiles(x86)"]!, "nodejs", "node.exe"));
        const run = startCmd(kit, env);
        await until("the runner to be online", async () => (await onlineAgents(p))[0], 90_000).catch((e) => {
            throw new Error(`${e.message}\n--- script output ---\n${output(run)}`);
        });
        const text = output(run);
        expect(text).toContain(`Using Node.js ${process.version} from ${exe}.`);
        // Only the start script's Node.js messages: the runner's own capability line may say a phone tool "was not found".
        expect(text).not.toMatch(/Node\.js[^\n]*(not installed|was not found|too old)/);
        expect(text).toContain("Connected to the platform");
        await runApiTest(p, NAME);
        expect(await retireMyRunner(BASE, person.token)).toBe(200);
        expect(await Promise.race([run.exited, sleep(60_000).then(() => "timeout")]), output(run)).toBe(1);
        expect(output(run)).toMatch(/no longer accepts this runner/);
    }, 400_000);

    it("Volta, nvm-windows and fnm layouts all connect", async () => {
        const layouts: Array<[string, (env: Record<string, string | undefined>, root: string) => string]> = [
            ["volta", (env) => realNodeExe(path.join(env.LOCALAPPDATA!, "Volta", "bin", "node.exe"))],
            ["nvm-windows", (env, root) => realNodeExe(path.join((env.NVM_HOME = path.join(root, "nvm (home)")), "v26.0.0", "node.exe"))],
            ["fnm", (env) => realNodeExe(path.join(env.APPDATA!, "fnm", "node-versions", "v26.0.0", "installation", "node.exe"))],
        ];
        for (const [name, setup] of layouts) {
            const p = await newProject(`Kit cmd ${name}`);
            const kit = unpack((await download(p, `${name} runner`, "windows")).buf);
            const root = fresh("env");
            const env = winEnv(root);
            const exe = setup(env, root);
            const run = startCmd(kit, env);
            await until(`the ${name} runner to be online`, async () => (await onlineAgents(p))[0], 90_000).catch((e) => {
                throw new Error(`${e.message}\n--- script output ---\n${output(run)}`);
            });
            expect(output(run), name).toContain(`Using Node.js ${process.version} from ${exe}.`);
            killOurs(run.child);
        }
    }, 400_000);

    it("skips an old Node.js it meets first and connects with the newer one", async () => {
        const p = await newProject("Kit cmd mixed");
        const kit = unpack((await download(p, "mixed runner", "windows")).buf);
        const env = winEnv(fresh("env"));
        fs.mkdirSync(path.join(env.ProgramFiles!, "nodejs"), { recursive: true });
        fs.writeFileSync(path.join(env.ProgramFiles!, "nodejs", "node.cmd"), "@echo v20.11.0\r\n");
        const good = realNodeExe(path.join(env.LOCALAPPDATA!, "Volta", "bin", "node.exe"));
        const run = startCmd(kit, env);
        await until("the runner to be online", async () => (await onlineAgents(p))[0], 90_000).catch((e) => {
            throw new Error(`${e.message}\n--- script output ---\n${output(run)}`);
        });
        expect(output(run)).toContain(`Using Node.js ${process.version} from ${good}.`);
        killOurs(run.child);
    }, 150_000);

    it("a Node.js that is too old is reported as too old, with its version and place, and no runner starts", async () => {
        const p = await newProject("Kit cmd too old");
        const kit = unpack((await download(p, "old runner", "windows")).buf);
        const env = winEnv(fresh("env"));
        const cmdFile = path.join(env["ProgramFiles(x86)"]!, "nodejs", "node.cmd");
        fs.mkdirSync(path.dirname(cmdFile), { recursive: true });
        fs.writeFileSync(cmdFile, "@echo v20.11.0\r\n");
        const run = startCmd(kit, env);
        expect(await run.exited, output(run)).toBe(1);
        const text = output(run);
        expect(text).toContain(`Found Node.js v20.11.0 at ${cmdFile}. That is too old, the runner needs 24 or newer.`);
        expect(text).not.toMatch(/not installed|was not found/);
        expect(text).not.toMatch(/Connected|Starting the runner/);
        expect(fs.existsSync(path.join(kit, "work"))).toBe(false);
        expect(await gone(p)).toBe(true);
    }, 90_000);

    it("with no Node.js anywhere the message lists where it looked, and no runner starts", async () => {
        const p = await newProject("Kit cmd none");
        const kit = unpack((await download(p, "none runner", "windows")).buf);
        const run = startCmd(kit, winEnv(fresh("env")));
        expect(await run.exited, output(run)).toBe(1);
        const text = output(run);
        expect(text).toContain("Node.js was not found on this computer. The runner needs Node.js 24 or newer.");
        expect(text).toContain("I looked on the PATH, in Program Files, in the nvm-windows, Volta and fnm folders, and in the PATH saved in Windows.");
        expect(text).toContain("https://nodejs.org");
        expect(text).not.toMatch(/Connected|Starting the runner|too old/);
        expect(await gone(p)).toBe(true);
    }, 90_000);

    it("finds this computer's own Node.js through the PATH Windows has saved, when the window's PATH has none (if this computer has one saved)", async () => {
        const probe = spawnSync(path.join(SYS32, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-Command", "foreach ($s in 'Machine','User') { $p = [Environment]::GetEnvironmentVariable('Path', $s); if ($p) { foreach ($d in $p.Split(';')) { if ($d -and (Test-Path -LiteralPath (Join-Path $d 'node.exe'))) { 'yes' } } } }"], { encoding: "utf8", timeout: 30_000 });
        if (!/yes/.test(probe.stdout)) return; // nothing saved on this computer, so nothing to find
        const p = await newProject("Kit cmd saved path");
        const kit = unpack((await download(p, "saved runner", "windows")).buf);
        const run = startCmd(kit, winEnv(fresh("env"), { AITP_KIT_SKIP_SHELL_SEARCH: "0" }));
        await until("the runner to be online", async () => (await onlineAgents(p))[0], 120_000).catch((e) => {
            throw new Error(`${e.message}\n--- script output ---\n${output(run)}`);
        });
        expect(output(run)).toMatch(/Using Node\.js v\d+\.\d+\.\d+ from .*node\.exe\./);
        killOurs(run.child);
    }, 200_000);
});
