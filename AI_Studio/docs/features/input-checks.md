# Form input checks

Tries harmless but awkward input in the forms it finds and tells you if the application mishandles it. **On by default** for
search-type forms, with the project's **Test Case Generation** testing agent (to leave it out of one exploration, send `inputChecks: false` in the API).

## What it does
For each of up to four pages with a form that is safe to probe, one test loads the page and, for up to two of its forms, submits a
small **fixed set of seven probes** (reloading the page before each one): HTML-like text, nothing, only spaces, 5,000 characters,
emoji and right-to-left text, quotes and a backslash, and a null character. After each it checks:

| Problem | Severity |
|---|---|
| What you typed becomes real **page markup** instead of plain text (possible cross-site scripting) | High |
| The **server fails** (HTTP 5xx) on that input | High |
| The **page goes blank** | High |
| A **script error** occurs | Medium |

Each finding says which form and which input triggered it, and how to fix it.

## Client-side limits (no submission)
Before the probes, on the same eligible forms (same rules as below, so never login, sign-up, checkout or payment forms, never
password / card / code fields, GET forms unless data-changing tests are on), the check reads what the form promises in the live page:

| Problem | Severity |
|---|---|
| A text, search or text-area field says it takes at most N characters (`maxlength`, N up to 500) but **accepts more** when N+10 characters are typed | Medium |
| A form with **required** fields could be submitted with them empty (the form has `novalidate`, or its submit button has `formnovalidate`, or the browser does not treat the empty field as missing) | Low (advice) |
| An **email** or **web address** field does not reject a clearly wrong value (`not-an-email`), or the form switches the browser's own checks off; a **number** field accepts letters | Low (advice) |

How it stays safe: nothing is submitted for these checks. The submit button is never clicked (so the form's own script never runs).
Required is judged by emptying the fields and reading the browser's own validity state; `maxlength` is judged by really typing
(`fill` would bypass the limit); types by entering a wrong value and reading the validity state. The page is reloaded before
the probes start, so nothing typed here reaches them. Findings use the same message, `[severity]` lines and "How to fix" as the probes.

Switch the limit checks off for one test by writing `safe nolimits` (or `all nolimits`) as the step's expected text; older
`safe` / `all` steps keep working and now include the limit checks.

## What it never touches
- By default only **GET (search-type) forms** are submitted. A form that sends data (POST) is never submitted unless you also tick
  **Include API tests that change data**, and then only forms such as contact or feedback forms.
- Forms with a **password, card number, security code, one-time code, account number or PIN** field are never probed, in any mode.
- Forms whose address or id looks like **login, sign-up, checkout, payment, cart, order, delete, logout or subscribe** are never probed, in any mode.
- The probe strings are fixed and harmless (no exploit payloads); each form gets at most seven submissions per run; nothing else on the site is visited.

## Limits
- It judges what the page shows after submitting; it does not read the raw server response, so input reflected somewhere the
  browser does not turn into markup is not flagged.
- Client-side limits: only the first six text fields of each form are looked at, and only `maxlength` up to 500. A limit enforced by
  script on a different event than typing (paste, drag and drop) is not exercised. Whether a script-submitted form ignores
  `required` (for example a plain button that never triggers the browser's checks) cannot be seen without submitting, so it is not
  reported. Typing into a field can still fire the page's own live-search or suggestion script; that is page behaviour, not a form
  submission. Date, range and select fields are not checked.
- Forms the crawler could not see (opened by a click, behind a login) are not probed. Search forms that rely on a script to submit
  are probed through their submit button.
- Pages with several forms: only the first two eligible ones are probed.

## Where it lives
`src/engine/inputs/` — `checks.ts` holds the page-side helper pasted into the generated script (so a downloaded script runs on its own);
`specs.ts` decides which pages get a test and classifies a failure as a finding ("Input handling check failed:", one `[severity]` per line).
