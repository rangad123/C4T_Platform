# Example adapter plug-in: node-http-check

A small, real plug-in that adds a testing framework to the platform without changing the platform. It runs **API tests** as plain Node.js scripts that use the built-in `fetch` and `node:assert`. No dependencies.

It is meant to be read and copied. The full guide, the contract and the safety notes are in `docs/features/adapter-plugins.md`.

## The files

| File | What it is |
|---|---|
| `plugin.json` | The manifest: the plug-in's name, version, `apiVersion` (always 1) and the adapters it adds (`id` and a plain-words `label`). The platform reads and checks this file **before** it opens the code. |
| `adapter.mjs` | The code. Its default export is the adapter: `id`, `label`, `kinds`, `executable`, `runtime`, `needs`, `traits`, plus `render` and `execute`. |
| `README.md` | This file. |

## What it does

- `render(spec, ctx, host)` turns the API steps of a test (`request` and `assertResponse`) into one script, `API-001.node-http-check.mjs`. It is pure: the same test gives the same script. The script holds no secrets. It reads the address (`API_BASE_URL`) and the stored API token (`API_TOKEN`, `API_AUTH_HEADER`) from the environment and refuses to send a request to any other site than the API's own.
- `execute(batch, env, opts, host)` writes the scripts into a fresh folder inside the run's scratch folder, starts Node for each one (up to three at a time) through `host.runNode`, reads the JSON result file each script writes, and returns **one result per script, in the same order**: passed or failed, the steps, the failing step's reason, and the responses it saw. A script that dies before it reports is an `error` result with the last of its output, never a pass.
- Checks it supports: `status`, `statusClass`, `statusBelow`, `jsonPath`, `jsonType`, `header`, `bodyContains`, `bodyNotContains`. Anything else is refused when the script is rendered, with a plain sentence, so a test is never silently half-checked.

`host` is handed in by the platform, so the plug-in imports nothing from it:

| `host` | What it gives |
|---|---|
| `host.js(text)` | `text` as a JavaScript string literal that is safe to paste into a script, whatever it holds |
| `host.makeRunDir()` | a new empty folder inside the run's scratch folder (artifact paths you return must stay inside it) |
| `host.runNode({ cwd, args, env, timeoutMs, signal })` | starts Node with the platform's filtered environment (the platform's own secrets are never passed), a time limit and the cancel signal; returns `{ exitCode, stdout, stderr, timedOut, aborted }` |

## Turn it on

A plug-in is code that runs inside the platform, so it is off by default and needs three settings in the environment of the server (for example in `.env`). They are read at start; they cannot be set from the API or the web UI.

```
ALLOW_ADAPTER_PLUGINS=true
API_KEY=choose-a-long-secret
ADAPTER_PLUGINS=C:\full\path\to\automation-testing\examples\adapter-plugin
```

`ADAPTER_PLUGINS` is a list of full paths separated by semicolons: a folder that holds `plugin.json` and `adapter.mjs`, or a single `.mjs` or `.js` file with a `<name>.plugin.json` next to it. Without `API_KEY` the switch is ignored (the platform says so when it starts and in `GET /api/config`).

Start the server. `GET /api/config` now lists `node-http-check` under `adapters` (with `plugin: { name, version }`) and shows it in the Frameworks section of the Runners tab with a "Plug-in" label. `npm run doctor` states in words whether plug-ins may load.

## Use it

A test is stored for a plug-in framework when you import it with a `framework`:

```
POST /api/projects/<id>/specs
{ "baseUrl": "http://localhost:3000", "framework": "node-http-check", "specs": [ { "title": "Items are listed", "kind": "api", "steps": [
    { "action": "request", "method": "GET", "path": "/api/items" },
    { "action": "assertResponse", "check": "status", "expected": 200 } ] } ] }
```

The test is rendered by this plug-in and run on the server by a normal run, like any other test. Its results, findings and history look the same as for built-in frameworks.

## Copy it for another framework (for example Selenium)

1. Copy this folder and rename it. In `plugin.json` change `name` and the adapter `id` (2 to 31 lower-case letters, digits and dashes, starting with a letter; it is stored in databases, so never rename it later). It may not be the id of a built-in framework.
2. In `adapter.mjs` change `ID`, `label`, `kinds` (`"web"`, `"api"`, `"mobile"` or `"desktop"`) and `runtime` (a name of your own: adapters with the same runtime run together in one batch; it may not be a built-in runtime).
3. Replace `renderScript()` with the code that turns a test's steps into your framework's script. Keep it pure and keep secrets out of the text; read them from the environment the script runs in.
4. Replace `runOne()` and `execute()` with the code that starts your framework (through `host.runNode` when it is a Node program) and turns its output into the neutral result: `{ testId, status, durationMs, error?, failedStepIndex, steps, artifacts, responses }`. Return exactly one result per script, in order. A framework that is not installed is an `error` result with a sentence that says what to install.
5. Set `needs` honestly (`{ node: true }`, `browsers`, `android`, `ios`, `windows`) and the three `traits` (all `false` is the safe answer: no vision judgement, no cleanup ledger, no platform-side repair).
6. List the new folder in `ADAPTER_PLUGINS`, restart, and check `GET /api/config` for your adapter and for any problem the platform reports about it.

## Limits

- API tests only, with JSON request bodies; no file uploads, no cookies kept between requests, no redirects followed, none of the security, latency, load or contract checks the built-in API framework has.
- It runs on the platform server only, not on a runner agent.
- A plug-in has the full power of the platform process. Only load plug-ins you wrote or reviewed.
