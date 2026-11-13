# AI Testing Platform — Architecture

A standalone platform that takes an application URL, autonomously explores and understands the
application, plans tests, generates executable scripts, **runs them to validate them**, and stores
the validated suite. There is no chat or copilot surface: the AI is an internal backend service.

## 1. Overall architecture

```
 HTTP API (Fastify)                      Worker (embedded or `npm run worker`)
 ─────────────────                       ────────────────────────────────────
 POST /api/projects/:id/test-generation ─► generation_jobs (SQLite, state QUEUED)
                                              │ claim (atomic UPDATE…RETURNING, 60 s lease + heartbeat)
                                              ▼
                                        runJob ──► Orchestrator (src/engine/orchestrator.ts)
                                              │
   DISCOVERING ── Discovery ─ crawl, safe interactions, login, network capture, OpenAPI probe
   ANALYZING   ── Application understanding (LLM) → AppModel, journeys
   PLANNING    ── Test planning (LLM) → scenarios
   GENERATING  ── Web: authoring agent drives a real browser → canonical specs
                  API: OpenAPI/traffic → canonical specs (deterministic)
                  Script generators render specs → Playwright / Playwright-API / Taqwright
   VALIDATING  ── Playwright executes every script → pass? → VALIDATED
                                              └ fail → triage → regenerate → re-run (≤ N)
                                              ▼
                       SQLite (projects, tests, specs, scripts, executions, events)
                       + artifact store  generated-tests/<project>/<suite>/<TEST-ID>.spec.ts
 React UI (web/) ◄── polls job + events ──────┘
```

Source layout (`src/`):

| Dir | Responsibility |
|---|---|
| `engine/discovery` | Browser session, BFS crawler, auth/login, network interception, snapshots |
| `engine/understanding` | `AppModel` types + LLM analyzer |
| `engine/planning` | Scenario planner |
| `engine/spec` | **Canonical test specification** (zod) |
| `engine/web` | Authoring agent + live step interpreter |
| `engine/api` | OpenAPI ingestion, API test-spec generation |
| `engine/generators` | Spec → script renderers (Playwright, Playwright-API, Taqwright) + registry |
| `engine/validation` | Playwright runner, failure triage/repair, validation loop |
| `engine/orchestrator.ts` | Pipeline; talks to storage only through `GenerationSink` |
| `platform/` | SQLite, repository, queue/worker, artifact store, HTTP server |
| `web/` | React UI |

`engine/` has no dependency on `platform/`: the pipeline can be driven by any host that implements
`GenerationSink`.

## 2. AI workflow

1. **Discovery** (no LLM). Chromium opens the URL; if credentials were supplied it logs in first.
   A same-origin BFS crawl (limits from the exploration level, `src/engine/levels.ts`: thorough 60 pages, depth 4, 3 pages per URL pattern; sitemap-seeded)
   records for each page: accessibility snapshot, headings, forms (classified login/signup/search/…),
   controls, links, API calls, console errors, screenshot. It performs *safe* interactions only
   (menus/tabs/accordions) and never follows or clicks logout/delete/pay-style links. Network traffic
   is captured (secrets redacted) and well-known OpenAPI/Swagger URLs are probed; if none match,
   spec-looking URLs the app itself fetched (e.g. Swagger UI loading `/api/v3/openapi.json`) are
   tried. API-only jobs load the start page once so this traffic is observed. The spec document
   itself is never turned into a test.
2. **Understanding** (LLM). One structured call over the whole crawl produces site type, purpose,
   features, page purposes and 4–12 prioritised user journeys → persisted `AppModel`.
3. **Planning** (LLM). Scenarios (title, category, type, priority, preconditions, expected results,
   required data) including negative/validation cases; irreversible real-world actions are excluded.
4. **Generation.**
   - *Web*: for each scenario an authoring agent performs the scenario in a fresh browser using
     semantic tools (click/fill/select/check/press/hover/navigate/assert). Only steps that
     **actually worked** are recorded; assertions are mandatory (a "complete" test with no
     assertion is rejected). Outcome `defect` (app behaves differently from the expectation) is
     stored as `NEEDS_REVIEW` instead of being forced to pass. After authoring, the recorded steps
     are replayed once in a clean browser and non-assertion steps that fail there are dropped —
     leftovers of attempts the agent abandoned and redid (seen in real runs as a duplicated login).
     The pruned version is kept only if every assertion still passes, so pruning cannot mask a failure.
   - *API*: deterministic from OpenAPI (preferred) or observed traffic: happy path + contract
     checks, missing/invalid fields, no-credentials, unknown/malformed ids, boundary strings,
     SQL-injection/XSS payloads.
5. **Validation.** Every script is executed by Playwright. Pass → `VALIDATED`. Fail → an LLM
   triages (locator / timing / data / assertion / app defect / environment). Fixable failures are
   regenerated (web: authoring agent resumes from the last working step with the failure text; API:
   corrected request/assertions) and re-run, up to `MAX_REPAIR_ATTEMPTS` (default 2). Application
   defects → `NEEDS_REVIEW`; everything else unresolved → `FAILED_VALIDATION`. Self-healing is
   intentionally minimal.

## 3. Repository reuse and decisions

`USE` = reused as-is, `MODIFY` = adapted, `REPLACE` = written new because the upstream is weaker or
unusable, `IGNORE` = not used. Statuses reflect what was actually done in this repo.

