# AI testing engine: benchmark results

Measured results of the AI testing engine on the seeded-defect benchmark (`BENCHMARK_METHODOLOGY.md`). Status labels are defined in
`FINAL_ARCHITECTURE.md`. No number here is an estimate unless it says so.

Two paid series were run. The **ladder** (50 trials, build `3cf5bd04`) compared five configurations. The **re-check** (10 trials,
build `33a3916d`) ran the ladder's top configuration again after the fixes made since. For every target the re-check measured, its
number decides the status, and the ladder's number is kept as history.

Changes made after the re-check were checked offline only. Their numbers are marked **offline re-judge, not yet measured in a paid
run**. They do not decide a status, unless a row says that the target is one the stored data can decide.

## How it was measured

- **Apps.** BenchShop (12 original seeded bugs, 8 extension) and BenchNotes (8 original, 3 extension), both in `examples/`.
- **Ladder.** One harness, five configurations ("rungs"), each the engine as it was at the end of a phase:
  - L0: the original pipeline;
  - L1: with application understanding (Phase 2);
  - L2: with exploration (Phase 3);
  - L3: with checks across layers (Phase 4);
  - L4: with verification and change-aware testing (Phases 5 and 6, build `3cf5bd04`).
- **Ladder trials.** 5 per rung per app, with the rung order alternated per wave. 50 trials, 50 completed, none crashed or timed out.
  Model `claude-haiku-5-5` in every trial. Each rung records a build fingerprint.
- **Re-check.** The L4 configuration with the same flags on build `33a3916d`, 5 trials per app. 10 of 10 completed, model
  `claude-haiku-5-5` only, scored with the ladder's scoring code. The benchmark apps are identical between the two builds.
- **Offline re-judge.** A later change is checked by running the changed judgement, scoring or replay code on the stored trial records
  with no AI calls. Replays run on freshly started benchmark apps. This shows direction. It does not show what the AI writes once the
  change is in.
- **Reading the numbers.** Median [range] over 5 trials, shop / notes app. A difference counts only when the ranges do not overlap or
  the median gap is larger than the wider range.
- **Truth.** Each app's intended behaviour is written in its requirements document (`examples/*/requirements/requirements.md`). The
  seeded bugs break it, and U6 below is judged against it.

## 1. Detection

| App | L0 original | L4 ladder (`3cf5bd04`) | Re-check (`33a3916d`) | Verdict |
|---|---|---|---|---|
| BenchShop (of 12) | 0 [0–0] | 11 [10–12] | **12 [10–12]** | better than L0; re-check against L4 held (ranges overlap) |
| BenchNotes (of 8) | 0 [0–1] | 8 [8–8] | **8 [8–8]** | better than L0; held |

## 2. Ten metrics per rung (ladder, history)

BenchShop:

| Metric | L0 | L1 | L2 | L3 | L4 |
|---|---|---|---|---|---|
| Confirmed (of 12) | 0 (0–0) | 0 (0–1) | 3 (2–4) | 10 (8–10) | **11 (10–12)** |
| Missed | 12 | 12 (11–12) | 9 (8–10) | 2 (2–4) | 1 (0–2) |
| False positives | 10 (5–21) | 6 (2–11) | 11 (7–15) | 19 (14–22) | 15 (13–16) |
| List precision | 0% | 0% (0–8%) | 19% (10–23%) | 51% (49–55%) | 64% (52–69%) |
| Reproduction (replays) | 63% (31–91%) | 40% (20–69%) | 81% (72–100%) | 94% (89–98%) | 94% (86–98%) |
| Mutation score | 100% (98–100%) | 98% (98–100%) | 100% (92–100%) | 100% (98–100%) | 100% (95–100%) |
| Time to first confirmed seed (min) | none [0/5] | 5.3 [1/5] | 9.9 (7.6–10.6) | 7.9 (7.1–18.4) | 7.8 (6.6–17.8) |
| Suite stability | 99% | 99% | 100% | 99% | 99% |
| Workflow coverage (harness / record) | 100% / – | 100% / – | 100% / 20% | 100% / 16% | 100% / 28% (0–43%) |
| AI cost per trial, list price | $2.67 (2.19–3.38) | $2.68 (1.95–4.07) | $3.11 (2.81–3.72) | $3.50 (2.58–4.25) | $3.02 (2.62–3.30) |
| Time (min) | 61.3 (47–81) | 63.6 (46–82) | 130.8 (120–152) | 208.8 (143–226) | 190.2 (165–200) |

