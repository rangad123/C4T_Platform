> Archived round history, not the current design: see `../RUNNER_ARCHITECTURE.md` (one runner per person).

# Local runner: current state audit

- **Date:** 2026-11-07.
- **Code audited:** commit `e344261` (2026-11-06). Line numbers refer to that commit. They move as this round's changes land.
- **Paths** are relative to `AI_Studio/` unless they say otherwise. Workflow files live at the root of the C4T_Platform repository, in `.github/workflows/`.
- **Scope:** everything that runs tests on a person's own computer: the agent program, the installers and downloads, the protocol, the platform's orchestration and data, the website, security, and tests and CI.

How to read the status words:

- For the state before this round: **exists**, **partial**, **missing**.
- For this round (updated after the build, 2026-11-07): **built** (in the tree with its tests, not yet released or run on a real Windows or Mac computer), or **not built**. The "**This round:**" paragraphs below say what the round set out to do; sections 9 and 10 say what was built. `PROGRESS.md` and `MANUAL_VERIFICATION.md` track tests and real machines.
- **read** means a claim comes from reading code or docs. **ran** means it was run on a Linux machine with Node 22 (AI Studio targets Node 24). No Windows or Mac machine was available. Nothing was changed while auditing.

The other documents in this folder describe the design as built: `RUNNER_ARCHITECTURE.md`, `AGENT_COMMUNICATION_PROTOCOL.md`, `JOB_EXECUTION_LIFECYCLE.md`, `SECURITY_DESIGN.md`, `IMPLEMENTATION_PLAN.md`.

---

## Summary

- AI Studio already had a runner. It is one Node and TypeScript program for Windows, macOS and Linux (`src/agent/`). It has Windows and Mac installers inside the download zip, an HTTPS long-poll protocol (version 1), revocable runner tokens, capability reports, automatic updates, browser set-up, recording and phone sessions, and Runners pages on the website.
- A runner runs tests with the same engine as the platform (`src/agent/task-child.ts:51-57`). No second engine exists.
- **In production nothing could run on a runner.** Every run start was refused, and no process would have turned a job into a runner task. See the next section.
- A Crowd4Test tester could not add a runner at all (`src/platform/runner-health.ts:42`).
- Every download carried a long-lived runner token. There was no enrollment exchange, no OS credential store and no rotation.
- Live progress was text lines only. Steps, screenshots and failures arrived with the final result.
- Updates were automatic and checked by SHA-256 values from the same server. They were not signed. Installers were not code-signed or notarised.
- The Mac installer had never run on a real Mac. The Windows installer had run on one Windows 11 x64 machine. No real-machine workflow had ever run in CI.

---

## Why nothing could run on a runner in production

Traced from the code (read), and confirmed with a scratch test that used the repository's own `src/` with production-like settings (ran, see "How the audit was done").

1. **No worker runs on the production server.** The deploy writes `WORKER_EMBEDDED=false` (`deploy/c4t-box/deploy.sh:132-136`), because customer scripts are not isolated there. The box runs one process, `src/main.ts` (`deploy/c4t-box/ecosystem.config.cjs:26-42`). It starts the Worker and the scheduler only when `WORKER_EMBEDDED` is true (`src/main.ts:44-53`). No separate worker process is deployed, so no worker heartbeat is ever written (`src/platform/ops/process.ts:38`).
2. **Block 1: every run start is refused.** `POST /api/projects/:id/runs` calls `refuseUnlessRunsStart` first (`src/platform/routes/runs.ts:36`). That calls `runsCanStartHere` (`src/platform/suite-run.ts:30-35`), which looks only at `WORKER_EMBEDDED` and the worker heartbeat. It never asks where the project's tests run. The answer is a 409, and nothing is queued. The same check guards every other way a run starts: `src/platform/server.ts:414,508,635,675`, `routes/suites.ts:198`, `routes/environments.ts:118`, `routes/variants.ts:47`, `routes/authoring.ts:66,88`, `routes/plans.ts:184`, `routes/runbooks.ts:141`, `trigger-services.ts:178`, and suite schedules through `suite-run.ts:130`.
3. **Block 2: nothing would hand the job to a runner.** Without the refusal, `createJob` only inserts a `QUEUED` row (`src/platform/repo.ts:455-482`). The runner task is made by `RemoteExecutor.execute` (`src/platform/agent-services.ts:664-757`, `store.enqueue` at `:749`). That executor runs inside a Worker's `runJob` (`src/platform/job-runner.ts:175`, wired in `bootstrap.ts:47`). With no Worker, no `agent_tasks` row is made, the runner's poll stays empty, and the job stays QUEUED for ever.
4. **The website locked every Run button.** It reads the same check as one global flag, `runsHere` (`src/platform/server.ts:285` to `web/src/features/runs/runs-here.ts:9-11`), and disables Run everywhere (`web/src/features/runs/RunMenu.tsx:79,243,386`). It also hid the "Use a runner" link (`web/src/features/agents/RunsOnLine.tsx:16-26`).
5. **Turning the worker on was not a fix.** With `WORKER_EMBEDDED=true`, `runsCanStartHere` is true for every project. A project with no setting runs "on this server" (`src/platform/agent-store.ts:488-491`), so its tests would run on the box. That is what the deploy README forbids (`deploy/c4t-box/README.md:45-57`).
6. **A runner job still used the server's browser.** Inside a job sent to a runner, the worker would launch Chromium on the server to check a saved sign-in (`src/platform/hard-signin-service.ts:203-209`) and for browser repair when the target is public (`src/engine/validation/validate-only.ts:184-185`). The test-data reset is sent from the server through the server's address guard (`src/platform/test-data-reset-run.ts:38`), so an app only the runner can reach makes the run stop. Mailbox steps cannot run on a runner (`hard-signin-service.ts:223`). None of this runs customer script code, but it opens browsers on the box.
7. **One worker runs one job at a time.** Each Worker claims one job and awaits it (`src/platform/worker.ts:56-64`). A runner job holds that slot for its whole run, including up to 30 minutes of waiting for a runner. Ten runners would still run one job at a time across the platform.
8. **Schedules looked alive but never fired.** The scheduler starts only with the embedded worker (`src/main.ts:44-53`), yet the API reported `schedulerEnabled: true` (`src/platform/routes/schedules.ts:153`). A plain schedule's **Run now** skips the refusal (`src/platform/scheduler.ts:71-86`), so it answered 202 and queued a job that nothing ran (ran). That job counts as an active run (`web/src/lib/labels.ts:60`) and locks the project's Run controls until someone stops it. Runner housekeeping (`maintain()`, task pruning) runs only on the scheduler tick (`src/platform/schedule-services.ts:61-63`), so it did not run either.
9. **Nobody on the tester side could add a runner.** `canManageRunner` returns false for a tester (`src/platform/runner-health.ts:42`). It guards project tokens (`routes/agents.ts:140`), Runners-page registration (`routes/runners.ts:88`) and kit downloads (`routes/runner-kits.ts:65`).

The result: a customer or admin could install a runner and see "Connected", save "On a runner", and still find every Run button disabled and every run refused.

**This round:** a runner-only execution mode for the hosted platform, a dispatch worker that runs several runner jobs at once and never runs test code, schedules and housekeeping in that mode, server-side browser work closed in that mode, and personal runners for anyone who may run tests. All are built in this round (decisions 1 and 2 below).

---

## How the audit was done

Read: the agent program, the protocol schema, the installers, the kit and update code, the platform's agent store, services, routes and job runner, the database migrations, the stream code, the deploy files, the web features for runners, runs, schedules and suites, the feature docs, and the CI workflows.

Ran (Linux, Node 22, no browser, `TAQWRIGHT_HOME` pointed at a missing folder so no phone was reached):

| Test file | Result |
|---|---|
| `tests/agent-program-unit.test.ts` + `tests/agent-stop-unit.test.ts` | 34 passed, 4 skipped (the agent-side cleanup suite listens on a fixed port and was skipped on purpose) |
| `tests/agent-platform-unit.test.ts` | 31/31 |
| `tests/runner-update-unit.test.ts` | 14/14 |
| `tests/runners-shared.test.ts` | 15/15 |
| `tests/runs-off-here.test.ts` | 4/4 (it never sets a project to run on a runner) |
| `tests/live-hardening.test.ts` | 12/12 |
| `tests/agent-safety-unit.test.ts` | 13/13 |
| `tests/runner-installer-kit.test.ts` | 10/10 |
| `tests/record-agent-unit.test.ts` | 34/34 |
| `tests/runner-limit-unit.test.ts` | 2/2 |
| `tests/pg-baseline-unit.test.ts` + `tests/sql-portability-unit.test.ts` | 8/8 |
| `tests/runner-matrix-workflow.test.ts` | **fails**: the workflow file it checks is not in this repository |
| `bash -n` and `dash -n` on the Mac setup script and launcher; a plist parser on `Info.plist` | all parse |
| Two scratch tests outside the repository, using `src/` with `WORKER_EMBEDDED=false` and no worker heartbeat, on temporary data folders | a project on an online runner: `PUT /runner` 200, but `POST /runs` 409 and `POST /api/tests/:id/validate` 409, `/api/config` `runsHere:false`, nothing queued. A schedule's Run now: 202 and a job that stayed QUEUED |

Not run: `tests/agent-platform.test.ts` and `tests/stream-agent.test.ts` (fixed ports), `tests/installer-mac-unit.test.ts` (fixed port), the Windows installer tests (need Windows), and every browser test. Known failures on this machine before the round: `add-runner-ui` 5 (no built kit), `runner-browsers-download` 3, `runner-kit` 2.

---

## 1. The agent program (`src/agent/`)

### Exists

