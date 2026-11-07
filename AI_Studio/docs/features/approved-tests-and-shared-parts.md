# Approved tests and the shared parts they use

A test's approved version never changes: its steps and its code are kept as they were approved
(`src/platform/review-store.ts`). But a run also uses parts that a project shares between tests:

- **reusable steps** and **shared elements**, for a test made of steps;
- **helpers**, for a test written as code.

When one of those changes, the test does something nobody approved. So the platform now records,
at each approval, what those parts make the test do, and checks it before every run.

## What happens

1. **At approval** (by a Project Admin, or by the project's review policy) the platform records a
   fingerprint of the shared parts the version uses (`src/platform/approval-deps.ts`, table
   `test_version_deps`, migration slot 54).
2. **When a part is changed on the project's pages** (reusable steps, shared elements, helpers, and
   library updates, which go through those pages) every test that uses it is checked at once.
   **Before every run** (runs of tests, schedules and suites, and runs on runners, which go through
   the same step) each test's approved version is checked again against the parts as they are now,
   which also catches a change made any other way.
3. **If a part changed**, the test is not run. The run log says, for that test:
   "A shared step it uses changed after approval; approve it again to run it." followed by the part
   that changed, for example "Changed: the reusable steps “Log in”." The run page lists the test as
   held back with the same sentence. A run in which every test is held back ends as "Nothing ran",
   which is held back, not a failure.
4. **A new version to approve** appears in the review queue: the same steps and code, with the
   source "Reusable steps, a shared element or a helper it uses changed", and a comment naming the
   part. It counts as the change of the person who changed the part, so the usual rule applies:
   they do not approve their own change unless they are the project's only Project Admin and the
   policy allows it. A change only a run found is the platform's. Approving it records the parts
   as they are now, and the test runs again. For a test made of steps, the review page shows the code made from the steps with
   the new parts beside the code of the approved version, so the reviewer sees what changed.
5. **Putting the part back** as it was makes the approved version run again, without a review.

## What counts as a change

- Reusable steps: their steps, their parameters and their kind (web, API, any).
- Shared elements: their locator and kind.
- Helpers: their code, for every helper the test imports, also through other helpers. A helper
  the test imports that did not exist at approval and exists now is a change too.
- Not a change: renaming reusable steps or an element (the tests that use them are updated and
  keep their approval), an element's notes and page, and an element's other locators (a repair
  that uses them makes a new version, which is reviewed as a repair). Test data sets and the
  application's address are settings of a run, not parts of a test, and are not covered.

## The project's review policy

Changes to shared parts are made by people on the project's pages, so they follow the policy for
**changes by people**:

- On (the default): the test is held back until a Project Admin approves it again.
- Off: the approved version is approved again at once, and a comment on it says so.
- A change made with the access key or open access, in a project with no Project Admin, is
  approved again at once too, exactly like such a change to a test itself.

## Versions approved before this was built

They have no record. The first run that checks such a version records the parts as they are then,
and runs it: that is what the test ran with before, and holding back every existing test at the
upgrade would stop every project. From then on a change holds it back. If a part is changed on the
project's pages before any run recorded it, what the test was approved with is unknown, so it is
held back until it is approved again.

## Limits

- A helper that is added after a test imported it (the test could not run before), and changes
  made outside the project's pages (for example a restore), are found when a run starts, not when
  they are saved: the version to approve again appears then, as the platform's.
- A test approved while one of its parts was missing (it could not run) is held back once the part
  exists.
