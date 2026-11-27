# AI testing engine: benchmark results

Measured results of the AI testing engine on the seeded-defect benchmark (`BENCHMARK_METHODOLOGY.md`). Status labels are defined in
`FINAL_ARCHITECTURE.md`. No number here is an estimate unless it says so.

## How it was measured

- **Apps.** BenchShop (12 original seeded bugs, 8 extension) and BenchNotes (8 original, 3 extension), both in `examples/`.
- **Ladder.** One harness, five configurations ("rungs"), each the engine as it was at the end of a phase:
  L0 the original pipeline, L1 with application understanding (Phase 2), L2 with exploration (Phase 3), L3 with checks across layers
  (Phase 4), L4 with verification and change-aware testing (Phases 5 and 6, build `3cf5bd04`).
- **Trials.** 5 per rung per app, rung order alternated per wave: 50 trials, 50 completed, none crashed or timed out. Model
  `claude-haiku-5-5` in every trial. Each rung records a build fingerprint.
- **Reading the numbers.** Median [range] over 5 trials, shop / notes app. A difference counts only when the ranges do not overlap or
  the median gap is larger than the wider range.
- **Truth.** Each app's intended behaviour is written in its requirements document (`examples/*/requirements/requirements.md`); the
  seeded bugs break it, and U6 below is judged against it.

## 1. Detection: final build against the original

| App | L0 original | L4 final | Verdict |
|---|---|---|---|
| BenchShop (of 12) | 0 [0–0] | **11 [10–12]** | better: L4 minimum above L0 maximum |
| BenchNotes (of 8) | 0 [0–1] | **8 [8–8]** | better |

## 2. Ten metrics per rung

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
undercounts L0–L3, so it is not used. L4 shop against L3 shop (10–12 against 8–10) is not a measurable difference.

## 3. Results per target

### Application understanding (Phase 2 targets U1–U7)

Measured in the Phase 2 understanding series (5 trials per app); U6 on the stored rules of the 10 L4 trials.

| Target | Status | Result |
|---|---|---|
| U1 screens found ≥ 0.9 | Verified in benchmark | 1 / 1 |
| U2 documented endpoints in the model | Verified in benchmark | 1 / 1, 0 extra |
| U3 workflow recall (target 1 with full input) | Partial | URL input 1 / 1; full input 1 [0.778–1] / 1 [0.875–1] |
| U3 workflow precision ≥ 0.8 | Verified in benchmark | 0.889 / 0.923 |
| U4 seeded-bug rules stated ≥ 0.8 | Partial | 1 [0.75–1] / 0.75 [0.75–1] |
| U5 every rule has its source; none auto-confirmed | Verified in benchmark | 100%; 0; 0 |
| U6 explicit rules contradicting their source ≤ 5% | Verified in benchmark | 0 of 444 (shop 0/236, notes 0/208), each rule reviewed by hand against the requirements document; inferred rules (reported only): 3 of 81 (3.7%) |
| U7 re-read changes only what changed; decisions kept | Verified in benchmark | 5/5 on both apps |

### Exploration (Phase 3 targets E1–E9, on L4)

| Target | Status | Result |
|---|---|---|
| E1 capture ≥ 80% | Verified in benchmark | 89.5% [69.2–100] / 93.3% [78.6–100] |
| E2 replay isolation ≥ 90% | Partial | 37.5% [22.2–41.2] / 23.1% [6.7–35.7] |
| E3 shop detection ≥ 5 of 12, above the baseline | Verified in benchmark | 11 [10–12]; L2 alone 3 [2–4] would not meet it |
| E4 false positives ≤ baseline | Partial | 15 against 6 / 11 against 5 |
| E5 a goal for every stated rule and workflow | Partial | rules 100%; workflows 88.9% / 65–67.5%; 4 of 19 trials meet it (offline re-score after a later fix) |
| E6 every session stops for a reason, none over budget | Partial | reason 10/10; 7 of 10 ran 0.05–0.34% over the token budget |
| E7 evidence complete on every finding | Partial | 22.2% [19.2–42.1] / 13.3% [7.1–20] |
| E8 cost ≤ 2× baseline | Verified in benchmark | met in the Phase 3 series |
| E9 coverage record | Verified in benchmark | 10/10 records with every field; odd-input classes exercised 0 times |

### Checks across layers (Phase 4 targets L1–L13; L2 is the baseline, L4 the candidate)