- **One codebase.** `scripts/build-runner.mjs:68-76` bundles the program with esbuild (Node target 24, ESM) into `runner.mjs`, `task-child.mjs` and `record-child.mjs`. OS-specific code is only OS integration: the Windows UI Automation probe (`src/agent/capabilities.ts:269-272`), the Windows proxy read (`src/agent/net.ts`), and the process-tree kill (`src/agent/task-process.ts:17-33`). (read)
- **Complete downloads** for `win-x64`, `win-arm64`, `mac-arm64`, `mac-x64` and `linux-x64` (`.github/workflows/ai-studio-deploy.yml:73`), with Node 24.19.0 bundled (`NODE_VERSION` in `scripts/build-runner-complete.mjs`). (read)
- **Same engine as the platform.** The test child calls `getAdapter(adapterId).execute(...)` from `src/engine/frameworks` (`src/agent/task-child.ts:51-57`). Adapters: `playwright`, `playwright-api`, `taqwright` (Android), `taqwright-ios` and `windows-uia` (`src/agent/task-runner.ts:44`). Test stand-ins enter only through environment seams used by tests (`src/agent/task-process.ts:38`). (read)
- **One process per task**, killed as a tree on cancel or timeout (`task-process.ts:17-33,103-106`). A watchdog stops a task at its limit plus 90 s (`task-runner.ts:47,396-404`). The child exits when the agent's IPC channel closes (`task-child.ts:21-24`). (read)
- **Per-task workspace** `workDir/tasks/<taskId>` (`task-runner.ts:131`), removed after the task (`:210`). Leftover task folders are wiped at start (`src/agent/agent.ts:222`). A shared file cache is keyed by SHA-256, checked on use and size-capped (`src/agent/file-cache.ts`). (read; cache tests ran)
- **Run credentials** reach only the test process's environment and are never written to disk by the agent (`src/agent-protocol/schema.ts:19-21`, `src/engine/validation/runner.ts:368-380`). They are masked in logs and results (`task-runner.ts:123`, `maskRun` in `src/agent/mapping.ts`). (read)
- **Browsers.** At start the runner uses Playwright's Chromium if present, else installed Chrome, else Edge (with a minimum version), else runs `playwright install chromium` in the background. Firefox and WebKit are fetched when a run first needs them (`src/agent/browser-setup.ts:1-12,173-185`). The installers do not install browsers. (read)
- **Headless by default.** The platform decides per run (`env.headless`, `schema.ts:299`; platform default `HEADLESS=true`, `src/config.ts:140-143`). The agent passes it on as `PW_HEADLESS` (`src/engine/validation/runner.ts:374`). (read)
- **Concurrency** 1 by default, 1 to 8 (`src/agent/config.ts:237-239`). Mobile tasks run one at a time per machine (device lock, `task-runner.ts:410`). (read)
- **Graceful stop** on SIGINT and SIGTERM: running tasks are cancelled, "The agent was stopped." is posted, and the agent waits up to 20 s (`src/agent/index.ts:51-66`, `agent.ts:126-136,214`). (read)
- **Computer check.** `runner.mjs --check` and a start-up check sent with hello (`src/agent/index.ts:15-22`, `src/agent/computer-check.ts:557-569`). Free disk of at least 1 GB is checked at start (`computer-check.ts:43-44,200-204`). (read)
- **Capabilities reported** (`schema.ts:56-159`, `capabilities.ts`): OS family, architecture, Node version, Playwright browsers, Chrome and Edge with version, the chosen browser, Android (adb, devices, emulators), iOS (Xcode, simulators, XCUITest), Windows UI Automation, record, live and device sessions, `customScripts`, `kitVersion`, network, update state and the start-up check. (read)
- **Token handling.** The token is sent only in the Authorization header, and requests never follow a redirect (`src/agent/client.ts:113,125`). It is registered with the log redactor (`agent.ts:173`, `log.ts:44-49`), hidden from the process list (`src/agent/index.ts:11`), and not passed to test processes (`task-process.ts:35-43`, `src/engine/validation/runner.ts:116-125`). (read; "never prints the token" ran)

### Partial or missing

- The agent's version is a constant, `AGENT_VERSION = "1.0.0"` (`src/agent/config.ts:18`). The real build id, `kitVersion` (`scripts/build-runner.mjs:119-120`), exists only for runners started from a download.
- Capabilities lack OS version, memory, CPU count, a Playwright version field (it appears only as text, `computer-check.ts:125`), the Android SDK path and the list of adapters.
- **Code scripts** (hand-written, imported, from Git) run only when the agent was started with `--allow-custom-scripts` (`task-runner.ts:324-330`). `runner.json` cannot set it (`src/agent/kit.ts:17-25`), and both installers start the runner with only `--token-file` (`installer/win/RunnerHost.cs:115`, `installer/mac/app/Contents/Resources/runner-setup.sh:1131`). Git-imported and code-project scripts count as hand-written (`schema.ts:311-312`). So a code project could not run on any installed runner.
- No display check for headed runs. Only recording checks for a display (`capabilities.ts:155-158,280`). A headed run without a display fails in the browser instead of being refused with a sentence.
- Disk space is not checked per task. Test processes have no memory or CPU limit.
- Logs are plain text lines with time and level (`src/agent/log.ts:51-56`), not structured.
- Sleep, wake and network changes have no special handling. Recovery relies on request timeouts (a hung poll ends within about 45 s of waking) and on the server's lease. Unverified on a real laptop.
- The agent's own states (`starting`, `connected`, `reconnecting`, `stopping`, `stopped`, `agent.ts:77-78`) are not reported to the platform.
- A result is retried 6 times over about 23 s (`task-runner.ts:50,614-628`), and an upload 3 times (`:586-601`). A platform outage longer than that loses a finished result.

**This round:** identity fields (OS version, memory, CPU count, Playwright version, adapters), a real agent version where the build gives one, the code-scripts switch on the runner, durable results kept on disk, typed live events and a stop file for graceful stops are built in this round. A display check for headed runs was built too (reject reason `no-display`); the real agent version was not (`AGENT_VERSION` is still `"1.0.0"`). Per-task disk checks and resource limits are not built.

---

## 2. Installers, downloads and updates

### How a person installed a runner before this round (read; not done by hand during the audit)

Who could: a holder of `ai_studio.runners.manage` who is a customer in that organisation, or Crowd4Test staff or an admin. Never a tester (`src/platform/runner-health.ts:42`). They opened a project's "Add a runner" panel. A project could have one kit runner by default (`DEFAULT_MAX_TOKENS = 1`, `src/platform/runner-kit.ts:27`).

Windows:
1. Choose the complete download (recommended; system and processor guessed from the browser). Get `runner-<project>-win-x64.zip`.
2. Unzip it and double-click `AITestingRunnerSetup.exe`.
3. SmartScreen says "unknown publisher": More info, Run anyway.
4. A checklist runs (Node found or bundled, runner files, test tools, browser, extras, connection). Click Install and start.
5. The runner starts hidden and the tray icon turns green, "Connected".
6. Tick "Start the runner when I sign in" to survive a restart. Delete the zip and the unzipped folder, because they still hold the token.

Mac:
1. Choose `mac-arm64` or `mac-x64`, unzip, open "AI Testing Runner.app".
2. Gatekeeper blocks it. On macOS 15 and later: System Settings, Privacy & Security, Open Anyway. Earlier: right-click, Open.
3. Terminal opens and runs the setup. It copies the runner into `~/Library/Application Support/AITestingRunner`.
4. A dialog asks "Start automatically when you sign in?". Yes writes a LaunchAgent. "Not now" runs the runner in that Terminal window, and closing the window stops it.

Fallbacks: a plain-files zip with `start-runner.cmd` or `sh start-runner.sh` (needs Node 24 or later and runs `npm install`), or a repository checkout (`npm run agent`).

### Exists

