// Reads the Mac download (ai-testing-runner-mac.pkg, src/platform/runner-mac-pkg.ts) without Apple's tools, checking every checksum:
// the xar header and its TOC, each file in the heap, the gzip of Scripts and the odc cpio inside it. Used by the tests and by the smoke
// check (scripts/smoke-runner.mjs) to put the app with its kit inside it where a person would have it, as the round 50 zip did.
//   node scripts/mac-pkg-read.mjs <file.pkg>        lists what it holds
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const sha1 = (b) => createHash("sha1").update(b).digest("hex");

/** The files of a xar archive by path ("runner.pkg/Scripts"), each checked against its TOC checksums. Throws on anything wrong. */
export function readXar(buf) {
    if (buf.length < 28 || buf.toString("latin1", 0, 4) !== "xar!") throw new Error("not a xar archive");
    const headerSize = buf.readUInt16BE(4);
    const version = buf.readUInt16BE(6);
    const tocZ = Number(buf.readBigUInt64BE(8));
    const tocPlain = Number(buf.readBigUInt64BE(16));
    const alg = buf.readUInt32BE(24);
    if (headerSize < 28 || version !== 1 || alg !== 1) throw new Error(`unexpected xar header (size ${headerSize}, version ${version}, checksum ${alg})`);
    const tocBytes = buf.subarray(headerSize, headerSize + tocZ);
    const toc = zlib.inflateSync(tocBytes).toString("utf8");
    if (Buffer.byteLength(toc) !== tocPlain) throw new Error("the TOC's plain length is wrong");
    const heap = headerSize + tocZ;
    const ck = /<toc>\s*<checksum style="sha1">\s*<offset>(\d+)<\/offset>\s*<size>(\d+)<\/size>/.exec(toc);
    if (!ck || Number(ck[2]) !== 20) throw new Error("the TOC names no SHA-1 checksum of itself");
    if (buf.subarray(heap + Number(ck[1]), heap + Number(ck[1]) + 20).toString("hex") !== sha1(tocBytes)) throw new Error("the TOC checksum does not match");
    const files = new Map();
    // A small walk over <file> elements: a directory's children follow its own fields.
    const stack = [];
    const re = /<file id="(\d+)">|<\/file>|<name>([^<]*)<\/name>|<type>([^<]*)<\/type>|<mode>([^<]*)<\/mode>|<data>([\s\S]*?)<\/data>/g;
    let m;
    while ((m = re.exec(toc))) {
        if (m[1]) stack.push({ id: m[1] });
        else if (m[0] === "</file>") {
            const f = stack.pop();
            const p = [...stack.map((s) => s.name), f.name].join("/");
            if (f.type === "file") {
                const d = f.data;
                const get = (tag) => new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(d)?.[1];
                const offset = Number(get("offset"));
                const length = Number(get("length"));
                const size = Number(get("size"));
                const enc = /<encoding style="([^"]+)"/.exec(d)?.[1];
                const archived = /<archived-checksum style="sha1">([0-9a-f]{40})</.exec(d)?.[1];
                const extracted = /<extracted-checksum style="sha1">([0-9a-f]{40})</.exec(d)?.[1];
                const raw = buf.subarray(heap + offset, heap + offset + length);
                if (raw.length !== length) throw new Error(`${p} runs past the end of the file`);
                if (sha1(raw) !== archived) throw new Error(`${p}: the archived checksum does not match`);
                const data = enc === "application/x-gzip" ? zlib.inflateSync(raw) : raw;
                if (enc !== "application/octet-stream" && enc !== "application/x-gzip") throw new Error(`${p}: encoding ${enc}`);
                if (data.length !== size || sha1(data) !== extracted) throw new Error(`${p}: the extracted checksum does not match`);
                files.set(p, { data, mode: parseInt(f.mode, 8), offset, length });
            } else files.set(p, { dir: true, mode: parseInt(f.mode, 8) });
        } else {
            const top = stack[stack.length - 1];
            if (!top) continue;
            if (m[2] !== undefined && top.name === undefined) top.name = m[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
            else if (m[3] !== undefined && top.type === undefined) top.type = m[3];
            else if (m[4] !== undefined && top.mode === undefined) top.mode = m[4];
            else if (m[5] !== undefined && top.data === undefined) top.data = m[5];
        }
    }
    const end = Math.max(heap + 20, ...[...files.values()].filter((f) => !f.dir).map((f) => heap + f.offset + f.length));
    if (end !== buf.length) throw new Error(`the file is ${buf.length} bytes, its contents end at ${end}`);
    return { toc, files };
}

