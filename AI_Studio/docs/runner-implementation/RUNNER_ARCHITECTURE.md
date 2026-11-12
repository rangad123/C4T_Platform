# Runner architecture

How AI Studio runs tests on a runner: a light program on a person's own computer (Windows, macOS, Linux) that connects out to the platform. This document describes the code as it is. The model is **one runner per person**: a person sets it up once in Settings, Your runner, and it is used for every run, schedule, recording and phone session they start. There is no runner picker.

A "built" statement means the code exists. It does not mean it was run on a real Windows or Mac computer: `MANUAL_VERIFICATION.md` covers that.

Related documents in this folder: `AGENT_COMMUNICATION_PROTOCOL.md` (every message), `JOB_EXECUTION_LIFECYCLE.md` (job states and failures), `SECURITY_DESIGN.md` (threats and controls), `MANUAL_VERIFICATION.md`. The round-by-round plan, audit and progress notes are history, in `archive/`.

## The goal in one paragraph

Everything stays on the website and the backend: projects, tests, AI, schedules, history and reports. Only test execution happens on a runner. A person clicks Run on the website. The backend sends the run to that person's runner when it is online and can run the test, and otherwise says plainly why. The runner runs the test with the same engine the platform uses. Progress, logs and screenshots come back while it runs. The final report shows on the website and is still there after a refresh.

## The three parts

| Part | Where it runs | What it owns | What it never does |
|---|---|---|---|
| Website | The person's browser (`web/src`) | Every screen: Settings, Your runner (set-up, switches, removal), the Run panel, the live run view, reports. It is the only dashboard. | Talk to a runner directly. |
| Backend | The platform's API process (`src/main.ts`, `src/platform`) | Who may do what, the job queue, the task record and its phases, events, artifacts, schedules, enrollment codes and credentials, updates. It is the source of truth for every state. | In `runners` mode: run test code or open a browser for a run (`src/platform/runner-only.ts`). |
| Runner | The person's computer (`src/agent`) | Connecting out to the backend, reporting what the computer can do, running each task in its own folder and process, sending progress, files and the result, keeping its credential, updating itself. | Listen on a port, show its own dashboard, decide whose runs it may take (the backend decides; the runner only refuses what it cannot or must not run). |

The runner has no window and no local web page (no `listen` or `createServer` in `src/agent`). On Windows the tray icon is the one visible sign: a control (start, stop, open the log), not a dashboard.

## Component diagram

```
 PERSON'S BROWSER                 HOSTED PLATFORM (one API process)                  PERSON'S COMPUTER
+--------------------+   HTTPS   +----------------------------------------+  HTTPS  +-------------------------------+
| Website (web/src)  |---------->| Website routes  src/platform/routes/*  |<--------| Runner        src/agent       |
|  Settings,         |           |   runs, suites, schedules,             |  runner |  client.ts   hello, poll,     |
|   Your runner      |           |   /api/me/runner*                      |  calls  |              heartbeat, files,|
|  Run panel         |<----------|                                        |   out   |              result, events   |
|  Live run view     |    SSE    | Job queue        generation_jobs       |  only   |  task-runner.ts  one slot per |
+--------------------+  (events) | Dispatch worker  (runners mode)        |         |    task, folder per task      |
                                 |   RemoteExecutor -> agent_tasks        |         |    +-------------------------+|
                                 | Runner routes    /api/agent/*          |         |    | task-child.ts (process) ||
                                 |   (own credential check, allow-list)   |         |    |  src/engine/frameworks  ||
                                 | Event store      agent_events --> SSE  |         |    |  Playwright, Taqwright, ||
                                 | Object store     task files, artifacts |         |    |  iOS, Windows UIA       ||
                                 | Scheduler, sweep, prune                |         |    +-------------------------+|
                                 | Update offers    signed manifest       |         |  file cache, credential store |
                                 +----------------------------------------+         |  updater                      |
                                                                                    +-------------------------------+
                                                                                      started at sign-in by:
                                                                                      Windows: tray host (installer/win)
                                                                                      macOS:   LaunchAgent (installer/mac)
```

