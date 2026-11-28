# AI testing engine: quality gaps

What the engine does not yet do well enough, with the measured number, the known cause and what has been done since. Numbers are from
`BENCHMARK_RESULTS.md` (shop / notes app, median over 5 trials). The paid re-check on build `33a3916d` decides the status where it
measured the target; the ladder on `3cf5bd04` is given as history. Status labels are defined in `FINAL_ARCHITECTURE.md`.

"Offline re-judge, not yet measured in a paid run" marks a change made after the re-check that only offline checks have looked at:
stored trial records re-judged or replayed with no AI calls. Its effect on a paid trial is a prediction until a paid series measures
it.

## 1. False alarms

| Gap | Status | Number (paid) | Cause | Since (offline re-judge, not yet measured in a paid run) |
|---|---|---|---|---|
| False positives per trial above the baseline on the shop (E4) | Partial | re-check 8 / 5 against 6 / 5 (ladder 15 / 11). L6 (≤ baseline + 2) is met | Page tests written by the AI; the API negative cases are gone | A report gate holds back a reported defect whose own captured check shows the test is at fault (an ambiguous element, a check that could not run or can never pass, a label read as a value). Total 74 → 48 over the 10 re-check trials, median 8 → 6 / 5 → 4; 0 true positives held back over 59 stored trials |
| 43–48 false alarms that come from test writing | Partial | of the 66 false positives in the first 9 re-check trials, 43 remain after the gate; 48 over all 10 | Hand-classified, approximate: about 22 hit a real seed on the seeded app but are also wrong on the clean one (an amount computed from the seeded subtotal, "$0.00" where the page shows "Free"); about 15 use wording the writer invented or never reach the state they check; about 5 lean on the shared account's earlier state; 3 are on the validation path | Nothing on the seeded side tells them apart from real findings. A rule "unstated text is not reported" cut them to 27 but lost seeds (BS-10, BR-07), so it was rejected. The fix belongs in test writing: check a value only against what the requirement states |
| Replay on a clean app (E2) | Partial | re-check 46.7% [32–53.8] / 30.8% [16.7–40] (target ≥ 90%) | The replay set-up is right: every test runs alone on a freshly started app. What fails on the clean app is the AI-written checks themselves: wording or role taken from the requirement (31), a wrong expected value (17), text that matches 2 elements (15) | Scoring leaves out tests the engine held back as not findings (the ladder re-scored: 38.5% / 30.0%). Fresh-account runs and row text checks removed 5 false positives in an offline replay of 145 findings; E2 moved within noise |
| False alarms classed "not an app bug" (V4) | Partial | re-check 62.5% / 66.7% (ladder 53.3% / 45.5%); a labelled set without replays 78.0% | Without the clean app, a wrong expectation fails at its check exactly as a defect does. A prompt-only change was rejected, and 78% is the ceiling for the labelled set without replays (a decision of 2026-11-27) | Rough re-count after the report gate 58% → 56%: most held-back false positives were already classed as automation |
| Severity is inflated | Partial | 22 of 26 findings Critical or High in one shop trial | Not analysed | Open |

## 2. Real findings left short of Confirmed (V2)

| Gap | Status | Number (paid) | Cause | Since (offline re-judge, not yet measured in a paid run) |
|---|---|---|---|---|
| Real shop findings reaching Confirmed | Partial | re-check 64.5% [61.3–68.8] / 87.0% (ladder 78.1% / 80.0%) | Two causes, A and B below | A fixed: shop 77.4% [74.2–79.3], still below 80% |
| Cause A: a database check with no source failed first | Tested | 17 true database-layer findings stopped at Reproduced at low confidence | The finding kept no expectation, so its confidence stayed low | Verification reads the expectation from the attempts it judges, and unsourced key checks run last again. Seeded Confirmed 201/201 (ladder) and 193/193 (re-check) kept; Confirmed false positives unchanged |
| Cause B: replays refused at their own sign-up | Partial | page findings at "Needs manual review" 11 → 25 between ladder and re-check | Tests that sign up with literal generated data. The two replays made when a finding is found run without a data reset, so the sign-up is refused and the finding is marked state-dependent. Verification resets the data and reproduces it 3 of 3 | Open; see section 6. The rule is kept: the same pattern also covers 16 false positives in the re-check (27 in the ladder) |

## 3. Seeded bugs still missed

| Gap | Status | Number (paid) | Cause |
|---|---|---|---|
| Re-check misses | Partial | 5 in 50 seed-trials, shop only: BS-01, BS-05, BS-11, BS-13 once each | A page sighting classed as a wrong expectation; an own-steps replay that stopped; a rule no test exercised; a rule that never reached the planner. L4 and L5 are met |
| Displayed-value check on BS-13 | Partial | ladder: never fired; BS-13 found 3/5 by AI-written page tests; re-check BS-13 4/5, which check found it was not analysed | That check never fired on this bug in the ladder |