BenchNotes:

| Metric | L0 | L1 | L2 | L3 | L4 |
|---|---|---|---|---|---|
| Confirmed (of 8) | 0 (0–1) | 0 (0–1) | 2 (0–2) | 8 (8–8) | **8 (8–8)** |
| Missed | 8 (7–8) | 8 (7–8) | 6 (6–8) | 0 | 0 |
| False positives | 5 (3–7) | 5 (4–9) | 10 (7–13) | 11 (9–17) | 11 (9–12) |
| List precision | 0% (0–7%) | 0% (0–9%) | 21% (12–27%) | 50% (44–63%) | 54% (46–61%) |
| Reproduction (replays) | 33% (23–53%) | 36% (33–82%) | 86% (71–94%) | 88% (82–93%) | 92% (86–95%) |
| Mutation score | 100% (94–100%) | 96% (92–100%) | 97% (96–100%) | 97% (93–100%) | 96% (92–100%) |
| Time to first confirmed seed (min) | 17.1 [1/5] | 6.8 [2/5] | 8.8 (7.7–10.5) | 14.9 (9.1–46.7) | 11.4 (7.2–15.9) |
| Suite stability | 100% | 100% | 100% | 100% | 100% |
| Workflow coverage (harness / record) | 100% / – | 100% / – | 100% / 60% | 100% / 68% | 100% / 70% (37–86%) |
| AI cost per trial, list price | $2.52 (1.86–3.38) | $2.93 (2.69–3.58) | $2.30 (1.89–2.76) | $2.63 (2.09–2.74) | $2.87 (2.13–3.01) |
| Time (min) | 52.4 (43–66) | 59.4 (48–72) | 97.2 (82–128) | 139.7 (136–163) | 137.8 (132–158) |

Cost is read from the stored AI usage rows at list price, with cached input charged as full input. The harness's own cost line
undercounts L0–L3, so it is not used. In the ladder, L4 shop against L3 shop (10–12 against 8–10) is not a measurable difference.

### Re-check against the ladder's L4

| Metric | L4 shop | Re-check shop | L4 notes | Re-check notes |
|---|---|---|---|---|
| False positives | 15 (13–16) | **8 [6–14]** | 11 (9–12) | **5 [3–9]** |
| List precision | 64.0% | 67.4% [59.3–77.5] | 54.1% | 64.7% [59.5–74.2] |
| AI cost per trial, list price | $3.02 [2.62–3.30] | **$2.51 [2.40–3.06]** | $2.87 [2.13–3.01] | $2.98 [2.57–3.17] |
| AI calls per trial | 1,314 [1,173–1,414] | 1,057 [1,020–1,232] | 1,203 [963–1,273] | 1,185 [1,068–1,262] |
| Time (min) | 190.2 [165–200] | **161.1 [160–218]** | 137.8 [132–158] | 134.6 [133–153] |
| Time to first confirmed seed (min) | 7.8 | 8.6 [6.6–11.1] | 11.4 | 8.8 [6.0–13.1] |

The lower shop cost and call count are probably real, but n = 5. The notes app is within noise.

## 3. Results per target

The "Measured" column is the paid result: the re-check where it measured the target, otherwise the ladder or the series named. The last
column lists changes made after the re-check, with their offline numbers; "—" means none.

### Application understanding (Phase 2 targets U1–U7)

Measured in the Phase 2 understanding series (5 trials per app); U6 on the stored rules of the 10 L4 trials.

| Target | Status | Measured | After later changes (offline re-judge, not yet measured in a paid run) |
|---|---|---|---|
| U1 screens found ≥ 0.9 | Verified in benchmark | 1 / 1 | — |
| U2 documented endpoints in the model | Verified in benchmark | 1 / 1, 0 extra | — |
| U3 workflow recall (target 1 with full input) | Partial | URL input 1 / 1; full input 1 [0.778–1] / 1 [0.875–1] | Pages that only a test account reached now enter the model: the notes app's People page is in the model in 5/5 stored trials (was 0/5). Whether the analysis then names its workflows needs a paid run |
| U3 workflow precision ≥ 0.8 | Verified in benchmark | 0.889 / 0.923 | — |
| U4 seeded-bug rules stated ≥ 0.8 | Partial | 1 [0.75–1] / 0.75 [0.75–1] | — |
| U5 every rule has its source; none auto-confirmed | Verified in benchmark | 100%; 0; 0 | — |
| U6 explicit rules contradicting their source ≤ 5% | Verified in benchmark | 0 of 444 (shop 0/236, notes 0/208), each rule reviewed by hand against the requirements document; inferred rules (reported only): 3 of 81 (3.7%) | — |
| U7 re-read changes only what changed; decisions kept | Verified in benchmark | 5/5 on both apps | — |

