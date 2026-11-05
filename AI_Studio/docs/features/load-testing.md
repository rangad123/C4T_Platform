# Basic load check: does an endpoint cope with 10 people at once?

The speed checks time one user at a time. The load check asks one more question about up to three API endpoints: **does it stay fast and
error-free when 10 people use it at the same time?** It is a small, safe check, **not a stress test and not capacity planning**: it will not
tell you how many users your application can take, only whether a handful of simultaneous users is already a problem.

**Off by default.** It is allowed by the project's **Performance** testing agent (Settings → General → Testing agents) and asked for per
exploration through the API or an AI assistant (`loadChecks: true`); the Explore page has no switch for it. It sends up to 300 requests to
each of up to 3 pages of your application. Use a test environment.

## What it does
For each of up to **3 endpoints** it picks, the test:

1. sends one ordinary request first (the test's own request). If that is not a success (for example HTTP 401 because no API token is
   configured), the endpoint is **not put under load** and the test passes with the note *"Load check skipped: a single request answered HTTP 401"*;
2. runs the **main round**: users start one after another over a few seconds, up to **10 users at once**, for about **10 seconds**. Each user sends a
   request, waits for the answer, pauses briefly and sends the next, so the traffic is spread over the whole window;
3. judges the round against the budgets (below). If it is within budget the test passes, and that is all;
4. if a budget was exceeded, runs the endpoint **once more at half the users** (5) before reporting anything, so one unlucky round does not become a finding.

### The limits are fixed in the code
These are constants of the test (and of the script you can download), not defaults. A spec, the API or a settings file can only **lower** them:

| Limit | Value |
|---|---|
| Endpoints per project (analysis) | 3 |
| Users at once | 10 (lowest allowed: 2) |
| Requests per endpoint, **in total** (the first request, the main round and the half-load round together) | 300 |
| Length of one round | 10 seconds (ramp-up at most 3 seconds) |
| Methods | **GET only**; the code that sends the requests has no method to choose |
| Retries | never |
| Load checks running at the same time on one machine, per application address | 1 (they take turns, also across test workers) |

Numbers asked for above the caps (for example `users:500`) are clamped to the caps, both when the script is generated and again when it runs.
An import may contain at most 3 load checks, a test contains at most one, and a load check cannot be data-driven (it would repeat per row).

### It stops to protect the application
- If **any answer is HTTP 429** (rate limited) the endpoint is left alone at once, with no further request. This is not a finding: the limiter is
  doing its job. The test passes with the note *"The endpoint limits how often it can be called (HTTP 429). Load was stopped…"*.
- If **more than 20%** of the answers are server errors (5xx) or network failures (judged from the 5th answer on) the round stops at once. That is
  reported as *"Stopped to protect the application"*, after the half-load round.

## Budgets and findings
| Budget | Default | Override |
|---|---|---|
| 95% of responses within | 1000 ms | `p95:500` |
| Requests that fail (5xx or no answer) | 1% (and at least 2 failures) | `errors:2` |

The step's `expected` text takes a space-separated list that can also **lower** `users:5 seconds:5 requests:100`. From the API, pass `loadBudgets`
next to `loadChecks: true` when starting an analysis.

A budget breach is a **finding** ("Needs review") only after the half-load round, and it says what happened at both levels:

- *"The endpoint struggled at 10 users at once (it coped with 5)"*: the half-load round was within budget.
- *"The endpoint struggled at 5 users at once"*: the half-load round was over budget too.

**Severity (per line):** a slow 95th percentile, a stop for failures, or an error rate above 5% is *medium*; a mild error rate (between the budget and 5%) is *low*.
Findings read "Load check: ..." in the UI, are the category `load` in the `ai-test` CLI (SARIF rule `LoadCapacity`) and are never sent to the AI repair step.

## What is measured
Every run stores, for the main round: users, requests sent, requests per second, share that failed, typical (p50), 95th-percentile and slowest
response times, and how many answers were successes, client errors (4xx), server errors (5xx), turned away (429) or had no answer. They go to the
same history as the speed checks (`perf_metrics`), so a trend builds up with no new tables. The test page shows a card titled **Handles N users
at once** with each value, its budget, *Within budget* / *Over budget* in words and a small history line; counts that are zero are left out.

`GET /api/tests/:id/performance` returns them like every other speed value.

## Which endpoints
Only **GET** endpoints that the API description or the observed traffic shows answering successfully and that can be called with what is known
(no path parameter without an example). Never an endpoint whose path looks like **sign-in, sign-up, payment, checkout, cart, order, delete,
logout, token, password, reset, upload, send, export** and similar (a wider list than the form checks use). An endpoint that needs sign-in is used
only when the project has an API token or auth header, and is sent the same way the speed check sends it; without one it is not generated.

## Where it never runs
- **Production.** A load test in a run against an environment marked *production* is **skipped** with the reason *"load checks don't run on
  production, so this test was not run here."* An analysis with the load option for an address that is a production environment of the project is
  refused (HTTP 409); a re-run of existing load tests against such an address does not send them.
- **Addresses the platform may not call.** Every address goes through the platform's outbound guard (`BLOCK_PRIVATE_TARGETS` and friends) when the job is
  created, and again before load tests are re-run.
- **Schedules and deploy triggers.** Scheduled re-runs and deploy-triggered runs leave load tests out, and a scheduled re-analysis switches the option off
  whatever the saved settings say. Starting a load check is always a person's decision. (Schedules have no option to turn it on.)
- **Automatic retries and repairs.** A load check is never re-run straight away (scheduled "run again to tell flaky from broken" skips it) and a failure
  is never handed to the AI repair step.

## How it works
`src/engine/performance/load.ts` holds the helper (plain JavaScript pasted into the generated script and compiled for tests from the same text,
with an injectable clock so the maths is tested without waiting), the spec generator, and the finding classifier (messages start with
`Load check failed:` and carry a `[severity]` per line). `generators/api.ts` renders the step; `validator.ts`, `severity.ts`, `cli/model.ts` and
`cli/render.ts` classify it; `platform/load-guard.ts` holds the production and address rules; the option `loadChecks` (default `false`) travels
through `server.ts`, `repo.ts`, `job-runner.ts` and `orchestrator.ts`. A plain note a passing check wants kept (the 429 case) is attached as `notes`
and stored as the test's reason.

## Limits
- It measures **one application from one machine**; the numbers are indicative and include the network between you and the application. Compare an
  endpoint with itself over time.
- **Not a capacity test.** 10 users and 300 requests will not find the point where the application breaks, and a pass is not a promise it scales.
- The load check coordinates through a lock folder in the machine's temp directory. Several machines (CI runners) pointing at the same application are
  not coordinated with each other.
- Web pages are not load tested, only API endpoints; the endpoint list comes from the analysis (API description or observed traffic).
- The `ai-test` CLI replay and `--specs` modes run a load check if the specs file contains one (the same limits apply); `--env production` skips it.
- There is no UI field for the lower limits (use the API or an imported spec).
