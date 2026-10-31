# MCP server: drive the platform from Claude, Cursor and other AI tools

## What it does for you

A developer can ask their AI tool, in plain words, "test the checkout of staging and tell me what failed", and the tool does it through the platform: it analyses the application, waits for the job, re-runs tests, and reads back what needs attention.

The MCP (Model Context Protocol) server is a small separate program. It talks to a **running platform** over the same REST API and the same API key as the web app, and it bypasses nothing: the address guard, the production confirmation, the one-active-job rule and the API key all still apply.

## Set it up

You need the platform running (`npm start`) and this repository checked out with `npm install` done. The server is started by your AI tool, not by hand. It speaks MCP over **stdio** and is configured only by environment variables:

| Variable | Meaning | Default |
|---|---|---|
| `AITP_URL` | Where the platform runs | `http://127.0.0.1:4000` |
| `AITP_API_KEY` | The platform's `API_KEY`, sent as `x-api-key` (only when the platform has one) | none |

Start command: `node <path to this repository>/bin/ai-test-mcp.mjs`. (`npm run mcp` also works for trying it in a terminal, but npm prints a banner on stdout, which breaks the protocol when an AI tool launches it. Use `node` in the configuration.)

### Claude Code

```
claude mcp add ai-testing --env AITP_URL=http://127.0.0.1:4000 --env AITP_API_KEY=your-key -- node C:/path/to/automation-testing/bin/ai-test-mcp.mjs
```

or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "ai-testing": {
      "command": "node",
      "args": ["C:/path/to/automation-testing/bin/ai-test-mcp.mjs"],
      "env": { "AITP_URL": "http://127.0.0.1:4000", "AITP_API_KEY": "your-key" }
    }
  }
}
```

### Claude Desktop

Add the same block under `mcpServers` in `claude_desktop_config.json` (Settings, Developer, Edit config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "ai-testing": {
      "command": "node",
      "args": ["C:/path/to/automation-testing/bin/ai-test-mcp.mjs"],
      "env": { "AITP_URL": "http://127.0.0.1:4000", "AITP_API_KEY": "your-key" }
    }
  }
}
```

### Cursor

Put it in `.cursor/mcp.json` (one project) or `~/.cursor/mcp.json` (all projects):

```json
{
  "mcpServers": {
    "ai-testing": {
      "command": "node",
      "args": ["/path/to/automation-testing/bin/ai-test-mcp.mjs"],
      "env": { "AITP_URL": "http://127.0.0.1:4000", "AITP_API_KEY": "your-key" }
    }
  }
}
```

Leave `AITP_API_KEY` out when the platform has no key. The key is never printed: not in tool answers, not in errors, not in the server's own log lines (the start-up line on stderr only says that a key is set).

## The tools

Each tool has a strict input schema (a misspelled argument is an error, not silently ignored). Answers are short text: the summary first, ids always, long lists cut with "...N more", and any answer cut to 12,000 characters (scripts: 20,000).

| Tool | What it does | Changes data? |
|---|---|---|
| `list_projects` | Projects with test counts and the latest job state | no |
| `get_project` | Address, readiness (from the dashboard when the platform has one), test counts by status, latest job | no |
| `analyze_application` | `{ url, name?, projectId?, includeWebTests?, includeApiTests?, openApiUrl?, apiBaseUrl?, maxPages?, ... }`. Creates the project if needed (or reuses the one with that name), starts generation, returns the job id and **echoes exactly what was switched on** | starts a job |
| `get_job` | Status, progress steps, counts, problem, latest messages | no |
| `wait_for_job` | Polls until the job ends or `timeoutSeconds` (default 60, at most 120) passes, then returns the summary or the current state; call again with the same id to keep waiting | no |
| `list_tests` | `{ projectId, status?, q?, limit? }` with ids, keys, status, severity | no |
| `get_test` | Steps in words, status, severity, last failure reason, results per environment | no |
| `run_tests` | Re-validate: `{ projectId, environment?, testIds?, confirmProduction? }` | starts a job |
| `get_failures` | The needs-attention list, most serious first, with reasons (what the Overview page shows) | no |
| `write_test` | `{ projectId, description, kind?, environment? }`: a test from a plain-English description | starts a job |
| `get_dashboard` | Readiness of every project | no |
| `download_script` | The runnable script of one test, as text (capped) | no |

There is also a resource template, `aitp://projects/{projectId}/report`, that returns a small JSON summary of a project (counts, readiness, latest job). The HTML report is far too large for a model, so it is not offered.

## Safety rules

- **Read-mostly.** Only `analyze_application`, `run_tests` and `write_test` start work, and they are marked as not read-only so the AI tool can ask you first.
- **Risky switches stay off.** `analyze_application` always sends data-changing API tests and load checks as **off** unless the caller passes `allowMutatingApiTests: true` or `loadChecks: true`. There is no mobile option. The answer lists every switch.
- **Production needs a yes from a person.** Running against a production environment is refused by the platform unless `confirmProduction` is true. The tool relays the refusal and tells the AI to ask you first; it passes `confirmProduction` only when it is `true`.
- **One job at a time.** If the project already has an active job the platform's 409 message (with the job id) is relayed.
- **No unbounded loops.** One `wait_for_job` call polls at most 60 times, and after 30 waits on the same job in one session the server stops waiting and says so.
- **No credentials through the AI.** The tools take no passwords or tokens; set test accounts and environments in the platform.
- **Errors are plain.** A refusal from the platform is passed on as its own message. A network failure says "Could not reach the platform at host:port. Is it running?". A wrong or missing key says so and what to set. Stack traces and the key are never shown.

## What `run_tests` can do

- No `testIds`, no `environment`: all runnable tests against the project's own address.
- One test (id or key like `API-001`), no environment: that test.
- `environment`: all tests, or the chosen ones, against that environment.
- Several chosen tests without an environment: not offered by the platform; the tool says so (pick one, run all, or name an environment).

`get_project` says the last run's result as a sentence with its denominator ("17 of 17 tests that ran passed. 6 other tests did not take part in that run..."), not as a bare percentage. (An earlier version multiplied the percentage by 100.)

## Limits

- It needs a running platform; it does not start one.
- `write_test` works only on platform versions that have `POST /api/projects/:id/plain-tests` and an AI model set up. Otherwise it answers "not available in this platform version" or relays the platform's "no AI model" message. `get_dashboard` and the readiness line of `get_project` degrade the same way on platforms without a dashboard.
- Only stdio transport; no remote (HTTP) MCP endpoint.
- The listing tools show the first 30 to 100 entries and say how many more there are.
- The server needs the repository (it runs TypeScript through `tsx`, like `ai-test`).

## How it is tested

`tests/mcp.test.ts` starts a real platform (HTTP on a local port, real worker, no model) with the sample app as the target and connects with the MCP SDK's own client to the real server process over stdio. It checks the tool list and schemas, empty then populated projects, analyze, wait, list tests, failures, re-runs including the production refusal and confirmation, API-key behaviour (missing and wrong key, the key never in any output or log), an unreachable platform, output caps, unknown tools and invalid arguments, and `write_test` degrading on a platform without the route.

The MCP server uses the official `@modelcontextprotocol/sdk` (MIT), listed in `THIRD_PARTY_LICENSES.md`.
