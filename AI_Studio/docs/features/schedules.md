# Schedules, trends, flaky tests and alerts

Let the platform run your tests on its own, show whether things are getting better or worse, point out tests
that cannot be trusted, and tell you (in Slack, Microsoft Teams, email or any web address) when something changes.

Open a project and choose the **Schedule** tab.

## What you can do

**Schedule a run.** Pick what should run and how often:

| What runs | Needs the AI model? | What it does |
|---|---|---|
| **Re-run all tests** | No | Runs every test of the project that this computer can run, exactly like the "Re-run" button, and compares the result with the earlier ones. Mobile tests are included only when an app and an emulator are set up. |
| **Analyze again** | Yes (for web testing) | A full analysis with the settings of the project's latest analysis (address, scope, limits, credentials). |

How often: every few minutes (at least 5), every few hours, every day at a time, or every week on a day and time.
Daily and weekly times are the **server's local time**; the tab shows which time zone that is.

Each schedule shows when it runs next, when it last ran, and a link to its runs. **Run now** starts it
immediately. **Pause / Resume** and **Delete** do what they say. Runs started by a schedule are marked
**Scheduled** in the Runs tab and in the trend list.

**Never two runs at once.** A project runs one job at a time. If a schedule is due while a job is still
running, it is skipped, the reason is shown on the schedule ("Skipped 2 min ago: A job is still validating…"),
and it is tried again at the next check (every 30 seconds) until the job is done.

**After downtime.** Schedules survive restarts. If the platform was off when a schedule was due, the schedule
runs **once** when the platform is back; the missed slots are not replayed, and the next run is counted from then.

**See the trend.** A chart of the pass rate of every finished run (scheduled or by hand) over the last 7, 30
or 90 days, the change over the period, the average, and a list of recent runs with how many tests passed.

