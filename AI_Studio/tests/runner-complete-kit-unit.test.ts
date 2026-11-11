/**
 * The complete runner download (its own Node.js and every package), without a browser and without the internet:
 *   - the build, against a local stand-in for nodejs.org (tiny fake Node.js archives: a .zip for Windows, .tar.gz for Mac and Linux with
 *     folders, a symbolic link, a GNU long name and a pax record), real SHA-256 checking against SHASUMS256.txt, the cache, a damaged
 *     archive refused and deleted, and the package rules (native code, os/cpu limits, install scripts, optional packages) on a small
 *     stand-in node_modules; plus the same rules run over this checkout's REAL node_modules for every target (nothing copied);
 *   - the route (server.inject, POST /api/me/runner/download, round 45): a system's one download carries its own Node.js whenever that
 *     target is built here (entries, Unix modes, content-length, headers, the code only in runner.enroll, no secrets or server paths), with
 *     the installer inside when the server has it; a target that was not built, or a stale or damaged build, falls back to the download
 *     without its own Node.js; the info answer says which systems carry it and how large they are;
 *   - the start scripts: the served zip unpacked with Windows' own tar.exe, start-runner.cmd run under cmd.exe and start-runner.sh under
 *     Git Bash with NO Node.js and no npm on the PATH: they use the Node.js inside the download, skip npm install and start the runner
 *     (a stand-in runner.mjs that says which Node.js runs it). A bundled Node.js that does not start falls back to the search; a complete
 *     download without its node_modules says it is incomplete.
 *
 * The fake archives' `node` is not a real Node.js, so for the start-script runs the unpacked node/node.exe is replaced by a hard link to
 * this computer's node.exe (Windows) and node/bin/node by a two-line shim that runs it (Git Bash), the way the existing kit tests stand in
 * a Node.js. Port: 6910 (the stand-in nodejs.org).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { START_CMD, START_SH } from "../src/platform/runner-kit-scripts.js";
import { buildServer } from "../src/platform/server.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { writeManifest } from "../scripts/build-installer.mjs";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { allows, buildComplete, distBase, packageClosure, parseTargets, readTarGzEntries, TARGET_NAMES } from "../scripts/build-runner-complete.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 6910;
const DIST = `http://127.0.0.1:${PORT}`;
const VERSION = "24.19.0";
const API_KEY = "complete-kit-admin-key-5d1e93";
const SENTINELS = { ANTHROPIC_API_KEY: "CMPLLEAK-anthropic-6b2d90e1", SECRET_BOX_KEY: "CMPLLEAK-box-1f7a3c55", OPENAI_API_KEY: "CMPLLEAK-openai-9e04c7b2" };
const ENV_KEYS = ["RUNNER_KIT_DIR", "RUNNER_INSTALLER_DIR", "RUNNER_COMPLETE_DIR", "RUNNER_KIT_RATE_PER_MINUTE", "AITP_NODE_DIST_URL", ...Object.keys(SENTINELS)];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let tmp: string;
let bundleDir: string;
let modRoot: string;
let completeOut: string;
let cacheDir: string;
let kitPkg: { dependencies: Record<string, string>; optionalDependencies: Record<string, string> };
let fixture: http.Server;
const served: string[] = [];
/** File name -> bytes the stand-in nodejs.org serves; `damaged` names get other bytes than SHASUMS256.txt promises. */
const archives = new Map<string, Buffer>();
const damaged = new Set<string>();
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const log: string[] = [];

// ── fake Node.js archives ───────────────────────────────────────────────────

function tarHeader(name: string, size: number, type: string, mode: number, linkname = ""): Buffer {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, "utf8");
    h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "latin1");
    h.write("0000000\0", 108, "latin1");
    h.write("0000000\0", 116, "latin1");
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    h.write("00000000000\0", 136, "latin1");
    h.write("        ", 148, "latin1");
    h.write(type, 156, "latin1");
    if (linkname) h.write(linkname, 157, "latin1");
    h.write("ustar\0", 257, "latin1");
    h.write("00", 263, "latin1");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    return h;
}
const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);
function tarFile(name: string, body: Buffer, mode = 0o644, type = "0"): Buffer {
    return Buffer.concat([tarHeader(name, body.length, type, mode), body, pad(body.length)]);
}

/** What nodejs.org's tarball looks like, in miniature: folders, bin/node, an npm link, LICENSE, a long name and a pax record. */
function fakeTarGz(top: string): Buffer {
    const nodeScript = Buffer.from(`#!/bin/sh\necho v${VERSION}\n`);
    const longName = `${top}/include/node/${"deeply-nested-header-".repeat(6)}.h`;
    const paxBody = Buffer.from(`30 path=${top}/share/doc/pax-named.md\n`);
    const parts = [
        tarHeader(`${top}/`, 0, "5", 0o755),
        tarHeader(`${top}/bin/`, 0, "5", 0o755),
        tarFile(`${top}/bin/node`, nodeScript, 0o755),
        tarHeader(`${top}/bin/npm`, 0, "2", 0o777, "../lib/node_modules/npm/bin/npm-cli.js"),
        tarFile(`${top}/lib/node_modules/npm/package.json`, Buffer.from('{"name":"npm"}')),
        // GNU long name: an "L" record holds the name of the next entry.
        tarFile("././@LongLink", Buffer.from(`${longName}\0`), 0o644, "L"),
        tarFile(longName.slice(0, 100), Buffer.from("/* header */\n")),
        tarFile("PaxHeader", paxBody, 0o644, "x"),
        tarFile("short-name-replaced-by-pax", Buffer.from("# pax\n")),
        tarFile(`${top}/LICENSE`, Buffer.from("Node.js is licensed for use as follows: MIT (stand-in)\n")),
        tarFile(`${top}/README.md`, Buffer.from("readme\n")),
        Buffer.alloc(1024),
    ];
    return zlib.gzipSync(Buffer.concat(parts));
}

