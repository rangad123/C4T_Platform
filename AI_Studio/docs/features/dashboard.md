# Dashboard: which of my applications is healthy right now?

With several projects, the plain list says little. The dashboard answers "can I release?" for every project in one look,
using only what the platform already knows: it starts no run, calls no AI model and never contacts your applications.

## What you see

Open **Projects** (the home page). With **two or more projects** the page becomes the dashboard; with none or one project
nothing changes (the welcome page and the plain list stay as they were).

* **A sentence for the whole fleet** under the title: "5 projects: 3 ready, 1 needs attention, 1 blocked".
* **Filter buttons** by readiness (with counts) and a **search box** (name or address). "Clear filters" brings everything back.
* **One row per project**, blocked first, then needs attention, unknown, ready, and by name inside each group:
  * the verdict as an icon **and** a word (**Blocked**, **Needs attention**, **Unknown**, **Ready**) with a coloured edge;
  * the **top two reasons** in plain words ("2 high-severity findings", "Last run 12 days ago"), "and N more" if there are more;
  * the project's address, when it last ran, and links to the project, its **Attention list** (tests that need review or could
    not be validated) and its **Runs**;
  * the **run ribbon** of the project's tests (validated, need review, could not be validated, waiting), as on the project Overview;
  * a **pass-rate line** for the last 10 runs (drawn once there are two runs), the pass rate of the latest run, and whether the
    project has a schedule and whether its last scheduled run worked.
* **How readiness is decided** at the bottom lists the rules below, taken from the same data the page uses.
* If the dashboard cannot be loaded, a message with **Try again** appears above the plain project list.

## What the pass rate means

