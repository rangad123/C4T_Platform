/**
 * The runner download against a REAL platform (round 45: one runner per person, set up in Settings): the download route (info, validation,
 * who may download, the one-time code, secrets), and then the download itself, unzipped into a temp folder and started the way a person
 * would start it: the bundled runner.mjs, the Windows start-runner.cmd and (when bash is there) start-runner.sh. Each trades the code inside
 * its zip for the person's credential, shows up in Settings (GET /api/me/runner) under the computer's own name, runs a real Playwright web
 * test and a real API test the person starts (no runner is chosen anywhere), and the results come back as the tests' verdicts. Removing the
 * computer (POST /api/me/runner/retire) makes the runner stop with a plain message. The platform runs in EXECUTION_MODE=runners.
 *
 * node_modules for the unzipped kits is a junction to this repository's (no network install); the install step of the start scripts is
 * skipped with AITP_KIT_SKIP_INSTALL=1, exactly as the brief allows. What is NOT covered here: the install step itself (npm registry,
 * browser download), winget/brew, a real fresh computer.
 *
 * Browser-launching: run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-kit.test.ts
 * Ports: platform 8800, fixture application 8801.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { Worker } from "../src/platform/worker.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLATFORM_PORT = 8800;
const APP_PORT = 8801;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "kit-admin-key-8d41c7e2f9";
const PASSWORD = "KITLEAK-Password-31a7c5";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS", "RUNNER_KIT_DIR", "RUNNER_INSTALLER_DIR", "RUNNER_COMPLETE_DIR", "RUNNER_KIT_RATE_PER_MINUTE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let stopBeat: (() => void) | undefined;
let dataDir: string;
let tmp: string;
let bundleDir: string;
let appServer: http.Server;
const logged: string[] = [];
const children: ChildProcess[] = [];
const links: string[] = [];

/** The person (an owner with their own API token, made in beforeAll): their downloads, their runner, their runs. */
let personToken = "";
const admin = async (method: string, url: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${personToken}` }) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    return { status: res.status, headers: res.headers, buf, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; headers: Headers; buf: Buffer; text: string; body: any };
};
/** A project whose imported tests run at once (no approval step: this file is about the runner, not the review). */
const newProject = async (name: string) => {
    const id = (await admin("POST", "/api/projects", { name })).body.id as string;
    expect((await admin("PUT", `/api/projects/${id}/review-policy`, { aiGenerated: false, edits: false, healing: false })).status).toBe(200);
    return id;
};
/**
 * This person's runner download. No installer or complete build is made here, so a Mac gets the plain files with all three start scripts
 * (the zip these tests unzip); Linux is one script, `ai-testing-runner.sh` (round 50), run with sh below.
 */
const download = (system: "windows" | "mac" | "linux" = "mac") => admin("POST", "/api/me/runner/download", { os: system, arch: "x64" });
/** The person's runner as Settings shows it, when it is connected. */
const myRunner = async () => {
    const r = (await admin("GET", "/api/me/runner")).body?.runner as { id: string; name: string; status: string; update?: unknown } | null | undefined;
    return r && (r.status === "online" || r.status === "busy") ? r : undefined;
};
const retire = () => admin("POST", "/api/me/runner/retire");
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

/** Unzip a kit into a fresh folder under tmp and give it this repository's node_modules (a junction: nothing is downloaded). */
function unpack(zip: Buffer, label: string): string {
    const root = fs.mkdtempSync(path.join(tmp, `${label}-`));
    let top = "";
    for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(zip)))) {
        top = name.split("/")[0]!;
        const dest = path.join(root, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
    }
    const kit = path.join(root, top);
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
function launch(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): Running {
    // The runner gets this computer's environment, minus the platform settings the test itself set for the server.
    // Windows names are case-insensitive but this process's copy may spell them differently (PROGRAMFILES): an override replaces the name however it is spelled.
    const overridden = new Set(Object.keys(extraEnv).map((k) => k.toUpperCase()));
    const inherited = Object.entries(process.env).filter(([k]) => !overridden.has(k.toUpperCase()));
    const env: NodeJS.ProcessEnv = Object.fromEntries([...inherited, ...Object.entries(extraEnv)].filter(([k]) => !/^(AGENT_|RUNNER_KIT_)/.test(k)));
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    const out: string[] = [];
    child.stdout?.on("data", (d) => out.push(String(d)));
    child.stderr?.on("data", (d) => out.push(String(d)));
    return { child, out, exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))) };
}
const output = (r: Running) => r.out.join("");

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

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    process.env.RUNNER_KIT_RATE_PER_MINUTE = "100";
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-kit-api-"));
    bundleDir = path.join(tmp, "dist-runner");
    // Until the bundle is built, the server must say so.
    process.env.RUNNER_KIT_DIR = path.join(tmp, "not-built");
    process.env.RUNNER_INSTALLER_DIR = path.join(tmp, "no-installer");
    process.env.RUNNER_COMPLETE_DIR = path.join(tmp, "no-complete");
    appServer = http.createServer((req, res) => {
        if (req.url === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Welcome to the fixture</h1></main></body></html>`);
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-kit-data-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), PUBLIC_URL: BASE, CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", EXECUTION_MODE: "runners" }));
    server = await buildServer(platform);
    // Everything the server writes to a request's log is kept, to prove the token never appears in it.
    server.addHook("onRequest", async (req) => {
        for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
            const original = req.log[level].bind(req.log) as (...a: unknown[]) => void;
            (req.log as unknown as Record<string, unknown>)[level] = (...a: unknown[]) => {
                logged.push(`${level} ${inspect(a, { depth: 3, breakLength: Infinity, maxStringLength: 2000 })}`);
                original(...a);
            };
        }
    });
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
    // EXECUTION_MODE=runners takes runs only while the part that hands them to runners is alive (as src/platform/ops/process.ts runs it).
    stopBeat = startHeartbeat(platform.db);
    const users = accessControlOf(server).users;
    const maya = users.create({ email: "maya@people.example", name: "Maya", role: "owner" });
    personToken = users.createToken(maya.id, { name: "kit test", role: "owner" }).token;
}, 60_000);

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

