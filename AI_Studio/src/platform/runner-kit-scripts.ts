/**
 * The text files of a runner kit: the start scripts and the README. Plain strings, written with `\n` here and converted to the
 * line endings each system expects when the zip is built (CRLF for .cmd and the Windows README, LF for the rest).
 *
 * Nothing in these texts is taken from a person's input except the project name and the runner name in the README, which is only read by
 * a person. The start scripts contain no project, name, address or token: they read runner.json and runner.enroll (or, for a download
 * made before round 39, runner.token) through the program, so a name with quotes, percent signs or ampersands cannot reach a shell.
 *
 * Enrollment (round 39): a download holds a one-time code in runner.enroll, never a long-lived credential. The scripts start the runner
 * with --enroll-file runner.enroll while that file is there; the runner trades the code for its own credential, keeps it in this
 * computer's credential store and deletes the file. Every later start passes no credential at all (the runner reads the stored one); a
 * folder from an older download still has runner.token and starts with --token-file as before.
 *
 * Test tools: with package-lock.json (every download from round 39 on) the scripts run `npm ci --ignore-scripts`, which installs exactly
 * the locked versions and checksums and runs no package's install script; without it, `npm install` as before.
 *
 * Finding Node.js (both scripts, same rule): a double-clicked file does not get the PATH a person's own terminal has, so "node" can be
 * installed and still invisible. The scripts therefore test every candidate they can find (the PATH, the places installers and version
 * managers use, and as a last resort the person's own shell or the PATH Windows has saved), use the first one that is NODE_MIN_MAJOR or
 * newer, put its folder first on PATH for the rest of the run, and say which one they use. Three different sentences: nothing found,
 * something found but too old (which, and where), and the "Using Node.js ..." line.
 *
 * A complete download (runner-kit-complete.ts) carries its own Node.js (node/node.exe, node/bin/node) and a complete node_modules
 * (marked by node_modules/.aitp-complete). The scripts try that Node.js first ("Using the Node.js that came with this download") and fall
 * back to the search above only when it does not start (for example the download for another processor); they skip npm install when
 * the marker is there. No script downloads a browser any more: the runner program chooses one itself (installed Chrome or Edge, or a
 * download it makes once).
 *
 * Two environment variables exist for the tests only: AITP_KIT_EXTRA_NODE_DIRS (more folders to look in, ";" separated on Windows,
 * ":" elsewhere) and AITP_KIT_SKIP_SHELL_SEARCH=1 (skip the last-resort search of the person's shell or the saved Windows PATH, which
 * would otherwise find the Node.js of the computer the test runs on).
 */

export type KitPlatform = "windows" | "unix";

export const NODE_MIN_MAJOR = 24;

