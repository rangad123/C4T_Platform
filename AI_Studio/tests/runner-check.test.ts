/**
 * "Check this computer" for real (docs/features/runner-check.md), on local sockets only:
 *  - a person's runner download from the REAL platform route (POST /api/me/runner/download, round 45), its one-time code traded the way
 *    the runner trades it (the credential kept in this computer's store), unzipped into a folder with a space and brackets, with this
 *    checkout's node_modules linked in (a junction, removed by unlinking only): check-computer.cmd run by cmd.exe and check-computer.sh run
 *    by Git Bash find Node.js the way the start scripts do and print the check; the credential is accepted and never printed;
 *  - the REAL runner program started from that download sends its check with its hello, and Settings (GET /api/me/runner) shows it;
 *  - the computer removed in Settings, the platform unreachable, and an https platform behind the TEST-ONLY company certificate reached through a proxy
 *    with a password (untrusted until runner.json names the certificate file; the password never printed).
 *
 * Starts a platform server and runner programs: run under the lock,
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-check.test.ts
 * Ports 8802-8806 (8806 is left closed on purpose).
 */
import { spawn, type ChildProcess } from "node:child_process";
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
import { enrollByHand, personToken } from "./fixtures/runner-person.js";
import { ConnectProxy, tlsFront } from "./fixtures/connect-proxy.js";
import { companyTls, removeMintedTls, TLS_SKIP_REASON } from "./fixtures/tls-files.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const COMPANY = companyTls();
if (!COMPANY) console.warn(TLS_SKIP_REASON);
const CA = COMPANY?.ca ?? "";
const FAKE_REG = path.join(ROOT, "tests/fixtures/fake-reg.mjs");
const API_KEY = "chk-admin-key-2b7e";
const PLATFORM_PORT = 8802;
const STUB_PORT = 8803;
const FRONT_PORT = 8804;
const PROXY_PORT = 8805;
const CLOSED_PORT = 8806;
/** The runner takes the computer's own name (the download names none). */
const NAME = os.hostname().trim().slice(0, 64) || "agent";
const USER = "maya";
const PASSWORD = "Chk-Pr0xy-S3cret-e2e";
const STUB_TOKEN = "aitg_CheckStubTokenSentinel0123456789abcd";
const BASH = ["C:\\Program Files\\Git\\usr\\bin\\bash.exe", "/bin/bash", "/usr/bin/bash"].find((p) => fs.existsSync(p));
const win = process.platform === "win32";

let tmp: string;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let person: { id: string; token: string };
let token: string;
let kit: string;
const links: string[] = [];
const started: ChildProcess[] = [];
let stub: http.Server;
let front: { stop(): Promise<void> };
let proxy: ConnectProxy;
const savedKitDir = process.env.RUNNER_KIT_DIR;
const savedInstallerDir = process.env.RUNNER_INSTALLER_DIR;

