# Flaky-test quarantine

A test that passes and fails on identical runs trains people to ignore red, and one such test can hold up a release. Quarantine
lets a person say "this test is unreliable, keep running it, but stop letting it decide anything", with a reason, an owner and an
end date, and puts it back to work when it has proved stable. It is for flaky tests only; it is not a way to hide real problems.

## What a person sees

- **Unreliable tests card** (Schedule page): each flaky test that may be quarantined has a **Quarantine** button and the evidence
  ("Failed 3 of the last 10 runs, passed on re-run twice"). A quarantined one shows a **Quarantined** badge. The platform never
  quarantines anything by itself; a person always confirms.
- **The dialog**: the reason is prefilled ("Passed and failed on identical runs 4 times") and can be edited (up to 300
  characters), the time (1 to 60 days, 14 by default) and your name (remembered). Nothing is applied until you confirm.
- **Test page**: while quarantined, a callout with the reason, who, since when, when it ends and a **Release from quarantine**
  button; the quarantine history; and, once it has ended, "Quarantine ended; this test counts again". An unreliable test that is
  not quarantined gets the offer to quarantine it. An ordinary test shows nothing new.
- **Tests page**: a **Quarantined** filter with its count (also `#/projects/<id>/tests?quarantine=1`), a badge and the reason on
  each quarantined test. The test keeps its real status and result; nothing is hidden.
- **Overview**: "2 tests are in quarantine and not counted." with a link to that filter. Quarantined failures also stay in the
  "Needs your attention" list, labelled.

## What quarantine changes

A quarantined test still runs, still stores its results and is still shown everywhere. It only stops **gating**. One definition
is used by every place below (`quarantineGate` in `src/platform/quarantine-store.ts`; the pure rules in
`src/engine/quarantine/rules.ts`). For tests that are not quarantined nothing changes: no new field, no new word, same numbers
(tests compare the outputs before and after).

| Where | What changes |
| --- | --- |
| Cancelled runs | What a cancelled run recorded is left out of the "unreliable" and quarantine-suggestion statistics: half a run says nothing about how reliable a test is. |
| Run summary, trends | The real counts stay (`total`, `validated`, `failed`, `needsReview`). The pass rate is computed without quarantined tests, and the summary gains `quarantined: { tests, passed, failed, needsReview }` (only when there are some). Each affected result carries `q: true`. |
| Run diff, alerts (`run_failed`, `regression`, `recovered`, `flaky`) | Quarantined tests are not failing, newly failing, recovered or flaky. A test that was quarantined and fails after the quarantine ends is "newly failing". Messages say "(2 quarantined tests ignored)"; webhook payloads gain `run.quarantined`. |
| Readiness and the fleet dashboard | Quarantined failures, findings and unreliability do not make a project `needs-attention` or `blocked`. One information reason is added last ("2 quarantined tests are not counted", code `quarantined-tests`) and the project carries `quarantine: { count, tests }` so the list is visible. |
| Runbooks | `run` steps pass when the only failures are quarantined, and `passRate`, `noFailures` and `readiness` checks ignore them and say how many (`"100% passed (2 of 2) (1 quarantined test ignored)"`). `noHighSeverity` and `noApiBreakingChange` are not softened. |
| Release snapshot and sign-off | The automated snapshot records `quarantine`. Sign-off blocking rules follow the readiness (so quarantined failures do not block), a warning says how many were not counted, and the release page, the signed release and the printed report list them with their reasons. |
| `ai-test` CLI | The exit code ignores quarantined failures. The JSON report adds `quarantine` to each such test and `summary.quarantined`. JUnit marks them `<skipped message="quarantined: reason"/>` (also in the platform's own JUnit download). SARIF keeps them as `note` results with `(quarantined: reason)` and `properties.quarantined`. The console, Markdown and HTML reports list them under "Quarantined, not counted". `--env` runs read the project's quarantine too. |
| Deploy trigger status | `passed` ignores quarantined failures; they are listed under `quarantined` and out of `failures`; the pass rate leaves them out; `message` says "Passed (1 quarantined test ignored)". |

## Who can be quarantined

**Eligible** means: the platform's flaky detection flags the test (it passed on an immediate re-run, or the results of its current
script flip at least twice within its last 20 runs) **and** it is not a check-family test **and** it did not fail every one of its
last 5 runs. The reason is given in plain words when a quarantine is refused (HTTP 409); there is no override.

