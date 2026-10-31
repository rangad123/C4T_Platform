# The platform's own test suite: tiers, release gate, flaky tests

This page is for people who develop the platform. Nothing here changes what a tester sees.

## Tiers

| Command | What runs | How |
|---|---|---|
| `npm run test:fast` | The files listed in `vitest.fast.config.ts` (no browser) | In parallel, about a minute |
| `npm run test:browser` | Every other file that is not a phone file: browsers, platform servers, the agent program, desktop windows | One file at a time |
| `npm run test:phone` | Files that use the fake phone tools (fake adb, emulator, Taqwright, xcrun) or are named `phone-*`, `mobile-*`, `device-*`, `ios*` | One file at a time |
| `npm run test:release` | Everything: the fast tier, then browser and phone | The release gate (below) |
| `npm test` | Everything, one file at a time, plain vitest | No report and no retry |

The tiers are worked out from the files themselves (`scripts/test-tiers.mjs`), so a new test file always lands in a tier. `node scripts/test-tiers.mjs` prints them. To add a browser-free file to the fast tier, add one line to `vitest.fast.config.ts`; `tests/test-run-unit.test.ts` checks that every line names a file that exists and that each file is in exactly one tier.

The runner download on real Windows, macOS and Linux machines (`node scripts/smoke-runner.mjs`, the GitHub workflow `runner-matrix.yml`, and the platform's pages in every browser with `npm run test:ui:browsers`) is described in `real-machine-checks.md`.

`scripts/test-run.mjs` (behind `test:browser`, `test:phone` and `test:release`) starts each vitest run through `scripts/with-lock.mjs browser`, so several people on one machine take turns. Options: `--files a,b` (only these files), `--no-retry`, `--report <dir>`.

## The release gate

```
node scripts/test-run.mjs release
```

1. Runs every file once.
2. Runs each file that had a problem once more, on its own.
3. Decides:
   - a test that fails both times is a **failure**;
   - a test that fails once and passes once (in either order) is **flaky**;
   - an error outside the tests (a `beforeAll` or `afterAll` that times out, an import that fails, one of vitest's "unhandled errors", a run that produced no results, or a non-zero exit with every test green) counts as a problem of that file and goes through the same retry. Nothing is dropped.
4. **Passes only when there is no failure and every flaky test is allowed** in `tests/flaky-allowlist.json`.
5. Writes a report to `.scratch/test-reports/<tier>-<time>.md` (and `.json`): verdict, failures, flaky tests, problems with the allow-list, free memory before and after each run, and **the time of every file, slowest first**. vitest's console output for each run is kept next to it.

Exit codes: 0 passed, 1 a failure or a flaky test that is not allowed, 2 the runner itself could not work.

### The flaky allow-list

`tests/flaky-allowlist.json` has an `allowed` list. Each entry needs `file`, `test` (the full name as the report prints it, or `(file)` for an error outside the tests of that file), a `reason` and an `expires` date (`YYYY-MM-DD`, at most 90 days ahead). An expired or incomplete entry allows nothing and is listed in the report. At most 20 entries are read. It is reviewed like code; it starts empty. An entry never turns a failure into a pass.

## Why the full run got slow, and what was done

Measured from `.scratch/full-suite-11.log` … `full-suite-18.log` (vitest's per-file times):

| Log | Files | Wall time | Note |
|---|---:|---:|---|
| 11 | 134 | 58 min | |
| 14 | 156 | 53 min | |
| 16 | 171 | **120 min** | every file 2 to 3 times slower than in 14 and 17 |
| 17 | 187 | 67 min | |
| 18 | 192 | 75 min | the browser UI files about twice as slow as in 17 |

- **The biggest cause is the machine, not the tests.** In log 16 nearly every file took 2 to 3 times as long as the same file in logs 14 and 17 (for example `locators.test.ts` 66 s to 524 s, `ui-flows.test.ts` 43 s to 248 s), and in log 18 the UI files took about twice as long as in 17 (`ux-explain-ui` 39 s to 83 s, `onboarding-ui` 40 s to 76 s, same tests). Those runs overlapped other work (builders, the shared server and tunnel). With about 8 GB of memory, Chromium and the platform are paged out and everything slows down. A run of about 2.5 hours is this effect. The release report now records free memory for each run, so a slow report can be compared with an earlier one before anyone blames a test.
- **Growth.** The suite went from about 100 to more than 200 files. Starting each file (imports, collection) takes about 1.6 s, about 5 minutes in all (`collect 318 s` in log 18).
- **The slowest files** (log 18): `desktop.test.ts` 339 s, `signed-in-checks` 154 s, `cli` 142 s, `runbook` 113 s, `recorder-ui` 96 s, `variants` 95 s, `healing` 88 s. Fixed sleeps are not a big cost (no file waits more than a few seconds in fixed sleeps).
- **Done:** the desktop injection test (98 s, six one-window runs, each waiting out the 10 s "nothing matched" retry) now runs its six attempts in one run, three windows at a time. Desktop steps act only through UI Automation patterns, never the keyboard, so the windows cannot take each other's input. The checks are the same, one per attempt. Measured: 98 s down to 52 s, on a machine with only 274 MB of memory free.
- **Done:** the fast tier runs in parallel inside the release gate, where `npm test` ran those files one at a time.
- **Done:** `scripts/with-lock.mjs` refreshes its lock every minute. Before, a lock older than 20 minutes counted as abandoned, so a second runner could delete a live lock during a long run, and two browser runs then overlapped (more memory pressure, more time-outs). The lock can also be taken again from inside itself (`AITP_LOCK_HELD`), which the tier runner relies on.

Not done (would need changes to many test files that other people are working on): one shared browser per file in all UI files, and fewer platform start-ups per file. The per-file table in each release report shows where to look next.

## The two known flaky tests

**`tests/recorder.test.ts`, "a start address the guard refuses …; a move to a refused address stops the session"** (failed in logs 10, 16 and 17 with "timed out waiting for status stopped").
Cause: a product race, not the test. The recorder shows a session as recording *before* its first page has loaded. The test (like a person who clicks at once, or a start page that redirects itself by script) moved to another address while that first load was still going. Chromium then aborts the first load (`net::ERR_ABORTED`), and the recorder took that as "Could not open the start page" and ended the session as **failed**. The move to the refused address never got to stop it. A standalone repro (`.scratch/qa/repro-recorder-race.ts`) failed 6 times out of 6 before the fix and passed 5 times out of 5 after it.
Fix (`src/engine/recorder/session.ts`): when the first load is aborted because another main-frame navigation has started, the recording is not failed. That navigation is judged on its own (by the address guard). Chromium reports the abort just *before* the new request, so the recorder waits up to 1 s for that request. Other start failures (refused connection, time-out) still fail the recording at once. New test: "moving on while the start page still loads is not a failed recording …" (it forces the race with a 3 s start page, `/slow` in `tests/fixtures/recorder-app.ts`). When this kind of wait times out, the message now gives the status the session really ended in.

**`tests/live-session-agent.test.ts`, setup time-out** (logs 14 and 17: "Hook timed out in 30000ms" for the file, with all its tests passing; the file took about 44 s where it normally takes about 14 s, so the extra 30 s is exactly the teardown limit).
It is the `afterAll` (the only hook without its own limit). On a quiet machine it takes about 30 ms in total (measured for each step: agent stop, worker, server, fixture application). The step that can take long is the agent stop. `Agent.stop()` waited for any capability probe still running, and the agent probes again every 30 s while it polls. On Windows the probe starts PowerShell to check UI Automation: 2.1 s measured on a quiet machine, up to its 20 s limit on a loaded one. After that the agent waits up to 20 s more for its tasks to drain. Together these pass the 30 s hook limit. A repro with an 8 s probe: `run()` returned **7.7 s** after `stop()` before the fix and **1 ms** after it (`.scratch/qa/repro-agent-stop.ts`).
Fix (`src/agent/agent.ts`): the agent waits for a probe only until it is stopped (`probeUnlessStopped`, used in `connect()` and in the poll loop). The probe's own commands still end by their own time limits. This was also a real product problem: pressing Ctrl+C on a runner could hang for up to 20 s. Regression test: `tests/agent-stop-unit.test.ts` (fast tier).

## Limits

- The per-file time is vitest's own (test run, without importing the file). The wall time of each run is in the report too.
- A retry re-runs the whole file, not one test.
- The gate cannot tell slowness caused by the machine from slowness caused by a test. The free-memory numbers are the hint.
