# Job execution lifecycle

How a run started on the website reaches a runner, runs, and comes back as a report. What happens when something goes wrong, and how the platform puts things right afterwards.

- Date: 2026-11-07, updated after the build the same day. References with a line number are at commit `e344261`; references without one name a file and function in the current tree.
- Every capability is marked **Built** (in the tree; "before this round" when it was already in `e344261`) or **Not built**. Nothing here is claimed to work on a real Windows or Mac computer; see `MANUAL_VERIFICATION.md`.
- Related: `RUNNER_ARCHITECTURE.md` (the parts and the modes), `AGENT_COMMUNICATION_PROTOCOL.md` (every message), `SECURITY_DESIGN.md`.

## 1. Two records for one run

A run is two records that move together.

| Record | Table | Written by | Holds |
|---|---|---|---|
| **The job** | `generation_jobs` | the API (create, cancel) and the worker that claimed it | who started it, the options (tests, environment, chosen runner), progress, counters, the final status |
| **The runner task** | `agent_tasks` | only the server, on the agent's messages | the batch of scripts sent to one runner, the claim, the lease, the result |

A job usually has one task. It can have more over its life: each new attempt of the job makes a new task (section 6).

The server is the source of truth. Every change to a task is a conditional `UPDATE` (for example "only if still queued", "only if this agent holds it"), so two writers cannot both win (`src/platform/agent-store.ts:12`, `claimFor` at `:541-554`). **Built.**

```
 website            API process                                   runner (tester's computer)
 ───────            ───────────                                   ──────────────────────────
 Run ──POST──▶ route checks ─▶ createJob (QUEUED)
                                   │
                    worker claims ─┘ (VALIDATING, lease 60 s)
                                   │
                    RemoteExecutor ─▶ agent_tasks row (queued) ◀──── long poll (every 25 s)
                                   │                          claim ──▶ offer (assigned)
                                   │                                   accept (protocol 2)
                                   │◀──── heartbeat every 10 s ─────── prepare, run, upload
                                   │◀──── live events (protocol 2) ─── steps, screenshots
                                   │◀──── result ───────────────────── ok / not run
                    collect ─▶ test results, artifacts, events
 SSE stream ◀──── agent_events ◀───┘
 report     ◀──── job COMPLETED / PARTIALLY_COMPLETED / FAILED
```

## 2. Job states

`JOB_STATES` in `src/platform/repo.ts:19-29`. A test run uses `QUEUED`, `VALIDATING` and the three end states. (The other states belong to AI generation jobs.) **Built.**

| From | To | When | Who | Where |
|---|---|---|---|---|
| — | `QUEUED` | every gate passed (section 4, step 3) | the API route, through `Repo.createJob` | `repo.ts:455-482` |
| `QUEUED` | `FAILED` "Cancelled" | a person cancels before a worker claims it | API, `DELETE /api/test-generation/:jobId` | `repo.ts:607-612`, `server.ts:805-809` |
| `QUEUED` | `VALIDATING` | a worker claims the oldest queued job and takes a 60 s lease | the worker (in `runners` mode: the dispatch worker) | `claimNextJob`, `repo.ts:495-508` |
| `VALIDATING` | `COMPLETED` | every test passed and no stage reported an error | the job runner | `job-runner.ts:414-417` |
| `VALIDATING` | `PARTIALLY_COMPLETED` | some tests failed or need review, or a stage reported an error | the job runner | `job-runner.ts:418-420` |
| `VALIDATING` | `FAILED` | the run itself could not finish: runner error, cancel, over the time limit, platform shut down | the job runner | `job-runner.ts:422-442`, `ops/shutdown.ts` |
| `VALIDATING` | `QUEUED` | the worker that held the job was lost (lease expired), fewer than 3 attempts | the next worker, `reclaimStaleJobs` | `repo.ts:532-566` |
| `VALIDATING` | `FAILED` (given up with a plain reason) | the third loss | `reclaimStaleJobs` | `repo.ts` (`WORKER_LOST_GIVE_UP`) |

