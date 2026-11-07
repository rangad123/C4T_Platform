#!/bin/sh
# AI Testing Runner for macOS: checks what this Mac already has, downloads only what is missing, and starts the runner.
#
#   runner-setup.sh [--check] [--silent | --yes] [--no-start] [--autostart | --no-autostart]
#                   [--install-dir DIR] [--kit-dir DIR] [--log FILE] [--uninstall]
#
#   --check         Say what would be downloaded and change nothing. Exit 0: nothing to download. 10: something would be. 1: error.
#   --silent        No dialogs and no questions (for administrators and scripts); the default answers are used. --yes: the same.
#   --no-start      Set everything up, do not start the runner.
#   --autostart     Run the runner in the background, also after every sign-in (a LaunchAgent). This is the default answer, and what
#                   --silent does. --no-autostart: run it in this Terminal window instead, and do not ask.
#   --install-dir   Where to install. Default: ~/Library/Application Support/AITestingRunner
#   --kit-dir       The unzipped runner kit (runner.mjs, runner.json, runner.enroll, ...). Default: the folder that holds this app.
#   --log FILE      Also write what is printed to FILE.
#   --uninstall     Stop the runner this installer started, remove its LaunchAgent and the install folder it created.
#
# Everything is per user: no sudo, no system changes. POSIX sh only (a Mac's /bin/sh is bash 3.2 in POSIX mode): no arrays, no [[ ]],
# no `local`, no GNU-only options. Every path is quoted, so a folder name with spaces, brackets or an ampersand is fine.
#
# Test-only environment variables (documented in docs/features/runner-installer-mac.md; nobody needs them):
#   AITP_NODE_DIST_URL                 download Node.js from here instead of https://nodejs.org/dist (the checksum comes from the same
#                                      place, so this is NOT a security setting)
#   AITP_INSTALLER_SKIP_NPM=1          do not run npm install
#   AITP_INSTALLER_NODE_SEARCH_ONLY=   look for Node.js only in these folders (colon separated; empty means nowhere)
#   AITP_INSTALLER_NO_UI=1             never show a dialog or a notification
#   AITP_INSTALLER_UNAME_S / _UNAME_M  pretend to be this system and machine (Darwin, arm64, x86_64)
#   AITP_INSTALLER_PROC_TRANSLATED=1   pretend to run under Rosetta
#   AITP_INSTALLER_WAIT_SECONDS        how long to wait for the background runner to connect (default 20)
#   AITP_INSTALLER_NO_PAUSE=1          do not wait for Enter at the end
#   AITP_KIT_SKIP_SHELL_SEARCH=1       do not ask the login shell where Node.js is (same switch as start-runner.sh)

APP_TITLE="AI Testing Runner"
LABEL="app.aitesting.runner"
NODE_MIN=24
# Used only when https://nodejs.org/dist/index.json cannot be read. Not run on a Mac here: if this exact version were ever withdrawn,
# the download says so plainly and the person installs Node.js from nodejs.org.
NODE_FALLBACK="24.11.0"
NODE_DIST_DEFAULT="https://nodejs.org/dist"
# What every download holds. The credential is separate: runner.enroll (a one-time code, from round 39 on) or, in an older download,
# runner.token. package-lock.json is in every download from round 39 on.
KIT_FILES="runner.mjs task-child.mjs record-child.mjs package.json LICENSES.txt runner.json"
KIT_OPTIONAL="package-lock.json"
# Logs: rotated at this size while the runner runs, keeping this many older files (runner.log.1 ... and launchd.log.1 ...).
LOG_MAX_BYTES=${AITP_INSTALLER_LOG_MAX_BYTES:-5000000}
LOG_KEEP=3
NL='
'

# ---------------------------------------------------------------- small helpers (defined first: the arguments are read below)

say() {
    printf '%s\n' "$*"
    if [ -n "$LOG_FILE" ]; then
        printf '%s\n' "$*" >>"$LOG_FILE" 2>/dev/null
    fi
}

step() {
    # step NUMBER "name" "what happened": one line in the shape  [1/5] Node.js 24 or newer ... found (v26.1.0 at /opt/homebrew/bin), skipped
    say "[$1/5] $2 ... $3"
}

print_usage() {
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

usage_error() {
    printf '%s\n' "$1" >&2
    printf '%s\n' "Run it with --help to see the options." >&2
    exit 1
}

SILENT=0
NO_START=0
MODE=run
AUTOSTART=""
INSTALL_DIR=""
LOG_FILE=""
KIT_DIR_ARG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --check) MODE=check ;;
        --uninstall) MODE=uninstall ;;
        --run-loop) MODE=loop ;;
        --silent | --yes) SILENT=1 ;;
        --no-start) NO_START=1 ;;
        --autostart) AUTOSTART=yes ;;
        --no-autostart) AUTOSTART=no ;;
        --install-dir | --log | --kit-dir)
            if [ $# -lt 2 ] || [ -z "$2" ]; then
                usage_error "The option $1 needs a value."
            fi
            case "$1" in
                --install-dir) INSTALL_DIR=$2 ;;
                --log) LOG_FILE=$2 ;;
                --kit-dir) KIT_DIR_ARG=$2 ;;
            esac
            shift
            ;;
        -h | --help)
            print_usage
            exit 0
            ;;
        *) usage_error "Unknown option: $1" ;;
    esac
    shift
done

if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
    printf '%s\n' "This Mac account has no home folder that I can find (HOME is not set), so there is nowhere to install to." >&2
    exit 1
fi

make_absolute() {
    case "$1" in
        /*) printf '%s' "$1" ;;
        *) printf '%s/%s' "$PWD" "$1" ;;
    esac
}

if [ -z "$INSTALL_DIR" ]; then
    INSTALL_DIR="$HOME/Library/Application Support/AITestingRunner"
fi
INSTALL_DIR=$(make_absolute "$INSTALL_DIR")
INSTALL_DIR=${INSTALL_DIR%/}
if [ -n "$LOG_FILE" ]; then
    LOG_FILE=$(make_absolute "$LOG_FILE")
fi
if [ -n "$KIT_DIR_ARG" ]; then
    KIT_DIR_ARG=$(make_absolute "$KIT_DIR_ARG")
fi

RUNNER_DIR="$INSTALL_DIR/runner"
NODE_PRIVATE="$INSTALL_DIR/node"
LOG_DIR="$INSTALL_DIR/logs"
PIDFILE="$INSTALL_DIR/runner.pid"
SENTINEL="$INSTALL_DIR/.created-by-ai-testing-runner"
NODE_PATH_FILE="$INSTALL_DIR/node-path"
INSTALLED_SCRIPT="$INSTALL_DIR/runner-setup.sh"
AGENT_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNLOG="$LOG_DIR/runner.log"
LAUNCHD_LOG="$LOG_DIR/launchd.log"
# The sha256 of the last enrollment file copied from a download (never the code itself), so opening the app again from the same
# unzipped folder does not copy an already used code over a runner that is working.
ENROLL_SEEN="$INSTALL_DIR/enroll-copied"

# Where this script lives: inside "AI Testing Runner.app/Contents/Resources", or (the copy the LaunchAgent runs) in the install folder.
SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
APP_DIR=""
case "$SELF_DIR" in
    */Contents/Resources) APP_DIR=${SELF_DIR%/Contents/Resources} ;;
esac

NODE_BIN=""
NODE_VER=""
OLD_NODES=""
OLD_SEEN="|"
NODE_SEARCHED=0
DOWNLOADS=0
# The Node.js a complete download carries (set by find_node when the unzipped kit has a node/bin/node that starts).
KIT_NODE=""

# ---------------------------------------------------------------- dialogs (osascript is part of every Mac; all of this is optional)

ui_available() {
    [ "$SILENT" = "1" ] && return 1
    [ "$MODE" = "check" ] && return 1
    [ "${AITP_INSTALLER_NO_UI:-}" = "1" ] && return 1
    [ -n "${SSH_CONNECTION:-}" ] && return 1
    command -v osascript >/dev/null 2>&1 || return 1
    return 0
}

# applescript "script text" ARGS...: run the script with the arguments as argv (so no text is ever pasted into AppleScript source).
# Prints what the script returns; the status is 0 when it ran, 1 when the person pressed Cancel, 2 when no dialog could be shown.
applescript() {
    as_text=$1
    shift
    as_file=$(mktemp "${TMPDIR:-/tmp}/aitp-dialog.XXXXXX" 2>/dev/null) || return 2
    printf '%s\n' "$as_text" >"$as_file"
    as_out=$(osascript "$as_file" "$@" 2>&1 </dev/null)
    as_status=$?
    rm -f "$as_file"
    if [ "$as_status" -eq 0 ]; then
        printf '%s\n' "$as_out"
        return 0
    fi
    case "$as_out" in
        *-128* | *"User canceled"*) return 1 ;;
    esac
    return 2
}