/** start-runner.cmd (double-click on Windows). Keep every line ASCII: cmd.exe reads the file in the computer's code page. */
export const START_CMD = `@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title AI Testing Platform runner
echo.
echo AI Testing Platform runner
echo.

rem --- find Node.js ${NODE_MIN_MAJOR} or newer: the PATH first, then the places installers and version managers use ---
rem Paths are always inside quotes and never inside a ( ) block, so a folder like "Program Files (x86)" or "runner (1)" is safe.
set "NODE_BIN="
set "NODE_VER="
set "OLDBIN1="
set "OLDBIN2="
set "OLDBIN3="

rem --- a complete download carries its own Node.js in the node folder: that one comes first ---
rem A relative path on purpose: this folder's name never goes through "call", which would misread a percent sign or a caret in it.
set "NODE_BUNDLED="
if not exist "node\\node.exe" goto nobundled
call :trynode "node\\node.exe"
if defined NODE_BIN set "NODE_BUNDLED=1"
if defined NODE_BIN goto havenode
echo The Node.js that came with this download does not start on this computer. It may be the download for another processor.
echo Looking for a Node.js installed on this computer instead.
echo.
:nobundled

for /f "delims=" %%P in ('where node 2^>nul') do call :trynode "%%P"
if defined NODE_BIN goto havenode

if not defined AITP_KIT_EXTRA_NODE_DIRS goto noextra
for %%D in ("%AITP_KIT_EXTRA_NODE_DIRS:;=" "%") do call :trydir "%%~D"
if defined NODE_BIN goto havenode
:noextra

call :trydir "%ProgramFiles%\\nodejs"
call :trydir "%ProgramW6432%\\nodejs"
call :trydir "%ProgramFiles(x86)%\\nodejs"
call :trydir "%LOCALAPPDATA%\\Programs\\nodejs"
call :trydir "%NVM_SYMLINK%"
call :trydir "%LOCALAPPDATA%\\Volta\\bin"
if defined VOLTA_HOME call :trydir "%VOLTA_HOME%\\bin"
if defined NODE_BIN goto havenode
if defined NVM_HOME for /d %%D in ("%NVM_HOME%\\v*") do call :trydir "%%~D"
for /d %%D in ("%APPDATA%\\nvm\\v*") do call :trydir "%%~D"
for /d %%D in ("%LOCALAPPDATA%\\nvm\\v*") do call :trydir "%%~D"
for /d %%D in ("%APPDATA%\\fnm\\node-versions\\*") do call :trydir "%%~D\\installation"
for /d %%D in ("%LOCALAPPDATA%\\fnm\\node-versions\\*") do call :trydir "%%~D\\installation"
for /d %%D in ("%LOCALAPPDATA%\\fnm_multishells\\*") do call :trydir "%%~D"
if defined NODE_BIN goto havenode

rem Last resort: ask PowerShell, which also reads the PATH Windows has saved (this window may have started before Node.js was installed).
if "%AITP_KIT_SKIP_SHELL_SEARCH%"=="1" goto searchdone
set "PSEXE=powershell"
if exist "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" set "PSEXE=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
for /f "usebackq delims=" %%P in (\`call "%PSEXE%" -NoProfile -NonInteractive -Command "$pc = [string][char]37; $ex = { param($m) $n = $m.Groups[1].Value; $v = $null; foreach ($t in 'Process','User','Machine') { if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, $t) } }; if ($v) { $v } else { $m.Value } }; $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $c.Source }; $keys = @([Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')); foreach ($k in $keys) { if ($k) { $p = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); foreach ($d in $p.Split(';')) { if ($d) { $d = [regex]::Replace($d, $pc + '([^' + $pc + ']+)' + $pc, $ex); $f = Join-Path $d 'node.exe'; if (Test-Path -LiteralPath $f) { $f } } } } }" 2^>nul\`) do call :trynode "%%P"
:searchdone
if defined NODE_BIN goto havenode
if defined OLDBIN1 goto oldnode
goto nonode

:nonode
echo Node.js was not found on this computer. The runner needs Node.js ${NODE_MIN_MAJOR} or newer.
echo I looked on the PATH, in Program Files, in the nvm-windows, Volta and fnm folders, and in the PATH saved in Windows.
goto askinstall

:oldnode
call :printold
echo.
echo To update: install the LTS version from https://nodejs.org, or with nvm-windows run  nvm install ${NODE_MIN_MAJOR}  and  nvm use ${NODE_MIN_MAJOR}.

:askinstall
if "%AITP_KIT_CHECK%"=="1" goto checknonode
where winget >nul 2>nul
if errorlevel 1 goto manualnode
echo.
echo I can install Node.js for you with the Windows Package Manager:
echo     winget install OpenJS.NodeJS.LTS
set "ANSWER="
set /p "ANSWER=Install it now? Type y and press Enter, or just press Enter to skip: "
if /i not "%ANSWER%"=="y" goto manualnode
winget install OpenJS.NodeJS.LTS
if errorlevel 1 goto wingetfail
echo.
echo Node.js is installed. Close this window and double-click start-runner.cmd again, so Windows finds it.
goto fail

:wingetfail
echo.
echo The installation did not finish.

:manualnode
echo.
echo Install the LTS version from https://nodejs.org, then double-click start-runner.cmd again.
goto fail

:havenode
for %%I in ("%NODE_BIN%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"
setlocal EnableDelayedExpansion
if defined NODE_BUNDLED echo Using the Node.js that came with this download, version !NODE_VER!.
if not defined NODE_BUNDLED echo Using Node.js !NODE_VER! from !NODE_BIN!.
endlocal
rem check-computer.cmd: check this computer instead of starting the runner (installs nothing, docs/features/runner-check.md).
if "%AITP_KIT_CHECK%"=="1" goto check
if "%AITP_KIT_SKIP_INSTALL%"=="1" goto run

rem --- the test tools: a complete download has them already, the plain files kit installs them on the first start ---
rem There is no browser step: the runner itself uses Chrome or Edge from this computer, or downloads a browser once (it says which).
if exist "node_modules\\.aitp-complete" if exist "node_modules\\@playwright\\test\\package.json" goto completetools
if exist "complete-kit.json" goto incomplete
if exist "node_modules\\@playwright\\test\\package.json" goto run
echo First start: installing the test tools. This needs the internet and can take a few minutes.
rem npm trusts this computer's certificate store (company certificates) and, when no proxy variable is set, uses "proxy" from runner.json.
rem That address may hold a password: it is never printed, and setlocal keeps both settings to npm only.
setlocal
set "NODE_USE_SYSTEM_CA=1"
if not defined HTTPS_PROXY call :kitproxy
rem With the download's lock file: exactly the locked versions and checksums, and no package's install script runs.
if exist "package-lock.json" goto npmci
call npm install --no-audit --no-fund
goto npmdone
:npmci
call npm ci --ignore-scripts --no-audit --no-fund
:npmdone
set "NPMCODE=%errorlevel%"
endlocal & set "NPMCODE=%NPMCODE%"
if not "%NPMCODE%"=="0" goto npmfail
goto run

:completetools
echo The test tools came with this download. Nothing to install.
goto run

:incomplete
echo.
echo This download is incomplete: the node_modules folder is missing or damaged.
echo Unzip the whole download again (right-click the zip file, then Extract all), or download a new runner from the platform.
goto fail

:npmfail
echo.
echo The test tools could not be installed. Check that this computer can reach the internet, then double-click start-runner.cmd again.
goto fail

:run
echo.
echo Starting the runner. Look for the line "Connected to the platform" below, and leave this window open.
echo If it says it could not reach the platform, check the address in runner.json and your network.
echo.

:loop
rem The one-time code while it is there, an older download's token, else the credential the runner saved.
if exist "runner.enroll" goto runenroll
if exist "runner.token" goto runtoken
call node runner.mjs
goto ran
:runenroll
call node runner.mjs --enroll-file runner.enroll
goto ran
:runtoken
call node runner.mjs --token-file runner.token
:ran
set "CODE=%errorlevel%"
if "%CODE%"=="0" goto done
if "%CODE%"=="2" goto badsettings
if "%CODE%"=="3" goto revoked
if "%CODE%"=="4" goto versions
if "%CODE%"=="5" goto refused
if "%CODE%"=="75" goto updated
echo.
echo The runner stopped unexpectedly (code %CODE%). Starting it again in 5 seconds. Close this window to stop it.
ping -n 6 127.0.0.1 >nul
goto loop

rem --- code 75: the runner switched to a new version of itself (docs/features/runner-updates.md): start it again at once ---
:updated
echo.
echo The runner updated itself. Starting the new version.
if exist ".update\\node-next\\node.exe" call :swapnode
goto loop

:badsettings
echo.
echo The runner could not read its settings. Check that you unzipped the whole kit, or download a new one from the platform.
goto fail

:revoked
echo.
echo The platform no longer accepts this runner. It was removed, another computer was set up in its place, or its code was already used or has expired.
echo Set up your runner again from Settings, Your runner in the platform.
goto fail

:versions
echo.
echo This runner and the platform are different versions. Download a new runner kit from the platform.
goto fail

:refused
echo.
echo The platform refused this runner. The message above says why.
goto fail

:done
echo.
echo The runner stopped.
exit /b 0

:fail
echo.
if not "%AITP_KIT_NO_PAUSE%"=="1" pause
exit /b 1

rem --- check-computer.cmd (AITP_KIT_CHECK=1): the runner checks this computer and says what to fix; nothing is installed or started ---
:check
echo.
call node runner.mjs --check
set "CODE=%errorlevel%"
echo.
if not "%AITP_KIT_NO_PAUSE%"=="1" pause
exit /b %CODE%

:checknonode
echo.
echo missing   Node.js ${NODE_MIN_MAJOR} or newer was not found, so the other checks could not run.
echo           To fix: Install the LTS version from https://nodejs.org, or download the complete runner from the platform (it brings its own Node.js). Then run this check again.
goto fail

rem --- helpers (reached only by call) ---

rem :kitproxy - HTTPS_PROXY for npm from "proxy" in runner.json (an http or https address only). Never echoed: it may hold a password.
:kitproxy
for /f "usebackq delims=" %%P in (\`node -e "try{var p=JSON.parse(require('fs').readFileSync('runner.json','utf8')).proxy;if(typeof p=='string')if(['http:','https:'].indexOf(new URL(p).protocol)!=-1)process.stdout.write(p)}catch(e){}" 2^>nul\`) do set "HTTPS_PROXY=%%P"
exit /b 0

rem :swapnode - an update brought a new Node.js for this download: put it in the node folder, keeping the old one in .update for a rollback.
rem Only while the runner is stopped (it just exited). Windows can hold node.exe for a moment after the process ends (a virus scanner,
rem a busy computer), so the move is tried up to 10 times, one second apart, before the update keeps the old Node.js.
:swapnode
if not exist "node\\node.exe" exit /b 0
if exist ".update\\node-previous" rmdir /s /q ".update\\node-previous"
set "SWAPTRY=0"
:swapmove
move "node" ".update\\node-previous" >nul 2>nul
if not errorlevel 1 goto swapnext
set /a SWAPTRY+=1
if %SWAPTRY% GEQ 10 exit /b 0
ping -n 2 127.0.0.1 >nul
goto swapmove
:swapnext
move ".update\\node-next" "node" >nul 2>nul
if errorlevel 1 move ".update\\node-previous" "node" >nul 2>nul
exit /b 0

rem :trydir "folder" - look for node.exe in a folder (node.cmd too: some tools put a small .cmd there)
:trydir
if defined NODE_BIN exit /b 0
if "%~1"=="" exit /b 0
call :trynode "%~1\\node.exe"
call :trynode "%~1\\node.cmd"
exit /b 0

rem :trynode "file" - is it a Node.js ${NODE_MIN_MAJOR} or newer? Sets NODE_BIN and NODE_VER if so; remembers up to three older ones for the message.
rem The version line is filtered by findstr so only something shaped like v26.1.0 is ever put into a variable.
:trynode
if defined NODE_BIN exit /b 0
if not exist "%~1" exit /b 1
set "TN_VER="
for /f "usebackq delims=" %%V in (\`call "%~1" --version 2^>nul ^| findstr /r /c:"^v[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*[.0-9A-Za-z-]*$"\`) do set "TN_VER=%%V"
if not defined TN_VER exit /b 1
set "TN_MAJOR=%TN_VER:~1%"
for /f "delims=." %%M in ("%TN_MAJOR%") do set "TN_MAJOR=%%M"
if %TN_MAJOR% GEQ ${NODE_MIN_MAJOR} set "NODE_BIN=%~1" & set "NODE_VER=%TN_VER%" & exit /b 0
if /i "%OLDBIN1%"=="%~1" exit /b 1
if /i "%OLDBIN2%"=="%~1" exit /b 1
if /i "%OLDBIN3%"=="%~1" exit /b 1
if not defined OLDBIN1 set "OLDBIN1=%~1" & set "OLDVER1=%TN_VER%" & exit /b 1
if not defined OLDBIN2 set "OLDBIN2=%~1" & set "OLDVER2=%TN_VER%" & exit /b 1
if not defined OLDBIN3 set "OLDBIN3=%~1" & set "OLDVER3=%TN_VER%" & exit /b 1
exit /b 1

rem :printold - one line for each older Node.js found (delayed expansion keeps odd characters in a path from being read as commands)
:printold
setlocal EnableDelayedExpansion
if defined OLDBIN1 echo Found Node.js !OLDVER1! at !OLDBIN1!. That is too old, the runner needs ${NODE_MIN_MAJOR} or newer.
if defined OLDBIN2 echo Found Node.js !OLDVER2! at !OLDBIN2!. That is too old, the runner needs ${NODE_MIN_MAJOR} or newer.
if defined OLDBIN3 echo Found Node.js !OLDVER3! at !OLDBIN3!. That is too old, the runner needs ${NODE_MIN_MAJOR} or newer.
endlocal
exit /b 0
`;