| Component | Candidates | Quality / notes | Decision |
|---|---|---|---|
| Crawler | autospec (3 pages, links only); QAAgency (≤8 links from landing page); autonomous-qa-agent (Python BFS, unlicensed) | None is a real crawler; a Python one can't be copied (license) or run in a TS worker | **REPLACE** — new BFS crawler with the platform's own page extraction; SPA-aware (hash routes, pushState/client-side navigation) |
| Page snapshot / DOM extraction | QAAgency `captureSnapshot`; autospec `ariaSnapshot` | QAAgency is richer (forms, links, controls), but has no LICENSE file | **REPLACE** — `discovery/snapshot.ts` written for the platform (the copy used at first was replaced) + autospec's aria approach |
| Network / API discovery | QAAgency `NetworkInterceptor` | Only candidate; no redaction; no LICENSE file | **REPLACE** — `discovery/network.ts` written for the platform (redaction, id templating, auth sniffing); the adapted copy used at first was replaced |
| Auth handling | QAAgency `AuthAgent` | Interactive prompts + LLM selectors | **REPLACE** — non-interactive, deterministic sign-in in `discovery/auth.ts`; the sign-in checks first adapted from QAAgency were rewritten |
| Browser agent loop | autospec `executor.ts`; QAAgency `explorer.ts` | autospec: clean tool loop with fresh snapshot per step; QAAgency: free-form selector strings from the LLM | **MODIFY** autospec's loop; **IGNORE** QAAgency's |
| Application understanding | QAAgency `analyzeSite`; autonomous-qa-agent flow inferencer | Both analyse one page / DOM | **MODIFY** QAAgency's framing, applied to the full crawl |
| Test planning | autospec planner; QAAgency planner | autospec: 1-line specs; QAAgency: plans but no structure for preconditions/data | **MODIFY** both → structured scenarios |
| Web script generation | autospec replay writer; QAAgency LLM-writes-TS; autonomous-qa-agent pytest POM | autospec: deterministic but **no assertions**; QAAgency: unvalidated free text; autonomous: Python/pytest | **MODIFY** autospec's mapping, driven by canonical spec + assertions |
| Test execution/validation | autospec (AI judges pass/fail); QAAgency (none); ai-testing-agent (pytest run); autonomous-qa-agent (pytest) | None re-executes the *generated script* as the arbiter | **REPLACE** — Playwright runner + JSON report parsing |
| Failure analysis | ai-testing-agent `failure_analyzer`; autonomous-qa-agent severity scorer | Triage idea is sound | **MODIFY** prompt shape; repair loop new |
| OpenAPI parsing | ai-testing-agent `spec_ingestion.py` | Solid, tested (65 upstream tests pass) | **MODIFY** (ported to TS) |
| API test scenarios | ai-testing-agent `request_body_handler.py`; QAAgency `api-test.ts` | ai-testing-agent far more complete | **MODIFY** ai-testing-agent's matrix; **IGNORE** QAAgency's |
| API workflow (chain) tests | ai-testing-agent `chain_detector.py`, `chain_test_generator.py` | Only candidate; pytest output | **MODIFY** — `api/workflows.ts`, canonical specs with `extract` |
| Requirements documents | ai-testing-agent (`parse_requirements`, txt/md/pdf/docx input) | Only reads UTF-8 text in practice; free-form LLM JSON | **MODIFY** — `requirements/`: real pdf/docx extraction, deterministic parse + LLM refinement, coverage |
| API test runner | ai-testing-agent (pytest+requests) | Needs a Python runtime | **REPLACE** with Playwright `request` fixture (one Node toolchain) |
| Mobile abstraction | Taqwright | Playwright-like API (`mobile.getByRole…`) | **USE** as target API (no code copied) |
| Mock AI mode | ai-testing-agent | Violates "no fake AI" | **IGNORE** |
| Accessibility audit | autonomous-qa-agent (unlicensed); QAAgency `a11y-test.ts` | Can't copy the former | **REPLACE** — written independently on `@axe-core/playwright` (`a11y/`) |
| Visual diff / severity scoring | autonomous-qa-agent | Valuable, but unlicensed | **IGNORE** (candidate if licensed) |
| Docs-page scraping (`/test_cases`, `/api_list`) | QAAgency | Useful on sites that publish them | **REPLACE** — the idea only: `discovery/docs.ts` written for the platform (the port used at first was replaced); feeds `documentedTestCases` (planner covers them) and documented APIs |

What was actually run from the clones: autospec typechecks and its unit test passes; ai-testing-agent's
65 tests pass; Taqwright's source was read to verify its API. The LLM-driven flows of autospec,
QAAgency and autonomous-qa-agent were **not** run — they need provider keys and none was available.

## 4. Agent responsibilities

| Component | Uses LLM | Responsibility |
|---|---|---|
| Orchestrator | no | Phase sequencing, partial-failure tolerance, counters, final status |
| Discovery | no | Crawl, login, network/OpenAPI capture → `AppModel` (raw) |
| Application understanding | yes (1 call) | Purposes, features, journeys |
| Test planning | yes (1 call) | Scenarios |
| Web authoring agent | yes (tool loop, one run per scenario) | Perform scenario in browser → canonical steps |
| API spec generator | no | OpenAPI / traffic → canonical specs |
| Script generators | no | Spec → code (pure functions) |
| Validator | no | Execute, classify, drive repair |
| Failure triage / repair | yes | Decide fixable vs defect; regenerate |

Observability stores concise events and agent tool calls (`agent_events`, `agent_runs`,
`agent_actions`) — never model reasoning.

## 5. Canonical test specification

`src/engine/spec/schema.ts` (zod). The spec — not the script — is the source of truth; scripts are
re-rendered from it.

```json
{
  "testId": "WEB-001",
  "title": "Login succeeds with valid credentials",
  "kind": "web",
  "category": "Authentication",
  "type": "functional",
  "priority": "critical",
  "preconditions": ["User account exists"],
  "steps": [
    { "action": "navigate", "url": "/login" },
    { "action": "fill", "locator": { "by": "label", "value": "Email" }, "value": "{{credentials.username}}" },
    { "action": "fill", "locator": { "by": "label", "value": "Password" }, "value": "{{credentials.password}}" },
    { "action": "click", "locator": { "by": "role", "role": "button", "value": "Log in" } },
    { "action": "assert", "check": "visible", "locator": { "by": "role", "role": "heading", "value": "Welcome" } }
  ],
  "expectedResults": ["Account page is displayed"],
  "testData": {},
  "tags": ["functional", "critical"],
  "source": { "scenarioId": "S-001", "origin": "browser-agent" }
}
```

Step actions: `navigate click fill select check press hover wait assert` (UI) and `request assertResponse`
(API). Locators use the Playwright/Taqwright `getBy*` vocabulary (`role label text placeholder testId css`).
Placeholders: `{{unique}}`, `{{name}}` from `testData`, `{{credentials.username|password}}`
(rendered as `process.env.TEST_USERNAME/TEST_PASSWORD` — secrets are never written into scripts).

## 6. Script generation

`generators/` — pure `render(spec, ctx) → {filename, content}` per framework, registered in
`generators/index.ts`:

| Framework | Kind | Executed by the platform |
|---|---|---|
| `playwright` | web | yes |
| `playwright-api` | api | yes |
| `taqwright` | mobile (Appium) | **yes, on an Android emulator** when the machine has the toolchain and the project has an app (see "Mobile testing"); otherwise tests stay `PENDING` with the reason. Scripts rendered from a web test on demand (`POST /api/tests/:id/scripts`) are stored, not run. |

Every step is wrapped in `test.step("N. description", …)`, which is how the validator reports the
failing step.

## 7. Validation

`validation/runner.ts` writes scripts to `.validation/run-*/` (inside the repo so
`@playwright/test` resolves), runs `playwright test` with the JSON reporter, and parses status,
error, per-step results, screenshots and traces. `validation/validator.ts` runs all scripts in one
batch, then repairs failures individually.

Deterministic findings (no LLM needed): API scripts record every response and attach it to the
report. Before any repair is attempted, a failure is classified as an application finding
(`NEEDS_REVIEW`) when it is unambiguous: any **5xx** response, or a "no credentials" test whose
documented-secured endpoint returned **2xx**. Only remaining failures go to LLM triage/repair.

Validation states: `PENDING → VALIDATING → VALIDATED | FAILED_VALIDATION | NEEDS_REVIEW`.
A test is `VALIDATED` only if its rendered script passed under Playwright.

Safety: state-changing API methods (POST/PUT/PATCH/DELETE) are generated only when the job sets
`allowMutatingApiTests`, because validation executes against the live application.

## 8. Job lifecycle

`QUEUED → DISCOVERING → ANALYZING → PLANNING → GENERATING → VALIDATING → COMPLETED | PARTIALLY_COMPLETED | FAILED`

