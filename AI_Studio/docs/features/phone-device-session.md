# Phone device session (AI phone exploration, part A)

The device session is the layer the AI phone explorer stands on. It opens the app under test on an Android phone or emulator, reads the screen, and performs
**one action at a time**. The explorer (MX-B) and the screens (MX-C) only use `openDeviceSession`; they never talk to adb.

## What a session can do

- **Open:** find a connected phone or emulator (or the one you name by serial); if none is connected, start the project's emulator through the platform's own
  emulator helper; install the APK when one is given; start the app.
- **Read** (`snapshot`): the things on the screen a person could see or touch, numbered 0, 1, 2 in reading order (at most 120), with text, label, id, and flags
  (tappable, text field, password, scrollable, checked, enabled, focused), a fingerprint of the screen (equal for the same screen), whether the keyboard shows,
  and whether the screen is **outside the app** (a permission question, a system dialog, another app). Optionally a small picture (JPEG, at most 640 px wide
  and 120 KB).
- **Act:** tap, long press, type, scroll, back, hide the keyboard, start or restart the app, wait (at most 3 s). After every action the session waits until
  the screen has stayed the same for 0.4 s (at most 3 s) and returns the new screen.

## Where the phone is

`openDeviceSession(opts, host)` in `src/platform/agent-device.ts` returns the same interface either way:

- **This computer** (`kind: "local"`): adb on the machine that runs the platform.
- **A runner agent** (`kind: "agent"`): chosen like recordings are: the project's runner choice, or `on: "agent"`. The platform queues a *device task* for one
  agent; the explorer's calls become commands in the agent's heartbeat replies and the agent's answers come back as pushes. An agent that reports
  `capabilities.deviceSession` (adb plus a ready phone, or an emulator it can start) is eligible; an older agent is never offered a device task, and the person
  is told why in words. Every remote call has a time limit; an agent that stops answering ends the session with a plain error.

Phone or link failures (no device, offline, locked, adb dead, the agent gone, a cap reached) are thrown as `DeviceSessionError` and are never a test verdict. A
refused or failed action (stale element, a field that cannot be typed into) is returned as `{ ok: false, error }` with the current screen.

## Safety rules (each is tested)

- **No coordinates, packages or commands from the AI.** An action names an element of the *last* snapshot by number; a stale or out-of-range number is refused,
  and the session re-reads the screen before acting to be sure the element is still there. Taps go to the centre of that element's bounds, computed here. The
  action schema is strict: any extra field is refused. The agent re-validates every command.
- **A closed list of adb calls** (`allowedCommand` in `adb.ts`): devices, install of the given APK, screenshot, screen description, three read-only `dumpsys`/
  `getprop`/`pm list` calls, tap, swipe, key events, text input, start or stop **the configured package only**. There is no shell on this computer (argument
  arrays) and no method that takes a command string. Never uninstall, change a setting or grant a permission: a permission dialog is answered by tapping it.
- **Typed text** is printable ASCII only, travels as one single-quoted word (`; rm -rf /`, `$(...)`, backticks and quotes are typed as text and reach no
  shell; a fake phone shell in the tests records any unquoted metacharacter and the tests assert none). Non-ASCII, line breaks and `%s` are refused with a reason.
- **Passwords.** A password field accepts only `{{credentials.password}}`; the real value comes from the credentials held on the machine that owns the phone and
  is typed there. `{{credentials.username}}` fits any text field. With no credentials the answer is "Sign-in details are needed for this field". The password
  field's text is never read (the parser empties it), the value is scrubbed from any other text, it is never in a snapshot, answer, error or log line, and in a
  task it is encrypted at rest with the platform's secret box and sent only to the agent the session runs on.
- **The picture** is made on the machine that owns the phone: the PNG from `screencap` is decoded, a flat rectangle is painted over every password field (and
  over any field that shows the password) on the full-size pixels, and only then is it scaled and written as a JPEG, with no new dependency (own PNG decoder with
  Node's zlib and a small baseline JPEG encoder in `image.ts`). The tests decode the result in Chromium and check the pixels.
- **Untrusted text.** The screen description comes from an app: it is read by a small scanner (no DOCTYPE, no entities beyond the standard ones), text loses
  control, direction and zero-width characters and is cut to 80 characters, and size (2 MB), depth, node count and element count are capped. Malformed input
  returns an error, never throws. On the platform side everything an agent sends is cleaned again (password text emptied, texts re-cleaned, fingerprint
  recomputed, pictures kept only if they are small JPEGs, project credentials removed).
- **Caps:** 200 actions and 20 minutes per session by default (settable lower or up to 500 / 120); stop through the abort signal ends it promptly; one session
  uses the device at a time (the platform's device lock), so a test run waits for it.
- **An emulator the session started** is stopped by its exact serial when the session ends (also on cancel, timeout, or the agent being stopped); one that was
  already running is left alone.

## The agent side

`src/agent/device-task.ts` handles a `kind: "device"` task: opens the session on this computer, answers the commands in each heartbeat reply, pushes answers to
`POST /api/agent/tasks/:id/device` (the seventh agent route), and closes everything it started on end, cancel, time limit, agent stop, or a platform that stops
answering (90 s). Protocol additions (all additive and optional, version stays 1): `capabilities.deviceSession`, task kind `device` with `TaskOffer.device`,
`HeartbeatResponse.deviceCommands`, the `DevicePush` message. The platform never re-offers a device task (a session cannot move to another computer).

## Seams and the fake adb (for contributors)

- `AITP_ADB_PATH` makes `adbPath()` return a stand-in (a `.mjs`/`.js` file is run with this Node); `AITP_EMULATOR_PATH` does the same for the emulator program.
  Unset, nothing changes. The agent's capability probe and the emulator helper now pass their `env` to the programs they start.
- `tests/fixtures/fake-adb.mjs` is a Node script that behaves like adb for the commands above and runs a scripted mock app, state kept in `AITP_FAKE_STATE`:
  `AITP_FAKE_APP=shop` (permission dialog, home, sign-in with a password field, products list that scrolls, product, cart, a "Delete account" screen, an
  external link that leaves the app) or `notes` (list, add form, delete confirmation by long press). `AITP_FAKE_DEVICES` (emulator, phone, both, none),
  `AITP_FAKE_FAULTS` (offline, unauthorized, locked, slow, never-settles, unicode, hostile, malformed, huge, many, show-password, no-uidump),
  `AITP_FAKE_SCALE`, `AITP_FAKE_ADB_LOG` (every call, as JSON lines). `tests/fixtures/fake-emulator.mjs` stands in for the emulator program.
- Tests: `tests/device-session-unit.test.ts` (fast tier), `tests/device-session.test.ts` (fake adb; one Chromium page to decode the picture, so run it under the
  browser lock), `tests/device-agent.test.ts` (real platform and real agent program, plus a fake agent for the protocol edges).

## What is not covered

Everything here was exercised only against the fake adb. **It has never run on a real phone or emulator**: real `uiautomator dump` output on many Android
versions and vendors, real `screencap` sizes, real keyboards (`input text` cannot type non-ASCII, which is refused by design), apps that block UI Automator
(banking apps with secure windows show an empty screen), WebViews (their content is only as visible as the app makes it), and games. The settle rule is
time-based, so a screen with a constant animation returns after 3 s as it is. The explorer does not handle iOS (Android only).