**Spot unreliable (flaky) tests.** A test is *unreliable* when its recent results flip between pass and fail
without the test having changed. See [How flaky tests are found](#how-flaky-tests-are-found).

**Get alerts.** Add a Slack, Teams, email or webhook channel (Teams and email are described in [notifications-and-import.md](notifications-and-import.md)), choose which events to hear about, press **Send test** to
check that it works, and watch the **Recent alerts** log to see what was sent and whether it arrived.

## Alerts

| Event | Sent when |
|---|---|
| **A test starts failing** (`regression`) | A test that passed in its last run now fails or has a new finding. |
| **A run has failures** (`run_failed`) | A run has failing tests or findings — or could not complete at all (for example the application was unreachable). |
| **A test is unreliable** (`flaky`) | A test failed and then passed when run again straight away. It is **not** reported as a regression. |
| **A failing test is fixed** (`recovered`) | A test that was failing passes again. |

* **No repeats.** An alert is sent once per situation. If the same tests are still failing on the next run,
  nothing more is sent. When the situation clears and comes back, you are told again. A message that could not be
  delivered is tried again after the next run.
* **One message per run and channel.** If a run triggers several events your channel subscribed to, they arrive
  together in one message.
* **Severity.** Application findings below a minimum severity are ignored (default: everything is reported).
  Set `ALERT_MIN_SEVERITY=medium` (or `high`, `critical`) to raise the bar for all channels; a channel can have
  its own minimum. A test that is itself broken (as opposed to a finding in your application) is always reported.
* **Which runs alert.** Scheduled runs and fresh analyses always do. A re-run you start by hand alerts when it
  covers two or more tests; re-running a single test by hand does not.
* **Delivery.** Each message is tried up to three times (waits of 0.5 s and 2 s) with an 8-second limit per try.
  A server error (5xx), "too many requests" or a network failure is retried; any other client error (for
  example 404) is final. Redirects are not followed. The outcome of every message is written to the log. A
  failing receiver never affects a run.
* **The address is a secret.** A Slack webhook URL lets anyone post to your channel, so it is stored
  encrypted (the same way test credentials are) and is never sent back to the browser — only its host name is
  shown. To change it, add a new channel.
* **Safe targets.** Alert addresses follow the same rule as tested applications: with
  `BLOCK_PRIVATE_TARGETS=true`, addresses on private networks or localhost are refused, both when saving and
  when sending.
* **Links.** Messages link to the project. The base address comes from `PUBLIC_URL`; without it the link uses
  the server's own address (`http://HOST:PORT`) — set `PUBLIC_URL` when people reach the platform under a
  different name.

### Webhook payload

A **Webhook** channel receives `POST` requests with `content-type: application/json`:

```json
{
  "event": "regression",
  "events": ["regression", "run_failed"],
  "test": false,
  "sentAt": "2026-10-06T02:00:41.120Z",
  "project": { "id": "6f0c…", "name": "Shop", "url": "https://shop.example.com" },
  "link": "https://qa.example.com/#/projects/6f0c…",
  "summary": "Shop: 2 tests newly failing. 1 of 3 tests passed (33.3%).",
  "run": {
    "jobId": "b81a…", "status": "PARTIALLY_COMPLETED", "mode": "validate", "trigger": "schedule",
    "finishedAt": "2026-10-06T02:00:40.000Z",
    "total": 3, "passed": 1, "failed": 1, "needsReview": 1, "flaky": 0, "passRate": 33.3, "durationMs": 31200
  },
  "newlyFailing": [ { "testKey": "API-002", "title": "Login works", "severity": "high", "reason": "Server error: GET /api/x returned 500 …" } ],
  "recovered": [],
  "flaky": [],
  "findings": [ { "testKey": "API-002", "title": "Login works", "severity": "high", "reason": "…" } ],
  "error": null
}
```

* `event` is the most important event in the message; `events` lists all of them. Possible values:
  `regression`, `run_failed`, `flaky`, `recovered`. The message sent by **Send test** has `event: "test"` and
  `test: true`.
* `run.passRate` is a percentage (or `null` when no test ran); `run.failed` counts tests that could not be made
  to pass, `run.needsReview` counts tests that found something in your application, `run.flaky` counts tests that
  passed only on a re-run.
* `findings` lists the currently failing tests, worst first (at most 5). `severity` is present for application
  findings only. `reason` is shortened to 240 characters.
* When a run could not execute any test (for example the application was down), `error` holds the reason and
  `run.total` is 0.

A **Slack** channel receives the standard incoming-webhook body: `text` (the notification fallback) and
`blocks` (a header, a summary, pass/failing/flaky counts, the top findings and an **Open project** button). This
also works with other tools that accept Slack-style webhooks.

## How it works

* **Scheduler.** A small loop (`src/platform/scheduler.ts`) runs next to the worker, in the same process as the
  server (embedded worker) or in `npm run worker`. Every `SCHEDULER_TICK_MS` (default 30 s) it takes the
  schedules that are due and creates their jobs. A due schedule is taken with one atomic database update on its
  `next_run_at`, so if two processes run a scheduler against the same database, only one acts on each due schedule.
* **Run summaries.** When any job finishes, the worker records a compact summary (`run_summaries`): which test
  passed, failed or found something, and what changed compared with what was last known about each test — newly
  failing, fixed, still failing, new findings, flaky passes. A test is compared with its own latest earlier
  result, even if that came from a smaller run. Re-runs compare tests by their key; fresh analyses (whose tests get
  new keys each time) compare by test title. Browser-variant checks and cancelled jobs are not summarized.
* **Retrying failures.** Scheduled re-runs run a failing test once more straight away with the very same script
  (`retryFailures`, default 1; set per schedule in the API, a checkbox in the UI). Both executions are recorded.
  A test that fails and then passes is a **flaky pass**: the test is marked passed, listed as unreliable, and not
  alerted as a regression. A test that fails both times continues into the normal failure handling.
* **Storage.** Five tables (migration slot 4): `schedules`, `alert_channels`, `alert_log`, `alert_state` (what each
  channel was last told, for de-duplication) and `run_summaries`, plus two indexes on `test_executions`.

### Cancelling a run

Cancelling a run (**Stop run** on a re-run, **Cancel analysis** on an analysis, `DELETE /api/test-generation/:jobId`) never rewrites a test's result. Tests that finished before the cancel keep the result they just got. Tests that did not get to run keep the status, reason, severity and history they had before the run (an analysis's new tests that did not run are "not run yet"). Nothing is recorded for a test that did not run: no execution, no evidence. The run is marked cancelled and says how many tests ran and how many did not, in a sentence made from those counts: `cancelled: { planned, ran, notRun, note }` on the job in the API (the same sentence is a run event, `cancel_summary`). A cancelled run has no run summary, no trend point and no alert, and the executions it recorded are left out of flaky detection and quarantine suggestions.

How it works: a local run keeps each test's result as it ends (a small reporter writes it next to Playwright's own report, which is only written when the whole run ends), so a run cancelled half way still reports the tests that had finished. Before validation starts, the platform remembers each test's status and reason; a test the cancel came before is put back to exactly that.

Not covered: a run on a **runner agent** keeps no partial results. The agent is stopped, its answer is dropped, and every test of that run counts as not run (and keeps its earlier result). A test that had already failed when the cancel arrived, and whose automatic repair the cancel cut off, keeps that failure as its result (the reason ends with "repair skipped: job cancelled"). Executions that cancelled runs recorded before this change are not cleaned up. A run that stops for a reason other than a cancel (the application or the agent became unreachable) still marks its unfinished tests "Validation interrupted".

