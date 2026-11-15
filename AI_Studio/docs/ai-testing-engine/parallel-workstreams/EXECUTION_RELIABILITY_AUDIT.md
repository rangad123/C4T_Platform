# Workstream 2: browser and test execution reliability

Read-only audit, 2026-11-14, `main` = 7a164a8 with the Phase 1 work uncommitted in the tree. Nothing was run: no tests, browsers, servers
or builds, and nothing touched the running benchmark. Every claim below comes from reading the code. Line numbers refer to the files as
they are now. Playwright claims refer to the installed `playwright` / `playwright-core` 1.65.0 in `AI_Studio/node_modules`.

Labels: **Verified** (read in the code; for library behaviour, read in the installed library), **Partial** (exists but incomplete),
**Missing**, **Suspected** (follows from the code but needs a run to confirm), **Proposed** (a change this document recommends).

Scope rule of this audit: test generation, assertions and repair stay as they are. Anything that would change them is listed
under "excluded" with the reason.

---

## 1. Summary

1. **JS-submitted sign-in (Verified root cause).** `login()` in `src/engine/discovery/auth.ts` judges the result about one tick after the
   submit click. Its "wait" (`settle()`, `src/engine/discovery/browser.ts:280-283`) only waits for load states the current document has
   already reached, so it returns at once. Playwright's click waits only for navigations requested *during* the click. A form whose
   script `await`s a `fetch` and only then sets `location.href` therefore still shows its password field when `signedIn()` looks
   (`auth.ts:143-148`), and the sign-in is reported as wrong credentials. The browser often *did* sign in (the API set the cookie).
   The late `location.href` then interrupts the crawler's first `page.goto` ("interrupted by another navigation"), and discovery records
   no loadable pages.
2. **CSP inline-style false positive (Suspected, strong code evidence, and a different cause than the one recorded).** The note in
   `BENCHMARK_METHODOLOGY.md` blames the caret-hiding style added for screenshots. In Chromium that cannot be the cause: Playwright hides
   the caret through CSSOM (`element.style.setProperty`), which CSP does not govern, and the `<style>` element it can inject is
   switched off for Chromium. The likely source is the **failure video's step-title overlay**, which the runner turns on
   (`src/engine/validation/runner.ts:157`, `show: { test: { level: "step" } }`). Playwright builds that overlay as markup with a `style="…"`
   attribute (`node_modules/playwright/lib/index.js:793-806`) and inserts it with `innerHTML`. On a page with `style-src 'self'`, that
   attribute is refused, and the refusal is logged as a console error. The health collector, installed before the first step, counts
   it, and `healthFinding` turns it into a `NEEDS_REVIEW` finding.
3. **Other gaps.** The crawler has no guard against interrupted navigations, although the security module already has one. No web
   session notices a crashed page or a disconnected browser. The interpreter and the rendered script wait differently after
   `navigate`. There are three sign-in routines with three different ways of waiting. The benchmark controller cannot run the
   `BENCH_LOGIN=js` variant it is documented to measure.
4. **Minimal fixes (Proposed).** C1: wait for the sign-in outcome inside `auth.ts`. C2: retry an interrupted navigation once in
   `crawler.ts load()`. C3: confirm the CSP cause, then drop only the step-title part of the video overlay. C4: record crashes and
   disconnects as session events. C5: a `--login js` controller option, which is Phase 1's file. None of these changes generation,
   assertions or repair. All of them touch `src/engine`, so they land **after the baseline finishes**, because the controller records
   `src/engine` dirtiness.

---

## 2. Part A: the JS-login failure

### 2.1 The application side (bench apps, read-only)

- `BENCH_LOGIN=js` renders `<form data-api="/api/login" data-next="…">` instead of a POST form
  (`examples/bench-shop/server.mjs:323`, `examples/bench-rbac/server.mjs:250`).
- The page script (`bench-shop/server.mjs:424-440`, `bench-rbac/server.mjs:308-322`) calls `preventDefault()`, then
  `await fetch(api)`, then `await res.json()`, and only then sets `location.href = f.dataset.next`. On an error it writes the message into
  a `role="alert"` paragraph and the password field stays.
- The session cookie arrives on the `fetch` response, so a successful API answer signs the browser in before any navigation happens.

