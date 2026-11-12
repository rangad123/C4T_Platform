/**
 * The runner installer, platform side: the zip a person downloads on Windows or a Mac from Settings, Your runner (round 45: the one
 * download for those systems; see docs/features/runner-installer.md).
 *
 * The programs inside are prebuilt by `npm run build:installer` into dist/installer/ (git-ignored): the Windows setup program
 * (`win/AITestingRunnerSetup.exe`, built with the C# compiler that ships with Windows) and the macOS app (`mac/AI Testing Runner.app/...`,
 * plain files with Unix modes). `dist/installer/manifest.json` lists every file with its mode and checksum; this module reads only
 * what the manifest names, verifies every checksum, and puts them in a zip next to the same runner bundle, `runner.json` and
 * `runner.enroll` (a single-use enrollment code) a files kit holds. Nothing from the server's environment, `.env`, database or data folder is ever read.
 *
 * Windows (round 49): the download is the setup program itself with the kit appended (buildInstallerExe); a signed exe gets the zip.
 *
 * If the installer was not built (or the part for the chosen system is missing or damaged) the caller falls back to the files kit and says so.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zipSync, type Zippable } from "fflate";
import { z } from "zod";
import { REPO_ROOT } from "../config.js";
import { NODE_MIN_MAJOR, withLineEnding, type KitPlatform } from "./runner-kit-scripts.js";
import { CHECK_FILES } from "./runner-check-scripts.js";
import { KIT_SLUG, kitCredentialFile, type Bundle } from "./runner-kit.js";

export type KitKind = "installer" | "files";

/** Where the prebuilt installers live: dist/installer next to the code, or RUNNER_INSTALLER_DIR (built on another computer and copied over, or tests). */
export const installerDir = (env: NodeJS.ProcessEnv = process.env): string => (env.RUNNER_INSTALLER_DIR?.trim() ? path.resolve(env.RUNNER_INSTALLER_DIR.trim()) : path.join(REPO_ROOT, "dist", "installer"));

export const WINDOWS_MISSING = "The Windows installer has not been built on this server. Build it on a Windows computer with `npm run build:installer`, then copy dist/installer/ to this server (or point RUNNER_INSTALLER_DIR at it).";
export const MAC_MISSING = "The Mac installer has not been built on this server. Run `npm run build:installer`.";
const DAMAGED = (system: string) => `The ${system} installer on this server is damaged. Run \`npm run build:installer\` again.`;

// ── the manifest ────────────────────────────────────────────────────────────

/** A path inside dist/installer: relative, forward slashes, no `..`, spaces allowed (the Mac app is called "AI Testing Runner.app"). */
const RelPath = z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9 ._()+-]+(\/[A-Za-z0-9 ._()+-]+)*$/)
    .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), "no dot segments");

const FileEntry = z.object({
    path: RelPath,
    /** The Unix mode as a decimal number (493 is 0755). */
    mode: z.number().int().min(0).max(0o777),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().min(0).optional(),
});

const Part = z.object({ available: z.boolean(), reason: z.string().max(600).optional(), files: z.array(FileEntry).max(200).default([]) });

const InstallerManifest = z.object({
    format: z.literal(1),
    builtAt: z.string().max(40).optional(),
    windows: Part.optional(),
    mac: Part.optional(),
});
export type InstallerManifest = z.infer<typeof InstallerManifest>;

export interface InstallerFile {
    /** Path inside the kit folder (the `win/` or `mac/` prefix removed). */
    name: string;
    mode: number;
    data: Uint8Array;
}

export type InstallerPart = { ok: true; files: InstallerFile[] } | { ok: false; reason: string };

export interface LoadedInstaller {
    windows: InstallerPart;
    mac: InstallerPart;
}

