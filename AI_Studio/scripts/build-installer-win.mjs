// Builds the Windows installer program: installer/win/*.cs compiled with the C# compiler that ships with Windows (csc.exe, .NET Framework 4.8,
// language level C# 5) into dist/installer/win/AITestingRunnerSetup.exe. No .NET SDK, Visual Studio, NSIS or Inno Setup is needed.
//
//   node scripts/build-installer-win.mjs              writes dist/installer/win/
//   node scripts/build-installer-win.mjs --out <dir>  writes somewhere else (the tests do)
//
// The program is not signed. Windows SmartScreen shows "unknown publisher" the first time it runs; docs/features/runner-installer.md says what
// signing needs. The build refuses to finish if the exe holds a path of this computer.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXE_NAME = "AITestingRunnerSetup.exe";
export const SOURCES = ["Common.cs", "NodeFinder.cs", "Net.cs", "Engine.cs", "RunnerHost.cs", "Ui.cs", "Program.cs"];
const REFERENCES = ["System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll", "System.IO.Compression.dll", "System.IO.Compression.FileSystem.dll", "System.Web.Extensions.dll"];

/** Where csc.exe is, or undefined. CSC_PATH overrides (tests use it to prove the "not found" message). */
export function findCsc(env = process.env) {
    if (env.CSC_PATH !== undefined) return env.CSC_PATH && fs.existsSync(env.CSC_PATH) ? env.CSC_PATH : undefined;
    if (process.platform !== "win32") return undefined;
    const win = env.WINDIR || env.SystemRoot || "C:\\Windows";
    for (const dir of ["Framework64", "Framework"]) {
        const f = path.join(win, "Microsoft.NET", dir, "v4.0.30319", "csc.exe");
        if (fs.existsSync(f)) return f;
    }
    return undefined;
}

export const NO_CSC_MESSAGE =
    "The Windows installer was not built: csc.exe (the C# compiler that comes with Windows, in C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319) was not found. " +
    "Build it on a Windows computer with `npm run build:installer`, then copy dist/installer/ to the server (or point RUNNER_INSTALLER_DIR at it).";

// ── a simple icon, made from bytes (no image tools needed) ──────────────────

/** An .ico file with 16, 24, 32, 48 and 64 pixel frames: a teal rounded square with a white check mark. */
export function makeIcon() {
    const sizes = [16, 24, 32, 48, 64];
    const frames = sizes.map((n) => {
        const SS = 4;
        const px = Buffer.alloc(n * n * 4);
        const seg = (x, y, ax, ay, bx, by) => {
            const dx = bx - ax, dy = by - ay;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
            return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        };
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                let r = 0, g = 0, b = 0, a = 0;
                for (let sy = 0; sy < SS; sy++) {
                    for (let sx = 0; sx < SS; sx++) {
                        const u = (x + (sx + 0.5) / SS) / n, v = (y + (sy + 0.5) / SS) / n;
                        // rounded square, corner radius 0.22
                        const rad = 0.22;
                        const cx = Math.min(Math.max(u, rad), 1 - rad), cy = Math.min(Math.max(v, rad), 1 - rad);
                        if (Math.hypot(u - cx, v - cy) > rad) continue;
                        const check = Math.min(seg(u, v, 0.26, 0.53, 0.42, 0.69), seg(u, v, 0.42, 0.69, 0.75, 0.33)) < 0.065;
                        a += 255;
                        if (check) { r += 255; g += 255; b += 255; } else { r += 0x0b; g += 0x7a; b += 0x6e; }
                    }
                }
                const k = SS * SS;
                const o = ((n - 1 - y) * n + x) * 4; // bottom-up rows, BGRA
                const alpha = a / k;
                px[o] = alpha ? Math.round(b / (a / 255)) : 0;
                px[o + 1] = alpha ? Math.round(g / (a / 255)) : 0;
                px[o + 2] = alpha ? Math.round(r / (a / 255)) : 0;
                px[o + 3] = Math.round(alpha);
            }
        }
        const maskRow = Math.ceil(n / 32) * 4;
        const header = Buffer.alloc(40);
        header.writeUInt32LE(40, 0);
        header.writeInt32LE(n, 4);
        header.writeInt32LE(n * 2, 8);
        header.writeUInt16LE(1, 12);
        header.writeUInt16LE(32, 14);
        header.writeUInt32LE(px.length + maskRow * n, 20);
        return Buffer.concat([header, px, Buffer.alloc(maskRow * n)]);
    });
    const dir = Buffer.alloc(6 + 16 * sizes.length);
    dir.writeUInt16LE(1, 2);
    dir.writeUInt16LE(sizes.length, 4);
    let offset = dir.length;
    sizes.forEach((n, i) => {
        const e = 6 + i * 16;
        dir[e] = n;
        dir[e + 1] = n;
        dir.writeUInt16LE(1, e + 4);
        dir.writeUInt16LE(32, e + 6);
        dir.writeUInt32LE(frames[i].length, e + 8);
        dir.writeUInt32LE(offset, e + 12);
        offset += frames[i].length;
    });
    return Buffer.concat([dir, ...frames]);
}

