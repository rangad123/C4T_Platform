/**
 * The Mac download as one file (round 55): `ai-testing-runner-mac.pkg`, a flat installer package the person double-clicks. Installer
 * opens it, installs for this user only (no administrator password) and runs its postinstall, which sets up the runner exactly as opening
 * the app did (round 50): runner-setup.sh --silent with the kit, so the same install folder (~/Library/Application Support/AITestingRunner),
 * the same LaunchAgent (sign-in start), the same takeover of a running runner and the one-time code used once. The app is also put in
 * ~/Applications, without any kit or code, so "open the app again" (status, Uninstall) keeps working.
 *
 * The format, written here without a dependency or Apple's tools (the server builds on Linux):
 *   - The file is a xar archive: a 28-byte big-endian header ("xar!", header size, version 1, the TOC's compressed and plain lengths,
 *     checksum kind 1 = SHA-1), the TOC as zlib-compressed XML, then the heap. The heap starts with the SHA-1 of the compressed TOC (the TOC
 *     points at it: offset 0, size 20); each file's <data> gives its offset in the heap, its length there and its SHA-1.
 *   - A product archive: `Distribution` (domains: the current user's home only, so Installer installs as the person) and one component
 *     package folder, `runner.pkg`, holding `PackageInfo` and `Scripts`. No Bom and no Payload: a payload-free package, as
 *     `pkgbuild --nopayload --scripts` makes. Installer unpacks Scripts into a private folder and runs `postinstall` from it.
 *   - `Scripts` is a gzip file of an odc ("070707") cpio archive: ./postinstall, ./kit.zip (the app and the kit, the same for everyone),
 *     ./runner.json and ./runner.enroll (this download's).
 *
 * What makes the per-download work small: the gzip holds STORED deflate blocks (the zip inside is already compressed), so the part that is
 * the same for everyone is framed, not compressed, and its bytes come from the complete build's pack as the zip download's do. The SHA-1
 * the TOC needs for Scripts comes before the heap, so the hash state after the shared part is computed once (first download after a
 * build or restart) and copied per download (Hash.copy), then only this download's few hundred bytes are hashed; the gzip CRC-32
 * continues the same way. The length is exact before anything is sent.
 */
import { createHash, type Hash } from "node:crypto";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { buildCompleteZip, personFiles, type BuildCompleteInput } from "./runner-kit-complete.js";
import { MAC_APP } from "./runner-installer.js";

export const MAC_PKG_NAME = "ai-testing-runner-mac.pkg";
export const MAC_PKG_ID = "app.aitesting.runner";
/** The component package's folder inside the product archive. */
export const MAC_PKG_COMPONENT = "runner.pkg";

/**
 * Runs after Installer unpacked Scripts. For a home-folder install Installer runs it as the person (Apple: "A home directory
 * installation is done as the current user (not as root)"); should it ever run as root, it drops to the person at the screen and
 * never runs the setup as root. POSIX sh, macOS tools only (ditto, stat, dscl, launchctl, sudo).
 */
