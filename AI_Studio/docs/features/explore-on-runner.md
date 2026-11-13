# Exploring on your runner (rounds 51 and 52)

On a platform that runs tests only on runners (`EXECUTION_MODE=runners`, [runner-only-mode.md](runner-only-mode.md)), the server
never opens a browser. **Explore my app** still works there: the exploration runs on the runner of the person who starts it, the
one runner they set up in **Settings, Your runner** ([runner-settings.md](runner-settings.md)). In local mode nothing changes.

## How it works

- **The browser is on your runner.** The whole exploration (`runGeneration` in `src/engine/orchestrator.ts`) runs on your runner, in a
  child process, using the engine code the runner download already has. Crawling, signing in to your application, the AI's
  authoring agents and each validation run all happen there. Your application is reached from your computer, so an application
  only your network can reach can be explored. Private and local addresses follow your runner's **Test private and local addresses**
  switch, the same rule as runs.
- **Hidden unless you ask.** The browser runs hidden, unless the runner's owner switched on **Show the browser while exploring** in
  Settings, Your runner: then the offer carries `explore.showBrowser` (web explorations and web Describe it only) and the runner opens a
  real window for the browser the AI explores with, while the exploration's own test runs stay hidden (one window). `src/agent/show-browser.ts`
  decides once per task; Linux without a screen, or a visible launch that fails for want of a window (`fallBackToHidden` in
  `src/engine/discovery/browser.ts`), means hidden with one sentence in the job. Older runners ignore the field. See [runner-settings.md](runner-settings.md).
- **The AI stays on the platform.** Each time the engine asks the model something, the runner sends the call to the platform
  (`POST /api/agent/tasks/:id/explore/llm`). The platform runs it on the job's own model, built as it would be for an exploration
  run on the server: the project's AI setting, the routing to the fast model, the usage meter and the AI budgets. Only the answer
  goes back. Tools the AI calls, such as clicking a page, run on the runner. Since round 52 each call carries what it is for (planning,
  analysis, vision...), and the usage row says so, as on the server (anything else counts as authoring). When the runner's own agent
  loop moves a piece of work to the main model (it repeated itself, made no progress), the job's log says so once and the escalation is
  counted, as for an exploration on the server. If the runner's request goes away before the answer (runner gone, task stopped), the
  provider call is stopped too.
- **The key never leaves the platform.** The runner never gets the AI provider, the key or the AI configuration. All it knows is
  the model's name, so it can say which model is working.
- **What it makes is saved on the platform.** Tests, scripts, plans, baselines, screenshots and the exploration's memory are sent
  to the platform as they are made (`POST /api/agent/tasks/:id/explore/sink`), in order, and saved into the project as an
  exploration on the server would save them. Files travel as uploads. A screenshot, video or trace too large for one save (8 MB) is
  uploaded first in 4 MB pieces, so evidence of any size reaches the server, up to 256 MB for one exploration. The live steps on the project page come through the runner's
  live-event channel ([runner-protocol-2.md](runner-protocol-2.md)).
- **Watch live** shows the browser on your runner, a picture about once a second while the panel is open
  ([ux-explorer-view.md](ux-explorer-view.md)). The runner asks every 2 seconds whether anyone is watching
  (`POST /api/agent/tasks/:id/explore/frame`, fenced like the AI and saving routes) and takes no picture while nobody is. Pictures stay in the
  platform's memory, never in a file, a log or the database. A runner downloaded before this shows nothing and the page asks for a new download.
- **Sign-in details** saved on the project's Requirements tab go to the runner with the task. The runner keeps them in memory,
  hides them in its logs and never writes them to disk.

## The other jobs that run this way (round 52)

The same explore task, with the same AI and saving routes and the same fencing, also carries the job's **mode** (`explore.mode` in the offer):

