# Local execution runner: progress log

A dated log of the runner work. Add a new entry at the top of "Log" whenever something lands, a test result changes, or a machine is checked. Keep the status table in step with the log.

Status words, as in `IMPLEMENTATION_PLAN.md`:

- **not started**
- **being built**: work has started; no claim yet.
- **built**: the code is in the tree and its listed tests pass on Linux. Say which tests, and what was not run.
- **verified on a real machine**: checked with `MANUAL_VERIFICATION.md` or the real-machine workflow. Name the machine and the build.
- **released**: deployed through the usual gates. Give the commit.

## Status

Last updated: 2026-11-08 (after integration, before release).

| # | Work item | Phase | Status | Proof (tests) | Notes |
|---|---|---|---|---|---|
| — | Audit of what existed | 1 | built | read and targeted test runs, see `CURRENT_STATE_AUDIT.md` | commit `e344261` |
| 1 | Runner-only execution | 2, 3, 4 | built | `tests/runner-only-mode.test.ts`, `tests/runs-off-here.test.ts` (both modes) | migration 52; `src/platform/runner-only.ts`, `Worker.dispatch` in `src/platform/worker.ts` |
| 2 | Runner identity and access | 2, 3, 4, 7 | built | `tests/runner-enroll.test.ts`, `tests/runner-personal.test.ts`, `tests/credential-store-unit.test.ts` | migration 51; DPAPI and Keychain only unit-tested on Linux |
| 3 | Task lifecycle, protocol 2 and live events | 3, 4, 7 | built | `tests/runner-protocol2.test.ts`, `tests/runner-protocol2-unit.test.ts`, `tests/runner-stop-file-unit.test.ts` | migration 53 |
| 4 | Installers, background start, signed updates and CI | 6, 7 | built (Linux parts) | `installer-win-unit`, `installer-mac-unit`, `runner-update-unit`, `runner-kit*`, `runner-matrix-workflow` | C# not compiled here; Mac scripts run under bash and dash with stubs; no signing key yet |
| 5 | Website: Runners pages | 5 | built | `tests/runner-personal-ui.test.ts`, `runners-ui`, `add-runner-ui`, `agents-ui` | |
| 6 | Website: Run panel, readiness and project setting | 5 | built | `tests/run-on-runner-ui.test.ts`, `runs-off-here` UI parts | |
| 7 | Website: live run view | 5 | built | `tests/run-live-ui.test.ts`, `tests/run-live-unit.test.ts` | |
| 8 | Approved tests stay as approved | 4 | built | `tests/approval-deps.test.ts` | migration 54 |
| 9 | End-to-end journey test | 7 | built | `tests/runner-journey-ui.test.ts`, `tests/helpers/runner-stack.ts` | every piece flag is on; its result is recorded by the integration run |
| 10 | Review of the other runner task kinds | 7 | done; two fixes built | `tests/runner-sessions-personal.test.ts`, `tests/runner-address-guard.test.ts` | sessions on personal runners; the runner's address guard |
| 11 | Design documents (this folder) | all | built | — | brought in line with the code on 2026-11-07 |
| — | Integration (baseline, CI lists, journey flags, full test run) | all | done | fast tier 3,625 passed; every runner and run-view file passed (see the log) | baseline regenerated for slots 1 to 54; type checks clean; the runner tests that run on Linux are in `ai-studio-ci.yml` |
| — | Upgrade proof on a production-shaped database (schema 50 to 54) | all | done | 8 of 8 checks passed (see the log) | a runner of the previous release still runs tests in `runners` mode |
| — | Real-machine workflow, first run | 6 | not started | `.github/workflows/runner-matrix.yml` | Windows Server, not desktop Windows |
| — | Manual pass: Windows 11, Windows 10, Mac (Apple chip), Mac (Intel) | 6 | not started | `MANUAL_VERIFICATION.md` | |
| — | Update-signing key made and set as an Actions secret | 6 | not started | deploy log says whether update offers were published | product owner's step; `PINNED_UPDATE_KEYS` in `src/agent/update-keys.ts` is empty until then |
| — | OS code signing (Authenticode, Developer ID and notarisation) | 6 | not started | — | no certificates yet; the steps skip themselves without secrets |