/** A file larger than this is not what the build produces (the Windows program is about 130 KB). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PART_BYTES = 40 * 1024 * 1024;

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function loadPart(dir: string, part: z.infer<typeof Part> | undefined, prefix: "win" | "mac", system: string, missing: string, required: string): InstallerPart {
    if (!part) return { ok: false, reason: missing };
    if (!part.available) return { ok: false, reason: part.reason ?? missing };
    const files: InstallerFile[] = [];
    let total = 0;
    for (const f of part.files) {
        if (!f.path.startsWith(`${prefix}/`)) return { ok: false, reason: DAMAGED(system) };
        let bytes: Uint8Array;
        try {
            const abs = path.resolve(dir, ...f.path.split("/"));
            // The manifest is data from disk: whatever it names must stay inside the installer folder.
            if (!abs.startsWith(path.resolve(dir) + path.sep)) return { ok: false, reason: DAMAGED(system) };
            bytes = fs.readFileSync(abs);
        } catch {
            return { ok: false, reason: DAMAGED(system) };
        }
        total += bytes.length;
        if (bytes.length > MAX_FILE_BYTES || total > MAX_PART_BYTES || sha256(bytes) !== f.sha256) return { ok: false, reason: DAMAGED(system) };
        files.push({ name: f.path.slice(prefix.length + 1), mode: f.mode, data: bytes });
    }
    if (!files.some((f) => f.name === required)) return { ok: false, reason: DAMAGED(system) };
    return { ok: true, files };
}

/** Reads dist/installer and verifies every checksum, so a half-built or edited installer is never handed out. */
export function loadInstaller(dir: string = installerDir()): LoadedInstaller {
    let manifest: InstallerManifest;
    try {
        manifest = InstallerManifest.parse(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")));
    } catch (e) {
        const none = (e as NodeJS.ErrnoException)?.code === "ENOENT";
        return { windows: { ok: false, reason: none ? WINDOWS_MISSING : DAMAGED("Windows") }, mac: { ok: false, reason: none ? MAC_MISSING : DAMAGED("Mac") } };
    }
    return {
        windows: loadPart(dir, manifest.windows, "win", "Windows", WINDOWS_MISSING, "AITestingRunnerSetup.exe"),
        mac: loadPart(dir, manifest.mac, "mac", "Mac", MAC_MISSING, "AI Testing Runner.app/Contents/MacOS/AITestingRunner"),
    };
}

/** What the info route says about the installers. */
export function installerInfo(loaded: LoadedInstaller = loadInstaller()): { windows: boolean; mac: boolean; reasons: { windows?: string; mac?: string } } {
    return {
        windows: loaded.windows.ok,
        mac: loaded.mac.ok,
        reasons: { ...(loaded.windows.ok ? {} : { windows: loaded.windows.reason }), ...(loaded.mac.ok ? {} : { mac: loaded.mac.reason }) },
    };
}

// ── the zip ─────────────────────────────────────────────────────────────────

export const installerFolder = (platform: KitPlatform): string => `runner-${KIT_SLUG}-${platform === "windows" ? "windows" : "mac"}-setup`;
export const installerFileName = (platform: KitPlatform): string => `${installerFolder(platform)}.zip`;

export interface InstallerReadmeInput {
    platform: KitPlatform;
    /** Left out: the runner uses the computer's own name. */
    runnerName?: string;
    platformUrl: string;
    kitVersion: string;
}

const WINDOWS_STEPS = `1. Unzip this folder on the computer where your application can be reached (right-click the zip file, then Extract all).
2. Open the folder and double-click AITestingRunnerSetup.exe.
   Windows may say "Windows protected your PC" because the installer is not signed yet. Choose More info, then Run anyway.
3. The setup window checks what your computer already has and only downloads what is missing: Node.js and the test tools. You do not need to install anything first, and it does not need administrator rights. The runner itself uses Chrome or Edge from this computer, or downloads a browser once.
4. Choose Install and start. When the window says "The runner is running", Settings, Your runner in the platform shows this computer as connected, under the computer's own name. Your runs, schedules and sessions then use it by themselves. You can close the window: the runner keeps working in the background and has an icon in the notification area next to the clock.
5. Delete the zip file and this unzipped folder once the runner is online. Setup copies what it needs to your own folder (C:\\Users\\<you>\\AppData\\Local\\AITestingRunner). The file runner.enroll in this folder is a one-time code: it works once, within 30 minutes of the download, and the runner deletes it when it connects.

Later: open "AI Testing Runner" from the Start menu (if you left that box ticked) to see the runner again. Right-click the notification-area icon to stop the runner, open the platform, show the log or remove the runner from this computer.
Remove it completely: right-click the icon and choose "Remove this runner from the computer", or run AITestingRunnerSetup.exe --uninstall. That deletes only what Setup put in its own folder; a Node.js that was already on the computer and the shared browser cache stay.
To take this runner's access away, open Settings, Your runner in the platform and choose Remove this computer. The runner then stops with a message saying so. Setting up another computer does the same for this one: each person has one runner.

If Setup cannot find the runner files, open it from the folder you unzipped: that folder holds runner.mjs, runner.json and runner.enroll next to it.`;

const MAC_STEPS = `1. Unzip this folder on the Mac where your application can be reached (double-click the zip file).
2. Open the folder and double-click "AI Testing Runner".
   macOS will probably say it could not verify the app, because the app is not signed yet. On macOS 15 and newer: choose Done, open System Settings, Privacy & Security, scroll down to Security and choose Open Anyway, then sign in. On macOS 14 and older: right-click the app, choose Open, then Open. In Terminal you can instead run  xattr -dr com.apple.quarantine "AI Testing Runner.app"  once.
3. A Terminal window opens and shows what it checks: it only downloads what your Mac is missing (Node.js and the test tools). The runner itself uses Chrome or Edge from this Mac, or downloads a browser once. You do not need to install anything first, and it does not need an administrator password.
4. When it says the runner is connected, Settings, Your runner in the platform shows this Mac as connected, under the Mac's own name. Your runs, schedules and sessions then use it by themselves.
5. Delete the zip file and this unzipped folder once the runner is online. The file runner.enroll in this folder is a one-time code: it works once, within 30 minutes of the download, and the runner deletes it when it connects.

To take this runner's access away, open Settings, Your runner in the platform and choose Remove this computer. The runner then stops with a message saying so. Setting up another computer does the same for this one: each person has one runner.`;

export function installerReadme(i: InstallerReadmeInput): string {
    const steps = i.platform === "windows" ? WINDOWS_STEPS : MAC_STEPS;
    return `AI Testing Platform runner${i.runnerName ? ` "${i.runnerName}"` : ""}
Platform: ${i.platformUrl}
Kit version: ${i.kitVersion}

${steps}

You need nothing installed first; the installer looks for Node.js ${NODE_MIN_MAJOR} or newer and uses it if it is there.
If the runner does not connect: ${i.platform === "windows" ? "double-click check-computer.cmd in this folder" : "double-click check-computer.command in this folder (or run  sh check-computer.sh  in Terminal)"}. It checks the runner the installer set up (Node.js, its files, the browser, the proxy and certificates, the platform and the token, disk space, the clock) and says what to fix. The installer shows the same check when it finishes. It changes nothing and never shows the token.
Android tests also need the Android tools on this computer, and iOS tests a Mac with Xcode. See the platform's runner guide.
`;
}

/** `rwxr-xr-x`, `rw-r--r--` and `rw-------` as ZIP external attributes (the permission bits live in the high 16 bits; `*` avoids a negative 32-bit shift). */
const mode = (m: number): number => (0o100000 | m) * 65536;

export interface BuildInstallerInput {
    bundle: Extract<Bundle, { ok: true }>;
    part: Extract<InstallerPart, { ok: true }>;
    platform: KitPlatform;
    /** Left out: the runner uses the computer's own name (round 45). */
    runnerName?: string;
    platformUrl: string;
    /** The single-use enrollment code (aite_...), written as runner.enroll; every download carries one (round 39). See runner-kit.ts kitCredentialFile. */
    enrollCode?: string;
    /** The signed-update sequence of this server's runner files (runner-update.ts downloadSequence): a fresh download refuses older signed updates. */
    updateSequence?: number;
    /** @deprecated Test seam only (runner.token); the platform's routes never pass one. */
    token?: string;
}

/** What the zip holds, under one top folder. `oneFile`: only the kit Setup reads from its own end (no program, check scripts or README). */
function installerEntries(i: BuildInstallerInput, oneFile: boolean): Zippable {
    const dir = installerFolder(i.platform);
    const text = (s: string): Uint8Array => new TextEncoder().encode(s);
    const kitVersion = i.bundle.manifest.kitVersion;
    const entries: Zippable = {};
    const add = (name: string, data: Uint8Array, perm = 0o644): void => {
        entries[`${dir}/${name}`] = [data, { os: 3, attrs: mode(perm), level: 6 }];
    };
    // The installer program (or app) with the modes the build recorded.
    if (!oneFile) for (const f of i.part.files) add(f.name, f.data, f.mode);
    // The same runner bundle as a files kit: the exact prebuilt bytes.
    for (const name of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"]) add(name, i.bundle.files.get(name)!);
    // The test tools' lock file (from round 39 on): the start scripts and installers install from it with npm ci.
    const lock = i.bundle.files.get("package-lock.json");
    if (lock) add("package-lock.json", lock);
    // What belongs to this download.
    add("runner.json", text(`${JSON.stringify({ url: i.platformUrl, ...(i.runnerName ? { name: i.runnerName } : {}), kitVersion, ...(i.updateSequence !== undefined ? { updateSequence: i.updateSequence } : {}) }, null, 2)}\n`));
    const credential = kitCredentialFile(i);
    add(credential.name, text(credential.text), 0o600);
    if (oneFile) return entries;
    // "Check this computer" (docs/features/runner-check.md): checks the runner the installer set up; Setup runs the same check at its end.
    for (const f of CHECK_FILES) add(f.name, text(withLineEnding(f.text, f.eol)), 0o755);
    add("README.txt", text(withLineEnding(installerReadme({ platform: i.platform, ...(i.runnerName ? { runnerName: i.runnerName } : {}), platformUrl: i.platformUrl, kitVersion }), i.platform === "windows" ? "\r\n" : "\n")));
    return entries;
}

export function buildInstallerZip(i: BuildInstallerInput): Uint8Array {
    return zipSync(installerEntries(i, false));
}

// ── the one-file Windows download (round 49) ────────────────────────────────

export const WINDOWS_EXE_NAME = "AITestingRunnerSetup.exe";
/**
 * The trailer after the program: the kit as a zip (one top folder), then a 16-byte footer: the zip's length (uint32 LE), the format (uint32 LE)
 * and these 8 ASCII bytes. installer/win/Common.cs (Stamp) reads the same layout.
 */
export const STAMP_MAGIC = "AITP-KIT";
export const STAMP_FORMAT = 1;
export const STAMP_FOOTER_BYTES = 16;

/** Does this PE file carry an Authenticode signature (a non-empty certificate table, data directory 4)? Anything that is not a PE file says no. */
export function peSigned(exe: Uint8Array): boolean {
    const b = Buffer.from(exe.buffer, exe.byteOffset, exe.byteLength);
    if (b.length < 0x40 || b.toString("latin1", 0, 2) !== "MZ") return false;
    const pe = b.readUInt32LE(0x3c);
    if (pe + 24 + 2 > b.length || b.toString("latin1", pe, pe + 4) !== "PE\0\0") return false;
    const opt = pe + 24;
    const plus = b.readUInt16LE(opt) === 0x20b;
    const count = opt + (plus ? 108 : 92);
    const cert = opt + (plus ? 112 : 96) + 4 * 8;
    if (cert + 8 > b.length || b.readUInt32LE(count) <= 4) return false;
    return b.readUInt32LE(cert + 4) > 0;
}

/**
 * The Windows download as one program: the CI-built AITestingRunnerSetup.exe (the same bytes for everyone) with this download's kit appended
 * (runner files, runner.json, runner.enroll). Setup finds it at its own end, unpacks it privately and copies only the program part into the
 * install folder. Undefined when the exe is signed: bytes after an Authenticode signature break it, so the caller sends the zip.
 */
export function buildInstallerExe(i: BuildInstallerInput): Uint8Array | undefined {
    const exe = i.part.files.find((f) => f.name === WINDOWS_EXE_NAME)!.data;
    // shortcut: a signed exe gets the zip; when signing starts, put the kit inside the certificate table's padding instead (as Chrome's tagged installers do).
    if (peSigned(exe)) return undefined;
    const payload = zipSync(installerEntries(i, true));
    const footer = Buffer.alloc(STAMP_FOOTER_BYTES);
    footer.writeUInt32LE(payload.length, 0);
    footer.writeUInt32LE(STAMP_FORMAT, 4);
    footer.write(STAMP_MAGIC, 8, "latin1");
    return Buffer.concat([exe, payload, footer]);
}
