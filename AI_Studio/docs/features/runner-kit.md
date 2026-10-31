# Runner kit: a download that starts a runner without a checkout

## What it does for you

A runner is a small program that runs your tests on the computer where your application can be reached (see `runner-agent.md` and `runner-agent-setup.md`). It used to need the whole repository, `npm install` and Playwright. When the platform runs in the cloud, nobody has that folder.

The **runner kit** is a small zip that the platform builds for you:

1. In the project, open **Setup, Runners, Add a runner**. Type a name for the computer and choose Windows or Mac or Linux. The choice decides what the instructions and the README lead with and how the folder is named; the zip holds all three start files either way.
2. Download the zip and unzip it on the computer where your application can be reached.
3. Start it. Windows: double-click `start-runner.cmd`. Mac or Linux: open Terminal, type `cd ` and a space, drag the unzipped folder into the window, press Enter, then run `sh start-runner.sh`. That route avoids the permission and "unidentified developer" prompts a double-click can raise. On a Mac, double-clicking `start-runner.command` also works once you right-click the file, choose Open, then Open again.
4. Leave the window open. It says "Connected to the platform", and the runner shows as online under Setup, Runners.
5. Delete the zip. It holds a secret (see Security).

You never type the platform's address or a token. The start script looks for Node.js 24 or newer (see "How the start scripts find Node.js"), installs the test tools on the first start, and then keeps the runner running, restarting it with a short pause if it ever crashes.

> **Installer.** Setup, Runners, Add a runner now also offers an **Installer** (a real setup program for Windows, an app for a Mac) that checks what the computer already has and downloads only what is missing. It is described in `runner-installer.md`. This document is about the **plain files** kit, which stays as it is (`kind: "files"` in the API; it is the default for Mac and Linux, and the fallback when the installer was not built).

> **Complete download (round 17).** Where the server has built it, the first choice is the **complete download**: one zip per system and processor that already holds its own Node.js and every test tool, so nothing has to be installed (`runner-complete-kit.md`). The start scripts below are the same file in every download: they use the Node.js inside a complete download first and skip `npm install` when its `node_modules` is complete.
>
> **No browser download in the scripts (round 17).** The start scripts no longer run `npx playwright install chromium` (and no longer write `.chromium-installed`). The runner program itself uses Google Chrome or Microsoft Edge from the computer, or downloads a browser once, and says which (`runner-browsers.md`).

## What is inside

