# Agent communication protocol

Every message between the backend and a runner agent. Written 2026-11-07, starting from commit `e344261`, and brought in line with the code after the build the same day.

Labels used below:

- **Built**: in the code. Sections 1 and 3 describe protocol 1 as it was at `e344261` (line references point at that commit) and as it still is. Sections 4 and later describe protocol 2 and enrollment, built in this round; they name files and functions in the current tree.
- **Not built**: not in the code, with the reason.

`docs/features/runner-protocol-2.md` and `docs/features/runner-enrollment.md` are the feature pages for the same messages.

The shared contract is one file, `src/agent-protocol/schema.ts`. The backend (`src/platform/agent-*.ts`, `src/platform/routes/agents.ts`) and the agent (`src/agent/*`) both import it, so they cannot drift apart.

## 1. Transport and authentication (built)

- HTTPS with JSON bodies. File transfers are raw bytes.
- The agent always connects out. The backend never connects to the agent. Anything the backend wants to tell the agent rides on the answer to one of the agent's requests (see section 7).
- The agent refuses plain `http://` to a public address unless started with `--allow-insecure`. Loopback and private addresses are allowed with a warning (`src/agent/config.ts:159-173`). It never follows a redirect (`redirect: "error"`, `src/agent/client.ts:125`). In production TLS ends at nginx.
- Every agent request carries `Authorization: Bearer aitg_<token>`. Enrollment is the one exception (section 4.1).
- The agent routes are an exact, anchored allow-list (`src/platform/agent-routing.ts:33-51`). They are the only routes that skip the API key, and the API key never works on them. One hook checks the token for the whole scope (`src/platform/routes/agents.ts:204-206`).
- Missing or malformed token: 401. Unknown or retired token: 404. The two refusals look the same on purpose (`src/platform/agent-services.ts:155-162`).
- Both sides validate every body with the shared zod schemas. The backend parses each body with a size cap (`routes/agents.ts:82-111`). The agent validates every answer (`client.ts:160-172`). An offer that does not match is reported by its id instead of crashing the agent.
- zod objects drop fields they do not know. A new optional field is therefore ignored by an older reader in either direction. This is what makes additive changes safe.

## 2. Versions and negotiation

### Built: protocol 1

- `PROTOCOL_VERSION = 1` (`schema.ts:25`).
- The hello request carries `protocol`. The backend refuses any other value with 409 and a sentence (`agent-services.ts:171`).
- The agent checks the `protocol` in the hello answer and stops with exit code 4 when it differs (`src/agent/agent.ts:232-235`).
- Detail: the agent turns a 409 on hello into "refused" (exit code 5) before it looks for a protocol problem (`client.ts:141-143`). A protocol refusal from the backend therefore ends the agent with code 5 and the backend's sentence, not code 4.
- Many features were added inside version 1 as optional fields: recording, phone sessions, updates, the computer check, browsers, network. The rule was: optional, and sent only to an agent that reports the capability.

### Built in this round: protocol 2

- `PROTOCOL_VERSION` is 2 and `SUPPORTED_PROTOCOLS` is `[1, 2]` (`src/agent-protocol/schema.ts`).
- The agent's hello carries `protocol: 1` (the oldest version it speaks, so a protocol-1 platform accepts it) and `protocols: [1, 2]`. The backend answers `protocol` with the highest version both speak (`negotiateProtocol`, `src/platform/agent-routing.ts`) and keeps it on the machine row (`agents.protocol`).
- A protocol-1 agent (no `protocols` list) is answered `protocol: 1` and gets exactly the behaviour of `e344261`. Every server change is additive: new routes, new optional fields.
- If an older platform still refuses the hello because of the version, the agent says hello once more with protocol 1 only and runs as a protocol-1 agent.
- Where protocol 2 adds a signal, a protocol-1 agent gets the protocol-1 equivalent: the server's deadline arrives as `cancel: true`, and a retired runner sees its token refused.

## 3. Protocol 1 messages (built)

### 3.1 Hello: `POST /api/agent/hello`

| | |
|---|---|
| Sent by | The agent, at start and again after every connection failure (`agent.ts:190-207`) |
| Request | `HelloRequest` (`schema.ts:178-186`): `protocol`, `name` (1-64 characters), `version`, `capabilities`, `concurrency` (1-8) |
| Answer | `HelloResponse` (`schema.ts:189-200`): `agentId`, `projectId` (`"shared"` for a runner with no project of its own), `protocol`, `pollSeconds`, `heartbeatSeconds`, `maxFileBytes`, `serverTime`, and `update` when the runner should update |
| Backend checks | At most 6 per minute per token, else 429 (`agent-services.ts:150,165-168`). A second computer using the same token while another one is online gets 409 (`:173-174`). Creates or updates the `agents` row for this token and name. |
| Agent timeout | 20 s (`client.ts:187`) |
| Retry | Back-off from 1 s to 30 s with ±25% jitter, honouring `Retry-After` up to 120 s (`src/agent/backoff.ts`, `client.ts:139-140`) |
| Idempotent | Yes: it updates the same row |

