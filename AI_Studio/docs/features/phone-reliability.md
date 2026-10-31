# Phone reliability: clean start, permission answers, self-repair, app bundles, any text

Five things that make Android phone tests repeatable. Each is off or inactive until it applies, so phone tests that use none of them run exactly as
before.

## What a tester sees

### How each test starts (Setup, Mobile app, "How each test starts")

- **Start every test from a fresh install of the app's data** (default off). Before each phone test the platform stops the app and clears its data
  (`adb shell pm clear <package>`). Only the project's own package is ever cleared. No test depends on what the one before it left behind (a
  signed-in account, a full cart, an answered question).
- **Grant these permissions before each test.** A checklist of the runtime permissions the app asks for ("Read the app's permissions" reads them from a
  phone connected to the platform's computer, `dumpsys package <package>`), or names typed by hand (`android.permission.CAMERA`). Each one is granted
  to the project's package with `pm grant` before each test, after the clear. At most 30.
- With either option on, **each test runs on its own** (one Taqwright run per test, the phone prepared in front of each), so a run takes longer.
- A test the phone could not be prepared for (a permission the app does not ask for, a phone that stopped answering) **does not run**. It gets an
  error with the reason, for example "The phone could not be prepared for this test, so it did not run: the permission Camera
  (android.permission.CAMERA) could not be granted; check that the app asks for it."
- The options are said in plain words where they matter: in the **plan** of a phone exploration (`phone.startState`) and once in the **events of every
  run** of phone tests (`phone_start_state`): "Each phone test starts from a fresh copy of the app's data (the app's data is cleared before each test)."
- The options need the app's package name. Without one, saving them is refused with that reason.

### Permission questions as steps

When the AI explorer answered a permission question while opening the app ("Allow Shop to send you notifications?"), every test written from that
exploration **starts with a step that gives the same answer if the question shows**: `Don't allow "send you notifications" when asked` (or `Allow
"…" when asked`). If the phone does not ask (it already answered, or the permission was granted before the test), the step does nothing and never fails
the test. The plan lists these steps (`phone.permissionAnswers`).

### Repair for phone tests

When a phone test fails because an element was never found (Taqwright's words: `did not reach state "visible"`, or a check whose element could not be
resolved), a run of existing tests (Run, Run again, a schedule) looks at the phone and may suggest a **Repair**, exactly like a web test's (on the test:
Now / After applying, Apply and run again, Dismiss). It is never applied by itself.

1. The app is opened on the phone (this computer or the runner, as the project runs phone tests) and the test's steps before the failing one are
   repeated through the device session, under the explorer's safety rules.
2. The screen at the failing step is read. If the element is there after all, nothing is suggested.
3. The AI model is shown the elements of **that screen only** that could do what the step does (a field for typing, something tappable for a tap), as
   untrusted app text, and asked which one is the element the step meant, or none.
4. The code checks the answer: it must be one of the elements offered, and a tap must pass the explorer's safety rules (nothing destructive, no payment,
   no sending, no data change unless the project allows it). The new locator is chosen the way the explorer chooses one (resource id, label, text, role).
5. The test is **run once** with the new locator. Only when that run gets past the step is a Repair suggested: high confidence when the test then
   passed, medium when it failed later for another reason. The reason says what the AI looked at and chose: "The AI looked at the phone's screen at
   this step and chose “Sign in” (…). The test passed when it was run once with it."

Events: `phone_repair_started`, then `healing_proposed` or `phone_repair_none` with the plain reason.

### App bundles (.aab)

Upload an `.aab` where an `.apk` goes. When the platform's computer has **Java and bundletool**, the bundle is turned into one universal APK
(`bundletool build-apks --mode=universal`) and used like an uploaded APK. Otherwise the upload is refused: "This is an Android App Bundle (.aab). Upload
an .apk, or install Java and bundletool on the computer that runs the platform and set BUNDLETOOL_JAR to the bundletool .jar file, then upload the .aab
again." The platform never downloads bundletool.

### Typing any text

`adb shell input text` types only plain ASCII, so the device session refuses other text ("That text has characters the phone can't type here…"). When
the phone's **current keyboard is ADBKeyboard**, text with accents, other scripts or emoji is typed through it: one broadcast whose only argument is the
base64 of the text (`am broadcast -a ADB_INPUT_B64 --es msg <base64>`), so nothing reaches a shell. Plain ASCII still goes through `input text`.

## What the owner must do to use it for real