### 2.2 What the engine does, step by step (Verified)

| # | Question from the prompt | Answer | Where |
|---|---|---|---|
| 1 | How is form submission detected? | It is not. The engine clicks the first visible submit button, or the first button matching `SEND_FORM`, or presses Enter in the password field. A failed click is swallowed (`.catch(() => undefined)`). No request, navigation or DOM change is tied to the click. | `auth.ts:121-126` |
| 2 | How is navigation awaited? | `settle(page, 8_000)` = `waitForLoadState("domcontentloaded")`, then `waitForLoadState("networkidle", {timeout})`. Playwright returns at once from both when the *current* document already fired them ("not waiting, … event already fired", `playwright-core/lib/coreBundle.js:62391-62393`). The engine's own comment says the same (`browser.ts:137-140`: "once a page reached it, waiting for it returns at once"). The click itself waits only for navigations requested while the click runs (`waitForSignalsCreatedBy`, `coreBundle.js:24827-24840`). A `location.href` set after an awaited `fetch` falls outside that window. | `auth.ts:127`, `browser.ts:280-283` |
| 3 | Does it assume full-page navigation? | Yes, in effect. The only case that works is a navigation started synchronously by the click: an HTML POST, which is why `BENCH_LOGIN=html` passes (`tests/bench-apps.test.ts` "the engine's own sign-in … succeeds"). | `auth.ts:125-127` |
| 4 | Are SPA transitions supported? | Only by luck. `signedIn()` accepts any URL change (`page.url() !== before`), so a `pushState` counts if it has already happened when the check runs. Nothing waits for it. | `auth.ts:145` |
| 5 | Asynchronous JS submission? | Not handled. The one-time-code step has the same flaw: after the code is submitted it calls `settle(page, 8_000)` and checks at once (`auth.ts:62-66`). The first check, `hasPasswordField`, also runs too early when the code step appears only after an async request, so the code step is never seen (`auth.ts:48`). | `auth.ts:46-68`, `:129` |
| 6 | Are network requests observed? | Not by `login()`. The session counts in-flight requests (`browser.ts:136-145`, `179-180`, `189`) and has `quiet()`, but `login()` never calls it. `NetworkInterceptor` (`network.ts`) only records API shapes for discovery. | `browser.ts:141-145` |
| 7 | How is success established? | `signedIn()`: false while any visible password field remains; true if the URL changed; otherwise true if the body text matches `/(log|sign)\s?out|my account|dashboard|profile|welcome/i`. | `auth.ts:143-148` |
| 8 | Is the authenticated state checked? | No. No cookie, storage or signed-in request is checked. The result always claims the mechanism `"session-cookie"` (`auth.ts:135`), whether or not a cookie was set. A false *success* is possible: a signed-out page that says "Welcome" passes when the URL did not change. | `auth.ts:132-136` |
| 9 | Timeouts? | Context default 8 s, navigation 30 s (`browser.ts:100-101`). Submit click 5 s (`auth.ts:125`). `settle` "8 s" (`auth.ts:127`), which in practice is about 0 s here, as shown above. No overall sign-in deadline. | |

### 2.3 Exact reason for the premature evaluation (Verified)

`auth.ts:125-132`: click, then `settle()` (returns at once because the login page's own `domcontentloaded` and `networkidle` have already
fired), then `passOneTimeCode()` (returns `asked:false` because the password field is still there), then `signedIn()`. At that moment
the `fetch` to `/api/login` is usually still in flight and the password field is still visible, so the result is
`{ ok:false, error:"Login did not succeed with the supplied credentials" }` (`auth.ts:136`).

### 2.4 Why discovery then finds nothing (Verified chain; final event text Suspected until reproduced)

1. `orchestrator.ts:311-315` records `loggedIn:false` and emits `auth_failed`. No `landingUrl` is kept, so no seed URL is added
   (`orchestrator.ts:324`). No `relogin` is set up, because it requires `authState.loggedIn` (`orchestrator.ts:327`).
2. `crawl()` starts with `sitemapUrls()` and then `load(page, startUrl)` (`crawler.ts:446-453`). Meanwhile the page script finishes
   its `fetch` and sets `location.href`. The `page.goto` is overtaken ("interrupted by another navigation") and throws.