/** Requests as the person whose runner this is (their own API token). */
const admin = async (method: "GET" | "POST" | "DELETE", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${person.token}` }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, headers: r.headers, raw: r.rawPayload, body: (r.headers["content-type"] ?? "").includes("json") ? r.json() : undefined };
};

/** This machine's environment without anything that would point the runner at a real proxy, a real Android SDK or another setting. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (/^(https?_proxy|no_proxy|all_proxy|node_extra_ca_certs|node_use_system_ca|node_use_env_proxy|android_home|android_sdk_root)$/i.test(k) || /^AITP_/i.test(k)) continue;
        env[k] = v;
    }
    // The Windows proxy setting comes from the fake reg (empty: no proxy); no phone tools are fetched; no key press at the end.
    return { ...env, AITP_REG_PATH: FAKE_REG, FAKE_REG_OUTPUT: "", AITP_ADB_PATH: path.join(tmp, "no-adb"), AITP_KIT_NO_PAUSE: "1", AITP_KIT_SKIP_SHELL_SEARCH: "1", ...extra };
}

/** Run a program to its end (async, so the servers in this process keep answering). Only the process started here is ever stopped. */
function run(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, ms = 90_000): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
        const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        started.push(child);
        let out = "";
        child.stdout!.on("data", (d) => (out += d));
        child.stderr!.on("data", (d) => (out += d));
        const timer = setTimeout(() => child.kill(), ms);
        child.on("exit", (code) => {
            clearTimeout(timer);
            resolve({ code, out });
        });
    });
}

/** A copy of the unzipped download in another folder, with its own runner.json lines, and the checkout's node_modules linked in. */
function copyKit(name: string, json: Record<string, unknown>, files: Record<string, string> = {}): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(kit)) if (f !== "node_modules" && f !== "work") fs.copyFileSync(path.join(kit, f), path.join(dir, f));
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "runner.json"), "utf8"));
    fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ ...cfg, ...json }));
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
    link(dir);
    return dir;
}

function link(dir: string): void {
    const l = path.join(dir, "node_modules");
    fs.symlinkSync(path.join(ROOT, "node_modules"), l, "junction");
    links.push(l);
}

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-check-"));
    const bundleDir = path.join(tmp, "bundle");
    await buildRunner({ outDir: bundleDir });
    process.env.RUNNER_KIT_DIR = bundleDir;
    platform = bootstrap(loadConfig({ DATA_DIR: path.join(tmp, "data"), HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), PUBLIC_URL: `http://127.0.0.1:${PLATFORM_PORT}`, SECRET_KEY: "chk-secret-key-0123456789abcdef" }));
    app = await buildServer(platform);
    await app.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    person = personToken(app);
    // No installer is built here: the Windows download is the plain files with the start and check scripts.
    process.env.RUNNER_INSTALLER_DIR = path.join(tmp, "no-installer");
    const dl = await admin("POST", "/api/me/runner/download", { os: "windows", arch: "x64" });
    expect(dl.status).toBe(200);
    kit = path.join(tmp, "runner kit (1)");
    for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(dl.raw)))) {
        if (name.endsWith("/")) continue;
        const rel = name.split("/").slice(1).join(path.sep);
        fs.mkdirSync(path.dirname(path.join(kit, rel)), { recursive: true });
        fs.writeFileSync(path.join(kit, rel), bytes);
    }
    // The code traded as the runner would: the credential is kept in this computer's store for this folder, the code file is gone.
    token = await enrollByHand(`http://127.0.0.1:${PLATFORM_PORT}`, kit, NAME);
    link(kit);

    // A stand-in platform behind the company certificate, reached only through the proxy (platform.test exists only there).
    stub = http.createServer((req, res) => {
        if (req.url === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
        if (req.url === "/api/agent/check" && req.headers.authorization === `Bearer ${STUB_TOKEN}`) return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"project":"Proxy shop"}');
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"This runner agent token is not valid or was revoked."}');
    });
    await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));
    front = await tlsFront(FRONT_PORT, STUB_PORT, { cert: fs.readFileSync(COMPANY!.cert, "utf8") + fs.readFileSync(CA, "utf8"), key: fs.readFileSync(COMPANY!.key, "utf8") });
    proxy = new ConnectProxy(PROXY_PORT, { user: USER, password: PASSWORD });
    await proxy.start();
}, 180_000);

afterAll(async () => {
    for (const c of started) if (c.exitCode === null) c.kill();
    await app?.close();
    platform?.db.close();
    removeMintedTls();
    await Promise.all([front?.stop(), proxy?.stop(), new Promise<void>((r) => (stub ? stub.close(() => r()) : r()))]);
    for (const l of links) fs.unlinkSync(l);
    if (savedKitDir === undefined) delete process.env.RUNNER_KIT_DIR;
    else process.env.RUNNER_KIT_DIR = savedKitDir;
    if (savedInstallerDir === undefined) delete process.env.RUNNER_INSTALLER_DIR;
    else process.env.RUNNER_INSTALLER_DIR = savedInstallerDir;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}, 60_000);

const nodeDirFirst = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    return { ...env, [key]: `${path.dirname(process.execPath)}${path.delimiter}${env[key] ?? ""}` };
};

