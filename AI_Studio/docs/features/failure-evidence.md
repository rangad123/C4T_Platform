# Failure evidence: what the page did when a test failed

A screenshot shows where a web test ended up. It does not show which request failed on the way, or what the browser console
said. Every generated web test now records both, and keeps them with the result when the test fails.

## What you see

On the page of a web test that did not pass, a section **What the page did** shows:

- **One sentence** on what likely matters, for example: *1 request failed: POST /api/cart answered 500; 2 console errors; the page
  made 41 requests.* It is computed from the recording with fixed rules, no model.
- **Requests that failed or were slow**: a small table (what was asked, how it ended, how long it took), with the requests around
  the failing step first and a note such as "During step 2, just before it failed".
- **Console errors**: errors and uncaught exceptions, with where in the test they happened.
- **Show all requests**: every recorded request (the 300 most useful, see limits) with a filter box and Failed / Slow buttons.

For a run that has no recording (a run made before this feature, or an API or mobile test) the section says so in words instead.
The same sentence is added to the text of an issue created from the test ("What the page did") and to the shareable project report.
The tables stay on the test page.

## How it works

1. The generated Playwright script contains a small recorder (plain JavaScript, pasted into every web script, the same way the
   health checks carry their collector). It listens to the page from before the first step: requests and answers, console messages,
   uncaught exceptions. It labels each entry with the number of the step that was running. It only keeps small objects in memory;
   nothing is written, and nothing is sent anywhere.
2. When the test ends and **failed**, an `afterEach` hook masks everything it recorded and attaches it to the result as `evidence`.
   A passing test attaches nothing (set `AITP_EVIDENCE=always` to keep it for passing tests too). The script works on its own: run
   with plain `npx playwright test` it produces the same attachment in the Playwright report.
3. The platform runner takes the attachment out of the report, parses it against a strict schema, masks it **again** (this time
   also with the exact credentials of the run), caps it and stores it as an `evidence` artifact of that execution. The raw
   attachment is never written anywhere else. Evidence that does not fit the schema is dropped and the result is unaffected.
4. `GET /api/tests/:id/evidence` (latest failed run) or `?executionId=...` returns the stored evidence, the sentence, counts and the
   entries that matter (failed and slow requests, console errors, what happened around the failing step). A test or run without
   evidence is a normal answer with `available: false` and a message; an unknown test or a run of another test is a 404.

## Expected and actual

For a failed check the test-detail answer (`GET /api/tests/:id`) says what was expected and what came back, as plain strings. Each failed step in `executions[].steps[]` gets `expected` and `actual`, and a failing test has a `failure` block: `{ kind: "mismatch", step: { index, title }, expected, actual }`. They are read from the error the runner stored ("Expected: ... Received: ..."). A status check reads "HTTP 200" and "HTTP 401", a status class "2xx" and "4xx", a text check the text and what the page showed. Each is at most 200 characters. They are read from the stored errors, so older runs have them too. No such lines in the error means no fields; nothing is guessed. Passing steps have none.

When an API test fails because the application answered 401 to a request that sends the project's API credential and **no API token (or auth header) is saved**, the reason is "The test needs the project's API token, and none is saved. Add one under API access on the Requirements tab (What the agents need), then run the test again.". Its **Add an API token** button opens that tab. The test is not sent to automatic repair (a model cannot fix a missing token) and `failure` is `{ kind: "missing-api-token" }`. Not covered: runs against a named environment do not name a missing token; a 403 is never called a missing token.

The failure message on the test page no longer says "edit it and import it again": it names the current actions, Edit steps and Edit the script.

## What is recorded and what is never stored

Recorded per request: method, the address (path and query), the other site's host when it is not the application's own, status,
resource type, duration, size from the `Content-Length` header, and why it failed or was cancelled. Per console line: type,
text, where it came from. Uncaught exceptions: the message.

**Never stored**: request or response bodies, cookies, any header (headers are not read at all except `Content-Length`),
URL fragments, credentials inside an address (`https://user:password@host`), data and blob addresses.

**Hidden** (replaced by `[hidden]`):

- the value of a query parameter whose name contains token, key, secret, pass, pwd, auth, session, code, otp, signature, credential,
  jwt, bearer, csrf, xsrf or cookie (any case, also when the name is URL-encoded);
