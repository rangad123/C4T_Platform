/**
 * The Windows runner installer, really run. The program is compiled with csc.exe, the kit is a person's own download from a REAL platform
 * (POST /api/me/runner/download, round 45: the Windows download is the installer, with the person's one-time code in runner.enroll), unzipped into a folder with spaces and brackets, and AITestingRunnerSetup.exe is started the way the quiet switches are
 * meant to be used (--check, --silent, --stop, --uninstall). Nothing leaves this computer: the "nodejs.org" it downloads Node.js from is a
 * local HTTP server (AITP_NODE_DIST_URL) serving a fake index.json, SHASUMS256.txt and a real zip whose node.exe is a copy of this computer's.
 *
 * Covered: the checklist and its exit codes; Node.js found and skipped; Node.js missing or too old, downloaded, checked against its checksum
 * and unpacked into the private folder (and refused when the checksum is wrong, the download is cut short, the checksum line is missing or
 * the person stops it); the newest long-term release chosen from the index, the pinned fallback when the index cannot be read; files copied
 * and compared; a second run that skips everything and is quick; the runner started HIDDEN, trading the code from the kit for the person's
 * credential (kept with Windows data protection, never as plain text), running a real API test and a real web test the person starts; one
 * copy at a time; stopping only the process it started (a decoy node process and a recorded pid that is not ours survive); the computer
 * removed in Settings ending it with exit code 3 and a plain message; uninstalling only what it created
 * (a sentinel in the install folder, a sentinel outside it, the Node.js it found elsewhere and a linked node_modules survive); shortcuts in
 * folders the test chooses; the copied code readable only by this user and the code never in any output or log; running again from the
 * installed copy after the unzipped folder is deleted; and a window smoke test (created and painted off screen, never shown).
 *
 * NOT covered here (said plainly in docs/features/runner-installer.md): the real nodejs.org and npm registry downloads, the npm install and
 * browser download steps themselves (skipped with the test switches), a computer without Node.js at all, SmartScreen, antivirus reactions to an
 * unsigned program, the tray icon's look and menu, Windows 10, and a person clicking in the window.
 *
 * Run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/installer-win.test.ts
 * Ports: platform 8815, fixture application 8816, fake nodejs.org 8817.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { buildServer } from "../src/platform/server.js";
import { allowPrivateAddresses, downloadRunner, myOnlineRunner, personToken, retireMyRunner } from "./fixtures/runner-person.js";
import { Worker } from "../src/platform/worker.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildInstallerWin, EXE_NAME, findCsc } from "../scripts/build-installer-win.mjs";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { writeManifest } from "../scripts/build-installer.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLATFORM_PORT = 8815;
const APP_PORT = 8816;
const DIST_PORT = 8817;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const DIST = `http://127.0.0.1:${DIST_PORT}`;
const API_KEY = "installer-admin-key-6d02b8c1e7";
const PASSWORD = "INSTLEAK-Password-4c19e0";
const CSC = findCsc();
const ON_WINDOWS = process.platform === "win32" && Boolean(CSC);
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS", "RUNNER_KIT_DIR", "RUNNER_INSTALLER_DIR", "RUNNER_KIT_RATE_PER_MINUTE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const NODE_DIR = path.dirname(process.execPath);
const FAKE_NODE = "v24.99.1";
const PINNED = "v24.11.0";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let tmp: string;
let setupExe: string;
let appServer: http.Server;
let distServer: http.Server;
const children: ChildProcess[] = [];
const links: string[] = [];
let counter = 0;

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
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ── the platform ────────────────────────────────────────────────────────────

/** The person whose runner this is (an owner with their own API token, made in beforeAll). */
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
/** A project whose imported tests run at once (no approval step: this file is about the installer). */
const newProject = async (name: string) => {
    const id = (await admin("POST", "/api/projects", { name })).body.id as string;
    expect((await admin("PUT", `/api/projects/${id}/review-policy`, { aiGenerated: false, edits: false, healing: false })).status).toBe(200);
    return id;
};
/** The person's runner while connected, as a list (empty when none). */
const onlineAgents = async (_projectId?: string) => {
    const r = await myOnlineRunner(BASE, person.token);
    return r ? [r] : [];
};

interface Kit {
    /** The unzipped folder that holds AITestingRunnerSetup.exe, runner.json and runner.enroll. */
    dir: string;
    projectId: string;
    /** The one-time code in runner.enroll: a secret that must appear in no output. */
    token: string;
    name: string;
}

/** The real download (default kind, so the installer zip), unzipped into  <tmp>/<n>/Maya Singh [kit]/<folder>  (spaces and brackets on purpose). */
async function makeKit(name: string): Promise<Kit> {
    const projectId = await newProject(`Installer ${name}`);
    // One runner per person: the one the last test left is removed first, so "online" always means this kit's runner.
    await retireMyRunner(BASE, person.token);
    const r = await downloadRunner(BASE, person.token, "windows");
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("x-runner-kit-kind")).toBe("installer");
    const parent = path.join(tmp, String(++counter), "Maya Singh [kit]");
    let top = "";
    for (const [entry, bytes] of Object.entries(unzipSync(new Uint8Array(r.buf)))) {
        top = entry.split("/")[0]!;
        const dest = path.join(parent, entry);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
    }
    const dir = path.join(parent, top);
    return { dir, projectId, token: fs.readFileSync(path.join(dir, "runner.enroll"), "utf8").trim(), name: NAME };
}

const freshInstallDir = (): string => path.join(tmp, String(++counter), "Local [data]", "AI Runner");

/** The install folder with this repository's node_modules linked in as the runner's packages (no npm install, no network). */
function withTools(installDir: string): void {
    fs.mkdirSync(path.join(installDir, "app"), { recursive: true });
    const link = path.join(installDir, "app", "node_modules");
    fs.symlinkSync(path.join(REPO, "node_modules"), link, "junction");
    links.push(link);
}

// ── running the program ─────────────────────────────────────────────────────

interface Running {
    child: ChildProcess;
    out: string[];
    exited: Promise<number | null>;
    started: number;
}
const startupDir = () => path.join(tmp, "startup");
const startMenuDir = () => path.join(tmp, "startmenu");

