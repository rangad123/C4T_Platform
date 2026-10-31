# Phones with less setup: the runner gets Google's phone tools itself

## What it does for you

A real Android phone on USB needs only Google's small **platform-tools** (adb and a few companions, about 7 to 15 MB), not the Android SDK. A runner started from a download (the complete download, the plain files, or an installer) now gets them itself:

1. When there is no adb on the computer, the runner says so in its capabilities: the runner's row in **Setup**, **Runners**, **Show details** has an **Android phone tools** part: "Not on this computer yet. The runner gets Google's Android phone tools (adb, about 7 to 15 MB) itself when a phone session needs them."
2. Such a runner may be chosen for an AI phone exploration. When the session arrives, the runner first fetches the tools. The person watching sees each step as a note of the session: "This computer has no Android phone tools (adb). The runner gets them from Google … By using them you accept Google's Android SDK license", "Downloading the Android phone tools 35.0.2 (6.9 MB)", "Checked the download against Google's size and checksum", "… are ready (in the runner's own folder)", then the four steps for **Allow USB debugging** (below).
3. Then the phone session opens as before. With no phone plugged in it ends with the usual plain sentence ("No phone or emulator is connected. Plug in a phone with USB debugging on, or start an emulator."), never a test verdict.
4. From then on the runner reports the tools as ready ("The runner got Google's Android phone tools (adb 35.0.2) into its own folder.") and, after a restart, uses them again without downloading.

### Allow USB debugging (on the phone, once)

1. Open **Settings**, **About phone**, and tap **Build number** seven times (on some phones it is under **Software information**). The phone says you are now a developer.
2. Go back to **Settings**, open **System**, **Developer options** (or search Settings for "Developer options") and turn on **USB debugging**.
3. Connect the phone with a USB cable, unlock it, and tap **Allow** on "Allow USB debugging?" (tick "Always allow from this computer" to be asked once).
4. On Windows, some phones also need their maker's USB driver (Google's for Pixel phones, Samsung's for Samsung phones).

### Emulators are a bigger, separate step

An emulator needs the Android SDK, an emulator program and a system image (several GB). The runner does not install them: use `npx @taqwright/taqwright install --with-avd` or Android Studio (see `phone-ai-tests.md` and `runner-agent-setup.md`).

## The setting

`AITP_PHONE_TOOLS` in the runner's environment, or `"phoneTools"` in the download's `runner.json` (the environment wins):

