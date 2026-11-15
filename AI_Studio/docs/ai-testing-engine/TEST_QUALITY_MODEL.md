# Test-quality model

How AI Studio scores the quality of a generated test (testing-engine Phase 1). Code: `src/eval/quality/score.ts`; tests:
`tests/test-quality-unit.test.ts`.

## Principles

- **Quality is not detection.** A well-built test can miss every defect, and a weak one can find one by luck. Defect detection is measured
  only by the seeded-defect benchmark (`BENCHMARK_METHODOLOGY.md`). A high quality score is never presented as proof of bug-finding ability.
- **Every score is computed by code** from stored evidence: the test's steps and links, its runs, its deliberate-fault result and the
  application intelligence model. No model produces a score.
- **"Not measurable" instead of a guess.** When the evidence a dimension needs is missing, the dimension says so and why (score `null`).
  Most tests generated before Phase 2 cannot be scored on expected-result reliability, because their expectations carry no source.
- **Each dimension returns** its score (0 to 1), the method in one line, and the evidence it used (step numbers, rule and requirement
  refs, counts), so a reader can check it.
- Five separate questions are kept apart: test quality (this document), application coverage (the coverage dimensions below), defect
  detection (benchmark), finding accuracy (benchmark precision), execution reliability (stability below and the benchmark's flaky counts).

## Dimensions

Per test: 1, 2, 3, 7, 8, 9, 10. Per suite: 4, 5, 6, and suite-level versions of 7 and 8.

| # | Dimension | Definition | Method | Not measurable when |
|---|---|---|---|---|
| 1 | Requirement relevance | The test traces to stated intent | 1 if linked to an existing requirement or to a confirmed or explicit rule; 0.5 if linked only to unconfirmed inferred rules; 0 if linked to nothing (rejected rules and stale requirement refs do not count) | the project has no requirements and no rules |
| 2 | Expected-result reliability | Its expected outcomes come from a source that states intended behaviour | share of expected outcomes whose source is requirement, PRD, OpenAPI, source code, database schema, existing test or person-confirmed (or that cite a confirmed rule); inferred and observed count 0 | the outcomes carry no source |
| 3 | Assertion quality | Its final checks pin down the outcome | mean weight of the assertions after the last action (exact value, count, remembered value, ARIA structure, validation message 1.0; URL pattern 0.8; contains-text 0.7; presence 0.3; "status below 500" 0.1; a content check with no expected value counts as presence); 0 without one. With a deliberate-fault result, averaged with the share of faults caught | never (a test without assertions scores 0) |
| 4 | Workflow coverage (suite) | The suite reaches the application's workflows | workflows of the model reached by at least one test / all workflows | the model has no workflows |
| 5 | Business-rule coverage (suite) | The suite checks the trusted rules | confirmed or explicit (not rejected) rules referenced by at least one test / all such rules | no trusted rules |
| 6 | State-transition coverage (suite) | The suite checks the state rules | trusted transition rules referenced / all trusted transition rules | no trusted transition rules |
| 7 | Input diversity | It types more than one kind of value | distinct input classes among typed values / 4, capped at 1 (classes: empty, whitespace, zero, negative, decimal, large number, long, special characters, unicode, email, ordinary); suite: distinct classes / 11 | the test types nothing |
| 8 | Boundary and negative coverage | It probes an edge or a rejection | 1 if its type is negative, boundary or validation, or it types a boundary class, or it asserts a validation message or a 4xx answer; suite: share of tests with inputs (or API tests) that do | (suite) no test types anything |
| 9 | Reproducibility | It can run alone, the same way each time | share of three conditions: opens its own start (page, request or app), no fixed pause, uses only values it sets (its data, extracted or remembered values, `{{unique}}`) | never |
| 10 | Execution stability | It gives the same verdict when nothing changed | runs agreeing with the most common verdict / runs that ran, over at least 3 | fewer than 3 runs ran |

## Limits

- Weights in dimension 3 are a fixed, documented table, not a measurement; the deliberate-fault result is the empirical part, and it only
  injects blunt faults today (see `TEST_GENERATION_QUALITY_AUDIT.md` §4.7).
- Links to rules and workflows come from the intelligence model, which the generation pipeline does not fill yet (Phase 2); until then
  dimensions 1, 2, 4, 5 and 6 are mostly "not measurable".
- The input classes are lexical; they say what was typed, not whether it was the right boundary for that field.