function launch(exe: string, args: string[], cwd: string, extraEnv: Record<string, string | undefined> = {}): Running {
    const merged: Record<string, string | undefined> = {
        AITP_INSTALLER_NODE_SEARCH_ONLY: NODE_DIR,
        AITP_INSTALLER_SKIP_NPM: "1",
        AITP_INSTALLER_SKIP_BROWSER: "1",
        AITP_INSTALLER_NO_UI: "1",
        AITP_INSTALLER_STARTUP_DIR: startupDir(),
        AITP_INSTALLER_STARTMENU_DIR: startMenuDir(),
        ...extraEnv,
    };
    // Windows names are case-insensitive but this process's copy may spell them differently: an override replaces the name however it is spelled.
    const overridden = new Set(Object.keys(merged).map((k) => k.toUpperCase()));
    const inherited = Object.entries(process.env).filter(([k]) => !overridden.has(k.toUpperCase()));
    const env: NodeJS.ProcessEnv = Object.fromEntries([...inherited, ...Object.entries(merged)].filter(([k, v]) => v !== undefined && !/^(AGENT_|RUNNER_KIT_|RUNNER_INSTALLER_)/.test(k)));
    const child = spawn(exe, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    const out: string[] = [];
    child.stdout?.on("data", (d) => out.push(String(d)));
    child.stderr?.on("data", (d) => out.push(String(d)));
    return { child, out, exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))), started: Date.now() };
}
const output = (r: Running) => r.out.join("").replace(/\r/g, "");

/** Start the program from a kit folder with the usual switches, and wait for it to end. */
async function run(kit: Kit, args: string[], installDir: string, extraEnv: Record<string, string | undefined> = {}, timeoutMs = 120_000) {
    const r = launch(path.join(kit.dir, EXE_NAME), [...args, "--install-dir", installDir], kit.dir, extraEnv);
    const code = await Promise.race([r.exited, sleep(timeoutMs).then(() => "timeout" as const)]);
    if (code === "timeout") killOurs(r.child);
    return { code, text: output(r), ms: Date.now() - r.started };
}

/** Kill a process we started, and only that process tree. */
function killOurs(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null || child.signalCode) return;
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
const readState = (installDir: string): { runnerPid: number; node: string; runnerStart: string } => JSON.parse(fs.readFileSync(path.join(installDir, "installer.json"), "utf8"));

// ── the fake nodejs.org ─────────────────────────────────────────────────────

type DistMode = "good" | "badsum" | "truncated" | "nosum" | "slow" | "noindex";
const dist = { mode: "good" as DistMode, requests: [] as string[], zipStarted: false };
let nodeZip: Buffer;
let nodeZipSha = "";

function indexJson(): string {
    const file = (v: string, lts: string | false) => ({ version: v, date: "2026-01-01", files: ["win-x64-zip", "win-x64-msi", "linux-x64"], lts });
    // Newest first, like the real index: a newer major that is not long-term support, the one to pick, an older long-term major, and a 24.x that is not LTS-labelled.
    return JSON.stringify([file("v25.3.0", false), file(FAKE_NODE, "Krypton"), file("v24.99.0", false), file("v22.99.9", "Jod"), file("v20.1.0", "Iron")]);
}

