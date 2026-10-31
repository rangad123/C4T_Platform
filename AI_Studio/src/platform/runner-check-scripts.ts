/**
 * check-computer.cmd, check-computer.sh and check-computer.command: "Check this computer" in every runner download (docs/features/runner-check.md).
 *
 * In a download with start scripts (the plain files and the complete download) they hand over to start-runner, which finds Node.js exactly as
 * it does for the runner (a complete download's own Node.js first) and then, with AITP_KIT_CHECK=1, runs `node runner.mjs --check` instead of
 * installing anything or starting the runner. An installer download has no start script: there they check the runner the installer set up in
 * its default folder, with the Node.js it chose, or say to run the installer first (which runs the same check at its end).
 *
 * Like the start scripts they contain no name, address or token: everything is read by the runner program from runner.json and runner.token.
 * Written with \n here; the zip gives the .cmd CRLF line endings (see withLineEnding). Keep the .cmd ASCII.
 */

/** check-computer.cmd (double-click on Windows). */
export const CHECK_CMD = `@echo off
rem Checks this computer for the AI Testing Platform runner and says what to fix (docs/features/runner-check.md).
rem It changes nothing, installs nothing and never shows the token.
setlocal EnableExtensions
cd /d "%~dp0"
title Check this computer for the runner
set "AITP_KIT_CHECK=1"
if not exist "start-runner.cmd" goto installer
rem start-runner.cmd finds Node.js the way it does for the runner, then runs "node runner.mjs --check" instead of the runner.
call .\\start-runner.cmd
exit /b %errorlevel%

:installer
rem An installer download has no start script: check the runner the installer set up, with its Node.js (or one on the PATH).
echo.
echo Check this computer for the AI Testing Platform runner
echo.
set "AITP_HOME=%LOCALAPPDATA%\\AITestingRunner"
if not exist "%AITP_HOME%\\app\\runner.mjs" goto notinstalled
set "NODE_BIN="
if exist "%AITP_HOME%\\node\\node.exe" set "NODE_BIN=%AITP_HOME%\\node\\node.exe"
if not defined NODE_BIN for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE_BIN set "NODE_BIN=%%P"
if not defined NODE_BIN goto nonode
cd /d "%AITP_HOME%\\app"
"%NODE_BIN%" runner.mjs --check
set "CODE=%errorlevel%"
goto end

:notinstalled
echo missing   The runner is not set up on this computer yet.
echo           To fix: Double-click AITestingRunnerSetup.exe. It sets the runner up and runs this same check at its end.
set "CODE=1"
goto end

:nonode
echo missing   Node.js 24 or newer was not found, so the other checks could not run.
echo           To fix: Double-click AITestingRunnerSetup.exe again: it gets Node.js for the runner.
set "CODE=1"

:end
echo.
if not "%AITP_KIT_NO_PAUSE%"=="1" pause
exit /b %CODE%
`;

/** check-computer.sh (Mac and Linux: `sh check-computer.sh`). POSIX sh, like start-runner.sh. */
export const CHECK_SH = `#!/bin/sh
# Checks this computer for the AI Testing Platform runner and says what to fix (docs/features/runner-check.md).
# It changes nothing, installs nothing and never shows the token.
cd "$(dirname "$0")" || exit 1
AITP_KIT_CHECK=1
export AITP_KIT_CHECK
if [ -f start-runner.sh ]; then
    # start-runner.sh finds Node.js the way it does for the runner, then runs "node runner.mjs --check" instead of the runner.
    exec sh ./start-runner.sh
fi

# An installer download (the Mac app) has no start script: check the runner the app set up, with the Node.js it chose (or one on the PATH).
echo
echo "Check this computer for the AI Testing Platform runner"
echo
check_done() {
    echo
    if [ "$AITP_KIT_NO_PAUSE" != "1" ] && [ -t 0 ]; then
        printf 'Press Enter to close this window. '
        read -r _ignored
    fi
    exit "$1"
}
home="$HOME/Library/Application Support/AITestingRunner"
if [ ! -f "$home/runner/runner.mjs" ]; then
    echo "missing   The runner is not set up on this computer yet."
    echo "          To fix: Open \\"AI Testing Runner\\". It sets the runner up and runs this same check at its end."
    check_done 1
fi
node_bin=""
if [ -f "$home/node-path" ]; then
    node_bin=$(head -n 1 "$home/node-path" 2>/dev/null)
fi
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
    node_bin=$(command -v node 2>/dev/null)
fi
if [ -z "$node_bin" ]; then
    echo "missing   Node.js 24 or newer was not found, so the other checks could not run."
    echo "          To fix: Open \\"AI Testing Runner\\" again: it gets Node.js for the runner."
    check_done 1
fi
cd "$home/runner" || check_done 1
"$node_bin" runner.mjs --check
check_done $?
`;

/** check-computer.command: macOS opens this one in Terminal when it is double-clicked (a .sh file opens in a text editor). */
export const CHECK_COMMAND = `#!/bin/sh
exec sh "$(dirname "$0")/check-computer.sh"
`;

/** The three files, for the zips: name, text, line ending, Unix mode. */
export const CHECK_FILES: ReadonlyArray<{ name: string; text: string; eol: "\r\n" | "\n" }> = [
    { name: "check-computer.cmd", text: CHECK_CMD, eol: "\r\n" },
    { name: "check-computer.sh", text: CHECK_SH, eol: "\n" },
    { name: "check-computer.command", text: CHECK_COMMAND, eol: "\n" },
];
