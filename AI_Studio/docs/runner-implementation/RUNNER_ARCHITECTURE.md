# Runner architecture

How AI Studio runs tests on runners installed on testers' computers. Written 2026-11-07, starting from commit `e344261`, and brought in line with the code after the build the same day.

Every capability below carries one of three labels:

- **Built**: in the code. "Built before this round" means it was already in `e344261`; references with a line number point at that commit. References without one name a file and function in the current tree.
- **Not built**: not in the code, with the reason.

A "Built" label means the code exists. It does not mean it was run on a real Windows or Mac computer. `MANUAL_VERIFICATION.md` covers that.

Related documents in this folder: `CURRENT_STATE_AUDIT.md` (what existed before this round), `AGENT_COMMUNICATION_PROTOCOL.md` (every message), `JOB_EXECUTION_LIFECYCLE.md` (job states and failures), `SECURITY_DESIGN.md` (threats and controls), `IMPLEMENTATION_PLAN.md`.

## The goal in one paragraph

Everything stays on the website and the backend: projects, tests, AI, schedules, history, reports and runner management. Only test execution happens on a runner, a background program on a tester's Windows 10/11 or macOS computer (Apple chip or Intel). A person clicks Run on the website. The backend picks a runner that may take the run, is online and can run it. The runner runs the test with the same engine the platform uses. Progress, logs and screenshots come back while it runs. The final report shows on the website and is still there after a refresh.

## The three parts

| Part | Where it runs | What it owns | What it never does |
|---|---|---|---|
| Website | The person's browser (`web/src`) | Every screen: Runners pages, adding a computer, the Run panel, the live run view, reports, settings. It is the only dashboard. | Talk to a runner directly. |
| Backend | The platform's API process (`src/main.ts`, `src/platform`) | Who may do what, the job queue, choosing a runner, the task record and its phases, events, artifacts, schedules, enrollment codes and credentials, updates. It is the source of truth for every state. | In `runners` mode: run test code or open a browser for a run (built: `src/platform/runner-only.ts`). |
| Runner agent | The tester's computer (`src/agent`) | Connecting out to the backend, reporting what the computer can do, running one task at a time in its own folder and process, sending progress, files and the result, keeping its credential, updating itself. | Listen on a port, show its own dashboard, decide which runs it may take (the backend decides; the agent only refuses what it cannot or must not run). |

The agent has no window and no local web page (no `listen` or `createServer` in `src/agent`). On Windows the tray icon is the one visible sign. It is a control (start, stop, open the log), not a dashboard.

## Component diagram