function expectGoodCheck(out: string): void {
    expect(out).toContain(`Check this computer for the AI Testing Platform runner "${NAME}" (platform 127.0.0.1:${PLATFORM_PORT}).`);
    expect(out).toContain(`ok        Settings: platform 127.0.0.1:${PLATFORM_PORT}, runner name "${NAME}", token kept in this computer's credential store (not shown)`);
    expect(out).toMatch(/ok {8}Runner files match this download \(version \d+\.\d+\.\d+\+[0-9a-f]{10}\)/);
    expect(out).toMatch(/ok {8}Test tools are installed \(Playwright \d/);
    expect(out).toMatch(/ok {8}Web tests will use /);
    expect(out).toContain(`ok        The platform at 127.0.0.1:${PLATFORM_PORT} answers (plain http, on this computer or a private network)`);
    expect(out).toContain("ok        The platform accepts this runner's token; the token is not shown");
    expect(out).toContain("ok        The clock agrees with the platform's");
    expect(out).toMatch(/Everything the runner needs is here\./);
    expect(out).not.toContain(token);
}

describe.skipIf(!win || !COMPANY)("check-computer in a real download", () => {
    it("check-computer.cmd (cmd.exe) finds Node.js like the start script, checks everything and never prints the token", async () => {
        const r = await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", ".\\check-computer.cmd"], kit, nodeDirFirst(cleanEnv()));
        expect(r.out).toMatch(/Using Node\.js v\d+\.\d+\.\d+ from /);
        expectGoodCheck(r.out);
        expect(r.code).toBe(0);
        // It installed nothing and started no runner: Settings shows the runner as never connected.
        expect((await admin("GET", "/api/me/runner")).body.runner).toMatchObject({ status: "offline", lastSeenAt: null });
    }, 120_000);

    it.skipIf(!BASH)("check-computer.sh under Git Bash does the same", async () => {
        const r = await run(BASH!, ["check-computer.sh"], kit, nodeDirFirst(cleanEnv()));
        expectGoodCheck(r.out);
        expect(r.code).toBe(0);
    }, 120_000);

    it("the real runner sends its check with its hello, and Settings shows it without a path or the credential", async () => {
        const child = spawn(process.execPath, ["runner.mjs"], { cwd: kit, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        started.push(child);
        let out = "";
        child.stdout!.on("data", (d) => (out += d));
        child.stderr!.on("data", (d) => (out += d));
        try {
            const until = Date.now() + 90_000;
            type Check = { at: string; items: Array<{ id: string; status: string; title: string }> };
            let check: Check | undefined;
            while (!check) {
                if (Date.now() > until) throw new Error(`no check reported. Runner output:\n${out}`);
                const mine = (await admin("GET", "/api/me/runner")).body.runner as { check?: Check } | null;
                check = mine?.check?.items.some((i) => i.id === "clock") ? mine.check : undefined;
                if (!check) await new Promise((r) => setTimeout(r, 300));
            }
            const ids = check.items.map((i) => i.id);
            for (const id of ["node", "files", "tools", "browser", "engines", "network", "disk", "clock", "phone"]) expect(ids).toContain(id);
            for (const id of ["node", "files", "tools", "disk", "clock"]) expect(check.items.find((i) => i.id === id)!.status, id).toBe("ok");
            const text = JSON.stringify(check);
            expect(text).not.toContain(token);
            expect(text).not.toContain(tmp);
            expect(text).not.toContain(tmp.replaceAll("\\", "\\\\"));
        } finally {
            child.kill();
            await new Promise((r) => (child.exitCode !== null ? r(undefined) : child.once("exit", r)));
        }
    }, 120_000);

    it("the platform unreachable: a plain sentence, the token not checked, exit 1", async () => {
        const dead = copyKit("dead kit", { url: `http://127.0.0.1:${CLOSED_PORT}` });
        const r = await run(process.execPath, ["runner.mjs", "--check"], dead, cleanEnv());
        expect(r.code).toBe(1);
        expect(r.out).toContain(`missing   Could not reach 127.0.0.1:${CLOSED_PORT}: the connection was refused`);
        expect(r.out).toContain("optional  The token was not checked, because the platform could not be reached");
        expect(r.out).not.toContain(token);
    }, 60_000);

    it("through a proxy with a password to a platform behind a company certificate: untrusted until runner.json names the certificate; the password is never printed", async () => {
        const secure = copyKit("secure kit", { url: `https://platform.test:${FRONT_PORT}` }, { "runner.token": `${STUB_TOKEN}\n` });
        const env = cleanEnv({ HTTPS_PROXY: `http://${USER}:${PASSWORD}@127.0.0.1:${PROXY_PORT}`, AITP_SYSTEM_CA: "0" });
        const before = await run(process.execPath, ["runner.mjs", "--check"], secure, env);
        expect(before.code).toBe(1);
        expect(before.out).toContain(`ok        Network: connects through the proxy http://${USER}:***@127.0.0.1:${PROXY_PORT}, from HTTPS_PROXY / HTTP_PROXY;`);
        expect(before.out).toMatch(/missing {3}Could not reach platform\.test:8804: the platform's certificate was not accepted \((SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)\)/);
        expect(before.out).toMatch(/To fix: .*--ca-file/);
        fs.copyFileSync(CA, path.join(secure, "company-root.pem"));
        const cfg = JSON.parse(fs.readFileSync(path.join(secure, "runner.json"), "utf8"));
        fs.writeFileSync(path.join(secure, "runner.json"), JSON.stringify({ ...cfg, caFile: "company-root.pem" }));
        const after = await run(process.execPath, ["runner.mjs", "--check"], secure, env);
        expect(after.out).toContain("company-root.pem (1 certificate)");
        expect(after.out).toContain(`ok        The platform at platform.test:${FRONT_PORT} answers, and its certificate is trusted`);
        expect(after.out).toContain(`ok        The platform accepts this runner's token (project "Proxy shop")`);
        // platform.test exists only behind the proxy: the check went through it, signed in.
        expect(proxy.hits.some((h) => h.method === "CONNECT" && h.target === `platform.test:${FRONT_PORT}` && h.auth === `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`)).toBe(true);
        for (const o of [before.out, after.out]) {
            expect(o).not.toContain(PASSWORD);
            expect(o).not.toContain(STUB_TOKEN);
        }
    }, 120_000);

    it("the computer removed in Settings: the check says so plainly, exit 1", async () => {
        expect((await admin("POST", "/api/me/runner/retire")).status).toBe(200);
        const r = await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", ".\\check-computer.cmd"], kit, nodeDirFirst(cleanEnv()));
        expect(r.code).toBe(1);
        expect(r.out).toContain("missing   The platform does not accept this runner's credential: it was removed, or another computer was set up in its place");
        expect(r.out).not.toContain(token);
    }, 120_000);
});