Arrows show who opens the connection. The runner always connects out. The backend never connects to the runner. Everything the backend wants to tell a runner rides on the answer to the runner's own request.

## Execution modes

`EXECUTION_MODE` in `src/config.ts` says where tests may run.

| Mode | Who uses it | What happens |
|---|---|---|
| `local` (default) | Self-hosting and development | A worker runs jobs (in the API process when `WORKER_EMBEDDED` is true, or as a separate process). Each project runs its tests on this server or on runners (`runner_settings.run_on`, `PUT /api/projects/:id/runner`). |
| `runners` | The hosted platform | The server never runs test code and never opens a browser for a run. A dispatch worker in the API process hands jobs to runners, several at once (`DISPATCH_CONCURRENCY`, default 8; one active job per project). Every project routes to runners without rewriting its stored setting. |

In `runners` mode (`docs/features/runner-only-mode.md`):

- `PUT /api/projects/:id/runner` with `platform` is refused (`PLATFORM_SETTING_REFUSED`). Recording and phone sessions on the server are refused (`ON_SERVER_REFUSED`).
- Only runs of existing tests (`validate`, `variants`, `environment`: `RUNNER_JOB_MODES`) are made; exploring, a test described in words, agent runs and security assessments are refused when made (`assertRunsOnRunner`, called by `Repo.createJob`). An "Explore again" schedule is refused when it is made (`EXPLORE_SCHEDULE_REFUSED`).
- Inside a runner job, the steps that used a server browser are skipped or refused with an honest event: the saved sign-in is not checked first, browser repair is not offered (`repair_browser_skipped`), mailbox steps fail on the runner with their own message, and the test-data reset is sent only to a public address.
- A last-line guard makes the local executor and the server's browser launch helpers throw `SERVER_RUN_REFUSED`, so a missed path fails loudly instead of running. The report PDF is the one browser the server still opens (its own static page, scripts off).
- Schedules fire and hand their jobs to runners. Housekeeping (sweep, prune) runs. `/api/config` reports `executionMode`. The dispatch worker writes the heartbeat `/readyz` reads.

## One runner per person

A runner is a credential (`agent_tokens` row with its `owner_id`). The computer that connected with it is an `agents` row. A person has at most one (`owner_id` is unique): setting up a computer again (a new download, a new one-time code) replaces their earlier credential, and "Remove this computer" deletes it.

