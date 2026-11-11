# Real-machine checks: the runner download on Windows, macOS and Linux

This page is for the people who develop and host the platform. Nothing here changes what a tester sees.

"The runner works on every computer" can only be shown on real computers. Two pieces do that:

- **`scripts/smoke-runner.mjs`**: one script that does what a tester does, on the computer it runs on, and checks every step.
- **`.github/workflows/runner-matrix.yml`**: GitHub runs that script on six kinds of machine (Windows, macOS and Linux, each on Intel/AMD and on ARM), and opens the platform's own pages in every browser.

## The smoke script

```
node scripts/smoke-runner.mjs [--kit files|installer|complete] [--port 6950] [--no-node-on-path] [--out <dir>]
```

What it does, in order (each step is a line in the report):

1. Starts the sample app (`examples/sample-app`, on the port after `--port`) and the platform (`src/main.ts`, `EXECUTION_MODE=runners`) on a **new temporary data folder** with a **new random access key**. The platform gets only the computer's basic environment (PATH, HOME, temp folders, proxy settings) and its own settings, so a developer's `DATA_DIR`, model keys or mail settings never reach it, and the repository's `.env` is not read. No AI model is configured. It then signs up the first person (an owner) with the access key, as the setup page does, and makes that person's own API token from the session: everything after this is that person.
2. Creates a project and imports two tests through the API, **without AI**: the sample app's home page in a browser ("Welcome to DemoShop" is visible) and its product list over HTTP (`GET /api/products` answers 200).
3. Downloads the person's runner the way Settings, Your runner does (`POST /api/me/runner/download` with this computer's system and processor; round 45: one download per system, see `runner-enrollment.md`). `--kit` says how it is started:
   - `installer`: with the Windows setup program or the Mac app. On Linux there is none, and a platform that sends plain files instead (installer not built here) gives a plain **skip**.
   - `files`: with its start script. On Windows and a Mac the download is the installer, which holds the start scripts only when it carries its own Node.js; otherwise a plain **skip**.
   - `complete`: with its start script and the Node.js inside the download (`x-runner-kit-target`; see `runner-complete-kit.md`). When the platform has not built it for this computer, a plain **skip**. Any refusal fails. The download is written to disk as it arrives (at most 512 MB).
4. Unpacks the zip with the computer's own tool (Windows' `tar.exe`, macOS' `ditto`, Linux' `unzip`; a built-in reader that keeps the Unix permissions when the tool is missing) into a folder whose name has a space and brackets (`smoke runner (1)`), like a second download in a Downloads folder.
5. Starts it the way the README says: `start-runner.cmd` (through `cmd.exe`), `sh start-runner.sh`, `AITestingRunnerSetup.exe --silent --install-dir <temp>` or `sh "AI Testing Runner.app/Contents/Resources/runner-setup.sh" --silent --no-autostart --install-dir <temp>`. The only switches it sets are the "no key press at the end" and "no window" ones (`AITP_KIT_NO_PAUSE`, `AITP_INSTALLER_NO_PAUSE`, `AITP_INSTALLER_NO_UI`), so the program ends by itself when the runner stops.
6. Waits for the person's runner to be **connected** (`GET /api/me/runner`), notes the name it took (the computer's), and records the start script's "Using Node.js ..." line.
7. With `--kit complete`: checks the start script said it used **the Node.js that came with the download** (its sentence, or a "Using Node.js ... from" path inside the unpacked folder). With `--no-node-on-path` the runner is started with a PATH from which every folder holding `node`, `npm` or `npx` was removed (the report lists them). This is the proof that the complete download needs nothing installed.
8. Runs both tests as the person, one after the other (no runner is chosen: each run goes to its starter's runner), and checks each **passed** and **ran on the runner** (the job's `ranOn`). When the runner reports which browser it used, the report shows it.
9. Removes the computer (`POST /api/me/runner/retire`) and checks the runner **ends** within 2 minutes with the plain "The platform no longer accepts this runner" message.
10. Checks the runner credential, the one-time code and the person's token never appeared in any output.
11. Cleans up: stops **only the programs it started**, by the handles it holds (on Windows the process tree of the child it started, `taskkill /pid <that id> /T /F`; on macOS and Linux the process group it created for that child). It never looks for programs by name or by port. Then it removes the link to `node_modules` (only the link) and deletes its temporary folder. Ctrl-C does the same.

