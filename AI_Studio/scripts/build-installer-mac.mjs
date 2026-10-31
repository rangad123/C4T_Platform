// Builds "AI Testing Runner.app" as plain files (it can be produced on any system) and writes the list of files the platform adds to the
// runner kit zip.
//
//   node scripts/build-installer-mac.mjs [--out DIR] [--dmg]
//
// Output (default DIR = dist/installer/mac):
//   AI Testing Runner.app/Contents/{Info.plist, MacOS/AITestingRunner, Resources/runner-setup.sh, Resources/README.txt}
//   manifest-part.json   { "version": 1, "entries": [ { "path": "AI Testing Runner.app/...", "mode": 493, "sha256": "..." } ] }
// Paths are relative to DIR; modes are decimal Unix modes (493 = 0755, 420 = 0644). Every file is written with LF line ends: a shell
// script with CRLF does not run on a Mac.
//
// --dmg builds a disk image with scripts/make-dmg.sh. That needs macOS (hdiutil); on any other system it says so and does nothing.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "installer", "mac", "app");
export const APP_NAME = "AI Testing Runner.app";
export const DEFAULT_OUT = path.join(ROOT, "dist", "installer", "mac");

const EXECUTABLE = 0o755;
const PLAIN = 0o644;
/** Files that must be runnable; everything else is a plain file. */
const EXECUTABLES = new Set(["Contents/MacOS/AITestingRunner", "Contents/Resources/runner-setup.sh"]);
/** Files whose text is shell or XML: converted to LF. */
const TEXT = /\.(sh|plist|txt)$|AITestingRunner$/;

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function listFiles(dir, base = dir) {
    const out = [];
    for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) out.push(...listFiles(full, base));
        else out.push(path.relative(base, full).split(path.sep).join("/"));
    }
    return out;
}

export function buildInstallerMac({ outDir = DEFAULT_OUT, version, log = () => {} } = {}) {
    const pkgVersion = version ?? JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    const appDir = path.join(outDir, APP_NAME);
    // Only the app folder and the manifest this script wrote are replaced.
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(path.join(outDir, "manifest-part.json"), { force: true });

    const entries = [];
    for (const rel of listFiles(SOURCE)) {
        let bytes = fs.readFileSync(path.join(SOURCE, rel));
        if (TEXT.test(rel)) {
            let text = bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/^﻿/, "");
            if (rel === "Contents/Info.plist") text = text.replaceAll("@VERSION@", pkgVersion);
            if (text.includes("\r")) throw new Error(`${rel} still has a carriage return after conversion.`);
            bytes = Buffer.from(text, "utf8");
        }
        const mode = EXECUTABLES.has(rel) ? EXECUTABLE : PLAIN;
        const dest = path.join(appDir, ...rel.split("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes, { mode });
        try {
            fs.chmodSync(dest, mode);
        } catch {
            /* Windows has no Unix modes; the manifest below is what carries them */
        }
        entries.push({ path: `${APP_NAME}/${rel}`, mode, sha256: sha256(bytes) });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const required of ["Contents/Info.plist", "Contents/MacOS/AITestingRunner", "Contents/Resources/runner-setup.sh", "Contents/Resources/README.txt"]) {
        if (!entries.some((e) => e.path === `${APP_NAME}/${required}`)) throw new Error(`The app is missing ${required}.`);
    }
    fs.writeFileSync(path.join(outDir, "manifest-part.json"), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
    log(`Built ${APP_NAME} (${entries.length} files, version ${pkgVersion}) in ${outDir}`);
    return { appDir, entries, version: pkgVersion };
}

/** Build the .dmg; only on macOS. Returns "built", or a plain reason it was not. */
export function buildDmg({ outDir = DEFAULT_OUT, log = () => {} } = {}) {
    const uname = spawnSync("uname", ["-s"], { encoding: "utf8" });
    if (uname.status !== 0 || uname.stdout.trim() !== "Darwin") {
        const why = "A .dmg can only be built on macOS (it needs hdiutil). The zipped .app the platform serves does not need it. Run  node scripts/build-installer-mac.mjs --dmg  on a Mac.";
        log(why);
        return why;
    }
    const r = spawnSync("sh", [path.join(ROOT, "scripts", "make-dmg.sh"), path.join(outDir, APP_NAME), path.join(outDir, "AI-Testing-Runner.dmg")], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("make-dmg.sh failed.");
    return "built";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf("--out");
    const outDir = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : DEFAULT_OUT;
    try {
        buildInstallerMac({ outDir, log: (l) => console.log(l) });
        if (process.argv.includes("--dmg")) buildDmg({ outDir, log: (l) => console.log(l) });
    } catch (e) {
        console.error(`build:installer-mac failed: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
    }
}