/** The entries of an odc ("070707") cpio archive, up to TRAILER!!!. */
export function readCpio(buf) {
    const out = [];
    let at = 0;
    for (;;) {
        const h = buf.toString("latin1", at, at + 76);
        if (h.slice(0, 6) !== "070707") throw new Error(`no cpio header at ${at}`);
        const field = (from, width) => parseInt(h.slice(from, from + width), 8);
        const mode = field(18, 6);
        const nameSize = field(59, 6);
        const size = field(65, 11);
        const name = buf.toString("utf8", at + 76, at + 76 + nameSize - 1);
        at += 76 + nameSize;
        if (name === "TRAILER!!!") break;
        out.push({ name, mode, data: buf.subarray(at, at + size) });
        at += size;
    }
    if (at !== buf.length) throw new Error("bytes after the cpio trailer");
    return out;
}

/** The whole package, read: Distribution, PackageInfo, and the files of Scripts by name ("postinstall", "kit.zip", ...). */
export function readMacPkg(buf) {
    const { toc, files } = readXar(buf);
    const pkg = [...files.keys()].find((p) => p.endsWith("/Scripts"))?.split("/")[0];
    if (!pkg || !files.get("Distribution")) throw new Error("not a product archive with one component package");
    const scriptsGz = files.get(`${pkg}/Scripts`).data;
    const cpio = zlib.gunzipSync(scriptsGz);
    const scripts = Object.fromEntries(readCpio(cpio).map((e) => [e.name.replace(/^\.\//, ""), e]));
    return { toc, files, component: pkg, distribution: files.get("Distribution").data.toString("utf8"), packageInfo: files.get(`${pkg}/PackageInfo`).data.toString("utf8"), scriptsGz, cpio, scripts };
}

/**
 * Puts what the package installs where a person had it in round 50: `dest/AI Testing Runner.app` with the kit (and this download's
 * runner.json and runner.enroll) inside it under Contents/Resources/kit. Returns that kit folder. Unzips with ditto or unzip (modes kept).
 */
export function expandMacPkg(file, dest) {
    const pkg = readMacPkg(fs.readFileSync(file));
    fs.mkdirSync(dest, { recursive: true });
    const zip = path.join(dest, ".kit.zip");
    fs.writeFileSync(zip, pkg.scripts["kit.zip"].data);
    const tmp = path.join(dest, ".kit");
    const tool = process.platform === "darwin" ? ["ditto", ["-x", "-k", zip, tmp]] : ["unzip", ["-q", "-o", zip, "-d", tmp]];
    const r = spawnSync(tool[0], tool[1], { encoding: "utf8", timeout: 600_000 });
    fs.rmSync(zip, { force: true });
    if (r.status !== 0) throw new Error(`Unpacking the package's kit.zip with ${tool[0]} failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
    const app = path.join(dest, "AI Testing Runner.app");
    fs.renameSync(path.join(tmp, "AI Testing Runner.app"), app);
    const kit = path.join(app, "Contents", "Resources", "kit");
    fs.renameSync(path.join(tmp, "kit"), kit);
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const name of ["runner.json", "runner.enroll", "runner.token"]) {
        const e = pkg.scripts[name];
        if (e) fs.writeFileSync(path.join(kit, name), e.data, { mode: e.mode & 0o777 });
    }
    return kit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const pkg = readMacPkg(fs.readFileSync(process.argv[2]));
    for (const [p, f] of pkg.files) console.log(`${f.dir ? "dir " : "file"} ${p}${f.dir ? "" : ` (${f.data.length} bytes)`}`);
    for (const [n, e] of Object.entries(pkg.scripts)) console.log(`  Scripts: ${n} ${(e.mode & 0o777).toString(8)} ${e.data.length} bytes`);
}
