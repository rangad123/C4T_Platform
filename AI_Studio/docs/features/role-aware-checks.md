# Speed and visual checks as a signed-in account

Page-speed and visual-baseline tests used to cover only pages **anyone** can open: a page that is reachable only when logged in
would send a fresh browser to the sign-in page, so the old rule skipped it. They now also cover pages behind a login, as the
project's **default account** or as a **named test account** (see `identity.md`). There is **no new option**: signed-in checks
appear when **Page speed checks** (*Speed*) and/or **Visual changes** is on **and** someone can sign in.

## What a user sees
Next to the anonymous tests, the Tests page lists extra ones whose titles say who is signed in:

- *Dashboard page loads quickly (/dashboard) (signed in as the default account)*
- *Content page looks the same as its approved baseline (/reports) (signed in as admin)*

They keep their category (**Performance** / **Visual**), findings, severity, speed history and baselines exactly like the anonymous ones.
A page behind a login is tested **once per account, never also as a visitor** (a visitor test of it would measure the sign-in page, which
is what used to make these pages unreliable). A test that opens with the sign-in steps shows them in its step list, so what it does is visible.

**When the sign-in does not work** the test is a plain **Failed validation**, never a finding, with a reason that says so:

- *Could not sign in as the default account: the sign-in form was still shown after the sign-in details were submitted. Check the account's username and password …*
- *Could not sign in as admin: the one-time code was not accepted. Check the authenticator secret and this computer's clock.*
- *Could not sign in as admin: the step "2. Enter the “admin” username" did not work (…)* (the form changed, a field was not found)

## Which pages, and for whom
After discovery (and the access survey, when the project has test accounts), the platform decides which pages get signed-in checks:

1. **Accounts.** The default account (when discovery could sign in with the project's credentials), then each test account the access survey
   could sign in as. **At most 2 accounts.**
2. **Candidate pages.** For the default account, the crawl's important pages (the same ranking as the other checks, then any other page that
   answered normally, shallowest first). For a test account, the pages that account reached in the survey.
3. **Looking, not guessing.** All candidates are opened **once as a visitor** (a fresh browser context, GET only; at most 30 pages). A page
   counts as "needs a sign-in" when the visitor gets HTTP 401/403/404, is redirected to a sign-in/denied/error address, is shown a sign-in
   form, or sees "access denied". Public pages, and pages that could not be judged (a server error, no answer), are left to the anonymous checks.
4. **Cap.** **At most 3 signed-in pages per account.** A gated page beyond the cap is dropped (not tested anonymously either).

The same visitor pass reads the sign-in form at the address discovery learned (`/login` and friends when none was learned) so the sign-in
steps use that form's real field names. If no sign-in form can be found, the signed-in checks are skipped with a warning event
(*"Speed and visual checks as a signed-in account were skipped: the sign-in form could not be found as a visitor"*), and everything else is as before.

## How a test signs in
A signed-in test starts with ordinary steps, rendered into plain Playwright like any other test:

1. open the sign-in page; 2. fill the username and 3. the password with `{{credentials.username}}` / `{{credentials.password}}`
(or `{{credentials.<name>.username|password}}` for a test account); 4. submit (the form's submit button, or Enter);
5. **check that the sign-in form is gone** (this is what makes a wrong password a clear failure instead of a measurement of the sign-in page);
and, when that account's login asks for an authenticator code, 6. fill `{{credentials.totp}}` / `{{credentials.<name>.totp}}`, 7. press Enter,
8. check that the code box is gone. Then it opens the page and runs the ordinary speed or screenshot step.

The generated script holds **only environment-variable names** (`TEST_USERNAME`, `TEST_PASSWORD`, `TEST_<NAME>_USERNAME`, `TEST_<NAME>_TOTP_SECRET`…),
never a secret; the platform supplies them when it runs the test, and the test also runs under plain Playwright with those variables set.

## Speed: carrying the session into fresh browsers
The speed test loads a page three times, each in a **brand-new browser context** (that is what keeps the cache out of the measurement).
A new context has no cookies, so it would be turned away from a signed-in page. Signed-in speed tests therefore have `signed-in` in the speed
step's `expected` text (for example `ttfb:500 signed-in`): the helper then captures the test page's session with `context.storageState()`
(cookies and local storage) and starts each measurement context with it. Without that word the measurements are made as a visitor, exactly as
before, so existing tests are unchanged. A guard fails the test with a plain message (no finding) if a fresh context is shown the sign-in form
instead of the page ("The signed-in session was not accepted in a fresh browser …"), so a lost session is never measured as if it were the page.

## Visual
The screenshot step needs no new context, so signed-in visual tests are simply "sign in, open the page, compare". The stability rule is the usual
one: the first run captures the baseline and runs again; a signed-in page whose content differs between two loads (a clock, a per-user greeting
with changing data…) is **not visually stable** and fails validation instead of becoming a flaky test; later differences are *Visual change* findings.

## Limits
- Sign-in uses the **form** discovery finds: a page with a password field, in a `<form>` or not; a login that opens in a popup, a CAPTCHA,
  single sign-on via another site and codes sent by email or text message are not supported (as for the rest of the platform).
- Sessions held only in **session storage** (not cookies or local storage) are not carried into the speed helper's fresh contexts; the speed
  test would then fail with the "session was not accepted" message rather than give a wrong number.
- Test-account pages need the **access survey** (on by default when the project has test accounts; `accessChecks: false` turns it off, and then only
  the default account gets signed-in checks).
- The survey and the visitor pass are small (12 pages per account, 30 probes): pages beyond them are not considered. At most 3 pages for 2 accounts.
- Whether a page "needs a sign-in" is judged from what a visitor is shown; an app that answers visitors with the page but hides the data in it would
  be treated as public (and tested anonymously, as before).
- A landing page that legitimately contains a password field (a "change password" form shown right after signing in) is read as a failed sign-in.
- Per-user dynamic content that changes between loads makes a visual test *not visually stable*, as for any dynamic page; there is no way to mask regions yet.
- The cross-browser/screen-size checks leave visual tests alone, as before. The browser-and-screen-size job now also receives the project's test accounts
  (it did not before), so any test that signs in as a named account can sign in there too.

## How it is built
`src/engine/identity/signed-in.ts` (planning, sign-in steps, failure wording), `generateSignedInPerformanceSpecs` in `performance/specs.ts`,
`generateSignedInVisualSpecs` in `visual/baseline.ts`, the `signed-in` token in `performance/checks.ts`, and one hook in `orchestrator.ts` (after the
access survey) and one in `validation/validator.ts` (a failed sign-in is a plain failure). Tests: `tests/signed-in-checks.test.ts`.
