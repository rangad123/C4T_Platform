# Test quality: tests that check almost nothing

A green test is only worth something if it would turn red when the feature breaks. AI-written (and hand-written) tests
sometimes only open a page and click around. The platform marks those as **Weak checks**. This is advice: a weak test keeps
its normal status and still runs.

## What counts as weak

| Rule | Example | Why it matters |
|---|---|---|
| No checks at all | Open the shop, click *Add to cart*, stop | Passes even if the cart is broken |
| Only checks that a page loaded | Only the address, the title, or "the page body is visible" | Passes even if the feature is missing from the page |
| Checks happen before the actions | Check the cart is empty, then click *Add*, never look again | The result of the action is never verified |
| API call only checked for success | `GET /products` expects 200 and nothing about the data | Passes with wrong or empty data |
| Duplicate | Same steps as an earlier test | Checks nothing new (the later test is flagged, naming the earlier one) |

Not flagged: API tests that expect an error status (that status *is* the check), tests that reuse a returned value in a
later request, and the single-purpose families — accessibility, visual, health, security and performance checks.

## Where you see it
- **Tests tab:** a *Weak checks* badge on the row (hover for the reason) and a *Weak checks* filter.
- **Test page:** a note explaining in plain words what the test doesn't verify.
- **Overview:** a line such as "3 tests check very little… See them" that opens the filtered list.

## How it works
`src/engine/quality/rules.ts` reads the canonical spec; nothing is stored. The result (`quality: { level, reasons }`) is computed
on read and added to `GET /api/projects/:id/tests` and `GET /api/tests/:id`. Duplicates are judged against the whole project, even
when the list is filtered. Changing a rule re-scores existing tests with no migration.

## Limits
The rules are structural: they can see that a test has no meaningful check, not whether a check is the *right* one.
