# Benchmark methodology

How AI Studio's ability to find real defects is measured. The benchmark runs the normal pipeline against small applications the
platform owns, with deliberately planted ("seeded") defects whose correct and defective behaviour is known and independently checked.

## Applications and seeded defects

### Applications

| Application | Start | What it is |
|---|---|---|
| BenchShop | `node examples/bench-shop/server.mjs <port>` | Registration and sign-in, product list and detail, cart with quantities, a discount code, shipping rule, two-step checkout (address, then review and place), order history, order states (placed, paid, shipped, cancelled), account profile. Server-rendered pages whose forms call a JSON API (`/api/...`), described in `/openapi.json`. |
| BenchNotes | `node examples/bench-rbac/server.mjs <port>` | Registration and sign-in, notes owned by people, sharing and revoking, roles user / manager / admin (managers read every note, only admins manage people and roles), protected API, sessions and sign-out, `/openapi.json`. |

Both are dependency-free Node servers that listen on `127.0.0.1` only and make no outbound calls (checked by a test). `startBenchApp` in `src/eval/bench/verify/app.ts` starts, resets and stops them. Data lives in
memory, is seeded deterministically (accounts in `src/eval/bench/catalogue.json` → `apps.*.accounts`, fixed product and note ids) and
is reset on start and by `POST /__bench/reset` with header `x-bench-reset: <BENCH_RESET_TOKEN>`; without that environment variable the
route does not exist (404), with a wrong token it answers 403.

The rules the defects break are stated where a person (or the engine) can read them: on the pages ("Up to 10 per item", "Code SAVE10
takes 10% off your order subtotal", "Free shipping on orders of $50.00 or more", "You can cancel an order until it ships", "Passwords
need at least 8 characters", "Every note needs a title", the role description) and in each application's OpenAPI description. They are
the documented expected behaviour; current behaviour is never taken as proof.

### Sign-in and hardening

Sign-in and registration are plain HTML forms by default (`BENCH_LOGIN=html`): they POST, and the server answers `303` to the next page
with the session cookie, or the form again with the message (`400`). Nothing navigates on page load; a signed-out visit to a protected
page is a server `303` to `/login`. The benchmark measures defect detection, not sign-in handling.

`BENCH_LOGIN=js` keeps the first version as an opt-in variant: the same forms are sent by the page script to the JSON API, and the page
changes location afterwards. **The engine's own sign-in (`engine/discovery/auth.ts`) did not get through that variant** ("Login did not
succeed with the supplied credentials": it judges the result right after the click, before the script has navigated; the late navigation
then interrupts the next page load, and discovery found no loadable pages). That is a recorded engine observation, measured separately
by running the benchmark with `BENCH_LOGIN=js`.

