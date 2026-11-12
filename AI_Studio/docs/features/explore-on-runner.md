# Exploring on your runner (round 51)

On a platform that runs tests only on runners (`EXECUTION_MODE=runners`, [runner-only-mode.md](runner-only-mode.md)), the server
never opens a browser. **Explore my app** still works there: the exploration runs on the runner of the person who starts it, the
one runner they set up in **Settings, Your runner** ([runner-settings.md](runner-settings.md)). In local mode nothing changes.

## How it works

- **The browser is on your runner.** The whole exploration (`runGeneration` in `src/engine/orchestrator.ts`) runs on your runner, in a
  child process, using the engine code the runner download already has. Crawling, signing in to your application, the AI's
  authoring agents and each validation run all happen there. Your application is reached from your computer, so an application
  only your network can reach can be explored. Private and local addresses follow your runner's **Test private and local addresses**
  switch, the same rule as runs.
- **The AI stays on the platform.** Each time the engine asks the model something, the runner sends the call to the platform
  (`POST /api/agent/tasks/:id/explore/llm`). The platform runs it on the job's own model, built as it would be for an exploration
  run on the server: the project's AI setting, the routing to the fast model, the usage meter and the AI budgets. Only the answer
  goes back. Tools the AI calls, such as clicking a page, run on the runner.
- **The key never leaves the platform.** The runner never gets the AI provider, the key or the AI configuration. All it knows is
  the model's name, so it can say which model is working.
- **What it makes is saved on the platform.** Tests, scripts, plans, baselines, screenshots and the exploration's memory are sent
  to the platform as they are made (`POST /api/agent/tasks/:id/explore/sink`), in order, and saved into the project as an
  exploration on the server would save them. Files travel as uploads. The live steps on the project page come through the runner's
  live-event channel ([runner-protocol-2.md](runner-protocol-2.md)).
- **Sign-in details** saved on the project's Requirements tab go to the runner with the task. The runner keeps them in memory,
  hides them in its logs and never writes them to disk.

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
- **The platform restarts** while you explore: the exploration ends and says so. Start it again.
- **Fencing.** Every call from the runner carries the task and its attempt. A call for a task that is not running on that runner's
  current attempt is refused (409). A runner that was replaced or lost cannot write into a job or spend AI.
- **An older runner** that does not know explore tasks is never offered one. The page asks you to update it instead.

## Not on a runner yet

These are still refused in runners mode, with a sentence: explorations started by a schedule or a deploy trigger, exploring a
phone app, describing a test in your own words, agent runs and security assessments.

## Where it is proven

- `tests/explore-on-runner-ui.test.ts`: the page states in a real browser (not set up, offline, too old, online and named, a refusal
  after the click, "Exploring on" while it runs).
- The server and runner parts have their own tests (`tests/explore-*.test.ts`). An end-to-end test runs an in-process platform in
  runners mode with the real runner, a scripted model double and a small local site.
- On real computers: `scripts/smoke-runner.mjs` in `.github/workflows/runner-matrix.yml` explores the sample app on each system's
  runner with a scripted model on the platform. It checks that tests were made and that the server opened no browser.
