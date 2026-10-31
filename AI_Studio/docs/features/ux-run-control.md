# Run control and an honest Stop

What changed for the tester: one **Run** control, a live strip while a run goes, a Stop that says what it keeps, and a page for each run.

## What the tester gets

- **Run panel** (Tests header, test page as the arrow beside *Run again*, Runs page). *What*: failing now, this group, selected tests, all tests, not run yet, each counted; disabled when empty. *Where*: this server, each runner (online or offline), each environment; production keeps its confirmation. *How*: other browsers and screen sizes, and "run failing tests once more straight away" (the platform's `retryFailures`). One sentence is computed from the choices; no time estimate (the platform has no real total to base one on).
- **Choosing a different runner** in the panel changes the project's runner setting first (the same `PUT /api/projects/:id/runner` the Runners tab uses) and the panel says so.
- **Select tests** in the Tests list adds a checkbox per row and a bar that counts; *Run selected* opens the panel with those tests.
- **Run strip** (project pages, test page): "Running 7 tests, 3 done, 1 failing, On this server", elapsed time, the newest live event, a list of tests with state (waiting, running, passing, failing, needs a look, not run) and links, and **Stop run**. When the run ends it says how it ended until dismissed. On a test's page it shows only that test.
- **Stop** asks "Stop this run?" and says how many results are recorded now; "Tests that did not finish keep their previous result" is the platform's rule since UXP. A run reads **Stopped: 3 of 7 ran** on the Runs page, Overview and run page. Wording: *Stop run* for runs, *Stop exploring* for the AI exploration, *Stop building* for a test built from a description.
- **Run page** (`#/projects/:id/runs/:jobId`): what ran, where, when, how long, who started it (person, schedule, deploy, run sequence), every test with failures first and the reason line, "Changed since the last run" (newly failing / newly passing), and *Run failing tests again* / *Run these tests again* (the same environment for an environment run). An exploration lists the tests it created.

## Platform additions (small, additive)

- `POST /api/projects/:id/runs` `{testIds?, retryFailures?, variants?}` starts the same validation job a schedule or test run starts, for exactly those tests (default: every test). 400 for an unknown test or variant, 422 when nothing can run, 409 while another run is active.
- `GET /api/projects/:id/runs/:jobId` reads one run test by test (`src/platform/run-view.ts`): `counts {planned, ran, passed, failed, findings, running, waiting, notRun}`, `tests[]` with `state`, `reason`, `durationMs`, `startedBy`, and `changes`. Everything is read from rows the run already wrote; nothing new is stored.

## Limits (honest)

- Scripts run together and results are recorded when they finish, so during a run most tests show "running", not a live step; there is no per-step live view on this page. On a runner, progress lines ("Finished 3 of 12 tests") reach the strip's one-line status through the live stream.
- "Changed since the last run" compares each test with its own previous result, only for runs of existing tests on the project's address (not environment, browser-check or exploration runs).
- Environment runs leave out phone and desktop tests (said in the panel's sentence).
- A run asked for by id lists is limited to 2000 tests.
- The panel's runner list needs the runner routes; without them it says "Runs on this server".
