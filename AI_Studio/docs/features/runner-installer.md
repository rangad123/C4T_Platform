# Runner installer: double-click, check, download what is missing, run

## What it does for you

The runner kit used to be a zip with a start script. The **installer** is a real program for the same job. A person opens the downloaded folder, double-clicks one file and sees a short checklist. The program checks what the computer already has, **skips what is there**, **downloads only what is missing**, and ends with a runner that is connected to the platform. It needs no administrator rights and no Node.js installed first.

- **Windows:** `AITestingRunnerSetup.exe`, a small WinForms program (about 130 KB) built with the C# compiler that ships with Windows. This document is mostly about it.
- **Mac:** `AI Testing Runner.app`, built by another part of the same build (`scripts/build-installer-mac.mjs`, see `runner-installer-mac.md`). The platform packs both the same way.

Since round 45 it is the one download for Windows and a Mac, from **Settings, Your runner**; nothing is chosen (`runner-enrollment.md`). A server that has not built the installer for a system sends the plain files instead (`runner-kit.md`) and says so. When the server has the complete build for the computer's processor, the installer comes inside that download and uses its Node.js and test tools (`runner-complete-kit.md`).

## What the person sees (Windows)

1. Unzip the download. The folder holds `AITestingRunnerSetup.exe`, `runner.json`, `runner.enroll` (the one-time code), the runner files and a `README.txt`.
2. Double-click `AITestingRunnerSetup.exe`. **Windows will say "Windows protected your PC"** (SmartScreen, "unknown publisher") because the program is not signed; choose **More info**, then **Run anyway**. See "Signing" below.
3. A window lists six rows, each with a state (Checking, Found and skipped, Missing and will download, Downloading n%, Installing, Done, Failed) and a detail:

   | Row | What it checks | If it is missing |
   |---|---|---|
   | Node.js 24 or newer | The same places `start-runner.cmd` looks (the PATH, Program Files, per-user installs, nvm-windows, Volta, fnm, and the PATH Windows has saved in the registry), plus a private copy this installer made earlier. The first one whose `--version` is 24 or newer wins and is shown as "Node.js v26.1.0 found, using it". An older one found first does not stop the search. | Downloads the official zip from `https://nodejs.org/dist/`, checks its SHA-256 against `SHASUMS256.txt` from the same place, and unpacks it into the private folder. Nothing is installed system-wide. |
   | Runner files | Compares each file of the unzipped folder with the installed one by content hash. | Copies only the files that differ. `runner.token` is copied and then readable only by the current user (the file's access list is replaced by one entry). The program also copies itself into the install folder. |
   | Test tools (npm packages) | Every package in the kit's `package.json` is installed at its pinned version, and `playwright-core` exists once (no second copy under `playwright`, `@playwright/test` or `@axe-core/playwright`). | Runs `npm install --no-audit --no-fund` with the Node.js in use (it calls npm's `npm-cli.js` through `node.exe`, so no PATH is needed). The output goes into the details pane. Cancel is available and it gives up after 15 minutes. |
   | Browser for web tests | Nothing (changed in round 17). The row only says the runner chooses a browser when it starts: Google Chrome or Microsoft Edge from this computer, or Chromium downloaded once (`runner-browsers.md`). | Never downloads anything. |
   | Optional extras | Only reported: Android tools found or not, "Windows desktop apps off", Firefox and WebKit installed or not. | Never installed automatically. The unticked box **Also install Firefox and WebKit** adds them. |
   | Connection to the platform | A plain GET of the platform's `/api/health` route from `runner.json`. | Says "Cannot reach <address>" with the likely reasons (offline, firewall or proxy, wrong address, platform switched off). The runner is still started: it keeps trying. |

4. Options: **Start the runner when I sign in** (a shortcut in the Startup folder, default off), **Add the runner to the Start menu** (default on), **Also install Firefox and WebKit** (default off). Then **Install and start**. When everything is already there it skips the click and just starts.
5. The runner is started **hidden** (no console window) by the installer itself. The window says "The runner is running", and the program stays as an icon in the notification area with a menu: the current state ("Connected to <platform> as <name>" or "Not connected: <reason>"), **Open the platform in my browser**, **Show the window**, **Show log**, **Stop the runner** (and **Start the runner**), **Remove this runner from the computer**, **Close this program**. The close button of the window only hides it. The icon has a coloured dot: green connected, amber starting or not connected, grey stopped, red access removed or needs attention.

**Later runs.** The same program is the launcher. Started again with everything in place it spends about a second on the checks and shows only the icon. Started while a copy is already running for the same folder, it opens that copy's window instead (one copy per install folder, by a named mutex). The copy inside the install folder (`AITestingRunner.exe`) manages that folder without any option, so the unzipped folder and the zip can be deleted once the runner is online; the Start menu entry points at that copy.