Exit code: **0** passed or skipped (the reason is printed), **1** failed, **2** wrong arguments. The report is printed and written with the logs to `--out` (default `.scratch/smoke-runner/<kit>-<time>/`): `report.md`, `report.json`, `platform.log`, `sample-app.log`, `runner.log` (what the runner window showed). The access key and any `aitg_` token are replaced by `***` in all of them. Each program's output is kept up to its last 4 MB.

Other options: `--link-node-modules` (plain kit only: link this checkout's `node_modules` into the unpacked folder and skip the start script's `npm install`, so no internet is needed), `--build-runner` (build the runner bundle into the temporary folder instead of using `dist/runner`), `--runner-kit-dir`, `--installer-dir`, `--online-timeout <s>` (default 900, or 180 with `--link-node-modules`), `--test-timeout <s>` (default 300), `--name`, `--keep` (keep the temporary folder), `--help`.

### Run it on your computer

From a checkout with `npm ci` done:

```
npm run build:runner
node scripts/smoke-runner.mjs                                    # plain files, real npm install and browser download
node scripts/smoke-runner.mjs --kit files --link-node-modules --build-runner   # no internet needed
npm run build:installer && node scripts/smoke-runner.mjs --kit installer       # Windows (or --skip-windows on a Mac)
node scripts/smoke-runner.mjs --kit complete --no-node-on-path   # after npm run build:runner -- --complete
```

On a shared machine run it under the lock: `node scripts/with-lock.mjs browser -- node scripts/smoke-runner.mjs ...`. Ports: the platform uses `--port` and the sample app the next one (default 6950 and 6951).

## The workflow

Triggers: every push to `main`, pull requests that touch `src/agent/**`, `src/agent-protocol/**`, `installer/**`, `scripts/build-*`, `src/platform/runner-kit*`, `src/platform/runner-installer*`, the kit route, the two scripts or the workflow itself, and **Run workflow** by hand (`workflow_dispatch`). It only reads the repository (`permissions: contents: read`), uses no secrets, and a newer push cancels an older run of the same branch.

### Job `smoke` (one per machine, 60 minutes at most)