`Capabilities` (`schema.ts:56-158`): `os` (`win32`, `darwin`, `linux`), `arch`, `node`, Playwright `browsers`, `android` (adb, devices, emulators), `ios`, `windows` (UI Automation, interactive session, elevated, allowed apps), `record`, `recordHeaded`, `liveSession`, `deviceSession`, `customScripts`, `phoneTools`, `kitVersion`, `browser`, `installedBrowsers`, `browserNote`, `network`, `update`, `check`. At `e344261` not reported: OS version, memory, CPU count, Playwright version, list of adapters. Built in this round: `osVersion`, `memoryMb`, `cpus`, `playwrightVersion`, `adapters` (`machineIdentity`, `src/agent/capabilities.ts`), and `runnerSwitches` (the agent understands the runner's switches).

### 3.2 Poll: `POST /api/agent/poll`

| | |
|---|---|
| Sent by | The agent, in a loop while it has a free slot. It is also the idle heartbeat and refreshes the capabilities. |
| Request | `PollRequest` (`schema.ts:276-282`): `agentId`, `capabilities` (optional), `freeSlots` (0-8) |
| Answer | 200 with a `TaskOffer`, or 204 when nothing came within the wait. Either may carry the header `x-runner-update: <auto\|requested> <version>`. |
| Backend behaviour | Holds the request open up to `pollSeconds` (25 s), looking for a task every 250 ms (`routes/agents.ts:247-262`). A newer poll from the same agent ends the older one (`agent-services.ts:255`). The token is checked again on every turn, so a retired runner gets nothing more (`routes/agents.ts:253`). Last seen is refreshed every 5 s. |
| Claim | One conditional `UPDATE … WHERE status = 'queued' AND project_id IN (runner_access of a live token)`, in one transaction with the device reservation (`src/platform/agent-store.ts:541-554`). Exactly one agent can win. |
| Agent timeout | `pollSeconds` + 20 s (`client.ts:197`) |
| Acknowledgement | None. The task is claimed when the answer is made. If the answer is lost, the task stays "running" until its lease runs out, and that uses one of its 2 offers. Fixed by accept/reject in protocol 2. |

Which task a runner is offered (`offerTo`, `agent-services.ts:199-235`): the oldest queued task of its owner (`queuedOfOwner`), skipping a task that needs something this computer lacks (`capabilityProblem`, `agent-routing.ts:108-133`), has hand-written scripts when its owner's switch is off, or needs a device another task holds. Record and phone-session tasks go only to the computer they were started on.

### 3.3 The task offer

`TaskOffer` (`schema.ts:621-653`), checked on arrival with `CheckedTaskOffer` (`:659-665`; a run task needs at least one script):

- `taskId`, `jobId`, `adapterId`, `leaseSeconds`, `workers` (1-8), `timeoutMs`, `testTimeoutMs`, `startTimeoutMs`, `projects` (cross-browser).
- `kind`: `run` (default), `record` or `device`.
- `scripts`: `WireScript` (`:305-315`): `testId`, `filename`, `content`, `baselines`, `custom` (hand-written), `session` (start signed in).
- `helpers`: up to 20 shared modules of at most 100 KB.
- `env`: `WireRunEnv` (`:289-302`): `baseUrl`, `apiBaseUrl`, `credentials`, `roles`, `apiToken`, `apiAuthHeader`, `vars`, `cleanup`, `headless`, `storageState`.
- `mobile`, `ios`, `record`, `device` for those task kinds.

The offer carries the run's secrets (accounts, tokens, saved sign-in). It travels only over the authenticated connection. The backend keeps it encrypted at rest. The agent never logs it and never writes it to disk outside the test process's environment (`schema.ts:19-21`).

### 3.4 Heartbeat: `POST /api/agent/tasks/:id/heartbeat`

| | |
|---|---|
| Sent by | The agent, for each running task, every `heartbeatSeconds` (10 s). New progress lines go out within about a second (`src/agent/task-runner.ts:146-170`). |
| Request | `HeartbeatRequest` (`schema.ts:669-674`): `done`, `total`, `log` (at most 20 lines of at most 300 characters, already masked by the agent) |
| Answer | `HeartbeatResponse` (`schema.ts:677-685`): `cancel`, `leaseSeconds`, and `commands` (recordings) or `deviceCommands` (phone sessions) |
| Backend checks | Only the agent that claimed the task (`ownedTask`, `agent-services.ts:272-278`); anything else is 404. Extends the lease. Keeps the last 200 lines in `log_json`. Turns the lines into masked `agent_progress` job events (`:434-446`). A task that is no longer running answers `cancel: true`. |
| Agent timeout | 15 s (`client.ts:216`) |
| Retry | Unsent lines go with the next beat. A warning after 3 failures; the run continues. A 404, 409 or 410 stops the task on the agent: the backend no longer expects its result. |
| Idempotent | No. A retried beat stores its lines twice. Fixed by live events with sequence numbers in protocol 2. |

### 3.5 Download a task file: `GET /api/agent/tasks/:id/files/:ref`

Only files registered for this task, only while it runs, only for the agent that claimed it (`agent-services.ts:305-311`). The answer is streamed with `content-length` and `x-content-sha256`. 409 when the file changed after the task was made, 404 when unknown. The agent checks size and SHA-256 before using the file (`src/agent/file-cache.ts:85-95`) and caches it by hash. Timeout 30 minutes.

### 3.6 Upload a file: `PUT /api/agent/tasks/:id/files/:name`

| | |
|---|---|
| Rules | `name` must be a safe file name (`SafeName`, `schema.ts:29`). Only while the task runs, only from the agent that claimed it (409 or 404 otherwise). |
| Caps | 64 MB per file (`AGENT_MAX_FILE_BYTES`), 512 MB (`AGENT_TASK_MAX_BYTES`) and 300 files (`AGENT_TASK_MAX_FILES`) per task, 413 beyond. nginx allows 100 MB per request. |
| Integrity | An optional `x-content-sha256` header. The backend's own hash is the truth; a mismatch is refused with 400 and the file is not kept. The file never appears half-written under its name. |
| Answer | `UploadResponse`: `ref`, `size`, `sha256` |
| Agent | 3 attempts, waiting 0.4 s and 0.8 s (`task-runner.ts:586-601`). Timeout 30 minutes. |
| Idempotent | Yes for the same name: the last upload replaces the earlier one and is counted once (`agent-store.ts:662-667`) |

### 3.7 Result: `POST /api/agent/tasks/:id/result`

| | |
|---|---|
| Request | `ResultRequest` (`schema.ts:715-724`): `ok`, `error` (at most 500 characters), `runs` (`WireRun`, at most 500), `browser` |
| `WireRun` (`:696-712`) | `testId`, `status` (`passed`, `failed`, `timedOut`, `skipped`, `error`), `durationMs`, `error` (2000), `failedStepIndex`, `steps` (title, status, error 800), `artifacts` (kind and uploaded name), `vision`, `notes`, `newBaselines`, `responses`, `metrics`, `variant`, `created` (cleanup ledger) |
| Meaning of `ok: false` | The agent could not run the task (tools missing, cancelled, crashed). It is a problem with the run, never a test verdict. |
| Backend | Only the claiming agent. A cancelled task answers `{ ok: true }`. A task no longer running answers 409 "already received". The result is masked against the run's secrets and stored encrypted (`agent-services.ts:335-350`). Cap 8 MB (`routes/agents.ts:31`). |
| Agent | 6 attempts, waiting 1, 2, 4, 8 and 8 s, about 23 s in all (`task-runner.ts:614-628`). It stops early when the backend refuses. Timeout 60 s (`client.ts:292`). |
| Idempotent | Protocol 1: no. A second result gets 409, even when the first one arrived and only its answer was lost. Protocol 2: yes, per attempt (section 4.9). |

Files named in a result but never uploaded were dropped without an event at `e344261`. Built in this round: a `runner_file_missing` event names each one.

### 3.8 Recording and phone-session pushes

- `POST /api/agent/tasks/:id/recording` with `RecordingPush` (`schema.ts:484-497`), and `POST /api/agent/tasks/:id/device` with `DevicePush` (`:610-618`). Each is capped at 1 MB.
- Commands from the web page arrive in the heartbeat answer. The agent applies each command, then reports its id in `acked` or answers it in `results`.
- Phone commands are repeated until answered; the agent runs each id once.
- These tasks are never offered to another computer.

### 3.9 Updates

- `POST /api/agent/update` with `{ agentId }` answers `{ update?: RunnerUpdateOffer }`.
- `GET /api/agent/update/files/:name` streams one file with `x-content-sha256` (`src/platform/routes/runner-updates.ts:45-64`).
- `RunnerUpdateOffer` (`schema.ts:244-253`): `version`, `reason` (`auto` or `requested`), `files` (name, size, SHA-256), `complete` (parts of a complete download).
- The runner reports its state in `capabilities.update` (`:219-234`).
- Exit code 75 asks the host to start the runner again at once (`:214`).

### 3.10 Computer check: `POST /api/agent/check`

Says whether the token is accepted and names the project, if any (`routes/agents.ts:223-233`). Changes nothing.

## 4. Protocol 2 and enrollment (built in this round)

The schemas are in `src/agent-protocol/schema.ts` (sections "enrollment" and "protocol 2"); the handlers in `src/platform/routes/agents.ts` and `src/platform/agent-services.ts`; the agent side in `src/agent/client.ts`, `agent.ts`, `task-runner.ts`, `live-events.ts` and `outbox.ts`. Every new agent route is in the anchored allow-list (`ROUTES`, `agent-routing.ts`).

### 4.1 Enroll: `POST /api/agent/enroll`

| | |
|---|---|
| Sent by | The agent at first contact, started with `--enroll <code>` or `--enroll-file <path>` (the installers pass the downloaded `runner.enroll`; the file is deleted once used) |
| Authentication | None: the code in the body is the credential. A request with an `Authorization` header is refused (400). Limited per address and per code (429). |
| Request | `EnrollRequest`: `code` (`aite_` plus 32 random bytes), `name`, `machineId` (a random install id the agent makes once and keeps in `runner.machine`), optional `version` and `capabilities` |
| Answer | 201 `EnrollResponse`: `{ token, runnerId, kind }`. `token` is the runner credential (`aitg_`), given once |
| Backend checks | The code is stored as SHA-256, used once, valid 30 minutes (`AgentStore.redeemEnrollment`). Expired, used, or a team code made before one runner per person: 410; unknown: 404. Each answer says to download the runner again from Settings. Trading a code retires the person's earlier runner credential. |
| Agent | Saves the credential in the operating system's store (`src/agent/credential-store.ts`), deletes the code file, then says hello with the credential |
| Idempotent | Partly: if the answer is lost, the same install id may ask again with the same code while the code is valid and the first credential was never used; it gets a fresh credential and the first one stops working. Any other caller gets "already used". |

The website side (`POST /api/runners/enroll`, `GET /api/runners/enrollments/:id`, the kit routes with `x-runner-enrollment-id` and `x-runner-enrollment-expires`) is described in `RUNNER_ARCHITECTURE.md`.

### 4.2 Hello, additions

- `machineId` (optional). The backend binds a credential to the first install id it sees. The same credential from another install id, or from none when the credential came from a code, is refused with a plain sentence and an Activity entry (`runner-refused`). Without a `machineId` (older agents with a token given by hand), the old behaviour applies.
- New optional capability fields: `osVersion`, `memoryMb`, `cpus`, `playwrightVersion`, `adapters`, `runnerSwitches`.
- The answer carries `rotate: true` when the credential is 30 days old, or was presented as the old one of a rotation.
- The answer carries `runner: { id, kind, customScripts, privateTargets }`, so the agent enforces the runner's switches as well as the backend.
- Not built: the agent's `version` is still the constant `"1.0.0"` (`AGENT_VERSION`, `src/agent/config.ts`). A downloaded runner's real version is `capabilities.kitVersion`.

### 4.3 Rotate: `POST /api/agent/rotate`

- Answers `RotateResponse`: `{ token, previousValidUntil }`. Limited like hello (6 a minute).
- The old credential keeps working until the new one is first used, for at most 24 hours. Asking again with the old one replaces an unused new one, so a lost answer never locks the runner out.
- The agent rotates when hello says `rotate: true`; a runner that stays connected says hello once a day to check (`rotateCredential`, `src/agent/agent.ts`). Each rotation is an Activity entry (`runner-credential-rotated`).

### 4.4 Offer, additions

- `attemptId`: a new random id for every hand-out, including a re-offer of the same task. Every later message about the task carries it (uploads in the header `x-attempt-id`).
- `attempt`: 1 for the first hand-out, 2 after a re-offer, and so on.
- `acceptSeconds`: how long the agent has to accept.
- Eligibility is decided before the offer is made (`offerTo`): a personal runner is offered only its owner's tasks (`agent_tasks.owner_id`), in projects that allow people's own computers and that the owner can still open with `tests.run`. A run started with `runnerId` is offered only to that runner. Code-script tasks go only to runners that allow them. A task whose site or API address is a private literal address goes only to a runner that allows private addresses. The claim checks the owner again.
- The private-address rule is not a field of the offer: it reaches the agent in the hello answer (`runner.privateTargets`) and in the heartbeat answer (`config`), and the agent applies it to every task (`src/agent/address-guard.ts`).

### 4.5 Accept: `POST /api/agent/tasks/:id/accept`

- Body: `{ attemptId }`. Answer: `{ ok: true, leaseSeconds }`.
- A protocol-2 agent must accept within `acceptSeconds` (`AGENT_ACCEPT_SECONDS`, default 30). Otherwise the task goes back to the queue without using up an offer, and the run's events say "… did not accept the run in time; offering it again." (`runner_requeued`). The third accept timeout for the same task fails it: "The run was offered to a runner 3 times and never accepted. Check that the runner is connected and up to date, then run again." An accept timeout is not counted as a runner's refusal.
- A protocol-1 agent's claim counts as accepted.

### 4.6 Reject: `POST /api/agent/tasks/:id/reject`

- Body: `{ attemptId, reason, message }`. `reason` is one of `missing-browser`, `missing-tools`, `code-scripts-off`, `private-target`, `busy`, `no-display`, `unsupported`, `other` (`REJECT_REASONS`). `message` is a plain sentence.
- The task goes back to the queue without using up an offer and is never offered to that runner again. Each rejection is a `runner_rejected` event. The run fails only when no runner that may take it is left online; its error lists every runner's reason.
- The agent decides before downloading anything. A protocol-1 agent answers the same sentence as a result with `ok: false`.

### 4.7 Heartbeat, additions

- Request: `attemptId`, and the `phase` the agent is in: `preparing` (downloading files, starting the browser), `running` or `uploading`. A protocol-1 heartbeat counts as `running`.
- Answer, besides `cancel` and `leaseSeconds`:
  - `timeout: true`: the backend's time limit for the run passed; the agent stops at once.
  - `shutdown: true`: the runner was retired, or a personal runner's owner is no longer active; it finishes what runs, takes nothing new and exits (`shutdownWanted`).
  - `config: { customScripts?, privateTargets? }`: the runner's switches changed since the task was handed out; they apply to the next task (`runnerConfig`).
- Heartbeat lines are scrubbed before they are stored on the task.
- A message for an attempt that is no longer current gets 409 with `details: { code: "superseded" }`, and the agent stops that attempt.

### 4.8 Live events: `POST /api/agent/tasks/:id/events`

| | |
|---|---|
| Request | `EventsRequest`: `{ attemptId, events: [{ seq, at, type, … }] }`, 1 to 100 events |
| `type` | `test_started`, `test_finished` (status, duration, error text; a stack the runner sends is not stored with the live event, only in the final result), `step_started`, `step_finished` (index, title, status, duration, error text), `log`, `screenshot` (names a file this attempt already uploaded), `phase` |
| Agent | Batches events: at most about 1 s or 50 events per request (`src/agent/live-events.ts`). Retries a batch until it is accepted. Masks the run's secrets first. |
| Backend | Answers `{ ok, stored, duplicates }`. Stores each event once (`agent_task_events`, keyed by task, attempt and `seq`), scrubs it again, and writes it as a job event: `runner_test_started`, `runner_step` (`state` started or finished), `runner_test_finished`, `runner_screenshot`, `runner_log`, `runner_phase`. The platform adds `runner_attempt`, `runner_rejected`, `runner_requeued`, `runner_lost` and `runner_file_missing`. The website's existing stream carries them and a refresh replays them. |
| Idempotent | Yes, on `(taskId, attemptId, seq)` |
| Cap | Per attempt `LIVE_EVENTS_MAX` (5,000) events or `LIVE_EVENT_BYTES_MAX` (5 MB); past that one note is kept and the rest are answered 200 and dropped, so the runner does not resend them. The result still has everything. |
| Engine coverage | Playwright web and API runs report steps through `LIVE_REPORTER` (`src/engine/validation/runner.ts`), added only when a runner asks for live events; scripts are not changed. Android, iOS and Windows desktop runs send one `test_finished` per test when the run ends. |
| Pictures | `GET /api/projects/:id/runs/:jobId/runner-files/:taskId/:name` serves a live screenshot (PNG or JPEG of a task of that run of that project, read permission) while the task is kept (a day) |

### 4.9 Uploads and results, additions

- Uploads (header `x-attempt-id`) and results carry the `attemptId`. A new attempt starts with no uploaded files. Upload budgets are reserved while an upload streams.
- A repeated result for the same attempt answers 200 with `alreadyReceived`, not 409.
- A result for an older attempt answers 409 with `superseded`; a result for a task the platform already ended (timed out, lost) answers 410.
- The agent writes the finished result to `<work folder>/outbox/<task>.json` (readable only by its user, never the task's credentials) before posting it, and removes it only when the backend answers 2xx, 404, 409 or 410. It retries with growing waits (2 s up to a minute), sends kept results first after every reconnect, keeps them across a restart, and drops one older than a day (`src/agent/outbox.ts`).

### 4.10 Phases

`agent_tasks.phase` is one of `queued`, `assigned`, `accepted`, `preparing`, `running`, `uploading`, `completed`, `rejected`, `failed`, `cancelled`, `timed_out`, `lost_connection` (`TASK_PHASES`).

- Only the backend writes it. A protocol-2 agent reports `preparing`, `running` and `uploading`, and the backend decides. Each change is a `runner_phase` event.
- Within an attempt a phase only moves forward and never leaves a final phase. A re-offer starts a new attempt at `queued`.
- The run shows the phase together with the runner that took it (`ranOn.phase`, `ranOn.attempt`).
- An interrupted run is never reported as passed.

`JOB_EXECUTION_LIFECYCLE.md` lists every transition.

### 4.11 Stopping on the computer

- On SIGTERM, SIGINT or the stop file `stop.request`, the agent cancels its running tasks, reports "The agent was stopped.", and exits (`src/agent/stop-file.ts`). The agent watches its work folder and the folder of `runner.mjs`; a stop file left from before is deleted at start.
- The Windows tray app writes the stop file and waits up to 25 s before ending the runner (`installer/win/RunnerHost.cs`).

### 4.12 Signed updates

- The deploy signs the update manifest (version, a sequence number, every file and part with size and SHA-256) with Ed25519 (`scripts/sign-runner-update.mjs`). The offer carries the manifest and signature unchanged (`signed` in `RunnerUpdateOffer`; older runners ignore it).
- The runner checks the signature against the keys pinned in its bundle (`PINNED_UPDATE_KEYS`), that every offered file is in the manifest with the same size and SHA-256, and that the sequence is newer than its own, before downloading anything. An update that does not check is refused; the runner keeps running and reports `update.state: "needs-manual"`.
- Without a valid signature the platform offers no update. No key is pinned yet, so today no runner updates itself.
- A runner from before this round cannot check signatures. It accepts the first signed update through its old checksum check.

## 5. Timings and limits

| What | Value | Where it is set | Status |
|---|---|---|---|
| Long-poll wait | 25 s (1-55) | `AGENT_POLL_SECONDS` (`agent-services.ts:65`) | Built |
| Heartbeat interval | 10 s (1-30) | `AGENT_HEARTBEAT_SECONDS` | Built |
| Task lease | 60 s (2-600), renewed by each heartbeat | `AGENT_LEASE_SECONDS` | Built |
| Online window | Seen in the last 45 s | `ONLINE_MS` (`agent-store.ts:166`) | Built |
| Offers per task | 2, then the task fails | `MAX_OFFERS` (`agent-store.ts:299`) | Built |
| No capable runner online | A person's run fails after 90 s; a schedule's or trigger's waits to the 30-minute queue limit (`noRunnerWaitMs`) | `AGENT_NO_AGENT_GRACE_SECONDS` | Built |
| Nobody picked it up | Task fails after 30 minutes | `QUEUE_MAX_MS` (`agent-store.ts:301`) | Built |
| Backend's wait for a task | `timeoutMs` + 5 minutes, or 4 hours without one | `agent-services.ts:759` | Built |
| Agent watchdog | The task's limit + 90 s, then the process tree is ended | `WATCHDOG_GRACE_MS` (`task-runner.ts:47`) | Built |
| Job limit | 120 minutes | `JOB_MAX_MINUTES` | Built |
| Sweep of lost tasks | At most every 5 s from polls, every 1 s per waiting task | `SWEEP_EVERY_MS`, `AGENT_WATCH_MS` | Built |
| Finished tasks kept | 24 hours | `pruneTasks` | Built |
| Hello rate | 6 a minute per token | `agent-services.ts:150` | Built |
| Other requests | 900 a minute per token | `agent-services.ts:151` | Built |
| Polls | One open poll per computer; a newer one ends the older | `beginPoll` | Built |
| JSON body | 2 MB; result 8 MB; pushes 1 MB | `routes/agents.ts:30-31` | Built |
| Agent request timeouts | hello 20 s, poll wait + 20 s, heartbeat 15 s, push 15 s, update 20 s, file 30 min, result 60 s | `client.ts` | Built |
| Reconnect back-off | 1 s doubling to 30 s, ±25%, `Retry-After` up to 120 s | `backoff.ts` | Built |
| Accept window | 30 s (1-300) | `AGENT_ACCEPT_SECONDS` | Built |
| Event batch | About 1 s or 50 events from the agent; at most 100 per request | `src/agent/live-events.ts`, `MAX_EVENTS_PER_BATCH` | Built |
| Enrollment code life | 30 minutes, single use | `ENROLLMENT_TTL_MS` | Built |
| Rotation | After 30 days; old credential valid until the new one is used, at most 24 h | `ROTATE_AFTER_MS`, `ROTATION_GRACE_MS` | Built |
| Windows graceful stop | Up to 25 s before ending the runner | `STOP_GRACE_MS` | Built |
| Kept results (outbox) | Retried 2 s up to a minute; dropped after a day | `src/agent/outbox.ts` | Built |

## 6. Answers and what the agent does

| Answer | On hello or poll | On any other request |
|---|---|---|
| 2xx | Carry on | Carry on |
| 401, or 404 on hello or poll | Stop, exit code 3 ("token not valid or revoked") | That request is given up. The next poll or hello stops the agent. |
| 404 on a task request | | Heartbeat: the task is gone for this agent, so it is stopped. Upload or result: given up, not retried. |
| 409 | Stop, exit code 5, with the backend's sentence | Heartbeat: stop the task. Result: given up; the backend already has one (protocol 2: `superseded` stops the attempt, `alreadyReceived` is a success) |
| 410 | | Heartbeat: stop the task |
| 413 or 400 on an upload | | Not retried. That file is missing from the run, which carries on |
| 426, or 400 naming the protocol | Stop, exit code 4 | That request fails |
| 429, 5xx, network error | Back off and try again | Retried within that request's attempts (upload 3, result 6). A heartbeat never stops the run on these. |

Exit codes (`agent.ts:29`): 0 stopped, 1 failed, 2 usage, 3 token refused, 4 protocol, 5 refused. 75 means start again after an update. Where they come from: `agent.ts:195-199` (hello and poll), `task-runner.ts:159-166` (heartbeat), `task-runner.ts:596-599` (upload), `task-runner.ts:620-625` (result).

## 7. How the backend reaches a runner

There is no push channel. Each signal rides on an answer.

| Signal | Runner idle (polling) | Runner busy (heartbeating) |
|---|---|---|
| A task for you | Poll answer 200 | Next poll from a free slot |
| Cancel this task | | Heartbeat answer `cancel: true` |
| Your deadline passed | | Protocol 2: `timeout`. Protocol 1: `cancel: true` |
| Your switches changed | Applied at offer time; the next hello carries them | Protocol 2: `config` |
| Update available | `x-runner-update` header on the poll answer, `update` in hello | The same, after the task |
| Retired | Open poll answers 204 at once; next request 404, exit code 3 | Protocol 2: `shutdown`. Protocol 1: heartbeat 404, the task stops |
| Rotate your credential | Protocol 2: the hello answer | The same |

## 8. Requested event names and the real messages

The event names from the requirements (R7 in `archive/CURRENT_STATE_AUDIT.md`), mapped to what exists.

| Requested name | Direction | Protocol 1 (built) | Protocol 2 (built) |
|---|---|---|---|
| RUNNER_REGISTERED | agent to backend | First hello for a token creates the computer's row | `POST /api/agent/enroll`, then hello |
| RUNNER_HEARTBEAT | agent to backend | Poll (idle) and task heartbeat | Same, heartbeat carries `attemptId` and `phase` |
| RUNNER_CAPABILITIES_UPDATED | agent to backend | Capabilities in every hello and poll | Same, with the new identity fields |
| JOB_ASSIGNED | backend to agent | Poll answer 200 with a `TaskOffer` | Same, with `attemptId` |
| JOB_ACCEPTED | agent to backend | Implicit: the claim is the acceptance | `POST …/accept` within `AGENT_ACCEPT_SECONDS` (30 s) |
| JOB_REJECTED | agent to backend | Only a result with `ok: false`, which fails the run | `POST …/reject` with a reason; offered to another runner |
| JOB_STARTED | agent to backend | No message; the first heartbeat | `phase` event or heartbeat with `running` |
| EXECUTION_PROGRESS | agent to backend | Heartbeat `done` and `total`, and lines such as "Finished 1 of 3 tests" | `test_started` and `test_finished` events, and phases |
| STEP_STARTED | agent to backend | None; steps arrive with the result | `step_started` event, stored as `runner_step` |
| STEP_COMPLETED | agent to backend | None; steps arrive with the result | `step_finished` event, stored as `runner_step` |
| LOG | agent to backend | Heartbeat `log` lines, stored as `agent_progress` | `log` event, stored as `runner_log` |
| SCREENSHOT_CAPTURED | agent to backend | None live; files are uploaded after the run | Upload, then a `screenshot` event, stored as `runner_screenshot` |
| VIDEO_AVAILABLE | agent to backend | A `video` artifact named in the result | Same; no live video event is planned |
| TEST_FAILED | agent to backend | In the result (`WireRun.status`, `error`) | `test_finished` with status and error text, stored as `runner_test_finished` (the stack only in the final result) |
| JOB_COMPLETED | agent to backend | Result with `ok: true` | Same, idempotent per attempt |
| JOB_CANCELLED | agent to backend | Result with `ok: false` after a cancel; stored as cancelled | Same |
| JOB_ERROR | agent to backend | Result with `ok: false` and a sentence | Same, or a reject when the run never started |
| JOB_CANCELLED | backend to agent | Heartbeat answer `cancel: true` | Same |
| JOB_TIMEOUT | backend to agent | None; the agent's watchdog and the backend's lease | Heartbeat answer `timeout` |
| CONFIGURATION_UPDATED | backend to agent | Only through the next hello | Heartbeat answer `config` |
| UPDATE_AVAILABLE | backend to agent | `update` in hello, the `x-runner-update` header, `POST /api/agent/update` | Same, with a signed manifest |
| SHUTDOWN_REQUESTED | backend to agent | None; retiring the runner makes its token refused | Heartbeat answer `shutdown` |

## 9. What an unchanged protocol-1 agent sees after this round (built)

- The same routes and answers. Its `aitg_` token keeps working. It is not asked to rotate and is not bound to a `machineId`.
- Its claim counts as accepted. A result with `ok: false` behaves as before.
- It sends no live events. Its heartbeat lines still become progress events on the run (`agent_progress`), now scrubbed before they are stored. The run page shows the phases it can know (queued, running) and says that steps and screenshots appear with the results.
- It gets no task whose code scripts depend on the runner's switches, and no recording or phone session on a personal runner (both need `runnerSwitches`).
- The backend's rules still apply to it, because they are checked before an offer is made: personal-runner eligibility, the per-run runner choice, code scripts and capabilities.
- `tests/runner-protocol2.test.ts` proves that an unchanged protocol-1 agent still runs a job; an upgrade check on a production-shaped copy, with the agent program of `e344261`, is part of integration.

## Round 45 (2026-11-11): one runner per person

This document describes rounds 39 to 44 as they were built. Round 45 replaced the team and shared runners with one simple model; where the text above says otherwise, this section wins.

- **One runner per person**, set up once in Settings (`#/settings#runner`) and used for every run that person starts, in every project they may run tests in. Setting up a computer again retires the person's earlier credential; there is no cap list (the 5-computer cap is gone).
- **Removed:** team runners, Crowd4Test's shared runner, project runner tokens and kits (`/api/projects/:id/agent-tokens*`, `/runner-kits*`), runner access (`/runner-access*`, `runner_access`), the per-run choice (`/runner-choices`, `runnerId` is accepted and ignored), the project's pinned runner (`runner_settings.agent_id`), the project switch "Allow people's own computers" (`allow_personal`) and the `/api/runners*` fleet routes. The tables and columns stay; nothing reads them. A team or project credential installed before is refused at every runner route with HTTP 401 and a sentence sending its person to Settings (the runner stops, exit code 3).
- **Routing by owner only:** a run is its starter's (a schedule's or deploy trigger's: its creator's; on an open server: the server's single owner, `"open"`). The claim itself checks the owner. A person's run is refused up front when their runner is not set up or offline (`RUNNER_NOT_SET_UP`, `RUNNER_OFFLINE`, `RUNNER_CANNOT_RUN`); a schedule's or trigger's run waits for the computer. Runs started with the server's shared access key have no owner and are refused.
- **Kept:** protocol 1 and 2 with attempts and hand-over, device reservations, signed updates, the server execution guard, machine binding, rotation, the private-address and owner-only rules, `maySeeSession`. The wire format is unchanged (`/api/agent/*`, hello's `projectId` string, `runner.kind` "personal").
- **New routes:** `GET/PATCH /api/me/runner`, `POST /api/me/runner/retire`, `/update`, `GET /api/me/runner/enrollments/:id`, `POST /api/me/runner/download`; the admins' list `GET /api/admin/runners` was removed on 2026-11-13 (each person sees only their own runner). Migration 55 records who made each deploy trigger token.