beforeAll(async () => {
    if (!ON_WINDOWS) return;
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    process.env.RUNNER_KIT_RATE_PER_MINUTE = "100";
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inst-win-"));
    // The platform's inputs: the runner bundle and the installer, both built here into temp folders.
    await buildRunner({ outDir: path.join(tmp, "dist-runner") });
    process.env.RUNNER_KIT_DIR = path.join(tmp, "dist-runner");
    const instDir = path.join(tmp, "dist-installer");
    buildInstallerWin({ outDir: path.join(instDir, "win") });
    writeManifest({ outDir: instDir });
    process.env.RUNNER_INSTALLER_DIR = instDir;
    process.env.RUNNER_COMPLETE_DIR = path.join(tmp, "no-complete");

    appServer = http.createServer((req, res) => {
        if (req.url === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Welcome to the fixture</h1></main></body></html>`);
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));

    // The "node-v24.x-win-x64.zip" a real download holds a folder with node.exe in it; here node.exe is a copy of this computer's, stored without compression.
    const nodeExe = fs.readFileSync(process.execPath);
    const zipFor = (v: string) => zipSync({ [`node-${v}-win-x64/node.exe`]: [new Uint8Array(nodeExe), { level: 0 }], [`node-${v}-win-x64/README.md`]: new TextEncoder().encode("stand-in\n") });
    const zips: Record<string, Buffer> = { [FAKE_NODE]: Buffer.from(zipFor(FAKE_NODE)), [PINNED]: Buffer.from(zipFor(PINNED)) };
    nodeZip = zips[FAKE_NODE]!;
    nodeZipSha = sha(nodeZip);
    distServer = http.createServer((req, res) => {
        const url = req.url ?? "";
        dist.requests.push(url);
        if (url === "/index.json") {
            if (dist.mode === "noindex") return void res.writeHead(404).end("no index");
            return void res.writeHead(200, { "content-type": "application/json" }).end(indexJson());
        }
        const m = /^\/(v[\d.]+)\/(SHASUMS256\.txt|node-v[\d.]+-win-x64\.zip)$/.exec(url);
        const zip = m ? zips[m[1]!] : undefined;
        if (!m || !zip) return void res.writeHead(404).end("not found");
        if (m[2] === "SHASUMS256.txt") {
            if (dist.mode === "nosum") return void res.writeHead(200).end(`${"a".repeat(64)}  node-${m[1]}-linux-x64.tar.gz\n`);
            const good = sha(zip);
            const hash = dist.mode === "badsum" ? "0".repeat(64) : good;
            return void res.writeHead(200).end(`${"b".repeat(64)}  node-${m[1]}-x64.msi\n${hash}  node-${m[1]}-win-x64.zip\n`);
        }
        dist.zipStarted = true;
        if (dist.mode === "truncated") {
            res.writeHead(200, { "content-length": String(zip.length), "content-type": "application/zip" });
            res.write(zip.subarray(0, 300_000));
            setTimeout(() => res.destroy(), 150);
            return;
        }
        if (dist.mode === "slow") {
            res.writeHead(200, { "content-length": String(zip.length), "content-type": "application/zip" });
            let at = 0;
            const timer = setInterval(() => {
                if (res.destroyed || at >= zip.length) return clearInterval(timer);
                res.write(zip.subarray(at, at + 200_000));
                at += 200_000;
            }, 250);
            res.on("close", () => clearInterval(timer));
            return;
        }
        res.writeHead(200, { "content-length": String(zip.length), "content-type": "application/zip" }).end(zip);
    });
    await new Promise<void>((r) => distServer.listen(DIST_PORT, "127.0.0.1", () => r()));

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inst-win-data-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), PUBLIC_URL: BASE, CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", EXECUTION_MODE: "runners" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
    // EXECUTION_MODE=runners takes runs only while the part that hands them to runners is alive.
    stopBeat = startHeartbeat(platform.db);
    person = personToken(server);
    setupExe = path.join(instDir, "win", EXE_NAME);
}, 240_000);

afterAll(async () => {
    for (const c of children) killOurs(c);
    await sleep(800);
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    stopBeat?.();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer?.close(r));
    await new Promise((r) => distServer?.close(r));
    // Take the junctions away first (rmdir removes only the link), then the folders.
    for (const l of links) {
        try {
            fs.rmdirSync(l);
        } catch {
            /* already gone */
        }
    }
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    if (tmp) {
        try {
            fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
        } catch {
            /* the operating system cleans the temp folder later */
        }
    }
    if (ON_WINDOWS && !fs.existsSync(path.join(REPO, "node_modules", "@playwright", "test", "package.json"))) throw new Error("The repository's node_modules was damaged by the cleanup");
});

/** Import an API test and two web tests, send the project's runs to the runner, and return the verdicts. */
async function runTests(projectId: string, runnerName: string, withWeb: boolean) {
    const specs = [
        { title: "The health endpoint answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/health" }, { action: "assertResponse", check: "status", expected: 200 }] },
        ...(withWeb
            ? [
                  { title: "The home page greets people", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Welcome to the fixture" } }] },
                  { title: "A missing heading is reported", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Nothing like this" } }] },
              ]
            : []),
    ];
    const imp = await admin("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, credentials: { username: "demo@example.com", password: PASSWORD }, specs });
    expect(imp.status, imp.text).toBe(202);
    const ids = (imp.body.tests as Array<{ id: string }>).map((t) => t.id);
    // No runner is chosen: the run goes to the person's own runner. The fixture is on this computer: private addresses on.
    expect(await allowPrivateAddresses(BASE, person.token)).toBe(200);
    const results = [];
    for (const id of ids) {
        const started = await admin("POST", `/api/tests/${id}/validate`);
        expect(started.status, started.text).toBe(202);
        const job = await until("the job to finish", async () => {
            const j = (await admin("GET", `/api/test-generation/${started.body.jobId}`)).body;
            return ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status) ? j : undefined;
        }, 150_000);
        expect(job.ranOn).toMatchObject({ kind: "agent", name: runnerName });
        results.push(((await admin("GET", `/api/tests/${id}/executions`)).body as Array<{ status: string; error?: string }>)[0]!);
    }
    return results;
}

const chromiumCached = (): boolean => {
    try {
        const rev = (JSON.parse(fs.readFileSync(path.join(REPO, "node_modules", "playwright-core", "browsers.json"), "utf8")).browsers as Array<{ name: string; revision: string }>).find((b) => b.name === "chromium")!.revision;
        const shell = (JSON.parse(fs.readFileSync(path.join(REPO, "node_modules", "playwright-core", "browsers.json"), "utf8")).browsers as Array<{ name: string; revision: string }>).find((b) => b.name === "chromium-headless-shell")!.revision;
        const base = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
        return fs.existsSync(path.join(base, `chromium-${rev}`, "INSTALLATION_COMPLETE")) && fs.existsSync(path.join(base, `chromium_headless_shell-${shell}`, "INSTALLATION_COMPLETE"));
    } catch {
        return false;
    }
};

const describeWin = describe.skipIf(!ON_WINDOWS);

// ── --check ─────────────────────────────────────────────────────────────────

describeWin("--check: look, change nothing, and say what would be downloaded", () => {
    it("with Node.js present: says it found it and will use it; the test tools are missing in a fresh folder, so the exit code is 10; nothing is written", async () => {
        const kit = await makeKit("check fresh");
        const inst = freshInstallDir();
        const r = await run(kit, ["--check"], inst);
        expect(r.code, r.text).toBe(10);
        expect(r.text).toMatch(/Node\.js 24 or newer: Found, skipped\. Node\.js v\d+\.\d+\.\d+ found, using it/);
        expect(r.text).toMatch(/Using Node\.js v\d+\.\d+\.\d+ from .*node\.exe\./);
        expect(r.text).toMatch(/Runner files: Out of date, will copy\. 7 files will be copied to /);
        expect(r.text).toMatch(/Test tools \(npm packages\): Missing, will download\. @playwright\/test is not installed/);
        expect(r.text).toMatch(/Optional extras: Checked\. Android tools .*Windows desktop apps off/);
        expect(r.text).toMatch(/Something would be downloaded: Test tools \(npm packages\)/);
        // It looked and changed nothing: no install folder was made, and nothing went over the network but the platform check.
        expect(fs.existsSync(inst)).toBe(false);
        expect(dist.requests).toEqual([]);
        // The token never shows in what it prints.
        expect(r.text).not.toContain(kit.token);
    });

    it("with every package present (linked in) it needs no download and says so: exit 0 (the browser is left to the runner)", async () => {
        const kit = await makeKit("check linked");
        const inst = freshInstallDir();
        withTools(inst);
        const r = await run(kit, ["--check"], inst);
        expect(r.text).toMatch(/Test tools \(npm packages\): Found, skipped\. Every package is installed at the version the runner needs/);
        // Round 17: Setup no longer downloads a browser (the runner uses installed Chrome or Edge, or downloads one), so a missing browser is not a download here.
        expect(r.code, r.text).toBe(0);
        expect(r.text).toMatch(/Browser for web tests: Checked\. Left to the runner: it uses Google Chrome or Microsoft Edge from this computer, or downloads Chromium once when it first starts/);
        expect(r.text).toContain("Nothing needs to be downloaded.");
        expect(r.text).toMatch(/Connection to the platform: Found, skipped\. Reached 127\.0\.0\.1/);
    });

    it("a complete download (its own node\\node.exe and a marked node_modules) needs nothing: --check exits 0, Setup copies both, never runs npm, and the next look skips both", async () => {
        const kit = await makeKit("complete kit");
        // What the complete download adds: node\node.exe (a hard link to this computer's Node.js stands in) and node_modules with every pinned package.
        fs.mkdirSync(path.join(kit.dir, "node"), { recursive: true });
        try {
            fs.linkSync(process.execPath, path.join(kit.dir, "node", "node.exe"));
        } catch {
            fs.copyFileSync(process.execPath, path.join(kit.dir, "node", "node.exe"));
        }
        fs.writeFileSync(path.join(kit.dir, "node", "LICENSE"), "MIT\n");
        const pinned = JSON.parse(fs.readFileSync(path.join(kit.dir, "package.json"), "utf8")).dependencies as Record<string, string>;
        for (const [name, version] of Object.entries(pinned)) {
            const d = path.join(kit.dir, "node_modules", ...name.split("/"));
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name, version }));
        }
        fs.writeFileSync(path.join(kit.dir, "node_modules", ".aitp-complete"), '{"target":"win-x64"}\n');
        fs.writeFileSync(path.join(kit.dir, "complete-kit.json"), '{"format":1,"target":"win-x64"}\n');
        const inst = freshInstallDir();
        const nowhere = path.join(tmp, "no-node-here");
        fs.mkdirSync(nowhere, { recursive: true });
        // npm stays switched off (no network in tests): the tools row must say they were copied, not that npm was skipped.
        const env = { AITP_INSTALLER_NODE_SEARCH_ONLY: nowhere };
        dist.requests.length = 0;
        const check = await run(kit, ["--check"], inst, env);
        expect(check.code, check.text).toBe(0);
        expect(check.text).toMatch(/Node\.js 24 or newer: In this download, will copy\. Node\.js v\d+\.\d+\.\d+ came with this download and will be copied \(no download\)/);
        expect(check.text).toContain("Test tools (npm packages): In this download, will copy. They came with this download and will be copied (no download)");
        expect(check.text).toContain("Nothing needs to be downloaded.");
        expect(fs.existsSync(inst)).toBe(false);

        const setup = await run(kit, ["--silent", "--no-start"], inst, env);
        expect(setup.code, setup.text).toBe(0);
        expect(setup.text).toMatch(/Node\.js v\d+\.\d+\.\d+ came with this download \(nothing downloaded\)/);
        expect(setup.text).toMatch(/They came with this download \(\d+ files copied, nothing downloaded\)/);
        expect(setup.text).not.toMatch(/Running npm install|npm:|AITP_INSTALLER_SKIP_NPM/);
        expect(fs.existsSync(path.join(inst, "node", "node.exe"))).toBe(true);
        expect(fs.existsSync(path.join(inst, "app", "node_modules", ".aitp-complete"))).toBe(true);
        expect(fs.existsSync(path.join(inst, "app", "complete-kit.json"))).toBe(true);
        expect(readState(inst).node).toBe("bundled");
        expect(dist.requests).toEqual([]);

        const again = await run(kit, ["--check"], inst, env);
        expect(again.code, again.text).toBe(0);
        expect(again.text).toMatch(/Node\.js 24 or newer: Found, skipped\. Node\.js v\d+\.\d+\.\d+ came with this download and is already copied/);
        expect(again.text).toContain("Test tools (npm packages): Found, skipped. They came with this download and are already copied");
    });

    it("says Cannot reach <address> plainly, with the likely reasons, and does not count it as something to download", async () => {
        const kit = await makeKit("check offline");
        fs.writeFileSync(path.join(kit.dir, "runner.json"), JSON.stringify({ url: "http://127.0.0.1:6599", name: kit.name }));
        const inst = freshInstallDir();
        withTools(inst);
        const r = await run(kit, ["--check"], inst);
        expect(r.text).toMatch(/Connection to the platform: Failed\. Cannot reach http:\/\/127\.0\.0\.1:6599 \(.*\)\. Likely reasons: this computer is offline, a firewall or proxy blocks it, the address is wrong, or the platform is switched off\./);
        expect(r.code).toBe(0);
    });

    it("reports a Node.js that is too old, with its version and place, and keeps looking: a newer one found later is used", async () => {
        const old = path.join(tmp, "oldnode");
        fs.mkdirSync(old, { recursive: true });
        const src = path.join(tmp, "oldnode.cs");
        fs.writeFileSync(src, 'class P { static int Main(string[] a) { System.Console.WriteLine("v20.11.0"); return 0; } }');
        const compiled = spawnSync(CSC!, ["/nologo", "/target:exe", `/out:${path.join(old, "node.exe")}`, src], { encoding: "utf8", windowsHide: true });
        expect(compiled.status, compiled.stdout).toBe(0);
        const kit = await makeKit("check old");
        const only = await run(kit, ["--check"], freshInstallDir(), { AITP_INSTALLER_NODE_SEARCH_ONLY: old });
        expect(only.code, only.text).toBe(10);
        expect(only.text).toContain(`Found Node.js v20.11.0 at ${path.join(old, "node.exe")}. That is too old, the runner needs 24 or newer.`);
        expect(only.text).toMatch(/Node\.js 24 or newer: Missing, will download\. Node\.js v20\.11\.0 is too old\. A private Node\.js 24 will be downloaded/);
        expect(only.text).not.toMatch(/found, using it/);
        const both = await run(kit, ["--check"], freshInstallDir(), { AITP_INSTALLER_NODE_SEARCH_ONLY: `${old};${NODE_DIR}` });
        expect(both.text).toMatch(/Node\.js v24\.\d+\.\d+ found, using it/);
        expect(both.text).not.toContain("is too old. A private");
    });

    it("with no Node.js anywhere says where it looked and that a private copy will be downloaded, without touching the network", async () => {
        const kit = await makeKit("check none");
        const empty = path.join(tmp, "empty-folder");
        fs.mkdirSync(empty, { recursive: true });
        const r = await run(kit, ["--check"], freshInstallDir(), { AITP_INSTALLER_NODE_SEARCH_ONLY: empty });
        expect(r.code, r.text).toBe(10);
        expect(r.text).toContain("Node.js was not found on this computer. I looked only in the folders I was told to use.");
        expect(r.text).toMatch(/Node\.js was not found\. A private Node\.js 24 will be downloaded/);
        expect(dist.requests.length).toBe(0);
    });

    it("refuses plainly when the unzipped folder is incomplete or the program was started from elsewhere", async () => {
        const kit = await makeKit("check broken");
        fs.rmSync(path.join(kit.dir, "task-child.mjs"));
        const r = await run(kit, ["--check"], freshInstallDir());
        expect(r.code, r.text).toBe(1);
        expect(r.text).toContain("The unzipped folder is incomplete (task-child.mjs is missing). Download the runner again from the platform and unzip all of it.");
        // The program alone, with no runner files next to it and nothing installed.
        const alone = path.join(tmp, "alone");
        fs.mkdirSync(alone, { recursive: true });
        fs.copyFileSync(setupExe, path.join(alone, EXE_NAME));
        const lone = launch(path.join(alone, EXE_NAME), ["--check", "--install-dir", freshInstallDir()], alone);
        expect(await lone.exited).toBe(1);
        expect(output(lone)).toContain("I cannot find the runner files. Open AITestingRunnerSetup.exe from the folder you unzipped");
    });

    it("rejects an unknown option and answers --help", async () => {
        const bad = launch(setupExe, ["--frobnicate"], tmp);
        expect(await bad.exited).toBe(1);
        expect(output(bad)).toMatch(/I do not know the option --frobnicate/);
        const help = launch(setupExe, ["--help"], tmp);
        expect(await help.exited).toBe(0);
        expect(output(help)).toContain("--check");
        expect(output(help)).toContain("--uninstall");
    });
});

// ── downloading Node.js ─────────────────────────────────────────────────────

describeWin("Node.js is downloaded only when it is missing, and only after its checksum matches", () => {
    const missingEnv = () => {
        const empty = path.join(tmp, "no-node-here");
        fs.mkdirSync(empty, { recursive: true });
        return { AITP_INSTALLER_NODE_SEARCH_ONLY: empty, AITP_NODE_DIST_URL: DIST } as Record<string, string>;
    };
    const resetDist = (mode: DistMode) => {
        dist.mode = mode;
        dist.requests.length = 0;
        dist.zipStarted = false;
    };
    const leftovers = (inst: string) => (fs.existsSync(path.join(inst, "downloads")) ? fs.readdirSync(path.join(inst, "downloads")) : []);

    it("downloads the newest long-term release from the index, verifies it, unpacks it into the private folder, and uses it afterwards", async () => {
        resetDist("good");
        const kit = await makeKit("node good");
        const inst = freshInstallDir();
        withTools(inst);
        const r = await run(kit, ["--silent", "--no-start"], inst, missingEnv(), 240_000);
        expect(r.code, r.text).toBe(0);
        // The index lists a newer major that is not long-term support, an old long-term major and the one to take; only that one is fetched.
        expect(dist.requests).toEqual(["/index.json", `/${FAKE_NODE}/SHASUMS256.txt`, `/${FAKE_NODE}/node-${FAKE_NODE}-win-x64.zip`]);
        expect(r.text).toContain(`Node.js ${FAKE_NODE} will be downloaded from ${DIST}.`);
        expect(r.text).toMatch(/Node\.js 24 or newer: Done\. Node\.js v\d+\.\d+\.\d+ downloaded and checked/);
        expect(fs.existsSync(path.join(inst, "node", "node.exe"))).toBe(true);
        expect(fs.statSync(path.join(inst, "node", "node.exe")).size).toBe(fs.statSync(process.execPath).size);
        // The checked download is deleted once unpacked, and nothing is left half done.
        expect(leftovers(inst)).toEqual([]);
        expect(fs.existsSync(path.join(inst, "node.new"))).toBe(false);
        expect(readState(inst).node).toBe("private");
        // The runner files were copied, the program copied itself next to them, and the one-time code is exactly the kit's (not traded yet: nothing started).
        for (const n of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "runner.json", "runner.enroll"]) expect(fs.existsSync(path.join(inst, "app", n)), n).toBe(true);
        expect(fs.existsSync(path.join(inst, "AITestingRunner.exe"))).toBe(true);
        expect(fs.readFileSync(path.join(inst, "app", "runner.enroll"), "utf8").trim()).toBe(kit.token);
        expect(fs.existsSync(path.join(inst, "app", "runner.token"))).toBe(false);
        // The next look finds the private copy and downloads nothing more.
        resetDist("good");
        const again = await run(kit, ["--check"], inst, missingEnv());
        expect(again.text).toContain(`Using Node.js v`);
        expect(again.text).toContain(path.join(inst, "node", "node.exe"));
        expect(again.text).toMatch(/Node\.js 24 or newer: Found, skipped/);
        expect(dist.requests).toEqual([]);
        expect(again.code, again.text).toBe(0);
    }, 400_000);

    it("uses the pinned version when the list of versions cannot be read, and says so", async () => {
        resetDist("noindex");
        const kit = await makeKit("node pinned");
        const inst = freshInstallDir();
        const r = await run(kit, ["--silent", "--no-start"], inst, missingEnv(), 240_000);
        expect(r.code, r.text).toBe(0);
        expect(r.text).toMatch(/Could not read the list of Node\.js versions \(.*404.*\)\. Using v24\.11\.0\./);
        expect(dist.requests).toContain(`/${PINNED}/node-${PINNED}-win-x64.zip`);
        expect(fs.existsSync(path.join(inst, "node", "node.exe"))).toBe(true);
    }, 400_000);

    it("refuses a download whose checksum does not match, deletes it and installs nothing", async () => {
        resetDist("badsum");
        const kit = await makeKit("node badsum");
        const inst = freshInstallDir();
        const r = await run(kit, ["--silent", "--no-start"], inst, missingEnv(), 240_000);
        expect(r.code, r.text).toBe(1);
        expect(r.text).toMatch(/The Node\.js download does not match the checksum 127\.0\.0\.1 publishes for it, so I did not use it and deleted it\./);
        expect(leftovers(inst)).toEqual([]);
        expect(fs.existsSync(path.join(inst, "node"))).toBe(false);
        expect(fs.existsSync(path.join(inst, "node.new"))).toBe(false);
    }, 400_000);

    it("fails plainly on a download that is cut short, and leaves nothing behind", async () => {
        resetDist("truncated");
        const kit = await makeKit("node cut");
        const inst = freshInstallDir();
        const r = await run(kit, ["--silent", "--no-start"], inst, missingEnv(), 240_000);
        expect(r.code, r.text).toBe(1);
        expect(r.text).toMatch(/The download was (cut short|interrupted)|The connection to 127\.0\.0\.1 was closed before the download finished|Could not reach 127\.0\.0\.1/);
        expect(leftovers(inst)).toEqual([]);
        expect(fs.existsSync(path.join(inst, "node"))).toBe(false);
    }, 400_000);

    it("does not download the zip at all when the checksum list does not mention it", async () => {
        resetDist("nosum");
        const kit = await makeKit("node nosum");
        const r = await run(kit, ["--silent", "--no-start"], freshInstallDir(), missingEnv(), 240_000);
        expect(r.code, r.text).toBe(1);
        expect(r.text).toContain(`does not mention node-${FAKE_NODE}-win-x64.zip, so I cannot check the download and did not fetch it.`);
        expect(dist.zipStarted).toBe(false);
    }, 400_000);

    it("stopping while it downloads ends it quickly, with nothing half done", async () => {
        resetDist("slow");
        const kit = await makeKit("node stop");
        const inst = freshInstallDir();
        const r = launch(path.join(kit.dir, EXE_NAME), ["--silent", "--no-start", "--install-dir", inst], kit.dir, missingEnv());
        await until("the download to start", () => dist.zipStarted && fs.existsSync(path.join(inst, "downloads")), 60_000);
        const stop = launch(path.join(kit.dir, EXE_NAME), ["--stop", "--install-dir", inst], kit.dir);
        expect(await stop.exited, output(stop)).toBe(0);
        expect(output(stop)).toMatch(/Stopped\./);
        expect(await Promise.race([r.exited, sleep(30_000).then(() => "timeout")]), output(r)).toBe(0);
        expect(leftovers(inst)).toEqual([]);
        expect(fs.existsSync(path.join(inst, "node"))).toBe(false);
    }, 300_000);
});

// ── the runner, really ──────────────────────────────────────────────────────

describeWin("--silent starts the runner hidden; it connects, runs real tests and is stopped cleanly", () => {
    it("trades the code from the kit, runs an API test and web tests, is not shown, keeps to one copy, and --stop ends only its own runner", async () => {
        const kit = await makeKit("silent run");
        const inst = freshInstallDir();
        withTools(inst);
        // A node process of the test's own: whatever the installer stops, it must not stop this.
        const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
        children.push(decoy);
        const logFile = path.join(tmp, `silent-${counter}.log`);
        const main = launch(path.join(kit.dir, EXE_NAME), ["--silent", "--install-dir", inst, "--log", logFile], kit.dir);
        await until("the runner to be online", async () => (await onlineAgents(kit.projectId))[0], 120_000).catch((e) => {
            throw new Error(`${e.message}\n--- output ---\n${output(main)}`);
        });
        const text = () => output(main);
        expect(text()).toMatch(/Node\.js 24 or newer: Found, skipped\. Node\.js v\d+\.\d+\.\d+ found, using it/);
        expect(text()).toMatch(/Test tools \(npm packages\): Found, skipped/);
        expect(text()).toMatch(/Browser for web tests: Checked\. Left to the runner/);
        expect(text()).toContain("Runner started (process ");
        await until("the connected line", () => text().includes(`Connected to 127.0.0.1 as ${NAME}`), 30_000);

        // Hidden: neither this program nor the runner it started has a window.
        const state = readState(inst);
        expect(state.runnerPid).toBeGreaterThan(0);
        for (const pid of [main.child.pid!, state.runnerPid]) {
            const q = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).MainWindowHandle`], { encoding: "utf8", windowsHide: true });
            expect(q.stdout.trim(), `window handle of process ${pid}`).toBe("0");
        }

        const [api, ok, bad] = await runTests(kit.projectId, NAME, chromiumCached());
        expect(api).toMatchObject({ status: "passed" });
        if (chromiumCached()) {
            expect(ok).toMatchObject({ status: "passed" });
            expect(bad!.status).not.toBe("passed");
            expect(bad!.error).toMatch(/Nothing like this|toBeVisible/);
        }

        // One copy at a time: a second start for the same folder says so and ends at once, and the first keeps running.
        const second = await run(kit, ["--silent"], inst, {}, 30_000);
        expect(second.code, second.text).toBe(0);
        expect(second.text).toContain("is already running for");
        expect(second.ms).toBeLessThan(20_000);
        expect(alive(state.runnerPid)).toBe(true);

        // The code is read from its file: it is in no output, no log file, and not on any command line it started.
        const logs = [text(), fs.readFileSync(logFile, "utf8"), ...["setup.log", "runner.log"].map((f) => (fs.existsSync(path.join(inst, "logs", f)) ? fs.readFileSync(path.join(inst, "logs", f), "utf8") : ""))].join("\n");
        expect(logs.includes(kit.token)).toBe(false);
        expect(logs.includes(PASSWORD)).toBe(false);
        expect(fs.existsSync(path.join(inst, "logs", "runner.log"))).toBe(true);
        const cmdline = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${state.runnerPid}").CommandLine`], { encoding: "utf8", windowsHide: true });
        expect(cmdline.stdout).toContain("--enroll-file");
        expect(cmdline.stdout.includes(kit.token)).toBe(false);

        // The code is used up and deleted; the credential it was traded for is kept with Windows data protection, never as plain text.
        expect(fs.existsSync(path.join(inst, "app", "runner.enroll"))).toBe(false);
        expect(fs.existsSync(path.join(inst, "app", "runner.token"))).toBe(false);
        const stored = path.join(inst, "app", "runner.credential");
        expect(fs.existsSync(stored)).toBe(true);
        expect(/aitg_|aite_/.test(fs.readFileSync(stored, "latin1"))).toBe(false);

        // --stop: the program ends with 0, its runner is gone and is shown offline, and the decoy is untouched.
        const stop = await run(kit, ["--stop"], inst, {}, 60_000);
        expect(stop.code, stop.text).toBe(0);
        expect(stop.text).toContain("Stopped.");
        expect(await Promise.race([main.exited, sleep(30_000).then(() => "timeout")]), text()).toBe(0);
        expect(alive(state.runnerPid)).toBe(false);
        await until("the runner to show offline", async () => (await onlineAgents(kit.projectId)).length === 0, 60_000);
        expect(alive(decoy.pid!)).toBe(true);
        expect(readState(inst).runnerPid).toBe(0);
        // Asking again when nothing runs is harmless.
        const nobody = await run(kit, ["--stop"], inst, {}, 30_000);
        expect(nobody.code).toBe(0);
        expect(nobody.text).toContain("No copy of the AI Testing Runner is running for");

        // The unzipped folder can be deleted: the copy in the install folder starts the same runner (same access), without any switch naming the folder.
        fs.rmSync(path.dirname(kit.dir), { recursive: true, force: true });
        const again = launch(path.join(inst, "AITestingRunner.exe"), ["--silent"], inst);
        await until("the runner to be online again from the installed copy", async () => (await onlineAgents(kit.projectId))[0], 120_000).catch((e) => {
            throw new Error(`${e.message}\n--- output ---\n${output(again)}`);
        });
        expect(output(again)).toMatch(/Runner files: Found, skipped\. Installed in /);
        const stopAgain = launch(path.join(inst, "AITestingRunner.exe"), ["--stop"], inst);
        expect(await stopAgain.exited, output(stopAgain)).toBe(0);
        expect(await Promise.race([again.exited, sleep(30_000).then(() => "timeout")]), output(again)).toBe(0);
        expect(alive(decoy.pid!)).toBe(true);
        killOurs(decoy);
    }, 600_000);

    it("a second start, with everything in place, skips every step and is quick", async () => {
        const kit = await makeKit("quick");
        const inst = freshInstallDir();
        withTools(inst);
        const first = await run(kit, ["--silent", "--no-start"], inst, {}, 120_000);
        expect(first.code, first.text).toBe(0);
        expect(first.text).toMatch(/Runner files: Done\. 7 files copied to /);
        const second = await run(kit, ["--silent", "--no-start"], inst, {}, 120_000);
        expect(second.code, second.text).toBe(0);
        expect(second.text).toMatch(/Node\.js 24 or newer: Found, skipped/);
        expect(second.text).toMatch(/Runner files: Found, skipped\. Already copied to /);
        expect(second.text).toMatch(/Test tools \(npm packages\): Found, skipped/);
        expect(second.text).not.toMatch(/Downloading|Installing|npm:/);
        expect(second.ms).toBeLessThan(25_000);
        // A file changed in the kit (a new download) is copied again, and only that one.
        fs.appendFileSync(path.join(kit.dir, "LICENSES.txt"), "\nupdated\n");
        const third = await run(kit, ["--silent", "--no-start"], inst, {}, 120_000);
        expect(third.text).toMatch(/Runner files: Done\. 1 file copied to /);
        expect(fs.readFileSync(path.join(inst, "app", "LICENSES.txt"), "utf8")).toContain("updated");
    }, 400_000);

    it("the computer removed in Settings ends it with exit code 3 and a plain message", async () => {
        const kit = await makeKit("revoked");
        const inst = freshInstallDir();
        withTools(inst);
        const main = launch(path.join(kit.dir, EXE_NAME), ["--silent", "--install-dir", inst], kit.dir);
        await until("the runner to be online", async () => (await onlineAgents(kit.projectId))[0], 120_000).catch((e) => {
            throw new Error(`${e.message}\n--- output ---\n${output(main)}`);
        });
        expect(await retireMyRunner(BASE, person.token)).toBe(200);
        expect(await Promise.race([main.exited, sleep(60_000).then(() => "timeout")]), output(main)).toBe(3);
        expect(output(main)).toContain("The platform no longer accepts this runner. It was removed, another computer was set up in its place, or its one-time code was already used or has expired.");
        expect(output(main)).toContain("Set up your runner again from Settings, Your runner in the platform.");
        expect(output(main).includes(kit.token)).toBe(false);
        expect(readState(inst).runnerPid).toBe(0);
    }, 400_000);

    it("never ends a process it did not start: a recorded process id that is not the runner's start time is left alone", async () => {
        const kit = await makeKit("decoy pid");
        const inst = freshInstallDir();
        withTools(inst);
        const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
        children.push(decoy);
        const first = await run(kit, ["--silent", "--no-start"], inst, {}, 120_000);
        expect(first.code, first.text).toBe(0);
        // A stale record: the id of a live node.exe, with a start time that is not its own (a reused id looks like this).
        const state = JSON.parse(fs.readFileSync(path.join(inst, "installer.json"), "utf8"));
        fs.writeFileSync(path.join(inst, "installer.json"), JSON.stringify({ ...state, runnerPid: decoy.pid, runnerStart: "1" }));
        const main = launch(path.join(kit.dir, EXE_NAME), ["--silent", "--install-dir", inst], kit.dir);
        await until("the runner to be online", async () => (await onlineAgents(kit.projectId))[0], 120_000).catch((e) => {
            throw new Error(`${e.message}\n--- output ---\n${output(main)}`);
        });
        expect(alive(decoy.pid!)).toBe(true);
        expect(output(main)).not.toContain("Ending the runner an earlier session left running");
        const stop = await run(kit, ["--stop"], inst, {}, 60_000);
        expect(stop.code).toBe(0);
        expect(alive(decoy.pid!)).toBe(true);
        killOurs(decoy);
    }, 400_000);
});