## 4. Incomplete evidence

| Gap | Status | Number (paid) | Cause | Since (offline re-judge, not yet measured in a paid run) |
|---|---|---|---|---|
| Evidence on every exploration finding (E7) | Partial | re-check 23.5% / 14.3% (ladder 22.2% / 13.3%) | The missing field is almost always the objective (page findings with no objective); on the notes app also the picture | Exploration findings keep a picture where a replay can take one (browser test); held tests leave the denominator. Not re-scored. Execution findings from verification still list no picture in the finding row |
| Requests and disagreeing layers on layer findings (L13) | Partial | re-check requests 91% / 51%, disagreeing layers 8% / 0%, read-back or database values 44% / 18% (ladder requests 0%, layers 0%) | The layer comparison is rarely recorded | Open |
| Odd-input classes exercised | Partial | 0 times in all 10 ladder records | Constraint goals ranked lowest and were cut by the goal cap or never reached | Inside the cap in 8/10 stored trials (was 5/10); whether they type the classes needs a paid run |

## 5. Understanding limits

| Gap | Status | Number | Cause | Since |
|---|---|---|---|---|
| Admin workflows on the notes app (U3) | Partial | admin-people and admin-roles missed in all 10 ladder trials | The project signs in as a user; the admin pages were reached only by the admin's access survey, which the model did not keep | Offline re-judge, not yet measured in a paid run: the People page is in the model in 5/5 stored trials, and 16 pursuits start there signed in as admin |
| Inferred workflows get no goal in a live run (E5) | Partial | the earlier 88.9% / 65–67.5% workflow figures were offline only | Inferred workflows stay out of the test writer, so a guess never reaches it as a stated rule (a decision of 2026-11-28) | Kept by decision |
| Seeded-bug rules stated (U4) | Partial | 1 / 0.75 against 0.8 | One or more trials miss a rule | Open |
| Inferred rules that overreach | Partial | 3 of 81 inferred rules contradict the requirements (explicit rules: 0 of 444) | Each generalises one page: an unshipped order, the owner's own note, a two-field form | Open |

## 6. Database checks and replays

| Gap | Status | Number | Cause | Since |
|---|---|---|---|---|
| Whole-table key checks under concurrency | Partial | in the re-check, a profile test saw 41 → 45 rows without a parent while other tests placed orders | The orphan and duplicate checks from schema keys count the whole table, so rows other tests write at the same time count against this test | They now run last, so they no longer hide a sourced check, but they can still turn a passing test into a database finding. The fix is a per-test baseline or running data-changing tests one at a time; both are larger changes |
| A fresh run tag in the replays (held out) | Not implemented | offline: 8 of 11 real findings reproduce instead of 0–1, but 22 of 35 false positives reproduce too | Cause B in section 2 | Built and held out (`a69dd15c`, a decision of 2026-11-28). In an offline re-judge of the ladder, V2 rises about 3 points but Confirmed false alarms go from 13 to 20, and the notes per-finding V1 median falls below 90%. Neither the report gate nor the verification class stops the 7 new Confirmed false alarms. It is revisited only with a check of the test's own expectation that stops them |

## 7. Safety and budget

| Gap | Status | Number (paid) | Cause | Since |
|---|---|---|---|---|
| Token budget overshoot (E6) | Partial | re-check: shop 0/5, notes 5/5 over by 0.03–0.29% | The budget was checked after a call, so the last call could overshoot | Offline re-judge, not yet measured in a paid run: the loop keeps the largest call so far in reserve (unit tests). A call larger than any before it can still overshoot |

A credential inside a stored test (L12) is no longer a gap: 0 in 10/10 re-check trials.

## 8. Measurement gaps

- **The changes after the re-check have not been measured in a paid run.** Their numbers above are offline re-judges.
- **AI calls per check (L10)** were not counted in the re-check either.
- **Speed and cost (Phase 7 Q5).** Only cost and time per trial are measured; no optimisation pass was made.
- **Costs are list prices.** Cached input is charged as full input in the usage rows.
- **One real application.** The practice store result is one trial on a build before the re-check. No customer application has been
  tested, and no staging application has been named for it.
- **The real pull request** still recommends a full run, for valid reasons: 12 tests failed their latest run and 26 tests' reach is
  unknown. Offline, once creation records test versions, it would focus 72 of 261 tests; not re-run live.

## 9. New-user journey

A first fresh review on the practice store got stuck at 3 of 8 steps. A second fresh review on `33a3916d` completed 7 of 8: step 8
(regression) was stuck, because in an AI agent project neither the pull-request buttons nor a deploy token could run anything, and no
"Check the fix" button existed. After those were built, the developer who built them re-walked steps 7 and 8 the same way and completed 8 of 8. That
re-walk was not done by a fresh reviewer (status: Tested). Left open: "Came back after a fix" was not shown live (covered by tests);
five agents have no report download.