- **A schedule's or a deploy trigger's exploration** (a runbook's explore step a pipeline starts) goes to the runner of the person who made
  the schedule or the trigger, as their runs do ([runner-personal.md](runner-personal.md)). While that runner is offline the job waits,
  holding no dispatch place, up to the queue limit, and never goes to anyone else's runner. The refusals are the runs' own
  (`SCHEDULE_HAS_NO_OWNER`, `TRIGGER_HAS_NO_OWNER`, ...).
- **Describe it** (mode `plain`): the runner runs `runPlainAuthoring` with the request the platform resolved (address, environment, sign-in,
  data sets). The test is created and validated through the sink. A rebuild from a changed description names the existing test by a
  handle of the task, never its id.
- **Agent runs** (mode `agent`): the runner runs `pursueObjective` in its own browser. Each step (with its picture), the token count,
  each approval request and the outcome go to the job's own agent run through sink calls (`agentStep`, `agentTokens`, `agentApproval`
  then `approvalState`, `agentOutcome`). The platform takes the run from the job, never a run id from the runner, answers an approval
  only for that run, and decides it itself: a person's answer, the time limit or a stop. An agent run is not picked up again after a
  platform restart (nothing is done twice).
- **An older runner** that does not list the mode in its hello (`exploreModes`) is never offered it. A start is refused with
  "Your runner “…” is too old to …. Update your runner in Settings, Your runner, then try again." (`RUNNER_CANNOT_RUN`), and the page says
  so before the click (`GET /api/me/runner` `can.plain`, `can.agent`).

## A phone app and a security assessment (round 52)

The same explore task carries two more modes. An older runner that does not list them in `exploreModes` is never offered them; a start is
refused with "Your runner “…” is too old to explore a phone app" (or "to run a security assessment"), and the pages say so before the click
(`GET /api/me/runner` `can.phoneExplore`, `can.assessment`).

- **Exploring a phone app** (mode `mobile`): the whole exploration runs on the starter's runner, on the phone or emulator attached to it, the
  AI staying on the platform. The runner's own phone rules apply, as for a phone session: a plugged-in phone only when its owner switched on
  **Use my connected phone** (Settings, Your runner), otherwise an emulator. A runner with no phone, or with neither an emulator nor that switch,
  is refused at the start with its own sentence and the Settings link. The app must already be installed on that phone or emulator: an app
  file uploaded to the platform is not sent to the runner. Screens, the plan and the tests are saved on the platform through the sink.
- **A security assessment** (mode `assessment`): the assessment loop stays on the platform and keeps every rule it has there (the
  authorization checked before it starts and every few seconds while it runs, cancel and the emergency stop, the time limit, one at a time per
  application). Only the steps that touch the application (the browser, the API document's read-only operations, the read-only checks) run on
  the starter's runner (`src/security/assessment/probe.ts`), through the same scope guard: the scope, the excluded paths and sensitive
  workflows, the sign-out refusal, the request rate and the request budget. Private and local addresses follow the runner's **Test private
  and local addresses** switch, never the platform's `SECURITY_ALLOW_PRIVATE_TARGETS`, and a start against one is refused when the switch is
  off. Nothing is requested from the platform. The task has no job (its `job_id` is `sec-<assessment id>`); its progress comes back as log
  lines of the task and is copied into the assessment, so the page shows it live; what it found comes back in the task's result, is checked
  and scrubbed of the saved sign-in's values, and is judged, stored and reported on the platform as before. A platform restart leaves the task
  running and the next loop takes the same task up. A start is refused with the runs' codes when the runner is not set up, offline, too old,
  has no browser, or does not open the private address. The external scanner tools (ZAP, nuclei...) run on the platform's computer, so they
  are left out of an assessment on a runner, and its coverage list says so.

## Who pays for the AI

The same person or organisation as before. The exploration uses the project's AI. With the organisation's own key, that key is
charged. With the AI Crowd4Test provides, Crowd4Test meters it and bills it, with the same budgets and limits. Your runner uses
no AI account of its own, and nothing about AI is set up on your computer.

## What the page says

- **Before you start.** The Explore page and the first card of **Create a test project** read your runner (`GET /api/me/runner`).
  If it is not set up, or is offline, they show the same sentence as a run's refusal ("Set up your runner in Settings to run tests.",
  "Your runner is offline. Start it on your computer, then try again.") and the link **Open Your runner in Settings**, and
  **Start exploring** stays off. A runner too old to explore says to update it (`can.explore`). With your runner online the page
  says "Explores on your runner, Office laptop."
