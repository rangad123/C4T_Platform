# Check this computer: the runner's own preflight check

## What it does for a tester

`npm run doctor` checks the platform's computer. The runner now has its own check, where testers are:

- **In every download** (plain files, complete download, installer): `check-computer.cmd` (Windows, double-click), `check-computer.sh` (Mac and Linux: `sh check-computer.sh`) and `check-computer.command` (Mac, double-click).
- **By hand:** `node runner.mjs --check` in the runner's folder (any flag the runner accepts works too: `--url`, `--token-file`, `--proxy`, `--ca-file`, `--browser`). From a checkout: `npm run agent -- --check --url ... --token-file ...`.
- **At the end of both installers**: the Windows setup program and the Mac app run it after setting up and show its lines (details pane and `setup.log` on Windows, the Terminal window and the log on a Mac).
- **On the runner's row** under Setup, Runners: a runner sends the same check when it starts; the row says "2 things need a look on this computer" with each line and how to fix it, and **Show details** lists every line. Nothing is shown when everything required is there.
- The **Add a runner** panel's last step ends with "If it does not connect, double-click check-computer.cmd in the same folder…" (the Mac and Linux wording names `sh check-computer.sh`; for the installer it names the unzipped folder and says the setup window shows the same check).

Output, in the shape of the doctor:

```
Check this computer for the AI Testing Platform runner "Office PC" (platform tests.example.com).

ok        Node.js v24.19.0, came with this download
ok        Settings: platform tests.example.com, runner name "Office PC", token read from runner.token (not shown)
ok        Runner files match this download (version 0.1.0+0fde81ee6f)
ok        Test tools are installed (Playwright 1.63.0), came with this download
ok        Web tests will use Microsoft Edge 155, installed on this computer (browser setting: auto, the default)
optional  Firefox and WebKit are not here yet (only runs on other browsers need them)
          To fix: Nothing to do: the runner downloads them when such a run arrives.
ok        Network: connects through the proxy http://maya:***@proxy.corp:8080, from HTTPS_PROXY / HTTP_PROXY; trusts Node.js's own certificates, this computer's certificate store (124)
missing   Could not reach tests.example.com: the platform's certificate was not accepted (SELF_SIGNED_CERT_IN_CHAIN): the connection is signed by a certificate this computer does not trust
          To fix: A company security tool that inspects https traffic usually causes this. Ask IT for the company's root certificate ...
optional  The token was not checked, because the platform could not be reached
ok        41.2 GB free on the disk that holds the runner's folder
optional  The clock was not compared with the platform's (the platform was not reached)
optional  Android phone tools are not on this computer yet (only phone tests need them)

1 thing needs a look. Fix it, then run this check again.
```

Exit code 0 when nothing required is missing, 1 when something is, 2 when the check itself failed. The scripts pause at the end (`AITP_KIT_NO_PAUSE=1` skips it).

## What it checks

