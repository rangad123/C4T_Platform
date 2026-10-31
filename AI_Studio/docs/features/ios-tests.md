# iOS tests

A fourth kind of mobile test: tests for **iOS apps on a simulator**, run by Taqwright and Appium (XCUITest) on a **runner agent that is a Mac with Xcode**. The framework is `taqwright-ios` ("Taqwright iOS (Appium, TypeScript)"); the test kind is still `mobile`.

## Read this first: what was and was not verified

This was built on a Windows laptop. **No iOS simulator, Xcode, Appium or Mac was available, so no iOS test has ever run for real in this build.** Everything below is covered by tests that use fakes:

| Part | How it is tested |
|---|---|
| Choosing a simulator, the Taqwright config, the capability rule, render rules, settings | Pure unit tests (`tests/ios-unit.test.ts`). |
| Booting, waiting for and shutting down a simulator | Against a fake `xcrun` (an in-memory fake in the unit tests; a small script, `tests/fixtures/fake-xcrun.mjs`, in the integration test). The real `xcrun simctl` argument lists (`list devices -j`, `boot <udid>`, `bootstatus <udid>`, `shutdown <udid>`) are written from Apple's documented command line and **not checked against a real Xcode**. |
| Running scripts and reading the result | The stand-in Taqwright CLI used by the Android tests (`tests/fixtures/fake-taqwright.mjs`). The real Taqwright iOS session (WebDriverAgent, the XCUITest driver) is **not exercised**. |
| Routing a task to a capable agent, early refusals, results becoming verdicts | Real platform and real agent program (`tests/ios.test.ts`), with a capability probe that claims to be a Mac. |

Do not read a green test run as "iOS works". Treat the first real run on a Mac as the real verification, and expect to fix details (the exact output of `simctl`, WebDriverAgent signing, first-boot time).

## What it does for you

You describe an iOS test like any mobile test (steps such as click, fill, assert visible text). The platform renders a script with the **same Taqwright generator Android tests use** (same `getByText`, `getByLabel`, `getByRole` vocabulary), sends it to a Mac agent, which starts a simulator, runs it and reports the result. The result is the test's verdict, with history and a screenshot when it fails, like any other test.

An iOS test with no capable agent is **never run and never failed**: it stays "Not validated" with a plain reason, exactly like an Android test without a toolchain.

## The spec and the app

A mobile spec with `"platform": "ios"` is an iOS test. Without `platform` (or with `"android"`), it is an Android test, exactly as before.

```json
{
  "title": "Settings shows General",
  "kind": "mobile",
  "platform": "ios",
  "steps": [
    { "action": "click", "locator": { "by": "text", "value": "General" } },
    { "action": "assert", "check": "visible", "locator": { "by": "text", "value": "About" } }
  ]
}
```

The app is a project setting, next to the Android one: **Mobile app, iOS app id** in the project (or `PUT /api/projects/:id/mobile-app` with `iosBundleId` and optionally `simulator`; `POST /api/projects/:id/specs` also takes `mobile: { iosBundleId }`). It is the bundle id of an app **already installed on the simulator**, such as `com.apple.Preferences`. A project that only tests iOS carries the pseudo address `ios-app://<bundle id>` (never fetched).

### What iOS does differently (checked at import and at render time, in plain words)

- `press` with a keyboard key: iOS understands Enter, Tab, Backspace, the arrow keys and Escape. Any other key is refused ("Step 2: iOS can't press the key "Space"...").
- `device:back`: iOS has no back button. Taqwright performs a swipe from the left edge, which works in apps with standard navigation and does nothing in others. The script text is the same as Android's.
- `device:home`, `device:scroll:<direction>`, `device:swipe:<direction>` and `device:scroll-into-view` work as on Android. Hover has no mobile equivalent (a comment, as for Android). Page-only checks (url, title, accessibility audit, health checks and so on) are skipped as for Android.
- `platform` on a web, API or desktop test is refused ("Only mobile tests have a platform.").

Android scripts are byte-identical to before (a test compares a stored hash).

## Where it runs

**Only on a runner agent that reports macOS, Xcode, at least one iOS simulator and the Appium XCUITest driver.** The platform server never runs iOS tests, even when the server itself is a Mac: that path was left out on purpose to keep the rules in one place. Setting up the Mac: `docs/features/runner-agent-setup.md`, "Mac with Xcode".

Refusals (HTTP 409, before any job exists; never a failing test):

| Situation | Message |
|---|---|
| The project runs tests on the server, or no agent is connected | iOS tests need a runner agent on a Mac with Xcode. Connect one and choose it for this project. |
| An agent is connected but cannot | iOS tests need a runner agent on a Mac with Xcode. The connected runner agent "X" can't run them: it is not a Mac / Xcode is not installed on it / it has no iOS simulator / the Appium XCUITest driver is not installed on it. |
| The project has no iOS app set up | 422 "This project has no iOS app set up. Add the app's bundle id first." |
| iOS is switched off for the project | iOS tests are turned off for this project. Turn them on under Runners, Frameworks. |

A task is offered only to an agent that passes the same rule, so a Windows or Linux agent, a Mac without Xcode, and an agent built before iOS support are never offered one. Scheduled runs, deploy triggers and runbooks leave iOS tests out when no capable agent exists.

