/**
 * The installer download, platform side (no browser, no ports: requests go through server.inject): the info route says which installers this
 * server has, the download route makes the installer zip (Windows setup program, Mac app) or falls back to the plain files kit with a plain
 * note, the kind is validated, modes and README are right, and neither the server's secrets nor the token (outside runner.token) are inside.
 *
 * The installers here are stand-ins (a few bytes named like the real files): what is tested is the platform's handling of whatever
 * `npm run build:installer` produced, not the C# program, which tests/installer-win-unit.test.ts and tests/installer-win.test.ts cover.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CustomScriptStore } from "../src/platform/custom-script-store.js";
import { buildServer } from "../src/platform/server.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { writeManifest } from "../scripts/build-installer.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const API_KEY = "inst-kit-admin-key-3f9a1c";
const SENTINELS = { ANTHROPIC_API_KEY: "INSTLEAK-anthropic-8c21f0a4", SECRET_BOX_KEY: "INSTLEAK-box-4be7d913", OPENAI_API_KEY: "INSTLEAK-openai-71d0c2e8" };
const ENV_KEYS = ["RUNNER_KIT_DIR", "RUNNER_INSTALLER_DIR", "RUNNER_KIT_RATE_PER_MINUTE", "AGENT_MAX_TOKENS", ...Object.keys(SENTINELS)];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const APP = "AI Testing Runner.app";

let tmp: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let instDir: string;
const logged: string[] = [];

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await server.inject({ method, url, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    const buf = res.rawPayload;
    const text = buf.toString("utf8");
    return { status: res.statusCode, headers: res.headers, buf, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; headers: Record<string, string>; buf: Buffer; text: string; body: any };
};
const newProject = async (name: string) => (await call("POST", "/api/projects", { name })).body.id as string;
const download = (projectId: string, name: string, platformName: "windows" | "unix", kind?: string) => call("POST", `/api/projects/${projectId}/runner-kits`, { name, platform: platformName, ...(kind ? { kind } : {}) });

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
function writeStandIns(dir: string): void {
    const put = (rel: string, body: string, mode: number) => {
        const f = path.join(dir, ...rel.split("/"));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, body);
        return { path: rel.replace(/^mac\//, ""), mode, sha256: sha(Buffer.from(body)) };
    };
    put("win/AITestingRunnerSetup.exe", "MZ stand-in program\n", 0o755);
    const entries = [
        put(`mac/${APP}/Contents/Info.plist`, "<plist/>\n", 0o644),
        put(`mac/${APP}/Contents/MacOS/AITestingRunner`, "#!/bin/sh\nexit 0\n", 0o755),
        put(`mac/${APP}/Contents/Resources/runner-setup.sh`, "#!/bin/sh\nexit 0\n", 0o755),
    ];
    fs.writeFileSync(path.join(dir, "mac", "manifest-part.json"), JSON.stringify({ version: 1, entries }));
    writeManifest({ outDir: dir, platformVersion: "1.0.0" });
}

beforeAll(async () => {
    for (const [k, v] of Object.entries(SENTINELS)) process.env[k] = v;
    // Several downloads for one project here; the one-runner default is covered in runner-limit-unit.test.ts.
    process.env.AGENT_MAX_TOKENS = "25";
    delete process.env.RUNNER_KIT_RATE_PER_MINUTE;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inst-kit-"));
    const bundleDir = path.join(tmp, "dist-runner");
    await buildRunner({ outDir: bundleDir });
    process.env.RUNNER_KIT_DIR = bundleDir;
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

describe("info", () => {
    it("says which installers this server has", async () => {
        const p = await newProject("Info shop");
        const info = (await call("GET", `/api/projects/${p}/runner-kits/info`)).body;
        expect(info.available).toBe(true);
        expect(info.installer).toEqual({ windows: true, mac: true, reasons: {} });
    });

    it("says why, in plain words, when an installer is missing or damaged; the plain files kit stays available", async () => {
        const p = await newProject("Info missing");
        const saved = process.env.RUNNER_INSTALLER_DIR;
        try {
            process.env.RUNNER_INSTALLER_DIR = path.join(tmp, "nothing-here");
            const none = (await call("GET", `/api/projects/${p}/runner-kits/info`)).body;
            expect(none.available).toBe(true);
            expect(none.installer.windows).toBe(false);
            expect(none.installer.mac).toBe(false);
            expect(none.installer.reasons.windows).toMatch(/Windows installer has not been built[\s\S]*npm run build:installer[\s\S]*RUNNER_INSTALLER_DIR/);
            expect(none.installer.reasons.mac).toMatch(/Mac installer has not been built/);
            // A Mac app with one file edited after the build is refused, and the Windows program is still offered.
            const copy = path.join(tmp, "tampered");
            fs.cpSync(instDir, copy, { recursive: true });
            fs.appendFileSync(path.join(copy, "mac", APP, "Contents", "Info.plist"), "tampered");
            process.env.RUNNER_INSTALLER_DIR = copy;
            const mixed = (await call("GET", `/api/projects/${p}/runner-kits/info`)).body;
            expect(mixed.installer.windows).toBe(true);
            expect(mixed.installer.mac).toBe(false);
            expect(mixed.installer.reasons.mac).toMatch(/damaged/);
        } finally {
            process.env.RUNNER_INSTALLER_DIR = saved;
        }
    });
});

describe("the Windows installer zip", () => {
    it("is the default for Windows: the program, the runner bundle, runner.json, runner.token and a README, with the right modes", async () => {
        const p = await newProject("Maya's Shop");
        const r = await download(p, "Office PC", "windows");
        expect(r.status, r.text).toBe(200);
        expect(r.headers["content-type"]).toBe("application/zip");
        expect(r.headers["content-disposition"]).toBe('attachment; filename="runner-maya-s-shop-windows-setup.zip"');
        expect(r.headers["x-runner-kit-kind"]).toBe("installer");
        expect(r.headers["x-runner-kit-note"]).toBeUndefined();
        expect(r.headers["cache-control"]).toBe("no-store");
        expect(r.headers["x-runner-enrollment-id"]).toMatch(/\S/);
        const z = unzipSync(new Uint8Array(r.buf));
        const dir = "runner-maya-s-shop-windows-setup";
        expect(Object.keys(z).filter((n) => !n.endsWith("/package-lock.json")).sort()).toEqual(
            // check-computer.* (package-lock.json comes with newer bundles): "Check this computer" in every download (docs/features/runner-check.md).
            ["AITestingRunnerSetup.exe", "LICENSES.txt", "README.txt", "check-computer.cmd", "check-computer.command", "check-computer.sh", "package.json", "record-child.mjs", "runner.enroll", "runner.json", "runner.mjs", "task-child.mjs"].map((n) => `${dir}/${n}`),
        );
        const m = modes(new Uint8Array(r.buf));
        expect(m[`${dir}/AITestingRunnerSetup.exe`]).toBe(0o755);
        expect(m[`${dir}/runner.enroll`]).toBe(0o600);
        expect(m[`${dir}/runner.mjs`]).toBe(0o644);
        expect(Buffer.from(z[`${dir}/AITestingRunnerSetup.exe`]!).toString()).toBe("MZ stand-in program\n");
        const cfg = JSON.parse(Buffer.from(z[`${dir}/runner.json`]!).toString());
        expect(cfg).toMatchObject({ url: "https://tests.example.com", name: "Office PC" });
        expect(cfg.kitVersion).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{10}$/);
        // The same prebuilt runner bytes as the files kit.
        const files = await download(p, "Office PC 2", "windows", "files");
        const fz = unzipSync(new Uint8Array(files.buf));
        for (const n of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"]) expect(Buffer.from(z[`${dir}/${n}`]!).equals(Buffer.from(fz[`runner-maya-s-shop-windows/${n}`]!)), n).toBe(true);
    });

    it("has a README that says, in plain words, what to click, what the SmartScreen prompt means and how to remove it", async () => {
        const p = await newProject("Readme shop");
        const r = await download(p, "Maya's laptop", "windows", "installer");
        const z = unzipSync(new Uint8Array(r.buf));
        const readme = Buffer.from(z["runner-readme-shop-windows-setup/README.txt"]!).toString("utf8");
        expect(readme).toContain("\r\n");
        expect(readme.replace(/\r\n/g, "\n")).not.toMatch(/\r/);
        for (const needle of ["AITestingRunnerSetup.exe", "Windows protected your PC", "More info", "Run anyway", "not signed", "only downloads what is missing", "Node.js", "does not need administrator rights", "--uninstall", "revoke", 'runner "Maya\'s laptop"']) expect(readme, needle).toContain(needle);
        expect(readme).not.toMatch(/start-runner/);
        expect(readme).not.toMatch(/seamless|leverage|unlock|empower/i);
    });

    it("carries a single-use code in runner.enroll only (round 39: no download carries a runner credential)", async () => {
        const p = await newProject("Token shop");
        const r = await download(p, "Token PC", "windows");
        const z = unzipSync(new Uint8Array(r.buf));
        const token = Buffer.from(z["runner-token-shop-windows-setup/runner.enroll"]!).toString("utf8").trim();
        expect(token).toMatch(/^aite_/);
        // No runner exists until the code is traded.
        expect((await call("GET", `/api/projects/${p}/agent-tokens`)).body).toEqual([]);
        for (const [name, bytes] of Object.entries(z)) {
            if (!name.endsWith("runner.enroll")) expect(Buffer.from(bytes).includes(token), name).toBe(false);
            expect(/aitg_[A-Za-z0-9_-]{20,}/.test(Buffer.from(bytes).toString("latin1")), name).toBe(false);
        }
        expect(logged.join("\n").includes(token)).toBe(false);
        // The download is recorded without the token, and says it was the installer.
        const audit = new CustomScriptStore(platform.db).auditTrail(p).filter((r) => r.action === "runner-kit-downloaded");
        expect(audit.length).toBe(1);
        expect(audit[0]!.detail).toContain("Token PC");
        expect(audit[0]!.detail).toContain("installer");
        expect(audit[0]!.detail?.includes(token)).toBe(false);
    });
});

describe("the Mac installer zip", () => {
    it("holds the .app with the modes the build recorded, the runner files and a Mac README", async () => {
        const p = await newProject("Mac shop");
        const r = await download(p, "Mac mini", "unix", "installer");
        expect(r.status, r.text).toBe(200);
        expect(r.headers["content-disposition"]).toBe('attachment; filename="runner-mac-shop-mac-setup.zip"');
        expect(r.headers["x-runner-kit-kind"]).toBe("installer");
        const z = unzipSync(new Uint8Array(r.buf));
        const dir = "runner-mac-shop-mac-setup";
        for (const n of [`${APP}/Contents/Info.plist`, `${APP}/Contents/MacOS/AITestingRunner`, `${APP}/Contents/Resources/runner-setup.sh`, "runner.mjs", "runner.json", "runner.enroll", "README.txt"]) expect(z[`${dir}/${n}`], n).toBeDefined();
        const m = modes(new Uint8Array(r.buf));
        expect(m[`${dir}/${APP}/Contents/MacOS/AITestingRunner`]).toBe(0o755);
        expect(m[`${dir}/${APP}/Contents/Resources/runner-setup.sh`]).toBe(0o755);
        expect(m[`${dir}/${APP}/Contents/Info.plist`]).toBe(0o644);
        expect(m[`${dir}/runner.enroll`]).toBe(0o600);
        const readme = Buffer.from(z[`${dir}/README.txt`]!).toString("utf8");
        expect(readme).not.toContain("\r");
        for (const needle of ["could not verify the app", "Open Anyway", "xattr -dr com.apple.quarantine", "AI Testing Runner"]) expect(readme, needle).toContain(needle);
    });
});

describe("kind", () => {
    it("defaults to the plain files for a Mac or Linux computer, and 'files' keeps today's zip for Windows", async () => {
        const p = await newProject("Kinds shop");
        const unix = await download(p, "Linux box", "unix");
        expect(unix.headers["x-runner-kit-kind"]).toBe("files");
        expect(unix.headers["content-disposition"]).toBe('attachment; filename="runner-kinds-shop-unix.zip"');
        expect(Object.keys(unzipSync(new Uint8Array(unix.buf)))).toContain("runner-kinds-shop-unix/start-runner.sh");
        const win = await download(p, "Old way", "windows", "files");
        expect(win.headers["x-runner-kit-kind"]).toBe("files");
        expect(win.headers["content-disposition"]).toBe('attachment; filename="runner-kinds-shop-windows.zip"');
        expect(Object.keys(unzipSync(new Uint8Array(win.buf)))).toEqual(expect.arrayContaining(["runner-kinds-shop-windows/start-runner.cmd", "runner-kinds-shop-windows/start-runner.sh"]));
    });

    it("rejects a kind that does not exist, with a plain message", async () => {
        const p = await newProject("Bad kind shop");
        for (const kind of ["dmg", "exe", "", 5, null]) {
            const r = await call("POST", `/api/projects/${p}/runner-kits`, { name: "x", platform: "windows", kind });
            expect(r.status, JSON.stringify(kind)).toBe(400);
            expect(r.body.error).toMatch(/Choose installer or files|Invalid|expected/i);
        }
        expect((await call("GET", `/api/projects/${p}/agent-tokens`)).body).toEqual([]);
    });

    it("falls back to the plain files kit when the installer is not built, and says so (each download still makes its own code)", async () => {
        const p = await newProject("Fallback shop");
        const saved = process.env.RUNNER_INSTALLER_DIR;
        try {
            process.env.RUNNER_INSTALLER_DIR = path.join(tmp, "not-built");
            for (const platformName of ["windows", "unix"] as const) {
                const r = await download(p, `Fallback ${platformName}`, platformName, "installer");
                expect(r.status, r.text).toBe(200);
                expect(r.headers["x-runner-kit-kind"]).toBe("files");
                expect(r.headers["x-runner-kit-note"]).toMatch(/has not been built[\s\S]*A plain files kit was made instead\./);
                expect(r.headers["content-disposition"]).toContain(platformName === "windows" ? "-windows.zip" : "-unix.zip");
                expect(Object.keys(unzipSync(new Uint8Array(r.buf))).some((n) => n.endsWith("start-runner.sh"))).toBe(true);
            }
            // The default for Windows is the installer, so it falls back the same way.
            const dflt = await download(p, "Fallback default", "windows");
            expect(dflt.headers["x-runner-kit-kind"]).toBe("files");
            expect(dflt.headers["x-runner-kit-note"]).toBeTruthy();
        } finally {
            process.env.RUNNER_INSTALLER_DIR = saved;
        }
        // Each download made its own single-use code (round 39); no runner exists until one is traded.
        expect(Number(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runner_enrollments WHERE project_id = ?", p)?.n)).toBe(3);
    });
});

describe("secrets", () => {
    it("never put the server's secrets, paths or data in an installer zip", async () => {
        const secrets: string[] = [...Object.values(SENTINELS)];
        const dotenv = path.join(ROOT, ".env");
        if (fs.existsSync(dotenv)) {
            for (const line of fs.readFileSync(dotenv, "utf8").split(/\r?\n/)) {
                const m = /^\s*([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
                const value = m?.[2]?.replace(/^["']|["']$/g, "").trim();
                if (value && value.length >= 12 && /[A-Za-z]/.test(value) && !/^(true|false|https?:\/\/)/.test(value)) secrets.push(value);
            }
        }
        const forbidden = [...secrets, API_KEY, "platform.db", ROOT, ROOT.replaceAll("\\", "/"), tmp, tmp.replaceAll("\\", "/")];
        const p = await newProject("Leak shop");
        for (const [platformName, kind] of [["windows", "installer"], ["unix", "installer"], ["windows", "files"]] as const) {
            const r = await download(p, `Leak ${platformName} ${kind}`, platformName, kind);
            expect(r.status).toBe(200);
            for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(r.buf)))) {
                if (name.endsWith("runner.enroll")) continue;
                const body = Buffer.from(bytes).toString("latin1");
                for (const s of forbidden) expect(body.includes(s), `${s.slice(0, 8)}... in ${name}`).toBe(false);
            }
        }
    });
});
