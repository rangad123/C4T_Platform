/**
 * The Linux download as one file (round 50): `ai-testing-runner.sh`, a short POSIX sh header with the kit as a gzip tar at its end. The
 * person runs `sh ai-testing-runner.sh`; the header unpacks the kit (`tail -c +N "$0" | tar xzf -`, which every Linux has: no unzip, no
 * extra package) into a private temporary folder (0700), moves the runner's files into its install folder (~/.local/share/ai-testing-runner,
 * or $XDG_DATA_HOME/ai-testing-runner), deletes the temporary folder and runs start-runner.sh from there, in the person's window.
 *
 * The tar is written here without a dependency, as a series of gzip members (a gzip file may hold several one after another; gzip, GNU tar,
 * busybox and bsdtar all read them as one stream). Each file's bytes are its raw deflate data unchanged (from the complete build's pack, or
 * compressed per download for the small files), wrapped in a gzip member with the CRC-32 and size the build already recorded, so the big
 * part is never compressed again and the length is known before anything is sent. Tar headers (ustar, with a pax record for a long name)
 * are compressed on the spot.
 *
 * A new download replaces a running runner: when the install folder's recorded runner (runner.pid, its command line checked, never a name)
 * is running and this download's one-time code was not copied before, the header stops it first (TERM to the runner and its start script,
 * as Ctrl-C does). Without a new code it says the runner is already running and changes nothing. The code is copied into the install
 * folder only once (enroll-copied holds its hash, never the code); the runner deletes it when it trades it.
 */
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { packedBodies, type PackedFile } from "./runner-kit-complete.js";

export const LINUX_SCRIPT_NAME = "ai-testing-runner.sh";

