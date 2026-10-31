// The COMPLETE runner download: one folder per system and processor that already holds its own Node.js and every pinned package, so
// the first start downloads nothing (see docs/features/runner-complete-kit.md).
//
//   npm run build:runner -- --complete                      every target
//   npm run build:runner -- --complete --targets win-x64,mac-arm64
//
// What it does, per target:
//   1. Node.js NODE_VERSION (one exact version, pinned here) from https://nodejs.org/dist/v<ver>/ (AITP_NODE_DIST_URL replaces the base for
//      tests; plain http is accepted only for an address on this computer). Every archive is checked against SHASUMS256.txt from the same
//      place before it is used, and kept in dist/runner-cache/ (git-ignored) so a second build downloads nothing. A file that does not match is
//      deleted and the build stops. Only `node` (or `node.exe`) and Node's LICENSE are taken from the archive: npm is not needed, because
//      the packages come complete.
//   2. The kit's pinned packages (dist/runner/package.json: Playwright, TypeScript, axe and, optional, Taqwright) with everything they
//      depend on, copied from this checkout's node_modules (which `npm ci` installed from package-lock.json, so the versions are exactly the
//      platform's). Each package is checked for native code (.node files, binding.gyp), an `os`/`cpu` limit and install scripts: what the
//      target cannot use is left out with a plain note when it is optional, and stops the build when it is not.
//   3. dist/runner-complete/<target>/: `pack.bin` (every file, already compressed, one after another) and `manifest.json` (each file's path,
//      Unix mode, size, CRC-32, SHA-256 and place in the pack, plus the SHA-256 of the whole pack). The platform streams a zip from these
//      without compressing anything per download (src/platform/runner-kit-complete.ts).
//
// Archives are unpacked with Node's own zlib: a small reader for the .zip (Windows) and a small streaming tar reader for the .tar.gz
// (Mac, Linux). The executable bit of `node` is kept (and recorded in the zip the platform serves).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";

/** The Node.js every complete download carries. One exact version; change it here (and rebuild) to move every target at once. */
export const NODE_VERSION = "24.19.0";
export const DEFAULT_DIST = "https://nodejs.org/dist";

/** The six downloads. `os`/`cpu` use Node's own names (process.platform / process.arch), which is what package.json `os`/`cpu` fields use too. */
export const TARGETS = {
    "win-x64": { os: "win32", cpu: "x64", archive: "zip", nodeName: "win-x64", exe: "node.exe", words: "Windows, Intel or AMD processor (x64)" },
    "win-arm64": { os: "win32", cpu: "arm64", archive: "zip", nodeName: "win-arm64", exe: "node.exe", words: "Windows on ARM (arm64)" },
    "mac-arm64": { os: "darwin", cpu: "arm64", archive: "tar.gz", nodeName: "darwin-arm64", exe: "bin/node", words: "Mac with an Apple chip (arm64)" },
    "mac-x64": { os: "darwin", cpu: "x64", archive: "tar.gz", nodeName: "darwin-x64", exe: "bin/node", words: "Mac with an Intel processor (x64)" },
    "linux-x64": { os: "linux", cpu: "x64", archive: "tar.gz", nodeName: "linux-x64", exe: "bin/node", words: "Linux, Intel or AMD processor (x64)" },
    "linux-arm64": { os: "linux", cpu: "arm64", archive: "tar.gz", nodeName: "linux-arm64", exe: "bin/node", words: "Linux on ARM (arm64)" },
};
export const TARGET_NAMES = Object.keys(TARGETS);

/** Caps (also in the doc): what nodejs.org serves is far below them; anything above is not what we expect and is refused. */
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
export const MAX_FILE_BYTES = 300 * 1024 * 1024;
export const MAX_PACK_BYTES = 400 * 1024 * 1024;
export const MAX_FILES = 60_000;
/** Paths inside the zip longer than this risk Windows' 260-character limit once unzipped under a Downloads folder. */
export const LONG_PATH_WARN = 160;

/**
 * Packages whose install script is not run in a complete download, and why that is fine. Any other package with an install script stops the
 * build (or, when it is only needed by an optional package, leaves that package out): its script might be what makes it work.
 */