- `COMPLETED`: ≥1 test, all validated, and no phase errored. `PARTIALLY_COMPLETED`: tests exist but
  some are not validated, or a phase errored (e.g. no LLM: deterministic API/accessibility tests still
  run, the AI web path does not). `FAILED`: no tests could be produced, or the pipeline crashed/was cancelled.
- Per-phase state (`pending/running/done/skipped/failed`) and counters are stored on the job.
- Phases fail independently: with no LLM, a job with `targets:["api"]` still completes; a web job
  records discovery results and then fails with a clear "no LLM credentials" error.
- Workers hold a 60 s lease renewed by heartbeat; an orphaned job is re-queued (its partial tests
  deleted) up to 3 attempts. `DELETE /api/test-generation/:jobId` cancels cooperatively.
- One active job per project (409 otherwise).

## 9. Database

SQLite (`node:sqlite`, WAL), migrations in `platform/db.ts`.

`users, projects, applications` (URL, non-secret config, **AES-256-GCM-encrypted credentials**,
latest `app_model_json`), `environments`, `test_suites`, `generation_jobs` (queue + progress +
counters), `test_cases` (canonical `spec_json`, validation status/reason, framework, attempts,
generation metadata), `generated_scripts` (versioned, `is_current`, `executable`),
`test_executions` + `test_execution_steps`, `agent_runs` + `agent_actions` + `agent_events`,
`artifacts`. `AgentObservation` from the brief is folded into `agent_actions.observation` and
`agent_events`.

Artifacts: `data/generated-tests/<projectId>/<suite-slug>/<TEST-ID>.spec.ts` and
`…/_artifacts/<TEST-ID>/attempt-N/{screenshot,trace}`, `…/_artifacts/<jobId>/application-model.json`.
Paths in the DB are relative to the store root; swap `ArtifactStore` for object storage if needed.

## 10. API

