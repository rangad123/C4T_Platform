# Phone test runs on the right device

Round 24. What changed for a tester: phone tests run on the phone the AI explored on, open the app the way the phone itself says to open it, and a
problem of the phone is reported as the phone's problem, not as a failing test of the app.

## Which device a run uses

Every phone run (the run right after tests are created, Run, schedules, runners) picks its device in this order:

1. what the project chose under Setup, Mobile app, "Where phone tests run": the phone the AI explored on (the default once an exploration used a
   real phone), a named phone, an emulator, or a device farm (the farm is decided by the job before this);
2. otherwise a connected, ready real phone that has the app installed for its current user;
3. otherwise an emulator: one that is already running, or the project's emulator, which the run starts.

A chosen phone that is not connected falls through to the next rule and the run says so ("The phone chosen for this project, CPH2467 (R58N20ABCDE), is
not connected to this computer, so phone tests run on the emulator Pixel_Test."). An emulator is never started when a ready phone with the app is
chosen or found. The run's activity names the device ("Ran on CPH2467 (R58N20ABCDE), a phone on this computer.") and a passing test run on a real phone
keeps that sentence as its note. Several phones at once (Setup, "Phone tests at once") work as before.

The exploration records the device it used (`exploredOn` in the project's mobile app settings); the tests it writes run there straight away. A runner
receives the project's choice with the task (protocol fields `mobile.runsOn` and `mobile.exploredOn`, optional, version 1) and applies the same rule
on its own computer; a runner with a phone but no emulator can now run phone tests.

A computer with the Android tools but no emulator can run phone tests on a connected phone (before, an emulator was required).

## How the app is opened

Before the tests, the run asks the device which screen opens the app, for the phone's current user (`engine/mobile/device/launcher.ts`):

1. `cmd package resolve-activity --brief --user <current> -c android.intent.category.LAUNCHER <package>`;
2. `dumpsys package <package>`, the MAIN activity with the LAUNCHER category (parser ported from appium-adb, Apache-2.0, with notice);
3. last resort: `monkey -p <package> -c android.intent.category.LAUNCHER 1` and the activity that came to the front.

Every answer is trimmed of `\r` and spaces. The "Open with" chooser (`com.android.internal.app.ResolverActivity`, what a phone with parallel apps
can answer) is never used. An app installed only for another user (OnePlus "MultiApp" 999) is reported plainly before anything starts.

Generated tests no longer call `mobile.launchApp` (Appium's `activateApp`, which resolves the activity itself without the launcher category or a user,
and failed with "Unable to resolve the launchable activity ... No activity found"). They start the resolved component with `mobile: startActivity`
(stop first, wait until drawn, for the resolved user). The session also asks for `appActivity`, `appWaitActivity: "*"`, `forceAppLaunch`, `noReset`,
`waitForIdleTimeout` 100 ms (feeds and videos never go idle; the tests wait for their elements), `disableWindowAnimation` and
`ignoreUnimportantViews: false` (the same tree the exploration read). A real phone is named to Taqwright as a local device, never as an emulator.

Tests written before this keep working without being explored again: generated tests are rendered from their stored steps on every run, and the
run configuration replaces Taqwright's `launchApp` for the app under test with the same explicit start, which covers code tests and downloaded
copies run by the platform. The resolved screen is kept with the project's app (`appActivity`, read-only) after a run on this computer.

## Pre-flight

Before a run on a known device: online and authorized, the screen on (woken once if off) and not locked, the app installed for the current user, its
launcher resolvable, the test helper (UiAutomator2) present (a note when not yet installed, with the Xiaomi switch), and the battery (stop below 10%
without a charger, a note below 20%). A failed pre-flight stops the run before any test starts; every test gets "The phone could not run the test:
<reason>". Read-only except waking the screen.

## Problems of the phone during a run

A test that hit a problem of the phone itself (the UiAutomator2 helper crashed or its instrumentation died, the connection dropped or a socket hung
up, the phone went offline, the test session could not be started) runs once more after the helper is stopped. If it happens again it is reported
as "The phone could not run the test: ... This is a problem of the phone or its connection, not a failing test of the app." It is never sent to
repair. A crash of the app found in the phone's log during the run still wins (it is the app's finding).

## System dialogs during a run

Every generated test watches for system dialogs between its own commands (every 1.5 s):

- a permission question still showing after the test had its chance (its own permission step answers first) is answered "Allow";
- "isn't responding": Wait once; if it comes back, the test fails saying so (the freeze itself is reported from the phone's log, as before);
- a crash dialog is closed and the test fails (the crash is reported from the log, as before);
- another app in front is sent back once by bringing the app under test forward. The home screen is left alone.

## Not covered / limits

- Verified only with the fake adb, recorded phone answers and real Taqwright against a scripted Appium server; the owner's OnePlus has not been used
  by the builder. The integrator verifies on the real phone.
- The permission answer is always "Allow" (there is no project setting for "Don't allow" yet; `MOBILE_PERMISSION_ANSWER=deny` exists in the script).
- The resolved screen is kept with the project only for runs on the platform's own computer; a runner resolves it again on every run.
- Exploration itself still opens the first ready device (or the device the session names); the choice above applies to runs.
- Old runners ignore the device choice fields and start their emulator as before.