- **Never**: security, page-health, accessibility, API-contract, access-control, input-handling, page-speed and AI-judgement checks,
  tests of type security/accessibility/health/performance/input/vision, tests tagged compliance, and any test whose latest failure
  is a finding of one of those families. These failures are findings about the application, not unreliability.
- **Never**: a consistent failure (failed on each of the last 5 runs). That is a defect or a broken test.
- A quarantine whose test later becomes one of those cases stops gating at the next read ("It counts again") even though the
  entry is still there. A person can release it.

## Expiry and release

- An entry lasts 14 days by default, at most 60 (also after reviews). It expires **at read time** (every reader treats an entry
  past its end as over) and the scheduler's tick records it (`status: expired`, a history row). There is no background-only logic.
- **Release** ends it early (`POST …/release`). A **review** (`POST …/review`) records that someone looked again and may move the
  end later, never beyond 60 days after the start and never earlier.
- After **10 passing runs in a row since the quarantine began** the page says "Passed its last 10 runs. Stable again: release it
  from quarantine?". It is only a suggestion; nothing is released automatically.

## History

Every quarantine, release, expiry and review is a row in an append-only history (`quarantine_history`): the database refuses to
change a row, and there is no delete in the code. It keeps who, when, the reason and the evidence. Deleting a project removes its
history with it.

## API (all behind the API key; every lookup is by project and id)

| | |
| --- | --- |
| `GET /api/projects/:id/quarantine` | Active entries (with days left, whether they still gate, the release hint), recently ended ones, suggestions, limits. |
| `GET /api/projects/:id/quarantine/suggestions` | Flaky tests that may be quarantined, with the evidence and a suggested reason. |
| `POST /api/projects/:id/quarantine` | `{ testId, reason?, days?, by, suggested? }`. 201 with the entry; 409 with the reason when refused or already quarantined. Without a reason the automatic one is used (`source: suggested`). |
| `POST /api/projects/:id/quarantine/:qid/release` | `{ by, note? }` |
| `POST /api/projects/:id/quarantine/:qid/review` | `{ by, extendDays?, note? }` |
| `GET /api/projects/:id/quarantine/history?testId=` | Newest first. |
| `GET /api/tests/:id/quarantine` | One test: its entry, whether it may be quarantined and why, its last ended entry, its history. |

The test list (`GET /api/projects/:id/tests`) and the test page answer gain `quarantine: { reason, since, expiresAt }`, only while a
quarantine is in force.

## Limits

- Per-run summaries record what was in force when the run finished; readiness, the dashboard, trigger status, the release
  snapshot, the CLI and JUnit read the quarantine as it is **now**.
- A test is judged flaky from the executions of its current script (the same detection as the Unreliable tests card); editing or
  repairing a test starts a fresh history.
- Quarantine is by test, not by project or by tag, and has no user accounts: names are free text (80 characters).
- Fresh analyses create tests with new ids, so quarantine matters for tests that are re-run (validations, schedules, triggers, CLI).
- Findings from a flaky functional test (for example a server error) are quarantined like any failure; check-family findings never are.

## Tests

`tests/quarantine-unit.test.ts` (browser-free, in the fast tier: families, eligibility boundaries, expiry with an injected clock,
release suggestion, the gating set, the store, CI/JUnit/runbook/readiness/sign-off pure rules), `tests/quarantine.test.ts`
(a real platform: seeded runs through every gating place, refusals, expiry, history, isolation, API key; plus a real end-to-end
run against a fixture app with a flaky endpoint through the worker, a deploy trigger, a runbook and the `ai-test` command line),
`tests/quarantine-ui.test.ts` (a browser journey with axe in light and dark and at phone width). Ports 5790 to 5792.
