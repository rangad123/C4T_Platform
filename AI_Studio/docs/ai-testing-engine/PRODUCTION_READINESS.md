# AI testing engine: production readiness

What the engine can be relied on for today, what it cannot, and what is still needed. Status labels are defined in
`FINAL_ARCHITECTURE.md`; numbers come from `BENCHMARK_RESULTS.md` and gaps are detailed in `QUALITY_GAPS.md`. The paid re-check on
build `33a3916d` decides a status where it measured the target.

## Summary

- **Finding seeded bugs: yes, on the benchmark.** The re-check build finds 12 [10–12] of 12 shop bugs and 8 [8–8] of 8 notes-app bugs
  (the ladder's final build: 11 [10–12] and 8 [8–8]). The original pipeline found 0 [0–0] and 0 [0–1]. On the practice store, 6 of 6
  seeded bugs were Confirmed in one run.
- **Clean findings: better, not there yet.** About 8 false positives per shop trial and 5 per notes trial (the ladder: 15 and 11).
  100% / 94.1% of Confirmed findings are real (target ≥ 90%, every trial ≥ 80%). But only 64.5% of real shop findings reach Confirmed
  (target ≥ 80%). A person should review every Confirmed finding before acting on it.
- **Measured on two benchmark apps and one practice store only.** No customer application and no staging application has been
  tested. The results do not support any claim of being better than other products.
- **The changes made after the re-check** (a report gate for the test's own faults, the database-check fix for real findings, account
  pages, input classes, pictures on findings, fresh-account runs) were checked offline only. Their effect on a paid trial is not
  measured.

## Readiness by area

| Area | Status | Basis |
|---|---|---|
| Detecting seeded bugs (original set) | Verified on real applications | re-check 12/12 and 8/8 (median); practice store 6/6 Confirmed (one trial) |
| Detecting seeded bugs (extension set) | Verified in benchmark | re-check 11 [10–11] of 11 |
| Each fixed-rule and calculation bug found often enough (L4, L5) | Verified in benchmark | re-check: BR-10 5/5, BS-01 4/5; every such seed at its target |
| Application understanding (screens, endpoints, rules with sources) | Verified in benchmark | U1, U2, U5, U6, U7 met |
| Workflow understanding | Partial | U3 and U4 below target in some trials |
| Exploration evidence and isolation | Partial | re-check E2 46.7% / 30.8%, E7 23.5% / 14.3% |
| False-positive rate | Partial | re-check: L6 and L7 met; E4 met on the notes app, not on the shop (8 against 6); V4 62.5% / 66.7%. Offline re-judge, not yet measured in a paid run: the report gate takes the shop median to 6 |
| Verification precision (V1) | Verified in benchmark | re-check 100% / 94.1% |
| Verification recall (V2) | Partial | re-check 64.5% / 87.0%. Offline re-judge, not yet measured in a paid run: shop 77.4% after the database-check fix |
| Verification (states, grouping, confidence, cause, report) | Verified in benchmark | V3, V5–V8, V10–V12 met; cause at the right function 93.8% / 80.0% |
| Database checks (read-only) | Verified in benchmark | L8 re-check: each database seed 5/5 through a database check. Whole-table key checks can still fail on rows other tests write at the same time |
| Change-aware testing on the pull-request benchmark | Verified in benchmark | G1–G9 met; 0 AI calls per pull request |
| Change-aware testing on a real pull request | Partial | recommends a full run, for valid reasons |
| Running a chosen agent after a deploy (AI agent projects) | Tested | a deploy token names the agent it runs; a pipeline call starts that agent's run; tests green |
| Check the fix on a finding, with its own run page | Tested | the finding is Fixed only when every attempt passes; tests green |
| Failure reasons on agent cards | Tested | the card and the Outcome tab say why a run failed; tests green |
| Reliability and security (runner auth, project isolation, job authorisation, artifact access, secret redaction, safe execution, retry, cancellation, interrupted-job recovery, cleanup, resource limits) | Tested | 11/11 items with a passing test or probe, 0 open high-severity |
| No secrets in evidence or stored tests | Verified in benchmark | evidence: 0 canary values over 7 kinds; stored tests: 0 credentials in 10/10 re-check trials |
| Spend control | Tested | an estimate before each run, limits enforced; cost per trial at list price in the re-check $2.51 [2.40–3.06] shop, $2.98 [2.57–3.17] notes |
| Cost and time of the new stages | Verified in benchmark | re-check: layers 0.79× / 1.29× cost, 1.11× / 1.24× time; verification +1.7% / +0.8% cost, +11.7% / +10.6% time |
| Speed and cost optimisation | Not implemented | no optimisation pass |
| A new user's journey from the docs | Tested | second fresh review 7 of 8 steps; after the fixes, a re-walk by the developer who made them 8 of 8, not yet by a fresh reviewer |
| Regression suites | Tested | at `33a3916d`: fast tier 411 files, 6,507 tests; browser tier 390 files, 3,763 tests; only known failures |
| Runner on real machines (Windows, macOS, Linux) | Tested | "Runner on real machines" workflow green at `33a3916d` on Windows Server 2022 and 2025, macOS 15 (Intel and Apple silicon) and Linux; hosted CI machines, not desktop Windows 11 or a signed-in Mac |

## Safe-use defaults that stay on

- **A full run is the default.** Focused pull-request runs only start when a person asks; nothing is skipped automatically. In an AI
  agent project a deploy token runs its agent; a focused run is refused there.
- **"Confirmed" needs 3 replays on fresh accounts** and high confidence. The AI's class alone never confirms a finding.
- **A reported defect whose own check is at fault is not reported** (ambiguous element, a check that cannot run or can never pass).
  The test keeps the reason.
- **Risky checks need a gate.** Data-changing tests need the data-changes gate, and risky checks (double submits, concurrency) need
  the risky-checks gate; gate-off trials made 0 risky writes.
- **Database checks are read-only.**
- **Rules start unverified.** Only a person confirms a rule; current behaviour is never a source of expected behaviour. Inferred
  workflows never reach the test writer.

## Before calling it production-ready

1. **Measure the changes made after the re-check** with one paid series (5 trials per app): E4 on the shop, V2, V4, E2, E7 and L13,
   the admin workflows (U3) and the input classes.
2. **Bring real findings to Confirmed (V2 ≥ 80% on the shop)** without letting false ones through. The replays made when a finding
   is found are refused when a test signs up with literal data; a fix for that was built but held out, because in an offline
   re-judge it also Confirmed 7 more false alarms (`QUALITY_GAPS.md` section 6).
3. **Write better checks.** The remaining false alarms and the E2 failures are AI-written expectations that also fail on the clean
   app. They cannot be told apart from defects without the clean app.
4. **Complete the evidence fields** (E7, L13): the objective on page findings, and the disagreeing layers.
5. **Run on more real applications.** At least one staging application, with Phase 5 reports, beyond the practice store; repeat the
   practice store to see stability.
6. **Have a fresh reviewer walk the new-user journey again.**
7. **Make an optimisation pass** only on measured evidence, keeping detection at the re-check level.
