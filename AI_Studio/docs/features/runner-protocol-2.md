# Runner protocol 2: attempts, accept and reject, phases, live events, durable results

Protocol 2 adds to protocol 1 (`docs/features/runner-agent.md`); it replaces nothing. The platform serves agents that speak only protocol 1
exactly as before, and an agent that speaks 2 falls back to 1 when the platform answers 1. The wire contract is still one file:
`src/agent-protocol/schema.ts` (section "protocol 2").

## Version negotiation

- The agent's hello carries `protocol: 1` (the oldest version it speaks, so a protocol-1 platform accepts it) and `protocols: [1, 2]`.
- The platform answers `protocol` with the highest version both speak (`negotiateProtocol`, `src/platform/agent-routing.ts`) and keeps it on
  the runner's machine row (`agents.protocol`).
- If a platform still refuses the hello because of the version, the agent says hello once more with protocol 1 only and runs as a
  protocol-1 agent.
- A protocol-1 agent (no `protocols` list) is answered `protocol: 1` and gets exactly today's behaviour.

## Attempts and fencing

Every hand-out of a task is a new **attempt** with a random id (`agent_tasks.attempt`, `attempt_id`). A protocol-2 offer carries
`attemptId`, `attempt` and `acceptSeconds`. The agent sends the attempt id with every accept, reject, heartbeat, event, upload (header
`x-attempt-id`) and result. A message for an attempt that is no longer current is answered 409 with `details: { code: "superseded" }`, and the
agent stops that attempt. A new attempt starts with no uploaded files.

## Accept and reject

- `POST /api/agent/tasks/:id/accept { attemptId }`: the agent takes the task. Not accepted within `AGENT_ACCEPT_SECONDS` (default 30), it goes
  back to the queue **without using up an offer**, and the run's events say "The runner did not accept the run in time; offering it again."
- `POST /api/agent/tasks/:id/reject { attemptId, reason, message }`: the agent will not run it. Reasons: `missing-browser`, `missing-tools`,
  `code-scripts-off`, `private-target`, `busy`, `no-display`, `unsupported`, `other`. The task goes back to the queue without using up an
  offer and is never offered to that runner again. The run fails only when no runner that may take it is left online; its error lists every
  runner's reason, and each rejection is an event of its own (`runner_rejected`).
- The agent decides before downloading anything: a runtime it does not have, code scripts its owner did not allow, or a visible browser
  window on a computer with no display (protocol 1 answers the same sentence as `ok: false`).
- A recording or phone session (which only one runner can host) that is turned down fails with the reason.

## Phases

`agent_tasks.phase`, written only by the platform: `queued`, `assigned` (offered), `accepted`, `preparing` (downloads, browser), `running`,
`uploading`, then one of `completed`, `rejected`, `failed`, `cancelled`, `timed_out`, `lost_connection`. Within an attempt a phase only moves
forward and never leaves a final phase; a re-offer starts a new attempt at `queued`. A protocol-2 agent reports `preparing`, `running` and
`uploading` in its heartbeats and as `phase` events; a protocol-1 heartbeat counts as `running`. Each change is a `runner_phase` event.

A run's job object carries `ranOn: { kind: "agent", agentId, name, runnerId, phase, attempt, browser? }`. Where it ran is kept with the job
(`generation_jobs.ran_on_json`), so after the 24-hour task prune an old run still names the machine that ran it, not the project's current
runner.

## Live events

`POST /api/agent/tasks/:id/events { attemptId, events: [...] }`, at most 100 per request. Each event has `seq` (from 0 per attempt) and
`at`. Types: `test_started`, `test_finished` (status, duration, error, stack), `step_started`, `step_finished` (index, title, status,
duration, error), `log`, `screenshot` (names a file this attempt already uploaded), `phase`. The platform keeps each (task, attempt, seq)
once (`agent_task_events`), so a batch sent twice is stored once. Every text is masked on the runner and scrubbed again on the platform.

They become job events, so the run's existing stream carries them and a refresh (or `Last-Event-ID`) replays them:

| Live event | Job event kind | `data` |
|---|---|---|
| test_started | `runner_test_started` | testId, title, variant, seq, taskId, attempt |
| step_started / step_finished | `runner_step` | `state: "started" \| "finished"`, testId, index, title, status, durationMs, error |
| test_finished | `runner_test_finished` | testId, status, durationMs, error, stack |
| screenshot | `runner_screenshot` | testId, ref, taskId (the picture: `GET /api/projects/:id/runs/:jobId/runner-files/:taskId/:ref`) |
| log | `runner_log` | line |
| phase | `runner_phase` | phase |

