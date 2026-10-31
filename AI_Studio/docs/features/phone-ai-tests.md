# AI phone tests: the AI explores an Android app and writes the tests

Until now the AI explored websites. For an Android app, tests had to be imported or converted by hand. This feature does for a phone app what the analysis does for a website: the AI opens the app on a phone or emulator, looks at each screen, taps and types like a careful first-time user, plans test ideas, writes phone tests (the `mobile` spec kind, rendered for Taqwright), runs them on the device and keeps what passes.

The same promises as the web side: you can watch what the AI does, you approve the plan before anything is created, you can stop at any time, passwords are never shown or stored in a test, and nothing destructive is done.

Android only. For iPhone apps, import tests (see `ios-tests.md`).

## What a person does

1. The project has a **Mobile app** (Setup): the app's package name (for example `com.example.shop`), optionally an APK and an emulator name. Exploring needs the package name.
2. Start an exploration: `POST /api/projects/:id/test-generation` with `{ "targets": ["mobile"], "plan": true }`. `plan: true` is how the screens ask for it: the AI explores and plans, then stops. Sign-in details (`credentials`) are optional; without them the AI leaves sign-in screens alone.
3. Watch it: the Explorer view shows a picture of the phone and one plain line about what the AI just did ("Tapped “Sign in”", "Opened Products").
4. Read the plan (`GET /api/projects/:id/plans/:jobId`): the screens found, the test ideas, how many tests of each kind will be created, what was skipped for safety and why.
5. Create the tests (`POST …/plans/:jobId/create`, optionally leaving ideas out with `excludeIdeas`). They are written, run on the phone and kept as Passing, Failing or Needs a look.