### A finding stays a finding

What a failed run proves on its own (an application finding such as missing security headers, an accessibility problem or a visual change; a sign-in that did not work; an AI judgement that could not run) is decided by one function, `classifyFailedRun` in `src/engine/validation/validator.ts`. The first analysis, a manual re-run, a schedule, a deploy trigger, a runbook step and a run against a named environment all use it, so a test is "Needs review" with the same severity on every path. Automatic repair attempts no longer matter for this: an immediate re-run (retries) does not use up a repair attempt, and a finding is recognised before the repair budget is looked at. Before this, a finding that was retried could end as "Validation failed" with no severity when `MAX_REPAIR_ATTEMPTS` was 1 or 0.

### How flaky tests are found

For every test the platform looks at its last 20 executions of its **current script**. If the test is edited or
repaired, its old results are ignored — they say nothing about the new version. A test is listed as unreliable
when its results changed from pass to fail or back **at least twice**, or when it ever passed on an immediate
re-run after failing. A test that failed once and stayed failed is a regression, not a flaky test. The list is
sorted by how often consecutive results disagreed (flips ÷ (runs − 1)); each entry shows how many runs, passes,
fails and flips it is based on.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `SCHEDULER_ENABLED` | `true` | Run the scheduler. Schedules are still saved when off, and **Run now** still works. |
| `SCHEDULER_TICK_MS` | `30000` | How often due schedules are looked for. |
| `PUBLIC_URL` | — | How people reach the platform; used for links in alerts. |
| `ALERT_MIN_SEVERITY` | `low` | Lowest severity of an application finding that triggers alerts (`critical`, `high`, `medium`, `low`). |

## API

All under `/api/projects/:id/…` (with `x-api-key` when the server requires one). Errors use `404` for an
unknown project, schedule or channel, `409` when the request is fine but cannot be done now (a job is running, the
project has no tests, too many schedules or channels), and `400` for invalid input.

| Request | Purpose |
|---|---|
| `GET /schedules` | `{ serverTime, timezone, schedulerEnabled, schedules[] }`; each schedule has `cadence`, `cadenceText`, `enabled`, `nextRunAt`, `lastRunAt`, `lastJobId`, `lastOutcome` (`started`, `skipped`, `error`), `lastNote`. |
| `POST /schedules` | `{ kind: "validate" \| "generate", cadence, name?, enabled?, retryFailures? (0–3) }`. `cadence` is `{type:"interval",every,unit:"minutes"\|"hours"}`, `{type:"daily",time:"HH:MM"}` or `{type:"weekly",weekday:0-6,time:"HH:MM"}`. |
| `PATCH /schedules/:sid` | Change any of those fields. Changing the cadence or enabling restarts the clock from now. |
| `DELETE /schedules/:sid` | Remove. |
| `POST /schedules/:sid/run` | Run now → `202 { jobId, status, job }`; `409` while a job is running. |
| `GET /trends?days=30` | `{ days, runs[], summary }`: per run `finishedAt`, `total`, `validated`, `needsReview`, `failed`, `flaky`, `passRate`, `durationMs`, `trigger`; `summary` has `firstPassRate`, `latestPassRate`, `averagePassRate`, `passRateDelta` (percentage points). |
| `GET /flaky` | `{ tests[] }` ranked by `flipRate`, with `executions`, `passes`, `fails`, `flips`, `flakyPasses`. |
| `GET /runs/:jobId/summary` | What changed in one finished run (`diff`: `newlyFailing`, `fixed`, `stillFailing`, `newFindings`, `flakyPasses`). |
| `GET /alert-channels`, `POST`, `PATCH /:cid`, `DELETE /:cid` | Channels: `{ kind: "webhook" \| "slack", url, name?, events?, minSeverity?, enabled? }`. Responses never contain the URL. |
| `POST /alert-channels/:cid/test` | Sends a test message; always `200 { ok, httpStatus, attempts, error }` describing what the receiver really answered. |
| `GET /alert-log?limit=30` | The latest delivery attempts. |

Jobs started by a schedule have `trigger: "schedule"` and a `scheduleId` in the job API.

## Limits

* Times are the server's local time; the schedule does not follow each viewer's time zone.
* A schedule that is skipped is not queued: if a job runs for longer than the interval, runs are simply not
  started for that period.
* "Analyze again" needs the AI model for web testing, creates new tests next to the old ones (as a manual
  analysis does), and compares results by test title.
* Alert messages are English-only. There is no email channel.
* Alerts for jobs finished while the platform shuts down may not be sent (it waits up to 5 seconds for messages
  in flight).
* Flaky detection needs history: at least two executions of the same test version.
