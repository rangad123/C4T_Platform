# Runner agent: the platform side

A **runner agent** is a small program on a tester's own computer (or an on-premise server) that connects out to the platform, receives batches of test scripts, runs them next to the application and the devices, and sends the results back. This page describes what the platform does for it. Installing and running the agent is in `runner-agent-setup.md`; the framework seam it plugs into is in `framework-adapters.md`.

## What it does for a user

- On the project's Agents page you make an **agent token**, start the agent with it, and choose **where this project's tests run**: on the platform (the default) or on an agent.
- With "run on an agent", every run of that project that executes scripts goes to the agent: a run started by a person, a schedule, a deploy trigger, a runbook, a cross-browser check or a named environment. The results, screenshots, traces, evidence and visual baselines are stored and shown exactly as for a local run. The run says where it ran (`ranOn` on the job).
- The application only has to be reachable **from the agent's network**. A staging site on a private address, a service on `localhost`, a phone on the tester's desk all work.

### What still runs on the platform

Only **script execution** moves. These always run on the platform, because they need the model and the browser-driving loop: analysis (discovery, planning, generating tests), plain-English test authoring, repair of failing tests, locator healing, and the AI judgement of screenshots (the screenshots come back from the agent and are judged here). Because those run here, the platform keeps its normal outbound address guard for them (see "Addresses").

### Refusals

A run is refused up front with a plain 409 when it cannot run where the project runs:

- No agent is online: "No runner agent is connected for this project. Start one, or switch the project back to running here."
- An agent is online but cannot run the tests, and the answer says what is missing: "The connected runner agent “maya-laptop” can't run API tests: it has no browsers installed (run `npx playwright install` on that machine)." Web and API tests need an installed browser; Android tests need `adb` and a connected phone or an emulator.

This applies to every way a job is created, because the check sits in job creation itself (`Repo.createJob`). A schedule or trigger that cannot start reports the same words. The setting cannot be changed while a run is in progress.

## The setting and the admin API

All of these need the API key (like every other admin route). Shapes are fixed in `.scratch/briefs/AGENT-API-SHAPES.md`.

| Route | What |
|---|---|
| `GET /api/projects/:id/agent-tokens` | tokens, newest first, revoked ones marked; never the secret or the hash |
| `POST /api/projects/:id/agent-tokens` `{label?}` | 201 `{token, secret}`; `secret` (`aitg_` plus 32 random bytes) is shown **once** |
| `DELETE /api/projects/:id/agent-tokens/:tid` | revokes; the agent is refused at its next request |
| `GET /api/projects/:id/agents` | name, version, os, capabilities, online (seen in the last 45 s), last seen, running tasks |
| `GET /api/projects/:id/runner` | `{runOn, agentId, status, canRunWeb, canRunMobile, unavailableReason}` |
| `PUT /api/projects/:id/runner` `{runOn, agentId?}` | choose `platform` or `agent` (a specific agent, or any); 409 when a job is running, or no agent is online |
| `GET /api/config` | now also `agentProtocol` (1) |

The setting lives in its own table, not in `projects`. Job objects gain `ranOn: {kind: "platform"} | {kind: "agent", agentId, name}` for validation, variant and environment runs.

## The protocol in plain words

The wire contract is `src/agent-protocol/schema.ts`. The agent always connects **out**; the platform never connects to the agent. Every request carries `Authorization: Bearer aitg_...`.

1. **hello**: the agent says who it is (name, version, operating system, what it can run, how many tasks at once). The platform registers or refreshes it and answers with the intervals and the largest file it takes.
2. **poll**: the agent asks for work, saying how many slots are free. The platform holds the request for up to 25 seconds ("long poll") and answers with a **task** or "nothing". One poll at a time per agent (a newer one replaces the older). A task is offered only if the agent can run it, is allowed (the project may name one agent), and has a free slot. Tasks queue first in, first out per project.
3. **download**: baselines for visual tests and the app file for mobile tests are files the task names; the agent fetches them (checking the hash) before running.
4. **run**: the agent runs the scripts with the same code the platform uses locally, so a remote run behaves like a local one.
5. **heartbeat**: every ~10 seconds the agent reports progress and a few log lines and extends its lease. The answer says `cancel: true` when the run was cancelled.
6. **upload**: each artifact (screenshot, trace, video, evidence, vision shot, new baseline) is sent as raw bytes; the platform hashes it itself.
7. **result**: the final word, posted once. `ok: false` means the agent could not run the tests at all.

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