export const POSTINSTALL = `#!/bin/sh
# AI Testing Runner: sets up the runner for the person who installs this package, as opening "AI Testing Runner.app" does.
# Installer runs this file from the folder it unpacked the package's scripts into: kit.zip, runner.json and runner.enroll are beside it.
HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
APP_NAME="${MAC_APP}"
fail() {
    printf '%s\\n' "AI Testing Runner: $*" >&2
    exit 1
}
for f in kit.zip runner.json runner.enroll; do
    [ -f "$HERE/$f" ] || fail "This package is damaged ($f is missing). Download the runner again from Settings, Your runner."
done

home_of() {
    dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p'
}
if [ "$(id -u)" = "0" ]; then
    # Never set up the runner as root: it belongs to the person signed in at the screen.
    RUN_USER=$(stat -f %Su /dev/console 2>/dev/null)
    case "$RUN_USER" in
        "" | root | loginwindow) fail "Nobody is signed in at this Mac's screen. Sign in and open the package again." ;;
    esac
    RUN_UID=$(id -u "$RUN_USER" 2>/dev/null) || fail "I could not find the account $RUN_USER."
    RUN_HOME=$(home_of "$RUN_USER")
    BASE=/private/tmp
else
    RUN_USER=$(id -un)
    RUN_UID=$(id -u)
    RUN_HOME=\${HOME:-}
    [ -n "$RUN_HOME" ] && [ -d "$RUN_HOME" ] || RUN_HOME=$(home_of "$RUN_USER")
    BASE=\${TMPDIR:-/tmp}
fi
[ -n "$RUN_HOME" ] && [ -d "$RUN_HOME" ] || fail "I could not find the home folder of $RUN_USER, so there is nowhere to install to."

# The kit, unpacked where nobody else can read it, and deleted however this ends.
TMP_DIR=$(umask 077 && mktemp -d "$BASE/ai-testing-runner.XXXXXX") || fail "I could not make a temporary folder."
trap 'rm -rf "$TMP_DIR"' EXIT
trap 'rm -rf "$TMP_DIR"; exit 130' INT TERM HUP
ditto -x -k "$HERE/kit.zip" "$TMP_DIR" || fail "This package is damaged: its runner files could not be unpacked. Download the runner again."
cp "$HERE/runner.json" "$HERE/runner.enroll" "$TMP_DIR/kit/" || fail "I could not copy this download's runner files."
chmod 600 "$TMP_DIR/kit/runner.enroll"

# The app goes to ~/Applications without any kit or code: opening it later shows the runner's status and offers Uninstall.
APPS="$RUN_HOME/Applications"
NEW_APPS=0
[ -d "$APPS" ] || NEW_APPS=1
mkdir -p "$APPS" || fail "I could not create $APPS."
rm -rf "$APPS/$APP_NAME.new"
ditto "$TMP_DIR/$APP_NAME" "$APPS/$APP_NAME.new" || fail "I could not copy the app to $APPS."
rm -rf "$APPS/$APP_NAME" && mv "$APPS/$APP_NAME.new" "$APPS/$APP_NAME" || fail "I could not replace $APPS/$APP_NAME."
SETUP="$APPS/$APP_NAME/Contents/Resources/runner-setup.sh"

if [ "$(id -u)" = "0" ]; then
    chown -R "$RUN_USER" "$TMP_DIR" "$APPS/$APP_NAME"
    [ "$NEW_APPS" = "1" ] && chown "$RUN_USER" "$APPS"
    # In the person's own login session, so the LaunchAgent lands in their gui domain.
    launchctl asuser "$RUN_UID" sudo -u "$RUN_USER" -H env HOME="$RUN_HOME" /bin/sh "$SETUP" --silent --kit-dir "$TMP_DIR/kit"
else
    HOME="$RUN_HOME" /bin/sh "$SETUP" --silent --kit-dir "$TMP_DIR/kit"
fi
`;

const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The product archive's script: one hidden choice, the user's home folder as the only destination, both Mac processors (no Rosetta question). */
export const DISTRIBUTION = `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>${xmlEscape(MAC_APP.replace(/\.app$/, ""))}</title>
    <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
    <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
    <volume-check>
        <allowed-os-versions>
            <os-version min="11.0"/>
        </allowed-os-versions>
    </volume-check>
    <choices-outline>
        <line choice="default">
            <line choice="${MAC_PKG_ID}"/>
        </line>
    </choices-outline>
    <choice id="default"/>
    <choice id="${MAC_PKG_ID}" visible="false">
        <pkg-ref id="${MAC_PKG_ID}"/>
    </choice>
    <pkg-ref id="${MAC_PKG_ID}" version="1" onConclusion="none" auth="none">#${MAC_PKG_COMPONENT}</pkg-ref>
</installer-gui-script>
`;

export const PACKAGE_INFO = `<?xml version="1.0" encoding="utf-8"?>
<pkg-info format-version="2" identifier="${MAC_PKG_ID}" version="1" install-location="/" auth="none" overwrite-permissions="true" relocatable="false">
    <payload numberOfFiles="0" installKBytes="0"/>
    <scripts>
        <postinstall file="./postinstall"/>
    </scripts>
</pkg-info>
`;

// ── cpio (odc) and stored gzip ──────────────────────────────────────────────

const octal = (n: number, width: number): string => {
    const s = n.toString(8);
    if (s.length > width) throw new Error("a cpio field is too large");
    return s.padStart(width, "0");
};

/** One odc cpio header and the name (with its NUL); the file's bytes follow it unpadded. */
export function cpioHeader(name: string, mode: number, size: number, ino: number, mtime: number): Buffer {
    const nameBytes = Buffer.from(`${name}\0`, "utf8");
    const head = `070707${octal(0, 6)}${octal(ino, 6)}${octal(mode, 6)}${octal(0, 6)}${octal(0, 6)}${octal(1, 6)}${octal(0, 6)}${octal(mtime, 11)}${octal(nameBytes.length, 6)}${octal(size, 11)}`;
    return Buffer.concat([Buffer.from(head, "ascii"), nameBytes]);
}

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const STORED_MAX = 65535;
/** gzip, deflate, no flags, no time, no extra flags, Unix. */
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);

const storedHead = (len: number, final: boolean): Buffer => {
    const h = Buffer.alloc(5);
    h[0] = final ? 1 : 0;
    h.writeUInt16LE(len, 1);
    h.writeUInt16LE(~len & 0xffff, 3);
    return h;
};

