# Runner browsers: use the browser the computer already has

## What it does for a tester

A runner (see `runner-agent.md`) needs a Chromium-family browser for web tests. It no longer has to download one when the computer already has a good one, and the start scripts and installers no longer download a browser at all: the runner program decides when it starts.

- At start the runner says what it looked for and what it chose, one line per step, for example:
  - `Looking for a browser for web tests (setting: auto, the default).`
  - `Not using Google Chrome at C:\Program Files\Google\Chrome\Application\chrome.exe: Google Chrome 120 is too old: the test tools need version 150 or newer (at most 3 versions behind their own Chromium 153). Update Google Chrome to use it.`
  - `Ready for web tests in Microsoft Edge 155, installed on this computer.`
- The runner's card under **Setup, Runners** says "Web tests run in Microsoft Edge 155, installed on maya-laptop." **Show details** lists the Chrome and Edge it found and, for one it does not use, why.
- Every run on a runner shows one line in its details: "Ran in Microsoft Edge 155, installed on maya-laptop." (or "Chromium 153, downloaded by the runner", or "Chromium 153, the browser that comes with the test tools"). The same sentence is one event of the run.

## The setting

`--browser <choice>` on the runner's command line, else the environment variable `AITP_BROWSER`, else `"browser"` in the kit's `runner.json` (a flag beats the variable, which beats the file). An unknown value is refused at start in plain words.

| Choice | What the runner uses |
|---|---|
| `auto` (default) | Playwright's own Chromium if the revision this Playwright expects is installed, else an installed Google Chrome, else an installed Microsoft Edge, else it downloads Playwright's Chromium. |
| `bundled` | Always Playwright's own Chromium, downloaded when missing. Installed browsers are never used. |
| `chrome`, `msedge` | Only that installed browser. If it is missing or too old the runner says so and does **not** quietly use another one: web tests are refused with "Microsoft Edge is not installed on this computer (looked in the usual install folders). This runner is set to use only Microsoft Edge (--browser msedge). Install it, or start the runner with --browser auto." |

## How it works

- **Finding Chrome and Edge** (`src/engine/browsers/choice.ts`) looks at file paths only, never at running programs: the stable install paths Playwright's own `channel` lookup uses (Windows: `%LOCALAPPDATA%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, then `%HOMEDRIVE%\Program Files` and `(x86)`, each with `Google\Chrome\Application\chrome.exe` or `Microsoft\Edge\Application\msedge.exe`; Mac: `/Applications/Google Chrome.app` and `~/Applications`, Edge likewise; Linux: `/opt/google/chrome/chrome`, `/opt/microsoft/msedge/msedge`, then `/usr/bin/google-chrome-stable`, `google-chrome`, `microsoft-edge-stable`, `microsoft-edge`). The first path that exists is used. Beta, Dev and Canary channels are not looked for.
- **The version** comes from the file system where the system keeps one: on Windows the version-numbered folder next to the program (`Application\155.0.4283.62\`, the newest if there are two), on a Mac the app's `Contents/Info.plist` (`CFBundleShortVersionString`). Only on Linux, and on a Mac without a readable plist, the program is asked `--version` (5 seconds at most; it prints and exits). On Windows the program is never run. A browser whose version cannot be read is not used.
- **The age rule:** an installed browser may be at most 3 major versions older than the Chromium of the installed Playwright (`browsers.json`; 153 for Playwright 1.63, so 150 or newer). Newer versions are always accepted. The reason: Playwright drives the browser through the DevTools protocol of its own Chromium, and Microsoft supports the current stable and beta channels, which are normally within a version or two of it.
- **Playwright's own Chromium counts as present** when `chromium-<rev>` and `chromium_headless_shell-<rev>` of the expected revision are complete (Playwright's `INSTALLATION_COMPLETE` marker) in Playwright's browser folder (`PLAYWRIGHT_BROWSERS_PATH` or the usual per-user cache).
- **Downloading** (`src/agent/browser-setup.ts`) runs Playwright's own installer (`node <playwright-core>/cli.js install chromium`, or `firefox` / `webkit`) as a child process of the runner, with the runner's environment minus its own `AITP_*` settings (so never the token), plus any proxy or certificate variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`, `NODE_USE_ENV_PROXY`) that the company-network setup exported into the runner's process (`company-networks.md`). Playwright's installer honours them. It prints "Chromium download: 25% of 150.2 MiB." at each quarter, "Downloaded Chromium." at the end. A Chromium download starts at start-up in the background: the runner connects meanwhile, reports no Chromium (with the sentence "The runner is downloading Chromium for web tests."), and reports it as soon as it is ready. A runner remembers in its work folder (`browser-downloads.json`) that it downloaded that revision, so a later start still says "downloaded by the runner".
- **Caps:** a download is stopped after 15 minutes (`AITP_BROWSER_DOWNLOAD_MINUTES`, 1 to 120); only the installer process the runner started is stopped, by its handle. On failure the reason is the installer's own line that names the cause (a server answer, a proxy, a certificate), with any `user:password@` in addresses replaced by `***:***@` and secrets the runner knows masked: "Chromium could not be downloaded: Download failed: server returned code 407 ...".
- **Firefox and WebKit** are needed only by "Ran on other browsers" runs. When such a run arrives the runner reads Playwright's device list to see which engines its variants use, downloads a missing one once (runs that need it at the same time wait for the same download), and runs. If it cannot be downloaded the run ends as a runner problem: "This run needs WebKit, and the runner could not download it (...). Check this computer's internet connection or proxy, then run it again. Runs in Chromium are not affected." It is never a failing test.
- **Using the choice everywhere the runner opens a browser:**
  - Task runs of generated and code tests: the run's Playwright config (written next to the scripts, never the test file a person sees) gets `channel: "msedge"` and `launchOptions: { executablePath: "<the exact program found>" }`. The exact program wins over the channel, so the test process does not depend on seeing the same environment variables as the runner. With variants, only Chromium-based device profiles get it; Firefox and WebKit variants keep their own engine. With Playwright's own Chromium the config is byte-for-byte what it was before (the channel-less path).
  - Recordings and live sessions (the recording process, `record-child.ts`) open the same browser.
  - API-only tasks open no browser and report none.
  - The platform server keeps its own Chromium; nothing changes there.