- **Tokens.** A token belongs to exactly one project, so an agent can only receive that project's tasks and see that project's files. It is 32 random bytes; only its SHA-256 hash and the last 4 characters are stored; it is compared in constant time, never logged and shown once. A revoked or unknown token is a 404 (they look the same); a missing or malformed header is a 401. One token stands for one agent: while an agent is online, a second machine using the same token under another name is refused ("make a token for each machine"). Make a token per machine.
- **API key exemption.** The API-key check skips exactly six requests (method plus path): `POST /api/agent/hello`, `POST /api/agent/poll`, `POST /api/agent/tasks/:id/heartbeat`, `GET /api/agent/tasks/:id/files/:ref`, `PUT /api/agent/tasks/:id/files/:name`, `POST /api/agent/tasks/:id/result`. The match is on the decoded path and is anchored and exact: no prefix, no case folding, no trailing slash, no doubled slashes, no traversal. Anything else, including a look-alike path, still needs the API key. On those six routes the API key is **not** accepted instead of the token: a handler hook checks the Bearer token before every handler.
- **Only the claiming agent.** A task is claimed with one atomic update, so exactly one agent gets it. Heartbeat, download, upload and result are refused (as "not found") for any other agent, another project's agent and the API key. A result is accepted once. A task that was taken back can no longer be answered by the agent that lost it.
- **Files.** Names must match a safe pattern (letters, digits, dot, dash, underscore, at most 120 characters, no leading dot) and are joined to the task's own folder only after that check and an anchoring check. Uploads are streamed to a temporary file with a size cap (default 64 MB per file, 512 MB and 300 files per task), hashed on the platform (an announced `X-Content-SHA256` that differs is refused), and become visible only when complete. Only files the task registered can be downloaded; the app file must lie inside the platform's own store. Files are kept under the project's artifact store, `_agent/<task>/`, and removed with the task after 24 hours. Request bodies: JSON 2 MB, the result 8 MB.
- **Rate limits.** Hello 6 a minute per token, other requests 900 a minute, one poll at a time per agent.
- **Secrets.** A task carries the credentials the run needs (the same environment the platform's own runner would get). It is sent only over the agent's authenticated connection. At rest the task payload and the result are encrypted with the platform's `SecretBox`; they never appear in logs, events, API answers or the database in clear. Whatever the agent sends back is scrubbed of every credential of the run (error text, step errors, notes, response observations, cleanup reasons) before it is stored, and failure evidence is parsed and masked again. A mobile task never gets the web credentials. `tests/secret-leak.test.ts` has sentinels for a run on an agent.
- **HTTPS.** The platform serves plain HTTP; put it behind HTTPS when agents are not on a trusted network. The agent refuses plain HTTP to a public address unless told otherwise.

### Addresses

`assertAllowedTarget` stops the platform from being used as a proxy into private networks. For a project that runs on an agent, the application address is reached **from the agent's network**, so private and loopback addresses are allowed for it where the address decides where scripts run (importing tests, re-running them, schedules that only validate, deploy triggers). Such addresses still must be `http` or `https` and must not contain a user name or password. Every call the platform makes itself keeps the usual guard: analysis, plain-English test authoring, issue trackers, webhooks and so on. When the target is private, the platform also skips its own browser for repair and healing of that run.

## Where the code is

- `src/platform/agent-store.ts`: tables (migration 19) and the store; `agent-routing.ts`: route matcher, capability check, wire form, path and secret helpers; `agent-services.ts`: tokens, registry, queue, `RemoteExecutor`, job gate; `routes/agents.ts`: admin and protocol routes.
- Hooks in shared files: `Repo.createJob` (`jobGate`), `setExecutorResolver` in `bootstrap`, the API-key hook and `/api/config` in `server.ts`, the scheduler tick (housekeeping), and `validate-only.ts` (mobile plan and browser skip for remote runs).
- Settings you can change with environment variables (mostly for tests): `AGENT_POLL_SECONDS`, `AGENT_HEARTBEAT_SECONDS`, `AGENT_LEASE_SECONDS`, `AGENT_MAX_FILE_BYTES`, `AGENT_TASK_MAX_BYTES`, `AGENT_TASK_MAX_FILES`, `AGENT_NO_AGENT_GRACE_SECONDS`.

## Limits

- Protocol 1 runs Playwright (web and API) and Taqwright (Android) tasks. iOS and Windows desktop are reported by agents but cannot be run yet.
- Leases and stale tasks are handled whenever an agent polls or a run waits. Pruning of finished tasks (after 24 hours) and of agents not seen for 30 days runs on the scheduler tick, so with the scheduler switched off nothing is pruned.
- Cleanup retry and environment runs on a named environment keep the platform's guard for private addresses (an environment's address is checked where the environment is saved and run).
- Runbook steps that analyse an application check its address with the platform's guard.