**Test statuses during a run.** Each test in the run is `VALIDATING` while the job holds it, then gets its verdict when the results are recorded.
- On a cancel, the tests that did not run go back to what they were: status, reason, history (`job-runner.ts:430-435`). **Built.**
- On any other failure of the run, the tests still `VALIDATING` become `FAILED_VALIDATION` "Validation interrupted: …" (`job-runner.ts:436-438`). At `e344261` that made a lost runner look like failing tests. **Built in this round:** a runner failure (it stopped answering, could not start, refused) puts them back as a cancel does, and an event says why (`runner_failed_tests_restored`).
- A lost worker is not a verdict either: `reclaimStaleJobs` puts the tests without a result back to not run yet, on every loss including the third, when the job is given up. *Built.*

**One active job per project.** Every run-start route checks, right before `createJob`, that the project has no job in flight (`routes/runs.ts:56-57`, and the same line in suites, environments, variants, authoring). **Built.**

## 3. Runner task statuses and phases

**Before this round.** `agent_tasks.status` is `queued`, `running`, `done`, `failed` or `cancelled` (`agent-store.ts:214`). "Offered", "accepted", "preparing" and "uploading" are all just `running`.

**Built in this round** (migration 53, `TASK_PHASES` in `src/agent-protocol/schema.ts`). `agent_tasks.phase` holds the finer state. Only the server writes it, from the agent's messages and its own timers. The website shows it with `ranOn` on the run. Existing rows got a phase from their status when the migration ran (queued, running, completed, failed or cancelled). Each change is a `runner_phase` event.

| Phase | Status | Entered when | Who causes it |
|---|---|---|---|
| `queued` | queued | the task is made, or put back for another attempt | server: `RemoteExecutor.execute` → `enqueue`, or the sweep |
| `assigned` | running | a runner's poll claims it; the offer is in the poll's answer | server: `offerTo` → `claimFor` |
| `accepted` | running | a protocol-2 agent sends accept within `AGENT_ACCEPT_SECONDS` (30 s); a protocol-1 claim counts as accepted | agent asks, server records |
| `preparing` | running | the agent says it is downloading files and checking the computer | agent reports, server records |
| `running` | running | the agent says the tests have started | agent reports, server records |
| `uploading` | running | the agent says it is sending files | agent reports, server records |
| `completed` | done | a result with `ok: true` is accepted | server: `result` → `finish` |
| `rejected` | queued again, or failed | a protocol-2 agent rejects the offer with a reason. The task is offered to another eligible runner; it ends `rejected` only when none is left | agent asks, server decides |
| `failed` | failed | a result with `ok: false`, or the server gives up on the task | server |
| `cancelled` | cancelled | a person's cancel, the job stopping, or the job ending without it | server |
| `timed_out` | failed | a deadline passed (section 7) | server |
| `lost_connection` | failed | the runner stopped answering and no offer is left | server: `sweep` |

Rules (built):
- Within one attempt a phase only moves forward, in the order of the table. Nothing leaves a terminal phase (`completed`, `rejected`, `failed`, `cancelled`, `timed_out`, `lost_connection`).
- A task that goes back to the queue starts a **new attempt**: a new `attemptId`, phase `queued`. Messages carrying the old `attemptId` get 409 `superseded`, and the agent stops that attempt.
- An accept that does not arrive within 30 s puts the task back in the queue **without** using up one of its offers. So does a reject, and the rejecting runner is never offered that task again.
- A protocol-1 agent sends no accept and no phase reports. Its claim counts as accepted (`accepted_ms` is the claim time) and its first heartbeat counts as `running`; the website shows less detail for it.
- An interrupted run is never reported as passed: only an accepted `ok: true` result leads to `completed`.

## 4. From Run to report, in 16 steps

Steps marked (P2) need a protocol-2 agent. A protocol-1 agent does the same work without those messages.

