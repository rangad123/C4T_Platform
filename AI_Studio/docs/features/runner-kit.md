# Runner kit: a download that starts a runner without a checkout

## What it does for you

A runner is a small program that runs your tests on the computer where your application can be reached (see `runner-agent.md` and `runner-agent-setup.md`). It used to need the whole repository, `npm install` and Playwright. When the platform runs in the cloud, nobody has that folder.

The **runner kit** is a small zip that the platform builds for you. Since round 45 each person has one runner, set up once in **Settings, Your runner** (`runner-enrollment.md`); this plain files zip is the Linux download, and the fallback for Windows and Mac when the server has no installer built:

1. Open **Settings, Your runner** and download the runner. The page guesses your system and processor; nothing else is chosen, and the runner is named after the computer (you can rename it there). The zip holds all three start files.
2. Download the zip and unzip it on the computer where your application can be reached.
3. Start it. Windows: double-click `start-runner.cmd`. Mac or Linux: open Terminal, type `cd ` and a space, drag the unzipped folder into the window, press Enter, then run `sh start-runner.sh`. That route avoids the permission and "unidentified developer" prompts a double-click can raise. On a Mac, double-clicking `start-runner.command` also works once you right-click the file, choose Open, then Open again.
4. Leave the window open. It says "Connected to the platform", and Settings, Your runner shows the computer as connected. Your runs, schedules and sessions then use it by themselves.
5. Delete the zip. It holds a one-time code (see Security).

You never type the platform's address or a token. The start script looks for Node.js 24 or newer (see "How the start scripts find Node.js"), installs the test tools on the first start, and then keeps the runner running, restarting it with a short pause if it ever crashes.

> **Installer.** Windows and Mac get the **installer** (a real setup program for Windows, downloaded as that one program since round 49; an app for a Mac) that checks what the computer already has and downloads only what is missing (`runner-installer.md`). This document is about the **plain files** (`x-runner-kit-kind: files`): the Linux download, and what Windows and Mac get when the installer was not built here (the answer then says so in `x-runner-kit-note`).

> **Own Node.js (complete build).** Where the server has built it for that system and processor, the Linux download (and a Mac download that fell back to the plain files; never a Windows one) also carries its own Node.js and every test tool, so nothing has to be installed (`runner-complete-kit.md`). It is not a separate choice any more. The start scripts below are the same file in every download: they use the Node.js inside a complete download first and skip `npm install` when its `node_modules` is complete.
>
> **No browser download in the scripts (round 17).** The start scripts no longer run `npx playwright install chromium` (and no longer write `.chromium-installed`). The runner program itself uses Google Chrome or Microsoft Edge from the computer, or downloads a browser once, and says which (`runner-browsers.md`).

## What is inside

