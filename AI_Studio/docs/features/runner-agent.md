# Runner agent: the platform side

A **runner agent** (a runner) is a small program on a tester's own computer, a team's machine or an on-premise server that connects out to the platform, receives batches of test scripts, runs them next to the application and the devices, and sends the results back. This page describes what the platform does for it. Installing and running the agent is in `runner-agent-setup.md`; the framework seam it plugs into is in `framework-adapters.md`.

## What it does for a user

- On the **Runners** page a person adds a computer. **Add this computer** makes a personal runner (anyone who may run tests in some project, at most 5 each); **Add a team runner** makes a runner of an organisation that is given to projects (needs "manage runners"). The download carries a single-use enrollment code, not a credential (`runner-enrollment.md`, `runner-personal.md`).
- Each project chooses **where its tests run**: on the platform or on runners, a default runner, and whether people's own computers may run its tests. On a platform started with `EXECUTION_MODE=runners` (the hosted platform) every project runs on runners and the platform runs no test code itself (`runner-only-mode.md`).
- On runners, every run that executes scripts goes to a runner: a run started by a person, a schedule, a deploy trigger, a runbook, a cross-browser check or a named environment. A person can pick the runner for one run (`runnerId`). The results, screenshots, traces, evidence and visual baselines are stored and shown exactly as for a local run, and a protocol-2 runner sends live progress while it runs (`run-live-view.md`). The run says where it ran (`ranOn` on the job).
- The application only has to be reachable **from the runner's network**. A staging site on a private address, a service on `localhost`, a phone on the tester's desk all work, where the runner allows private addresses (see "Addresses").

### What still runs on the platform

Only **script execution** moves. Analysis (discovery, planning, generating tests), plain-English test authoring, repair of failing tests, locator healing and the AI judgement of screenshots need the model and a browser on the platform. In `local` mode they run there, with the platform's normal outbound address guard. In `runners` mode the platform opens no browser: work that needs one (exploring, a test described in words, agent runs, security assessments) is refused with a sentence, and repair suggestions that need a browser are not made (`runner-only-mode.md`).

### Refusals

A run is refused up front with a plain 409 when it cannot run where the project runs:

- No runner the person may use is online: "No runner agent is connected for this project. …" (in `runners` mode: "No runner is online for this project, and tests run only on runners here. Start the runner on your computer, or add one on the Runners page.").
- A runner is online but cannot run the tests, and the answer says what is missing: "The connected runner agent “maya-laptop” can't run API tests: it has no browsers installed (run `npx playwright install` on that machine)." Web and API tests need an installed browser; Android tests need `adb` and a connected phone or an emulator.
- A runner chosen for this run that the person may not use answers 404; one that cannot take it now, a 409 with the reason.

This applies to every way a job is created, because the check sits in job creation itself (`Repo.createJob`). A schedule or trigger that cannot start reports the same words. The setting cannot be changed while a run is in progress.

## The setting and the admin routes

People use these through the website, with the permission named; the API key works as for every other admin route.

| Route | Permission | What |
|---|---|---|
| `GET /api/runners`, `GET /api/runners/:runnerId` | read (narrowed by the handler) | runners the caller may see, with `kind`, `mine`, `settings`, `machine`, current work; `canAddPersonal`, `canAddTeam` |
| `POST /api/runners/enroll` `{ kind, label?, organizationId?, projectIds? }` | decided by kind in the handler | a single-use code `{ id, kind, code, expiresAt }` |
| `POST /api/runners/kits`, `POST /api/projects/:id/runner-kits` | decided by kind / manage runners | the download, with the code in `runner.enroll` and the headers `x-runner-enrollment-id`, `x-runner-enrollment-expires` |
| `GET /api/runners/enrollments/:enrollmentId` | its maker | `{ status: "waiting" \| "used" \| "expired", runnerId }` |
| `PATCH /api/runners/:runnerId` | its owner (personal) or a runner manager (team) | rename; switches `codeScripts`, `privateAddresses`, `realPhone` |
| `POST /api/runners/:runnerId/retire` | the same | retire: its credential stops working |
| `PUT` / `DELETE /api/projects/:id/runner-access/:runnerId` | manage runners | give a team runner to a project, or take it away |
| `GET /api/projects/:id/runner-choices` | run tests | the runners this person may use for one run of this project |
| `GET /api/projects/:id/agent-tokens`, `POST` `{label?}`, `DELETE …/:tid` | manage runners | credentials made directly (for scripts and development): `POST` answers 201 `{token, secret}`, the secret (`aitg_` plus 32 random bytes) shown **once** |
| `GET /api/projects/:id/agents` | read | name, version, os, capabilities, online (seen in the last 45 s), last seen, running tasks |
| `GET /api/projects/:id/runner` | read | `{runOn, agentId, status, canRunWeb, canRunMobile, unavailableReason, …}` |
| `PUT /api/projects/:id/runner` `{runOn?, agentId?, allowPersonal?}` | project settings | where the project runs (`platform` is refused in `runners` mode), its default runner, and "Allow people's own computers"; 409 when a job is running or no runner is online |
| `GET /api/config` | — | also `agentProtocol` and `executionMode` |

