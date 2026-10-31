# Phones: is this phone ready, where phone tests run, how thorough, signing in

Round 24, part DEVICE. What a tester sees in **Setup, Mobile app** and on the page of a running phone exploration, and how it works. The device
choice itself (which phone a run uses), the exploration's limits and the plan's ideas are built by the other parts of round 24 and use these
settings; their documents describe them.

## What a tester sees

### Is this phone ready? (Setup, Mobile app)

Below the Mobile app row, for a project with an Android app, a card lists every phone and emulator connected to the computer that runs the platform,
each with its model and serial ("CPH2467 (R58N20ABCDE)"), its maker and Android version, and **Ready**, **Check** or **Not ready**. What needs doing is
listed first, each line with the exact steps; **Everything that was checked** shows the rest. **Check again** reads the phones again.

| Check | What it says |
|---|---|
| USB debugging | allowed for this computer; otherwise "This computer is not allowed to use the phone yet" with the steps (unlock, tap Allow on "Allow USB debugging?") |
| Android version | "Android 15 (API 35)"; older than Android 5 is not ready |
| Screen | on and unlocked; a locked phone is not ready (tests cannot type a PIN), a dark screen needs a look |
| Stay awake | the screen stays on while the phone charges; otherwise **Keep the screen on while charging** |
| Animations | off is what test phones use; otherwise **Turn animations off for tests** (and **Restore animations** afterwards) |
| Battery | low (under 20%) and not charging needs a look |
| The app | installed for the phone's current user; an app that lives only in a second user (OnePlus "Parallel apps" user 999 "MultiApp", app twins, a work profile) is not ready, said in those words; with an uploaded `.apk` a missing app is installed by the platform |
| Launcher | the screen that opens the app, from the shared resolver (`mobile/device/launcher.ts`), never the "Open with" chooser |
| Other users | a second user is noticed and explained: tests use the current user only |
| Test helper | whether the UiAutomator2 server is installed yet (the first phone test installs it) |

**Settings this maker's phones need** gives exact menu steps by maker, read from `ro.product.manufacturer`:

- **OnePlus, OPPO, realme:** turn on **Disable permission monitoring** (Developer options; on some versions **Disable system optimization**), and
  let `io.appium.uiautomator2.server` and `.server.test` run in the background (Apps, App management, Battery usage, **Allow background activity**).
- **Xiaomi, Redmi, POCO:** **USB debugging (Security settings)** and **Install via USB** in Developer options; **Autostart** and no battery limits
  for the test helper.
- **Samsung:** turn off **Auto Blocker** (Security and privacy) while testing; **Unrestricted** battery for the test helper.
- **vivo, iQOO:** **Install via USB**, turn off **Monitor apps installed via ADB**, allow the test helper in the background.
- **Huawei, Honor:** **Allow ADB debugging in charge only mode**, turn off **Monitor apps installed via ADB**, **App launch** set to manual for the
  test helper.

