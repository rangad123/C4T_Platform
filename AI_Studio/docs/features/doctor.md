# Doctor: a preflight check for a new machine

## What it does for a person
`npm run doctor` looks at the computer it runs on and says, in plain sentences, whether the platform can run here and which kinds of test will work. Each line starts with a status, then says what the thing is for, and for anything that is not fine, how to fix it:

```
ok        Node.js 24.19.0, needs 24 or newer
          For: Runs the platform, the command line and the runner agent.
missing   Chromium is not installed
          For: Runs every web test, and takes the screenshots in reports.
          To fix: Run `npx playwright install chromium`.
optional  git is not installed
          For: Imports hand-written tests from a Git repository.
          To fix: Install git from https://git-scm.com, then open a new terminal. Only needed for Git import.

1 required thing is missing. Fix it and run this check again.
```

- **ok**: fine. **missing**: required, and the exit code is 1. **optional**: only matters if you need that kind of test; it never changes the exit code.
- What it checks, in order: Node.js against `engines.node` in `package.json`; installed dependencies (Playwright); the Chromium browser (required) and Firefox and WebKit (optional, for cross-browser runs); TypeScript (the hand-written script guard needs it); git (optional, for Git import); whether a `.env` file exists; whether the settings that are set can be read by the platform (by name only); whether an AI provider key is set for the chosen provider (optional, because API tests from an OpenAPI file work without one); `API_KEY` when `HOST` is not a local address (required then); whether the data folder (`DATA_DIR`) can be written; whether the configured port (`PORT`) is free; the web build (`web/dist`, optional); the Android toolchain (optional: the same check the platform uses before a mobile run, plus whether `adb`, Java and `ANDROID_HOME` are found); Xcode (optional, Macs only); Windows PowerShell for desktop tests (optional, Windows only); and in words, whether hand-written scripts may run on this computer (`ALLOW_CUSTOM_SCRIPTS`) and how many applications desktop tests may start (`DESKTOP_ALLOWED_APPS`).
- Exit code 0 means ready to run (optional items may still be open), 1 means something required is missing, 2 means the check itself failed. `npm run doctor -- --help` shows the usage.
- On a computer that only runs a runner agent, the lines about the AI key, the port and the web build do not matter (the agent needs none of them); `runner-agent-setup.md` lists what the agent needs. There is no separate agent mode.

## How it works
`src/cli/doctor.ts` holds pure check functions (`runChecks`) that read everything about the computer through a `Probes` object, so tests can feed a fake computer. `realProbes()` is the only code that touches the machine. The npm script runs it with `tsx --env-file-if-exists=.env`, the same way the other scripts load settings.

## What it will not do
- It starts no browser, emulator, simulator or server. Whether a browser is installed is answered from the file Playwright would launch, without launching it; programs on `PATH` are found by looking for the file, without running them.
- It never prints the value of a setting, only "set" or "not set", or the name of a setting that is wrong. It does not read `.env`; it only asks whether the file exists.
- It touches nothing it did not create. The only writes are one temp file inside the data folder, created and removed at once, and a bind of the configured port for a moment. If the data folder does not exist yet, it is not created: the nearest existing parent is checked instead.

## Limits
- It cannot see everything: a locked Windows session, a screen reader, a full disk, or a firewall are not checked. A port that is free now can be taken a second later.
- If the platform itself is already running on the configured port, the port line says it is in use and explains that this is fine when it is the platform.
- The Android check says what the platform's own check says; it does not start an emulator, so it cannot prove one boots.
- iOS and desktop lines on the wrong operating system are listed as optional with a hint to use a runner agent on the right computer.
- Tests: `tests/doctor-unit.test.ts` (fake computers, fast tier) and `tests/doctor.test.ts` (spawns the real program with secrets in the environment and in a `.env`, a temp data folder and a held port).