## Log

### 2026-11-08: integrated and checked

- **Full test run on Linux (Node 22).** Fast tier: 3,625 passed, 9 failed. The 9 are the machine failures this computer already had before this work (start scripts needing Git Bash, phone tools, one scanner adapter, one emulator check); the same 9 fail on `e344261`. Every browser and port file this work created or touched passed, run one at a time after a fresh web build, including `runner-journey-ui` (11 of 11, every step on, in `runners` mode), `runner-only-mode`, `runner-enroll`, `runner-personal`, `runner-protocol2`, `runner-address-guard`, `runner-review-fixes`, `run-live-ui`, `run-on-runner-ui`, `runner-personal-ui`, `agent-platform`, `agent-program`, `agent-program-e2e`, `runners-shared`, `secret-leak` and `ux-nav-ui`. Still failing, and failing the same way on `e344261`: three `add-runner-ui` cases that expect a Windows or Mac browser, and one `device-session` case.
- **Found and fixed during integration.** A switch changed while a runner was idle reached it only at its next hello, so it could refuse a run it should take. Protocol-2 offers now carry the runner's switches (`TaskOffer.config`). Protocol-1 runners still learn a change at their next hello.
- **Upgrade proof.** A schema-50 database seeded by the previous release (four projects in two organisations and one with none, nine runner credentials including revoked and retired ones, machines, queued and running tasks, schedules, approved versions, secrets) upgraded to 54 in 37 ms with no row changed in any of its 127 tables; at 1,000 times the rows, in under a second. Old credentials became team runners with the old rules; the previous release's runner program connected and completed runs in `runners` mode; work left over from a crashed process was re-queued and finished; secrets still decrypt; the platform started no process of its own; a late slot-42 repair leaves no column missing.
- **Pre-release review.** No blockers. Its one high finding (a schedule's "Run now" could reach the schedule maker's own computer) and the medium ones are fixed and tested (`tests/runner-review-fixes.test.ts`).
- **Not done yet:** the real-machine workflow has never run; no manual pass on Windows or a Mac; the update-signing key is not set, so no runner updates itself; nothing is code-signed.

### 2026-11-07: built

Every work item of the round is in the tree (not yet committed or released). In short, with the files that hold it:

