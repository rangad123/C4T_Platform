# Exploring by objectives

When the AI agent explores a website, it can also work through a list of **objectives**: checks worked out from what the platform
knows about the application ([application-understanding.md](application-understanding.md)). Each objective asks one question, such as
"does the sign-up form refuse an invalid email?" or "does placing the same order twice charge once?", and says what the answer should
be and where that expectation comes from. The AI agent then tries it in a real browser, inside fixed limits, and every expected result it
checks against comes from a stated rule or requirement, never from what the application happened to do.

The result is a set of saved tests, a record of what was covered and what was left out, and, where the application did not behave as
expected, **candidate findings** for a person to review. A candidate finding is never presented as a confirmed bug.

## When it runs

- Only for websites tested by the AI agent, as part of **Explore my app**. There is no separate button, wizard or tab.
- Only when the application has been analysed at least once. Without an analysis the exploration runs as before, and its activity says:
  "Exploring by objectives needs an analysed model of the application, and there is none yet, so this exploration ran without
  objectives."
- On every exploration level (Thorough, Deep, Everything) of an agent project, while the project's **Explore by objectives** switch is
  on. It sits in Settings → General, beside "How much to explore", and is on for every agent project until an owner turns it off
  (a project that never saved it counts as on). Exploring by objectives takes longer and uses more AI. Only people who may change the
  project's settings can change the switch; others see it greyed out.
- On a runner that supports it. An older runner runs the exploration as before, and the job says in one sentence that the runner is
  too old to explore by objectives and needs downloading again.
- It runs after the planned tests are written, in the same job, on the starter's own runner and with the starter's AI key, like the
  rest of the exploration ([explore-on-runner.md](explore-on-runner.md)).

## Where objectives come from

Objectives are worked out without AI, from the latest analysis. The same analysis always gives the same objectives, and an objective
found twice is kept once.

| Kind | One for each | Expected result taken from |
|---|---|---|
| Rule | rule that a source states or a person confirmed, and whose expected result says something checkable | the rule's own expected result |
| Workflow | workflow that a source states or a person confirmed | the workflow's stated outcome, or else "every step completes" |
| Form field | form field whose page declares a limit (required, a typed value such as an email, a minimum or maximum, a length, a pattern, a list of options) | the field's declared limits |
| State change | change of state (for example an order going from "placed" to "shipped") that a source states | the stated change |
| Coverage gap | change of state that the application showed, or the AI guessed, but no source states | nothing: no check is run |

Rules that are only inferred and wait for a person, rejected rules, and rules whose evidence is gone are not used. A coverage gap is
listed so someone can say which document answers it; it never becomes a test, because nothing states what should happen.

Text from the application and its documents (page names, field labels, rule wording) is treated as data. It can appear in an
objective's question and expected result, but it cannot add an action, lengthen a session or change a limit.

### Priority

Objectives run highest priority first. The priority is a fixed score, not a learned one, and each objective carries the sentence that
explains it, for example "Priority 9: stated by a source, mentions order, a workflow of 4 steps, a workflow check." What raises it:

- how firmly the expectation is stated (confirmed by a person, then stated by a source);
- words that mark something critical: money (price, subtotal, total, discount, coupon, shipping, tax, refund, charge or a dollar
  amount, which counts one point more than the others), order, account, payment, delete;
- a longer workflow;
- the kind: rule and state-change checks first, coverage gaps last.

## What the AI agent tries

Each objective allows a fixed set of ways to test it, called **operators**. One operator of one objective is one **pursuit**: the AI
agent gets fixed instructions for it, and the objective's expected result, wrapped in fixed wording and naming its source.

| Operator | What is done | Used for | Changes data |
|---|---|---|---|
| As stated | do the preconditions, follow the stated steps, check the expected result | rules, workflows, state changes | submits forms |
| Invalid input | type each value the field's limits say must be refused, and submit | form fields | submits forms |
| Boundary input | type values at and one step past each declared limit, and submit | form fields | yes |
| Double submit | click the final submit twice in a row | workflows | yes |
| Repeat | do the same steps again with the same values | workflows, state changes | yes |
| Direct address | open a later step's page by its address before doing the earlier steps | workflows, state changes | no |
| Back (by address) | open the previous page's address again, then carry on | workflows | no |
| Refresh | reload the current page by opening its address again, then carry on | workflows | no |
| Cancel | stop at a stated step with Cancel, Close, Discard or Escape | workflows | yes |

The values for form fields are worked out from the field's limits with the browser's own rules: empty, an invalid format (an email,
address, number or date that is not valid, a value outside the listed options, a value that breaks the pattern), one below, at and one
above each limit, one character past the maximum length, and a few unicode values. Only values whose expected result a limit decides
are typed in. A pattern that could make the check hang is ignored, and no value is longer than 10,000 characters.

