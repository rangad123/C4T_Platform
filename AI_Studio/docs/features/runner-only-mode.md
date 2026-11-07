# Runs only on runners (`EXECUTION_MODE=runners`)

A hosted platform must not run its customers' tests on its own server: anything run there can read what the server's user can. With `EXECUTION_MODE=runners` the platform runs tests only on runners (the program on a tester's or a team's own computer) and never runs test code or opens a browser for a run itself.

`EXECUTION_MODE=local` (the default) keeps everything as before: self-hosted installs and development run tests on the server or on a runner, per project.

## What the server does in this mode

- **A dispatch worker** starts with the API process, even with `WORKER_EMBEDDED=false`. It takes only jobs a runner can do (runs of existing tests: a run, a suite, an environment run, a browsers check) and looks after up to `DISPATCH_CONCURRENCY` (default 8) at once. Each job mostly waits for its runner, so a slow or busy runner holds only its own slot. One active job per project still holds.
- **Every project runs on runners**, whatever its stored setting says. The stored setting is not rewritten; a runner the project is pinned to still applies. `PUT /api/projects/:id/runner` with `platform` answers 409.
- **Runs start while the dispatch worker is alive.** `/api/config` has `executionMode` and keeps `runsHere` true while runs can start. A run with no runner the person may use online is refused at once (409) by the job gate.
- **Schedules fire** (with `SCHEDULER_ENABLED`, the default) and hand their runs to runners. Runner housekeeping (leases, stale tasks, old task files) rides on the scheduler's tick, or on its own timer when the scheduler is off. `GET /api/projects/:id/schedules` says whether schedules really fire (`schedulesFire`, `schedulesNote`), in both modes.
- **Jobs queued before the switch** that need the server's browser are ended with a plain reason when the dispatch worker starts, so they do not hold their project.

## What is refused, and how

| Work | In this mode |
|---|---|
| Exploring with the AI, a test described in words, agent runs | Refused when made (409, a sentence); nothing is saved or queued. Every way a job is made goes through the same check in `Repo.createJob`. |
| Security assessments | Refused when started (409); no assessment loop runs. |
| Recording or a phone session "on the server" | Refused (409); on a runner they work as before. |
| Checking or capturing a saved sign-in in a browser | Refused (409). Inside a run the saved sign-in is not checked first; it goes to the runner with the tests, and the run says so. |
| Repair suggestions that need a browser | Not made; the run says so. |
| Test data reset | Sent from the server, so only to a public address. A private or local address stops the run before any test, with a sentence. |
| Email steps | Fail on a runner with their own message (the mailbox is read by the platform). |
| Report PDF | Allowed: the platform's own static page, scripts off. The only browser the server opens. |

As the last line, the server's Playwright launch functions and its local script executor throw (`SERVER_RUN_REFUSED`) and count the attempt, so a path that should have gone to a runner fails loudly instead of running.

## Who a run belongs to, and which runner

- A schedule's job carries `startedBy = { kind: "schedule", id, ownerId }`. `ownerId` is the person who made the schedule (`schedules.created_by`, migration 52; null for older schedules and for schedules made with an API key), so a person's own runner can take that person's scheduled runs.
- Every route a person starts a run from accepts an optional `runnerId` in its body (`POST /api/projects/:id/runs`, `/api/tests/:id/validate`, `/api/tests/:id/baseline`, `/api/tests/:id/variants`, `/api/projects/:id/variants`, `/api/projects/:id/environments/:name/runs`, `/api/projects/:id/test-suites/:sid/run`, `/api/projects/:id/schedules/:sid/run`, `/api/projects/:id/validation`, `/api/projects/:id/specs`). It is carried into the job as `options.runner`; the job gate checks it. Runbook runs and deploy triggers keep the project's setting.

## When things go wrong (both modes)

- **A runner fails** (stops answering, cannot start, refuses): the job fails with the runner's words, and tests that had no result yet go back to what they were. No test is marked failed by it.
- **The process looking after a job is lost** (its lease runs out): before the job is queued again, its earlier runner tasks are cancelled, so a runner never runs it twice at once. After the third loss the job is given up with a plain reason, and its unfinished tests are back to not run yet.
- **A deploy or restart** stops the dispatch worker. Runs still going after `SHUTDOWN_GRACE_SECONDS` (60) are stopped: the runner is told to stop, the run is marked interrupted, and its unfinished tests go back to not run yet. A run cannot yet be picked up again by the new process.

## Limits

- One API process: the dispatch worker lives in it. A second dispatch worker (`npm run worker` with this mode) is safe (jobs are claimed atomically) but not needed.
- A run waiting for a busy runner holds one dispatch slot for up to 30 minutes; with all slots held, further runs wait in the queue.
- The test data reset still goes from the server, not the runner.