### Exploration (Phase 3 targets E1–E9)

| Target | Status | Measured | After later changes (offline re-judge, not yet measured in a paid run) |
|---|---|---|---|
| E1 capture ≥ 80% | Verified in benchmark | re-check 88.2% [81.3–89.3] / 92.9% [71.4–100] (ladder 89.5% / 93.3%) | — |
| E2 replay isolation ≥ 90% | Partial | re-check 46.7% [32–53.8] / 30.8% [16.7–40] (ladder 37.5% / 23.1%) | Scoring now leaves out tests the engine itself held back as not findings. Stored data can decide this part: the ladder re-scored is 38.5% [26.7–41.2] / 30.0% [14.3–45.5]. Tests written as a newly registered account run as one again, and row text checks read the row as its accessible name: an offline replay of 145 ladder findings removed 5 false positives, and the E2 medians moved within noise |
| E3 shop detection ≥ 5 of 12, above the baseline | Verified in benchmark | re-check 12 [10–12] (ladder 11 [10–12]); L2 alone 3 [2–4] would not meet it | — |
| E4 false positives ≤ baseline (6 / 5) | Partial | re-check 8 / 5: notes met, shop not (ladder 15 / 11) | A report gate holds back a defect whose own captured check shows the test is at fault. On the 10 re-check trials: false positives 74 → 48 in total, median 8 → 6 / 5 → 4, which would meet the target. 0 true positives held back over 59 stored trials |
| E5 a goal for every stated rule and workflow | Partial | rules 100%. The earlier workflow figures (88.9% / 65–67.5%) came from an offline scorer that also counts inferred workflows; a live run gives goals only to stated workflows, so they do not describe a live run | Inferred workflows stay out of the test writer by a decision of 2026-11-28 |
| E6 every session stops for a reason, none over budget | Partial | re-check: reason 10/10; shop 0/5 over, notes 5/5 over by 0.03–0.29% (ladder 7 of 10, 0.05–0.34%) | The loop now stops when the next call, estimated as the largest call so far, would pass the budget (unit tests). The stored trials keep only session totals, so the effect needs a paid run |
| E7 evidence complete on every finding | Partial | re-check 23.5% [14.3–26.7] / 14.3% [8.3–21.4] (ladder 22.2% / 13.3%); the missing field is almost always the objective | Exploration findings now keep a picture where a replay can take one (browser test); held tests leave the denominator. Not re-scored |
| E8 cost ≤ 2× baseline | Verified in benchmark | met in the Phase 3 series | — |
| E9 coverage record | Verified in benchmark | 10/10 records with every field (ladder); odd-input classes exercised 0 times | Constraint goals on a form a stated workflow fills now rank with that workflow: inside the goal cap in 8/10 stored trials (was 5/10), 13 constraint pursuits among those started in 7/10 (was 0). Whether they type the classes needs a paid run |

### Checks across layers (Phase 4 targets L1–L13; L2 is the baseline, L4 the candidate)

