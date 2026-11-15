# Workstream 3: execution evidence and observability audit

Read-only audit, 2026-11-14. Code state: `main` = `7a164a8`, plus the uncommitted Phase 1 work (`src/eval/*`, `examples/bench-*`,
`src/engine/intel/`, `src/platform/app-intel-store.ts`, `routes/app-intel.ts`, `db.ts` slot 62, `pg/baseline.sql`, `roles.ts`,
`eval-store.ts`, `web/src/features/eval/*`). Nothing was changed except this file. No test, build, browser or server was run, and the
running benchmark (`node scripts/eval.mjs bench --max --baseline ...`, data `eval/.data-bench`) was not touched or read.

Labels: **Verified** (read in the current code, file:line given), **Partial** (exists but incomplete), **Missing** (not in the code),
**Suspected** (looks like a problem from reading; needs a reproduction before anyone fixes it), **Proposed** (a recommendation).
Paths are relative to `AI_Studio/`. Line numbers are for `7a164a8` plus the working tree.

---

## 0. Summary

1. **Much of the evidence model already exists, and steps already correlate requests.** Every generated web script carries the evidence
   recorder (`engine/evidence/capture.ts`, pasted into the script by `engine/generators/playwright.ts:388-395`). Each request and console line
   gets the number of the step that was running (`capture.ts:186,216`, `evidenceStep` at `playwright.ts:359-360`). The platform cleans the
   attachment again and bounds it (`engine/evidence/model.ts:72-125`). Then it stores it as an `evidence` artifact
   (`validation/runner.ts:602-616`). Verified.
2. **Main gaps (Missing):** step durations and timestamps are thrown away (`runner.ts:619-623`, `test_execution_steps` has no time columns,
   `db.ts:112-115`). The UI state at each step is not recorded. There are no stack traces for page errors (`capture.ts:218-220`), no backend
   correlation id (no response header is read except `content-length`, `capture.ts:194-196`) and no structured assertion outcome. Passing
   runs keep no evidence at all (`capture.ts:274-275`). API tests record responses without a step or a duration
   (`generators/api.ts:32-37,69`).
3. **Redaction is strong where it exists, but four gaps are Verified:**
   - (a) The evidence re-mask uses a smaller secret set than the trace scrubber. It leaves out environment variables and the values of the
     saved sign-in (`model.ts:58-66` vs `trace-scrub.ts:58-83`).
   - (b) Problem lines from authoring and exploration hold raw console and page-error text. That text goes to the AI provider unmasked
     (`discovery/browser.ts:159-160,181-182` → `web/author.ts:127,187,346`).
   - (c) An authoring trace that is kept is masked only with the sign-in password (`web/author.ts:659`).
   - (d) Screenshots and videos are never masked. Only the live Explorer pictures cover secret fields (`frames/shoot.ts`). Project reports
     embed failure screenshots inline (`reports/project-report.ts:100-112`).

   One more is Suspected: on the platform's own run path, `run.error` and step errors are stored without masking (runner path: `agent/mapping.ts:143-150`).
4. **Traces hold cookies and bodies the application issued.** Trace scrubbing works by known value only (`trace-scrub.ts:1-34`). A session
   cookie, a CSRF token or personal data that the app returns during the run stays in the stored trace. Verified by design (documented
   limit).
5. **Retention is off by default** (`engine/retention/policy.ts:43-49`, `enabled: false`). Traces (up to 256 MB unpacked,
   `trace-scrub.ts:49`), videos and screenshots of failed runs are therefore kept until a person turns a policy on. Verified.
6. **Biggest conflict risk with Phase 1:**
   - Almost every evidence change lives in `src/engine`. The benchmark records `src/engine` as "dirty" (`eval/bench/record.ts:33-37`) and
     resumes with `--resume` from the same working tree.
   - `web/author.ts` is a fingerprinted prompt source (`record.ts:16-26`).
   - Any change to `EVIDENCE_HELPER_SOURCE` or to the generator changes every rendered script and its `content_hash`. That resets the
     per-hash flaky and quarantine window (`quarantine-store.ts:128-140`) and breaks the fault-injection anchor `\n    evidenceStep(page, N);\n`
     (`mutation/faults.ts:155-160`, `web/socket-faults.ts:59`).

   Work therefore belongs on a separate worktree or branch. It merges only after the baseline is frozen. Changes that alter rendered
   scripts go out as one batch.

---

## A. Inventory of current evidence

