# Admin guide

For the person who installs, configures and runs the platform. Testers and product managers do not need this: they read the [user guide](USER_GUIDE.md). The calls other programs can make are in the [API reference](API_REFERENCE.md).

## Contents

1. [Install and start](#1-install-and-start)
2. [Settings (`.env`)](#2-settings-env)
3. [Safety switches](#3-safety-switches)
4. [Check a new machine (doctor)](#4-check-a-new-machine-doctor)
5. [Mobile, desktop and iOS tests](#5-mobile-desktop-and-ios-tests)
6. [Runner agents (tests on another computer)](#6-runner-agents-tests-on-another-computer)
7. [Pipelines and the command line (`ai-test`)](#7-pipelines-and-the-command-line-ai-test)
8. [Deploy trigger](#8-deploy-trigger)
9. [Use the platform from an AI tool (MCP)](#9-use-the-platform-from-an-ai-tool-mcp)
10. [Alerts: mail server and addresses](#10-alerts-mail-server-and-addresses)
11. [Storage, retention and backup](#11-storage-retention-and-backup)
12. [AI usage limits](#12-ai-usage-limits)
13. [Plug-in frameworks](#13-plug-in-frameworks)
14. [Test file format (JSON import)](#14-test-file-format-json-import)
15. [Run downloaded tests outside the platform](#15-run-downloaded-tests-outside-the-platform)
16. [Troubleshooting that needs a terminal](#16-troubleshooting-that-needs-a-terminal)
17. [Known limits](#17-known-limits)
18. [Where the deeper technical documents are](#18-where-the-deeper-technical-documents-are)
19. [Page addresses (for links)](#19-page-addresses-for-links)
20. [Production hosting (deployment)](#20-production-hosting-deployment)

---

## 1. Install and start

**Requirements:** Node.js 24 or newer, and an AI service key for web testing. Testing an API alone works without a key.

```bash
npm install
npx playwright install chromium
cp .env.example .env        # add your AI service key (see section 2)
npm run build:web
npm run build:runner        # only if people will download the runner kit (section 6)
                            # add  -- --complete  for the downloads that bring their own Node.js (needs the internet once)
npm start                   # → http://127.0.0.1:4000
```

**Docker:** `docker compose up --build`. Configure `.env` first. Set `API_KEY`, because the container is exposed. The image runs web and API testing. It does not include the Android tools, so run mobile tests on a computer that has the platform installed directly. It has only the Chrome browser, so the Firefox and Safari checks show as unavailable there.

**Run the worker separately:** set `WORKER_EMBEDDED=false`, then start `npm run worker` next to the server.

**Mobile tests (optional):** see [section 5](#5-mobile-desktop-and-ios-tests).

**Other browsers (optional):** `npx playwright install firefox webkit`.

## 2. Settings (`.env`)

### AI service

| Provider | Settings |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY=...` |
| OpenAI | `LLM_PROVIDER=openai`, `OPENAI_API_KEY=...` |
| Google | `LLM_PROVIDER=google`, `GOOGLE_GENERATIVE_AI_API_KEY=...` |
| OpenRouter / local model | `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL=...`, `LLM_API_KEY=...`, `LLM_MODEL=...` |

`LLM_MODEL` overrides the model for any provider. Restart the server after you change the key. The **Settings** page in the web app shows whether a model is set up and which one.

Reliability ([ai-model-reliability.md](features/ai-model-reliability.md)): failed AI requests are retried with backoff (honouring the provider's Retry-After), a provider failing 5 times in a row is paused for a minute, and fallback models are asked when the main one is unavailable or out of credit. `LLM_FALLBACK_MODELS` (for example `claude-haiku-4-5, openai:gpt-5.4`; a list saved in Settings wins), `LLM_RETRY_ATTEMPTS` (6), `LLM_TIMEOUT_MS` (120000, one request), `LLM_CALL_DEADLINE_MS` (600000, one call with retries and fallbacks). A fallback on another provider needs that provider's own key variable.

Prompt caching ([prompt-caching.md](features/prompt-caching.md)): on by default. Repeated instructions, tool descriptions and an agent's conversation are marked for the provider's prompt cache (Anthropic directly, and Anthropic models on OpenRouter; OpenAI and Google cache on their own). `LLM_PROMPT_CACHE=off` turns it off; the switch in Settings, AI model wins. Cached tokens are listed in AI usage and count at 0.1 (reads) and 1.25 (writes) toward the token limits.

Fast model for routine steps ([model-routing.md](features/model-routing.md)): `LLM_MODEL_FAST` (`[provider:]model`, empty by default = the main model does everything) takes the web agent's steps, the phone exploration's turns and plain-English API choices; understanding, planning, repairs and images stay on the main model (`LLM_MODEL_FAST_IMAGES=true` lets images go to the fast one). A fumbled step (unusable answer, the same action failing twice, repeating itself, no progress) hands the rest of that test to the main model; hand-overs are in the job's activity and counted in AI usage. A value saved in Settings, AI model wins. A fast model on another provider needs that provider's key variable.

### Other settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `4000` / `127.0.0.1` | Where the server listens |
| `API_KEY` | none | Require `x-api-key` on all API calls. **Set it on any shared host.** |
| `SECRET_KEY` | auto-generated | Encrypts stored credentials |
| `DATA_DIR` | `./data` | Database and generated tests |
| `CONCURRENCY` | `3` | Parallel test authoring and validation |
| `MAX_REPAIR_ATTEMPTS` | `2` | Automatic fix attempts per failing test |
| `WORKER_EMBEDDED` | `true` | `false` plus `npm run worker` runs the worker separately |
| `BLOCK_PRIVATE_TARGETS` | `false` | Refuse localhost and private-network targets (hosted setups) |
| `HEADLESS` | `true` | `false` shows the browser while tests are authored and run |
| `SCHEDULER_ENABLED` | `true` | Run scheduled tests |
| `SCHEDULER_TICK_MS` | `30000` | How often the scheduler looks for due schedules |
| `PUBLIC_URL` | request host | Address of this platform as people reach it. Alert and issue messages link back to it, and the runner kit tells its runner to connect here. Set it to the https address when the platform is behind a tunnel or proxy |
| `ALERT_MIN_SEVERITY` | `low` | Lowest finding severity that triggers alerts (a channel can override it) |
| `MOBILE_AVD` | first emulator found | Emulator for mobile tests |
| `PHONE_EXPLORER` | `map` | How a phone exploration chooses its actions: `map` maps the app screen by screen and asks the AI only where it pays (forms, when stuck, naming screens); `ai` lets the AI choose every action (the earlier explorer: slower, many more AI calls). See docs/features/phone-ai-tests.md |
| `MOBILE_KEEP_EMULATOR` | `false` | Leave the emulator running after a job (faster next run, holds about 2 GB) |
| `DESKTOP_ALLOWED_APPS` | none | Programs Windows desktop tests may start on this computer (see section 5) |
| `ALLOW_CUSTOM_SCRIPTS` | `false` | Allow code tests to run on this computer (see section 3) |
| `ALLOW_ADAPTER_PLUGINS` / `ADAPTER_PLUGINS` | off / none | Load plug-in frameworks (see section 13) |
| `AI_MONTHLY_TOKEN_LIMIT` / `AI_JOB_TOKEN_LIMIT` | none | Default AI usage limits (see section 12) |
| `RETENTION_DEFAULT_DAYS` | off | Default retention for projects with no policy of their own (see section 11) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | none | Mail server for email alerts (see section 10) |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | none | Company proxy for the server's own outbound calls (AI model, webhooks and notifications, issue trackers). Its own addresses are always reached directly. Email does not use it. A password in the address is never printed (`http://user:***@host:port`) |
| `AITP_SYSTEM_CA` | on | The server trusts its computer's certificate store as well as Node.js's own list, so a company security tool's root certificate installed there works. `0` turns it off. `NODE_EXTRA_CA_CERTS` keeps working. See [company-networks.md](features/company-networks.md) |

Live-update tuning variables (`STREAM_*`) exist for tests and rarely need a change. They are listed in [live-stream.md](features/live-stream.md).

## 3. Safety switches

Four switches decide what the platform may do. Each is off or restrictive by default.

| Switch | What it does | Rule |
|---|---|---|
| `API_KEY` | Every API call needs the `x-api-key` header. | Set it on any shared host, and whenever `HOST` is not a local address. The web app asks for the key once under **Settings → Access to this platform**. The two switches below do nothing unless an `API_KEY` is also set. |
| `BLOCK_PRIVATE_TARGETS` | Refuses addresses on localhost and private networks, for the platform's own calls (tests, alerts, issue trackers). | Turn on for hosted setups. A runner agent reaches your application from its own network, so this guard does not apply to runs on an agent. |
| `ALLOW_CUSTOM_SCRIPTS` | Lets code tests (written, imported from Git, or taken over from a generated test) run on the platform computer. | Off by default. A code test is arbitrary code that runs with the rights of the platform. It has no effect without `API_KEY`. Never turn it on for authors you do not trust: the check before saving catches mistakes, it is not a security boundary. A runner agent allows code tests only when started with `--allow-custom-scripts`. |
| `ALLOW_ADAPTER_PLUGINS` | Loads plug-in frameworks listed in `ADAPTER_PLUGINS`. | Off by default, and any value other than the word `true` is off. A plug-in runs with the full power of the platform process, so load only plug-ins you wrote or reviewed. It has no effect without `API_KEY`. |

Also set in the platform, not in `.env`:

- A production environment is read-only and needs a confirmation on every run.
- A runner agent allows Windows programs only from its own list (`--allow-app`), and code tests only with `--allow-custom-scripts`.

More: [custom-scripts.md](features/custom-scripts.md), [adapter-plugins.md](features/adapter-plugins.md).

**People and accounts.** With `API_KEY` set, the key holder creates the first owner under **Settings → People**; from then on people sign in with their own email and password (or single sign-on) and have a role (Owner, Editor, Viewer). The key stays an owner-level key for scripts, the MCP server, `ai-test` and runner kits; runner and deploy-trigger tokens are unchanged. Set `PUBLIC_URL` to the https address people use (invite links and the single sign-on redirect use it, and the session cookie becomes Secure); behind a TLS proxy without `PUBLIC_URL`, set `COOKIE_SECURE=true`. Without `API_KEY` and without accounts the platform stays open to anyone who reaches the port, including creating the first owner, so set `API_KEY` before exposing it. More: [people-and-access.md](features/people-and-access.md).

**Client logins limited to their projects.** Under **Settings → People** an owner can set a person to **Only these projects** with a role in each (never above their own role). The server then answers 404 for anything of another project (projects, tests, runs, screenshots, recordings, security applications, assessments and findings) and lists only their projects; their API tokens are limited the same way. Platform-wide settings (people, Activity, single sign-on, storage, AI usage and budgets, evaluation, new projects, restoring backups) need access to all projects. Every existing person keeps access to all projects after the upgrade (migration 32). The last active owner with access to all projects cannot be limited or demoted. More: [people-and-access.md](features/people-and-access.md#per-project-access-projects-a-person-may-see).

## 4. Check a new machine (doctor)

```bash
npm run doctor
```

It checks the computer it runs on and says, in plain sentences, what is ready (**ok**), missing (**missing**, required) or optional (**optional**), and how to fix each gap. It looks at Node, the Playwright browsers, `typescript`, `git`, the settings, the data folder, the port, and the optional Android, Xcode and Windows tools.

- Exit code 0 means ready (optional items may still be open), 1 means something required is missing, 2 means the check itself failed.
- It never prints secret values (only "set" or "not set") and never starts a browser, emulator or server.
- On a computer that only runs a runner agent, the lines about the AI key, the port and the web build do not matter.

More: [doctor.md](features/doctor.md).

## 5. Mobile, desktop and iOS tests

### Android

Android tests run on an emulator, against an app you choose. You write them (import them as test files, see section 14). The AI does not explore native apps.

1. **One-time setup** on the computer that runs the platform (about 2 GB):

   ```bash
   npx @taqwright/taqwright install --with-avd     # JDK, Android SDK, Appium and an emulator
   ```

   **Settings → Mobile testing** shows *Ready* when it worked, or what is missing. The emulator needs roughly 2 to 3 GB of free memory. Close heavy programs first if the computer is tight on memory.

2. **Choose the app.** In a project: **Setup → Mobile app → Change**. Enter the app's **package** (for an app already on the emulator, for example `com.android.settings`) and/or upload an **.apk** to install first. A project can be mobile-only, with no web address.

3. **Import mobile tests** (Tests → **New test** → **Import tests…**). See the example in section 14.

On Android, locators match like this: `text` is the visible text, `label` is the content description, `testId` is the resource id, `placeholder` is an input's hint, and `role` is the control type (button, textbox and so on). `navigate` opens a deep link.

What to expect: when the app's package is set, each test starts from the app's first screen (the app is stopped and reopened). The platform starts the emulator for the run and shuts it down afterwards. The first start is a full boot (a few minutes). Later runs start from a saved snapshot (a minute or two per run). A failed test shows the failing step, a screenshot, a video and a trace. If you already have the emulator running, it is used and left running. Set `MOBILE_KEEP_EMULATOR=true` to leave it running after a job.

### Windows desktop apps

Desktop tests drive a Windows program through the built-in Windows UI Automation. They come from imported tests and run on a Windows computer that is logged in and unlocked, not run as administrator: the platform computer if it runs Windows, or a runner agent on Windows.

- Every computer keeps an **allow-list of programs it may start**. Set `DESKTOP_ALLOWED_APPS` in `.env` on the platform (full paths or program names, separated by `;`, for example `C:\Windows\System32\calc.exe;C:\Program Files\MyApp\MyApp.exe`). On an agent use `--allow-app <path to the .exe>`.
- A program not on the list is refused with a plain message and is never reported as a failing test.
- Shells and script hosts (cmd, PowerShell, wscript and similar) can never be started, whatever the list says.

More: [windows-desktop-tests.md](features/windows-desktop-tests.md).

### iOS

A mobile test with `platform: "ios"` runs through Taqwright on a runner agent on a Mac with Xcode, an iOS simulator and the XCUITest driver. The platform computer never runs iOS tests. Without a capable agent a run is refused up front with the reason. The app (its bundle id) must already be installed on the simulator. This path has been tested only with stand-ins for Xcode and Taqwright, not on a real Mac. Read the first section of [ios-tests.md](features/ios-tests.md) before you rely on it.

## 6. Runner agents (tests on another computer)

By default tests run on the server that hosts the platform. A **runner agent** is a small program you start on another computer so tests run there: next to an application that is reachable only from your network, on a machine with real browsers, or with a phone plugged in by USB. In the web app this computer is called a *runner*.

**The easy way: the runner kit.** In the project, open **Setup → Runners → Add a runner**, type a name, choose Windows or macOS/Linux and download the zip. The person unzips it on the other computer and starts it with one of the three files that are in every kit (`start-runner.cmd` on Windows; on a Mac or Linux `sh start-runner.sh` from Terminal, or `start-runner.command` by right-click, Open). The scripts look for Node.js 24 or newer on the PATH, in the usual install folders, in nvm, fnm and Volta, and in the login shell, use the first one that is new enough, and say which; see `docs/features/runner-kit.md`. No checkout of the platform, no typing of the address or the token. With the plain files the computer needs Node.js 24 or newer, and the first start installs the test tools (it needs the internet); the **complete download** below needs neither. No start script or installer downloads a browser any more: the runner uses Chrome or Edge from the computer, or downloads a browser once. The zip contains a new project token, so it is a secret: it should be deleted once the runner is online, and the token can be revoked under **Runners**.

Two things to do on the server for this to work:

- Build the runner once: `npm run build:runner` (writes `dist/runner/`, git-ignored; the Docker image does it for you). `npm start` does not build it. Without it the download answers 503 with "The runner kit has not been built on this server. Run `npm run build:runner`." Build it again after you update the platform, so runners and platform stay on the same version.
- **Runners update themselves from that build.** A runner downloaded from this version on sees the new build at its next poll, finishes its running tests, downloads the five program files (and, for a complete download, the changed test tools from the complete build, so run `--complete` too when the test tools changed), checks every file and restarts. A project owner can switch it off per runner (Setup, Runners, **Update automatically**) and use **Update this runner** instead. The per-runner setting is kept in `runner-updates.json` in the data folder (include it in backups of the data folder). Details: [runner-updates.md](features/runner-updates.md).
- Set `PUBLIC_URL` to the https address people use. A runner refuses plain `http://` for anything that is not on the same computer or a private network, and without `PUBLIC_URL` the platform can only guess the address from the page request (the page warns when the guess will not work).

**The installer (build and host it).** The download also offers an **Installer**: a Windows setup program (`AITestingRunnerSetup.exe`) and a Mac app that check what the computer already has and only download what is missing (Node.js, the test tools, the browser). Build it with `npm run build:installer`. The Windows program is compiled with `csc.exe`, the C# compiler that comes with Windows, so it can only be built on a Windows computer; the Mac app is plain files and builds anywhere. The result is `dist/installer/` (git-ignored; do not commit it). The platform loads it for each download and checks every file against `manifest.json`; a missing or damaged part makes that download fall back to the plain files kit, and the panel says so. To serve the Windows installer from a Linux server or the Docker image, either build on Windows and copy `dist/installer/` to the server and set `RUNNER_INSTALLER_DIR` to it, or put the exe at `installer/prebuilt/AITestingRunnerSetup.exe` before `docker build`. The program is **not signed**: Windows SmartScreen shows "unknown publisher" the first time. Signing needs a code-signing certificate you buy; see [runner-installer.md](features/runner-installer.md) for what to run. People who prefer a script can choose **Plain files** in the panel.

**The complete download (build it once).** `npm run build:runner -- --complete` (or `--complete --targets win-x64,mac-arm64` for fewer) also builds, for each of `win-x64`, `win-arm64`, `mac-arm64`, `mac-x64`, `linux-x64` and `linux-arm64`, a download that holds its own Node.js (one pinned version) and every test tool, so the tester installs nothing. It needs the internet once: it fetches each Node.js from `https://nodejs.org/dist/`, checks it against the published `SHASUMS256.txt`, keeps it in `dist/runner-cache/`, and writes `dist/runner-complete/` (both git-ignored). Each download is about 56 to 70 MB; all six take about 400 MB of disk. The Docker image builds all six (`--build-arg RUNNER_COMPLETE_TARGETS=none` or a shorter list to save space). A target that was not built is offered as "not prepared on this server" and its download answers 503 with the command to run. Build it again when the pinned test tools change (after `npm ci` with a new Playwright, for example): until then those downloads say they were built for other versions. `RUNNER_COMPLETE_DIR` points the server at a build made elsewhere. Details: [runner-complete-kit.md](features/runner-complete-kit.md).

The full description (what is inside, security, limits) is in [runner-kit.md](features/runner-kit.md).

**Check a runner download on a computer.** `node scripts/smoke-runner.mjs` does what a tester does, on the computer it runs on: it starts the platform on a temporary data folder and the sample app, downloads a runner through the platform's own route (`--kit files`, `installer` or `complete`), unpacks it, starts it the way the README says, runs one web test and one API test on it, revokes it and checks the runner ends with the plain message. It prints a short report and exits 0 (passed, or skipped with the reason, for example when the complete download was not built) or 1. It stops only the programs it started. GitHub runs it on Windows, macOS and Linux, on Intel/AMD and ARM, on every push to main (`.github/workflows/runner-matrix.yml`). What each check proves and what it cannot: [real-machine-checks.md](features/real-machine-checks.md).

**By hand, from a checkout.** This is what developers and servers that already have the repository use.

1. In the project, open **Setup → Runners** and create a token. It starts with `aitg_`, is shown once, belongs to that project only and can be revoked.
2. On the other computer, check out the platform, run `npm install` and `npx playwright install chromium`, then start the agent. Windows (PowerShell):

   ```powershell
   cd C:\path\to\automation-testing
   $env:AITP_URL = "https://tests.example.com"
   $env:AITP_AGENT_TOKEN = "aitg_..."
   npm run agent -- --name "Maya's laptop"
   ```

   macOS and Linux:

   ```bash
   cd /path/to/automation-testing
   export AITP_URL=https://tests.example.com
   export AITP_AGENT_TOKEN=aitg_...
   npm run agent -- --name "Build server"
   ```

   The command the page gives you is the same program: `node bin/ai-test-agent.mjs --url <platform address> --token <token>`.
3. The agent connects **out** to the platform, so no port needs opening. It reports what it can run (browsers, Android devices and emulators), then you choose the runner for the project.

Only running the scripts moves. Exploration, plain-English authoring, repair and AI judgement still run on the platform. Web, API and Android tests, recording, Windows desktop apps and iOS (on a Mac) run on an agent. If no suitable agent is online, a run is refused with a plain reason instead of waiting.

Main options (every one can also be set by an environment variable; the flag wins):

| Option | Environment | Meaning |
|---|---|---|
| `--url <address>` | `AITP_URL` | The platform's address |
| `--token <aitg_...>` | `AITP_AGENT_TOKEN` | The agent token |
| `--token-file <file>` | `AITP_AGENT_TOKEN_FILE` | Read the token from the first line of a file (safer than a flag) |
| `--name <label>` | `AITP_AGENT_NAME` | The name shown for the runner. Default: the computer's name |
| `--concurrency <1-8>` | `AITP_AGENT_CONCURRENCY` | Runs at the same time. Default 1. Mobile runs are always one at a time |
| `--allow-app <program>` | `AITP_ALLOW_APPS` (separated by `;`) | A Windows program desktop tests may start |
| `--allow-custom-scripts` | `AITP_ALLOW_CUSTOM_SCRIPTS=1` | Run code tests. Off by default |
| `--proxy <address>` | `HTTPS_PROXY` / `HTTP_PROXY` (then `"proxy"` in runner.json, then the Windows proxy setting) | Company proxy for the runner's own connections; `none` connects directly. A password in it is never shown or sent to the platform |
| `--proxy-bypass <list>` | `NO_PROXY` | Addresses reached without the proxy |
| `--proxy-tests` | `AITP_PROXY_TESTS=1` | Send the browser and the tests' API calls through the proxy too (default: directly) |
| `--ca-file <file>` | `AITP_CA_FILE` | A company certificate file to trust, besides the computer's certificate store |

Other options (`--work-dir`, `--cache-mb`, `--allow-insecure`, `--allow-apps-file`), exit codes, firewalls and proxies, running the agent as a service on Linux, macOS and Windows, and troubleshooting are in [runner-agent-setup.md](features/runner-agent-setup.md). The platform side and its security are in [runner-agent.md](features/runner-agent.md).

Notes:

- Recording a test on a runner needs a display on that computer (a signed-in Windows or macOS session, or a Linux desktop). If the runner goes quiet for 45 seconds the recording stops and the steps so far are kept.
- Stop the agent with Ctrl-C. A run in progress is cancelled and reported as "The agent was stopped."
- Prefer the environment variable or `--token-file`. A token on the command line is visible to other users of the computer.
- Plain `http://` platform addresses are accepted only on private networks. Use https otherwise.
- The agent needs the outbound https port only. Proxies must allow idle requests of at least 60 seconds.
- On a company network the runner finds the proxy by itself (the variables, runner.json, or the Windows proxy setting) and trusts the computer's certificate store; when the network is the problem (a proxy that wants a password, a blocked address, a security tool's certificate) its window and its row under **Runners** say which and what to do. Automatic proxy scripts (PAC) and Windows-only proxy sign-in (NTLM) are not supported. See [company-networks.md](features/company-networks.md).

## 7. Pipelines and the command line (`ai-test`)

```bash
npm run ai-test -- run --specs tests/ai-tests.json --url http://localhost:3000 --fail-on high --junit results.xml --sarif results.sarif
```

Export your project's tests once (**Tests → More actions → Export… → Export as JSON**, or `ai-test export`), commit the file, and replay it on every build. Replay uses no AI and gives the same result every time.

- **Exit codes:** `0` the gate passed. `1` a finding at or above `--fail-on` (default `high`), or a broken test. `2` a usage or infrastructure problem (a bad flag, a missing environment variable, an unreadable specs file, the server not reachable, nothing ran). The message says which.
- **Outputs:** JUnit, JSON, SARIF (for GitHub code scanning), a self-contained HTML report and Markdown. On GitHub it can keep one pull-request comment up to date (`--github-comment`).
- **Secrets** are passed as environment-variable names (`--username-env`, `--password-env`, `--token-env`), never as values on the command line.
- **Other modes:** `--analyze` runs a full exploration and test creation (needs an AI key). `--server <url>` drives a platform that is already running (use `--api-key-env NAME` when it has an `API_KEY`).
- **Saved agent inputs:** a project's sign-in details, API access and OpenAPI document are saved only on its **Requirements** tab (**What the agents need**); an exploration uses them and never changes them. An exploration through the API, the command line or MCP that names another API address (`apiBaseUrl`) or OpenAPI document (`openApiUrl`) while credentials are saved is refused with 409 and the reason, so saved credentials never go to another site.
- **Tests switched off:** when no worker can pick a job up (for example `WORKER_EMBEDDED=false` and no `npm run worker`), runs, explorations, validations and deploy triggers answer 409 with `cannotRunHere: true` instead of queueing, and `/api/config` reports `runsHere: false`; the web disables **Run**, **Explore** and **Describe it** with that reason.
- **Environments:** `ai-test run --env staging`. For production add `--confirm-production`.
- **Compare two versions of an API description** (it lists what would break existing clients and what is harmless):

  ```bash
  npm run ai-test -- api-diff old.json new.json --fail-on breaking
  ```

  Exit code 1 when the gate fails. The same is available as `POST /api/projects/:id/api-diff`. It compares descriptions, not live behaviour. More: [contracts.md](features/contracts.md).
- **Examples** for a GitHub workflow, GitLab and Jenkins are in [ci.md](features/ci.md). The pipeline files have not been run on real CI services. They are tested against mock servers.

`ai-test --help`, `ai-test run --help` and `ai-test export --help` list every flag.

## 8. Deploy trigger

On **Runs → After a deploy**, create a **trigger token** (shown once, revocable). Your pipeline calls `POST /api/triggers/<token>/run` with optional `{ environment, commit }` and polls `GET /api/triggers/<token>/status/<jobId>`. The token is the only credential for those two calls (no `x-api-key`). The limit is one run per 30 seconds per token. A busy project answers 409. A token can also start a run sequence instead of a plain re-run. More: [healing-and-triggers.md](features/healing-and-triggers.md).

## 9. Use the platform from an AI tool (MCP)

Start `node bin/ai-test-mcp.mjs` from Claude, Cursor or another MCP client. Set `AITP_URL` (default `http://127.0.0.1:4000`) and, if the platform has an `API_KEY`, `AITP_API_KEY`. Example for Claude Code:

```bash
claude mcp add ai-testing --env AITP_URL=http://127.0.0.1:4000 --env AITP_API_KEY=your-key -- node C:/path/to/automation-testing/bin/ai-test-mcp.mjs
```

Config snippets for Claude Desktop and Cursor are in [mcp-server.md](features/mcp-server.md).

The tools can list projects, start an exploration, wait for it, read failures, re-run tests, write a test from a description, show readiness and drive a live browser step by step (`open_live_session`, `live_snapshot`, `live_act`, `live_save_as_test`, `close_live_session`). Rules that stay on:

- Only the tools that start work (explore, run, write a test) are marked as changing things, so the AI tool can ask you first.
- Data-changing API tests and load checks stay off unless asked for.
- An exploration uses the inputs saved on the project's Requirements tab; naming another API address or OpenAPI document while credentials are saved is refused (409).
- A production run still needs a confirmation.
- The tools take no passwords or tokens. In the live browser, only the sign-in placeholders are accepted, and only on the project's own site.
- Stdio only. It needs a running platform and the repository.

More: [mcp-server.md](features/mcp-server.md) and [live-session.md](features/live-session.md).

## 10. Alerts: mail server and addresses

- **Email alerts** need a mail server: set `SMTP_HOST` and `SMTP_FROM` (at least), plus `SMTP_PORT` (default 587), `SMTP_SECURE` (`true` for a secure connection from the first byte; the default is `true` only for port 465), `SMTP_USER` and `SMTP_PASSWORD`. A channel can carry its own mail settings instead, and its password is write-only. Creating an email channel without any mail server gives a plain message naming what to set. A channel has up to 10 recipients.
- **Microsoft Teams** channels take a Workflows webhook address.
- **`PUBLIC_URL`** is the address people use for the platform. Alerts and issues link back to it.
- **`ALERT_MIN_SEVERITY`** is the lowest severity that triggers alerts.
- Alert addresses on private networks are refused when `BLOCK_PRIVATE_TARGETS=true`. The channel's **Send test** button and the recent-alerts log show the real result.
- Schedules do not run if `SCHEDULER_ENABLED=false`.

More: [notifications-and-import.md](features/notifications-and-import.md), [schedules.md](features/schedules.md).

## 11. Storage, retention and backup

- **Retention** is off by default. When a project turns it on (**Setup → Storage and backup**), old screenshots, videos, traces and evidence are removed after the days you choose. A preview shows what would go before you confirm. `RETENTION_DEFAULT_DAYS` (7 to 365) turns it on for projects with no policy of their own. Failed runs are kept three times as long. Tests, run history, issues, releases, approved baselines, the newest runs and the files behind an open issue or a signed release are never removed.
- **Download backup** saves a project as a zip (tests, scripts, manual cases, releases, run sequences, environments, test data, schedules), without any secrets. **Restore from a backup** creates a new project from it, with tests waiting to be run and a list of secrets to enter again.
- **Settings → Storage** shows the disk the whole platform uses.
- Always capture and compare visual baselines on the same operating system (for example always in Docker), because fonts render differently.

More: [storage-and-backup.md](features/storage-and-backup.md).

## 12. AI usage limits

**Settings → AI usage** shows tokens (the units the AI service bills in) used this month by day, project, purpose and model. Set a monthly limit for the whole platform, a monthly limit per project and a limit per job in the page, or use `AI_MONTHLY_TOKEN_LIMIT` and `AI_JOB_TOKEN_LIMIT` as defaults (limits set in the page take precedence). When a limit is reached the job stops cleanly with a plain message, keeps the tests it already made and still runs them. A scheduled exploration is skipped. Enter a price per model to see a cost (no prices are built in). Only counts are stored, never prompts or answers. More: [ai-usage-budgets.md](features/ai-usage-budgets.md).

## 13. Plug-in frameworks

An owner can add a testing framework as a plug-in module without changing the platform: list its absolute path in `ADAPTER_PLUGINS` (separated by semicolons) and turn it on with `ALLOW_ADAPTER_PLUGINS=true`. It is ignored unless `API_KEY` is also set. A plug-in runs with the full power of the platform process, so load only plug-ins you wrote or reviewed. A broken plug-in is reported without stopping the platform, and tests whose plug-in is missing keep their data and say what is missing. Plug-ins run on the platform computer only, not on runner agents. A working example is in `examples/adapter-plugin/`. More: [adapter-plugins.md](features/adapter-plugins.md) and [framework-adapters.md](features/framework-adapters.md) (how the built-in frameworks plug in).

## 14. Test file format (JSON import)

**Tests → New test → Import tests…** accepts a JSON file of tests. They are rendered, run and checked. **Export…** gives the same format back, so you can move tests between projects.

A minimal web test:

```json
{
  "specs": [{
    "title": "Login succeeds",
    "kind": "web",
    "steps": [
      { "action": "navigate", "url": "/login" },
      { "action": "fill", "locator": { "by": "label", "value": "Email" }, "value": "{{credentials.username}}" },
      { "action": "fill", "locator": { "by": "label", "value": "Password" }, "value": "{{credentials.password}}" },
      { "action": "click", "locator": { "by": "role", "role": "button", "value": "Log in" } },
      { "action": "assert", "check": "url", "expected": "/account" }
    ]
  }]
}
```

Locators: `role`, `label`, `text`, `placeholder`, `testId`, `css`. The full format is in `src/engine/spec/schema.ts`.

A mobile test (the API also accepts `mobile: { appPackage }` on import):

```json
{
  "specs": [{
    "title": "Network settings open",
    "kind": "mobile",
    "steps": [
      { "action": "assert", "check": "visible", "locator": { "by": "text", "value": "Network & internet" } },
      { "action": "click", "locator": { "by": "text", "value": "Network & internet" } },
      { "action": "assert", "check": "visible", "locator": { "by": "text", "value": "Internet" } }
    ]
  }]
}
```

Placeholders you can use in a step's value: `{{credentials.username}}` and `{{credentials.password}}` (the saved sign-in), `{{credentials.totp}}` (the current authenticator code, which the script computes itself from `TEST_TOTP_SECRET` when it runs), `{{env.NAME}}` (a variable of the chosen environment) and `{{column}}` (a column of a test data table).

Maestro flows (YAML) and Git repositories are imported from the same **Import tests…** chooser. A preview shows what converted and what was left out before anything is stored.

## 15. Run downloaded tests outside the platform

**Tests → More actions → Export… → Download tests** gives a zip with `tests/`, `specs/`, `manifest.json`, `playwright.config.ts`, `results/validation-junit.xml` and a `README.md`. To run it:

```bash
npm i -D @playwright/test && npx playwright install chromium
BASE_URL=https://staging.example.com TEST_USERNAME=... TEST_PASSWORD=... API_TOKEN=... npx playwright test
```

Results are written to `results/junit.xml` for your pipeline. Credentials are never stored in scripts. Always pass them as environment variables. A test that uses an authenticator code reads its secret from `TEST_TOTP_SECRET` when it runs. Downloaded scripts contain the real element locators, so they work without the platform. Scripts that create records delete their own records. The AI look at the screen runs only inside the platform: a downloaded script just saves the screenshot.

## 16. Troubleshooting that needs a terminal

| Problem | Fix |
|---|---|
| "No LLM credentials configured" | Add an AI service key to `.env` and restart. API-only testing still works. |
| 401 from the API | Send the `x-api-key` header (the web app asks once under **Settings → Access to this platform**). |
| "This computer can't run mobile tests yet" | Run `npx @taqwright/taqwright install --with-avd` on the computer that runs the platform. |
| "Mobile tests need an app to test" | **Setup → Mobile app → Change**: add a package or upload an .apk, then run again. |
| "The Android emulator didn't respond" | Free up memory (the emulator needs 2 to 3 GB), close other emulators, run again. |
| Firefox or Safari show "unavailable" | Run `npx playwright install firefox webkit` (the Docker image has only Chrome). |
| Scheduled runs do not happen | Check `SCHEDULER_ENABLED`, that the server is running, and the schedule's "skipped" note (a job was still running). |
| Alerts do not arrive | Use **Send test** on the channel. The alert log shows the real result. Private addresses are refused if `BLOCK_PRIVATE_TARGETS=true`. |
| `ai-test` exits with 2 | A usage or infrastructure problem (bad flag, missing environment variable, unreadable specs file, server unreachable, nothing ran). The message says which. |
| A code test will not run | Code tests run only on a runner started with `--allow-custom-scripts`, or on the platform computer with `ALLOW_CUSTOM_SCRIPTS=true` and an `API_KEY` set. |
| A Windows desktop test is refused | Add the program to `DESKTOP_ALLOWED_APPS` (platform) or `--allow-app` (runner). |
| A runner shows offline | It was not seen for 45 seconds. It stopped, lost the network, or a proxy cuts idle requests shorter than about 60 seconds. |
| A runner will not start | Run `npm install` in its checkout. For a wrong or revoked token, create a new one. See [runner-agent-setup.md](features/runner-agent-setup.md) for every message. |
| The runner kit download says it has not been built | Run `npm run build:runner` on the server (the Docker image does this at build time). |
| The complete download for a computer is "not prepared on this server", or says it was built for other versions | Run `npm run build:runner -- --complete --targets <target>` on the server (it fetches Node.js from nodejs.org once). |
| A runner kit says "Runners need an https address" | Set `PUBLIC_URL` to the https address people use, then download the kit again. |
| A runner from a kit stopped saying the token is no longer accepted | Its token was revoked. Download a new kit (Setup, Runners, Add a runner). |
| The page's live progress stops updating | The page falls back to refreshing every few seconds and says so. Check that a proxy does not cut long-lived connections. |
| Not sure if a computer is ready | Run `npm run doctor`. |

## 17. Known limits

- Mobile tests run on Android emulators (and, through a runner, a USB phone and an iOS simulator on a Mac). They run one at a time and the AI does not generate them (you import them). A real-phone run and the iOS path have not been verified on real hardware.
- OAuth2 for API tests supports the client-credentials flow only. CAPTCHA, text-message or email codes, and single sign-on logins are not supported. An authenticator-app code is supported.
- Compliance mapping and the security checks are indicative hygiene checks, not an audit or a penetration test.
- Browser and screen-size checks use emulation, not real devices.
- CI pipeline files and the GitHub and Jira integrations are tested against mock services, not live ones.
- Code tests and plug-ins run with the rights of the process that runs them. They are not sandboxed.
- The accessibility checks use axe-core against WCAG 2.0 and 2.1 levels A and AA. "Safari" is Playwright's WebKit engine, and the phone (390 by 844, touch) and tablet (820 by 1180, touch) sizes are Chrome profiles.

## 18. Where the deeper technical documents are

Every feature has a technical document in `docs/features/`. The ones an admin reaches for most:

| Topic | Document |
|---|---|
| Pipelines and the command line | [ci.md](features/ci.md) |
| Runner agents | [runner-agent-setup.md](features/runner-agent-setup.md), [runner-agent.md](features/runner-agent.md) |
| MCP server | [mcp-server.md](features/mcp-server.md) |
| Doctor | [doctor.md](features/doctor.md) |
| Code tests | [custom-scripts.md](features/custom-scripts.md) |
| Plug-in frameworks | [adapter-plugins.md](features/adapter-plugins.md), [framework-adapters.md](features/framework-adapters.md) |
| Storage, retention, backup | [storage-and-backup.md](features/storage-and-backup.md) |
| Production hosting, probes, metrics, scheduled backups | [production-hosting.md](features/production-hosting.md), [deploy/README.md](../deploy/README.md) |
| AI usage limits | [ai-usage-budgets.md](features/ai-usage-budgets.md) |
| Alerts and import | [notifications-and-import.md](features/notifications-and-import.md) |
| Windows desktop and iOS | [windows-desktop-tests.md](features/windows-desktop-tests.md), [ios-tests.md](features/ios-tests.md) |
| How the platform is built | [AI_TESTING_ARCHITECTURE.md](AI_TESTING_ARCHITECTURE.md) |

## 19. Page addresses (for links)

The web app uses addresses after `#`. A test opens at `#/tests/:id/steps`, `/text`, `/code` or `/history` (the bare `#/tests/:id` opens Steps, and the old `/builder` address opens Steps). A run opens at `#/projects/:id/runs/:jobId` and a release at `#/projects/:id/release/:releaseId`. A place's open section is kept in the address as `?section=`. Old addresses of earlier pages open the place that now holds them: `/schedule` opens Runs (Schedules), `/runners` opens Setup, `/objects`, `/blocks` and `/helpers` open Library, `/releases`, `/manual-cases` and `/compliance` open Release. On the Tests page `?quarantine=1`, `?quality=weak`, `?status=` and `?git=1` filter or open the Git import. More: [ux-navigation.md](features/ux-navigation.md), [ux-workbench.md](features/ux-workbench.md).

## 20. Production hosting (deployment)

For a server on the internet use the deploy kit in `deploy/`: [deploy/README.md](../deploy/README.md) walks through an Ubuntu VPS step by step (DNS, `.env`, start, update, backup and restore, logs). `deploy/docker-compose.prod.yml` runs the platform behind Caddy, which gets the HTTPS certificate for `DOMAIN` by itself; `deploy/ai-testing-platform.service` runs it with systemd instead of Docker. These files have not been run on a VPS yet: check them with the commands in the README.

**Probes and metrics** (outside `/api/`):

| Address | Key | Use |
|---|---|---|
| `/healthz` | none | The process answers (Docker's health check uses it). |
| `/readyz` | none | Ready for work: database writable, migrations done, a worker alive in the last 90 s, at least 500 MB free. Otherwise 503 with the names of the failing checks (`database`, `migrations`, `worker`, `disk`, `shutdown`). |
| `/metrics` | `API_KEY` or `METRICS_TOKEN` | Prometheus: jobs by status, queue, job durations, AI calls, tokens and cost, runners online, HTTP requests and latency by route, errors, backup state. |

**Settings:**

| Variable | Default | Purpose |
|---|---|---|
| `LOG_FORMAT` | text | `json` writes one JSON object per log line (time, level, message, component, job, request id), with secrets removed |
| `METRICS_TOKEN` | none | A separate token (16+ characters) for Prometheus: `Authorization: Bearer <token>` on `/metrics` |
| `SHUTDOWN_GRACE_SECONDS` | `60` | On stop, how long the running job may take to finish before it is stopped and shown as interrupted. Give Docker or systemd longer than this to stop the process. |
| `READY_MIN_FREE_MB` | `500` | `/readyz` fails below this much free disk (`0` = no check) |
| `WORKER_STALE_SECONDS` | `90` | `/readyz` fails when no worker said it is alive for this long |
| `BACKUP_DIR` | none (off) | Turns on scheduled backups of the whole database to this folder (not the data folder) |
| `BACKUP_SCHEDULE` | `daily` | `daily` (02:30 UTC), `daily@HH:MM` (UTC), `hourly`, `6h`, `off` |
| `BACKUP_KEEP` | `7` | How many verified backups to keep |
| `BACKUP_UPLOAD_COMMAND` | none | A command run after each backup with the file in `$BACKUP_FILE` (for example `rclone copy "$BACKUP_FILE" remote:aitp`) |

**Stopping:** SIGTERM (Docker stop, systemd stop, Ctrl+C) stops taking new jobs, gives the running job `SHUTDOWN_GRACE_SECONDS`, then stops it the way Stop does and records it as "Interrupted: the platform was shut down…" so nobody mistakes it for a run in progress; it is not restarted on its own. A job whose tests run on a runner is not stopped: it is handed over, the runner keeps going, and the platform picks it up again when it starts (`docs/features/runner-restarts.md`).

**Scheduled backups** are a full copy of the database (every project, history and the encrypted secrets), made while the platform runs and checked by opening the copy before it counts. Without `SECRET_KEY` the encryption key file is copied next to each backup; with `SECRET_KEY`, keep that value safe yourself. Screenshots, recordings and traces are not included. One backup now: `npx tsx src/platform/ops/backup-cli.ts`. Restore: stop the platform, copy the backup to `<DATA_DIR>/platform.db` (delete `platform.db-wal` and `platform.db-shm`), put the key back, start.

**Database:** SQLite on the same machine as the platform and its worker. One server only; never on a network drive. Comfortable for a team running a few jobs at a time.

More: [production-hosting.md](features/production-hosting.md).

## 21. Security assessment

A separate module for passive, read-only security assessments of applications a client authorized (no attack payloads, no external
scanners). It is on by default; `SECURITY_ASSESSMENT=off` removes its pages and answers 404 on its routes, and functional testing is
unchanged either way.

| Setting | Default | Meaning |
|---|---|---|
| `SECURITY_ASSESSMENT` | `on` | `off` hides the module |
| `SECURITY_ALLOW_PRIVATE_TARGETS` | off | `true` lets assessments reach loopback and private networks (an internal staging server). Cloud metadata addresses stay refused. Leave it off on a hosted platform. |
| `SECURITY_RETENTION_DAYS` | 365 | finished assessments and their per-assessment evidence are removed after this many days (findings keep their latest evidence) |
| `SECURITY_MAX_REQUESTS` | 2000 | requests one assessment may send |
| `SECURITY_MAX_RESPONSE_BYTES` | 5 MB | bytes read from one response |
| `SECURITY_ASSESSMENT_MINUTES` | 30 | time limit of one assessment |
| `SECURITY_USE_PROXY` | off | `on` sends assessment requests through the company proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`). The guard still checks every address and its DNS answers first, but the proxy then resolves the name itself, so the private-address protection also depends on the proxy. Use it only when the client's application is reachable only through the proxy. |
| `SECURITY_PROXY_ALLOW_PRIVATE` | off | `true` lets that proxy be on a loopback or private address (most company proxies are). A proxy on a cloud metadata address is always refused. |

Who may do what: viewers read, editors register applications and run assessments, **owners record or revoke the client's
authorization** and delete applications. No assessment starts without a current authorization, and changing an application's target,
scope, exclusions or request rate makes it stale. Every request goes through the scope guard (only the target and its listed scope,
never excluded paths, DNS checked and pinned, redirects re-checked, rate limit and caps). Every change is in the project's security
activity and in Settings, People, Activity. The scheduled full backup (`BACKUP_DIR`) holds all security data; a project backup holds the
project's security data too (secrets left out; restored authorizations are withdrawn, so a new one is needed). When an assessment ends,
the project's alert channels can be told (new critical or high findings and failures by default; set per project in its security
section, under Notifications).

**Restoring on an older platform.** A platform version from before the security data was part of a project backup (round 20) refuses a
backup that holds it, with: *"The file is not a backup this platform made: it holds “security.json”, which a backup never contains."*
That older version cannot be changed, so make the backup for it without the security data: in *Setup*, *Storage and backup*, an owner
ticks **Leave out the security assessment data** before **Download backup** (the box is shown only for a project that has security data),
or calls `GET /api/projects/<id>/backup?withoutSecurity=true`. The file is then exactly the earlier format (no `security.json`, no security
counts, no security sign-in to enter again) and restores there; the applications, authorizations, assessments and findings are not in it.
Each such download is recorded in the project's security activity and in Activity, with what was left out.

**External security scanners (optional).** SECURITY_SCANNERS=zap,nuclei,schemathesis,promptfoo names the tools that may run at all;
everything else stays off whatever is installed on the machine. An editor must then allow them for a project, so both gates must be open.
Nuclei only ever runs templates from SECURITY_NUCLEI_TEMPLATES (review them before pointing it at a client), ZAP needs SECURITY_ZAP_URL
and SECURITY_ZAP_API_KEY (server-side only, never returned by the API), and Schemathesis and Promptfoo are found on the path or named
explicitly. A tool that is not installed, not configured, not allowed or refused at the profile is reported as such and produces no
findings, and one tool failing never fails the assessment. More: [security-scanners.md](features/security-scanners.md).

**Starting the ZAP daemon.** It is a separate service and it has to be started by hand:

```
zap.bat -daemon -config api.enabled=true -host 127.0.0.1 -port 8090     # zap.sh on macOS and Linux
```

Set an API key on the daemon (`-config api.key=<key>`) and give the platform the same value in `SECURITY_ZAP_API_KEY`. Do **not** try to
set the API address with `-config api.addrs.addr.name` or `-config api.addrs.addr.regex`: that writes a string into a boolean setting,
the daemon then logs `'regex' doesn't map to a Boolean object` on every start, its permitted-address configuration never loads, and the
API hangs up on every request with no answer. `-host` and `-port` are the documented flags and need no repair afterwards. If a daemon is
already running and was started that way, repair `<regex>false</regex>` in `%USERPROFILE%\ZAP\config.xml` once, then restart it.

More: [security-assessment.md](features/security-assessment.md).