// ── uninstall and shortcuts ─────────────────────────────────────────────────

describeWin("shortcuts and --uninstall", () => {
    it("adds the shortcuts it was asked for, and removes only what it created: the folder it made, its shortcuts, nothing else", async () => {
        const kit = await makeKit("uninstall");
        const inst = freshInstallDir();
        const env = { AITP_INSTALLER_NODE_SEARCH_ONLY: path.join(tmp, "no-node-uninstall"), AITP_NODE_DIST_URL: DIST } as Record<string, string>;
        fs.mkdirSync(env.AITP_INSTALLER_NODE_SEARCH_ONLY!, { recursive: true });
        dist.mode = "good";
        const r = await run(kit, ["--silent", "--no-start", "--start-at-sign-in", "--start-menu"], inst, env, 240_000);
        expect(r.code, r.text).toBe(0);
        expect(r.text).toContain("Added a shortcut to the Startup folder");
        const startup = path.join(startupDir(), "AI Testing Runner.lnk");
        const menu = path.join(startMenuDir(), "AI Testing Runner.lnk");
        expect(fs.existsSync(startup)).toBe(true);
        expect(fs.existsSync(menu)).toBe(true);
        // The shortcut starts the installed copy, quietly, for this folder (read back through Windows' own shortcut object).
        const read = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${startup.replaceAll("'", "''")}'); $s.TargetPath; $s.Arguments`], { encoding: "utf8", windowsHide: true }).stdout.split(/\r?\n/);
        expect(read[0]).toBe(path.join(inst, "AITestingRunner.exe"));
        expect(read[1]).toContain("--background");
        expect(read[1]).toContain(inst);

        // Things that are not the installer's: a file in its own folder, a file beside it, a linked node_modules, a shortcut of someone else's.
        const inside = path.join(inst, "keep-me.txt");
        const outside = path.join(path.dirname(inst), "outside.txt");
        fs.writeFileSync(inside, "mine");
        fs.writeFileSync(outside, "mine");
        withTools(inst);
        const other = path.join(startupDir(), "Somebody else.lnk");
        fs.writeFileSync(other, "not ours");

        const u = await run(kit, ["--uninstall", "--silent"], inst, env, 120_000);
        expect(u.code, u.text).toBe(0);
        expect(u.text).toContain("(the private Node.js)");
        expect(u.text).toMatch(/Removed .*app/);
        expect(u.text).toContain("Left alone: any Node.js that was already on this computer, and the shared browser cache.");
        for (const gone of ["app", "node", "logs", "downloads", "installer.json", "AITestingRunner.exe"]) expect(fs.existsSync(path.join(inst, gone)), gone).toBe(false);
        expect(fs.existsSync(startup)).toBe(false);
        expect(fs.existsSync(menu)).toBe(false);
        expect(fs.readFileSync(inside, "utf8")).toBe("mine");
        expect(fs.readFileSync(outside, "utf8")).toBe("mine");
        expect(fs.readFileSync(other, "utf8")).toBe("not ours");
        // The folder is not empty (the file that is not ours is in it), so it stays; the Node.js found elsewhere and the linked packages are untouched.
        expect(fs.existsSync(inst)).toBe(true);
        expect(fs.existsSync(process.execPath)).toBe(true);
        expect(fs.existsSync(path.join(REPO, "node_modules", "@playwright", "test", "package.json"))).toBe(true);
        // A second uninstall has nothing to do and says so.
        const again = await run(kit, ["--uninstall", "--silent"], inst, env, 60_000);
        expect(again.code).toBe(0);
        expect(again.text).toContain("Nothing to remove");
    }, 600_000);

    it("never deletes a folder it did not create, even when asked to", async () => {
        const kit = await makeKit("not ours");
        const stranger = path.join(tmp, "stranger [folder]");
        fs.mkdirSync(path.join(stranger, "app"), { recursive: true });
        fs.writeFileSync(path.join(stranger, "app", "important.txt"), "keep");
        const u = await run(kit, ["--uninstall", "--silent"], stranger, {}, 60_000);
        expect(u.code, u.text).toBe(0);
        expect(u.text).toContain("has no record of an installation by this program");
        expect(fs.readFileSync(path.join(stranger, "app", "important.txt"), "utf8")).toBe("keep");
    });

    it("an installed copy removes itself and its folder when it is the one that was started", async () => {
        const kit = await makeKit("self remove");
        const inst = freshInstallDir();
        withTools(inst);
        expect((await run(kit, ["--silent", "--no-start"], inst, {}, 120_000)).code).toBe(0);
        fs.rmSync(path.dirname(kit.dir), { recursive: true, force: true });
        const copy = launch(path.join(inst, "AITestingRunner.exe"), ["--uninstall", "--silent"], inst);
        expect(await copy.exited, output(copy)).toBe(0);
        expect(output(copy)).toContain("This program will remove itself");
        await until("the folder to be gone", () => !fs.existsSync(inst), 30_000);
        expect(fs.existsSync(path.join(REPO, "node_modules", "@playwright", "test", "package.json"))).toBe(true);
    }, 300_000);
});

