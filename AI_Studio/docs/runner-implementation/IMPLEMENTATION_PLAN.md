# Local execution runner: implementation plan

Date: 2026-11-07. Starting point: commit `e344261`. Updated the same day after the build: every work item below is in the tree. Line numbers in "Why this work is needed" are from `e344261`; elsewhere files and function names are the reference.

Related documents in this folder:

- `CURRENT_STATE_AUDIT.md`: what existed before this round, with evidence.
- `RUNNER_ARCHITECTURE.md` and `AGENT_COMMUNICATION_PROTOCOL.md`: the design as built.
- `JOB_EXECUTION_LIFECYCLE.md` and `SECURITY_DESIGN.md`: states, failures, threats and limits.
- `PROGRESS.md`: the dated log of what has landed and which tests ran.
- `MANUAL_VERIFICATION.md`: the checklist for real Windows and Mac computers.

## Goal

Everything stays on the website and the backend: projects, tests, AI, schedules, history, reports and runner management. Only test execution happens on a runner, a background program installed once on a person's Windows 10/11 PC or Mac (Apple chip or Intel). A person clicks Run, the backend hands the run to a runner they may use, the runner runs the test with the same engine as the platform, and live progress, logs and screenshots come back to the website. The final report survives a refresh.

## Status words

Every deliverable below has one of these:

- **built**: in the tree with its tests (Linux). Built before this round where it says so.
- **built (not run on Windows or macOS)**: the code and its Linux tests exist; the operating-system part has not run on a real computer.
- **not built**: not part of this round, with the reason.

Nothing in this plan works in production until it is released through the usual gates and checked on real machines (`MANUAL_VERIFICATION.md`).

## Why this work is needed

The audit found a runner that mostly exists but cannot be used where it matters:

- On the hosted platform no run can start on a runner. Every run start is refused by `runsCanStartHere` (`src/platform/suite-run.ts:30-35`), and even without the refusal nothing would turn the job into a runner task, because that happens inside a platform worker (`src/platform/agent-services.ts:664-757`, called from `src/platform/job-runner.ts:175`), and the hosted platform starts none.
- A tester cannot add their own computer (`src/platform/runner-health.ts:42`).
- Every download carries a long-lived runner token (`src/platform/routes/runner-kits.ts:87-90`), kept in a plain file.
- While a run is going, the website sees only text lines. Steps, screenshots and failures arrive at the end.
- Updates install without asking and are not signed (`src/agent/updater.ts`).
- Start at sign-in is off by default on both installers, and nothing has been proven on a real Mac.

## Work items in this round

| # | Work item | What it delivers | Migration slot |
|---|---|---|---|
| 1 | Runner-only execution | `EXECUTION_MODE` (`local` or `runners`); a dispatch worker in the API process; every project routes to runners; nothing runs on the server in `runners` mode; schedules and housekeeping in that mode; per-run runner choice plumbing; two reliability fixes | 52 |
| 2 | Runner identity and access | Personal and team runners; single-use enrollment codes; the OS credential store; credential rotation; machine identity; owner switches; the project switch "Allow people's own computers"; who may use which runner; the runner-choices list | 51 |
| 3 | Task lifecycle, protocol 2 and live events | Task phases; attempt ids (fencing); accept and reject with re-offer; idempotent and durable results; typed live events stored as job events; server-to-agent commands in the heartbeat answer; secret scrubbing fixes | 53 |
| 4 | Installers, background start, signed updates and CI | Enrollment in both installers; start at sign-in on by default; a graceful stop on Windows; Mac log rotation; Ed25519-signed updates; lockfile installs; a Mac `.pkg` script; OS signing steps gated on secrets; a real-machine workflow; runner tests in CI | none |
| 5 | Website: Runners pages | "Add this computer" and "Add a team runner"; the runner's page with identity, current work, problems, offline help and the owner's switches; buttons only when the server says the person may | none |
| 6 | Website: Run panel, readiness and project setting | No "This server" in `runners` mode; Run enabled when a usable runner is online; a runner choice per run; the project's default runner and the "Allow people's own computers" switch; honest schedule status | none |
| 7 | Website: live run view | Phase, runner, current test and step, counts, live logs and screenshots, errors, duration and the final report, all rebuilt from stored events after a refresh | none |
| 8 | Approved tests stay as approved | A dependency hash on each approved test version; a run holds back a test whose shared steps, helpers or elements changed after approval | 54 |
| 9 | End-to-end journey test | A real platform in `runners` mode, a real agent from source and a real browser: add a computer, run, watch, refresh, disconnect, reconnect, second person isolation | none |
| 10 | Security review of the other runner task kinds | A read-only review of recording, device and phone sessions, live sessions, framework settings sent to runners, the update channel and kit downloads | none |
| 11 | Design documents | The documents in this folder | none |

