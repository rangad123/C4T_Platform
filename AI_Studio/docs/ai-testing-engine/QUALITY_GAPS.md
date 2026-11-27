# AI testing engine: quality gaps

What the engine does not yet do well enough, with the measured number, the known cause and what has been done since. Numbers are from
`BENCHMARK_RESULTS.md` (shop / notes app, median over 5 trials on build `3cf5bd04`). Status labels are defined in
`FINAL_ARCHITECTURE.md`.

"Fixed later, not re-measured" means a fix is live (`7d66fc10` or `33a3916d`) but only offline checks or free runs have looked at it
since the paid measurement. Its effect is a prediction until a paid series measures it.

## 1. Too many false alarms

| Gap | Status | Number | Cause | Since |
|---|---|---|---|---|
| False positives per trial above the baseline (E4, L6) | Partial | 15 / 11 per trial against 6 / 5 (original pipeline) and 11 / 10 (exploration only) | Mostly AI-written page tests: 29 / 35 had a wrong check or observation, 21 / 3 leaned on the shared account's earlier state | Offline replay of the 226 Confirmed L4 findings: false Confirmed page findings 25 → 12, all 201 real catches kept |
| Page findings that also fail on the clean app reach "Confirmed" (V1, V4) | Partial | V1 91.7% / 85.7% (one notes trial 66.7%); V4 53.3% / 45.5% | Verification replays on the seeded app only; the failure repeats 3 of 3 times, so it looks real | The AI's class now needs supporting facts; a labelled set without replays went from 36.6% to 78.0% |
| The 12 false Confirmed page findings left after the replay | Partial | 12 | The test never reaches the state it checks, or uses a wrong locator. No general rule was found that does not need the clean app | Open |
| Documented-type negative cases fail on the clean apps (L6, L7) | Partial | API-layer false positives 5 / 3 per trial; clean-app pass 82.8% / 80% | The clean benchmark apps accept values their OpenAPI documents rule out (a number for a string) | Fixed later, not re-measured: a wrong-type case that no source says is refused is filed as an expectation issue, not a finding; the "reflected payload inside JSON" case was dropped |
| Replay isolation (E2) | Partial | 37.5% / 23.1% (target ≥ 90%) | Same page tests: they depend on earlier state | Open |
| Severity is inflated | Partial | 22 of 26 findings Critical or High in one shop trial | Not analysed | Open |

## 2. Seeded bugs still missed

| Gap | Status | Number | Cause | Since |
|---|---|---|---|---|
| BS-01 discount on the subtotal (L5) | Partial | 1 of 5 | The invariant probe applied the code to an empty cart; the bug needs 2 or more lines | Fixed later, not re-measured: the probe now builds lines from listed records first |
| BR-10 note title shown unescaped (L4) | Partial | 2 of 5 | The stored-injection page check failed correctly but was filed as a failed test | Fixed later, not re-measured: that failure now becomes a finding for review |
| BS-13 cart total before the discount | Partial | 3 of 5, never by the displayed-value check | That check never fires on this bug | Open |
| BS-17 duplicate email, through a database check (L8) | Partial | 0 of 5 that way (found 5/5 by the API check) | The duplicate case had no database check, and absence checks ran after the API assertion | Fixed later: a free run gave 5 of 5 through the database check |

## 3. Incomplete evidence

| Gap | Status | Number | Cause | Since |
|---|---|---|---|---|
| Evidence on every exploration finding (E7) | Partial | 22.2% / 13.3% complete | The goal and screenshot fields are often empty | Fixed later, not re-measured |
| Screenshots on exploration findings | Not implemented | none saved | — | Open |
| Requests and disagreeing layers on layer findings (L13) | Partial | requests 0%, layers 0% | Not stored at detection time on this build | Fixed later, not re-measured |
| Odd-input classes exercised | Partial | 0 times in all 10 L4 records | Not analysed | Open |

## 4. Understanding limits

| Gap | Status | Number | Cause |
|---|---|---|---|
| Workflows the model never holds (U3, E5) | Partial | workflow goals 88.9% / 65–67.5% | The explorer never reached the admin pages on the notes app (admin-people and admin-roles missed in all 10 trials, notes-share in 8); on the shop, cart-quantity and order-lifecycle |
| Seeded-bug rules stated (U4) | Partial | 1 / 0.75 against 0.8 | One or more trials miss a rule |
| Inferred rules that overreach | Partial | 3 of 81 inferred rules contradict the requirements (explicit rules: 0 of 444) | Each generalises one page: an unshipped order, the owner's own note, a two-field form |

## 5. Safety and budget

| Gap | Status | Number | Cause | Since |
|---|---|---|---|---|
| A credential inside a stored test (L12) | Partial | 1 of 10 trials | An AI-written "wrong password" was built from the real one | Fixed later, not re-measured: an AI-written value that holds a secret is replaced before the test is stored |
| Token budget overshoot (E6) | Partial | 7 of 10 trials 0.05–0.34% over | The budget is checked after a call, so the last call can overshoot | Open |

## 6. Measurement gaps

- **No paid trial has measured the post-ladder fixes.** The expected effects (BR-10 about 4 of 5, BS-01 at least 4 of 5, API false
  positives 0–1 per trial) are predictions, not results.
- **AI calls per check (L10)** were not countable on the measured build; a tag was added later.
- **Speed and cost (Phase 7 Q5).** Only cost and time per rung are measured; no optimisation pass was made.
- **Costs are list prices.** Cached input is charged as full input in the usage rows.
- **One real application.** The practice store result is one trial per build. No customer application has been tested, and no
  staging application has been named for it.
- **The real pull request** still recommends a full run, for valid reasons: 12 tests failed their latest run and 26 tests' reach is
  unknown. Offline, once creation records test versions, it would focus 72 of 261 tests; not re-run live.

## 7. New-user journey

A fresh reviewer following the docs on the practice store got stuck at 3 of 8 steps: findings, the quality card and pull-request
results could not be reached from the workspace. Those were fixed later and have not been reviewed again (status: Partial).