describe("before the kit is built", () => {
    it("info says it is not available and why; a download is a plain 503 that makes no code", async () => {
        const info = await admin("GET", "/api/me/runner/download/info");
        expect(info.status).toBe(200);
        expect(info.body).toMatchObject({ available: false, reason: "The runner kit has not been built on this server. Run `npm run build:runner`." });
        const d = await download("windows");
        expect(d.status).toBe(503);
        expect(d.body.error ?? d.body.message).toContain("npm run build:runner");
        expect(platform.db.all("SELECT id FROM runner_enrollments")).toEqual([]);
    });
});

describe("the routes", () => {
    it("build the bundle", async () => {
        const manifest = await buildRunner({ outDir: bundleDir });
        process.env.RUNNER_KIT_DIR = bundleDir;
        // The three programs, package.json and LICENSES.txt, plus the kit's package-lock.json when this checkout has one.
        expect(manifest.files).toHaveLength(fs.existsSync(path.join(REPO, "package-lock.json")) ? 6 : 5);
    }, 120_000);

    it("need a person: nobody and a wrong key get 401, the shared access key gets a plain 403", async () => {
        for (const headers of [{} as Record<string, string>, { "x-api-key": "wrong" }]) {
            expect((await admin("GET", "/api/me/runner/download/info", undefined, headers)).status).toBe(401);
            expect((await admin("POST", "/api/me/runner/download", { os: "windows", arch: "x64" }, headers)).status).toBe(401);
        }
        const key = await admin("POST", "/api/me/runner/download", { os: "windows", arch: "x64" }, { "x-api-key": API_KEY });
        expect(key.status).toBe(403);
        expect(key.body.error).toBe("Sign in with your own account to set up your runner.");
        expect(platform.db.all("SELECT id FROM runner_enrollments")).toEqual([]);
    });

    it("info: available, and what Settings says about the address from PUBLIC_URL", async () => {
        const info = await admin("GET", "/api/me/runner/download/info");
        expect(info.status).toBe(200);
        expect(info.body).toMatchObject({ available: true, urlOk: true, mayDownload: true });
        // PUBLIC_URL here is an address on this computer, which the page says plainly.
        expect(info.body.urlWarning).toMatch(/only a runner on this computer/i);
        expect(info.body.reason).toBeUndefined();
    });

    it("info without PUBLIC_URL uses the Host header and says so; plain http on a public host is flagged", async () => {
        const cfg = platform.config as unknown as { PUBLIC_URL?: string };
        const before = cfg.PUBLIC_URL;
        try {
            delete cfg.PUBLIC_URL;
            const lan = (await admin("GET", "/api/me/runner/download/info")).body;
            expect(lan).toMatchObject({ available: true, urlOk: true });
            expect(lan.urlWarning).toMatch(/set PUBLIC_URL|only a runner on this computer/i);
            cfg.PUBLIC_URL = "http://tests.example.com";
            const pub = (await admin("GET", "/api/me/runner/download/info")).body;
            expect(pub).toMatchObject({ urlOk: false });
            expect(pub.urlWarning).toBe("Runners need an https address when the platform is not on your own network. Set PUBLIC_URL to the https address people use.");
            expect(pub.systems.every((x: { available: boolean }) => !x.available)).toBe(true);
        } finally {
            if (before === undefined) delete cfg.PUBLIC_URL;
            else cfg.PUBLIC_URL = before;
        }
    });

    it("refuse anything but a system and a processor with a plain 400 and make no code", async () => {
        const bodies: unknown[] = [{}, { os: "windows" }, { arch: "x64" }, { os: "unix", arch: "x64" }, { os: "windows", arch: "x86" }, { os: "windows", arch: "x64", name: "Maya's laptop" }, { os: "linux", arch: "x64", kind: "files" }, { name: "ok", platform: "unix" }];
        for (const b of bodies) {
            const r = await admin("POST", "/api/me/runner/download", b);
            expect(r.status, JSON.stringify(b)).toBe(400);
            expect(String(r.body.error ?? r.body.message ?? "").length).toBeGreaterThan(5);
        }
        expect(platform.db.all("SELECT id FROM runner_enrollments")).toEqual([]);
    });

    it("download: a zip with the person's one-time code, never a credential; the code is in no answer, row or log", async () => {
        const r = await download("windows");
        expect(r.status, r.text.slice(0, 200)).toBe(200);
        expect(r.headers.get("content-type")).toBe("application/zip");
        expect(r.headers.get("content-disposition")).toBe('attachment; filename="runner-my-computer-windows.zip"');
        expect(r.headers.get("cache-control")).toBe("no-store");
        const enrollmentId = r.headers.get("x-runner-enrollment-id")!;
        expect(enrollmentId).toMatch(/^[0-9a-f-]{36}$/);
        // No installer is built here: Windows gets the plain files, and the answer says why.
        expect(r.headers.get("x-runner-kit-kind")).toBe("files");
        expect(r.headers.get("x-runner-kit-note")).toMatch(/Windows installer has not been built/);

        const files = unzipSync(new Uint8Array(r.buf));
        expect(files["runner-my-computer-windows/runner.token"]).toBeUndefined();
        const code = Buffer.from(files["runner-my-computer-windows/runner.enroll"]!).toString("utf8").trim();
        expect(code).toMatch(/^aite_[A-Za-z0-9_-]{20,}$/);
        expect((await admin("GET", `/api/me/runner/enrollments/${enrollmentId}`)).body).toEqual({ status: "waiting" });

        // The platform keeps only the hash: no row and no log line holds the code.
        expect(logged.some((l) => l.includes("runner-downloaded"))).toBe(true);
        for (const line of logged) expect(line).not.toContain(code);
        expect(JSON.stringify(platform.db.all("SELECT * FROM runner_enrollments"))).not.toContain(code);
        expect(JSON.stringify(platform.db.all("SELECT * FROM activity"))).not.toContain(code);

        // runner.json points at the platform and names no runner: it takes the computer's own name.
        const json = JSON.parse(Buffer.from(files["runner-my-computer-windows/runner.json"]!).toString("utf8"));
        expect(Object.keys(json).sort()).toEqual(["kitVersion", "url"]);
        expect(json.url).toBe(BASE);
        expect(json.kitVersion).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{10}$/);
    });

    it("the zip holds none of the server's secrets, paths or data", async () => {
        const r = await download("mac");
        expect(r.status).toBe(200);
        const files = unzipSync(new Uint8Array(r.buf));
        const secrets = [API_KEY, personToken, PASSWORD, dataDir, dataDir.replaceAll("\\", "/"), "platform.db", REPO, REPO.replaceAll("\\", "/")];
        for (const [name, bytes] of Object.entries(files)) {
            if (name.endsWith("runner.enroll")) continue;
            const body = Buffer.from(bytes).toString("latin1");
            for (const s of secrets) expect(body.includes(s), `${s.slice(0, 10)} in ${name}`).toBe(false);
        }
        expect(Object.keys(files)).toContain("runner-my-computer-unix/start-runner.sh");
    });
});