function fakeZip(top: string): Buffer {
    return Buffer.from(
        zipSync({
            [`${top}/node.exe`]: new TextEncoder().encode("stand-in node.exe, not a real program"),
            [`${top}/LICENSE`]: new TextEncoder().encode("Node.js is licensed for use as follows: MIT (stand-in)\n"),
            [`${top}/npm.cmd`]: new TextEncoder().encode("@echo off\n"),
            [`${top}/node_modules/npm/package.json`]: new TextEncoder().encode('{"name":"npm"}'),
        }),
    );
}

function addArchives(): void {
    for (const t of ["win-x64", "win-arm64"]) archives.set(`node-v${VERSION}-${t}.zip`, fakeZip(`node-v${VERSION}-${t}`));
    for (const t of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) archives.set(`node-v${VERSION}-${t}.tar.gz`, fakeTarGz(`node-v${VERSION}-${t}`));
}

const shasums = () => [...archives].map(([name, bytes]) => `${sha(bytes)}  ${name}`).join("\n") + "\n";

// ── a stand-in node_modules at the versions the real kit pins ───────────────

function pkg(dir: string, json: Record<string, unknown>, files: Record<string, string> = {}): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(json));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
    }
}

function writeModules(root: string): void {
    const nm = path.join(root, "node_modules");
    const v = { ...kitPkg.dependencies, ...kitPkg.optionalDependencies };
    pkg(path.join(nm, "@playwright", "test"), { name: "@playwright/test", version: v["@playwright/test"], dependencies: { playwright: v.playwright } }, { "index.js": "module.exports = {};\n" });
    // A Mac-only optional dependency, like fsevents: kept for Macs, left out elsewhere.
    pkg(path.join(nm, "playwright"), { name: "playwright", version: v.playwright, dependencies: { "playwright-core": v["playwright-core"] }, optionalDependencies: { "mac-watcher": "1.0.0" } }, { "index.js": "\n" });
    pkg(path.join(nm, "mac-watcher"), { name: "mac-watcher", version: "1.0.0", os: ["darwin"] }, { "index.js": "\n" });
    pkg(path.join(nm, "playwright-core"), { name: "playwright-core", version: v["playwright-core"], bin: { "playwright-core": "cli.js" } }, { "cli.js": "#!/usr/bin/env node\n", "browsers.json": "{}" });
    pkg(path.join(nm, "typescript"), { name: "typescript", version: v.typescript }, { "lib/typescript.js": "\n" });
    pkg(path.join(nm, "@axe-core", "playwright"), { name: "@axe-core/playwright", version: v["@axe-core/playwright"], dependencies: { "axe-core": "~4.13.0" }, peerDependencies: { "playwright-core": ">= 1.0.0" } }, { "dist/index.js": "\n" });
    pkg(path.join(nm, "axe-core"), { name: "axe-core", version: "4.13.0" }, { "axe.js": "\n" });
    // Taqwright with a nested dependency of its own version, as npm lays it out.
    pkg(path.join(nm, "@taqwright", "taqwright"), { name: "@taqwright/taqwright", version: v["@taqwright/taqwright"], dependencies: { undici: "^8.0.0", "@playwright/test": "^1.60.0" } }, { "dist/index.js": "\n" });
    pkg(path.join(nm, "@taqwright", "taqwright", "node_modules", "undici"), { name: "undici", version: "8.1.0" }, { "index.js": "\n" });
    // Something nothing needs: never copied.
    pkg(path.join(nm, "vite"), { name: "vite", version: "7.0.0" }, { "bin/esbuild.exe": "MZ" });
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** The person downloading: an owner with their own API token (made in beforeAll). */
let bearer = "";
const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await server.inject({ method, url, headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    const buf = res.rawPayload;
    const text = buf.toString("utf8");
    return { status: res.statusCode, headers: res.headers, buf, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; headers: Record<string, string>; buf: Buffer; text: string; body: any };
};
/** The one download of a system (round 45): it carries its own Node.js whenever this server built that target. */
const complete = (osName: "windows" | "mac" | "linux", arch: string) => call("POST", "/api/me/runner/download", { os: osName, arch });
const systemOf = (info: { systems: Array<{ os: string; arch: string }> }, osName: string, arch: string) => info.systems.find((x) => x.os === osName && x.arch === arch) as unknown as { kind: string; ownNode: boolean; bytes?: number; note?: string; available: boolean };

/** What `npm run build:installer` writes, in miniature: a stand-in Windows program and Mac app, with a manifest. */
function writeInstallerStandIns(dir: string): void {
    const put = (rel: string, body: string, mode: number) => {
        const f = path.join(dir, ...rel.split("/"));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, body);
        return { path: rel.replace(/^mac\//, ""), mode, sha256: createHash("sha256").update(Buffer.from(body)).digest("hex") };
    };
    put("win/AITestingRunnerSetup.exe", "MZ stand-in program\n", 0o755);
    const app = "AI Testing Runner.app";
    const entries = [put(`mac/${app}/Contents/Info.plist`, "<plist/>\n", 0o644), put(`mac/${app}/Contents/MacOS/AITestingRunner`, "#!/bin/sh\nexit 0\n", 0o755), put(`mac/${app}/Contents/Resources/runner-setup.sh`, "#!/bin/sh\nexit 0\n", 0o755)];
    fs.writeFileSync(path.join(dir, "mac", "manifest-part.json"), JSON.stringify({ version: 1, entries }));
    writeManifest({ outDir: dir, platformVersion: "1.0.0" });
}

function modes(zip: Uint8Array): Record<string, { mode: number; unix: boolean }> {
    const b = Buffer.from(zip);
    const out: Record<string, { mode: number; unix: boolean }> = {};
    // The central directory starts where the end record says (scanning the whole zip would find signatures inside compressed data).
    let eocd = b.length - 22;
    while (eocd > 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    let p = b.readUInt32LE(eocd + 16);
    const count = b.readUInt16LE(eocd + 10);
    for (let n = 0; n < count; n++) {
        const nameLen = b.readUInt16LE(p + 28);
        const extra = b.readUInt16LE(p + 30);
        const comment = b.readUInt16LE(p + 32);
        out[b.subarray(p + 46, p + 46 + nameLen).toString("utf8")] = { mode: (b.readUInt32LE(p + 38) >>> 16) & 0o7777, unix: b.readUInt16LE(p + 4) >> 8 === 3 };
        p += 46 + nameLen + extra + comment;
    }
    return out;
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
const SYSTEM_TAR = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
const fwd = (p: string) => p.replaceAll("\\", "/");
/** C:\x\y -> /c/x/y for Git Bash. */
const msys = (p: string) => (process.platform === "win32" ? fwd(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`) : p);

/** A PATH with no Node.js and no npm on it (the system folders only), so a script that needed them would fail. */
function pathWithoutNode(): string {
    if (process.platform !== "win32") return "/usr/bin:/bin";
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    return [path.join(sys, "System32"), sys, path.join(sys, "System32", "Wbem"), path.join(sys, "System32", "WindowsPowerShell", "v1.0")].join(";");
}
/** For Git Bash: its own tools plus the system folders, still without Node.js. */
function bashPathWithoutNode(): string {
    return ["/usr/bin", "/bin", msys(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"))].join(":");
}

const STAND_IN_RUNNER = `console.log("RUNNER-STAND-IN execPath=" + process.execPath + " version=" + process.version + " args=" + process.argv.slice(2).join(" "));\n`;

function unpackWithSystemTar(zip: Buffer, label: string): string {
    const dir = fs.mkdtempSync(path.join(tmp, `${label}-`));
    const file = path.join(dir, "download.zip");
    fs.writeFileSync(file, zip);
    const r = spawnSync(SYSTEM_TAR, ["-xf", "download.zip"], { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    expect(r.status, `${SYSTEM_TAR}: ${r.stderr}`).toBe(0);
    fs.rmSync(file);
    const top = fs.readdirSync(dir).find((n) => fs.statSync(path.join(dir, n)).isDirectory())!;
    return path.join(dir, top);
}

function unpackWithFflate(zip: Buffer, label: string): string {
    const dir = fs.mkdtempSync(path.join(tmp, `${label}-`));
    let top = "";
    const m = modes(new Uint8Array(zip));
    for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(zip)))) {
        top = name.split("/")[0]!;
        const dest = path.join(dir, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes, { mode: m[name]?.mode ?? 0o644 });
    }
    return path.join(dir, top);
}

function run(command: string, args: string[], cwd: string, env: Record<string, string>): { code: number | null; out: string } {
    const r = spawnSync(command, args, { cwd, env: { SystemRoot: process.env.SystemRoot ?? "", SYSTEMROOT: process.env.SystemRoot ?? "", ComSpec: process.env.ComSpec ?? "", PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", TEMP: tmp, TMP: tmp, ...env } as NodeJS.ProcessEnv, encoding: "utf8", windowsHide: true, timeout: 90_000 });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ── setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
    for (const [k, v] of Object.entries(SENTINELS)) process.env[k] = v;
    // Several downloads by one person here.
    process.env.RUNNER_KIT_RATE_PER_MINUTE = "100";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-complete-"));
    // No installer built here, unless a test points at the stand-ins: the download is then the start scripts with their own Node.js.
    process.env.RUNNER_INSTALLER_DIR = path.join(tmp, "no-installer");
    bundleDir = path.join(tmp, "dist-runner");
    await buildRunner({ outDir: bundleDir });
    kitPkg = JSON.parse(fs.readFileSync(path.join(bundleDir, "package.json"), "utf8"));
    modRoot = path.join(tmp, "checkout");
    writeModules(modRoot);
    completeOut = path.join(tmp, "dist-runner-complete");
    cacheDir = path.join(tmp, "runner-cache");
    addArchives();
    fixture = http.createServer((req, res) => {
        served.push(req.url ?? "");
        const name = (req.url ?? "").replace(`/v${VERSION}/`, "");
        if (req.url === `/v${VERSION}/SHASUMS256.txt`) return void res.writeHead(200, { "content-type": "text/plain" }).end(shasums());
        const bytes = archives.get(name);
        if (!bytes) return void res.writeHead(404).end("not found");
        const body = damaged.has(name) ? Buffer.concat([bytes.subarray(0, bytes.length - 8), Buffer.from("DAMAGED!")]) : bytes;
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) }).end(body);
    });
    await new Promise<void>((r) => fixture.listen(PORT, "127.0.0.1", () => r()));
    process.env.RUNNER_KIT_DIR = bundleDir;
    process.env.RUNNER_COMPLETE_DIR = completeOut;
    const dataDir = path.join(tmp, "data");
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: "6911", PUBLIC_URL: "https://tests.example.com", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.ready();
    const users = accessControlOf(server).users;
    const maya = users.create({ email: "maya@people.example", name: "Maya", role: "owner" });
    bearer = users.createToken(maya.id, { name: "complete test", role: "owner" }).token;
}, 180_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await server?.close();
    platform?.db.close();
    await new Promise<void>((r) => (fixture ? fixture.close(() => r()) : r()));
    fs.rmSync(tmp, { recursive: true, force: true });
});

const build = (targets: string[], extra: Record<string, unknown> = {}) =>
    buildComplete({ root: ROOT, bundleDir, outDir: completeOut, cacheDir, targets, modulesRoot: modRoot, env: { AITP_NODE_DIST_URL: DIST }, version: VERSION, log: (l: string) => log.push(l), ...extra });
const readManifest = (target: string) => JSON.parse(fs.readFileSync(path.join(completeOut, target, "manifest.json"), "utf8"));

// ── the build ───────────────────────────────────────────────────────────────

describe("building the complete downloads", () => {
    it("fetches each pinned Node.js once, checks it against SHASUMS256.txt, and keeps only node and its licence", async () => {
        served.length = 0;
        const results = await build(["win-x64", "linux-x64", "mac-arm64"]);
        expect(results.map((r: { target: string }) => r.target)).toEqual(["win-x64", "linux-x64", "mac-arm64"]);
        expect(served).toEqual([`/v${VERSION}/SHASUMS256.txt`, `/v${VERSION}/node-v${VERSION}-win-x64.zip`, `/v${VERSION}/node-v${VERSION}-linux-x64.tar.gz`, `/v${VERSION}/node-v${VERSION}-darwin-arm64.tar.gz`]);
        const win = readManifest("win-x64");
        const names = win.files.map((f: { path: string }) => f.path);
        expect(names).toContain("node/node.exe");
        expect(names).toContain("node/LICENSE");
        expect(names.some((n: string) => /npm/.test(n))).toBe(false);
        expect(win.files.find((f: { path: string }) => f.path === "node/node.exe").mode).toBe(0o755);
        expect(win.nodeVersion).toBe(`v${VERSION}`);
        expect(win.packageJsonSha256).toBe(sha(fs.readFileSync(path.join(bundleDir, "package.json"))));
        // The pack is every file's compressed bytes end to end, and its checksum is recorded.
        expect(win.packBytes).toBe(fs.statSync(path.join(completeOut, "win-x64", "pack.bin")).size);
        expect(win.packSha256).toBe(sha(fs.readFileSync(path.join(completeOut, "win-x64", "pack.bin"))));
        const linux = readManifest("linux-x64");
        const node = linux.files.find((f: { path: string }) => f.path === "node/bin/node");
        expect(node.mode).toBe(0o755);
        expect(linux.files.map((f: { path: string }) => f.path).filter((n: string) => n.startsWith("node/")).sort()).toEqual(["node/LICENSE", "node/bin/node"]);
        // The stand-in tarball's long-named and pax-named entries were walked past, not mistaken for node.
        const stream = await readTarGzEntries(path.join(cacheDir, `node-v${VERSION}`, `node-v${VERSION}-linux-x64.tar.gz`), new Map([[`node-v${VERSION}-linux-x64/include/node/${"deeply-nested-header-".repeat(6)}.h`, "long"], [`node-v${VERSION}-linux-x64/share/doc/pax-named.md`, "pax"]]));
        expect(Buffer.from(stream.get("long").data).toString()).toBe("/* header */\n");
        expect(Buffer.from(stream.get("pax").data).toString()).toBe("# pax\n");
    });

    it("copies every pinned package and what it needs, and nothing else; a Mac-only optional part only into the Mac downloads", () => {
        const win = readManifest("win-x64");
        const mac = readManifest("mac-arm64");
        const pkgs = (m: { files: Array<{ path: string }> }) => [...new Set(m.files.map((f) => f.path).filter((p) => p.startsWith("node_modules/") && p.endsWith("/package.json")).map((p) => p.slice(0, -"/package.json".length)))].sort();
        expect(pkgs(win)).toEqual(
            [
                "node_modules/@axe-core/playwright",
                "node_modules/@playwright/test",
                "node_modules/@taqwright/taqwright",
                "node_modules/@taqwright/taqwright/node_modules/undici",
                "node_modules/axe-core",
                "node_modules/playwright",
                "node_modules/playwright-core",
                "node_modules/typescript",
            ].sort(),
        );
        expect(pkgs(mac)).toContain("node_modules/mac-watcher");
        expect(win.notes.join(" ")).toMatch(/Left out mac-watcher, an optional part of playwright: mac-watcher 1\.0\.0 is only for darwin/);
        expect(win.packages).toEqual({ ...kitPkg.dependencies, ...kitPkg.optionalDependencies });
        expect(win.files.find((f: { path: string }) => f.path === "node_modules/playwright-core/cli.js").mode).toBe(0o755);
        const info = JSON.parse(zlib.inflateRawSync(fs.readFileSync(path.join(completeOut, "win-x64", "pack.bin")).subarray(...range(win, "complete-kit.json"))).toString());
        expect(info).toMatchObject({ format: 1, target: "win-x64", nodeVersion: `v${VERSION}`, nodeModulesComplete: true });
        expect(win.files.map((f: { path: string }) => f.path)).toContain("node_modules/.aitp-complete");
    });

    it("uses the cache the second time (only the checksum list is fetched) and checks the cached copy again", async () => {
        served.length = 0;
        await build(["win-x64"]);
        expect(served).toEqual([`/v${VERSION}/SHASUMS256.txt`]);
        // A cached file that no longer matches is fetched again.
        const cached = path.join(cacheDir, `node-v${VERSION}`, `node-v${VERSION}-win-x64.zip`);
        fs.appendFileSync(cached, "x");
        served.length = 0;
        await build(["win-x64"]);
        expect(served).toEqual([`/v${VERSION}/SHASUMS256.txt`, `/v${VERSION}/node-v${VERSION}-win-x64.zip`]);
    });

    it("refuses a download that does not match its published checksum, deletes it and keeps the earlier build", async () => {
        const name = `node-v${VERSION}-linux-arm64.tar.gz`;
        damaged.add(name);
        try {
            await expect(build(["linux-arm64"])).rejects.toThrow(/does not match the checksum nodejs\.org publishes in SHASUMS256\.txt, so it was deleted and not used/);
            expect(fs.existsSync(path.join(cacheDir, `node-v${VERSION}`, name))).toBe(false);
            expect(fs.existsSync(path.join(cacheDir, `node-v${VERSION}`, `${name}.part`))).toBe(false);
            expect(fs.existsSync(path.join(completeOut, "linux-arm64"))).toBe(false);
        } finally {
            damaged.delete(name);
        }
    });

    it("downloads only over https, except from this computer, and knows its targets", () => {
        expect(() => distBase({ AITP_NODE_DIST_URL: "http://mirror.example.com/dist" })).toThrow(/only downloaded over https/);
        expect(distBase({ AITP_NODE_DIST_URL: "http://127.0.0.1:1/dist/" })).toBe("http://127.0.0.1:1/dist");
        expect(distBase({})).toBe("https://nodejs.org/dist");
        expect(parseTargets(undefined)).toEqual(TARGET_NAMES);
        expect(parseTargets("none")).toEqual([]);
        expect(parseTargets("mac-arm64,win-x64,mac-arm64")).toEqual(["mac-arm64", "win-x64"]);
        expect(() => parseTargets("win-x86")).toThrow(/Unknown target win-x86/);
        expect(TARGET_NAMES).toEqual(["win-x64", "win-arm64", "mac-arm64", "mac-x64", "linux-x64", "linux-arm64"]);
        expect(allows(["darwin"], "darwin")).toBe(true);
        expect(allows(["!win32"], "win32")).toBe(false);
        expect(allows(["!win32"], "linux")).toBe(true);
        expect(allows(undefined, "linux")).toBe(true);
    });

    it("stops on a needed package with native code or an unknown install script, and leaves out an optional one with a note", () => {
        const root = path.join(tmp, "native-checkout");
        fs.cpSync(modRoot, root, { recursive: true });
        // Optional Taqwright needs something with a compiled addon: Taqwright is left out, the rest is fine.
        pkg(path.join(root, "node_modules", "@taqwright", "taqwright", "node_modules", "undici"), { name: "undici", version: "8.1.0" }, { "build/Release/addon.node": "ELF" });
        const r = packageClosure({ root, required: Object.keys(kitPkg.dependencies), optional: Object.keys(kitPkg.optionalDependencies), target: "linux-x64" });
        expect(r.leftOut.map((l: { name: string }) => l.name)).toEqual(["@taqwright/taqwright"]);
        expect(r.notes.join(" ")).toMatch(/Left out @taqwright\/taqwright \(optional\): undici 8\.1\.0 contains native code built for one kind of computer\. Web and API tests are not affected\./);
        // A needed package with an install script the build does not know: stop, and say which and through what.
        pkg(path.join(root, "node_modules", "axe-core"), { name: "axe-core", version: "4.13.0", scripts: { postinstall: "node fetch-things.js" } }, { "axe.js": "\n" });
        expect(() => packageClosure({ root, required: Object.keys(kitPkg.dependencies), optional: [], target: "linux-x64" })).toThrow(
            /cannot include @axe-core\/playwright: axe-core 4\.13\.0 has an install script, which a complete download cannot run \(through @axe-core\/playwright\)/,
        );
    });

    it("runs the same package rules over this checkout's real node_modules for every target: everything the runner pins can be shipped", () => {
        const real = JSON.parse(fs.readFileSync(path.join(bundleDir, "package.json"), "utf8"));
        for (const target of TARGET_NAMES) {
            const r = packageClosure({ root: ROOT, required: Object.keys(real.dependencies), optional: Object.keys(real.optionalDependencies ?? {}), target });
            expect(r.leftOut, target).toEqual([]);
            const names = [...r.packages.values()].map((p: { name: string }) => p.name);
            for (const n of Object.keys(real.dependencies)) expect(names, `${target} ${n}`).toContain(n);
            // No native addon anywhere in what would be shipped.
            for (const p of r.packages.values() as Iterable<{ name: string; native: boolean }>) expect(p.native, `${target} ${p.name}`).toBe(false);
        }
    });
});

function range(m: { files: Array<{ path: string; offset: number; csize: number }> }, name: string): [number, number] {
    const f = m.files.find((x) => x.path === name)!;
    return [f.offset, f.offset + f.csize];
}

// ── the route ───────────────────────────────────────────────────────────────

describe("the download route", () => {
    it("info says, per system and processor, which downloads carry their own Node.js and about how large they are", async () => {
        const info = (await call("GET", "/api/me/runner/download/info")).body;
        expect(info.available).toBe(true);
        expect(info.systems.map((x: { os: string; arch: string }) => `${x.os}-${x.arch}`)).toEqual(["windows-x64", "windows-arm64", "mac-x64", "mac-arm64", "linux-x64", "linux-arm64"]);
        const win = systemOf(info, "windows", "x64");
        expect(win).toMatchObject({ ownNode: true, kind: "files", available: true });
        expect(win.bytes).toBeGreaterThan(readManifest("win-x64").packBytes);
        // Not built for this processor: the download is still there, without its own Node.js.
        expect(systemOf(info, "windows", "arm64")).toMatchObject({ ownNode: false, available: true });
        expect(systemOf(info, "windows", "arm64").bytes).toBeUndefined();
    });

    it("streams the Windows download with its own Node.js, every package, the runner, the start scripts, with the right modes and length", async () => {
        const r = await complete("windows", "x64");
        expect(r.status, r.text).toBe(200);
        expect(r.headers["content-type"]).toBe("application/zip");
        expect(r.headers["content-disposition"]).toBe('attachment; filename="runner-my-computer-win-x64.zip"');
        // No installer on this server: the plain files, and the answer says why.
        expect(r.headers["x-runner-kit-kind"]).toBe("files");
        expect(r.headers["x-runner-kit-note"]).toMatch(/Windows installer has not been built/);
        expect(r.headers["x-runner-kit-target"]).toBe("win-x64");
        expect(r.headers["cache-control"]).toBe("no-store");
        expect(Number(r.headers["content-length"])).toBe(r.buf.length);
        const z = unzipSync(new Uint8Array(r.buf));
        const dir = "runner-my-computer-win-x64";
        for (const n of ["node/node.exe", "node/LICENSE", "node_modules/.aitp-complete", "node_modules/@playwright/test/package.json", "complete-kit.json", "runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt", "runner.json", "runner.enroll", "start-runner.cmd", "start-runner.sh", "start-runner.command", "README.txt"]) {
            expect(z[`${dir}/${n}`], n).toBeDefined();
        }
        expect(Object.keys(z).every((k) => k.startsWith(`${dir}/`))).toBe(true);
        // Exactly the bytes the build packed (fflate checks every CRC while unzipping, too).
        expect(Buffer.from(z[`${dir}/node/node.exe`]!).toString()).toBe("stand-in node.exe, not a real program");
        const m = modes(new Uint8Array(r.buf));
        expect(m[`${dir}/node/node.exe`]).toEqual({ mode: 0o755, unix: true });
        expect(m[`${dir}/runner.enroll`]!.mode).toBe(0o600);
        expect(m[`${dir}/start-runner.sh`]!.mode).toBe(0o755);
        expect(m[`${dir}/start-runner.cmd`]!.mode).toBe(0o755);
        expect(m[`${dir}/runner.mjs`]!.mode).toBe(0o644);
        const cfg = JSON.parse(Buffer.from(z[`${dir}/runner.json`]!).toString());
        expect(Object.keys(cfg).sort()).toEqual(["kitVersion", "url"]);
        expect(cfg.url).toBe("https://tests.example.com");
        const readme = Buffer.from(z[`${dir}/README.txt`]!).toString();
        expect(readme).toContain("\r\n");
        for (const needle of ["Download: complete, for Windows on an Intel or AMD processor (win-x64)", "Nothing is installed: this download already holds Node.js and the test tools.", `Node.js v${VERSION} in the node folder`, "start-runner.cmd", "Google Chrome or Microsoft Edge", "Settings, Your runner"]) expect(readme, needle).toContain(needle);
        expect(readme).not.toMatch(/You need Node\.js 24 or newer/);
        // The bundle is the same prebuilt one as the plain kit.
        expect(Buffer.from(z[`${dir}/runner.mjs`]!).equals(fs.readFileSync(path.join(bundleDir, "runner.mjs")))).toBe(true);
    });

    it("puts the installer inside when the server has it: Windows leads with the setup program, the start scripts stay as the way without installing", async () => {
        const saved = process.env.RUNNER_INSTALLER_DIR;
        const inst = path.join(tmp, "installer-stand-ins");
        if (!fs.existsSync(inst)) writeInstallerStandIns(inst);
        process.env.RUNNER_INSTALLER_DIR = inst;
        try {
            const r = await complete("windows", "x64");
            expect(r.status, r.text).toBe(200);
            expect(r.headers["x-runner-kit-kind"]).toBe("installer");
            expect(r.headers["x-runner-kit-note"]).toBeUndefined();
            expect(r.headers["x-runner-kit-target"]).toBe("win-x64");
            const z = unzipSync(new Uint8Array(r.buf));
            const dir = "runner-my-computer-win-x64";
            for (const n of ["AITestingRunnerSetup.exe", "node/node.exe", "node_modules/.aitp-complete", "start-runner.cmd", "runner.enroll"]) expect(z[`${dir}/${n}`], n).toBeDefined();
            const readme = Buffer.from(z[`${dir}/README.txt`]!).toString();
            expect(readme.indexOf("Double-click AITestingRunnerSetup.exe")).toBeGreaterThan(-1);
            expect(readme.indexOf("AITestingRunnerSetup.exe")).toBeLessThan(readme.indexOf("start-runner.cmd"));
            expect(readme).toContain("Or, to run it without installing, double-click start-runner.cmd");
            const mac = await complete("mac", "arm64");
            expect(mac.headers["x-runner-kit-kind"]).toBe("installer");
            expect(Object.keys(unzipSync(new Uint8Array(mac.buf)))).toContain("runner-my-computer-mac-arm64/AI Testing Runner.app/Contents/MacOS/AITestingRunner");
            // Linux never gets an installer.
            const linux = await complete("linux", "x64");
            expect(linux.headers["x-runner-kit-kind"]).toBe("files");
            expect(linux.headers["x-runner-kit-target"]).toBe("linux-x64");
        } finally {
            process.env.RUNNER_INSTALLER_DIR = saved;
        }
    });

    it("streams Linux and Mac downloads with node/bin/node executable, chosen by os and arch", async () => {
        const linux = await complete("linux", "x64");
        expect(linux.status, linux.text).toBe(200);
        expect(linux.headers["content-disposition"]).toBe('attachment; filename="runner-my-computer-linux-x64.zip"');
        const lm = modes(new Uint8Array(linux.buf));
        expect(lm["runner-my-computer-linux-x64/node/bin/node"]).toEqual({ mode: 0o755, unix: true });
        const lz = unzipSync(new Uint8Array(linux.buf));
        expect(Buffer.from(lz["runner-my-computer-linux-x64/README.txt"]!).toString()).not.toContain("\r\n");
        const mac = await complete("mac", "arm64");
        expect(mac.status, mac.text).toBe(200);
        expect(mac.headers["x-runner-kit-target"]).toBe("mac-arm64");
        expect(Object.keys(unzipSync(new Uint8Array(mac.buf)))).toContain("runner-my-computer-mac-arm64/node_modules/mac-watcher/package.json");
    });

    it("a target that was not built gets the download without its own Node.js", async () => {
        const r = await complete("windows", "arm64");
        expect(r.status).toBe(200);
        expect(r.headers["x-runner-kit-target"]).toBeUndefined();
        expect(r.headers["x-runner-kit-kind"]).toBe("files");
        const names = Object.keys(unzipSync(new Uint8Array(r.buf)));
        expect(names.some((n) => n.includes("/node/"))).toBe(false);
        expect(names).toContain("runner-my-computer-windows/start-runner.cmd");
    });

    it("never hands out a build made for other test tool versions, or a damaged pack", async () => {
        const copy = path.join(tmp, "stale-complete");
        fs.cpSync(completeOut, copy, { recursive: true });
        const m = JSON.parse(fs.readFileSync(path.join(copy, "win-x64", "manifest.json"), "utf8"));
        fs.writeFileSync(path.join(copy, "win-x64", "manifest.json"), JSON.stringify({ ...m, packageJsonSha256: "0".repeat(64) }));
        const fd = fs.openSync(path.join(copy, "linux-x64", "pack.bin"), "r+");
        fs.writeSync(fd, Buffer.from("XX"), 0, 2, 10);
        fs.closeSync(fd);
        const saved = process.env.RUNNER_COMPLETE_DIR;
        process.env.RUNNER_COMPLETE_DIR = copy;
        try {
            for (const [osName, arch] of [["windows", "x64"], ["linux", "x64"]] as const) {
                const r = await complete(osName, arch);
                expect(r.status, `${osName} ${arch}`).toBe(200);
                expect(r.headers["x-runner-kit-target"], `${osName} ${arch}`).toBeUndefined();
            }
            const info = (await call("GET", "/api/me/runner/download/info")).body;
            expect(systemOf(info, "mac", "arm64").ownNode).toBe(true);
            expect(systemOf(info, "linux", "x64").ownNode).toBe(false);
            expect(systemOf(info, "windows", "x64").ownNode).toBe(false);
        } finally {
            process.env.RUNNER_COMPLETE_DIR = saved;
        }
    });

    it("never puts the server's secrets, paths or data in a download with its own Node.js; the single-use code is in runner.enroll only", async () => {
        const r = await complete("windows", "x64");
        const z = unzipSync(new Uint8Array(r.buf));
        const token = Buffer.from(z["runner-my-computer-win-x64/runner.enroll"]!).toString().trim();
        expect(token).toMatch(/^aite_/);
        const forbidden = [...Object.values(SENTINELS), API_KEY, bearer, "platform.db", tmp, fwd(tmp), ROOT, fwd(ROOT)];
        for (const [name, bytes] of Object.entries(z)) {
            const b = Buffer.from(bytes);
            if (!name.endsWith("runner.enroll")) expect(b.includes(token), name).toBe(false);
            expect(/aitg_[A-Za-z0-9_-]{20,}/.test(b.toString("latin1")), name).toBe(false);
            for (const f of forbidden) expect(b.includes(f), `${name} holds ${f.slice(0, 12)}`).toBe(false);
        }
    });
});

// ── the start scripts ───────────────────────────────────────────────────────

describe("the start scripts with a complete download", () => {
    it("no kit downloads a browser any more, and both scripts look for the Node.js inside the download first", () => {
        for (const s of [START_CMD, START_SH]) {
            expect(s).not.toMatch(/playwright install/);
            expect(s).not.toMatch(/chromium-installed/);
            expect(s).toContain("Using the Node.js that came with this download");
            expect(s).toContain("The test tools came with this download. Nothing to install.");
        }
        expect(START_CMD.indexOf('if not exist "node\\node.exe" goto nobundled')).toBeLessThan(START_CMD.indexOf("where node"));
        expect(START_SH.indexOf("node/bin/node")).toBeLessThan(START_SH.indexOf("find_node; then"));
    });

    it.skipIf(process.platform !== "win32" || !fs.existsSync(SYSTEM_TAR))("start-runner.cmd, unzipped with Windows' own tar, runs the runner with the Node.js inside, with no Node.js or npm on the PATH", async () => {
        const r = await complete("windows", "x64");
        const kit = unpackWithSystemTar(r.buf, "cmd");
        expect(fs.existsSync(path.join(kit, "node", "node.exe"))).toBe(true);
        // Stand in a real Node.js for the fake one, and a runner that only says which Node.js runs it.
        fs.rmSync(path.join(kit, "node", "node.exe"));
        try {
            fs.linkSync(process.execPath, path.join(kit, "node", "node.exe"));
        } catch {
            fs.copyFileSync(process.execPath, path.join(kit, "node", "node.exe"));
        }
        fs.writeFileSync(path.join(kit, "runner.mjs"), STAND_IN_RUNNER);
        const res = run("cmd.exe", ["/d", "/c", ".\\start-runner.cmd"], kit, { PATH: pathWithoutNode(), Path: pathWithoutNode(), AITP_KIT_NO_PAUSE: "1", AITP_KIT_SKIP_SHELL_SEARCH: "1", LOCALAPPDATA: path.join(tmp, "no-localappdata"), APPDATA: path.join(tmp, "no-appdata") });
        expect(res.out).toContain(`Using the Node.js that came with this download, version ${process.version}.`);
        expect(res.out).toContain("The test tools came with this download. Nothing to install.");
        expect(res.out).toMatch(new RegExp(`RUNNER-STAND-IN execPath=${path.join(kit, "node", "node.exe").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} version=${process.version.replace(/\./g, "\\.")} args=--enroll-file runner.enroll`, "i"));
        expect(res.out).not.toMatch(/npm|installing the test tools|playwright install/i);
        expect(res.out).toContain("The runner stopped.");
        expect(res.code).toBe(0);
    });

    it.skipIf(!BASH)("start-runner.sh, under Git Bash, makes node/bin/node executable again and runs the runner with it, with no Node.js on the PATH", async () => {
        const r = await complete("linux", "x64");
        const kit = unpackWithFflate(r.buf, "sh");
        const nodeBin = path.join(kit, "node", "bin", "node");
        // The stand-in for a real Node.js: a two-line script that runs this computer's node. It loses its executable bit, as some unzip tools do.
        fs.writeFileSync(nodeBin, `#!/bin/sh\nexec "${msys(process.execPath)}" "$@"\n`);
        fs.chmodSync(nodeBin, 0o644);
        fs.writeFileSync(path.join(kit, "runner.mjs"), STAND_IN_RUNNER);
        const res = run(BASH!, ["start-runner.sh"], kit, { PATH: bashPathWithoutNode(), HOME: msys(path.join(tmp, "home-sh")), AITP_KIT_NO_PAUSE: "1", AITP_KIT_SKIP_SHELL_SEARCH: "1" });
        expect(res.out).toContain(`Using the Node.js that came with this download, version ${process.version}.`);
        expect(res.out).toContain("The test tools came with this download. Nothing to install.");
        expect(res.out).toMatch(/RUNNER-STAND-IN execPath=\S+ version=v\d+\.\d+\.\d+ args=--enroll-file runner\.enroll/);
        expect(res.out).not.toMatch(/npm|installing the test tools|playwright install/i);
        expect(res.out).toContain("The runner stopped.");
        expect(res.code).toBe(0);
    });

    it.skipIf(process.platform !== "win32")("a Node.js inside the download that does not start (another processor) falls back to the one on the computer; npm is still skipped", async () => {
        const r = await complete("windows", "x64");
        const kit = unpackWithFflate(r.buf, "wrong");
        fs.writeFileSync(path.join(kit, "runner.mjs"), STAND_IN_RUNNER);
        // node/node.exe stays the fake one from the archive, which is not a program.
        const res = run("cmd.exe", ["/d", "/c", ".\\start-runner.cmd"], kit, { PATH: pathWithoutNode(), Path: pathWithoutNode(), AITP_KIT_NO_PAUSE: "1", AITP_KIT_SKIP_SHELL_SEARCH: "1", AITP_KIT_EXTRA_NODE_DIRS: path.dirname(process.execPath), LOCALAPPDATA: path.join(tmp, "no-localappdata"), APPDATA: path.join(tmp, "no-appdata") });
        expect(res.out).toContain("The Node.js that came with this download does not start on this computer. It may be the download for another processor.");
        expect(res.out).toMatch(/Using Node\.js v\d+\.\d+\.\d+ from /);
        expect(res.out).toContain("The test tools came with this download. Nothing to install.");
        expect(res.out).toContain("RUNNER-STAND-IN");
        expect(res.code).toBe(0);
    });

    it.skipIf(!BASH)("a complete download whose node_modules is missing says it is incomplete instead of trying npm", async () => {
        const r = await complete("linux", "x64");
        const kit = unpackWithFflate(r.buf, "half");
        fs.writeFileSync(path.join(kit, "node", "bin", "node"), `#!/bin/sh\nexec "${msys(process.execPath)}" "$@"\n`);
        fs.rmSync(path.join(kit, "node_modules"), { recursive: true, force: true });
        const res = run(BASH!, ["start-runner.sh"], kit, { PATH: bashPathWithoutNode(), HOME: msys(path.join(tmp, "home-half")), AITP_KIT_NO_PAUSE: "1", AITP_KIT_SKIP_SHELL_SEARCH: "1" });
        expect(res.out).toContain("This download is incomplete: the node_modules folder is missing or damaged.");
        expect(res.out).not.toMatch(/npm install|RUNNER-STAND-IN/);
        expect(res.code).toBe(1);
    });
});