/** start-runner.sh (macOS and Linux). POSIX sh: no bashisms, no `local`, no arrays; it has to run under a Mac's /bin/sh, dash and Git Bash. */
export const START_SH = `#!/bin/sh
# Starts the AI Testing Platform runner. Every path below is quoted, so a folder name with spaces or brackets is fine.
cd "$(dirname "$0")" || exit 1
echo
echo "AI Testing Platform runner"
echo

# macOS marks everything that came from the internet as quarantined. Clear that for this folder only, so the browser and the packages
# installed below are not blocked later. Silent, and nothing happens when it does not apply. (check-computer.sh changes nothing: the check reports the flag.)
if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && [ "$AITP_KIT_CHECK" != "1" ]; then
    xattr -dr com.apple.quarantine . >/dev/null 2>&1
fi

say() {
    printf '%s\\n' "$*"
}

pause_if_interactive() {
    if [ "$AITP_KIT_NO_PAUSE" != "1" ] && [ -t 0 ]; then
        printf 'Press Enter to close this window. '
        read -r _ignored
    fi
}

fail() {
    echo
    pause_if_interactive
    exit "\${1:-1}"
}

# --- find Node.js ${NODE_MIN_MAJOR} or newer ---
# A double-clicked file does not read the shell profile (.zshrc, .bashrc), where nvm, fnm, Volta and friends put node on the PATH. So
# every candidate is tested, and the first one that is new enough is used.
NODE_MIN=${NODE_MIN_MAJOR}
NODE_BIN=""
NODE_VER=""
OLD_NODES=""
OLD_SEEN="|"
NL='
'

# try_node FILE: is FILE a usable Node.js? Sets NODE_BIN and NODE_VER if it is new enough; remembers an older one for the message.
try_node() {
    [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ] || return 1
    tn_out=$("$1" --version 2>/dev/null </dev/null) || return 1
    tn_ver=\${tn_out#v}
    tn_ver=\${tn_ver%%[!0-9.]*}
    tn_major=\${tn_ver%%.*}
    case "$tn_major" in
        ''|*[!0-9]*) return 1 ;;
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
            OLD_NODES="$OLD_NODES""Found Node.js v$tn_ver at $1. That is too old, the runner needs $NODE_MIN or newer.$NL"
            ;;
    esac
    return 1
}

# try_dirs "one folder per line": look for "node" in each folder, in order.
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

# try_lines "one answer per line": a shell's answer to "where is node", only lines that are absolute paths.
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
    bd_file=$(mktemp "\${TMPDIR:-/tmp}/aitp-node.XXXXXX" 2>/dev/null) || return 1
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

find_node() {
    # 1. Whatever "node" means right now, then every folder on the PATH (the first one may be an old one).
    try_node "$(command -v node 2>/dev/null)" && return 0
    try_dirs "$(printf '%s\\n' "$PATH" | tr ':' '\\n')" && return 0
    if [ -n "$AITP_KIT_EXTRA_NODE_DIRS" ]; then
        try_dirs "$(printf '%s\\n' "$AITP_KIT_EXTRA_NODE_DIRS" | tr ':' '\\n')" && return 0
    fi
    # 2. The places Homebrew, installers and version managers use.
    for fn_dir in \\
        /opt/homebrew/bin /opt/homebrew/opt/node*/bin /usr/local/bin /usr/local/opt/node*/bin /opt/local/bin /usr/bin \\
        "$HOME/.volta/bin" "$HOME/.asdf/shims" "$HOME/.local/share/mise/shims" "$HOME/.mise/shims" "$HOME/.nodenv/shims" "$HOME/.n/bin" \\
        "\${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin "$HOME"/.nvm/versions/node/*/bin \\
        "$HOME"/.local/share/fnm/node-versions/*/installation/bin "$HOME/Library/Application Support"/fnm/node-versions/*/installation/bin \\
        "$HOME"/.fnm/node-versions/*/installation/bin "$HOME"/.asdf/installs/nodejs/*/bin "$HOME"/.local/share/mise/installs/node/*/bin \\
        /usr/local/n/versions/node/*/bin
    do
        try_node "$fn_dir/node" && return 0
    done
    # 3. nvm, read the way a terminal would (in a throwaway shell, so nothing here changes).
    for fn_nvm in "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" /opt/homebrew/opt/nvm/nvm.sh /usr/local/opt/nvm/nvm.sh; do
        [ -s "$fn_nvm" ] || continue
        fn_out=$(bounded 10 /bin/sh -c '. "$1" >/dev/null 2>&1; nvm use default >/dev/null 2>&1; command -v node' sh "$fn_nvm" 2>/dev/null)
        try_lines "$fn_out" && return 0
    done
    # 4. Last resort: ask the person's own login shell, which reads their profile. Bounded, so a slow profile cannot hang this script.
    if [ "$AITP_KIT_SKIP_SHELL_SEARCH" != "1" ]; then
        fn_out=$(bounded 8 "\${SHELL:-/bin/sh}" -ilc 'command -v node' 2>/dev/null)
        try_lines "$fn_out" && return 0
    fi
    return 1
}

# A complete download carries its own Node.js (node/bin/node): that one comes first. Some unzip tools drop the executable bit, so it is
# put back (this folder belongs to the person running the script).
NODE_BUNDLED=""
if [ -f node/bin/node ]; then
    [ -x node/bin/node ] || chmod u+x node/bin/node 2>/dev/null
    if try_node "$(pwd)/node/bin/node"; then
        NODE_BUNDLED=1
    else
        echo "The Node.js that came with this download does not start on this computer. It may be the download for another processor."
        echo "Looking for a Node.js installed on this computer instead."
        echo
    fi
fi

if [ -z "$NODE_BUNDLED" ] && ! find_node; then
    if [ -n "$OLD_NODES" ]; then
        printf '%s' "$OLD_NODES"
        INSTALL_LEAD="To update, install the LTS version from https://nodejs.org, or with your package manager:"
    else
        INSTALL_LEAD="Install the LTS version from https://nodejs.org, or with your package manager:"
        echo "Node.js was not found on this computer. The runner needs Node.js $NODE_MIN or newer."
        echo "I looked on the PATH, in the Homebrew, nvm, fnm, Volta, asdf, mise, nodenv and n folders, and asked your login shell."
    fi
    echo
    # check-computer.sh: say it in the check's own shape, and offer no installation.
    if [ "$AITP_KIT_CHECK" = "1" ]; then
        echo "missing   Node.js $NODE_MIN or newer was not found, so the other checks could not run."
        echo "          To fix: Install the LTS version from https://nodejs.org, or download the complete runner from the platform (it brings its own Node.js). Then run this check again."
        fail 1
    fi
    if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v brew >/dev/null 2>&1 && [ -t 0 ]; then
        echo "I can install it with Homebrew:  brew install node"
        printf 'Install it now? Type y and press Enter, or just press Enter to skip: '
        read -r answer
        if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
            if brew install node; then
                echo
                echo "Node.js is installed. Open a new Terminal window and start this script again, so it is found."
            else
                echo
                echo "The installation did not finish."
            fi
            fail 1
        fi
    fi
    echo "$INSTALL_LEAD"
    echo "    macOS with Homebrew:    brew install node   (brew upgrade node if you already have it)"
    echo "    Ubuntu or Debian:       see https://nodejs.org/en/download for the current commands"
    echo "    any system with nvm:    nvm install $NODE_MIN"
    echo "Then start this script again."
    fail 1
fi

# The rest of this script (npm, npx and the runner) uses the same Node.js.
PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH
if [ -n "$NODE_BUNDLED" ]; then
    say "Using the Node.js that came with this download, version $NODE_VER."
else
    say "Using Node.js $NODE_VER from $NODE_BIN."
fi

# check-computer.sh: check this computer instead of starting the runner (installs nothing; docs/features/runner-check.md).
if [ "$AITP_KIT_CHECK" = "1" ]; then
    echo
    node runner.mjs --check
    check_code=$?
    echo
    pause_if_interactive
    exit "$check_code"
fi

# The test tools: a complete download has them already, the plain files kit installs them on the first start. There is no browser step:
# the runner itself uses Chrome or Edge from this computer, or downloads a browser once (it says which).
if [ "$AITP_KIT_SKIP_INSTALL" != "1" ]; then
    if [ -f node_modules/.aitp-complete ] && [ -f node_modules/@playwright/test/package.json ]; then
        echo "The test tools came with this download. Nothing to install."
    elif [ -f complete-kit.json ]; then
        echo
        echo "This download is incomplete: the node_modules folder is missing or damaged."
        echo "Unzip the whole download again, or download a new runner from the platform."
        fail 1
    elif [ ! -f node_modules/@playwright/test/package.json ]; then
        echo "First start: installing the test tools. This needs the internet and can take a few minutes."
        # npm trusts this computer's certificate store (company certificates) and, when no proxy variable is set, uses "proxy" from
        # runner.json. That address may hold a password: it is never printed, and it is set for npm only.
        kit_proxy=""
        if [ -z "$HTTPS_PROXY" ] && [ -z "$https_proxy" ]; then
            kit_proxy=$(node -e "try{var p=JSON.parse(require('fs').readFileSync('runner.json','utf8')).proxy;if(typeof p=='string')if(['http:','https:'].indexOf(new URL(p).protocol)!=-1)process.stdout.write(p)}catch(e){}" 2>/dev/null)
        fi
        # With the download's lock file: exactly the locked versions and checksums, and no package's install script runs.
        if [ -f package-lock.json ]; then
            set -- ci --ignore-scripts --no-audit --no-fund
        else
            set -- install --no-audit --no-fund
        fi
        if [ -n "$kit_proxy" ]; then
            HTTPS_PROXY=$kit_proxy NODE_USE_SYSTEM_CA=1 npm "$@"
        else
            NODE_USE_SYSTEM_CA=1 npm "$@"
        fi
        npm_code=$?
        kit_proxy=""
        if [ "$npm_code" -ne 0 ]; then
            echo
            echo "The test tools could not be installed. Check that this computer can reach the internet, then start this script again."
            fail 1
        fi
    fi
fi

echo
echo 'Starting the runner. Look for the line "Connected to the platform" below, and leave this window open.'
echo "If it says it could not reach the platform, check the address in runner.json and your network."
echo

# Ctrl-C stops the runner, which then exits 0; the script follows it instead of starting it again.
trap 'exit 0' INT TERM
while :; do
    if [ -f runner.enroll ]; then
        node runner.mjs --enroll-file runner.enroll
    elif [ -f runner.token ]; then
        node runner.mjs --token-file runner.token
    else
        node runner.mjs
    fi
    code=$?
    case "$code" in
        0)
            echo
            echo "The runner stopped."
            exit 0
            ;;
        2)
            echo
            echo "The runner could not read its settings. Check that you unzipped the whole kit, or download a new one from the platform."
            fail 2
            ;;
        3)
            echo
            echo "The platform no longer accepts this runner. It was removed, another computer was set up in its place, or its code was already used or has expired."
            echo "Set up your runner again from Settings, Your runner in the platform."
            fail 3
            ;;
        4)
            echo
            echo "This runner and the platform are different versions. Download a new runner kit from the platform."
            fail 4
            ;;
        5)
            echo
            echo "The platform refused this runner. The message above says why."
            fail 5
            ;;
        75)
            # The runner switched to a new version of itself (docs/features/runner-updates.md): start it again at once. A new Node.js that
            # came with the update is put in the node folder now, while nothing runs it (the old one stays in .update for a rollback).
            echo
            echo "The runner updated itself. Starting the new version."
            if [ -f .update/node-next/bin/node ] && [ -f node/bin/node ]; then
                rm -rf .update/node-previous
                if mv node .update/node-previous; then
                    mv .update/node-next node || mv .update/node-previous node
                fi
            fi
            continue
            ;;
    esac
    echo
    echo "The runner stopped unexpectedly (code $code). Starting it again in 5 seconds. Press Ctrl-C to stop it."
    sleep 5
done
`;