| File | What it is |
|---|---|
| `runner.mjs`, `task-child.mjs`, `record-child.mjs` | The runner and the two helper programs it starts (one runs a task's scripts, one hosts a recording). Prebuilt by the server: the same code the repository's agent runs, bundled into three files. |
| `LICENSES.txt` | The licence notices of the two open source packages (zod, yaml) whose code is copied into the three programs. |
| `package.json` | The tools the runner needs, pinned to the exact versions this platform uses: `@playwright/test`, `playwright`, `typescript`, `@axe-core/playwright`, and `@taqwright/taqwright` as an optional package (Android tests only; if it cannot be installed, web and API tests still work). No scripts. |
| `runner.json` | The platform's address, the name you typed, and the kit version (the platform version plus a short hash of the bundle). |
| `runner.token` | The project token (`aitg_...`) made for this download. The only copy: the platform keeps its hash. |
| `start-runner.cmd`, `start-runner.sh`, `start-runner.command` | The start scripts. All three are in every kit, whichever system you chose, so someone who picked the wrong one is not left with nothing to run. Inside the zip `.sh` and `.command` carry Unix permission 0755 (the zip says it was made on Unix, which Apple's Archive Utility and `unzip` honour) and `runner.token` is 0600. |
| `README.txt` | Five plain lines (the Mac steps in words), what to do when the script cannot find Node.js, how to stop the runner and how to revoke its token. |

Everything is inside one folder named `runner-<project>-<system>`. The runner keeps its working files in a `work` folder next to `runner.mjs`, so deleting the folder removes everything it stored.

Nothing from the platform's `.env`, database, API key, model keys or `data/` folder ever enters the zip. The bundle is built only from `src/agent`, `src/engine` and `src/agent-protocol` and the small shared code they import (esbuild follows imports and nothing else), the build refuses to finish if the output holds a path of the build computer, and a test scans every file of a real download for secrets set in the environment and for the values in the repository's `.env`.

## The start scripts

Both do the same, in the same order:

1. Find a Node.js 24 or newer (next section), say which one they use, and put its folder first on the `PATH` for the rest of the run so `npm`, `npx` and the runner all use the same Node.js. If there is none, they explain it in plain words. On Windows with `winget` they offer `winget install OpenJS.NodeJS.LTS` and **ask first**; on a Mac with Homebrew they offer `brew install node` and ask first; otherwise they print where to get it. They never install anything without asking.
2. First start only: `npm install --no-audit --no-fund`. In a complete download (its `node_modules/.aitp-complete` is there) this is skipped with "The test tools came with this download. Nothing to install."; a complete download without its `node_modules` says it is incomplete instead of trying npm. No browser is downloaded here (see above).
3. Start `node runner.mjs --token-file runner.token`. The runner finds its address and name in `runner.json`. (You can still pass any flag; a flag beats an environment variable, which beats the kit's files.)
4. If the runner crashes, wait 5 seconds and start it again. If it stops for a reason that starting again cannot fix, say so in plain words and stay open so you can read it: the token was revoked (exit code 3), the settings could not be read (2), the runner and platform are different versions (4), or the platform refused the runner (5). Exit code 75 means the runner updated itself: the script starts it again at once (and first swaps in a Node.js the update brought for a complete download); see `runner-updates.md`. Before `npm install` the scripts set `NODE_USE_SYSTEM_CA=1` and, when no proxy variable is set, pass runner.json's `"proxy"` to npm as `HTTPS_PROXY` (npm only, never printed).

`AITP_KIT_SKIP_INSTALL=1` skips step 2 (the tests use it). `AITP_KIT_NO_PAUSE=1` skips the "press a key" pause after an error. Two more variables exist for the tests only and are not meant for people: `AITP_KIT_EXTRA_NODE_DIRS` (more folders to look in for Node.js, separated by `;` on Windows and `:` elsewhere) and `AITP_KIT_SKIP_SHELL_SEARCH=1` (skip the last-resort search below, which would otherwise find the Node.js of the computer the test runs on).

## How the start scripts find Node.js

A double-clicked file does not get the `PATH` a person's own terminal has. On a Mac, Node.js installed with nvm, fnm, Volta, asdf, mise or Homebrew is found through the shell profile (`.zshrc`), which a double-click never reads; on Windows nvm-windows, Volta, fnm and per-user installs have the same problem. The old scripts only asked "is `node` on the PATH?", so a perfectly good Node.js (the report that started this was a Node 26) looked "not installed". Now every candidate is **tested** (`node --version` is run, the answer must look like `v26.1.0`), and the **first one that is 24 or newer** is used. An older one found first does not stop the search.

**Mac and Linux (`start-runner.sh`, plain POSIX `sh`, tested under a Mac-style `sh`, dash and Git Bash; no bashisms, no `timeout`, no `readlink -f`):**

1. `command -v node`, then every folder on the `PATH` in order.
2. The usual places: `/opt/homebrew/bin` and `/opt/homebrew/opt/node*/bin`, `/usr/local/bin`, `/usr/local/opt/node*/bin`, `/opt/local/bin`, `/usr/bin`, `~/.volta/bin`, `~/.asdf/shims` and `~/.asdf/installs/nodejs/*/bin`, `~/.local/share/mise/shims` and `…/mise/installs/node/*/bin`, `~/.nodenv/shims`, `~/.n/bin`, `$NVM_DIR` or `~/.nvm` `versions/node/*/bin`, fnm's `~/.local/share/fnm/node-versions/*/installation/bin` and `~/Library/Application Support/fnm/…`, and `/usr/local/n/versions/node/*/bin`.
3. nvm itself: `nvm.sh` is sourced quietly in a throwaway shell and its default Node.js is read (limit 10 seconds).
4. Last resort: the person's own login shell is asked `command -v node` (`$SHELL -ilc`), limit 8 seconds, errors discarded, and a profile that prints a banner or hangs cannot spoil it (only lines that are absolute paths are used; the probe is killed at the limit).

**Windows (`start-runner.cmd`):**

1. `where node`.
2. `%ProgramFiles%\nodejs`, `%ProgramW6432%\nodejs`, `%ProgramFiles(x86)%\nodejs`, `%LOCALAPPDATA%\Programs\nodejs`, `%NVM_SYMLINK%`, `%LOCALAPPDATA%\Volta\bin` (and `%VOLTA_HOME%\bin`), nvm-windows' `%NVM_HOME%\v*`, `%APPDATA%\nvm\v*` and `%LOCALAPPDATA%\nvm\v*`, fnm's `%APPDATA%\fnm\node-versions\*\installation` and `%LOCALAPPDATA%\fnm\…`, and `%LOCALAPPDATA%\fnm_multishells\*`. A `node.cmd` in these folders is accepted too.
3. Last resort: PowerShell reads the `PATH` Windows has **saved** (machine and user, with `%NVM_SYMLINK%`-style variables expanded from the saved values), which also covers a window that was opened before Node.js was installed.

Paths are always quoted and never inside a `( )` block, so `C:\Users\Maya Singh\Downloads\runner (1)\` and `Program Files (x86)` work; a path with `&` or `!` is printed through delayed expansion so it is never read as a command; a "version" is only believed if it matches `v<number>.<number>.<number>`.

**What it says** (three different sentences, never "not installed" when a Node.js was found):

- Found and fine: `Using Node.js v26.1.0 from /Users/maya/.nvm/versions/node/v26.1.0/bin/node.`
- Found but too old: `Found Node.js v20.11.0 at <path>. That is too old, the runner needs 24 or newer.` (one line for each older one found, up to three on Windows), then how to update (nodejs.org LTS, `brew upgrade node`, `nvm install 24`), and the winget or Homebrew offer.
- Not found: `Node.js was not found on this computer. The runner needs Node.js 24 or newer.` and one line saying where it looked, then how to install.

**macOS specifics.** The script clears the quarantine flag from its own folder (`xattr -dr com.apple.quarantine .`, silent, failure ignored) so files macOS marked as downloaded do not block the installed packages, a complete download's own `node` program or a browser the runner downloads later. `start-runner.command` only hands over to `start-runner.sh` (`exec sh …`); it does not go through the login shell, which would break for fish. Apple Silicon and Intel use the same standard `npm install`; nothing is hard-coded to an architecture. Folder names with spaces work (every path is quoted).

**Node.js 26 and newer.** The version test is "major number 24 or more", so Node 26 passes; the pinned packages in the kit allow it (`@playwright/test`, `playwright` and `playwright-core` 1.63.0 require Node 20 or newer, `typescript` 14.17 or newer, `@axe-core/playwright` has no engine limit, the optional `@taqwright/taqwright` 1.1.0 requires 24 or newer), and the bundled runner uses none of the APIs that were removed in Node 25 (checked by searching the bundle). It has been run here on Node 24 only: no Node 25 or 26 was available to try (see Limits).

## Setting it up on the server

- **Build the runner once:** `npm run build:runner`. It writes `dist/runner/` (git-ignored) with the three programs, the kit's `package.json` and a `manifest.json` with a checksum of every file. `npm start` does not build it. The Docker image runs it at build time. Build it again after updating the platform so runners and platform stay on the same version.
- **Without a build** the download answers `503`: "The runner kit has not been built on this server. Run `npm run build:runner`." and the info answer says `available: false` with that reason. A build whose files do not match the manifest is refused the same way ("damaged").
- **Set `PUBLIC_URL`** to the https address people use. A runner refuses plain `http://` unless the platform is on its own computer or a private network (127.x, 10.x, 172.16-31.x, 192.168.x). Without `PUBLIC_URL` the platform uses the address from the page request (the `Host` header; the server has no trust-proxy setting, so `x-forwarded-*` headers are never read) and says so in a warning. Behind a tunnel or reverse proxy that address is usually wrong, so set `PUBLIC_URL`.
- `RUNNER_KIT_DIR` points the server at a build somewhere else (the tests do).

## The API

Both routes need the API key like every other route.

| Route | Answer |
|---|---|
| `GET /api/projects/:id/runner-kits/info` | `{ available, reason?, kitVersion?, platformUrl, urlOk, urlWarning?, nodeMin: 24 }` |
| `POST /api/projects/:id/runner-kits` with `{ name, platform: "windows" \| "unix", kind?: "installer" \| "files" }` (without `kind`, Windows gets the installer and Mac or Linux the plain files; see `runner-installer.md`) | The zip (`application/zip`, `content-disposition: attachment; filename="runner-<project>-<system>.zip"`, header `x-runner-token-id`, `cache-control: no-store`). `platform` only decides the folder and file name and which instructions the README leads with; every kit holds all three start scripts. |

The name is 1 to 60 characters, printable, without `/ \ : * ? " < > |`. Errors: `400` bad name or system, `404` no such project, `409` the project already has the maximum number of working tokens (25; `AGENT_MAX_TOKENS` changes it) or the address cannot be worked out, `429` more than 5 downloads a minute for a project (`RUNNER_KIT_RATE_PER_MINUTE`), `503` kit not built.

The token made by a download is an ordinary project token: it appears in `GET /api/projects/:id/agent-tokens` under the runner's name and is revoked there like any other. The existing token routes are unchanged (they have no limit of their own). The download is recorded in the project's audit rows (`runner-kit-downloaded`, with the runner's name and the last four characters of the token) and as a log line with the token's id; the token itself is never logged. The platform has no general audit log; it uses the per-project audit table that hand-written tests and reusable steps already write to.

A runner started from a kit reports its kit version (an additive optional field `kitVersion` in the capabilities it sends; the protocol version stays 1). `GET /api/projects/:id/agents` returns it as `capabilities.kitVersion`. The platform never decides anything by it.

## Security

- **The zip is a secret.** `runner.token` lets anyone who has it connect a runner to that project and receive its test runs, including the test accounts' credentials the runs carry. The file is marked owner-only in the zip. The README and the platform page say to delete the zip once the runner is online. If a zip leaks, revoke the token under Setup, Runners: the runner stops with a message.
- The platform stores only the token's hash. The zip is built per download, sent with `cache-control: no-store`, and the token is never logged.
- The scripts contain no name, address or token: the runner reads `runner.json` and `runner.token`, so a runner name with quotes, `%` or `&` cannot reach a shell. The name is only ever text in `runner.json` and the README.
- The kit does not make the runner any more powerful than a checkout-based one: hand-written code tests and Windows desktop apps stay off unless the person starts the runner with `--allow-custom-scripts` or `--allow-app` (edit the start script's line for that).
- The zip is not signed. Windows SmartScreen or macOS Gatekeeper may ask for a confirmation the first time (the README says what to choose).

## Limits

- The plain files need Node.js 24 or newer on the runner computer (the complete download brings its own).
- The plain files' first start downloads the test tools from the npm registry; a computer with no internet access cannot start from them alone (use the complete download, or the checkout route). A browser is downloaded by the runner only when the computer has no usable Chrome or Edge.
- Phones need the Android tools on that computer, iOS tests need a Mac with Xcode and the Appium driver; the kit does not install them.
- Linux may need system libraries for a browser the runner downloads (`npx playwright install-deps chromium`, needs administrator rights); the runner says so when the browser cannot start.
- It is a zip with a script, not a signed installer, and it does not install a service: the runner runs while the window is open.
- Tested here: the bundle built and checked, the zip (including the Unix permission bits read from its central directory), the routes, and a real run (connect, a web test and an API test, revoke) from the unzipped runner, from `start-runner.cmd` on Windows and from `start-runner.sh` under Git Bash. Finding Node.js is tested with fake installs laid out the way nvm, Volta, Homebrew, fnm and nvm-windows lay theirs out (a shim for Unix, a hard link to this computer's `node.exe` for Windows), with the real Node.js hidden: the "Using Node.js" line, an old one skipped, the too-old message, the not-found message, folders with spaces and brackets, and a login shell that prints noise or never answers (`tests/runner-kit-node-unit.test.ts`, `tests/runner-kit-node.test.ts`). Not tested: a real Mac (macOS `/bin/sh`, Apple Silicon, Gatekeeper, the quarantine flag, `xattr`, Terminal.app), real nvm, fnm, Volta, asdf or mise installs, a real Node.js 25 or 26 (only 24 was available), a fresh computer, `winget`/`brew` installation, the npm registry install and browser download, Linux, `start-runner.command`.
