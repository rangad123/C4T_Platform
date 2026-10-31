# Device farms and several phones at once

Phone tests no longer need a phone or emulator on the platform's computer. A project can connect a **device farm** (real phones in the cloud) and
run its Android tests there, several at once, and on several phones in one go.

## What a tester does

1. **Setup → Mobile app → Device farm → Connect a device farm.** Pick the provider, give the account's user name and access key (stored encrypted,
   never shown again), and list the phones to run on, one per line: the name as the provider lists it, a comma, the Android version
   (`Google Pixel 8, 14`). **Check connection** makes one read-only call with the account and says whether it worked.
2. **Where phone tests run:** "This computer's phone, or the project's runner" (as before) or "A device farm".
3. **Phone tests at once** (1 to 10): on a farm, each test gets its own phone session and up to that many run together. On this computer it is used
   when that many phones or emulators are connected and ready.
4. **Run on several phones** (a farm with more than one phone): every test runs on each picked phone. The test passes only when it passed on all of
   them; its result says how it went on each ("Google Pixel 8 (Android 14): passed; Samsung Galaxy S23 (Android 13): failed").
5. Run tests as usual. The job says where they ran ("Phone tests run on BrowserStack App Automate ("Team"): Google Pixel 8 (Android 14), 2 at a
   time."). A passing test's note and a failing test's reason carry the provider's link to the session's **video and logs**; a failing test keeps a
   screenshot of the phone. **Recent farm sessions** lists the last sessions with their links.

## Providers

| Provider | How the app gets there | Session page |
|---|---|---|
| BrowserStack App Automate | the project's .apk is uploaded once per run | yes |
| Sauce Labs (data centre us-west-1, eu-central-1 or us-east-4) | uploaded to Sauce Labs storage once per run | yes |
| LambdaTest | uploaded once per run | yes |
| Any Appium server (Appium 2 + UiAutomator2) | must already be installed on its phone (the package name is used) | no |

The result of each session is reported back to the provider (BrowserStack, Sauce Labs, LambdaTest), so their dashboards show passed or failed too.

## How it works

- **Engine** (`src/engine/mobile/cloud/`): `providers.ts` (each provider as data: fixed addresses, upload request, capabilities in its dialect, result
  report, session link), `webdriver.ts` (a small W3C WebDriver client over `fetch`), `script-reader.ts`, `farm-runner.ts`, `farm-session.ts`,
  `farm-executor.ts`, `local-parallel.ts`.
- **Which client runs the tests.** Taqwright 1.1 can target BrowserStack and LambdaTest only, through fixed addresses of its own, has no Sauce Labs,
  and its "real phone" mode needs adb on the same computer. So farm runs do **not** start Taqwright: `script-reader.ts` reads the rendered Taqwright
  script back into its steps (a closed grammar: only the lines the platform's generator writes; anything else is refused in words, never evaluated)
  and `farm-runner.ts` performs them through the WebDriver client with Taqwright's own locator rules (text → `//*[@text=…]`, label → accessibility
  id, test id → resource id, placeholder → `@hint`, role → class name plus name). Every test starts from the app's first screen (stop, then open,
  as the script's `beforeEach`), waits up to 15 s for elements, and fails with a plain reason ("Element not found: the text “Summer sale” (waited 15 s)").
- **Where it hooks in.** `platform/device-farm-run.ts` lays the project's choice over the job's script executor (before the framework settings, so
  the per-test time limit still applies): Android batches go to the farm, everything else to the executor it always went to. `resolveMobile`
  accepts a project on a farm without Android tools here (`EngineContext.deviceFarm`); the single-test run route and the schedules' "can this run"
  check do the same (`farmChosen`).
- **AI exploration on a farm** works too: `farm-session.ts` implements the device session contract (`device/types.ts`) over Appium (the screen from
  the page source, read by the same parser as `uiautomator dump`; taps and swipes as W3C pointer actions at the centre of the element the AI named;
  typing into the focused field). It reuses the local session's checks (`parseAction`, `planAction`, stale-element refusal, password placeholder,
  covered password fields in the picture). The explorer uses the farm's first picked phone.
