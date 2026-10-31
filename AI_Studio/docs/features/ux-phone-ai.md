# AI phone tests: start, watch the phone, approve the plan, see the tests

What changed for the tester (MX-C). The owner asked: "AI phone tests should also be there." The AI already explored websites. Now it can open an **Android app** on an emulator or a phone, tap through it like a careful user, plan tests, write them and run them, with the same promises as for a website: the person sees what it does, approves the plan first, can stop at any time, passwords are never shown, nothing destructive is tapped. This page covers the screens. What the AI does and refuses is in [phone-ai-tests.md](phone-ai-tests.md) (the explorer, the plan and the platform routes) and the device session in its own document; this page only says how the screens use them.

## For the tester

### Starting (three entry points, one panel)

- **New test, then Explore the phone app (AI)** (under "With help"). Its line says what it does. When the project has no Android app it says "Add a phone app first. Opens Setup, Mobile app." and takes you there; when the app is only a file without its package name it says so; for an iPhone app it says "Android only. For iPhone apps, import tests."
- **Setup, then Mobile app, then Explore with AI** (next to **Change**).
- **The welcome page** (and **New project**): the first card, **Explore my app**, now asks **A website or API** or **An Android app**. For an Android app it asks for the app's package name (and optionally an `.apk` file, which is installed first), saves it as the project's Mobile app, and opens the panel below. Nothing starts until you press **Start exploring**.
- The panel ("Explore the phone app (AI)") says in plain words what will happen: the AI opens the app on a phone or emulator, taps through it like a careful user and plans tests; nothing is created until you approve the plan; it never taps buttons that look like paying, deleting or sending; passwords are hidden. A short list says **What it will not do**: pay or subscribe, delete accounts or data, send messages or money or make calls, use a fingerprint or face check, get past captchas, explore games.
- **Where it runs** is a list of choices read from the platform: **This server** (when an emulator is set up on it) and each runner. A choice that cannot work is switched off with the reason: "Offline, last seen 3 hours ago", "This runner is out of date and cannot explore phone apps. Update it from Setup, Runners.", "Android: no devices connected". A runner is offered as usable only when it says it can explore phones (`capabilities.deviceSession`) and has a phone or emulator. If nothing can: "No phone or emulator is ready. Connect a runner on a computer with an Android emulator or phone: Setup, Runners, Add a runner. For a real phone, turn on USB debugging first." with **Open Runners**. The platform runs a project's phone work where the project runs, so choosing another place is saved first (and the panel says so: "Phone tests for this project will run there from now on").
- **Test account** is under **Advanced options** (a user name and a password, never shown again). The panel reminds you: "If the app needs a login, add a test account under Advanced options."
- The AI model not set up: the panel says so and links to **Settings**; **Start exploring** is off. An app with only an `.apk` and no package name: the panel asks for the name, because the platform explores an app by its package name. An iPhone app: "Phone exploration works on Android only. For iPhone apps, import tests."
- **Start exploring** always asks for a plan (plan mode), so nothing is created until the person agrees. The platform's own refusal (another job running, no device) is shown in the panel in its own words and the person can try again.
- The panel is a real dialog: keyboard stays inside, **Escape** or **Cancel** closes it and the focus returns to what opened it, and it scrolls on a short screen with the two buttons kept in reach.

### Watching the phone

- The progress card says **Exploring your phone app** (and the badge in the page header too), with one step in phone words ("Exploring your phone app…", "4 screens so far").
- **Watch live** works as for a website, off until asked for. The Explorer view then shows the phone screen in a **portrait, rounded frame** that fits the screen (picture above the lists on a phone), with the app, the screen's title, **Doing now** ("Tapped “Sign in”") and **Stop exploring** with the same dialog (it says no plan is made and nothing is created). The picture's text alternative is the app and the screen's title. When the exploration ends the last picture stays: "Exploration stopped: 4 screens seen".
- Under the steps, with or without the picture: **"4 screens seen"** (and "…, 31 actions" once the platform says how many) and, when there is any, **What the AI left alone**: a calm list, one line each, such as "Skipped “Delete account” because it looks destructive".

### Approving the plan

- The plan is the one a website has, in phone words: "We found 9 screens, with 2 forms. We will create about 12 phone tests: signing in 2, moving between screens 5, forms 3 and lists and details 2." **Create the tests**, **Discard the plan**, **Edit the plan**.
- **Edit the plan** lists each kind of test as a checkbox and, under it, each test idea with what it checks and the **screens it goes through** ("Path: Home → Sign in → Home"). Leaving an idea or a whole kind out changes the sentence at once, and **Create the tests** sends exactly that.
- **What we found (9 screens)** lists the screens by name (a small picture only if the platform sends one). **What the AI left alone (N)** and **Ideas left out (N)** (ideas the AI could not turn into a test it could repeat, each with the reason) are listed, and the platform's own notes appear under **Worth knowing**.
- **Discard the plan**, or a plan that is gone, offers **Explore again**, which opens the phone panel (not the website form).

