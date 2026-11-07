# The runner journey test

`tests/runner-journey-ui.test.ts` checks the whole path a person takes to run tests on their own computer, with real programs and a
real browser. `tests/helpers/runner-stack.ts` starts the programs, so other tests can reuse it.

## What it starts

- **The platform** as its own program (`node --import tsx src/main.ts`) on a temporary data folder, on port 8180. In `runners` mode
  (`EXECUTION_MODE=runners`, no embedded worker) the platform hands every run to runners. In `local` mode it uses its embedded
  worker and the project is set to "On a runner".
- **A stand-in application** on port 8181. A page can be held open, so a run can be caught half way, then released.
- **The runner program from source** (`bin/ai-test-agent.mjs`, which loads `src/agent`), started with an enrollment code
  (`--enroll`), a token file (`--token-file`), or the credential it saved earlier. The test stops it and starts it again, like a
  person closing and reopening it.
- **Two people**, both local accounts with the editor role (they may run tests but not manage team runners). Each has a password for
  the browser and a personal API token for API calls.

Each program runs in its own process group and is stopped by its own process id. Both get a short list of environment variables:
a temporary home folder, no keys from the computer running the test, no proxy, no database address, and `TAQWRIGHT_HOME` pointing at
a folder that does not exist. No AI model is called. Nothing leaves the computer.

## The journey

1. In `runners` mode, the platform says so in `/api/config` and refuses to run a project's tests itself.
2. The first person adds their computer from the Runners page ("Add this computer", the command with the one-time code). The runner
   trades the code for its credential and shows as online.
3. The person lets that computer test local addresses (the stand-in application is on `127.0.0.1`). A personal runner refuses
   them by default.
4. From the Test scripts page they run the project's two tests on their computer. The first test waits half way. The run page shows
   the run going on that computer.
5. Live events from the runner arrive while the test is still going.
6. They refresh the page half way and still see the run.
7. They see the results: one passed, one failed with its error, and the screenshot taken when it failed.
8. The runner program stops. The Runners page shows it offline (nothing heard for 45 seconds). It starts again with the credential
   it saved and shows online again.
9. A second run works.
10. A second person in the same project cannot see the first person's computer, cannot pick it for a run (404), and has no runner
    to run on (409).
11. Neither the enrollment code nor any runner credential shows up in either program's output. The code is not left in the runner's
    folder. A credential there may only be readable by its own user. The runner leaves no files in the repository.

## Pieces that land at different times

The flags at the top of the test say which pieces are there. A step that needs a missing piece is reported as a todo. Where today's
platform has an equivalent, the step runs that instead, so the rest of the journey is still checked:

| Flag | The piece | Without it |
|---|---|---|
| `runnersMode` (on) | runner-only execution | local mode, project set to "On a runner"; step 1 is a todo |
| `enrollment` | enrollment codes, the runner's `--enroll` and its saved credential | a team runner registered with the access key, started with a token file |
| `personal` | personal runners, `runner-choices`, the owner's switches, `runnerId` | steps 3 and 10 are todos |
| `addComputerUi` | "Add this computer" on the Runners page | the code is made through the API |
| `runPanel` | the Run panel's runner choice for one run | today's panel; `runnerId` is not checked |
| `liveEvents` | live events and the task phase | step 5 is a todo |
| `liveView` | the run page's live panel | only today's run page is checked |

Turn a flag on in the file, or set `RUNNER_JOURNEY=all` (or a comma-separated list of flag names) for one run. `RUNNER_JOURNEY=local`
runs the same journey on a platform in local mode.

## Running it

```
npx vite build web
TAQWRIGHT_HOME=/nonexistent-taqwright npx vitest run tests/runner-journey-ui.test.ts
```

It needs `web/dist` and Playwright's Chromium. It takes about three minutes, most of it the 45 seconds before a stopped runner
counts as offline, and the runs themselves.

## Limits

- The runner runs from a checkout on the same computer as the platform. The installers, the background start at sign-in and signed
  updates are not part of this test. They need a real Windows or Mac computer (see the manual verification checklist).
- The credential store is checked only on the platform where the test runs. On Linux that is a file only its user can read. The
  Windows (DPAPI) and macOS (Keychain) stores are not run here.
- Offline is detected after 45 seconds without a heartbeat. The test waits for that.