// ── the build ───────────────────────────────────────────────────────────────

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** Compiles the program. Returns { exe, bytes, sha256 } or throws an Error whose message is plain. */
export function buildInstallerWin({ root = ROOT, outDir = path.join(root, "dist", "installer", "win"), log = () => {}, env = process.env } = {}) {
    const csc = findCsc(env);
    if (!csc) throw Object.assign(new Error(NO_CSC_MESSAGE), { code: "NO_CSC" });
    const src = path.join(root, "installer", "win");
    for (const f of [...SOURCES, "app.manifest"]) if (!fs.existsSync(path.join(src, f))) throw new Error(`installer/win/${f} is missing.`);
    fs.mkdirSync(outDir, { recursive: true });
    const work = fs.mkdtempSync(path.join(outDir, ".build-"));
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        const version = /^(\d+)\.(\d+)\.(\d+)/.exec(String(pkg.version ?? "0.0.0"));
        const four = version ? `${version[1]}.${version[2]}.${version[3]}.0` : "0.0.0.0";
        fs.writeFileSync(
            path.join(work, "AssemblyInfo.cs"),
            `using System.Reflection;\n[assembly: AssemblyTitle("AI Testing Runner setup")]\n[assembly: AssemblyProduct("AI Testing Platform")]\n[assembly: AssemblyCompany("AI Testing Platform")]\n[assembly: AssemblyDescription("Checks what is already installed, downloads what is missing and starts the AI Testing Platform runner.")]\n[assembly: AssemblyVersion("${four}")]\n[assembly: AssemblyFileVersion("${four}")]\n`,
        );
        const ico = path.join(work, "app.ico");
        fs.writeFileSync(ico, makeIcon());
        const exe = path.join(outDir, EXE_NAME);
        fs.rmSync(exe, { force: true });
        const args = [
            "/nologo", "/target:winexe", "/platform:anycpu", "/optimize+", "/debug-", "/warn:4", "/utf8output", "/codepage:65001",
            `/out:${exe}`, `/win32manifest:${path.join(src, "app.manifest")}`, `/win32icon:${ico}`,
            ...REFERENCES.map((r) => `/r:${r}`),
            ...SOURCES.map((f) => path.join(src, f)),
            path.join(work, "AssemblyInfo.cs"),
        ];
        log(`Compiling ${SOURCES.length} files with ${csc} ...`);
        const r = spawnSync(csc, args, { encoding: "utf8", windowsHide: true });
        if (r.status !== 0 || !fs.existsSync(exe)) {
            const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split(/\r?\n/).slice(0, 25).join("\n");
            throw new Error(`The Windows installer did not compile:\n${text}`);
        }
        const bytes = fs.readFileSync(exe);
        // The program must not carry this computer's folder names.
        const text = bytes.toString("latin1");
        const home = [root, root.replaceAll("\\", "/"), env.USERPROFILE, env.HOME].filter((s) => s && s.length > 6);
        const hit = home.find((h) => text.includes(h));
        if (hit) throw new Error(`The installer contains a path of this computer (${hit.slice(0, 3)}...). It must not.`);
        log(`Done: ${EXE_NAME}, ${bytes.length} bytes.`);
        return { exe, bytes: bytes.length, sha256: sha256(bytes) };
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf("--out");
    const outDir = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : undefined;
    try {
        buildInstallerWin({ ...(outDir ? { outDir } : {}), log: (l) => console.log(l) });
    } catch (e) {
        console.error(`build:installer (Windows) failed: ${e instanceof Error ? e.message : e}`);
        process.exit(e && e.code === "NO_CSC" ? 3 : 1);
    }
}
