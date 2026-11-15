# AI Studio: existing infrastructure map

What a new testing and bug-discovery engine can reuse instead of rebuilding. Each entry says where the piece lives, what it offers today,
and how a new engine would plug into it. State labels follow `CURRENT_STATE_AUDIT.md`. All file references are under `AI_Studio/src/`
unless stated.

## 1. Reuse summary

| Need of a new engine | Existing piece | Reuse verdict |
|---|---|---|
| Drive a browser, read pages | `engine/discovery/browser.ts`, `crawler.ts`, `snapshot.ts`, `web/interpreter.ts` | Reuse as is |
| Capture traffic while exploring | `engine/discovery/network.ts` | Reuse; extend to keep request/response pairs per action |
| Run generated tests reliably | `engine/frameworks/*`, `engine/validation/runner.ts` | Reuse as is |
| Mobile devices | `engine/mobile/device/*`, Taqwright adapter, device farms | Reuse as is |
| Call APIs, parse OpenAPI, check contracts | `engine/api/*`, `engine/contracts/*` | Reuse as is |
| Call an LLM with typed output | `engine/llm/provider.ts` (`LlmClient.object` + zod) | Reuse as is |
| Tool-calling loops in a real browser | `engine/web/author.ts`, `engine/agent/objective.ts` | Reuse the pattern and the tool set |
| Background jobs | `generation_jobs` + `platform/worker.ts` + `job-runner.ts` | Reuse; add a job mode, not a queue |
| Run work on the customer's network | runner protocol 2 explore task | Reuse; add an explore mode |
| Store results and files | `GenerationSink` / `RepoSink`, `ObjectStore`, `artifacts` | Reuse; add sink methods |
| Evidence for a bug report | `engine/evidence/*`, traces, videos, screenshots | Reuse |
| Findings with dedupe and history | `security/findings/*` | Reuse the model; generalise beyond security |
| Measure test strength | `engine/mutation/*`, `src/eval/*` | Reuse as the benchmark base |
| Access control, project isolation | `platform/auth/*` | Reuse; register new routes in `roles.ts` and `project-scope.ts` |

## 2. Pieces in detail

### 2.1 Browser automation utilities

- **Where:** `engine/discovery/browser.ts` (`BrowserSession`, `launchChromium`, `ariaSnapshot`, `settle`), `discovery/snapshot.ts` (one DOM round
  trip: title, text, links, forms, controls), `discovery/crawler.ts` (BFS same-origin crawl producing `PageModel`s, URL templating
  `urlPattern`), `discovery/auth.ts` (unattended sign-in incl. TOTP), `discovery/guard-proxy.ts` (address guard incl. redirects),
  `engine/snapshots/compact.ts` (bounded snapshots for prompts), `engine/frames/*` (secret-covered small screenshots), `engine/browsers/*`
  (bundled Chromium vs installed Chrome/Edge).
- **Offers:** isolated contexts per task, aria-tree page representation, form discovery, sign-in, saved signed-in sessions
  (`platform/hard-signin-service.ts`), test mailbox for email steps (`platform/mailbox/*`), a screen map of transitions
  (`engine/screenmap/map.ts`, no LLM), per-role crawls (`identity/role-differences.ts`).
- **Reuse:** an application-intelligence or exploratory engine should start from `crawl()` and `buildScreenMap()` output rather than a new
  crawler. The step interpreter `web/interpreter.ts` (`executeStep`, `locate`) is already the single way an AI action touches a page
  (authoring, agent runs, recorder, live sessions, repair), so new exploration tools should call it.

### 2.2 Playwright infrastructure

- **Where:** `engine/generators/playwright.ts` (spec -> TypeScript script, embeds evidence/a11y/contract helpers), `engine/validation/runner.ts`
  (`runScripts`: one `playwright test` child per batch, JSON + partial + live reporters, traces `retain-on-failure-and-retries`, failure
  video, screenshots, `responses` per test), `validation/variants.ts` (browsers, viewports), `visual/baseline.ts`.
- **Offers:** deterministic, re-runnable scripts generated from the canonical `TestSpec` (`engine/spec/schema.ts`: ~20 step actions incl.
  `request`/`assertResponse` with `extract`, `assert` checks, `condition`, `clock`, `email`, `useBlock`).
- **Reuse:** any new test family (stateful, boundary, property-style, concurrency) should be expressed as `TestSpec`s, or as new step actions
  added to the schema and generator, so execution, review, versioning, suites, schedules and reports work unchanged. Mutating fault replay
  (`mutation/faults.ts`) already uses `route.fetch()` to alter only responses; the same mechanism suits fault injection for robustness tests.

### 2.3 Appium / mobile infrastructure