3. The `catch` at `crawler.ts:678-686` records `page_failed` and skips the start URL. With nothing seeded, the queue may hold only
   sitemap entries, and those can hit the same race. Result: no loadable pages, matching the observation recorded in Phase 1.
4. The same `login()` is used for every test account in the access survey (`identity/access.ts:188-192`). With a JS login, each
   account is dropped with `access_survey_skipped`, so the access-control checks lose all their accounts.
5. The person is told "Login failed: Login did not succeed with the supplied credentials" (`orchestrator.ts:315`), which points to the
   wrong cause.

### 2.5 The repo already has the right pattern twice

| Sign-in routine | How it waits after submit | Where |
|---|---|---|
| Discovery `login()` | `settle()`, effectively no wait | `auth.ts:125-127` |
| Run-time renewal of a saved sign-in | `password.waitFor({ state: "hidden", timeout: 15_000 })`, then reload and re-check | `engine/auth/run-session.ts:84-88` |
| Generated signed-in checks | `assert hidden` on the password field (auto-retries up to the 8 s `expect` timeout) | `engine/identity/signed-in.ts:126` |
| Interrupted start-page load | retry once from `about:blank` on "interrupted by another navigation" | `security/assessment/discover.ts:432-441` |
| Recorder start page | counts main-frame navigation requests and tolerates the first load being replaced | `engine/recorder/session.ts:369-378` |

The fix reuses these approaches. No new mechanism is needed.

---

## 3. Current browser synchronization strategy (Verified)

