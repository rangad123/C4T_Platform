/**
 * The complete runner download, end to end on this Windows laptop, against a REAL platform:
 *   - built with `buildComplete` from this checkout's REAL node_modules (every package the runner pins, copied), with a stand-in for
 *     nodejs.org serving a small fake Node.js zip (port 6913);
 *   - downloaded through the platform's own route over real HTTP (streamed, with its length), unzipped with Windows' own tar.exe;
 *   - started with start-runner.cmd and NO Node.js and no npm on the PATH. The node.exe inside is replaced by a hard link to this computer's
 *     Node.js (the fake archive's is not a program), so every package the runner loads comes from the download's own node_modules;
 *   - the runner connects, runs a real API test and real web tests from a validation job, and ends with the plain revoked message.
 * Also: Playwright's test runner and Taqwright load from the copied node_modules with the bundled Node.js.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-complete-kit.test.ts
 * Ports: platform 6912, stand-in nodejs.org 6913, fixture application 6914.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildComplete } from "../scripts/build-runner-complete.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLATFORM_PORT = 6912;
const DIST_PORT = 6913;
const APP_PORT = 6914;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "complete-e2e-admin-key-71c3d9";
const VERSION = "24.19.0";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS", "RUNNER_KIT_DIR", "RUNNER_COMPLETE_DIR", "RUNNER_INSTALLER_DIR", "AGENT_MAX_TOKENS", "RUNNER_KIT_RATE_PER_MINUTE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const ON_WINDOWS = process.platform === "win32";
const SYSTEM_TAR = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

let tmp: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dist: http.Server;
let app: http.Server;
const children: ChildProcess[] = [];
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    return { status: res.status, headers: res.headers, buf, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; headers: Headers; buf: Buffer; text: string; body: any };
};
async function until<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, ms = 60_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v) return v;
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
        await sleep(250);
    }
}

interface Running {
    child: ChildProcess;
    out: string[];
    exited: Promise<number | null>;
}
function launch(command: string, args: string[], cwd: string, extraEnv: Record<string, string>): Running {
    const overridden = new Set(Object.keys(extraEnv).map((k) => k.toUpperCase()));
    const inherited = Object.entries(process.env).filter(([k]) => !overridden.has(k.toUpperCase()));
    const env: NodeJS.ProcessEnv = Object.fromEntries([...inherited, ...Object.entries(extraEnv)].filter(([k]) => !/^(AGENT_|RUNNER_KIT_|RUNNER_COMPLETE_|NODE_OPTIONS$|npm_)/i.test(k)));
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    const out: string[] = [];
    child.stdout?.on("data", (d) => out.push(String(d)));
    child.stderr?.on("data", (d) => out.push(String(d)));
    return { child, out, exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))) };
}
const output = (r: Running) => r.out.join("");
/** Ends a process this test started, and only that process tree. */
function killOurs(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null || child.signalCode) return;
    if (ON_WINDOWS) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGKILL");
}
/** Windows' own folders only: no Node.js, no npm. */
const pathWithoutNode = () => {
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    return [path.join(sys, "System32"), sys, path.join(sys, "System32", "Wbem"), path.join(sys, "System32", "WindowsPowerShell", "v1.0")].join(";");
};

let kitZip: Buffer;
let projectId: string;
let tokenId: string;