| Line | ok / missing / optional |
|---|---|
| Node.js | 24 or newer; says whether it came with the download. Older is missing. When the scripts find no Node.js at all, they print the missing line themselves (the other checks need Node.js). |
| Settings | runner.json and the token file readable, the address acceptable (the runner's own rules); a broken runner.json or network line becomes this line instead of a crash. The token is never shown. |
| Runner files | The five program files, and the test tools' lock file `package-lock.json` when the download has one (every download from round 39 on), against the checksum in the download's version (`kitVersion` ends with the first 10 hex characters of the SHA-256 of `name\0sha256\n` per file in name order, exactly how `scripts/build-runner.mjs` makes it), so a changed or damaged file is found without a manifest in the zip. Before 2026-11-09 the check left the lock file out and said every newer download was damaged; `tests/runner-kit-unit.test.ts` now runs the check on a freshly built download. After a self-update (runner-updates.md) runner.json carries the new version. |
| Test tools | Every package of the download's package.json at its pinned version in node_modules (complete download: "came with this download"); the phone test tools are mentioned, not required. |
| Browser | What the runner would choose and why (runner-browsers.md: setting, installed Chrome or Edge too old, Playwright's Chromium present, or "the runner downloads Chromium once"). Nothing is downloaded. An explicit `--browser msedge` the computer cannot meet is missing. |
| Firefox and WebKit | Optional. |
| Network | The proxy (password as `***`) and where it came from, including the Windows setting (company-networks.md), and the certificates trusted. A proxy with a Node.js older than 24.14 is missing. Windows notes (PAC, `<local>`) are printed as notes. |
| Platform | `GET /api/health` at the address in runner.json, through the proxy and the trusted certificates: unreachable, an untrusted certificate, a proxy wanting a password, a web filter, a redirect (the runner does not follow redirects) and a server error each have their sentence. |
| Token | `POST /api/agent/check` (new, additive route): accepted (with the project's name), revoked or the project deleted (missing), or "this platform cannot check the token without connecting" for an older platform (optional). |
| Disk | Free space where the runner keeps its work folder; under 1 GB is missing. |
| Clock | Against the platform's `Date` header (the runner: the hello answer's `serverTime`); more than 5 minutes off is missing. |
| Phone tools | Optional: adb found, the runner's own tools (phone-setup-simple.md), or "the runner gets them when a phone test needs them". adb is looked for as a file, never run. |
| Mac only | The processor: Apple chip, Intel, or an Intel Node.js under Rosetta (optional, slower). The quarantine flag on the runner's folder (optional; start-runner.sh clears it, and in check mode it does not, so the check can report it). Read with `/usr/sbin/sysctl -n` and `/usr/bin/xattr -p`. |

## How it works

- `src/agent/computer-check.ts`: one pure function per line (fed fake computers by the tests), `checkComputer` (reads the computer through a `CheckDeps` object), `formatCheck`, `runCheckProgram`. `src/agent/index.ts` handles `--check` before anything else, so a broken runner.json is a line, then flushes and exits.
- The runner program must start without its test tools for the check to work in a plain kit before its first `npm install` (the likely failure behind a proxy). Two engine files imported Playwright packages at load time and are now loaded when used: `src/engine/a11y/audit.ts` (`@axe-core/playwright`, a dynamic import inside the audit) and `src/engine/recorder/session.ts` (`playwright`'s `chromium` through `createRequire` when first needed). Behaviour is unchanged.
- The scripts (`src/platform/runner-check-scripts.ts`) hand over to `start-runner.cmd` / `start-runner.sh` with `AITP_KIT_CHECK=1`: those find Node.js exactly as for the runner (the download's own first) and then run `node runner.mjs --check` instead of installing or starting anything; without Node.js they print the missing line and offer no installation. An installer download has no start script: there the scripts check the runner the installer set up in its default folder (`%LOCALAPPDATA%\AITestingRunner\app`, `~/Library/Application Support/AITestingRunner/runner`) with its Node.js, or say to run the installer first.
- The installers ask only a runner program whose text contains the marker `aitp-computer-check/1`, so an older runner program is never started by accident.
- Running runner: `main.ts` makes the start-up part (Node.js, files, tools, disk, Mac lines) once; `client.ts` adds `capabilities.check` to hello and polls with the browser, network and phone lines read from the capabilities the runner reports anyway, and the clock line from the hello answer. Validated against the protocol before it is sent (a line that does not fit is dropped, never a refused hello).
- Protocol (additive, optional, version 1): `Capabilities.check = { at, items: [{ id, status: "ok"|"missing"|"optional", title (≤300), fix? (≤400) }] (≤20) }`. Route `POST /api/agent/check` (runner token, no API key, role `own`; answers `{ ok: true, project? }`; it creates nothing, though like every runner route it records the token's last use). `GET /api/projects/:id/agents` passes `check` through with `user:password@` masked once more.

## Privacy and safety

- The token is never printed: every line of output is masked against the token and a proxy password, and the proxy is always shown as `user:***@host:port`. The token is sent only to the platform address the download names, and only to `/api/agent/check` (the health request carries none).
- The check changes nothing: no download, no npm, no runner row, no runner started. On the platform's side it only answers.
- What goes to the platform has no paths (the Mac quarantine fix names "the runner's folder"; the exact command stays on the computer as a note).

## Tests

- `tests/runner-check-unit.test.ts` (24, fast tier): the phone tools started outside the runner's folder; every line on fake computers (versions, the file checksum, test tools, the browser decisions, the proxy with a password, the platform answers including an untrusted certificate and a refused connection, the token answers, disk, clock, phone tools, a fake Mac on Rosetta with the quarantine flag); the whole check on fake download folders with a stand-in platform behind `fetch` (only the named platform is asked, the token goes only to the token check, never printed; a proxy password never printed; a broken runner.json is a line); the runner's report (fits the protocol, no path or token); the check-computer files in the plain and installer zips (CRLF/LF, mode 0755, README); the start scripts' check mode; `check-computer.sh` syntax and the "not set up yet" path under Git Bash.
- `tests/runner-check.test.ts` (6, under the lock; ports 6930-6939): a download from the real platform route with the real runner bundle: `check-computer.cmd` under cmd.exe and `check-computer.sh` under Git Bash (exit 0, every required line ok, the token accepted and not printed); the real runner sending its check with its hello and the runner list showing it without a path or token; the platform unreachable; an https platform behind the TEST-ONLY company certificate through a proxy with a password (untrusted, then trusted once runner.json names the certificate file; the password never printed); a revoked token.
- `tests/runner-check-ui.test.ts`: the runner's row ("2 things need a look" with the lines), its details, the Add a runner line, in light and dark, at phone width.

## What is not covered (honest limits)

- **Never run on a real Mac or Linux machine.** The Mac lines are tested with a fake `sysctl`/`xattr` only; `check-computer.command`, the Mac app's run of the check and the installer-download branch of the scripts on a Mac were not run on a Mac. The Mac app's check was syntax-checked only.
- The Windows installer's run of the check at its end was compiled but not exercised by a test here (see what the owner must do); `check-computer.cmd` in an installer download looks only in the installer's default folder (not a folder chosen with `--install-dir`).
- No real company proxy or security tool (a local CONNECT proxy and the test-only certificate stand in), no real clock skew (a stand-in date), no full disk.
- The check is a snapshot: a browser the runner downloads later, or a phone plugged in later, is shown by the runner's other lines on its row, not by a new check.
- "Not started from a download" (a checkout) skips the file and test-tool lines.