```
 PERSON'S BROWSER                 HOSTED PLATFORM (one API process)                  TESTER'S COMPUTER
+--------------------+   HTTPS   +----------------------------------------+  HTTPS  +-------------------------------+
| Website (web/src)  |---------->| Website routes  src/platform/routes/*  |<--------| Runner agent  src/agent       |
|  Runners pages     |           |   runs, suites, schedules, runners,    |  agent  |  client.ts   hello, poll,     |
|  Add this computer |           |   runner-choices, runners/enroll       |  calls  |              heartbeat, files,|
|  Run panel         |<----------|                                        |   out   |              result, events   |
|  Live run view     |    SSE    | Job queue        generation_jobs       |  only   |  task-runner.ts  one slot per |
+--------------------+  (events) | Dispatch worker  (runners mode)        |         |    task, folder per task      |
                                 |   RemoteExecutor -> agent_tasks        |         |    +-------------------------+|
                                 | Agent routes     /api/agent/*          |         |    | task-child.ts (process) ||
                                 |   (own token check, allow-list)        |         |    |  src/engine/frameworks  ||
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

A setting, `EXECUTION_MODE` in `src/config.ts`, says where tests may run. Built.

| Mode | Who uses it | What happens |
|---|---|---|
| `local` (default) | Self-hosting and development | Today's behaviour, unchanged. A worker runs jobs: in the API process when `WORKER_EMBEDDED` is true (`src/main.ts:45-53`), or as a separate worker process. Each project chooses "this server" or "a runner" (`runner_settings.run_on`). |
| `runners` | The hosted platform | The server never runs test code and never opens a browser for a run. A dispatch worker inside the API process takes jobs and hands them to runners, several at once (`DISPATCH_CONCURRENCY`, default 8; the one-active-job-per-project rule stays). Every project routes to runners without rewriting its stored setting. A pinned runner still applies. "This server" is not offered. |

In `runners` mode (built; `docs/features/runner-only-mode.md`):

- `PUT /api/projects/:id/runner` with `platform` is refused with a plain sentence (`PLATFORM_SETTING_REFUSED`).
- Only runs of existing tests (`validate`, `variants`, `environment`: `RUNNER_JOB_MODES`) are made; exploring, a test described in words, agent runs and security assessments are refused when made (`assertRunsOnRunner`, called by `Repo.createJob`).
- Inside a runner job, the steps that used a server browser are skipped or refused with an honest event: the saved sign-in is not checked first (it goes to the runner with the tests), browser repair is not offered (`repair_browser_skipped`), mailbox steps fail on the runner with their own message, and the test-data reset is sent only to a public address.
- A last-line guard makes the local executor and the server's browser launch helpers throw `SERVER_RUN_REFUSED`, so a missed path fails loudly instead of running. The report PDF is the one browser the server still opens (its own static page, scripts off).
- Schedules fire and hand their jobs to runners. Housekeeping (sweep, prune) runs.
- `/api/config` reports `executionMode`. The dispatch worker writes the worker heartbeat that `/readyz` reads.
- The deploy script writes `EXECUTION_MODE=runners` and keeps `WORKER_EMBEDDED=false` (`deploy/c4t-box/deploy.sh`).

Why a new mode instead of turning the worker on: with `WORKER_EMBEDDED=true` every project could run on the server, and a new project defaults to "this server" (`src/platform/agent-store.ts:488-491`). The hosted server keeps secrets that customer test code must never be able to read.

### Why nothing could run on a runner in production before this round

Built behaviour at `e344261`, in short (`CURRENT_STATE_AUDIT.md` has the full trace):

1. Every run start calls `runsCanStartHere` (`src/platform/suite-run.ts:30-35`). It looks only at `WORKER_EMBEDDED` and a worker heartbeat, not at where the project's tests run. Production has no worker, so every run is refused.
2. Even without that refusal, the runner task is made by `RemoteExecutor` (`src/platform/agent-services.ts:653`), which runs inside a worker's job (`src/platform/job-runner.ts:175`). No worker means no task, so the runner's poll stays empty.

The dispatch worker in `runners` mode fixes both (`Worker.dispatch`, `src/platform/worker.ts`, started in `src/main.ts` even with `WORKER_EMBEDDED=false`).

## Two kinds of runner

A runner is a credential (`agent_tokens` row). The computer it runs on is an `agents` row (`src/platform/agent-store.ts:99-129`).

| | Team runner | Personal runner |
|---|---|---|
| Status | Built (machine-level runners, migration 42; kind `team` from migration 51) | Built (migration 51, `PERSONAL_RUNNERS_MIGRATION` in `src/platform/agent-store.ts`) |
| Belongs to | An organisation (`organization_id`), or Crowd4Test's shared pool when that is null | One person (`owner_id`) |
| Who may add one | People with `ai_studio.runners.manage` who pass `canManageRunner` (`src/platform/runner-health.ts:31-45`). Testers cannot. | Anyone who holds `ai_studio.tests.run` in at least one project they can open, testers included |
| Which runs it takes | Runs of projects granted to it in `runner_access`, within its organisation's projects (`runner-health.ts:48`); a shared runner may serve any project | Only runs its owner starts, plus runs of schedules its owner made, in projects the owner can still open with `tests.run`, and only where the project allows people's own computers. Never anyone else's run. |
| Limit | One per project for project kits; 50 per organisation (`MAX_RUNNERS_PER_ORGANIZATION`) | 5 active per person (`MAX_PERSONAL_RUNNERS`) |
| Code scripts (hand-written, imported, Git) | Off by default: only when the agent was started with `--allow-custom-scripts`, or a runner manager turns on the runner's switch (`allow_code_scripts`). Never on a Crowd4Test shared runner. | On by default (`allow_code_scripts`). The owner can switch it off. Enforced when the task is offered (`mayRunCodeScripts`) and again by the agent. |
| Private and local addresses (localhost, LAN, 169.254.x) | Allowed, as before (`allow_private_targets` 1) | Refused by default (`allow_private_targets` 0). The owner can allow them. Checked at offer and on the runner (`src/agent/address-guard.ts`). |
| Who may rename, change switches, retire | Runner managers, as before (private addresses and the phone switch are not switches of a team runner) | Switches: the owner only. Rename and retire: the owner and platform admins |
| A connected real phone | Not changed | Only when the owner turns on "Use my connected phone" (`allow_real_phone`); emulators otherwise |
| Recordings, live sessions, phone sessions | The project's rules | Only for its owner |

Each project has a switch "Allow people's own computers" (`runner_settings.allow_personal`). It is on by default and changed by people with `project.settings`. A project with no `runner_settings` row counts as on. When it is on, the project's test accounts (passwords, TOTP secrets, API tokens, saved sessions) reach the owner's computer for the owner's runs. The setting's help text says so. Changed with `PUT /api/projects/:id/runner { allowPersonal }`. Built.

### Choosing a runner for a run

Built:

- Every run-start route a person uses accepts an optional `runnerId` (an `agent_tokens.id`), carried into the job as `options.runner`. It applies to that run only and never changes the project's setting. Runbook runs and deploy triggers keep the project's setting.
- With `runnerId`: only that runner may take the run. It must be one the person may use for this project (else 404), online and capable (else 409 with the reason).
- Without it: the project's pinned runner (`runner_settings.agent_id`), else any eligible runner.
- `GET /api/projects/:id/runner-choices` lists the runners this person may use for this project: their own personal runners and the team runners granted to it. Each entry carries its kind, whether it is theirs, online, busy, the machine, whether it can run web and phone tests and code scripts, and a plain `problem` sentence. Needs `tests.run` on the project.

Built before this round, kept: the claim is pull-based and oldest first. Whichever capable runner polls first gets the task (`agent-services.ts:199-235`).

## Enrollment and credentials

### Before this round (built)

Every download carried a long-lived runner credential. A kit download mints an `aitg_` token and writes it into the zip as `runner.token` (`src/platform/routes/runner-kits.ts:87-90`). The token is kept as a plain file: on Windows with its access list reduced to the current user (`installer/win/Engine.cs:500-517`), on a Mac with mode 0600 (`installer/mac/app/Contents/Resources/runner-setup.sh:784`). It never expires and cannot be rotated.

The credential itself is sound: `aitg_` plus 32 random bytes (`agent-store.ts:163`), stored only as a SHA-256 hash with a 4-character hint, compared in constant time, revocable.

### From this round (built)

No download or installer carries a long-lived credential again.

1. On the Runners page the person chooses "Add this computer" (personal) or "Add a team runner".
2. The website calls `POST /api/runners/enroll` (or `POST /api/runners/kits` for a download). The backend makes a single-use enrollment code: `aite_` plus 32 random bytes, stored hashed, valid 30 minutes (`runner_enrollments`, migration slot 51).
3. The download embeds the code as `runner.enroll` (mode 0600) and answers with the headers `x-runner-enrollment-id` and `x-runner-enrollment-expires`; the page never sees the code and follows it with `GET /api/runners/enrollments/:id`. The page can also show a copyable command with `--enroll <code>`.
4. The installer starts the runner with `--enroll-file`. Old installs that still have `runner.token` keep working.
5. At first contact the agent calls `POST /api/agent/enroll` with the code, its name, a random install id (`machineId`, kept in `runner.machine`) and optionally its version and capabilities. The answer is `{ token, runnerId, kind }`: the runner credential (`aitg_`), given once. If the answer is lost, the same install id may ask again while the code is valid and the first credential was never used.
6. The agent saves the credential in the operating system's store and deletes the code file.
7. An expired or used code gets a plain answer: make a new one on the Runners page.

Rotation: the agent asks `POST /api/agent/rotate` for a new credential when the hello answer says `rotate: true` (the credential is 30 days old); a runner that stays connected says hello once a day to check. The old credential keeps working until the new one is first used, for at most 24 hours. A lost answer therefore never locks the agent out.

Machine binding: the backend binds a credential to the first `machineId` it sees. The same credential from another `machineId` is refused with a plain error and an Activity entry. Agents too old to send a `machineId` keep today's behaviour.

### Where the credential is kept (built)

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

Built before this round:

- The backend offers an update in the hello answer (`update`), in the `x-runner-update` header of a poll answer, and through `POST /api/agent/update`. Files come from `GET /api/agent/update/files/:name` (`src/platform/routes/runner-updates.ts:45,54`).
- The runner stops taking tasks, downloads the files over its authenticated connection, checks each file's SHA-256 against the offer, runs a self-test, switches, and exits with code 75 so its host starts it again. It rolls back after 3 starts with no connection (`src/agent/updater.ts:1-21`). Back-off is 5, 15 and 45 minutes, at most 3 tries an hour.
- The owner can switch updates off per runner (`AITP_UPDATES=0`, or the switch on the Runners page).
- The installer programs and their private Node.js are not updated by this.

The gap was that the checksums came from the same platform. They catch damage, not a compromised server or build artefact.

Built in this round (`docs/features/runner-updates.md`):

- The deploy signs the update manifest (version, a sequence number, file names, sizes, SHA-256) with Ed25519, using `node:crypto` (`scripts/sign-runner-update.mjs`). The private key lives only in a GitHub Actions secret, `RUNNER_UPDATE_SIGNING_KEY`. Without a valid signature the platform offers no update (`src/platform/runner-update.ts`) and the deploy log says so.
- The public key is pinned in the runner bundle (`PINNED_UPDATE_KEYS`, `src/agent/update-keys.ts`; empty until the owner makes the key pair). The runner refuses any update whose signature, file list or sequence does not check, before downloading anything. It keeps running and reports `update.state: "needs-manual"`, and the Runners page says a new version is available to download by hand.
- The plain kit, the Windows installer and the updater use `npm ci --ignore-scripts` with a shipped `package-lock.json`.

Operating-system code signing (Authenticode on Windows; Developer ID and notarisation on macOS): no certificates bought yet. The signing steps are built in the deploy workflow, each skipped with a log line when its secrets are absent. A Mac `.pkg` is built by `scripts/build-runner-pkg.sh`; the zip stays the default download until a real Mac pass is green. The download pages keep their plain notices that the files are not signed.

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

| Data | Where | Status |
|---|---|---|
| Runner and its credential hash | `agent_tokens` | Built; `kind`, `owner_id`, `allow_code_scripts`, `allow_private_targets`, `allow_real_phone`, `machine_id`, `rotated_at`, `previous_hash`, `previous_until_ms` from migration 51 |
| Computer, its capabilities, last seen | `agents` | Built; `os_version`, `machine_id` (51) and `protocol` (53) |
| Which projects a team runner serves | `runner_access` | Built |
| Project's runner setting | `runner_settings` (`run_on`, `agent_id`) | Built; `allow_personal` (51) |
| Enrollment codes (hashed) | `runner_enrollments` | Built (51) |
| Who made a schedule | `schedules.created_by` | Built (52) |
| The job | `generation_jobs` | Built |
| The runner task, its payload and result | `agent_tasks`. Payload and result are encrypted at rest with AES-256-GCM (`src/platform/secrets.ts:58-65`). Finished tasks are removed after 24 hours. | Built; `owner_id` (51); `phase`, `phase_ms`, `attempt`, `attempt_id`, `accepted_ms`, `rejections_json`, `result_attempt_id` (53); where the run happened is kept in `generation_jobs.ran_on_json` (53), which survives the 24-hour prune |
| Live-event duplicates check | `agent_task_events`, keyed by task, attempt and sequence number | Built (53) |
| Job events (progress, live steps, screenshots) | `agent_events`, kept with the job, not pruned after 24 hours | Built; the `runner_*` kinds added |
| Files sent to and from the runner | Object store: `<project>/_agent/<task>/in/` and `.../out/<name>`, with size and SHA-256 in `agent_task_files` | Built |
| Artifacts people see | Copied by the result sink to `<project>/_artifacts/<test>/job-…/attempt-n/` with an `artifacts` row | Built |

The object store is `LocalDiskStore` under the data folder (`src/platform/object-store.ts:294-298`). S3 is not built, so there are no time-limited upload or download links. Every file is streamed through the API. The runner never receives a storage path or a storage credential, only safe file names and hashes.

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

Built. Job events go into `agent_events`. The website reads them over server-sent events: `GET /api/test-generation/:jobId/stream` and `GET /api/projects/:id/stream` (`src/platform/routes/stream.ts:208,236`), with a one-use stream ticket. A reconnect sends `Last-Event-ID` and gets every missed event. A first visit gets the last 500. A refresh therefore rebuilds the view from stored events.

Built in this round: the runner's live events are stored as job events with kinds such as `runner_test_started`, `runner_step`, `runner_test_finished`, `runner_screenshot` and `runner_log`, so the same stream carries them and a refresh replays them. The task's phase and the runner that took it are exposed on the run (`ranOn: { kind, agentId, name, runnerId, phase, attempt }`), and the run page shows them (`web/src/features/runs/LiveRun.tsx`).

## Decisions and their reasons

Taken on 2026-11-07.

| # | Decision | Reason |
|---|---|---|
| 1 | The hosted platform runs tests only on runners (`EXECUTION_MODE=runners`). A dispatch worker in the API process hands jobs to runners, several at once. "This server" is not offered. | Customer test code on the shared server could read the server's secrets. The worker that existed ran one job at a time and lived only where tests also ran on the server. |
| 2 | Two kinds of runner: team runners as today, and personal runners owned by one person, who may be a tester. A personal runner takes only its owner's runs and schedules. At most 5 per person. | Testers need to run tests on their own computer without an administrator. One person's computer must never run another person's work. |
| 3 | Each project has "Allow people's own computers", on by default, changed with `project.settings`. | The project's test accounts reach the owner's computer. A project owner who does not accept that can switch it off, and the help text says so plainly. |
| 4 | Code scripts run on a personal runner by default; the owner can switch that off. Team runners keep `--allow-custom-scripts`, plus an admin switch on the runner. Never on Crowd4Test shared runners. | On their own computer a person already runs the project's code. A machine that serves many customers must not run one customer's code. The switch lets installed team runners opt in without editing a start command. |
| 5 | A personal runner refuses private and local addresses by default; the owner can allow them. | A test should not reach into the tester's home or office network by surprise. |
| 6 | Single-use enrollment codes, 30 minutes, traded for the credential at first contact. Rotation every 30 days with a 24-hour overlap. | A download sitting in a Downloads folder must not be a working credential. Rotation limits how long a copied credential is useful. |
| 7 | The credential is kept in DPAPI (Windows), the login Keychain (macOS), a 0600 file (Linux). | It protects against other users and a copied disk. The documents say plainly that it does not protect against programs of the same user. |
| 8 | A per-user background agent that starts at sign-in, on by default. No SYSTEM service, no LaunchDaemon. Headed runs only where a display exists. | Session 0 and daemons have no desktop, and a service would run customer code with full rights. |
| 9 | Transport stays HTTPS long-poll. Protocol 2 is additive: attempt ids, accept and reject, idempotent results, typed live events. Protocol-1 agents keep working. | See below. |
| 10 | Updates must carry an Ed25519 signature checked against a key pinned in the runner. No signing key, no update offers. | A checksum from the same server cannot stop a compromised server from pushing code to every tester's computer. |
| 11 | OS code signing steps are built but gated on secrets that may be absent. Unsigned notices stay. | No certificates bought yet. The build must not fail without them, and people must be told the truth. |
| 12 | One active job per runner by default, configurable 1 to 8. | A tester's computer is also their work computer. The setting exists already (`--concurrency`, `src/agent/config.ts:237-239`). |

### Why HTTPS long-poll and not WebSocket

- It exists and works: protocol 1 is built and tested (`src/agent-protocol/schema.ts`, `src/platform/routes/agents.ts`).
- It passes the production proxy as it is (nginx allows long requests, `proxy_read_timeout 3600s`) and company proxies that only allow ordinary HTTPS.
- It needs no new package. The project adds no dependencies for this work.
- The website already uses server-sent events for the browser side (`src/platform/stream-core.ts:1-8` explains that choice). Both directions stay plain HTTP.
- The cost is a little delay: commands to a runner ride on the answer to its next heartbeat or poll (about every 10 seconds during a task, one long poll of up to 25 seconds when idle). For test runs this is acceptable.

## What this design does not cover yet

- S3 storage and time-limited links (not built).
- PostgreSQL for the runner tables: the schema is ready, the stores still use the synchronous database interface (not built in this round).
- AI authoring and exploring on runners: refused in `runners` mode (not built).
- Run sequences (runbooks) across a restart: a sequence is not resumed. At a deploy it ends as interrupted while the test run of its current step, when it already runs on a runner, carries on and finishes (runs on runners themselves survive a deploy or restart and are picked up again: `docs/features/runner-restarts.md`).
- The agent's own version: still the constant `"1.0.0"` in `src/agent/config.ts`; a downloaded runner reports its `kitVersion`.
- OS-level isolation of test processes (sandbox, separate user): not built. Tests run with the rights of the person's account.
- A real pass on Windows 10/11 and on Macs with Apple chip and Intel: see `MANUAL_VERIFICATION.md`.

## Round 45 (2026-11-11): one runner per person

This document describes rounds 39 to 44 as they were built. Round 45 replaced the team and shared runners with one simple model; where the text above says otherwise, this section wins.

- **One runner per person**, set up once in Settings (`#/settings#runner`) and used for every run that person starts, in every project they may run tests in. Setting up a computer again retires the person's earlier credential; there is no cap list (the 5-computer cap is gone).
- **Removed:** team runners, Crowd4Test's shared runner, project runner tokens and kits (`/api/projects/:id/agent-tokens*`, `/runner-kits*`), runner access (`/runner-access*`, `runner_access`), the per-run choice (`/runner-choices`, `runnerId` is accepted and ignored), the project's pinned runner (`runner_settings.agent_id`), the project switch "Allow people's own computers" (`allow_personal`) and the `/api/runners*` fleet routes. The tables and columns stay; nothing reads them. A team or project credential installed before is refused at every runner route with HTTP 401 and a sentence sending its person to Settings (the runner stops, exit code 3).
- **Routing by owner only:** a run is its starter's (a schedule's or deploy trigger's: its creator's; on an open server: the server's single owner, `"open"`). The claim itself checks the owner. A person's run is refused up front when their runner is not set up or offline (`RUNNER_NOT_SET_UP`, `RUNNER_OFFLINE`, `RUNNER_CANNOT_RUN`); a schedule's or trigger's run waits for the computer. Runs started with the server's shared access key have no owner and are refused.
- **Kept:** protocol 1 and 2 with attempts and hand-over, device reservations, signed updates, the server execution guard, machine binding, rotation, the private-address and owner-only rules, `maySeeSession`. The wire format is unchanged (`/api/agent/*`, hello's `projectId` string, `runner.kind` "personal").
- **New routes:** `GET/PATCH /api/me/runner`, `POST /api/me/runner/retire`, `/update`, `GET /api/me/runner/enrollments/:id`, `POST /api/me/runner/download`; admins: `GET /api/admin/runners`, `POST /api/admin/runners/:id/retire`. Migration 55 records who made each deploy trigger token.