## What the agent does on the Mac

1. Checks again that it can run iOS (the platform's answer is not trusted blindly).
2. Asks `xcrun simctl list devices -j` for the iOS simulators and picks one by pure rules: the project's simulator name if the app or the Frameworks settings name one, a **running** one first, then the newest iOS, iPhone before iPad.
3. If it is running, uses it as it is and leaves it running. If it is shut down, boots it (`simctl boot <udid>`), waits (`simctl bootstatus <udid>`), runs, then shuts down **that udid only**. If the wait fails or the job is cancelled, it shuts down the simulator it booted. It never uses a name for shutdown, never `shutdown all`, and never touches another simulator or process.
4. Writes a fixed Taqwright config for `Platform.IOS` pinned to that simulator (name, udid, iOS version, bundle id, a free Appium port). Nothing a spec says goes into the config; the Taqwright process gets no credentials and none of the agent's or platform's variables.
5. Runs Taqwright and reads its report with the same code as Android (`parseReport`).

Xcode's tools are started only through `execFile` with argument arrays, never through a shell.

### Problems with the Mac are not verdicts

No Xcode answer, no simulator, a simulator that does not finish starting, or an Appium/XCUITest session that cannot be created (the failure happens before any step ran and the error is about the session) become an error result with a plain sentence and the task is reported as "not run". The job shows the sentence, no run is added to the test's history, and the test shows that sentence as the reason it could not be validated (the platform's usual "Validation interrupted" handling for any runner problem, the same as for web and Android on an agent), not a failing step. A failure inside a step is always a verdict.

## Settings

Under Runners, Frameworks there is an iOS card: switch iOS tests on or off, **default simulator** (a name such as `iPhone 15`; the app's own simulator name wins), **time limit per test** (default 180 s, 30 to 300) and **keep the simulator running** (applies only to a simulator the run booted). The API is the same `framework-settings` resource (`ios.defaultSimulator`, `ios.keepSimulator`, `ios.testTimeoutSeconds`, `enabled["taqwright-ios"]`).

## How it works (files)

- `src/engine/frameworks/ios.ts`: the adapter (`needs: { node, ios }`, runtime `taqwright-ios`); `src/engine/generators/ios.ts`: renders through the Taqwright generator after the iOS checks.
- `src/engine/mobile/ios-spec.ts` (rules), `ios-simulators.ts` (parse and choose, pure), `ios-config.ts` (config text, environment), `ios-runner.ts` (simulator start/stop, run, infrastructure classification), `ios-capability.ts` (the capability rule shared by platform and agent). `runTaqwrightCli` in `validation/mobile-runner.ts` is the Android runner's spawn-and-parse step, now shared.
- Spec: optional `platform` on the canonical spec; `adapterForSpec(spec)` picks the adapter (use it, not `defaultAdapterFor(kind)`, when a spec is at hand).
- Target: `iosBundleId` and `simulator` on the project's mobile target.
- Agent: capabilities `ios.xcuitest` and `ios.iosSimulators`, `taqwright-ios` in the task runner, a simulator lock so tasks use one simulator at a time.
- Platform: `capabilityProblem` (agent-routing), the job gate and `runnerStatus.canRunIos` (agent-services), the remote executor (`TaskOffer.ios`), the scheduler, framework settings.

### Protocol additions (all optional; `PROTOCOL_VERSION` stays 1)

- `Capabilities.ios.xcuitest` (boolean) and `Capabilities.ios.iosSimulators` (count of iOS simulators; `simulators` still lists every platform simctl knows).
- `TaskOffer.ios`: `{ bundleId?, simulator?, defaultSimulator?, keepSimulator? }`. An older agent ignores it and, not reporting `xcuitest`, is never offered an iOS task.

### Test seams (not for production)

`IOS_RUNNER_CLI` replaces the Taqwright entry point (no simulator is touched when only this is set); `IOS_XCRUN_CLI` names a node script that stands in for `xcrun`. The agent passes both through to its task process. `xcrun` itself is started with the short environment list the test process gets (path, home, temp, proxy, `DEVELOPER_DIR`), never the agent's token or other variables of the Mac; the capability probe when the agent starts still runs `xcrun simctl list` with the agent's full environment.

## Limits

- **Not verified on a real Mac** (see the first section).
- The app must already be installed on the simulator. No app file (`.app`, `.ipa`) is uploaded or installed by the platform yet. Real devices (USB iPhones) are not supported, only simulators.
- One simulator at a time per agent. No parallel iOS workers.
- Hand-written (custom) iOS scripts, data-driven rows, visual baselines, "looks right" judging, cross-browser variants and per-environment runs are not offered for iOS tests (as for Android).
- Analysis and AI generation do not explore iOS apps; iOS tests come from spec import, the visual builder or by changing the platform of an imported mobile spec.
- The session-start classification looks for known phrases in the error text; an unknown Appium message may still show up as a failed test. The first failures on real hardware should be read with that in mind.
- The simulator boot wait is 5 minutes; a very slow first boot can exceed it and is reported as a Mac problem.
- Detox is not built (needs an app build and a device).
