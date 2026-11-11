# Runner agent: installing and running it

## What it does for you

The platform normally runs your tests on the computer where it is installed. That is not always where the application is reachable: a staging site on your office network, an app on a laptop, a build that only exists on a test machine, an Android phone on your desk.

The **runner agent** is a small program you start on such a computer. It connects **out** to the platform (it never opens a port and needs no inbound firewall rule), asks for work, runs the tests next to your application and devices, and sends the results back. Each person has one runner, set up once in **Settings, Your runner**; every run, schedule and session that person starts then goes to it (see `runner-agent.md` for the platform side), and everything else looks the same: results, screenshots, traces, evidence and the cleanup ledger appear exactly as for a local run.

The agent runs the platform's own execution code (`runScripts` for web and API tests through the Playwright adapter, `runMobileScripts` for Android through the Taqwright adapter), so a remote run behaves like a local one. The AI work (analysing a site, writing and repairing tests, judging screenshots, healing locators) still runs on the platform; only running the generated scripts moves to the agent.

**This is the developer's way.** Most people download the runner from Settings, Your runner instead: the installer on Windows and a Mac, plain files on Linux, with the platform's address and a one-time code inside, started by double-clicking one file. It runs the same agent described below; see `runner-kit.md`. The rest of this page applies to both.

## What you need

| | |
|---|---|
| A checkout of this repository on the agent computer | The agent is shipped with the platform: `node bin/ai-test-agent.mjs`. It does not need the platform's database, API key or model key. |
| Node.js 24 or newer | Same as the platform. |
| `npm install` done in the checkout | Installs Playwright and the engine the agent reuses. |
| Playwright browsers | `npx playwright install chromium` (add `firefox` and `webkit` for cross-browser checks). Only needed for web tests. API tests need no browser. |
| Android tests only | The Android toolchain and an emulator, or a phone with USB debugging: `npx @taqwright/taqwright install --with-avd`, or an Android SDK on `ANDROID_HOME`. |
| A way to reach the platform | An https address (see "Firewalls and proxies"). |
| A way to reach your application | From this computer, whatever address you put in the project. |

If you start it from a folder that is not a checkout with `@playwright/test` installed, it stops and says so.

## 1. Get a one-time code

In **Settings, Your runner**, download the runner (`POST /api/me/runner/download`). Its `runner.enroll` holds a one-time code (`aite_...`, valid 30 minutes). Start the checkout's agent with `--enroll <code>` once: it trades the code for your one runner credential, keeps it in this computer's credential store and needs no code afterwards. This replaces any runner you had before (one runner per person). Choosing **Remove this computer** in Settings stops the agent with a clear message. A token given with `--token` or `AITP_AGENT_TOKEN` still works for development, but there is no page that makes one any more, and a team or project token is refused.

## 2. Start the agent

Windows (PowerShell):

```powershell
cd C:\path\to\automation-testing
$env:AITP_URL = "https://tests.example.com"
$env:AITP_ENROLL_CODE = "aite_..."   # the first start only
npm run agent -- --name "Maya's laptop"
```

macOS and Linux:

```bash
cd /path/to/automation-testing
export AITP_URL=https://tests.example.com
export AITP_ENROLL_CODE=aite_...   # the first start only
npm run agent -- --name "Build server"
```

`node bin/ai-test-agent.mjs ...` does the same (and is what you use in service definitions: `npm` prints a banner). The agent prints one line per event:

```
2026-10-08T09:12:01.402Z INFO  Capabilities: win32/x64; node v24.1.0; browsers: chromium; Android: adb found, 1 device ready, emulators: Pixel_7
2026-10-08T09:12:01.560Z INFO  Connected to the platform as "Maya's laptop" (agent 3f9a..., project 71c0...).
2026-10-08T09:14:20.118Z INFO  Task 8d2e... started: playwright, 12 scripts.
2026-10-08T09:14:41.906Z INFO  Task 8d2e... finished: 12 results (11 passed, 1 failed), 3 files uploaded.
```

Stop it with Ctrl-C (or SIGTERM). A run in progress is cancelled and reported to the platform as "The agent was stopped." (an infrastructure message, never a failing test), then the agent exits with 0. A second Ctrl-C leaves at once.

### Options

Every option can also be set in the environment. The flag wins.