1. **The person clicks Run.** The website sends `POST /api/projects/:id/runs` (or the suite, environment, variant, plan or runbook route). The body may name a runner for this run only: `runnerId`, carried as `options.runner`. *Built.* Runbook runs and deploy triggers take no `runnerId`.
2. **Route checks.** The person needs `ai_studio.tests.run` on the project. `refuseUnlessRunsStart` answers 409 when no run can start (`routes/runs.ts:36`, `suite-run.ts:30-35`). In `runners` mode it is true while the dispatch worker is alive. Unknown tests are refused, tests no adapter can execute are named, and the project must have no job in flight. *Built.* In `runners` mode, jobs that need the server's browser are refused here (`assertRunsOnRunner`, `src/platform/runner-only.ts`).
3. **Create-time gates.** `Repo.createJob` refuses an archived project, then runs the plugin, framework, job and custom-script gates (`repo.ts:455-461`). The job gate (`assertJobAllowed`, `agent-services.ts:509-540`) answers 409 with a sentence when no eligible runner is online, or when none of them can run these tests (missing browser, Android, iOS needs a Mac, Windows desktop). *Built.* This round it also checks: a chosen runner is eligible for this person and project, online and capable; a personal runner takes only its owner's runs and only where the project allows people's own computers; code scripts and private addresses are allowed on the runners that could take the run. *Built.* In `runners` mode the refusal says to start the runner or add one on the Runners page (`NO_RUNNER_MESSAGE`). Only then is the job inserted as `QUEUED`, with who started it (`startedBy`) and the chosen runner.
4. **A worker claims the job.** It becomes `VALIDATING` with a 60 s lease, renewed every 5 s (`job-runner.ts:50,76-89,127-141`). In `local` mode this is the platform's one worker. In `runners` mode it is a dispatch worker inside the API process that only takes jobs it can hand to runners, several at once (`DISPATCH_CONCURRENCY`, default 8). *Built* (`Worker.dispatch`, `src/platform/worker.ts`).
5. **The job is prepared.** The job runner reads the tests, the environment and the project's test accounts (decrypted only now). In `runners` mode the server opens no browser and runs no test code: the saved sign-in check, browser repair and mailbox steps are skipped or refused with an event, and a test-data reset is sent from the server only to public addresses. A last-line guard makes the local executor and the server's browser launch throw `SERVER_RUN_REFUSED` in `runners` mode. *Built.*
6. **A runner task is made.** `RemoteExecutor.execute` stores baselines under `<project>/_agent/<task>/in/`, refers to the app file by hash, encrypts the payload with the run's credentials (AES-256-GCM), and writes the task and its files in one transaction (`agent-services.ts:664-757`, `agent-store.ts:505-510`). Event: "Sent N script(s) to a runner agent." (`agent_task_queued`). *Built.*
7. **A runner takes it.** Each runner holds one long poll (25 s). While it is open, `offerTo` looks at queued tasks every 250 ms, oldest first, and skips any the runner may not take (project not granted, pinned to another runner, capability missing, code scripts not allowed, device busy) (`agent-services.ts:199-235`). `claimFor` claims it in one conditional `UPDATE` that re-checks the grant and that the credential is live (`agent-store.ts:541-554`). The offer goes back in the poll's answer; the task is now `running` (phase `assigned`) and its `offers` count goes up. *Built.* Each hand-out also gets a fresh `attemptId` and a `runner_attempt` event; a personal runner claims only its owner's tasks (checked in the claim), and a chosen runner is the only one offered a task meant for it. *Built.*
8. **(P2) Accept or reject.** The agent accepts within 30 s, or rejects with a reason code and a sentence (missing browser, code scripts off, private address refused, busy). A reject offers the task to another eligible runner. *Built.* Protocol 1 has no accept: the claim is the acceptance, and a runner that cannot run the task can only answer `ok: false`, which fails the run (`agent-services.ts:342-345`).
9. **The agent prepares.** It makes a folder for this task only (`src/agent/task-runner.ts:131`), checks the adapter, applies the code-script rule and the static guard (`:324-330`), downloads the task's files and checks each one's size and sha256 before use (`src/agent/file-cache.ts:85-95`), and checks phones, simulators or Windows desktop apps when the run needs them. (P2) phase `preparing`. The agent rejects before downloading anything when it cannot run the task. *Built.*
10. **The agent runs the tests.** It starts one child process for the task (`task-child`), which calls the same engine adapters as the platform (`src/agent/task-child.ts:51-57`). The test accounts reach only that child's environment; the child inherits an allow-list of variables, never the runner credential (`task-process.ts:34-43`). A watchdog kills the process tree when the task's limit plus 90 s passes (`task-runner.ts:47,396-404`). (P2) phase `running`. *Built.*
11. **Heartbeats.** Every 10 s the agent sends done/total and up to 20 log lines. Each heartbeat extends the lease (`agent-services.ts:280-302`). The lines become `agent_progress` job events, scrubbed of the run's secrets (`:434-446`). The answer can say `cancel: true`. *Built.* (P2) The answer can also say `timeout`, `shutdown` or `config`, and the lines are scrubbed before they are stored on the task as well. *Built.*
12. **(P2) Live events.** The agent sends `test_started`, `step_started`, `step_finished`, `test_finished`, `screenshot` and `log` events in batches (at most 1 s or 50 events) to `POST /api/agent/tasks/:id/events`. The server stores each `(task, attempt, seq)` once, scrubbed, as job events (`runner_test_started`, `runner_step`, `runner_screenshot`, …). A screenshot event points at a file already sent through the upload route. *Built.* Android, iOS and Windows desktop runs send one `test_finished` per test at the end; a protocol-1 agent sends none.
13. **The website watches.** The run page reads `GET /api/test-generation/:jobId/stream` (SSE, with a stream ticket). Events come from `agent_events`; a first visit gets the latest 500, and a reconnect with `Last-Event-ID` replays every event it missed (`routes/stream.ts:208-218`). A refresh, or coming back later, loses nothing. *Built*; the run page's live card reads the `runner_*` events once and then follows the stream (`web/src/features/runs/LiveRun.tsx`).
14. **Cleanup and uploads.** If the project asks for it, the agent removes the records the run created (`task-runner.ts:428-434`). Then it sends each file with `PUT /api/agent/tasks/:id/files/:name`; the server streams it to its final place and checks its sha256 before it counts (`routes/agents.ts:288-332`). (P2) phase `uploading`. *Built.*
15. **The result.** The agent posts `ok: true` with each test's result, or `ok: false` with a reason. The server scrubs the run's secrets out of it, encrypts it and finishes the task once (`agent-services.ts:335-350`). *Built.* (P2) A repeat of the same attempt's result answers 200 `alreadyReceived`, and the agent keeps the result in `<work folder>/outbox/` until the server has it. *Built.*
16. **The report.** The executor's watch loop (every 1 s) sees `done` and runs `collect`: it re-masks the evidence, maps each file to its test, and the sink records the verdicts, steps and artifacts as for a local run (`agent-services.ts:807-890`, `repo-sink.ts:170-185`). The job ends `COMPLETED`, `PARTIALLY_COMPLETED` or `FAILED`; the run shows where it ran (`ranOn`) with the task's phase and attempt. After 24 h the task and its `_agent/<task>` files are pruned; the job, its events, its artifacts and where it ran (`generation_jobs.ran_on_json`) stay. *Built.*

