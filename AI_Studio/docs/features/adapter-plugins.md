# Adapter plug-ins

A plug-in adds a testing framework to the platform without changing the platform: an ES module that renders a test into a script and runs it, plus a small manifest. Selenium, an in-house runner or a command-line tool are the intended uses. The platform ships one real, tiny example, `examples/adapter-plugin/` (the adapter `node-http-check`), with its own README.

**A plug-in is code that runs inside the platform process, with all of that process's power.** It can read every secret a run is given, and it can reach the database through its own imports. Nothing here is a sandbox. Only load plug-ins you wrote or reviewed. What the platform does is keep a careless or broken plug-in from corrupting what it stores or stopping it (see "What is contained"), not stop a malicious one.

## What it does for a user

- The person who runs the server lists plug-ins in the environment. At start the platform loads them and the new frameworks appear in `GET /api/config` (`adapters`, each with `plugin: { name, version }`) and in the **Frameworks** section of the Runners tab, under "Plug-in frameworks", with a "Plug-in" label. A plug-in that could not load is listed there too, with the reason in words; the rest of the platform works as usual.
- A test is stored for a plug-in framework when it is imported with `"framework": "<adapter id>"` (`POST /api/projects/:id/specs`, one framework for the whole import; the specs must be of a kind the adapter runs). From then on a normal run renders it with the plug-in, runs it through the plug-in, and records the result, findings and history like any other test. Without `framework` nothing changes: every test is decided by its kind, as before.
- The Frameworks section is read only for plug-ins. They are turned on and off by whoever runs the server, not from the web page, and they have no settings of their own.
- A test stored for a plug-in framework shows the adapter's own label (for example "Node HTTP check (example plug-in)") wherever the page names its script format, with a "Plug-in" badge next to its status. The raw framework id is not shown in words.
- `npm run doctor` says in words whether adapter plug-ins may load on this computer.

## Turning it on

Three settings in the server's **environment** (for example `.env`). They are read at start. They can never come from the API or the UI.

| Setting | Meaning |
|---|---|
| `ALLOW_ADAPTER_PLUGINS=true` | The deliberate switch. Default off. Anything other than the word `true` is off. |
| `API_KEY=...` | Required. The switch is **ignored** without an API key: anyone who could reach the port would otherwise be affected by whatever a plug-in does. The platform says so loudly at start, and `GET /api/config` carries the reason (`adapterPlugins.reason`). |
| `ADAPTER_PLUGINS=<path>;<path>` | Semicolon-separated **full** paths: a folder holding `plugin.json` and `adapter.mjs`, or a single `.mjs` / `.js` file with a `<file name without extension>.plugin.json` next to it. |

When the switch is off, or there is no API key, the files are **not opened at all**: a plug-in module is not imported, so nothing it would do at import time happens. (A test writes a marker file from such a module and checks that it never appears.) When it is on, the platform logs a security warning at start naming how many plug-ins were loaded. The standalone worker (`worker-main.ts`) loads plug-ins by the same rule; the API process and the embedded worker share one load.

