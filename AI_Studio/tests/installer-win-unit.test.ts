/**
 * The Windows runner installer without a platform (fast tier): the build script finds csc.exe and compiles the C# program, the result is a
 * small GUI program with a no-administrator manifest, an icon and no local paths; the plain message when csc.exe is missing; the manifest that
 * merges the Windows program with the Mac app's file list; and the platform's loader that verifies every checksum before it hands a file out.
 * The zip a download produces and the routes are in tests/runner-installer-kit.test.ts; the real runs of the program are in tests/installer-win.test.ts.
 *
 * Skipped with a clear reason where csc.exe does not exist (every Windows computer has it; no other system does). No ports, no browser.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installerInfo, loadInstaller, MAC_MISSING, WINDOWS_MISSING } from "../src/platform/runner-installer.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildInstallerWin, EXE_NAME, findCsc, makeIcon, NO_CSC_MESSAGE, SOURCES } from "../scripts/build-installer-win.mjs";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildInstaller, writeManifest } from "../scripts/build-installer.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const HAS_CSC = Boolean(findCsc());
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let tmp: string;
let out: string;
let exe: Buffer;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inst-unit-"));
    out = path.join(tmp, "inst");
    if (HAS_CSC) {
        buildInstallerWin({ outDir: path.join(out, "win") });
        writeManifest({ outDir: out, platformVersion: "9.9.9" });
        exe = fs.readFileSync(path.join(out, "win", EXE_NAME));
    }
}, 120_000);

afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!HAS_CSC)("the Windows program is built with the compiler that ships with Windows", () => {
    it("finds csc.exe and produces AITestingRunnerSetup.exe, a small Windows program (PE file, no console)", () => {
        expect(findCsc()).toMatch(/csc\.exe$/i);
        expect(exe.subarray(0, 2).toString("latin1")).toBe("MZ");
        const pe = exe.readUInt32LE(0x3c);
        expect(exe.subarray(pe, pe + 4).toString("latin1")).toBe("PE\0\0");
        const optional = pe + 24;
        expect([0x10b, 0x20b]).toContain(exe.readUInt16LE(optional));
        // Subsystem 2 = Windows GUI: no console window when it is double-clicked (the quiet switches attach to the console they were started from).
        expect(exe.readUInt16LE(optional + 68)).toBe(2);
        expect(exe.length).toBeLessThan(2 * 1024 * 1024);
        expect(exe.length).toBeGreaterThan(50 * 1024);
    });

    it("asks for no administrator rights, is DPI aware, uses UTF-8 and has a version and an icon", () => {
        const body = exe.toString("latin1");
        expect(body).toContain('requestedExecutionLevel level="asInvoker"');
        expect(body).not.toMatch(/requireAdministrator|highestAvailable/);
        expect(body).toContain("dpiAware");
        expect(body).toContain("UTF-8");
        expect(body).toContain("AI Testing Runner setup");
        // The icon frames are plain bitmaps; find the 64 pixel header (40 byte header, width 64, height 128, 1 plane, 32 bits).
        const header = Buffer.alloc(16);
        header.writeUInt32LE(40, 0);
        header.writeInt32LE(64, 4);
        header.writeInt32LE(128, 8);
        header.writeUInt16LE(1, 12);
        header.writeUInt16LE(32, 14);
        expect(exe.includes(header)).toBe(true);
        const ico = makeIcon() as Buffer;
        expect(ico.readUInt16LE(2)).toBe(1);
        expect(ico.readUInt16LE(4)).toBe(5);
    });

    it("carries no path of this computer and no secret", () => {
        const body = exe.toString("latin1");
        const home = [ROOT, ROOT.replaceAll("\\", "/"), process.env.USERPROFILE ?? "", os.homedir()].filter((s) => s.length > 6);
        for (const h of home) expect(body.includes(h), h).toBe(false);
        for (const needle of ["aitg_", "ANTHROPIC_API_KEY", "SECRET_BOX_KEY"]) expect(body.includes(needle), needle).toBe(false);
    });

    it("is written in C# 5 only, and every source file the build uses exists", () => {
        for (const f of SOURCES as string[]) {
            const text = fs.readFileSync(path.join(ROOT, "installer", "win", f), "utf8");
            // The compiler would refuse these; this names the rule so a later edit fails for a reason a person can read.
            expect(text, `${f} uses an interpolated string`).not.toMatch(/[\s(=,]\$@?"/);
            expect(text, `${f} uses ?.`).not.toMatch(/\w\?\.\w/);
            expect(text, `${f} uses nameof`).not.toMatch(/\bnameof\(/);
        }
    });

    it("says it cannot build, in plain words, when csc.exe is missing", () => {
        expect(findCsc({ CSC_PATH: "" })).toBeUndefined();
        expect(findCsc({ CSC_PATH: path.join(tmp, "nope", "csc.exe") })).toBeUndefined();
        try {
            buildInstallerWin({ outDir: path.join(tmp, "none"), env: { ...process.env, CSC_PATH: path.join(tmp, "nope", "csc.exe") } });
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as { code?: string }).code).toBe("NO_CSC");
            expect((e as Error).message).toBe(NO_CSC_MESSAGE);
            expect(NO_CSC_MESSAGE).toMatch(/csc\.exe/);
            expect(NO_CSC_MESSAGE).toMatch(/npm run build:installer/);
        }
    });

    it("a source file that does not compile fails with the compiler's message, not a stack trace", () => {
        const fake = path.join(tmp, "broken-root");
        fs.cpSync(path.join(ROOT, "installer"), path.join(fake, "installer"), { recursive: true });
        fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ version: "1.2.3" }));
        fs.appendFileSync(path.join(fake, "installer", "win", "Common.cs"), "\nclass Oops { int x = ; }\n");
        expect(() => buildInstallerWin({ root: fake, outDir: path.join(tmp, "broken-out") })).toThrow(/did not compile[\s\S]*error CS/);
    });
});

describe("dist/installer/manifest.json", () => {
    it.skipIf(!HAS_CSC)("lists the Windows program with its mode and checksum, and says plainly that the Mac app is missing", () => {
        const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
        expect(m.format).toBe(1);
        expect(m.platformVersion).toBe("9.9.9");
        expect(m.windows.available).toBe(true);
        expect(m.windows.files).toEqual([{ path: `win/${EXE_NAME}`, mode: 0o755, sha256: sha(exe), bytes: exe.length }]);
        expect(m.mac).toMatchObject({ available: false, reason: MAC_MISSING });
    });

    it("merges the Mac app's list (decimal modes, paths relative to mac/) and re-hashes the files itself", () => {
        const dir = path.join(tmp, "merge");
        const app = "AI Testing Runner.app";
        const files: Array<[string, string, number]> = [
            [`${app}/Contents/Info.plist`, "<plist/>", 0o644],
            [`${app}/Contents/MacOS/AITestingRunner`, "#!/bin/sh\n", 0o755],
        ];
        for (const [rel, body] of files) {
            fs.mkdirSync(path.dirname(path.join(dir, "mac", rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, "mac", rel), body);
        }
        fs.writeFileSync(path.join(dir, "mac", "manifest-part.json"), JSON.stringify({ version: 1, entries: files.map(([p, b, m]) => ({ path: p, mode: m, sha256: sha(Buffer.from(b)) })) }));
        const m = writeManifest({ outDir: dir });
        expect(m.windows).toMatchObject({ available: false, reason: WINDOWS_MISSING });
        expect(m.mac.available).toBe(true);
        expect(m.mac.files.map((f: { path: string; mode: number }) => [f.path, f.mode])).toEqual([
            [`mac/${app}/Contents/Info.plist`, 420],
            [`mac/${app}/Contents/MacOS/AITestingRunner`, 493],
        ]);
        // A part whose files do not match its own checksums, or that names a path outside the app, is refused rather than served.
        fs.writeFileSync(path.join(dir, "mac", app, "Contents", "Info.plist"), "tampered");
        expect(writeManifest({ outDir: dir }).mac).toMatchObject({ available: false });
        fs.writeFileSync(path.join(dir, "mac", "manifest-part.json"), JSON.stringify({ version: 1, entries: [{ path: "../../secret.txt", mode: 420, sha256: "0".repeat(64) }] }));
        const refused = writeManifest({ outDir: dir });
        expect(refused.mac.available).toBe(false);
        expect(refused.mac.reason).toMatch(/outside the app/);
    });

    it("build:installer without csc.exe leaves the Windows part out with the reason, instead of failing", async () => {
        const saved = process.env.CSC_PATH;
        process.env.CSC_PATH = path.join(tmp, "nope", "csc.exe");
        try {
            const r = await buildInstaller({ outDir: path.join(tmp, "nocsc"), skipMac: true });
            expect(r.manifest.windows).toMatchObject({ available: false });
            expect(r.notes.join(" ")).toMatch(/csc\.exe/);
        } finally {
            if (saved === undefined) delete process.env.CSC_PATH;
            else process.env.CSC_PATH = saved;
        }
    });
});

describe("the platform's loader", () => {
    it("says what is missing when nothing was built, and what is damaged when a file does not match", () => {
        const none = loadInstaller(path.join(tmp, "empty"));
        expect(none.windows).toEqual({ ok: false, reason: WINDOWS_MISSING });
        expect(none.mac).toEqual({ ok: false, reason: MAC_MISSING });
        expect(installerInfo(none)).toEqual({ windows: false, mac: false, reasons: { windows: WINDOWS_MISSING, mac: MAC_MISSING } });
        const dir = path.join(tmp, "damaged");
        fs.mkdirSync(path.join(dir, "win"), { recursive: true });
        fs.writeFileSync(path.join(dir, "win", EXE_NAME), "not the program");
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: 1, windows: { available: true, files: [{ path: `win/${EXE_NAME}`, mode: 493, sha256: "a".repeat(64) }] } }));
        const bad = loadInstaller(dir);
        expect(bad.windows).toMatchObject({ ok: false });
        expect((bad.windows as { reason: string }).reason).toMatch(/damaged/);
        fs.writeFileSync(path.join(dir, "manifest.json"), "{ not json");
        expect((loadInstaller(dir).windows as { reason: string }).reason).toMatch(/damaged/);
    });

    it("refuses a manifest that names a path outside the installer folder", () => {
        const dir = path.join(tmp, "traversal");
        fs.mkdirSync(path.join(dir, "win"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "outside.exe"), "x");
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: 1, windows: { available: true, files: [{ path: "win/../../outside.exe", mode: 493, sha256: sha(Buffer.from("x")) }] } }));
        expect(loadInstaller(dir).windows).toMatchObject({ ok: false });
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: 1, windows: { available: true, files: [{ path: "/etc/passwd", mode: 493, sha256: sha(Buffer.from("x")) }] } }));
        expect(loadInstaller(dir).windows).toMatchObject({ ok: false });
    });

    it.skipIf(!HAS_CSC)("loads the real build: the program with mode 0755, and a tampered copy is refused", () => {
        const ok = loadInstaller(out);
        expect(ok.windows.ok).toBe(true);
        const files = (ok.windows as { files: Array<{ name: string; mode: number; data: Uint8Array }> }).files;
        expect(files.map((f) => [f.name, f.mode])).toEqual([[EXE_NAME, 0o755]]);
        expect(sha(files[0]!.data)).toBe(sha(exe));
        expect(installerInfo(ok)).toMatchObject({ windows: true, mac: false });
        fs.appendFileSync(path.join(out, "win", EXE_NAME), "x");
        try {
            expect((loadInstaller(out).windows as { reason: string }).reason).toMatch(/damaged/);
        } finally {
            fs.writeFileSync(path.join(out, "win", EXE_NAME), exe);
        }
    });
});