- **While it explores.** The progress card says "Exploring on Office laptop." (the job's `ranOn`).
- **A refusal after the click** shows the server's sentence with the same link.

## When something goes wrong

- **Your runner goes away** (closed, asleep, off the network): the exploration ends with "Your runner stopped answering while it
  explored, so the exploration ended. Its browser went with it, so the work is not moved to another computer. Start the
  exploration again." It is never moved to another computer. Tests already saved are kept.
- **Stop exploring** on the page stops the child process on your runner. Tests already created are kept.
- **The platform restarts** (a deploy) while you explore: the exploration carries on on your runner. The platform hands the job over
  ("The platform is restarting...") and the next platform process takes it up from the same runner task ("Picked up again"). Nothing is
  explored twice. While the platform is away, the runner sends its AI calls and saves again for up to about two and a half minutes. Each
  save is numbered, and the platform applies each number once (explore_task_state, migration 58, keeps what it needs between processes:
  the tests it made, the last save and its answers, the provider names). An agent run is not taken up again: its runner task is stopped.
- **Fencing.** Every call from the runner carries the task and its attempt. A call for a task that is not running on that runner's
  current attempt is refused (409). A runner that was replaced or lost cannot write into a job or spend AI.
- **An older runner** that does not know explore tasks is never offered one. The page asks you to update it instead.

## Not on a runner yet

Recordings "on the server" stay refused in runners mode, with a sentence (record on your runner instead).

## Known gaps

- **A phone app's file** uploaded to the platform does not go to the runner: install the app on the runner's phone or emulator first. A
  runner that would fetch its own phone tools does so only for a phone session, not for an exploration.
- **A phone sign-in that needs a person** (a one-time code, a captcha) does not pause the exploration on a runner: it stops there.
- **A cancelled security assessment on a runner** keeps nothing it saw before the cancel (the runner's findings arrive only with its result).
- **External security scanners** do not run on a runner (see above).

- **A crash** (the platform killed, not stopped) still ends the exploration: only a graceful stop hands it over.
- **A platform away for longer than about two and a half minutes** ends the exploration on the runner. Start it again.
- **Images counted on usage rows.** A look at screenshots made on a runner is labelled vision, but its image count is 0 (the tokens are right).

## Where it is proven

- `tests/explore-frames-on-runner.test.ts` (Watch live: no picture kept while nobody watches, a watched picture reaches the page with
  `onRunner`, fencing, the size and JPEG checks, an older runner's sentence, and the real runner sending pictures of its browser while the test
  watches) and `tests/remote-frames-unit.test.ts` (the runner takes no picture until it is told someone watches).
- `tests/explore-restart.test.ts`: a graceful restart while a runner explores. The job is handed over with its task left running. The next
  platform process answers a repeated save as before, takes the next one, and finishes the job from the same task, every test made once.
- `tests/explore-sink.test.ts` (chunked uploads, numbered saves, the state read back after a hand-over, sending again while the platform is
  away) and `tests/explore-llm-unit.test.ts` (purposes, the runner's escalation told and counted once, a closed request stopping the provider
  call, provider names after a hand-over).
- `tests/explore-on-runner-ui.test.ts`: the page states in a real browser (not set up, offline, too old, online and named, a refusal
  after the click, "Exploring on" while it runs).
- `tests/jobs-on-runner.test.ts` (round 52): a schedule's and a deploy trigger's exploration go to the creator's runner and wait while it
  is offline; an older runner is never offered a described test or an agent run; an agent run's approvals are decided on the platform; the
  real runner builds a described test (and rebuilds it as the same test) and does an agent run, and the server opened no browser.
- The server and runner parts have their own tests (`tests/explore-*.test.ts`). An end-to-end test runs an in-process platform in
  runners mode with the real runner, a scripted model double and a small local site.
- `tests/assessment-on-runner.test.ts` (round 52): the start refusals (no runner, offline, too old, a private address the runner does not
  open, the server's key, no authorization), the offer (the starter's runner only, never another person's or a downgraded one), the platform
  requesting nothing while it waits, a cancel stopping the task; then the real runner runs a whole assessment of the local fixture: its
  problems found and stored, live progress, nothing outside the scope or under an excluded path, only reads, no browser on the server.
- `tests/phone-explore-on-runner.test.ts` (round 52): a runner too old for it and a runner with no phone are refused at the start, and the
  real runner explores the mock app on a fake phone (tests/fixtures/fake-adb.mjs) reached as a real one is (an SDK folder), the screens and the
  plan saved on the platform.
- On real computers: `scripts/smoke-runner.mjs` in `.github/workflows/runner-matrix.yml` explores the sample app on each system's
  runner with a scripted model on the platform. It checks that tests were made and that the server opened no browser.