- **Where:** `engine/mobile/device/*` (adb, uiautomator2 source, actions, readiness, emulator start), `engine/mobile/explore/*` (explorer,
  planner, spec builder, safety rules, sign-in with a person gate), `engine/mobile/quality/*` (a11y, logcat, startup, monitor),
  `generators/taqwright.ts` + `validation/mobile-runner.ts` (Taqwright, an Appium-style API on the Playwright runner), `frameworks/ios.ts`
  + `mobile/ios-*.ts`, `engine/mobile/cloud/*` (BrowserStack, Sauce Labs, LambdaTest, generic Appium over WebDriver).
- **Reuse:** the mobile explorer is a separate loop from web; a cross-platform exploratory engine should share objectives, coverage and
  findings, and keep the platform-specific action layer (`device/actions.ts` vs `web/interpreter.ts`).

### 2.4 API clients

- **Where:** `engine/api/openapi.ts` (OpenAPI 3 / Swagger 2), `api/test-specs.ts` (scenario matrix), `api/workflows.ts` (chains with id
  extraction), `api/oauth.ts`, `engine/contracts/check.ts` (JSON-Schema subset validator embedded in scripts), `contracts/diff.ts`,
  `contracts/drift.ts`, `identity/access.ts` (`surveyApiAccess` per role), `performance/load.ts`, `engine/cleanup/*` (delete what tests
  created), `platform/guarded-fetch.ts` (server-side outbound guard).
- **Reuse:** API contract, stateful API and authorization testing can be built on the existing endpoint model (`ApiEndpointModel` in
  `understanding/app-model.ts`) and the `request`/`assertResponse` steps; deterministic generation is already the pattern here (no LLM).

### 2.5 Execution adapters

- **Where:** `engine/frameworks/types.ts` (`FrameworkAdapter { render, execute, needs, traits }`, `ScriptExecutor`, `ExecutionEnv`),
  `registry.ts`, `builtin.ts` (`playwright`, `playwright-api`, `taqwright`), `ios.ts`, `windows.ts`, `plugin-loader.ts` (off by default),
  `executor.ts` (`executorFor(scope)`, resolver installed by `platform/agent-services.ts:1780` for runner routing), `settings-executor.ts`
  (per-project time limits, workers), `mobile/cloud/farm-executor.ts` (device choice wrapper).
- **Reuse:** a new engine never chooses where scripts run; it calls `ctx.executor.execute(adapterId, batch, env, opts)` and gets
  `ScriptRun[]`. Runner routing, farms, framework switches and refusal in hosted mode then apply automatically.

### 2.6 AI provider abstraction

- **Where:** `engine/llm/provider.ts` (`LlmClient`: `object<T>(system, prompt, schema)`, `text`, `imageObject`), `routing.ts` (fast / main /
  strong by purpose, escalation), `resilience.ts` (fallback chain), `metered.ts` + `usage.ts` (per-purpose metering, budgets checked before
  each call), `prompt-cache.ts`, `without-ai.ts`. Server job wiring: `platform/job-runner.ts:jobLlm`. Runner proxy:
  `agent/remote-llm.ts` + `agent-protocol/explore-llm.ts` + `platform/explore-llm.ts`.
- **Reuse:** a new engine receives `ctx.llm` and must not create its own provider client; it then gets metering, budgets, routing,
  fallback, caching and the runner proxy for free. Add a new `LlmPurpose` only if usage must be reported separately (the enum is in
  `usage.ts`; `STRONG_TASKS` in `routing.ts` decides which purposes get the strong model). Key selection is being changed (organisational
  and personal keys, one chosen per person) and is resolved before the engine runs.

### 2.7 Agent orchestration

- **Where:** `engine/web/author.ts` (authoring loop), `engine/agent/objective.ts` (objective loop with fixed tools, limits counted in code,
  fenced page text, secret stand-ins, high-impact approval `high-impact.ts`, verdict needs a passed/failed check), `engine/mobile/explore/*`,
  `engine/authoring/plain.ts`; recorded through `GenerationSink.startAgentRun/agentAction/finishAgentRun` and `objective_run*` tables.
- **Reuse:** the objective loop is the closest existing shape to an exploratory bug hunter: it already separates "application / agent /
  environment / runner" failure categories and refuses verdicts without evidence. A new exploration strategy should be a new objective set
  and tool set over this loop, not a new agent framework. Multi-agent coordination does not exist and is not needed to reuse this.

### 2.8 Database models

- **Where:** `platform/db.ts` (61 ordered migration slots; each feature owns its SQL in its store file), `platform/sql.ts` (async `Sql`),
  `platform/repo.ts` (core tables), store files `platform/*-store.ts`, `security/store.ts`, `platform/pg/baseline.sql` (PostgreSQL schema, not
  used at runtime).