## 5. Failure cases

For each: what happens, the words people see, and how the platform reconciles it. "Before this round" means at `e344261`.

### No runner online
- **At Run:** the job gate answers 409 with a sentence and nothing is queued (`agent-services.ts:522`, `NO_AGENT_MESSAGE`). A chosen runner that is offline gets a 409 naming it; one the person may not use, a 404. *Built.*
- **After the job was queued** (the runner went away): the executor counts how long no capable runner has been online. After 90 s it fails the task: "No runner agent that can run these tests is connected. …" (`agent-services.ts:771-781`). The job ends `FAILED`. *Built.* In `runners` mode the sentence is "No runner that can run these tests is online. Start the runner, or add one on the Runners page." Rejected by every runner that could take it: the task fails at once with their reasons. *Built.*
- **A schedule's run with no runner:** the schedule records it as skipped with the reason (`scheduler.ts:229-240`). "Run now" on a schedule is refused (409) while runs cannot start, instead of queuing a job nothing runs (`schedule-services.ts`). *Built.*

### No capable runner
- **At Run:** the job gate compares the run's adapters with every eligible online runner and answers 409 with the first reason, for example "The connected runner agent "X" can't run API tests: …" (`agent-services.ts:526-533`). *Built.*
- The executor's "is a capable runner online" check uses the same rules as offering (owner, chosen runner, code scripts, rejections), so a run that only a shared runner could take, but that has code scripts, is no longer left waiting 30 minutes. *Built.*

