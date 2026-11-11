# The complete runner download: nothing else to install

## What it does for you

A runner used to need Node.js 24 or newer on the computer, and its first start ran `npm install` and downloaded a browser. The **complete download** is one zip per system and processor that already holds its own Node.js and every test tool at the exact versions this platform uses. You unzip it and start it; the first start downloads nothing. The tester's own Node.js, npm and libraries do not matter.

The only thing that may still be downloaded is a browser for web tests, and only when the computer has no usable Google Chrome or Microsoft Edge: the runner program decides that itself when it starts (see `runner-browsers.md`). No start script and no installer downloads a browser any more, for any kind of download.

Since round 45 it is not a separate choice. Each person downloads one runner from **Settings, Your runner** (`runner-enrollment.md`), for their system and processor (the page guesses both from the browser: Chromium-based browsers are asked `navigator.userAgentData.getHighEntropyValues(["architecture", "bitness"])`, otherwise the user agent decides; a Mac without that answer is guessed to have an Apple chip). When the server has built the complete download for that target, the one download is built this way: on Windows and a Mac with the installer inside (it leads the README; the start scripts stay as the way without installing), on Linux with the start scripts. A target that was not built, or whose build is stale or damaged, gets the same download without its own Node.js.

## The six downloads

| Target | For | Node.js inside |
|---|---|---|
| `win-x64` | Windows on an Intel or AMD processor | `node/node.exe` |
| `win-arm64` | Windows on an ARM processor | `node/node.exe` |
| `mac-arm64` | a Mac with an Apple chip | `node/bin/node` |
| `mac-x64` | a Mac with an Intel processor | `node/bin/node` |
| `linux-x64` | Linux on an Intel or AMD processor | `node/bin/node` |
| `linux-arm64` | Linux on an ARM processor | `node/bin/node` |

## What is inside

Everything is in one folder, `runner-<project>-<target>`:

