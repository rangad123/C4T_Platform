# AI testing engine: production readiness

What the engine can be relied on for today, what it cannot, and what is still needed. Status labels are defined in
`FINAL_ARCHITECTURE.md`; numbers come from `BENCHMARK_RESULTS.md` and gaps are detailed in `QUALITY_GAPS.md`.

## Summary

- **Finding seeded bugs: yes, on the benchmark.** The final build finds 11 [10–12] of 12 shop bugs and 8 [8–8] of 8 notes-app bugs.
  The original pipeline found 0 [0–0] and 0 [0–1]. On the practice store, 6 of 6 seeded bugs were Confirmed in one run.
- **Clean findings: not yet.** About 15 false positives per shop trial and 11 per notes trial. 91.7% / 85.7% of Confirmed findings are
  real (target ≥ 90%, every trial ≥ 80%). A person should review every Confirmed finding before acting on it.
- **Measured on two benchmark apps and one practice store only.** No customer application and no staging application has been
  tested. The results do not support any claim of being better than other products.
- **The fixes made after the benchmark** (false Confirmed page findings, the two lost seeds, the credential case, evidence) were
  checked offline or in free runs only. Their effect on a paid trial is not measured.

## Readiness by area

| Area | Status | Basis |
|---|---|---|
| Detecting seeded bugs (original set) | Verified on real applications | benchmark 11/12 and 8/8; practice store 6/6 Confirmed (one trial) |
| Detecting seeded bugs (extension set) | Verified in benchmark | 10 [9–11] of 11 |
| Application understanding (screens, endpoints, rules with sources) | Verified in benchmark | U1, U2, U5, U6, U7 met |
| Workflow understanding | Partial | U3 and U4 below target in some trials |
| Exploration evidence and isolation | Partial | E2 37.5% / 23.1%, E7 22% / 13% |
| False-positive rate | Partial | E4, L6, L7 and V4 not met |
| Verification (states, grouping, confidence, cause, report) | Verified in benchmark | V3, V5–V8, V10–V12 met |
| Verification precision and recall | Partial | V1 85.7% on the notes app, V2 78.1% on the shop |
| Change-aware testing on the pull-request benchmark | Verified in benchmark | G1–G9 met; 0 AI calls per pull request |
| Change-aware testing on a real pull request | Partial | recommends a full run, for valid reasons |
| Reliability and security (runner auth, project isolation, job authorisation, artifact access, secret redaction, safe execution, retry, cancellation, interrupted-job recovery, cleanup, resource limits) | Tested | 11/11 items with a passing test or probe, 0 open high-severity |
| No secrets in evidence or stored tests | Partial | evidence: 0 canary values over 7 kinds; stored tests: 1 of 10 trials held a password variant (fixed later, not re-measured) |
| Spend control | Tested | an estimate before each run, limits enforced; cost per trial at list price $2.62–3.30 shop, $2.13–3.01 notes |
| Cost and time of the new stages | Verified in benchmark | layers 0.96× / 1.24× cost, 1.27× time; verification +1.5% / +1.0% cost, +11.7% / +10.3% time |
| Speed and cost optimisation | Not implemented | no optimisation pass |
| A new user's journey from the docs | Partial | 3 of 8 steps stuck in a fresh review; fixed later, not re-reviewed |
| Regression suites | Tested | at `33a3916d`: fast tier 411 files, 6,507 tests; browser tier 390 files, 3,763 tests; only known failures |
| Runner on real machines (Windows, macOS, Linux) | Tested | "Runner on real machines" workflow green at `33a3916d` on Windows Server 2022 and 2025, macOS 15 (Intel and Apple silicon) and Linux; hosted CI machines, not desktop Windows 11 or a signed-in Mac |

## Safe-use defaults that stay on

- **A full run is the default.** Focused pull-request runs only start when a person asks; nothing is skipped automatically.
- **"Confirmed" needs 3 replays on fresh accounts** and high confidence. The AI's class alone never confirms a finding.
- **Risky checks need a gate.** Data-changing tests need the data-changes gate, and risky checks (double submits, concurrency) need
  the risky-checks gate; gate-off trials made 0 risky writes.
- **Database checks are read-only.**
- **Rules start unverified.** Only a person confirms a rule; current behaviour is never a source of expected behaviour.

## Before calling it production-ready

1. **Measure the post-benchmark fixes** with one paid confirmation series (5 trials per app), and check false positives (E4, L6),
   V1, V2, V4, BR-10, BS-01, L12 and L13 against their targets.
2. **Bring false positives to the baseline or below.** The remaining false Confirmed page findings (12 in an offline replay) fail on
   the clean app; verification needs that signal.
3. **Run on more real applications.** At least one staging application, with Phase 5 reports, beyond the practice store; repeat the
   practice store to see stability.
4. **Save screenshots on exploration findings** and complete the evidence fields (E7, L13).
5. **Review the new-user journey again** after its fixes.
6. **Make an optimisation pass** only on measured evidence, keeping detection at the L4 level.
