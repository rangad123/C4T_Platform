/**
 * The runner download from Settings (round 45), platform side (no browser, no ports: requests go through server.inject). One download per
 * system, nothing to choose: Windows gets the setup program (since round 49 the program itself with the kit appended; a signed one gets the zip), a Mac the app (since round 50 a zip
 * holding only the app, the kit inside it; a signed app gets the old zip), Linux the plain files (since round 50 one sh script with the kit as a gzip tar at its end); a system whose installer is not built
 * here gets the plain files with a plain note. Who may download (a person who may run tests, the open server; never the shared access
 * key), what is inside (runner.json without a name, so the runner takes the computer's name; runner.enroll with this person's one-time
 * code, owner-bound), the info answer, the rate limit, and that neither the server's secrets nor the code (outside runner.enroll) are inside.
 *
 * The installers here are stand-ins (a few bytes named like the real files): what is tested is the platform's handling of whatever
 * `npm run build:installer` produced, not the C# program, which tests/installer-win-unit.test.ts and tests/installer-win.test.ts cover.
 * The complete builds (own Node.js) are covered by tests/runner-complete-kit-unit.test.ts.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { OPEN_OWNER_ID } from "../src/platform/agent-store.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CANNOT_DOWNLOAD, KEY_CANNOT_DOWNLOAD } from "../src/platform/routes/runner-kits.js";
import { buildServer } from "../src/platform/server.js";
import { spawnSync } from "node:child_process";
import { splitLinuxScript, splitMacPkg, splitStampedExe } from "./fixtures/runner-person.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { writeManifest } from "../scripts/build-installer.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const API_KEY = "inst-kit-admin-key-3f9a1c";
const SENTINELS = { ANTHROPIC_API_KEY: "INSTLEAK-anthropic-8c21f0a4", SECRET_BOX_KEY: "INSTLEAK-box-4be7d913", OPENAI_API_KEY: "INSTLEAK-openai-71d0c2e8" };
const ENV_KEYS = ["RUNNER_KIT_DIR", "RUNNER_INSTALLER_DIR", "RUNNER_COMPLETE_DIR", "RUNNER_KIT_RATE_PER_MINUTE", ...Object.keys(SENTINELS)];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const APP = "AI Testing Runner.app";

let tmp: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let instDir: string;
/** People with their own API tokens (Bearer): an owner (may run tests everywhere), and a viewer (may run tests nowhere). */
const people: Record<"maya" | "vic" | "rita", { id: string; token: string }> = {} as never;
const logged: string[] = [];

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

