/**
 * The runner kit against a REAL platform: the download route (info, validation, token, limits, secrets), and then the kit itself, unzipped
 * into a temp folder and started the way a tester would start it: the bundled runner.mjs, the Windows start-runner.cmd and (when bash is
 * there) start-runner.sh. Each connects to the platform on a real port with the token inside its zip, shows up as online, runs a real
 * Playwright web test and a real API test from a validation job, and the results come back as the tests' verdicts. A revoked token makes
 * the runner stop with a plain message.
 *
 * node_modules for the unzipped kits is a junction to this repository's (no network install); the install step of the start scripts is
 * skipped with AITP_KIT_SKIP_INSTALL=1, exactly as the brief allows. What is NOT covered here: the install step itself (npm registry,
 * browser download), winget/brew, a real fresh computer.
 *
 * Browser-launching: run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-kit.test.ts
 * Ports: platform 6530, fixture application 6531.
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
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLATFORM_PORT = 6530;
const APP_PORT = 6531;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "kit-admin-key-8d41c7e2f9";
const PASSWORD = "KITLEAK-Password-31a7c5";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS", "RUNNER_KIT_DIR", "AGENT_MAX_TOKENS", "RUNNER_KIT_RATE_PER_MINUTE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let tmp: string;
let bundleDir: string;
let appServer: http.Server;
const logged: string[] = [];
const children: ChildProcess[] = [];
const links: string[] = [];

const admin = async (method: string, url: string, body?: unknown, headers: Record<string, string> = { "x-api-key": API_KEY }) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    return { status: res.status, headers: res.headers, buf, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; headers: Headers; buf: Buffer; text: string; body: any };
};
const newProject = async (name: string) => (await admin("POST", "/api/projects", { name })).body.id as string;
const download = (projectId: string, name: string, platformName: "windows" | "unix" = "windows") => admin("POST", `/api/projects/${projectId}/runner-kits`, { name, platform: platformName, kind: "files" });
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
    // These journeys download several kits per project; the one-runner default is covered in runner-limit-unit.test.ts.
    process.env.AGENT_MAX_TOKENS = "25";
    delete process.env.RUNNER_KIT_RATE_PER_MINUTE;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-kit-api-"));
    bundleDir = path.join(tmp, "dist-runner");
    // Until the bundle is built, the server must say so.
    process.env.RUNNER_KIT_DIR = path.join(tmp, "not-built");
    appServer = http.createServer((req, res) => {
        if (req.url === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Welcome to the fixture</h1></main></body></html>`);
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-kit-data-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), PUBLIC_URL: BASE, CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
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
}, 60_000);

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
    it("info says it is not available and why; a download is a plain 503", async () => {
        const p = await newProject("Not built yet");
        const info = await admin("GET", `/api/projects/${p}/runner-kits/info`);
        expect(info.status).toBe(200);
        expect(info.body).toMatchObject({ available: false, reason: "The runner kit has not been built on this server. Run `npm run build:runner`.", nodeMin: 24 });
        const d = await download(p, "Laptop");
        expect(d.status).toBe(503);
        expect(d.body.error ?? d.body.message).toContain("npm run build:runner");
        // Nothing was handed out, so no token was made either.
        expect((await admin("GET", `/api/projects/${p}/agent-tokens`)).body).toEqual([]);
    });
});

describe("the routes", () => {
    let projectId = "";

    it("build the bundle", async () => {
        const manifest = await buildRunner({ outDir: bundleDir });
        process.env.RUNNER_KIT_DIR = bundleDir;
        expect(manifest.files).toHaveLength(5);
        projectId = await newProject("Kit Shop");
    }, 120_000);

    it("are protected by the API key like every other route", async () => {
        for (const headers of [{} as Record<string, string>, { "x-api-key": "wrong" }]) {
            expect((await admin("GET", `/api/projects/${projectId}/runner-kits/info`, undefined, headers)).status).toBe(401);
            expect((await admin("POST", `/api/projects/${projectId}/runner-kits`, { name: "x", platform: "windows" }, headers)).status).toBe(401);
        }
        expect((await admin("GET", `/api/projects/${projectId}/agent-tokens`)).body).toEqual([]);
    });

    it("info: available, the version, the address from PUBLIC_URL", async () => {
        const info = await admin("GET", `/api/projects/${projectId}/runner-kits/info`);
        expect(info.status).toBe(200);
        expect(info.body).toMatchObject({ available: true, platformUrl: BASE, urlOk: true, nodeMin: 24 });
        expect(info.body.kitVersion).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{10}$/);
        // PUBLIC_URL here is an address on this computer, which the page says plainly.
        expect(info.body.urlWarning).toMatch(/only a runner on this computer/i);
        expect(info.body.reason).toBeUndefined();
    });

    it("info without PUBLIC_URL uses the Host header and says so; plain http on a public host is flagged", async () => {
        const cfg = platform.config as unknown as { PUBLIC_URL?: string };
        const before = cfg.PUBLIC_URL;
        try {
            delete cfg.PUBLIC_URL;
            const lan = (await admin("GET", `/api/projects/${projectId}/runner-kits/info`)).body;
            expect(lan).toMatchObject({ available: true, platformUrl: BASE, urlOk: true });
            expect(lan.urlWarning).toMatch(/set PUBLIC_URL|only a runner on this computer/i);
            cfg.PUBLIC_URL = "http://tests.example.com";
            const pub = (await admin("GET", `/api/projects/${projectId}/runner-kits/info`)).body;
            expect(pub).toMatchObject({ urlOk: false, platformUrl: "http://tests.example.com" });
            expect(pub.urlWarning).toBe("Runners need an https address when the platform is not on your own network. Set PUBLIC_URL to the https address people use.");
        } finally {
            if (before === undefined) delete cfg.PUBLIC_URL;
            else cfg.PUBLIC_URL = before;
        }
    });

    it("refuse a bad name or system with a plain 400 and make no token", async () => {
        const bodies: unknown[] = [{}, { name: "", platform: "windows" }, { name: "A".repeat(61), platform: "windows" }, { name: "a/b", platform: "unix" }, { name: "a\\b", platform: "unix" }, { name: "tab\there", platform: "unix" }, { name: "ok", platform: "mac" }, { name: "ok" }, { name: "ok", platform: "unix", extra: 1 }, { name: 5, platform: "unix" }];
        for (const b of bodies) {
            const r = await admin("POST", `/api/projects/${projectId}/runner-kits`, b);
            expect(r.status, JSON.stringify(b)).toBe(400);
            expect(String(r.body.error ?? r.body.message ?? "").length).toBeGreaterThan(5);
        }
        expect((await admin("GET", `/api/projects/${projectId}/agent-tokens`)).body).toEqual([]);
    });

    it("answer 404 for a project that does not exist", async () => {
        const ghost = "00000000-0000-4000-8000-000000000000";
        expect((await admin("GET", `/api/projects/${ghost}/runner-kits/info`)).status).toBe(404);
        expect((await download(ghost, "x")).status).toBe(404);
    });

    it("download: a zip, a header with the new token's id, the token in the list under the runner's name, never in the list's answer or the log", async () => {
        const r = await download(projectId, "Maya's laptop");
        expect(r.status, r.text.slice(0, 200)).toBe(200);
        expect(r.headers.get("content-type")).toBe("application/zip");
        expect(r.headers.get("content-disposition")).toBe('attachment; filename="runner-kit-shop-windows.zip"');
        expect(r.headers.get("cache-control")).toBe("no-store");
        const tokenId = r.headers.get("x-runner-token-id")!;
        expect(tokenId).toMatch(/^[0-9a-f-]{36}$/);

        const files = unzipSync(new Uint8Array(r.buf));
        const secret = Buffer.from(files["runner-kit-shop-windows/runner.token"]!).toString("utf8").trim();
        expect(secret).toMatch(/^aitg_[A-Za-z0-9_-]{20,}$/);

        const list = (await admin("GET", `/api/projects/${projectId}/agent-tokens`)).body as Array<{ id: string; label: string; revokedAt: string | null }>;
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: tokenId, label: "Maya's laptop", revokedAt: null });
        expect(JSON.stringify(list)).not.toContain(secret);

        // The platform keeps only the hash: the audit row and the log know the token's last four characters at most.
        const audit = platform.db.all<{ action: string; detail: string }>("SELECT action, detail FROM custom_audit WHERE project_id = ? AND action = 'runner-kit-downloaded'", projectId);
        expect(audit).toHaveLength(1);
        expect(audit[0]!.detail).toContain("Maya's laptop");
        expect(audit[0]!.detail).not.toContain(secret);
        expect(logged.some((l) => l.includes("runner-kit-downloaded"))).toBe(true);
        for (const line of logged) expect(line).not.toContain(secret);
        expect(JSON.stringify(platform.db.all("SELECT * FROM agent_tokens"))).not.toContain(secret);

        // runner.json points at the platform and names the runner.
        const json = JSON.parse(Buffer.from(files["runner-kit-shop-windows/runner.json"]!).toString("utf8"));
        expect(json).toMatchObject({ url: BASE, name: "Maya's laptop" });
        expect(json.kitVersion).toBe((await admin("GET", `/api/projects/${projectId}/runner-kits/info`)).body.kitVersion);
    });

    it("the zip holds none of the server's secrets, paths or data", async () => {
        const r = await download(projectId, "Leak check", "unix");
        expect(r.status).toBe(200);
        const files = unzipSync(new Uint8Array(r.buf));
        const secrets = [API_KEY, PASSWORD, dataDir, dataDir.replaceAll("\\", "/"), "platform.db", REPO, REPO.replaceAll("\\", "/")];
        for (const [name, bytes] of Object.entries(files)) {
            if (name.endsWith("runner.token")) continue;
            const body = Buffer.from(bytes).toString("latin1");
            for (const s of secrets) expect(body.includes(s), `${s.slice(0, 10)} in ${name}`).toBe(false);
        }
        expect(Object.keys(files)).toContain("runner-kit-shop-unix/start-runner.sh");
    });

    it("a kit for one project does not show up in another", async () => {
        const other = await newProject("Somebody else");
        expect((await admin("GET", `/api/projects/${other}/agent-tokens`)).body).toEqual([]);
        expect((await admin("GET", `/api/projects/${other}/agents`)).body).toEqual([]);
    });

    it("stops at the token limit (409) and works again after one is revoked", async () => {
        const p = await newProject("Token limit");
        process.env.AGENT_MAX_TOKENS = "2";
        try {
            const first = await download(p, "one");
            expect(first.status).toBe(200);
            expect((await admin("POST", `/api/projects/${p}/agent-tokens`, { label: "two" })).status).toBe(201);
            const refused = await download(p, "three");
            expect(refused.status).toBe(409);
            expect(String(refused.body.error ?? refused.body.message)).toMatch(/already has 2 runners/);
            expect((await admin("GET", `/api/projects/${p}/agent-tokens`)).body).toHaveLength(2);
            // The hand-made token route has the same limit, so the limit cannot be stepped around.
            const tokenRefused = await admin("POST", `/api/projects/${p}/agent-tokens`, { label: "four" });
            expect(tokenRefused.status).toBe(409);
            expect(String(tokenRefused.body.error)).toMatch(/already has 2 runners/);
            expect((await admin("GET", `/api/projects/${p}/agent-tokens`)).body).toHaveLength(2);
            // Removing a runner makes room again.
            expect((await admin("DELETE", `/api/projects/${p}/agent-tokens/${first.headers.get("x-runner-token-id")}`)).status).toBe(200);
            expect((await download(p, "three")).status).toBe(200);
            expect((await download(p, "five")).status).toBe(409); // two active again (two and three)
        } finally {
            process.env.AGENT_MAX_TOKENS = "25"; // back to this file's baseline
        }
    });

    it("is rate limited per project", async () => {
        const p = await newProject("Rate limit");
        const statuses: number[] = [];
        for (let i = 0; i < 7; i++) statuses.push((await download(p, `r${i}`)).status);
        expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
        expect(statuses.slice(5)).toEqual([429, 429]);
        // A refused download made no token.
        expect((await admin("GET", `/api/projects/${p}/agent-tokens`)).body).toHaveLength(5);
        // Another project is not affected.
        expect((await download(projectId, "still fine")).status).toBe(200);
    });
});

describe("the unzipped kit really runs", () => {
    /** Import a web test and an API test into a project, send its runs to the agent, and check the verdicts that come back. */
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
        const set = await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" });
        expect(set.status, set.text).toBe(200);
        const verdict = async (id: string) => {
            const started = await admin("POST", `/api/tests/${id}/validate`);
            expect(started.status, started.text).toBe(202);
            const job = await until("the job to finish", async () => {
                const j = (await admin("GET", `/api/test-generation/${started.body.jobId}`)).body;
                return ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status) ? j : undefined;
            }, 150_000);
            expect(job.ranOn).toMatchObject({ kind: "agent", name: runnerName });
            return ((await admin("GET", `/api/tests/${id}/executions`)).body as Array<{ status: string; error?: string }>)[0]!;
        };
        const results = [];
        for (const id of ids) results.push(await verdict(id));
        return results;
    }

    const onlineAgents = async (projectId: string) => ((await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; online: boolean; capabilities: { browsers: string[]; kitVersion?: string } }>).filter((a) => a.online);

    it("runner.mjs from the kit connects with the token inside, runs a web and an API test, and the verdicts come back", async () => {
        const p = await newProject("Kit end to end");
        const dl = await download(p, "kit runner");
        expect(dl.status).toBe(200);
        const kit = unpack(dl.buf, "mjs");
        // Started the way the README's technical readers would: node runner.mjs, nothing else on the command line.
        const run = launch(process.execPath, ["runner.mjs"], kit);
        const agent = await until("the runner to be online", async () => (await onlineAgents(p))[0], 60_000).catch((e) => {
            throw new Error(`${e.message}\n--- runner output ---\n${output(run)}`);
        });
        expect(agent).toMatchObject({ name: "kit runner", online: true });
        expect(agent.capabilities.browsers).toContain("chromium");
        // The kit version it reports is the one written into runner.json.
        const info = (await admin("GET", `/api/projects/${p}/runner-kits/info`)).body;
        expect(agent.capabilities.kitVersion).toBe(info.kitVersion);
        expect(output(run)).toContain("Connected to the platform");
        // Everything it stores is inside the kit folder.
        expect(fs.existsSync(path.join(kit, "work", "tasks"))).toBe(true);

        const [api, ok, bad] = await runTests(p, "kit runner", true);
        expect(api).toMatchObject({ status: "passed" });
        expect(ok).toMatchObject({ status: "passed" });
        expect(bad!.status).not.toBe("passed");
        expect(bad!.error).toMatch(/Nothing like this|toBeVisible/);

        // The token and the test password stay out of the runner's output.
        const token = fs.readFileSync(path.join(kit, "runner.token"), "utf8").trim();
        expect(output(run)).not.toContain(token);
        expect(output(run)).not.toContain(PASSWORD);

        // Revoking the token in the platform stops the runner, with a plain message and its own exit code.
        const tokenId = dl.headers.get("x-runner-token-id")!;
        expect((await admin("DELETE", `/api/projects/${p}/agent-tokens/${tokenId}`)).status).toBe(200);
        expect(await Promise.race([run.exited, sleep(30_000).then(() => "timeout")])).toBe(3);
        expect(output(run)).toMatch(/not valid or was revoked/);
        expect(output(run)).not.toContain(token);
    }, 400_000);

    it.skipIf(process.platform !== "win32")("start-runner.cmd (double-click) installs nothing here, connects, runs tests, and ends with a plain message when the token is revoked", async () => {
        const p = await newProject("Kit cmd");
        const dl = await download(p, "cmd runner");
        const kit = unpack(dl.buf, "cmd");
        const run = launch("cmd.exe", ["/d", "/c", ".\\start-runner.cmd"], kit, { AITP_KIT_SKIP_INSTALL: "1", AITP_KIT_NO_PAUSE: "1" });
        await until("the runner started from the .cmd to be online", async () => (await onlineAgents(p))[0], 90_000).catch((e) => {
            throw new Error(`${e.message}\n--- script output ---\n${output(run)}`);
        });
        expect(output(run)).toContain("Starting the runner");
        const [api, ok] = await runTests(p, "cmd runner", true).then((r) => r.slice(0, 2));
        expect([api!.status, ok!.status]).toEqual(["passed", "passed"]);

        expect((await admin("DELETE", `/api/projects/${p}/agent-tokens/${dl.headers.get("x-runner-token-id")}`)).status).toBe(200);
        const code = await Promise.race([run.exited, sleep(60_000).then(() => "timeout")]);
        expect(code, output(run)).toBe(1); // the script's own "stopped for good" exit
        const text = output(run);
        expect(text).toMatch(/no longer accepts this runner's token/);
        expect(text).toContain("Download a new runner kit");
        expect(text).not.toContain(fs.readFileSync(path.join(kit, "runner.token"), "utf8").trim());
    }, 400_000);

    it.skipIf(!BASH)("start-runner.sh (bash) connects, runs an API test, and ends with a plain message when the token is revoked", async () => {
        const p = await newProject("Kit sh");
        const dl = await download(p, "unix runner", "unix");
        const kit = unpack(dl.buf, "sh");
        const run = launch(BASH!, ["start-runner.sh"], kit, { AITP_KIT_SKIP_INSTALL: "1", AITP_KIT_NO_PAUSE: "1" });
        await until("the runner started from the .sh to be online", async () => (await onlineAgents(p))[0], 90_000).catch((e) => {
            throw new Error(`${e.message}\n--- script output ---\n${output(run)}`);
        });
        const [api] = await runTests(p, "unix runner", false);
        expect(api).toMatchObject({ status: "passed" });

        expect((await admin("DELETE", `/api/projects/${p}/agent-tokens/${dl.headers.get("x-runner-token-id")}`)).status).toBe(200);
        const code = await Promise.race([run.exited, sleep(60_000).then(() => "timeout")]);
        expect(code, output(run)).toBe(3);
        expect(output(run)).toMatch(/no longer accepts this runner's token/);
    }, 400_000);

    it.skipIf(process.platform !== "win32")("start-runner.cmd on a computer without Node.js explains it, never installs anything on its own, and does not start a runner", async () => {
        const p = await newProject("Kit no node");
        const kit = unpack((await download(p, "no node")).buf, "nonode");
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
        expect((await onlineAgents(p)).length).toBe(0);
    }, 60_000);

    it.skipIf(!BASH)("start-runner.sh on a computer without Node.js explains it and does not start a runner", async () => {
        const p = await newProject("Kit sh no node");
        const kit = unpack((await download(p, "no node", "unix")).buf, "shnonode");
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

    it("a runner whose runner.json is damaged stops with exit code 2 and a plain message", async () => {
        const p = await newProject("Kit broken");
        const dl = await download(p, "broken");
        const kit = unpack(dl.buf, "broken");
        fs.writeFileSync(path.join(kit, "runner.json"), "{ not json");
        const run = launch(process.execPath, ["runner.mjs"], kit);
        expect(await run.exited).toBe(2);
        expect(output(run)).toMatch(/runner\.json is not valid\. Download the runner kit again/);
    }, 60_000);
});