After a pursuit, the platform checks the recorded steps to see whether the operator was really applied (for example, two clicks on the
same control in a row for a double submit). If it was not, no test is saved for it and the activity says so.

### What is skipped, and why

An operator that does not run is listed with its reason, never left out silently:

- **"data changes off"**, with the setting that is off. Submitting a form is a data change, so:
  - the two operators that submit forms (as stated, invalid input) run when the project's **Include API tests that change data**
    switch (Requirements tab) is on. With it off they are skipped with "data changes off: the project's “Include API tests that
    change data” is off";
  - the other data-changing operators (boundary input, double submit, repeat, cancel) need that switch **and** the server setting
    `EXPLORE_DATA_OPERATORS=true`. With the switch on and the setting missing they are skipped with "data changes off: this server
    does not allow this operator (EXPLORE_DATA_OPERATORS)". The setting is meant for the benchmark and test applications; a
    production platform does not set it.

  Both are off by default. With the project's switch off, only direct address, back and refresh run: rules and form fields get no
  pursuit. Every skipped operator is listed under "not run" in the coverage record, and an objective none of whose operators ran shows
  the same reason.
- **"needs a second account"**: an objective about another user's data (for example "can a customer see someone else's order?") needs
  two accounts, which is a later phase.
- **"no page for a later step"**: direct address needs a workflow step on a different page than the first one.
- **"no input classes"**: no value of the field fits the operator.
- Going back with the browser's own back button is not tested; "Back (by address)" opens the page's address instead. The coverage
  record notes this once for the session.

## Limits on a session

Every limit is counted by the platform, not asked of the AI, and is fixed before the first page of the session is read.

| Level | Objectives | Browser actions | AI calls | Time | Visits to one screen in one pursuit |
|---|---|---|---|---|---|
| Thorough | 50 | 750 | 750 | 90 minutes | 8 |
| Deep | 100 | 2,000 | 2,000 | 150 minutes | 10 |
| Everything | 200 | 5,000 | 5,000 | 180 minutes | 12 |

The objectives limit is on objectives: every pursuit of the objectives inside it is run (an objective with five operators is five
pursuits), until the session's actions, AI calls, tokens or time run out. AI tokens are limited to 7.5, 15 or 30 million for the
session. Each pursuit also has its own limits: the level's step limit for writing a test (30, 40 or 50 steps), 10 minutes, and 25,000
tokens a step (750,000, 1 million or 1.25 million). A pursuit that reaches its own limit before its test is finished is listed as not
finished, saying the steps done so far were not saved. Objectives beyond the session's limit are counted and listed as not reached.

The session also avoids going round in circles:

- the same action on the same screen is not done twice in one pursuit;
- a screen visited more often than the level allows ends the pursuit (a screen is its address with record numbers ignored, plus its
  layout of buttons, fields and headings, so the same screen with other data counts as the same);
- each pursuit starts in a fresh browser session;
- an objective already done in the session is not done again.

### Why a session stopped

Every session ends with exactly one stop reason, the first that applied:

| Stop reason | Meaning |
|---|---|
| Every objective done | each objective was pursued or skipped |
| Objectives limit | every pursuit of the objectives inside the level's limit was run |
| Time | the session's time ran out; a pursuit still running is abandoned |
| Actions, AI calls, AI tokens | the session's limit of that was reached |
| Instability | three environment failures in a row (a browser that stopped, an error the run could not recover from) |
| Safety | a pursuit reported an unsafe action |
| Cancelled | a person stopped the exploration |

Each pursuit's own outcome is kept too: completed, stopped (it repeated itself or went too deep), interrupted by the session's stop,
an environment failure, unsafe, skipped as already done, or not reached.

## Candidate findings

When the AI agent ends a test because the application did not do what was expected, the test is saved for review with a candidate
finding. This applies to exploration by objectives and to the planned tests written before it.

- **Captured** (`capture: "captured"`): the test ends at a failing check of a stated expectation, and the saved test keeps that
  failing check. A stated expectation is a rule, an objective's expected result (which names its source), or a planned expected result
  that names a rule by its ref or cites a requirement the scenario covers ("(requirement 1.1)"; a requirement numbered only "1.1"
  counts only in that form, never as a bare number such as "1.1 kg"). Later repairs may not remove, loosen or re-point a check with
  a stated source.
- **Seen, not kept as a check** (`capture: "observed_only"`): the AI agent said something was wrong, but no failing check of a stated
  expectation was kept. It still gives a candidate finding, saved for review with low confidence, but it is not captured.

"Captured" always means the first kind. A defect is captured only from a stated source; a failure the AI agent only saw is never
called captured.