/** The bytes of `src` as stored deflate blocks of 65535 bytes (the last one shorter), none of them final. */
async function* storedBlocks(src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    let held: Buffer[] = [];
    let heldLen = 0;
    for await (const chunk of src) {
        held.push(chunk);
        heldLen += chunk.length;
        while (heldLen >= STORED_MAX) {
            const all = held.length === 1 ? held[0]! : Buffer.concat(held);
            yield storedHead(STORED_MAX, false);
            yield all.subarray(0, STORED_MAX);
            const rest = all.subarray(STORED_MAX);
            held = rest.length ? [rest] : [];
            heldLen = rest.length;
        }
    }
    if (heldLen > 0) {
        yield storedHead(heldLen, false);
        yield Buffer.concat(held);
    }
}

/** The stored-block framing of `data`, the last block final (an empty final block when there is nothing). */
function finalBlocks(data: Buffer): Buffer {
    const out: Buffer[] = [];
    let at = 0;
    do {
        const len = Math.min(STORED_MAX, data.length - at);
        out.push(storedHead(len, at + len >= data.length), data.subarray(at, at + len));
        at += len;
    } while (at < data.length);
    return Buffer.concat(out);
}

const storedBytes = (n: number): number => n + 5 * Math.ceil(n / STORED_MAX);

// ── the shared part, computed once ──────────────────────────────────────────

type SharedInput = Omit<BuildCompleteInput, "layout" | "runnerName" | "platformUrl" | "enrollCode" | "updateSequence" | "token">;

interface Shared {
    /** Bytes of Scripts up to the per-download part: the gzip header and the stored blocks of the shared cpio entries. */
    archived: number;
    /** Plain cpio bytes in them. */
    plain: number;
    sha1: Hash;
    crc: number;
    /** The shared cpio bytes again, for each download (the big part read from the pack, nothing compressed again). */
    stream: () => AsyncIterable<Buffer>;
}

/** Everything that is the same for every download of this build: postinstall, the zip of the app and the kit. Mtime 0 keeps it byte-stable. */
function sharedCpio(i: SharedInput): { stream: () => AsyncIterable<Buffer>; plain: number } {
    const post = Buffer.from(POSTINSTALL, "utf8");
    const zip = buildCompleteZip({ ...i, layout: "mac-pkg", platformUrl: "" });
    zip.stream.destroy();
    const again = zip.again!;
    const heads = Buffer.concat([cpioHeader(".", S_IFDIR | 0o755, 0, 1, 0), cpioHeader("./postinstall", S_IFREG | 0o755, post.length, 2, 0), post, cpioHeader("./kit.zip", S_IFREG | 0o644, zip.bytes, 3, 0)]);
    return {
        plain: heads.length + zip.bytes,
        stream: async function* () {
            yield heads;
            yield* again();
        },
    };
}

/** Keyed by what goes into the shared part; a new build, app or runner bundle makes a new key. Few entries: one per Mac processor. */
const sharedCache = new Map<string, Promise<Shared>>();
const MAX_SHARED = 4;

function sharedKey(i: SharedInput): string {
    const h = createHash("sha256");
    h.update(`${i.build ? `${i.build.packPath}|${i.build.manifest.packSha256}` : "plain"}\n`);
    for (const f of i.installer?.files ?? []) h.update(`${f.name}|${f.mode}|`).update(f.data);
    for (const [name, data] of [...i.bundle.files.entries()].sort(([a], [b]) => a.localeCompare(b))) h.update(`${name}|`).update(data);
    return h.digest("hex");
}

async function shared(i: SharedInput): Promise<Shared> {
    const key = sharedKey(i);
    let s = sharedCache.get(key);
    if (!s) {
        s = (async () => {
            const sha1 = createHash("sha1").update(GZIP_HEADER);
            let crc = 0;
            let archived = GZIP_HEADER.length;
            const cpio = sharedCpio(i);
            async function* counted(): AsyncGenerator<Buffer> {
                for await (const b of cpio.stream()) {
                    crc = zlib.crc32(b, crc);
                    yield b;
                }
            }
            for await (const b of storedBlocks(counted())) {
                sha1.update(b);
                archived += b.length;
            }
            if (archived !== GZIP_HEADER.length + storedBytes(cpio.plain)) throw new Error("the shared part of the Mac package came out at another length");
            return { archived, plain: cpio.plain, sha1, crc, stream: cpio.stream };
        })();
        if (sharedCache.size >= MAX_SHARED) sharedCache.delete(sharedCache.keys().next().value!);
        sharedCache.set(key, s);
        s.catch(() => sharedCache.delete(key));
    }
    return s;
}