| Machine | GitHub image | Installer check |
|---|---|---|
| Windows, Intel/AMD | `windows-latest` | yes |
| Windows, ARM | `windows-11-arm` | yes (the program is built with the Windows C# compiler; if that fails the check says skipped) |
| macOS, Apple silicon | `macos-latest` | yes (the Mac app) |
| macOS, Intel | `macos-15-intel` | yes |
| Linux, Intel/AMD | `ubuntu-24.04` | no installer for Linux |
| Linux, ARM | `ubuntu-24.04-arm` | no installer for Linux |

The brief named `macos-13` for Intel Macs. GitHub retired that image in December 2025; `macos-15-intel` is its Intel successor (GitHub has said it is the last Intel image).

Each machine: checkout, Node.js 24, `npm ci`, on Linux `npx playwright install-deps chromium` (the system libraries the browser needs; a person on Linux runs the same command, the start script tells them), `npm run build:web`, `npm run build:runner`, the installer build where there is one (not fatal), the complete download for that machine (`npm run build:runner -- --complete --targets <target>`, only when the checkout's build script knows `--complete`), then three checks:

1. **Plain files**: the real first start, with the start script's own `npm install` from the npm registry and its browser step. Proves the plain kit's scripts, the pinned packages and Playwright on that system and processor.
2. **Installer** (Windows and macOS): the setup program's `--silent` install into a temporary folder, its own checks and downloads, the runner it starts.
3. **Complete download with no Node.js on the PATH**: proves the download carries its own runtime and packages.

A failed check does not stop the next one (`if: success() || failure()`). The report and logs are uploaded as the artifact **runner-smoke-&lt;target&gt;** (14 days), even after a failure.

### Job `ui-browsers` (Linux, Windows, macOS; 45 minutes at most)

Installs Playwright's Chromium, Firefox and WebKit, builds the web UI, and runs `npm run test:ui:browsers -- --report ui-report`: the platform's own pages (`tests/ui-smoke.test.ts`, `tests/ui-flows.test.ts`) in Chromium, Firefox and WebKit, and in **Google Chrome** and **Microsoft Edge** through Playwright's `channel` when they are installed (found by their files at the usual install places; one that is missing is skipped with a plain line). The summary and each browser's log are uploaded as **ui-browsers-&lt;os&gt;**. The same command works on a developer's computer.

## How to read a failed run

1. Open the run under the repository's **Actions** tab and the job that is red. The step that failed prints the short report: every step with ok, skip or FAIL, the reason, and the last lines of the runner window when the runner did not come online.
2. Download the artifact **runner-smoke-&lt;target&gt;**. `files/`, `installer/` and `complete/` each hold `report.md`, `report.json` and the logs. `runner.log` is what a tester would have seen in the runner window; `platform.log` is the platform's side.

| What the report says | Where to look |
|---|---|
| "The runner stopped before it was online" | `runner.log`: Node.js not found or too old, `npm install` failed (registry, a package with no build for this processor), the browser download failed |
| "Timed out ... waiting for the runner to be online" | `runner.log` (still installing? cannot reach the platform?) and `platform.log` |
| A test "ran on the platform" | the switch to the runner did not take; `platform.log` |
| A test ended failed | `report.json` has the test's error; `runner.log` has the browser's start-up messages (missing system libraries on Linux, an unsupported processor) |
| "did not say it used the Node.js that came with the download" | the complete download's start script found another Node.js first, or the download has no `node/` folder |
| "without the plain ... message" after revoking | the start script or installer did not recognise exit code 3 |
| skipped | the reason says what was not built or not offered; not a failure |

## What these checks do not prove

- **Never run on GitHub yet.** The workflow was written and checked by a test that reads it (`tests/runner-matrix-workflow.test.ts`), but it has not run on GitHub's machines. The first run may need small fixes (an image's tools, timings).
- **No real phones**: Android and iOS tests are not part of the smoke check.
- **No signing, SmartScreen, Gatekeeper or the quarantine flag**: the download is fetched by the script, not by a browser, so Windows' "downloaded from the internet" mark and macOS' quarantine flag are never set, and nothing is double-clicked. Explorer's "Extract All" and Finder's unzip are stood in for by `tar.exe` and `ditto`.
- **"No browser on the computer" is not covered**: GitHub's images have Chrome and Edge installed and can reach Playwright's download host.
- **"Nothing installed" is simulated**: the images have Node.js installed. `--no-node-on-path` only removes it from the PATH; the start script could still find it in the usual install folders, which is why the check also requires the start script to say it used the download's own Node.js.
- **A fresh user account, a company proxy or certificate, a slow or offline network, a disk without space**: not covered (see `company-networks.md` for proxies).
- **ARM Windows**: whether Playwright's browsers and every pinned package work there is exactly what that machine will show; nothing was tried on one here.
- Only the latest image of each system; older Windows, macOS or Linux versions are not covered.

## Cost and plans (what the owner must check)

- For a **public** repository GitHub's standard hosted machines are free, including `windows-11-arm` and `ubuntu-24.04-arm`.
- For a **private** repository the minutes count against the plan: macOS minutes count ten times and Windows minutes twice against the included minutes. The ARM images (`windows-11-arm`, `ubuntu-24.04-arm`) were offered for public repositories first; for a private repository check GitHub's current documentation, they may need a paid plan or "larger runners". A full run is 9 jobs (6 smoke, 3 browser) of roughly 10 to 40 minutes each; this estimate has not been measured on GitHub.
- If a machine is not available on the plan, remove its line from the matrix; the lint test names the six machines and must be updated with it.

## Tests

- `tests/smoke-runner-unit.test.ts` (fast tier): the arguments and their plain mistakes, the exit codes 2 and 0 of the command line, the download decisions (the complete download missing or not offered is a skip, a refusal is a failure, no installer for Linux), the start commands, the PATH without Node.js, the environments handed to the platform (no developer settings) and to the runner, the redaction of the access key and tokens, the report text, the zip's Unix permissions and both unpackers, stopping **only** the processes it started together with what they started while a process the test started survives, and a whole run against a stand-in platform that ends in the "complete download not built" skip with the sample app it started stopped and the report written without the key.
- `tests/runner-matrix-workflow.test.ts` (fast tier): the workflow parses; triggers; every job has a time limit; the six machines and targets; the build steps; the three checks with the right switches and ports (6950-6969, never 4000); the installer build not fatal; later checks run after a failure; reports uploaded always; the browser job; actions pinned to a major version; no secret, token, key or `pull_request_target`; `ci.yml`'s jobs unchanged; the Chrome and Edge lookup paths.
- The real smoke check was run on this Windows 11 laptop (x64) with the plain kit, `--link-node-modules --build-runner`, under the shared lock: passed, both tests ran on the runner, the revoked runner ended with the plain message. `--kit complete --no-node-on-path` was run here against a platform without a complete build and ended in the plain skip (exit 0) with everything stopped. `node scripts/ui-browsers.mjs --only chromium,msedge` passed here (20 tests in Playwright's Chromium and 20 in the installed Microsoft Edge). Not run: the installer check (it downloads from the npm registry), a complete download that holds a real Node.js, Firefox and WebKit through the script, and the five other machines.

## Round 39: the workflow moved into this repository

`.github/workflows/runner-matrix.yml` now lives in this repository (not the older outer one) and checks this repository's `AI_Studio/`. It runs on demand and on pushes and pull requests that touch the runner (`src/agent`, `src/agent-protocol`, `installer`, the runner and installer build scripts, the smoke script). No secret is used and nothing is deployed.

- **Machines**: `windows-2022`, `windows-2025`, `macos-15` (Apple silicon; GitHub retired `macos-14`), `macos-15-intel` (GitHub retired `macos-13`; `macos-15-intel` is the Intel image that remains) and `ubuntu-latest`. The ARM machines and the browser and downloaded-project jobs of the older workflow are not part of it.
- **Per machine**: build the web UI, the runner, the installer (Windows program or Mac app), the Mac `.pkg` and `.dmg` (unsigned, macOS only) and the complete download; then `smoke-runner.mjs --kit installer --lifecycle`: install with the real installer unattended, start, online, a web and an API test run on the runner, check that no credential or one-time code is readable as plain text anywhere in the install folder (logs and work folder included), stop it the way a person does, start it again (the one-time code is used up, so it must use its saved credential), make a credential renewal due in the check's own platform database and start it again (it renews, keeps the new credential in DPAPI or the Keychain, and the folder is checked again), start it once more (it can only come online by reading the renewed credential back, because the old one stopped working when the new one was first used), revoke it, uninstall it, and check that nothing is left (no install folder, no sign-in start). Then the plain files and the complete download (no Node.js on the PATH), and the installer tests that need that system (Windows: `installer-win-unit`, `runner-stop-file-unit`; macOS: `installer-mac-unit`, informative only).
- **Honest limits**: GitHub's Windows machines are Windows Server, not Windows 10 or 11 desktop, and nobody is signed in at a screen; the Mac runs use `--no-autostart` (the LaunchAgent path runs only in the unit test with a stand-in `launchctl`). A manual pass on a real Windows 11 PC and a real Mac is still needed. The workflow has not run on GitHub yet.
- **Main CI** (`ai-studio-ci.yml`, Ubuntu) now also runs the runner tests that need no real machine, one file at a time: `agent-platform-unit`, `runner-limit-unit`, `runner-update-unit`, `runner-installer-kit`, `record-agent-unit`, `live-session-fake-agent`, `installer-mac-unit`, `agent-program-unit`, `agent-platform`, `runner-stop-file-unit`, `smoke-runner-unit`, `runner-matrix-workflow`.