export const INSTALL_SCRIPT_OK = {
    edgedriver: "its install script only fetches Microsoft Edge's desktop driver ahead of time, which it also does on first use; phone tests never use it",
    geckodriver: "its install script only fetches Firefox's desktop driver ahead of time, which it also does on first use; phone tests never use it",
};

/** The marker the start scripts and installers look for: the packages in node_modules are complete, so npm install is skipped. */
export const COMPLETE_MARKER = "node_modules/.aitp-complete";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// ── downloads ───────────────────────────────────────────────────────────────

/** The base address of the Node.js downloads: https://nodejs.org/dist, or AITP_NODE_DIST_URL (http only for this computer). */
export function distBase(env = process.env) {
    const raw = (env.AITP_NODE_DIST_URL || DEFAULT_DIST).trim().replace(/\/+$/, "");
    let u;
    try {
        u = new URL(raw);
    } catch {
        throw new Error(`AITP_NODE_DIST_URL is not a full address: ${raw}`);
    }
    const local = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error(`Node.js is only downloaded over https (got ${u.protocol}//${u.host}).`);
    return raw;
}

export const archiveName = (target, version = NODE_VERSION) => `node-v${version}-${TARGETS[target].nodeName}.${TARGETS[target].archive}`;

async function fetchToFile(url, dest, maxBytes) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`${url} answered ${res.status}.`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${url} is ${declared} bytes, more than the ${maxBytes} this build accepts.`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest);
    let got = 0;
    try {
        for await (const chunk of Readable.fromWeb(res.body)) {
            got += chunk.length;
            if (got > maxBytes) throw new Error(`${url} sent more than the ${maxBytes} bytes this build accepts.`);
            if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        }
    } finally {
        await new Promise((r) => out.end(r));
    }
    return got;
}

/** "<sha256>  <file>" lines -> the hash of one file, or undefined. */
export function expectedHash(shasums, file) {
    for (const line of shasums.split(/\r?\n/)) {
        const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
        if (m && m[2] === file) return m[1].toLowerCase();
    }
    return undefined;
}

/**
 * The checksum list for NODE_VERSION: fetched fresh every build (over https), saved next to the archives. Without a network the saved copy
 * is used and the build says so; a cached archive is always checked against it again.
 */
async function loadShasums({ base, cacheDir, version, log }) {
    const local = path.join(cacheDir, `node-v${version}`, "SHASUMS256.txt");
    const url = `${base}/v${version}/SHASUMS256.txt`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`${url} answered ${res.status}.`);
        const text = await res.text();
        if (text.length > 1024 * 1024) throw new Error(`${url} is larger than a checksum list can be.`);
        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.writeFileSync(local, text);
        return text;
    } catch (e) {
        if (fs.existsSync(local)) {
            log(`Could not read ${url} (${e instanceof Error ? e.message : e}); using the copy saved by an earlier build.`);
            return fs.readFileSync(local, "utf8");
        }
        throw new Error(`Could not read the Node.js checksum list ${url}: ${e instanceof Error ? e.message : e}`);
    }
}

/** The archive for one target, from the cache when it is there and still matches, otherwise downloaded and checked. */
async function nodeArchive({ target, base, cacheDir, shasums, version, log }) {
    const file = archiveName(target, version);
    const want = expectedHash(shasums, file);
    if (!want) throw new Error(`SHASUMS256.txt for Node.js ${version} does not list ${file}, so it cannot be checked and was not downloaded.`);
    const dest = path.join(cacheDir, `node-v${version}`, file);
    if (fs.existsSync(dest)) {
        if (sha256(fs.readFileSync(dest)) === want) {
            log(`  ${file}: in the cache, checksum matches.`);
            return dest;
        }
        log(`  ${file}: the cached copy does not match its checksum; downloading it again.`);
        fs.rmSync(dest, { force: true });
    }
    const part = `${dest}.part`;
    fs.rmSync(part, { force: true });
    log(`  ${file}: downloading from ${base} ...`);
    try {
        await fetchToFile(`${base}/v${version}/${file}`, part, MAX_ARCHIVE_BYTES);
    } catch (e) {
        fs.rmSync(part, { force: true });
        throw e;
    }
    const got = sha256(fs.readFileSync(part));
    if (got !== want) {
        fs.rmSync(part, { force: true });
        throw new Error(`${file} does not match the checksum nodejs.org publishes in SHASUMS256.txt, so it was deleted and not used. Run the build again; if it repeats, something between this computer and nodejs.org is changing the download.`);
    }
    fs.renameSync(part, dest);
    log(`  ${file}: downloaded, checksum matches.`);
    return dest;
}

// ── unpacking (Node's zlib, no other tools) ─────────────────────────────────

/** The files `wanted` (path inside the archive -> name to keep) from a .zip, read through its central directory. */
export function readZipEntries(buf, wanted) {
    const out = new Map();
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("The Node.js zip has no central directory (it is not a zip, or it was cut short).");
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("The Node.js zip's central directory is damaged.");
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
        p += 46 + nameLen + extraLen + commentLen;
        const keep = wanted.get(name);
        if (!keep) continue;
        if (size > MAX_FILE_BYTES) throw new Error(`${name} in the Node.js zip is larger than ${MAX_FILE_BYTES} bytes.`);
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("The Node.js zip is damaged.");
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + csize);
        const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
        if (!data) throw new Error(`${name} in the Node.js zip uses a compression this build does not read.`);
        if (data.length !== size || zlib.crc32(data) >>> 0 !== crc) throw new Error(`${name} in the Node.js zip is damaged (its checksum does not match).`);
        out.set(keep, { data, mode: keep.endsWith(".exe") ? 0o755 : 0o644 });
    }
    return out;
}

const octal = (b) => {
    // A tar number: octal text, or (GNU) base-256 when the first byte has its high bit set.
    if (b[0] & 0x80) {
        let v = 0;
        for (let i = 1; i < b.length; i++) v = v * 256 + b[i];
        return v;
    }
    const s = b.toString("latin1").replace(/\0.*$/s, "").trim();
    return s ? parseInt(s, 8) : 0;
};
const cstr = (b) => b.toString("utf8").replace(/\0.*$/s, "");

/**
 * The files `wanted` from a .tar.gz, streamed (the archive is never held in memory as a whole): ustar names with their prefix, GNU long
 * names ("L") and pax "path=" records are understood; links and folders are skipped. Keeps each file's Unix mode.
 */
export async function readTarGzEntries(file, wanted) {
    const out = new Map();
    let pending = Buffer.alloc(0);
    let state = { kind: "header" };
    let longName = null;
    const feed = (chunk) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        for (;;) {
            if (state.kind === "header") {
                if (pending.length < 512) return;
                const h = pending.subarray(0, 512);
                pending = pending.subarray(512);
                if (h.every((b) => b === 0)) {
                    state = { kind: "end" };
                    return;
                }
                const size = octal(h.subarray(124, 136));
                const type = String.fromCharCode(h[156] || 48);
                const prefix = h.subarray(257, 263).toString("latin1").startsWith("ustar") ? cstr(h.subarray(345, 500)) : "";
                let name = longName ?? (prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100)));
                longName = null;
                if (name.startsWith("./")) name = name.slice(2);
                const mode = octal(h.subarray(100, 108)) & 0o777;
                const padded = Math.ceil(size / 512) * 512;
                if (type === "L" || type === "x") state = { kind: "meta", type, size, padded, parts: [], got: 0 };
                else if ((type === "0" || type === "\0" || type === "7") && wanted.has(name)) {
                    if (size > MAX_FILE_BYTES) throw new Error(`${name} in the Node.js archive is larger than ${MAX_FILE_BYTES} bytes.`);
                    state = { kind: "keep", name: wanted.get(name), mode, size, padded, parts: [], got: 0 };
                } else state = { kind: "skip", left: padded };
                continue;
            }
            if (state.kind === "skip") {
                const n = Math.min(state.left, pending.length);
                pending = pending.subarray(n);
                state.left -= n;
                if (state.left > 0) return;
                state = { kind: "header" };
                continue;
            }
            if (state.kind === "keep" || state.kind === "meta") {
                const n = Math.min(state.padded - state.got, pending.length);
                state.parts.push(Buffer.from(pending.subarray(0, n)));
                pending = pending.subarray(n);
                state.got += n;
                if (state.got < state.padded) return;
                const data = Buffer.concat(state.parts).subarray(0, state.size);
                if (state.kind === "keep") out.set(state.name, { data, mode: state.mode || 0o644 });
                else if (state.type === "L") longName = cstr(data);
                else {
                    const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
                    if (m) longName = m[1];
                }
                state = { kind: "header" };
                continue;
            }
            return; // end of archive
        }
    };
    const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
    for await (const chunk of stream) {
        feed(chunk);
        if (state.kind === "end") {
            stream.destroy();
            break;
        }
    }
    return out;
}

/** node(.exe) and LICENSE of one target, laid out as `node/node.exe` (Windows) or `node/bin/node`. */
export async function extractNode(target, archive, version = NODE_VERSION) {
    const t = TARGETS[target];
    const top = `node-v${version}-${t.nodeName}`;
    const wanted = new Map([
        [`${top}/${t.exe}`, `node/${t.exe}`],
        [`${top}/LICENSE`, "node/LICENSE"],
    ]);
    const got = t.archive === "zip" ? readZipEntries(fs.readFileSync(archive), wanted) : await readTarGzEntries(archive, wanted);
    for (const name of wanted.values()) if (!got.has(name)) throw new Error(`${path.basename(archive)} does not hold ${name.replace(/^node\//, "")} where Node.js puts it.`);
    const exe = got.get(`node/${t.exe}`);
    exe.mode = 0o755;
    return got;
}

// ── the packages ────────────────────────────────────────────────────────────

/** Does a package.json `os` / `cpu` list allow this value? (A list of names, where "!name" excludes one; no list allows everything.) */
export function allows(list, value) {
    if (!Array.isArray(list) || list.length === 0) return true;
    const blocked = list.filter((x) => String(x).startsWith("!")).map((x) => String(x).slice(1));
    const allowed = list.filter((x) => !String(x).startsWith("!"));
    if (blocked.includes(value)) return false;
    return allowed.length === 0 || allowed.includes(value);
}

function* walkFiles(dir, rel = "") {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (rel === "" && e.name === "node_modules") continue; // nested packages are added on their own, when they are needed
        const abs = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) yield* walkFiles(abs, r);
        else if (e.isFile()) yield { abs, rel: r };
    }
}