- **Runner-only execution.** `EXECUTION_MODE` (`local` default, `runners`) and `DISPATCH_CONCURRENCY` (default 8) in `src/config.ts`. In `runners` mode the API process starts a dispatch worker (`Worker.dispatch`, `src/platform/worker.ts`, started in `src/main.ts`) that takes only runner jobs; jobs that need the server's browser are refused at creation (`assertRunsOnRunner`, `src/platform/runner-only.ts`); a last-line guard throws `SERVER_RUN_REFUSED` if the server tries to run tests or open a browser for a run. Schedules fire and carry `startedBy = { kind: "schedule", id, ownerId }` (`schedules.created_by`, migration 52). Every run-start route takes an optional `runnerId`. `/api/config` has `executionMode`. A runner failure, and a job given up after three lost workers, put tests back to what they were instead of marking them failed.
- **Identity and access.** Team and personal runners (`agent_tokens.kind`, `owner_id`, migration 51); single-use enrollment codes (`runner_enrollments`; `POST /api/runners/enroll`, `GET /api/runners/enrollments/:id`, `POST /api/agent/enroll`); downloads carry `runner.enroll` and the headers `x-runner-enrollment-id`, `x-runner-enrollment-expires`; the OS credential store (`src/agent/credential-store.ts`, `credential-store-os.ts`, folder from `AITP_CREDENTIAL_DIR`); rotation (`POST /api/agent/rotate`, 30 days, 24-hour overlap); machine binding (`runner.machine`); owner switches (`PATCH /api/runners/:runnerId`); the project switch (`PUT /api/projects/:id/runner { allowPersonal }`); `GET /api/projects/:id/runner-choices`; at most 5 personal runners per person.
- **Protocol 2.** Version negotiation (`protocols: [1, 2]`), attempt ids, `POST /api/agent/tasks/:id/accept` (within `AGENT_ACCEPT_SECONDS`, default 30) and `/reject`, task phases (`agent_tasks.phase`, migration 53), live events (`POST /api/agent/tasks/:id/events`, stored once per task, attempt and sequence number in `agent_task_events`, shown as `runner_*` job events), durable results (`src/agent/outbox.ts`), heartbeat answers `timeout`, `shutdown` and `config`, the stop file `stop.request` (`src/agent/stop-file.ts`), scrubbing of encoded secrets (`src/agent-protocol/secret-variants.ts`), "where it ran" kept with the job (`generation_jobs.ran_on_json`).
- **Installers and updates.** Both installers read `runner.enroll`, start at sign-in by default, and call `--forget-credential` on uninstall; the Windows host stops gracefully with `stop.request`; the Mac loop rotates its logs and stops for good when the runner is retired; `scripts/build-runner-pkg.sh` makes a `.pkg`. Updates must be signed with Ed25519 (`scripts/sign-runner-update.mjs`, `src/agent-protocol/update-manifest.ts`, `src/agent/update-keys.ts`); with no key set nothing is offered. OS signing steps run only when their secrets exist. `.github/workflows/runner-matrix.yml` exists and has not run.
- **Website.** Add this computer and Add a team runner (`web/src/features/runners/AddComputerSteps.tsx`, `enroll.ts`), the owner's switches (`RunnerSwitches.tsx`), the Run panel's runner choice and readiness in `runners` mode (`web/src/features/runs/runs-here.ts`), the live run view (`web/src/features/runs/LiveRun.tsx`, `live-run.ts`).
- **Approved tests stay as approved.** `src/platform/approval-deps.ts` (`test_version_deps`, migration 54).
- **Sessions on personal runners** (from the review of the other task kinds): recordings, live sessions and phone sessions on a person's own computer only for its owner; a real phone only with the owner's switch (`allow_real_phone`).
- **The runner's own address guard** (`src/agent/address-guard.ts`): a runner that refuses private addresses checks them on its own network and sends the test browser through the guard proxy.
- **Fixes from the independent review before release** (checked in the code on 2026-11-07): a schedule's "Run now" belongs to the person who clicked it; platform admins may rename or retire a person's computer but not change its switches; a team enrollment code needs "manage runners" in every project it names; live events are capped per attempt (5,000 events or 5 MB); a credential rotation is an Activity entry (`runner-credential-rotated`). Also built since: the third accept timeout for the same task fails it with a plain sentence; live events no longer store a stack (the final result keeps it); a Crowd4Test shared runner never shows code scripts as on; a runner made from a project with no organisation is labelled as that project's runner. Tested in `tests/runner-review-fixes.test.ts`.
- **Tests run while these documents were updated** (Linux, Node 22): `credential-store-unit` (7), `runner-protocol2-unit` (15), `runner-stop-file-unit` (5), `run-live-unit` (7), `environment-accounts-unit` (1), `runner-update-unit` (23), `installer-mac-unit` (68), `runner-matrix-workflow` (10): all passed. The browser and port tests, and the full fast tier, are run by the integration step; its results go in the next entry.
- **Not verified:** nothing has run on a real Windows 10 or 11 PC or a real Mac. The Windows installer's C# changes were not compiled here. The update-signing key does not exist yet.
- **Limits** are listed in `SECURITY_DESIGN.md` ("Limitations") and in `IMPLEMENTATION_PLAN.md` ("What is left after this round").

### 2026-11-07: build started