/** The header. `@SKIP@` becomes the byte where the payload starts (tail -c +N counts from 1). Plain POSIX sh: dash, bash, busybox ash. */
const HEADER = `#!/bin/sh
# AI Testing Runner for Linux, in one file. Run it in a terminal:  sh ai-testing-runner.sh
# It unpacks the runner kept at the end of this file into a private temporary folder, installs it in your own folder
# (~/.local/share/ai-testing-runner), deletes the temporary folder and starts the runner in this window. No sudo, nothing system-wide.
# The file holds a one-time code for your runner: delete it once the runner is connected. Do not edit it (its end is not text).
AITP_SKIP=@SKIP@

say() {
    printf '%s\\n' "$*"
}
fail() {
    say "$*" >&2
    exit 1
}

say ""
say "AI Testing Runner"
say ""
[ "$(uname -s 2>/dev/null)" = "Linux" ] || fail "This file is the runner for Linux. On a Mac or on Windows, download the runner for that computer from Settings, Your runner."
SELF=$0
[ -f "$SELF" ] || fail "Run this file by its name, so it can read the runner from its own end:  sh ai-testing-runner.sh"
[ -n "\${HOME:-}" ] && [ -d "$HOME" ] || fail "This account has no home folder that I can find (HOME is not set), so there is nowhere to install to."
for tool in tail tar mktemp cmp; do
    command -v "$tool" >/dev/null 2>&1 || fail "This computer has no $tool, which unpacking the runner needs. Install it with your package manager and run this file again."
done

# Where the runner lives. AITP_RUNNER_INSTALL_DIR is for tests and unusual setups.
INSTALL_DIR=\${AITP_RUNNER_INSTALL_DIR:-\${XDG_DATA_HOME:-$HOME/.local/share}/ai-testing-runner}
case "$INSTALL_DIR" in
    /*) ;;
    *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
esac
INSTALL_DIR=\${INSTALL_DIR%/}
PIDFILE="$INSTALL_DIR/runner.pid"
SENTINEL="$INSTALL_DIR/.created-by-ai-testing-runner"
# The hash of the last one-time code copied from a download (never the code), so running the same file again does not reuse a spent code.
ENROLL_SEEN="$INSTALL_DIR/enroll-copied"

# The kit, unpacked where nobody else can read it, and deleted however this ends.
TMP_DIR=$(umask 077 && mktemp -d "\${TMPDIR:-/tmp}/ai-testing-runner.XXXXXX") || fail "I could not make a temporary folder."
chmod 700 "$TMP_DIR"
cleanup() {
    [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"
    TMP_DIR=""
}
trap 'cleanup' EXIT
trap 'cleanup; exit 130' INT TERM HUP
say "Unpacking the runner ..."
if ! (umask 077 && tail -c +"$AITP_SKIP" "$SELF" | tar xzf - -C "$TMP_DIR"); then
    fail "This file is damaged or incomplete, so it could not be unpacked. Download the runner again from Settings, Your runner."
fi
for f in runner.mjs runner.json start-runner.sh; do
    [ -f "$TMP_DIR/$f" ] || fail "This file is damaged ($f is missing). Download the runner again from Settings, Your runner."
done

if [ -d "$INSTALL_DIR" ] && [ ! -f "$SENTINEL" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    fail "The folder $INSTALL_DIR already holds files that the runner did not put there. Nothing was changed."
fi
mkdir -p "$INSTALL_DIR" || fail "I could not create $INSTALL_DIR."
[ -f "$SENTINEL" ] || printf '%s\\n' "Made by the AI Testing Runner (ai-testing-runner.sh). To remove the runner: node runner.mjs --forget-credential here, then delete this folder." >"$SENTINEL"
chmod 700 "$INSTALL_DIR"

sha_of() {
    { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1" 2>/dev/null || cksum "$1"; } | {
        read -r so_hash _so_rest
        printf '%s' "$so_hash"
    }
}
NEW_CODE=0
if [ -f "$TMP_DIR/runner.enroll" ] && [ "$(sha_of "$TMP_DIR/runner.enroll")" != "$(head -n 1 "$ENROLL_SEEN" 2>/dev/null)" ]; then
    NEW_CODE=1
fi

# The runner this file started earlier: the pid it recorded, believed only while that process still runs this folder's start-runner.sh.
pid_command() {
    tr '\\0' ' ' <"/proc/$1/cmdline" 2>/dev/null
}
runner_pid() {
    [ -f "$PIDFILE" ] || return 1
    rp_pid=$(head -n 1 "$PIDFILE" 2>/dev/null | tr -d ' \\r')
    case "$rp_pid" in
        '' | *[!0-9]*) return 1 ;;
    esac
    kill -0 "$rp_pid" 2>/dev/null || return 1
    case "$(pid_command "$rp_pid")" in
        *"$INSTALL_DIR/start-runner.sh"*)
            printf '%s' "$rp_pid"
            return 0
            ;;
    esac
    return 1
}
# stop_runner PID: what Ctrl-C does in its window: TERM to the runner (node runner.mjs, a child of that script) and to the script.
stop_runner() {
    say "A new download: stopping the runner that is running from the earlier one (process $1)."
    for sr_dir in /proc/[0-9]*; do
        sr_stat=$(cat "$sr_dir/stat" 2>/dev/null) || continue
        sr_stat=\${sr_stat##*) }
        set -- "$1" $sr_stat
        [ "$3" = "$1" ] || continue
        # The runner renames itself (process.title "ai-test-agent"), which replaces its command line.
        case "$(pid_command "\${sr_dir#/proc/}")" in
            *runner.mjs* | ai-test-agent*) kill -TERM "\${sr_dir#/proc/}" 2>/dev/null ;;
        esac
    done
    kill -TERM "$1" 2>/dev/null
    sr_i=0
    while [ "$sr_i" -lt 30 ] && kill -0 "$1" 2>/dev/null; do
        sleep 1
        sr_i=$((sr_i + 1))
    done
    if kill -0 "$1" 2>/dev/null; then
        case "$(pid_command "$1")" in
            *"$INSTALL_DIR/start-runner.sh"*) kill -KILL "$1" 2>/dev/null ;;
        esac
    fi
    rm -f "$PIDFILE"
}
if RUNNING=$(runner_pid); then
    if [ "$NEW_CODE" != "1" ]; then
        say "The AI Testing runner is already running on this computer (process $RUNNING), from $INSTALL_DIR."
        say "Nothing was changed. To set it up again, download a new runner from Settings, Your runner, and run that file."
        exit 0
    fi
    stop_runner "$RUNNING"
fi

# The runner's files, moved from the temporary folder (only those that changed). Its work folder and saved access stay.
put_file() {
    [ -f "$TMP_DIR/$1" ] || return 0
    if [ -f "$INSTALL_DIR/$1" ] && cmp -s "$TMP_DIR/$1" "$INSTALL_DIR/$1"; then
        return 0
    fi
    mv -f "$TMP_DIR/$1" "$INSTALL_DIR/$1.new" && mv -f "$INSTALL_DIR/$1.new" "$INSTALL_DIR/$1" || fail "I could not copy $1 to $INSTALL_DIR. Check the free disk space."
}
# put_dir NAME MARKER: a complete download's node or node_modules folder, replaced as a whole when its marker file differs.
put_dir() {
    [ -d "$TMP_DIR/$1" ] || return 0
    if [ -f "$INSTALL_DIR/$2" ] && cmp -s "$TMP_DIR/$2" "$INSTALL_DIR/$2"; then
        return 0
    fi
    rm -rf "$INSTALL_DIR/$1.new" "$INSTALL_DIR/$1.old"
    mv "$TMP_DIR/$1" "$INSTALL_DIR/$1.new" || fail "I could not copy $1 to $INSTALL_DIR. Check the free disk space."
    if [ -e "$INSTALL_DIR/$1" ]; then
        mv "$INSTALL_DIR/$1" "$INSTALL_DIR/$1.old" || fail "I could not replace $INSTALL_DIR/$1."
    fi
    mv "$INSTALL_DIR/$1.new" "$INSTALL_DIR/$1" || fail "I could not copy $1 to $INSTALL_DIR."
    rm -rf "$INSTALL_DIR/$1.old"
}
for f in runner.mjs task-child.mjs record-child.mjs package.json package-lock.json LICENSES.txt runner.json complete-kit.json start-runner.sh check-computer.sh; do
    put_file "$f"
done
put_dir node node/bin/node
put_dir node_modules node_modules/.aitp-complete
if [ "$NEW_CODE" = "1" ]; then
    # A new one-time code replaces the runner's saved access (on Linux the file runner.credential in its work folder: a saved credential
    # would win over the code) and an older download's token; the runner trades the code at its first start and deletes it.
    find "$INSTALL_DIR" -maxdepth 2 -name runner.credential -type f -exec rm -f {} + 2>/dev/null
    mv -f "$TMP_DIR/runner.enroll" "$INSTALL_DIR/runner.enroll" || fail "I could not copy the one-time code to $INSTALL_DIR."
    chmod 600 "$INSTALL_DIR/runner.enroll"
    rm -f "$INSTALL_DIR/runner.token"
    sha_of "$INSTALL_DIR/runner.enroll" >"$ENROLL_SEEN"
fi
cleanup
trap - EXIT INT TERM HUP

say "Installed in $INSTALL_DIR. To check this computer later:  sh \\"$INSTALL_DIR/check-computer.sh\\""
say "You can delete this file now: it is not needed again, and its one-time code works once."
cd "$INSTALL_DIR" || fail "The folder $INSTALL_DIR is missing."
printf '%s\\n' "$$" >"$PIDFILE"
exec sh "$INSTALL_DIR/start-runner.sh"
exit 1
`;