/**
 * start-runner.command: macOS opens this one in Terminal when it is double-clicked (a .sh file opens in a text editor). It only hands
 * over to start-runner.sh, which finds Node.js itself; going through the login shell instead would break for shells like fish.
 */
export const START_COMMAND = `#!/bin/sh
exec sh "$(dirname "$0")/start-runner.sh"
`;

export interface ReadmeInput {
    platform: KitPlatform;
    /** @deprecated Downloads are for a person's own computer (round 45); a line is shown only when given. */
    projectName?: string;
    /** Left out: the runner uses the computer's own name. */
    runnerName?: string;
    platformUrl: string;
    kitVersion: string;
    /** Set for the complete download: it carries its own Node.js and packages (see runner-kit-complete.ts). */
    complete?: { target: string; words: string; nodeVersion: string; installer: boolean };
}

/** The Mac and Linux way to start the runner. It avoids the permission and "unidentified developer" prompts a double-click can raise. */
const UNIX_START = `Open Terminal (on a Mac: Applications, Utilities, Terminal). Type  cd  followed by a space, drag the unzipped folder into the Terminal window and press Enter. Then type
   sh start-runner.sh
   and press Enter. (Double-clicking start-runner.command also works, but macOS may say it could not verify the file: open System Settings, Privacy & Security and choose Open Anyway; on macOS 14 or older, right-click the file, choose Open, then Open.)`;

