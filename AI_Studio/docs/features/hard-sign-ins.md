# Hard sign-ins: saved sessions, emailed codes and links, captchas

Some sign-ins cannot be filled in by a test: single sign-on at another site, "Sign in with Google / Microsoft", a captcha, a code sent by email, a magic link. This feature covers them without pretending to automate what cannot be automated.

## What a tester sees

**Library → Test accounts → Saved sign-ins.** One row for the project's own sign-in ("Project sign-in") and one per test account.

- **Sign in once yourself** opens a browser on the application's sign-in page (on the computer that runs the platform). You sign in by hand: single sign-on, a popup window of an identity provider, a captcha, an emailed code, whatever the site asks. Then **I'm signed in, save it**. The platform keeps only the cookies and local storage the site set (Playwright's "storage state"), encrypted. It never reads what you type. The status line shows where the window is, whether a sign-in popup is open, and whether the page shows a captcha (you solve it; the platform never touches it). **Cancel** closes the browser. After 15 minutes without saving it closes by itself.
- **Upload a saved sign-in file**: the same, from a storage-state file you made elsewhere (for example `npx playwright codegen --save-storage=state.json https://your.app`). Use this when the platform runs on a server without a screen.
- Each row says *Signed in*, *Signed out*, *Saved, not checked yet* or *Not saved*, when the session was saved and when its cookies run out. **Check now** runs the "Still signed in?" check. **Sign in again** replaces the session. **Forget** deletes it.

**Runs and explorations start signed in.** Before a run (or an exploration) of a project with a saved project sign-in on the same site:

1. If the cookies' own expiry has passed, the run stops at once.
2. Otherwise the platform opens the signed-in page it saved (the page you were on when you saved) in a fresh headless browser with the session. Signed out = the page asks for a password, shows a captcha, moves to a sign-in address or another site, or answers 401/403.
3. Signed out: the run stops **before any test runs**, with *"The saved sign-in for this project no longer works (…). Sign in again under Test accounts, then run again. No test was run, so no result changed."* The row shows *Signed out* and the button *Sign in again*.
4. Signed in: every generated web test of the run starts signed in, except tests that sign in by themselves (they type the stored password or a one-time code), which start signed out as before. An exploration opens the app signed in and does not fill the sign-in form.
5. If the check page cannot be opened at all (the app is down), the run goes ahead (its tests say what is wrong) and the session is not blamed.

**Emailed codes and magic links.** **Library → Test accounts → Test mailbox**, then the step **Use an emailed code or link** (step editor: *Type an emailed code*, *Open an emailed link*; text: `Wait for an email to "qa+{{unique}}@mail.test" and type its code into the "Code" field`, `… and type its code after "Your code is" into …`, `… and open its link[ containing "sign-in"]`). While the test runs, the step waits up to 90 seconds for the newest email to that exact address that arrived after the test started, then types its code or opens its link. Two kinds of mailbox:

- **Forward to the platform (simplest).** *Make a forwarding address* shows a private address once (`https://<platform>/api/inbound-mail/<token>`). Have your mail service post each email there: JSON `{ "to", "from", "subject", "text", "html" }`, JSON `{ "raw": "<the message>" }`, or the raw message as `message/rfc822` or `text/plain`. Mail is kept encrypted for a day (at most 200 messages a project; 60 a minute). Making a new address retires the old one.
- **Read an IMAP mailbox.** Server, port, TLS, user name, password (write-only). The platform logs in, opens the folder read-only, searches for messages to the address and reads the newest five; nothing is marked read or deleted. *Test the mailbox* checks the login. Plain IMAP without TLS is refused unless the server is on this computer or a private network.

Use `{{unique}}` in a test data value (for example `addr = qa+{{unique}}@mail.test`) so each run has its own address; most mail services deliver plus-addresses to the same mailbox.

**Captchas** (Google reCAPTCHA, hCaptcha, Cloudflare Turnstile) are recognised and never solved:

- exploration stops on that page (nothing is tried, its links are not followed) and the job says *"This page has a captcha (reCAPTCHA) at /contact; use a saved session or ask the site to turn it off for tests."*;
- the automatic sign-in stops with the same sentence;
- a failed web test whose page loaded a captcha gets that sentence as its reason (*Needs a look*), and is not sent to repair.

## How it works

- **Storage** (migration slot 29, `src/platform/session-store.ts`): `saved_sessions` (per project and account: the encrypted state, the application, the check page, the cookies' earliest expiry, the last check), `test_mailboxes` (the encrypted IMAP settings, or the SHA-256 of the inbound token), `inbound_mail` (forwarded messages, body encrypted). All secrets go through `SecretBox`; none is ever returned by the API, put in a spec, a script or an event. A backup copies the encrypted values as they are.
- **The sign-in browser** (`src/engine/auth/capture.ts`, `src/platform/hard-signin-service.ts`): the platform's own Chromium in a fresh context, one per project, popups followed (they share the context), every page the browser opens checked by the address guard first, the browser's process id kept and only that process ended.
- **Runs** (`src/engine/auth/run-session.ts`): the job wraps its executor (`HardSignInExecutor`). For Playwright scripts against the session's own site it marks the scripts that do not sign in by themselves; the runner writes the session into the run's own folder (owner-only, deleted when the run ends) and adds one line after the script's Playwright import in **the run's copy only**: `test.use({ storageState: process.env.AITP_STORAGE_STATE, trace: "off" })`. The stored script never changes. Those scripts keep screenshots, video and failure evidence but **no trace**, because a trace records every request with its cookies. Cookie and storage values are masked in evidence. A run on a runner agent receives the session in the task, encrypted like the other sign-in details (`WireRunEnv.storageState`, `WireScript.session`, additive optional protocol fields, version stays 1).
- **Email steps** (`src/engine/auth/email-step.ts`, `mail-rpc.ts`, `mail.ts`, `src/platform/mailbox/*`): the generated script holds no mailbox details. It writes a small request file into its run folder; the platform process answers it from the project's mailbox (and only that project's), doing the extraction itself. Codes: 4 to 8 digits (or 6 to 8 capital letters and digits) shortly after a word such as code, verification, one-time, OTP, passcode or PIN, else the first six-digit number; years and prices are skipped; with *after*, the first such token after that text. Links: the first link to the application's own site that is not an unsubscribe, privacy or image link; with *containing*, the first whose address or words contain it. A link to another site is not opened (plain failure).
- **Captchas** (`src/engine/auth/captcha.ts`, `captcha-run.ts`): by elements (`.g-recaptcha`, `.h-captcha`, `.cf-turnstile`, captcha iframes by title or address), by frames, and for runs by the requests in the failure evidence.

## API

All routes need the access key or a signed-in person (see the role table); the inbound route is the exception: its token is its credential.

| Route | What it does |
| --- | --- |
| `GET /api/projects/:id/hard-sign-in` | `{ appUrl, accounts, sessions, capture, mailbox, browser: { installed, display } }`; never a value. |
| `POST /api/projects/:id/sessions/:account/capture` | `{ url?, headed? }` opens the sign-in browser (`201`). `account` is `main` or a test account. `409` one is open; `422` no browser / no screen; `404` unknown account. |
| `GET /api/projects/:id/sessions/capture` | Its status (poll): `starting`, `open`, `saved`, `cancelled`, `failed`; `currentUrl` (no query string), `popupOpen`, `popups`, `captcha`. |
| `POST /api/projects/:id/sessions/capture/save`, `DELETE /api/projects/:id/sessions/capture` | Save and close; cancel. |
| `PUT /api/projects/:id/sessions/:account` | `{ storageState, checkUrl? }` uploads a storage state (at most 1 MB, 300 cookies, 40 origins). |
| `POST /api/projects/:id/sessions/:account/check` | "Still signed in?" now: `{ signedIn, reason, unreachable?, session }`. |
| `DELETE /api/projects/:id/sessions/:account` | Forget. |
| `PUT /api/projects/:id/mailbox` | `{ kind: "inbound" }` (answers `inboundPath` once) or `{ kind: "imap", imap: { host, port, tls, user, password?, mailbox? } }`. |
| `POST /api/projects/:id/mailbox/test`, `DELETE /api/projects/:id/mailbox` | Test; remove (forwarded mail is deleted too). |
| `POST /api/inbound-mail/:token` | Forwarded mail (`202`); unknown token `404`, too many `429`. |

## What is not covered (honest list)

- **Signing in by hand happens on the platform's computer.** Like recording, the window opens where the platform runs; on a server without a screen, upload a storage-state file instead. Signing in by hand on a runner agent's computer is not built.
- **Named test accounts' sessions are saved and checked, but runs only use the project's own sign-in** ("main"). A test cannot yet say "start signed in as admin".
- A run against a **named environment** (another address) does not use the saved session and is not checked.
- **Email steps run on the platform only.** On a runner agent they fail with *"…runners cannot read the test mailbox."* Text-message (SMS) codes are not supported. Live step-by-step tries (the step editor's "try", live sessions) refuse the email step: it only runs in a real run.
- The "Still signed in?" judgement is a heuristic (password field, captcha, sign-in address, 401/403). An app that shows a signed-out page at the same address without a password field is taken as signed in; the tests then fail on their own.
- The session is as good as a password while it lasts: anyone who can run the project's tests runs them signed in. Hand-written (code) tests never get it.
- IMAP: LOGIN only (no OAuth2/XOAUTH for Gmail or Microsoft 365: use an app password or forwarding); messages larger than 1 MB are not read; the server's clock is trusted to within a minute.
- Captchas are recognised by the common widgets only; a home-made image puzzle is not recognised.
- Not exercised here: real identity providers, a headed window on a server, real mail providers. The tests use local fixture sites (an app and an "identity provider" on another port), a fake IMAP server (plain and TLS) and the platform's own inbound route.

## Tests

`tests/hard-signin-unit.test.ts` (fast tier): MIME reading and extraction rules, the IMAP reader against `tests/fixtures/fake-imap.ts` (plain and TLS, refused login, read-only commands), encryption at rest of sessions and forwarded mail, per-project isolation, the email step's script helper really executed against the answering loop, the run-only session line, captcha recognition, text phrases and the step editor's rules. `tests/hard-signin.test.ts` (real Chromium, platform and worker, under the browser lock): sign in by hand through a popup of another site and save, the cookie absent from answers, events and the database, a run that starts signed in, an emailed code and a magic link through the inbound address, a captcha page reported, the sign-in stopping at a captcha, a revoked session stopping the next run before any test with no result changed, and the Test accounts page.