- **Relevant models:** `applications.app_model_json` (latest `AppModel`), `site_memory` (distilled knowledge, diffed between runs),
  `project_notes`, `project_agent_inputs`, `requirements` + `requirement_links`, `test_cases.spec_json` (canonical spec), `test_executions` +
  steps + `variant`, `api_snapshots` (drift), `run_summaries`, `quarantine_*`, `healing_proposals`, `issue_links`, `security_findings` (+
  history, sightings: fingerprint-unique per application).
- **Reuse:** new tables go in a new migration slot owned by a new store file, written in the portable subset (`sql-dialect.ts`) so the planned
  PostgreSQL move stays possible; new stores should use the async `Sql` (the direction of stage M2-M3), and `baseline.sql` must be updated in
  step (a unit test compares it with SQLite).

### 2.9 Job queue

- **Where:** `generation_jobs` + `Repo.claimNextJob` (atomic claim, lease owner, heartbeat, reclaim), `platform/worker.ts` (plain or dispatch
  worker, disk-space wait), `job-runner.ts:runJobAs` (switch on `options.mode`), `scheduler.ts:activeJobOf` (one active job per project),
  `runner-handover.ts` (restart hand-over), `runner-only.ts:RUNNER_JOB_MODES`.
- **Reuse:** a new kind of work is a new `JobMode` value plus a branch in `runJobAs`, added to `RUNNER_JOB_MODES` when it runs on a runner.
  Scheduling, deploy triggers, runbooks, cancel, time limits, events and alerts then work for it. No new queue or broker is warranted.

### 2.10 Local runner

- **Where:** `agent-protocol/schema.ts` (protocol 2), `agent/agent.ts`, `task-runner.ts`, `task-process.ts`, `explore-child.ts` (modes
  `generate`, `plain`, `agent`, `mobile`, `assessment`), `remote-sink.ts`, `remote-llm.ts`, `remote-frames.ts`, `outbox.ts`, `device-task.ts`,
  `record-task.ts`, `address-guard.ts`, `browser-setup.ts`, `updater.ts`; platform side `platform/agent-services.ts`, `agent-store.ts`,
  `explore-dispatch.ts`, `explore-sink.ts`, `explore-llm.ts`.
- **Offers:** outbound-only HTTPS, per-person runner, a child process per task with whole-tree kill, attempt ids and durable results, secret
  scrubbing of logs, private-address rule, platform-side AI, ordered remote sink, chunked evidence upload (8 MB per file, 256 MB per attempt),
  restart-safe explorations (`explore_task_state`).
- **Reuse:** the new engine's browser- and device-touching work runs on the runner by adding an `ExploreTask.mode` (schema enum +
  `explore-child.ts` branch + a capability in `exploreModes`), with its AI and persistence unchanged. Anything that needs the customer's
  network (private addresses, staging behind a VPN) belongs here.

### 2.11 Artifact storage

- **Where:** `platform/object-store.ts` (`ObjectStore` interface, `LocalDiskStore`; key = relative path stored in the database;
  `withLocalCopy` for child processes; signed links planned for S3), `platform/storage.ts`, `artifacts` table, `GenerationSink.saveTextArtifact`,
  `saveBaselines`, `platform/retention-*.ts`, `platform/storage-usage.ts`.
- **Reuse:** store new evidence (HAR-like logs, state snapshots, reproduction bundles) through the store with keys under
  `<projectId>/_artifacts/<jobId>/...`; do not write paths outside it. S3 is planned but not built.

### 2.12 Reporting components

- **Where:** `platform/reports/junit.ts`, `project-report.ts` (HTML/PDF via `platform/pdf.ts`), `release-report.ts`, `platform/trends.ts`
  (flaky vs broken, deltas), `dashboard.ts`, `failure-view.ts`, `run-view.ts`, `cancel-summary.ts`, `engine/evidence/summary.ts`
  (deterministic one-sentence evidence summary), `engine/validation/severity.ts`, `platform/issues/content.ts` (neutral issue document
  rendered for GitHub, Jira, Notion), `security/findings/report.ts`, `xlsx.ts`.
- **Reuse:** a bug report for a new finding should build an `issues/content.ts` document and reuse the evidence summary; the issue filing
  route already exists per test.

### 2.13 Logging and tracing

- **Where:** `EngineEvent` (`engine/context.ts`) -> `agent_events` -> SSE (`platform/stream-core.ts`, `routes/stream.ts`, `event-bus.ts`);
  `platform/ops/logger.ts` (JSON logs with secret scrubbing), `ops/metrics.ts` (Prometheus), Playwright traces per failed test with
  `engine/evidence/trace-scrub.ts`, `frame-hub.ts` (in-memory live pictures).