- **Several local phones**: with "Phone tests at once" above 1 and more than one phone ready (`adb devices`), the local runner shares the tests out
  and runs one Taqwright process per phone, each with its own Appium port and UiAutomator2 system port (`MOBILE_SYSTEM_PORT`).
- **Storage** (`platform/device-farm-store.ts`, migration slot 28): connections (`device_farms`, credentials in `secrets_enc` via SecretBox), the
  project's choice (`device_farm_choice`) and the last 500 farm sessions per project with their links (`device_farm_sessions`).
- **API** (`routes/device-farms.ts`): `GET/POST /api/projects/:id/device-farms`, `PUT/DELETE …/device-farms/:farmId`, `POST …/:farmId/check`,
  `PUT /api/projects/:id/device-farm-choice` `{ runOn: "device"|"farm", farmId, parallel, matrix }`, `GET …/device-farms/sessions?testId=&jobId=`.

## Safety

- Credentials are write-only (the API only says `credentialsSet`), encrypted at rest, sent only in the `Authorization` header and only to the
  provider's own fixed addresses (a person never types an address for BrowserStack, Sauce Labs or LambdaTest). For "Any Appium server" the address
  passes the outbound guard, may not contain credentials, and credentials are only sent over https (or to this computer). Links are built from the
  session id only. Messages from a provider have the account's secrets removed before they reach a result.
- The project's test account is typed on the farm's phone when a step uses `{{credentials.*}}`: the password then exists on the provider's side
  (BrowserStack, Sauce Labs and LambdaTest can show typed text in their command logs). **Use a test account, not a real one.**
- Caps: 5 connections per project, 10 phones per connection, 10 at once, 200 steps per test, 8 MB per farm answer, 5 minutes to get a phone,
  1 minute per command, the project's per-test time limit (180 s by default).

## What is not covered

- **Never run against a real farm here.** Everything is tested against a local fake WebDriver server and fake provider endpoints
  (`tests/fixtures/fake-appium.ts`). Real provider behaviour (exact capability names they accept today, upload limits, how fast a phone is free,
  the session page addresses for LambdaTest) is unverified; the addresses and shapes come from the providers' public documentation as of 2026.
- Tests that do not run on a farm, each with a plain reason: code tests (hand-written scripts), tests driven by a data set, tests that type a
  one-time sign-in code, phone checks (start-up time, accessibility: they need adb), CSS locators, keys outside a small list (Enter, Tab,
  Backspace, Escape, Space, arrows, Delete, Home, Back).
- Farm runs have no Taqwright trace or video file of their own: the video is on the provider's session page.
- iOS on a farm is not built (Android only).
- A project whose tests run on a runner: phone tests still go from the platform to the farm, but a job made only of phone tests can be refused by
  the runner check if the chosen runner has no Android tools.
- Several local phones: Taqwright is started with the emulator device provider pinned to each serial; it has only been exercised with the
  Taqwright stand-in, never with real phones.

## What the owner must provide

An account with BrowserStack App Automate, Sauce Labs or LambdaTest (user name and access key), the app's .apk uploaded under Mobile app, and the
names of the phones to use as the provider lists them. For "Any Appium server": an Appium 2 server with the UiAutomator2 driver, a phone attached,
the app installed on it, and an https address if it needs a password.

## Tests

`tests/device-farm-unit.test.ts` (fast tier: script reading and refusals, providers, page-source conversion, sharing out, the store) and
`tests/device-farm.test.ts` (fake farm: each provider, parallel, several phones, failures that are never passes, the farm device session, the platform
end to end with no secret anywhere). `tests/secret-leak.test.ts` has a sentinel for the farm access key.
