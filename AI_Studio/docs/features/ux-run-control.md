# Run control and an honest Stop

What changed for the tester: one **Run** control, a live strip while a run goes, a Stop that says what it keeps, and a page for each run.

## What the tester gets

- **Run panel** (Tests header, test page as the arrow beside *Run again*, Runs page). *What*: failing now, this group, selected tests, all tests, not run yet, each counted; disabled when empty. *Where*: this server (only on a platform that runs tests itself, and only while the project runs there), each runner the person may use (their own computers first, then team runners), each environment; production keeps its confirmation. *How*: other browsers and screen sizes, and "run failing tests once more straight away" (the platform's `retryFailures`). One sentence is computed from the choices; no time estimate (the platform has no real total to base one on).
- **Choosing a runner** in the panel is for that run only: the run start sends `runnerId` and the project's setting does not change (the panel says so). Before the click, each runner that cannot take this run says why in one sentence (offline, cannot run web or API tests, cannot run phone tests, does not run code scripts, or the project does not allow people's own computers) and cannot be picked. "Any runner that is online" is offered when several can take it and the project has no default runner. The split *Run again* button sends no `runnerId`: the platform uses the project's default runner, or any runner that may take it.
- **Select scripts** in the Test scripts list adds a checkbox per row and a bar that counts; *Run selected* opens the panel with those tests.
- **Code scripts on your own computer**: when the runner chosen in the panel is the person's own computer (or "any runner" can only be theirs) and the run includes code scripts, a note before Start says "This run includes code scripts. They run on your computer with your user's rights." with a link to that computer's page, where its owner can switch code scripts off. The list of tests does not say who wrote a script, so the note names nobody (`codeScriptsSentence` names the authors when given them). A run of a fixed list ("Run failing tests again") does not know which tests are code scripts, so it shows no note.
- **Run strip** (project pages, test page): "Running 7 tests, 3 done, 1 failing, On this server", elapsed time, the newest live event, a list of tests with state (waiting, running, passing, failing, needs a look, not run) and links, and **Stop run**. When the run ends it says how it ended until dismissed. On a test's page it shows only that test.
- **Stop** asks "Stop this run?" and says how many results are recorded now; "Tests that did not finish keep their previous result" is the platform's rule since UXP. A run reads **Stopped: 3 of 7 ran** on the Runs page, Overview and run page. Wording: *Stop run* for runs, *Stop exploring* for the AI exploration, *Stop building* for a test built from a description.
- **Run page** (`#/projects/:id/runs/:jobId`): what ran, where, when, how long, who started it (person, schedule, deploy, run sequence), every test with failures first and the reason line, "Changed since the last run" (newly failing / newly passing), and *Run failing tests again* / *Run these tests again* (the same environment for an environment run). An exploration lists the tests it created.

## Runs only on runners (`EXECUTION_MODE=runners`)

On the hosted platform every run goes to a runner. The website reads `executionMode` from `GET /api/config` and the runners the person may use from `GET /api/projects/:id/runner-choices` (`web/src/features/runs/runs-here.ts`):

- "This server" is not offered anywhere: not in the Run panel, not in "Where this project's tests run", not for a phone exploration.
- Run, *Run again*, *Run suite* and the line under the Tests header wait until at least one runner the person may use in this project is online. With none, they say so, link to **Add this computer** (`#/runners?add=computer`) when the project allows people's own computers, and otherwise point to team runners.
- "Where this project's tests run" offers a **default runner** ("Any runner that is online", or one runner) and the switch **Allow people's own computers**, whose note says that the project's test accounts (passwords, one-time code secrets, API tokens and saved sign-ins) are sent to that computer for its owner's runs. Only someone who may change the project's settings can save it; others see it read-only. When only the switch changed, the save sends `{ allowPersonal }` alone.
- The Schedules panel says whether schedules really start: only while scheduling is on and runs can start (in runners mode, while the platform's dispatch is running). "Run now" is disabled while runs cannot start.
- Exploring (the application or a phone app) and "Describe it" say before the click, in the platform's own words, that they are not available in this mode yet, and cannot be started; the platform refuses them there.
- When a run with code scripts is going to the person's own computer, the panel says so before Start: "This run includes code scripts written by … They run on your computer with your user's rights.", with a link to that runner's page, where its owner can switch code scripts off. Names come from a script's saved versions, so they are given for a single test's run; a run of several tests says "This run includes code scripts." without names.

## Platform additions (small, additive)

- `POST /api/projects/:id/runs` `{testIds?, retryFailures?, variants?}` starts the same validation job a schedule or test run starts, for exactly those tests (default: every test). 400 for an unknown test or variant, 422 when nothing can run, 409 while another run is active.
- `GET /api/projects/:id/runs/:jobId` reads one run test by test (`src/platform/run-view.ts`): `counts {planned, ran, passed, failed, findings, running, waiting, notRun}`, `tests[]` with `state`, `reason`, `durationMs`, `startedBy`, and `changes`. Everything is read from rows the run already wrote; nothing new is stored.

## Limits (honest)

- On this server, scripts run together and results are recorded when they finish, so during a run most tests show "running", not a live step. On a runner that sends live events (protocol 2), the strip and the run page show the test and step it is on as it happens; see [run-live-view.md](run-live-view.md). A protocol-1 runner sends progress lines only ("Finished 3 of 12 tests").
- "Changed since the last run" compares each test with its own previous result, only for runs of existing tests on the project's address (not environment, browser-check or exploration runs).
- Environment runs leave out phone and desktop tests (said in the panel's sentence).
- A run asked for by id lists is limited to 2000 tests.
- The panel's runner list needs `GET /api/projects/:id/runner-choices`; without it the panel shows the project's setting as the platform says it and offers no per-run choice.
- Which runners can take a run is decided from the tests' kinds (web, API, phone) and whether they are code scripts. A run of a fixed list (for example "Run failing tests again") does not know the kinds, so the platform checks it when the run starts and its refusal is shown in the panel.
- The runner list is read again every 15 seconds while a Run control is on screen in runners mode, and when the panel opens; a runner that goes offline between the read and the click is refused by the platform with a sentence.