Base `/api`; optional `x-api-key` when `API_KEY` is set.

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects` | Create project |
| GET | `/projects`, `/projects/:id` | List / detail (latest app + job + suites) |
| POST | `/projects/:id/test-generation` | Start a job → `202 {jobId, status:"QUEUED"}` |
| GET | `/test-generation/:jobId` | Status, per-phase progress, counters (`testsGenerated/Validated/FailedValidation/NeedingReview`) |
| GET | `/test-generation/:jobId/events?after=` | Observability events |
| DELETE | `/test-generation/:jobId` | Cancel |
| GET | `/projects/:id/tests` (`kind, validationStatus, suite, q`) | Test list |
| GET | `/projects/:id/suites`, `/application-model`, `/jobs`, `/download` | Suites, model, history, zip of validated tests |
| GET | `/tests/:id`, `/tests/:id/executions`, `/tests/:id/script?framework=` | Detail / executions / script text |
| POST | `/tests/:id/scripts` `{framework}` | Render the spec for another framework |
| GET | `/artifacts/:id` | Screenshot / trace / model |
| POST | `/projects/:id/specs` `{specs, baseUrl?, credentials?, validate?}` | Import canonical specs (testId optional); all-or-nothing validation; starts a validation-only job |
| GET | `/projects/:id/specs` | Export all canonical specs (round-trips into the import) |
| POST | `/tests/:id/validate` | Re-validate one test (validation-only job) |
| POST | `/tests/:id/baseline` | Accept the latest run's screenshots as the approved visual baseline, then re-validate |
| GET | `/projects/:id/compliance?frameworks=` | Indicative coverage of NIST 800-53 / HIPAA / ISO 27001 controls by the project's tests (computed on read; `/tests/:id` and the download manifest also list each test's `controls`) |
| PUT | `/projects/:id/mobile-app` `{appPackage?, avd?, clearApk?}` | Set the app mobile tests run against |
| POST | `/projects/:id/mobile-app/apk?filename=` | Upload an APK (raw body) |
| GET | `/projects/:id/junit` | JUnit XML of each test's latest validation run (findings = failures of type `application-finding`) |
| GET | `/health`, `/config` | Health; LLM + framework info |

Generation request body: `url` (required), `credentials{username,password,apiToken,apiAuthHeader}`,
`targets["web","api"]`, `scope`, `includePaths`, `maxPages`, `maxDepth`, `maxScenarios`,
`allowMutatingApiTests`, `openApiUrl`, `apiBaseUrl`. `BLOCK_PRIVATE_TARGETS=true` refuses
loopback/private-network targets (SSRF guard for hosted deployments; off by default so local and
staging environments can be tested).

## Additional test sources

- **API workflows** (`engine/api/workflows.ts`): multi-request tests built from OpenAPI/traffic. A
  `request` step can `extract` response values into variables (`{ "id": "0.id" }`) used by later
  steps as `{{id}}`; a missing capture fails the test explicitly. Safe list → detail chains always run;
  create → read → update → delete and login → secured-call chains need `allowMutatingApiTests`.
- **Accessibility audits** (`engine/a11y/`): one deterministic `accessibility` test per key page
  (`assert check:"a11y"`, WCAG 2.0/2.1 A+AA via axe-core, `expected` = minimum failing impact,
  default `serious`). Violations are an application finding → `NEEDS_REVIEW` with rule ids, impact
  and targets as the reason. Toggle with `accessibility` (default on).
- **Requirements documents** (`engine/requirements/`): upload txt/md/pdf/docx as
  `requirements: {filename, contentBase64}` on test generation. Text is extracted at submit time
  (bad files → 400), requirements are parsed (document ids preserved; LLM refinement optional), the
  planner covers them and cites ids per scenario (`scenario.requirements` → `spec.source.requirements`),
  and coverage is recorded: counters `requirementsTotal/Covered`, a `requirement_uncovered` event per
  gap, and a `requirements-coverage.json` artifact. Unmappable requirements stay uncovered — never faked.
- **User-supplied specs**: import canonical specs; they are rendered, executed and validated by a
  validation-only job (`mode: "validate"` — discovery/understanding/planning/generation `skipped`)
  through the same queue, worker, lease and repair machinery. Any test can be re-validated on demand.

## Visual regression (opt-in: `visual: true`)

`engine/visual/baseline.ts`. One `visual` test per key page (same page selection as the
accessibility audits): navigate + `assert check:"screenshot"` (full page or a locator; `expected` =
tolerated differing pixels, default 100; animations disabled, caret hidden).

1. **First validation captures the baseline.** Playwright writes the missing screenshot; the validator
   stores it (`_baselines/<TEST-ID>/<TEST-ID>-<step>.png`, artifact kind `baseline`) and re-runs once.
2. **Stability check.** If the page differs between two consecutive loads (clocks, carousels, ads) it
   cannot be baselined → `FAILED_VALIDATION` ("not visually stable"), not a finding.
3. **Later validations compare** against the approved baseline. A difference is an application change
   → `NEEDS_REVIEW`, severity low, with `visual-actual` and `visual-diff` images shown on the test page.
4. **Accept as new baseline** (`POST /tests/:id/baseline`, or the button) when the change is intended;
   the acceptance is confirmed by an automatic re-validation.

Baselines are per browser/OS rendering: one captured on Windows will differ from Linux CI renders, so
capture and compare on the same kind of host (e.g. always in the Docker image).

## Reviewing results

- **Severity** (`engine/validation/severity.ts`): every `NEEDS_REVIEW` finding gets
  critical/high/medium/low plus its basis, computed on read from facts already stored — auth bypass →
  critical; 5xx → high (critical on a critical journey); accessibility by worst axe impact; functional
  defects by journey priority (one step higher for security tests). `FAILED_VALIDATION` (a broken
  test) gets none. Written independently (autonomous-qa-agent's scorer is unlicensed).
- **Artifacts of failed runs**: screenshot, Playwright trace and **video** (`retain-on-failure`).
- **JUnit**: `GET /projects/:id/junit`; the downloaded zip includes `results/validation-junit.xml` and a
  Playwright config with a JUnit reporter for running the suite in CI.

## API authentication for tests

Static bearer token (`credentials.apiToken`), a custom header (`apiAuthHeader`), or **OAuth2
client credentials** (`credentials.oauth2 {tokenUrl, clientId, clientSecret, scope?, audience?,
authMethod: basic|body}`). The token is fetched once per validation run (redirects not followed; the
token URL passes the SSRF check), passed to scripts only as `API_TOKEN`, and never stored. A failed
token request is reported as an event and the run continues, so authenticated tests fail visibly.

## Deployment

- `docker compose up --build` → http://localhost:4000 (verified: image builds, runs as non-root, passes API validation; data in the `platform-data` volume; `.env` for
  LLM keys, `API_KEY`, `SECRET_KEY`). The image runs as an unprivileged user with Chromium in
  `/ms-playwright` and `shm_size: 1gb`. **Set `API_KEY`** — the container listens on 0.0.0.0.
- CI: `.github/workflows/ci.yml` — a quick `checks` job (typechecks, UI build, `npm run test:fast`), then the full suite in four
  `--shard` slices with Chromium, Firefox and WebKit installed (JUnit per shard). The suite needs no LLM key. Never run on GitHub
  from here; `npm run test:fast` and `--shard` were run locally.

## Checks, browsers, schedules and CI/CD (feature modules)

Four feature modules were added on top of the pipeline; each owns its files, its routes (`src/platform/routes/*`, registered by
`registerFeatureRoutes`) and its migration slot. Full designs are in `docs/features/`.

- **Page health and passive security checks** (`engine/health/*`, `engine/security/*`; `docs/features/checks.md`) follow the
  accessibility pattern: new assert/response checks in the spec schema, a self-contained helper emitted into the rendered script, a mirror
  module with a stable failure prefix, a finding classifier in the validator (before the LLM repair loop, which these deterministic specs skip),
  per-line `[severity]` tags read by `severity.ts`, and job options `healthChecks`/`securityChecks` (default on). Security specs are GET-only and
  anonymous; exposed-file hits need a content signature so SPA catch-alls cannot cause false positives.
- **Cross-browser/responsive variants** (`validation/variants.ts`, `variants-store.ts`; `docs/features/variants.md`): the runner builds one
  Playwright project per variant and parses results per (script, project); `test_executions.variant` (NULL = base run) keeps history and JUnit
  unchanged. Variant results never change a test's validation status; they surface as a compatibility matrix and badge. Job mode `variants`.
- **Schedules, trends, flaky detection, alerts** (`platform/scheduler.ts`, `trends.ts`, `alerts.ts`; `docs/features/schedules.md`): a scheduler with an
  injectable clock claims due schedules atomically and never overlaps a running job; `run_summaries` give cheap trends and run-to-run diffs;
  a failing scheduled test is retried once (pass-after-fail = flaky); alert channels (webhook/Slack, encrypted URLs, SSRF-guarded, no redirects,
  retries, dedupe) deliver in the background so a dead receiver can never fail a job. `onJobFinished` skips cancelled and `variants` jobs.
- **`ai-test` CLI and issue trackers** (`src/cli/*`, `platform/issues/*`; `docs/features/ci.md`, `issues.md`): replay / generate / remote modes, a gate with
  exit codes 0/1/2, JUnit/JSON/SARIF/HTML/Markdown from one neutral result model, a sticky PR comment, and GitHub/Jira issue creation (idempotent,
  encrypted tokens, guarded outbound calls). The CLI classifies findings by the failure-prefix constants exported by the checks modules.

Shared plumbing: `platform/http-error.ts`, `platform/net-guard.ts` (the SSRF guard used for applications, spec URLs, webhooks and trackers),
`scripts/with-lock.mjs` (serialises browser-heavy work between parallel developers).

## More checks and tools

Each follows the same shape as the earlier check families: a self-contained helper pasted into the generated script (and compiled for the
engine and tests from the same text), a spec generator, a classifier that turns the check's own failure message (a stable prefix and a
`[severity]` per line) into a finding before the LLM repair loop is consulted, and severity read from those tags. Designs, limits and tests are in `docs/features/`.

| Feature | Where | Notes |
|---|---|---|
| Weak-test detection | `engine/quality/rules.ts` | Computed on read, never stored; advice only. Exempts single-purpose families. |
| API response contracts | `engine/contracts/check.ts`, `specs.ts` | Dependency-free JSON-Schema-subset validator in the script; `oneOf`/`anyOf` nodes arrive marked `x-aitp-lossy` and are skipped (no false alarms). The schema step replaces the generic "contains key" steps on those tests. |
| OpenAPI diff / `ai-test api-diff` | `engine/contracts/diff.ts`, `cli/api-diff.ts` | Breaking vs non-breaking, direction-aware (request vs response). |
| Page and API speed | `engine/performance/{checks,latency,specs}.ts`, `platform/perf-store.ts` (migration 6) | Median of 3 cold loads; API latency is one warm-up + 10 sequential requests, stops at 429/5xx. Measured values travel as a `metrics` attachment and are stored per run. Opt-in. |
| Form input checks | `engine/inputs/` | Fixed harmless probes; GET/search forms only unless data-changing tests are enabled; login, sign-up, payment forms and password/card/OTP fields are never probed. |
| Shareable report | `platform/reports/project-report.ts`, `routes/reports.ts` | One escaped, self-contained HTML page; PDF via the platform's Chromium with scripts disabled. |
| API drift | `engine/contracts/drift.ts`, `platform/drift-store.ts` (migration 9) | Shape-only snapshots (values never stored; script-side shapes are re-validated by `sanitizeShape`); noise rules: empty lists, errored operations and partial re-runs are never reported as removals. Alerts are opt-in per channel. |
| Signed-in speed and visual | `engine/identity/signed-in.ts` | Sign-in steps prefixed to the spec; the speed helper carries `storageState` into its fresh contexts only with the `signed-in` token. A failed sign-in is a plain failure, never a finding. |
| Form limits | `engine/inputs/checks.ts` | `inputLimits` reads validity state and types into the field; never clicks submit. |
| Two-step sign-in | `engine/identity/totp.ts` | RFC 6238 with `node:crypto`, verified against the RFC vectors; the script computes codes from `TEST_TOTP_SECRET` at run time. |
| Environments and test data | `engine/environments/`, `engine/testdata/dataset.ts`, `platform/environments-store.ts` (migration 11) | Executions carry an `environment` column (NULL = default, like `variant`). Production environments are read-only (mutating tests skipped with a reason) and need an explicit confirm. Environment secrets are `SecretBox`-encrypted and write-only. Data sets render one test per row (cap 25). |
| Site memory | `engine/memory/*`, `platform/memory-store.ts` (migration 10) | Structural facts only (fingerprints of headings and field names, never text), size-capped, versioned; informs prompts and a deterministic change summary, never suppresses discovery. |
| Vision judgement | `engine/vision/*`, `llm/provider.ts` (`imageObject`) | `looksRight` check: structured verdict, a finding only at medium/high confidence, unavailable model → FAILED_VALIDATION; downloaded scripts save a screenshot only. |
| Repair suggestions | `engine/healing/*`, `platform/healing-store.ts` (migration 12) | Deterministic, unique-candidate-only, approve-to-apply; refuses assertion failures and non-locator failures. |
| Deploy triggers | `platform/trigger-*.ts` (migration 12) | Hashed tokens, constant-time compare; `isTriggerTokenRoute` is the only API-key exemption (anchored, exact, decoded path). |
| Load check | `engine/performance/load.ts`, `platform/load-guard.ts` | Caps live in the script (10 users, 300 requests, GET only, no retries); generator and helper both clamp; early stop on >20% errors or any 429; half-load re-run before a finding; skipped on production; one load check at a time per application address (lock folder). Schedules and triggers never run it. |
| Test data cleanup | `engine/cleanup/*`, `platform/cleanup-store.ts` (migration 13) | Ledger of ids captured at creation; one party deletes per run (`AITP_CLEANUP`: unset = the script, `platform`, `off`); platform re-derives DELETE paths, same-origin only, `assertAllowedTarget`, no redirects; failures never change test status; ids and paths only. |
| Fleet dashboard | `platform/dashboard.ts` | One read-only aggregation (no per-project queries); readiness is a pure function (`assessReadiness`) with documented rules, returned with the answer. |
| Plain-English tests | `engine/authoring/{describe,api,plain}.ts`, `platform/plain-run.ts` | A job of mode `plain` reuses the authoring agent and the normal validator. Spec origin `plain-english`; unbuildable or weak results are kept as needs review with the reason, never green; API specs can only use known operations. Unsafe descriptions are refused by a cautious keyword filter (a first filter, not a security boundary). |
| Failure evidence | `engine/evidence/*`, `platform/evidence-read.ts` | The same helper runs inside every web script and in the platform: bounded in-memory recording, attached only on failure, schema-checked and re-masked with the run's exact credentials on arrival. Bodies and headers are never stored. |
| MCP server | `src/mcp/*`, `bin/ai-test-mcp.mjs` | A client of the REST API over stdio: strict tool schemas, risky options off unless passed, key scrubbed from all output, capped answers and waits. Adds no new power over the API. |
| Teams and email alerts | `platform/alerts.ts`, `platform/alert-email.ts` | Teams Adaptive Card webhook; email through nodemailer with SMTP user and password in the encrypted channel blob (write-only), mail host through the address guard, plaintext sign-in refused to non-private hosts. |
| Maestro import | `engine/import/maestro.ts`, `platform/routes/imports.ts` | Pure YAML converter (safe parse, caps) that hands specs to the normal spec import; unsupported commands reported per step. |
| Runbooks | `engine/runbook/*` (pure), `platform/runbook-{store,runner,triggers}.ts` (migration 14) | Forward-only routes (no loops, validated at save), step and run time caps, one active run per project (unique index), jobs started through the normal job path; a run found `running` after a restart is marked `interrupted`, never resumed. Schedules and tokens link via small link tables. |
| Manual cases and sign-off | `engine/manual/*`, `platform/manual-{case-store,releases}.ts` (migration 15) | Automated state comes from `buildDashboard` (no duplicated rules); sign-off rules are a pure function returned with the API; audit trail is append-only (no update or delete method, plus a database trigger); report HTML is escaped with a no-script CSP. |
| Notion and Sentry | `platform/issues/notion.ts`, `platform/sentry/*` | Notion is another tracker provider (2000-char block split, 100-block cap). Sentry is stored as integration kind `sentry` but selected out of every tracker path; a zod schema drops everything except id, title, level, counts, times and link; matching by time window and address with a pinned score table; never claims causation. |
| Storage, retention and backup | `engine/retention/*`, `platform/{retention-store,retention-runner,storage-usage,backup}.ts` (migration 16) | Retention off by default; preview and run share one planning function; only artifact files of known evidence kinds are removable, row kept with `pruned_at`; executions and trends untouched. Backups never contain secrets (leak-tested in plain, base64 and UTF-16); restore always creates a new project from a streamed, size- and entry-capped, zod-validated zip. |
| AI usage and budgets | `engine/llm/{usage,metered}.ts`, `platform/usage-store.ts` (migration 17) | A metered `LlmClient` wrapper checks job, project and month caps before every call and refuses with a typed `BudgetExceeded` (jobs stop cleanly and keep their work); counts and labels only; no built-in prices; small overshoot possible from one in-flight call. |
| Quarantine | `engine/quarantine/rules.ts`, `platform/quarantine-{store,service}.ts` (migration 18) | One gate (`quarantineGate`) used by summaries, readiness, runbooks, sign-off, CLI/JUnit/SARIF and trigger status, each reporting what it ignored; only flaky, non-check-family tests qualify, no override; append-only history enforced by a trigger. |
| Framework adapters | `engine/frameworks/*` | `FrameworkAdapter` (id, kinds, runtime, `needs`, traits, `render`, `execute`) with a registry; the three built-ins wrap the existing generators and runners unchanged; `ScriptExecutor` is the only way callers run scripts, `LocalExecutor` the default. Adding a framework is an addition: see `docs/features/framework-adapters.md`. |
| Runner agent (platform) | `platform/agent-{store,routing,services}.ts`, `routes/agents.ts` (migration 19), `src/agent-protocol/schema.ts` | `RemoteExecutor` installed through `setExecutorResolver`; one token per project and per connected agent (hashed, revocable, 404 when revoked); atomic task claim, lease with one re-offer, only the claimer may touch a task; exact-match auth exemption for the six `/api/agent/*` routes (Bearer token, never the API key); task payload and result encrypted at rest; an infrastructure failure is never a test verdict; for agent runs private targets are allowed because the agent, not the platform, connects to them; cleanup runs on the agent. |
| Runner agent (program) | `src/agent/*`, `bin/ai-test-agent.mjs` | Connects out only; each task runs in its own Node process using the platform's own adapter code (real process-tree kill on cancel); downloads cached by sha256; uploads streamed with caps; token and credentials masked in every log line; iOS and Windows reported but not run (protocol 1). |
| Design system | `web/src/styles/{tokens,base}.css`, `web/src/styles.css`, `components/ui.tsx` | Crowd4Test tokens (ink neutrals, one teal accent, Instrument Sans and JetBrains Mono, hairlines, 6/10/14px radii). The handoff's token files were not supplied, so values not stated in its README are inferred and marked `/* inferred */`. Dark theme is a remap of the semantic aliases. |
| Windows desktop tests | `engine/desktop/*`, `engine/frameworks/windows.ts` (adapter `windows-uia`), `engine/generators/windows.ts`, `platform/desktop-guard.ts` | One hidden PowerShell per test, JSON lines over stdin/stdout, UI Automation patterns only (no synthetic input); only windows of the process it started; password controls are `[hidden]`; launching needs the machine's allow-list (resolved full path) and a hard deny-list of shells and script hosts always wins; no shell string is built from spec text; refuses when elevated or non-interactive; refusals are infrastructure outcomes, never test verdicts; a ledger of started processes (pid + start time) is swept after every run. Capability fields are additive (protocol stays 1). |
| Object repository | `engine/locators/*`, `platform/locator-store.ts` (migration 20), `routes/locators.ts` | Named elements per project and kind; a step locator may be `{ ref }`, resolved at render time so generated scripts stay self-contained; usage is rebuilt from specs; editing an element re-renders and re-validates the tests that use it; applying a repair suggestion to a shared step fixes the element once (with an explicit confirmation of the blast radius); with no refs everything is byte-identical. |
| Framework settings | `engine/frameworks/settings.ts`, `platform/framework-settings-store.ts` (migration 21), `routes/frameworks.ts` | Schema with clamping and defaults equal to today's behaviour; applied in one place where a run is built (also carried to agents as additive optional task fields); headed only on an agent; no retries by design; the Windows allow-list stays machine-side. |
| Custom tests | `engine/custom/*`, `platform/custom-script-store.ts` (migration 22), `platform/custom-scripts.ts`, `platform/custom-policy.ts`, `routes/custom-scripts.ts` | Take over archives the spec and makes the script the source of truth; versions (100 kept, generated v0 never pruned); AST guard as an accident guard; the run policy at job creation is the real boundary (`ALLOW_CUSTOM_SCRIPTS` or an agent started with `--allow-custom-scripts`); every re-render path skips custom tests; web code editor is a lazy CodeMirror chunk. |
| Git import | `engine/gitimport/*`, `platform/git-import-service.ts`, `git-runner.ts`, `routes/git-import.ts` | System `git` via argument arrays, https only, files read from the object store (no checkout), token via process environment only, limits, work folder always removed; each file becomes one custom test, guarded; refresh adds versions only for changed files. |
| Visual builder | `engine/builder/index.ts`, `platform/spec-edit-service.ts`, `spec-version-store.ts` (migration 23), `routes/spec-edit.ts` | The spec stays the source of truth: validated with the import rules, re-rendered for every framework the test has, saved all-or-nothing, history kept; custom tests are refused (take over instead). |
| Step blocks | `engine/blocks/*`, `platform/block-store.ts` (migration 25), `routes/blocks.ts` | A `useBlock` step is expanded in one place before any generator sees the spec (generators throw if they do); the stored spec keeps the small step; a change is validated against every user (credential-origin rule included) before anything is saved, then propagates like shared-element changes; nesting depth 3, cycles refused. |
| Text tests | `engine/dsl/*`, `platform/dsl-service.ts`, `routes/dsl.ts` | One grammar table drives parser, printer, phrase list and doc; every step action must have a phrase (a test fails otherwise); the printer reads back what it writes and a test it cannot express fully is read-only, so saving can never lose data; saves reuse the step editor's validation, history and re-render. |
| Adapter plug-ins | `engine/frameworks/plugin*.ts`, `platform/plugin-gate.ts`, `examples/adapter-plugin/` | Off unless `ALLOW_ADAPTER_PLUGINS` and `API_KEY`; loaded from env paths only, never imported when off; manifest and adapter shape validated, every call wrapped and results rebuilt with caps; a vanished plug-in fails runs early without deleting data. Host only, not a sandbox. |
| iOS adapter | `engine/frameworks/ios.ts`, `engine/generators/ios.ts`, `engine/mobile/ios-*.ts` | Taqwright iOS on a macOS runner agent only; simulator chosen by pure functions, only a simulator the agent booted is shut down (by recorded udid); infrastructure problems are never verdicts. Covered by fakes only: not run on real hardware. |
| Live session | `engine/recorder/act.ts`, `platform/live-session-service.ts`, `live-session-store.ts` (migration 24), `routes/live-session.ts`, MCP tools | act and snapshot on the shared recorder session (local or on an agent through heartbeat commands); secrets only as placeholders, filled on the machine that owns the browser and only on the project's own origin. |
| Live updates | `platform/event-bus.ts`, `routes/stream.ts`, `web/src/lib/stream.ts` | Server-sent events (no WebSocket: one-way is enough, no dependency, proxy-friendly). The database is the source of truth so a worker in another process still streams; `Last-Event-ID` resumes without gaps; single-use, path-bound stream tickets keep the API key out of URLs; caps and cleanup of timers and listeners. |
| Recorder and inspector | `engine/recorder/*`, `platform/recorder-service.ts`, `routes/recorder.ts` | The platform launches its own Chromium (one session per project) and injects a recorder that reports through a private random binding; password, one-time-code and card fields are never read in the page; locators are ranked and their match counts checked with Playwright's own locators; the start URL and every redirect hop go through the address guard; the browser pid is verified ended on every exit path; saving goes through the normal spec import and a real validation run (origin `recorded`). Sessions live in memory. | Recording can also run **on a runner agent**: a shared core (`engine/recorder/session.ts`) runs in the platform (local driver) or in the agent's own forked process (record task, `platform/agent-record.ts`, `agent/record-*.ts`); the agent pushes state, the platform queues page commands into the heartbeat reply, and every push is validated as untrusted input.
| Test accounts and access control | `engine/identity/access.ts`, `platform/identity-store.ts` (migration 8) | Accounts encrypted with SecretBox, write-only. A small survey as visitor and each account feeds "lesser account cannot open page" checks; a heuristic, rated by how privileged the address sounds. |

## Mobile testing

Specs of kind `mobile` (imported, or created by hand) are executed on an Android emulator by Taqwright
(Apache-2.0, an npm dependency; no source copied) through Appium 3 and the UiAutomator2 driver.

- **Toolchain** (`engine/mobile/toolchain.ts`): `npx @taqwright/taqwright install --with-avd` vendors a JDK, the
  Android SDK, Appium and an emulator image into Taqwright's own directory without touching the user's
  `JAVA_HOME`/`ANDROID_HOME`; an existing SDK on `ANDROID_HOME` works too. The platform checks for it up
  front (`GET /api/config` → `mobile`) so a missing emulator becomes a clear reason, never a failed or fake pass.
- **Target** (`engine/mobile/target.ts`): the app a project's mobile tests run against — an installed app's
  package (`com.android.settings`) and/or an uploaded APK, plus an optional AVD. Stored on the project's
  application record; `PUT /api/projects/:id/mobile-app`, `POST …/mobile-app/apk` (raw body, must be a zip
  containing `AndroidManifest.xml`), or the `mobile` field of a spec import. Server paths are never returned.
- **Emulator** (`mobile/emulator.ts`): the platform, not Appium, starts the emulator, because a run is only as
  trustworthy as its starting device. It boots headless, switches off Android's "… isn't responding" dialogs and
  animations, and after the first successful boot saves a clean snapshot (`aitp-clean`) that later runs restore in
  seconds without saving anything back. An emulator for the AVD that is already running is reused and left alone;
  one the run started is stopped afterwards. A device lock serialises jobs, and each run gets its own Appium port.
  Real problems this found: an ANR dialog covering the app after a slow first boot; Appium only opening the app
  when told to (generated scripts now stop and relaunch the app before every test, so each starts at its first
  screen); a stale Appium on the default port refusing the next run's session; a not-yet-noticed running emulator
  being started a second time.
- **Runner** (`validation/mobile-runner.ts`): same contract as the browser runner — an allow-listed child
  environment (no LLM keys), the device/app passed through environment variables rather than interpolated
  into source, a generous time limit (first boot is slow), one worker (one device), and the JSON report parsed by
  the same code as Playwright's. Failures carry the failing step, an inline screenshot, an on-device video and
  Taqwright's self-contained HTML trace. An emulator the run started is stopped afterwards
  (`MOBILE_KEEP_EMULATOR=true` to keep it).
- **Validator** dispatches per framework (`taqwright` → mobile runner, everything else → Playwright). Mobile
  failures are `FAILED_VALIDATION` with the step that failed; there is no LLM repair for mobile yet.
- **Resources**: an emulator needs ~3 GB of free RAM. On a 7.7 GB machine whose RAM was held by other workloads the
  UiAutomator2 session failed (system processes were being killed); once ~2 GB was free it was reliable. A run takes
  1–3 minutes from the snapshot; the very first start is a full boot (a few minutes).
- **Tests**: `tests/mobile.test.ts` covers detection, the runner (environment isolation, report/artifact
  mapping, timeouts, no-report errors) and the API/persistence with a stand-in Taqwright CLI;
  `tests/mobile-device.test.ts` (`MOBILE_E2E=1 npm run test:mobile:device`) runs against a real emulator: it passed on an
  Android 34 emulator three runs in a row (Settings → Network & internet → Internet passes; an entry that does not exist
  fails with the failing step, screenshot and video).

## Compliance mapping

`engine/compliance/` maps tests to 21 security-control topics (10 NIST 800-53, 5 HIPAA Security Rule,
6 ISO 27001) and reports each control as *covered* (a mapped test passed, none needs review),
*needs attention* (a mapped test found something or failed) or *no tests yet*. The control library
and the matching idea come from ai-testing-agent's `compliance.py`; the matcher differs on purpose:
keywords match whole words (upstream's substring matching tags `/api/catalog` as audit logging because
"log" is inside "catalog"), `{path parameters}` are ignored, and web tests count too (their signals are the
pages visited, title, area and tags; submitting input counts as a write). Mappings are computed on read from
the stored specs, so improving the rules re-maps existing projects with no migration. It is an
indicative coverage view, **not** a compliance assessment, and the UI says so.

## User interface

React + Vite SPA in `web/`, served by the API process. Hash routes (so deep links work without server
config): `#/` projects (or the first-run welcome), `#/new`, `#/projects/:id` (+ `/tests`, `/runs`, `/compliance`),
`#/tests/:id`, `#/settings`.

**Structure.** Sidebar = top-level destinations only (New project, Projects, Settings, AI status).
Inside a project, tabs (Overview · Tests · Runs · Compliance) — one navigation level each, never duplicated.
Breadcrumbs come from the page (`usePage`), so they are always correct.

**Flow.** First visit = one field (the URL) and a one-line "how it works". Everything else is under
*Advanced options*, with a line showing the defaults. The overview answers: what am I testing, what has the
AI done, are the tests ready, what next — a live checklist while running, then a result banner, four numbers
and a "Needs your attention" list ranked by severity. The Tests tab is one grouped list (areas with
problems first) with status filters; the test page shows intent first (what it checks, steps in plain
language with ✓/✗, expected result), evidence when it failed, and code only on request.

**Plain language, in one place.** `web/src/lib/labels.ts` is the only place internal states, raw engine
errors and recorded steps become words: `NEEDS_REVIEW` → "Needs review", `Cannot connect to API: ENOTFOUND…` →
"We couldn't reach the AI service … try again", `{action: "fill", …}` → "Type “your test username” into the
“Email” field". The backend keeps its precise states. Technical details (counters, activity log, JSON
spec, token usage) sit behind "View technical details".

**Design system.** `styles.css` tokens (neutral scale, one accent, semantic success/warning/danger/info
with matching soft backgrounds, light + dark via `prefers-color-scheme`, 4/8/12 px radius, one shadow),
a six-step type scale, and shared components (`components/ui.tsx`: Button, Badge, Callout, EmptyState,
ErrorState, skeletons, Menu, Disclosure, Metric, FilePicker; `CodeViewer`, `JobProgress`,
`TechnicalDetails`). One icon set (lucide) with one icon per concept. Empty, loading (skeleton) and error
states say what it is, why, and what to do. Responsive: the sidebar becomes a drawer under 900 px; rows,
filters and metrics reflow.

**Tests.** `tests/ui-lib.test.ts` pins the wording and URL handling; `tests/ui-smoke.test.ts` drives the
built UI in a real browser through the whole journey (welcome → bad URL → analysis with live progress →
tests → test detail → code → run again → import) and fails on any browser console error. Bugs this found:
a stale tests list after an analysis finished, and `localhost` defaulting to `https`. Long areas page 50 tests at a time (counts still cover the whole area; search covers all of it). The UI tests run on Chromium, Firefox and WebKit (`npm run test:ui:browsers`; all pass on the three). `tests/ui-flows.test.ts` covers an API-key-protected server (key screen, wrong key, remembered key) and the visual-review loop (diff shown → *Accept new screenshot* → passes).

Dependencies: `lucide-react` (ISC); code is coloured with the editor's own `@lezer/highlight` and `@codemirror/lang-javascript` (MIT).

## 11–12. Third-party repositories and licenses

See `THIRD_PARTY_LICENSES.md`.

## 13. Running locally

```bash
npm install && npx playwright install chromium
cp .env.example .env            # set an LLM key (see below)
npm run build:web               # builds the UI served by the API process
npm start                       # API + embedded worker + UI on http://127.0.0.1:4000
# separate worker:  WORKER_EMBEDDED=false npm start   +   npm run worker
npm test                        # deterministic + platform + authoring-plumbing tests
npm run demo:e2e                # real run against the local DemoShop sample app (needs an LLM key)
```

LLM configuration: `LLM_PROVIDER` = `anthropic` (default, `ANTHROPIC_API_KEY`) | `openai`
(`OPENAI_API_KEY`) | `google` (`GOOGLE_GENERATIVE_AI_API_KEY`) | `openai-compatible`
(`LLM_BASE_URL`, e.g. a local server or OpenRouter); `LLM_MODEL` overrides the default model.
`openai-compatible` uses the Chat Completions endpoint, which gateways implement. Example (OpenRouter):

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=anthropic/claude-sonnet-5.5
LLM_API_KEY=sk-or-...
```

## 14. Adding another testing framework

1. Create `src/engine/generators/<name>.ts` exporting a `ScriptGenerator`
   (`framework`, `kind`, `executable`, `render(spec, ctx)`), mapping each canonical step to the target API.
2. Add the framework id to the `Framework` union in `generators/types.ts` and register it in
   `generators/index.ts`.
3. If the platform can execute it, add a runner next to `validation/runner.ts` and route to it in
   `validation/validator.ts`; otherwise leave `executable: false` and it stays `PENDING`.
4. Allow it in the `POST /tests/:id/scripts` enum in `platform/server.ts`.
No change to discovery, planning or the spec is required.

## Real-world check (no LLM): Swagger Petstore

An API-only job against the public demo https://petstore3.swagger.io/ (safe mode, GET only):
spec found via observed traffic (19 operations, 11 state-changing ones skipped), 15 tests generated,
**9 validated**, **6 NEEDS_REVIEW** — all six genuine: three documented-secured endpoints answer
200 without credentials, and `/store/inventory`, an unknown order id and an unknown username return
500 instead of the documented 4xx. Verified independently with curl.

Provider note: OpenAI structured outputs default to strict JSON Schema, which rejects optional
properties; the engine passes `strictJsonSchema: false` (`PROVIDER_OPTIONS` in `llm/provider.ts`).

## Real-world check: LLM run (OpenRouter, `anthropic/claude-sonnet-5.5`)

`npm run demo:e2e` against DemoShop (12 pages max, 10 scenarios): 8 journeys identified, 10
scenarios planned (incl. wrong password, empty fields, protected page, no-results search),
**18 tests generated, 16 validated, 2 needs-review, 0 failed validation**; ~288K input / 14K output
tokens (≈$0.60). The repair loop fixed one test on its first attempt. One needs-review item was a
**real bug in the sample app** the agent found unprompted (cart count shows 0 on the cart page — two
inline scripts redeclare `const c`). The other exposed a planner over-reach (an API expectation in a
UI journey) and the stale-step problem; both were fixed afterwards (UI-only expectations rule;
replay pruning).

Second run after those fixes: 16 generated, **14 validated, 2 needs-review, 0 failed**; no API
expectations in UI tests; no repairs needed. Both review items independently re-found the same cart
bug. Two scenarios were lost to a transient DNS failure reaching the LLM gateway (the SDK's default 2
retries); every model call now uses `LLM_MAX_RETRIES = 5` with exponential backoff.

## Real-world check: a third-party app (saucedemo.com)

Sauce Labs' public automation-practice shop, with its published test account. What it exposed and
what was fixed:

| Run | Pages | Tests | Validated | Review | Notes |
|---|---|---|---|---|---|
| 1 | 1 | 13 | 13 | 0 | Login tests only — discovery never got past the login page |
| 2 | 2 | 13 | 12 | 1 | Shop journeys (cart add/remove, sorting, details, logout); 1 real bug found |
| 3 | 5 | 10 | 10 | 0 | Crawl reaches cart and product detail; checkout covered; no repairs needed; 3 scenarios lost to local network errors |

Fixes driven by these runs:
- **Crawl from where login lands.** Sauce Demo keeps showing the login form at `/` when signed in and
  never links to the app from it; login now reports its landing URL and the crawl is seeded with it.
- **Don't trust the HTTP status for SPAs.** Its working product page is served with status 404 (static
  host fallback); a page now counts as an error only if the content also looks like one.
- **Repair from the first wrong step**, not just the failing one: a stray-but-successful navigation
  earlier in a test broke a later assertion, and resuming from the failing step kept the bad steps.
  Triage now reports `firstWrongStep`; a repair that fails again re-authors from scratch.
- **Retry the opening page load** of each authoring session on network errors (timeouts,
  `ERR_NETWORK_CHANGED`, DNS) — one flaky request used to cost a whole scenario.
- **A job is `COMPLETED` only if every planned scenario produced a test**; scenarios that could not be
  authored now make it `PARTIALLY_COMPLETED`.

Finding (verified independently with a plain Playwright script): after **Reset App State** the cart
badge clears but the products keep showing "Remove" until a page reload — stale UI state. The agent
reported exactly this, unprompted.

## Security hardening (from an internal review)

- API-key auth is checked on the decoded path (percent-encoded paths like `/%61pi/...` cannot bypass it).
- Generated scripts are injection-safe: text placed in comments has every JS line terminator
  (`
`, `
`, U+2028, U+2029) removed, and string literals escape U+2028/U+2029.
- Validation children receive an allow-listed environment only — never the platform's LLM keys,
  `SECRET_KEY` or `API_KEY`.
- An OpenAPI `servers` URL on a different origin is ignored (warning event); API traffic and the
  user's token go only to the app's origin or an explicit `apiBaseUrl`.
- SSRF guard (opt-in) covers IPv4-mapped IPv6, `::`, CGNAT; it checks at submit time only (no
  per-request re-validation, so DNS rebinding is not covered).
- LLM API repairs are structurally checked: same requests and auth mode, no removed assertions, no
  changed expected status on security tests. Vacuous web assertions (empty url/text expectations)
  are refused during authoring.
- Credential-like query parameters and body fields are redacted before anything is stored.
- Jobs carry a lease owner; a stalled worker cannot write the final state of a reclaimed job.
- Cancelling during validation records completed runs truthfully and ends the job as cancelled.

Regression tests: `tests/security.test.ts`.

## Secret leak audit

`tests/secret-leak.test.ts` runs one real job with sentinel secrets in every place one can be entered (default sign-in, authenticator secret, API token, two named accounts with passwords, authenticator secret and tokens), then searches everything it produced — every API answer (project, tests, specs, runs, events, trends, reports, JUnit), the zip, the PDF text, the database and its journal, stored scripts and evidence, and the scratch directory the scripts ran from — as plain text, UTF-16 and base64. None appears; they exist only encrypted (SecretBox). A second test plants secrets to prove the detector can find them. It covers the paths listed; it cannot prove the absence of a leak somewhere it does not look (for example a log line on the server console).

## Known limitations

- The LLM-driven web path has been run for real only against the bundled DemoShop sample app
  (see "Real-world check: LLM run" below); quality on large, complex apps is not yet measured.
- The new checks are hygiene checks, not a penetration test; browser/size variants use Playwright's WebKit and Chromium device profiles, not real devices; the CI workflow, GitLab/Jenkins snippets and the GitHub/Jira integrations are verified against mock servers only.
- Mobile tests run on Android emulators only (no iOS, no real-device farm), one device at a time, and need ~3 GB of free RAM.
  Mobile tests are not yet generated by the AI pipeline: they come from imports; exploring a native app is not implemented.
- No CAPTCHA/2FA/SSO login support; multi-tenant auth beyond a single API key is not implemented.
- OAuth2 supports the client-credentials grant only
  (no interactive authorization-code flows, which an unattended platform cannot complete).
- Compliance mapping is keyword-based and indicative, not an audit; it covers 21 control topics.
- The Docker image was built and run end to end (non-root, API key enforced, 9/9 API tests validated
  inside the container, data persisted across a restart). The CI workflow has not been run on
  GitHub: that needs a pushed repository.
- Live third-party targets drift: on a re-run an hour later, Petstore returned 500 for three more
  endpoints (verified with curl), so the same job reported 6 validated / 9 needs-review. Results
  reflect the service at run time.