describe("the unzipped kit really runs", () => {
    /** Import a web test and an API test into a project, send its runs to the agent, and check the verdicts that come back. */
    async function runTests(projectId: string, runnerName: string, withWeb: boolean) {
        // No runner is chosen anywhere: every run the person starts goes to their own runner. The fixture application is on this computer,
        // so the owner switches on private addresses for their runner first (off by default), as Settings does.
        const sw = await admin("PATCH", "/api/me/runner", { switches: { privateTargets: true } });
        expect(sw.status, sw.text).toBe(200);
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
        const verdict = async (id: string) => {
            const started = await admin("POST", `/api/tests/${id}/validate`);
            expect(started.status, started.text).toBe(202);
            const job = await until("the job to finish", async () => {
                const j = (await admin("GET", `/api/test-generation/${started.body.jobId}`)).body;
                return ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status) ? j : undefined;
            }, 150_000);
            expect(job.ranOn, JSON.stringify({ status: job.status, error: job.error }).slice(0, 600)).toMatchObject({ kind: "agent", name: runnerName });
            return ((await admin("GET", `/api/tests/${id}/executions`)).body as Array<{ status: string; error?: string }>)[0]!;
        };
        const results = [];
        for (const id of ids) results.push(await verdict(id));
        return results;
    }

    /** The computer's own name, as the runner reports it (config.ts: the host name, trimmed to 64). */
    const computerName = os.hostname().trim().slice(0, 64) || "agent";

    it("runner.mjs from the download trades its code, shows in Settings under the computer's name, runs a web and an API test, and the verdicts come back", async () => {
        const p = await newProject("Kit end to end");
        const dl = await download("mac");
        expect(dl.status).toBe(200);
        const kit = unpack(dl.buf, "mjs");
        const code = fs.readFileSync(path.join(kit, "runner.enroll"), "utf8").trim();
        // Started the way the README's technical readers would: node runner.mjs, nothing else on the command line.
        const run = launch(process.execPath, ["runner.mjs"], kit);
        const mine = await until("the runner to be connected", myRunner, 60_000).catch((e) => {
            throw new Error(`${e.message}\n--- runner output ---\n${output(run)}`);
        });
        expect(mine.name).toBe(computerName);
        expect((await admin("GET", `/api/me/runner/enrollments/${dl.headers.get("x-runner-enrollment-id")}`)).body).toEqual({ status: "connected" });
        // The code is used up and gone from the folder; the credential is kept in this computer's store, never as a plain file here.
        expect(fs.existsSync(path.join(kit, "runner.enroll"))).toBe(false);
        expect(output(run)).toContain("Connected to the platform");
        // Everything it stores is inside the kit folder.
        expect(fs.existsSync(path.join(kit, "work", "tasks"))).toBe(true);

        const [api, ok, bad] = await runTests(p, mine.name, true);
        expect(api).toMatchObject({ status: "passed" });
        expect(ok).toMatchObject({ status: "passed" });
        expect(bad!.status).not.toBe("passed");
        expect(bad!.error).toMatch(/Nothing like this|toBeVisible/);

        // The code and the test password stay out of the runner's output.
        expect(output(run)).not.toContain(code);
        expect(output(run)).not.toContain(PASSWORD);

        // Removing the computer in Settings stops the runner, with a plain message and its own exit code.
        expect((await retire()).status).toBe(200);
        expect(await Promise.race([run.exited, sleep(30_000).then(() => "timeout")])).toBe(3);
        expect(output(run)).toMatch(/The platform no longer accepts this runner/);
        expect(output(run)).not.toContain(code);
        expect(await myRunner()).toBeUndefined();
    }, 400_000);

    it.skipIf(process.platform !== "win32")("start-runner.cmd (double-click) installs nothing here, connects, runs tests, and ends with a plain message when the computer is removed", async () => {
        const p = await newProject("Kit cmd");
        const dl = await download("windows");
        const kit = unpack(dl.buf, "cmd");
        const enrollCode = fs.readFileSync(path.join(kit, "runner.enroll"), "utf8").trim();
        const run = launch("cmd.exe", ["/d", "/c", ".\\start-runner.cmd"], kit, { AITP_KIT_SKIP_INSTALL: "1", AITP_KIT_NO_PAUSE: "1" });
        const mine = await until("the runner started from the .cmd to be connected", myRunner, 90_000).catch((e) => {
            throw new Error(`${e.message}\n--- script output ---\n${output(run)}`);
        });
        expect(output(run)).toContain("Starting the runner");
        const [api, ok] = await runTests(p, mine.name, true).then((r) => r.slice(0, 2));
        expect([api!.status, ok!.status]).toEqual(["passed", "passed"]);

        expect((await retire()).status).toBe(200);
        const code = await Promise.race([run.exited, sleep(60_000).then(() => "timeout")]);
        expect(code, output(run)).toBe(1); // the script's own "stopped for good" exit
        const text = output(run);
        expect(text).toMatch(/no longer accepts this runner/);
        expect(text).toContain("Set up your runner again from Settings, Your runner");
        expect(text).not.toContain(enrollCode);
    }, 400_000);

    it.skipIf(!BASH)("start-runner.sh (bash) connects, runs an API test, and ends with a plain message when the computer is removed", async () => {
        const p = await newProject("Kit sh");
        const dl = await download("mac");
        const kit = unpack(dl.buf, "sh");
        const run = launch(BASH!, ["start-runner.sh"], kit, { AITP_KIT_SKIP_INSTALL: "1", AITP_KIT_NO_PAUSE: "1" });
        const mine = await until("the runner started from the .sh to be connected", myRunner, 90_000).catch((e) => {
            throw new Error(`${e.message}\n--- script output ---\n${output(run)}`);
        });
        const [api] = await runTests(p, mine.name, false);
        expect(api).toMatchObject({ status: "passed" });

        expect((await retire()).status).toBe(200);
        const code = await Promise.race([run.exited, sleep(60_000).then(() => "timeout")]);
        expect(code, output(run)).toBe(3);
        expect(output(run)).toMatch(/no longer accepts this runner/);
    }, 400_000);

    it.skipIf(process.platform !== "win32")("start-runner.cmd on a computer without Node.js explains it, never installs anything on its own, and does not start a runner", async () => {
        const kit = unpack((await download("windows")).buf, "nonode");
        // A PATH with only Windows' own folder: no node, and no winget either (it lives in the user's WindowsApps folder).
        const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
        // The script now also looks in Program Files, the user's folders and the saved PATH, where this computer's own Node.js lives: point those at empty folders.
        const empty = fs.mkdtempSync(path.join(tmp, "empty-"));
        const run = launch(path.join(system, "cmd.exe"), ["/d", "/c", ".\\start-runner.cmd"], kit, {
            PATH: system,
            Path: system,
            ProgramFiles: empty,
            ProgramW6432: empty,
            "ProgramFiles(x86)": empty,
            LOCALAPPDATA: empty,
            APPDATA: empty,
            NVM_HOME: "",
            NVM_SYMLINK: "",
            AITP_KIT_NO_PAUSE: "1",
            AITP_KIT_SKIP_SHELL_SEARCH: "1",
        });
        expect(await run.exited, output(run)).toBe(1);
        const text = output(run);
        expect(text).toContain("Node.js was not found on this computer. The runner needs Node.js 24 or newer.");
        expect(text).toContain("I looked on the PATH, in Program Files");
        expect(text).toContain("https://nodejs.org");
        expect(text).not.toMatch(/Connected|Starting the runner/);
        expect(fs.existsSync(path.join(kit, "work"))).toBe(false); // nothing was started or installed
        expect(await myRunner()).toBeUndefined();
    }, 60_000);

    it.skipIf(!BASH)("start-runner.sh on a computer without Node.js explains it and does not start a runner", async () => {
        const kit = unpack((await download("mac")).buf, "shnonode");
        const tools = path.dirname(BASH!); // Git's own tools (dirname, uname), but no node
        const home = fs.mkdtempSync(path.join(tmp, "home-")); // an empty home: no nvm, Volta or fnm to find
        const run = launch(BASH!, ["start-runner.sh"], kit, { PATH: tools, Path: tools, HOME: home.replaceAll("\\", "/"), AITP_KIT_NO_PAUSE: "1", AITP_KIT_SKIP_SHELL_SEARCH: "1" });
        expect(await run.exited, output(run)).toBe(1);
        const text = output(run);
        expect(text).toContain("Node.js was not found on this computer. The runner needs Node.js 24 or newer.");
        expect(text).toContain("I looked on the PATH, in the Homebrew, nvm, fnm, Volta, asdf, mise, nodenv and n folders");
        expect(text).toContain("https://nodejs.org");
        expect(text).not.toMatch(/Connected|Starting the runner/);
        expect(fs.existsSync(path.join(kit, "work"))).toBe(false);
    }, 60_000);

    /** The download saved where a person's browser saves it, a home folder of its own and a temporary folder to check is left empty. */
    function saved(buf: Buffer, label: string) {
        const root = fs.mkdtempSync(path.join(tmp, `${label}-`));
        const downloads = path.join(root, "Downloads");
        const home = path.join(root, "home");
        const temp = path.join(root, "temp");
        for (const d of [downloads, home, temp]) fs.mkdirSync(d);
        fs.writeFileSync(path.join(downloads, "ai-testing-runner.sh"), buf);
        return { downloads, home, temp, install: path.join(home, ".local", "share", "ai-testing-runner") };
    }
    const start = (where: ReturnType<typeof saved>, home = where.home, shell = "sh") =>
        launch(shell, shell === "sh" ? ["ai-testing-runner.sh"] : ["sh", "ai-testing-runner.sh"], where.downloads, { HOME: home, TMPDIR: where.temp, AITP_KIT_SKIP_INSTALL: "1", AITP_KIT_NO_PAUSE: "1" });

    it.skipIf(process.platform !== "linux")("Linux, one file (round 50): sh ai-testing-runner.sh installs into ~/.local/share/ai-testing-runner, connects, runs an API test; a new download replaces the running runner; no code is left behind", async () => {
        const p = await newProject("Kit one file");
        const dl = await download("linux");
        expect(dl.status, dl.text.slice(0, 200)).toBe(200);
        expect(dl.headers.get("content-disposition")).toBe('attachment; filename="ai-testing-runner.sh"');
        const first = saved(dl.buf, "linux1");
        // The test tools: this repository's node_modules, linked into the install folder the script will use (marked as the runner's own),
        // and the script's install step skipped, as in the other kit tests.
        fs.mkdirSync(first.install, { recursive: true });
        fs.writeFileSync(path.join(first.install, ".created-by-ai-testing-runner"), "test\n");
        fs.symlinkSync(path.join(REPO, "node_modules"), path.join(first.install, "node_modules"), "junction");
        links.push(path.join(first.install, "node_modules"));
        const run = start(first);
        let run2: Running | undefined;
        try {
        const mine = await until("the runner started by sh ai-testing-runner.sh to be connected", myRunner, 90_000).catch((e) => {
            throw new Error(`${e.message}\n--- output ---\n${output(run)}`);
        });
        expect(mine.name).toBe(computerName);
        expect(output(run)).toContain(`Installed in ${first.install}.`);
        // The code is traded and deleted; the temporary copy is gone; only its hash is kept.
        expect(fs.existsSync(path.join(first.install, "runner.enroll"))).toBe(false);
        expect(fs.readdirSync(first.temp).filter((n) => n.startsWith("ai-testing-runner."))).toEqual([]); // the runner itself may use the folder too
        expect(fs.existsSync(path.join(first.install, "work"))).toBe(true);
        const [api] = await runTests(p, mine.name, false);
        expect(api).toMatchObject({ status: "passed" });

        // A second download, started while the first runner runs (busybox sh where there is one): the first stops, the new one connects.
        const again = await download("linux");
        const second = saved(again.buf, "linux2");
        const shell = spawnSync("busybox", ["sh", "-c", "exit 0"]).status === 0 ? "busybox" : "sh";
        const next = start(second, first.home, shell);
        run2 = next;
        expect(await Promise.race([run.exited, sleep(60_000).then(() => "timeout")]), `${output(run)}\n--- new download ---\n${output(next)}\nsignal ${run.child.signalCode}`).toBe(0);
        expect(output(next)).toMatch(/A new download: stopping the runner that is running from the earlier one \(process \d+\)\./);
        const replaced = await until("the new runner to be connected", async () => {
            const r = await myRunner();
            return r && r.id !== mine.id ? r : undefined;
        }, 90_000).catch((e) => {
            throw new Error(`${e.message}\n--- output ---\n${output(next)}`);
        });
        expect(replaced.name).toBe(computerName);
        expect(fs.existsSync(path.join(first.install, "runner.enroll"))).toBe(false);
        expect(fs.readdirSync(second.temp).filter((n) => n.startsWith("ai-testing-runner."))).toEqual([]);
        // Nothing in the install folder holds either code: the runner deleted the one it traded, and the header was never copied there.
        for (const n of fs.readdirSync(first.install)) {
            const f = path.join(first.install, n);
            if (fs.statSync(f).isFile()) expect(/aite_[A-Za-z0-9_-]{20,}/.test(fs.readFileSync(f, "latin1")), n).toBe(false);
        }

        // The same file run again: the runner is already running and nothing changes.
        const same = spawnSync("sh", ["ai-testing-runner.sh"], { cwd: second.downloads, env: { ...process.env, HOME: first.home, TMPDIR: second.temp }, encoding: "utf8", timeout: 60_000 });
        expect(same.status, same.stdout + same.stderr).toBe(0);
        expect(same.stdout).toContain("The AI Testing runner is already running on this computer");
        expect(next.child.exitCode).toBeNull();

        expect((await retire()).status).toBe(200);
        expect(await Promise.race([next.exited, sleep(60_000).then(() => "timeout")]), output(next)).toBe(3);
        expect(output(next)).toMatch(/no longer accepts this runner/);
        } finally {
            // The script runs the runner as its child: on a failure stop that child too (ours, found by its parent's pid), then the script.
            for (const r of [run, run2]) {
                if (!r?.child.pid || r.child.exitCode !== null) continue;
                for (const d of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
                    try {
                        if (fs.readFileSync(`/proc/${d}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[1] === String(r.child.pid)) process.kill(Number(d), "SIGTERM");
                    } catch {
                        /* gone */
                    }
                }
                killOurs(r.child);
            }
        }
    }, 400_000);

    it("a runner whose runner.json is damaged stops with exit code 2 and a plain message", async () => {
        const dl = await download("mac");
        const kit = unpack(dl.buf, "broken");
        fs.writeFileSync(path.join(kit, "runner.json"), "{ not json");
        const run = launch(process.execPath, ["runner.mjs"], kit);
        expect(await run.exited).toBe(2);
        expect(output(run)).toMatch(/runner\.json is not valid\. Download the runner kit again/);
    }, 60_000);
});
