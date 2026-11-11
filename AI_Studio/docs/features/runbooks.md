# Runbooks: chain runs, branch on the result, tell the team

A schedule runs one job on a timer and a deploy token starts one re-run. A **runbook** is a small ordered workflow built
from those same parts:

> Run the smoke tests. If they pass, run everything, then tell the team. If they fail, tell the team and stop.

It is useful for release gates ("is this build good enough?") and for nightly runs that should only make noise when
something is wrong. A runbook never does anything the platform could not already do by hand: every "run tests" step is
the same validation job a schedule starts, with the same environment rules, and the platform still runs **one job per
project at a time**.

---

## What you see

Open a project, then the **Schedule** tab. The **Runbooks** panel sits under "Scheduled runs".

- With no runbooks, it says *Chain runs together, for example run the smoke tests, then everything, then tell the team*
  and offers three templates and **Write your own**.
- Each runbook is a row: its name, a sentence made from its steps ("Run tests tagged “smoke”, then check that at least
  100% passed, then tell the team."), how the last run ended, and a **mini ribbon with one tick per step** (green passed,
  red failed, amber stopped or in progress, grey skipped or not needed). The ribbon has a text alternative ("Last run,
  3 steps: 2 passed, 1 skipped").
- **Run now** starts it and shows the run live: every step with what it did in plain words ("100% passed (48 of 50)",
  "2 tests failed", "Skipped: the run went from … to …"). **Cancel the run** stops it (and its job).
- **Earlier runs** lists the last ten; **Show** opens one. A link from a message (`…/schedule?run=<id>`) opens the run.
- **Start automatically** (a disclosure on each runbook) links schedules and deploy tokens to the runbook; those then
  start the runbook instead of a plain re-run. The Scheduled runs and Deploy tokens panels show a "Runs the runbook …"
  badge on a linked schedule or token.

### Templates

Each is created through the same validation as a runbook you write. The ones that tell the team ask which alert channel
to use; choosing "Nobody yet" builds the runbook without the message step.

| Template | Steps |
| --- | --- |
| Smoke then full run | Run the tests of type "smoke". If they fail, tell the team and stop. Otherwise run all tests; tell the team only if that fails. |
| Release gate | Run all tests, check the pass rate is at least 95%, no high-severity findings, no breaking API change, and the project is ready; then tell the team the verdict. Any failing check skips to the message. |
| Nightly with alert | Run all tests; stop if they pass; tell the team if they fail. Pair it with a nightly schedule. |

If a template's choice matches no test in the project (for example a project with no "smoke" tests), the runbook row
shows a warning ("Step 1: No tests match …") right away, and the step would fail with that same reason.

---

## The definition

A runbook is JSON, versioned (`version: 1`), validated with zod when saved: up to **12 steps**, a name of 1 to 80
characters, up to 20 runbooks per project.

```json
{
  "version": 1,
  "name": "Release gate",
  "steps": [
    { "id": "smoke", "type": "run", "scope": { "tag": "smoke" }, "retries": 1, "onFail": "tell" },
    { "id": "rate", "type": "condition", "condition": { "check": "passRate", "atLeast": 100 }, "onFail": "tell" },
    { "id": "everything", "type": "run", "scope": "all", "onPass": "stop", "onFail": "tell" },
    { "id": "tell", "type": "notify", "channelId": "<alert channel id>", "message": "{{project}}: the run {{status}}. {{passRate}} passed. {{runUrl}}" }
  ]
}
```

Every step has an `id` (a lowercase name such as `smoke`), a `type`, an optional `title` and optional routes `onPass`
and `onFail`, each `"next"`, `"stop"` or the id of a **later** step. Defaults: after a pass go to the next step; after a
failure stop. Because a step can only move forward, **a runbook always terminates**: backward and self references, and
unknown ids, are refused when you save ("“smoke” comes before this step. A runbook only moves forward, so it can never
loop").

### Step types

| Type | What it does | Settings |
| --- | --- | --- |
| `run` | Re-validates tests, the same job a schedule starts. Passes when every test passed. | `scope`: `"all"` or `{ suite?, tag?, type?, testIds? }` (all given filters must match; `testIds` accept test ids or keys like `API-003`). `environment` (a named environment of the project), `confirmProduction`, `retries` (0, 1 or 2; default 1; a pass after a fail is a flaky pass), `includeMobile` (default off). |
| `analyze` | Starts an analysis again, with the settings of the project's latest analysis, like a schedule of kind "Analyze again". Needs the AI model. | `allowMutatingApiTests` and `loadChecks`, both **off unless the step turns them on** (whatever the saved settings say). Mobile is never added. The editor shows these options. |
| `condition` | Judges the run of the step before it, or the project. | `condition`: `passRate` (`atLeast` 0 to 100), `noFailures`, `noHighSeverity`, `noApiBreakingChange`, `readiness` (the project is "ready", the same answer as the dashboard). Passes or fails like a run and routes the same way. |
| `notify` | Sends a message through an alert channel of the project. | `channelId`, `message` (up to 500 characters). |
| `wait` | Waits, then moves on. | `seconds`, 1 to 300. |

`wait` and `notify` steps always move on, so they take no `onFail` (it is refused, since it would silently do nothing).
A `condition` needs a `run` or `analyze` step somewhere before it, except `readiness`, which is about the project.

### What each check measures

- **passRate**: tests that passed divided by tests that ran in the previous run job. "No tests ran" fails.
- **noFailures**: no test failed or found a problem in that job.
- **noHighSeverity**: no test of that job currently has an open finding of high or critical severity (the severity data
  the dashboard uses).
- **noApiBreakingChange**: compares the API recorded in that job with the previous run. When there is nothing to compare
  yet it **passes**, and the step says "nothing to compare yet" so it is not mistaken for a clean comparison.
- **readiness**: the project's readiness is exactly the dashboard's (blocked, needs attention, unknown, ready); only
  "ready" passes, and the step names the top reasons when it does not.
- If the earlier run did not finish (the job failed or was cancelled), every check except readiness fails and says why.

### Message placeholders

A message may use only `{{project}}`, `{{status}}` (passed or failed, so far), `{{passRate}}`, `{{failed}}` and
`{{runUrl}}`. Anything else, and a brace that never closes, is refused when saving. The text is plain; each kind of
channel escapes it its own way (Slack markup, Teams markdown, HTML in email, JSON for a webhook), so a project called
`<b>&` cannot inject markup. A run's `runUrl` is a link to the run under the project's Runs → Schedules section.

---

## How a run goes

1. **Start** (by hand, by a schedule, by a deploy token): the run records a snapshot of the definition and one row per
   step (`pending`).
2. Steps run **in order, following the routes**. A `run` or `analyze` step creates the job and waits for it. If the
   project is busy with another job (a person's or a schedule's), the step **waits** for it (up to its time cap) and
   never starts a second job at the same time.
3. Every step ends as `passed`, `failed`, `skipped`, `stopped` or `timed_out`, with the job it started, its timings, a
   reason in plain words and, for a check, what it measured. Steps the run never reached are `skipped` with the reason.
4. The run ends as:

| Run status | Meaning |
| --- | --- |
| `passed` | It reached the end, or stopped early, and nothing had failed. |
| `failed` | It reached the end but a step had failed on the way (a failure that was routed around still counts). |
| `stopped` | A failure led to an explicit "stop" (for example the failing smoke tests went to the message, which then stops). |
| `timed_out` | A step took longer than the step cap, or the run longer than the total cap. |
| `cancelled` | Somebody cancelled it. |
| `interrupted` | The platform was restarted while it ran. |

`passed` in the API is `true` for passed, `false` for failed, stopped and timed out, and `null` for cancelled and
interrupted runs (they prove nothing).

**Messages never fail a run.** If a channel was deleted, is paused, or the receiver is down, the notify step is marked
`failed` with the plain reason and the run carries on; the failed delivery appears in the alert log like any other. A
deleted environment, test or channel referenced by a step makes **that step** fail with a plain reason (and no job).

### Limits and safety

- **One runbook run per project at a time** (enforced by a unique index in the database), and a start while a job is
  active is refused (HTTP 409), like starting a second job.
- **Time caps:** a step may take up to 30 minutes and a whole run up to 60 minutes; beyond that the run ends as
  `timed_out` and the job of the step in progress is asked to stop. A `wait` is at most 300 seconds.
- **Production:** a `run` step on a production environment needs `confirmProduction: true`. It is refused when saved
  (HTTP 409 with `requiresConfirmation`) and checked again when the step runs, in case the environment became production
  after the runbook was saved. Production stays read-only: tests that change data are skipped, as for any production run.
- **Data-changing tests, the load check and mobile are never switched on by a runbook** unless a step says so. A load
  check still needs an allowed target that is not a production environment.
- Load-check tests are never part of a `run` step (a person starts those on purpose).
- **Restarts:** a run is driven by the process that started it and records a heartbeat. A run found `running` whose
  driver stopped beating (after a crash or restart) is marked `interrupted` with a reason, **never resumed**. A graceful
  shutdown marks its own runs interrupted at once. Interrupted runs are found at start-up and whenever runs are read or
  started.
- Everything is behind the API key like the rest of the API, except the deploy token's own two routes (below).

---

## Starting a runbook

- **By hand:** Run now, or `POST /api/projects/:id/runbooks/:rid/run` (202, `{ runId }`).
- **By a schedule:** link the schedule (the Start automatically disclosure, `PUT …/schedules/:sid/runbook`, or
  `runbookId` when creating or changing a schedule). A due tick starts a runbook run instead of a plain job; its jobs are
  labelled as scheduled. If a runbook (or any job) is running, the tick is skipped with a plain reason and tried again,
  exactly like an active job. "Run now" on the schedule starts the runbook too, on the clicker's own runner; a due tick runs on the
  schedule maker's. Either way the run's owner decides which tests it can take (their runner's code scripts, phone, iOS device).
- **By a deploy token:** link the token (`PUT …/triggers/:tid/runbook`, or `runbookId` when creating the token). The
  pipeline's `POST /api/triggers/<token>/run` then answers `202 { "kind": "runbook", "runId", "runbook", "state":
  "running", "commit", "environment" }`; `GET /api/triggers/<token>/status/<runId>` returns `{ kind: "runbook", state,
  finished, passed, reason, steps: [{ id, title, status, reason, jobId }] }`. The token's rate limit applies; a stranger's
  token gets 404 for the run; `callbackUrl` and `url` are not used for runbooks (they are reported under `ignored`; poll
  the status route instead). The jobs the run starts are labelled "after a deploy" with the commit.
- A runbook that a schedule or token starts **cannot be deleted** (409 naming what starts it); a running one cannot
  either.

## API

| Route | |
| --- | --- |
| `GET /api/projects/:id/runbooks` | The runbooks (each with `definition`, plain-language `titles`, `usedBy`, `lastRun` with `ticks`, `running`, `warnings`), the `limits` and the `templates`. |
| `POST /api/projects/:id/runbooks` | Create from a definition. 400 with the first problem in plain words (and `details.issues` listing all). |
| `POST /api/projects/:id/runbooks/from-template` | `{ template, channelId?, name? }`. |
| `GET`, `PUT`, `DELETE /api/projects/:id/runbooks/:rid` | One runbook; `PUT` replaces the definition (earlier runs keep theirs). |
| `POST …/:rid/run` | Start a run: 202 `{ runId }`, 409 when a runbook or job is running. |
| `GET …/:rid/runs`, `GET …/:rid/runs/:runId` | Runs (newest first) and one run with its steps. `GET /api/projects/:id/runbook-runs/:runId` finds a run by its id alone. |
| `POST …/:rid/runs/:runId/cancel` | 202; cancels the run and the job of the step in progress. 409 if already finished. |
| `PUT /api/projects/:id/schedules/:sid/runbook`, `…/triggers/:tid/runbook` | `{ runbookId }` or `{ runbookId: null }`. |

## How it is built

`src/engine/runbook/` is pure (no I/O): `schema.ts` (the definition and its rules), `flow.ts` (routing, run status,
checks), `presets.ts`. `src/platform/runbook-store.ts` holds the tables (migration 14: runbooks, runs, one row per step,
and two small link tables for schedules and deploy tokens, so those tables are untouched), `runbook-runner.ts` drives runs
through the platform's jobs, `runbook-triggers.ts` is the deploy-token glue, `routes/runbooks.ts` the routes. The
scheduler and the schedule and trigger routes have small additive hooks. The message goes through
`AlertService.sendRunbookMessage` in `alerts.ts`.

## Limits worth knowing

- The jobs a runbook starts are **ordinary runs**: they appear in Runs and in the trends, and the project's normal alert
  rules still apply to them (a regression is announced as usual). A `notify` step is an extra, explicit message on top,
  so a channel can hear about a failing run twice, once from the alert rules and once from the step.
- A runbook run lives in the process that started it. If the API process and a separate worker process both run
  schedules, a run started by one is driven by that one; the other only sees it in the database.
- The `noHighSeverity` check reads each test's current finding. For a run against an environment, a test's own status is
  not changed by that run, so it reflects the project's own last findings.
- Templates assume the project's tests have types such as "smoke"; projects whose tests have none see the warning.
- There is no drag-and-drop in the editor: steps move with the up and down buttons.