Work items 1 to 4 were built in parallel against shared contracts (route names, fields and function names written down before the work began). Items 5 to 7 were built against stand-ins first and then against the real routes. Item 10 (a read-only review) led to two fixes that were built in the same round: recordings, live sessions and phone sessions on a person's own computer only for its owner, and the runner's own address guard. Every item is built; integration (see "Integration") is the last step.

## Phases

The phases follow the order the work was asked for. Several phases were worked on at the same time; the phase says what the work is for, not when it was done.

### Phase 1: audit

Goal: know exactly what exists before building anything.

| Deliverable | Status |
|---|---|
| Read-only audit of the agent program, installers, protocol, orchestration, data, website, security, tests and CI, with file and line evidence | built (2026-11-07, `CURRENT_STATE_AUDIT.md`) |
| The open product questions answered by the product owner | built (the decisions in `RUNNER_ARCHITECTURE.md`) |

Exit: the audit and the decisions are written down. Done.

### Phase 2: foundation (data, identity, configuration)

Goal: the platform knows what a runner is, who owns it, and how it may connect, and the hosted platform can be told to run tests only on runners.

| Deliverable | Work item | Status |
|---|---|---|
| `EXECUTION_MODE` setting (`local` default, `runners` for the hosted platform); `/api/config` reports `executionMode` | 1 | built (`src/config.ts`, `src/platform/runner-only.ts`) |
| Runner kinds: team (today's machine-level runners) and personal (owned by one person, at most 5 active each, `MAX_PERSONAL_RUNNERS`) | 2 | built (`src/platform/agent-store.ts`) |
| Data for runners: `kind`, `owner_id`, `allow_code_scripts`, `allow_private_targets`, `allow_real_phone`, `machine_id`, rotation columns on `agent_tokens`; `runner_enrollments`; `runner_settings.allow_personal` (on by default); `os_version` and `machine_id` on `agents`; `owner_id` on `agent_tasks` | 2 | built (migration 51, `PERSONAL_RUNNERS_MIGRATION`; `repairPersonalRunnerColumns` adds the columns again where an older late repair rebuilt a table) |
| `schedules.created_by` (empty for existing schedules) | 1 | built (migration 52) |
| Single-use enrollment codes (`aite_` prefix, stored as SHA-256, 30 minutes) made on the website and traded once by the agent for a runner credential (`aitg_`) | 2 | built (`POST /api/runners/enroll`, `POST /api/agent/enroll`) |
| Downloads carry the enrollment code (`runner.enroll`, 0600), never a long-lived credential | 2, 4 | built (`src/platform/routes/runner-kits.ts`, `runner-kit.ts`, `runner-kit-complete.ts`) |
| Credential stored in the OS store: Windows DPAPI (current user) file `runner.credential`, macOS login Keychain, Linux a 0600 file | 2 | built (`src/agent/credential-store.ts`, `credential-store-os.ts`); only the Linux store ran; the Windows and macOS commands are unit-tested |
| Credential rotation every 30 days and on request, with an overlap of up to 24 hours for the old one | 2 | built (`POST /api/agent/rotate`, `ROTATE_AFTER_MS`, `ROTATION_GRACE_MS`) |
| An install id per runner folder (`runner.machine`); a credential bound to the first install id that uses it | 2 | built (`AgentService.hello`, `MachineRefused`) |
| Identity fields: OS version, memory, CPU count, Playwright version, supported adapters | 2 | built (`machineIdentity`, `src/agent/capabilities.ts`) |
| A real agent version instead of the constant `"1.0.0"` | 2 | not built: `AGENT_VERSION` in `src/agent/config.ts` is still the constant; a downloaded runner's real version is its `kitVersion` |
| Long-lived tokens from older downloads keep working | 2 | built (today's behaviour, kept) |

Exit: `tests/runner-enroll.test.ts` and `tests/runner-personal.test.ts`; a kit zip holds `runner.enroll` and no `aitg_`; an old `aitg_` token still connects; existing runners, tokens and projects keep working after the migrations (being proven on a production-shaped copy at integration).

### Phase 3: orchestration (dispatch, eligibility, lifecycle)

Goal: a run started on the website reaches the right runner, exactly once per attempt, and the backend stays the source of truth.

| Deliverable | Work item | Status |
|---|---|---|
| Dispatch worker in the API process in `runners` mode, several runner jobs at once (`DISPATCH_CONCURRENCY`, default 8); a runner job no longer holds the only worker slot while it waits | 1 | built (`Worker.dispatch`, `src/platform/worker.ts`; started in `src/main.ts`) |
| Every project routes to runners in `runners` mode without rewriting stored settings; "This server" refused with a sentence | 1 | built (`PLATFORM_SETTING_REFUSED`) |
| A plain refusal (409) when no eligible runner is online, instead of a run that waits | 1, 2 | built (`NO_RUNNER_MESSAGE`, the job gate) |
| Who may use a runner: a personal runner takes only its owner's runs and its owner's schedules, in projects the owner can still open with `tests.run` and that allow people's own computers; team runners as before | 2 | built (`offerTo`, `claimFor` with `agent_tasks.owner_id`, `jobOwnerId`) |
| Per-run runner choice (`runnerId` on every run-start route), checked before the run is queued and when the task is offered | 1, 2 | built (`options.runner`, the job gate, `offerTo`); runbook runs and deploy triggers keep the project's setting |
| `GET /api/projects/:id/runner-choices` | 2 | built (`src/platform/routes/runners.ts`) |
| Task phases (queued, assigned, accepted, preparing, running, uploading, completed, rejected, failed, cancelled, timed_out, lost_connection), written only by the server | 3 | built (migration 53, `TASK_PHASES`) |
| Protocol 2, additive: version negotiation, attempt ids, explicit accept (`AGENT_ACCEPT_SECONDS`, 30 s) and reject with re-offer, idempotent results; protocol-1 agents keep working | 3 | built (`src/agent-protocol/schema.ts`) |
| Schedules fire in `runners` mode and hand their jobs to runners; "Run now" refused while runs cannot start | 1 | built (`src/main.ts`, `schedule-services.ts`) |
| A re-queued job cancels the previous attempt's runner tasks | 1 | built (`reclaimStaleJobs`, `beforeRequeue`) |
| A runner failure leaves tests as they were (not "failed validation"); so does a job given up after three lost workers | 1 | built (`job-runner.ts`, `repo.ts`) |
| A re-queue writes an event saying the runner stopped answering | 3 | built (`runner_requeued`) |
| "Where it ran" kept after the 24-hour prune | 3 | built (`generation_jobs.ran_on_json`) |
| Long-poll transport, heartbeats, lease and re-offer | — | built before this round (protocol 1), kept |

Exit: `tests/runner-only-mode.test.ts` and `tests/runner-protocol2.test.ts`; a spy proves no browser was launched and no local executor ran on the server in `runners` mode; a protocol-1 agent still completes a run; `tests/runs-off-here.test.ts` in both modes.

### Phase 4: local Playwright execution

Goal: the runner runs existing tests unchanged, with the same engine as the platform, and reports what happens as it happens.

| Deliverable | Work item | Status |
|---|---|---|
| The agent runs tests through the platform's own adapters (`src/agent/task-child.ts`): Playwright web and API, Android, iOS, Windows desktop | — | built before this round |
| One process and one folder per task, killed as a tree on cancel or timeout | — | built before this round |
| Browser choice at start: Playwright's Chromium, else Chrome, else Edge, else a one-time Chromium download | — | built before this round |
| Live events from the run: test started and finished, step started and finished, screenshots, log lines, phases; batched, retried, stored once | 3 | built (`src/agent/live-events.ts`, `LIVE_REPORTER` in `src/engine/validation/runner.ts`); step events for Playwright web and API only, other adapters send one `test_finished` per test at the end |
| Results kept on disk and retried until the server answers, across an agent restart | 3 | built (`src/agent/outbox.ts`) |
| Code scripts (hand-written, imported, Git) on a personal runner by default, with an owner switch enforced on both sides; team runners as before plus an admin switch; never on a Crowd4Test shared runner | 2 | built (`mayRunCodeScripts`, hello `runner.customScripts`) |
| Private and local addresses refused by a personal runner by default, with an owner switch; checked on the runner's own network, with the test browser behind the guard proxy | 2 | built (`src/agent/address-guard.ts`) |
| Headed runs only where a display exists, otherwise refused with a sentence | 3 | built (reject reason `no-display`, `src/agent/task-runner.ts`) |
| "The agent was stopped." reported for running tasks on a stop signal or the stop file `stop.request` | 3 | built (`src/agent/stop-file.ts`) |
| The saved sign-in check, browser repair and mailbox steps never open a browser on the server in `runners` mode (skipped or refused with an event); test-data reset only for public targets | 1 | built |
| Authoring and exploring jobs that need a server browser refused in `runners` mode | 1 | built (`assertRunsOnRunner`) |
| An approved test runs as approved: a change to a shared step, helper or element it uses holds it back until it is approved again | 8 | built (`src/platform/approval-deps.ts`, migration 54) |

Exit: the live-event and outbox tests in `tests/runner-protocol2.test.ts`; `tests/approval-deps.test.ts`; the existing agent tests (`agent-program*`, `agent-platform*`, `stream-agent`).

### Phase 5: website live monitoring

Goal: everything a person needs is on the website; the runner has no dashboard of its own.

| Deliverable | Work item | Status |
|---|---|---|
| "Add this computer" for anyone who may run tests: a download for the detected OS that carries a one-time code, or a command to copy; the code's 30-minute life shown; waits for the runner (`GET /api/runners/enrollments/:id`) and says when it connects | 5 | built (`web/src/features/runners/AddComputerSteps.tsx`, `enroll.ts`) |
| "Add a team runner" for runner managers, with organisation and projects | 5 | built |
| The runner's page: kind, owner, OS and version, processor, memory, agent and Playwright versions, capabilities, current work linked to the run, last heartbeat, connection problems, the computer check, offline help per OS, the owner's switches, rename and retire | 5 | built (`RunnerSwitches.tsx`) |
| Buttons only when the server says the person may (`canAddPersonal`, `canAddTeam`, `canManage`) | 2, 5 | built |
| Copy fixes on the Runners pages | 5 | built |
| Run panel: eligible runners (theirs first), filtered by capability with the reason before Start; sends `runnerId` for this run without changing the project setting; says what to do when none is online | 6 | built (`web/src/features/runs/runs-here.ts`, `RunMenu.tsx`) |
| Project setting: default runner and "Allow people's own computers", with the plain note that the project's test accounts reach that computer | 6 | built (`RunnerChoicePanel.tsx`) |
| Schedules panel says whether schedules really fire | 6 | built (`schedulesFire`, `schedulesNote`) |
| Live run view: phase, runner, start time, current test and step, steps done, counts, live logs and screenshots, errors, duration, final report; rebuilt from stored events after a refresh | 7 | built (`web/src/features/runs/LiveRun.tsx`, `live-run.ts`) |
| Job events over SSE that replay after a refresh | — | built before this round, kept |

Exit: `tests/runner-personal-ui.test.ts`, `tests/run-on-runner-ui.test.ts` and `tests/run-live-ui.test.ts`, plus the updated `runners-ui`, `add-runner-ui`, `agents-ui` and `runs-off-here` tests.

### Phase 6: installers

Goal: a person installs the runner once, it starts in the background at sign-in, and it never installs an update it cannot verify.

| Deliverable | Work item | Status |
|---|---|---|
| Windows setup program and Mac app, per user, no administrator rights, Node.js download checked against its SHA-256 | — | built before this round (Windows tested on one Windows 11 PC; Mac only simulated) |
| Both installers read `runner.enroll` and start the runner with `--enroll-file`; an old `runner.token` still accepted | 4 | built (not run on Windows or macOS) |
| Start at sign-in on by default: Windows hidden under the tray program; Mac a LaunchAgent; no SYSTEM service and no LaunchDaemon | 4 | built (not run on Windows or macOS) |
| Graceful stop on Windows: the stop file, then up to 25 s, then the hard stop | 4 | built (`installer/win/RunnerHost.cs`; C# not compiled here) |
| Mac `runner.log` and `launchd.log` rotated while running (5 MB, 3 kept); after the runner is retired (exit code 3) the Mac loop stops until the next sign-in | 4 | built (`runner-setup.sh`; ran under bash and dash with stubs) |
| Uninstall deletes the stored credential (`--forget-credential`) | 2, 4 | built |
| Updates signed with Ed25519, public key pinned in the runner (`PINNED_UPDATE_KEYS`); an unverifiable update refused and shown as "download by hand"; a sequence number stops an old signed update from being installed again | 4 | built (`scripts/sign-runner-update.mjs`, `src/agent-protocol/update-manifest.ts`, `src/agent/updater.ts`, `src/platform/runner-update.ts`) |
| No signing key set: the platform offers no update and says so | 4 | built; this is the state until the owner makes the key |
| `npm ci --ignore-scripts` with a shipped lockfile in the plain kit, the Windows installer and the updater | 4 | built |
| Mac `.pkg` script (`scripts/build-runner-pkg.sh`) and the `.dmg` script, built in the deploy workflow on macOS; the zip stays the default download until a real Mac pass is green | 4 | built (not run on a Mac by us) |
| Authenticode and Developer ID with notarisation in the deploy workflow, each skipped with a log line when its secrets are absent | 4 | built; no certificate exists yet |
| Real-machine workflow (`.github/workflows/runner-matrix.yml`) on Windows Server 2022 and 2025, macOS 14 (Apple chip), macOS 15 (Intel), Ubuntu | 4 | built; it has not run |

Exit: `installer-win-unit`, `installer-mac-unit`, `runner-update-unit` (with signature checks), `runner-kit*` and `runner-matrix-workflow` on Linux; the matrix workflow has one green run (not yet); the manual pass in `MANUAL_VERIFICATION.md` on at least one real Windows 11 PC and one real Mac (not yet).

### Phase 7: hardening

Goal: the runner is treated as untrusted, secrets stay masked, and the whole journey is proven end to end.

| Deliverable | Work item | Status |
|---|---|---|
| Heartbeat lines scrubbed before they are stored | 3 | built |
| Encoded forms of secrets masked (URL-encoded, `+`, lower-case hex, JSON-escaped, `encodeURI`, base64 of `user:pass`) on the server and in the agent's log | 3 | built (`src/agent-protocol/secret-variants.ts`) |
| Per-task upload caps reserved while an upload streams | 3 | built (per platform process) |
| The unscoped `AgentStore.claim()` removed | 3 | built (only the scoped `claimFor` is left) |
| Enrollment rate-limited per address and per code; expired, used and unknown codes answered plainly | 2 | built |
| A credential used from another install id refused, with an Activity entry (`runner-refused`) | 2 | built |
| `created_by` recorded on every runner credential | 2 | built |
| Removing a project's own runner uses the same rule as adding one (`canManageRunner`) | 2 | built |
| Environment runs: the project's accounts reach an environment only on the project's own site | 1 | built (`projectAccountsReach`, `src/platform/environment-run.ts`) |
| AI repair calls while a repair draft already waits for review | 1 | not changed in this round (outside the runner work's files) |
| A per-organisation cap on runs | 1 | not built (there is a cap of 50 runners per organisation, `MAX_RUNNERS_PER_ORGANIZATION`, not on runs) |
| Review of the other runner task kinds | 10 | done; its two main findings fixed (sessions on personal runners: `tests/runner-sessions-personal.test.ts`; the runner's address guard: `tests/runner-address-guard.test.ts`) |
| The whole journey in a real browser with a real agent | 9 | built (`tests/runner-journey-ui.test.ts`, every piece flag on) |
| Runner tests that pass on Ubuntu added to `ai-studio-ci.yml` | 4 | being done at integration |
| `tests/secret-leak.test.ts` and the access tests | — | built before this round, must keep passing |

Exit: `tests/runner-journey-ui.test.ts` passes with every piece on; `secret-leak`, `permissions-unit`, `users-unit` and the access tests pass (recorded in `PROGRESS.md` by the integration run).

## Requirement coverage after this round

The requirement ids are the ones used in `CURRENT_STATE_AUDIT.md`.

| Id | Requirement | Phase | Built in this round | Still open after it |
|---|---|---|---|---|
| R1 | Website is the control plane; agent is headless | 5 | Runners pages, Run panel, live view | none planned |
| R2 | One TypeScript codebase for Windows and macOS | 4 | kept | Windows on ARM not tested; the agent's own version is still a constant |
| R3 | Installers, autostart, enrollment, uninstall, verified updates, signing | 6 | enrollment, sign-in start by default, signed updates, `.pkg` script, signing steps | the signing key; certificates; a real Mac pass; standalone `.exe` or MSI |
| R4 | Background execution in the person's session | 6 | sign-in start by default; display check for headed runs | runs only while the person is signed in (by design) |
| R5 | Runner identity | 2 | OS version, memory, CPU, Playwright version, adapters, install id | a real agent version |
| R6 | Enrollment and credentials | 2 | codes, OS credential store, rotation, machine binding | approval of new runners (not decided) |
| R7 | Protocol | 3 | protocol 2: attempt ids, accept and reject, typed live events, `timeout`, `shutdown` and `config` in the heartbeat answer | explicit sleep and wake handling |
| R8 | Lifecycle and reconciliation | 3 | phases, fencing, re-offer, durable results | picking a run up again after a platform restart |
| R9 | Execution through adapters | 4 | live step events for Playwright web and API | step-level events for other adapters |
| R10 | Capability discovery and matching | 2, 4 | identity fields, adapter list, code-script and private-address checks | none planned |
| R11 | Website runners, install flow, Run panel, live view | 5 | all listed in phase 5 | runner status pushed instead of polled |
| R12 | Data | 2, 3 | migrations 51 to 54 | time-limited object-store URLs; async store for PostgreSQL |
| R13 | Security | 7 | phase 7 list | OS sandbox or separate OS user for tests |
| R14 | Reliability | 1, 3, 6 | dispatch concurrency, durable results, graceful stop, log rotation | per-task disk and memory limits; runs across a deploy |
| R15 | Tests | all | new tests per phase, journey test, matrix workflow | real Windows 10/11 desktop and real Mac runs (manual) |

## Integration (end of this round)

1. Regenerate `src/platform/pg/baseline.sql` for slots 51 to 54. Done.
2. Turn on every piece of `tests/runner-journey-ui.test.ts` and make it pass. Flags on; the run is part of integration.
3. Add this round's new test files to `vitest.fast.config.ts` or the browser tier as fits, and to `ai-studio-ci.yml` where they pass on Ubuntu. Fast-tier files added; CI lists being done.
4. Run the type checks, the fast tier, the browser tests one file at a time, `secret-leak` and the access tests; compare any failure with the known machine failures. Type checks clean; the rest being done.
5. Prove the upgrade on a copy shaped like production (schema 50 to 54, both modes, an unchanged protocol-1 runner). Being done.
6. Update `PROGRESS.md` and the feature pages under `docs/features/`.
7. Release only through the usual gates. Switching the hosted platform to `EXECUTION_MODE=runners` is a release step: the deploy script writes it (`deploy/c4t-box/deploy.sh`).
8. Run the real-machine workflow once, then the manual pass in `MANUAL_VERIFICATION.md`.

## What the product owner must do

- Make the update-signing key pair (`node scripts/sign-runner-update.mjs --new-key <file>`), paste the public key into `PINNED_UPDATE_KEYS` (`src/agent/update-keys.ts`), and set the private key as the `RUNNER_UPDATE_SIGNING_KEY` Actions secret. Until then the platform offers no update, so installed runners stay on their version, and a runner downloaded before the key is pinned can only be updated by downloading it again.
- Decide whether to buy a Windows code-signing certificate and an Apple Developer ID. Until then SmartScreen and Gatekeeper warnings stay, and the docs say so.
- Provide, or ask someone to use, one real Windows 11 PC, one Windows 10 PC, one Mac with an Apple chip and one Intel Mac for the manual pass.

## What is left after this round (not built)

1. **Proof on real machines.** Nothing has run on a real Windows 10 or 11 PC or a real Mac: not the installers, the background start at sign-in, the DPAPI or Keychain credential store, the graceful stop, signed updates or the `.pkg`. The Windows installer's C# changes were not compiled on the build machine. The matrix workflow is built but has not run, and GitHub's Windows machines are Windows Server, not Windows 10 or 11 desktop.
2. **The update-signing key.** It must be made by the owner (above). Until then no runner updates itself.
3. **OS code signing.** The steps exist but are skipped without secrets. Unsigned installers keep showing warnings.
4. **AI authoring and exploring on runners.** In `runners` mode, exploring an application, a test described in words, agent runs and security assessments are refused, because the AI needs a browser on the server. Moving them to runners is not built.
5. **Server helpers that need the runner's network.** The saved sign-in check and browser repair are skipped, mailbox steps fail on a runner with their own message, and the test-data reset is sent from the server only to public addresses. Running them on the runner is not built.
6. **Runs across a deploy or restart.** Runner runs still going `SHUTDOWN_GRACE_SECONDS` (60 s) after a deploy starts are stopped and marked interrupted; their unfinished tests go back to not run yet. Picking a run up again in the new process is not built.
7. **Failure traces hold typed passwords.** A Playwright trace of a failed test keeps what was typed, the password included. Traces and videos are kept only for failed tests and shown only to people of the project; they are not masked, and no shorter retention rule is built.
8. **Isolation of tests on the runner computer.** Tests run as the signed-in person, with no OS sandbox and no separate low-privilege user. A test can read what that person can read, including the runner's credential through the same OS store call.
9. **Code scripts and the address guard.** Code scripts can open their own connections and reach private addresses whatever the runner's switch says.
10. **No per-organisation cap on runs.** One active job per project and `DISPATCH_CONCURRENCY` per platform are the only limits; a busy runner holds a dispatch slot for up to 30 minutes.
11. **Schedule-started runbooks have no owner.** A runbook started by a schedule carries no person, so a personal runner never takes its runs; only team runners can.
12. **A run already on a person's computer when their access is removed.** Access is re-checked when a task is offered and claimed, not while a test run goes (recordings and phone sessions do end within one heartbeat).
13. **Per-task resource limits.** Disk space is checked once at start; there is no per-task disk check and no memory or CPU cap.
14. **Sleep, wake and network changes.** No explicit handling; recovery relies on request timeouts and the server's lease. To be checked on real laptops.
15. **PostgreSQL for the runner tables.** An async runner store, a database device lock and wake-ups instead of a short read loop are separate migration work.
16. **Direct object-store transfers.** Artifacts still go through the platform's upload route; time-limited upload and download URLs are not built.
17. **Approval of new runners.** No step where an admin approves a runner before it takes work. Not decided.
18. **Runner status pushed to the website.** The Runners pages and the Run panel still poll.
19. **Live steps for other adapters.** Android, iOS and Windows desktop runs report each test once, at the end.
20. **The agent's own version.** Still the constant `"1.0.0"`; a downloaded runner is identified by its `kitVersion`.
21. **Crowd4Test shared runners** still receive the test accounts of every project they serve, and customers are not told so on the page that grants them.
22. **AI repair calls on failing approved runs** while an earlier repair draft waits for review were not changed in this round.
23. **Fixes from the pre-release review: built** (`tests/runner-review-fixes.test.ts`). The third accept timeout for the same task fails it; a schedule's "Run now" belongs to the person who clicked it; only a personal runner's owner may change its switches; a team enrollment code needs "manage runners" in every project it names; live events are capped per attempt; a credential rotation is written to Activity.
24. **Other installers.** No standalone `.exe` or MSI (the Windows download is a zip with the setup program inside); no Linux desktop installer (Linux uses the plain kit or a checkout); Windows on ARM runs the x64 build under emulation and is untested.
