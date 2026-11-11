# The live view of a run on a runner

A run that goes to a runner shows, while it goes and afterwards, what the runner is doing. Nothing is polled from the runner: the runner sends live events to the platform (protocol 2, `POST /api/agent/tasks/:id/events`), the platform stores them as job events, and the page reads them.

## What the person sees

**Run page** (`#/projects/:id/runs/:jobId`), a card "Progress on the runner" (after the run: "On the runner"):

- **Where the run is**: Queued, Offered, Accepted, Getting ready, Running, Sending results, Done. A run that ended badly shows how far it got, then Turned down, Did not finish, Stopped, Took too long or Lost contact. One sentence says it with the runner's name ("maya-laptop is getting ready: it fetches the tests and the files they need.").
- **Runner**: its name; when it is the viewer's own runner (from `GET /api/me/runner`), "Your computer" and a link to Your runner in Settings.
- **Started** (when the runner accepted the run or started its first test), **Running for** (ticking) or **Took**.
- **Now**: the test and step it is on ("Checkout (WEB-002), step 4: Click Pay").
- **Steps done** and **Results so far** ("2 passed, 1 failed, 1 running").
- **What failed**: each failed test, the step that failed, the error text, and the stack trace behind a disclosure.
- **Screenshots** as they arrive, newest first (six, then "Show all").
- **Runner log**: the runner's own lines and the platform's lines about the task (offered again, turned down, stopped answering). It follows new lines only while the reader is at the bottom.

The list of tests below shows each test's state as the runner reports it (and the step a running test is on) until the platform stores the run's results; a stored result always wins.

**Run strip** (the project's pages): on a runner, it adds the phase while the runner is not running tests yet or is sending results ("Getting ready"), and replaces the newest event line with "Now: Checkout (WEB-002), step 4: Click Pay". Its passed and failed counts use the runner's report until the results are stored.

**View technical details**: adds the runner (name and id) and the task's phase.

A screen reader hears the phase and the test ("Test 3 of 7: Checkout."), never every step.

## Where it comes from

- Events: `runner_phase`, `runner_test_started`, `runner_step` (`state` started or finished), `runner_test_finished`, `runner_screenshot`, `runner_log`, and the platform's own `runner_*` task events. A protocol-1 runner sends none; its `agent_task_queued`, `agent_task_started` and `agent_progress` lines give a phase (queued, running) and the log, and the card says that steps and screenshots appear with the results.
- The phase shown is the platform's own (`ranOn.phase` on the run), else the newest phase event, else, once the run is over, what the job says.
- The page reads every runner event of the run once (`GET /api/test-generation/:jobId/events`, in pages of 500), then adds new ones as the run's live stream brings them (the stream carries a runner event's facts). Without the stream it reads new events every 3 seconds while the run goes. So a refresh, or coming back later, shows the same picture.
- A new attempt (the run was offered again) starts the tests over; the earlier attempt's lines stay in the log.
- Screenshots load from `GET /api/projects/:id/runs/:jobId/runner-files/:taskId/:name`. A signed-in browser loads them as plain images; with an access key the page fetches them with the key in a header.
- The code is `web/src/features/runs/live-run.ts` (the fold, pure), `LiveRun.tsx` (reading and the card), `RunStrip.tsx`, `RunDetail.tsx`.

## Limits

- Live screenshots are kept with the runner's task for a day; after that the card says the picture is no longer kept, and the run's own screenshots (with its results) remain.
- A test run in several browsers or screen sizes is shown as one test: each run of it starts it over.
- "Your computer" compares the run's runner with the viewer's own (`GET /api/me/runner`); anyone else sees the runner's name only.
- The card keeps the last 300 log lines; the full list of events is under "View technical details".