| Path | What |
|---|---|
| `node/` | The official Node.js (one pinned version, `NODE_VERSION` in `scripts/build-runner-complete.mjs`, today 24.19.0) and its `LICENSE`. Only the program: npm, npx and the headers are left out, because nothing needs to be installed. |
| `node_modules/` | The kit's pinned packages (`@playwright/test`, `playwright`, `playwright-core`, `typescript`, `@axe-core/playwright`, and the optional `@taqwright/taqwright` for phone tests) with everything they depend on, about 165 packages and 4,400 files. `node_modules/.aitp-complete` marks it complete. |
| `complete-kit.json` | Which target, which Node.js version, the package versions, what was left out and why. |
| `runner.mjs`, `task-child.mjs`, `record-child.mjs`, `package.json`, `LICENSES.txt` | The same prebuilt runner as the plain kit. |
| `runner.json`, `runner.enroll` | The address (no name: the runner uses the computer's name), and the person's one-time code made for this download (the only copy; mode 0600). |
| `start-runner.cmd`, `start-runner.sh`, `start-runner.command` | The start scripts (mode 0755). |
| `AITestingRunnerSetup.exe` or `AI Testing Runner.app` | Only in the Windows and Mac downloads, and only when the server has built the installer: the double-click alternative to the start script. It copies the Node.js and the packages from the download into its own folder and downloads nothing either. |
| `README.txt` | What to do, in plain lines. |

**Sizes.** Measured on this laptop for Windows x64: Node.js 24's `node.exe` is 88.5 MB and compresses to 33.9 MB; the packages are 86.5 MB in 4,372 files and compress to 21.4 MB. So the Windows x64 download is about **56 MB** and about **175 MB unzipped**. The Mac and Linux Node.js programs are larger than the Windows one (roughly 100 to 120 MB), so those downloads are estimated at **60 to 70 MB**; their real sizes were not measured here (no real Mac or Linux archive was fetched). The panel shows the real size of each built target, read from the build.

## How the start scripts and installers use it

- `start-runner.cmd` tries `node\node.exe` first, `start-runner.sh` tries `node/bin/node` first (and puts its executable bit back if an unzip tool dropped it). If it answers with a version of 24 or newer, the script says **"Using the Node.js that came with this download, version v24.19.0."** If it does not start (the download for another processor, or a damaged file), the script says so in one line and falls back to the usual search for an installed Node.js (`runner-kit.md`).
- When `node_modules/.aitp-complete` and `node_modules/@playwright/test/package.json` are there, the script says **"The test tools came with this download. Nothing to install."** and never runs npm. A complete download whose `node_modules` is missing says "This download is incomplete" and how to fix it, instead of trying npm (the download carries no npm).
- No script runs `npx playwright install chromium` any more, for any download. The `.chromium-installed` marker is gone.
- The **Windows installer** uses `node\node.exe` from the unzipped folder first ("Node.js v24.19.0 came with this download"), copies the `node` folder into its private Node.js folder and records it as `"node": "bundled"` in `installer.json` (later starts from the installed copy use it before searching the computer), and copies `node_modules` into its `app` folder when the `.aitp-complete` marker differs (rows say "In this download, will copy", never "will download"). `--check` exits 0 for a complete download on a computer with nothing installed.
- The **Mac app** does the same: `node/bin/node` next to it is used first and copied into `~/Library/Application Support/AITestingRunner/node`, and `node_modules` is copied into `runner/` ("came with this download, copied (no download)").
- Both installers no longer download a browser: their "Browser for web tests" row only says the runner chooses one when it starts. The Windows option "Also install Firefox and WebKit" is gone (`--all-browsers` is still accepted and ignored, so old shortcuts keep working): the runner fetches Firefox and WebKit itself when a run needs them.

## Setting it up on the server

```
npm run build:runner -- --complete                         # all six targets
npm run build:runner -- --complete --targets win-x64,mac-arm64
npm run build:runner -- --complete --targets none          # just the plain bundle
```

The build needs the internet once per Node.js version. For each target it:

1. Fetches `SHASUMS256.txt` from `https://nodejs.org/dist/v<version>/` (fresh every build; a saved copy is used only when the network fails, and the build says so).
2. Takes the archive from `dist/runner-cache/node-v<version>/` when it is there and still matches its checksum, otherwise downloads it (`node-v<version>-win-<arch>.zip`, `-darwin-<arch>.tar.gz`, `-linux-<arch>.tar.gz`). **Every archive is checked against SHASUMS256.txt before it is used**; one that does not match is deleted and the build stops with a plain message. Downloads are https only.
3. Unpacks only `node` (or `node.exe`) and `LICENSE` with Node's own zlib: a small reader for the zip's central directory, and a small streaming tar reader (ustar names with their prefix, GNU long names and pax `path=` records understood; links and folders skipped). The executable bit is kept.
4. Collects the packages from this checkout's `node_modules` (which `npm ci` installed from `package-lock.json`, so the versions are exactly the platform's): every dependency, optional dependency and required peer, resolved the way Node resolves them, nested copies included. Every pinned package must be at exactly the version the kit's `package.json` names, and `playwright-core` must exist once.
5. Checks each package for what would not work on another computer: native code (`.node` files, `binding.gyp`), an `os`/`cpu` limit that excludes the target, and install scripts. A needed package with any of these stops the build with its name and the path to it. An optional dependency that does not fit the target is left out with a note, as npm would on that computer. An optional package (Taqwright) whose dependencies do not fit is left out as a whole with a note ("Web and API tests are not affected"). Two install scripts are known and allowed: `edgedriver` and `geckodriver` only fetch desktop browser drivers ahead of time, which they also do on first use, and phone tests never use them. When this was written, this checkout's real packages passed for all six targets with nothing left out (a test checks that).
6. Writes `dist/runner-complete/<target>/pack.bin` (every file already compressed, one after another) and `manifest.json` (each file's path, Unix mode, size, compressed size, CRC-32, SHA-256 and place in the pack, the SHA-256 of the whole pack, and the SHA-256 of the runner's `package.json` it was built for).

`dist/` is git-ignored, the cache included. `RUNNER_COMPLETE_DIR` points the server at a build somewhere else (built on another computer and copied over, or the tests). `AITP_NODE_DIST_URL` replaces `https://nodejs.org/dist` for the tests; plain http is accepted only for an address on the same computer. Behind a company proxy, Node's own `fetch` honours `HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` is set (Node 24); this was not tried here.

The **Docker image** builds all six at build time (`ARG RUNNER_COMPLETE_TARGETS=all`; the image grows by roughly 400 MB). `--build-arg RUNNER_COMPLETE_TARGETS=win-x64,mac-arm64` builds fewer, `none` builds none (then the complete choice is not offered). The download cache is removed from the image.

**Rebuild when the pinned packages change** (an update of Playwright, TypeScript and so on). A complete build is matched to the runner by the SHA-256 of the runner's `package.json`: after `npm run build:runner` with other package versions, the complete downloads answer "built for other test tool versions" until `--complete` is run again. A runner code change alone does not make them stale (the runner programs are added to each download from the current bundle).

## The API

- `GET /api/me/runner/download/info`: each entry of `systems` says `ownNode` (this download carries its own Node.js here) and `bytes` (the approximate size) for all six targets.
- `POST /api/me/runner/download` `{ os, arch }`: when the target is built, the zip is streamed with its exact `content-length`, `x-runner-kit-target: <target>`, `x-runner-kit-kind` (`installer` when the installer is inside, else `files`), `x-runner-enrollment-id`, `cache-control: no-store`, file name `runner-my-computer-<target>.zip`.
- A target that was not built, a damaged build (a file list that does not add up, or a pack whose checksum does not match) or one built for other package versions is never handed out: the download is made without it. `429` when 3 downloads with their own Node.js are already streaming on the server, or more than 5 downloads a minute were made by the person.
- The download is recorded in Activity (`runner-download`) and in the log with the code's record id, never the code.