# dialog_choice "text" "left button" "right button": 0 = right button (the "yes"), 1 = left button or Cancel, 2 = no dialog possible.
dialog_choice() {
    dc_answer=$(applescript 'on run argv
set r to display dialog (item 1 of argv) with title (item 4 of argv) buttons {item 2 of argv, item 3 of argv} default button (item 3 of argv) cancel button (item 2 of argv)
return button returned of r
end run' "$1" "$2" "$3" "$APP_TITLE")
    dc_status=$?
    if [ "$dc_status" -ne 0 ]; then
        return "$dc_status"
    fi
    if [ "$dc_answer" = "$3" ]; then
        return 0
    fi
    return 1
}

# confirm "text" "no label" "yes label" DEFAULT(yes|no): ask in a dialog, else in the Terminal window, else use the default.
confirm() {
    if ui_available; then
        dialog_choice "$1" "$2" "$3"
        cf_status=$?
        if [ "$cf_status" -eq 0 ]; then return 0; fi
        if [ "$cf_status" -eq 1 ]; then return 1; fi
    fi
    if [ "$SILENT" != "1" ] && [ -t 0 ]; then
        printf '%s\n%s [y/n] ' "$1" "$3?"
        read -r cf_answer
        case "$cf_answer" in
            y | Y | yes | Yes) return 0 ;;
        esac
        return 1
    fi
    [ "$4" = "yes" ]
}

notify() {
    ui_available || return 0
    applescript 'on run argv
display notification (item 1 of argv) with title (item 2 of argv)
end run' "$1" "$APP_TITLE" >/dev/null
    return 0
}

show_alert() {
    ui_available || return 0
    applescript 'on run argv
display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button "OK" with icon stop
end run' "$1" "$APP_TITLE" >/dev/null
    return 0
}

pause_if_interactive() {
    if [ "$SILENT" != "1" ] && [ "$MODE" != "check" ] && [ "${AITP_INSTALLER_NO_PAUSE:-}" != "1" ] && [ -t 0 ]; then
        printf 'Press Enter to close this window. '
        read -r pi_ignored
    fi
    return 0
}

# die "what happened and what to do": the last thing a failed run says.
die() {
    say ""
    say "$1"
    show_alert "$1"
    pause_if_interactive
    exit 1
}

# ---------------------------------------------------------------- this Mac: system and processor

detect_platform() {
    OS_NAME=${AITP_INSTALLER_UNAME_S:-$(uname -s 2>/dev/null)}
    MACHINE=${AITP_INSTALLER_UNAME_M:-$(uname -m 2>/dev/null)}
    if [ "$OS_NAME" != "Darwin" ]; then
        return 1
    fi
    TRANSLATED=${AITP_INSTALLER_PROC_TRANSLATED:-}
    if [ -z "$TRANSLATED" ]; then
        # 1 when this shell runs under Rosetta on an Apple silicon Mac; the setting does not exist on an Intel Mac.
        TRANSLATED=$(sysctl -n sysctl.proc_translated 2>/dev/null) || TRANSLATED=0
    fi
    case "$MACHINE" in
        arm64 | aarch64)
            NODE_ARCH=arm64
            ARCH_WORDS="Apple silicon"
            ;;
        x86_64 | amd64)
            if [ "$TRANSLATED" = "1" ]; then
                # An Intel shell on an Apple silicon Mac: the native build is faster and it is what the tests should use.
                NODE_ARCH=arm64
                ARCH_WORDS="Apple silicon, seen through Rosetta"
            else
                NODE_ARCH=x64
                ARCH_WORDS="Intel"
            fi
            ;;
        *) return 2 ;;
    esac
    return 0
}

# ---------------------------------------------------------------- finding Node.js (same order as start-runner.sh in the runner kit)

# try_node FILE: is FILE a usable Node.js? Sets NODE_BIN and NODE_VER if it is NODE_MIN or newer; remembers an older one for the message.
try_node() {
    [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ] || return 1
    tn_out=$("$1" --version 2>/dev/null </dev/null) || return 1
    tn_ver=${tn_out#v}
    tn_ver=${tn_ver%%[!0-9.]*}
    tn_major=${tn_ver%%.*}
    case "$tn_major" in
        '' | *[!0-9]*) return 1 ;;
    esac
    if [ "$tn_major" -ge "$NODE_MIN" ]; then
        NODE_BIN=$1
        NODE_VER=v$tn_ver
        return 0
    fi
    case "$OLD_SEEN" in
        *"|$1|"*) ;;
        *)
            OLD_SEEN="$OLD_SEEN$1|"
            OLD_NODES="$OLD_NODES""v$tn_ver at $1$NL"
            ;;
    esac
    return 1
}

try_dirs() {
    while IFS= read -r td_dir; do
        if [ -n "$td_dir" ] && try_node "$td_dir/node"; then
            return 0
        fi
    done <<EOF
$1
EOF
    return 1
}

try_lines() {
    while IFS= read -r tl_line; do
        case "$tl_line" in
            /*)
                if try_node "$tl_line"; then
                    return 0
                fi
                ;;
        esac
    done <<EOF
$1
EOF
    return 1
}

# bounded SECONDS COMMAND...: print what COMMAND prints, but give up on it after SECONDS (a Mac has no timeout command).
bounded() {
    bd_secs=$1
    shift
    bd_file=$(mktemp "${TMPDIR:-/tmp}/aitp-node.XXXXXX" 2>/dev/null) || return 1
    "$@" </dev/null >"$bd_file" 2>/dev/null &
    bd_pid=$!
    (
        bd_i=0
        while [ "$bd_i" -lt "$bd_secs" ] && kill -0 "$bd_pid" 2>/dev/null; do
            sleep 1
            bd_i=$((bd_i + 1))
        done
        kill -9 "$bd_pid" 2>/dev/null
    ) >/dev/null 2>&1 &
    wait "$bd_pid" 2>/dev/null
    cat "$bd_file" 2>/dev/null
    rm -f "$bd_file"
    return 0
}

# find_node: the Node.js this installer put in its own folder first, then the same places start-runner.sh looks; the first one that is
# NODE_MIN or newer wins. AITP_INSTALLER_NODE_SEARCH_ONLY (tests) narrows the search to the folders it names.
find_node() {
    NODE_BIN=""
    NODE_VER=""
    OLD_NODES=""
    OLD_SEEN="|"
    KIT_NODE=""
    # A complete download carries its own Node.js (node/bin/node next to the runner files): that one comes first. Some unzip tools drop
    # the executable bit, so it is put back (the unzipped folder is the person's own).
    if [ -n "$KIT_SRC" ] && [ -f "$KIT_SRC/node/bin/node" ]; then
        [ -x "$KIT_SRC/node/bin/node" ] || chmod u+x "$KIT_SRC/node/bin/node" 2>/dev/null
        if try_node "$KIT_SRC/node/bin/node"; then
            KIT_NODE=$NODE_BIN
            return 0
        fi
    fi
    if [ -x "$NODE_PRIVATE/bin/node" ] && try_node "$NODE_PRIVATE/bin/node"; then
        return 0
    fi
    if [ "${AITP_INSTALLER_NODE_SEARCH_ONLY+set}" = "set" ]; then
        try_dirs "$(printf '%s\n' "$AITP_INSTALLER_NODE_SEARCH_ONLY" | tr ':' '\n')" && return 0
        return 1
    fi
    # 1. Whatever "node" means right now, then every folder on the PATH (the first one may be an old one).
    try_node "$(command -v node 2>/dev/null)" && return 0
    try_dirs "$(printf '%s\n' "$PATH" | tr ':' '\n')" && return 0
    # 2. The places Homebrew, installers and version managers use.
    for fn_dir in \
        /opt/homebrew/bin /opt/homebrew/opt/node*/bin /usr/local/bin /usr/local/opt/node*/bin /opt/local/bin /usr/bin \
        "$HOME/.volta/bin" "$HOME/.asdf/shims" "$HOME/.local/share/mise/shims" "$HOME/.mise/shims" "$HOME/.nodenv/shims" "$HOME/.n/bin" \
        "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin "$HOME"/.nvm/versions/node/*/bin \
        "$HOME"/.local/share/fnm/node-versions/*/installation/bin "$HOME/Library/Application Support"/fnm/node-versions/*/installation/bin \
        "$HOME"/.fnm/node-versions/*/installation/bin "$HOME"/.asdf/installs/nodejs/*/bin "$HOME"/.local/share/mise/installs/node/*/bin \
        /usr/local/n/versions/node/*/bin; do
        try_node "$fn_dir/node" && return 0
    done
    # 3. nvm, read the way a terminal would (in a throwaway shell, so nothing here changes).
    for fn_nvm in "${NVM_DIR:-$HOME/.nvm}/nvm.sh" /opt/homebrew/opt/nvm/nvm.sh /usr/local/opt/nvm/nvm.sh; do
        [ -s "$fn_nvm" ] || continue
        fn_out=$(bounded 10 /bin/sh -c '. "$1" >/dev/null 2>&1; nvm use default >/dev/null 2>&1; command -v node' sh "$fn_nvm" 2>/dev/null)
        try_lines "$fn_out" && return 0
    done
    # 4. Last resort: ask the person's own login shell, which reads their profile. Limited to 8 seconds.
    if [ "${AITP_KIT_SKIP_SHELL_SEARCH:-}" != "1" ]; then
        fn_out=$(bounded 8 "${SHELL:-/bin/sh}" -ilc 'command -v node' 2>/dev/null)
        try_lines "$fn_out" && return 0
    fi
    return 1
}