One rule everywhere (`passRate` and `describeRun` in `src/engine/summary/pass-rate.ts`): the pass rate is the tests that passed divided by the tests that produced a verdict in that run (passed, found a problem, or could not be validated), with one decimal; `null` when none did. Tests that were not part of the run (not run yet, left out, cancelled, quarantined) are not in the denominator, and the text says so. `latestRun` in the dashboard answer (and in a release's automated snapshot) gains two sentences: `sentence` ("17 of 17 tests that ran passed.", "15 of 17 tests that ran passed, 1 found a problem and 1 could not be validated.") and `others` ("6 other tests did not take part in that run. Across all 23 tests right now, 6 could not be validated, 16 are unreliable.", plus "The pass rate leaves out 2 quarantined tests." when some are). The dashboard row, the release page, the printed release report and the MCP tools say the same. A release signed before the sentences existed shows only its percentage.

## How readiness is decided

The verdict is computed by fixed rules (no AI, no scores). The first matching group wins: blocked, then needs attention.

| Verdict | When |
|---|---|
| **Blocked** | any open **critical** or **high-severity** finding; or the last analysis or run **failed** (for example the application was unreachable). Cancelled jobs are ignored. |
| **Needs attention** | tests failing in the last run, or tests that could not be validated; open **medium** or **low** findings; **unreliable (flaky)** tests; a **breaking API change** since the previous run; tests **not validated yet**; or the last run is **stale** (see below). |
| **Unknown** | the project was never analyzed, its tests were never run, the analysis made no tests, the first analysis is still running, or its stored data could not be read. |
| **Ready** | none of the above: every test passes, no findings, no unreliable tests, no breaking API change, and the last run is at most 7 days old. |

* **Stale**: the last finished run ended **more than 7 days ago** (exactly 7 days is still fresh). A project that would be ready
  becomes *needs attention* with the reason "Last run 12 days ago". On a blocked or needs-attention project the reason is added at
  the end. Unknown projects have no run to be old.
* **Reasons** are listed most important first: critical findings, high-severity findings, a failed run, failing tests, medium and low
  findings, unreliable tests, breaking API changes, tests not validated yet, stale. The page shows two; the API returns all.
* A finding is a test in *needs review*; its severity is the same one the project Overview shows.
* A project whose stored data cannot be read becomes **Unknown** with the reason "Some of this project's data could not be read".
  Other projects are not affected.

## The API

`GET /api/dashboard` (same API key as every other route). Optional `?state=blocked|needs-attention|unknown|ready` and `?q=text`
(name or address, not case sensitive); an unknown state answers 400. The answer:

```json
{
  "generatedAt": "2026-10-07T12:00:00.000Z",
  "summary": { "total": 5, "ready": 3, "needsAttention": 1, "blocked": 1, "unknown": 0, "sentence": "5 projects: 3 ready, 1 needs attention, 1 blocked" },
  "projects": [
    {
      "id": "…", "name": "Checkout", "host": "checkout.example.com",
      "readiness": { "state": "blocked", "label": "Blocked", "stale": false,
                     "reasons": [ { "code": "high-findings", "text": "2 high-severity findings" } ] },
      "analysis": { "status": "COMPLETED", "at": "…", "active": false },
      "tests": { "total": 14, "validated": 11, "needsAttention": 2, "couldNotValidate": 1, "waiting": 0 },
      "latestRun": { "jobId": "…", "finishedAt": "…", "trigger": "schedule", "mode": "validate", "passRate": 78.6, "total": 14, "validated": 11, "failed": 1, "needsReview": 2 },
      "trend": [ { "at": "…", "passRate": 85.7 }, { "at": "…", "passRate": 78.6 } ],
      "schedule": { "exists": true, "enabled": 1, "total": 1, "lastRunOk": true, "lastRunAt": "…", "note": null },
      "findings": { "critical": 0, "high": 2, "medium": 0, "low": 0, "highOrCritical": 2 },
      "flaky": 0, "apiBreakingChanges": 0, "lastRunAt": "…"
    }
  ],
  "rules": [ { "state": "blocked", "label": "Blocked", "summary": "…", "when": [ "…" ] } ],
  "staleDays": 7
}
```

* `summary` always counts the whole fleet, even when the list is filtered, so filter buttons keep their numbers.
* `host` is the address's host name only (the full address can carry a path or a key). `trend` is the latest 10 runs, oldest first;
  `passRate` is a percentage, `null` when a run executed nothing.
* `rules` and `staleDays` carry the rules above, so a client can show why.
* `readiness.reasons[].code` is stable (`critical-findings`, `high-findings`, `job-failed`, `failing-tests`, `medium-findings`,
  `low-findings`, `unreliable-tests`, `breaking-api-change`, `unvalidated-tests`, `stale`, `never-analysed`, `never-run`,
  `no-tests`, `analysis-running`, `data-unreadable`); `text` is for people.

## How it works

* **No new tables.** `src/platform/dashboard.ts` reads jobs, tests, run summaries (the data of the **Trends** tab), schedules and API
  snapshots (the data of **API changes**). Unreliable tests use the same rule as the project's flaky list
  (`flakyCountsByProject` in `trends.ts`, which shares its code with `detectFlaky`).
* **A fixed number of queries for all projects**, never one set per project: nine queries whether there are 3 projects or 50
  (a test counts the statements and compares both).
* **Read only.** It writes nothing, starts no job and sends no request to a target or a model.
* **The rules are one pure function**, `assessReadiness`, with a table-driven unit test for every state and reason.
* **UI**: `web/src/features/dashboard/*`; the only change to a shared page is in `Home.tsx` (two or more projects show the dashboard,
  with the plain list as fallback).

## Limits

* The verdict is only as fresh as the last finished run. A project nobody runs becomes stale after 7 days; schedule a daily run
  (see [Schedules](schedules.md)) to keep it current.
* "Latest run" means the newest finished run of any kind (analysis, re-run, scheduled, deploy). A browser-check or environment run
  also counts as the project's last run.
* The ribbon shows the project's tests as they stand now (the same counts as the project Overview), not the per-test results of
  the last run.
* A breaking API change stays on the dashboard until the next run with API requests shows none.
* The threshold of 7 days and the rules are fixed; they are not settings.