### Runner busy
The task waits in the queue. If no runner takes it within 30 minutes it fails: "No runner agent picked up this run within 30 minutes." (`agent-store.ts:641`). *Built.*

### Disconnect mid-run
- **On the server:** the heartbeats stop, the 60 s lease runs out, and `sweep` puts the task back in the queue while it has used fewer than 2 offers. The second time it fails: "The runner agent stopped responding while it was running these tests." (`agent-store.ts:639-640`). The job ends `FAILED`. *Built.*
- **Before this round** the re-offer reused the same task id, so a late result from the first attempt was accepted as the second's; the requeue was silent; the tests became `FAILED_VALIDATION`. *Built in this round:* a new `attemptId` fences the old attempt (409 `superseded`) for a protocol-2 agent, the requeue writes "… stopped answering; offering the run again." (`runner_requeued`), the second loss writes `runner_lost` with phase `lost_connection`, and the tests are put back.
- **On the agent:** a heartbeat that fails is retried with the next one, and its lines are kept for it; after 3 failures in a row it logs a warning and the run continues (`task-runner.ts:157-167`). A heartbeat answered 404, 409 or 410 means the platform has given the task up: the agent stops the run and does not send a result (`:162-165`). *Built.*
- **Short blips** (shorter than the lease) do not interrupt the run. *Built.*

### Cancel
1. The person presses Stop: `cancel_requested` is set on the job (`repo.ts:607-612`).
2. Within 5 s the job's lease tick aborts it, and the executor calls `requestCancel`: a queued task is cancelled at once, a running one is marked (`agent-store.ts:616-619`).
3. The agent's next heartbeat (within 10 s) answers `cancel: true`. The agent kills the test's whole process tree (`task-process.ts:16-32`) and posts `ok: false` "The run was cancelled."; the task is stored as cancelled.
4. If the agent never answers, `sweep` cancels the task when its lease runs out (`agent-store.ts:637`).
5. The tests that had not run go back to what they were; a summary event says how many ran (`job-runner.ts:430-435`).
*Built.*

### Timeout
Four limits; whichever comes first ends the run.

| Limit | What happens | Words | Status |
|---|---|---|---|
| Agent watchdog: the task's limit + 90 s | the agent kills the process tree and posts `ok: false` | "The run took longer than its time limit and was stopped." (`task-runner.ts:412`) | Built |
| Executor deadline: the run's `timeoutMs` + 5 min, or 4 h without one | the task is cancelled and failed; the job fails | "The runner agent did not finish in time." (`agent-services.ts:759,797-801`) | Built |
| Job limit: `JOB_MAX_MINUTES` | the job is stopped and failed | "This job was stopped because it ran longer than N minutes, the limit on this server (JOB_MAX_MINUTES)." (`job-runner.ts:70,143-150`) | Built |
| Queue limit: 30 min without a taker | the task fails | see "Runner busy" | Built |

*Built:* when a server deadline passes, the heartbeat answer tells a protocol-2 agent `timeout` (stop now), and the task's phase becomes `timed_out`.

### Agent crash
- **The test process crashes:** the agent posts `ok: false` with the crash and the last 200 characters of output, redacted (`task-runner.ts:413-416`). *Built.*
- **The agent itself dies:** heartbeats stop, so it is the disconnect case above. When the agent starts again it wipes leftover task folders (`src/agent/agent.ts:222-223`) and says hello again. *Built.* A finished result that was not yet delivered is kept: the agent writes it to `<work folder>/outbox/<task>.json` before posting and resends it after a restart until the server answers 2xx, 404, 409 or 410. *Built.*
- **Stop from the Windows tray:** the tray writes `stop.request` in the runner's folder and waits up to 25 s; the agent reports "The agent was stopped." for its running tasks, as on SIGINT/SIGTERM, and only then is it ended hard (`installer/win/RunnerHost.cs`, `src/agent/stop-file.ts`). *Built (C# not compiled or run on Windows here).*