**If the runner stops.** A crash is followed by a 5 second pause and a restart (like the script). Exit code 3 (the computer was removed or replaced in Settings, or it was a team or project runner) shows "The platform no longer accepts this runner's token... Download a new runner from the platform", tray state "Access removed", and no restart. Codes 2 (settings unreadable), 4 (different versions) and 5 (refused) stop with their message too.

**From a complete download (round 17).** When the unzipped folder holds `node\node.exe` and a `node_modules` marked complete (`runner-complete-kit.md`), that Node.js is used first ("Node.js v24.19.0 came with this download") and copied into the private `node` folder, recorded as `"node": "bundled"` in `installer.json` (later starts use it before searching the computer), and `node_modules` is copied into `app` when its marker differs. Those rows say "In this download, will copy", never "will download", and `--check` exits 0 on a computer with nothing installed.

## Where it installs

`%LOCALAPPDATA%\AITestingRunner\` (or the folder given with `--install-dir`):

| Path | What |
|---|---|
| `app\` | The runner files, `runner.json`, `runner.token`, `node_modules\`, and `work\` (the runner's task folders and cache; kept when files are updated) |
| `node\` | The private Node.js, only if none was found |
| `logs\` | `setup.log` (what Setup did) and `runner.log` (the runner's output, rotated at 2 MB). The token is never in them |
| `downloads\` | The Node.js zip while it is being checked; empty afterwards |
| `AITestingRunner.exe` | A copy of the setup program |
| `installer.json` | What Setup created (private Node.js or not, shortcuts) and the id and start time of the runner it started. Uninstall and "stop" read it |

Outside that folder it writes only the shortcuts the person ticked: `AI Testing Runner.lnk` in the Startup folder and in the Start menu programs folder. It makes **no registry writes** and no changes to the system or user PATH. (The Start menu shortcut goes slightly beyond the first brief, which named only the Startup shortcut; without it there is no way back to the window after the unzipped folder is deleted.)

## Stop and remove

- **Stop** (tray menu, or `AITestingRunnerSetup.exe --stop --install-dir <folder>`): ends only the runner this program started. It is started inside a Windows *job object*, so the runner and everything it spawns end when this program ends, for any reason. Setup also records the runner's process id **and start time**; at the next start, or on uninstall, a leftover runner from a session that ended abnormally is ended only if that pid still has the same start time and is a `node.exe`. A reused process id belonging to anything else is never touched. A running task is cancelled by the platform's lease timeout, not told goodbye.
- **Remove** (tray menu, or `--uninstall`): after asking (a question box; `--silent` or `AITP_INSTALLER_NO_UI=1` skips the question) it stops its own runner, removes the two shortcuts **if they point at this install**, deletes `app`, `node`, `logs`, `downloads`, `installer.json` and its own copy, and removes the folder only if nothing else is in it. It prints what it removed. It never deletes a Node.js found elsewhere, never the shared Playwright browser cache, never anything in a folder that has no `installer.json` of its own, and never follows a linked folder (a junction or symbolic link inside `app` is unlinked, its target is left alone). A copy that runs from the install folder cannot delete itself; a hidden helper does it a few seconds later. A folder another program still has open (a File Explorer or terminal window in it, for example) is tried again for a few seconds and then left in place with a sentence that names it and says to close that program and delete the folder, or to delete it after a restart: nothing deletes it later in the background, so a new install into the same folder never loses its files. The runner starts the Android tools (adb and the emulator) in the system's temp folder, never in its own: adb leaves its server running in the folder it was started from, and on Windows a program's current folder cannot be deleted, so an adb server started from `app` kept the uninstall from removing it until the computer restarted. Still open: when the runner uses the adb it downloaded itself (`app\work\phone-tools`), a running adb server holds its own program file there. Under this installer the job object ends that server with the runner; a server started outside the installer (by the plain download's start script, for example) can keep that folder until it is stopped (`adb kill-server`) or the computer restarts.

## Switches

| Switch | What |
|---|---|
| `--check` | Print the checklist as plain lines and change nothing. Exit **0** nothing would be downloaded, **10** something would be (Node.js or the test tools), **1** error (for example an incomplete unzipped folder) |
| `--silent` | No window, no questions: install what is missing and run the runner in the foreground until stopped. Exit 0 after a stop, **2 to 5** the runner's own codes, 1 failure |
| `--no-start` | Install, do not start the runner |
| `--stop` | Ask the running copy for this install folder to stop its runner and exit |
| `--uninstall` | See above |
| `--install-dir <path>` | Install somewhere else. Paths with spaces and brackets work |
| `--log <file>` | Also write the output to this file |
| `--background` | Start with only the icon when nothing is missing (the Startup shortcut uses it) |
| `--start-at-sign-in`, `--start-menu` | The two window options, for `--silent` installs. `--all-browsers` is still accepted and ignored (round 17 removed the "Also install Firefox and WebKit" option: the runner fetches them itself when a run needs them) |

The program is built with `/target:winexe`, so it has no console of its own: when started from a terminal it attaches to that terminal (or writes to the pipe it was given) for these switches.

**Test-only environment variables** (people never need them; the tests and this document are the only users): `AITP_NODE_DIST_URL` (base address of the Node.js downloads instead of `https://nodejs.org/dist`; plain http is allowed only when this is set), `AITP_INSTALLER_SKIP_NPM=1`, `AITP_INSTALLER_SKIP_BROWSER=1`, `AITP_INSTALLER_NODE_SEARCH_ONLY=<dir;dir>` (look for Node.js only there and in the private copy), `AITP_INSTALLER_NO_UI=1` (never a window, tray icon or question), `AITP_INSTALLER_STARTUP_DIR` and `AITP_INSTALLER_STARTMENU_DIR` (where the shortcuts go instead of the real folders). `--ui-smoke [--screenshot <png>]` builds the window and the tray menu without showing them and paints the window off screen to a picture; the tests use it.