Nothing on a phone changes unless a person presses a button. **Turn animations off for tests** saves the three scales the phone had and sets them to
0; **Restore animations** puts exactly those back (Android's default, 1, when nothing was saved). **Keep the screen on while charging** sets Stay
awake for USB and AC charging and **Put the screen setting back** restores the old value. A phone that refuses (a OnePlus without Disable permission
monitoring, a Xiaomi without USB debugging (Security settings)) gets that sentence, and the result is read back from the phone, so a change that
silently did nothing is reported too. Changes are refused while the project has a run or exploration going.

Phones on a runner are listed under **Phones on runners** by model and state; their ready check runs on that computer: **Check this computer**
(`check-computer`) prints one line per phone ("Phone CPH2467 (R58N20ABCDE): animations are on" with what to do).

### Phone test settings (Setup, Mobile app)

- **Where phone tests run:** **Choose for me** (a connected phone that has the app, else an emulator), **The phone the AI explored on** (the default
  once the AI explored on a real phone; off until an exploration recorded its device), each real phone connected here by model and serial, **An
  emulator**, **A device farm** (the farm connection under Device farm; choosing anything else switches the farm off). A sentence above says what
  applies now ("Phone tests run on the phone the AI explored on, CPH2467 (R58N20ABCDE).").
- **How thorough:** **Quick** (about 40 screens, 150 actions or 10 minutes, up to 15 test ideas), **Standard** (150, 600, 30 minutes, 40 ideas, the
  usual), **Thorough** (300, 1,200, 60 minutes, 80 ideas). The exploration stops earlier when it stops finding new screens, and says why.
- **Already signed in on this phone:** keeps the app's data, so an app signed into by hand is explored and tested signed in. It cannot be on
  together with **Start every test from a fresh install of the app's data** (that clears the data, which signs the app out); the page and the
  platform both say so.

### While the AI explores

- The progress line counts screens, activities (and how many the phone lists for the app), actions and AI calls, and at the end says why it
  stopped ("Stopped because no new screens after 80 actions: the app looks fully explored").
- **Sign-in:** when the app shows a sign-in screen the AI fills it from the test account typed under Advanced options when starting: the user name
  (or e-mail or phone first, then the password on the next screen), the password, and the sign-in button. Only `{{credentials.*}}` stand-ins leave the
  platform; the phone's session puts the real values in. It never taps Forgot password, Sign up, Continue with Google or anything that reads as log
  out, pay, delete or send.
- **A one-time code or a captcha** pauses the exploration. The page shows "The app asks for a one-time code. Enter the code on the phone, then choose
  Continue." with the time left (5 minutes), **Continue** and **Go on without signing in**. Nobody answering by then is the same as going on, and the
  steps say so. The platform never reads or types the code.
- **Already signed in on this phone** and the app asks to sign in anyway, without a test account: the page asks the person to sign in on the phone
  by hand, then Continue.

### The plan

Under what was found: "Explored 142 screens across 31 activities (the phone lists 40 for the app); stopped because no new screens after 80 actions:
the app looks fully explored."

## How it works

- **Settings** (`src/engine/mobile/phone-settings.ts`): `runsOn`, `depth`, `keepSignedIn`, `exploredOn` (written by the exploration through
  `recordExploredOn` in `src/platform/phone-settings-store.ts`) and `phoneSetup` (saved values to restore) are fields of the project's mobile app
  (`MobileTarget`, the latest application's config JSON). A change rewrites that JSON in place (same application, test account and app model). No
  table, no migration. Defaults store nothing. `DEPTHS` holds the numbers the explorer and the planner use.
- **Ready check** (`src/engine/mobile/device/ready.ts`): `checkPhoneReady(call, input)` over a call function; every call is on the closed READ list
  of `src/engine/mobile/device/setup-commands.ts` (getprop of six properties, `dumpsys power|battery|window`, `settings get global` of four keys,
  `am get-current-user`, `pm list users`, `pm list packages --user N`, `cmd package resolve-activity --brief --user N -c LAUNCHER <pkg>`). The changes
  are the CHANGE list: `settings put global` of the three animation scales and `stay_on_while_plugged_in`, to a number. Only an `Adb` made with
  `forReadiness()` / `forPhoneSetup()` may run them; the explorer's session never has one. Every answer is trimmed of `\r`.
- **Sign-in** (`src/engine/mobile/explore/signin.ts`): `readAuthScreen` (password, identifier, code by words or by 4-8 digit boxes, captcha, none) and
  `signInOnPhone` (fills, taps the button judged by `explore/safety.ts`, follows up to 4 screens, detects details that were not accepted). A
  `PersonGate` asks a person; the platform's gate (`src/platform/phone-person-gate.ts`) writes `mobile_sign_in_waiting` to the job's events, polls
  for `mobile_sign_in_answer`, and writes `timeout` itself at the deadline, so it works when jobs run in a separate worker process.
  `EngineContext.askPerson` carries it to phone explorations (job-runner).
- **Routes** (`src/platform/routes/phone-device.ts`, all under `/api/projects/:id`, so per-project scope comes from the prefix):
  `GET|PUT /phone-settings` (viewer | editor), `GET /phones` (viewer), `POST /phones/:serial/animations` and `/stay-awake` (editor),
  `GET|POST /jobs/:jobId/phone-sign-in` (viewer | editor; the job must belong to the project). `PUT /api/projects/:id/mobile-app` and the `.apk` upload
  keep the settings and refuse a clean start together with Already signed in.
- **Runner**: `src/agent/phone-ready-lines.ts`, one line per phone in `check-computer` (optional, never required; only when the runner's computer has adb).
- **Screens**: `web/src/features/phonedevice/` (`PhoneDevicePanel.tsx`, `SignInPause.tsx`, `phonedevice.ts`, `phonedevice.css`), hooked into Setup,
  Mobile app, the progress of a phone exploration and the plan. Definitions in `web/src/lib/help.ts` (`phoneReady`, `phoneCheck`), the guide topic
  **Get a phone ready for tests**, and the tour step **Is the phone ready?** in the Phones chapter. The device farm's own choice is now titled
  **Device farm or this computer**.

## What is not covered (honest limits)

- **Never run on a real phone here.** Everything was exercised against the fake adb (`tests/fixtures/fake-adb.mjs`, with makers, a parallel-apps
  user, a screen that is off, a OnePlus that refuses setting changes) and the in-memory phone. The menu names for each maker come from the makers'
  own wording as published and from the research report; they move between versions and were not checked on each phone.
- The ready check does not unlock a phone, does not install the test helper and does not change OEM settings (Disable permission monitoring,
  Auto Blocker, background activity): those need a person on the phone. Whether the test helper is allowed in the background cannot be read over adb.
- The ready check reads phones on the platform's computer; phones on a runner are checked by that runner's `check-computer`, not live in Setup.
- A one-time code, captcha, fingerprint or face check is never answered by the platform. Sign-in forms that are web pages inside the app, two-step
  screens the detector does not recognise, or sign-in with Google/Apple accounts are not filled; the exploration goes on without signing in.
- "Already signed in" relies on the app keeping its session: an app that signs out after some time needs signing in again on the phone.