/** What a package needs to be usable on another computer: native code, an os/cpu limit, install scripts. */
export function inspectPackage(dir) {
    const pkg = readJson(path.join(dir, "package.json"));
    const files = [...walkFiles(dir)];
    const scripts = pkg.scripts ?? {};
    return {
        name: String(pkg.name ?? path.basename(dir)),
        version: String(pkg.version ?? "0.0.0"),
        pkg,
        files,
        native: files.some((f) => f.rel.endsWith(".node")) || fs.existsSync(path.join(dir, "binding.gyp")) || pkg.gypfile === true,
        os: pkg.os,
        cpu: pkg.cpu,
        installScript: ["preinstall", "install", "postinstall"].some((k) => typeof scripts[k] === "string" && scripts[k].trim()),
    };
}

/** Where Node would find package `name` when it is required from `fromDir`, without leaving `root`. */
export function resolvePackage(root, fromDir, name) {
    const top = path.resolve(root);
    let dir = path.resolve(fromDir);
    for (;;) {
        const candidate = path.join(dir, "node_modules", ...name.split("/"));
        if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
        if (dir === top) return null;
        const up = path.dirname(dir);
        if (up === dir || !up.startsWith(top)) return null;
        dir = up;
    }
}

/**
 * Every package `roots` needs, from `root`'s node_modules, for one target. Returns the packages to copy and the notes about what was left out.
 *   - required roots: a package the target cannot use (native code, os/cpu, unknown install script) stops the build, unless it was only an
 *     optionalDependency of another package (then it is left out with a note, as npm would on that computer);
 *   - optional roots: the whole optional package is left out, with a note, when anything it needs cannot be used.
 */