- **Gaps:** no distributed tracing or correlation id across UI action, API call and backend; the application's own server logs are only
  reachable through the Sentry lookup (`platform/sentry/*`).

### 2.14 Security integrations

- **Where:** `security/assessment/*` (passive assessment loop, probe on runner, judge), `security/scope.ts` (scope guard),
  `security/authorization.ts` (written authorization before testing), `security/findings/*` (normalise, fingerprint, dedupe, history,
  sightings, redaction), `security/scanners/*` (ZAP, Nuclei, Schemathesis, promptfoo adapters; not run in the hosted mode),
  `engine/security/checks.ts` (passive checks also used in functional exploration), `engine/identity/access.ts` (role access checks).
- **Reuse:** the findings pipeline is the best existing base for a general finding lifecycle (fingerprint, first/last seen, validation
  state, reproduction, evidence JSON, history). The scope guard and authorization record are the base for any active or mutating testing.

## 3. Where work belongs: facts for the architecture decision

Facts observed in the code that constrain where new capabilities go.

### 3.1 Backend (AI Studio server)

- Holds all AI calls (keys never leave it; runners proxy calls through `explore/llm`), metering and budgets.
- Holds all persistence: database, object store, and the `RepoSink` that applies every engine write in order.
- Holds orchestration: job queue, scheduling, triggers, runbooks, the security assessment loop, alerts, reports, issue filing.
- In the hosted deployment it never opens a browser or runs a script (`EXECUTION_MODE=runners`; `LocalExecutor` refuses).
- Outbound calls from the server meet `net-guard.ts` (public addresses only), so it cannot reach private targets.
- Several pieces are in-process memory (frame hub, sign-in throttling, event bell, OAuth hand-off): the server is designed as a single
  process with one SQLite file. Horizontal scaling is not possible today without the planned PostgreSQL/S3 move.

### 3.2 Local runner

- Everything that touches the application under test in the hosted deployment: crawling, authoring, running scripts, agent runs, phone
  sessions, security probes.
- Runs the same engine code (`runGeneration`, `pursueObjective`, `runAssessmentOnRunner`) inside a child process; only the transport changes.
- Reaches private and VPN-only targets (subject to its owner's private-address switch).
- Has no AI key and no database; it cannot store or decide anything the platform has not handed it.
- External scanners (ZAP, Nuclei, Schemathesis, promptfoo) do not run here today; moving them would be new work.

### 3.3 Deterministic tools (no LLM) already in the code

Crawler and screen map, network-to-endpoint folding, sign-in, OpenAPI ingestion and the API scenario matrix, API workflows, contract
checks, OpenAPI diff and drift, accessibility (axe-core), page health, passive security checks, access control by role, input checks,
visual baselines, performance and bounded load, record cleanup, locator healing and repair without AI, flaky detection and trends,
severity scoring, evidence summary, site-memory diff, deliberate-fault strength measurement, security finding normalisation and dedupe.
The codebase's existing rule is that a verdict comes from a check that ran, not from a model
(`engine/agent/objective.ts` header, `validation/runner.ts` header).

### 3.4 Where the LLM is used today

`LlmPurpose` values (`engine/llm/usage.ts`): `analysis` (page purposes, features, journeys: `understanding/analyzer.ts`), `planning`
(scenarios: `planning/planner.ts`), `review` (review of generated tests), `authoring` (tool-calling in a real browser: `web/author.ts`,
`agent/objective.ts`, phone explorer), `repair` (failure triage into `locator / timing / test_data / assertion / app_defect / environment /
other` and regeneration: `validation/repair.ts`), `vision` (opt-in "looks right" judgement), `plain` (plain-English authoring), `other`
(requirements parsing, documentation pages, manual cases). Everything else above is deterministic.

### 3.5 How jobs, context, observations and findings flow today

- **Orchestration:** one job row per unit of work, one active job per project, a mode switch in `job-runner.ts`; long work on a runner is one
  explore task per job.
- **Application context:** `AppModel` JSON on the application row (latest only) and as a job artifact; `site_memory` distilled across
  runs; notes, agent inputs and requirements as their own tables; the approved plan as a JSON artifact (`plan-store.ts`).
- **Observations:** per test run, `ScriptRun` carries steps, error, failed step, artifacts and `responses` (method, path, status, body shape);
  failure evidence (requests and console) is captured inside the script and sanitised; traces, video and screenshots on failure. During
  exploration, traffic is folded into endpoint models, not kept as raw per-action logs.
- **Findings:** functional defects are tests in `NEEDS_REVIEW` with executions, deterministic severity and optional issue links; no
  fingerprint, no dedupe across tests, no sightings. Security findings have the full lifecycle.