# ---------------------------------------------------------------- small readers

# json_get FILE KEY: a string value from a small JSON file (runner.json). Uses Node.js when one is known, sed otherwise.
json_get() {
    if [ -n "$NODE_BIN" ]; then
        "$NODE_BIN" -e 'try{var j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));var v=j[process.argv[2]];if(typeof v==="string"){console.log(v)}}catch(e){}' "$1" "$2" 2>/dev/null
        return 0
    fi
    # No Node.js yet: read the value with sed, allowing \" and \\ inside it.
    sed -n "s/^.*\"$2\"[[:space:]]*:[[:space:]]*\"\\(\\([^\"\\\\]\\|\\\\.\\)*\\)\".*\$/\\1/p" "$1" 2>/dev/null | head -n 1 | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g'
}

file_size() {
    wc -c <"$1" 2>/dev/null | tr -d ' '
}

# is_private_host URL: is the host of this address on a private network (so plain http is acceptable)?
is_private_host() {
    ip_host=${1#*://}
    ip_host=${ip_host%%/*}
    ip_host=${ip_host%%:*}
    case "$ip_host" in
        localhost | 127.* | 10.* | 192.168.* | 169.254.* | *.local | *.lan | *.internal) return 0 ;;
        172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
    esac
    return 1
}

# pid_command PID: what a process is running, as one line (BSD and Linux ps, then /proc); empty when unknown.
pid_command() {
    pc_out=$(ps -p "$1" -o command= 2>/dev/null)
    if [ -z "$pc_out" ] && [ -r "/proc/$1/cmdline" ]; then
        pc_out=$(tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null)
    fi
    printf '%s' "$pc_out"
}

# runner_pid: prints the pid of the runner loop this installer started, if it is running. A pid file that points at something else
# (an old file, a pid another program has taken since) is ignored and deleted: nothing is ever killed on the strength of a number alone.
runner_pid() {
    [ -f "$PIDFILE" ] || return 1
    rp_pid=$(head -n 1 "$PIDFILE" 2>/dev/null | tr -d ' \r')
    case "$rp_pid" in
        '' | *[!0-9]*)
            rm -f "$PIDFILE"
            return 1
            ;;
    esac
    if kill -0 "$rp_pid" 2>/dev/null; then
        case "$(pid_command "$rp_pid")" in
            *runner-setup.sh*)
                printf '%s' "$rp_pid"
                return 0
                ;;
        esac
    fi
    rm -f "$PIDFILE"
    return 1
}

# ---------------------------------------------------------------- the runner kit next to the app

# kit_complete_in DIR: does DIR hold every file of a download, and its one-time code (or an older download's runner.token)?
kit_complete_in() {
    for kc_file in $KIT_FILES; do
        [ -f "$1/$kc_file" ] || return 1
    done
    [ -f "$1/runner.enroll" ] || [ -f "$1/runner.token" ]
}

# find_kit: sets KIT_SRC to the folder that holds the runner files, or to "" when only an earlier install has them.
find_kit() {
    KIT_SRC=""
    for fk_dir in "$KIT_DIR_ARG" "${AITP_KIT_DIR:-}" "$( [ -n "$APP_DIR" ] && dirname "$APP_DIR" )"; do
        [ -n "$fk_dir" ] || continue
        if kit_complete_in "$fk_dir"; then
            KIT_SRC=$fk_dir
            return 0
        fi
    done
    # No kit beside the app: an earlier install already holds the files (its credential is in the Keychain, or in runner.token).
    if [ -f "$RUNNER_DIR/runner.mjs" ] && [ -f "$RUNNER_DIR/runner.json" ]; then
        return 0
    fi
    # Still nothing: with a dialog, let the person point at the unzipped folder.
    if ui_available && [ "$MODE" = "run" ]; then
        fk_pick=$(applescript 'on run argv
set f to choose folder with prompt (item 1 of argv)
return POSIX path of f
end run' "Choose the folder you unzipped. It holds runner.mjs and runner.json.")
        fk_pick=${fk_pick%/}
        if [ -n "$fk_pick" ] && kit_complete_in "$fk_pick"; then
            KIT_SRC=$fk_pick
            return 0
        fi
    fi
    return 1
}

kit_missing_message() {
    case "$SELF_DIR" in
        */AppTranslocation/*)
            printf '%s' "macOS started this app from a temporary place, so it cannot see the runner files that sit next to it. In Terminal run:  xattr -dr com.apple.quarantine \"<the unzipped folder>\"  and open the app again. Or drag the unzipped folder to another place in Finder first."
            return 0
            ;;
    esac
    printf '%s' "I could not find the runner files (runner.mjs, runner.json and runner.enroll) next to this app. Unzip the whole runner kit you downloaded from the platform and open the app from inside the unzipped folder."
}

# ---------------------------------------------------------------- step 1: Node.js

human_size() {
    # human_size BYTES -> "38 MB"
    hs_mb=$((($1 + 524288) / 1048576))
    if [ "$hs_mb" -lt 1 ]; then
        printf 'less than 1 MB'
    else
        printf '%s MB' "$hs_mb"
    fi
}

curl_reason() {
    case "$1" in
        6 | 7) printf 'could not connect, check the internet connection' ;;
        18 | 56 | 52) printf 'the download was cut off' ;;
        22) printf 'the server answered with an error' ;;
        28) printf 'it took too long' ;;
        35 | 51 | 58 | 60 | 77) printf 'the secure connection failed' ;;
        *) printf 'the download failed (curl error %s)' "$1" ;;
    esac
}

# fetch URL DEST SECONDS: download one file. Plain https only, unless a test sets AITP_NODE_DIST_URL.
fetch() {
    # The file is written by a relative name from inside its folder, so no odd character in the folder's path ever reaches curl.
    fe_dir=$(dirname "$2")
    fe_name=$(basename "$2")
    if [ -n "${AITP_NODE_DIST_URL:-}" ]; then
        (cd "$fe_dir" && curl -fsSL --connect-timeout 20 -m "$3" -o "$fe_name" "$1" 2>/dev/null)
    else
        (cd "$fe_dir" && curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 20 -m "$3" -o "$fe_name" "$1" 2>/dev/null)
    fi
}

# remote_size URL: the size in bytes the server announces (empty when it does not say).
remote_size() {
    if [ -n "${AITP_NODE_DIST_URL:-}" ]; then
        curl -sIL --connect-timeout 20 -m 30 "$1" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }'
    else
        curl -sIL --proto '=https' --tlsv1.2 --connect-timeout 20 -m 30 "$1" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }'
    fi
}

sha256_of() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" 2>/dev/null | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" 2>/dev/null | awk '{print $NF}'
    else
        return 1
    fi
}

# resolve_node_version: the newest long-term-support Node.js of NODE_MIN or newer, from the published index; the pinned one if that fails.
resolve_node_version() {
    NODE_FULL=""
    rn_file="$INSTALL_DIR/tmp/index.json"
    if fetch "$NODE_BASE/index.json" "$rn_file" 30; then
        # One object per line (the file has no nested objects), newest first. Keep the first with a version name for "lts".
        # (the echo adds the final newline the file may lack, or `read` below would skip its last line)
        NODE_FULL=$({ tr '{' '\n' <"$rn_file"; echo; } | sed -n 's/^"version":"v\([0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}\)".*"lts":"[^"]\{1,\}".*$/\1/p' | while IFS= read -r rn_v; do
            if [ "${rn_v%%.*}" -ge "$NODE_MIN" ]; then
                printf '%s' "$rn_v"
                break
            fi
        done)
        rm -f "$rn_file"
    fi
    if [ -z "$NODE_FULL" ]; then
        NODE_FULL=$NODE_FALLBACK
        say "     (the list of Node.js versions could not be read, so I use $NODE_FALLBACK)"
    fi
}

download_node() {
    NODE_BASE=${AITP_NODE_DIST_URL:-$NODE_DIST_DEFAULT}
    NODE_BASE=${NODE_BASE%/}
    if [ -n "${AITP_NODE_DIST_URL:-}" ]; then
        say "     (test setting: downloading from $NODE_BASE instead of nodejs.org)"
    fi
    if ! command -v curl >/dev/null 2>&1; then
        step 1 "Node.js $NODE_MIN or newer" "failed: curl was not found on this Mac"
        die "Setup stopped. Install Node.js $NODE_MIN or newer from https://nodejs.org, then open this app again."
    fi
    resolve_node_version
    dn_file="node-v$NODE_FULL-darwin-$NODE_ARCH.tar.gz"
    dn_url="$NODE_BASE/v$NODE_FULL/$dn_file"
    dn_tar="$INSTALL_DIR/tmp/$dn_file"
    dn_sums="$INSTALL_DIR/tmp/SHASUMS256.txt"

    if ! fetch "$NODE_BASE/v$NODE_FULL/SHASUMS256.txt" "$dn_sums" 60; then
        step 1 "Node.js $NODE_MIN or newer" "failed: could not read the checksum list from $NODE_BASE (version $NODE_FULL)"
        die "Setup stopped. Check the internet connection and open this app again, or install Node.js $NODE_MIN or newer from https://nodejs.org."
    fi
    dn_expected=$(awk -v f="$dn_file" '$2 == f { print $1; exit }' "$dn_sums")
    case "$dn_expected" in
        *[!0-9a-fA-F]* | '')
            step 1 "Node.js $NODE_MIN or newer" "failed: the checksum list has no entry for $dn_file"
            die "Setup stopped. Install Node.js $NODE_MIN or newer from https://nodejs.org, then open this app again."
            ;;
    esac
    if [ "${#dn_expected}" -ne 64 ]; then
        step 1 "Node.js $NODE_MIN or newer" "failed: the checksum for $dn_file is not a SHA-256 value"
        die "Setup stopped. Install Node.js $NODE_MIN or newer from https://nodejs.org, then open this app again."
    fi

    dn_size=$(remote_size "$dn_url")
    case "$dn_size" in
        '' | *[!0-9]*) step 1 "Node.js $NODE_MIN or newer" "downloading Node.js $NODE_FULL for $ARCH_WORDS (this can take a minute)" ;;
        *) step 1 "Node.js $NODE_MIN or newer" "downloading $(human_size "$dn_size")" ;;
    esac
    fetch "$dn_url" "$dn_tar" 900
    dn_code=$?
    if [ "$dn_code" -ne 0 ]; then
        rm -f "$dn_tar"
        step 1 "Node.js $NODE_MIN or newer" "failed: $(curl_reason "$dn_code")"
        die "Setup stopped. Check the internet connection and open this app again. Nothing was installed."
    fi

    dn_actual=$(sha256_of "$dn_tar")
    if [ -z "$dn_actual" ]; then
        rm -f "$dn_tar"
        step 1 "Node.js $NODE_MIN or newer" "failed: this Mac has no tool to check a SHA-256 checksum"
        die "Setup stopped. Install Node.js $NODE_MIN or newer from https://nodejs.org, then open this app again."
    fi
    # Compare in lower case: the list is lower case, but a tool may print capitals.
    dn_actual=$(printf '%s' "$dn_actual" | tr 'A-F' 'a-f')
    dn_expected=$(printf '%s' "$dn_expected" | tr 'A-F' 'a-f')
    if [ "$dn_actual" != "$dn_expected" ]; then
        rm -f "$dn_tar"
        step 1 "Node.js $NODE_MIN or newer" "failed: the download does not match the checksum that nodejs.org publishes, so I deleted it"
        die "Setup stopped. Nothing was installed. Try again later, or install Node.js $NODE_MIN or newer from https://nodejs.org."
    fi

    dn_stage="$INSTALL_DIR/tmp/node-extract"
    rm -rf "$dn_stage"
    mkdir -p "$dn_stage"
    if ! tar -xzf "$dn_tar" -C "$dn_stage" 2>/dev/null; then
        rm -rf "$dn_stage" "$dn_tar"
        step 1 "Node.js $NODE_MIN or newer" "failed: the downloaded file could not be unpacked"
        die "Setup stopped. Try again later, or install Node.js $NODE_MIN or newer from https://nodejs.org."
    fi
    dn_dir=""
    for dn_candidate in "$dn_stage"/node-v*-darwin-*; do
        if [ -d "$dn_candidate" ]; then
            dn_dir=$dn_candidate
            break
        fi
    done
    if [ -z "$dn_dir" ] || [ ! -f "$dn_dir/bin/node" ]; then
        rm -rf "$dn_stage" "$dn_tar"
        step 1 "Node.js $NODE_MIN or newer" "failed: the downloaded file does not hold a Node.js"
        die "Setup stopped. Try again later, or install Node.js $NODE_MIN or newer from https://nodejs.org."
    fi
    rm -rf "$NODE_PRIVATE"
    mv "$dn_dir" "$NODE_PRIVATE"
    rm -rf "$dn_stage" "$dn_tar" "$dn_sums"
    if ! find_node; then
        step 1 "Node.js $NODE_MIN or newer" "failed: the unpacked Node.js does not start"
        die "Setup stopped. Try again later, or install Node.js $NODE_MIN or newer from https://nodejs.org."
    fi
    step 1 "Node.js $NODE_MIN or newer" "done ($NODE_VER at $(dirname "$NODE_BIN"))"
}

step_node() {
    # The first screen already searched (the login-shell search can take seconds); do not repeat it.
    if [ "$NODE_SEARCHED" != "1" ]; then
        find_node
    fi
    if [ -n "$NODE_BIN" ] && [ -n "$KIT_NODE" ]; then
        # The complete download's Node.js: copied into the private folder (so the unzipped folder can be deleted), never downloaded.
        if [ -x "$NODE_PRIVATE/bin/node" ] && cmp -s "$KIT_NODE" "$NODE_PRIVATE/bin/node"; then
            NODE_BIN="$NODE_PRIVATE/bin/node"
            step 1 "Node.js $NODE_MIN or newer" "came with this download ($NODE_VER), already copied, skipped"
            return 0
        fi
        if [ "$MODE" = "check" ]; then
            step 1 "Node.js $NODE_MIN or newer" "came with this download ($NODE_VER), would copy it (no download)"
            return 0
        fi
        rm -rf "$NODE_PRIVATE.new"
        if ! { mkdir -p "$NODE_PRIVATE.new" && cp -R "$KIT_SRC/node/." "$NODE_PRIVATE.new/"; }; then
            rm -rf "$NODE_PRIVATE.new"
            step 1 "Node.js $NODE_MIN or newer" "failed: could not copy the Node.js that came with this download"
            die "Setup stopped. Check that this Mac has free disk space and that you may write to $INSTALL_DIR."
        fi
        rm -rf "$NODE_PRIVATE"
        mv "$NODE_PRIVATE.new" "$NODE_PRIVATE"
        chmod 755 "$NODE_PRIVATE/bin/node" 2>/dev/null
        NODE_BIN="$NODE_PRIVATE/bin/node"
        step 1 "Node.js $NODE_MIN or newer" "came with this download ($NODE_VER), copied (no download)"
        return 0
    fi
    if [ -n "$NODE_BIN" ]; then
        step 1 "Node.js $NODE_MIN or newer" "found ($NODE_VER at $(dirname "$NODE_BIN")), skipped"
        return 0
    fi
    if [ -n "$OLD_NODES" ]; then
        printf '%s' "$OLD_NODES" | while IFS= read -r sn_line; do
            [ -n "$sn_line" ] && step 1 "Node.js $NODE_MIN or newer" "found $sn_line, too old for the runner"
        done
    fi
    if [ "$MODE" = "check" ]; then
        step 1 "Node.js $NODE_MIN or newer" "not found, would download the $ARCH_WORDS build from nodejs.org"
        DOWNLOADS=$((DOWNLOADS + 1))
        return 0
    fi
    download_node
}

# ---------------------------------------------------------------- step 2: the runner files

install_files_differ() {
    # How many of the kit's files are missing or different in the install folder.
    idf_n=0
    for idf_file in $(kit_copy_list); do
        if [ ! -f "$RUNNER_DIR/$idf_file" ] || ! cmp -s "$KIT_SRC/$idf_file" "$RUNNER_DIR/$idf_file"; then
            idf_n=$((idf_n + 1))
        fi
    done
    printf '%s' "$idf_n"
}

# kit_copy_list: the files to copy from the unzipped download: every kit file, the lock file when there is one, and the credential.
# A one-time code is copied only once: the runner deletes its copy after trading it, and the same code is never copied again.
kit_copy_list() {
    printf '%s' "$KIT_FILES"
    for kl_file in $KIT_OPTIONAL; do
        [ -f "$KIT_SRC/$kl_file" ] && printf ' %s' "$kl_file"
    done
    if [ -f "$KIT_SRC/runner.enroll" ]; then
        if [ "$(sha256_of "$KIT_SRC/runner.enroll")" != "$(head -n 1 "$ENROLL_SEEN" 2>/dev/null)" ]; then
            printf ' %s' runner.enroll
        fi
    elif [ -f "$KIT_SRC/runner.token" ]; then
        printf ' %s' runner.token
    fi
}

clear_quarantine() {
    # Everything that came from the internet in a zip carries a flag that makes macOS ask about every program in it. Clear it for the
    # install folder only, silently; nothing happens where the tool does not exist.
    if [ "$OS_NAME" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
        xattr -dr com.apple.quarantine "$INSTALL_DIR" >/dev/null 2>&1
    fi
    return 0
}

step_files() {
    if [ -z "$KIT_SRC" ]; then
        step 2 "Runner files" "found in $RUNNER_DIR, skipped"
        return 0
    fi
    sf_diff=$(install_files_differ)
    if [ "$MODE" = "check" ]; then
        if [ "$sf_diff" -eq 0 ]; then
            step 2 "Runner files" "found, up to date, skipped"
        else
            step 2 "Runner files" "would copy $sf_diff files from the unzipped kit (no download)"
        fi
        return 0
    fi
    mkdir -p "$RUNNER_DIR" || die "Setup stopped. I could not create $RUNNER_DIR."
    sf_copied=0
    sf_list=$(kit_copy_list)
    for sf_file in $sf_list; do
        if [ ! -f "$RUNNER_DIR/$sf_file" ] || ! cmp -s "$KIT_SRC/$sf_file" "$RUNNER_DIR/$sf_file"; then
            # Written under a private name and moved into place, so a runner that is running never reads half a file. The token is private.
            (
                umask 077
                cp "$KIT_SRC/$sf_file" "$RUNNER_DIR/$sf_file.new"
            ) && mv -f "$RUNNER_DIR/$sf_file.new" "$RUNNER_DIR/$sf_file" || {
                step 2 "Runner files" "failed: could not copy $sf_file"
                die "Setup stopped. Check that this Mac has free disk space and that you may write to $INSTALL_DIR."
            }
            sf_copied=$((sf_copied + 1))
        fi
    done
    chmod 600 "$RUNNER_DIR/runner.token" "$RUNNER_DIR/runner.enroll" 2>/dev/null
    case " $sf_list " in
        *" runner.enroll "*)
            # A new one-time code replaces the credential of an older download; the runner trades it at its next start.
            rm -f "$RUNNER_DIR/runner.token"
            sha256_of "$KIT_SRC/runner.enroll" >"$ENROLL_SEEN" 2>/dev/null
            ;;
    esac
    # The script itself is copied too, so the sign-in start keeps working when the app is moved or deleted.
    if [ -f "$0" ] && { [ ! -f "$INSTALLED_SCRIPT" ] || ! cmp -s "$0" "$INSTALLED_SCRIPT"; }; then
        cp "$0" "$INSTALLED_SCRIPT.new" && mv -f "$INSTALLED_SCRIPT.new" "$INSTALLED_SCRIPT"
    fi
    clear_quarantine
    if [ "$sf_copied" -eq 0 ]; then
        step 2 "Runner files" "found, up to date, skipped"
    else
        step 2 "Runner files" "done ($sf_copied of $(printf '%s\n' $sf_list | wc -l | tr -d ' ') files copied to $RUNNER_DIR)"
    fi
}

# ---------------------------------------------------------------- step 3: the test tools

# tools_missing PACKAGE_JSON: the names of the packages that are not installed in the runner folder at the version package.json pins.
tools_missing() {
    "$NODE_BIN" -e 'var fs=require("fs"),path=require("path");var d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).dependencies||{};var miss=[];Object.keys(d).forEach(function(n){var v=null;try{v=JSON.parse(fs.readFileSync(path.join(process.argv[2],"node_modules",n,"package.json"),"utf8")).version}catch(e){}if(v!==d[n]){miss.push(n)}});console.log(miss.join(" "))' "$1" "$RUNNER_DIR" 2>/dev/null
}

# kit_has_tools: does the unzipped download hold a complete node_modules (a complete download, marked node_modules/.aitp-complete)?
kit_has_tools() {
    [ -n "$KIT_SRC" ] && [ -f "$KIT_SRC/node_modules/.aitp-complete" ] && [ -f "$KIT_SRC/node_modules/@playwright/test/package.json" ]
}

step_tools() {
    if kit_has_tools; then
        # A complete download: its node_modules is copied as it is, npm is never run.
        if [ -f "$RUNNER_DIR/node_modules/.aitp-complete" ] && cmp -s "$KIT_SRC/node_modules/.aitp-complete" "$RUNNER_DIR/node_modules/.aitp-complete"; then
            step 3 "Test tools" "came with this download, already copied, skipped"
            return 0
        fi
        if [ "$MODE" = "check" ]; then
            step 3 "Test tools" "came with this download, would copy them (no download)"
            return 0
        fi
        rm -rf "$RUNNER_DIR/node_modules.new"
        if ! cp -R "$KIT_SRC/node_modules" "$RUNNER_DIR/node_modules.new"; then
            rm -rf "$RUNNER_DIR/node_modules.new"
            step 3 "Test tools" "failed: could not copy them from this download"
            die "Setup stopped. Check that this Mac has free disk space and that you may write to $INSTALL_DIR."
        fi
        rm -rf "$RUNNER_DIR/node_modules"
        mv "$RUNNER_DIR/node_modules.new" "$RUNNER_DIR/node_modules"
        step 3 "Test tools" "done (copied from this download, nothing downloaded)"
        return 0
    fi
    st_pkg="$RUNNER_DIR/package.json"
    if [ ! -f "$st_pkg" ]; then
        st_pkg="$KIT_SRC/package.json"
    fi
    if [ -z "$NODE_BIN" ] || [ ! -f "$st_pkg" ]; then
        step 3 "Test tools" "would be installed with npm after Node.js (needs the internet)"
        DOWNLOADS=$((DOWNLOADS + 1))
        return 0
    fi
    st_missing=$(tools_missing "$st_pkg")
    st_status=$?
    if [ "$st_status" -eq 0 ] && [ -z "$st_missing" ]; then
        step 3 "Test tools" "found (all packages are installed at the pinned versions), skipped"
        return 0
    fi
    if [ "$MODE" = "check" ]; then
        step 3 "Test tools" "not complete, would install with npm (needs the internet)"
        DOWNLOADS=$((DOWNLOADS + 1))
        return 0
    fi
    if [ "${AITP_INSTALLER_SKIP_NPM:-}" = "1" ]; then
        step 3 "Test tools" "skipped (test setting: npm is not run)"
        return 0
    fi
    st_npm="$(dirname "$NODE_BIN")/npm"
    if [ ! -x "$st_npm" ]; then
        st_npm=npm
    fi
    if ! command -v "$st_npm" >/dev/null 2>&1 && [ ! -x "$st_npm" ]; then
        step 3 "Test tools" "failed: npm was not found next to Node.js"
        die "Setup stopped. Reinstall Node.js from https://nodejs.org (it includes npm), then open this app again."
    fi
    step 3 "Test tools" "installing with npm (needs the internet, can take a few minutes)"
    mkdir -p "$LOG_DIR"
    st_log="$LOG_DIR/npm-install.log"
    # With the download's lock file: exactly the locked versions and checksums, and no package's install script runs (Playwright needs
    # none). An older download without one: npm install, as before.
    if [ -f "$RUNNER_DIR/package-lock.json" ]; then
        (cd "$RUNNER_DIR" && PATH="$(dirname "$NODE_BIN"):$PATH" "$st_npm" ci --ignore-scripts --no-audit --no-fund) >"$st_log" 2>&1
    else
        (cd "$RUNNER_DIR" && PATH="$(dirname "$NODE_BIN"):$PATH" "$st_npm" install --no-audit --no-fund) >"$st_log" 2>&1
    fi
    st_code=$?
    if [ "$st_code" -ne 0 ]; then
        step 3 "Test tools" "failed: npm could not install them (code $st_code)"
        tail -n 12 "$st_log" 2>/dev/null | while IFS= read -r st_line; do say "     $st_line"; done
        die "Setup stopped. Check that this Mac can reach the internet, then open this app again. The full output is in $st_log."
    fi
    st_missing=$(tools_missing "$RUNNER_DIR/package.json")
    if [ -n "$st_missing" ]; then
        step 3 "Test tools" "failed: after npm finished these are still missing: $st_missing"
        die "Setup stopped. Open this app again; if it repeats, download a new runner kit from the platform."
    fi
    step 3 "Test tools" "done"
}

# ---------------------------------------------------------------- step 4: the browser for web tests

browser_cache_dir() {
    case "${PLAYWRIGHT_BROWSERS_PATH:-}" in
        '') printf '%s' "$HOME/Library/Caches/ms-playwright" ;;
        0) printf '%s' "$RUNNER_DIR/node_modules/playwright-core/.local-browsers" ;;
        *) printf '%s' "$PLAYWRIGHT_BROWSERS_PATH" ;;
    esac
}

step_browser() {
    # Nothing to download here any more: the runner itself uses Google Chrome or Microsoft Edge from this Mac, or downloads Chromium once
    # when it first starts (and Firefox or WebKit only when a run needs them).
    step 4 "Browser for web tests" "left to the runner (it uses Google Chrome or Microsoft Edge from this Mac, or downloads Chromium once when it first starts)"
    # Phone tools likewise: the runner fetches Google's platform-tools (adb) into its own folder when a phone session needs them (phone-setup-simple.md).
    if ! command -v adb >/dev/null 2>&1; then
        say "      Android phone tools: not on this Mac; the runner gets Google's (adb, about 10 MB) itself when a phone session needs them"
    fi
}

# ---------------------------------------------------------------- step 5: can this Mac reach the platform

step_platform() {
    sp_json="$RUNNER_DIR/runner.json"
    if [ ! -f "$sp_json" ]; then
        sp_json="$KIT_SRC/runner.json"
    fi
    PLATFORM_URL=$(json_get "$sp_json" url)
    RUNNER_NAME=$(json_get "$sp_json" name)
    if [ -z "$PLATFORM_URL" ]; then
        step 5 "Platform connection" "failed: runner.json has no platform address"
        die "Setup stopped. Download a new runner kit from the platform (Setup, Runners, Add a runner)."
    fi
    if [ "$MODE" = "check" ]; then
        step 5 "Platform connection" "not checked here ($PLATFORM_URL)"
        return 0
    fi
    case "$PLATFORM_URL" in
        https://*) ;;
        http://*)
            if ! is_private_host "$PLATFORM_URL"; then
                step 5 "Platform connection" "not checked: $PLATFORM_URL is plain http on a public network (the runner will still try it)"
                return 0
            fi
            ;;
        *)
            step 5 "Platform connection" "failed: the address $PLATFORM_URL is not an http or https address"
            die "Setup stopped. Download a new runner kit from the platform (Setup, Runners, Add a runner)."
            ;;
    esac
    if ! command -v curl >/dev/null 2>&1; then
        step 5 "Platform connection" "not checked (curl was not found)"
        return 0
    fi
    sp_code=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$PLATFORM_URL" 2>/dev/null)
    sp_status=$?
    if [ "$sp_status" -eq 0 ] && [ "$sp_code" != "000" ]; then
        step 5 "Platform connection" "found ($PLATFORM_URL answers), skipped"
    else
        case "$sp_status" in
            6) sp_why="the name could not be found" ;;
            7) sp_why="nothing answered there, or the connection was refused" ;;
            28) sp_why="no answer within 8 seconds" ;;
            35 | 51 | 58 | 60 | 77) sp_why="the secure connection failed" ;;
            *) sp_why="curl error $sp_status" ;;
        esac
        step 5 "Platform connection" "failed: $PLATFORM_URL could not be reached ($sp_why)"
        say "     The runner keeps trying. Check the address in runner.json and that this Mac is on the right network or VPN."
        say "     On a company network a proxy may be the reason: the runner uses HTTPS_PROXY, or add \"proxy\" (and \"caFile\" for a company certificate) to runner.json. See docs/features/company-networks.md."
    fi
}

# ---------------------------------------------------------------- "Check this computer"

# The runner's own check (node runner.mjs --check, the same as check-computer.sh; docs/features/runner-check.md), each line shown and logged.
# Only a runner program that knows the check is asked (its text holds the marker), so an older one is never started by accident. It
# changes nothing, never prints the token, and never stops the setup.
run_computer_check() {
    [ -n "$NODE_BIN" ] && [ -f "$RUNNER_DIR/runner.mjs" ] || return 0
    grep -q 'aitp-computer-check/1' "$RUNNER_DIR/runner.mjs" 2>/dev/null || return 0
    say ""
    say "Checking this computer (the same check as check-computer.sh):"
    rc_out=$(cd "$RUNNER_DIR" && "$NODE_BIN" runner.mjs --check </dev/null 2>/dev/null)
    printf '%s\n' "$rc_out" | while IFS= read -r rc_line; do
        [ -n "$rc_line" ] && say "  $rc_line"
    done
    return 0
}

# ---------------------------------------------------------------- the install folder

# prepare_install_dir: create it (and mark it as ours), or refuse a folder that already holds someone else's files.
prepare_install_dir() {
    if [ -d "$INSTALL_DIR" ]; then
        if [ ! -f "$SENTINEL" ]; then
            pi_files=$(ls -A "$INSTALL_DIR" 2>/dev/null | head -n 1)
            if [ -n "$pi_files" ]; then
                die "The folder $INSTALL_DIR already holds files that this app did not put there. Nothing was changed. Choose an empty folder with --install-dir."
            fi
            printf '%s\n' "Created by the AI Testing Runner app. Uninstall removes this folder." >"$SENTINEL"
        fi
    else
        mkdir -p "$INSTALL_DIR" || die "Setup stopped. I could not create $INSTALL_DIR."
        printf '%s\n' "Created by the AI Testing Runner app. Uninstall removes this folder." >"$SENTINEL"
    fi
    chmod 700 "$INSTALL_DIR" 2>/dev/null
    mkdir -p "$INSTALL_DIR/tmp" "$LOG_DIR"
    if [ -z "$LOG_FILE" ]; then
        LOG_FILE="$LOG_DIR/setup.log"
    fi
    return 0
}

# ---------------------------------------------------------------- the LaunchAgent (start the runner when you sign in)

xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# write_launch_agent PLIST_PATH: a property list for launchd; every value is escaped, so a path with & or spaces stays one value.
write_launch_agent() {
    wl_script=$INSTALLED_SCRIPT
    {
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
        printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        printf '%s\n' '<plist version="1.0">'
        printf '%s\n' '<dict>'
        printf '    <key>Label</key>\n    <string>%s</string>\n' "$(xml_escape "$LABEL")"
        printf '%s\n' '    <key>ProgramArguments</key>'
        printf '%s\n' '    <array>'
        printf '        <string>%s</string>\n' "/bin/sh" "$(xml_escape "$wl_script")" "--run-loop" "--install-dir" "$(xml_escape "$INSTALL_DIR")"
        printf '%s\n' '    </array>'
        printf '    <key>WorkingDirectory</key>\n    <string>%s</string>\n' "$(xml_escape "$RUNNER_DIR")"
        # Started again only when the loop ends with an error: after a stop for good (the runner's access was removed) it stays stopped
        # until the next sign-in.
        printf '%s\n' '    <key>RunAtLoad</key>' '    <true/>' '    <key>KeepAlive</key>' '    <dict>' '        <key>SuccessfulExit</key>' '        <false/>' '    </dict>'
        printf '%s\n' '    <key>ProcessType</key>' '    <string>Background</string>'
        printf '    <key>StandardOutPath</key>\n    <string>%s</string>\n' "$(xml_escape "$LAUNCHD_LOG")"
        printf '    <key>StandardErrorPath</key>\n    <string>%s</string>\n' "$(xml_escape "$LAUNCHD_LOG")"
        printf '%s\n' '    <key>EnvironmentVariables</key>' '    <dict>' '        <key>PATH</key>'
        printf '        <string>%s</string>\n' "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
        printf '%s\n' '    </dict>' '</dict>' '</plist>'
    } >"$1"
}

launchd_domain() {
    printf 'gui/%s' "$(id -u)"
}

install_launch_agent() {
    mkdir -p "$(dirname "$AGENT_PLIST")" "$LOG_DIR"
    write_launch_agent "$AGENT_PLIST" || return 1
    if ! command -v launchctl >/dev/null 2>&1; then
        say "launchctl was not found, so the runner cannot be started at sign-in on this computer."
        return 1
    fi
    # A copy that is already loaded would make bootstrap fail; take it out first (quietly).
    launchctl bootout "$(launchd_domain)/$LABEL" >/dev/null 2>&1
    if launchctl bootstrap "$(launchd_domain)" "$AGENT_PLIST" >/dev/null 2>&1; then
        return 0
    fi
    # Older macOS versions only know load.
    launchctl load -w "$AGENT_PLIST" >/dev/null 2>&1
}

remove_launch_agent() {
    if command -v launchctl >/dev/null 2>&1; then
        launchctl bootout "$(launchd_domain)/$LABEL" >/dev/null 2>&1 || launchctl unload "$AGENT_PLIST" >/dev/null 2>&1
    fi
    rm -f "$AGENT_PLIST"
    return 0
}

# ---------------------------------------------------------------- running the runner

fatal_message() {
    case "$1" in
        2) printf '%s' "The runner could not read its settings. Check that you unzipped the whole kit, or download a new one from the platform." ;;
        3) printf '%s' "The platform no longer accepts this runner. It was removed, its one-time code was already used or has expired, or the project was deleted. Make a new download on the Runners page of the platform." ;;
        4) printf '%s' "This runner and the platform are different versions. Download a new runner kit from the platform." ;;
        5) printf '%s' "The platform refused this runner. The message above says why." ;;
    esac
}

# rotate_log FILE: when FILE is larger than LOG_MAX_BYTES, keep a copy as FILE.1 (FILE.1 becomes FILE.2 ..., at most LOG_KEEP) and empty
# FILE in place. Emptying in place (not moving) is what keeps it working while the runner and launchd still write to it: both append.
rotate_log() {
    [ -f "$1" ] || return 0
    [ "$(file_size "$1")" -gt "$LOG_MAX_BYTES" ] 2>/dev/null || return 0
    rlg_n=$LOG_KEEP
    while [ "$rlg_n" -gt 1 ]; do
        rlg_prev=$((rlg_n - 1))
        if [ -f "$1.$rlg_prev" ]; then mv -f "$1.$rlg_prev" "$1.$rlg_n"; fi
        rlg_n=$rlg_prev
    done
    cp "$1" "$1.1" 2>/dev/null && : >"$1"
    return 0
}

# watch_logs: rotate runner.log and launchd.log once a minute while the loop runs (AITP_INSTALLER_LOG_CHECK_SECONDS, for tests). Started
# with its output closed, so it never keeps the Terminal window's or a caller's output open after the loop has ended.
watch_logs() {
    while :; do
        sleep "${AITP_INSTALLER_LOG_CHECK_SECONDS:-60}" </dev/null >/dev/null 2>&1
        rotate_log "$RUNLOG"
        rotate_log "$LAUNCHD_LOG"
    done
}

# start_runner: start the runner in the background, telling it how to find its credential. A one-time code it trades and deletes (runner.enroll), an older
# download's runner.token, or nothing: the runner then reads the credential it keeps in the login Keychain.
start_runner() {
    if [ -f runner.enroll ]; then
        "$NODE_BIN" runner.mjs --enroll-file runner.enroll >>"$RUNLOG" 2>&1 </dev/null &
    elif [ -f runner.token ]; then
        "$NODE_BIN" runner.mjs --token-file runner.token >>"$RUNLOG" 2>&1 </dev/null &
    else
        "$NODE_BIN" runner.mjs >>"$RUNLOG" 2>&1 </dev/null &
    fi
    NODE_PID=$!
}

stop_children() {
    if [ -n "$NODE_PID" ]; then
        kill "$NODE_PID" 2>/dev/null
    fi
    return 0
}

loop_cleanup() {
    if [ -n "$TAIL_PID" ]; then kill "$TAIL_PID" 2>/dev/null; fi
    if [ -n "$WATCH_PID" ]; then kill "$WATCH_PID" 2>/dev/null; fi
    if [ -n "$LOGS_PID" ]; then kill "$LOGS_PID" 2>/dev/null; fi
    if [ -f "$PIDFILE" ] && [ "$(head -n 1 "$PIDFILE" 2>/dev/null)" = "$$" ]; then
        rm -f "$PIDFILE"
    fi
    return 0
}

# watch_connection OFFSET: tell the person (a notification) when the runner says it is connected. Only looks at what was written since OFFSET.
watch_connection() {
    wc_i=0
    while [ "$wc_i" -lt 120 ]; do
        if tail -c +"$(($1 + 1))" "$RUNLOG" 2>/dev/null | grep -q 'Connected to the platform'; then
            notify "Connected to $PLATFORM_URL as $RUNNER_NAME"
            return 0
        fi
        sleep 1
        wc_i=$((wc_i + 1))
    done
    return 0
}

# run_loop foreground|launchd: keep the runner running; Ctrl-C (or a stop from launchd or --uninstall) stops it and ends the loop.
run_loop() {
    rl_kind=$1
    mkdir -p "$LOG_DIR"
    rotate_log "$RUNLOG"
    rotate_log "$LAUNCHD_LOG"
    : >>"$RUNLOG"
    cd "$RUNNER_DIR" || die "The runner folder $RUNNER_DIR is missing. Open the AI Testing Runner app to set it up again."
    # Use the Node.js that setup chose; look again if it has gone.
    NODE_BIN=""
    if [ -f "$NODE_PATH_FILE" ]; then
        try_node "$(head -n 1 "$NODE_PATH_FILE" 2>/dev/null)"
    fi
    if [ -z "$NODE_BIN" ] && ! find_node; then
        die "Node.js $NODE_MIN or newer is no longer available. Open the AI Testing Runner app to set it up again."
    fi
    PATH="$(dirname "$NODE_BIN"):$PATH"
    export PATH
    PLATFORM_URL=$(json_get runner.json url)
    RUNNER_NAME=$(json_get runner.json name)
    NODE_PID=""
    TAIL_PID=""
    WATCH_PID=""
    LOGS_PID=""
    STOP=0
    trap 'STOP=1; stop_children' INT TERM HUP
    trap 'loop_cleanup' EXIT
    printf '%s\n' "$$" >"$PIDFILE"
    watch_logs </dev/null >/dev/null 2>&1 &
    LOGS_PID=$!
    if [ "$rl_kind" = "foreground" ]; then
        # Show what the runner writes in this window (and keep it in the log file).
        tail -n 0 -f "$RUNLOG" &
        TAIL_PID=$!
    fi
    while [ "$STOP" = "0" ]; do
        rl_offset=$(file_size "$RUNLOG")
        if [ "$rl_kind" = "foreground" ]; then
            watch_connection "$rl_offset" &
            WATCH_PID=$!
        fi
        start_runner
        wait "$NODE_PID"
        rl_code=$?
        # A trapped signal ends `wait` early while the runner is still stopping; wait for it to be gone.
        while kill -0 "$NODE_PID" 2>/dev/null; do
            wait "$NODE_PID"
            rl_code=$?
        done
        NODE_PID=""
        if [ -n "$WATCH_PID" ]; then kill "$WATCH_PID" 2>/dev/null; WATCH_PID=""; fi
        if [ "$STOP" = "1" ]; then
            break
        fi
        case "$rl_code" in
            0) STOP=1 ;;
            75)
                # The runner switched to a new version of itself (docs/features/runner-updates.md): start it again at once.
                say "The runner updated itself. Starting the new version."
                ;;
            2 | 3 | 4 | 5)
                sleep 1
                say ""
                say "$(fatal_message "$rl_code")"
                printf '%s\n' "$(date '+%Y-%m-%d %H:%M:%S') $(fatal_message "$rl_code")" >>"$RUNLOG"
                if [ "$rl_kind" = "foreground" ]; then
                    FATAL_CODE=$rl_code
                    STOP=1
                elif [ "$rl_code" = "3" ]; then
                    # The runner's access was removed: stop for good. The loop ends without an error, so launchd does not start it
                    # again (KeepAlive only after a failure); the next sign-in tries once more.
                    printf '%s\n' "$(date '+%Y-%m-%d %H:%M:%S') The runner stopped for good. Open the AI Testing Runner app with a new download to set it up again." >>"$RUNLOG"
                    STOP=1
                else
                    # Started by launchd: ask again in an hour instead of every few seconds, so a revoked token does not hammer the platform.
                    rl_i=0
                    while [ "$rl_i" -lt 720 ] && [ "$STOP" = "0" ]; do
                        sleep 5
                        rl_i=$((rl_i + 1))
                    done
                fi
                ;;
            *)
                say ""
                say "The runner stopped unexpectedly (code $rl_code). Starting it again in 5 seconds. Press Ctrl-C to stop it."
                rl_i=0
                while [ "$rl_i" -lt 5 ] && [ "$STOP" = "0" ]; do
                    sleep 1
                    rl_i=$((rl_i + 1))
                done
                ;;
        esac
    done
    sleep 1
    loop_cleanup
    trap - EXIT
    return 0
}

# ---------------------------------------------------------------- uninstall

stop_recorded_runner() {
    sr_pid=$(runner_pid) || return 1
    say "Stopping the runner this app started (process $sr_pid)."
    kill -TERM "$sr_pid" 2>/dev/null
    sr_i=0
    while [ "$sr_i" -lt 20 ] && kill -0 "$sr_pid" 2>/dev/null; do
        sleep 1
        sr_i=$((sr_i + 1))
    done
    if kill -0 "$sr_pid" 2>/dev/null; then
        # Still there after 20 seconds: check once more that it is ours before the last resort.
        case "$(pid_command "$sr_pid")" in
            *runner-setup.sh*) kill -KILL "$sr_pid" 2>/dev/null ;;
        esac
    fi
    rm -f "$PIDFILE"
    return 0
}

# forget_credential: the runner deletes the credential it keeps in the login Keychain (it knows the entry; this script never sees it),
# and the files that could hold one go too: a one-time code not yet traded, and an older download's runner.token.
forget_credential() {
    [ -f "$RUNNER_DIR/runner.mjs" ] || return 0
    fc_node=""
    if [ -f "$NODE_PATH_FILE" ]; then
        fc_node=$(head -n 1 "$NODE_PATH_FILE" 2>/dev/null)
    fi
    if [ -n "$fc_node" ] && [ -x "$fc_node" ]; then
        # At most 30 seconds (AITP_INSTALLER_FORGET_SECONDS, for tests): an uninstall never hangs on the runner.
        (cd "$RUNNER_DIR" && exec "$fc_node" runner.mjs --forget-credential) </dev/null >/dev/null 2>&1 &
        fc_pid=$!
        (
            fc_i=0
            while [ "$fc_i" -lt "${AITP_INSTALLER_FORGET_SECONDS:-30}" ] && kill -0 "$fc_pid" 2>/dev/null; do
                sleep 1
                fc_i=$((fc_i + 1))
            done
            kill -9 "$fc_pid" 2>/dev/null
        ) </dev/null >/dev/null 2>&1 &
        wait "$fc_pid"
        fc_code=$?
        if [ "$fc_code" -eq 0 ]; then
            say "Removed the runner's saved access from this Mac."
        else
            say "The runner could not remove its saved access (an older runner, or it was never connected). Nothing else holds it."
        fi
    fi
    rm -f "$RUNNER_DIR/runner.enroll" "$RUNNER_DIR/runner.token" "$ENROLL_SEEN"
    return 0
}

do_uninstall() {
    say "$APP_TITLE: uninstall"
    cd "$HOME" || exit 1
    du_found=0
    if [ -f "$AGENT_PLIST" ]; then
        du_found=1
        say "Removing the sign-in start (the LaunchAgent $LABEL)."
        remove_launch_agent
    fi
    if runner_pid >/dev/null; then
        du_found=1
    fi
    stop_recorded_runner && du_found=1
    forget_credential
    if [ ! -d "$INSTALL_DIR" ]; then
        if [ "$du_found" = "0" ]; then
            say "Nothing to remove: no AI Testing Runner was installed by this app in $INSTALL_DIR."
        fi
        exit 0
    fi
    if [ ! -f "$SENTINEL" ]; then
        say "The folder $INSTALL_DIR was not created by this app, so I left it alone."
        exit 0
    fi
    case "$INSTALL_DIR" in
        / | "$HOME" | "$HOME/" | "$HOME/Library" | "$HOME/Library/Application Support")
            say "I will not remove $INSTALL_DIR."
            exit 1
            ;;
    esac
    du_remove=no
    if [ "$SILENT" = "1" ]; then
        du_remove=yes
    elif confirm "Remove the AI Testing Runner folder and everything in it?
$INSTALL_DIR
(the private Node.js, the test tools, logs and the runner's work files. A Node.js or browser that was already on this Mac is not touched.)" "Keep it" "Remove" no; then
        du_remove=yes
    fi
    if [ "$du_remove" = "yes" ]; then
        rm -rf "$INSTALL_DIR"
        say "Removed $INSTALL_DIR."
    else
        say "Kept $INSTALL_DIR. The runner is stopped."
    fi
    say "The browser cache $(browser_cache_dir) is shared with other tools and was left alone."
    notify "The AI Testing Runner was uninstalled."
    exit 0
}

# ---------------------------------------------------------------- the main run

show_status() {
    # The runner is already running: say so, show the end of its log, and offer to uninstall.
    ss_pid=$1
    # The Node.js setup chose last time reads runner.json properly; without it the plain-text reader is used.
    if [ -f "$NODE_PATH_FILE" ]; then
        try_node "$(head -n 1 "$NODE_PATH_FILE" 2>/dev/null)"
    fi
    PLATFORM_URL=$(json_get "$RUNNER_DIR/runner.json" url)
    RUNNER_NAME=$(json_get "$RUNNER_DIR/runner.json" name)
    say ""
    say "The AI Testing runner is already running on this Mac (process $ss_pid)."
    if [ -n "$PLATFORM_URL" ]; then
        say "It belongs to $PLATFORM_URL and is named \"$RUNNER_NAME\"."
    fi
    if [ -f "$RUNLOG" ]; then
        say "The end of its log ($RUNLOG):"
        tail -n 5 "$RUNLOG" 2>/dev/null | while IFS= read -r ss_line; do say "    $ss_line"; done
    fi
    if [ "$SILENT" != "1" ]; then
        if confirm "The AI Testing runner is already running on this Mac.
Leave it running, or uninstall it?" "Leave it running" "Uninstall" no; then
            do_uninstall
        fi
    fi
    exit 0
}

do_setup() {
    say "$APP_TITLE"
    say ""
    detect_platform
    dp_status=$?
    if [ "$dp_status" -eq 1 ]; then
        die "This installer is for macOS, and this computer reports \"$OS_NAME\". On Linux, use start-runner.sh from the runner kit."
    elif [ "$dp_status" -eq 2 ]; then
        die "This installer does not know the processor \"$MACHINE\". Install Node.js $NODE_MIN or newer from https://nodejs.org and use start-runner.sh from the runner kit."
    fi
    say "This Mac: macOS, $ARCH_WORDS"
    say "Install folder: $INSTALL_DIR"
    say ""

    if ! find_kit; then
        die "$(kit_missing_message)"
    fi

    if [ "$MODE" = "run" ]; then
        if rp=$(runner_pid); then
            show_status "$rp"
        fi
        # What the first screen has to say: what could be downloaded.
        find_node
        NODE_SEARCHED=1
        want=""
        [ -n "$NODE_BIN" ] || want="Node.js"
        probe_pkg="$RUNNER_DIR/package.json"
        [ -f "$probe_pkg" ] || probe_pkg="$KIT_SRC/package.json"
        if ! kit_has_tools && { [ -z "$NODE_BIN" ] || [ -n "$(tools_missing "$probe_pkg")" ]; }; then
            want="${want:+$want, }the test tools"
        fi
        if [ -n "$want" ] || [ ! -f "$SENTINEL" ]; then
            if [ -n "$want" ]; then
                intro="It only downloads what is missing: $want."
            else
                intro="It needs nothing from the internet."
            fi
            if ! confirm "This will set up the AI Testing runner on this Mac. $intro Nothing is installed system-wide." "Cancel" "Set up" yes; then
                say "Cancelled. Nothing was changed."
                pause_if_interactive
                exit 0
            fi
        fi
        prepare_install_dir
        say "Details are written to $LOG_FILE"
        say ""
    fi

    step_node
    step_files
    step_tools
    step_browser
    step_platform

    if [ "$MODE" = "check" ]; then
        say ""
        if [ "$DOWNLOADS" -gt 0 ]; then
            say "Check finished: $DOWNLOADS thing(s) would be downloaded. Nothing was changed."
            exit 10
        fi
        say "Check finished: nothing needs to be downloaded."
        exit 0
    fi

    printf '%s\n' "$NODE_BIN" >"$NODE_PATH_FILE"
    say ""
    say "Setup finished."
    run_computer_check

    if [ "$NO_START" = "1" ]; then
        say "The runner was not started (--no-start). Open the app again, or run: sh \"$INSTALLED_SCRIPT\" --install-dir \"$INSTALL_DIR\""
        pause_if_interactive
        exit 0
    fi

    # In the background, also after every sign-in? Yes is the default answer: asked once in a dialog with Yes preselected, and taken
    # without asking with --silent / --yes. A LaunchAgent set up earlier is kept (and its file written again, in this version's form).
    if [ -z "$AUTOSTART" ] && [ -f "$AGENT_PLIST" ]; then
        AUTOSTART=yes
    fi
    if [ -z "$AUTOSTART" ] && [ -f "$INSTALL_DIR/autostart-asked" ]; then
        AUTOSTART=$(head -n 1 "$INSTALL_DIR/autostart-asked" 2>/dev/null)
    fi
    if [ -z "$AUTOSTART" ]; then
        if [ "$SILENT" = "1" ]; then
            AUTOSTART=yes
        else
            if confirm "Run the runner in the background, and start it again whenever you sign in? It runs while you are signed in to this Mac, without a Terminal window. Choose Not now to run it in this window instead." "Not now" "Yes" yes; then
                AUTOSTART=yes
            else
                AUTOSTART=no
            fi
            printf '%s\n' "$AUTOSTART" >"$INSTALL_DIR/autostart-asked"
        fi
    fi
    if [ "$AUTOSTART" = "yes" ]; then
        if install_launch_agent; then
            say "The runner now runs in the background while you are signed in, and starts again when you sign in."
            say "Log: $RUNLOG"
            wait_s=${AITP_INSTALLER_WAIT_SECONDS:-20}
            ww=0
            while [ "$ww" -lt "$wait_s" ]; do
                if grep -q 'Connected to the platform' "$RUNLOG" 2>/dev/null; then
                    say "The runner is connected to $PLATFORM_URL as \"$RUNNER_NAME\"."
                    notify "Connected to $PLATFORM_URL as $RUNNER_NAME"
                    break
                fi
                sleep 1
                ww=$((ww + 1))
            done
            say "To stop it for good, open the app again and choose Uninstall, or run it with --uninstall."
            pause_if_interactive
            exit 0
        fi
        say "The sign-in start could not be set up. Starting the runner in this window instead."
    fi

    say "Starting the runner. Look for the line \"Connected to the platform\" below, and leave this window open. Press Ctrl-C to stop it."
    say ""
    FATAL_CODE=0
    run_loop foreground
    if [ "$FATAL_CODE" -ne 0 ]; then
        pause_if_interactive
        exit "$FATAL_CODE"
    fi
    say ""
    say "The runner stopped."
    pause_if_interactive
    exit 0
}

case "$MODE" in
    uninstall) do_uninstall ;;
    loop)
        # What a LaunchAgent runs. No questions, no windows.
        SILENT=1
        run_loop launchd
        exit 0
        ;;
    *) do_setup ;;
esac