- any exact occurrence of a credential the run used (passwords, authenticator secrets, API tokens, the auth header and its value,
  the named test accounts' secrets), also URL-encoded, form-encoded or JSON-escaped, in addresses and in console text;
  the script learns them from its own environment variables, the platform from the run;
- in console text and paths: bearer tokens, JWTs, `Cookie:` and `Set-Cookie:` lines, `password=...` / `"token": "..."` pairs, well-known
  key formats (GitHub, Stripe, AWS, Google, Slack), and long hex or base64-looking strings (32 characters or more with a digit; UUIDs are kept).

Masking happens before shortening, so a secret cut in half by the 2 KB limit cannot survive. Masking twice changes nothing.
Both ends use the same code (`src/engine/evidence/capture.ts`), so the script and the platform cannot disagree.

## Limits

- At most **300 requests** and **200 console lines** are kept (2 KB per message). When there are more, answered requests with a
  good status and plain log lines are dropped first, oldest first, so failures survive. The counts say how many there really were
  and the page says so.
- The stored file is capped at 600 KB.
- A secret shorter than 4 characters is not masked by exact match (query values by parameter name are still hidden). Usernames and
  e-mail addresses are not treated as secrets. A secret in an unexpected shape inside free console text (a short random token with
  no `token=` label) can only be found by exact match against the run's credentials.
- Hiding by parameter name is deliberately broad: a parameter named `keycode` or `promo_code` is hidden too.
- Only the main page and the pages it opens are recorded. Requests made by a web worker or a service worker are not.
- Requests that are still running when the test fails are listed as "No answer yet".
- Playwright's own trace (`trace.zip`, the "detailed trace" download) is a separate artifact with full network details. See
  "Traces without the run's secrets" below.
- **API tests**: not covered. They already record each request's method, path and status as steps. **Mobile tests**: not covered.
- Evidence is stored with the execution in the artifact store, next to its screenshot, and follows the same lifecycle as the screenshot; there is no separate retention setting. The `ai-test` command's evidence folder does not include it.

## Traces without the run's secrets

A trace of a failed test keeps what the test typed and what the browser sent and received. A check of a real Playwright trace found the
password in the action log (the `fill` call, its title and its log), in the page snapshot (the password field's value), in the network
log (the form body, the `Authorization` header, a header the page echoed), in response bodies and in the error-context attachment.

Every text part of a trace is now masked with the run's secrets before the trace is kept or sent (`src/engine/evidence/trace-scrub.ts`):

- **Which secrets.** The run's password, authenticator secret and API token, those of its named accounts, the auth header and its value,
  the base64 of a Basic sign-in, the values of a saved sign-in, and an environment variable whose name says it is a secret (ending in
  `PASSWORD`, `SECRET`, `TOKEN`, `API_KEY` and the like). Other environment variables are plain settings and stay in the trace as they are
  (the runner's own log masks every variable, as a precaution for text that is only read by people). Each secret in the forms a trace
  carries it in: exact, URL-encoded, form-encoded (as a browser sends a form and `URLSearchParams` writes it: `! ' ( ) ~` escaped too and
  `+` for a space), the strict RFC 3986 form many HTTP libraries send, each also with lower-case hex, JSON-escaped once and twice,
  HTML-escaped, `encodeURI`'s form and base64.
- **How.** Each value is replaced with `[hidden]`, in one pass, so a secret that is part of the word itself (such as `hidden`) is masked
  like any other. A value made only of digits is replaced with as many 9s (8s when it is all 9s) instead, so a number in the trace's JSON
  stays a number and the viewer still opens it.
- **Where.** On the computer that ran the test: a runner cleans each trace before it uploads it (`src/agent/task-runner.ts`), and a run on
  the platform itself cleans it before it is stored (`engine/validation/runner.ts`, `mobile-runner.ts` for Taqwright's one-file HTML trace).
  The platform cleans a runner's trace again when it takes the result (`agent-services.ts`, `collect`), which covers runners that are
  older than this change.
- **What is kept.** Pictures (screencast frames, screenshots), fonts and every part without a secret keep their original bytes and names,
  and the trace opens in Playwright's trace viewer as before. Playwright names a resource after the sha1 of its content
  (`resources/<sha1>.dat`); that name would let anyone with the trace test a guessed password with one hash. So a resource that is masked
  is renamed to the sha1 of its cleaned content, and every reference to it in the action and network logs is rewritten in the same pass
  (two bodies that differed only by a secret become one part). While masking, the references to the trace's own parts (resource sha1s,
  screencast frame names) are set aside, so a short secret that matches inside one does not break it.
- **When a trace is not kept.** If a secret is found in a part that is not text, or the archive cannot be read, or it declares more than
  the limits (20,000 parts, 64 MB a part, 256 MB in all; a one-file HTML trace up to 256 MB), or a part unpacks to more or less than it
  declares or with the wrong checksum, the trace is not sent and not kept. The run says so: a line in the run's events and a note on the
  result (runner), or a `runner_trace_withheld` event (platform). On a store that is not the platform's own disk, a runner's upload is
  replaced by its cleaned copy; if that write fails, the upload is deleted rather than kept for a day as it came.
- **Without holding up the platform.** The platform's API and its dispatch worker are one process, and it cleans every trace a runner sends.
  The archive is read from its central directory; each part is unpacked and packed again by `node:zlib` on its thread pool (only the parts
  that changed are packed again), and the masking gives way to other work every few milliseconds. One trace is cleaned at a time per
  process. Measured on the development machine with a trace of 60 MB of text (35 MB packed) that needed masking: before, the event loop was
  blocked for 4.0 s; now its longest pause was 71 ms (the whole clean takes about 6 s, in the background).
  `tests/trace-scrub-unit.test.ts` checks the longest pause stays under 400 ms for 48 MB of text.

Limits: masking is by known value of at least 4 characters. A value the test made itself (a one-time code from the authenticator secret, a
password a code script keeps in its own source), a secret transformed some other way, and anything inside a compressed part (a zip or
gzip body the application served) are not found. The failure screenshot and video are pictures: a password field is drawn as dots (two
passwords of the same length give the same picture; `tests/runner-trace-secrets.test.ts`), but a secret shown as text on the page, or
typed into a field that is not a password field, stays visible in them. A secret that looks like a number but is not only digits (`-1234`,
`12.50`), or one equal to a JSON word (`true`, `null`), becomes `[hidden]` where it stands outside a string too, so that JSON line no longer
parses: the trace still opens, without that step's details. A secret made of digits also changes the numbers it is part of (a timestamp,
a size). A trace someone already downloaded, or one stored before this change, is not changed.

## Files

`src/engine/evidence/` (recorder source and redaction `capture.ts`, strict schema and masking `model.ts`, sentences `summary.ts`),
`src/platform/evidence-read.ts` (reading and presenting), `src/platform/routes/evidence.ts`, the hook in
`src/engine/generators/playwright.ts`, collection in `src/engine/validation/runner.ts`, the UI in `web/src/features/evidence/`.
Tests: `tests/evidence-unit.test.ts` (redaction, schema, recorder, sentences, no browser), `tests/evidence.test.ts` (real runs, API,
issues, report, the secrets sweep, standalone script), `tests/evidence-ui.test.ts` (browser journey), plus a sentinel in
`tests/secret-leak.test.ts`. Traces: `src/engine/evidence/trace-scrub.ts`; `tests/trace-scrub-unit.test.ts` (every form and part, refusals,
the runner's upload, form encoding, `hidden`, digits, parts that lie about their size, the event loop, variables, renamed resources and
their references, a short secret inside a sha1 or a frame name),
`tests/runner-trace-secrets.test.ts` (a real run on the real agent program, an older runner, a store whose write fails, a real Chromium form
sign-in with `! ' ( ) ~` and a space in the password, loaded afterwards by Playwright's own trace loader, password-field pixels), and `tests/secret-leak.test.ts`, which unpacks every stored
and scratch trace and searches each part. The form sign-in and the real run are checked by `tests/fixtures/secret-oracle.ts`, which
decodes each part (percent and form decoding, HTML entities, JSON escapes, UTF-16) and looks for the plain value, instead of reusing the
cleaner's own list of forms.

## On the test page

A failing test, or one that needs a look, shows a **What failed** block (see `ux-explain.md`): the failed step in plain words, Expected and Got from the `expected`/`actual` fields, links to the screenshot, recording and trace that still exist, the cause when `failure.kind` names one, and the actions that exist (*Edit steps*, *Switch to code*, *Apply the repair*, *Quarantine*, *Run again*).
