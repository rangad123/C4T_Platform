# The macOS installer: "AI Testing Runner.app"

## What it does for you

The runner kit (see `runner-kit.md`) asks a Mac user to open Terminal and type `sh start-runner.sh`. The app replaces that with a double-click. It lives **inside the unzipped kit folder**, beside `runner.mjs`, `runner.json` and `runner.token`, and it:

1. **Checks what the Mac already has and skips it.** Each step prints one line: `[1/5] Node.js 24 or newer ... found (v26.1.0 at /opt/homebrew/bin), skipped`, `... downloading 38 MB`, `... done`, or `... failed: <plain reason>`.
2. **Downloads only what is missing**, per user, with no administrator rights and no `sudo`:
   - **Node.js 24 or newer.** It looks the way `start-runner.sh` does (PATH, Homebrew in `/opt/homebrew` and `/usr/local`, nvm, fnm, Volta, asdf, mise, nodenv, n, then the person's login shell, limited to 8 seconds). The first one that is 24 or newer is used and the step reads "found, skipped". Otherwise it downloads the official `node-v24.x-darwin-<arm64|x64>.tar.gz` from `https://nodejs.org/dist/`, takes the version from `index.json` (the newest long-term-support release of major 24 or newer; a pinned fallback, 24.11.0, if the list cannot be read), **verifies the SHA-256 against `SHASUMS256.txt`** (`shasum -a 256`), refuses and deletes the file on a mismatch, and unpacks it into its own folder. Apple silicon gets `arm64`, Intel gets `x64`, and an Intel shell running under Rosetta on an Apple silicon Mac gets the native `arm64` build.
   - **The runner files**, copied from the kit folder into the install folder (only the files whose content differs; the `work/` folder is kept; `runner.token` is mode 0600).
   - **The test tools**, with `npm install --no-audit --no-fund` using the chosen Node.js's own npm. Skipped when every package in `package.json` is already installed at the pinned version.
   - **No browser** (changed in round 17): step 4 only says the runner chooses one when it starts (Google Chrome or Microsoft Edge from this Mac, or Chromium downloaded once; `runner-browsers.md`).
   - **From a complete download** (round 17, `runner-complete-kit.md`): `node/bin/node` beside the app is used first and copied into the install folder's `node/`, and the complete `node_modules` is copied into `runner/` ("came with this download, copied (no download)"). A `node` there that does not start is passed over for one found on the Mac.
   - It clears `com.apple.quarantine` from the install folder after copying (silently), and makes a quick `curl` to the platform address in `runner.json` (`https` only, or `http` on a private network) with a plain message on failure.
3. **Asks before it downloads** (a native dialog through `osascript`): "This will set up the AI Testing runner on this Mac. It only downloads what is missing: Node.js, the test tools. Nothing is installed system-wide." The list names only what is actually missing ("It needs nothing from the internet." for a complete download). Cancel changes nothing.
4. **Starts the runner** in the Terminal window the app opens (default), or, if you answer Yes once to "Start the runner automatically when you sign in?", **in the background at login** through a LaunchAgent. A notification says "Connected to <platform> as <name>".

Everything lives in `~/Library/Application Support/AITestingRunner/`: `runner/` (the kit files and `node_modules`), `node/` (the private Node.js, only if one was downloaded), `logs/`, `runner.pid`, `runner-setup.sh` (a copy of the script, so the login start keeps working if the app is moved or deleted), and a marker file saying the installer created the folder.

## Opening the app a second time

- If the runner it started is **already running** (the pid file names a live process whose command line is this installer's), the app only shows the status and the end of the log. It never starts a second runner and never stops the first. A dialog offers "Leave it running" or "Uninstall".
- A pid file that points at something else (an old number, a program that has taken the number since) is ignored and deleted. **Nothing is ever stopped on the strength of a number alone.**
- If the kit is not beside the app (the app was moved to Applications, or macOS runs it from a temporary place, see Gatekeeper below) it uses the files from the earlier install, or asks you to choose the unzipped kit folder.

## Uninstalling

`--uninstall` (or the "Uninstall" choice above): stops only the runner process this installer recorded, takes the LaunchAgent out (`launchctl bootout`, falling back to `unload`) and deletes its plist, then asks before removing the install folder. It removes the folder **only if the installer created it** (the marker file), never a Node.js that was found elsewhere, and never the shared Playwright browser cache (it says where the cache is).

## Switches (arguments to `runner-setup.sh`)

Run as `sh "AI Testing Runner.app/Contents/Resources/runner-setup.sh" <switches>`.

| Switch | Meaning |
|---|---|
| `--check` | Say what would be downloaded and change nothing (no dialogs, no files). Exit 0: nothing to download. 10: something would be downloaded. 1: error. |
| `--silent` | No dialogs and no questions. Steps still print. |
| `--no-start` | Set up, do not start the runner. |
| `--autostart` / `--no-autostart` | Install the LaunchAgent without asking / never ask. |
| `--install-dir DIR` | Install somewhere else. A folder that already holds files the installer did not create is refused. |
| `--kit-dir DIR` | The unzipped kit, when the app is not inside it. |
| `--log FILE` | Also write what is printed to FILE (default: `logs/setup.log` in the install folder). |
| `--uninstall` | See above. |

`--run-loop` is internal: it is what the LaunchAgent runs (the runner in a loop, restarted after a crash). After a "fatal" exit (settings unreadable, token revoked, version mismatch, refused) it waits an hour before trying again, so a revoked token does not hammer the platform.

### Test-only environment variables

These exist so the tests can run without a Mac and without the internet. **They are not settings.** `AITP_NODE_DIST_URL` replaces nodejs.org, but the checksum comes from the same server, so it gives no integrity.

`AITP_NODE_DIST_URL`, `AITP_INSTALLER_SKIP_NPM=1`, `AITP_INSTALLER_SKIP_BROWSER=1`, `AITP_INSTALLER_NODE_SEARCH_ONLY=<dir:dir>` (look only there; empty means nowhere), `AITP_INSTALLER_NO_UI=1`, `AITP_INSTALLER_UNAME_S` / `AITP_INSTALLER_UNAME_M` (pretend to be Darwin and arm64 or x86_64), `AITP_INSTALLER_PROC_TRANSLATED=1` (pretend to run under Rosetta), `AITP_INSTALLER_WAIT_SECONDS`, `AITP_INSTALLER_NO_PAUSE=1`, `AITP_INSTALLER_NO_TERMINAL=1` (the launcher runs the setup in its own shell instead of opening Terminal), and `AITP_KIT_SKIP_SHELL_SEARCH=1` (same switch as `start-runner.sh`).

## How it is built

Sources are under `installer/mac/app/Contents/` (a `.gitattributes` there forces LF). `node scripts/build-installer-mac.mjs [--out DIR] [--dmg]` writes the tree as plain files, so it can be produced on any system:

```
dist/installer/mac/AI Testing Runner.app/Contents/Info.plist
                                          /MacOS/AITestingRunner          (sh launcher, 0755)
                                          /Resources/runner-setup.sh      (the logic, 0755)
                                          /Resources/README.txt
dist/installer/mac/manifest-part.json
```

`manifest-part.json` is `{ "version": 1, "entries": [ { "path": "AI Testing Runner.app/Contents/MacOS/AITestingRunner", "mode": 493, "sha256": "..." }, ... ] }`: paths relative to `dist/installer/mac/`, modes as decimal Unix modes (493 is 0755, 420 is 0644). The platform adds these entries to the kit zip it serves, with those modes. Info.plist: bundle id `app.aitesting.runner`, name "AI Testing Runner", `LSMinimumSystemVersion` 11.0, `LSUIElement` false, executable `AITestingRunner`; the version is the platform's `package.json` version.

The launcher has no window. Started from Finder it writes a small `.command` file in the temporary folder (every argument quoted for any characters) and runs `open -a Terminal` on it, so the long log is visible; started from a terminal it runs the setup directly.

### The .dmg

`node scripts/build-installer-mac.mjs --dmg` calls `scripts/make-dmg.sh`, which runs `hdiutil create -volname "AI Testing Runner" -srcfolder ... -ov -format UDZO`. **It only runs on macOS** and on any other system the build says so and does nothing. **It was never run or tested** (there was no Mac). The image holds the app only; an app opened from it asks you to choose the unzipped kit folder, because the runner files and token belong to a kit downloaded from the platform. The default thing the platform serves is the zipped `.app` folder structure, not a `.dmg`.

## First launch: Gatekeeper (what you will see)

The app is **unsigned and not notarized**. The first time, macOS says "Apple could not verify “AI Testing Runner” is free of malware" with only **Done** and **Move to Bin** (macOS 15 and newer) or "cannot be opened because it is from an unidentified developer" (older). **Choose Done, never Move to Bin.** The supported ways:

- **macOS 15 (Sequoia) and newer:** open **System Settings → Privacy & Security**, scroll to **Security**, choose **Open Anyway** next to "AI Testing Runner" (it appears only after the first blocked attempt), sign in, then open the app again. Right-click → Open no longer offers an override on these versions.
- **macOS 14 and older:** right-click the app, choose **Open**, then **Open** again; or
- in Terminal: `xattr -dr com.apple.quarantine "<unzipped folder>"` and open the app again. Running that on the **whole folder** also avoids a second problem: for a quarantined app macOS may run it from a randomized read-only copy ("App Translocation"), where the kit files that sit beside it cannot be seen. The app detects that, says what to do, and offers to let you choose the folder.
- Or skip the app: `sh start-runner.sh` in the kit folder works as before.

### Signing and notarizing (the owner's step, untested)

This needs a paid Apple Developer account and a "Developer ID Application" certificate in the keychain. These commands were **never run** here; they are the standard sequence:

```
codesign --force --options runtime --timestamp --sign "Developer ID Application: <Name> (<TEAMID>)" "AI Testing Runner.app"
codesign --verify --deep --strict --verbose=2 "AI Testing Runner.app"
ditto -c -k --keepParent "AI Testing Runner.app" AITestingRunner-notarize.zip
xcrun notarytool submit AITestingRunner-notarize.zip --apple-id <id> --team-id <TEAMID> --password <app-specific-password> --wait
xcrun stapler staple "AI Testing Runner.app"
spctl --assess --type execute --verbose "AI Testing Runner.app"
```

The kit-specific files (`runner.json`, `runner.token`) sit **outside** the bundle, so they do not break its signature. A signed app would let the platform serve the same bytes in every kit, but the platform currently builds its zip from the unsigned tree: serving a signed bundle means adding the signed files to the platform's resources.

## What is tested, and what is not

Tests (`tests/installer-mac-unit.test.ts` in the fast tier, `tests/installer-mac.test.ts` against a real platform) run `runner-setup.sh` and the launcher under Git Bash on Windows against simulated Macs: the system and processor are announced by environment variables, `launchctl`, `osascript`, `open`, `xattr` and `shasum` are stubs on the PATH that record their arguments, and nodejs.org is a local HTTP server serving a real `.tar.gz` that holds a `node` shim (which runs the computer's real Node.js, so the runner really starts). They cover: the build output, shell syntax under bash, POSIX-mode bash and dash, a scan for bashisms and GNU-only options, found-and-skipped versus download, the checksum check (wrong checksum refused and deleted, truncated download), architecture selection (Apple silicon, Intel, Rosetta, Linux refused), npm and browser skipping and installing, file copying, the pid file (a live pid of another program is never killed), uninstall (sentinel files outside survive), folders with spaces and brackets, LaunchAgent plist generation (well-formed for paths with `&`, `<`, quotes), the dialog texts and answers, the launcher's `.command` quoting, and, against a real platform, a runner that downloads its Node.js, connects, runs a real API test and returns the verdict, then ends plainly when its token is revoked.

**Never run on a Mac** (so unverified): Terminal opening the `.command` file, the real `osascript` dialogs and notifications, `launchctl` actually loading the agent and starting the runner at login, Gatekeeper and App Translocation, Rosetta detection with `sysctl sysctl.proc_translated`, the real nodejs.org download (the index parsing follows the published format, the fallback version 24.11.0 is from memory), BSD `tar`, `ps`, `sed` and `mktemp` behaviour beyond what the portability scan checks, `hdiutil`, signing and notarization, and macOS 11 to 13 versus newer behaviour of `launchctl`.

## Limits

- It installs for the current user only; there is no system-wide or multi-user install.
- It does not install Xcode, Android tools or anything iOS or Android tests need (see `ios-tests.md`).
- The private Node.js is not updated by later runs: a newer one is only fetched after `--uninstall`.
- The Terminal window must stay open when the runner runs in it; use the sign-in start for a runner that survives closing windows.

## Round 39: one-time codes, background by default, logs, stop for good, the .pkg

- **Enrollment.** A download holds `runner.enroll` (a one-time code). Setup copies it once (mode 0600), keeps only its sha256 in `enroll-copied` so a used code is never copied again, and removes an older `runner.token` it replaces. The loop starts the runner with `--enroll-file runner.enroll` while the file is there, then with no credential argument (the runner keeps its credential in the login Keychain); an older install with `runner.token` starts with `--token-file`.
- **Background by default.** The LaunchAgent is the default answer: the dialog preselects Yes, and `--silent` / `--yes` set it up without asking (`--no-autostart` runs in the Terminal window instead). A LaunchAgent set up earlier is written again in the new form. It runs while the person is signed in; there is no LaunchDaemon on purpose (it would run customers' tests as root, with no access to the person's screen).
- **KeepAlive** is now `{ SuccessfulExit: false }`: launchd restarts the loop only after a failure. When the runner's access is removed (exit code 3) the loop writes one line and ends without an error, so it stays stopped until the next sign-in instead of retrying every hour. Codes 2, 4 and 5 still wait an hour between tries.
- **Logs.** `runner.log` and `launchd.log` are checked once a minute while the runner runs and rotated at 5 MB (copied to `.1`, `.2`, `.3`, then emptied in place, because both are still being appended to). A few lines written in the moment of the copy can be lost.
- **Test tools** install with `npm ci --ignore-scripts` from the download's `package-lock.json`; an older download without one uses `npm install`.
- **Uninstall** runs `runner.mjs --forget-credential` with the recorded Node.js (the runner deletes its Keychain entry), then removes `runner.enroll`, `runner.token` and `enroll-copied` even when the folder is kept.
- **The .pkg.** `sh scripts/build-runner-pkg.sh [--app PATH] [--out DIR] [--sign-app IDENTITY]` (macOS only, `pkgbuild` and `productbuild`) packages the app for `/Applications`, or `~/Applications` when the person chooses "Install for me only". It holds the app only and runs no install script. `sh scripts/make-dmg.sh --out DIR` puts the app and the package in a disk image. The deploy workflow builds both on `macos-14`; with the Apple secrets (`APPLE_CERT_P12`, `APPLE_CERT_PASSWORD`, `APPLE_DEVELOPER_ID_APPLICATION`, `APPLE_DEVELOPER_ID_INSTALLER`, `APPLE_TEAM_ID`, `APPLE_ID`, `APPLE_APP_PASSWORD`) it signs the app (`codesign`), signs the package (`productsign`), notarises (`notarytool`) and staples it; without them it says so and builds them unsigned. The platform keeps serving the zip until a pass on a real Mac is green.
- **Not run on a Mac.** Everything above ran only under bash and dash on Linux with stubs (`tests/installer-mac-unit.test.ts`). The real `launchctl`, Keychain, `pkgbuild`, signing and notarisation run in `.github/workflows/runner-matrix.yml` (macOS 14 Apple silicon, macOS 15 Intel) and in the deploy workflow; a manual pass on a real Mac is still needed.

## Round 50: the download is the app alone

After unzipping, people saw many files. Now the Mac download (`ai-testing-runner-mac.zip`) holds exactly one item: `AI Testing Runner.app`. The person opens the download (Safari unzips it by itself), then opens AI Testing Runner.

- **The kit is inside the app.** The server puts this download's files in `AI Testing Runner.app/Contents/Resources/kit/` when it builds the zip: `runner.mjs`, `task-child.mjs`, `record-child.mjs`, `package.json`, `package-lock.json` (plain download), `LICENSES.txt`, `runner.json`, `runner.enroll` (0600), and for a complete download `node/`, `node_modules/` and `complete-kit.json`. Everything else in the app is the same bytes for everyone. No README, start scripts or check files beside it: the app runs the check itself when it finishes. Modes come from the zip's Unix attributes (the launcher, `runner-setup.sh` and `node/bin/node` 0755), as before.
- **Where the app looks.** `find_kit` tries `--kit-dir`, then `AITP_KIT_DIR`, then **the kit in its own bundle**, then the folder beside the app (a download from before round 50, or a signed app), then the earlier install. App Translocation copies the whole bundle, so the kit travels with it and is no longer lost.
- **A new download replaces a running runner.** If the runner this app recorded (`runner.pid`, command line checked) is running and the kit holds a one-time code that was never copied (its hash differs from `enroll-copied`), the app stops it the way `--uninstall` does (`stop_recorded_runner`) and sets up and starts the new one. Copying a new code first asks the runner to forget its saved access (`runner.mjs --forget-credential`, the Keychain entry), because the runner prefers a saved credential to a code; this applies to every new code, also without a running runner. The same download opened again still only shows the status.
- **Signed apps.** No Apple signing is set up. A file added inside a signed bundle breaks its signature, so when the built app has `Contents/_CodeSignature/` the server sends today's zip (one folder, the app beside the kit, README and check files) and logs "the Mac app is signed: sending the zip with the kit beside it". `shortcut:` in `routes/runner-kits.ts`: when signing starts, a browser-approved connect code makes every download the same file.
- **Proven where.** Here (Linux): the zip's single top item, the kit's place and the modes from the central directory, the signed case, the single-use code (`tests/runner-installer-kit.test.ts`, `tests/runner-complete-kit-unit.test.ts`), and `runner-setup.sh` finding the kit in the bundle and replacing a running runner under bash and dash with stubs (`tests/installer-mac-unit.test.ts`). Only on a real Mac (`.github/workflows/runner-matrix.yml`, macOS legs): `ditto` unpacking the download, the app started with nothing beside it, and a second download replacing the running runner. Not run anywhere yet: Safari's own unzip, Archive Utility, real App Translocation.