- **Windows setup program** `AITestingRunnerSetup.exe` (WinForms, compiled with Windows' `csc`, `scripts/build-installer-win.mjs`), shipped inside the zip. Per user: no admin rights, no registry writes, no Add/Remove Programs entry (`docs/features/runner-installer.md:36-49`). (read)
  - Node comes from the bundle, or from nodejs.org over HTTPS with its SHA-256 checked against `SHASUMS256.txt` (`installer/win/Net.cs:45,58,181`, `installer/win/Engine.cs:391`). Zip extraction is guarded against path tricks (`Net.cs:203-216`).
  - The setup program stays running as a tray app and hosts `node runner.mjs --token-file runner.token` hidden (`installer/win/RunnerHost.cs:115-118`), inside a job object that kills the runner when the host closes (`RunnerHost.cs:269-281`).
  - Uninstall from the tray menu or `--uninstall`, removing only what it created (`docs/features/runner-installer.md:51-54`).
- **Mac app** `AI Testing Runner.app`, a shell launcher (`installer/mac/app/Contents/MacOS/AITestingRunner`) that runs `runner-setup.sh` in Terminal. It downloads Node (SHA-256 checked) or copies the bundled one, and clears quarantine. The LaunchAgent uses RunAtLoad and KeepAlive in the `gui/<uid>` domain (`runner-setup.sh:999-1024`). `--uninstall` boots it out and removes what it made. (read; scripts parse, ran)
- **Crash restart.** The Windows host (`RunnerHost.cs:102-103`) and the Mac loop restart the runner after 5 s. Exit codes 2 to 5 stop it for good. (read)
- **Revocation honoured.** A 401 (or 404 on hello or poll) makes the agent exit with code 3 (`src/agent/client.ts:141`, `agent.ts:197-199`). The Windows host shows "Access removed" and stops (`RunnerHost.cs:96`). (read)
- **Automatic updates** for runners started from a download (`src/agent/updater.ts:1-21`). The runner stops taking tasks, downloads the update files over its own authenticated connection, checks each SHA-256 against the offer, self-tests with `--version`, switches, exits with code 75, and rolls back after 3 starts with no connection. Back-off 5, 15 and 45 minutes, at most 3 tries an hour. Each runner can switch updates off (owner switch, or `AITP_UPDATES=0`). (ran: 14/14)

### Partial or missing

- **Formats.** Windows: the setup program comes inside a zip, not as a standalone `.exe`. Mac: no `.pkg`. A `.dmg` script exists (`scripts/make-dmg.sh`) but was never run (`docs/features/runner-installer-mac.md:71`).
- **Background start was opt-in.** Windows: the Startup-folder shortcut is unchecked by default (`installer/win/Ui.cs:110-115`, `Engine.cs:757`). Mac: "Not now" leaves the runner in a Terminal window (`runner-setup.sh:1360-1367,1395`). Neither starts before sign-in, and both end at sign-out. There is no Windows service and no LaunchDaemon. That is deliberate: headed browsers and desktop tests need the person's session, and Windows services run in Session 0, which has no desktop.
- **Token storage.** A plain file: on Windows `%LOCALAPPDATA%\AITestingRunner\app\runner.token`, with its ACL reduced to the current user (`installer/win/Engine.cs:500,510-517`); on the Mac the runner folder, mode 0600 (`runner-setup.sh:784`). The zip and the unzipped folder keep a copy until the person deletes them (`src/platform/runner-kit-scripts.ts:671`). No DPAPI, Credential Manager or Keychain anywhere (ran: grep).
- **Windows Stop is a hard kill** (`TerminateJobObject`, `RunnerHost.cs:196-203`). A running task is not reported. The platform gives it up when the lease runs out and offers it again, so a test can run again after the person stopped the runner on purpose (`docs/features/runner-installer.md:53`).
- **Mac after revocation:** the LaunchAgent loop sleeps an hour and tries again, for ever (`runner-setup.sh:1151-1166`).
- **Mac logs:** `runner.log` is rotated only when the loop starts, at 5 MB (`runner-setup.sh:1095-1097`), and `launchd.log` never. The Windows host rotates at 2 MB (`RunnerHost.cs:183`). The plain kit writes to the console only.
- **Updates are not signed.** The checksums come from the same platform, so they catch damage, not a compromised server or build artefact (`docs/features/runner-updates.md:84`). The deploy checks only the tarball's own SHA-256 file, shipped beside it (`deploy/c4t-box/deploy.sh:208-262`). The installer programs and their private Node are never updated (`runner-updates.md:78`).
- **No lockfile.** The plain kit, the Windows installer and the updater run `npm install` with exact direct versions but floating transitive ones (`scripts/build-runner.mjs:26-27,83-94`, `installer/win/Engine.cs:578`, `src/agent/updater.ts:466`, `runner-kit-scripts.ts:150,546-548`).
- **No code signing or notarisation.** The commands are documented and were never run (`docs/features/runner-installer.md:76`, `docs/features/runner-installer-mac.md:82-95`, `deploy/c4t-box/README.md:128`). The website says the downloads are unsigned (`web/src/features/runners/UnsignedNotice.tsx`).
- **Shared (machine-level) runners had no download.** "Register a runner" on the Runners page returned a bare secret and a developer command that needs a repository checkout (`src/platform/routes/runners.ts:80-95`, `web/src/features/agents/agents.ts:165-166`).

### What was verified on real machines

- **Windows:** the installer, kit and update tests ran on one Windows 11 x64 machine, per the docs (`docs/features/runner-installer.md:105-108`, `docs/features/runner-kit.md:116`, `docs/features/runner-updates.md:71-72`). Never verified: Windows 10, Windows on ARM, a machine without Node, real nodejs.org and npm downloads, SmartScreen, antivirus, the tray menu by hand, sign-in start.
- **Mac:** never run on a Mac (`docs/features/runner-installer-mac.md:101`, `runner-updates.md:77`). The tests simulate a Mac under bash with stand-ins for `launchctl`, `osascript`, `open`, `xattr` and `shasum` (`tests/installer-mac.test.ts:10-11`). Unverified: the "Background Items Added" notice for an unsigned LaunchAgent, App Translocation, Gatekeeper on the bundled `node`, privacy prompts.
- **CI:** the deploy workflow compiles the Windows setup program on `windows-latest` and checks that the file exists (`.github/workflows/ai-studio-deploy.yml:29-58`). The real-machine workflow (`runner-matrix.yml`) was not in this repository and had never run on GitHub (`docs/features/real-machine-checks.md:97`).

**This round:** single-use enrollment codes instead of tokens in downloads, the OS credential store, rotation, background start by default, a graceful stop on Windows, Mac log rotation and a stop after revocation, signed update manifests, `npm ci` with a lockfile, a `.pkg` build script, signing steps that run only when certificates are configured, and a real-machine workflow in this repository are built in this round. Buying certificates is not done (decision 11). GitHub's Windows machines are Windows Server, so a manual pass on Windows 10 and 11 desktops and on real Macs is still needed (`MANUAL_VERIFICATION.md`).

---

## 3. The protocol (`src/agent-protocol/schema.ts`, `src/platform/routes/agents.ts`)

### Exists

- **Outbound only.** The agent always calls in. HTTPS is required except for loopback and private networks, or with `--allow-insecure` (`src/agent/config.ts:159-173`). TLS ends at nginx (`deploy/c4t-box/nginx-site.conf:1-4`). (read)
- **HTTP long poll**, not WebSocket. The poll waits 25 s by default (`AGENT_POLL_SECONDS`, 1 to 55), one poll per agent (`src/platform/agent-services.ts:65,255-261`). nginx allows it (`proxy_read_timeout 3600s`). (read)
- **Routes** (exact, anchored allow-list that skips the API key, `src/platform/agent-routing.ts:35-51`): `POST /api/agent/hello`, `POST /api/agent/poll`, `POST /api/agent/tasks/:id/heartbeat`, `GET` and `PUT /api/agent/tasks/:id/files/:name`, `POST /api/agent/tasks/:id/result`, `POST /api/agent/tasks/:id/recording`, `POST /api/agent/tasks/:id/device`, `POST /api/agent/update`, `GET /api/agent/update/files/:name`, `POST /api/agent/check`. (read)
- **Versioned and typed.** `PROTOCOL_VERSION = 1` is sent in hello. A mismatch is a 409 on the server and exit code 4 on the agent (`src/agent/agent.ts:233-235`). One zod schema serves both sides. The server parses every body with a size cap (`routes/agents.ts:82-110`). The agent validates every answer (`src/agent/client.ts:160-172`) and reports a bad offer by its id instead of crashing (`client.ts:208-212`, `agent.ts:316-323`). (read; ran)
- **Timings.** Heartbeat every 10 s (`AGENT_HEARTBEAT_SECONDS`), task lease 60 s (`AGENT_LEASE_SECONDS`), online if seen within 45 s (`src/platform/agent-store.ts:166`, `src/platform/runner-health.ts:110-111`), all configurable (`agent-services.ts:64-72`). Agent request timeouts: hello 20 s, poll the poll time plus 20 s, heartbeat 15 s, file transfer 30 minutes, result 60 s (`client.ts:187,197,216,253,283,292`). (read)
- **Reconnect.** Exponential back-off from 1 s to 30 s with 25% jitter (`src/agent/backoff.ts:8-14`). It honours `Retry-After` up to 120 s (`client.ts:139-140`) and says hello again after each failure (`agent.ts:190-207`). (ran)

### Partial or missing

- **No explicit accept or reject.** An offer is claimed when the poll answers. If that answer is lost, the task sits "running" until the lease runs out, and that uses one of its two offers. A runner that cannot run a task can only post `ok:false`, which fails the whole run (`agent-services.ts:342-345`).
- **No attempt id.** A re-offer to the same agent reuses the `taskId`, so a late result from the first attempt is accepted as the second's (`agent-services.ts:272-278`; `tests/agent-platform.test.ts:571-589`).
- **No event ids, sequence numbers or message timestamps** (only `serverTime` in the hello answer).
- **Not idempotent.** A second result gets 409 "already received", not an OK. A retried heartbeat stores its log lines twice. Uploads with the same name overwrite, which is safe.
- **Thin live events.** A heartbeat carries at most 20 lines of 300 characters, plus done and total (`schema.ts:669-674`). No step, screenshot, video or test-failed events while running.
- **No server-to-agent messages** for timeout, configuration change or shutdown. Retiring the runner is the only remote stop.

### The requested event names against protocol 1

| Requested event | Protocol 1 before this round | Status |
|---|---|---|
| RUNNER_REGISTERED | `POST /api/agent/hello` | exists |
| RUNNER_HEARTBEAT | the poll while idle; `POST …/heartbeat` during a task | exists |
| RUNNER_CAPABILITIES_UPDATED | capabilities sent with every hello and poll (`agent.ts:295-300`) | exists |
| JOB_ASSIGNED (to the agent) | a poll answer carrying a `TaskOffer` | exists |
| JOB_ACCEPTED | implicit: the offer is already claimed | missing |
| JOB_REJECTED | only a result with `ok:false`, which fails the run | missing |
| JOB_STARTED | no message (the first heartbeat) | missing |
| EXECUTION_PROGRESS | heartbeat `done`/`total` and log lines | partial |
| STEP_STARTED, STEP_COMPLETED | none live; steps come with the result | missing |
| LOG | heartbeat log lines (at most 20 of 300 characters) | partial |
| SCREENSHOT_CAPTURED, VIDEO_AVAILABLE | none live; files upload after the run | missing |
| TEST_FAILED | in the final result only; "Finished n of N tests: <title> (<status>)" lines (`src/agent/task-child.ts:56`) | partial |
| JOB_COMPLETED, JOB_ERROR | `POST …/result` with `ok` true or false and a reason | exists |
| JOB_CANCELLED (agent to platform) | result `ok:false` after a cancel | exists |
| JOB_CANCELLED (to the agent) | heartbeat answer `cancel: true` | exists |
| JOB_TIMEOUT (to the agent) | none; the agent's watchdog and the server's lease | missing |
| CONFIGURATION_UPDATED | only at the next hello | missing |
| UPDATE_AVAILABLE | `update` in the hello answer, the `x-runner-update` header, `POST /api/agent/update` (`schema.ts:208-214`) | exists |
| SHUTDOWN_REQUESTED | none | missing |

**This round:** protocol 2, added beside protocol 1: attempt ids, explicit accept and reject with re-offer, idempotent results, typed live events with sequence numbers, and timeout, shutdown and configuration messages in the heartbeat answer. Being built in this round (decision 9). Protocol-1 agents keep being served unchanged.

---

## 4. Orchestration on the platform

### Two state machines

| | Platform job (`generation_jobs`, `src/platform/repo.ts:19-29`) | Runner task (`agent_tasks`, `src/platform/agent-store.ts:214`) |
|---|---|---|
| States | QUEUED, then VALIDATING when claimed (`repo.ts:495-508`), then COMPLETED, PARTIALLY_COMPLETED or FAILED. A cancel ends as FAILED "Cancelled". | `queued`, then `running` when claimed, then `done`, `failed` or `cancelled`. |
| Lease | 60 s, renewed every 5 s by the worker (`src/platform/job-runner.ts:76-89,127-141`) | 60 s, renewed by each agent heartbeat (`agent-services.ts:64-72`) |

ASSIGNED, ACCEPTED, PREPARING and UPLOADING were all just `running`. REJECTED, TIMED_OUT and LOST_CONNECTION existed only as error text.

### Exists (read unless marked)

- **Enqueue.** `RemoteExecutor.execute` builds the offer. Baselines go into the store under `<project>/_agent/<task>/in/`, and the app file is referenced by hash (`agent-services.ts:674-742`). `enqueue` writes the row and its files in one transaction (`agent-store.ts:505-510`).
- **Claim.** The agent's long poll (`routes/agents.ts:235-266`) calls `offerTo` every 250 ms (`agent-services.ts:199-235`). `claimFor` is one conditional `UPDATE … WHERE status='queued' AND project_id IN (runner_access of a live token) RETURNING *`, plus the device reservation, in one transaction (`agent-store.ts:541-554`). (ran: "exactly one agent claims a task")
- **Progress.** A heartbeat extends the lease, stores done and total, and keeps the last 200 log lines in `log_json` (`agent-store.ts:595-604`). The lines also become `agent_progress` job events (`agent-services.ts:434-446`).
- **Re-offer.** `sweep()` (`agent-store.ts:633-646`) puts a task whose lease ran out back in the queue while it has had fewer than 2 offers (`MAX_OFFERS`, `agent-store.ts:299`). After that it fails with "The runner agent stopped responding…". Record and phone tasks are never re-offered. `sweep()` runs from polls (at most every 5 s), from every executor watch tick (1 s) and from the scheduler. (ran: "offered once more, then fails")
- **Timeouts.** No capable runner online for 90 s (`AGENT_NO_AGENT_GRACE_SECONDS`) fails the task (`agent-services.ts:771-781`). Queued for 30 minutes fails it (`QUEUE_MAX_MS`, `agent-store.ts:301,641`). The executor's deadline is the run's limit plus 5 minutes, or 4 hours without one (`agent-services.ts:759,797-801`). The job's limit is `JOB_MAX_MINUTES`, 120 by default (`job-runner.ts:143-150`).
- **Cancel.** A person's cancel sets `cancel_requested` on the job (`repo.ts:607-612`). Within 5 s the worker aborts the job. A queued task becomes cancelled at once; a running one is flagged (`agent-store.ts:616-619`). The agent's next heartbeat answers `cancel: true`, the agent posts `ok:false`, and the task is stored as cancelled (`agent-store.ts:607-613`). If the agent never answers, `sweep` cancels the task after the lease. Tests that had not run go back to what they were (`job-runner.ts:430-435`).
- **A result posted twice.** `finish()` changes only a `running` row owned by this agent. The second post gets 409. A post to a cancelled task gets `{ok:true}` (`agent-services.ts:335-350`). (ran)
- **An artifact uploaded twice.** The upload is streamed to its final key and hash-checked before it is visible (`routes/agents.ts:288-332`). The row upserts on `(task_id, direction, ref)` (`agent-store.ts:662-667`), so the last upload wins and is counted once. Uploads are accepted only while the task runs and only from the agent that claimed it.
- **Pruning.** After 24 h `pruneTasks` deletes finished tasks, their payloads and their `_agent/<task>` files (`agent-store.ts:649-654`, `agent-services.ts:607-628`).

### How a runner was chosen

- A runner is a token (`agent_tokens.id`). A machine is an `agents` row, unique on `(token_id, name)`. Hello refuses a second machine on the same token while another is online (`agent-services.ts:173-174`).
- A runner belongs to an organisation, or to Crowd4Test when `organization_id` is null (migration 42, `agent-store.ts:98-160`). `runner_access` grants it to projects. An organisation's runner may serve only its own organisation's projects; a Crowd4Test shared runner may serve any (`mayServe`, `runner-health.ts:48`; `routes/runners.ts:145`). (ran: `runners-shared`)
- The project's setting, `runner_settings`, holds `run_on` (`platform` or `agent`) and an optional `agent_id`. That id pins a **machine row**, not a runner (`agent-store.ts:47-52,488-501`).
- Dispatch is pull-based and oldest first. A polling agent looks at up to 50 queued tasks across the projects it serves (`queuedFor`, `agent-store.ts:527-535`) and skips a task when the project is pinned to another machine, the capabilities do not match (`capabilityProblem`, `src/platform/agent-routing.ts:108-133`: browsers, Android, iOS needs a Mac, Windows UI Automation needs Windows), it has code scripts and the agent lacks `customScripts` or is a shared runner (`agent-services.ts:226-228`), or its device is held.
- There is no load balancing and no choice per run. Whichever capable agent polls first gets the task. The same capability rule runs when the job is created, against the online eligible agents (`agent-services.ts:509-538`).

### When no runner can take the run

| Situation | What happened |
|---|---|
| Production | Refused before any runner check (see "Why nothing could run"). |
| Project on runners, no eligible runner online at Run | 409 from `jobGate`, which `createJob` calls for every way a job is made (`repo.ts:460`, `agent-services.ts:509-538`). |
| The pinned runner is offline | The same generic 409 (`agent-services.ts:474-476`). |
| A runner disappears after the job was queued | The task fails after 90 s. |
| A runner is online but busy | The task fails after 30 minutes. |
| A schedule's run is refused | The schedule records it as skipped with the message (`scheduler.ts:229-240`). |
| Switching a project to runners with none online | `PUT /api/projects/:id/runner` refuses (`routes/agents.ts:189-190`), so a project cannot be set up before its runner. |

### Partial or missing

- **Worker crash.** `reclaimStaleJobs` puts the job back in the queue, up to 3 attempts (`repo.ts:532-566`), and the new attempt makes a new task. The old task is not cancelled (its job is not finished, so `sweep`'s orphan rule at `agent-store.ts:642` does not apply). The runner finishes the old run unobserved, the customer's app sees the run twice, and with concurrency 1 the new task can hit the 30-minute limit. Not tested.
- **A runner failure marks tests failed.** `job-runner.ts:436-438` sets every test that was VALIDATING to `FAILED_VALIDATION` with "Validation interrupted: …". The feature doc says the platform never invents a failing verdict (`docs/features/runner-agent.md:67-69`). The test behind that claim calls the executor directly, not the job runner.
- **Re-offers are silent.** No event says "the runner stopped answering; trying again" (`agent-store.ts:639`, `agent-services.ts:771-783`).
- **A file named in the result but never uploaded is dropped** without an event (`agent-services.ts:851`).
- **Where it ran.** After the 24 h prune, `ranOn` falls back to the project's current pinned runner (`agent-services.ts:581-586`), so an old run can name the wrong machine.
- **The `queuedFor` limit of 50** hides a matching task behind 50 non-matching ones (`agent-store.ts:527-535`). Low risk while one worker exists.
- **Pruning only on the scheduler tick** (`schedule-services.ts:63`), so with the scheduler off every runner artifact stays stored twice (see section 5).

**This round:** runs routed to runners in runners mode, a dispatch worker with several runner jobs at once, per-run runner choice, cancelling the old attempt's task when a job is re-queued, tests left as they were after a runner failure, task phases written by the server, events for re-offers and missing files, `ranOn` kept past the prune, and housekeeping in runners mode are built in this round. The `queuedFor` limit is not built.

---

## 5. Data, live events and artifacts

### Exists (read unless marked)

- **Tables:** `agent_tokens` (runner, `token_hash` SHA-256 with a 4-character hint), `agents` (machine: `os`, `arch`, `version`, `capabilities_json`, `last_seen_ms`), `runner_access`, `runner_settings`, `device_reservations`, `agent_tasks` (`last_beat_ms`, `log_json`, encrypted payload), `agent_task_files` (direction, ref, path, size, SHA-256), `agent_events`, `generation_jobs`, `artifacts`. Ownership: `organization_id`, `created_by`, `runner_access.granted_by`.
- **Transactions** around enqueue, claim, sweep, access removal and moving a project to another organisation. Every state change is a conditional UPDATE (`agent-store.ts:12`).
- **Events are kept.** Every job event is a row in `agent_events` (`repo.ts:619-632`). The executor adds `agent_task_queued`, `agent_task_started` and `agent_browser`. Heartbeat lines become `agent_progress` events, scrubbed (`agent-services.ts:434-446`). After the run, per-test results, steps and artifacts are recorded by `RepoSink`, exactly as for a run on the platform.
- **Server-Sent Events to the browser.** `GET /api/test-generation/:jobId/stream` and `/api/projects/:id/stream`, with a one-use stream ticket (`src/platform/routes/stream.ts:95,208-260`; `src/platform/stream-core.ts:1-8` explains why SSE was chosen over WebSocket). A resume with `Last-Event-ID` replays what was missed; a first visit gets the last 500 (`routes/stream.ts:213-216`). In one process an in-process bell pushes at once (`src/platform/event-bus.ts`); across processes the table is polled every 250 to 1000 ms (`stream-core.ts:41-42`). A refresh replays everything, and the 24 h task prune does not touch `agent_events`.
- **Artifacts.** The agent sends `PUT /api/agent/tasks/:id/files/:name`, streamed through the API. Caps: 64 MB per file, 512 MB and 300 files per task (`agent-services.ts:68-70`); nginx caps a request at 100 MB (`deploy/c4t-box/nginx-site.conf:17`). Files land at `<project>/_agent/<task>/out/<name>` in the local store, with size and SHA-256 recorded. `collect` re-masks evidence and maps refs to files (`agent-services.ts:807-890`). `RepoSink` copies each file to `<project>/_artifacts/<test>/job-…/attempt-n/` and adds an `artifacts` row (`src/platform/repo-sink.ts:170-185`). Downloads to the agent are streamed with `x-content-sha256` and a size re-check (`routes/agents.ts:274-286`).
- **The agent never gets a path or a storage credential**, only safe names and hashes (`schema.ts:29,285`). App files are limited to the project's own part of the store (`src/platform/object-store.ts:355-362`).
- **People's access to artifacts** goes through `/api/artifacts/:id`, scoped by object to project (`src/platform/auth/project-scope.ts:75,249-250`).
- **PostgreSQL schema.** `src/platform/pg/baseline.sql` has every one of these tables, with epoch-millisecond columns as BIGINT and identity columns that keep insertion order. (ran: `pg-baseline-unit`, `sql-portability-unit`)

### Partial or missing

- **Live granularity.** Only lines such as "Running 3 scripts" and "Finished 1 of 3 tests: Check One (passed)". No live steps or screenshots. Done and total stay on the task and show only on the Runners page (`runner-health.ts:143`), not in the job's counters.
- **Unscrubbed task log.** `agent_tasks.log_json` stores the agent's lines as sent, without the server-side scrub the events get, for 24 h (`agent-services.ts:285`, `agent-store.ts:595-603`).
- **Snapshots only.** Capabilities and heartbeats have no history. `agent_tasks.job_id` has no foreign key.
- **Object storage.** Only the local disk store exists (`object-store.ts:294-299`). The artifact route asks for a 300-second signed link (`src/platform/server.ts:943-946`), but the local store returns none (`object-store.ts:260-265`), so every file streams through the API. No S3 adapter and no time-limited upload or download links. Every runner artifact is stored twice for 24 h (task copy and artifact copy).
- **PostgreSQL code.** `AgentStore` and the job and event methods of `Repo` use the synchronous SQLite `Db`. The asynchronous `Sql` interface exists (`src/platform/sql.ts:1-12`) but had no PostgreSQL adapter. Behaviour that changes under PostgreSQL, none of it tested:
  1. Device reservations can race: a `*` reservation and a named one do not collide on the primary key (`agent-store.ts:544,551,559-561`).
  2. A runner job's events are written by two processes (the worker and the API's heartbeat handler), but the job stream assumes one writer (`src/platform/stream-store.ts:15-22`). A live viewer could miss a line; a refresh recovers it.
  3. Each open poll reads the queue every 250 ms, and each active runner job runs a sweep transaction every second (`routes/agents.ts:254-261`, `agent-services.ts:206-233,768`).
  4. `heartbeat` read-modify-writes `log_json` without a row lock (`agent-store.ts:597-601`). Low risk.

**This round:** typed live events stored as job events (replayed after a refresh), heartbeat lines scrubbed before storing, phases and where-it-ran kept on the task or job, and the old attempt's uploads kept apart are built in this round. S3, signed links and the asynchronous PostgreSQL stores are not built in this round; they belong to the PostgreSQL migration stages.

---

## 6. The website (`web/src/`)

### Exists (read)

- **Runners list** with search and filters for status, owner and project. Each row shows name, owner, project count, last seen, waiting count and a status badge (`web/src/features/runners/RunnersPages.tsx:37-160`).
- **Status words:** online, busy, offline, not connected, retired (`web/src/features/runners/runners.ts:5,56-62`, `src/platform/runner-health.ts:50`). Offline means 45 s without a word.
- **Machine details:** OS, architecture, Node, agent version, kit version, update state, browsers, Android and devices (`RunnersPages.tsx:257-278`, `web/src/features/agents/AgentsList.tsx:132-156`, `web/src/features/agents/agents.ts:58-91,134-146`). Last seen as relative time.
- **Rename and retire** for those who may manage (`RunnersPages.tsx:337-379`); "stop using" and remove access (`web/src/features/runners/ProjectRunnersSection.tsx:111-115`, `web/src/features/agents/RemoveAccess.tsx:36`). Retire is the revoke; a retired row is kept on purpose.
- **Install flow** in three steps (`web/src/features/agents/AddRunner.tsx:38-163`). It detects Windows, Mac or Linux and the processor from the browser (`web/src/features/agents/kit.ts:62-97`), and says the downloads are unsigned (`web/src/features/runners/UnsignedNotice.tsx`).
- **Run buttons** on Test scripts, the test page and the run page (`web/src/pages/ProjectTests.tsx:181,258`, `web/src/features/runs/RunMenu.tsx`, `web/src/features/runs/RunDetail.tsx:104-114`), suites (`web/src/features/workspace/SuitesPage.tsx:37-39`, `web/src/features/suites/SuiteDetail.tsx:69,145-147`) and schedules (`web/src/features/schedules/SchedulesPanel.tsx`).
- **Run progress.** The strip shows "Running N tests · X done · Y failing · <runner> · elapsed" and the latest event line (`web/src/features/runs/RunStrip.tsx:120-160`). The run page shows where, browser, when, how long and who started it (`RunDetail.tsx:75-115`). The full event log is under "View technical details" (`web/src/components/TechnicalDetails.tsx`).
- **Live over SSE, not aggressive polling.** EventSource with a one-use ticket, resume with the last event id, back-off from 1 to 30 s (`web/src/lib/stream.ts:1-104`). While live it also re-reads the run every 6 s, or every 2.5 s without SSE (`web/src/features/runs/runs.ts:95-108`). A reload reads everything back from the database.

### Partial or missing (read unless marked)

- **Unreachable in production.** Run was disabled everywhere and the server refused every run (ran).
- **Install only from a project.** "Add a runner" lives only under a project (`ProjectRunnersSection` to `ProjectRunners` to `AddRunner`). The Runners page's "Register a runner" (`RunnersPages.tsx:162-212`) gives only a token and a developer command. A Mac is always guessed as an Apple chip. Downloads are zips; no `.pkg`, `.dmg` or `.msi`.
- **No identity depth.** No OS version, memory or Playwright version anywhere. "Current work" shows the kind and progress, with no link to the run and no test or step names (`RunnersPages.tsx:279-291`). The network problem and "check this computer" show only on the project's runner card; the machine page shows only failures from the last 24 hours (`RunnersPages.tsx:313-334`).
- **Offline instructions.** A runner that went offline gets only the tooltip "Start it again on its computer". It does not say how (tray, sign-in start, LaunchAgent).
- **Runner choice.** The Run panel lists the project's runners and disables offline ones, but does not filter by capability or explain before Start (`RunMenu.tsx:306-334`). Picking a runner rewrites the project's setting for everyone with `PUT /runner` (`RunMenu.tsx:199-203`), which needs `project.settings`, so a person without it gets a 403 and the run does not start. Nothing chooses a runner for one run.
- **"Where tests run"** offers and recommends "On this server" (`web/src/features/agents/RunnerChoicePanel.tsx:10-153`), which cannot run in production. A new kit runner does not become the project's runner until someone saves it (`AddRunner.tsx:575-577`).
- **Live depth.** Runner progress is text lines only. No step events, no live screenshots, no current-step field (`docs/features/ux-run-control.md`, Limits).
- **Buttons the server refuses.** The Runners nav item needs `ai_studio.runners.manage` (`web/src/components/Shell.tsx:75`), but "Add a runner", "Remove access", the advanced token panel and Save on "where tests run" were shown to everyone (`AgentsList.tsx:27-56`, `web/src/features/agents/ProjectRunners.tsx:46-77`, `RunnerChoicePanel.tsx:139-142`). The server then answered 403. `ProjectRunners.tsx:24` polled `/agent-tokens` every 5 s, which answers 403 to anyone without the permission.
- **Wrong copy for the hosted product:** "Most people do not need one" (`ProjectRunners.tsx:44`), "Most projects need none: tests run on this server" (`ProjectRunnersSection.tsx:61`), "Tests run on this server unless you choose a runner" (`web/src/lib/labels.ts:445`), the stale path "Settings, Runners" and a Linux installer that does not exist (`RunnersPages.tsx:30`, `web/src/features/phone/phone.ts:77,108`, `web/src/features/phone/PhoneStart.tsx:127`), "fail after 30 minutes" when the default is 90 s (`runners.ts:59`), "switch the project back to running here" (`src/platform/agent-services.ts:40,779`), and "your own installation" (`src/platform/suite-run.ts:27,38,41`).
- **Polling.** The project runners section polls five endpoints every 5 s, plus `/runners` (`ProjectRunners.tsx:22-25`, `RunnerChoicePanel.tsx:12`). Runner status is never pushed.

### A tester's path, "run this test on my laptop" (from the code)

1. They open AI Studio from Crowd4Test and arrive as side `tester` (`src/platform/auth/crowd4test.ts:174`), typically with `tests.write` and `tests.run`.
2. No Runners item in the left panel. The dashboard's runner card points to "Settings, Runners", a path that no longer exists.
3. Test scripts says tests are switched off on this server. The "Use a runner" link is hidden. **First break: no way to runners from where they run tests.**
4. Run opens a panel with Start disabled and "This server" still offered.
5. By URL they reach the runners page, which says "Most people do not need one."
6. "Add a runner" is shown. The download answers 403: `canManageRunner` refuses testers. **Second break: a tester can never add their own laptop.**
7. Even after an admin installs a runner and saves "On a runner", Run stays disabled and the server answers 409 (ran). **Third break, the decisive one.**
8. Schedules, Run now: 202, the run shows as queued and nothing happens (ran). The project now has an active run, so every Run control says "A run is going". **Fourth break.**

Where a worker runs (a development machine), the rest works: the strip shows the runner and progress lines, the run page survives a reload, and a lost runner fails the run after 90 s.

**This round:** "Add this computer" for everyone who may run tests, "Add a team runner" from the Runners page, runner pages with kind, owner, identity, current work and offline help, buttons shown only when the server says the caller may, a Run panel that lists eligible runners and sends a choice for this run only, the "Allow people's own computers" project switch, a live run view with phases, steps and screenshots, and the copy fixes are built in this round.

---

## 7. Security

### The model before this round (read)

A runner credential is `aitg_` plus 32 random bytes (`agent-store.ts:163`), stored only as SHA-256 plus the last 4 characters (`:23-24`), looked up by hash and compared in constant time (`:420-428`), and revocable (`revoked_at`, `:361-364,414-417`). Agent routes are an exact, anchored allow-list that skips the API key (`agent-routing.ts:33-74`). One request hook authenticates the bearer token for the whole scope (`routes/agents.ts:204-208`). A token serves only projects in `runner_access`. Claiming is one SQL update that re-checks access and revocation (`agent-store.ts:541-555`). Heartbeat, download, upload, result, recording and device messages all go through `ownedTask`, "this token's agent claimed it" (`agent-services.ts:272-278`). Task payloads and results are encrypted at rest with AES-256-GCM (`src/platform/secrets.ts:58-65`, `agent-services.ts:414,749`). Results and errors are scrubbed of the run's credentials before storing (`agent-services.ts:335-349`).

### Controls

| Control | Status | Evidence |
|---|---|---|
| Registration authorised by the backend | exists | `runner-health.ts:31-45`; all three minting routes use `canManageRunner` (ran: `live-hardening`) |
| Short-lived registration credential | missing | the long-lived token is the registration credential (`agent-store.ts:319-338`) |
| No secret in the download | missing | every zip carries `runner.token` (`src/platform/runner-kit.ts:205`, `src/platform/runner-kit-complete.ts:281`, `routes/runner-kits.ts:87-90,128-131`) |
| Revocation | exists | `agent-store.ts:361-364,414-417`; an open poll re-checks on its next turn (`routes/agents.ts:253`); deleting a project retires its lone token (`src/platform/project-folders.ts:162`) |
| Rotation and expiry | missing | no route; tokens never expire; `last_used_at` is recorded but never used |
| OS credential storage | missing | plain file with ACL or 0600 (section 2) |
| Unauthorised agents refused | exists | 401 when missing or malformed, 404 when unknown or revoked (`agent-services.ts:155-163`); the API key never substitutes (ran: route-matcher tests) |
| One organisation's runner cannot reach another's projects | exists | claim SQL (`agent-store.ts:547-549`), `mayServe`, grant route (`routes/runners.ts:140-147`) (ran: `runners-shared`). By design a Crowd4Test shared runner may serve any organisation |
| Secrets not in responses or request logs | exists | the secret is in the 201 answer or the zip only (`routes/agents.ts:145-147`, `routes/runners.ts:91-94`); lists show the hint (`routes/agents.ts:33`); the request log keeps method and URL (`server.ts:246`) |
| Masking in logs | partial | agent redactor (`src/agent/log.ts:44-55`) and server scrub (`agent-routing.ts:165-180`) mask exact strings only; evidence masking also covers URL-encoded, `+`, hex and JSON-escaped forms (`src/engine/evidence/capture.ts:56-66`); heartbeat log stored unscrubbed (section 5) |
| No platform-wide secret reaches tests | exists | the offer carries project credentials only (`schema.ts:289-302`); the child environment is an allow-list (`src/engine/validation/runner.ts:116-125`, `task-process.ts:34-43`) |
| Download integrity | partial | task files checked by size and SHA-256 (`src/agent/file-cache.ts:85-95`); updates by SHA-256 (`updater.ts:370-373,446`); no signatures anywhere |
| Workspace isolation | partial | a folder per task; but every task of every project a runner serves runs as the same OS user, with no OS-level isolation |
| Resource limits | partial | time limits and upload caps; JSON bodies 2 MB, results 8 MB (`routes/agents.ts:30-31`); no CPU, memory or per-task disk limit; upload caps are read before the write, not reserved |
| Audit logging | partial | every non-GET admin request goes to Activity (`src/platform/auth/access.ts:357-380`); kit downloads audited (`routes/runner-kits.ts:95-97,136-139`). Not audited: refused or revoked token attempts, a token used under a new machine name, source address. Kit and project tokens have no `created_by` |
| Rate limits | partial | hello 6 a minute; agent limits apply after the token lookup; no per-address limit and no nginx `limit_req` (`routes/agents.ts:204-208`) |
| Private addresses | partial | runner runs allow private targets by design (`docs/features/runner-agent.md:85-87`); the kits and installers never set `BLOCK_PRIVATE_TARGETS` |

### Gaps that matter for testers' own computers

- **Tests can read the runner's token.** Tests run as the agent's OS user with `HOME`, `USERPROFILE` and `APPDATA` passed (`src/engine/validation/runner.ts:116-125`, `task-process.ts:34-43,53-59`). A hand-written script on a runner that allows them can read `runner.token`, because the ACL and 0600 only stop other users, and then act as the runner for every project it serves. Mitigation in place: code scripts need `--allow-custom-scripts` and never go to shared runners (ran: `agent-safety-unit`).
- **A runner receives each project's test accounts.** Every task carries that project's passwords, TOTP secrets, API tokens and saved session (`agent-routing.ts:138-150`, `schema.ts:289-302`, by design per `docs/features/runner-agent.md:82`). Whoever operates the machine can read them. For Crowd4Test shared runners, which serve any organisation, this was not stated to customers anywhere found.
- **No machine binding.** The same token and name from another machine updates the same row (`agent-store.ts:444-451`). A copied token is a full impersonation.
- **Updates.** A compromised platform or deploy pipeline could run code on every runner without a prompt (unsigned, automatic by default, `src/platform/runner-update.ts:36-37,112`).
- **Removing a project's access does not stop its task already running** (`agent-services.ts:272-278`).
- **Traces and videos** are kept on failure (`src/engine/validation/runner.ts:146,148`). Whether a trace holds a typed password was not checked; the leak test skips zip, webm and mp4 files (`tests/secret-leak.test.ts:390`).
- **Dead code:** `AgentStore.claim()` has no `runner_access` check; only tests call it (`agent-store.ts:588-592`).

**This round:** enrollment codes, the OS credential store, rotation, machine binding, `created_by` on every token, personal-runner eligibility, the project switch, private addresses refused by default on personal runners, code scripts on personal runners with an owner switch, scrubbed task logs and encoded-form masking, atomic upload caps, a scoped or removed `claim()`, and signed updates are built in this round. OS-level isolation of tests from the runner (a separate user or sandbox) is not built. A test that runs as the same user can still reach what the runner can reach; `SECURITY_DESIGN.md` states the limits.

---

## 8. Tests and CI

### Runner test files before this round

Tier: **F** = in `vitest.fast.config.ts`; **CI** = in `.github/workflows/ai-studio-ci.yml`; **B** = needs a browser; **W** = Windows only; **M** = Mac simulated under bash; **P** = fixed real ports.

| File (tests) | Tier | Covers |
|---|---|---|
| `agent-platform-unit` (31) | F | token hash and lookup, bearer parsing, route matcher and path tricks, task states (claim once, lease, re-offer, cancel, prune), capability rules, safe names, scrub, rate limiter |
| `agent-platform` (24) | P | admin versus agent auth, revoke, path tricks over HTTP, refusals with no or incapable agent, only the claiming agent, upload caps and hashes, cancel, lost agent, `ok:false`, private targets, a full job through the worker |
| `agent-program-unit` (37) | F, P | CLI, HTTPS rule, token never printed, capabilities, back-off, answer validation, wire mapping, file-cache checksum refusal, log redaction, agent-side cleanup |
| `agent-program` (24) | B, P | the real agent against a stand-in platform: web and API runs, credentials only in the test process, two slots, cancel kills the tree, missing browser, reconnect after a platform restart, revoked token mid-run, graceful stop |
| `agent-program-e2e` (5) | B, P | the real agent against the real platform: online, a validated web and API run, failure artifacts, password only in the test process |
| `stream-agent` (1), part of `stream` | P | live progress lines over the stream; events are scrubbed (`stream.test.ts:526-562`) |
| `runners-shared` (15) | CI, P | pre-migration tokens keep working, organisation scoping, 404 for another organisation's runner, grants, shared runners managed by Crowd4Test only, retire, pinned runner |
| `live-hardening` (12) | F, CI | a retired runner's open poll gets nothing, testers cannot mint tokens, project delete retires a lone token, caps |
| `agent-safety-unit` (13) | F, CI | code scripts never offered to a shared runner |
| `secret-leak` (16) | CI, P | a runner task's credentials are scrubbed from results and never stored in plain text; sends no heartbeat log |
| `runner-kit-unit` (30), `runner-kit` (18), `runner-complete-kit-unit` (18), `runner-complete-kit` (2), `runner-kit-node-unit` (45), `runner-kit-node` (12) | F / P, part W | bundles, zip modes (token at 0600), download routes, Node detection; the complete-kit end-to-end only on Windows |
| `runner-update-unit` (14), `runner-update-scripts` (6), `runner-update` (3), `runner-update-ui` (2) | F / F / W / B | offers, checksum refusal, staging, rollback |
| `installer-win-unit` (12), `installer-win` (22) | F (needs `csc`) / W | the Windows installer build and a real run |
| `installer-mac-unit` (57), `installer-mac` (2) | P / M | the Mac setup script with stand-ins; never on a Mac |
| `runner-check*`, `runner-browsers*`, `record-agent*`, device, phone and live-session runner tests, `custom-agent`, `framework-settings-agent` | mixed | "check this computer", browser choice and download, recording, phone and live sessions, code scripts and framework settings on a real agent |
| `runners-ui` (5), `agents-ui` (17), `add-runner-ui` (40), `ux-agent-status` (7) | B / B / B / F | Runners pages with a stand-in runner; the add-runner journey |
| `runner-matrix-workflow` (11) | F | the shape of the real-machine workflow; **fails** here because the file is not in this repository (ran) |

**CI** ran only `runners-shared`, `live-hardening`, `secret-leak`, `agent-safety-unit` and `runs-off-here` from the runner area. None of `agent-platform-unit`, `agent-platform`, `agent-program*`, `stream-agent`, `record-agent*`, `runner-kit*`, `runner-update*` or `installer-*` ran in CI. The deploy workflow only builds the Windows setup program. No real-machine workflow ran.

### Against the requested test list

| Area | Status | Where, or what was missing |
|---|---|---|
| Agent: registration, auth, heartbeat, cancel, events, upload, cleanup | exists | `agent-program`, `agent-program-unit`, `agent-platform`, `stream-agent` |
| Agent: reconnect | partial | back-off unit test; platform restart. Missing: sleep and wake, network change, DNS failure |
| Agent: accept, reject | partial | claim tests only; reject exists only as `ok:false` |
| Agent: timeout | partial | the server's deadline and lease are tested; the agent's watchdog (`task-runner.ts:398`) is not |
| Agent: crash recovery | partial | re-offer after a lost agent; an agent killed mid-task and restarted is not tested |
| Backend: registration, credentials, revocation, capability matching, assignment, transitions, unauthorised access, artifact access | exists | `agent-platform-unit`, `agent-platform`, `live-hardening`, `runners-shared`, `project-access` |
| Backend: duplicate events | partial | result twice and upload twice tested; repeated heartbeat lines and a retried result after a lost answer are not |
| Integration: the whole flow with the website | partial | the real agent at API level; the UI only with a stand-in runner. No browser test clicks Run with a real runner and checks the live view and a refresh |
| Integration: disconnect and recovery | partial | lease and requeue, platform restart; no network cut against the real platform |
| Real installers, Windows 10 and 11 | partial | one Windows 11 x64 machine (docs); never Windows 10 or ARM |
| Real installers, macOS | missing | simulated only |

**This round:** new tests for runner-only mode, enrollment and personal runners, protocol 2 and live events, the website's runner and live views, and an end-to-end journey with the real agent; the existing runner unit and integration tests added to CI; and a real-machine workflow in this repository are built in this round. A manual pass on real Windows 10 and 11 desktops and real Macs is not done; `MANUAL_VERIFICATION.md` lists it.

---

## 9. Bugs and risks found

All read unless marked "ran". Severity is about the hosted product with runners on people's own computers.

| # | Severity | Finding | Evidence | This round |
|---|---|---|---|---|
| 1 | blocker | Every run start refused in production, runner projects included; no process turns a job into a runner task | `suite-run.ts:30-35`, `routes/runs.ts:36`, `src/main.ts:44-53`, `agent-services.ts:664-757` (ran) | built (`EXECUTION_MODE=runners`, dispatch worker) |
| 2 | blocker | Turning the worker on would run "on this server" projects on the box | `agent-store.ts:488-491`, `deploy/c4t-box/README.md:45-57` | built (every project routes to runners in `runners` mode) |
| 3 | high | A Crowd4Test tester can never add a runner | `runner-health.ts:42` (ran: `live-hardening`) | built (personal runners) |
| 4 | high | Schedule Run now queues a job nothing runs, and it locks the project's Run controls | `scheduler.ts:71-86`, `web/src/lib/labels.ts:60` (ran) | built (refused while runs cannot start) |
| 5 | high | Schedules show a next run but never fire; housekeeping and pruning never run | `routes/schedules.ts:153`, `src/main.ts:44-53`, `schedule-services.ts:61-63` (ran) | built (schedules and housekeeping in `runners` mode) |
| 6 | high | One worker runs one job at a time, and a runner job holds it while it waits | `worker.ts:56-64` | built (`DISPATCH_CONCURRENCY`) |
| 7 | medium | Server-side Chromium and server-side network calls inside runner jobs | `hard-signin-service.ts:203-209,223`, `validate-only.ts:184-185`, `test-data-reset-run.ts:38` | built (closed in `runners` mode; reset only to public addresses) |
| 8 | medium | Every download zip carries a long-lived token | `runner-kit.ts:205`, `runner-kit-complete.ts:281`, `routes/runner-kits.ts:87-90` | built (`runner.enroll`) |
| 9 | medium | Tests run as the runner's user and can read its token file | `src/engine/validation/runner.ts:116-125`, `task-process.ts:34-43` | built (OS store); same-user access remains a limit |
| 10 | medium | Heartbeat log lines stored unscrubbed for 24 h | `agent-store.ts:595-603`, `agent-services.ts:285` | built |
| 11 | medium | Crowd4Test shared runners receive every served project's test accounts; customers are not told | `runner-health.ts:47-48`, `agent-routing.ts:138-150` | not built |
| 12 | medium | Silent, unsigned automatic updates to every runner | `updater.ts`, `docs/features/runner-updates.md:84`, `deploy/c4t-box/deploy.sh:208-262` | built (Ed25519; no key pinned yet) |
| 13 | medium | A worker crash leaves the old runner task running while a new one is queued | `repo.ts:532-566`, `agent-store.ts:642` | built |
| 14 | medium | No fencing: a re-offer to the same agent reuses the task id, and a late result counts | `agent-services.ts:272-278`, `tests/agent-platform.test.ts:571-589` | built (attempt ids) |
| 15 | medium | A runner that cannot run a task fails the whole run instead of letting another runner take it | `agent-services.ts:342-345` | built (reject and re-offer) |
| 16 | medium | A runner failure marks tests FAILED_VALIDATION, against the feature doc | `job-runner.ts:436-438`, `docs/features/runner-agent.md:67-69` | built |
| 17 | medium | Windows Stop is a hard kill; the task is re-offered after the lease | `installer/win/RunnerHost.cs:196-203` | built (`stop.request`; not run on Windows) |
| 18 | medium | A finished result is lost if the platform is away for more than about 23 s | `task-runner.ts:50,614-628` | built (outbox) |
| 19 | medium | Code projects cannot run on any installed runner | `task-runner.ts:324-330`, `src/agent/kit.ts:17-25`, `schema.ts:311-312` | built (code-scripts switch) |
| 20 | low-medium | No private-address guard on runners by default | `docs/features/runner-agent.md:85-87` | built for personal runners (`src/agent/address-guard.ts`); team runners unchanged |
| 21 | low | Exact-string masking only, so encoded secrets survive in progress lines and errors | `agent-routing.ts:165-180`, `src/agent/log.ts:44-48` | built |
| 22 | low | Traces and videos may hold typed passwords; the leak test skips them | `src/engine/validation/runner.ts:146,148`, `tests/secret-leak.test.ts:390` | checked: a trace holds the typed password; not fixed |
| 23 | low | `npm install` without a lockfile on the plain kit, Windows installer and updater | `scripts/build-runner.mjs:83-94`, `installer/win/Engine.cs:578`, `updater.ts:466` | built (`npm ci --ignore-scripts`) |
| 24 | low | No machine binding; a copied token is a full impersonation | `agent-store.ts:444-451`, `agent-services.ts:173-174` | built (install id) |
| 25 | low | Kit and project tokens have no `created_by` | `routes/runner-kits.ts:87,128`, `routes/agents.ts:145` | built |
| 26 | low | Removing a project's access does not stop its running task | `agent-services.ts:272-278` | not built (sessions do end) |
| 27 | low | Per-task upload caps can be passed by parallel uploads | `routes/agents.ts:292-297`, `agent-services.ts:324-325` | built (reserved per process) |
| 28 | low | `AgentStore.claim()` has no access check (test-only) | `agent-store.ts:588-592` | built (removed) |
| 29 | low | The "capable runner online" check for code scripts counts shared runners that dispatch then refuses, so the run waits 30 minutes | `agent-services.ts:774` against `:228` | built (same rules as offering) |
| 30 | low | Agent rate limits apply after the token lookup; no per-address limit | `routes/agents.ts:204-208`, `deploy/c4t-box/nginx-site.conf` | per-address limit on the enroll route only |
| 31 | low | A runner cannot see a matching task behind 50 non-matching ones | `agent-store.ts:527-535` | not built |
| 32 | low | Re-offers are silent; a file named in a result but never uploaded vanishes | `agent-store.ts:639`, `agent-services.ts:851` | built (`runner_requeued`, `runner_file_missing`) |
| 33 | low | `ranOn` after 24 h names the project's current pin | `agent-services.ts:581-586` | built (`ran_on_json`) |
| 34 | low | Every runner artifact stored twice for 24 h, and pruned only on the scheduler tick | `repo-sink.ts:180`, `schedule-services.ts:63` | built (pruning in `runners` mode); double storage not changed |
| 35 | low | The Run panel rewrites the project setting for everyone | `web/src/features/runs/RunMenu.tsx:199-203` | built |
| 36 | low | Buttons shown to people the server then refuses; `/agent-tokens` polled into 403s | `AgentsList.tsx:27-56`, `ProjectRunners.tsx:24,46-77`, `RunnerChoicePanel.tsx:139-142` | built on the Runners pages |
| 37 | low | Removing a project's own runner skips `canManageRunner` | `routes/agents.ts:155-159` | built |
| 38 | low | A kit token for a project with no organisation gets organisation null, which counts as a Crowd4Test shared runner | `agent-store.ts:325`, `runner-health.ts:48` | built (such a runner serves only its project) |
| 39 | low | Mac LaunchAgent retries for ever after revocation; Mac logs grow without bound | `runner-setup.sh:1095-1097,1151-1166` | built (not run on a Mac) |
| 40 | low | No display check for headed runs | `src/agent/capabilities.ts:155-158` | built (`no-display`) |
| 41 | low | The agent's version is a constant `"1.0.0"` | `src/agent/config.ts:18` | not built (`kitVersion` is the real version) |
| 42 | low | Wrong production copy on the runner, run and phone pages | section 6 | built |
| 43 | docs | `docs/features/runner-agent.md:77-78` says a token belongs to one project and six routes skip the key; the code has `runner_access` and 11 routes | `agent-routing.ts:35-51` | fixed (`docs/features/runner-agent.md`) |
| 44 | CI | `runner-matrix-workflow` fails in the fast tier; most runner tests are not in CI | `tests/runner-matrix-workflow.test.ts` (ran) | the test passes; CI lists being added at integration |
| 45 | PostgreSQL | Device reservation race, two writers on one job stream, polling load, `log_json` updated without a row lock | section 5 | not built in this round |

---

## 10. Requirements R1 to R15

| ID | Requirement (short) | Before this round | What existed | Main gaps | This round |
|---|---|---|---|---|---|
| R1 | Website is the control plane; the agent is headless; no second dashboard | partial | Runners, grants, where tests run, updates and runs all on the website; the agent serves no local web page | Windows tray app and Mac Terminal window; plain kits need an open console | built (background by default, tray as the only sign) |
| R2 | One TypeScript/Node agent for Windows 10/11 and macOS arm64/x64; OS modules only for OS integration | exists | one bundle, five complete downloads | agent version is a constant | kept; agent version still a constant |
| R3 | Installers (.exe, .pkg/.dmg), runtime, background start, secure enrollment, uninstall, trusted updates, signing documented | partial | Windows setup program and Mac app inside zips; Node installed with checksums; uninstall; automatic updates | no standalone .exe or .pkg; opt-in autostart; token in the zip; unsigned updates; no code signing | built: enrollment, default autostart, `.pkg` script, signed updates, gated signing steps; not done: the signing key, certificates |
| R4 | Background execution in the person's session; LaunchAgent; headless by default; headed only in the session | partial | session-based on both, deliberately; headless by default | opt-in; no display check for headed runs | built: default on, display check |
| R5 | Runner identity (id, machine, name, OS and version, arch, agent version, status, heartbeat, capabilities) | partial | ids, name, OS, arch, version, last seen, computed online/busy/offline, capabilities | OS version, machine install id, memory; pin is on a machine row | built: identity fields and install id |
| R6 | Short-lived enrollment, no secret in the installer, OS credential store, rotation, revocation, isolation, no secrets in responses | partial | authorised minting, revocation, refusal of unknown agents, organisation isolation, write-only secrets | no enrollment exchange, token in every download, no OS store, no rotation or expiry | built (decisions 6 and 7) |
| R7 | Outbound HTTPS, persistent channel, heartbeat, ack, events, reconnect, versioned typed messages, ids, idempotency | partial | outbound long poll, heartbeat and lease, back-off, typed zod messages, version 1 | no accept or reject, no attempt id, no event ids, not idempotent, thin live events, no server-to-agent timeout/config/shutdown | built: protocol 2 (decision 9) |
| R8 | Lifecycle QUEUED to COMPLETED with REJECTED, FAILED, CANCELLED, TIMED_OUT, LOST_CONNECTION; reconciliation | partial | conditional updates, re-offer once, four timeout layers, cancel | phases collapsed into `running`; orphaned task after a worker crash; tests marked failed after a runner failure | built: phases, fencing, reconciliation fixes |
| R9 | Adapter architecture, Playwright first, existing tests unchanged, browsers, artifacts, step events, failure details | partial | the platform's own adapters; browser set-up; screenshots, traces, videos | no live step events; code scripts unreachable on installed runners; no separate stack-trace field | built: live events (Playwright web and API steps) and code-scripts switch |
| R10 | Capability discovery and matching before dispatch | partial | browsers, Android, iOS, Windows UI Automation; matched at creation and at dispatch | OS version, memory, CPU, Playwright version, adapter list | built |
| R11 | Runners section, install per OS, offline help, Run with runner choice, live view over SSE, nothing lost on refresh | partial | list and status, three-step install, SSE with resume, events kept | unreachable in production; no per-run choice; no live steps or screenshots; install only per project; misleading copy | built |
| R12 | Data: runner, credential, capability, heartbeat, job, event, artifact; ownership; object storage; time-limited links; no paths to the agent | partial | all core tables; ownership; transactions; no paths or storage credentials to the agent | local disk only; no signed links; job-to-runner link lost after 24 h; no foreign key on `job_id` | built: where it ran kept; not built: S3 and signed links |
| R13 | Untrusted runner, encrypted transport, authz, integrity, isolation, masking, audit, honest limits | partial | strict input validation, scoped claims, encrypted payloads, allow-listed child environment | no signatures; same-user tests can read the token; exact-string masking; unscrubbed task log; thin runner audit | built: most controls; not built: OS-level isolation |
| R14 | Autostart, graceful stop, crash recovery, reconnect, timeouts, cleanup, disk checks, log rotation, health, concurrency, no shared workspace | partial | crash restart, back-off, per-task folders, concurrency 1 to 8, start-up checks, server disk wait | opt-in autostart; Windows hard kill; result lost on outage; Mac logs unbounded; no per-task disk check; one job at a time platform-wide | built: most; not built: per-task disk and resource limits, runs across a deploy |
| R15 | Agent, backend, integration and real-installer tests | partial | broad unit and integration tests on Linux | little in CI; no browser test with a real runner; Mac never real; Windows 10 never | built: new tests and the journey test; matrix workflow not run; manual pass not done |

---

## 11. Decisions taken (2026-11-07)

The audit raised product questions. These are the answers the design is built to, in plain words. The numbers match the other documents in this folder.

1. **The hosted platform runs tests only on runners.** A new setting, `EXECUTION_MODE`, is `local` by default (today's behaviour, for self-hosting and development) or `runners` (production). In `runners` mode the server never runs test code and never opens a browser for a run. A dispatch worker in the API process hands runner jobs to runners, several at once. "This server" is not offered. *Answers: should "run here" disappear on the hosted product, and is a worker on the box acceptable.*
2. **Two kinds of runner.** Team runners are today's runners, managed by people with `ai_studio.runners.manage`. Personal runners are new: anyone who may run tests in some project, testers included, may add their own computer. A personal runner takes only runs its owner starts, plus their own schedules, in projects the owner can still run tests in and that allow people's own computers. It never takes anyone else's run. At most 5 active personal runners per person. *Answers: may a tester add their laptop, and who owns it.*
3. **A project switch, "Allow people's own computers"**, on by default, changed by whoever may change project settings. When it is on, the project's test accounts (passwords, TOTP secrets, API tokens, saved sessions) reach the owner's computer for their runs. The help text says so plainly. *Answers: may a customer's accounts reach a tester's machine.*
4. **Code scripts** (hand-written, imported, from Git) run on a personal runner by default; its owner can switch that off. Team runners keep today's rule (only when started to allow them, never on Crowd4Test shared runners), plus an admin switch on the runner. *Answers: may code projects run on installed runners.*
5. **Private and local addresses** (localhost, the local network, link-local): a personal runner refuses them by default, and its owner can allow them. Team runners keep today's behaviour.
6. **Enrollment.** No download or installer carries a long-lived credential again. The website makes a single-use enrollment code, valid 30 minutes and stored hashed. The runner trades it at first contact for its credential and deletes the code. An expired or used code gets a plain answer. The runner asks for a new credential every 30 days and when the server says so; the old one keeps working until the new one is first used, for at most 24 hours. *Answers: short-lived enrollment, credential life and rotation.*
7. **Credential storage:** Windows DPAPI for the current user, the macOS login Keychain, a 0600 file on Linux. This protects against other users and a copied disk, not against programs running as the same user.
8. **Background:** a per-user agent that starts at sign-in, on by default (Windows: hidden start under the tray host; macOS: a LaunchAgent). No Windows service or LaunchDaemon, because it would run customers' code with system rights and Session 0 has no desktop. It runs while the person is signed in; a locked screen is fine. Headed runs only where a display exists; otherwise the run is refused with a sentence. *Answers: background by default, and whether a before-sign-in mode is needed.*
9. **Transport stays HTTPS long poll.** Protocol 1 exists, passes nginx and needs no new package. Protocol 2 is added beside it: attempt ids, accept and reject with re-offer, idempotent results, typed live events with ids and sequence numbers. Protocol-1 agents keep being served.
10. **Updates must be signed** with Ed25519, with the public key pinned in the runner. A runner refuses any update whose signature does not check, and the Runners page then says a new version can be downloaded by hand. Without the signing key the deploy publishes no update offers. *Answers: automatic silent updates.*
11. **OS code signing** (Authenticode, Developer ID and notarisation) is not bought yet. The signing steps are built to run only when the certificates are configured. The unsigned notices stay.
12. **One active job per runner by default**, configurable from 1 to 8.

Also settled: a person can choose a runner for one run without changing the project's setting. Without a choice, the project's pinned runner is used, else any eligible runner.

## 12. Questions still open

- Should a new runner need approval before it gets work? Not decided; not built.
- What are customers told when a Crowd4Test shared runner receives their project's test accounts? Shared runners were not changed in this round.
- How long should failure traces and videos from runner runs be kept, given they hold typed passwords (checked in this round)?
- Should the test-data reset and the saved sign-in check move onto the runner? This round handles them in `runners` mode without a server browser; moving them onto the runner is not built.
- Should a run whose runner lost its connection be retried automatically? Today, and in this round's design, it is offered once more and then fails.
- When will certificates for Windows and Apple signing be bought, and who holds them?
- Which real Windows 10, Windows 11 and Mac (Apple chip and Intel) machines will be used for the manual pass in `MANUAL_VERIFICATION.md`?
