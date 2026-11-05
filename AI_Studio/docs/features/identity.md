# Two-step sign-in, test accounts and access-control checks

## Two-step sign-in (authenticator codes)
If the test account's login asks for a one-time code from an authenticator app, give the platform the account's **setup key** (the letters and
digits shown next to the QR code when the account was enrolled). Enter it on the project's Requirements tab, under *What the agents need → Sign in → Authenticator secret* (a phone app's exploration panel keeps it under *Advanced options*), or pass
`totpSecret` in the API (`--totp-secret-env NAME` in the `ai-test` CLI). The platform then:

- fills the current code when the login shows a code step (an input with `autocomplete="one-time-code"`, or a name, id or placeholder such as *otp*, *2fa*, *mfa*, *verification*, *code*) and continues;
- says plainly what went wrong instead of reporting a false success: *no secret given*, *code not accepted (check the secret and this computer's clock)*, or *secret not valid base32*;
- never submits a code in its last 3 seconds: it waits for the next one;
- lets generated tests use `{{credentials.totp}}`: the script computes the code itself from the `TEST_TOTP_SECRET` environment variable when it runs, so the secret never appears in a script, spec or API answer.

It implements RFC 6238 (SHA-1, 6 digits, 30 s) with `node:crypto` and is checked against the RFC's own test vectors. **Codes sent by email or text message cannot be generated this way** and are not supported.

## Test accounts
**Tests → ⋯ More actions → Test accounts**: up to six named accounts such as *user* and *admin*, each with a username, a password and optionally an authenticator secret.
Names use lower-case letters, digits, `-` and `_`. Passwords and secrets are **write-only**: encrypted at rest, never returned by the API or shown again (the panel shows
"Saved — leave empty to keep"). Scripts refer to an account as `{{credentials.admin.username}}`, `{{credentials.admin.password}}`, `{{credentials.admin.totp}}`, resolved at run time from
`TEST_ADMIN_USERNAME`, `TEST_ADMIN_PASSWORD`, `TEST_ADMIN_TOTP_SECRET`. API: `GET` / `PUT /api/projects/:id/roles` (a password or secret left out keeps the saved one; an empty secret removes it).

## Access-control checks
When a project has test accounts, an analysis also asks: *can someone open a page they shouldn't?* (`accessChecks: false` turns it off.)

1. **Survey.** The app is crawled briefly (12 pages) as a visitor and as each account, noting which pages each can reach and each page's heading.
2. **Checks.** A page that a more privileged account (one that reaches more pages) reached but a lesser account — or a visitor — did not becomes a check: *"the 'user' account cannot open /reports"*.
   Pages whose address sounds privileged (`/admin`, `/users`, `/billing`, `/settings`, `/reports`…) come first and are rated **high**; others are rated **low** and capped at 3.
3. **Execution.** In a fresh browser, the test signs in as that account (including a one-time code), opens the page directly by its address and decides. *Denied* = HTTP 401/403/404, a redirect to a sign-in or error page, a sign-in form, an "access denied" message, or
   the page's heading not shown. *Open* = the heading is shown. Only page addresses are requested (GET); nothing is changed.

A finding reads: *"A signed-in 'user' user can open /reports and see 'Quarterly reports'. It is normally reached only by 'admin', so this is **possible** broken access control: check that this page is meant to be open to them."*

## API endpoints
Give an account an **API token** (a bearer token, in the same panel) and the analysis also checks the API. Up to 12 **GET** endpoints whose address sounds privileged
(`/admin`, `/users`, `/billing`, `/settings`, `/reports`…) are called once as a visitor and once per account with a token, one request at a time. For each such endpoint that the
most privileged account can call, every other viewer gets a check: *"the 'user' account cannot call GET /api/admin/reports"*. The check sends that one GET (with the account's token
from `TEST_<NAME>_API_TOKEN`, never the project's default credential) and passes when the answer is a refusal — HTTP 401, 403, 404 or a redirect. A success answer is a finding, rated **high**:
*"A caller with the 'user' account's token can call GET /api/admin/reports (HTTP 200). It is normally reached only by 'admin', so this is possible broken access control."*
Checks that pass today guard against regressions. Other statuses (such as a 500) are reported as a plain validation failure, not as a finding. Only GET is ever sent.
Tokens are write-only like passwords: encrypted at rest, never returned or put in a script.

## Stored sign-in details stay on the application's own site
A test is data, and anyone who can write or edit one (an import, a recording, plain English, the step editor) could write *"go to another site and type the password"* or *"send this request to another site"*. So that the project's password, authenticator secret and API token cannot leave for a site the owner never chose, one rule holds everywhere:

- **In the steps.** A step that uses stored details (any `{{credentials...}}` placeholder, also through test data, or an API request that sends the saved sign-in, which is what a request does unless it says `auth: none`) must run on the application's own site. For an API test that is the API address (or the application's, when the project has no separate API address). Otherwise the test is refused, with the step named: *"Step 3: Stored sign-in details can only be used on the application's own site (this step is on https://other.example). Use the application's own address, or for a request set auth to none."* The same check runs in every place a test is stored or turned into a script: spec import (and so saving a recording), the step editor (save and preview), plain-English and generated tests, and the script generators themselves. Nothing is stored when a step is refused. A site is the whole origin: another port, another scheme, and `localhost` against `127.0.0.1` are other sites. An address that begins with a placeholder (`{{where}}/x`) cannot be judged and is refused when the step uses stored details.
- **In the script, when it runs.** The web script compares the page's real address with the application's right before it uses a stored value (`assertOwnOrigin(page.url(), BASE_URL)`), so a redirect or a page that sends the browser away cannot get a password typed there. The API script (and a load check) compares the request's real target with the API address before it attaches the token or the saved header. Either way the step fails with the same message and nothing is typed or sent.

Because of this, **single sign-on on another site is not supported with stored details**: a test that has to sign in at an identity provider on another origin cannot use `{{credentials...}}` there. Sign in on the application's own login page, or keep that part outside the automated test. Tests that use no stored details, and requests with `auth: none`, may go to any allowed address as before.

## Limits (it is a heuristic)
- It cannot know your intent. A public page that simply wasn't linked where the crawl looked can be flagged, which is why ordinary-looking pages are only *low* and capped.
- Two accounts that reach the same number of pages are not compared with each other (there is no way to tell which is the lesser); each is still compared with a visitor.
- The survey is small (12 pages per viewer, two clicks deep) and follows links only; pages reachable only by a script action are not seen.
- Pages that need a specific record or a POST are not covered. API endpoints are covered only for privileged-looking GET addresses that need no path parameter.
- Admin areas behind a second login screen of their own, CAPTCHAs, and email/SMS codes are not supported.
