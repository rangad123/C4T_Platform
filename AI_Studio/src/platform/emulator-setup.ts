/**
 * The downloadable "set up the Android emulator" helper for the computer that runs the platform (Settings → Mobile testing).
 *
 * It is a small, per-OS script, not a multi-gigabyte kit: the Android SDK, emulator and system image are license-gated by Google and far
 * too large to redistribute, so the script downloads them at run time the same way the runner fetches browsers and adb. All it does is
 * check that Node.js is there, then run `npx @taqwright/taqwright install --with-avd`, which vendors the JDK, the SDK, Appium and an
 * emulator image and creates an AVD (see src/engine/mobile/toolchain.ts). Run in the platform's own folder it uses the installed
 * @taqwright/taqwright; run anywhere else npx fetches it. There is no user input in the script, so nothing is interpolated into a shell.
 */
import type { RouteCtx } from "./routes/types.js";
import { HttpError } from "./http-error.js";

/** The one command the setup runs. npx uses the copy in the platform's node_modules when present, else fetches it. */
const INSTALL = "npx --yes @taqwright/taqwright install --with-avd";

const WINDOWS = `@echo off
setlocal
echo ============================================================
echo   AI Testing Platform - set up the Android emulator
echo ============================================================
echo.
echo This downloads the Android tools and creates an emulator so that mobile
echo tests can run on this computer: about 2-3 GB to download, about 15 GB of
echo disk, and 15-30 minutes depending on your connection.
echo.
REM Messages live under labels, not inside ( ) blocks: a ")" in an echo would end such a block early.
where node >nul 2>nul
if errorlevel 1 goto nonode
set NODE_MAJOR=
for /f "delims=" %%v in ('node -p "parseInt(process.versions.node)"') do set NODE_MAJOR=%%v
if not defined NODE_MAJOR goto oldnode
if %NODE_MAJOR% LSS 24 goto oldnode
echo [ok] Node.js %NODE_MAJOR% found.
echo.
echo Downloading the Android SDK, an emulator and a system image, and
echo creating an emulator. Keep this window open...
echo.
call ${INSTALL}
if errorlevel 1 goto failed
echo.
echo [done] The emulator is set up. Open the platform, go to
echo        Settings - Mobile testing; it should now say Ready.
pause
exit /b 0

:nonode
echo [missing] Node.js is not installed.
echo           Install Node.js 24 or newer from https://nodejs.org/ and run this file again.
pause
exit /b 1

:oldnode
echo [too old] This computer has Node.js %NODE_MAJOR%; the Android tools need Node.js 24 or newer.
echo           Install it from https://nodejs.org/ and run this file again.
pause
exit /b 1

:failed
echo.
echo [failed] Setup did not finish - read the messages above.
echo          If a download was cut off (a dropped connection), run this file again: it continues where it stopped.
echo          It usually needs about 15 GB of free disk, 3 GB of free memory, and
echo          hardware virtualization turned on (BIOS, and "Windows Hypervisor Platform"
echo          or "Hyper-V" under Windows Features).
pause
exit /b 1
`;

const UNIX = `#!/bin/sh
# AI Testing Platform - set up the Android emulator (run on the computer that runs the platform).
echo "============================================================"
echo "  AI Testing Platform - set up the Android emulator"
echo "============================================================"
echo
echo "This downloads the Android tools and creates an emulator so that mobile tests can run on this computer:"
echo "about 2-3 GB to download, about 15 GB of disk, and 15-30 minutes depending on your connection."
echo
if ! command -v node >/dev/null 2>&1; then
  echo "[missing] Node.js is not installed."
  echo "          Install Node.js 24 or newer from https://nodejs.org/ (or your package manager) and run this again."
  exit 1
fi
NODE_MAJOR=$(node -p "parseInt(process.versions.node)" 2>/dev/null)
case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "[too old] This computer has Node.js $NODE_MAJOR; the Android tools need Node.js 24 or newer."
  echo "          Install it from https://nodejs.org/ (or your package manager) and run this again."
  exit 1
fi
echo "[ok] Node.js $NODE_MAJOR found."
echo
echo "Downloading the Android SDK, an emulator and a system image, and creating an emulator..."
echo
if ! ${INSTALL}; then
  echo
  echo "[failed] Setup did not finish - read the messages above."
  echo "         If a download was cut off (a dropped connection), run this again: it continues where it stopped."
  echo "         It usually needs about 15 GB of free disk and 3 GB of free memory."
  echo "         On Linux the emulator needs KVM (/dev/kvm); on a Mac it works out of the box."
  exit 1
fi
echo
echo "[done] The emulator is set up. Open the platform, go to Settings > Mobile testing; it should now say Ready."
`;

// Line endings are set here, not inherited from how this source file was checked out: a Windows checkout with core.autocrlf=true would
// otherwise give the .sh CRLF endings, which sh rejects ("then\r"), while cmd.exe is safest with CRLF.
const crlf = (s: string): string => s.replace(/\r?\n/g, "\r\n");
const lf = (s: string): string => s.replace(/\r\n/g, "\n");

/** The setup scripts, by operating system. "unix" covers macOS and Linux. */
export const EMULATOR_SETUP = {
    windows: { file: "setup-emulator.cmd", contentType: "application/octet-stream", body: crlf(WINDOWS) },
    unix: { file: "setup-emulator.sh", contentType: "application/octet-stream", body: lf(UNIX) },
} as const;

export type SetupOs = keyof typeof EMULATOR_SETUP;

/** The script for an OS name ("windows" / "unix"; "mac" and "linux" map to unix), or undefined when the name is not one we serve. */
export function emulatorSetupScript(os: string): (typeof EMULATOR_SETUP)[SetupOs] | undefined {
    const key = os === "mac" || os === "macos" || os === "darwin" || os === "linux" ? "unix" : os;
    return key === "windows" || key === "unix" ? EMULATOR_SETUP[key] : undefined;
}

export function registerEmulatorSetupRoutes(ctx: RouteCtx): void {
    const { app } = ctx;
    // GET /api/mobile/emulator-setup?os=windows|unix — the setup script for the platform's computer (Settings → Mobile testing).
    app.get("/api/mobile/emulator-setup", async (req, reply) => {
        const os = String((req.query as { os?: string } | undefined)?.os ?? "").toLowerCase();
        const script = emulatorSetupScript(os);
        if (!script) throw new HttpError(400, 'Choose which computer this is for: os=windows or os=unix (Mac or Linux).');
        return reply
            .header("content-type", script.contentType)
            .header("content-disposition", `attachment; filename="${script.file}"`)
            .header("access-control-expose-headers", "content-disposition")
            .header("cache-control", "no-store")
            .send(script.body);
    });
}