### After creation

- "Creating your tests" with the live list of tests as they are made and run. Then the project's Overview and **Tests**: phone tests read **Phone** with the app's package, and a failing one shows the platform's reason and, on its page, the usual screenshot, video and steps.
- A test's strip says where it came from: "Created by exploring the Android app, 14 Oct 2026, path: Home → Sign in → Home" (when the platform stored the path; nothing is said that was not stored).

## What the screens read (API)

All of it exists in the platform; nothing here is invented by the screens.

- `POST /api/projects/:id/test-generation` with `{ targets: ["mobile"], plan: true }` (and `credentials` when a test account was typed). 409/422 answers carry a plain `error`.
- `GET /api/projects/:id/plans/:jobId` for the plan: the usual fields plus `found.screens` and a `phone` part (`appName`, `screens`, `ideas` with `goal`, `family`, `path`, `couldNotWrite`, `skipped`, `signInNeeded`, `signedIn`). `web/src/features/onboarding/onboarding.ts` `normalizePlan` joins that with the kinds of test (`families` named `phoneSignIn` and so on) once, so the rest is the website's code. `POST .../create` gets the ideas left out (`excludeIdeas`) and no switch of its own for a kind made of ideas.
- `GET /api/projects/:id/jobs/:jobId/frame` for the picture; a picture whose address is `android-app://<package>` is shown as a phone picture.
- `GET /api/test-generation/:jobId/events` for the screens found (`mobile_screen_found`), what was left alone (`mobile_action_skipped`) and the closing line (`mobile_exploration_done`, "9 screens, 31 actions").
- `GET /api/config` (`mobile.available`, `llm.configured`), `GET/PUT /api/projects/:id/runner`, `GET /api/projects/:id/agents` (`capabilities.android`, `capabilities.deviceSession`), `PUT /api/projects/:id/mobile-app`.
- A project whose application is an `android-app://` address has phone jobs: the job answer does not say what it explored yet, so the screens infer it from the project (and believe `targets` when an answer has it).

## Decisions and limits

- Words follow the decided vocabulary: Exploration, Run, Passing, Failing, Needs a look, Runner; a phone test is "Phone" (was "Mobile" in the Tests list and on a test's page).
- The AI explores an **Android** app by its **package name**; an `.apk` alone does not name the app, so the screens ask for the name. iPhone apps are imported, not explored.
- **Actions are not counted live**: the platform tells when it finds a screen and when it leaves something alone, not each tap, so while it runs the card shows the screens seen only, and the number of actions once the exploration has ended (or if the platform ever sends a counter).
- "What the AI left alone" is wider than safety: it includes taps it did not make because the element was not a text field or no sign-in details were given, each with its reason.
- Choosing a different runner in the panel changes where the project's phone work runs (the platform's rule), so it is said before it is done; there is no one-off choice.
- The picture is a still, about once a second, at most 640 px wide, with password fields covered by the device session; it is held in the platform's memory while someone watches and nowhere else. A runner that cannot send pictures shows "This part runs on another computer and cannot be shown." and the counters and lists still work.
- **Never run on a real phone or emulator by this work.** Everything here was exercised against a fake API and (see the tests) the real platform with a fake `adb`; no emulator, phone or real model was used. How the exploration behaves on real apps is not verified by these screens.

## Files

`web/src/features/phone/` (`phone.ts` words and rules, `PhoneStart.tsx` the panel and Explore with AI, `PhoneProgress.tsx` counters and the list of what was left alone, `phone.css`), small edits in `web/src/features/explorer/*` (phone frame, words), `onboarding/*` (the first card's choice, the plan for a phone app), `authoring/NewTestMenu.tsx`, `setup/SetupPage.tsx`, `components/{MobileAppPanel,JobProgress,ProjectHub,ui}.tsx`, `pages/{ProjectOverview,ProjectTests}.tsx`, `provenance/provenance.ts`, `lib/labels.ts`, `api.ts`, the guide (`explore-phone-app`, a want, place help).

## Tests

`tests/phone-ai-unit.test.ts` (fast tier: the words and promises, where it can run, the plan sums for a phone app and that a website plan adds up as before, the plan as the platform sends it, counters and skipped lines from real event names, the origin line), `tests/phone-ai-ui.test.ts` (real browser against a fake API: every start state, the welcome choice, watching with the phone picture, stop, the plan with edits and its notes, the tests as they appear, keyboard, 44 px targets, 375 px, axe in light and dark, retired words, screenshots in `.scratch/phone-ai/shots`), `tests/phone-ai-real.test.ts` (the real platform with the fake adb `shop` app and a scripted model, skipped with its reason while the platform side is missing).