| Target | Status | Measured | After later changes (offline re-judge, not yet measured in a paid run) |
|---|---|---|---|
| L1 shop ≥ 10 of 12, above baseline | Verified in benchmark | re-check 12 [10–12] (ladder 11 [10–12] against 3 [2–4]) | — |
| L2 notes ≥ 7 of 8, above baseline | Verified in benchmark | re-check 8 [8–8] (ladder 8 [8–8] against 2 [0–2]) | — |
| L3 extension bugs ≥ 9 of 11 | Verified in benchmark | re-check 11 [10–11] (ladder 10 [9–11]) | — |
| L4 each fixed-rule bug ≥ 4 of 5 | Verified in benchmark | re-check BR-10 5/5, BS-05 4/5, every other 5/5 (ladder BR-10 2/5) | — |
| L5 each calculation bug ≥ 3 of 5 | Verified in benchmark | re-check BS-01 4/5, BS-02 5/5, BS-11 4/5, BS-13 4/5, BS-14 5/5 (ladder BS-01 1/5) | — |
| L6 false positives ≤ baseline + 2 (≤ 13 / ≤ 12) | Verified in benchmark | re-check 8 [6–14] / 5 [3–9]; API layer 0 / 0 (ladder 15 / 11; API layer 5 / 3) | See E4 |
| L7 layer findings: fail on seeded, pass on clean ≥ 90% | Verified in benchmark | re-check seeded-fail 100% / 100%; clean-pass 100% [95.7–100] / 100% [100–100] (ladder clean-pass 82.8% / 80%) | The one layer finding that failed on clean differed only in letter case. Relation checks now take a value's casing from the API document; in that shop trial clean-pass goes from 96% to 100% |
| L8 database bugs caught through a database check ≥ 4 of 5 | Verified in benchmark | re-check BS-06, BS-17, BS-18, BR-11 5/5 each through a database check (ladder BS-17 0/5). BS-12 was taken out of this target by decision | Unsourced whole-table key checks run last again. A documented 409's duplicate check carries that 409 as its source and stays before it, so BS-17 keeps its path (8/8 on the real benchmark apps, tests) |
| L9 request caps kept; no risky write without the gate | Verified in benchmark | caps kept; gate-off trials 0 risky writes | — |
| L10 cost ≤ 1.3×, time ≤ 1.4× | Verified in benchmark | re-check without verification: cost 0.79× / 1.29×, time 1.11× / 1.24× (ladder 0.96× / 1.24×, 1.27× / 1.27×); AI calls per check not counted | — |
| L11 every layer listed in every trial | Verified in benchmark | 10/10 | — |
| L12 no credentials in stored tests | Verified in benchmark | re-check 0 hits in 10/10 trials, 0 off-origin test targets (ladder 1 of 10) | — |
| L13 full evidence on every finding | Partial | re-check: action 100%, observed 100%, requests 91% / 51%, source 75% / 84%, read-back or database values 44% / 18%, disagreeing layers 8% / 0% (ladder requests 0%, layers 0%) | — |

### Verification (Phase 5 targets V1–V12)

| Target | Status | Measured | After later changes (offline re-judge, not yet measured in a paid run) |
|---|---|---|---|
| V1 Confirmed are real ≥ 90% (each trial ≥ 80%) | Verified in benchmark | re-check 100% [89.5–100] / 94.1% [86.7–100] (ladder 91.7% / 85.7%) | With the report gate, Confirmed false positives in the re-check trials 8 → 6; 193/193 seeded Confirmed findings kept |
| V2 real bugs reach Confirmed ≥ 80% | Partial | re-check 64.5% [61.3–68.8] / 87.0% [79.2–90.9] (ladder 78.1% / 80.0%) | A database check that ran first no longer leaves a real defect at low confidence: shop 64.5% → 77.4% [74.2–79.3], still below 80%; notes unchanged; Confirmed false positives unchanged in every trial |
| V3 every finding in a named state with a reason | Verified in benchmark | 100% | — |
| V4 false alarms classed "not an app bug" ≥ 80% | Partial | re-check 62.5% [12.5–71.4] / 66.7% [40–100] (ladder 53.3% / 45.5%); on a labelled set without replays 78.0% | The report gate changes the stored classes only slightly (rough re-count 58% → 56%): most of the false positives it holds back were already classed as automation |
| V5 duplicates grouped, never mixed | Verified in benchmark | re-check 0 mixed, 1 group per seed | — |
| V6 Confirmed only at high confidence | Verified in benchmark | 0 / 0 | — |
| V7 cause at the right function ≥ 60%, none invented | Verified in benchmark | re-check 93.8% [88.2–95.0] / 80.0% [76.9–81.3], 0 invented (ladder 86.4% / 75.0%) | — |
| V8 13-field report on every Confirmed | Verified in benchmark | 100% | — |
| V9 no secret test values in evidence | Tested | 0 canary values, 7 kinds | — |
| V10 fresh reviewer reproduces ≥ 8 of 10 | Verified in benchmark | 10 of 10 (8 from the report alone), on the ladder build | — |
| V11 added cost ≤ +15%, time ≤ +30% | Verified in benchmark | re-check +1.7% / +0.8%; +11.7% / +10.6% (ladder +1.5% / +1.0%; +11.7% / +10.3%) | — |
| V12 no detection lost against L3 | Verified in benchmark | ladder 11 against 10 / 8 against 8; re-check 12 / 8 | — |

### Change-aware testing (Phase 6 targets G1–G9, pull-request benchmark, 5 repeats)