A captured finding is then replayed twice, each time in a fresh browser, without AI. If both replays stop at the same failing check,
the failure does not depend on what earlier tests left behind.

| Confidence | Meaning |
|---|---|
| High | a stated expectation, a kept failing check, and both fresh replays failed at that check |
| Medium | a stated expectation and a kept failing check, but the fresh replays did not fail the same way or could not run |
| Low | seen, not kept as a check: no failing check of a stated expectation was kept |

The test's review reason says this in words, for example: "The application did not behave as expected: the cart total stayed the same
after the quantity changed. The failing check is of rule R-3; both fresh replays failed at it (confidence high)."

Each candidate finding records the objective and operator it came from, the steps (the saved test is the way to reproduce it), the
expected result and its source, what was observed, the request and console lines noted as evidence, up to three screenshots of
the page where a fresh replay stopped (password fields and stored secrets covered), the two replays, its confidence
and the analysis version the objective came from. Text is cleaned of secrets and cut to a fixed length before it is stored. The same
source, expected result and scenario make the same finding, so a project keeps one record for it across runs.

Confidence is a stated rule, not a judgement, and no candidate finding is marked confirmed. A person reviews it like any other test
saved for review.

## Coverage

At the end of a session the job keeps a coverage record, counted only from what was actually done (actions performed, tests saved),
never from what a pursuit claimed:

- pages, named elements, workflow steps, state changes, form-field input checks, rules and API endpoints: how many there are, how many
  were exercised, and which were not;
- pages reached that the analysis did not know;
- how many distinct screens and distinct pursuits there were;
- the objectives nothing of which ran, highest priority first, each with its priority sentence and what happened to it;
- every operator that did not run, with its reason (see "What is skipped").

The job also keeps the session's limits, each objective with its priority, the stop reason, each pursuit's outcome and the action log
(its first 2,000 rows, with a count of the rest).

## Where it shows

- **While the exploration runs**, the live view lists the objectives, highest priority first, each with its priority sentence and its
  state: Waiting, Exploring, Done, or Skipped (after the run, Not finished) with its reason. **Stop** is the run's own stop; afterwards the run's results show the
  stop reason "Cancelled". Which operators did not run, and why, is shown once the run is over.
- People who may only look at the project see the same list without **Stop**.
- **On the run's results**, the stop reason, the limits used and the coverage record, then **Findings to check**: each candidate
  finding with what was observed, its objective (kind and source), how many actions its test takes, the expected result and its
  source, its confidence in words with what that means, its evidence (screenshots, requests and console lines) and a link to the saved test. Each
  is labelled "Needs a person to check" ("Found by the AI, needs a person to check"). Up to three screenshots
  (where a fresh replay stopped, with password fields and stored secrets covered) show as thumbnails that open larger; a finding
  without one says "No screenshot was saved for this finding." Captured findings come first; each captured one is labelled "Captured: kept as a failing check" and each other one "Seen, not kept as a check",
  which also has a dashed border. An older run without findings says so in one sentence.
- With an older runner, the view says in one sentence that the runner needs downloading again.
- A refusal from the server is shown as its sentence.

## Limits

- Websites only. Phone and desktop exploration work as before.
- Not yet tested: slow or failing network requests, several tabs, an expired session, keyboard use and rapid clicks beyond a double
  submit, and checks that need two accounts.
- A very large application can have more pages and form fields than fit; the analysis then says how many were left out of the
  objectives.
- Objectives are only as good as the analysis: a requirement nobody wrote down, or a rule waiting for a person, gives no objective.
  Confirming rules and workflows on the Requirements tab adds them.
- With the project's "Include API tests that change data" off (the default), nothing that submits a form is tried: no rule or workflow as stated, no invalid or boundary
  values, no double submits, repeats or cancels.
- The browser's back button is not tested.
- Confirming a finding (more clean replays, merging the same finding across runs) is not part of this; findings stay candidates.
- Exploring by objectives uses AI calls on the starter's key, within the AI budgets that apply to every exploration
  ([ai-usage-budgets.md](ai-usage-budgets.md)).

## API

Under `/api/projects/:id`; reading needs access to the project.

| Request | Answer |
|---|---|
| `GET /candidate-findings?job=` | `{ findings }`, newest seen first; with `job`, the findings that run found first or last (404 for another project's run) |
| `GET /objectives` | the objectives the latest analysis gives, with priority and reason, without AI; one sentence when there is no analysis yet |
| `GET /jobs/:jobId/coverage` | the run's stop reason, limits, usage, coverage record and action log; one sentence for a run without a record (404 for another project's run) |

A finding's screenshots are job files read with `GET /api/artifacts/:id` (the ids in `evidence.screenshots`; JPEG; reading needs
access to the project, and another project's file answers 404).