// ── the package ─────────────────────────────────────────────────────────────

interface XarFile {
    name: string;
    offset: number;
    data: { length: number; sha1: string };
}

function tocXml(files: XarFile[], when: string): string {
    const data = (f: XarFile): string =>
        `<data><length>${f.data.length}</length><offset>${f.offset}</offset><size>${f.data.length}</size><encoding style="application/octet-stream"/><extracted-checksum style="sha1">${f.data.sha1}</extracted-checksum><archived-checksum style="sha1">${f.data.sha1}</archived-checksum></data>`;
    const file = (id: number, f: XarFile, mode: string): string =>
        `<file id="${id}">${data(f)}<ctime>${when}</ctime><mtime>${when}</mtime><atime>${when}</atime><group>wheel</group><gid>0</gid><user>root</user><uid>0</uid><mode>${mode}</mode><type>file</type><name>${xmlEscape(f.name)}</name></file>`;
    const [dist, info, scripts] = files as [XarFile, XarFile, XarFile];
    return `<?xml version="1.0" encoding="UTF-8"?>
<xar><toc><checksum style="sha1"><offset>0</offset><size>20</size></checksum><creation-time>${when}</creation-time>${file(1, dist, "0644")}<file id="2"><ctime>${when}</ctime><mtime>${when}</mtime><atime>${when}</atime><group>wheel</group><gid>0</gid><user>root</user><uid>0</uid><mode>0755</mode><type>directory</type><name>${MAC_PKG_COMPONENT}</name>${file(3, info, "0644")}${file(4, scripts, "0644")}</file></toc></xar>
`;
}

const sha1Hex = (b: Buffer): string => createHash("sha1").update(b).digest("hex");

/**
 * This download's package, as a stream and its exact length. Async only the first time after a build or restart (the shared part is
 * hashed once, reading the pack once); after that only this download's few hundred bytes are hashed.
 */
export async function buildMacPkg(i: Omit<BuildCompleteInput, "layout">): Promise<{ stream: Readable; bytes: number }> {
    if (!i.installer) throw new Error("the Mac package needs the app");
    const { runnerName: _n, platformUrl: _u, enrollCode: _c, updateSequence: _s, token: _t, ...rest } = i;
    const sharedInput: SharedInput = rest;
    const s = await shared(sharedInput);
    // This download's files, the cpio trailer, the final block and the gzip trailer.
    const person = personFiles(i);
    const tailCpio = Buffer.concat([...person.flatMap((f, n) => [cpioHeader(`./${f.name}`, S_IFREG | f.mode, f.data.length, 4 + n, 0), f.data]), cpioHeader("TRAILER!!!", 0, 0, 0, 0)]);
    const trailer = Buffer.alloc(8);
    trailer.writeUInt32LE(zlib.crc32(tailCpio, s.crc) >>> 0, 0);
    trailer.writeUInt32LE((s.plain + tailCpio.length) % 0x100000000, 4);
    const tail = Buffer.concat([finalBlocks(tailCpio), trailer]);
    const scriptsLength = s.archived + tail.length;
    const scriptsSha1 = s.sha1.copy().update(tail).digest("hex");

    const dist = Buffer.from(DISTRIBUTION, "utf8");
    const info = Buffer.from(PACKAGE_INFO, "utf8");
    const files: XarFile[] = [
        { name: "Distribution", offset: 20, data: { length: dist.length, sha1: sha1Hex(dist) } },
        { name: "PackageInfo", offset: 20 + dist.length, data: { length: info.length, sha1: sha1Hex(info) } },
        { name: "Scripts", offset: 20 + dist.length + info.length, data: { length: scriptsLength, sha1: scriptsSha1 } },
    ];
    const toc = Buffer.from(tocXml(files, new Date().toISOString().replace(/\.\d{3}Z$/, "Z")), "utf8");
    const tocZ = zlib.deflateSync(toc, { level: 9 });
    const header = Buffer.alloc(28);
    header.write("xar!", 0, "ascii");
    header.writeUInt16BE(28, 4);
    header.writeUInt16BE(1, 6);
    header.writeBigUInt64BE(BigInt(tocZ.length), 8);
    header.writeBigUInt64BE(BigInt(toc.length), 16);
    header.writeUInt32BE(1, 24);
    const head = Buffer.concat([header, tocZ, createHash("sha1").update(tocZ).digest(), dist, info]);
    async function* body(): AsyncGenerator<Buffer> {
        yield head;
        yield GZIP_HEADER;
        yield* storedBlocks(s.stream());
        yield tail;
    }
    return { stream: Readable.from(body(), { objectMode: false }), bytes: head.length + scriptsLength };
}