- **Who may have one:** a signed-in person who may run tests (`ai_studio.tests.run`) in at least one project they can open, Crowd4Test testers included (`mayHaveRunner`, `src/platform/runner-health.ts`). On an open server (no access key, nobody signed up yet) the server acts as one person (`OPEN_OWNER_ID`, "open"). The shared access key is nobody's and has no runner.
- **Whose runs it takes:** a run is its starter's; a schedule's or deploy trigger's is its creator's (`jobOwnerId`). The runner is offered only its owner's tasks (`AgentStore.queuedOfOwner`), and the claim checks the owner again, while the owner may still run that project's tests (`ownerMayRun`). Never anyone else's run.
- **Up front:** `AgentService.assertJobAllowed` (called by `Repo.createJob`) refuses a person's run when their runner is not set up, offline or cannot run the tests, with a typed code that links to Settings (`RUNNER_NOT_SET_UP`, `RUNNER_OFFLINE`, `RUNNER_CANNOT_RUN`). A schedule's or deploy trigger's run whose owner's computer is off is made and waits for it. A run with no owner (the access key, an orphaned schedule or trigger) is refused with a sentence.
- **Waiting:** a queued run with no runner able to take it fails after a short grace for a person's run (`AGENT_NO_AGENT_GRACE_SECONDS`, 90 s; they were told up front), and at the queue limit (30 minutes, `QUEUE_MAX_MS`) for a schedule's or trigger's run (`noRunnerWaitMs`). Both end with the same sentence (`noRunnerSentence`), naming the owner for a schedule or trigger.
- **What it can start now:** `GET /api/me/runner` answers the runner with `can: { web, phone, ios, windows, record, recordHeaded, phoneSession }`, each `{ ok, why? }`, in the words of the server's own refusals (`cannotRunSentence`, `recordProblem`, `hostDeviceProblem`; offline: `RUNNER_OFFLINE`). The website shows what the server would say.
- **Sessions:** a recording, a live session or a phone session opens on the caller's own runner (`ownHostFor`, `src/platform/agent-record.ts`): not set up, offline, can't (with the reason), or ok. It is its starter's alone (`maySeeSession`).
- **The owner's switches** (Settings, Your runner; `PATCH /api/me/runner`): code scripts (hand-written, imported, Git; on by default), private and local addresses (off by default), "Use my connected phone" (off: emulators only). They are enforced when a task is offered (`mayRunCodeScripts`, `targetAllowed`) and again on the runner (`src/agent/address-guard.ts`, `task-runner.ts`). The runner's old `--allow-custom-scripts` flag is accepted and does nothing for a person's runner.
- **Admins:** platform admins with `ai_studio.runners.manage` see everyone's runners and may remove one (`GET /api/admin/runners`, `seesEveryRunner`: one rule for the route and the page).
- **A credential the platform does not know** (removed, replaced, or from before the runner reset below) is answered 404 at every runner route with `RUNNER_TOKEN_GONE`: "This runner's token is no longer valid: the runner was removed or replaced. Download the new runner in Settings, Your runner, and use that one instead." Every runner program since the first release stops on it at hello (exit code 3) and prints it after "The platform no longer accepts this runner."; its launchers do not start it again.

## The runner reset (migration 57)

Every runner made before migration 57 was removed: everyone downloads the new runner from Settings, Your runner, and uses only that one. Until then a person has no runner, and the website shows the set-up prompt. The migration (`RUNNER_RESET_MIGRATION`, `src/platform/agent-store.ts`):

