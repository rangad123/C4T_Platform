# Bug verification: findings on the run page

What exploration finds is shown inside the run's existing results, in the **Findings to check** card. There is no separate page or
tab for findings.

After each run the platform verifies the run's new candidate findings in the background: it runs the test again, 3 attempts in fresh
browsers. This is on by default; set `VERIFY_FINDINGS=false` on the server to switch it off.

## Order

1. **Confirmed**: findings whose status reads "Confirmed …", worst severity first (critical, high, medium, low).
2. **Needs manual review**: findings in that state, and confirmed findings the platform is not sure enough about (their status reads
   "Possible …, needs review"), worst severity first.
3. **The rest**, folded by state (for example "Candidate (3)", "Unconfirmed (1)", "Not a bug (2)"), closed until opened.

Within a group, captured findings come before observed-only ones, then higher confidence first.

## What each finding shows

- **Status**: the finding's state in words. "Confirmed" is shown only at high confidence: a confirmed finding below high confidence
  reads "Possible *severity* bug, needs review", and a critical or high security finding that has not been reproduced reads
  "Possible *severity* security issue, needs review" (`src/engine/findings/score.ts`, `label`).
- **Severity** as a badge, and **confidence** with how often the attempts failed the same way on one line, for example
  "High confidence · failed the same way 2 of 3 times". The reason for each level is under the finding's Evidence.
- **Steps** of its saved test, behind a disclosure, with the objective and the expected result.
- **Thumbnails** of its screenshots, each opening larger in a new tab.
- **Likely cause**, with its label (Verified, Strongly supported or Hypothesis), only when one was found at a code location. When
  none was, one line above the list says why (for example, no code source is connected to the project).

The server works these out (`GET /api/projects/:id/candidate-findings?job=`, the `review` field of each finding), so the page has no
rule of its own.

## Actions

A person who may change tests (`ai_studio.tests.write`) sees up to four buttons, only where the finding's lifecycle allows a person
that move (`src/engine/findings/lifecycle.ts`):

- **Confirm**: from Reproduced, Unconfirmed, Needs manual review and the side states. A candidate is verified by the platform first.
- **Not a bug**: asks why; the reason is kept in the finding's history.
- **Split**: shown for a finding that is in a group; takes it out of the group so it is checked on its own.
- **File issue**: for a confirmed finding or one that needs manual review, to the project's first connected issue tracker. One issue
  is made per group and tracker; the row then links to it.

People who may only look see the same findings without buttons. Every control is reachable with the keyboard.
