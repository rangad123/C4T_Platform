// Builds the runner installers the platform serves (Setup, Runners, Add a runner, "Installer"):
//
//   npm run build:installer                       Windows program (needs csc.exe, so a Windows computer) + the Mac app (plain files, any computer)
//   npm run build:installer -- --skip-windows     skip the Windows program (what the Linux Docker image does)
//   npm run build:installer -- --windows-exe <f>  use a Windows program that was built elsewhere instead of compiling one
//
// Output: dist/installer/ (git-ignored; never commit it):
//   win/AITestingRunnerSetup.exe
//   mac/AI Testing Runner.app/...   (written by scripts/build-installer-mac.mjs, with mac/manifest-part.json)
//   manifest.json                   every file with its Unix mode and SHA-256; the platform reads only what this names and verifies the hashes
//
// A part that cannot be built here is left out and the manifest says why in plain words, so the platform offers the plain files kit for it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstallerWin, EXE_NAME, NO_CSC_MESSAGE } from "./build-installer-win.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const REASON_WINDOWS = "The Windows installer has not been built on this server. Build it on a Windows computer with `npm run build:installer`, then copy dist/installer/ to this server (or point RUNNER_INSTALLER_DIR at it).";
const REASON_MAC = "The Mac installer has not been built on this server. Run `npm run build:installer`.";

/** Reads what is in `outDir` and writes manifest.json. Returns the manifest. */
export function writeManifest({ outDir, platformVersion = "0.0.0", log = () => {} }) {
    const manifest = { format: 1, builtAt: new Date().toISOString(), platformVersion };
    // Windows: the one program.
    const exe = path.join(outDir, "win", EXE_NAME);
    if (fs.existsSync(exe)) {
        const bytes = fs.readFileSync(exe);
        manifest.windows = { available: true, files: [{ path: `win/${EXE_NAME}`, mode: 0o755, sha256: sha256(bytes), bytes: bytes.length }] };
    } else manifest.windows = { available: false, reason: REASON_WINDOWS, files: [] };
    // Mac: whatever scripts/build-installer-mac.mjs listed, re-hashed from the files themselves.
    const partFile = path.join(outDir, "mac", "manifest-part.json");
    if (fs.existsSync(partFile)) {
        try {
            const part = JSON.parse(fs.readFileSync(partFile, "utf8"));
            if (part.version !== 1 || !Array.isArray(part.entries) || part.entries.length === 0) throw new Error("manifest-part.json is not in the expected format");
            const files = part.entries.map((e) => {
                const rel = String(e.path);
                if (rel.startsWith("/") || rel.split("/").includes("..")) throw new Error(`manifest-part.json names a path outside the app: ${rel}`);
                const bytes = fs.readFileSync(path.join(outDir, "mac", ...rel.split("/")));
                const actual = sha256(bytes);
                if (e.sha256 && e.sha256 !== actual) throw new Error(`${rel} does not match the checksum in manifest-part.json`);
                return { path: `mac/${rel}`, mode: Number(e.mode) & 0o777, sha256: actual, bytes: bytes.length };
            });
            manifest.mac = { available: true, files };
        } catch (e) {
            manifest.mac = { available: false, reason: `The Mac installer on this server is damaged (${e instanceof Error ? e.message : e}). Run \`npm run build:installer\` again.`, files: [] };
        }
    } else manifest.mac = { available: false, reason: REASON_MAC, files: [] };
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`manifest.json: Windows ${manifest.windows.available ? "yes" : "no"}, Mac ${manifest.mac.available ? "yes" : "no"}.`);
    return manifest;
}

export async function buildInstaller({ root = ROOT, outDir = path.join(root, "dist", "installer"), skipWindows = false, skipMac = false, windowsExe, log = () => {} } = {}) {
    const platformVersion = String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "0.0.0");
    fs.mkdirSync(outDir, { recursive: true });
    const notes = [];

    // Windows
    if (windowsExe) {
        const src = path.resolve(windowsExe);
        if (!fs.existsSync(src)) throw new Error(`--windows-exe ${windowsExe} does not exist.`);
        fs.mkdirSync(path.join(outDir, "win"), { recursive: true });
        fs.copyFileSync(src, path.join(outDir, "win", EXE_NAME));
        log(`Windows: using the program built elsewhere (${windowsExe}).`);
    } else if (skipWindows) {
        notes.push("Windows: skipped (--skip-windows). An existing win/ folder is kept.");
    } else {
        try {
            buildInstallerWin({ root, outDir: path.join(outDir, "win"), log });
        } catch (e) {
            if (e && e.code === "NO_CSC") notes.push(`Windows: ${NO_CSC_MESSAGE}`);
            else throw e;
        }
    }

    // Mac (plain files, written by INST-B's script)
    const macScript = path.join(root, "scripts", "build-installer-mac.mjs");
    if (skipMac) notes.push("Mac: skipped (--skip-mac). An existing mac/ folder is kept.");
    else if (!fs.existsSync(macScript)) notes.push("Mac: scripts/build-installer-mac.mjs was not found, so no Mac installer was built.");
    else {
        log("Building the Mac app ...");
        const r = spawnSync(process.execPath, [macScript, "--out", path.join(outDir, "mac")], { cwd: root, encoding: "utf8", windowsHide: true });
        if (r.status !== 0) notes.push(`Mac: the Mac installer did not build (${`${r.stderr || r.stdout || ""}`.trim().split(/\r?\n/).slice(-3).join(" ")}).`);
        else if (r.stdout) log(r.stdout.trim());
    }

    const manifest = writeManifest({ outDir, platformVersion, log });
    for (const n of notes) log(n);
    return { manifest, notes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const value = (flag) => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    buildInstaller({ skipWindows: argv.includes("--skip-windows"), skipMac: argv.includes("--skip-mac"), windowsExe: value("--windows-exe"), log: (l) => console.log(l) })
        .then(({ manifest }) => {
            if (!manifest.windows.available && !manifest.mac.available) console.log("Nothing was built: the platform will offer the plain files kit only.");
        })
        .catch((e) => {
            console.error(`build:installer failed: ${e instanceof Error ? e.message : e}`);
            process.exit(1);
        });
}