The setting lives in its own table (`runner_settings`), not in `projects`. Job objects carry `ranOn: {kind: "platform"} | {kind: "agent", agentId, name, runnerId?, phase?, attempt?}` for validation, variant and environment runs.

## The protocol in plain words

The wire contract is `src/agent-protocol/schema.ts`. The agent always connects **out**; the platform never connects to the agent. Every request carries `Authorization: Bearer aitg_...`.

1. **hello**: the agent says who it is (name, version, operating system, what it can run, how many tasks at once). The platform registers or refreshes it and answers with the intervals and the largest file it takes.
2. **poll**: the agent asks for work, saying how many slots are free. The platform holds the request for up to 25 seconds ("long poll") and answers with a **task** or "nothing". One poll at a time per agent (a newer one replaces the older). A task is offered only if the agent can run it, is allowed (the project may name one agent), and has a free slot. Tasks queue first in, first out per project.
3. **download**: baselines for visual tests and the app file for mobile tests are files the task names; the agent fetches them (checking the hash) before running.
4. **run**: the agent runs the scripts with the same code the platform uses locally, so a remote run behaves like a local one.
5. **heartbeat**: every ~10 seconds the agent reports progress and a few log lines and extends its lease. The answer says `cancel: true` when the run was cancelled.
6. **upload**: each artifact (screenshot, trace, video, evidence, vision shot, new baseline) is sent as raw bytes; the platform hashes it itself.
7. **result**: the final word, posted once. `ok: false` means the agent could not run the tests at all.

Protocol 2 (attempts, accept and reject, task phases, live test and step events, durable results) is additive: see `runner-protocol-2.md`.

### Record tasks (recording a test on an agent)
An agent that reports `record: true` (it has a Chromium; `recordHeaded: true` when it also has a display) can host a **recording session** for the recorder (see [recorder.md](recorder.md)). It is the same poll and claim as a run, with three additions, all optional so protocol 1 is unchanged and an older agent never receives one:

- The offer has `kind: "record"` and a `record` block (recording id, start address, headed, idle and total minutes, step cap) and no scripts. A record task has no job: its `job_id` is `rec-<recordingId>` and it is addressed to the chosen agent only. It takes one of the agent's task slots while it lasts.
- The agent pushes the **whole recording state** to `POST /api/agent/tasks/:id/recording` (status, current address, steps, inspect state, the picked element, notes, an error sentence, and the ids of the commands it applied), at most about once a second. The platform treats every push as untrusted: schema-checked, at most 1 MB and 5 per second per task, refused for a task that is not a record task, not claimed by this agent, or finished; steps marked secret are forced back to the standard placeholder; the project's known credentials are scrubbed from the text; non-http(s) `goto` steps are dropped.
- Commands from the web page (inspect, edit a step, delete a step, stop, discard) are queued by the platform and returned in the **heartbeat reply** (`commands`, oldest first, at most 20); the agent beats every second while recording, applies each command, and acknowledges it in its next push. The agent finishes with a normal result (`ok: true`, no runs).

If neither a push nor a heartbeat arrives for 45 seconds the session stops with "Lost contact with <agent>. The steps recorded so far are kept.", and an unclaimed record task fails after 60 seconds. A record task is never re-offered to another agent.

### Phone tests: one answer for the card and the setting

Whether phone tests can run on an agent is decided by one rule (`androidSummary` in `src/platform/agent-routing.ts`): adb is installed and either a phone is ready (state `device`) or an emulator can be started. Routing, the "where tests run" answer and the agent card all use it. Each agent in `GET /api/projects/:id/agents` carries `capabilities.android.state` (`no-tools`, `phone`, `emulator`, `none`) and `summary` ("Android: 2 devices, 1 emulator", "Android: no phone connected, 1 emulator can be started", "Android: no devices connected"). `GET /api/projects/:id/runner` gains `phones: { canRun, text }`, for example "Phone tests can run on Maya. Android: no phone connected, 1 emulator can be started." or "Phone tests can't run: it has no Android phone connected and no emulator set up.". A phone that waits for permission or is offline counts as not ready ("Android: 1 device, none ready"). The word "READY, NEEDS ATTENTION" on a run (a finished run with problems) is a UI label, not part of this answer, and is unchanged.

A cancelled run on an agent keeps no partial results: see "Cancelling a run" in `schedules.md`.

### Failures that are not test failures

