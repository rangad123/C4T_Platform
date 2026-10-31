# Framework settings (per project)

The platform has four testing frameworks: Playwright for web tests, Playwright for API tests, Taqwright (Appium) for Android and Windows UI Automation for desktop applications. A project chooses *where* its tests run (this server or a runner agent). **Framework settings** choose *how* each framework runs for that project: the few settings that really change a run, validated, applied the same way everywhere a run is built, and carried to runner agents.

Every value starts at what the platform always did. A project that never changes anything gets exactly the scripts, Playwright configuration, agent tasks and API answers it got before this feature (tests prove it).

## What a user sees

On the project's **Runners** tab, a **Frameworks** section with one card per framework: its name, a line in words about where it can run ("Ready on this server", "Ready on Maya's laptop", "Needs Windows", "Needs an Android emulator"), an on/off switch and its fields with units and hints. Below: **Save settings**, **Use defaults** (fills the form with the defaults; nothing changes until Save), and the **last ten changes** (what moved, when, who). While a run is in progress for the project the form is locked. The Tests page gets one quiet line ("API tests are turned off, web tests stop after 120 s. Change") only when something differs from the defaults.

## The settings

| Framework | Setting | Default | Range |
|---|---|---|---|
| all four | on / off | on | |
| Web | browser window: hidden or visible | hidden | visible only on a runner agent |
| Web | parallel browsers (`workers`) | the platform's own `CONCURRENCY` | 1 to 8; a project can only lower the platform's value |
| Web | time limit per test | 60 s | 30 to 300 s |
| API | time limit per test | 60 s | 30 to 300 s |
| Android | keep the emulator running afterwards | off | |
| Android | default emulator | none (today's choice) | a known emulator |
| Android | time limit per test | 180 s | 30 to 300 s |
| Windows desktop | time limit per test | 120 s | 30 to 300 s |
| Windows desktop | time to open the application | 15 s | 5 to 60 s |

Numbers outside the range are moved to the nearest allowed value and the answer says so ("The web test time limit was set to 300 seconds, the most allowed.").

### What is deliberately not a setting

- **Retries.** A retry hides a test that fails now and then. The platform reports flakiness (trends, quarantine) instead of hiding it. `{"web": {"retries": 2}}` is refused as an unknown setting.
- **The Windows application allow-list.** It stays on the computer that runs the tests (`DESKTOP_ALLOWED_APPS` on the platform host, `--allow-app` on an agent). A project must not widen what a computer may start, for security.
- **A visible browser on this server.** A window only opens where a person can watch it: on a runner agent. Asking for it while the project runs on this server is refused with a plain 400. If a project that asked for it is later moved back to this server, runs are headless and the run says why (an event and a note in `effective`).

## What each setting does

- **On / off.** A switched-off framework is not offered: importing a spec of that kind is refused (409 "API tests are turned off for this project. Turn them on under Runners, Frameworks.", all or nothing); starting a run whose tests are all of switched-off frameworks is refused with the same 409 (this is checked in `Repo.createJob`, so it holds for people, schedules, deploy triggers, runbooks, plain-English authoring and variants alike); a run that mixes kinds runs the tests that are on and says in its events which were left out (this is not counted as an error); schedules, triggers and runbooks leave them out; an analysis stops offering the switched-off kinds (`targets`), and is refused if none is left.
- **Time limit.** Playwright: written into the generated `playwright.config.ts` as `timeout`, and the overall limit of the run grows with it. Taqwright: `MOBILE_TEST_TIMEOUT_MS`. Windows: the script's own `test.setTimeout` is replaced for that run only. A check with its own longer limit written into the script (access, input and load checks) keeps it.
- **Parallel browsers.** The smaller of the platform's value for that run and the project's cap. Web and API tests share one Playwright process; when their settings would differ (for example different time limits) they are run as two processes one after the other, otherwise as one, as always.
- **Visible window.** Carried in the task's `env.headless` (which protocol 1 always had), so even an agent from before this feature opens a window.
- **Default emulator / keep emulator.** The project's own app emulator still wins; then the project's default; then the platform's `MOBILE_AVD`, then the first emulator found. The emulator name must be one the project can use (its agents' emulators when it runs on an agent, this server's otherwise). The server's `MOBILE_KEEP_EMULATOR` switch still keeps the emulator whatever the project says.
- **Time to open the application.** Put into the script's target for that run when the spec does not name its own `startTimeoutMs`.

## How it is applied (one place)

`src/engine/frameworks/settings-executor.ts` wraps the executor of a job. Every caller (validation, re-runs, variants, environments, plain-English validation, schedules, triggers, runbooks) already runs scripts through `executor.execute(...)`, either on this machine or through the remote executor that makes a task for a runner agent, so the same values reach every run. `job-runner.ts` installs the wrapper when a job starts, only if the project differs from the defaults; otherwise the executor is the one it always was. When settings differ the job gets one event, "Running with a 120 s test timeout for web tests, at most 1 browser worker." (and notes, such as headed being ignored on this server). Nothing is said when nothing differs.

### Runner agents (protocol 1, additive)

`TaskOffer` gets two optional fields, `testTimeoutMs` and `startTimeoutMs`. They are absent for a project with default settings, so its task is unchanged. An older agent ignores fields it does not know and runs with the usual limits (zod objects drop unknown keys); `PROTOCOL_VERSION` stays 1. The agent program passes them to the same adapter code the platform uses, and its watchdog stretches with the limit. The wire environment `headless` already existed.

## API

All routes need the API key like every other admin route.

- `GET /api/projects/:id/framework-settings` returns `{ settings, effective, adapters, runner, defaults, limits, avds, changes }`. `settings` is what the project stored (defaults when nothing was stored), `effective` is what a run would use after clamping and the place it runs (headed only on an agent, workers never above the platform's) with `notes` in words, `adapters` has `{ id, label, kinds, enabled, available: { platform, agent: boolean|null, reason? } }` per framework (`agent` is null when no agent is connected), `changes` the last ten.
- `PUT /api/projects/:id/framework-settings` with `{ "settings": { ...partial... }, "by": "Maya" }`. It merges field by field, validates types and unknown keys (400 with a plain sentence), clamps (the answer carries `adjusted`), refuses a visible browser while the project runs on this server (400), refuses an unknown emulator (400), and answers **409 while a job of the project is running**. It returns the same shape as GET.

The change log (`framework_settings_log`, migration 21) is append-only: no route changes or removes a line. Settings live in `framework_settings`; both are removed with the project.

## Limits and honesty

- The Windows limits are tested at the adapter level (the script that would run is checked) and in the unit tests, not by starting a real application.
- Two sentences in this feature are about the machine, not the project: the Android `keepEmulator` OR-s with `MOBILE_KEEP_EMULATOR`, and the workers can only be lowered.
- Settings are part of the database, not of the project backup archive (`backup.ts` was not extended).
- A run already queued when the settings change uses the settings as they are when it starts.

## Where the code is

`src/engine/frameworks/settings.ts` (pure: schema, defaults, clamping, merge, effective values, wording), `settings-executor.ts` (the wrapper), `src/engine/desktop/timings.ts`; `src/platform/framework-settings-store.ts` (migration 21, store, change log, job gate), `routes/frameworks.ts`; small additive edits in `validation/runner.ts`, `mobile-runner.ts`, `frameworks/{types,builtin,windows}.ts`, `validate-only.ts`, `environments/run.ts`, `job-runner.ts`, `repo.ts` (`frameworkGate`), `bootstrap.ts`, `scheduler.ts`, `server.ts` (import check), `agent-services.ts`, `agent-protocol/schema.ts`, `src/agent/{task-runner,task-child,child-protocol}.ts`; UI in `web/src/features/frameworks/*`. Tests: `tests/framework-settings-unit.test.ts` (fast), `framework-settings.test.ts`, `framework-settings-agent.test.ts`, `framework-settings-ui.test.ts`.