- ends a task that was claimed by or running on a removed runner (and a recording or phone session queued for one) as failed with `RUNNER_REMOVED_IN_UPDATE`: "The runner this run was on was removed in an update. Download the new runner in Settings, Your runner, then start the run again." The run gets the same sentence as an event. A queued task nobody claimed stays queued and waits for its owner's new runner under the 30-minute rule;
- writes where a run ran (`generation_jobs.ran_on_json`) for a run that had no snapshot yet, so history still names the runner;
- deletes every credential, computer, enrollment code, device reservation and per-runner update setting, and drops `runner_access`;
- rebuilds `agent_tokens` (no `kind`, `project_id`, `organization_id` or `revoked_at`; `owner_id` unique), `agents` (no `project_id`), `runner_enrollments` (a person's code only), `runner_settings` (only `run_on`) and `runner_update_settings` (no `auto`);
- gives schedules and deploy trigger tokens with no recorded creator one from Activity, once, where that is certain (this ran at every start before).

`pg/baseline.sql` already has this schema, so a PostgreSQL database never runs slot 57.

Routes: `GET/PATCH /api/me/runner`, `POST /api/me/runner/retire` ("Remove this computer"), `POST /api/me/runner/update`, `GET /api/me/runner/enrollments/:id`, `GET /api/me/runner/download/info`, `POST /api/me/runner/download`; admins: `GET /api/admin/runners`, `POST /api/admin/runners/:id/retire`. `GET /api/projects/:id/runner` says where a project's tests run (local mode). `GET /api/projects/:id/agents` lists the caller's own computer with its raw capabilities; the website no longer reads it, tests do.

## Enrollment and credentials

No download or installer carries a long-lived credential.

1. In Settings, Your runner, the person downloads the runner for their computer (`POST /api/me/runner/download`). The backend makes a single-use enrollment code: `aite_` plus 32 random bytes, stored hashed, valid 30 minutes (`runner_enrollments`).
2. The download embeds the code as `runner.enroll` (mode 0600) and answers with `x-runner-enrollment-id` and `x-runner-enrollment-expires`; the page never sees the code and follows it with `GET /api/me/runner/enrollments/:id`.
3. The installer starts the runner with `--enroll-file`.
4. At first contact the runner calls `POST /api/agent/enroll` with the code, its name and a random install id (`machineId`, kept in `runner.machine`). The answer is `{ token, runnerId, kind }` (`kind` is always "personal"): the runner credential (`aitg_`), given once. If the answer is lost, the same install id may ask again while the code is valid and the first credential was never used.
5. The runner saves the credential in the operating system's store and deletes the code file. An expired or used code gets a plain answer: download the runner again from Settings.

Rotation: the runner asks `POST /api/agent/rotate` for a new credential when the hello answer says `rotate: true` (30 days old); a runner that stays connected says hello once a day to check. The old credential keeps working until the new one is first used, for at most 24 hours.

Machine binding: the backend binds a credential to the first `machineId` it sees. The same credential from another `machineId` is refused with a plain error and an Activity entry.

### Where the credential is kept

| System | Store |
|---|---|
| Windows | `runner.credential`, protected with DPAPI for the current user (`System.Security.Cryptography.ProtectedData` through `powershell -NoProfile`, data passed on standard input, never on the command line) |
| macOS | The login Keychain, service "Crowd4Test AI Studio runner", account = the runner's folder (`security`, the token on standard input) |
| Linux | `runner.credential`, mode 0600, not encrypted |

Module: `src/agent/credential-store.ts` (`loadCredential`, `saveCredential`, `deleteCredential`) and `credential-store-os.ts`, keyed to the runner's folder (`AITP_CREDENTIAL_DIR`; a download sets it to its own folder). Only the Linux store has run; the Windows and macOS commands are unit-tested. `--forget-credential` deletes it, for uninstall. `--token` and `--token-file` keep working for development and old installs.

What this protects against: other users of the computer, and a copied disk (Windows, macOS). What it does not protect against: programs running as the same user, including the tests the runner runs. `SECURITY_DESIGN.md` says more.

## Background start

| System | How it starts | Default | Status |
|---|---|---|---|
| Windows | The setup program stays running as a tray app and starts `node runner.mjs` hidden (`installer/win/RunnerHost.cs:115-118`), inside a job object that ends the runner with the tray app (`RunnerHost.cs:269-281`). "Start the runner when I sign in" is a Startup-folder shortcut. | On by default; `--silent` adds it unless `--no-start-at-sign-in` | Built (not run on Windows) |
| macOS | A LaunchAgent in the person's GUI session (`gui/<uid>`, `runner-setup.sh:1022-1024`), RunAtLoad and KeepAlive (`runner-setup.sh:999-1021`). | The LaunchAgent is the default answer and is used by `--silent`; `--no-autostart` keeps the Terminal window | Built (not run on a Mac) |
| Linux | The plain kit's start script in a terminal | No background start | Built (development only) |

The runner works while the person is signed in. A locked screen is fine. It does not run before sign-in or after sign-out.

Stopping (built): the Windows tray app's Stop writes `stop.request` in the runner's folder (the folder of `runner.mjs`), waits up to 25 seconds for the runner to report its task and exit, and only then ends it (`installer/win/RunnerHost.cs`, `src/agent/stop-file.ts`). On SIGTERM, SIGINT or the stop file, the agent reports "The agent was stopped." for running tasks. The Mac loop stops the runner with TERM; when the runner's access is removed (exit code 3) the loop stays stopped until the next sign-in.

Why no Windows service (SYSTEM) and no macOS LaunchDaemon:

- It would run customers' test code as SYSTEM or root, with rights over the whole computer.
- A Windows service runs in Session 0, which has no desktop. Visible browsers and Windows desktop tests cannot work there.
- A LaunchDaemon runs outside the person's GUI session. Visible browsers, simulators and the person's login Keychain are not available to it.
- A per-user agent needs no administrator rights to install, which suits testers' own computers.

Headed runs: browsers run headless unless the run asks for a visible window. A headed run on a computer without a display is refused with a sentence (protocol 2: reject reason `no-display`, `src/agent/task-runner.ts`). Built.

## Updates

- The backend offers an update in the hello answer (`update`), in the `x-runner-update` header of a poll answer, and through `POST /api/agent/update`. Files come from `GET /api/agent/update/files/:name` (`src/platform/routes/runner-updates.ts`).
- The deploy signs the update manifest (version, sequence number, file names, sizes, SHA-256) with Ed25519 (`scripts/sign-runner-update.mjs`, key in the `RUNNER_UPDATE_SIGNING_KEY` secret). Without a valid signature the platform offers no update (`src/platform/runner-update.ts`), and Settings says the new version must be downloaded by hand. The runner checks the signature, file list and sequence against a key pinned in it (`src/agent/update-keys.ts`) before downloading anything.
- The runner stops taking tasks, downloads the files over its authenticated connection, checks each file's SHA-256, runs a self-test, switches, and exits with code 75 so its host starts it again. It rolls back after 3 starts with no connection (`src/agent/updater.ts`). Back-off is 5, 15 and 45 minutes, at most 3 tries an hour.
- Updates are always on server-side. "Update now" in Settings asks for one at once (`POST /api/me/runner/update`). The one opt-out is the runner's own `AITP_UPDATES=0`.
- The installer programs and their private Node.js are not updated by this. OS code signing (Authenticode, Developer ID) is built in the deploy workflow but skipped while its secrets are absent; the download pages say the files are not signed.

## Adapters: the same engine as the platform

Built. The runner does not have its own test engine. The task child calls `getAdapter(adapterId).execute(...)` from `src/engine/frameworks` (`src/agent/task-child.ts:51-57`), bundled from the same source into `task-child.mjs` by `scripts/build-runner.mjs`. Test tools are pinned to the platform's versions.

| Adapter id | Runs | Needs on the runner |
|---|---|---|
| `playwright` | Web tests, and web and API together | A browser: Playwright's Chromium, or the installed Chrome or Edge; Firefox and WebKit when a run first needs them (`src/agent/browser-setup.ts`) |
| `playwright-api` | API tests | The same Playwright runtime |
| `taqwright` | Android tests | adb and a phone or emulator |
| `taqwright-ios` | iOS tests | A Mac with Xcode, the XCUITest driver and a simulator |
| `windows-uia` | Windows desktop tests | Windows, a signed-in session, not elevated, the app on the allow list |

Supported list: `src/agent/task-runner.ts:44`. The backend matches a task to a runner's reported capabilities before offering it (`capabilityProblem`, `src/platform/agent-routing.ts:108-133`), so a macOS-only task never reaches a Windows runner.

Each task runs in its own process (`src/agent/task-process.ts`) and its own folder (`tasks/<taskId>`, removed afterwards). On cancel or timeout the whole process tree is ended. The child gets only an allow-listed environment. The runner's own credential is not passed to it (`task-process.ts:35-43`).

Live step events (built): a small Playwright reporter (`LIVE_REPORTER`, `src/engine/validation/runner.ts`), added only when a runner asks for live events, reports each test, each top-level `test.step` and each failure screenshot of a Playwright web or API run, without changing the scripts. Android, iOS and Windows desktop runs send one `test_finished` per test when the run ends. `AGENT_COMMUNICATION_PROTOCOL.md` has the messages.

## Where data and artifacts live

### On the backend

| Data | Where |
|---|---|
| A person's runner and its credential hash | `agent_tokens` (`owner_id`, unique; `allow_code_scripts`, `allow_private_targets`, `allow_real_phone`, `machine_id`, rotation columns) |
| The computer, its capabilities, last seen | `agents` |
| Enrollment codes (hashed) | `runner_enrollments` |
| Where a project's tests run (local mode) | `runner_settings.run_on` |
| Who made a schedule or a deploy trigger token | `schedules.created_by`, the trigger token's creator |
| The job | `generation_jobs`; where it ran is kept in `ran_on_json` and survives the task prune |
| The runner task, its payload and result | `agent_tasks`, payload and result encrypted at rest (AES-256-GCM); removed 24 hours after they finish |
| Live-event duplicates check | `agent_task_events` (task, attempt, sequence number) |
| Job events (progress, live steps, screenshots) | `agent_events`, kept with the job |
| Files sent to and from the runner | Object store: `<project>/_agent/<task>/in/` and `.../out/<name>`, with size and SHA-256 in `agent_task_files` |
| Artifacts people see | Copied to `<project>/_artifacts/<test>/job-…/attempt-n/` with an `artifacts` row |
| Updates: a pending "Update now" and the last report written to Activity | `runner_update_settings` |

The runner never receives a storage path or a storage credential, only safe file names and hashes. Every file is streamed through the API.

### On the runner

| Data | Where | Status |
|---|---|---|
| Install folder | Windows `%LOCALAPPDATA%\AITestingRunner\`; macOS `~/Library/Application Support/AITestingRunner/` | Built |
| Task folders | `<work dir>/tasks/<taskId>`, deleted after each task; leftovers wiped at start (`src/agent/agent.ts:222`) | Built |
| File cache | `<work dir>/cache`, named by SHA-256 and checked on use, size-capped (2048 MB by default) | Built |
| Credential | The OS store (`runner.credential` on Windows and Linux, the Keychain on macOS); a plain `runner.token` only in older installs | Built |
| Enrollment code | `runner.enroll`, deleted after use | Built |
| Install id | `runner.machine`, next to the runner's settings | Built |
| A finished result waiting to be delivered | `<work folder>/outbox/<task>.json`, kept across an agent restart until the backend answers, dropped after a day (`src/agent/outbox.ts`) | Built |
| Logs | Windows host log, rotated at 2 MB (`RunnerHost.cs:183`); Mac `runner.log` rotated only when the loop starts | Built; the Mac logs are also rotated while running (5 MB, 3 kept) |

The test accounts in a task travel only over the authenticated connection and reach only the child process environment. The agent does not write them to disk (`src/agent-protocol/schema.ts:19-21`).

## How the website sees a run live

Job events go into `agent_events`. The website reads them over server-sent events (`GET /api/test-generation/:jobId/stream`, `GET /api/projects/:id/stream`, `src/platform/routes/stream.ts`) with a one-use stream ticket. A reconnect sends `Last-Event-ID` and gets every missed event; a first visit gets the last 500. A refresh therefore rebuilds the view from stored events. The runner's live events are stored as job events (`runner_test_started`, `runner_step`, `runner_test_finished`, `runner_screenshot`, `runner_log`), and the run carries the task's phase and the runner that took it (`ranOn: { kind, agentId, name, runnerId, phase, attempt }`).

## Operations and test settings

Read straight from the environment, outside the config schema, so tests (and unusual installs) can change them. Defaults are what production uses.

| Variable | Read by | Default | What it does |
|---|---|---|---|
| `AGENT_POLL_SECONDS` | `agentLimits`, `src/platform/agent-services.ts` | 25 | How long an idle runner's poll is held |
| `AGENT_HEARTBEAT_SECONDS` | same | 10 | How often a runner beats during a task |
| `AGENT_LEASE_SECONDS` | same | 60 | A task's lease; a runner that stops beating loses it |
| `AGENT_ACCEPT_SECONDS` | same | 30 | Protocol 2: time to accept a task it was handed |
| `AGENT_NO_AGENT_GRACE_SECONDS` | same | 90 | A person's queued run with no runner able to take it fails after this |
| `AGENT_WATCH_MS` | same | 1000 | How often the executor looks at its task |
| `AGENT_MAX_FILE_BYTES`, `AGENT_TASK_MAX_BYTES`, `AGENT_TASK_MAX_FILES` | same | 64 MB, 512 MB, 300 | Upload limits per file and per task |
| `RUNNER_KIT_DIR`, `RUNNER_COMPLETE_DIR`, `RUNNER_INSTALLER_DIR` | `runner-kit.ts`, `runner-kit-complete.ts`, `runner-installer.ts` | under `dist/` | Where the built runner files are |
| `RUNNER_KIT_RATE_PER_MINUTE` | `routes/runner-kits.ts` | 5 | Downloads a person may make per minute |
| `RUNNER_UPDATE_PUBLIC_KEYS` | `runner-update.ts` | none | Extra update keys, for runners built with another key |

On the runner, `AITP_*` variables (`src/agent/config.ts`, `--help`) mirror its command-line options.

## Decisions and their reasons

| # | Decision | Reason |
|---|---|---|
| 1 | The hosted platform runs tests only on runners (`EXECUTION_MODE=runners`); a dispatch worker in the API process hands jobs to them. | Customer test code on the shared server could read the server's secrets. |
| 2 | One runner per person, used automatically for everything they start; no picker, no team or shared runners. A schedule or deploy trigger runs on its creator's runner and waits for it. | People run tests on their own computer without an administrator, and one person's computer never runs another person's work. One answer to "where does this run" is easier to understand and to keep secure. |
| 3 | Code scripts run on a person's runner by default; the owner can switch that off in Settings. | On their own computer a person already runs the project's code. |
| 4 | Private and local addresses are refused by default; the owner can allow them. | A test should not reach into the person's home or office network by surprise. |
| 5 | Single-use enrollment codes, 30 minutes, traded for the credential at first contact. Rotation every 30 days with a 24-hour overlap. | A download in a Downloads folder must not be a working credential. |
| 6 | The credential is kept in DPAPI (Windows), the login Keychain (macOS), a 0600 file (Linux). | It protects against other users and a copied disk, not against programs of the same user. |
| 7 | A per-user background program that starts at sign-in. No SYSTEM service, no LaunchDaemon. | Session 0 and daemons have no desktop, and a service would run customer code with full rights. |
| 8 | Transport stays HTTPS long-poll. Protocol 2 is additive; protocol-1 runners keep working. | See below. |
| 9 | Updates must carry an Ed25519 signature checked against a key pinned in the runner. | A checksum from the same server cannot stop a compromised server from pushing code to every person's computer. |
| 10 | One active job per runner by default, configurable 1 to 8 (`--concurrency`). | A person's computer is also their work computer. |

### Why HTTPS long-poll and not WebSocket

- It exists and works: protocol 1 is built and tested (`src/agent-protocol/schema.ts`, `src/platform/routes/agents.ts`).
- It passes the production proxy as it is (nginx allows long requests, `proxy_read_timeout 3600s`) and company proxies that only allow ordinary HTTPS.
- It needs no new package. The project adds no dependencies for this work.
- The website already uses server-sent events for the browser side (`src/platform/stream-core.ts:1-8` explains that choice). Both directions stay plain HTTP.
- The cost is a little delay: commands to a runner ride on the answer to its next heartbeat or poll (about every 10 seconds during a task, one long poll of up to 25 seconds when idle). For test runs this is acceptable.

## What this design does not cover yet

- S3 storage and time-limited links.
- PostgreSQL for the runner tables (the baseline has them; nothing runs on it yet).
- AI authoring and exploring on runners: refused in `runners` mode.
- Run sequences (runbooks) across a restart: a sequence is not resumed; the test run of its current step, when it already runs on a runner, carries on (`docs/features/runner-restarts.md`).
- OS-level isolation of test processes (sandbox, separate user): tests run with the rights of the person's account.
- A real pass on Windows 10/11 and on Macs with Apple chip and Intel: see `MANUAL_VERIFICATION.md`.