| Target | Status | Result |
|---|---|---|
| L1 shop ≥ 10 of 12, above baseline | Verified in benchmark | 11 [10–12] against 3 [2–4] |
| L2 notes ≥ 7 of 8, above baseline | Verified in benchmark | 8 [8–8] against 2 [0–2] |
| L3 extension bugs ≥ 9 of 11 | Verified in benchmark | 10 [9–11] |
| L4 each fixed-rule bug ≥ 4 of 5 | Partial | all 5/5 except BS-05 4/5 and BR-10 2/5 |
| L5 each calculation bug ≥ 3 of 5 | Partial | BS-02, BS-11, BS-14 5/5, BS-13 3/5, BS-01 1/5 |
| L6 false positives ≤ baseline + 2 | Partial | shop 15 against 11 + 2; notes 11 against 10 + 2; API-layer 5 [4–5] / 3 [3–3] |
| L7 layer findings pass on the clean app ≥ 90% | Partial | 82.8% / 80% |
| L8 database bugs caught through a database check ≥ 4 of 5 | Partial | BS-06, BS-18, BR-11 5/5; BS-17 0/5 that way (found 5/5 by the API check first). BS-12 was later taken out of this target by decision |
| L9 request caps kept; no risky write without the gate | Verified in benchmark | caps kept; gate-off trials 0 risky writes |
| L10 cost ≤ 1.3×, time ≤ 1.4× | Verified in benchmark | cost 0.96× / 1.24×, time 1.27× / 1.27×; AI calls per check not countable on this build |
| L11 every layer listed in every trial | Verified in benchmark | 10/10 |
| L12 no credentials in stored tests | Partial | 1 of 10 trials |
| L13 full evidence on every finding | Partial | action 100%, observed 100%, requests 0%, layers 0% |

### Verification (Phase 5 targets V1–V12, on L4)

| Target | Status | Result |
|---|---|---|
| V1 Confirmed are real ≥ 90% (each trial ≥ 80%) | Partial | 91.7% [84.6–95.8] / 85.7% [66.7–92.9] |
| V2 real bugs reach Confirmed ≥ 80% | Partial | 78.1% [71.0–82.8] / 80.0% [72.7–89.5] |
| V3 every finding in a named state with a reason | Verified in benchmark | 100% |
| V4 false alarms classed "not an app bug" ≥ 80% | Partial | 53.3% / 45.5%; on a labelled set without replays 78.0% after a later fix |
| V5 duplicates grouped, never mixed | Verified in benchmark | 0 mixed, 1 group per bug |
| V6 Confirmed only at high confidence | Verified in benchmark | 0 / 0 |
| V7 cause at the right function ≥ 60%, none invented | Verified in benchmark | 86.4% / 75.0%, 0 invented |
| V8 13-field report on every Confirmed | Verified in benchmark | 100% |
| V9 no secret test values in evidence | Tested | 0 canary values, 7 kinds |
| V10 fresh reviewer reproduces ≥ 8 of 10 | Verified in benchmark | 10 of 10 (8 from the report alone) |
| V11 added cost ≤ +15%, time ≤ +30% | Verified in benchmark | +1.5% / +1.0%; +11.7% / +10.3% |
| V12 no detection lost against L3 | Verified in benchmark | 11 against 10 / 8 against 8 |

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

## 4. Misses and false positives on L4

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

The fixes made after the ladder for BS-01, BR-10, the credential case and evidence were checked offline only. An offline replay of the
226 Confirmed L4 findings with those fixes took the false Confirmed page findings from 25 to 12, and all 201 real catches stayed
Confirmed. No paid trial has measured them yet.

## 5. Beyond the benchmark: the practice store

One full run on a separate practice web store, run locally with all 6 of its seeded bugs switched on (one trial, a build of 26 Nov
before the live one):

| Result | Value |
|---|---|
| Tests created | 261 (226 validated) |
| Findings | 18: 10 Confirmed, 3 Reproduced, 4 Needs review, 1 Unconfirmed |
| Seeded bugs Confirmed | 6 of 6 |
| Confirmed findings that were real | 8 of 10 |
| Layers used | page 86 tests, API 175, stored data 14, database 5 tests with 40 checks; 8 invariants proposed and kept |

One trial shows direction, not stability. No customer application has been tested. The engine is not compared with any other product
here, and these results do not support such a comparison.