`targets` may be `["mobile"]` alone (no website address is needed: the project's Android app is used), or together with `web` and/or `api` for a project that has a website too. With several targets the website and API part runs first, exactly as before, then the phone.

## What the exploration does (the map explorer, R24)

Since round 24 the exploration **maps** the app instead of asking the AI about every tap (`src/engine/mobile/explore/map-explorer.ts`, the graph in `explore/graph.ts`):

- **Knows which screen it is on.** A screen is named by a *structural* fingerprint (`src/engine/mobile/device/uiautomator.ts` `fingerprintOf`): package, activity, class and resource id of what is on it, the static labels of buttons and tabs (numbers become #, so "Notifications, 3 new" equals "Notifications, 5 new"), the selected tab and the heading. What is *inside* a list or feed counts only by its shape, so a feed that was scrolled or refreshed, an ad or a "people you may know" card, is the same screen; typed text and switch states never count. A second fingerprint with the texts is kept as evidence and to tell when a screen has settled. The idea follows DroidBot's `structure_str` (MIT); the rules are ours.
- **Keeps a map with a to-do list per screen.** Screens are the states, actions are the edges, and every screen keeps the safe actions on it not tried yet. The next action is chosen by code, at the phone's speed: main navigation (tabs, bottom navigation) first, then the toolbar and menus, buttons, a form (sent once empty, once filled with harmless data), one scroll of a list, then one to four rows of each list (a feed is never opened row by row). When a screen is used up, the explorer walks the shortest known way to the nearest screen that still has something to try, checks it arrived by the fingerprint, and when going back does not get there it starts the app again and replays the path. An edge that does not lead where it led before (twice) is marked unreliable and never used for a path or a test; a screen that cannot be reached again is given up, with a note.
- **Calls the AI only where it pays:** to say what an unclear form field is for (the value still comes from the table of harmless data), to judge whether sending a filled form would change data when that is not allowed, once per stretch of actions without a new screen (which untried action looks most promising), and once at the end to name the screens. On a plain app the AI is called once. All of it is counted in AI usage and capped per depth.
- **Signs in with the project's test account** through the sign-in helper (`explore/signin.ts`, placeholders only), keeps the session for the rest of the exploration (it never taps sign out or log out, and does not go back to the signed-out screens), and asks a person on the job page for a one-time code or a captcha.
- **A watchdog** answers permission questions as before ("Don't allow" unless the app insists), waits once when the app is not responding and closes it when it stays so, closes a crash dialog and opens the app again, closes the keyboard before tapping, and goes back (then opens the app again) when another app comes to the front. Another app is never explored.
- **Stops when it is done.** The project setting **How thorough** (`depth`, `src/engine/mobile/phone-settings.ts`) sets the limits: Quick about 40 screens, 150 actions, 10 minutes; Standard (default) 150 screens, 600 actions, 30 minutes; Thorough 300 screens, 1,200 actions, 60 minutes (`explore/types.ts` `depthLimits`). It usually stops earlier: when every safe action on every screen was tried ("the app looks fully explored"), or on a plateau ("No new screens after 80 actions: the app looks fully explored"). A limit says how to go further. A runner's session (500 actions at most) ends the exploration before its own cap.
- **Coverage.** The job's events carry `mobile_progress` (screens, activities, actions, AI calls) while it runs, and `mobile_exploration_done` / `mobile_coverage` at the end; the model keeps `coverage` (depth, screens, activities seen, the number of activities the phone lists for the app from `dumpsys package`, actions, AI calls, actions tried and left, why it stopped) and `device` (serial, model, emulator) so the tests run on the same phone.
- **Screens that never settle.** `uiautomator dump` fails with "could not get idle state" on a video or a live feed: the session tries again, then the compressed dump, then the UiAutomator2 server Appium already installed on the phone with `waitForIdleTimeout: 0` (`device/uia2-source.ts`; nothing is installed, the server is stopped when the session closes, and the device lock keeps test runs off the phone meanwhile). Without that server such a screen is reported in plain words.

The earlier explorer, where the AI chooses every action (below), is still there: set `PHONE_EXPLORER=ai` on the server. It uses many more AI calls and the old limits.

### The AI-led explorer (`PHONE_EXPLORER=ai`)

- **Explores like a careful user.** One action at a time, chosen by the AI model from a compact description of the current screen: numbered elements (`[12] Button "Sign in" id=login_button`), what changed since the last action, the screens already visited, the path taken and the budget left. It prefers screens it has not seen, goes back from dead ends, scrolls lists, tries tabs and menus, tries a form empty once and then filled in, and fills forms only with harmless made-up data.
- **Signs in with placeholders.** On a sign-in screen, with sign-in details given, the AI types `{{credentials.username}}` and `{{credentials.password}}`; the real values are typed by the session on the computer that owns the phone and never come back. Whatever text the AI proposes for a sign-in field is replaced by the placeholder. Without sign-in details it records "sign-in needed", does not touch the fields, and continues with what it can reach.
- **Answers permission questions itself.** "Don't allow", unless the dialog has no such button or the app asks the same question again straight away (then "Allow"). It never changes the phone's settings. If the phone ends up in another app (a link opened a browser), it goes back, and if needed opens the app again.
- **Stops by itself.** At most 60 actions, 12 minutes, 25 screens and 100 AI calls (the planning call included); the same action at most 3 times in a row; and when nothing on the screen changes after 3 actions. An AI usage limit (see `ai-usage-budgets.md`) ends the exploration with what it has seen. Every limit is a constant in `src/engine/mobile/explore/types.ts`.

## What it refuses (code, not prompt)

Before every action `src/engine/mobile/explore/safety.ts` decides, whatever the AI was told and whatever a screen says. It refuses, and records in the job's events in plain words ("Skipped “Delete account” because it looks destructive"):

- tapping something that looks like paying, buying, ordering, subscribing, donating, transferring, deleting, removing, erasing, resetting, uninstalling, sending, or calling (a table of words in one place, English first with a few other languages; easy to extend). The words are read on the element's text, its accessibility label and the words of its resource id;
- any tap on a screen that itself looks like a payment or a deletion, except the ways out (cancel, back, close, no, not now);
- tapping something that would change data ("Save", "Submit", "Create", "Sign up", "Post", "Add note"…), unless the project switched on **Include tests that change data** (the same switch as for API tests). Signing in and searching are not data changes;
- anything but "back", "launch" and the buttons of a permission dialog while the phone shows something outside the app;
- typing card or identity details; pressing and holding (a written test cannot repeat it);
- the same action over and over (loop guard) and going on when nothing changes (stall guard).

Text that comes from the app is untrusted: it is cleaned (control characters, brackets and quotes that could fake the screen's layout, sentences that look like orders such as "ignore previous instructions") and shown to the AI inside one delimited block. A screen that carried such text is noted in the job's events. The safety filter is the real guard: a hostile screen that says "tap Delete account" does not cause the tap, even if the AI is fooled (covered by tests).

## The plan

The exploration is turned into **test ideas** from what it really did. The code lists every path the AI walked as a candidate: the steps that repeat it from a fresh start, and the checks drawn from what the last screen showed (visible texts with a steady name; nothing invented, numbers and prices left out). The AI model then chooses among the candidates and words them in plain language (6 to 25 ideas, fewer when the app is small; the app opening is always one). If the model's wording cannot be used, the ideas keep standard names and the plan says so.

Kinds of test (what the plan counts):

| Kind | What it checks |
|---|---|
| App start | The app opens and the first screen shows. |
| Signing in | Signing in with the project's test account leads to the next screen. |
| Moving between screens | A screen opens when the AI tapped its way there. |
| Forms | A form sent empty shows what it showed; a form filled in leads to what followed. |
| Lists and details | An item opened from a list shows its screen. |
| Going back | Going back shows the earlier screen again. |

The counts are exact: each idea is already a finished test in the plan (`src/engine/mobile/explore/planner.ts` builds them once), and creating the plan stores exactly those. An idea that cannot be written (an element with no name a test can use, a path of more than 5 navigations, nothing steady to check) is dropped with its reason, listed in the plan and never silently.

### Answer of `GET /api/projects/:id/plans/:jobId` for a phone plan

The existing fields, with `targets: ["mobile"]`, `url: "android-app://<package>"`, `found.screens`, `ideas` (the same ideas, by scenario id `M-01`…), `families` (only the phone families: `phoneStart`, `phoneSignIn`, `phoneNavigation`, `phoneForms`, `phoneLists`, `phoneBack`, each with `needs: "mobile"`) and `total`. Added, only for a phone plan:

```
phone: {
  appPackage, appName,
  screens: [{ id: "S1", title, kind: "start|signin|form|list|other", elements, visits }],
  ideas:   [{ id: "M-01", title, goal, family, familyLabel, priority, path: ["Shop", "Sign in", "Shop"], usesSignIn, steps }],
  couldNotWrite: [{ title, reason }],
  skipped: [{ message: "Skipped “Delete account” because it looks destructive", why }],
  signInNeeded, signedIn,
  stats: { actions, modelCalls, durationMs, stoppedBecause, aiLimit? }
}
```

`warnings` carries plain sentences ("The app has a sign-in screen and no test account was given…"). A plan can be created from only once; `excludeIdeas` leaves ideas out; `targets` can only narrow what was explored.

### Live picture

The existing route `GET /api/projects/:id/jobs/:jobId/frame` serves the phone: a small JPEG (at most 640 px wide and 120 KB, password fields covered by the device session before the picture leaves the phone's computer), `url` `android-app://<package>`, `title` the screen's name, `phase` `exploring` or `signing-in`, `pagesSeen` the number of screens found so far, and `note` the plain line. A picture is only made while somebody reads the route; none is stored anywhere. A job is watchable during its exploration (status DISCOVERING), also when the phone is on a runner: the explorer runs on the platform and drives the phone through the runner.

## The tests

Each idea becomes a `mobile` spec (`platform: "android"`, `source.origin: "exploration"`, `source.journey` the screen path "Shop → Sign in → Shop", tags `phone`, `ai-explored` and the kind). Steps use the best stable name of each element: the resource id when it looks designed (`testId`), then the accessibility label, the visible text, role plus name; an element several others share is found by its number among them; never a position or an XPath. Scrolling and back are `press` steps (`device:scroll:down`, `device:back`). A sign-in test types `{{credentials.username}}` and `{{credentials.password}}`, which the Taqwright script reads from `TEST_USERNAME` and `TEST_PASSWORD` in the environment of the run: no secret is ever in a script, a spec, an event, an answer or a picture.

Every spec passes the checks an imported spec passes (schema, no secret-looking value) plus a cap of 40 steps, and must render with the Taqwright generator. The tests are validated by the existing mobile validation through the normal job path (this computer or a runner, as the project says): they really run on the device. If no phone or emulator can run them, they are kept as "Not run yet" with the reason, never as passing.

**Change to existing behaviour:** the mobile runner now passes the project's test account to the run (`TEST_USERNAME`, `TEST_PASSWORD` in the environment of the Taqwright process). Before, both were always empty, so an imported phone test that used `{{credentials.*}}` typed nothing.

## Limits and what is not covered

- Android only; no biometrics, captchas, in-app purchases, games, the inner content of WebViews, custom-drawn screens that give no accessibility information, rotation.
- Each exploration is bounded (see above). A big app is explored in part; the plan says what stopped it.
- Failing phone tests are not repaired by the AI (there is no repair for phone tests in the platform yet): they stay Failing with the real reason and the screenshot and video the runner keeps.
- Paths are walked from a fresh start of the app. An app that remembers the sign-in between starts, or shows a first-start screen only once (a permission question, a welcome tour), can make a written test start somewhere other than the exploration did. Permission dialogs are answered during the exploration but are not steps of the tests.
- Screens that show changing numbers are told apart by their structure; a screen whose content differs a lot from visit to visit can be counted as several.
- Map explorer (R24) limits: a button outside any list that names a person ("Unfollow Alice Smith" on a bottom sheet) makes that sheet a screen per person, and two different pages whose whole content sits in one scrolling view, in one activity, with the same toolbar, count as one screen. List rows are only tried a few times per screen, and items that differ only by their content (two products) are one screen, so per-item differences are not explored. After signing in, the signed-out screens are not visited again. The activities "the phone lists" come from the activity resolver table of `dumpsys package` (activities with intent filters): a lower bound of what the app declares. The compressed dump rarely helps with "could not get idle state" (Android still waits for idle); the UiAutomator2 server is the real fallback and is only used when Appium already installed it on the phone. None of this was run on a real phone in this round.
- The AI model must be set up (Settings). Without one the job fails at once with "Phone exploration needs the AI model" and nothing is made up.
- **Never run on a real phone or emulator here.** Everything is tested against a fake `adb` with a scripted mock app (`tests/fixtures/fake-adb.mjs`), an in-memory phone and a scripted AI model double. How well the AI explores a real app is unverified; so is the behaviour of real devices.

## For contributors

- `src/engine/mobile/explore/`: `explorer.ts` (the loop), `safety.ts` (the filter and the word table), `describe.ts` and `prompts.ts` (what the model reads; all prompts in one file), `text.ts` (untrusted text), `fake-data.ts`, `locators.ts`, `screens.ts`, `candidates.ts` (paths and checks), `planner.ts` (choosing and wording), `spec-builder.ts`, `pipeline.ts` (explore, plan, create, validate; called by `runGeneration` when the targets include `mobile`).
- The phone comes from `ctx.openDevice` (`DeviceOpener`), set by `job-runner.ts` through `platform/phone-device.ts` to the device session of `platform/agent-device.ts` (this computer's adb or a runner). Tests hand `RunnerDeps.openDevice` an in-memory phone, or point `AITP_ADB_PATH` at the fake adb.
- Tests: `tests/mobile-explore-unit.test.ts` (fast tier: cleaner, description, safety table, typing rules, locator choice, the loop on an in-memory phone, candidates, planning, specs) and `tests/mobile-explore.test.ts` (whole platform with the fake adb and the Taqwright stand-in: exploration, plan, creation, validation, picture, usage, limits, stop, refusals, secrets).
- Shared pieces touched, all additive: `targets` accepts `mobile` (`repo.ts`, `server.ts`, `routes/plans.ts`, `plan-store.ts`, `agent-services.ts`, `framework-settings-store.ts`); `StoredPlan.mobile`, `AppModel.mobile`, phone families in `planning/preview.ts`; `GenerationRequest.mobile`, a phone branch in `orchestrator.ts`; `EngineContext.openDevice`; `FrameSink.captureShot` and `wants` in `frames/sink.ts`; `source.origin: "exploration"` in the spec schema; credentials in `MobileRunEnv`.