| Option | Environment | Meaning |
|---|---|---|
| `--url <address>` | `AITP_URL` | The platform's address. |
| `--token <aitg_...>` | `AITP_AGENT_TOKEN` | A credential given by hand (development only; not in --help). |
| `--token-file <file>` | `AITP_AGENT_TOKEN_FILE` | The same from the first line of a file (development only). |
| `--name <label>` | `AITP_AGENT_NAME` | The name shown in Settings. Default: the computer's name. |
| `--concurrency <1-8>` | `AITP_AGENT_CONCURRENCY` | Runs at the same time. Default 1. Mobile runs are always one at a time per computer. |
| `--work-dir <folder>` | `AITP_AGENT_WORK_DIR` | Where task folders and the file cache live. Default: `.agent-work` in the checkout. |
| `--cache-mb <number>` | `AITP_AGENT_CACHE_MB` | Size limit of the file cache (baselines, APKs). Default 2048. Least recently used files go first. |
| `--allow-insecure` | `AITP_AGENT_ALLOW_INSECURE=1` | Accept a plain `http://` platform address that is not on a private network. |
| `--allow-app <program>` (repeatable) | `AITP_ALLOW_APPS` (separated by `;`) | A Windows application that desktop tests may start: a full path or a program name. Nothing is allowed by default. See "Windows desktop apps" below. |
| `--allow-apps-file <file>` | `AITP_ALLOW_APPS_FILE` | The same list in a file, one entry per line (lines starting with `#` are comments). |
| `--allow-custom-scripts` | `AITP_ALLOW_CUSTOM_SCRIPTS=1` | Run hand-written scripts (code people on the project wrote or imported). Off by default. See "Hand-written scripts" below. |
| `--browser <auto\|bundled\|chrome\|msedge>` | `AITP_BROWSER` (or `"browser"` in a kit's runner.json) | Which browser web tests use. Default `auto`: Playwright's Chromium if it is installed, else the computer's Google Chrome, else Microsoft Edge, else Chromium is downloaded once. See [runner-browsers.md](runner-browsers.md). |
| `--help`, `--version` | | |

Exit codes: 0 stopped normally, 1 failed (for example the work folder is unusable), 2 wrong command line, 3 not accepted any more (removed, replaced by another computer, or a team or project runner; the platform's sentence is shown), 4 protocol mismatch (update the agent or the platform), 5 the platform refused this agent.

### The token stays secret

- Prefer the environment variable or `--token-file` (keep that file readable by you only). A token on the command line is visible to other users of the computer in the process list; the agent warns when you do that.
- The agent never prints or logs the token, never puts it in its process title, and does not hand it to the test processes.
- The credentials a run needs (the test accounts, API token) arrive with each task, live only in memory and in the environment of the test process, and are never written to disk by the agent or printed. As a second line of defence every log line and every error text sent back has these values masked.

## Firewalls and proxies

- **Outbound only.** The agent needs to reach the platform on its https port (443 unless you run it elsewhere). Nothing connects to the agent; no inbound rule is needed.
- **Plain http** is accepted only for this computer and private networks (127.x, 10.x, 172.16-31.x, 192.168.x, link-local, `localhost`). For anything else use https or pass `--allow-insecure` knowing the token and the test credentials then travel unencrypted. The agent prints a warning every time it runs that way.
- **Long-poll.** The agent keeps a request open for about 25 seconds waiting for work. Proxies and load balancers must allow idle requests of at least 60 seconds.
- **Corporate proxy.** The agent uses `--proxy <address>`, else `HTTPS_PROXY` / `HTTP_PROXY` (with `NO_PROXY`), else `"proxy"` in runner.json, else on Windows the person's own proxy setting, for its own connections and the programs it starts; tests reach the application directly unless `--proxy-tests` is given. Automatic proxy scripts (PAC) and Windows-only sign-in (NTLM) are not supported. See [company-networks.md](company-networks.md).
- **The application.** The agent reaches your application from its own network, so private and loopback addresses are fine for run targets (the platform's own address guard does not apply to agent runs, while every call the platform makes itself still does).
- **Certificates.** The agent trusts the computer's certificate store as well as Node's own list, so a company root certificate that IT installed works as it is. Otherwise give the file with `--ca-file /path/to/ca.pem` (or `NODE_EXTRA_CA_CERTS`, which keeps working).

## What the agent can and cannot run (protocol 1)

| | Runs? |
|---|---|
| Web tests (Playwright, Chromium, Firefox, WebKit as installed) including cross-browser and screen-size variants, visual baselines, "looks right" screenshots, failure evidence | Yes |
| API tests (Playwright API), including data-changing tests with test-data cleanup | Yes |
| Android tests (Taqwright) on an emulator (AVD) or on a USB or Wi-Fi phone | Yes. Emulator runs use the platform's emulator helper; the phone path is not verified on real hardware yet (see limits). |
| iOS tests (Taqwright on an Xcode simulator) | Yes, on a Mac with Xcode, an iOS simulator and the Appium XCUITest driver. See "Mac with Xcode (iOS tests)" below. Never verified on a real Mac in this build. |
| Recording a test in a browser window on this computer | Yes, with Chromium installed; showing the window needs a display (see below). |
| Windows desktop apps (UI Automation, no extra software) | Yes, on a Windows agent in a signed-in session, only for applications you allow with `--allow-app`. See "Windows desktop apps" below. |
| Analysis, plain-English authoring, repair, healing, "looks right" judging | No: these use the model and the platform's browser and stay on the platform. |

What the agent reports to the platform about this computer (refreshed on every poll, cached for 30 seconds, so a phone plugged in later is noticed): operating system, architecture, Node version, installed Playwright browsers (judged from Playwright's own browser folders, nothing is launched), Android (`adb devices -l`, emulator names), iOS (`xcrun simctl list devices -j`), Windows UI Automation (one short hidden PowerShell run that loads the UI Automation assemblies and reads whether the session is interactive and whether it is elevated; no window is opened). The platform uses this to refuse a run that cannot work ("this agent has no Android device") before it starts.

### Recording a test on this computer

The agent can also host a recording: the project's Recorder opens the browser here, on your screen, so you click through the application where it is reachable. For that the agent needs a Chromium installed for Playwright (`npx playwright install chromium`), and, to show the window, a display: a signed-in Windows or macOS session, or a Linux desktop with `DISPLAY` or `WAYLAND_DISPLAY` set. An agent run as a service, or on a server with no screen, reports that it cannot show the window; the Recorder then says so and offers to record with the window hidden or on another agent. The agent opens http and https addresses only, never reads password fields, and closes the browser it opened when the recording ends, when you discard it, when the platform goes away or when the agent is stopped. A recording uses one of the agent's task slots while it lasts. See "Recording on a runner agent" in `recorder.md`.

### How a task runs

1. A task arrives with its scripts, the environment (addresses, accounts, variables), and references to files (visual baselines, the APK).
2. The agent downloads those files into a cache keyed by checksum, verifies the sha256, and reuses them for later tasks. Cache size is limited; files in use are never removed.
3. It runs the scripts in a separate process with the platform's own adapter code. Cancel (from the platform) or a time-out kills that process and everything it started (browsers, Appium) as a tree.
4. If the project asks for it, it removes the records the tests created, with the platform's own rules: only records this run captured, newest first, one at a time, only on the application's own address, no redirects, "already gone" counts as removed. The outcome per record goes back to the platform's cleanup ledger.
5. It uploads every artifact of the run (screenshots, traces, videos, visual differences, evidence, new baselines, vision shots), checks that the platform stored the same bytes, and posts the result. A file larger than the platform's limit is left out and the test says so in a note; it never fails the run.
6. It deletes the task folder. When the agent starts it also removes anything an earlier, killed run left.

A problem with the machine (Playwright browsers missing, no emulator, the runner crashing, a time-out of the whole task) is reported as "the agent could not run this" with a plain sentence. It is never turned into a failing test.

## Running it as a service

Run it as a normal user (not root or Administrator) that can launch browsers. Put the token in a file only that user can read and use `AITP_AGENT_TOKEN_FILE`.

### Linux (systemd)

`/etc/systemd/system/ai-test-agent.service`:

```ini
[Unit]
Description=AI Testing Platform runner agent
After=network-online.target
Wants=network-online.target

[Service]
User=tester
WorkingDirectory=/opt/automation-testing
Environment=AITP_URL=https://tests.example.com
Environment=AITP_AGENT_TOKEN_FILE=/etc/ai-test-agent/token
Environment=AITP_AGENT_NAME=build-server
ExecStart=/usr/bin/node bin/ai-test-agent.mjs
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now ai-test-agent`. Logs: `journalctl -u ai-test-agent -f`. Headed browsers (a run with "headless" off) need a display; headless runs do not.

### macOS (launchd)

`~/Library/LaunchAgents/com.aitesting.agent.plist` (a LaunchAgent runs in your login session, which iOS simulators and headed browsers need):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aitesting.agent</string>
  <key>WorkingDirectory</key><string>/Users/tester/automation-testing</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>bin/ai-test-agent.mjs</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>AITP_URL</key><string>https://tests.example.com</string>
    <key>AITP_AGENT_TOKEN_FILE</key><string>/Users/tester/.ai-test-agent-token</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/tester/Library/Logs/ai-test-agent.log</string>
  <key>StandardErrorPath</key><string>/Users/tester/Library/Logs/ai-test-agent.log</string>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/com.aitesting.agent.plist`.

### Windows

The simplest dependable way is a **Scheduled Task** that runs at log-on of the test user and restarts on failure:

```powershell
$action  = New-ScheduledTaskAction -Execute "node.exe" -Argument "bin\ai-test-agent.mjs" -WorkingDirectory "C:\automation-testing"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$set     = New-ScheduledTaskSettingsSet -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "AI Test Agent" -Action $action -Trigger $trigger -Settings $set
```

Set `AITP_URL` and `AITP_AGENT_TOKEN_FILE` as user environment variables first (`setx AITP_URL https://tests.example.com`). For a headless server without a log-on, a service wrapper such as NSSM works the same way (program `node.exe`, argument `bin\ai-test-agent.mjs`, startup folder the checkout, the two environment variables). Android emulators and headed browsers need an interactive session, so prefer the Scheduled Task for those.

## Hand-written scripts

People on a project can take a generated test over and edit its script, write a test from scratch, or import tests from a Git repository (see `custom-scripts.md`). Those scripts are **code**, and the agent runs code with the rights of the user who started it: it can read that user's files and reach everything that computer can reach.

- **Off by default.** An agent started without `--allow-custom-scripts` does not report the ability, is never offered a hand-written script, and refuses one with the plain message "This task has hand-written scripts, and this agent was not started with --allow-custom-scripts, so it did not run them." (an infrastructure message, never a failing test). Generated tests run on it as always.
- **Switching it on is your decision.** Start the agent with `--allow-custom-scripts` (or `AITP_ALLOW_CUSTOM_SCRIPTS=1`) only when you trust everyone who can edit tests in the project. The agent prints a reminder at start-up, and the Agents page shows that it accepts them.
- **A second check.** Before it runs a hand-written script or a shared helper, the agent runs the same static guard the platform uses on its own copy. A script that does not pass is not started. The guard catches accidents and obvious escapes; it is not a sandbox, which is why the switch above is the real boundary.
- Helpers (`./helpers/<name>`) are written next to the scripts for that task only and removed with the task folder.

## Windows desktop apps

A Windows agent can run desktop tests (kind "desktop", framework "windows-uia"; see `docs/features/windows-desktop-tests.md`). Things to know before you rely on it:

- **Nothing may start unless you say so.** A test names the application it drives, but the computer decides whether it may start it. List every application with `--allow-app` (a full path such as `C:Program FilesMyAppMyApp.exe`, or a name such as `calc.exe` that is looked up on the PATH and stands for that one file). Matching is on the resolved full path, case-insensitive, no wildcards. An application that is not listed is refused with "This computer isn't set up to start <app>. Add it with --allow-app, then run again." and is never a failing test.
- **Shells and script hosts are never allowed.** `cmd`, `powershell`, `pwsh`, `wscript`, `cscript`, `mshta`, `rundll32`, script interpreters, download tools and similar programs are on a built-in deny-list that wins over your allow-list. The agent prints a note and ignores such an entry.
- **A signed-in, interactive session.** UI Automation needs the desktop of a logged-in user. Run the agent from the Scheduled Task at log-on (above), not as a Windows service, and keep the screen unlocked while tests run. The Agents page says "needs an interactive desktop session" when the agent was started in a session without one.
- **Not as administrator.** The agent and the applications run as a normal user. If the agent is elevated, desktop tests are refused and Settings says so. Reason: an elevated process driven by test text would hand that text administrator power.
- **Your keyboard and mouse stay yours.** Tests act through UI Automation patterns (Invoke, Value, SelectionItem, Toggle) and never send keystrokes or move the cursor. They only look at windows of the process they started.

## Mac with Xcode (iOS tests)

A Mac agent can run iOS tests (framework `taqwright-ios`; see `docs/features/ios-tests.md`). What the Mac needs, and nothing else is required of it:

- **Full Xcode** (not only the command line tools) with its license accepted, and at least one **iOS simulator runtime** (`xcodebuild -downloadPlatform iOS`, or Xcode, Settings, Platforms). `xcrun simctl list devices` should show an iPhone.
- **The Appium XCUITest driver.** `npx @taqwright/taqwright install` in the platform folder on that Mac installs it (and Appium) under Taqwright's own folder; or install it yourself with `appium driver install xcuitest`. `npx taqwright doctor` reports what is in place.
- Start the agent from a normal user session on the Mac (the LaunchAgent above), not as root. No extra option is needed: iOS has no `--allow-...` flag, because a simulator is a throwaway device, like an Android emulator.

The agent reports Xcode, the number of iOS simulators and whether the XCUITest driver was found; Settings and `describeCapabilities` in the agent log say "XCUITest driver found (iOS tests can run)" when everything is there. If something is missing, a run is refused up front with a sentence that names it, and it is never a failing test.

How it behaves on the simulator: the agent uses a simulator that is already running as it is and leaves it running. If none is running it boots one (the project's default simulator by name if set, otherwise the newest iOS version, iPhones before iPads), waits until it has finished starting, runs the tests, and shuts down only that simulator by the id it noted at boot. It never boots, shuts down or erases any other simulator, and never uses `simctl shutdown all`. The app under test must already be installed on the simulator (for example with `xcrun simctl install booted MyApp.app`); the platform does not send an app file for iOS.

## Troubleshooting

| You see | What it means and what to do |
|---|---|
| `ai-test-agent cannot start: @playwright/test was not found` | Run `npm install` in the checkout and start the agent from there. |
| `The platform no longer accepts this runner` (exit 3) | The computer was removed or replaced in Settings, or it was set up for a team or a project. Set up your runner again from Settings, Your runner. |
| `This agent speaks protocol 1 but the platform speaks protocol N` (exit 4) | Update the checkout of the agent (or the platform) so both are the same version. |
| `The platform refused this agent` (exit 5) | The platform said no (the text after it says why), for example another agent already uses that name. |
| `--url must use https://` (exit 2) | Use an https address, or a private-network address, or `--allow-insecure`. |
| `Could not reach <host>: the connection was refused` / `the address could not be found` | Wrong address or no route. The agent keeps trying (1 s growing to 30 s) and says hello again when the platform is back; running tasks are not affected. |
| `the platform's certificate was not accepted` | A private certificate authority or a security tool that re-signs https: install its root certificate on the computer, or start the agent with `--ca-file <file>`. The message says which. Proxy problems (a password, a blocked address, a proxy that is down) have their own sentences: [company-networks.md](company-networks.md). |
| `no Playwright browsers installed` in the capabilities line | The runner now finds an installed Chrome or Edge or downloads Chromium itself (the lines before it say which, see [runner-browsers.md](runner-browsers.md)); `npx playwright install chromium` in the checkout still works. Web tests are refused until a browser is ready. |
| `Chromium could not be downloaded: ...` | The reason follows (a server answer, a proxy, a certificate). Fix the network ([company-networks.md](company-networks.md)) or install Google Chrome or Microsoft Edge, then start the runner again. |
| Settings says the runner is offline | It was not seen for 45 seconds: the agent stopped, lost the network, or a proxy cuts idle requests shorter than about 60 s. |
| `The work folder ... cannot find @playwright/test` | Use a `--work-dir` inside the checkout (the default), or a folder whose parent has the platform's `node_modules`. For other folders the agent links the checkout's `node_modules` into it. |
| A run says `Playwright browsers are not installed on this agent` | The browsers were removed or never installed for this Playwright version. Install them and run again. |
| `The Android device ... is not connected to this agent or is not ready` | Check `adb devices` on the agent: the phone must show `device` (accept the USB debugging prompt), and the cable or Wi-Fi must be up. |
| `The emulator "X" does not exist on this agent` | Create it (`npx @taqwright/taqwright install --with-avd` or Android Studio) or choose another one for the project. |
| `Some files from this run are not attached` in a test's notes | An artifact was bigger than the platform's upload limit or could not be uploaded after three tries; the test result itself is complete. |
| The agent stopped by itself after Ctrl-C and the run shows "The agent was stopped." | That is the graceful stop. Start it again; the platform re-offers nothing for a stopped run, so run the tests again. |
| Disk usage grows under `.agent-work` | The `cache` folder holds baselines and APKs up to `--cache-mb`; `tasks` is emptied after each run. Delete the folder while the agent is stopped to start clean. |

## Limits (honest list)

- Protocol 1 runs Playwright (web, API), Taqwright (Android), Taqwright on iOS simulators (Mac with Xcode only; not verified on real hardware here) and Windows UI Automation (desktop apps) only. WinAppDriver is not used.
- A phone selected by serial is passed to Taqwright through a small entry-point wrapper that sets its device id. This is covered by a test with the stand-in Taqwright command, not by a real phone; the Android emulator path has not been exercised on this build either (tests never start an emulator).
- Mobile runs are serialised per computer by the existing device lock; `--concurrency` above 1 applies to web and API runs.
- A task being run when the agent process is killed hard (power loss, `kill -9`) is not reported by the agent; the platform gives it up when its lease runs out and re-offers it once. A test process left behind by a hard kill of the agent exits by itself when it notices the agent is gone.
- The agent trusts the platform it is pointed at with the credentials of the project's runs. Create tokens only for platforms you operate.