| File | What it is |
|---|---|
| `runner.mjs`, `task-child.mjs`, `record-child.mjs` | The runner and the two helper programs it starts (one runs a task's scripts, one hosts a recording). Prebuilt by the server: the same code the repository's agent runs, bundled into three files. |
| `LICENSES.txt` | The licence notices of the two open source packages (zod, yaml) whose code is copied into the three programs. |
| `package.json` | The tools the runner needs, pinned to the exact versions this platform uses: `@playwright/test`, `playwright`, `typescript`, `@axe-core/playwright`, and `@taqwright/taqwright` as an optional package (Android tests only; if it cannot be installed, web and API tests still work). No scripts. |
| `runner.json` | The platform's address and the kit version (the platform version plus a short hash of the bundle). No name: the runner uses the computer's own name. |
| `runner.enroll` | Your one-time code (`aite_...`, valid 30 minutes) made for this download. The only copy: the platform keeps its hash. The runner trades it for your one runner credential at its first start and deletes the file. |
| `start-runner.cmd`, `start-runner.sh`, `start-runner.command` | The start scripts. All three are in every kit, whichever system you chose, so someone who picked the wrong one is not left with nothing to run. Inside the zip `.sh` and `.command` carry Unix permission 0755 (the zip says it was made on Unix, which Apple's Archive Utility and `unzip` honour) and `runner.enroll` is 0600. |
| `README.txt` | Five plain lines (the Mac steps in words), what to do when the script cannot find Node.js, how to stop the runner and how to remove the computer. |

Everything is inside one folder named `runner-my-computer-<system>`. The runner keeps its working files in a `work` folder next to `runner.mjs`, so deleting the folder removes everything it stored.

Nothing from the platform's `.env`, database, API key, model keys or `data/` folder ever enters the zip. The bundle is built only from `src/agent`, `src/engine` and `src/agent-protocol` and the small shared code they import (esbuild follows imports and nothing else), the build refuses to finish if the output holds a path of the build computer, and a test scans every file of a real download for secrets set in the environment and for the values in the repository's `.env`.

## The start scripts

Both do the same, in the same order:

1. Find a Node.js 24 or newer (next section), say which one they use, and put its folder first on the `PATH` for the rest of the run so `npm`, `npx` and the runner all use the same Node.js. If there is none, they explain it in plain words. On Windows with `winget` they offer `winget install OpenJS.NodeJS.LTS` and **ask first**; on a Mac with Homebrew they offer `brew install node` and ask first; otherwise they print where to get it. They never install anything without asking.
2. First start only: `npm install --no-audit --no-fund`. In a complete download (its `node_modules/.aitp-complete` is there) this is skipped with "The test tools came with this download. Nothing to install."; a complete download without its `node_modules` says it is incomplete instead of trying npm. No browser is downloaded here (see above).
3. Start `node runner.mjs --enroll-file runner.enroll` while that file is there, then `node runner.mjs` (it uses the credential it keeps; a folder from a download before round 39 still starts with `--token-file runner.token`). The runner finds its address in `runner.json`. (You can still pass any flag; a flag beats an environment variable, which beats the kit's files.)
4. If the runner crashes, wait 5 seconds and start it again. If it stops for a reason that starting again cannot fix, say so in plain words and stay open so you can read it: the computer was removed or replaced, or it was a team or project runner (exit code 3, with the platform's sentence), the settings could not be read (2), the runner and platform are different versions (4), or the platform refused the runner (5). Exit code 75 means the runner updated itself: the script starts it again at once (and first swaps in a Node.js the update brought for a complete download); see `runner-updates.md`. Before `npm install` the scripts set `NODE_USE_SYSTEM_CA=1` and, when no proxy variable is set, pass runner.json's `"proxy"` to npm as `HTTPS_PROXY` (npm only, never printed).

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

`GET /api/me/runner/download/info` and `POST /api/me/runner/download` `{ os, arch }` (routes/runner-kits.ts), described in `runner-enrollment.md`. A person who may run tests, or the open server; the shared access key gets a plain 403. The zip comes with `content-disposition: attachment; filename="runner-my-computer-<system>.zip"`, `x-runner-enrollment-id`, `x-runner-enrollment-expires`, `x-runner-kit-kind: files` and `cache-control: no-store`. Errors: `400` anything but a system and a processor, `403` the access key or a person who may run tests nowhere, `409` the address cannot be worked out, `429` more than 5 downloads a minute for one person (`RUNNER_KIT_RATE_PER_MINUTE`), `503` kit not built.

The download is recorded in Activity (`runner-download`, the system and processor) and as a log line with the code's record id; the code itself is never logged. The per-project kit routes, project runner tokens and the per-project runner limit (`AGENT_MAX_TOKENS`) were removed in round 45.

A runner started from a kit reports its kit version (an additive optional field `kitVersion` in the capabilities it sends; the protocol version stays 1). Settings shows it with the runner's update state. The platform never decides anything by it.

## Security

- **The zip holds a one-time code.** `runner.enroll` lets whoever starts it first within 30 minutes become your runner and receive your runs, including the test accounts' credentials they carry. The file is marked owner-only in the zip. The README says to delete the zip once the runner is online. If a zip leaks before you start it, download again (the new runner replaces any made with the old code) or choose Remove this computer in Settings.
- The platform stores only the code's hash. The zip is built per download, sent with `cache-control: no-store`, and the code is never logged.
- The scripts contain no name, address or code: the runner reads `runner.json` and `runner.enroll`, so nothing typed by a person can reach a shell.
- The kit does not make the runner any more powerful than a checkout-based one: hand-written code tests follow the owner's "Code scripts" switch in Settings, and Windows desktop apps stay off unless the person starts the runner with `--allow-app` (edit the start script's line for that).
- The zip is not signed. Windows SmartScreen or macOS Gatekeeper may ask for a confirmation the first time (the README says what to choose).

## Limits

- The plain files need Node.js 24 or newer on the runner computer (the complete download brings its own).
- The plain files' first start downloads the test tools from the npm registry; a computer with no internet access cannot start from them alone (use the complete download, or the checkout route). A browser is downloaded by the runner only when the computer has no usable Chrome or Edge.
- Phones need the Android tools on that computer, iOS tests need a Mac with Xcode and the Appium driver; the kit does not install them.
- Linux may need system libraries for a browser the runner downloads (`npx playwright install-deps chromium`, needs administrator rights); the runner says so when the browser cannot start.
- It is a zip with a script, not a signed installer, and it does not install a service: the runner runs while the window is open.
- Tested here: the bundle built and checked, the zip (including the Unix permission bits read from its central directory), the routes, and a real run (trade the code, show in Settings, a web test and an API test the person starts, remove the computer) from the unzipped runner, from `start-runner.cmd` on Windows and from `start-runner.sh` under Git Bash. Finding Node.js is tested with fake installs laid out the way nvm, Volta, Homebrew, fnm and nvm-windows lay theirs out (a shim for Unix, a hard link to this computer's `node.exe` for Windows), with the real Node.js hidden: the "Using Node.js" line, an old one skipped, the too-old message, the not-found message, folders with spaces and brackets, and a login shell that prints noise or never answers (`tests/runner-kit-node-unit.test.ts`, `tests/runner-kit-node.test.ts`). Not tested: a real Mac (macOS `/bin/sh`, Apple Silicon, Gatekeeper, the quarantine flag, `xattr`, Terminal.app), real nvm, fnm, Volta, asdf or mise installs, a real Node.js 25 or 26 (only 24 was available), a fresh computer, `winget`/`brew` installation, the npm registry install and browser download, Linux, `start-runner.command`.

## Round 50: Linux is one file

The Linux download is `ai-testing-runner.sh` (`src/platform/runner-linux-script.ts`), no longer a zip. The person runs `sh ai-testing-runner.sh` in a terminal.

- **Format.** A short POSIX `sh` header, then the kit as a **gzip tar**: `tail -c +N "$0" | tar xzf -`, which every Linux can do with what it has (`unzip` is often missing). The tar is written by the server without a dependency as a series of gzip members (header blocks compressed on the spot; each file's bytes are its deflate data unchanged, wrapped with the CRC-32 and size already known), so a complete download's 60 MB is never compressed again and its exact length is sent. Long names use a ustar prefix, else a pax record.
- **What the header does.** Checks it runs on Linux and was started by its file name; unpacks into a private temporary folder (`mktemp -d`, 0700, umask 077); installs into `~/.local/share/ai-testing-runner` (`$XDG_DATA_HOME/ai-testing-runner`; it refuses a folder it did not make, marked by `.created-by-ai-testing-runner`), moving only the files that changed (`work/` and the runner's saved access stay; a complete download's `node/` and `node_modules/` are replaced as a whole when their marker differs); deletes the temporary folder; records its pid in `runner.pid` and `exec`s `start-runner.sh` there (today's script, in the person's window). `AITP_RUNNER_INSTALL_DIR` installs elsewhere (tests).
- **The one-time code.** Copied into the install folder only when its hash differs from `enroll-copied` (the hash, never the code); the runner deletes it when it trades it. A new code first removes the runner's saved access (`runner.credential` in its work folder), because the runner prefers a saved credential to a code: without that the new download's code would never be traded and Settings would wait for it. The header itself is never copied anywhere, and the temporary folder is gone before the runner starts.
- **A new download replaces a running runner.** When `runner.pid` names a live process whose command line is that folder's `start-runner.sh` and the download's code is new, the header sends TERM to its `node runner.mjs` child (found through `/proc`, by parent pid and command line) and to the script, waits up to 30 seconds (KILL only after checking the command line again), then installs and starts the new one. The same file run again says the runner is already running and changes nothing.
- **Check.** `sh ~/.local/share/ai-testing-runner/check-computer.sh`.
- **Proven where.** Here: the header plus payload unpacked and run by `sh` (dash) and busybox `sh` against the real platform (`tests/runner-kit.test.ts`: connects, runs an API test, a second download replaces it, no code left behind) and the format against GNU tar (`tests/runner-complete-kit-unit.test.ts`). On GitHub's Ubuntu (`runner-matrix.yml`, Linux leg): the real download with its own Node.js, `sh ai-testing-runner.sh`, and the replacement. Not run: busybox `tar` on Alpine, other distributions.