## Honest limits

- **Not signed.** SmartScreen shows "unknown publisher" on the first run, and some antivirus products are wary of unsigned programs that download and start other programs. Signing needs a code-signing certificate that the owner buys (an OV certificate builds reputation over time; an EV certificate is trusted at once) and the Windows SDK's `signtool sign /fd SHA256 /tr <timestamp server> /td SHA256 /f <certificate> AITestingRunnerSetup.exe` after `npm run build:installer`. Nothing here is signed, and nothing in the product pretends it is.
- Verified downloads only: https, and the Node.js zip's SHA-256 must match `SHASUMS256.txt`. The checksum file comes from the same host as the zip, so this catches a damaged or cut-short download and a swapped file on a mirror, not a compromised nodejs.org.
- The Node.js and npm downloads need the internet. A computer with none cannot use the installer's download steps (copy a prepared folder, or use the checkout route).
- Only a node.exe is accepted as Node.js; a `node.cmd` stand-in (which `start-runner.cmd` accepts) is not. 64-bit Windows only (on ARM Windows the x64 build runs under emulation).
- The npm install and the real nodejs.org are **not exercised by the tests** (see Tests).

## Building and hosting it

```
npm run build:installer                 # on Windows: compiles the exe with csc.exe and builds the Mac app; writes dist/installer/
npm run build:installer -- --skip-windows
npm run build:installer -- --windows-exe <file>   # use an exe built elsewhere
```