### Download failure
A file whose size or sha256 does not match the offer is refused by the file cache (`file-cache.ts:85-95`); the server answers 404 or 409 for a file that is unknown or changed. The error ends the task with `ok: false` "The agent could not run this task: …" (`task-runner.ts:182-187`). The run fails; it is not a test verdict, and its tests go back to what they were. (P2) The phase becomes `failed`. *Built.*

### Upload failure
- Each file gets 3 tries (waits 0.4 s and 0.8 s). A file arriving damaged is sent again; a refusal that repeating cannot change (too big, bad name, task gone) is not (`task-runner.ts:564-610`).
- A file over the limit, missing or unreadable is skipped with a warning, and the result is still sent. Limits: 64 MB per file, 512 MB and 300 files per task (`agent-services.ts:68-70`); nginx allows 100 MB per request.
- A file named in the result but never uploaded is named by a `runner_file_missing` event. The per-task caps are reserved while an upload streams, so parallel uploads cannot pass them. *Built.*

### Missing browser
- **Before dispatch:** the runner reports its browsers in every poll; the job gate and `offerTo` both skip a runner that lacks what the run needs (`capabilityProblem`, `agent-routing.ts:108-133`). *Built.*
- **On the agent:** at start it uses Playwright's Chromium, else installed Chrome, else Edge, else installs Chromium in the background (`src/agent/browser-setup.ts`). If a run still finds no browser, the agent reports a machine problem, not failing tests: "Playwright browsers are not installed on this agent. …" (`task-runner.ts:467`). *Built.*
- A protocol-2 agent rejects such an offer with a reason (`missing-browser`), so another runner can take it. *Built.*
- **Headed runs with no display:** refused with a sentence (reason `no-display`). *Built.*

### Test failure
A failing test is a verdict, recorded exactly as for a local run: status, failure text, steps, screenshot, trace and video when kept. The job ends `PARTIALLY_COMPLETED`. *Built.* (P2) The failure also arrives live as a `test_finished` event with its error and stack. *Built.*

### Platform restart
- **Graceful (deploy, SIGTERM):** `/readyz` answers 503 and the platform stops taking work. Runner work is drained: nothing new is handed to a runner, open polls end, and every job waiting for a runner is handed over to the next process with its runner task left running (no cancel, no lease beat, its writes stored and then fenced, its lease released with the `handed-over` mark; `src/platform/runner-handover.ts`). The next process re-queues it without counting an attempt and picks up the same task. *Built* ([runner-restarts.md](../features/runner-restarts.md)). A job busy with anything else gets up to `SHUTDOWN_GRACE_SECONDS` (60) to finish; then it is stopped the way Stop works and ends `FAILED`: "Interrupted: the platform was shut down before this job finished. Start it again when the platform is back." (`src/platform/ops/shutdown.ts`). *Built.*
- **Unclean (crash):** the job is re-queued when its 60 s lease runs out; its runner task is kept and picked up (or its stored result used) when what the new attempt would send is exactly what the task holds (`batchKey`: everything the task offer sends except its id, time limits and secret values: scripts with their content, flags, baselines and helpers, the environment, the phone or iOS part, the variants). Otherwise the earlier task is stopped before those tests are sent again. *Built.*
- **The agent's side:** polls fail and the agent retries with back-off (1 s doubling to 30 s, ±25%), says hello again after each failure, and honours `Retry-After` up to 120 s (`src/agent/backoff.ts:8-14`, `agent.ts:190-207`). A running task keeps running; heartbeats fail and are retried. *Built.*
- **A finished result while the platform is away:** kept in the outbox and sent again when the platform answers (above). *Built.* Before this round it was lost after about 23 s.
- **Recordings and phone sessions** live in memory and are given up after a restart; the agent is told `cancel` (`agent-services.ts:286-298`). *Built.*