| Value | What happens |
|---|---|
| `auto` | Fetch when a phone session arrives and there is no adb. **Default for a runner started from a download.** |
| `now` | The same, and also fetch in the background right after the runner starts. |
| `off` | Never fetch. **Default for a runner started from a repository checkout** (a developer's own SDK is left alone). |

An unknown value in `runner.json` stops the runner with a plain sentence ("… has a "phoneTools" the runner does not know …"), like the `browser` line. The installers' "Optional extras" line (Windows) and a line after the browser step (Mac) say that the runner gets the phone tools itself when none are found.

## How it works

- **Where from.** `https://dl.google.com/android/repository/repository2-3.xml`, Google's own list of SDK packages (the one Android Studio's SDK manager reads). The runner takes the newest **stable** `platform-tools` entry for its system (`windows`, `macosx`, `linux`), ignoring obsolete, preview and beta entries. The list gives the archive's file name, exact **size** and **SHA-1**. Google publishes no SHA-256 for platform-tools, so the check is: the list over https from dl.google.com, then the archive's size and SHA-1 against it. Nothing is pinned in the code, because Google keeps only the newest platform-tools in that list (a pinned checksum would stop working with the next release); the version that was fetched is recorded next to the files (`aitp-phone-tools.json`: version, address, size, SHA-1, time). An archive address that points away from the list's own address is refused.
- **Proxy.** The download uses the runner's own `fetch`, so it goes through the proxy and certificates the runner set up at start (see `company-networks.md`).
- **Where to.** `<work folder>/phone-tools/platform-tools/` (for a download: `work/phone-tools` inside the unzipped folder). Only entries under `platform-tools/` with plain relative names are unpacked; an archive with any other entry, or without adb, is refused whole. The files are written beside the old copy and swapped in, so a failed download never damages a working set. On a Mac or Linux every program in it is made runnable.
- **Used only when nothing else is there.** If adb is found another way (Taqwright's toolchain, `ANDROID_HOME`, `AITP_ADB_PATH`), the runner's own tools are neither fetched nor reported. Otherwise `ANDROID_HOME` **in the runner's own environment** points at its `phone-tools` folder, so the capability probe, the phone session and Taqwright find adb there. Nothing outside the runner's folder changes; nothing is put on the PATH.
- **Retries.** A failed download is tried again at the next phone session, but not within 2 minutes of a failure and at most 3 times an hour; meanwhile the row says why ("The Android phone tools could not be fetched: …").
- **Caps.** List at most 16 MB, archive at most 150 MB and exactly the listed size, at most 3,000 files and 400 MB unpacked, 10 minutes in total.
- **Protocol (additive, version stays 1).** `Capabilities.phoneTools: { state: "ready" | "can-fetch" | "fetching" | "failed" | "off" | "unsupported", version?, note? }`, never a path. A runner whose state is `can-fetch` or `fetching` counts as able to host a phone session (`deviceSessionProblem`), because whether a phone is plugged in can only be seen once adb is there. Routing of Taqwright phone **test runs** is unchanged: they still need adb (and Taqwright's tools) before they are sent.
- **Code.** `src/engine/mobile/platform-tools.ts` (the list, the checks, unpacking), `src/agent/phone-tools.ts` (the setting, the report, retries, ANDROID_HOME), hooks in `agent.ts`, `task-runner.ts` (a Taqwright task on a runner without adb fetches first too), `device-task.ts`, `capabilities.ts`, `kit.ts`, `engine/mobile/device/capability.ts`; the runner row (`web/src/features/agents`). An adb file that exists but cannot be started (a damaged or wrong download) now says so: "The Android tools (adb) on this computer could not be started. If the runner fetched them, delete the phone-tools folder in its work folder so it fetches them again."

## The phone test flakes (fixed in the test fixtures)

Three phone tests failed only on a busy machine. The cause was the fake adb (`tests/fixtures/fake-adb.mjs`), not the product: its state file was rewritten in place by many short processes. `writeFileSync` empties a file before writing it, and the device session reads `dumpsys window` and `dumpsys input_method` **in parallel**, so now and then one fake adb read an empty file, took it for "no phone state yet", started a fresh phone (no app, launcher in front, permission not answered) and saved that over the real state. That explains "not on the screen: Shop" after the permission tap, a sign-in field reported stale right after the sign-in screen opened, and the fake emulator (which polled the same file and exited when it could not read its device) disappearing early so `kill(pid, 0)` threw `ESRCH`. A stand-alone reproduction (three fake adb calls at once, 150 rounds) lost the state 4 times in 150 before the fix and 0 times after.

Fix: every fake adb call holds a small lock file while it reads and changes the state; the state is written to a temporary file and renamed over the old one (readers see all of the old or all of the new); it is written only when it changed; an unreadable file is never taken as "no state". The fake emulator writes the same way and exits only when a state it could read lacks its device. The `slow` fault now means "still changing for 1.2 s after the last change" (time, like a real loading screen) instead of "for the next 4 reads", which on a busy machine outlasted the session's 3 s settle limit. The session's settle rule itself was not the cause and is unchanged: the fake app applies a tap before the tap command returns, so the first read after an action already shows the new screen.

## What is not covered (honest limits)

- **Never run against Google's real servers or a real phone here.** Tests use a local stand-in for dl.google.com (http on 127.0.0.1) with tiny archives; the layout of `repository2-3.xml` (`remotePackage path="platform-tools"`, `revision`, `channelRef`, `archive/complete/size|checksum|url`, `host-os`) was written from Google's published format and was not fetched to check it. The owner's first real phone session on a runner without adb is the first real download.
- The adb in the stand-in archive is not a real program, so the end-to-end test stops at "could not be started"; a real phone conversation after a real download was not exercised. Real USB drivers on Windows, the "Allow USB debugging" prompt, and Mac Gatekeeper with Google's programs (Node's `fetch` sets no quarantine flag, so none is expected) are untested.
- SHA-1 is what Google publishes; it is weaker than SHA-256. The list itself is trusted because it comes over https from dl.google.com.
- Linux on ARM: Google publishes no platform-tools; the runner says to install adb from the system's packages. Windows on ARM uses Google's x64 tools through Windows' emulation (not tried).
- The platform does not know whether a phone is plugged into a runner that has no adb yet; such a runner is offered phone sessions and says so in words when no phone is there.
- Phone **test runs** with Taqwright still need Taqwright's own toolchain (Appium, its driver, Java); the phone tools alone are enough for the AI explorer only.