`dist/installer/` is git-ignored: **never commit it**. It holds `win/AITestingRunnerSetup.exe`, `mac/AI Testing Runner.app/...` and `manifest.json`, which lists every file with its Unix mode and SHA-256. The platform reads only what the manifest names, checks every hash on each download, and falls back to the plain files kit (saying so in the answer's `x-runner-kit-note` header and in the panel) when a part is missing or damaged. The C# compiler exists only on Windows, so the cloud image cannot compile the exe. Two supported ways to host it:

1. **Build on Windows and copy.** Run `npm run build:installer` on a Windows computer, copy the whole `dist/installer/` folder to the server, and point `RUNNER_INSTALLER_DIR` at it (a mounted volume works for Docker). It holds both the Windows and the Mac part.
2. **Build the image with a prebuilt exe.** Put the exe at `installer/prebuilt/AITestingRunnerSetup.exe` (git-ignored) before `docker build`; the Dockerfile then runs `npm run build:installer -- --windows-exe installer/prebuilt/AITestingRunnerSetup.exe`, which adds it to the image next to the Mac app. Without that file the image builds the Mac app only and says so.

Rebuild after updating the platform, as with `npm run build:runner`.

## The platform side

`POST /api/me/runner/download` `{ os: "windows" | "mac", arch }` makes the installer zip when the installer for that system is built here (`x-runner-kit-kind: installer`); otherwise the plain files with `x-runner-kit-kind: files` and `x-runner-kit-note` (a plain sentence). The zip is named `runner-my-computer-windows-setup.zip` (or `-mac-setup.zip`; `runner-my-computer-<target>.zip` when it carries its own Node.js). It holds the program (modes from the manifest), the same prebuilt runner files as the plain kit, `runner.json` (no name: the runner uses the computer's name), `runner.enroll` (mode 0600) and a `README.txt`. `GET /api/me/runner/download/info` says per system and processor whether it is the installer (`kind`) and why not (`note`). Nothing from the server's `.env`, database or data folder enters the zip, and the code is made per download and appears in `runner.enroll` only.

## Tests

- `tests/installer-win-unit.test.ts` (fast): the build finds csc and compiles; the exe is a small PE file with the GUI subsystem, an asInvoker manifest, DPI and UTF-8 settings, version info, an icon and no local path; the message when csc is missing; a compile error is reported plainly; the manifest merge with the Mac part; the loader's checksum checks.
- `tests/runner-installer-kit.test.ts` (no browser): the routes, the zips (entries, modes, README, fallback, validation, secrets).
- `tests/installer-win.test.ts` (browser lock; ports 8815, 8816, 8817): real runs of the compiled program against a real platform, with a local HTTP server standing in for nodejs.org: `--check` results and exit codes; Node.js found, too old, or missing; download, checksum check and unpack; wrong checksum, cut-short download, missing checksum line and a stop during the download all end cleanly; the pinned version when the index is unreadable; a second run that skips everything; the hidden runner connecting with the token from the kit and running an API test and web tests; one copy at a time; `--stop`; a decoy process and a stale recorded pid untouched; revoked token ending with exit code 3; uninstall removing only what it created; shortcuts; the token file's access list; the token in no output or log; running again from the installed copy after the unzipped folder is gone; and the window created and painted off screen.
- `tests/add-runner-ui.test.ts`: the panel with the installer choice, in light and dark, at phone width, with the keyboard.

**Not verified here:** a computer without Node.js at all (the tests stand in a copy of this computer's `node.exe`), the real nodejs.org and npm registry downloads, the npm install and Chromium download steps (switched off in the tests), SmartScreen's behaviour and wording, antivirus reactions to an unsigned program, the look and menu of the tray icon, the window as a person uses it (clicking, the Cancel button during a real npm install, the Start menu and Startup shortcuts starting at sign-in), Windows 10 (the tests ran on Windows 11), and ARM Windows.

## Round 39: one-time codes, background by default, graceful stop, lock file

- **Enrollment.** A download holds `runner.enroll` (a one-time code, valid 30 minutes), never a long-lived credential. Setup copies it into the install folder once (restricted to the current user), records only its sha256 (so opening Setup again from the same unzipped folder never copies a used code back), and deletes an older `runner.token` it replaces. The runner starts with `--enroll-file runner.enroll`, trades the code for its credential, keeps that protected for this Windows user (DPAPI) and deletes the file; later starts pass no credential argument. A folder from an older download still starts with `--token-file runner.token`.
- **Background by default.** "Start the runner when I sign in" is checked by default (a person's earlier choice wins), and `--silent` adds the Startup shortcut too unless `--no-start-at-sign-in` is given. The runner has no window; the icon next to the clock is the one visible sign and its menu is the control. It runs while the person is signed in (a locked screen is fine), not before sign-in and not after sign-out. There is no Windows service on purpose: a service would run customers' tests as SYSTEM in a session with no desktop.
- **Graceful stop.** Stop, Quit and `--stop` write `stop.request` in the runner's folder (`src/agent/stop-file.ts`), wait up to 25 seconds for the runner to report its running test as stopped and exit, and only then end it and everything it started (the job object). A leftover request is deleted at the next start. The agent watches the file and handles it like a stop signal (`src/agent/index.ts`, tested in `tests/runner-protocol2.test.ts`).
- **Test tools** install with `npm ci --ignore-scripts` from the download's `package-lock.json` (exact versions and checksums, no package install scripts; Playwright needs none). An older download without a lock file uses `npm install` as before.
- **Uninstall** first runs `node runner.mjs --forget-credential` so the runner deletes its saved credential, then deletes any `runner.enroll` / `runner.token` and the folders it created.
- **Code signing.** The deploy workflow signs `AITestingRunnerSetup.exe` with Authenticode (`signtool`, secrets `WIN_CERT_PFX` as base64 and `WIN_CERT_PASSWORD`) when the secrets exist, and says in the log when they do not. No certificate exists yet, so Windows still shows "unknown publisher".
- **Not run here.** None of the round 39 C# changes were compiled or run on this machine (no C# compiler on Linux): `tests/runner-stop-file-unit.test.ts` reads the sources, and `tests/installer-win.test.ts` plus `.github/workflows/runner-matrix.yml` (Windows Server 2022 and 2025) run them. GitHub's machines are not Windows 10 or 11 desktops: a pass on a real Windows 11 PC is still needed.