- **Clean start, permissions, repair:** nothing beyond what phone tests already need (Android tools, a phone or emulator, an AI model for repair).
- **.aab:** install Java (or use the JDK `npx @taqwright/taqwright install` brings) and download Google's `bundletool-all-<version>.jar` once; set
  `BUNDLETOOL_JAR` to its path (or put it as `bundletool.jar` in Taqwright's folder). For an emulator or test phone, bundletool signs with the
  computer's Android debug key (`~/.android/debug.keystore`, created by Android Studio or the first debug build).
- **Unicode typing:** install the open-source ADBKeyboard app on the phone (`adb install ADBKeyboard.apk`, from
  github.com/senzhk/ADBKeyBoard), then make it the current keyboard once on the phone (Settings, System, Keyboard) or with
  `adb shell ime enable com.android.adbkeyboard/.AdbIME` and `adb shell ime set com.android.adbkeyboard/.AdbIME`. The platform only looks at which
  keyboard is selected (`dumpsys input_method`); it never installs or switches it.

## How it works (for contributors)

- `src/engine/mobile/state/`: `clean-start.ts` (options, sentences, `runEachPrepared`), `permissions.ts` (`dumpsys package` parser),
  `permission-step.ts` (answers kept by the explorer, the step, its Taqwright code), `bundle.ts` (.aab), `unicode.ts` (ADBKeyboard).
- `src/engine/mobile/repair/`: `phone-repair.ts` (target, replay, prompt, checks, one re-run), `screen-match.ts` (a locator against a snapshot).
- adb: the explorer's closed list (`allowedCommand`) gained only the base64 keyboard broadcast. Clearing, granting and reading the package description
  are a separate list (`allowedPrepareCommand`) that only an `Adb` made with `forPreparation()` may run; the device session never has one.
- Shared files, all additive: `MobileTarget.cleanStart` / `grantPermissions` (`target.ts`), the per-test runs in `mobile-runner.ts`, the
  `device:permission` press in `generators/taqwright.ts`, `MobileAppModel.permissions` and two lines in `explorer.ts`, `planner.ts`/`spec-builder.ts`
  (the first steps), `TypingOptions` in `device/actions.ts` and two lines in `device/session.ts`, the phone branch after web healing in
  `validator.ts`, `ctx.openDevice` for validation jobs in `job-runner.ts`, `unhealableTest` accepts phone tests and the `exploration` origin
  (`healing/failure.ts`), the Mobile app settings and .aab upload in `server.ts`, `GET /api/projects/:id/mobile-app/permissions`
  (`routes/phone-state.ts`), `phone.startState` and `phone.permissionAnswers` in the plan answer (`routes/plans.ts`), the run sentence in
  `validate-only.ts`.
- Text format: the phrase `When the phone asks for a permission, tap the text "Don't allow"` (`for: "mobile"`: it prints and reads back; a web or API
  test refuses it, and the editor's list leaves it out because phone tests are not text yet).
- Tests: `tests/phone-reliability-unit.test.ts` (fast tier) and `tests/phone-reliability.test.ts` (fake adb with `pm clear`/`pm grant`/
  `dumpsys package`/ADBKeyboard added, `tests/fixtures/fake-taqwright-steps.mjs`, `tests/fixtures/fake-java.mjs`, a scripted model; a platform in
  process, no browser).

## What is not covered

- **Nothing here has run on a real phone, emulator, Appium, Java or bundletool.** Everything was exercised against the fake adb and stand-ins. In
  particular: real `dumpsys package` output on many Android versions, real `pm clear`/`pm grant` messages, whether real permission dialogs are found by
  their button text within 3 s, real bundletool output and signing, and ADBKeyboard on real phones.
- **Taqwright's exact words for a missing element** were taken from its source (`waitFor: … did not reach state "visible"`, `(last: <unresolved>)`); a
  version that words them differently would not be repaired (it stays Failing, never wrongly repaired).
- Repair suggestions are made on runs of existing tests, not during the first validation right after an exploration creates the tests (that path stores
  no suggestions). Steps that open a deep link, type test data (`{{data.…}}`) or press other keys cannot be repeated on the phone, so a test that needs
  them gets no suggestion. Only one element is chosen; a step whose element moved to another screen is not repaired.
- Permission steps are written only for questions answered **while the app was being opened**. A question that appears after an action in the middle
  of a test is answered by the explorer but is not a step (such a test may stop at the question).
- Clean start with only an APK and no package name is refused (the package is needed to clear it; reinstalling would mean uninstalling, which the
  platform never does). On a runner with several phones and no chosen serial, clearing may fail with "more than one device" (the test then errors with
  that reason).
- The permission checklist reads a phone connected to the platform's own computer; for phones on a runner, type the names.
- A wrong partial text match: a text locator with no exact match matches elements that contain the text, as Taqwright does.
