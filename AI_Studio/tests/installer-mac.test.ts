/**
 * The macOS installer against a REAL platform: a kit is downloaded from the platform the way a tester downloads it, "AI Testing
 * Runner.app" is put beside the runner files, and runner-setup.sh is run under Git Bash (or any POSIX shell) as a simulated Mac. There is
 * no Node.js anywhere on its search path, so it downloads one from a local stand-in for nodejs.org (a real .tar.gz holding a Node.js shim
 * that runs this computer's real Node.js), checks the SHA-256, unpacks it, and starts the runner with it. The runner connects to the
 * platform with the token inside the kit, shows up as online, runs a real API test and returns the verdict. A revoked token ends the run
 * with the plain message; a second launch only shows the status; --uninstall stops only the runner this installer recorded.
 * The LaunchAgent's command line (--run-loop) is also run for real, without launchd.
 *
 * What is NOT covered (never run on a Mac): Terminal and the .command hand-over, the osascript dialogs, launchctl loading the agent,
 * Gatekeeper and App Translocation, Rosetta detection with sysctl, the real nodejs.org download, hdiutil, signing.
 *
 * Run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/installer-mac.test.ts
 * (it starts no browser, but the machine is small). Ports: platform 6610, fixture application 6613, nodejs.org stand-in 6614.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
// @ts-expect-error plain JavaScript build scripts (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { APP_NAME, buildInstallerMac } from "../scripts/build-installer-mac.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLATFORM_PORT = 6610;
const APP_PORT = 6613;
const DIST_PORT = 6614;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const DIST = `http://127.0.0.1:${DIST_PORT}`;
const API_KEY = "installer-mac-admin-key-7c3e51d0a9";
const NODE_VERSION = "24.12.1";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS", "RUNNER_KIT_DIR", "AGENT_MAX_TOKENS", "RUNNER_KIT_RATE_PER_MINUTE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const fwd = (p: string) => p.replaceAll("\\", "/");
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

function findShell(name: string): string | undefined {
    const dirs = process.platform === "win32" ? ["C:\\Program Files\\Git\\usr\\bin"] : ["/bin", "/usr/bin"];
    for (const d of dirs) {
        const p = path.join(d, process.platform === "win32" ? `${name}.exe` : name);
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}
const BASH = [process.env.KIT_TEST_BASH, findShell("bash")].find((p) => p && fs.existsSync(p));
const TOOLS = BASH ? (process.platform === "win32" ? [msys(path.dirname(BASH)), msys(path.join(path.dirname(BASH), "..", "..", "mingw64", "bin"))] : ["/usr/bin", "/bin"]) : [];
const REAL_NODE = fwd(process.execPath);

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let tmp: string;
let appServer: http.Server;
let distServer: http.Server;
let installerApp: string;
const children: ChildProcess[] = [];
const links: string[] = [];
const distRequests: string[] = [];
let tarball: Buffer;
let counter = 0;
const fresh = (...parts: string[]) => {
    const dir = path.join(tmp, `d${++counter}`, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    return { status: res.status, headers: res.headers, buf, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; headers: Headers; buf: Buffer; text: string; body: any };
};
const newProject = async (name: string) => (await admin("POST", "/api/projects", { name })).body.id as string;
const onlineAgents = async (projectId: string) => ((await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; online: boolean }>).filter((a) => a.online);

/** Unzip a platform-built kit into  <tmp>/<n>/Maya Singh/runner (1)  and put "AI Testing Runner.app" beside the runner files (what the platform's zip will hold). */
function unpackKit(zip: Buffer): string {
    const kit = path.join(fresh("Maya Singh"), "runner (1)");
    for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(zip)))) {
        const dest = path.join(kit, name.split("/").slice(1).join("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
    }
    fs.cpSync(installerApp, path.join(kit, APP_NAME), { recursive: true });
    return kit;
}

interface Running {
    child: ChildProcess;
    out: string[];
    exited: Promise<number | null>;
}
const output = (r: Running) => r.out.join("").replace(/\r/g, "");
/** Start runner-setup.sh as a simulated Mac. Only this one's process tree is ever stopped. */
function launchSetup(kit: string, home: string, args: string[], extraEnv: Record<string, string | undefined> = {}, scriptPath?: string): Running {
    const overrides: Record<string, string | undefined> = {
        HOME: msys(home),
        PATH: TOOLS.join(":"),
        SHELL: "/nonexistent/shell",
        TMPDIR: fwd(os.tmpdir()),
        AITP_INSTALLER_UNAME_S: "Darwin",
        AITP_INSTALLER_UNAME_M: "arm64",
        AITP_INSTALLER_PROC_TRANSLATED: "0",
        AITP_INSTALLER_NO_UI: "1",
        AITP_INSTALLER_NO_PAUSE: "1",
        AITP_INSTALLER_SKIP_BROWSER: "1",
        AITP_INSTALLER_NODE_SEARCH_ONLY: "",
        AITP_KIT_SKIP_SHELL_SEARCH: "1",
        AITP_NODE_DIST_URL: DIST,
        STUB_LOG: fwd(path.join(tmp, "stub.log")),
        ...extraEnv,
    };
    const overridden = new Set(Object.keys(overrides).map((k) => k.toUpperCase()));
    const inherited = Object.entries(process.env).filter(([k]) => !overridden.has(k.toUpperCase()) && !/^(AGENT_|RUNNER_KIT_|AITP_)/.test(k));
    const env: NodeJS.ProcessEnv = Object.fromEntries([...inherited, ...Object.entries(overrides)].filter(([, v]) => v !== undefined));
    const script = msys(scriptPath ?? path.join(kit, APP_NAME, "Contents", "Resources", "runner-setup.sh"));
    const child = spawn(BASH!, [script, ...args], { cwd: kit, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    const out: string[] = [];
    child.stdout?.on("data", (d) => out.push(String(d)));
    child.stderr?.on("data", (d) => out.push(String(d)));
    return { child, out, exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))) };
}

