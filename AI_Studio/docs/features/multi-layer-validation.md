# Checks across layers

A test that passes on the page can still leave the wrong thing behind: the API stored another value, the list misses the new record,
or the database holds a row that points at nothing. An exploration therefore checks more than what the page shows, where it can, and
says which layers it checked.

## The layers

| Layer | What is checked | Needs |
|---|---|---|
| **Page** | What the page shows and does (the browser tests). | Web tests in the run. |
| **API** | The documented answers of the API: statuses, shapes, access for each account, the documented cases. | An API document, or API calls seen while exploring. |
| **Stored data** | What a write stored, read back through the API. | **Include API tests that change data** on (Requirements tab). |
| **Database** | What a write stored, read in the database itself, and the database's keys (no row pointing at a missing one, no unique value twice). | **Include API tests that change data** on, and database checks set up ([database-checks.md](database-checks.md)). |

The checks are ordinary test steps, so they run, pass, fail and repair like any other step:

- a **kept response** (`wait` until `response` with `extract`): the answer the page's action got, kept for the steps after it;
- a **relation** (`assertResponse` with `check: "relation"`): an expression over the latest answer and the test's values, such as
  `discount == round(subtotal * 0.10)` (`src/engine/validation/relation.ts`);
- a **database check** (`assertResponse` with `check: "dbCheck"`): one of the fixed read checks, named in words
  (`src/engine/database/checks.ts`).

## Checked layers

A finished exploration's page shows the line **Checked layers**, in the card "How the exploration went": each layer its tests check,
with how many tests (and, for the database, how many database checks), then each layer that was not checked and why, for example
"Database: not checked, no read-only database access is set up". The report is the job's `layer-report` artifact
(`src/engine/validation/layers.ts`, `layerReport`), returned as `layers` by `GET /api/projects/:id/jobs/:jobId/coverage`. A run from
before these checks has no such line.

## Runners

A runner reports the capability `validationSteps: 1` when its scripts run these steps (`src/agent/capabilities.ts`). Tests that go to a
runner that does not report it run without their relation, kept-response and database steps, and the run says so in one sentence:
"Your runner is older than the checks across layers, so the relation, kept-response and database steps were left out of the tests it
ran. Download the runner again to run them." The tests themselves are not changed: the next run on a newer runner has every step.
Deploy the platform before the runner.

Database checks reach the database through a service of the run on the platform's own machine, so tests that run on a runner skip
their database steps with a note in the test's result.

## Known limits

- **Where the database checks sit.** In a test that changes data, the checks over the database's keys and stated rules run right after
  its last write, before the API checks on that answer and any read after it, so a stored-data fault fails at the database check
  (`src/engine/database/checks.ts`, `withDatabaseChecks`). A documented refusal of a repeat (HTTP 409) gets only the duplicate checks over
  the fields it sends. A record that is stored correctly but missing from a list fails at the list check: the database check before it
  passes, because the stored data is right.
- **Sign-in limit checks are recognised by their tag.** A test counts as a sign-in limit check (and needs the risky-check gate) when it
  carries the tag `rate-limiting`, as the generated check does (`src/engine/validation/risky.ts`). A hand-written test that repeats
  sign-ins without that tag runs without the gate.
- **The "fixture" gate is for test fixtures only.** The platform gives a job the gate "bench" (the benchmark's own server) or
  "authorization" (a current client authorization), never "fixture" (`src/platform/job-runner.ts`, `riskyChecksGateOf`).
- **Concurrency checks are capped per run and per endpoint.** At most 3 checks a run, one per endpoint: a workflow step and the create
  endpoint of the same record can both be checked (`src/engine/api/concurrency.ts`).
- **Older runners skip risky checks with the general sentence.** A runner that predates the gate field ignores it, so its risky tests
  skip with "Not run: it sends risky writes ..." and no sentence says the runner needs updating.
