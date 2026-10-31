# Windows desktop app tests

A third kind of test next to web and mobile: tests for **Windows desktop applications**, driven through Windows' built-in **UI Automation** from PowerShell. There is **no new dependency**: no Appium, no WinAppDriver, no npm package. The framework is `windows-uia` ("Windows UI Automation (PowerShell)"), the test kind is `desktop`.

## What it does for you

You describe a test as steps (start the application, click, type, choose, check the text, check what is visible). The platform renders a script, **really starts the application on a Windows computer**, runs the steps, and records the result like any other test: validated or failed, history, failing step, a picture of the application window when it fails.

Desktop tests are **not** offered by analysis or AI generation (the AI does not explore desktop applications yet). They come from spec import: "Import tests" on the Tests page accepts the JSON below, and `POST /api/projects/:id/specs` takes the same specs.

## Where it runs

- On the **platform host**, when that is a Windows computer in a signed-in session and the application is listed in `DESKTOP_ALLOWED_APPS`.
- On a **runner agent running Windows** (the usual choice), started from a signed-in session with `--allow-app` for each application. See `docs/features/runner-agent-setup.md`.

If no suitable computer is available, a run is refused up front with a plain 409 that names what is missing ("needs a Windows computer", "This computer isn't set up to start ...", "the agent runs as administrator ...") and **never** becomes a failing test.

### Interactive session (read this)