type Answer = { status: number; headers: Record<string, string>; buf: Buffer; text: string; body: any };
async function callOn(app: Awaited<ReturnType<typeof buildServer>>, headers: Record<string, string>, method: "GET" | "POST", url: string, body?: unknown): Promise<Answer> {
    const res = await app.inject({ method, url, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    const buf = res.rawPayload;
    const text = buf.toString("utf8");
    return { status: res.statusCode, headers: res.headers as Record<string, string>, buf, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined };
}
const as = (who: keyof typeof people, method: "GET" | "POST", url: string, body?: unknown) => callOn(server, { authorization: `Bearer ${people[who].token}` }, method, url, body);
const asKey = (method: "GET" | "POST", url: string, body?: unknown) => callOn(server, { "x-api-key": API_KEY }, method, url, body);
const download = (who: keyof typeof people, os: "windows" | "mac" | "linux", arch: "x64" | "arm64" = "x64") => as(who, "POST", "/api/me/runner/download", { os, arch });
const enrollment = (id: string) => platform.db.get<{ owner_id: string | null; label: string | null; used_ms: number | null }>("SELECT owner_id, label, used_ms FROM runner_enrollments WHERE id = ?", id);

/** Unix permission bits of each entry from the zip's central directory (fflate's unzip does not expose them). */
function modes(zip: Uint8Array): Record<string, number> {
    const b = Buffer.from(zip);
    const out: Record<string, number> = {};
    for (let i = 0; i + 46 <= b.length; i++) {
        if (b.readUInt32LE(i) !== 0x02014b50) continue;
        const nameLen = b.readUInt16LE(i + 28);
        out[b.subarray(i + 46, i + 46 + nameLen).toString("utf8")] = (b.readUInt32LE(i + 38) >>> 16) & 0o7777;
        i += 45;
    }
    return out;
}

/** What `npm run build:installer` writes, in miniature: a stand-in program and a stand-in Mac app, with a manifest. */
/** A PE file whose certificate table (data directory 4) is not empty: what a signed program looks like to the server. */
function signedPe(): Buffer {
    const pe = 0x40;
    const opt = pe + 24;
    const b = Buffer.alloc(opt + 112 + 16 * 8);
    b.write("MZ", 0, "latin1");
    b.writeUInt32LE(pe, 0x3c);
    b.write("PE\0\0", pe, "latin1");
    b.writeUInt16LE(0x20b, opt);
    b.writeUInt32LE(16, opt + 108);
    b.writeUInt32LE(b.length, opt + 112 + 32);
    b.writeUInt32LE(64, opt + 112 + 36);
    return Buffer.concat([b, Buffer.alloc(64)]);
}

function writeStandIns(dir: string, program: Buffer | string = "MZ stand-in program\n", macSigned = false): void {
    const put = (rel: string, body: string | Buffer, mode: number) => {
        const f = path.join(dir, ...rel.split("/"));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, body);
        return { path: rel.replace(/^mac\//, ""), mode, sha256: sha(Buffer.from(body)) };
    };
    put("win/AITestingRunnerSetup.exe", program, 0o755);
    const entries = [
        put(`mac/${APP}/Contents/Info.plist`, "<plist/>\n", 0o644),
        put(`mac/${APP}/Contents/MacOS/AITestingRunner`, "#!/bin/sh\nexit 0\n", 0o755),
        put(`mac/${APP}/Contents/Resources/runner-setup.sh`, "#!/bin/sh\nexit 0\n", 0o755),
        ...(macSigned ? [put(`mac/${APP}/Contents/_CodeSignature/CodeResources`, "<plist/>\n", 0o644)] : []),
    ];
    fs.writeFileSync(path.join(dir, "mac", "manifest-part.json"), JSON.stringify({ version: 1, entries }));
    writeManifest({ outDir: dir, platformVersion: "1.0.0" });
}

beforeAll(async () => {
    for (const [k, v] of Object.entries(SENTINELS)) process.env[k] = v;
    // Several downloads per person here; the limit itself is checked below with its own number.
    process.env.RUNNER_KIT_RATE_PER_MINUTE = "100";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inst-kit-"));
    const bundleDir = path.join(tmp, "dist-runner");
    await buildRunner({ outDir: bundleDir });
    process.env.RUNNER_KIT_DIR = bundleDir;
    // No complete build here: the plain installer and files downloads are what this file checks.
    process.env.RUNNER_COMPLETE_DIR = path.join(tmp, "no-complete-builds");
    instDir = path.join(tmp, "dist-installer");
    writeStandIns(instDir);
    process.env.RUNNER_INSTALLER_DIR = instDir;
    const dataDir = path.join(tmp, "data");
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: "6590", PUBLIC_URL: "https://tests.example.com", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    server.addHook("onRequest", async (req) => {
        for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
            const original = req.log[level].bind(req.log) as (...a: unknown[]) => void;
            (req.log as unknown as Record<string, unknown>)[level] = (...a: unknown[]) => {
                logged.push(`${level} ${JSON.stringify(a)}`);
                original(...a);
            };
        }
    });
    await server.ready();
    const users = accessControlOf(server).users;
    for (const [key, role] of [["maya", "owner"], ["rita", "editor"], ["vic", "viewer"]] as const) {
        const person = users.create({ email: `${key}@people.example`, name: key === "maya" ? "Maya" : key === "rita" ? "Rita" : "Vic", role });
        people[key] = { id: person.id, token: users.createToken(person.id, { name: "download test", role }).token };
    }
}, 120_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await server?.close();
    platform?.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("who may download", () => {
    it("a person who may run tests gets their own one-time code; the access key and a person who may not run tests are refused", async () => {
        const r = await download("maya", "linux");
        expect(r.status, r.text.slice(0, 200)).toBe(200);
        const e = enrollment(r.headers["x-runner-enrollment-id"]!);
        expect(e).toMatchObject({ owner_id: people.maya.id, label: null, used_ms: null });
        expect(Date.parse(r.headers["x-runner-enrollment-expires"]!)).toBeGreaterThan(Date.now());
        // An editor may run tests: the same.
        const editor = await download("rita", "windows");
        expect(editor.status).toBe(200);
        expect(enrollment(editor.headers["x-runner-enrollment-id"]!)).toMatchObject({ owner_id: people.rita.id });

        const key = await asKey("POST", "/api/me/runner/download", { os: "windows", arch: "x64" });
        expect(key.status).toBe(403);
        expect(key.body.error ?? key.body.message).toBe(KEY_CANNOT_DOWNLOAD);
        const viewer = await download("vic", "windows");
        expect(viewer.status).toBe(403);
        expect(viewer.body.error ?? viewer.body.message).toBe(CANNOT_DOWNLOAD);
        const nobody = await callOn(server, {}, "POST", "/api/me/runner/download", { os: "windows", arch: "x64" });
        expect(nobody.status).toBe(401);
        // A refused download made no code.
        expect(Number(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runner_enrollments WHERE owner_id IS NULL OR owner_id = ?", people.vic.id)?.n)).toBe(0);
    });

    it("the open server (no access key, nobody signed up) downloads as its one person", async () => {
        const dataDir = path.join(tmp, "open-data");
        const open = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: "6591", PUBLIC_URL: "http://127.0.0.1:6591", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0" }));
        const app = await buildServer(open);
        try {
            await app.ready();
            const info = await callOn(app, {}, "GET", "/api/me/runner/download/info");
            expect(info.body).toMatchObject({ available: true, mayDownload: true });
            const r = await callOn(app, {}, "POST", "/api/me/runner/download", { os: "mac", arch: "arm64" });
            expect(r.status, r.text.slice(0, 200)).toBe(200);
            expect(open.db.get("SELECT owner_id FROM runner_enrollments WHERE id = ?", r.headers["x-runner-enrollment-id"])).toEqual({ owner_id: OPEN_OWNER_ID });
        } finally {
            await app.close();
            open.db.close();
        }
    });

    it("checks what is asked for: a system and a processor, nothing else", async () => {
        for (const body of [{}, { os: "windows" }, { os: "unix", arch: "x64" }, { os: "windows", arch: "ia32" }, { os: "windows", arch: "x64", name: "Office PC" }, { os: "windows", arch: "x64", kind: "files" }, { os: "linux", arch: "x64", complete: true }]) {
            const r = await as("maya", "POST", "/api/me/runner/download", body);
            expect(r.status, JSON.stringify(body)).toBe(400);
            expect(String(r.body.error ?? r.body.message ?? "").length).toBeGreaterThan(5);
        }
    });

    it("is rate limited per person", async () => {
        const saved = process.env.RUNNER_KIT_RATE_PER_MINUTE;
        process.env.RUNNER_KIT_RATE_PER_MINUTE = "5";
        const limited = bootstrap(loadConfig({ DATA_DIR: path.join(tmp, "limit-data"), API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: "6592", PUBLIC_URL: "https://tests.example.com", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0" }));
        const app = await buildServer(limited);
        try {
            await app.ready();
            const u = accessControlOf(app).users;
            const a = u.create({ email: "a@people.example", name: "A", role: "owner" });
            const b = u.create({ email: "b@people.example", name: "B", role: "owner" });
            const ta = u.createToken(a.id, { name: "a", role: "owner" }).token;
            const tb = u.createToken(b.id, { name: "b", role: "owner" }).token;
            const statuses: number[] = [];
            for (let i = 0; i < 7; i++) statuses.push((await callOn(app, { authorization: `Bearer ${ta}` }, "POST", "/api/me/runner/download", { os: "linux", arch: "x64" })).status);
            expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
            // Another person is not affected.
            expect((await callOn(app, { authorization: `Bearer ${tb}` }, "POST", "/api/me/runner/download", { os: "linux", arch: "x64" })).status).toBe(200);
            expect(Number(limited.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runner_enrollments WHERE owner_id = ?", a.id)?.n)).toBe(5);
        } finally {
            process.env.RUNNER_KIT_RATE_PER_MINUTE = saved;
            await app.close();
            limited.db.close();
        }
    });
});

describe("info", () => {
    it("says, per system and processor, whether it can be downloaded here, and whether this person may download: only what Settings reads", async () => {
        const info = (await as("maya", "GET", "/api/me/runner/download/info")).body;
        expect(info).toEqual({ available: true, urlOk: true, mayDownload: true, systems: expect.any(Array) });
        // Installers built and no complete build: each system just "available" and the name it is saved as, with no note and no size.
        for (const sys of info.systems as Array<Record<string, unknown>>) expect(Object.keys(sys).sort(), `${sys.os}-${sys.arch}`).toEqual(["arch", "available", "fileName", "os"]);
        expect(Object.fromEntries((info.systems as Array<{ os: string; fileName: string }>).map((x) => [x.os, x.fileName]))).toEqual({ windows: "AITestingRunnerSetup.exe", mac: "ai-testing-runner-mac.pkg", linux: "ai-testing-runner.sh" });
        // The names match what the downloads are saved as.
        for (const [osName, name] of [["windows", "AITestingRunnerSetup.exe"], ["mac", "ai-testing-runner-mac.pkg"], ["linux", "ai-testing-runner.sh"]] as const) expect((await download("maya", osName)).headers["content-disposition"]).toBe(`attachment; filename="${name}"`);
        expect((info.systems as Array<{ os: string; arch: string; available: boolean }>).map((x) => `${x.os}-${x.arch}:${x.available}`)).toEqual(["windows-x64:true", "windows-arm64:true", "mac-x64:true", "mac-arm64:true", "linux-x64:true", "linux-arm64:true"]);
        const viewer = (await as("vic", "GET", "/api/me/runner/download/info")).body;
        expect(viewer).toMatchObject({ mayDownload: false, refusal: CANNOT_DOWNLOAD });
        expect((await asKey("GET", "/api/me/runner/download/info")).body).toMatchObject({ mayDownload: false, refusal: KEY_CANNOT_DOWNLOAD });
    });

    it("says why, in plain words, when an installer is missing or damaged; that system then gets the plain files", async () => {
        const saved = process.env.RUNNER_INSTALLER_DIR;
        try {
            process.env.RUNNER_INSTALLER_DIR = path.join(tmp, "nothing-here");
            const none = (await as("maya", "GET", "/api/me/runner/download/info")).body;
            const win = none.systems.find((s: { os: string; arch: string }) => s.os === "windows" && s.arch === "x64");
            expect(win).toMatchObject({ available: true });
            expect(win.note).toMatch(/Windows installer has not been built[\s\S]*npm run build:installer[\s\S]*The plain files were sent instead\./);
            expect(none.systems.find((s: { os: string }) => s.os === "mac").note).toMatch(/Mac installer has not been built/);
            // A Mac app with one file edited after the build is refused, and the Windows program is still offered.
            const copy = path.join(tmp, "tampered");
            fs.cpSync(instDir, copy, { recursive: true });
            fs.appendFileSync(path.join(copy, "mac", APP, "Contents", "Info.plist"), "tampered");
            process.env.RUNNER_INSTALLER_DIR = copy;
            const mixed = (await as("maya", "GET", "/api/me/runner/download/info")).body;
            expect(mixed.systems.find((s: { os: string }) => s.os === "windows").note).toBeUndefined();
            const mac = mixed.systems.find((s: { os: string }) => s.os === "mac");
            expect(mac.note).toMatch(/damaged/);
        } finally {
            process.env.RUNNER_INSTALLER_DIR = saved;
        }
    });

    it("before the runner is built: not available, and a download is a plain 503 that makes no code", async () => {
        const saved = process.env.RUNNER_KIT_DIR;
        try {
            process.env.RUNNER_KIT_DIR = path.join(tmp, "not-built");
            const info = (await as("maya", "GET", "/api/me/runner/download/info")).body;
            expect(info).toMatchObject({ available: false, reason: "The runner kit has not been built on this server. Run `npm run build:runner`." });
            const before = Number(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runner_enrollments")?.n);
            const r = await download("maya", "windows");
            expect(r.status).toBe(503);
            expect(r.body.error ?? r.body.message).toContain("npm run build:runner");
            expect(Number(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runner_enrollments")?.n)).toBe(before);
        } finally {
            process.env.RUNNER_KIT_DIR = saved;
        }
    });
});

describe("the Windows download", () => {
    it("is the setup program itself (round 49): the program's bytes, then the kit (runner bundle, runner.json without a name, runner.enroll), with the right file name", async () => {
        const r = await download("maya", "windows");
        expect(r.status, r.text).toBe(200);
        expect(r.headers["content-type"]).toBe("application/vnd.microsoft.portable-executable");
        expect(r.headers["content-disposition"]).toBe('attachment; filename="AITestingRunnerSetup.exe"');
        expect(r.headers["x-runner-kit-kind"]).toBe("installer");
        expect(r.headers["x-runner-kit-note"]).toBeUndefined();
        expect(r.headers["x-runner-kit-target"]).toBeUndefined();
        expect(r.headers["cache-control"]).toBe("no-store");
        expect(r.headers["access-control-expose-headers"]).toContain("x-runner-enrollment-id");
        const parts = splitStampedExe(r.buf)!;
        expect(parts.format).toBe(1);
        expect(parts.program.toString()).toBe("MZ stand-in program\n");
        const z = unzipSync(new Uint8Array(parts.payload));
        const dir = "runner-my-computer-windows-setup";
        expect(Object.keys(z).filter((n) => !n.endsWith("/package-lock.json")).sort()).toEqual(["LICENSES.txt", "package.json", "record-child.mjs", "runner.enroll", "runner.json", "runner.mjs", "task-child.mjs"].map((n) => `${dir}/${n}`));
        expect(modes(new Uint8Array(parts.payload))[`${dir}/runner.enroll`]).toBe(0o600);
        const cfg = JSON.parse(Buffer.from(z[`${dir}/runner.json`]!).toString());
        // No name: the runner is named after the computer (the person can rename it in Settings).
        expect(Object.keys(cfg).sort()).toEqual(["kitVersion", "url"]);
        expect(cfg.url).toBe("https://tests.example.com");
        expect(cfg.kitVersion).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{10}$/);
        // The same prebuilt runner bytes as the plain files download.
        const fz = splitLinuxScript((await download("maya", "linux")).buf)!.files;
        for (const n of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"]) expect(Buffer.from(z[`${dir}/${n}`]!).equals(fz[n]!), n).toBe(true);
    });

    it("a signed program gets the zip instead (bytes after a signature break it): the program, the bundle, runner.enroll and a README with the right modes and plain words", async () => {
        const saved = process.env.RUNNER_INSTALLER_DIR;
        const signed = path.join(tmp, "signed-installer");
        writeStandIns(signed, signedPe());
        process.env.RUNNER_INSTALLER_DIR = signed;
        try {
            const r = await download("maya", "windows", "arm64");
            expect(r.status, r.text).toBe(200);
            expect(r.headers["content-type"]).toBe("application/zip");
            expect(r.headers["content-disposition"]).toBe('attachment; filename="runner-my-computer-windows-setup.zip"');
            expect(r.headers["x-runner-kit-kind"]).toBe("installer");
            expect(splitStampedExe(r.buf)).toBeUndefined();
            expect(logged.some((l) => l.includes("the Windows installer is signed: sending the zip"))).toBe(true);
            const z = unzipSync(new Uint8Array(r.buf));
            const dir = "runner-my-computer-windows-setup";
            expect(Object.keys(z).filter((n) => !n.endsWith("/package-lock.json")).sort()).toEqual(
                // check-computer.* : "Check this computer" in every zip download (docs/features/runner-check.md).
                ["AITestingRunnerSetup.exe", "LICENSES.txt", "README.txt", "check-computer.cmd", "check-computer.command", "check-computer.sh", "package.json", "record-child.mjs", "runner.enroll", "runner.json", "runner.mjs", "task-child.mjs"].map((n) => `${dir}/${n}`),
            );
            const m = modes(new Uint8Array(r.buf));
            expect(m[`${dir}/AITestingRunnerSetup.exe`]).toBe(0o755);
            expect(m[`${dir}/runner.enroll`]).toBe(0o600);
            expect(m[`${dir}/runner.mjs`]).toBe(0o644);
            expect(Buffer.from(z[`${dir}/AITestingRunnerSetup.exe`]!).equals(signedPe())).toBe(true);
            const readme = Buffer.from(z[`${dir}/README.txt`]!).toString("utf8");
            expect(readme).toContain("\r\n");
            expect(readme.replace(/\r\n/g, "\n")).not.toMatch(/\r/);
            expect(readme.split("\r\n")[0]).toBe("AI Testing Platform runner");
            for (const needle of ["AITestingRunnerSetup.exe", "Windows protected your PC", "More info", "Run anyway", "not signed", "only downloads what is missing", "Node.js", "does not need administrator rights", "--uninstall", "Settings, Your runner", "Remove this computer", "each person has one runner"]) expect(readme, needle).toContain(needle);
            for (const gone of ["Project:", "Runners", "revoke its token", "start-runner"]) expect(readme, gone).not.toContain(gone);
            expect(readme).not.toMatch(/seamless|leverage|unlock|empower/i);
        } finally {
            process.env.RUNNER_INSTALLER_DIR = saved;
        }
    });

    it("carries this person's single-use code in runner.enroll only, never a runner credential, and logs no code", async () => {
        const r = await download("maya", "windows");
        const parts = splitStampedExe(r.buf)!;
        const z = unzipSync(new Uint8Array(parts.payload));
        const code = Buffer.from(z["runner-my-computer-windows-setup/runner.enroll"]!).toString("utf8").trim();
        expect(code).toMatch(/^aite_/);
        expect(parts.program.includes(code)).toBe(false);
        for (const [name, bytes] of Object.entries(z)) {
            if (!name.endsWith("runner.enroll")) expect(Buffer.from(bytes).includes(code), name).toBe(false);
            expect(/aitg_[A-Za-z0-9_-]{20,}/.test(Buffer.from(bytes).toString("latin1")), name).toBe(false);
        }
        expect(logged.join("\n").includes(code)).toBe(false);
        expect(logged.some((l) => l.includes("runner-downloaded"))).toBe(true);
        // The plaintext is never stored: only its hash and the last four characters.
        expect(JSON.stringify(platform.db.all("SELECT * FROM runner_enrollments"))).not.toContain(code);
        // The person's Activity says a runner was downloaded, without the code.
        const rows = platform.db.all<{ action: string; detail: string }>("SELECT action, detail FROM activity WHERE action = 'runner-download'");
        expect(rows.length).toBeGreaterThan(0);
        expect(JSON.stringify(rows)).not.toContain(code);
        // Single use, as before (after the log checks: this file's log capture also serializes inject's raw request, body included).
        const trade = (machineId: string) => callOn(server, {}, "POST", "/api/agent/enroll", { code, name: "test-computer", machineId });
        const first = await trade("11111111-1111-4111-8111-111111111111");
        expect(first.status, first.text).toBe(201);
        expect((await trade("22222222-2222-4222-8222-222222222222")).status).toBeGreaterThanOrEqual(400);
    });
});

describe("the Mac download", () => {
    it("is one installer package (round 55): the app and the kit in its Scripts, this download's code beside them, the modes the build recorded", async () => {
        const r = await download("maya", "mac", "arm64");
        expect(r.status, r.text).toBe(200);
        expect(r.headers["content-type"]).toBe("application/octet-stream");
        expect(r.headers["content-disposition"]).toBe('attachment; filename="ai-testing-runner-mac.pkg"');
        expect(r.headers["x-runner-kit-kind"]).toBe("installer");
        expect(Number(r.headers["content-length"])).toBe(r.buf.length);
        const pkg = splitMacPkg(r.buf)!;
        expect(pkg.distribution).toContain('enable_currentUserHome="true"');
        const names = Object.keys(pkg.files);
        expect(names.filter((n) => !n.startsWith("kit.zip/")).sort()).toEqual(["Distribution", "PackageInfo", "TOC", "kit.zip", "postinstall", "runner.enroll", "runner.json"]);
        expect(names.filter((n) => n.startsWith(`kit.zip/${APP}/`)).sort()).toEqual([`${APP}/Contents/Info.plist`, `${APP}/Contents/MacOS/AITestingRunner`, `${APP}/Contents/Resources/runner-setup.sh`].map((n) => `kit.zip/${n}`));
        expect(names.filter((n) => n.startsWith("kit.zip/kit/") && !n.endsWith("/package-lock.json")).sort()).toEqual(["LICENSES.txt", "package.json", "record-child.mjs", "runner.mjs", "task-child.mjs"].map((n) => `kit.zip/kit/${n}`));
        const m = modes(new Uint8Array(pkg.files["kit.zip"]!));
        expect(m[`${APP}/Contents/MacOS/AITestingRunner`]).toBe(0o755);
        expect(m[`${APP}/Contents/Resources/runner-setup.sh`]).toBe(0o755);
        expect(m[`${APP}/Contents/Info.plist`]).toBe(0o644);
        expect(m["kit/runner.mjs"]).toBe(0o644);
        expect(pkg.modes["runner.enroll"]).toBe(0o600);
        expect(pkg.modes["postinstall"]).toBe(0o755);
        // The app itself is the same bytes for everyone: only runner.json and runner.enroll differ.
        expect(pkg.files[`kit.zip/${APP}/Contents/Resources/runner-setup.sh`]!.toString()).toBe("#!/bin/sh\nexit 0\n");
        expect(pkg.files["runner.enroll"]!.toString().trim()).toMatch(/^aite_/);
        expect(JSON.parse(pkg.files["runner.json"]!.toString()).url).toBe("https://tests.example.com");
    });

    it("a signed app gets today's zip with the kit beside it (a file inside would break the signature), and the server logs it", async () => {
        const saved = process.env.RUNNER_INSTALLER_DIR;
        const signed = path.join(tmp, "signed-mac");
        writeStandIns(signed, undefined, true);
        process.env.RUNNER_INSTALLER_DIR = signed;
        try {
            const info = (await as("maya", "GET", "/api/me/runner/download/info")).body;
            expect(info.systems.find((x: { os: string }) => x.os === "mac").fileName).toBe("runner-my-computer-mac-setup.zip");
            const r = await download("maya", "mac", "arm64");
            expect(r.status, r.text).toBe(200);
            expect(r.headers["content-disposition"]).toBe('attachment; filename="runner-my-computer-mac-setup.zip"');
            expect(r.headers["x-runner-kit-kind"]).toBe("installer");
            expect(logged.some((l) => l.includes("the Mac app is signed: sending the zip with the kit beside it"))).toBe(true);
            const z = unzipSync(new Uint8Array(r.buf));
            const dir = "runner-my-computer-mac-setup";
            for (const n of [`${APP}/Contents/Info.plist`, `${APP}/Contents/_CodeSignature/CodeResources`, `${APP}/Contents/MacOS/AITestingRunner`, "runner.mjs", "runner.json", "runner.enroll", "README.txt"]) expect(z[`${dir}/${n}`], n).toBeDefined();
            expect(Object.keys(z).some((n) => n.includes("/Contents/Resources/kit/"))).toBe(false);
            const m = modes(new Uint8Array(r.buf));
            expect(m[`${dir}/${APP}/Contents/MacOS/AITestingRunner`]).toBe(0o755);
            expect(m[`${dir}/runner.enroll`]).toBe(0o600);
            const readme = Buffer.from(z[`${dir}/README.txt`]!).toString("utf8");
            for (const needle of ["could not verify the app", "Open Anyway", "xattr -dr com.apple.quarantine", "AI Testing Runner", "Settings, Your runner"]) expect(readme, needle).toContain(needle);
        } finally {
            process.env.RUNNER_INSTALLER_DIR = saved;
        }
    });
});

describe("the Linux download, and the fallback", () => {
    it("Linux gets one file (round 50): a sh header, then the kit as a gzip tar that tar unpacks, with the right modes; the code only in runner.enroll, single use", async () => {
        const r = await download("maya", "linux", "arm64");
        expect(r.headers["x-runner-kit-kind"]).toBe("files");
        expect(r.headers["x-runner-kit-note"]).toBeUndefined();
        expect(r.headers["content-type"]).toBe("application/x-sh");
        expect(r.headers["content-disposition"]).toBe('attachment; filename="ai-testing-runner.sh"');
        expect(Number(r.headers["content-length"])).toBe(r.buf.length);
        const parts = splitLinuxScript(r.buf)!;
        expect(parts.header.startsWith("#!/bin/sh\n")).toBe(true);
        expect(parts.header).toContain('tail -c +"$AITP_SKIP" "$SELF" | tar xzf - -C "$TMP_DIR"');
        expect(Object.keys(parts.files).filter((n) => n !== "package-lock.json").sort()).toEqual(["LICENSES.txt", "check-computer.sh", "package.json", "record-child.mjs", "runner.enroll", "runner.json", "runner.mjs", "start-runner.sh", "task-child.mjs"]);
        expect(parts.modes["runner.enroll"]).toBe(0o600);
        expect(parts.modes["start-runner.sh"]).toBe(0o755);
        expect(parts.modes["runner.mjs"]).toBe(0o644);
        const code = parts.files["runner.enroll"]!.toString().trim();
        expect(code).toMatch(/^aite_/);
        // The code is nowhere but runner.enroll: not in the header, not in any other file.
        expect(parts.header).not.toContain(code);
        for (const [n, body] of Object.entries(parts.files)) if (n !== "runner.enroll") expect(body.includes(code), n).toBe(false);
        // The header parses under every shell a Linux may call sh: dash, bash in POSIX mode, busybox (those present here).
        const headerFile = path.join(tmp, "header.sh");
        fs.writeFileSync(headerFile, parts.header);
        for (const [shell, args] of [["dash", ["-n"]], ["bash", ["--posix", "-n"]], ["busybox", ["sh", "-n"]]] as const) {
            if (spawnSync(shell, [...(shell === "busybox" ? ["sh"] : []), "-c", "exit 0"]).status !== 0) continue;
            const checked = spawnSync(shell, [...args, headerFile], { encoding: "utf8" });
            expect(checked.status, `${shell}: ${checked.stderr}`).toBe(0);
        }
        // This computer's own tail and tar read it, the way the header does.
        const file = path.join(tmp, "ai-testing-runner.sh");
        fs.writeFileSync(file, r.buf);
        const listed = spawnSync("sh", ["-c", 'n=$(sed -n "s/^AITP_SKIP=//p" "$1" | head -n 1); tail -c +"$n" "$1" | tar tzvf -', "sh", file], { encoding: "utf8" });
        expect(listed.status, listed.stderr).toBe(0);
        expect(listed.stdout).toMatch(/-rw------- .* runner\.enroll/);
        expect(listed.stdout).toMatch(/-rwxr-xr-x .* start-runner\.sh/);
        // Single use.
        const trade = (machineId: string) => callOn(server, {}, "POST", "/api/agent/enroll", { code, name: "linux-box", machineId });
        expect((await trade("33333333-3333-4333-8333-333333333333")).status).toBe(201);
        expect((await trade("44444444-4444-4444-8444-444444444444")).status).toBeGreaterThanOrEqual(400);
    });

    it("Windows and Mac get the plain files when the installer is not built here, and the answer says so (each download makes its own code)", async () => {
        const saved = process.env.RUNNER_INSTALLER_DIR;
        const before = Number(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runner_enrollments WHERE owner_id = ?", people.maya.id)?.n);
        try {
            process.env.RUNNER_INSTALLER_DIR = path.join(tmp, "not-built");
            for (const system of ["windows", "mac"] as const) {
                const r = await download("maya", system);
                expect(r.status, r.text).toBe(200);
                expect(r.headers["x-runner-kit-kind"]).toBe("files");
                expect(r.headers["x-runner-kit-note"]).toMatch(/has not been built[\s\S]*The plain files were sent instead\./);
                expect(r.headers["content-disposition"]).toContain(system === "windows" ? "-windows.zip" : "-unix.zip");
                expect(Object.keys(unzipSync(new Uint8Array(r.buf))).some((n) => n.endsWith("start-runner.sh"))).toBe(true);
            }
        } finally {
            process.env.RUNNER_INSTALLER_DIR = saved;
        }
        expect(Number(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runner_enrollments WHERE owner_id = ?", people.maya.id)?.n)).toBe(before + 2);
    });
});

describe("secrets", () => {
    it("never put the server's secrets, paths or data in a download", async () => {
        const forbidden = [...Object.values(SENTINELS), API_KEY, people.maya.token, "platform.db", ROOT, ROOT.replaceAll("\\", "/"), tmp, tmp.replaceAll("\\", "/")];
        for (const system of ["windows", "mac", "linux"] as const) {
            const r = await download("maya", system);
            expect(r.status).toBe(200);
            // Windows: the program part is checked as one more entry, the kit at its end like any zip.
            const parts = splitStampedExe(r.buf);
            const script = splitLinuxScript(r.buf);
            const pkg = splitMacPkg(r.buf);
            const entries = parts ? { "AITestingRunnerSetup.exe (program part)": new Uint8Array(parts.program), ...unzipSync(new Uint8Array(parts.payload)) } : script ? { "the script's header": Buffer.from(script.header), ...script.files } : pkg ? pkg.files : unzipSync(new Uint8Array(r.buf));
            for (const [name, bytes] of Object.entries(entries)) {
                if (name.endsWith("runner.enroll")) continue;
                const body = Buffer.from(bytes).toString("latin1");
                for (const s of forbidden) expect(body.includes(s), `${s.slice(0, 8)}... in ${name}`).toBe(false);
            }
        }
    });
});