Paths that are refused with a plain sentence (the rest keep loading): relative paths, paths containing `..`, network paths (`\\server\share`), paths longer than 500 characters, files that are not `.mjs` or `.js`, folders without `plugin.json` or `adapter.mjs`, a path that does not exist. Messages name the file or folder, never the full server path: every error text that comes from a plug-in or from loading one (what `GET /api/config` lists, the 409 sentence, a run's error) has absolute paths cut down to their last part ("Cannot find package 'x' imported from adapter.mjs"). Only Windows drive paths, network paths, `file:` addresses and POSIX paths under the usual roots (`/home`, `/Users`, `/var`, `/tmp`, `/opt`, `/app`, `/data` and a few more) are recognised; a path somewhere else on a Linux server, or one a plug-in builds into its own result text, is not. A `plugin.json` that starts with a byte order mark (PowerShell and some editors write one) is read normally. At most **10 plug-ins** are loaded; the rest are reported. There is no installing, no downloading and no `npm install`.

## Writing one

### `plugin.json`

```json
{ "name": "node-http-check", "version": "1.0.0", "apiVersion": 1, "description": "…",
  "adapters": [ { "id": "node-http-check", "label": "Node HTTP check (example plug-in)" } ] }
```

Checked before the module is imported, with these rules: `name` 1 to 49 characters (letters, digits, spaces, `.`, `_`, `-`, starting with a letter or digit); `apiVersion` is `1`; no unknown fields; the file is at most 16 KB; at most **5 adapters** per plug-in; every adapter `id` matches `^[a-z][a-z0-9-]{1,30}$`, appears once, and is **not the id of a built-in framework** (a plug-in can never override one) nor already taken by another loaded plug-in. Ids are stored in databases, so never rename one.

### `adapter.mjs`

The default export is an adapter object, an array of them, or a function (sync or async) returning either. It must provide exactly the adapters `plugin.json` declares.

```js
export default {
    id: "my-framework",                  // as in plugin.json
    kinds: ["api"],                      // "web" | "api" | "mobile" | "desktop": the tests it renders and runs
    executable: true,                    // false: scripts are rendered and stored, never run
    runtime: "my-framework",             // adapters with one runtime run together; may not be a built-in runtime
    needs: { node: true },               // what the machine must have: node, browsers, android, ios, windows
    traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false },
    render(spec, ctx, host) { return { filename: "API-001.my.mjs", content: "…" }; },   // pure, synchronous
    async execute(batch, env, opts, host) { return [/* one result per script, in order */]; },
};
```

Every member is checked (type and shape; `needs` and `traits` accept no unknown keys). `label` comes from `plugin.json`. A `describe()` function is optional and never called: the platform builds the description from the checked data. The `FrameworkAdapter` contract is the one in `docs/features/framework-adapters.md`; `kinds`, `needs` and `traits` mean the same.

**`render(spec, ctx, host)`** gets copies of the test and the render context (changing them changes nothing). It returns `{ filename, content }`: the file name is letters, digits, dots, dashes and underscores (at most 120, no folders, no name Windows keeps for devices such as `con`, `nul`, `aux`, `com1` or `lpt1` with or without an extension, no dot at the end), the content a string of at most 1 MB. The stored framework is always the adapter's own id. Reusable steps are expanded before the adapter sees the test, and shared elements are resolved, as for built-ins. **Stored sign-in details only go to the application's own site**: the platform checks that rule on the expanded steps before the plug-in is called (`src/engine/spec/credential-origin.ts`), and a test that breaks it is refused with the usual sentence. A plug-in must still not write secrets into script text: read them at run time from the environment the platform hands the child.

**`execute(batch, env, opts, host)`** gets copies of the scripts (`testId`, `filename`, `content`), the environment (`env.run` has the address, the stored accounts and the API token: this is where the secrets are), and the options (`workers`, `timeoutMs`, `testTimeoutMs`, `signal`). It returns **one result per script, in input order**:

```
{ testId, status: "passed" | "failed" | "timedOut" | "skipped" | "error", durationMs, error?, failedStepIndex,
  steps: [{ index, title, status: "passed" | "failed", error? }], artifacts: [{ kind: "screenshot" | "trace" | "video", path }],
  responses: [{ method, path, status }], metrics?, notes? }
```

`error` means "the framework could not run it" (not installed, crashed), `failed` means "it ran and a check did not hold". Artifact paths must be existing files inside `batch.scratchDir`.

**`host`** is a fourth argument, so a plug-in imports nothing from the platform: `host.js(text)` (a safe JavaScript string literal), and in `execute` also `host.makeRunDir()` (a fresh folder inside the run's scratch folder, named `run-plugin-...`; when `execute` returns or fails the platform removes the folders it made, by the exact paths it recorded, except one that holds a file a result points at (a screenshot not yet copied), which the hourly sweep of old `run-*` scratch folders removes like those of the built-in runners; a plug-in may make at most 200) and `host.runNode({ cwd, args, env, timeoutMs, signal })` (the platform's own way to start a child process: Node.js only, with the filtered environment the Playwright runner uses, so the platform's own secrets such as `API_KEY`, `SECRET_KEY` and LLM keys are never inherited; what the plug-in adds in `env` is the only extra; a time limit; the cancel signal; output capped at 1 MB each; `cwd` must be inside the run folder). A plug-in that spawns a process some other way is on its own: it should apply the same rules.

## What is contained

Every call into a plug-in is wrapped. Contained does not mean safe from a hostile plug-in (it shares the process); it means a mistake stays small.

| Problem in the plug-in | What the platform does |
|---|---|
| Bad manifest, bad adapter object, a module that throws or takes more than 10 s to load, an id clash | That plug-in is not registered (all of its adapters or none). The reason is listed in `GET /api/config` and the Frameworks section. Other plug-ins and the built-ins keep working. |
| `render` throws or returns something invalid | The test gets a plain diagnostic, `The plug-in "name" could not render this test: …` (no stack trace). Other tests render. |
| `execute` throws, returns a wrong count or a non-list | An **error** result for every script of the batch, never a pass. |
| One result is malformed or has an unknown status | An error result for that script only. |
| `execute` hangs | Cut at the run's time limit (`timeoutMs`, else the larger of 120 s and the tests' own limits added up) or when the job is cancelled. The plug-in's own `signal` is aborted so it can stop its processes; the scripts get an error result (or the job ends as cancelled). |
| Oversized or hostile data | Strings, lists and numbers are capped; results are rebuilt field by field from fresh objects, so `__proto__` keys and getters reach nothing; artifacts outside the run folder or that do not exist are dropped with a note; the run's own secrets are masked in text. |

## When a plug-in is gone

The framework id is stored with each test. If the plug-in that provided it is later removed, fails to load, or is switched off, those tests keep their id and **nothing is deleted** (tests, scripts, results, history). Nothing runs them with another framework either:

- A run that includes such a test is refused before it exists (HTTP 409) with a sentence like: `Some tests use the testing framework "x", which an adapter plug-in provides and which is not loaded now. The plug-in "name" did not load: … Nothing was deleted: …`. The sentence says why when it knows (a load problem, plug-ins switched off, not listed).
- A job that was created while the plug-in was loaded and runs after it vanished fails early with the same sentence and the test is left as it was.
- Single-test run from the page: the same 409.
- When the plug-in is loaded again the tests run again.

## Where plug-in tests run, and what they cannot do

- **On the platform server only.** The runner agent has no plug-in loading (see "Not done"). A project that runs its tests on a runner agent refuses a run that includes a plug-in test, in words.
- Only in a **normal run** (including schedules, deploy triggers and runbooks, which create normal runs). Browser and screen-size checks, runs against an environment and plain-English rewrites refuse them in words.
- **Automated runs leave such tests out instead of failing.** A schedule, a deploy trigger or a runbook step that would include a test of a plug-in that is not loaded, or whose project runs on a runner agent, or (for a schedule or runbook step aimed at an environment) any plug-in test, runs the other tests, and the job records a warning event (`plugin_skipped`): "1 test was not run because it uses the plug-in framework "x". <the reason>". Nothing is deleted. If nothing else is left to run, the run says there are no tests that can be run. A person who asks for a plug-in test directly (the run button, a manual run with chosen tests) still gets the plain 409 above, so it is never silently skipped. (A manual run against an environment that includes a plug-in test is refused whole, as before.)
- A project that runs its tests on a runner agent refuses a run that includes a plug-in test with: `This project has tests that use the plug-in framework "Node HTTP check (example plug-in)" (node-http-check), which runs on the platform computer only: runner agents do not have plug-ins. This project runs its tests on a runner agent. Run the project on the platform computer, or move these tests to another project.` The same sentence reaches a person who presses Run again on such a test (409).
- A plug-in cannot become the default framework of a kind: `defaultAdapterFor(kind)` still returns the first registered adapter, which is always a built-in. Only an import with an explicit `framework` stores a test for a plug-in.
- The built-in per-project framework settings (time limits, on and off, workers) are for the built-in frameworks; plug-ins have none. A plug-in framework is on while it is loaded.

## API and code changes

- `GET /api/config`: `adapters[]` entries of plug-in frameworks carry `plugin: { name, version }`; new `adapterPlugins: { requested, enabled, configured, reason?, loaded: [{ name, version, description, adapters: [{ id, label }] }], problems: [{ plugin, message }] }`. Names only, never server paths. Everything else in the answer is unchanged.
- `POST /api/projects/:id/specs`: optional `framework`. A built-in id that is not the kind's own, an unknown id, or an adapter that does not run that kind is a plain 400, and nothing is stored.
- `Config`: `ALLOW_ADAPTER_PLUGINS` (the effective value), `ADAPTER_PLUGINS`, `adapterPluginsRequested`, `adapterPluginsReason`.
- Code: `src/engine/frameworks/plugin.ts` (manifest, contract checks, path rules, result cleaning), `plugin-loader.ts` (loading, the wrapper, `host`, status), `src/platform/plugin-gate.ts` (the job gate and the import choice), a gate field on `Repo.createJob`, the stored framework passed to `runValidationOnly` for non-built-in ids.

## Tests

`tests/review-fixes-bf-plugin-unit.test.ts` and `tests/review-fixes-bf.test.ts` (no server paths in messages, run folders removed, a byte order mark, device names, automated runs that skip plug-in tests, a backup with plug-in tests; no browser), `tests/plugin-unit.test.ts` (fast tier: manifest and adapter table, enable rule, paths, result cleaning, containment including a hung `execute` and the host process helper, doctor wording), `tests/plugin.test.ts` (real platform, the real example plug-in, a fixture API: really run, VALIDATED, a failing assertion with its reason, a broken plug-in, switch off / no key imports nothing, a vanished plug-in, API-key protection, built-ins unchanged), `tests/plugin-ui.test.ts` (the Frameworks section in a browser, axe in both themes, 375 px).

## Not done, and not covered

- **Not a sandbox** (above). No signing, no permissions, no resource limits beyond the time and size caps. A hostile plug-in can do anything the server can. In particular: `batch.scratchDir` is the platform's shared scratch folder (every job, not a folder of this batch), so "inside the run folder" means inside that shared folder, and a plug-in can attach a file another job's run left there as its own screenshot; `env.run` is handed over as a shallow copy, so a plug-in can change the credentials object later batches see; and the platform's own secrets (`SECRET_KEY`, `API_KEY`, LLM keys) are in the plug-in's process like everything else, so only a value the platform knows to hide (a run's accounts and tokens) is masked in its output, not those. The child processes started through `host.runNode` never inherit them. These were reviewed and left as they are: fixing them half-way would suggest a protection that does not exist.
- **Runner agents do not load plug-ins.** Doing it cleanly needs the agent to advertise the plug-in's capabilities, the platform to route by them, and the task process to import the same code on the agent's machine; none of that exists. A project on an agent cannot run plug-in tests.
- No hot reload: plug-ins load at start (restart to change them). No plug-in settings, no per-project on and off, no way to choose a plug-in framework from the web page (import with `framework`, or the API). A per-project switch was looked at and left out on purpose: the project framework settings (`src/engine/frameworks/settings.ts`) are a fixed list of the five built-in ids, with a pinned default, a change log, the executor and the job gate all keyed by it. Carrying an arbitrary adapter id safely (dropping ids of plug-ins that are not loaded, keeping the defaults byte-identical) needs a second store and a second gate, which is more than this gap warranted.
- A failing plug-in test goes through the platform's usual repair step when a model is configured; that path is not exercised by the tests (they never call a model).
- Reusable steps (blocks) are expanded before a plug-in renders (in `renderWithAdapter`). A plug-in test that uses a block of API steps is covered by a test that runs the example plug-in for real: it is rendered and run from the expanded steps, a change to the block reaches it, and its failure reason is the plug-in's own (`tests/blocks-gaps.test.ts`).
- Only Node.js child processes are provided by `host`; a plug-in that needs another program spawns it itself.
- A backup that holds plug-in tests restores on a server where the plug-in is not loaded: the tests and their scripts come back and the restore says so ("1 test uses the plug-in framework "x", which is not loaded on this server ...", a note, not an error); they run again once the plug-in is loaded. A framework name that cannot be a plug-in's (not 2 to 31 lower-case letters, digits and dashes starting with a letter) is still a damaged backup.
- Windows is where this was developed and tested; paths in `ADAPTER_PLUGINS` use the platform's rules (a drive letter on Windows, a leading `/` elsewhere).