**Caps.** A pack larger than 400 MB, more than 60,000 files, a single file larger than 300 MB, a manifest larger than 32 MB, or a Node.js archive larger than 200 MB is refused. The zip has no zip64 records, so it stays under 4 GB and 65,535 entries.

**Secrets.** As with the plain kit: the one-time code is only in `runner.enroll`, the zip holds nothing from the server's `.env`, database, data folder or file paths (a test scans every file of a served zip for the server's secrets, its API key, its temp and repository paths, and the code outside `runner.enroll`).

## Tests

- `tests/runner-complete-kit-unit.test.ts` (19 tests, run under the lock; port 6910 for the stand-in nodejs.org): the build against a local stand-in for nodejs.org with tiny fake Node.js archives (a .zip, and .tar.gz files with folders, an npm symbolic link, a GNU long name and a pax record), real SHA-256 checking, the cache (a second build fetches only the checksum list; a changed cached file is fetched again), a damaged archive refused and deleted, https only; the package rules on a small stand-in `node_modules` (a Mac-only optional part kept only for Macs, a needed package with an install script stops the build, an optional package with native code is left out with its note) and on this checkout's **real** `node_modules` for all six targets; the route (info per system with `ownNode` and size, the Windows, Linux and Mac zips with entries, Unix modes from the central directory, exact length, headers, README, the installer inside when the server has it, a target not built and a stale or damaged build never handed out, no secrets or paths); and the start scripts: the served zip unpacked with **Windows' own `tar.exe`**, `start-runner.cmd` run by `cmd.exe` and `start-runner.sh` run by Git Bash with **no Node.js and no npm on the PATH**: both use the Node.js inside the download, skip npm and start the runner (a stand-in `runner.mjs` that prints which Node.js runs it); a Node.js in the download that does not start falls back to an installed one; a download without its `node_modules` says it is incomplete.
- `tests/runner-complete-kit.test.ts` (2 tests, browser lock; ports 8818, 8819 and 8801): a win-x64 download built from this checkout's **real** node_modules, downloaded through the real route over HTTP, unzipped with tar.exe, and started with start-runner.cmd with no Node.js or npm on the PATH (a hard link to this laptop's node.exe standing in for the one inside): the runner connects, runs a real API test and a real web test from a validation job (both pass), and ends with the revoked message; Playwright's test runner, TypeScript, axe and Taqwright all load from the download's own node_modules.
- `tests/installer-win.test.ts`: the compiled Windows setup program on a complete download (`node\node.exe` and a marked `node_modules` next to it, no Node.js anywhere else): `--check` exits 0 and says both came with the download; Setup copies both, records `"bundled"`, makes no network request, and the next look skips both.
- `tests/installer-mac-unit.test.ts`: the Mac setup script on a complete download the same way, and a Node.js in the download that does not start is passed over for one found on the Mac.
- `tests/add-runner-ui.test.ts`: the panel with the three ways, the size, the guessed system and processor (including a Mac where the browser says "x86"), targets that were not built, what is sent, the steps for the complete download, keyboard, phone width and no accessibility violations in light and dark.

## What is not covered (honest limits)

- **No real Node.js archive was downloaded here and no real `--complete` build was run** (tests never use the internet). The parsing follows nodejs.org's published layout (`node-v<ver>-<os>-<arch>/node.exe`, `…/bin/node`, `SHASUMS256.txt`), the pinned version 24.19.0 is the one this laptop runs, and the file names were not checked against the live site. The owner's first `npm run build:runner -- --complete` is the first real run.
- The bundled Node.js was only run here as this laptop's own `node.exe` (Windows x64) standing in for the one from the download. **Never run on a real Mac, on Linux, or on an ARM machine**: Gatekeeper and the quarantine flag on the unzipped `node` program (the start script already clears the quarantine flag for its folder; Node.js's own Mac programs are signed by the Node.js project), `unzip` and Archive Utility keeping the executable bit, and the ARM downloads are unverified. The CI matrix from `real-machine-checks.md` is where they get proved.
- Windows Explorer's "Extract all" was not used (it was `tar.exe`, which uses a different unzip code). The longest path inside the download is about 110 characters, so a folder name of up to about 140 characters still stays under Windows' 260-character limit.
- Real API and web tests through the copied packages were run from a win-x64 complete download only, with this laptop's Chromium already in the Playwright cache; the runner downloading a browser on a computer without one was not exercised here (that is the runner's part, see runner-browsers.md).
- A complete download is about 56 to 70 MB per target and the image grows by about 400 MB for all six; there is no delta update: a new version is a new download.
- Not signed (no certificates exist); the same SmartScreen and Gatekeeper prompts as the other downloads apply to the start scripts and installers. The Node.js programs inside are the Node.js project's own.
