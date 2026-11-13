/**
 * The COMPLETE runner download, platform side: a zip that already holds its own Node.js and every pinned package for one system and
 * processor, so the first start downloads nothing (see docs/features/runner-complete-kit.md). Since round 45 it is not a choice: the one
 * download of a system (routes/runner-kits.ts) is built this way, with the installer inside, whenever this server has built it.
 *
 * `npm run build:runner -- --complete` writes dist/runner-complete/<target>/: pack.bin (every file already compressed, one after another)
 * and manifest.json (each file's path, mode, sizes, CRC-32, SHA-256 and offset, and the SHA-256 of the whole pack). A download is a zip
 * streamed from those bytes, with the small files that belong to this download (runner.json, runner.token, the start scripts, the README
 * and the prebuilt runner programs) compressed on the spot. Nothing is compressed per download for the big part, and the zip is never
 * held in memory as a whole.
 *
 * As with the plain kit, nothing is read from the server's environment, `.env`, database or data folder: only the prebuilt files, the
 * project name, what the person typed and the token created for this download.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { z } from "zod";
import { REPO_ROOT } from "../config.js";
import type { InstallerPart } from "./runner-installer.js";
import { linuxScript } from "./runner-linux-script.js";
import { KIT_SLUG, kitCredentialFile, type Bundle } from "./runner-kit.js";
import { readme, START_CMD, START_COMMAND, START_SH, withLineEnding } from "./runner-kit-scripts.js";
import { CHECK_FILES } from "./runner-check-scripts.js";

export const COMPLETE_TARGETS = ["win-x64", "win-arm64", "mac-arm64", "mac-x64", "linux-x64", "linux-arm64"] as const;
export type CompleteTarget = (typeof COMPLETE_TARGETS)[number];
export type CompleteOs = "windows" | "mac" | "linux";
export type CompleteArch = "x64" | "arm64";

export const targetOf = (os: CompleteOs, arch: CompleteArch): CompleteTarget => `${os === "windows" ? "win" : os}-${arch}` as CompleteTarget;

/** Plain words for each target, as the panel and the README say them. */
export const TARGET_WORDS: Record<CompleteTarget, string> = {
    "win-x64": "Windows on an Intel or AMD processor",
    "win-arm64": "Windows on an ARM processor",
    "mac-arm64": "a Mac with an Apple chip",
    "mac-x64": "a Mac with an Intel processor",
    "linux-x64": "Linux on an Intel or AMD processor",
    "linux-arm64": "Linux on an ARM processor",
};

/** Where the complete builds live: dist/runner-complete next to the code, or RUNNER_COMPLETE_DIR (tests, or a build copied from elsewhere). */
export const completeDir = (env: NodeJS.ProcessEnv = process.env): string =>
    env.RUNNER_COMPLETE_DIR?.trim() ? path.resolve(env.RUNNER_COMPLETE_DIR.trim()) : path.join(REPO_ROOT, "dist", "runner-complete");

export const completeBuildHint = (target: CompleteTarget): string =>
    `The complete download for ${TARGET_WORDS[target]} has not been built on this server. Run \`npm run build:runner -- --complete --targets ${target}\` (it needs the internet once, to fetch Node.js), or choose another way to set up the runner.`;
const DAMAGED = (target: CompleteTarget): string => `The complete download for ${TARGET_WORDS[target]} on this server is damaged. Run \`npm run build:runner -- --complete --targets ${target}\` again.`;
const STALE = (target: CompleteTarget): string =>
    `The complete download for ${TARGET_WORDS[target]} was built for other test tool versions than this platform's runner. Run \`npm run build:runner -- --complete --targets ${target}\` again.`;

/** Caps (stated in the doc). The build stays far below them; anything above is not what it produces, so it is never handed out. */
export const MAX_COMPLETE_PACK_BYTES = 400 * 1024 * 1024;
export const MAX_COMPLETE_FILES = 60_000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
/** Complete downloads streaming at once, for the whole server. Each reads ~60 to 70 MB from disk; more at once would only slow all of them. */
export const MAX_COMPLETE_AT_ONCE = 3;