| Target | Status | Result |
|---|---|---|
| G1 recall | Verified in benchmark | 100% / 100% in all 5 repeats |
| G2 focus | Verified in benchmark | 11.1% of tests, 33.3% of time |
| G3 every pick explained, no decoy picked | Verified in benchmark | 532 of 532 explained, 0 decoys |
| G4 unmapped change → full run | Verified in benchmark | both decoy and unmapped |
| G5 full suite from the pull-request view | Verified in benchmark | 36/36, 29/29 |
| G6 fixed-bug regression | Verified in benchmark | 31/31, 0 wrong |
| G7 history exact | Verified in benchmark | exact |
| G8 webhook and token security | Tested | tests green |
| G9 AI calls per pull request | Verified in benchmark | 0 |

## 4. Misses and false positives

### Re-check (status-deciding)

**Misses.** 5 seed misses in 50 seed-trials, all on the shop; the notes app had none.

| Seed | Missed in | Cause |
|---|---|---|
| BS-01 discount on the subtotal | 1 shop trial | The page sighting was classed as a wrong expectation, and the invariant probe did not fire |
| BS-05 cancel a shipped order | 1 shop trial | The test's own-steps replay stopped, as in the ladder |
| BS-11 | 1 shop trial | The rule was present, but no test saw the behaviour |
| BS-13 cart total before the discount | 1 shop trial | No rule from that requirement reached the planner |

**False positives.** Shop 6, 9, 8, 14, 8 per trial (state 25, observation 19, assumption 1); notes 5, 3, 7, 5, 9 (observation 25,
state 4). All are page tests except one stored-data finding. The API negative cases behind the ladder's L6 and L7 misses are gone.

What the remaining false positives are (offline analysis of the re-check trials; counts classified by hand are approximate):
- 64 of the 66 false positives in the first 9 trials were defects reported by the test writer that never went through the
  validator's own-fault rules. The report gate (E4 row) now holds 23 of them back.
- Of the 43 left: about 22 tests hit a real seed on the seeded app but are also wrong on the clean one; about 15 use wording the
  writer invented or never reach the state they check; about 5 lean on the shared account's earlier state; 3 are on the validation
  path.

Why shop V2 fell (offline analysis):
- **Cause A, database layer.** 17 true findings stopped at Reproduced at low confidence. A database check with no source had failed
  first and left the finding without its expectation. Fixed after the re-check (V2 row).
- **Cause B, page layer.** Page findings stopped at "Needs manual review" rose from 11 to 25. These tests sign up with literal
  generated data, so the replays made when a finding is found are refused at sign-up and mark it state-dependent. The same pattern
  also covers 16 false positives in the re-check (27 in the ladder), so the rule is kept. See `QUALITY_GAPS.md`.

### Ladder (history)

**Misses** (9 across 10 trials), each attributed to a stage and checked by hand:

| Seed | Missed in | Cause |
|---|---|---|
| BS-01 discount on the subtotal | 4 of 5 shop trials | The invariant probe applied the code to an empty cart; the bug shows only with 2 or more lines |
| BS-05 cancel a shipped order | 1 shop trial | The test's replay stopped, so it was not reported |
| BS-13 cart total before the discount | 2 shop trials | The displayed-value check never fired; found 3/5 by AI-written page tests |
| BR-10 note title shown unescaped | 3 notes trials | The stored-injection check failed correctly but was filed as a failed test, not a finding |

**False positives** (shop 13–16, notes 9–12 per trial):

| Source | Shop (5 trials) | Notes (5 trials) | What they are |
|---|---|---|---|
| Assumption | 23 | 15 | Documented-type negative cases (a number sent where the document says string) that the clean apps accept |
| State | 21 | 3 | Page tests that lean on the shared account's earlier state and fail on the clean app too |
| Observation | 29 | 35 | Page tests whose check or observation was wrong |

The fixes for BS-01, BR-10, the credential case and the API negative cases were made after the ladder. The re-check measured them
(section 3).

## 5. Beyond the benchmark: the practice store

One full run on a separate practice web store, run locally with all 6 of its seeded bugs switched on (one trial, a build of 26 Nov
before the re-check build):

| Result | Value |
|---|---|
| Tests created | 261 (226 validated) |
| Findings | 18: 10 Confirmed, 3 Reproduced, 4 Needs review, 1 Unconfirmed |
| Seeded bugs Confirmed | 6 of 6 |
| Confirmed findings that were real | 8 of 10 |
| Layers used | page 86 tests, API 175, stored data 14, database 5 tests with 40 checks; 8 invariants proposed and kept |

One trial shows direction, not stability. No customer application has been tested. The engine is not compared with any other product
here, and these results do not support such a comparison.