| Layer | After an action | Navigation | Default timeouts | Where |
|---|---|---|---|---|
| Discovery crawl | `goto(domcontentloaded)` + `settle` (networkidle ≤ 4 s, effective because a fresh document resets it); probes wait 150-300 ms fixed | `load()` uses `goto`, or `reload` for hash-only changes | context 8 s, navigation 30 s | `crawler.ts:446-453`, `256-262`, `357-358`, `477-478`, `517` |
| Discovery sign-in | `settle` (no effective wait, §2.2) | none awaited | click 5 s | `auth.ts` |
| Authoring (AI writes a test) | `executeStep`, then `settle(1_500)` (usually immediate), then `session.quiet()` (250 ms, then until the session's in-flight count is 0, ≤ 1.5 s) | `navigate` = `goto(domcontentloaded, 30 s)` | step 6 s (`interpreter.ts:115`); repair replay 5 s (`author.ts:695`) | `author.ts:286-294`, `341-344`; `interpreter.ts:142-145` |
| Interpreter click | no wait of its own; relies on the next locator's auto-wait | popup: waits for the `popup` event (≥ 10 s) | 6 s | `interpreter.ts:146-156` |
| Rendered script | Playwright auto-wait; `test.step` per step | `page.goto(url)`, default `waitUntil: "load"` | test 60 s, expect 8 s, action 10 s, navigation 30 s, `retries: 0` | `generators/playwright.ts:59`, `359-360`; `validation/runner.ts:139-165` |
| Health checks | `waitForLoadState("load")`, then networkidle ≤ 5 s | the interpreter reloads once to install the collector | | `health/checks.ts:100-104`, `232-245` |
| Validation re-runs | scheduled re-run only when `retryFailures` > 0 (default 0); new tests may be re-run for flakiness | | | `validation/validator.ts:244-259`, `390-402` |

---

## 4. Part B: other execution weaknesses

| # | Area | Finding | Label | Evidence |
|---|---|---|---|---|
| B1 | Client-side routes | `probeClientRoutes` clicks, waits a fixed 300 ms, then compares the URL. A route change that takes longer (lazy chunk, data first) is missed. `replayClickPath` polls up to 3 s. | Verified code; impact Suspected | `crawler.ts:477-479`, `517` |
| B2 | Late self-navigation | A page that moves itself after load (JS redirect, a late `location.href` after an action) makes the next `page.goto` throw. The crawler records `page_failed` and does not retry. The security crawl and the recorder do handle this. | Verified | `crawler.ts:446-453`, `678-686` vs `security/assessment/discover.ts:432-441` |
| B3 | Interpreter vs script: navigate | The interpreter loads to `domcontentloaded`; the rendered script to `load`. A page with one slow subresource passes while authoring and can hit the 30 s navigation timeout in the script. The file header says the two "must stay semantically aligned" (`interpreter.ts:5-6`). | Verified divergence; impact Suspected | `interpreter.ts:144`, `generators/playwright.ts:59` |
| B4 | Authoring sync after a click | `settle()` after a step usually returns at once (§2.2). `quiet()` covers most async work, but its in-flight counter can touch 0 between a `fetch` finishing and the `location.href` request starting. If 250 ms have already passed, the snapshot is then taken mid-navigation, and `ariaSnapshot` returns "(accessibility snapshot unavailable)" or the old page. | Suspected | `browser.ts:141-145`, `270-277`; `author.ts:289-290`, `341-344` |
| B5 | In-flight counter | One counter for every page of the session (tabs included). A streaming or long-poll response holds `quiet()` to its full limit. Requests of a closed or crashed page are never subtracted. | Verified code; impact Suspected | `browser.ts:136-145`, `179-180`, `189` |
| B6 | Dynamic content | The crawler relies on networkidle ≤ 4 s. Pages that poll or hold a WebSocket never reach it and always pay the 4 s. That costs time, not correctness. | Verified | `browser.ts:280-283` |
| B7 | Dialogs | Session: every dialog is dismissed unless a `dialog` step armed an answer; each one is recorded in `SessionEvents.dialogs`. Script: Playwright's default dismissal. The two agree. | Verified (no gap) | `browser.ts:45-67`, `173-178`; `interpreter.ts:112-123`, `175-180` |
| B8 | Overlays / consent | `addLocatorHandler` for consent banners and overlays named in the notes, the same in session and script (`tests/finish-flows.test.ts`). | Verified (no gap) | `web/interruptions.ts:50-64`, `67+` |
| B9 | Form validation | The crawler never submits forms (`UNSAFE_NAME`, Phase 0). Browser-native validation bubbles (`required`) have no DOM text, so only `accessibleErrorMessage`/attribute checks can see them. No failure seen in logs. | Partial / Suspected | `crawler.ts:310`; `interpreter.ts:349-350` |
| B10 | Dropdowns / autocomplete | `select` handles native `<select>` only (`selectOption`). Custom comboboxes need click steps. Conditional-field probing tries native selects only. No logged failure. | Partial | `interpreter.ts:194-196`; `crawler.ts:278` |
| B11 | Failed requests | The session records own-origin HTTP ≥ 400 and network failures, minus aborted ones, as `problems` that feed the authoring evidence. The health collector does the same for scripts. | Verified (no gap) | `browser.ts:183-193`; `health/checks.ts:70-81` |
| B12 | Retries | No automatic retry in scripts (`retries: 0`). Validator re-runs are opt-in (`retryFailures`, default 0). Authoring retries only the first navigation, up to twice, on network-looking errors. | Verified | `runner.ts:145`; `validator.ts:123`, `247`; `author.ts:301-306` |
| B13 | Browser / page crash | Discovery, authoring, healing and the objective agent's `BrowserSession` listen for neither the page `crash` event nor the browser `disconnected` event. Only the recorder (`recorder/session.ts:330`, `362`) and the sign-in capture (`auth/capture.ts:118`) do. After a crash, every queued URL becomes a separate `page_failed`. A crashed authoring step reaches the model as an ordinary step error. In script runs, a crash is a plain `failed` run that goes on to repair; only phone runs have an infrastructure class (`validator.ts:485`). | Verified Missing (detection); downstream Suspected | `browser.ts:155-196`; `crawler.ts:678-686`; `validator.ts:481-499` |
| B14 | Reloads | The interpreter's first health assert reloads the page to install the collector (`health/checks.ts:232-245`). On a page reached by a POST or holding unsaved state, the reload repeats or loses it. Authoring only; scripts install the collector up front (`playwright.ts:364`). | Verified code; impact Suspected | as cited |
| B15 | Session expiry | Crawl: one re-login on 401 or on a redirect to a password page (`crawler.ts:596-604`), but only if the first sign-in succeeded. Script runs: the setup renews a saved sign-in (`run-session.ts:56-98`). Authoring contexts start signed out on every scenario and sign in through steps (`author.ts:262`). | Partial | as cited |
| B16 | Multiple tabs | New pages are watched and reported (`browser.ts:126`, `158`). Authoring follows the latest popup (`author.ts:345-350`); scripts use the latest popup. The in-flight counter is shared (B5). | Partial | as cited |
| B17 | Screenshots / traces / video | Authoring traces each scenario (kept only when blocked, `author.ts:281`). Script runs keep trace (DOM + ARIA + screen), video and a screenshot on failure (`runner.ts:153-157`). Runs that use the saved sign-in write `trace: "off"` (`run-session.ts:20-21`): a deliberate secrecy rule, and an evidence gap for WS3. | Verified | as cited |
| B18 | CSP false positive | See §5. | Suspected (strong) | |
| B19 | Benchmark cannot measure the JS variant | `BenchApp.start` spawns the app without `BENCH_LOGIN` (`src/eval/bench/apps.ts:86-88`). The controller and CLI have no option for it, although the methodology says it is "measured separately". Only `src/eval/bench/verify/app.ts:34` (tests) accepts it. | Verified Missing | as cited |
| B20 | Explorer live view under strict CSP | When someone watches, the frame capture covers secret fields by appending a `<style>` element and later restoring `style` attributes with `setAttribute` (`frames/shoot.ts:100-104`, `122-126`). Under `style-src 'self'` both are refused and logged as console errors. That error enters `SessionEvents.problems` (`browser.ts:181`), and from there the authoring evidence (`author.ts:346`). It is the engine's own side effect, shown to the model as page evidence. | Suspected | as cited |

---

## 5. The CSP inline-style false positive

**Where console errors are collected (Verified).**

- Scripts: `installHealthCollector` (`health/checks.ts:52-85`) is installed before the first step (`generators/playwright.ts:364`).
  Every `console` message of type `error` is kept unless it matches `HEALTH_NOISE_TEXT` / `HEALTH_NOISE_URL` (`:46-47`, `61-69`). Nothing
  excludes CSP reports.
- `noConsoleErrors` fails with "N JavaScript error(s) …" (`:142-147`).
- `deterministicFinding` → `healthFinding` (`validator.ts:506-509`) → `NEEDS_REVIEW` (`:497-498`). The benchmark counts that as a
  finding, which is a false positive on a clean app.

**Candidate causes, checked against the installed Playwright 1.65.0.**

| Candidate | Injects a CSP-governed inline style in Chromium? | Evidence | Verdict |
|---|---|---|---|
| Screenshot caret hiding (`caret: "hide"`) | No: CSSOM `element.style.setProperty("caret-color", …)` | `coreBundle.js:23092-23104` (`inPagePrepareForScreenshots`) | Ruled out for Chromium |
| Screenshot animation sync `<style>` | Only when `shouldToggleStyleSheetToSyncAnimations()` is true. It is `false` for Chromium (`crPage.ts`, `coreBundle.js:39284`), true for WebKit and BiDi | `coreBundle.js:23058-23063`, `23285` | Not Chromium. A possible cause on WebKit variants |
| Screenshot `style` option | Only if the option is passed; the generator passes none (`playwright.ts:248`) | | Ruled out |
| Highlight glass pane | Uses `adoptedStyleSheets` (constructed sheet) when available | `coreBundle.js` around `x-pw-glass` | Not governed by CSP |
| Action decorations (`show.actions`) | `style.cssText` (CSSOM) | `_createScreencastDecoration`, `showActionTitle` | Not governed by CSP |
| **Step-title overlay (`show.test`)** | **Yes**: markup `<div style="white-space: nowrap; …">` inserted with `element.innerHTML` (`addUserOverlay`). It is re-added after every new document and on every `test.step` begin and end | `playwright/lib/index.js:754-806`; `coreBundle.js` `Overlay._doAdd`/`addUserOverlay` | **Likely cause** |
| Explorer frame masking (engine) | Yes, but authoring/explore only and only while watched (B20) | `frames/shoot.ts:100-126` | Secondary; not in script runs |

**Why it fits the observation.** Video is recorded for every run and kept only on failure (`retain-on-failure`, `runner.ts:157`), so the
overlay is present in passing runs too. Each generated step runs inside `test.step` (`playwright.ts:359-360`), so the overlay is
rewritten after the collector is installed. Identical messages are de-duplicated (`checks.ts:143`), which explains exactly
"1 JavaScript error". The overlay does not exist in the authoring session (`BrowserSession` sets no `show`), so the same check passes
while it is being written and fails in the script.

**Reproduction needed (Proposed R8, §7).** Run one generated health spec against a strict-`style-src` local fixture three times: (a) the
current config; (b) `configFor(..., { video: false })`, the existing switch at `runner.ts:177`; (c) video with `show: { actions: {} }`
only. Expected: (a) fails with the CSP message, (b) and (c) pass. If (c) still fails, the action decorations are involved too, and the
choice moves to (b).

**Rejected fixes.**

- Filtering CSP messages in the health collector would hide real CSP violations in customer apps. That weakens an assertion.
- `bypassCSP: true` changes how the app behaves under test.
- Matching Playwright's overlay text is fragile across versions.

---

## 6. Part C: keeping executor, observer, assertion and repair apart

| Role | Today | Changes here |
|---|---|---|
| Executor (acts) | `auth.ts` `login()`, `crawler.ts` `load()`, `interpreter.ts` `executeStep`, the rendered script | C1 (sign-in waits for its outcome) and C2 (interrupted-navigation retry) change only *when* the executor judges or re-issues the same action. No new action is taken, and nothing is clicked or submitted that was not before. |
| Observer (records) | `BrowserSession.watch` → `SessionEvents` (`browser.ts:155-196`); health collector; evidence recorder (`evidence/capture.ts`); trace and video | C4 adds `crashed` / `disconnected` to `SessionEvents`. C3 removes an observer artefact (the overlay) that changes the page under test. |
| Assertions (judge) | `executeAssert`, the health helper, `deterministicFinding` | Untouched. No filter is added to `noConsoleErrors`. |
| Repair | `det-repair.ts`, `repair.ts`, `healing/*` | Untouched. Routing crashed web runs away from repair (B13) changes repair routing, so it is deferred until decided. |

---

## 7. Part D: minimal changes, tests, acceptance criteria

### 7.1 Changes (all Proposed)

**C1. Sign-in waits for an outcome. File: `src/engine/discovery/auth.ts` only, about 40 lines.**

Add a small `afterSubmit(session, preUrl, deadlineMs = 15_000)` helper and use it in place of `settle()` at `auth.ts:127` and
`auth.ts:64`. It polls every 100 ms until one of these is true:

- no visible password field (or, for the code step, no code field);
- the URL changed;
- a code field appeared;
- the session has been quiet for 1 s after at least one request it started (this covers a wrong password shown in place, so failures
  are not slowed by the whole deadline);
- the deadline passed.

Then, if a main-frame navigation started after the click (counted the way `recorder/session.ts:369-372` counts them), it waits for that
navigation's `domcontentloaded`, and finally `session.quiet()`. Only then do `passOneTimeCode` and `signedIn` run, unchanged.

In `navigateToLogin` (`auth.ts:79-81`), after clicking a "Log in" link, wait up to 5 s for a visible password field instead of checking
at once.

Optional, same file: report `"session-cookie"` only when `context.cookies()` changed for the app's origin. This makes the result say
what was observed. It is not a success condition, because token-in-storage apps set no cookie.

The HTML path is unchanged in outcome: the password field is gone at the first poll.

**C2. Interrupted navigation in the crawl. File: `src/engine/discovery/crawler.ts`, `load()` (`:446-453`), about 8 lines.**

On "interrupted by another navigation", go to `about:blank` and `goto` once more, exactly like `security/assessment/discover.ts:432-441`.
Share that helper rather than copying it, if WS1 agrees on its place (see §8).

**C3. CSP false positive. File: `src/engine/validation/runner.ts:157`, one line, only after R8 confirms the cause.**

Drop `test: { level: "step" }` from `video.show` and keep `actions`. If R8 variant (c) fails, use `video: "off"` behaviour for that
overlay instead. To decide: failure videos lose the step-title caption. The step numbers stay in the trace and in the evidence
recorder (`evidenceStep`, `playwright.ts:359`).

**C4. Crash and disconnect become observed events. Files: `src/engine/discovery/browser.ts` (`watch`, `SessionEvents`) and `crawler.ts` loop, about 20 lines.**

`page.on("crash")` and `browser.on("disconnected")` set `events.crashed` and add a plain problem line. The crawl stops with one
`discovery_browser_crashed` warning instead of N `page_failed` events. Authoring passes the event through as it already passes
`problems`. Classifying crashed script runs as infrastructure, outside repair, is **excluded** (repair routing).

**C5. Benchmark option to run the JS variant. Phase 1 files: `src/eval/bench/apps.ts:86-88`, `cli.ts`, `record.ts`.**

Pass `BENCH_LOGIN` through and record it in the result. This is Phase 1's code, so it goes to the Phase 1 owner after the baseline; this
workstream only asks for it.

**Excluded, because they would change generation, assertions, repair, or what a recorded test does:**

- Waits after an interpreter click (B4). These change which steps get recorded.
- Aligning `goto` `waitUntil` between interpreter and script (B3). This changes rendered scripts or recording.
- Filtering CSP reports from `noConsoleErrors`.
- An infrastructure class for crashed web runs (B13).

Record these and revisit them.

### 7.2 Regression test scenarios (Proposed)

Put them in new browser-tier test files, for example `tests/signin-async.test.ts` and `tests/crawl-late-navigation.test.ts`. Do not use the
Phase 1 files `tests/bench-apps.test.ts` and `tests/bench-clean.test.ts`. They use `startBenchApp(app, port, "none", token, "js")`
from `src/eval/bench/verify/app.ts:34` (read-only use) on ports outside the benchmark's 5291+ range, plus small local fixtures for cases
the bench apps lack. Use no AI provider.

| Id | Scenario | Expected after the fix |
|---|---|---|
| R1 | `login()` on bench-shop and bench-rbac, `BENCH_LOGIN=js`, seeded accounts | `ok:true`, `loginPath:"/login"`, `landingUrl` ends `/` (shop) or `/notes` (rbac). A following `goto("/orders")` or `goto("/notes")` is not redirected to `/login`, and it throws no "interrupted by another navigation". |
| R2 | Same, wrong password | `ok:false` within 5 s (quiet-after-request exit), error unchanged |
| R3 | Same, `BENCH_LOGIN=html` | Same results as today's `bench-apps` test, and not more than 1 s slower |
| R4 | `login()` then `crawl()` (no AI, fake `EngineContext` as in the crawler tests), JS variant | At least the pages the HTML variant reaches, no `page_failed` for the start URL, the seed is the landing URL |
| R5 | `surveyAccess` with the bench-rbac accounts, JS variant | Every account has a reach. No `access_survey_skipped`. |
| R6 | Local fixture variants: (a) `fetch` answered after 1.5 s, then `location.href`; (b) `pushState` and in-place render, no document load; (c) token in `localStorage`, no cookie; (d) one-time-code step shown after an async request (pattern of `tests/totp-login.test.ts`); (e) a signed-out page that says "Welcome" and keeps the form after a failed submit | (a)-(d) `ok:true` (with the code step passed in d). (e) `ok:false`. |
| R7 | Fixture page that sets `location.href` 500 ms after load; crawl it, then a second page | Both visited, no `page_failed` (C2) |
| R8 | Strict `style-src 'self'` fixture with no inline style; one generated health spec run through `runScripts` under (a) the current config, (b) video off, (c) `show.actions` only. Control page with a real inline `style` attribute. | Before C3: (a) fails with the CSP line, (b) passes. After C3: the clean page passes, **the control page still fails** `noConsoleErrors` (proves nothing was suppressed). |
| R9 | Crash during a crawl (`page.goto("chrome://crash")` in a test-only fixture route) | One crash event and the crawl ends. Not N `page_failed`. |
| R10 | Existing suites unchanged: `totp-login`, `hard-signin`, `crawler-discovery`, `crawler-seeds`, `finish-flows`, `health`, plus `bench-apps` and `bench-clean` once Phase 1 commits them | All pass |

### 7.3 Acceptance criteria

- R1-R10 pass. R1 and R4 pass three times in a row (no flake).
- A benchmark run with `BENCH_LOGIN=js` (after C5) shows `auth_succeeded`, and pages and tests discovered are within the run-to-run
  spread of the HTML variant.
- An HTML-variant benchmark run after C1-C4 gives detection, precision and false-positive numbers within the spread the baseline repeats
  establish. Any difference is attributed before merging.
- No change to any prompt source hash (`PROMPT_SOURCES`, `src/eval/bench/record.ts`), generator output, assertion code or repair code.
  This can be checked by diff.
- A wrong-password sign-in fails in ≤ 5 s on the fixtures. No sign-in waits longer than 15 s.

---

## 8. Dependency and conflict analysis

### 8.1 Matrix

Columns:

1. Independent of Phase 1?
2. Needs Phase 1 database models?
3. Needs Phase 1 app intelligence?
4. Changes generation or repair?
5. Changes benchmark execution?
6. Can change customer results?
7. Conflicts with another workstream?

| Change | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| C1 sign-in waits | Yes (code). Land after the baseline: `src/engine` dirty flag | No | No | No | HTML variant: same outcome, small extra time. JS variant: from failing to working | **Yes**: JS-login customers go from "Login failed" to signed-in exploration (more pages and tests, access survey works). Wrong credentials fail up to about 5 s later. | WS1: the access survey and cross-user tests depend on it (benefit). WS3: the sign-in outcome is a natural first action event. |
| C2 interrupted-navigation retry | Yes, after the baseline | No | No | No | Only if a bench page self-navigates (none does on load) | Yes, slightly: pages that failed with this error now load | WS1 owns the existing helper (`security/assessment/discover.ts`); agree where the shared one lives |
| C3 drop the step-title overlay | Yes, after R8 and after the baseline | No | No | No | Bench apps allow inline styles, so no result change; failure videos lose captions | **Yes**: strict-CSP customer sites stop getting false `noConsoleErrors` findings | **WS3**: failure video content (an evidence change). Needs WS3 agreement and a decision. |
| C4 crash/disconnect events | Yes, after the baseline | No | No | No (routing to repair unchanged) | Only on a crash | Messages only | WS3: adds to `SessionEvents`, which an action-event model would extend. Do it once. |
| C5 `--login js` option | **No**: Phase 1 files | No | No | No | Adds a mode; default unchanged | No | None |

### 8.2 Shared files (merge-conflict risk)

| File | Who else touches it | Risk |
|---|---|---|
| `src/engine/discovery/browser.ts` (`SessionEvents`, `watch`) | WS3 (browser observer, action events), WS1 (security crawl uses sessions) | High: agree on one event shape first |
| `src/engine/validation/runner.ts` (`CONFIG`) | WS3 (trace, video, evidence), WS4 (selecting tests to run) | Medium: C3 is one line |
| `src/engine/discovery/crawler.ts` | WS3 (per-page observation), Phase 2+ (exploration) | Medium |
| `src/engine/discovery/auth.ts` | WS1 (multi-account sign-in for cross-user tests) | Medium: WS2 should own it, and WS1 builds on C1 |
| `src/security/assessment/discover.ts` (`open`) | WS1 | Low if the helper is only moved after agreement |
| `src/engine/identity/access.ts` | WS1 | Low (WS2 does not edit it; it benefits from C1) |
| `src/eval/bench/apps.ts`, `cli.ts`, `record.ts` | Phase 1 | C5 belongs to Phase 1 |
| `tests/bench-apps.test.ts`, `tests/bench-clean.test.ts`, `vitest.fast.config.ts` | Phase 1 (uncommitted) | Do not edit; new test files only |

### 8.3 Order

1. **Now, read-only and no engine change:** write the R1-R9 test files, behind a skip until each fix lands, and run R8 (a)/(b)/(c) to
   confirm the CSP cause. R8 needs a browser, so run it only when it cannot compete with the benchmark for the machine, or on another one.
2. **After the baseline is written:**
   - C1 (highest value, single file);
   - then C2, together with WS1 on the shared helper;
   - then C4, together with WS3's event shape;
   - then C3 with WS3 agreement and a decision.
3. **Phase 1 owner:** C5, then a measured JS-variant benchmark run as the before/after record.

Complexity: C1 small to medium, C2 small, C3 trivial (after R8), C4 small, C5 small. Regression risk: C1 medium, because sign-in is on
every signed-in job; R3, R6e and R10 cover it. The others are low.
