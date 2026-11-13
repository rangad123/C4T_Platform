# API reference

This is the list of the platform's web interface (API) calls, for people who write scripts or connect other tools. Every call starts with `/api`. If the platform has an `API_KEY` set, send it in the `x-api-key` header on every call (the deploy trigger calls and the runner program use their own tokens, as noted in the table). Errors come back as `{ "error": "..." }` with a plain sentence and a matching status code.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/projects` | Create a project `{ name }` |
| POST | `/projects/:id/test-generation` | Start generation (same options as the UI) → `{ jobId }` |
| GET · PUT | `/me/ai` · `/me/ai/chosen` | Your AI keys and the one your AI work uses ([ai-keys.md](features/ai-keys.md)) |
| POST · PATCH · DELETE | `/me/ai/keys` (`/:keyId`, `/:keyId/test`) | Your own AI keys; Test this key |
| GET · POST · PATCH · DELETE | `/admin/ai-keys` (`/:keyId`, `/:keyId/test`, `/:keyId/assignees`) | Organisational AI keys and who they are assigned to (Crowd4Test admins) |
| GET | `/test-generation/:jobId` | Job status, progress, counts |
| GET | `/test-generation/:jobId/events` | Activity log |
| DELETE | `/test-generation/:jobId` | Cancel a job |
| GET | `/projects/:id/tests` | List tests (`kind`, `validationStatus`, `suite`, `q` filters) |
| GET | `/tests/:id` · `/tests/:id/script` | Test detail · script text |
| POST | `/tests/:id/validate` | Re-validate a test |
| POST | `/tests/:id/baseline` | Accept new visual baseline |
| POST · GET | `/projects/:id/specs` | Import · export specs (import accepts `mobile: { appPackage }` for mobile tests) |
| GET | `/projects/:id/download` · `/projects/:id/junit` | Zip of validated tests · JUnit XML |
| POST | `/projects/:id/variants` · `/tests/:id/variants` | Check tests on other browsers/sizes `{ variants, testIds? }` |
| GET · POST · PATCH · DELETE | `/projects/:id/schedules` (`/:sid`, `/:sid/run`) | Scheduled runs |
| GET | `/projects/:id/trends` · `/flaky` · `/alert-log` · `/runs/:jobId/summary` | Trend, unreliable tests, alert history, run summary |
| GET · POST · PATCH · DELETE | `/projects/:id/alert-channels` (`/:cid`, `/:cid/test`) | Slack / Teams / email / webhook alert channels |
| GET · POST · PATCH · DELETE | `/projects/:id/integrations` · `/integrations/:id` (`/test`) | GitHub / Jira / Notion connections |
| POST · GET | `/tests/:id/issue` · `/tests/:id/issues` | Create / list issues for a test |
| POST | `/projects/:id/validation` | Re-run a project's runnable tests (used by the CLI's remote mode) |
| PUT | `/projects/:id/mobile-app` | Set the app mobile tests run against `{ appPackage?, avd?, clearApk? }` |
| POST | `/projects/:id/mobile-app/apk?filename=` | Upload an APK (raw body) |
| GET | `/config` | AI model, test formats, and whether this computer can run mobile tests |
| GET · PUT | `/projects/:id/roles` | Named test accounts (secrets are write-only) |
| GET | `/projects/:id/report?format=pdf|html` | Shareable project report |
| GET | `/projects/:id/api-changes[?since=<jobId>]` | What the live API changed between two runs |
| GET | `/projects/:id/compliance` | Control coverage (`?frameworks=NIST-800-53,HIPAA,ISO-27001`) |
| GET · POST · PUT · DELETE | `/projects/:id/environments` (`/:name`, `/:name/secrets`, `/:name/default`, `/:name/runs`, `/:name/results`) | Named environments; secrets are write-only; `runs` needs `confirmProduction` for production |
| GET · POST · PUT · DELETE | `/projects/:id/test-data` (`/:name`) | Data sets (CSV / JSON) for data-driven tests |
| GET · DELETE | `/projects/:id/memory` | What the platform learned about the site · forget it |
| GET · POST | `/tests/:id/healing` (`/:pid/apply`, `/:pid/dismiss`) | Repair suggestions for a failed test |
| GET · POST · DELETE | `/projects/:id/triggers` (`/:tid`) | Deploy trigger tokens |
| POST · GET | `/triggers/:token/run` · `/triggers/:token/status/:jobId` | Run after a deploy · poll the result (token instead of `x-api-key`) |
| GET | `/dashboard[?state=&q=]` | Readiness of every project, with reasons and the rules used |
| POST | `/projects/:id/plain-tests` · `/tests/:id/plain-rewrite` | Build a test from a sentence · rebuild it from a changed sentence |
| GET | `/tests/:id/evidence[?executionId=]` | Requests and console of a failed web test, redacted, with a summary |
| POST | `/projects/:id/import/maestro` | Convert Maestro flows into tests (`dryRun` previews) |
| GET | `/projects/:id/alert-options` | Whether the server has its own mail settings |
| GET · POST · PUT · DELETE | `/projects/:id/runbooks` (`/:rid`, `/:rid/run`, `/:rid/runs`, `/:rid/runs/:runId`, `…/cancel`, `/from-template`) · `/schedules/:sid/runbook` · `/triggers/:tid/runbook` | Runbooks, their runs, and linking a schedule or deploy token to one |
| GET · POST · PUT · DELETE | `/projects/:id/manual-cases` (`/:cid`, `/import`, `/export`) | Manual test cases |
| GET · POST · PUT | `/projects/:id/releases` (`/:rid`, `/refresh`, `/results/:cid`, `/signoff`, `/reopen`, `/report`) | Releases, manual results, sign-off with audit trail, report |
| GET · PUT · DELETE · POST | `/projects/:id/sentry` (`/test`) · `/tests/:id/sentry` | Sentry connection · related errors for a failed test |
| GET · PUT · POST | `/storage` · `/projects/:id/storage` · `/projects/:id/retention` (`/preview`, `/run`) | Disk usage; retention policy, preview and run (run needs `confirm: true`) |
| GET · POST · DELETE | `/projects/:id/backup` · `/projects/restore` · `/projects/:id/restore-needs` | Project backup zip (no secrets) · restore as a new project · clear the re-enter list |
| GET · PUT · DELETE | `/usage` · `/jobs/:id/usage` · `/usage/prices` · `/usage/budgets` · `/projects/:id/usage-budget` | AI usage, prices and budgets |
| GET · POST | `/projects/:id/quarantine` (`/suggestions`, `/history`, `/:qid/release`, `/:qid/review`) · `/tests/:id/quarantine` | Quarantine of flaky tests |
| GET · PATCH · POST | `/me/runner` (`/retire`, `/update`, `/enrollments/:id`, `/download`, `/download/info`) | The person's own runner (one per person, set up in Settings): its state and switches, remove it, update it, the download with its one-time code |
| GET · POST · PUT · DELETE | `/projects/:id/objects` (`/:oid`, `/export`, `/import`, `/extract`) · POST `/tests/:id/steps/:index/share` | Shared UI elements (object repository), extraction of shared locators, "Make shared" for one step |
| GET · PUT | `/projects/:id/framework-settings` | Per-project framework settings and what a run would effectively use |
| GET · POST | `/tests/:id/take-over` · `/tests/:id/restore-generated` | What taking over costs, take over a test, go back to the generated version |
| PUT · POST | `/tests/:id/script` (`/check`) | Save a hand-written script as a new version, check it without saving |
| GET · POST | `/tests/:id/script-versions` (`/:version`, `/:version/restore`) | Version history, one version, restore one |
| GET · PUT · POST | `/tests/:id/spec` (`/preview`) · `/tests/:id/spec-versions` (`/:v`) | Read and save a generated test's steps, preview the script, step history |
| POST | `/projects/:id/built-tests` | Start a test from one valid step in the builder |
| GET · POST · PUT · DELETE | `/projects/:id/blocks` (`/:name`, `/:name/usage`, `/from-steps`) | Reusable step groups: list, create, change, delete, usage, extract from a test |
| POST · GET | `/dsl/parse` · `/dsl/print` · `/dsl/phrases` | Check text without saving, print steps as text, the phrase list |
| POST · GET · PUT | `/projects/:id/dsl-tests` · `/tests/:id/dsl` | Create a test from text, read and save a test's text |
| POST · GET | `/recordings/:rid/act` · `/recordings/:rid/snapshot` · GET `/projects/:id/live-sessions` | Act on a live session, read the page, audit list |
| POST | `/projects/:id/custom-tests` | Write a hand-written test from scratch |
| GET · PUT · DELETE | `/projects/:id/helpers` (`/:name`) | Shared helper modules (delete is refused while a test imports one) |
| GET · POST · DELETE | `/projects/:id/git-imports` (`/:gid/check`, `/:gid/refresh`, `/:gid`) | Preview and import test files from Git, list linked repositories, check, refresh, remove the link |
| POST · GET · DELETE | `/projects/:id/recordings` · `/recordings/:rid` | Start, read and discard a recording session |
| POST · PATCH · DELETE | `/recordings/:rid/inspect` · `/recordings/:rid/steps/:index` (`/share`) · `/recordings/:rid/stop` · `/recordings/:rid/save` | Inspect and assert, edit or share a step, stop, save as a test |
| POST · GET | `/stream-tickets` · `/test-generation/:jobId/stream` · `/projects/:id/stream` | Live updates over server-sent events (a single-use ticket instead of the API key in the URL) |
| GET | `/projects/:id/agents` | Connected runner agents with their capabilities and whether they are online |
| GET · PUT | `/projects/:id/runner` | Where the project's tests run (`platform` or `agent`) and a one-line status |
| POST | `/agent/hello` · `/agent/poll` · `/agent/tasks/:id/heartbeat` · `/agent/tasks/:id/result` · GET/PUT `/agent/tasks/:id/files/:name` | The runner agent protocol: **bearer agent token instead of `x-api-key`**, used by the agent program only |
| GET · PUT · POST | `/projects/:id/cleanup` (`/settings`, `/retry`) · `/tests/:id/cleanup` | Test data cleanup ledger, per-project switch, retry of failed removals |

Example:
```bash
curl -X POST localhost:4000/api/projects -H 'content-type: application/json' -d '{"name":"Shop"}'
curl -X POST localhost:4000/api/projects/<id>/test-generation -H 'content-type: application/json' \
  -d '{"url":"https://staging.example.com","credentials":{"username":"qa@example.com","password":"..."}}'
```