export function packageClosure({ root, required, optional = [], target }) {
    const t = TARGETS[target];
    const cache = new Map();
    const look = (dir) => {
        if (!cache.has(dir)) cache.set(dir, inspectPackage(dir));
        return cache.get(dir);
    };
    const problemOf = (info) => {
        if (!allows(info.os, t.os) || !allows(info.cpu, t.cpu)) return `${info.name} ${info.version} is only for ${[info.os, info.cpu].filter(Boolean).map((l) => l.join("/")).join(", ")}`;
        if (info.native) return `${info.name} ${info.version} contains native code built for one kind of computer`;
        if (info.installScript && !INSTALL_SCRIPT_OK[info.name]) return `${info.name} ${info.version} has an install script, which a complete download cannot run`;
        return undefined;
    };
    const notes = [];

    /** All packages one root needs. Throws { problem } when a required edge reaches something unusable. */
    const closeOver = (rootName) => {
        const found = new Map();
        const visit = (dir, via) => {
            const key = path.relative(root, dir).split(path.sep).join("/");
            if (found.has(key)) return;
            const info = look(dir);
            const problem = problemOf(info);
            if (problem) throw Object.assign(new Error(problem), { problem, via });
            found.set(key, info);
            const deps = info.pkg.dependencies ?? {};
            const optionalDeps = info.pkg.optionalDependencies ?? {};
            const peers = info.pkg.peerDependencies ?? {};
            const peerMeta = info.pkg.peerDependenciesMeta ?? {};
            for (const name of Object.keys(deps)) {
                if (name in optionalDeps) continue;
                const at = resolvePackage(root, dir, name);
                if (!at) throw Object.assign(new Error(`${name} (needed by ${info.name}) is not installed in node_modules`), { problem: `${name} (needed by ${info.name}) is not installed`, via });
                visit(at, [...via, info.name]);
            }
            for (const name of Object.keys(peers)) {
                if (peerMeta[name]?.optional) continue;
                const at = resolvePackage(root, dir, name);
                if (at) visit(at, [...via, info.name]);
            }
            for (const name of Object.keys(optionalDeps)) {
                const at = resolvePackage(root, dir, name);
                if (!at) {
                    notes.push(`${name} (optional for ${info.name}) is not in this checkout's node_modules, so it is not in the download either.`);
                    continue;
                }
                const sub = look(at);
                const problem = problemOf(sub);
                if (problem) {
                    notes.push(`Left out ${name}, an optional part of ${info.name}: ${problem}. ${info.name} works without it, as it does after npm install on that computer.`);
                    continue;
                }
                visit(at, [...via, info.name]);
            }
        };
        const start = resolvePackage(root, root, rootName);
        if (!start) throw Object.assign(new Error(`${rootName} is not installed in node_modules`), { problem: `${rootName} is not installed`, via: [] });
        visit(start, []);
        return found;
    };

    const all = new Map();
    for (const name of required) {
        let found;
        try {
            found = closeOver(name);
        } catch (e) {
            throw new Error(`The complete download for ${target} cannot include ${name}: ${e.problem ?? e.message}${e.via?.length ? ` (through ${e.via.join(" > ")})` : ""}.`);
        }
        for (const [k, v] of found) all.set(k, v);
    }
    const leftOut = [];
    for (const name of optional) {
        try {
            const found = closeOver(name);
            for (const [k, v] of found) all.set(k, v);
        } catch (e) {
            leftOut.push({ name, reason: `${e.problem ?? e.message}${e.via?.length ? ` (through ${e.via.join(" > ")})` : ""}` });
            notes.push(`Left out ${name} (optional): ${e.problem ?? e.message}. Web and API tests are not affected.`);
        }
    }
    for (const info of all.values()) {
        if (info.installScript && INSTALL_SCRIPT_OK[info.name]) {
            const line = `${info.name}: install script not run, ${INSTALL_SCRIPT_OK[info.name]}.`;
            if (!notes.includes(line)) notes.push(line);
        }
    }
    return { packages: all, leftOut, notes };
}