// ── the window ──────────────────────────────────────────────────────────────

describeWin("the window", () => {
    it("is created with its checklist and tray menu, painted off screen to a picture, and never shown", async () => {
        const kit = await makeKit("window");
        const inst = freshInstallDir();
        withTools(inst);
        const png = path.join(tmp, "window.png");
        const r = launch(path.join(kit.dir, EXE_NAME), ["--ui-smoke", "--install-dir", inst, "--screenshot", png], kit.dir, { AITP_INSTALLER_NO_UI: undefined });
        expect(await Promise.race([r.exited, sleep(60_000).then(() => "timeout")]), output(r)).toBe(0);
        const text = output(r);
        expect(text).toContain("window: AI Testing Runner setup; rows: 6; handle: yes");
        for (const row of ["Node.js 24 or newer", "Runner files", "Test tools (npm packages)", "Browser for web tests", "Optional extras", "Connection to the platform"]) expect(text, row).toContain(`row ${row} | `);
        expect(text).toMatch(/row Node\.js 24 or newer \| Found, skipped \| Node\.js v\d+/);
        const bytes = fs.readFileSync(png);
        expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(bytes.length).toBeGreaterThan(5000);
        // Nothing was installed by looking.
        expect(fs.existsSync(path.join(inst, "installer.json"))).toBe(false);
    }, 120_000);
});
