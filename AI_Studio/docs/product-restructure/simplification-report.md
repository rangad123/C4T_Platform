# Simplification report: the runner and everything around it

Date: 2026-11-12. This follows `simplification-audit.md` (same folder): every finding there was done, deliberately kept, or deferred with a reason, as listed below. Code: about 1,330 lines removed and 1,020 added in `src` and `web/src` (most additions are tests and the one shared readiness check); 9 files deleted.

## The model it keeps

One runner per person, set up once in **Settings, Your runner**, used automatically for everything that person starts. No runner picker. Schedules and deploy triggers use their creator's runner. The platform never runs tests itself in `runners` mode (production).

## Major UI simplifications

- **Recording:** the "this server or a runner" choice and the runner drop-down are gone, and so is the wrong sentence about a window opening "on the computer that runs this platform". In production a recording always uses the person's runner; when it cannot, one line says why with a link to Settings. The "Show the browser window" option is gone: a recording always opens its window.
- **Phone exploration:** switched off at the button in production, with the reason, instead of a full dialog that ends in "unavailable". It no longer changes a project-wide setting behind the person's back.
- **Phones:** one place decides whether a real phone is used (the runner's "use my connected phone" switch). Production shows "Phones on your runner" instead of empty panels about the platform's computer.
- **Run menu:** a blocked run shows one message, not three. "Where" became "Against" (project address or an environment) and appears only when there is a choice. The runner is named once: "Runs 2 tests on your runner, Office laptop."
- **A run's page:** its facts (runner, when, how long, results) appear once, in "About this run"; the live panel keeps the steps, the current step, what failed, screenshots and the log, which folds once the run ends.
- **Progress:** four plain steps (waiting for your runner, getting ready, running, done) instead of seven protocol states; the explaining sentence only appears for bad endings.
- **Settings, Your runner:** one "Download for {this computer}" button ("For another computer?" shows the system and processor choice); the unsigned-program warning moved into a "Still blocked?" disclosure; the runner card shows status, name and when it was last heard from, with the technical facts and the computer check under one "Details" disclosure; one-sentence switch hints; the admin list of everyone's runners is its own section.
- **Fewer repeats:** "On {runner}" badges and the "runs on" line appear only when something is wrong; the Dashboard's runner card only when the runner is not set up or offline; the project's "next steps" no longer repeat "set up your runner".
- **Schedules:** each schedule says "Runs on {name}'s runner"; "Explore again" is not offered in production, where it could never run.

## Components consolidated or removed

- One readiness check (`useReadiness`) and one "not ready" message (`RunnerNotReady`) for every Run, suite, recording and phone start, built on the server's own refusal sentences (`can` on `GET /api/me/runner`).
- One shared runner state: one request per page instead of one per component, refreshed on window focus and after a refused start.
- The runner UI lives in one folder (`features/runners`); `features/agents/agents.ts` is gone and every runner shape comes from `/me/runner`.
- Deleted: the Record picker, the phone "where" radios, the platform-computer phone panels in production, the duplicate run facts, the extra progress states, dead help entries and helpers, the "mobile tooling" panel in production, and the leftover runner-page code.

## Features and options removed or hidden

- Removed: the Record "where" choice; "Show the browser window"; "Explore again" schedules in production (refused when made); the per-runner "update automatically" setting (updates are always offered; the runner's own `AITP_UPDATES=0` stays the opt-out).
- Hidden behind a disclosure: the system and processor choice, the "still blocked" download help, the runner's technical details and the computer check.

## Backend complexity removed

- **One wait rule:** a schedule or deploy trigger whose creator's computer is off now waits for it (up to 30 minutes, the queue limit) instead of failing after 90 seconds, and while it waits it takes no dispatch place, so it never delays anyone else's run. A run that was already on a runner before a restart is never failed by this rule. Person-started runs keep the short wait (they are refused up front when the runner is offline anyway). One sentence for every "no runner took it" ending.
- **One host check** (`ownHostFor`) instead of two fleet-era pickers for recordings and phone sessions; one `ownRunner(owner, project)` instead of lists of at most one, a wrapper type and a cache.
- **Team-runner leftovers removed:** the repeated "is this a personal runner" checks after sign-in (the single refusal in `authenticate` stays), team writes when a project moves or is deleted.
- **Copy:** "runner" everywhere; the code-scripts refusal points at the Settings switch instead of a start option.
- **Device farms:** a project's device farm runs its Android tests without needing Android tools on the person's computer (the website's readiness check agrees).
- **Docs:** `RUNNER_ARCHITECTURE.md` and the model section of `SECURITY_DESIGN.md` rewritten for one runner per person; plan, audit and progress history moved to `docs/runner-implementation/archive/`.

## Deliberately retained

- **Security:** the runner switches (code scripts, private addresses, connected phone) and the code-scripts notice; one-time codes with expiry; machine binding and credential rotation; the confirmation on "Remove this computer"; `authenticate` refusing team credentials (401) and old team codes (410) (round 49: no such credential or code exists any more after the runner reset); the owner checks, including the Crowd4Test check before schedule and trigger runs; the private-address checks on platform and runner; the guard that stops the platform running tests in production.
- **Reliability:** signed updates with rollback and every update state; the sweep (accept timeout, one re-offer, lost runner); device reservations; the hand-over on restart; the result outbox; the live run view rebuilt from stored events.
- **Compatibility:** the runner protocol (versions 1 and 2), hello's fields, `--token`, `runner.token` and `--allow-custom-scripts` (accepted; the Settings switch decides); `GET /api/projects/:id/runner` (local mode) and `GET /api/projects/:id/agents` (kept for tests, no longer read by the website); the Windows and macOS installers.

## Done in round 49 (were deferred)

The owner decided on 2026-11-12 to remove every existing runner: everyone downloads the new runner from Settings, Your runner.

- **The runner reset (migration 57):** every runner credential, computer, enrollment code, device reservation and per-runner update setting is deleted, and `runner_access` is dropped. A task claimed by or running on a removed runner (and a recording or phone session queued for one) ends as failed with "The runner this run was on was removed in an update. Download the new runner in Settings, Your runner, then start the run again.", also as an event of its run; a queued task nobody claimed waits for its owner's new runner (30-minute rule). A run without a "where it ran" snapshot gets one first, so history still names the runner. An installed old runner gets 404 with "This runner's token is no longer valid: the runner was removed or replaced. Download the new runner in Settings, Your runner, and use that one instead." and stops (exit code 3), as every runner program has since the first release.
- **BE-6:** migration 57 rebuilds `agent_tokens` (no `kind`, project, organisation or revoked state; `owner_id` unique), `agents` (no project), `runner_enrollments`, `runner_settings` (only `run_on`) and `runner_update_settings` (no `auto`). The late-filled-slot repair now runs before the slots still to run and tells slot 42 by `device_reservations`; the column patch for slot 51 is gone. `pg/baseline.sql` is at version 57.
- **BE-4:** one credential per person by construction. `runnerOf`, `setTokenSwitches`, `sessionHosts` read one row; "Remove this computer" deletes it (`retire`); a new enrolment replaces the old one in the same transaction.
- **BE-10:** the download information answers only what Settings reads; the folder name is one constant (`runner-my-computer-...`), no project name or slug through the builders.
- **BE-11:** the deploy builds complete downloads for Mac and Linux only; a Windows download never carries one (its fallback is the plain files).
- **BE-14:** the owner attribution of old schedules and trigger tokens ran once, in migration 57; the start-up calls and the methods are gone.

## Tests executed

Node 24.22.3 (the version CI uses):
- Type checks (server and web): clean. Web build and runner build: succeed.
- Fast tier (all 170 browser-free files, which CI now runs): 3,763 passed, none failed.
- CI's lists: access 489 passed, runner 461 passed.
- Runner and website files run one at a time: `runner-personal` 17, `runner-owner-unit` 11, `device-farm` 6, `device-farm-unit` 11, `custom-agent` 13, `schedules` 30, `triggers` 12, `runbook` 27, `record-agent` 12, `device-agent` 7, `runner-update` 2 (1 skipped, Windows), `runner-settings-ui` 24, `run-on-runner-ui` 22, `run-live-ui` 6, `runner-journey-ui` 11 (real platform, real runner), `recorder-ui` 37, `recorder-agent-ui` 15, `phone-ai-ui` 35, `phone-device-ui` 7, `onboarding-ui` 21, `dashboard-ui` 9, `ux-nav-ui` 75, `runs-ui` 22, `ui-flows` 13, `guide-ui` 45, `code-ui` 26, `security-ui` 25, `manual-ui` 15, `schedules-ui` 6: all passed.
- `runner-kit` 11 passed, 1 failed: "a computer without Node.js": this computer has an older Node.js in `/usr/bin` that the start script finds (machine-specific; not in CI).
- `custom.test.ts` has one failure that also fails on the previous release, unchanged by this work.
- The Windows and macOS real-machine check (`runner-matrix.yml`) runs before release.

## Remaining complexity that is genuinely necessary

- The runner protocol's two versions and its attempts, phases and hand-over: they are what keeps runs alive across platform restarts and dropped connections.
- Signed updates with rollback: the only safe way to change code on people's computers.
- The owner and Crowd4Test checks on every claim: they stop a removed person's computer receiving runs and secrets.

## Still needs attention

- The update-signing key does not exist yet, so runners cannot update themselves; people re-download from Settings until it does.
- Someone who keeps an active Crowd4Test account but loses only the "run tests" permission is stopped at their next visit, not at their next scheduled run (the Crowd4Test people service does not report permissions).
- A schedule run that fails because its creator's computer stayed off does not update the schedule's "last outcome".