// ── the build ───────────────────────────────────────────────────────────────

/** A DOS date and time for the zip entries (the build's own time; zips cannot say a time zone). */
export function dosTime(d = new Date()) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

function verifyBundle(bundleDir) {
    let manifest;
    try {
        manifest = readJson(path.join(bundleDir, "manifest.json"));
    } catch {
        throw new Error(`There is no runner build in ${bundleDir}. Run npm run build:runner first (--complete does that for you).`);
    }
    for (const f of manifest.files ?? []) {
        const bytes = fs.readFileSync(path.join(bundleDir, f.name));
        if (sha256(bytes) !== f.sha256) throw new Error(`The runner build in ${bundleDir} is damaged (${f.name}). Run npm run build:runner again.`);
    }
    const pkgBytes = fs.readFileSync(path.join(bundleDir, "package.json"));
    return { manifest, kitPackage: JSON.parse(pkgBytes.toString("utf8")), packageJsonSha256: sha256(pkgBytes) };
}

/**
 * Builds the complete downloads for `targets` into `outDir/<target>/`.
 * `modulesRoot` is the folder whose node_modules the packages are copied from (this checkout; the tests use a small stand-in).
 */
export async function buildComplete({ root, bundleDir, outDir, cacheDir, targets = TARGET_NAMES, modulesRoot = root, env = process.env, version = NODE_VERSION, log = () => {} }) {
    for (const t of targets) if (!TARGETS[t]) throw new Error(`Unknown target ${t}. The targets are ${TARGET_NAMES.join(", ")}.`);
    const { manifest: bundle, kitPackage, packageJsonSha256 } = verifyBundle(bundleDir);
    const required = Object.keys(kitPackage.dependencies ?? {});
    const optional = Object.keys(kitPackage.optionalDependencies ?? {});
    const base = distBase(env);
    log(`Complete runner downloads with Node.js ${version} from ${base} for ${targets.join(", ")}.`);
    const shasums = await loadShasums({ base, cacheDir, version, log });
    const { time, date } = dosTime();
    /** Compressed module files, shared by every target that has the same package list. */
    const compressed = new Map();
    const results = [];

    for (const target of targets) {
        log(`${target} (${TARGETS[target].words}):`);
        const archive = await nodeArchive({ target, base, cacheDir, shasums, version, log });
        const nodeFiles = await extractNode(target, archive, version);
        const { packages, leftOut, notes } = packageClosure({ root: modulesRoot, required, optional, target });
        for (const n of notes) log(`  note: ${n}`);

        // Every pinned package must be in node_modules at exactly the version the kit's package.json names.
        const pinned = { ...(kitPackage.dependencies ?? {}), ...(kitPackage.optionalDependencies ?? {}) };
        const versions = {};
        for (const [name, want] of Object.entries(pinned)) {
            if (leftOut.some((l) => l.name === name)) continue;
            const info = packages.get(`node_modules/${name}`);
            if (!info) throw new Error(`${name} is not at the top of node_modules, so the complete download cannot pin it. Run npm ci, then build again.`);
            if (info.version !== want) throw new Error(`node_modules has ${name} ${info.version}, but the runner pins ${want}. Run npm ci, then build again.`);
            versions[name] = info.version;
        }
        const copies = [...packages.keys()].filter((k) => k.endsWith("/playwright-core") || k === "node_modules/playwright-core");
        if (copies.length > 1) throw new Error(`The download would hold ${copies.length} copies of playwright-core (${copies.join(", ")}); it must hold one. Run npm ci, then build again.`);

        const info = {
            format: 1,
            target,
            words: TARGETS[target].words,
            nodeVersion: `v${version}`,
            nodeModulesComplete: true,
            packages: versions,
            leftOut,
            notes,
        };
        // What the installers compare to tell whether an installed node_modules is the same set (the start scripts only check it exists).
        const marker = `${JSON.stringify({ target, nodeVersion: `v${version}`, packageJson: packageJsonSha256 })}\n`;

        // Files in the order they go into the zip: the runtime, the packages, the two small files that describe them.
        const entries = [];
        for (const [name, f] of [...nodeFiles].sort(([a], [b]) => a.localeCompare(b))) entries.push({ path: name, data: f.data, mode: f.mode, share: false });
        for (const [key, pkgInfo] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
            const bins = new Set(
                (typeof pkgInfo.pkg.bin === "string" ? [pkgInfo.pkg.bin] : Object.values(pkgInfo.pkg.bin ?? {})).map((b) => String(b).replace(/^\.\//, "")),
            );
            for (const f of pkgInfo.files) entries.push({ path: `${key}/${f.rel}`, abs: f.abs, mode: bins.has(f.rel) ? 0o755 : 0o644, share: true });
        }
        entries.push({ path: COMPLETE_MARKER, data: Buffer.from(marker), mode: 0o644, share: false });
        entries.push({ path: "complete-kit.json", data: Buffer.from(`${JSON.stringify(info, null, 2)}\n`), mode: 0o644, share: false });
        if (entries.length > MAX_FILES) throw new Error(`The download for ${target} would hold ${entries.length} files, more than ${MAX_FILES}.`);

        const final = path.join(outDir, target);
        const tmp = `${final}.tmp`;
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        const fd = fs.openSync(path.join(tmp, "pack.bin"), "w");
        const packHash = createHash("sha256");
        const files = [];
        let offset = 0;
        let longest = "";
        try {
            for (const e of entries) {
                if (!/^[A-Za-z0-9 ._@+()~!$&',;=[\]{}#%^-]+(\/[A-Za-z0-9 ._@+()~!$&',;=[\]{}#%^-]+)*$/.test(e.path) || e.path.split("/").some((s) => s === "." || s === "..")) {
                    throw new Error(`A file in the download has a name a zip should not carry: ${e.path}`);
                }
                let c = e.share ? compressed.get(e.abs) : undefined;
                if (!c) {
                    const data = e.data ?? fs.readFileSync(e.abs);
                    if (data.length > MAX_FILE_BYTES) throw new Error(`${e.path} is larger than ${MAX_FILE_BYTES} bytes.`);
                    c = { size: data.length, crc: zlib.crc32(data) >>> 0, sha256: sha256(data), body: zlib.deflateRawSync(data, { level: 9 }) };
                    if (e.share) compressed.set(e.abs, c);
                }
                fs.writeSync(fd, c.body);
                packHash.update(c.body);
                files.push({ path: e.path, mode: e.mode, size: c.size, csize: c.body.length, crc: c.crc, sha256: c.sha256, offset });
                offset += c.body.length;
                if (offset > MAX_PACK_BYTES) throw new Error(`The download for ${target} would be larger than ${MAX_PACK_BYTES} bytes.`);
                if (e.path.length > longest.length) longest = e.path;
            }
        } finally {
            fs.closeSync(fd);
        }
        const manifest = {
            format: 1,
            target,
            nodeVersion: `v${version}`,
            /** The runner build this was made next to (information only: the platform matches complete builds by packageJsonSha256). */
            builtWithKitVersion: bundle.kitVersion,
            packageJsonSha256,
            builtAt: new Date().toISOString(),
            dosTime: time,
            dosDate: date,
            packBytes: offset,
            packSha256: packHash.digest("hex"),
            unpackedBytes: files.reduce((s, f) => s + f.size, 0),
            packages: versions,
            leftOut,
            notes,
            files,
        };
        fs.writeFileSync(path.join(tmp, "manifest.json"), `${JSON.stringify(manifest)}\n`);
        fs.rmSync(final, { recursive: true, force: true });
        fs.renameSync(tmp, final);
        const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
        log(`  done: ${files.length} files, ${mb(manifest.unpackedBytes)} unpacked, ${mb(offset)} to download.`);
        if (longest.length > LONG_PATH_WARN) log(`  note: the longest path inside is ${longest.length} characters (${longest}); Windows may refuse to unzip it into a deep folder.`);
        results.push({ target, files: files.length, packBytes: offset, unpackedBytes: manifest.unpackedBytes, leftOut, notes, longestPath: longest.length });
    }
    return results;
}

/** `--targets a,b` (or `all`, or `none`) -> the list. */
export function parseTargets(value) {
    if (value === undefined || value === "" || value === "all") return TARGET_NAMES;
    if (value === "none") return [];
    const list = value.split(",").map((s) => s.trim()).filter(Boolean);
    for (const t of list) if (!TARGETS[t]) throw new Error(`Unknown target ${t}. The targets are ${TARGET_NAMES.join(", ")} (or all, or none).`);
    return [...new Set(list)];
}