If the agent says `ok: false`, disappears (no heartbeat for 60 seconds, twice) or never shows up, the run fails as a **runner problem** with a plain message ("The runner agent stopped responding while it was running these tests."). The platform never invents a failing verdict for a test in that case: it stops the job, exactly as it does when a tool is missing locally. After 60 seconds without a heartbeat a task is offered once more (to the same or another agent); a second loss fails it. A task nobody picks up for 30 minutes fails; a queued task with no capable agent online fails after about 90 seconds. Cancelling a job cancels its task.

### Cleanup of test data

The application may only be reachable from the agent's network, so for a remote run the **agent** removes the records the tests created (the task says `cleanup: "agent"`) and returns the ledger lines with what became of each. The platform stores them in the normal cleanup ledger, shows them as usual, and sends no DELETE of its own for those runs. Retrying a failed removal from the cleanup page still runs from the platform, so it may fail for a private application.

## Security model

The full threat model is `docs/runner-implementation/SECURITY_DESIGN.md`. In short:

- **Credentials.** A runner credential (`aitg_` plus 32 random bytes) is kept on the platform only as its SHA-256 hash and last 4 characters, compared in constant time, never logged. A revoked or unknown credential is a 404 (they look the same); a missing or malformed header is a 401. Downloads carry a single-use enrollment code (`aite_…`, 30 minutes) that the runner trades once at `POST /api/agent/enroll` for its credential, which it keeps in the operating system's store. The credential is bound to the install id it was first used from and is rotated after 30 days (`runner-enrollment.md`).
- **Which work a runner gets.** A team runner serves the projects granted to it in `runner_access`, within its own organisation (a Crowd4Test shared runner may serve any organisation; a runner of no organisation made from a project serves only that project). A personal runner takes only its owner's runs and its owner's schedules, in projects that allow people's own computers and that the owner can still run tests in. One credential stands for one machine: while a runner is online, a second machine using the same credential under another name is refused.
- **API key exemption.** The API-key check skips only the agent routes in an exact, anchored allow-list (`ROUTES` in `src/platform/agent-routing.ts`): hello, poll, the task routes (heartbeat, file download and upload, result, recording, device, accept, reject, events), the update routes, check, enroll and rotate. The match is on the decoded path: no prefix, no case folding, no trailing slash, no doubled slashes, no traversal. Anything else, including a look-alike path, still needs the API key or a session. On those routes the API key is **not** accepted instead of the credential: a hook checks the Bearer credential before every handler. Enroll is the one route without a credential: the code in its body is checked, and it is limited per address and per code.
- **Only the claiming runner, only the current attempt.** A task is claimed with one atomic update, so exactly one runner gets it. Heartbeat, download, upload, events and result are refused (as "not found") for any other runner, another project's runner and the API key. A protocol-2 message for an attempt that is no longer current gets 409 `superseded`. A result is accepted once (protocol 2: the same attempt's repeat answers `alreadyReceived`).
- **Files.** Names must match a safe pattern (letters, digits, dot, dash, underscore, at most 120 characters, no leading dot) and are joined to the task's own folder only after that check and an anchoring check. Uploads are streamed to a temporary file with a size cap (default 64 MB per file, 512 MB and 300 files per task, reserved while they stream), hashed on the platform (an announced `X-Content-SHA256` that differs is refused), and become visible only when complete. Only files the task registered can be downloaded; the app file must lie inside the platform's own store. Files are kept under the project's artifact store, `_agent/<task>/`, and removed with the task after 24 hours. Request bodies: JSON 2 MB, the result 8 MB, at most 100 live events per request.
- **Rate limits.** Hello and rotate 6 a minute per credential, other requests 900 a minute, one poll at a time per runner; enroll per address and per code.
- **Secrets.** A task carries the credentials the run needs (the same environment the platform's own runner would get). It is sent only over the runner's authenticated connection. At rest the task payload and the result are encrypted with the platform's `SecretBox`; they never appear in logs, events, API answers or the database in clear. Whatever the runner sends back (results, heartbeat lines, live events, recording and phone pushes) is scrubbed of every credential of the run, in its usual encoded forms too, before it is stored, and failure evidence is parsed and masked again. A mobile task never gets the web credentials. A personal runner's owner can read the project's test accounts during their own runs; the project switch "Allow people's own computers" decides whether that is allowed. Failure traces keep typed values unmasked. `tests/secret-leak.test.ts` has sentinels for a run on a runner.
- **HTTPS.** The platform serves plain HTTP; put it behind HTTPS when runners are not on a trusted network. The runner refuses plain HTTP to a public address unless told otherwise.

### Addresses

`assertAllowedTarget` stops the platform from being used as a proxy into private networks. For a project that runs on an agent, the application address is reached **from the agent's network**, so private and loopback addresses are allowed for it where the address decides where scripts run (importing tests, re-running them, schedules that only validate, deploy triggers). Such addresses still must be `http` or `https` and must not contain a user name or password. Every call the platform makes itself keeps the usual guard: analysis, plain-English test authoring, issue trackers, webhooks and so on. When the target is private, the platform also skips its own browser for repair and healing of that run.

### Private and local addresses on the runner's network

A runner may refuse private and local addresses: loopback (`localhost`, `127.x`, `::1`), the computer's own network (`10.x`, `172.16-31.x`, `192.168.x`, `fc00::/7`) and link-local addresses (`169.254.x`, `fe80::`). A person's own computer refuses them by default and its owner can allow them on the Runners page; a team runner allows them. The platform tells the runner in the hello answer (`runner.privateTargets`) and, when the switch changes, in a heartbeat (`config.privateTargets`, applied to the next task). `BLOCK_PRIVATE_TARGETS=true` in the runner's own environment refuses them whatever the platform says. An older platform that says nothing keeps the old behaviour (allowed).

When they are refused (`src/agent/address-guard.ts`):

- Before a web or API run or a recording starts, the runner looks up its addresses **on its own network**: the site, the API address and every `http(s)` value of the environment. A private, loopback or link-local address, or a name that cannot be found, ends the task with a plain sentence. A protocol-2 runner turns the task down with the reason `private-target`, so the platform can offer it to another runner.
- The run's browser and the tests' API calls go through the runner's own address guard (`src/engine/discovery/guard-proxy.ts`, started inside the agent on `127.0.0.1` for each task). It looks up every name itself and refuses a private address on every request, frame and redirect hop, so a public page that redirects to the person's router is refused before any connection is made. The config gets Playwright's `proxy` option through `AITP_ADDRESS_GUARD` (`src/engine/net/test-proxy.ts`); the platform never sets it. Generated scripts also get `BLOCK_PRIVATE_TARGETS=true`, so a step that names another private address is refused with the usual sentence.
- Recordings and live sessions on such a runner open their browser through the same guard (`src/agent/record-task.ts`, `record-child.ts`).
- A runner started with `--proxy-tests` cannot check where the company proxy sends a test, so it refuses such runs with a sentence that says what to do.

What the guard does **not** cover:

- **Code scripts** (hand-written, imported, Git) are code. They can open their own connections (`fetch`, sockets, a new request context without the proxy, `test.use({ proxy })`) and so reach private addresses anyway. The guard is not an operating-system sandbox.
- Traffic that does not go through the browser's proxy: WebRTC (UDP), and Android, iOS and Windows desktop tests.
- Firefox and WebKit variants were not checked against the guard on this machine; the guard was tested with Chromium.

## Where the code is

- `src/platform/agent-store.ts`: tables (migrations 19, 42, 51, 53) and the store; `agent-routing.ts`: route matcher, capability check, wire form, path and secret helpers, protocol negotiation; `agent-services.ts`: credentials, enrollment, registry, queue and offers, `RemoteExecutor`, job gate; `routes/agents.ts`: admin and protocol routes; `routes/runners.ts`, `routes/runner-kits.ts`: the Runners page, enrollment codes and downloads; `runner-only.ts`: `EXECUTION_MODE=runners`.
- Hooks in shared files: `Repo.createJob` (`jobGate`), `setExecutorResolver` in `bootstrap`, the API-key hook and `/api/config` in `server.ts`, the scheduler tick (housekeeping), and `validate-only.ts` (mobile plan and browser skip for remote runs).
- Settings you can change with environment variables (mostly for tests): `AGENT_POLL_SECONDS`, `AGENT_HEARTBEAT_SECONDS`, `AGENT_LEASE_SECONDS`, `AGENT_ACCEPT_SECONDS`, `AGENT_MAX_FILE_BYTES`, `AGENT_TASK_MAX_BYTES`, `AGENT_TASK_MAX_FILES`, `AGENT_NO_AGENT_GRACE_SECONDS`, `EXECUTION_MODE`, `DISPATCH_CONCURRENCY`.

## Limits

- Protocol 1 and 2 run Playwright (web and API), Android, iOS (on a Mac with Xcode) and Windows desktop tasks; live step events come only from Playwright runs.
- Leases and stale tasks are handled whenever a runner polls or a run waits. Pruning of finished tasks (after 24 hours) and of runners not seen for 30 days runs on the scheduler tick (in `runners` mode on its own timer when the scheduler is off), so in `local` mode with the scheduler switched off nothing is pruned.
- Cleanup retry and environment runs on a named environment keep the platform's guard for private addresses (an environment's address is checked where the environment is saved and run).
- Runbook steps that analyse an application check its address with the platform's guard.
- Not run on a real Windows or Mac computer in round 39: see `docs/runner-implementation/MANUAL_VERIFICATION.md`.