beforeAll(async () => {
    if (!ON_WINDOWS) return;
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    for (const k of ["BLOCK_PRIVATE_TARGETS", "AGENT_MAX_TOKENS", "RUNNER_KIT_RATE_PER_MINUTE", "RUNNER_INSTALLER_DIR"]) delete process.env[k];
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-complete-e2e-"));

    // The stand-in nodejs.org: one fake Windows zip and its checksum list.
    const top = `node-v${VERSION}-win-x64`;
    const zip = Buffer.from(zipSync({ [`${top}/node.exe`]: new TextEncoder().encode("stand-in node.exe"), [`${top}/LICENSE`]: new TextEncoder().encode("MIT (stand-in)\n") }));
    const name = `${top}.zip`;
    dist = http.createServer((req, res) => {
        if (req.url === `/v${VERSION}/SHASUMS256.txt`) return void res.writeHead(200).end(`${sha(zip)}  ${name}\n`);
        if (req.url === `/v${VERSION}/${name}`) return void res.writeHead(200, { "content-length": String(zip.length) }).end(zip);
        res.writeHead(404).end();
    });
    await new Promise<void>((r) => dist.listen(DIST_PORT, "127.0.0.1", () => r()));
    app = http.createServer((req, res) => {
        if (req.url === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Welcome to the fixture</h1></main></body></html>`);
    });
    await new Promise<void>((r) => app.listen(APP_PORT, "127.0.0.1", () => r()));

    // The runner bundle and the complete download, from this checkout's real node_modules.
    const bundleDir = path.join(tmp, "dist-runner");
    await buildRunner({ outDir: bundleDir });
    const completeDir = path.join(tmp, "dist-runner-complete");
    await buildComplete({ root: REPO, bundleDir, outDir: completeDir, cacheDir: path.join(tmp, "cache"), targets: ["win-x64"], env: { AITP_NODE_DIST_URL: `http://127.0.0.1:${DIST_PORT}` }, version: VERSION });
    process.env.RUNNER_KIT_DIR = bundleDir;
    process.env.RUNNER_COMPLETE_DIR = completeDir;

    platform = bootstrap(loadConfig({ DATA_DIR: path.join(tmp, "data"), API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), PUBLIC_URL: BASE, CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();

    projectId = (await admin("POST", "/api/projects", { name: "Complete shop" })).body.id;
    const r = await admin("POST", `/api/projects/${projectId}/runner-kits`, { name: "complete runner", platform: "windows", complete: true, arch: "x64" });
    if (r.status !== 200) throw new Error(`download failed: ${r.status} ${r.text.slice(0, 300)}`);
    expect(Number(r.headers.get("content-length"))).toBe(r.buf.length);
    kitZip = r.buf;
    tokenId = r.headers.get("x-runner-token-id")!;
}, 300_000);

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
    await new Promise((r) => (dist ? dist.close(r) : r(undefined)));
    await new Promise((r) => (app ? app.close(r) : r(undefined)));
    if (tmp) {
        try {
            fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
        } catch {
            /* a process we ended can hold its folder for a moment; the temp folder is cleaned later */
        }
    }
});

/** The download unzipped with Windows' own tar, and a real Node.js standing in for the fake node.exe. */
function unpack(label: string): string {
    const dir = fs.mkdtempSync(path.join(tmp, `${label}-`));
    fs.writeFileSync(path.join(dir, "download.zip"), kitZip);
    const r = spawnSync(SYSTEM_TAR, ["-xf", "download.zip"], { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    fs.rmSync(path.join(dir, "download.zip"));
    const kit = path.join(dir, fs.readdirSync(dir)[0]!);
    fs.rmSync(path.join(kit, "node", "node.exe"));
    try {
        fs.linkSync(process.execPath, path.join(kit, "node", "node.exe"));
    } catch {
        fs.copyFileSync(process.execPath, path.join(kit, "node", "node.exe"));
    }
    return kit;
}

const chromiumCached = (): boolean => {
    try {
        const list = JSON.parse(fs.readFileSync(path.join(REPO, "node_modules", "playwright-core", "browsers.json"), "utf8")).browsers as Array<{ name: string; revision: string }>;
        const rev = (n: string) => list.find((b) => b.name === n)!.revision;
        const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
        return fs.existsSync(path.join(base, `chromium-${rev("chromium")}`, "INSTALLATION_COMPLETE")) && fs.existsSync(path.join(base, `chromium_headless_shell-${rev("chromium-headless-shell")}`, "INSTALLATION_COMPLETE"));
    } catch {
        return false;
    }
};

describe.skipIf(!ON_WINDOWS || !fs.existsSync(SYSTEM_TAR))("the complete download on this Windows computer", () => {
    it("Playwright's test runner and Taqwright load from the download's own node_modules with its own Node.js", () => {
        const kit = unpack("load");
        const node = path.join(kit, "node", "node.exe");
        const env = { SystemRoot: process.env.SystemRoot ?? "", PATH: pathWithoutNode(), TEMP: tmp, TMP: tmp };
        const pw = spawnSync(node, [path.join("node_modules", "@playwright", "test", "cli.js"), "--version"], { cwd: kit, env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
        expect(`${pw.stdout}${pw.stderr}`).toMatch(/Version 1\.\d+\.\d+/);
        const load = spawnSync(node, ["--input-type=module", "-e", "await import('@playwright/test'); await import('typescript'); await import('@axe-core/playwright'); await import('@taqwright/taqwright'); console.log('all-loaded');"], { cwd: kit, env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
        expect(`${load.stdout}${load.stderr}`).toContain("all-loaded");
        // Every package resolved inside the download, never from this checkout.
        const where = spawnSync(node, ["-p", "require.resolve('playwright-core')"], { cwd: kit, env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
        expect(where.stdout.trim().toLowerCase().startsWith(kit.toLowerCase())).toBe(true);
    });

    it("start-runner.cmd with no Node.js and no npm on the PATH connects, runs real tests, and ends plainly when the token is revoked", async () => {
        const kit = unpack("run");
        const run = launch("cmd.exe", ["/d", "/c", ".\\start-runner.cmd"], kit, {
            PATH: pathWithoutNode(),
            AITP_KIT_NO_PAUSE: "1",
            AITP_KIT_SKIP_SHELL_SEARCH: "1",
            // The runner finds Playwright's browsers where this computer keeps them.
            PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright"),
        });
        await until("the runner from the complete download to be online", async () => ((await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ online: boolean }>).find((a) => a.online), 120_000).catch((e) => {
            throw new Error(`${e.message}\n--- script output ---\n${output(run)}`);
        });
        const text = output(run);
        expect(text).toContain(`Using the Node.js that came with this download, version ${process.version}.`);
        expect(text).toContain("The test tools came with this download. Nothing to install.");
        expect(text).not.toMatch(/npm install|installing the test tools|playwright install/i);

        const withWeb = chromiumCached();
        const specs = [
            { title: "The health endpoint answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/health" }, { action: "assertResponse", check: "status", expected: 200 }] },
            ...(withWeb ? [{ title: "The home page greets people", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Welcome to the fixture" } }] }] : []),
        ];
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs });
        expect(imp.status, imp.text).toBe(202);
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
        for (const t of imp.body.tests as Array<{ id: string }>) {
            const started = await admin("POST", `/api/tests/${t.id}/validate`);
            expect(started.status, started.text).toBe(202);
            const job = await until("the job to finish", async () => {
                const j = (await admin("GET", `/api/test-generation/${started.body.jobId}`)).body;
                return ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status) ? j : undefined;
            }, 180_000);
            expect(job.ranOn).toMatchObject({ kind: "agent", name: "complete runner" });
            const exec = ((await admin("GET", `/api/tests/${t.id}/executions`)).body as Array<{ status: string; error?: string }>)[0]!;
            expect(exec.status, `${exec.error ?? ""}\n--- runner ---\n${output(run).slice(-3000)}`).toBe("passed");
        }

        expect((await admin("DELETE", `/api/projects/${projectId}/agent-tokens/${tokenId}`)).status).toBe(200);
        const code = await Promise.race([run.exited, sleep(60_000).then(() => "timeout")]);
        expect(code, output(run)).toBe(1);
        expect(output(run)).toMatch(/no longer accepts this runner's token/);
    }, 600_000);
});