The platform also writes `runner_phase` (each phase change), `runner_attempt` (a new hand-out), `runner_rejected`, `runner_requeued`,
`runner_lost` and `runner_file_missing` (a file the result named but the runner never uploaded). Only `runner_*` events carry their `data`
on the stream; other events are unchanged. A protocol-1 agent's lines stay `agent_progress` events.

The live picture route serves only PNG or JPEG files of a task of that run of that project (permission: read the project). It works while
the task is kept (a day); afterwards the run's own screenshots, stored with its results, remain.

### Where step events come from

Playwright web and API runs: a small reporter (`LIVE_REPORTER`, `src/engine/validation/runner.ts`) is added to the run only when a runner
asks for live events. It reports each test, each top-level `test.step` (generated scripts number their steps `"1. ..."`, which becomes the
step index; a hand-written script's own steps are reported in order) and each failure screenshot. Scripts are not changed. The agent uploads
a failure screenshot the moment Playwright writes it and then sends the `screenshot` event; the final upload round reuses that file.

Android, iOS and Windows desktop runs report no live steps: when their run ends the agent sends one `test_finished` event per test before
it uploads the files; their progress lines still arrive live.

### Watch live pictures

An exploration or a described test on a runner may be watched (`explorerFrames: true` in the capabilities). The runner's child asks
`POST /api/agent/tasks/:id/explore/frame` with `{}` every 2 seconds and the answer is `{ watched }`; while it is true, at most one picture a
second goes to the same route as `{ frame: { imageBase64, url, title, note, phase, pagesSeen, at } }` (a JPEG of at most 120 KB, the body
at most about 170 KB). The route is fenced like `explore/llm` and `explore/sink` (`x-attempt-id`, the runner's own running task). Pictures
are never put into live events.

## Heartbeat answers (protocol 2)

Besides `cancel`: `timeout: true` (the platform's time limit for the run passed; the agent stops at once), `shutdown: true` (the runner was
retired: it finishes what runs, takes nothing new and exits), and `config: { customScripts?, privateTargets? }` when the runner's switches
changed since the task was handed out (they apply to the next task). The platform reads them through two hooks the runner identity code
fills in (`AgentService.shutdownWanted`, `AgentService.runnerConfig`); by default they say nothing. A protocol-2 offer carries the same
`config` (the switches as they are when the task is handed out), so a switch changed while the runner sat idle applies to that task instead
of waiting for the runner's next hello. A protocol-1 offer never has it.

## Durable results

The agent writes a finished task's result to `<work folder>/outbox/<task>.json` (readable only by its user) before posting it, and removes it
only when the platform answers 2xx, 404, 409 or 410. Network trouble, a server error or a rate limit keeps it; the agent tries again with
growing waits (2 s up to a minute) while it runs, sends kept results first after every reconnect, and keeps them across a restart of the
agent. A result older than a day is dropped. The same result posted again for the same attempt is answered 200 `alreadyReceived`; a result
for a task the platform already ended (timed out, lost) gets 410. The file holds the masked runs, never the task's credentials.

## Stopping

SIGINT/SIGTERM, or a file named `stop.request` in the agent's work folder (`--work-dir`; for a downloaded runner `.agent-work` in its
folder), stops the agent gracefully: running tasks are cancelled and reported "The agent was stopped."

## Secrets

- Heartbeat lines are scrubbed before they are kept with the task (`log_json`), not only in the events.
- The platform's scrub and the agent's log mask each secret in the forms text usually carries it in: URL-encoded, `+` for spaces,
  lower-case hex, JSON-escaped, `encodeURI`'s form, and a Basic sign-in's base64 of `user:password`
  (`src/agent-protocol/secret-variants.ts`). Recording and phone session pushes use the same scrub.
- Upload budgets (files and bytes per task) are reserved while an upload streams, so uploads side by side cannot pass the limits together.

## Limits

- A failure trace keeps what was typed into the page, the password included: a check with Playwright's own trace (a password typed into a
  password field, then a failing assertion) found the value in the trace's action log and in one of its attachments. Traces (and videos)
  are kept only for failed tests, stored like a local run's, and shown only to people of the project; they are not masked.
- If the platform restarts while a run is going, the job is claimed again and creates a new task; the old task's result is no longer
  collected (the runner's kept result is refused with 409 and dropped). The run is not reported as passed.
- The upload reservation is per platform process; the agent routes are served by one process.
- Not verified on Windows or macOS in this round: the protocol code is the same on every system; the tests ran on Linux.