/** A path inside the kit folder: relative, forward slashes, no dot segments, printable ASCII only. */
const RelPath = z
    .string()
    .min(1)
    .max(400)
    .regex(/^[\x21-\x7e ]+$/)
    .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === "" || s === "." || s === ".."), "not a plain relative path");

const FileEntry = z.object({
    path: RelPath,
    mode: z.number().int().min(0).max(0o777),
    size: z.number().int().min(0).max(0xffffffff),
    csize: z.number().int().min(0).max(0xffffffff),
    crc: z.number().int().min(0).max(0xffffffff),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    offset: z.number().int().min(0),
});

const CompleteManifest = z.object({
    format: z.literal(1),
    target: z.enum(COMPLETE_TARGETS),
    nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
    packageJsonSha256: z.string().regex(/^[0-9a-f]{64}$/),
    builtAt: z.string().max(40).optional(),
    dosTime: z.number().int().min(0).max(0xffff),
    dosDate: z.number().int().min(0).max(0xffff),
    packBytes: z.number().int().min(1).max(MAX_COMPLETE_PACK_BYTES),
    packSha256: z.string().regex(/^[0-9a-f]{64}$/),
    unpackedBytes: z.number().int().min(0),
    packages: z.record(z.string(), z.string()).default({}),
    leftOut: z.array(z.object({ name: z.string().max(200), reason: z.string().max(2000) })).default([]),
    notes: z.array(z.string().max(2000)).default([]),
    files: z.array(FileEntry).min(1).max(MAX_COMPLETE_FILES),
});
export type CompleteManifest = z.infer<typeof CompleteManifest>;

export type CompleteBuild = { ok: true; target: CompleteTarget; manifest: CompleteManifest; packPath: string } | { ok: false; target: CompleteTarget; reason: string };

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Checking a 60 MB pack takes a moment; a pack is checked again only when its file changes (size or time). */
const verified = new Map<string, string>();

function hashFile(file: string): string {
    const h = createHash("sha256");
    const fd = fs.openSync(file, "r");
    try {
        const buf = Buffer.allocUnsafe(1024 * 1024);
        for (;;) {
            const n = fs.readSync(fd, buf, 0, buf.length, null);
            if (n <= 0) break;
            h.update(buf.subarray(0, n));
        }
    } finally {
        fs.closeSync(fd);
    }
    return h.digest("hex");
}

/**
 * One target's build, checked: the manifest parses, the files sit end to end in the pack and nowhere else, the pack's checksum matches,
 * and it was built for the same pinned packages as the runner bundle that goes next to it (the bundle's package.json).
 */