/** Kill a process tree we started, and only that. */
function killOurs(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null || child.signalCode) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGKILL");
}

/** The part of the shim that runs the real Node.js. Git Bash only: a path argument is handed over in Windows form (its own conversion trips over an ampersand in a folder name). */
const SHIM_RUN = [
    "    *) n=$#; i=0",
    '       if command -v cygpath >/dev/null 2>&1; then while [ $i -lt $n ]; do a=$1; shift; case "$a" in /*) a=$(cygpath -m "$a") ;; esac; set -- "$@" "$a"; i=$((i+1)); done; fi',
    `       exec "${REAL_NODE}" "$@" ;;`,
].join("\n");

/** A real .tar.gz of node-v<version>-darwin-arm64/bin/node  (a shim that answers --version and otherwise runs this computer's Node.js). */
function buildTarball(version: string): Buffer {
    const top = `node-v${version}-darwin-arm64`;
    const src = fresh("tarball-src");
    fs.mkdirSync(path.join(src, top, "bin"), { recursive: true });
    fs.writeFileSync(path.join(src, top, "bin", "node"), `#!/bin/sh\ncase "$1" in\n    --version|-v) echo v${version} ;;\n${SHIM_RUN}\nesac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(src, top, "LICENSE"), "fake node for tests\n");
    const out = path.join(src, `${top}.tar.gz`);
    const r = spawnSync(BASH!, ["-c", 'cd "$1" && tar -czf "$2" "$3"', "sh", msys(src), msys(out), top], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
    return fs.readFileSync(out);
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    delete process.env.AGENT_MAX_TOKENS;
    delete process.env.RUNNER_KIT_RATE_PER_MINUTE;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inst-mac-api-"));
    const bundleDir = path.join(tmp, "dist-runner");
    await buildRunner({ outDir: bundleDir });
    process.env.RUNNER_KIT_DIR = bundleDir;
    installerApp = buildInstallerMac({ outDir: path.join(tmp, "built") }).appDir;

    if (BASH) {
        tarball = buildTarball(NODE_VERSION);
        const sum = crypto.createHash("sha256").update(tarball).digest("hex");
        distServer = http.createServer((req, res) => {
            distRequests.push(`${req.method} ${req.url}`);
            if (req.url === "/index.json") return void res.writeHead(200).end(`[{"version":"v${NODE_VERSION}","date":"2025-12-01","files":["osx-arm64-tar"],"npm":"11.6.1","lts":"Krypton","security":false}]`);
            if (req.url === `/v${NODE_VERSION}/SHASUMS256.txt`) return void res.writeHead(200).end(`${sum}  node-v${NODE_VERSION}-darwin-arm64.tar.gz\n`);
            if (req.url === `/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`) return void res.writeHead(200, { "content-length": String(tarball.length) }).end(req.method === "HEAD" ? undefined : tarball);
            res.writeHead(404).end("no");
        });
        await new Promise<void>((r) => distServer.listen(DIST_PORT, "127.0.0.1", () => r()));
    }
    appServer = http.createServer((req, res) => {
        if (req.url === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html lang=\"en\"><head><title>Fixture</title></head><body><main><h1>Fixture</h1></main></body></html>");
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inst-mac-data-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), PUBLIC_URL: BASE, CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
}, 180_000);

afterAll(async () => {
    for (const c of children) killOurs(c);
    await sleep(500);
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    distServer?.closeAllConnections?.();
    await new Promise((r) => distServer?.close(r));
    // Take the junctions away first (rmdir removes only the link), then the folders.
    for (const l of links) {
        try {
            fs.rmdirSync(l);
        } catch {
            /* already gone */
        }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
    } catch {
        /* the operating system cleans the temp folder later */
    }
    if (!fs.existsSync(path.join(REPO, "node_modules", "@playwright", "test", "package.json"))) throw new Error("The repository's node_modules was damaged by the cleanup");
});

/** Give the installed runner folder this repository's node_modules (a junction), standing in for the npm install that a Mac would do. */
function linkTools(install: string): string {
    const link = path.join(install, "runner", "node_modules");
    fs.symlinkSync(path.join(REPO, "node_modules"), link, "junction");
    links.push(link);
    return link;
}
const removeLink = (link: string) => {
    try {
        fs.rmdirSync(link);
    } catch {
        /* already gone */
    }
};

async function runApiTest(projectId: string, runnerName: string): Promise<void> {
    const imp = await admin("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: APP,
        validate: false,
        specs: [{ title: "The health endpoint answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/health" }, { action: "assertResponse", check: "status", expected: 200 }] }],
    });
    expect(imp.status, imp.text).toBe(202);
    const id = (imp.body.tests as Array<{ id: string }>)[0]!.id;
    expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
    const started = await admin("POST", `/api/tests/${id}/validate`);
    expect(started.status, started.text).toBe(202);
    const job = await until("the job to finish", async () => {
        const j = (await admin("GET", `/api/test-generation/${started.body.jobId}`)).body;
        return ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status) ? j : undefined;
    }, 150_000);
    expect(job.ranOn).toMatchObject({ kind: "agent", name: runnerName });
    expect(((await admin("GET", `/api/tests/${id}/executions`)).body as Array<{ status: string }>)[0]).toMatchObject({ status: "passed" });
}

describe.skipIf(!BASH)("AI Testing Runner.app against a real platform (simulated Mac)", () => {
    it("downloads Node.js, installs the runner files, starts the runner, which connects, runs a real API test and returns the verdict; a revoked token ends it plainly", async () => {
        const p = await newProject("Mac installer story");
        const dl = await admin("POST", `/api/projects/${p}/runner-kits`, { name: "mac runner", platform: "unix" });
        expect(dl.status, dl.text).toBe(200);
        const kit = unpackKit(dl.buf);
        const home = fresh("Users", "Maya Singh");
        const install = path.join(home, "Library", "Application Support", "AITestingRunner");

        // 1. Set up only: Node.js is downloaded and checked, the files are copied, nothing is started.
        const setup = launchSetup(kit, home, ["--silent", "--no-start"], { AITP_INSTALLER_SKIP_NPM: "1" });
        expect(await setup.exited, output(setup)).toBe(0);
        const first = output(setup);
        expect(first).toMatch(/\[1\/5\] Node\.js 24 or newer \.\.\. downloading /);
        expect(first).toMatch(new RegExp(`\\[1/5\\] Node\\.js 24 or newer \\.\\.\\. done \\(v${NODE_VERSION.replaceAll(".", "\\.")} at \.+/node/bin\\)`));
        expect(first).toContain("[2/5] Runner files ... done (7 of 7 files copied to ");
        expect(first).toMatch(/\[3\/5\] Test tools \.\.\. (not complete|installing|skipped)/);
        expect(first).toContain("[5/5] Platform connection ... found (");
        expect(distRequests).toContain(`GET /v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`);
        expect(fs.existsSync(path.join(install, "node", "bin", "node"))).toBe(true);
        expect(fs.readFileSync(path.join(install, "runner", "runner.token"), "utf8")).toBe(fs.readFileSync(path.join(kit, "runner.token"), "utf8"));
        const downloadsBefore = distRequests.length;

        // 2. Give the install the repository's test tools (what npm would install on a Mac), then open the app again: everything is skipped
        //    and the runner starts, with the Node.js that was downloaded.
        const link = linkTools(install);
        const run = launchSetup(kit, home, ["--silent"]);
        await until("the runner to be online", async () => (await onlineAgents(p))[0], 90_000).catch((e) => {
            throw new Error(`${e.message}\n--- installer output ---\n${output(run)}`);
        });
        const text = output(run);
        expect(text).toMatch(new RegExp(`\\[1/5\\] Node\\.js 24 or newer \\.\\.\\. found \\(v${NODE_VERSION.replaceAll(".", "\\.")} at \.+/node/bin\\), skipped`));
        expect(text).toContain("[2/5] Runner files ... found, up to date, skipped");
        expect(text).toContain("[3/5] Test tools ... found (all packages are installed at the pinned versions), skipped");
        // Round 17: the installer never downloads a browser any more; the runner chooses one itself (installed Chrome or Edge, or a download).
        expect(text).toContain("[4/5] Browser for web tests ... left to the runner (it uses Google Chrome or Microsoft Edge from this Mac, or downloads Chromium once when it first starts)");
        expect(text).toContain("Connected to the platform");
        expect(distRequests.length, "the second run downloaded something").toBe(downloadsBefore);

        // 3. The runner really works: a real API test is sent to it and passes.
        await runApiTest(p, "mac runner");

        // 4. A second launch while it runs only shows the status and starts nothing.
        const again = launchSetup(kit, home, ["--silent"]);
        expect(await again.exited, output(again)).toBe(0);
        expect(output(again)).toMatch(/The AI Testing runner is already running on this Mac \(process \d+\)\./);
        expect(output(again)).not.toContain("[1/5]");
        expect((await onlineAgents(p)).length).toBe(1);
        expect(run.child.exitCode).toBeNull();

        // 5. The token is revoked: the runner says so in plain words, the installer ends with the runner's code, and cleans up its pid file.
        expect((await admin("DELETE", `/api/projects/${p}/agent-tokens/${dl.headers.get("x-runner-token-id")}`)).status).toBe(200);
        expect(await Promise.race([run.exited, sleep(60_000).then(() => "timeout")]), output(run)).toBe(3);
        expect(output(run)).toMatch(/no longer accepts this runner's token/);
        expect(fs.existsSync(path.join(install, "runner.pid"))).toBe(false);

        // 6. Uninstall removes the folder it created (the test tools link is taken away first, as the existing kit tests do).
        removeLink(link);
        const un = launchSetup(kit, home, ["--uninstall", "--silent"]);
        expect(await un.exited, output(un)).toBe(0);
        expect(fs.existsSync(install)).toBe(false);
        expect(fs.existsSync(path.join(kit, "runner.token"))).toBe(true);
    }, 600_000);

    it("the command line a LaunchAgent runs (--run-loop) starts the runner, which connects and is online; --uninstall stops exactly that process", async () => {
        const p = await newProject("Mac installer login item");
        const dl = await admin("POST", `/api/projects/${p}/runner-kits`, { name: "login runner", platform: "unix" });
        const kit = unpackKit(dl.buf);
        const home = fresh("Users", "Maya Singh");
        const install = path.join(fresh("Support [x] (y)"), "AITestingRunner");
        const setup = launchSetup(kit, home, ["--silent", "--no-start", "--install-dir", msys(install)], { AITP_INSTALLER_SKIP_NPM: "1" });
        expect(await setup.exited, output(setup)).toBe(0);
        const link = linkTools(install);
        // launchd would run exactly this, from the copy of the script in the install folder.
        const installed = launchSetup(kit, home, ["--run-loop", "--install-dir", msys(install)], {}, path.join(install, "runner-setup.sh")).child;
        try {
            await until("the runner to be online", async () => (await onlineAgents(p))[0], 90_000);
            expect(fs.existsSync(path.join(install, "runner.pid"))).toBe(true);
            expect(fs.readFileSync(path.join(install, "logs", "runner.log"), "utf8")).toContain("Connected to the platform");
            // The test-tools link is still inside the folder: removing the folder must remove the link and never what it points at.
            const un = launchSetup(kit, home, ["--uninstall", "--silent", "--install-dir", msys(install)]);
            const code = await Promise.race([un.exited, sleep(90_000).then(() => "timeout")]);
            expect(code, output(un)).toBe(0);
            expect(output(un)).toMatch(/Stopping the runner this app started \(process \d+\)\./);
            await until("the runner to go offline", async () => (await onlineAgents(p)).length === 0, 60_000);
            await until("the loop to end", () => installed.exitCode !== null || installed.signalCode !== null, 30_000);
            expect(fs.existsSync(install)).toBe(false);
            expect(fs.existsSync(path.join(REPO, "node_modules", "@playwright", "test", "package.json"))).toBe(true);
        } finally {
            killOurs(installed);
            removeLink(link);
        }
    }, 400_000);
});
