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