- **Fixed on the way:** a "Ran on other browsers" run on a runner used to be refused by the runner itself ("The test runner returned 2 results for 1 scripts."), because it expected one result per script, not one per script and variant. It now expects one per script and variant.

## Protocol (additive, version stays 1)

- `Capabilities.browser?: { name: "chromium" | "chrome" | "msedge", version?, source: "installed" | "downloaded" | "bundled" }`: what web tests use, once ready.
- `Capabilities.installedBrowsers?: Array<{ name: "chrome" | "msedge", version?, usable, reason? }>` (at most 4; never a path).
- `Capabilities.browserNote?: string`: one sentence while no browser is ready.
- `ResultRequest.browser?`: the same shape as `Capabilities.browser`, for web runs.
- `Capabilities.browsers` now contains `chromium` when an installed Chrome or Edge is used, and leaves it out when the setting asks for a browser the computer does not have. The platform's refusal then reads "it has no browser ready (<the note>)".
- Platform: the result's browser becomes a run event (kind `agent_browser`, data `{ browser }`), and job objects' `ranOn` gains `browser` for agent runs (read from that event, so it outlives the task, which is pruned after 24 hours). `GET /api/projects/:id/agents` passes `browser`, `installedBrowsers` and `browserNote` through. An older runner reports none of these and every answer stays as it was.

## Tested here (Windows 11 laptop)

- `tests/runner-browsers-unit.test.ts` (21, fast tier): install paths per system, the version from Windows version folders (the program is never run), a Mac Info.plist, and a fake Linux browser that answers `--version`; the age rule; the policy order; the setting's precedence; the run config with and without an installed browser; the engines of variants; the capability report; the plain sentences; the runner's own decision against fake installs laid out under a temporary folder.
- `tests/runner-browsers-download.test.ts` (5, under the lock): Playwright's real installer against a local fake download host (tiny fake archives): Chromium downloaded once and then used, a refused download, a download stopped at its time limit (the installer's connection closes), Firefox downloaded once for two runs asking at the same time, a failed WebKit download as a plain runner problem, and the installer's environment (proxy variables yes, the token and `AITP_*` no).
- `tests/runner-browsers.test.ts` (4, under the lock): the real runner and real browsers: a web test in Playwright's real Chromium through the channel-less path; the same kind of test through this laptop's installed **Microsoft Edge 155** with `--browser msedge` (the page sees `Edg/`); a variants run where the Chromium variant runs in Edge (the browser's `sec-ch-ua` names Microsoft Edge even under a device profile) and the Firefox variant in Firefox; a recording opened in Edge. Parts whose browser is missing are skipped with the reason.
- `tests/runner-browsers-platform.test.ts` (5): the runner list, the refusal sentence, the run event and `ranOn.browser`, an older runner unchanged, an unknown browser refused.
- `tests/runner-browsers-ui.test.ts` (2): the run details line and the runner card in a real browser, axe-clean in light and dark, no sideways scroll at 375 px.

## Limits (what is not covered)

- **Never run on a real Mac or a real Linux machine.** The Mac plist and the Linux `--version` paths are tested with fake installs and a fake browser only; Chrome or Edge on those systems has not been launched by this code here. RM's CI matrix runs the runner on GitHub's Mac and Linux machines (which have Chrome and Edge preinstalled, so "no browser" is simulated).
- Installed Google Chrome was not used for a run here (only Edge); its path and version folder were read in the same way.
- Only the stable channels are looked for; Chrome for Testing, Chromium from a Linux distribution, snap or flatpak installs, and portable copies elsewhere are not found (use `--browser bundled` or install a stable channel).
- A real Chromium, Firefox or WebKit download from Playwright's servers was not done in tests (local fake host only). Linux may need system libraries for a downloaded browser (`npx playwright install-deps`, administrator rights); the runner does not install them.
- The age rule is a rule of thumb, not a guarantee: a much newer Chrome can in principle change behaviour Playwright relies on.
- Without `--browser`, a computer that has Playwright's Chromium keeps using it (it is the browser the platform's own tests run in), even when Chrome or Edge is installed.

## Failure videos in an installed browser

Playwright records a failure video with its own small video tool (ffmpeg), whatever the browser. A runner that uses the computer's
installed Chrome or Edge has never downloaded Playwright's browsers, so that tool is usually missing, and without it every test failed
at its first page ("Executable doesn't exist at …/ffmpeg-…"). Now the runner checks for the tool when it chooses an installed browser
(`ffmpegReady` in `src/engine/browsers/choice.ts`). When it is missing, tests run without failure videos (`video: "off"` in the run's
config; screenshots and traces are kept as before), the runner says so, and it fetches the tool in the background (about 2 MB, once).
From the next run on, failure videos are kept again. Found by the first run of `.github/workflows/runner-matrix.yml` on GitHub's
Windows and macOS machines.