export function loadComplete(target: CompleteTarget, bundle: Extract<Bundle, { ok: true }>, dir: string = completeDir()): CompleteBuild {
    const base = path.join(dir, target);
    let manifest: CompleteManifest;
    try {
        const file = path.join(base, "manifest.json");
        if (fs.statSync(file).size > MAX_MANIFEST_BYTES) return { ok: false, target, reason: DAMAGED(target) };
        manifest = CompleteManifest.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (e) {
        const missing = (e as NodeJS.ErrnoException)?.code === "ENOENT";
        return { ok: false, target, reason: missing ? completeBuildHint(target) : DAMAGED(target) };
    }
    if (manifest.target !== target) return { ok: false, target, reason: DAMAGED(target) };
    const pkg = bundle.files.get("package.json");
    if (!pkg || sha256(pkg) !== manifest.packageJsonSha256) return { ok: false, target, reason: STALE(target) };
    let at = 0;
    const names = new Set<string>();
    for (const f of manifest.files) {
        if (f.offset !== at || names.has(f.path)) return { ok: false, target, reason: DAMAGED(target) };
        names.add(f.path);
        at += f.csize;
    }
    if (at !== manifest.packBytes || !names.has("complete-kit.json") || !names.has("node_modules/.aitp-complete")) return { ok: false, target, reason: DAMAGED(target) };
    if (!names.has(target.startsWith("win") ? "node/node.exe" : "node/bin/node")) return { ok: false, target, reason: DAMAGED(target) };
    const packPath = path.join(base, "pack.bin");
    let stat: fs.Stats;
    try {
        stat = fs.statSync(packPath);
    } catch {
        return { ok: false, target, reason: DAMAGED(target) };
    }
    if (stat.size !== manifest.packBytes) return { ok: false, target, reason: DAMAGED(target) };
    const key = `${packPath}|${stat.size}|${stat.mtimeMs}`;
    if (verified.get(key) !== manifest.packSha256) {
        if (hashFile(packPath) !== manifest.packSha256) return { ok: false, target, reason: DAMAGED(target) };
        verified.set(key, manifest.packSha256);
    }
    return { ok: true, target, manifest, packPath };
}

// ── the zip ─────────────────────────────────────────────────────────────────

export const completeFolder = (target: CompleteTarget): string => `runner-${KIT_SLUG}-${target}`;
export const completeFileName = (target: CompleteTarget): string => `${completeFolder(target)}.zip`;

interface ZipEntry extends Omit<PackedFile, "name"> {
    name: Buffer;
    localOffset: number;
}

const FLAG_UTF8 = 0x0800;
const MADE_BY_UNIX = (3 << 8) | 20;

function localHeader(e: ZipEntry, time: number, date: number): Buffer {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(FLAG_UTF8, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.csize, 18);
    h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(e.name.length, 26);
    h.writeUInt16LE(0, 28);
    return Buffer.concat([h, e.name]);
}

function centralHeader(e: ZipEntry, time: number, date: number): Buffer {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(MADE_BY_UNIX, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(FLAG_UTF8, 8);
    h.writeUInt16LE(8, 10);
    h.writeUInt16LE(time, 12);
    h.writeUInt16LE(date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.csize, 20);
    h.writeUInt32LE(e.size, 24);
    h.writeUInt16LE(e.name.length, 28);
    // extra, comment, disk number, internal attributes: all 0
    // The Unix permission bits (with "regular file") live in the high 16 bits of the external attributes; `*` avoids a negative 32-bit shift.
    h.writeUInt32LE((0o100000 | e.mode) * 65536, 38);
    h.writeUInt32LE(e.localOffset, 42);
    return Buffer.concat([h, e.name]);
}

export interface BuildCompleteInput {
    bundle: Extract<Bundle, { ok: true }>;
    /** The complete build (own Node.js and test tools). Left out: only the runner files (the plain Mac app or the plain Linux script). */
    build?: Extract<CompleteBuild, { ok: true }>;
    /** The installer program for this system, when the server has one: put next to the start scripts as the double-click alternative. */
    installer?: Extract<InstallerPart, { ok: true }>;
    /**
     * How the download is laid out. "folder": one folder with the start scripts, the check and a README (today's zip). "linux": one sh
     * script with the kit as a gzip tar at its end (runner-linux-script.ts, round 50). "mac-pkg" (round 55): the part of the Mac package
     * that is the same for everyone, a zip of the app and `kit/` WITHOUT runner.json and runner.enroll (runner-mac-pkg.ts adds those
     * beside it, per download; needs `installer`).
     */
    layout?: "folder" | "mac-pkg" | "linux";
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

/**
 * The download, as a stream and its exact length. The big part is copied from the pack as it is (already compressed); the rest is
 * compressed here. Every entry carries Unix permissions: node and the start scripts 0755, runner.enroll 0600.
 */
export function buildCompleteZip(i: BuildCompleteInput): { stream: Readable; bytes: number; again?: () => AsyncIterable<Buffer> } {
    const layout = i.layout ?? "folder";
    const manifest = i.build?.manifest;
    const target = i.build?.target;
    const win = Boolean(target?.startsWith("win"));
    const kitVersion = i.bundle.manifest.kitVersion;
    // Where the kit's files go: one folder (today), inside the app, or the tar's root (the Linux script unpacks it into a folder of its own).
    if (layout === "folder" && !target) throw new Error("the folder layout is the complete download");
    const prefix = layout === "mac-pkg" ? "kit/" : layout === "linux" ? "" : `${completeFolder(target!)}/`;
    const files: PackedFile[] = [];
    const taken = new Set<string>();
    const push = (name: string, e: Omit<PackedFile, "name">): void => {
        if (taken.has(name)) throw new Error(`two files named ${name}`);
        taken.add(name);
        files.push({ ...e, name });
    };
    const small = (name: string, data: Uint8Array, mode = 0o644): void => {
        const body = zlib.deflateRawSync(data, { level: 9 });
        push(name, { mode, crc: zlib.crc32(data) >>> 0, size: data.length, csize: body.length, body });
    };
    const text = (s: string): Buffer => Buffer.from(s, "utf8");

    // The runtime and the packages, straight from the pack.
    if (manifest) for (const f of manifest.files) push(prefix + f.path, { mode: f.mode, crc: f.crc, size: f.size, csize: f.csize, packOffset: f.offset });
    // The runner programs: exactly the prebuilt bytes.
    for (const name of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"]) small(prefix + name, i.bundle.files.get(name)!);
    // The lock file goes in every layout: the kit version counts it, so a download without it fails the runner's own file check
    // ("Runner files do not match this download") although nothing is damaged. A complete download never runs npm with it.
    const lock = i.bundle.files.get("package-lock.json");
    if (lock) small(prefix + "package-lock.json", lock);
    // What belongs to this download (the Mac package carries these outside its shared zip).
    if (layout !== "mac-pkg") for (const f of personFiles(i)) small(prefix + f.name, f.data, f.mode);
    if (layout === "mac-pkg") {
        // The app itself, the same bytes for everyone. No README, no start scripts: the package's postinstall runs the app's setup.
        if (!i.installer) throw new Error("the Mac package layout needs the app");
        for (const f of i.installer.files) small(f.name, f.data, f.mode);
    } else if (layout === "linux") {
        // The script's header runs start-runner.sh from the installed copy; check-computer.sh stays there for "If the runner does not connect".
        small("start-runner.sh", text(withLineEnding(START_SH, "\n")), 0o755);
        const check = CHECK_FILES.find((f) => f.name === "check-computer.sh")!;
        small(check.name, text(withLineEnding(check.text, check.eol)), 0o755);
    } else {
        small(prefix + "start-runner.cmd", text(withLineEnding(START_CMD, "\r\n")), 0o755);
        small(prefix + "start-runner.sh", text(withLineEnding(START_SH, "\n")), 0o755);
        small(prefix + "start-runner.command", text(withLineEnding(START_COMMAND, "\n")), 0o755);
        // "Check this computer" (docs/features/runner-check.md): double-clickable, in every download.
        for (const f of CHECK_FILES) small(prefix + f.name, text(withLineEnding(f.text, f.eol)), 0o755);
        if (i.installer) for (const f of i.installer.files) small(prefix + f.name, f.data, f.mode);
        const readmeText = readme({
            platform: win ? "windows" : "unix",
            ...(i.runnerName ? { runnerName: i.runnerName } : {}),
            platformUrl: i.platformUrl,
            kitVersion,
            ...(target && manifest ? { complete: { target, words: TARGET_WORDS[target], nodeVersion: manifest.nodeVersion, installer: Boolean(i.installer) } } : {}),
        });
        small(prefix + "README.txt", text(withLineEnding(readmeText, win ? "\r\n" : "\n")));
    }
    if (layout === "linux") return linuxScript(files, i.build?.packPath);
    // The Mac package's zip must come out byte for byte the same each time (its checksum is computed once): a fixed date without a build.
    return zipOf(files, i.build?.packPath, manifest ? { time: manifest.dosTime, date: manifest.dosDate } : layout === "mac-pkg" ? FIXED_DOS : dosNow());
}

/** runner.json and the one-time code: the only files that differ from one download to the next. */
export function personFiles(i: Pick<BuildCompleteInput, "bundle" | "runnerName" | "platformUrl" | "enrollCode" | "updateSequence" | "token">): { name: string; data: Buffer; mode: number }[] {
    const kitVersion = i.bundle.manifest.kitVersion;
    const runnerJson = `${JSON.stringify({ url: i.platformUrl, ...(i.runnerName ? { name: i.runnerName } : {}), kitVersion, ...(i.updateSequence !== undefined ? { updateSequence: i.updateSequence } : {}) }, null, 2)}\n`;
    const credential = kitCredentialFile(i);
    return [
        { name: "runner.json", data: Buffer.from(runnerJson, "utf8"), mode: 0o644 },
        { name: credential.name, data: Buffer.from(credential.text, "utf8"), mode: 0o600 },
    ];
}

/** 2026-01-01 00:00 as a DOS time and date. */
const FIXED_DOS = { time: 0, date: ((2026 - 1980) << 9) | (1 << 5) | 1 };

/** One file of a download, already compressed (raw deflate): its bytes are here (`body`) or in the complete build's pack (`packOffset`). */
export interface PackedFile {
    name: string;
    mode: number;
    crc: number;
    size: number;
    csize: number;
    packOffset?: number;
    body?: Buffer;
}

const dosNow = (): { time: number; date: number } => {
    const d = new Date();
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
};

/** The compressed bytes of every file in order, read from the pack where they live there. */
export async function* packedBodies(files: PackedFile[], packPath: string | undefined, around: (f: PackedFile, i: number) => { before: Buffer; after?: Buffer }): AsyncGenerator<Buffer> {
    const fh = packPath ? await fs.promises.open(packPath, "r") : undefined;
    try {
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        for (let n = 0; n < files.length; n++) {
            const e = files[n]!;
            const { before, after } = around(e, n);
            yield before;
            if (e.body) yield e.body;
            else {
                let left = e.csize;
                let pos = e.packOffset!;
                while (left > 0) {
                    const { bytesRead } = await fh!.read(chunk, 0, Math.min(chunk.length, left), pos);
                    if (bytesRead <= 0) throw new Error("the complete download's pack ended early");
                    // A copy: the chunk buffer is reused for the next read while this one may still be queued.
                    yield Buffer.from(chunk.subarray(0, bytesRead));
                    left -= bytesRead;
                    pos += bytesRead;
                }
            }
            if (after) yield after;
        }
    } finally {
        await fh?.close();
    }
}

function zipOf(files: PackedFile[], packPath: string | undefined, { time, date }: { time: number; date: number }): { stream: Readable; bytes: number; again: () => AsyncIterable<Buffer> } {
    const entries: ZipEntry[] = [];
    let offset = 0;
    for (const f of files) {
        const name = Buffer.from(f.name, "utf8");
        entries.push({ ...f, name, localOffset: offset });
        offset += 30 + name.length + f.csize;
    }
    if (entries.length > 0xffff - 1) throw new Error("too many files for a zip without zip64");
    const central = Buffer.concat(entries.map((e) => centralHeader(e, time, date)));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    const bytes = offset + central.length + end.length;
    if (bytes > 0xffffffff) throw new Error("the download is larger than a zip without zip64 can be");
    async function* body(): AsyncGenerator<Buffer> {
        yield* packedBodies(files, packPath, (_f, n) => ({ before: localHeader(entries[n]!, time, date) }));
        yield central;
        yield end;
    }
    // `again`: the same bytes once more, without compressing the small files again (the Mac package streams its zip per download).
    return { stream: Readable.from(body(), { objectMode: false }), bytes, again: body };
}