UI Automation needs the desktop of a logged-in user. It does not work from a Windows service session, and **a locked screen blocks it** (the application's window cannot be found or read; the test then fails with "did not open a window ... within N seconds" or "nothing matched"). Keep the computer signed in and unlocked while tests run. The probe reports a non-interactive session (`[Environment]::UserInteractive` is false) and the Agents page shows "needs an interactive desktop session"; it cannot tell a locked screen from an unlocked one.

## The spec

```json
{
  "title": "The counter goes up",
  "kind": "desktop",
  "desktop": { "app": "C:\\Program Files\\MyApp\\MyApp.exe", "windowTitle": "My App", "args": ["--demo"], "startTimeoutMs": 15000 },
  "steps": [
    { "action": "launchApp" },
    { "action": "click", "locator": { "by": "testId", "value": "btnAdd" } },
    { "action": "assert", "check": "text", "locator": { "by": "testId", "value": "lblCount" }, "expected": "Count: 1" }
  ]
}
```

`desktop`: `app` (required), `windowTitle` (part of the title of the application's main window, used to recognise it), `args` (up to 20 plain strings), `startTimeoutMs` (default 15000, at most 60000).

### Steps

| Step | Meaning |
|---|---|
| `launchApp` | Start the application. Must be the first step, once. |
| `click` | Invoke the element (button, menu item, link). Falls back to Select, Toggle or Expand/Collapse. |
| `fill` | Set the text of an element that supports Value (text box). Never types. |
| `select` | Choose a list item, tab or radio button by name, or an item of a list or combo box. |
| `check` (`checked`: true or false) | Set a check box. |
| `wait` | Pause, at most 10 seconds. |
| `assert` with `check` = `visible`, `hidden`, `text`, `value`, `enabled`, `disabled`, `count` | `text` is "contains" on the element's name or value; `value` is "equals" on its value; `count` is the number of matching elements. Checks wait up to 8 seconds. |
| `closeApp` | Close the application. Optional, last. (The test closes it anyway.) |

Not allowed (the import says why): `navigate`, `press`, `hover`, API steps, page checks (`url`, `title`, `a11y`, `screenshot`, health checks, ...), css and placeholder locators, text data sets.

### Locators

A small fixed vocabulary, no free-form XPath or script:

| `by` | Matches |
|---|---|
| `testId` | the element's AutomationId |
| `label` or `text` | the element's Name (contains; add `"exact": true` for equals) |
| `role` | the control type (`Button`, `Edit`, `CheckBox`, `ComboBox`, `List`, `ListItem`, `Menu`, `MenuItem`, `Tab`, `TabItem`, `Text`, `Window`, ...); `value` then narrows by name. `role` can also be given with `testId`, `label` or `text`. |

`nth` (0-based) picks one of several matches. When several elements match and no `nth` is given, the step fails and says so.

## Security (the part that must be right)

Starting a program on a computer is a new power. A spec can never launch an arbitrary program or inject into PowerShell.

1. **Allow-list on the computer that runs the test.** `--allow-app <exe path or name>` (repeatable), `AITP_ALLOW_APPS` (semicolon-separated) or `--allow-apps-file` for an agent; `DESKTOP_ALLOWED_APPS` (semicolon-separated, in `.env.example`) for the platform host. Nothing is allowed by default. Matching is on the **resolved full path**, case-insensitive; a bare name is looked up on the PATH and stands for one real file. No wildcards: a folder or `*` allows nothing. A spec never widens the list, and neither does the platform's task.
2. **Hard deny-list that always wins.** Command shells and script hosts (`cmd`, `powershell`, `pwsh`, `wscript`, `cscript`, `mshta`, `wsl`), script and language runtimes (`node`, `python`, `java`, ...), `rundll32`, `regsvr32`, `msbuild`, `msiexec`, download and remote tools, machine-administration tools and similar are never started, even if someone allows them by mistake. The check runs on the name in the spec and again on the file the name really resolves to (a renamed copy or a link to a shell is refused too).
3. **Checked at import.** `app` must be a program name or an absolute drive path ending in `.exe`: no relative path, `..`, UNC path, URL, script, shortcut or installer, and none of the characters a shell treats specially. `args` are plain strings: no quotes, backticks, `$`, `%`, `^`, `&`, `|`, `;`, `<`, `>`, control characters, `..`, UNC paths or URLs.
4. **No shell string is ever composed.** The application is started by the helper with `System.Diagnostics.Process.Start` and `UseShellExecute = $false`; arguments are quoted for the Windows command line by the helper. Every value from a spec (names, ids, text, arguments, window title) reaches PowerShell as JSON data on stdin, ASCII-escaped, one request per line, and is only ever used as a .NET argument or property value. The PowerShell text contains no value from a test; the helper script is fixed. Tests with names and ids containing quotes, backticks, `$()`, semicolons and newlines prove none of it runs.
5. **Refusal is not a verdict.** A refusal says "This computer isn't set up to start <app>. Add it with --allow-app, then run again." (or "... Add it to DESKTOP_ALLOWED_APPS ...") and never becomes a failing test. The platform refuses before a job exists; the agent and the script check again.
6. **Never elevated.** If the platform host or the agent runs as administrator, desktop tests are refused. Reason: an elevated process driven by test text would hand that text administrator power.
7. **Windows only.** On any other operating system the adapter reports unavailable and a desktop test is refused with a plain message.
8. **Own windows only.** The helper looks at top-level windows whose process id is the one it started, and their descendants. It never enumerates or reads other applications' windows.
9. **No input synthesis.** Actions use UI Automation patterns only (Invoke, Value, SelectionItem, Toggle, ExpandCollapse). No SendKeys, no cursor movement, no bringing a window to the front. A person using the same computer is not disturbed, and tests are deterministic. An element without the needed pattern fails the step with a plain message.
10. **Passwords are never read.** Password-type controls (`IsPassword`) are reported as `[hidden]` in the element tree and are refused by `text` and `value` checks. Names, values and trees recorded in errors are length-capped and pass the same masking the web evidence uses (this run's credentials, bearer tokens, key shapes).
11. **A clean environment.** The helper process gets only a small set of Windows variables; the application under test does not receive `TEST_*`, `AITP_*`, `API_*`, `LLM_*`, `SECRET_*` or `BASE_URL` variables.
12. **No orphans.** One helper PowerShell per test; it closes the application (and its process tree) at the end of the test and at exit. When a run is stopped hard (time-out or cancel, where the test runner kills the test process and with it the helper), the helper cannot clean up, so every process the helper starts is also written to a ledger in a private folder, and after the run the adapter stops anything still alive from that ledger (checking the process start time first, so a reused process id is never touched). The tests count the fixture application and helper processes after a pass, a failure, a time-out and a cancel. A hard kill of the whole platform or agent process cannot run this sweep; an application left behind that way has to be closed by hand.

## Evidence on failure

- A **picture of the application window only** (not the desktop), taken with `PrintWindow`, attached as a normal screenshot artifact.
- A **compact element tree** in the error text (control types, automation ids, names, depth up to 4, at most 80 nodes, passwords hidden) so a person can fix a locator.

## How it works

- `src/engine/desktop/target.ts`, `spec.ts`: target and step rules, the deny-list, plain-word issues.
- `src/engine/desktop/host-script.ts`: the PowerShell host (UI Automation, JSON lines).
- `src/engine/desktop/helper.ts`: the JavaScript helper pasted into every script and compiled for tests from the same text; allow-list decision, session, retries, tree and error text.
- `src/engine/desktop/policy.ts`, `probe.ts`, `sweep.ts`: the allow-list check, the capability probe (cached 30 seconds, opens no window), the process ledger sweep.
- `src/engine/generators/windows.ts`: spec to script. The script is an ordinary Playwright Test file that does not use `page`, so the existing runner, report parsing, artifacts, cancel and the runner-agent protocol work unchanged. The spec's target travels as data in one marked line; the computer's policy is written into another marked line for one run only (the stored script never carries it, and a downloaded script reads `DESKTOP_ALLOWED_APPS`).
- `src/engine/frameworks/windows.ts`: the adapter (`needs: { windows: true }`), registered with the built-ins.
- Agent: `windows.uiautomation`, `interactive`, `elevated` and `allowedApps` are reported in capabilities (additive optional protocol fields; `PROTOCOL_VERSION` stays 1; `winappdriver` is now optional and unused). The agent's task runner checks again before starting anything and passes only its own allow-list to the helper.
- Platform: `agent-routing.ts` (capability decision), `desktop-guard.ts` (early refusals), the Runners tab ("Windows desktop apps: ready"), and a project that holds only desktop tests carries the pseudo address `windows-app://desktop` (like `android-app://` for mobile; never fetched).

## Limits

- Needs an interactive, unlocked, non-elevated Windows session. Behaviour on a locked screen is not detected and was not verified; expect a start-up time-out.
- Applications must publish UI Automation providers. WPF, UWP/WinUI, Win32 standard dialogs and most modern frameworks do. **Plain .NET Framework WinForms buttons and text boxes show up only as anonymous panes without Invoke or Value support** (checked on this machine), so a pattern-only driver cannot act on them; such an application needs UI Automation support added, or another approach. The test fixture is therefore a WPF window.
- No AI generation or exploration of desktop apps; no data-driven rows, visual baselines, "looks right" judging, per-environment runs or cross-browser variants for desktop tests.
- One application per test. The start waits for a window of that process (optionally matching `windowTitle`).
- The picture comes from `PrintWindow`; some GPU-accelerated windows can come out black, then the picture falls back to copying the window's rectangle from the screen.
- Verified on this build only on Windows 11 with Windows PowerShell 5.1 and the .NET Framework 4 C# compiler.