- Work items 1 to 11 started in the same tree, against shared contracts: the job owner on scheduled jobs, the per-run `runnerId`, `GET /api/projects/:id/runner-choices`, the two enrollment routes, the credential-store functions, the live-events route and the task phases. `RUNNER_ARCHITECTURE.md` and `AGENT_COMMUNICATION_PROTOCOL.md` describe them.
- Migration slots reserved in `src/platform/db.ts`: 51 (personal and team runners, enrollment codes, owner switches, the project switch), 52 (who made each schedule), 53 (task phases, attempts and live events), 54 (what an approved test version depends on).
- Rules for the work: every server change is additive, and a test proves an unchanged protocol-1 agent still runs a job; no new packages (Ed25519 comes from `node:crypto`); secrets stay write-only; nothing is claimed that has not been run. What cannot run on this Linux machine (Windows, macOS) is said plainly.
- Nothing from this round is released. Production still has tests off on the server.

### 2026-11-07: decisions taken

The product owner answered the audit's open questions. In short (reasons in `RUNNER_ARCHITECTURE.md`):

1. The hosted platform runs tests only on runners (`EXECUTION_MODE=runners`); self-hosting and development keep `local`.
2. Two kinds of runner: team runners (today's machine-level runners) and personal runners, which anyone who may run tests in some project can add for their own computer. A personal runner takes only its owner's runs and its owner's schedules. At most 5 active personal runners per person.
3. A project switch, "Allow people's own computers", on by default. When on, the project's test accounts reach the owner's computer for their runs, and the setting says so.
4. Code scripts run on a personal runner by default; its owner can switch that off. Team runners keep today's rule, plus an admin switch.
5. Private and local addresses: a personal runner refuses them by default; its owner can allow them.
6. Enrollment by a single-use code valid 30 minutes; no download carries a long-lived credential; the credential rotates every 30 days.
7. The credential is kept in the OS store (DPAPI, Keychain, a 0600 file on Linux), with honest limits.
8. A per-user background agent that starts at sign-in, on by default. No SYSTEM service and no LaunchDaemon.
9. Transport stays HTTPS long-poll; protocol 2 is additive.
10. Updates must be signed (Ed25519, public key pinned in the runner).
11. OS code signing steps are built but wait for certificates.
12. One active job per runner by default, configurable 1 to 8.

### 2026-11-07: audit done

- Read-only audit of the agent program and installers, the platform's orchestration and data, the website, and security, tests and CI, at commit `e344261`. Results in `CURRENT_STATE_AUDIT.md`.
- Headline: a runner agent exists (protocol 1 over HTTPS long-poll, Windows and Mac installers, downloads, self-updates, the same engine as the platform), but on the hosted platform no run could start on a runner, a tester could not add their own computer, every download carried a long-lived credential, live progress was text only, updates were unsigned, and nothing had been run on a real Mac.

## Things to re-check at integration

Status on 2026-11-07, after the build: the baseline is regenerated (slots 1 to 54); the journey test's flags are all on; the stop file is `stop.request` in the folder of `runner.mjs` on both the Windows host and the agent (`installer/win/Common.cs`, `src/agent/stop-file.ts`); the installers pass `--enroll-file` and `--forget-credential` as `src/agent/config.ts` reads them. The rest of the list is checked by the integration run.


- `tests/pg-baseline-unit.test.ts` passes after the baseline is regenerated for slots 51 to 54.
- The website's stand-in APIs match the real routes (runner choices, enrollment, live events, phases).
- The installers pass `--enroll-file` and `--forget-credential` exactly as the agent reads them.
- The stop file name (`stop.request` in the runner's data folder) is the same in the Windows host and the agent.
- The journey test's `it.todo` parts are turned on and pass.
- Existing data after the migrations: an existing token reads as a team runner, an existing project allows people's own computers, existing schedules have no owner, existing tasks get a phase from their status, versions approved before slot 54 follow the rule written in the approval feature page.
- The new test files are in the right tier and in `ai-studio-ci.yml` where they pass on Ubuntu.