/** README.txt: five plain lines, then how to stop the runner and how to take its access away. */
export function readme(i: ReadmeInput): string {
    const win = i.platform === "windows";
    const c = i.complete;
    const firstStart = c
        ? "Nothing is installed: this download already holds Node.js and the test tools."
        : "The first start installs the test tools, which takes a few minutes and needs the internet.";
    // Windows and Mac (round 45): the installer leads when the download has it; the start script is the way without installing anything.
    const scriptStart = win
        ? `double-click start-runner.cmd. Windows may ask you to confirm because the file came from the internet: choose More info, then Run anyway. ${firstStart}`
        : `${UNIX_START.replace(/^Open/, "open")}
   ${firstStart}`;
    const start = c?.installer
        ? win
            ? `Double-click AITestingRunnerSetup.exe. Windows may say "Windows protected your PC" because the installer is not signed yet: choose More info, then Run anyway. Choose Install and start: it copies the runner to your own folder, keeps it running in the background with an icon next to the clock, and can start it when you sign in. ${firstStart}
   Or, to run it without installing, ${scriptStart}`
            : `Double-click "AI Testing Runner". macOS may say it could not verify the app, because it is not signed yet: on macOS 15 and newer choose Done, then System Settings, Privacy & Security, Open Anyway; on older versions right-click the app and choose Open. It copies the runner to your own folder and can start it when you sign in. ${firstStart}
   Or, to run it without installing, ${scriptStart}`
        : win
          ? `Double-click start-runner.cmd. Windows may ask you to confirm because the file came from the internet: choose More info, then Run anyway. ${firstStart}
   ${c ? "This download is for Windows only." : `On a Mac or Linux computer this folder also holds start-runner.sh and start-runner.command: ${UNIX_START.replace(/\n/g, "\n   ")}`}`
          : `${UNIX_START}
   ${firstStart}
   ${c ? `This download is for ${c.words} only.` : "On Windows, double-click start-runner.cmd instead."}`;
    const node = c
        ? `This download is for ${c.words}. It holds Node.js ${c.nodeVersion} in the node folder and every test tool in node_modules, so it needs nothing else and changes nothing on the computer. If the window says that Node.js does not start, this is the download for another kind of computer: download the right one from the platform.`
        : `You need Node.js ${NODE_MIN_MAJOR} or newer. The start script looks for it in the usual places and says which one it uses. It offers to install it if it is missing.
If it says it cannot find Node.js but you have it, open a terminal (Terminal on a Mac, Command Prompt on Windows) and run  node --version  there. If that works, run the start script from that same window.`;
    return `AI Testing Platform runner${i.runnerName ? ` "${i.runnerName}"` : ""}
${i.projectName ? `Project: ${i.projectName}\n` : ""}Platform: ${i.platformUrl}
Kit version: ${i.kitVersion}${c ? `\nDownload: complete, for ${c.words} (${c.target})` : ""}

1. Unzip this folder on the computer where your application can be reached.
2. ${start}
3. Leave the window open. It says "Connected to the platform" when the runner is ready.
4. In the platform, open Settings, Your runner. It shows this computer as connected, under the computer's own name. From then on your runs, schedules and sessions use it by themselves.
5. The file runner.enroll in this folder is a one-time code. The runner trades it for its own access the first time it starts, keeps that access in this computer's credential store and deletes the file. The code works once, and only for 30 minutes after the download was made: if it has expired, download the runner again from Settings, Your runner.

${node}
If the runner does not connect: ${win ? "double-click check-computer.cmd" : "run  sh check-computer.sh  in the same Terminal window (or double-click check-computer.command)"}. It checks this computer (Node.js, the runner's files, the browser, the proxy and certificates, the platform and the token, disk space, the clock) and says what to fix. It changes nothing and never shows the token.
Web tests need a browser. The runner uses Google Chrome or Microsoft Edge when this computer has one, and otherwise downloads a browser once, the first time it starts. It says which one it uses.

Updates: when the platform is updated, the runner downloads its new version itself, checks every file, waits for its running tests to finish and starts again ("The runner updated itself"). It keeps the previous version: run  node runner.mjs --rollback  in this folder to go back. It installs only an update signed by the platform's publisher; when it cannot check the signature it keeps running and Settings, Your runner says to download the new version.

Company network: the runner finds a proxy set in Windows or in the HTTPS_PROXY variable by itself and trusts this computer's certificate store. If it still cannot connect, add lines to runner.json: "proxy": "http://proxy.example:8080" (with a user name and password if the proxy needs them: "http://user:password@proxy.example:8080"; the password is never shown or sent to the platform), "noProxy": "intranet.example,.corp.example" (addresses reached without the proxy), "caFile": "company-root.pem" (your company's certificate file, in this folder) and "proxyTests": true (tests go through the proxy too). The same settings can be given when starting the runner: --proxy http://proxy.example:8080 and --ca-file company-root.pem.

To stop the runner, close the window or press Ctrl+C.
To take this runner's access away, open Settings, Your runner in the platform and choose Remove this computer. The runner then stops with a message saying so. Setting up another computer does the same for this one: each person has one runner. To remove it from this computer, run  node runner.mjs --forget-credential  in this folder (it deletes the saved access), then delete the folder.
Android tests also need the Android tools on this computer, and iOS tests a Mac with Xcode. See the platform's runner guide.
`;
}

/** Turn \n into the line ending of the target system. */
export const withLineEnding = (text: string, eol: "\r\n" | "\n"): string => (eol === "\n" ? text.replace(/\r\n/g, "\n") : text.replace(/\r?\n/g, "\r\n"));