| Evidence | Status | Where (file:function:line) | What is kept | Notes |
|---|---|---|---|---|
| Playwright traces | **Verified (failure only)** | `validation/runner.ts` config `:155` `trace: { mode: "retain-on-failure-and-retries", snapshots: { dom, aria, screen } }`. Collected in `parseReport` `:826`. Cleaned by `scrubRunTraces` `:580` → `evidence/trace-scrub.ts:539-560`. Runner: `agent/task-runner.ts:953-963` (cleaned before upload). Platform re-clean: `platform/agent-services.ts:1676`. Phone: `validation/mobile-runner.ts:123,372-373` (Taqwright HTML trace) | The full trace: actions, DOM/ARIA snapshots, screencast, network log with headers and bodies, console | Masking by known value only (`trace-scrub.ts:28-34`). `scrubRunTraces` returns at once when the run has no secrets (`:540`), so the trace is stored as Playwright wrote it. A trace that cannot be cleaned is deleted and a note added (`:551-555`). Authoring keeps a trace only for **blocked** scenarios (`web/author.ts:649-669`). |
| Screenshots | **Verified (failure only)** | `runner.ts:153` `screenshot: "only-on-failure"`, `:825`. Mobile inline base64 `:816-822`. Vision shots `:792-815`. Live failure picture: `task-runner.ts:910-926`. Stored by `repo-sink.ts:183-193` | PNG at the end of the test | Not masked (`trace-scrub.ts:30-31` says so). Explorer frames are masked separately (`frames/shoot.ts:54-58`, `frames/sink.ts:7`). |
| Videos | **Verified (failure only)** | `runner.ts:157` `video: { mode: "retain-on-failure", show: { actions, test: step } }`. Turned off when no video tool is present (`:176-177`). `:827` | WebM of the whole test with action overlays | Recorded for every run, kept on failure. Not masked; cannot be scrubbed. |
| Console logs | **Verified (failure only)** | `capture.ts:214-217` (`console`). Serialised `:255-262`. Re-masked `model.ts:96-101` | type, masked text ≤2 KB, source location, step, time from start. ≤200 lines, errors and warnings kept first (`capture.ts:26,212`) | Masked twice (script, then platform). |
| Browser errors | **Partial** | `capture.ts:218-220` (`pageerror`) | **message only, no stack** | Stack is **Missing**. The live reporter keeps a 4 KB stack of the *test* error only (`runner.ts:282`, not the page's). Discovery and authoring also collect raw error lines (`discovery/browser.ts:181-182`, see C). |
| Network requests/responses | **Partial (metadata only, failure only)** | `capture.ts:182-209`, `evidenceSerialize:243-254`. Schema `model.ts:16-29`. Stored `runner.ts:602-616` | method, resource type, host (only when not the app's own), path + query with sensitive values hidden, status, ms, size (content-length), failure reason, aborted/pending, step, t. ≤300 requests, failures kept first | **Never kept: bodies, cookies, any header** (`capture.ts:10-12,194-195`). No request id, no backend correlation id, no timing breakdown, no redirect chain. The full network log with bodies exists only inside the trace. |
| API execution logs | **Partial** | `generators/api.ts:32-37` (`responses` attachment), `:69`. Parsed at `runner.ts:784-790`. Persisted only as drift observations (`repo-sink.ts:177`, `recordObservations`) | method, spec path, status, optional body *shape* for successful GETs | No step index, no duration, no request headers, no body excerpts. Not kept as an execution artifact. The richer `calls` array (headers, body text, set-cookie, `api.ts:29,34`) lives only in memory for passive security checks. |
| Runner logs | **Verified** | `agent/log.ts:49-56` (every line redacted with registered secrets and their variants). Platform keeps progress lines scrubbed: `agent-services.ts:505-506,575-578` (≤300 chars, kept with the task for a day) | Plain lines | Not a per-execution artifact. Tasks are forgotten after a day (`agent/outbox.ts:22`). |
| Platform logs | **Verified** | `platform/ops/logger.ts:1-60` (`LOG_FORMAT=json`, `scrubLogText`, `requestId`, `job`, `component`) | JSON lines | `requestId` is the platform's own HTTP request id. It is unrelated to the tested application (`EXISTING_INFRASTRUCTURE_MAP.md` §2.13). |
| Job execution status / live events | **Verified** | `agent_events` (`db.ts:124-128`). SSE `stream-core.ts`, `event-bus.ts:1-20`. Live run events `runner.ts:252-257` (`test_started/finished`, `step_started/finished` **with `durationMs`**, `screenshot`). Stored scrubbed `agent-services.ts:607-650` | Event rows per job | Step durations reach the event stream only for live runs on a runner. They are not attached to the execution. |
| Execution records | **Partial** | `test_executions` (`db.ts:107-111`, plus `variant` `:143`, `environment` `environments-store.ts:38`, `test_version_id` `review-store.ts:81`, filled `:537`). `test_execution_steps` (`db.ts:112-115`). Written by `repo.ts:addExecution:903-933`, `variants-store.ts:29-32`, `environments-store.ts:240-243` | status, duration, error, started/finished; per step idx/title/status/error | **No step timing**; `PwStep` ignores Playwright's `startTime`/`duration` (`runner.ts:619-623`). `errorContext` (ARIA snapshot at the failure, `runner.ts:764-768`), `notes`, `vision`, `created` are not persisted with the execution. |
| Artifact storage | **Verified** | `platform/object-store.ts:1-40` (`ObjectStore`, `LocalDiskStore`; S3 later). `artifacts` table (`db.ts:129-133` + `pruned_at`/`pruned_reason`, `retention-store.ts:11-14`). Keys `<projectId>/_artifacts/<testKey>/<run dir>/<kind>.<ext>` (`repo-sink.ts:180-189`) | kinds `screenshot, trace, video, visual-actual, visual-diff, vision-shot, evidence` (`runner.ts:79`) | Download `GET /api/artifacts/:id` (`server.ts:957-981`), project-scoped (`auth/project-scope.ts:75`), signed 5-minute links when the store supports them. |
| Execution reports | **Verified** | `evidence-read.ts:31-63` (`evidenceView`), `routes/evidence.ts:15` (`GET /api/tests/:id/evidence`), `evidence/summary.ts` (deterministic sentence), `evidence/failure-facts.ts` (expected/received from the error text), `issues/content.ts:79-81`, `reports/project-report.ts:100-112,185`, `reports/junit.ts`, UI `web/src/features/evidence/EvidenceSection.tsx`, `FailureSummary.tsx` | Summary sentence, highlights, screenshot in the HTML/PDF report | JUnit has no evidence. Issues carry only the summary sentence and a link, never files (`issues/*.ts`). |
| Retention | **Verified (off by default)** | `engine/retention/policy.ts:10-12,43-49`, `rules.ts:23` (`PRUNABLE_KINDS`), `platform/retention-runner.ts:1-11` | Keeps the artifact rows; removes files | `enabled: false` unless the project or `RETENTION_DEFAULT_DAYS` sets a policy. |
| Evidence for passing runs | **Missing (opt-in env only)** | `capture.ts:274-275` `AITP_EVIDENCE=always` (passed through `runner.ts:519-520`). Not set anywhere in `src` | — | Change-aware selection (Workstream 4) needs what a *passing* test touched. Today nothing records it. |
| UI state per step | **Missing** (outside the trace) | Only in the trace's DOM/ARIA snapshots, and the `errorContext` ARIA snapshot at the failing check (`runner.ts:764-768`, used by repair, not stored) | — | No URL or title per step in structured form. |

---

## B. Minimal action event model

### B.1 Principle

**Proposed.** Do not add tables and do not add one column per field. Most of what the model needs is already stored, or can be derived at
read time:

| Model element | Where it already lives | What is missing |
|---|---|---|
| Execution id | `test_executions.id` | — |
| Step id, title, status, error | `test_execution_steps` (idx, title, status, error) | timing |
| Action type, target, input kind | the spec of the test version that ran: `test_executions.test_version_id` → the version's steps. Step *n* of evidence = `spec.steps[n-1]` | nothing to store; join at read time |
| Network/console per step | evidence artifact (`step` field on every entry) | request/correlation id, stack |
| Screenshot/trace/video refs | `artifacts` rows with `execution_id` | per-step trace position (derivable from the trace) |
| Expected/actual | spec step (`assert` check + value) + `failure-facts.ts` on the step error | structured join (read-time) |

So the model is mostly a **view**. It is an evolution of the stored evidence JSON (`v: 1` → `v: 2`, read side accepting both), still
stored as the existing `evidence` artifact kind and bounded by `EVIDENCE_MAX_BYTES` (`model.ts:13`).

### B.2 Proposed format (evidence v2: additions in **bold**)

```jsonc
{
  "v": 2,
  "durationMs": 18234,
  "counts": { "requests": 41, "requestsKept": 41, "console": 3, "consoleKept": 3 },
  "steps": [                                   // v1 had { n, t }
    { "n": 3, "t": 5120, "ms": 840,            // **ms**: Playwright step duration (JSON report: step.duration)
      "status": "failed",                       // **status**: duplicated from test_execution_steps for self-contained files
      "url": "/cart?id=[hidden]",               // **url**: page address when the step ended, masked with evidenceSplitUrl
      "title": "Cart",                          // **title**: document title, masked + clipped to 120 chars
      "trace": { "callId": "call@57" } }        // **trace ref**: only when derived from a kept trace (see B.4)
  ],
  "requests": [
    { "t": 5300, "step": 3, "method": "POST", "type": "fetch", "path": "/api/cart", "status": 500, "ms": 112, "size": 88,
      "corr": "a1b2c3d4" }                     // **corr**: value of an allow-listed correlation response header (see B.3)
  ],
  "console": [
    { "t": 5420, "step": 3, "type": "pageerror", "text": "TypeError: x is undefined",
      "stack": "at render (/static/app.js:120)\n..." }  // **stack**: masked, ≤1.5 KB, pageerror only
  ],
  "actions": [                                 // **optional**: only for a run with a kept trace (B.4); ≤300 entries
    { "step": 3, "api": "locator.click", "selector": "getByRole('button', { name: 'Pay' })", "t": 5130, "ms": 60, "error": "..." }
  ]
}
```

Event ids are **not stored**. They are deterministic: `<executionId>:<step n>`, `<executionId>:req:<index>`, `<executionId>:con:<index>`.

**Read-time outcome** (no storage; built in `evidence-read.ts` from spec + steps + evidence + artifacts):

```jsonc
{ "assertionId": "<testKey>#s3",               // test key + 1-based step number of the assert step
  "check": "text",                              // spec assert step's check
  "expected": "Added to the cart",              // spec value, masked (testData secrets → [hidden])
  "actual": "Payment failed",                   // failure-facts.ts from the step error, FACT_MAX 200
  "passed": false,
  "evidence": { "requests": [12, 13], "console": [2], "screenshot": "<artifactId>", "trace": "<artifactId>", "video": "<artifactId>" } }
```

**Input classification** (Proposed, read time, from the spec step; the value is never shown):
`none` | `literal` | `test-data` (`{{data.x}}`) | `generated` (`runTag` / fake data) | `credential` (sign-in fields, `specUsesCredentials`
in `playwright.ts:334`) | `environment` (`{{env.X}}`) | `secret-environment` (an env name matching `SECRET_VAR_NAME`, `trace-scrub.ts:86`).

### B.3 Correlation strategy

| Link | Today | Proposed |
|---|---|---|
| Action → network/console | **Verified**: every entry carries `step`, the step current when the request *started* (`capture.ts:186`). Steps carry `t` (`capture.ts:238`) | Keep this as the main key. Add step `ms` so "issued during step 3 but answered after it" can be shown (request `t + ms` > step `t + ms`). |
| Step → time | Partial: `t` from start in evidence; `durationMs` only in live events (`runner.ts:255`) | Read `startTime`/`duration` from the JSON report steps (`runner.ts:220`, `PwStep :619`). Store in evidence v2 `steps[].ms`. Optionally pass them to `StepResult` for the run page. |
| Browser → backend | **Missing** | Read only an allow-list of *response* headers that carry correlation ids: `x-request-id`, `x-correlation-id`, `traceparent`, `x-amzn-trace-id`, `cf-ray`. Store the value masked and clipped to 64 chars in `requests[].corr`. This lets a person or the Sentry lookup (`platform/sentry/*`) find the server log line. **Do not inject request headers** (for example `x-aitp-step` or a `traceparent` via `page.route`). A custom header on a cross-origin request triggers a CORS preflight and can change application behaviour and test results. Offer it only as a later per-project opt-in. |
| Request ids inside the run | Playwright request objects (`capture.ts:187` WeakMap); index in the list | Event id = index (B.2). No new id needed. |
| Execution → trace | artifact row with `execution_id` | Trace digest (B.4) gives each action its `callId` and time, so the UI can open the trace near the failing step. |
| API tests | `responses` without step/time (`api.ts:69`) | Add `step` and `ms` to each `responses` entry. This is a rendered-script change (D). |

**How the rendered script tags requests per step (Verified, already in place):** `evidenceStep(page, i + 1)` is emitted before each
`test.step` (`playwright.ts:357-360`). The recorder labels every later request and console line with that number. Popups are hooked too
(`capture.ts:229`). No new tagging is needed. The gaps are timing (fixed from the JSON report on the platform, no script change) and the
correlation header (script change).

### B.4 Trace digest (Proposed, platform-only, no script change)

For a failed run that kept a trace, the platform already opens the archive to clean it (`trace-scrub.ts:430`). A pass on the *cleaned* trace
could extract a bounded action list (`api`, selector, start/end, error) and per-action network timing into evidence v2 `actions`. That gives
action-level correlation for every failed run with no change to generated scripts.
**Suspected: the trace event format** (`trace.trace` / `trace.network` JSON lines in Playwright 1.65.0) must be checked against the installed
version before this is built. Treat the format as unstable and never fail a run on a parse error.

### B.5 Storage needed

- **No new table and no new column** for v2 (Proposed). It stays in the `evidence` artifact.
- Size, by estimate (Proposed; measure before fixing caps):
  - v1 today: ≤600 KB cap (`model.ts:13`), typically about 150 B × requests.
  - v2 adds about 60 B × steps, ≤1.5 KB × page errors, and about 120 B × actions (≤300 → ≤36 KB).
  - The 600 KB cap stays. The existing shrink loop (`model.ts:118-123`) extends to drop `actions` first.
- **Optional, only for Workstream 4:** a passing-run "footprint" (method + normalised path + status per step, no console). It is about
  2–5 KB per execution if stored as an `evidence` artifact with `AITP_EVIDENCE=always`-like gating per project. That is one more file per
  passing run, and it is prunable. A JSON column on `test_executions` would avoid the file but needs a migration in `db.ts` *and*
  `pg/baseline.sql`, both currently edited by Phase 1. Defer the decision to Workstream 4 (Proposed).

---

## C. Redaction: where secrets or personal data can leak

| # | Place | Covered by | Gap | Status |
|---|---|---|---|---|
| C1 | Evidence network/console (script side) | `capture.ts:85-104` (`evidenceScrub`: cookies, Bearer/Basic, JWT, known key shapes, `name=value` secrets, long hex/base64). `:111-122` (`evidenceText`). `:133-155` (query values by name). `:44-68` (env secrets whose names end in `PASSWORD/SECRET/TOKEN/AUTH_HEADER`) | Env names ending `_KEY` (for example `TEST_ENV_API_KEY`) are not taken as secrets in the script (`:50`). No email, card-number or phone patterns. | Verified gap (PII) |
| C2 | Evidence re-mask (platform) | `model.ts:72-125` with `secretsOfRun` `:58-66` | `secretsOfRun` leaves out `env.vars` and the saved sign-in values (`storageState`). `traceSecretsOfRun` includes both (`trace-scrub.ts:58-83`). Same gap on the runner collect path (`agent-services.ts:1629`). A secret env value that is not shaped like a token, printed in a console line, is stored. | **Verified gap** |
| C3 | Traces | `trace-scrub.ts` (known values in every encoding; refuses what it cannot clean) | (a) Values the *application* issued during the run (`Set-Cookie`, CSRF tokens, bearer tokens returned by a login API, personal data in response bodies) are not known to the run and stay in the trace (documented, `:28-34`). (b) A run without credentials keeps the trace untouched (`:540`). (c) Compressed bodies are not searched. | Verified (by design) |
| C4 | Authoring traces | `web/author.ts:659` | Masked with the sign-in password **only**. TOTP secret, role passwords, API token, env secrets and saved sign-in are not used, unlike `traceSecretsOfRun`. Kept in the scratch folder (`AUTHORING_TRACES`, `:640-646` pruning). | **Verified gap** |
| C5 | Authoring/exploration "problems" | none | `discovery/browser.ts:159-160,181-193` keeps the raw `Console error: <text>` and `Page error: <message>` (≤300 chars). These go into the action observation (`web/author.ts:127`), the defect-verdict prompt (`:187`) and the defect `evidence` list (`:346,552`). This text is sent to the AI provider unmasked. `onAction` does not store it: AI action records are no longer kept (the job sink's `agentAction` is a no-op and the `agent_actions` table was dropped in migration slot 63). | **Verified gap** (to provider) |
| C6 | Screenshots, videos | none for test runs. Explorer frames cover password, OTP and card fields and fields holding a stored secret (`frames/shoot.ts:1-9,54-58`) | Failure screenshot and video show every value on the page. Password inputs are drawn as dots, but an API key typed into a text field, personal data, and payment data in non-`password` fields stay visible. Project report HTML/PDF embeds the screenshot as base64 (`project-report.ts:112`). | Verified gap (cannot be text-scrubbed) |
| C7 | `errorContext` (ARIA snapshot at failure) | `runner.ts:578` (`maskSecrets` with run secrets). Runner `mapping.ts:149` | Known values only. The snapshot holds visible page text, which can include personal data. Not stored, but sent to the repair model. | Partial |
| C8 | `run.error`, step errors (test_executions.error, test_execution_steps.error) | Runner path: `agent/mapping.ts:143-150` (`maskRun`) + platform `scrubSecrets` (`agent-services.ts:834`). Plug-ins: `frameworks/plugin.ts:267-283` | Platform run path (`frameworks/builtin.ts:44` → `runScripts`) masks only `errorContext` (`runner.ts:578`), not `error`/`steps[].error`, before `repo-sink.ts:164-176` stores them. A Playwright error such as `expected "…" to have value "<secret>"` would be stored. | **Suspected** (verify that no wrapper masks first) |
| C9 | Live events (step errors, test stack ≤4 KB) | `agent-services.ts:638` (`scrubSecrets` with run secrets) | Known values only; shape rules are not applied | Partial |
| C10 | Runner and platform logs | `agent/log.ts:49-56`; `ops/logger.ts` (`scrubLogText`: server secrets, Bearer/Basic, JWT, secret query params) | Fine for credentials. Personal data is not masked. Acceptable for logs. | Verified |
| C11 | Discovery API samples | `discovery/network.ts:21,30-35,37+` (secret-named fields and query params replaced, `card/cvv/cvc` included) | Personal fields (email, phone, name) in response *samples* kept as examples. Body *shapes* are fine. | Partial |
| C12 | API test `responses` attachment | spec path only, body shape (types) only (`api.ts:67-69`) | Path literals can carry ids or emails (for example `/users/jane@x.com`) | Partial |
| C13 | Issue text | summary sentence only (`issues/content.ts:79-81`); failure text clipped (`failureText`) | Failure text comes from C8. If C8 is unmasked, so is the issue. | Depends on C8 |
| C14 | Security findings | `security/findings/redact.ts:1-30` (cookies, auth headers, JWT, secret params, `.env` lines, **emails**) | Strongest scrubber in the code base. Not reused by test evidence. | Verified |
| C15 | Stored artifacts at rest | project-scoped download (`project-scope.ts:75`), signed links (`server.ts:974`), runner results encrypted at rest (`agent-services.ts:10`) | Artifact files on local disk are plain files. Retention is off by default (`policy.ts:43-49`). | Verified |

**Proposed redaction rules for evidence v2** (one shared place: `capture.ts` script side + `model.ts` platform side):

1. Use one secret set for every scrubber of a run. `secretsOfRun` returns the same values as `traceSecretsOfRun` (C2), and authoring uses it
   too (C4).
2. Add personal-data patterns to the *platform* re-mask only. This keeps rendered scripts unchanged:
   - email local part → `[email hidden]`, reusing `security/findings/redact.ts` `EMAIL`;
   - 13–19 digit runs that pass Luhn → `[card hidden]`;
   - IBAN shape.
   Apply them to console text, `stack`, `title`, `failed`, path segments.
3. New v2 fields go through the same `evidenceText`/`evidenceSplitUrl` functions in both places. `corr` values are clipped and shape-checked
   (hex, UUID, `traceparent`) so they cannot carry arbitrary text.
4. Mask `problems` lines in discovery and authoring with `evidenceText(text, secrets)` before they reach a prompt (C5).
5. Mask `run.error` and `steps[].error` on the platform path exactly as `maskRun` does on the runner (C8, after reproduction).
6. Screenshots and videos: no pixel scrubbing (Proposed against it: costly, unreliable).
   - Make the *existing* explorer cover (`frames/shoot.ts` `coverIn`) available as an opt-in fixture for failure screenshots. It would cover
     password, OTP and card fields and fields that hold a stored secret.
   - Videos cannot be covered after the fact. Offer a project setting "no failure video" (the mode already exists, `runner.ts:177`).
   - The project report includes screenshots only when the project allows it.
7. Traces: keep the known-value scrub. Additionally mask the *values* of `Set-Cookie`, `Cookie` and `Authorization` headers in the trace
   network log by header name (Proposed, needs the trace format check in B.4). This closes most of C3(a). Bodies stay as they are, a
   documented limit.

---

## D. Storage, retention, plan, acceptance, dependencies

### D.1 Storage and retention implications

- v2 keeps the current file count and the 600 KB cap. The trace digest adds ≤36 KB per failed run. Estimated growth is under 10% of the
  `evidence` kind and negligible next to traces and videos (Proposed estimate).
- A passing-run footprint (only if Workstream 4 needs it) adds one small file per passing execution. Most executions pass, so this is the one
  item with real growth: about 5 KB × executions. Gate it per project; it is prunable (`PRUNABLE_KINDS`).
- **Retention default** (Proposed, to be decided, see the Open questions below): keep `enabled: false`, but show storage and age in Settings.
  Alternatively, ship a platform default (`RETENTION_DEFAULT_DAYS`). Traces and videos are the bulk and also the most sensitive (C3, C6).
- No schema change is needed for anything in D.2 except the optional footprint column, which is not recommended.

### D.2 Implementation plan (small steps)

All steps are developed on a separate branch or worktree and merged **after the Phase 1 baseline is frozen** (`baseline.json` written). See
D.4. "Script change" means the rendered Playwright/API script text changes.

| Step | Change | Files | Script change | Size |
|---|---|---|---|---|
| E1 | One secret set: `secretsOfRun` takes the same inputs as `traceSecretsOfRun` (vars, storageState values); runner collect uses it | `engine/evidence/model.ts`, `platform/agent-services.ts:1629`, `validation/runner.ts:577` | no | S |
| E2 | Mask discovery/authoring problem lines; authoring trace scrub with the full secret set | `engine/discovery/browser.ts:159`, `engine/web/author.ts:659` (+ the run's secrets reach `AuthorInput`) | no | S |
| E3 | Reproduce C8 with a unit test; if confirmed, mask `error`/`steps[].error` after `parseReport` | `validation/runner.ts:575-580` | no | S |
| E4 | Personal-data patterns in the platform re-mask (email, Luhn card, IBAN) | `engine/evidence/model.ts` (+ reuse `security/findings/redact.ts` EMAIL) | no | S |
| E5 | Step timing: read `startTime`/`duration` of top-level steps from report.json; `StepResult.durationMs?`; evidence v2 `steps[].ms` (merged at `storeEvidence`) | `validation/runner.ts:619-623,733-745,602-616`, `engine/evidence/model.ts` (v2 schema, v1 accepted) | no | S |
| E6 | Read-time outcome view: join spec step, step result, `failure-facts`, evidence and artifacts into `outcomes[]` on `GET /api/tests/:id/evidence` | `platform/evidence-read.ts`, `engine/evidence/summary.ts`, `routes/evidence.ts`, `web/src/features/evidence/*` | no | M |
| E7 | Trace digest into v2 `actions` (after format check); header-name masking in trace network log | `engine/evidence/trace-scrub.ts` (or a new `engine/evidence/trace-digest.ts`), `validation/runner.ts`, `agent-services.ts:1676` | no | M |
| E8 (batch) | Script-side additions in one release: `pageerror` stack, allow-listed correlation header → `corr`, step URL/title at step change, `_KEY` env names as secrets; API `responses` gain `step`/`ms` | `engine/evidence/capture.ts`, `engine/generators/api.ts`, keep the `evidenceStep(page, N);` line format unchanged for `mutation/faults.ts` and `web/socket-faults.ts` | **yes** | M |
| E9 | Opt-in screenshot cover fixture and "no failure video" project setting; project report screenshot opt-in | `validation/runner.ts` config, `engine/frames/shoot.ts` (export), `reports/project-report.ts` | yes (fixture), config | M |
| E10 (only if Workstream 4 asks) | Passing-run footprint gated per project | `capture.ts` `evidenceAttach`, `runner.ts:519` | yes | S |

### D.3 Acceptance criteria

- **E1:**
  - A run with env var `DB_PASSWORD=s3cr3t-value` and a saved sign-in cookie `sid=…` prints both in a console line.
  - The stored evidence holds neither value, on both the platform path and the runner path.
  - `sanitizeEvidence` stays idempotent (existing property).
- **E2:**
  - A page that logs a secret value and an email into the console during authoring.
  - The verdict prompt text does not contain the secret (AI action records are no longer stored; `agent_actions` was dropped in migration slot 63).
  - The kept blocked-scenario trace contains no TOTP secret, API token or role password.
- **E3:** A failing `toHaveValue(<password>)` on the platform path stores `[hidden]` in `test_executions.error` and in the step error.
- **E4:** `jane.doe@example.com` and `4111 1111 1111 1111` in console text are stored masked. A UUID, an order number and a timestamp are not
  masked (no false masking of ids).
- **E5:**
  - Every stored v2 evidence has `ms` for each top-level step, and the sum is within the test duration.
  - v1 files still render. The `/api/tests/:id/executions` shape is unchanged apart from optional fields (the benchmark reads `status` and
    `startedAt` there, `eval/bench/controller.ts:256`).
- **E6:**
  - For a failing assert step the API returns `assertionId`, `expected`, `actual`, `passed:false` and refs to requests of the same step and
    to the screenshot, trace and video artifacts.
  - No new rows are written.
- **E7:**
  - For a failed run with a kept trace, `actions` lists the failing action with its selector and error.
  - The digest never makes a trace withheld that would have been kept.
  - A malformed trace yields no `actions` and an unchanged run.
  - `Set-Cookie`, `Cookie` and `Authorization` values are absent from the stored trace.
- **E8:**
  - The rendered script for a fixed spec changes only in the helper block.
  - The `evidenceStep` marker regex used by `faults.ts` still matches, so fault-injection tests pass unchanged.
  - A page error stores a masked stack ≤1.5 KB.
  - A response carrying `x-request-id` stores it as `corr`, and no other header value is stored.
  - No request header is added: compare outgoing request headers of one run before and after.
- **E9:** With the cover on, a failure screenshot of a page with a filled card field shows the field covered. With it off, the output is
  byte-identical to today. A project report with screenshots disabled has no `<img>`.
- **All steps:** the fast test tier stays green; no change in pass/fail of the existing validation fixtures.

### D.4 Dependency and conflict table

Columns:
- **P1-indep:** can be built without Phase 1.
- **P1 models / P1 intel:** depends on Phase 1 database models or on Phase 1 application intelligence.
- **Gen/repair:** changes test generation or repair behaviour.
- **Bench exec:** changes benchmark execution if merged before the baseline ends.
- **Cust results:** could alter existing customer results.
- **Scripts:** touches rendered scripts.

| Step | P1-indep | P1 models | P1 intel | Gen/repair | Bench exec | Cust results | Scripts | Conflicts with |
|---|---|---|---|---|---|---|---|---|
| E1 | yes | no | no | no | `src/engine` dirty flag only; results same | no (stored text only) | no | WS1 (redaction owner), WS2 (`agent-services.ts`) |
| E2 | yes | no | no | **prompt text changes** (masked lines only); `web/author.ts` is a fingerprinted prompt source | **yes**: prompt fingerprint changes | could change a defect verdict in rare cases where the secret text mattered | no | WS1 |
| E3 | yes | no | no | repair reads `run.error`: masked values only | dirty flag | no | no | WS2 (`runner.ts`) |
| E4 | yes | no | no | no | dirty flag | no | no | WS1 (`findings/redact.ts` reuse) |
| E5 | yes | no | no | no | dirty flag | no (adds data) | no | **WS2** (`runner.ts` parseReport, live reporter); WS4 (step timing for selection) |
| E6 | yes | no | no | no | no (platform read side) | no | no | WS4 (UI evidence area), WS1 (finding evidence view) |
| E7 | yes | no | no | no | dirty flag; more CPU per failed trace on the shared machine | no | no | WS1 (trace scrub owner), WS2 (`agent-services.ts` collect) |
| E8 | yes | no | no | no | **yes**: every rendered script changes | `content_hash` changes → flaky/quarantine window restarts (`quarantine-store.ts:128-140`), trends grouped by hash (`trends.ts:340`) | **yes** | **WS2** (generator, runner config), WS1 (api.ts `calls` used by passive checks), WS4 (footprint) |
| E9 | yes | no | no | no | config change | screenshots differ only when opted in | fixture | WS2 (runner config) |
| E10 | yes | no | no | no | yes | more storage only | yes | **WS4** (consumer) |

None of the steps depends on Phase 1 database models (`app_intel_*`, slot 62) or on Phase 1 application intelligence (`src/engine/intel/`).
None needs a migration, which avoids `db.ts` and `pg/baseline.sql` (both edited by Phase 1).

**Shared files (merge-conflict risk):**

| File | Workstreams |
|---|---|
| `src/engine/validation/runner.ts` | WS2 (config, timeouts, parseReport, live reporter), WS3 (E3, E5, E7, E9) |
| `src/engine/evidence/capture.ts` | WS3 (E8, E10), WS1 (redaction patterns) |
| `src/engine/evidence/trace-scrub.ts` | WS3 (E7), WS1 |
| `src/engine/evidence/model.ts` | WS3, WS1 |
| `src/engine/generators/playwright.ts`, `generators/api.ts` | WS2 (waits, locators), WS1 (security checks via `calls`), WS3 (E8) |
| `src/platform/agent-services.ts` | WS2 (runner protocol, retries), WS3 (E1, E7), WS1 |
| `src/engine/web/author.ts` (also a Phase 1 prompt fingerprint) | WS2 (authoring reliability), WS3 (E2) |
| `src/engine/discovery/browser.ts` | WS2 (session), WS1, WS3 (E2) |
| `src/platform/evidence-read.ts`, `web/src/features/evidence/*` | WS3 (E6), WS4 (footprint view), WS1 (finding evidence) |
| `src/engine/mutation/faults.ts`, `web/socket-faults.ts` (anchor on `evidenceStep` line) | WS3 must not change the marker; WS2 if it changes step emission |
| `src/platform/repo-sink.ts` | WS2, WS3, WS4 (if footprint stored) |

**Recommended order (Proposed):**
1. E1, E3, E4 (redaction, platform-only, small). They can be prepared now on a branch and merged first after the baseline.
2. E5, then E6 (structured timing and outcome view, no script change).
3. E2 after the baseline, because it changes a prompt fingerprint. Record it as a post-baseline engine change.
4. E7.
5. E8 as **one** batch together with any Workstream 2 generator changes, so script hashes change once.
6. E9, and E10 if Workstream 4 asks for it.

---

## Open questions

1. Should retention ship enabled by default (for example 30 days passed / 90 failed), given traces and videos hold application-issued cookies
   and on-screen personal data?
2. Should project reports embed failure screenshots by default?
3. Is a per-project "keep evidence for passing runs" (footprint) acceptable for Workstream 4, at about 5 KB per execution?
4. May the platform read allow-listed correlation response headers from the tested application? Injecting request headers is not
   recommended.