/** The header with the payload's start filled in. Its length depends on the number's own digits, so it is settled in a short loop. */
export function linuxHeader(): Buffer {
    let start = Buffer.byteLength(HEADER) + 1;
    for (;;) {
        const h = Buffer.from(HEADER.replace("@SKIP@", String(start)), "utf8");
        if (h.length + 1 === start) return h;
        start = h.length + 1;
    }
}

// ── the tar, as gzip members ────────────────────────────────────────────────

const BLOCK = 512;
const octal = (n: number, width: number): string => n.toString(8).padStart(width - 1, "0");

function ustarHeader(name: string, prefix: string, size: number, mode: number, mtime: number, type: "0" | "x"): Buffer {
    const h = Buffer.alloc(BLOCK);
    h.write(name, 0, 100, "utf8");
    h.write(`${octal(mode, 8)}\0`, 100, "latin1");
    h.write(`${octal(0, 8)}\0`, 108, "latin1");
    h.write(`${octal(0, 8)}\0`, 116, "latin1");
    h.write(`${octal(size, 12)}\0`, 124, "latin1");
    h.write(`${octal(mtime, 12)}\0`, 136, "latin1");
    h.fill(0x20, 148, 156);
    h.write(type, 156, "latin1");
    h.write("ustar\0" + "00", 257, "latin1");
    h.write(prefix, 345, 155, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${octal(sum, 7)}\0 `, 148, "latin1");
    return h;
}

/** The header block(s) for one file: ustar, with the name split into prefix/name when it is long, or a pax record when even that does not fit. */
export function tarHeader(name: string, size: number, mode: number, mtime: number): Buffer {
    const len = (s: string) => Buffer.byteLength(s, "utf8");
    if (len(name) <= 100) return ustarHeader(name, "", size, mode, mtime, "0");
    for (let i = name.indexOf("/"); i > 0; i = name.indexOf("/", i + 1)) {
        if (len(name.slice(0, i)) <= 155 && len(name.slice(i + 1)) <= 100) return ustarHeader(name.slice(i + 1), name.slice(0, i), size, mode, mtime, "0");
    }
    // "<length> path=<name>\n", where the length counts itself.
    const body = ` path=${name}\n`;
    let n = len(body) + 1;
    while (String(n).length + len(body) !== n) n = String(n).length + len(body);
    const record = Buffer.from(`${n}${body}`, "utf8");
    const padded = Buffer.alloc(Math.ceil(record.length / BLOCK) * BLOCK);
    record.copy(padded);
    return Buffer.concat([ustarHeader("PaxHeader", "", record.length, 0o644, mtime, "x"), padded, ustarHeader(Buffer.from(name).subarray(0, 100).toString("utf8").replace(/\uFFFD+$/, ""), "", size, mode, mtime, "0")]);
}

const GZIP_HEAD = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
const gzipTrailer = (crc: number, size: number): Buffer => {
    const t = Buffer.alloc(8);
    t.writeUInt32LE(crc >>> 0, 0);
    t.writeUInt32LE(size >>> 0, 4);
    return t;
};
const padTo = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

/**
 * The script: the header, then for each file a gzip member with (the previous file's padding and) its tar header, and one with its bytes;
 * then the tar's end. As a stream with its exact length, like the zip (runner-kit-complete.ts).
 */
export function linuxScript(files: PackedFile[], packPath: string | undefined, mtime = Math.floor(Date.now() / 1000)): { stream: Readable; bytes: number } {
    const header = linuxHeader();
    let pad = 0;
    const heads = files.map((f) => {
        const member = zlib.gzipSync(Buffer.concat([Buffer.alloc(pad), tarHeader(f.name, f.size, f.mode, mtime)]));
        pad = padTo(f.size);
        return member;
    });
    const end = zlib.gzipSync(Buffer.alloc(pad + 2 * BLOCK));
    let bytes = header.length + end.length;
    files.forEach((f, n) => (bytes += heads[n]!.length + GZIP_HEAD.length + f.csize + 8));
    async function* body(): AsyncGenerator<Buffer> {
        yield header;
        yield* packedBodies(files, packPath, (f, n) => ({ before: Buffer.concat([heads[n]!, GZIP_HEAD]), after: gzipTrailer(f.crc, f.size) }));
        yield end;
    }
    return { stream: Readable.from(body(), { objectMode: false }), bytes };
}