### Worker crash
- **The job's lease:** the job's 60 s lease runs out, and the next worker start (or its loop) re-queues it, up to 3 attempts (`Repo.reclaimStaleJobs`, `worker.ts`). The previous attempt's runner tasks that are still alive are kept for the new attempt to pick up (above); giving the job up, or a project that no longer runs on runners, cancels them first (`beforeRequeue`, `runner-only.ts`). *Built.*
- **Never twice at once:** before the new attempt sends a test again, it stops any earlier task that holds that test and waits until it has stopped (`stopLeftovers`, `agent-services.ts`). Earlier tasks for other tests are left alone and picked up later, or stopped when the job ends. *Built.*
- **`runners` mode:** the dispatch worker lives in the API process. While it is not alive, `runsCanStartHere` is false and new runs get a plain 409 (`DISPATCH_DOWN_MESSAGE`); it writes the worker heartbeat that `/readyz` reads. Jobs queued before the switch that need the server's browser are ended with a plain reason when it starts. *Built.*

### Other cases
- **Runner retired during a run:** its open poll ends on its next turn (`routes/agents.ts:253`), its heartbeats get 404, the agent stops and exits with code 3, and the task follows the disconnect path. *Built.* (P2) The heartbeat answer also says `shutdown`. *Built.*
- **Project access removed during a run, or a personal runner's owner loses access:** a task already running is not stopped (`ownedTask` checks only the claiming credential, `agent-services.ts:272-278`). The check is made again at the next offer and claim. *Built.* Stopping a running test run: *Not built.* Recordings, live sessions and phone sessions end within one heartbeat when their starter loses access (`sessionAccessProblem`). *Built.*

## 6. Reconciliation

| Rule | What it does | Runs from | Status |
|---|---|---|---|
| `sweep()` | requeues running tasks whose lease ran out (offers left); fails them after the last offer; fails tasks queued for 30 min; cancels tasks whose job has ended (`agent-store.ts:633-646`) | runner polls (at most every 5 s, `SWEEP_EVERY_MS`), each executor watch tick (1 s), the scheduler | Built |
| `reclaimStaleJobs()` | re-queues jobs whose worker lease ran out, up to 3 attempts (`repo.ts:532-566`) | worker start and every worker loop | Built; cancels the old attempt's tasks first |
| `pruneTasks` | deletes finished tasks, their payloads and `_agent/<task>` files after 24 h (`agent-store.ts:649-654`) | the scheduler tick only (`schedule-services.ts:63`) | Built; in `runners` mode it rides on the scheduler in the API process, or on its own timer when the scheduler is off |
| Shutdown | stops the running job honestly and puts its tests back (`ops/shutdown.ts`) | SIGTERM / SIGINT | Built |
| Attempt fencing | any message from a superseded attempt gets 409 `superseded` | every protocol-2 task message | Built |
| Hello lists held tasks | the agent tells the server which tasks it still runs after a reconnect | — | Not built |

**Duplicates and retries.**

| Message sent twice | Before this round | Built in this round |
|---|---|---|
| Result | the second gets 409 "already received"; a result for a cancelled task gets `{ ok: true }` (`agent-services.ts:335-350`) | the same attempt's repeat gets 200 `alreadyReceived`; another attempt's gets `superseded` |
| Upload with the same name | the last one wins and is counted once (`agent-store.ts:662-667`) | kept per attempt, so a re-offer starts clean |
| Heartbeat retried | its log lines are stored twice | live events are stored once per `(task, attempt, seq)` |
| Claim | exactly one runner wins (one conditional `UPDATE`) | unchanged |

## 7. Timings

