# The downloadable Android emulator setup

Mobile tests run on an Android emulator on the computer that runs the platform. **Settings → Mobile testing** shows whether one is set up
(`Ready`) and, when it is not, offers a one-step setup download. This is the admin-facing detail behind that; what a tester sees is covered
by the user guide's phone sections and the Settings page itself.

## What it is

A small, per-operating-system script, **not** a multi-gigabyte kit:

- `setup-emulator.cmd` (Windows)
- `setup-emulator.sh` (macOS and Linux)

The Android SDK, the emulator and a system image are license-gated by Google and far too large to redistribute, so the script **downloads
them at run time** — the same approach the runner uses for browsers and the phone tools. It is generated in `src/platform/emulator-setup.ts`
and served from `GET /api/mobile/emulator-setup?os=windows|unix` (role: viewer; platform-wide, so it is classified `none` in
`auth/project-scope.ts`). There is no user input in the script, so nothing is interpolated into a shell command.

## What the script does

1. Checks that **Node.js 24 or newer** is on the computer (the Android tools need 24), and says where to get it if it is missing or too old.
2. Runs `npx --yes @taqwright/taqwright install --with-avd`, which vendors the JDK, the Android SDK, Appium and an emulator system image
   into Taqwright's own directory and creates an AVD (see `src/engine/mobile/toolchain.ts`). Run inside the platform's own folder, npx uses
   the installed `@taqwright/taqwright`; run anywhere else, npx fetches it.
3. On success, tells the person to reload **Settings → Mobile testing**, which then reads `Ready`.
4. On failure, prints the usual needs in plain words: about 15 GB of free disk, 3 GB of free memory, and hardware virtualization turned on
   (Windows Hypervisor Platform / Hyper-V on Windows; KVM / `/dev/kvm` on Linux; built in on a Mac), and that running it again continues
   where a cut-off download stopped (taqwright skips what is already installed).

Measured on a Windows 11 x64 computer (2026-10-26): 6.4 GB on disk for the toolchain plus about 6 GB for an emulator once it has been
used, and 22 minutes for a full install. The download itself was not metered; about 2–3 GB is an estimate from the parts (taqwright
reports about 700 MB for the JDK, the command-line tools and Appium, and about 1 GB for the system image, plus the emulator package). Re-running the setup on a computer that already has the emulator recreates
the `taqwright_api34` emulator (taqwright creates it with `--force`), so its saved snapshot is rebuilt on the next run; the Settings
page only offers the download while no emulator is set up.

## The command line alternative

The script is only a convenience. The same setup is `npx @taqwright/taqwright install --with-avd`, run once on the computer that runs the
platform. The Settings page shows this command too.

## Not covered here

Setting up an emulator on a **separate runner computer** is not part of this download — the emulator runs on the platform's own computer.
Phone tests on a real device, or on a runner, are covered by the user guide (Phones and emulators, Phones on a runner).