Every response carries standard hardening, and the pages keep to it: a Content-Security-Policy (`default-src 'self'`, `script-src
'self'` with no inline script, `style-src 'self' 'unsafe-inline'`, `frame-ancestors 'none'`, `form-action 'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`; the session cookie is
`HttpOnly; SameSite=Lax` (no `Secure`: plain http on loopback); no version banners, no CORS headers. `tests/bench-clean.test.ts`
("clean variant: no check-family finding") runs the engine's own passive security checks (the exact helper generated scripts carry) and
its generated page health checks under Playwright against both clean applications and requires zero findings, so a check-family finding
in a benchmark run is either caused by a seeded defect or counted as a false positive.

**Second recorded engine observation:** with a strict `style-src 'self'` (no `'unsafe-inline'`) every generated page health check fails
with "1 JavaScript error ... Applying inline style violates the following Content Security Policy directive", although the pages contain
no inline style: the style element is injected by the test run itself (Playwright hides the text caret for screenshots), so the engine
reports its own side effect as a defect of any site with a strict style policy. The applications therefore allow inline styles (scripts
stay `'self'`); the observation is a false-positive source to fix in a later phase.

### Switches

`BENCH_DEFECTS=none` (default) is the clean application; `all` switches every defect on; a comma-separated list of ids switches those
only. One build serves every variant. Defects are silent: the page looks normal and no message reveals them.

### Catalogue (hidden from the engine)

`src/eval/bench/catalogue.json` (versioned, currently `2026-11-14.1`) holds, per defect: id, application, workflow, category, expected
behaviour, actual behaviour, preconditions, reproduction steps, verifier, severity, impact, and whether it is detectable with today's
infrastructure (yes / partly / no, with the reason). Only the benchmark controller reads it. A test crawls every reachable page, static
file, API description and readable API answer, signed out and as every seeded account, with every defect switched on, and fails if any
defect id, catalogue sentence or wording such as "defect", "seed", "bug", "catalogue", "switched" or `BENCH_` is served.

| Id | App | Category | Workflow | Severity | Detectable today |
|---|---|---|---|---|---|
| BS-01 | Shop | business logic | discount code | high | partly |
| BS-02 | Shop | calculation | cart subtotal | critical | partly |
| BS-03 | Shop | boundary | quantity limit (10) | medium | partly |
| BS-04 | Shop | validation | registration email | medium | partly |
| BS-05 | Shop | state transition | cancel a shipped order | high | partly |
| BS-06 | Shop | persistence | profile save | high | partly |
| BS-07 | Shop | duplicate operation | placing an order twice | critical | no |
| BS-08 | Shop | authorization (horizontal) | another person's order | critical | partly |
| BS-09 | Shop | API contract | unknown product → 404 | low | partly |
| BS-10 | Shop | workflow | skipping the address step | high | no |
| BS-11 | Shop | boundary | free shipping at exactly $50.00 | medium | partly |
| BS-12 | Shop | persistence | newest order missing from history | medium | partly |
| BR-01 | Notes | authorization (horizontal) | reading another user's note | critical | partly |
| BR-02 | Notes | authorization | a reader can edit a shared note | high | no |
| BR-03 | Notes | authorization (vertical) | people list for non-admins | high | yes |
| BR-04 | Notes | authorization (escalation) | managers change roles | critical | no |
| BR-05 | Notes | authorization (session) | session works after sign-out | high | no |
| BR-06 | Notes | authorization | revoked sharing still visible | high | no |
| BR-07 | Notes | validation | short password accepted | medium | partly |
| BR-08 | Notes | API contract | note without a title created | low | partly |

20 defects: 12 in BenchShop, 8 in BenchNotes. "Detectable today" is a judgement from the Phase 0 audit (for example, duplicate submission
and step skipping need data-changing actions the pipeline does not plan by default); the baseline measures it.

### Independent verification

Each defect has a verifier in `src/eval/bench/verify/index.ts`: plain HTTP against the running application, no model, no browser, no
knowledge of the code, following the catalogue's reproduction steps. It answers "defective behaviour present" or "correct behaviour
seen". `tests/bench-verify.test.ts` proves, for both applications:
- with `none`, every verifier sees the correct behaviour;
- with `all`, every verifier sees its defect;
- with one defect switched on alone, its verifier fires and **no other verifier of that application does** — so a finding that fails
  with exactly one defect on can be pinned to that defect.

`tests/bench-apps.test.ts` proves the reset rules, the hidden catalogue, loopback-only listening, and that the main journeys work in a
real browser (sign in, cart, quantity limit message, checkout with an address, order history; notes, title message, sharing, admin page
refused), because the engine drives the pages, not only the API.

### Safety

Applications run only on loopback ports chosen by the controller, with disposable in-memory data and no outbound calls; they are never
deployed and never pointed at a customer environment. Data-changing tests are allowed only against them.

### Limits

Two small applications and 20 known defects; real applications are larger and their defects are unknown. Defect classes are chosen to
cover the categories the plan names, not their real-world frequency. A detection rate here is not a real-world rate.

## Procedure

The controller is `src/eval/bench/controller.ts`, run by `node scripts/eval.mjs bench` (`src/eval/bench/cli.ts`; `--help` lists every option).

1. **Its own platform.** The command starts a platform in its own process with a data folder of its own (never `./data`, never a running
   platform): open mode, no shared key, tests run by this platform itself (`EXECUTION_MODE=local`). The AI model is the one configured in
   `.env`, exactly as for the platform; nothing about the model is built into the benchmark.
2. **Exploration, as a person does it.** For each app, the app is started on a loopback port with its seeded behaviours switched on
   (`discovery`, the primary measure) and the normal evaluation entry runs through the platform's API (`src/eval/harness.ts`): explore and
   plan, create the tests from the plan, rerun them. The platform receives the app's address and its seeded sign-in account and nothing else
   (no catalogue, no defect id; a test checks that no model call carries one). `--mode regression` instead explores the correct app and runs
   the created tests with the defects in.
3. **Findings.** A finding is a test the platform reported as a possible application problem (validation status `NEEDS_REVIEW`); in
   regression mode, a created test that fails with the defects in.
4. **Attribution by replay, no model.** Every finding is replayed through the platform's own run route: once more with the defects on, once
   with every defect off, and (for findings that failed with them on and passed with them off) once with each seeded defect alone. The app
   restarts for every replay, so its data is fresh each time.
5. **Recording.** The result records the engine commit and whether `src/engine` had uncommitted changes, a sha256 of every engine prompt
   source (`PROMPT_SOURCES` in `record.ts`), provider, model id, fast and planning models, the generation settings (no temperature is set by
   the engine), the catalogue version and hash, each app's version (hash of its server script), every exploration option, the operator's
   price table, the approved budget, the daily call cap and how often the run was resumed.
6. **Kept.** The result is stored through the existing evaluation run store (`EvalRun.benchmark`, shown in Settings, Quality of the AI
   tester) and written to its output folder (`eval/results/bench/` by default; see "Output folders"). With `--baseline` it is written once to `baseline.json` with `baseline.json.sha256`,
   read-only; a second baseline in the same folder is refused, and the baseline is written only when every app finished.

### Output folders

Each kind of run keeps its results, its baseline, its resume state (`bench-state.json`) and the calibration of its estimates in a folder of
its own under `eval/results/`, so results of different kinds are never mixed. The default folder follows from the mode and the sign-in
variant (`defaultOutName` in `src/eval/bench/cli.ts`); a run pointed at a folder that already holds results of another kind is refused.

| Folder | Run |
|---|---|
| `bench` | discovery mode, HTML sign-in (the baseline) |
| `bench-login-js` | discovery mode, `--login js` |
| `bench-regression` | `--mode regression`, HTML sign-in |
| `bench-regression-login-js` | `--mode regression`, `--login js` |
| `bench-v2-notes` | the corrected notes-only run (below), given explicitly with `--out` |

Each run also uses its own fresh platform data folder (`--data-dir`); a folder is never reused for another run.

### Corrected snapshot (notes application)

The first baseline was stopped by the daily call cap and resumed. On resume the controller looked up which planned ideas already had a
test by reading `spec.scenarioId`, while the engine stores the idea's id at `spec.source.scenarioId`; it found none, so the resumed
creation wrote tests again for ideas already made (the notes project ended with 190 tests, many ideas authored twice). That notes result
is therefore not used as the baseline for that application.

The correction is a second frozen snapshot whose only code difference from the original is that lookup (it reads
`spec.source.scenarioId` and still accepts `spec.scenarioId`). Engine, prompts, model, generation settings, benchmark applications,
catalogue and prices are identical; both snapshots' fingerprints (a hash over `src`, `examples` and `scripts`) are recorded and checked
before each run. The original snapshot and its results, including the shop result, stay unchanged as historical records. The corrected
notes-only run uses the same options as the original, with its own output folder (`bench-v2-notes`) and its own fresh platform data
folder; the notes application keeps its data in memory and starts from its seed on every start, so no other reset is needed. Before that
run, a check without a real model must show that a resume no longer re-authors an idea (the fixed lookup finds the ideas already made,
and a scripted stop-and-resume authors no idea twice).

### Cost, limits and stops

- Before a run: an estimate of calls and tokens (from the level's limits, calibrated by the last benchmark result in the folder when there is
  one). A run with a real model refuses to start without a price table row for the model (`--prices`; `0`/`0` for a free model, with a
  `note` such as "free (OpenRouter :free variant)") and `--approved-budget-usd` (`0` for a free model).
- During a run: the price is set on the benchmark's platform, so its usage records are priced; for a paid model the platform's monthly and
  per-job token limits are set from the budget (AI work stops cleanly at them), and the controller stops the run when the priced usage
  passes the budget. `--daily-call-cap` stops it when the platform's AI calls of the UTC day reach the cap (free models are limited per day);
  the calls so far are printed as the run goes.
- Rate limits: the AI layer retries a rate-limited call on the same model (the model is never switched). When a job still ends because of
  the provider's rate limit, or the daily cap stops it, the app is marked `stopped`, the tests made so far are judged, the state is saved in
  `bench-state.json` after every app, and `--resume` runs the apps that did not finish on the same platform data (only `--yes`, the budget,
  the daily cap and `--out` may change on a resume).

## Metrics

Pure functions in `src/eval/bench/metrics.ts`, unit-tested in `tests/bench-metrics-unit.test.ts`. Counts are summed over the apps and every
rate is recomputed from the sums (rates are never averaged). A rate with a denominator of 0 is reported as "not measured", never as 0.

| Finding category | Rule (replays only) |
|---|---|
| confirmed | fails again with the defects on, passes with all off, fails with at least one seeded defect alone; attributed to each such defect |
| combined | fails again with the defects on, passes with all off, no single defect alone makes it fail |
| false positive | fails with every defect off too (or a person labelled it false) |
| unreproduced | did not fail again with the defects on, or could not run (for example a possible bug the AI noted while writing a test: it has no failing step to replay) |

| Metric | Definition | Denominator |
|---|---|---|
| Detection rate | seeded defects with at least one confirmed finding | seeded defects switched on in the run |
| Precision | true positives (confirmed + combined) | every reported finding |
| Precision (verified) | true positives | true positives + false positives (unreproduced left out) |
| False-positive rate | false positives | every reported finding |
| Reproduction rate | findings that failed again in the replay with the defects on | findings selected for verification (all of them) |
| Detection time | benchmark start to the first failure the platform recorded for a confirmed finding | — (none found: not measured) |
| Cost per confirmed defect | estimated AI cost from the platform's usage records and the operator's prices | detected defects |

Also reported, never as quality measures: tests generated, workflow areas reached by the tests' own addresses, execution failures (tests the
platform could not make pass), flaky tests, AI calls and tokens, execution time.

**Labels.** An unreproduced finding can be labelled by a person (`--labels`, `"<app>/<testKey>": "<defect id>" | "false_positive"`). A defect
label counts in "detected only by a person's label", never in the detection rate; a false-positive label counts as a false positive.

**Limits of the numbers.** Attribution by replay credits a finding only when its own test fails because of the defect; a correct observation
the AI wrote only in prose (an unreproduced finding) is not credited without a person's label. The model is not deterministic: repeat runs
and report the spread before concluding that a change helped.