| What | Value | Setting | Where |
|---|---|---|---|
| Runner poll (long poll) | 25 s (1–55) | `AGENT_POLL_SECONDS` | `agent-services.ts:65` |
| Task heartbeat | 10 s (1–30) | `AGENT_HEARTBEAT_SECONDS` | `:66` |
| Task lease | 60 s (2–600), renewed by each heartbeat | `AGENT_LEASE_SECONDS` | `:67` |
| No capable runner grace | 90 s (0–1800) | `AGENT_NO_AGENT_GRACE_SECONDS` | `:71` |
| Executor watch tick | 1 s (20 ms–5 s) | `AGENT_WATCH_MS` | `:72` |
| Online window (runner counts as online) | 45 s since last seen | constant `ONLINE_MS` | `agent-store.ts:166` |
| Offers per task | 2 | constant `MAX_OFFERS` | `agent-store.ts:299` |
| Queue limit | 30 min | constant `QUEUE_MAX_MS` | `agent-store.ts:301` |
| Finished tasks kept | 24 h | constant `TASK_KEEP_MS` | `agent-store.ts:303` |
| Sweep from polls | at most every 5 s | constant `SWEEP_EVERY_MS` | `agent-services.ts:120` |
| Executor deadline | `timeoutMs` + 5 min, or 4 h | none | `agent-services.ts:759` |
| Job lease / renewal | 60 s / every 5 s | constants `LEASE_MS`, 5 000 ms | `job-runner.ts:50,141` |
| Job limit | 120 min (0–10 080) | `JOB_MAX_MINUTES` | `src/config.ts:42` |
| Job attempts after a lost worker | 3 | none | `repo.ts:542,547` |
| Shutdown grace | 60 s | `SHUTDOWN_GRACE_SECONDS` | `ops/shutdown.ts` |
| Agent watchdog | the task's limit + 90 s | constant `WATCHDOG_GRACE_MS` | `src/agent/task-runner.ts:47` |
| Agent result tries (protocol 1) | 6, about 23 s in all | constant `RESULT_ATTEMPTS` | `task-runner.ts:50` |
| Agent upload tries | 3 per file | constant `UPLOAD_ATTEMPTS` | `task-runner.ts:49` |
| Agent reconnect back-off | 1 s doubling to 30 s, ±25%; `Retry-After` up to 120 s | none | `src/agent/backoff.ts:8-14` |
| Agent request timeouts | hello 20 s, poll = poll seconds + 20 s, heartbeat 15 s, file 30 min, result 60 s | none | `src/agent/client.ts` |
| Agent graceful stop | 20 s drain | none | `agent.ts:214` |
| Runner concurrency | 1 (1–8) | `--concurrency`, `AITP_AGENT_CONCURRENCY` | `src/agent/config.ts:237-238` |
| Dispatch worker jobs at once | 8 (1–64) | `DISPATCH_CONCURRENCY` | `src/config.ts` |
| Accept window (P2) | 30 s (1–300) | `AGENT_ACCEPT_SECONDS` | `agent-services.ts` (`agentLimits`) |
| Live event batch (P2) | about 1 s or 50 events; at most 100 per request | `MAX_EVENTS_PER_BATCH` | `src/agent/live-events.ts`, `schema.ts` |
| Kept results (P2) | retried 2 s up to a minute, dropped after a day | none | `src/agent/outbox.ts` |
| Windows tray stop wait | 25 s, then a hard kill | `STOP_GRACE_MS` | `src/agent/stop-file.ts`, `installer/win/RunnerHost.cs` |

## 8. What backs these claims

- **Ran during the audit (Linux, Node 22):** `agent-platform-unit` (claim once, lease, re-offer then fail, cancel, stale, prune), `runs-off-here`, `runners-shared`, `live-hardening`, `runner-update-unit`, the agent's unit tests (back-off, client, file cache).
- **Read, not run here:** `agent-platform` (fixed ports: no runner, incapable runner, cancel, lost agent, slow task, `ok: false`, a full job through the worker), `agent-program` (real agent against a stand-in platform: cancel kills the tree, reconnect after a platform restart, revoked during a run, graceful stop), `stream-agent` (live progress lines).
- **Not tested at `e344261`:** a worker crash during a runner run (the orphaned task), the agent's watchdog, an agent killed mid-task and restarted, a retried result after a lost answer, duplicated heartbeat lines, sleep and wake, a network change.
- **This round's tests:** `tests/runner-only-mode.test.ts` (dispatch, refusals, shutdown, stale jobs), `tests/runner-protocol2.test.ts` and `runner-protocol2-unit` (attempts, accept and reject, phases, live events, outbox, an unchanged protocol-1 agent), `tests/runner-enroll.test.ts`, `tests/runner-personal.test.ts`, `tests/runner-stop-file-unit.test.ts`, `tests/runner-journey-ui.test.ts` (the whole path with a real agent and browser). `PROGRESS.md` records which ran and their results.
