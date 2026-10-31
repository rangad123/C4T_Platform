# Phone quality checks: crashes, freezes, start-up time, accessibility

The most valuable findings on a phone are the ones the app itself gives away: it crashes, it stops responding, it takes too long to open, or a screen
cannot be used with a screen reader or a finger. The platform now looks for all four, during an AI exploration and during every phone test run.
Android only.

## What a tester sees

- **During an exploration** (Explorer view and the job's events): "The app crashed: java.lang.IllegalStateException: … (after: Tapped “Crash now”). The
  app was started again and the exploration goes on.", and "The app took 850 ms to open from a cold start (budget 5 s)".
- **In the plan** (`GET /api/projects/:id/plans/:jobId`, `phone.quality`): the crashes and freezes (exception, the first lines of the stack trace, the
  screen it happened on, the steps that led to it, how many times), the cold start time against the budget, the accessibility of every screen found
  (problems per screen), what was not checked and why, and the check tests creating the plan makes. A crash or a slow start also adds a sentence to the
  plan's warnings. Families with exact counts: **App crashes**, **Start-up time**, and **Phone accessibility** (only when Accessibility is switched on).
- **After creating the plan**: each finding is a test that **needs a look** (stored with the facts the phone reported), for example
  "The app does not crash on “Settings”" (it repeats the steps the AI took, then waits 2 s), "The app opens within 5 s", "Accessibility of “Home”".
  Running such a test again checks it again on the phone: it stays Needs a look if it happens again and becomes Passing if not.
- **In every phone test run** (this computer or a runner): a crash or freeze of the app during the test fails it with
  "The app crashed: <exception>" or "The app stopped responding: <reason>", with the stack trace, as a finding (Needs a look, high severity). It is
  never a silent pass.

Severity: crash and freeze **high**, slow start **medium**, phone accessibility **medium** when something has no label, else **low**.
The `ai-test` CLI files crashes as `app-crash` (SARIF rule `AppCrash`), a slow start as `performance`, phone accessibility as `accessibility`.

## How it works

- **The phone's own log.** `adb logcat -d -b crash -b system -v epoch -t <mark>` (one fixed command; added to the closed list in `device/adb.ts`). A mark
  is taken before the app starts (exploration) or before the tests (run); only entries after it, and only of the app under test (its package or one of
  its processes `pkg:name`), count. Java/Kotlin crashes (`FATAL EXCEPTION`), native crashes (`Fatal signal`) and freezes (`ANR in <pkg>`) are read.
  At most 512 KB of log text, 25 stack lines of 200 characters, 10 crashes per read. Text is untrusted: control and direction characters are removed,
  the project's password, `password=…`/`token=…`-style values, `Bearer` tokens, long keys and e-mail addresses are replaced before anything is stored.
- **In an exploration** the explorer calls three hooks (`explore/explorer.ts` → `quality/explore.ts`): at the start the cold start is measured and the
  screen density read; every new screen is checked for accessibility from the description the explorer already has; after every action the log is
  read; on a crash the finding is recorded with the screen before it (name and a few visible texts) and the steps since the last start, and the app
  is restarted (`restart`: force-stop and start, the configured package only). At most 5 distinct crashes are kept; the same crash again is counted.
- **Start-up time**: `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER <pkg>` finds the launcher activity, then
  `am start -S -W -n <pkg>/<activity>` stops the app and starts it cold; Android's `TotalTime` is the number. Budget per project
  (`PUT /api/projects/:id/mobile-app` with `startupBudgetMs`, 500 to 60000; `null` resets) and 5 s by default. In a test run it is measured once,
  before the tests, when a start-up check test is among them; the project's budget wins over the one written into the test.
- **Accessibility** (`quality/a11y.ts`), from the UI Automator description: something touchable with no text, no content description and no text inside
  it (medium); an image button with no content description (medium); a touch target under 48 × 48 dp, unless it sits inside a larger touchable row or
  is cut by the screen's or a list's edge (low); several touchable things with the same label (low). Sizes use the density from
  `getprop ro.sf.lcd_density`; without it they are estimated (the screen taken as 400 dp wide) and the finding says so.
- **Check tests** carry a tag (`phone-crash`, `phone-check-startup` with `startup-budget:<ms>`, `phone-check-a11y`); the Taqwright generator adds one
  marker line for the last two (`// phone-check: start-up budget=5000`, `// phone-check: accessibility`), which the mobile runner reads. Every other
  phone script renders byte for byte as before (tested). An accessibility check test runs on its own, then the runner reads the screen it ended on.
- **Which test a crash belongs to** in a run of several tests: the tests that did not pass; when all passed, the last one, and the finding says it
  could not be told which. Check tests always run alone.

Code: `src/engine/mobile/quality/` (`logcat.ts`, `startup.ts`, `a11y.ts`, `findings.ts` (prefixes, severity, markers), `monitor.ts`, `explore.ts`,
`create.ts`, `run-checks.ts`). Hooks: `DeviceSession.health` (optional, `device/types.ts`, set by the local session), `ExploreOptions.quality`,
`PhonePlan.quality`, a wrapper around the mobile runner's `execute` (`withPhoneChecks`), `phoneQualityFinding` in `validator.ts`, `phoneQualitySeverity`
in `severity.ts`, the families in `planning/preview.ts`, `phone.quality` in `routes/plans.ts`, `MobileTarget.startupBudgetMs`.

## What is not covered

- **Never run on a real phone or emulator here.** Everything is tested against the fake adb (`tests/fixtures/fake-adb.mjs`: the `crashy` and
  `inaccessible` mock apps and the faults `crash-in-run`, `anr-in-run`, `slow-start`, `no-logcat`) and the Taqwright stand-in. The log formats are
  Android's documented ones, but vendor variations, Android versions without the crash buffer (before 7; then the log is said to be unreadable and
  crashes are not checked) and real `am start -W` timings are unverified.
- **Exploration on a runner**: crash, freeze and start-up checks need the phone on the computer that runs the platform (the runner's device session
  has no such call yet); the plan says so. Accessibility is checked there too. Test runs on a runner are checked (the runner runs the same code).
- **Text size and colour contrast are not checked**: UI Automator does not report text sizes, and contrast cannot be measured reliably from it.
  Password fields are not checked for a label (their hint is never read).
- Whether Taqwright leaves the app on the screen it ended on after a test (needed by the accessibility re-check) is unverified on a real device; if the
  phone does not show the app, the check fails with that reason instead of passing.
- Crash attribution in a run of several tests is by result, not by time (see above).
- Native crash stacks are only the `#NN pc` lines the crash dumper logs within 10 s; no symbolisation. ANRs of other apps, system crashes and
  out-of-memory kills without a log entry are not reported.
- No Setup screen field for the start-up budget yet (API only).
