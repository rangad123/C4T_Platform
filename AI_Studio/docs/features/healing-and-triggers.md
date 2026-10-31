# Repair suggestions for renamed controls, and runs after a deploy

Two separate features that both answer "what do I do when the application changes under my tests?"

- **Repair suggestions** (self-healing locators): when a web test fails because a button or field it looks for is
  gone, the platform checks whether the page now has one clear replacement and **suggests** it. Nothing changes until
  you press **Apply and run again**.
- **Deploy triggers**: let your deploy pipeline start a re-run of all tests the moment a release is live, ask for the
  result, and optionally be told when it is done.

---

## Repair suggestions

### What you see

Open a test that did not pass because an element could not be found. If the page offers exactly one clear
replacement you get a card above the test details:

> **We found a likely replacement for the “Add to cart” button**
> It is now “Add to basket” (high confidence)
> The “Add to cart” button is no longer on the page. The only close match is the button “Add to basket”, which means the same thing.
> Now: *button called “Add to cart”* → After applying: *button called “Add to basket”*
> **Apply and run again** · Dismiss

- **Apply and run again** changes that one step's locator (how the step finds its element), re-creates the test's
  script and runs the test again. If it passes, it is validated as usual. If it still fails, the application is what
  changed and the test shows that new failure.
- **Dismiss** closes the suggestion. The same suggestion is not made again for that test.
- A test with no clear replacement shows nothing extra: the failure is reported exactly as before.

Confidence is shown in words: **high** (the names read the same or mean the same), **medium**, or **low** (check it
before applying).

### What is, and is not, healed

Healing is **deterministic and uses no AI model** (it is free, repeatable and works with no model configured). It
never changes a test by itself.

A suggestion is made only when **all** of these hold:

1. The test is a web test written to follow a journey (generated from a scenario, imported or hand-written). The
   built-in checks (security, health, accessibility, speed, input handling, visual, access control) report what they
   find and are **never** healed, whatever the failure.
2. The step that failed could not **find** its element (a timeout waiting for it, or "element not found"). An element
   that exists but is hidden or disabled, a locator that matches several elements, a failing expectation (the cart
   says 0 items), a server error: all of those are results about the application and are never healed.
3. The old element is really absent when the page is examined, and exactly **one** element scores above the
   threshold. Two similar buttons (two “Add to basket” buttons for two products) mean the platform would be guessing,
   so it proposes nothing.
4. The suggested locator finds that one element on the live page (Playwright resolves it to exactly that element).

How the page is examined: the platform opens the application in a real browser, repeats the steps that came before the
failing one (like automatic repair does), then compares what the page offers now with the old locator by ranked
signals: same role and a similar accessible name, same test id, same label or hint text, same text, similar
id/class names. Names are compared by meaning, not only spelling: "cart" = "basket", "sign in" = "log in",
"Check out" = "Checkout". Names that **contradict** each other never match ("Add to cart" vs "Remove from cart", "Sign in"
vs "Sign up", "Accept" vs "Decline", "Item 1" vs "Item 2", "Save" vs "Do not save").

**A check is never made to pass by pointing it somewhere else.** A step that *checks* something (for example "the Add
to cart button is visible") may be healed only when it is about the state of a control (visible, enabled, disabled,
its text or value), the locator names a control (a button, link, field...) rather than a heading or message, and the
**unchanged** check passes on the replacement when the platform tries it. Checks about what the page says (a heading,
a message, a count, the address or title) are the claim being tested and are never healed.

### Applying a suggestion safely

Apply is refused (with a plain message) when:

- the test is not currently failed or needing review (a passing test has nothing to repair);
- the test has changed since the suggestion was made (the step is gone or now looks for something else): *stale*;
- the suggestion was already applied or dismissed;
- a run is in progress for the project (one job at a time).

### API

| Request | What it does |
|---|---|
| `GET /api/tests/:id/healing` | The test's suggestions (newest first) with `status` (`proposed`, `applied`, `dismissed`), `confidence`, `confidenceLabel`, `reason`, the old and new locator, plain-language descriptions, and `canApply` (with `blockedReason` when false). |
| `POST /api/tests/:id/healing/:pid/apply` | Applies it and queues a re-run. `202 { jobId, … }`; `409` when refused as above. |
| `POST /api/tests/:id/healing/:pid/dismiss` | Dismisses it. |

Suggestions are stored in the `healing_proposals` table (migration slot 12). A fresh failing run replaces the open
suggestion of that test with its own result.

### Limits

- Web tests only. Mobile and API tests are not healed.
- Locators with `nth` (the "second matching button") are not healed.
- Looking for a replacement repeats the steps before the failing one on the live application, which is what the test
  run itself just did; for a journey that creates data (sign-up, orders) that data is created once more.
- There is no record of where a control used to sit on the page, so position alone is not used. A control that moved
  *and* was renamed beyond recognition is not found.
- A model-based fallback (choose among the candidates) is deliberately not built in. `proposeHeal` in
  `src/engine/healing/heal.ts` is marked as the place for it.

---

## Deploy triggers

### What you can do

In a project, open **Schedule → Run after a deploy**.

1. **Create a token** (optionally named, for example "GitHub Actions"). It is shown **once**, together with a ready
   to paste `curl` example. Only a fingerprint is kept; if you lose it, make a new one.
2. Add a step to your pipeline that calls the run address after the release.
3. Optionally ask for the result, or give a callback address to be told.
4. **Revoke** a token at any time; it stops working at once.

Runs started this way appear in **Runs** marked **After a deploy** with the commit, and in the trend list, and they
raise the same alerts as a scheduled run. They re-run every test this computer can run, exactly like **Re-run all
tests**.

### The pipeline's two calls

No API key is needed (and none should be put in a pipeline): **the token is the credential.**

```
POST /api/triggers/<token>/run
{ "commit": "9b1f0c2", "environment": "staging", "callbackUrl": "https://ci.example.com/hooks/qa", "url": "https://pr-42.example.com" }
```

All four fields are optional. `commit` and `environment` are labels (shown, never interpreted). Answers:

| Status | Meaning |
|---|---|
| `202` `{ jobId, state: "queued", testCount, commit, environment }` | The run was queued. `ignored` lists anything that was left out (see `url` below). |
| `404` | Unknown **or revoked** token (the same answer, so a token cannot be probed for). |
| `409` | Tests are already running for this project (try again when they finish), or the project has no application or no runnable tests yet. |
| `429` with `Retry-After` | One run per token every 30 seconds. |
| `400` | A field is malformed, or `callbackUrl` is not an allowed address. |

```
GET /api/triggers/<token>/status/<jobId>
```

```json
{ "jobId": "…", "state": "passed", "finished": true, "passed": true,
  "summary": { "total": 12, "passed": 12, "failed": 0, "needsReview": 0, "passRate": 100 },
  "failures": [], "commit": "9b1f0c2", "environment": "staging", "createdAt": "…", "finishedAt": "…" }
```

`state` is `queued`, `running`, `passed`, `failed` (some tests did not pass; they are listed in `failures`, up to
20), `error` (the run could not complete; `message` says why) or `cancelled`. `passed` is `null` until the run has
finished. A token can only read the runs it started (anything else is `404`).

**Callback.** With `callbackUrl`, when the run ends the platform POSTs a JSON body with `event:
"deploy_run_finished"`, the same fields as the status answer, the project name and a link to its runs. It goes through
the same delivery as alerts: the address must pass the platform's address rules (and is checked again at delivery),
redirects are not followed, and temporary failures (5xx, 429, network) are retried with a short backoff. Whether it
arrived is recorded; a callback that cannot be delivered never affects the run. The address is stored encrypted
(it may carry a secret) and is never shown again.

**`url`.** A pipeline can run the tests against another address (a preview deployment) **only** if the token was
created with *Let the pipeline send a different address* **and** the address passes the platform's rules; otherwise it
is ignored (and `ignored` says so). When honoured, that address becomes the project's address from then on, and its
saved sign-in details move with it, which is why the option is off by default: only enable it for addresses you
control.

### Management API (needs the API key like every project route)

| Request | What it does |
|---|---|
| `POST /api/projects/:id/triggers` `{ label?, allowUrl? }` | Creates a token. `201`; the answer includes `token` once. Up to 10 active tokens per project. |
| `GET /api/projects/:id/triggers` | Lists tokens (name, last four characters, created, last used, revoked, allowUrl). Never the token. |
| `DELETE /api/projects/:id/triggers/:tid` | Revokes it. |

### Security

- A token is 32 random bytes (`aitt_` + 43 URL-safe characters). Only its SHA-256 hash is stored, compared in constant
  time; the plaintext exists only in the answer that creates it. It is never logged: request logs show
  `/api/triggers/[token]/…`.
- The API-key check stays in force for everything else. **Exactly** these two routes skip it: `POST
  /api/triggers/<token>/run` and `GET /api/triggers/<token>/status/<jobId>`, matched on the decoded path with an
  anchored, case-sensitive, exact pattern (no prefix match, no trailing slash, no extra segments). Encoded dots and
  slashes, doubled slashes, other methods and other casing all fall through to the key check and get `401`. A trigger
  token is not an API key and opens nothing else (tests cover these).
- Rate limit: one accepted run per token per 30 seconds, kept in the database so it survives a restart.
- Tokens, trigger runs and run history live in migration slot 12 (`trigger_tokens`, `trigger_runs`).

### Limits

- A trigger always re-runs **all** runnable tests of the project (the same job a schedule starts). There is no
  per-suite or per-environment selection.
- The deploy `environment` is a label. It does not select one of the project's named environments.
- Callbacks are delivered by the process that runs the job; if that process stops before delivering, the callback
  may not be delivered (the status endpoint still gives the result).
- Rate limiting is per token, not per client address.

## After you apply a repair: what changed, and Undo

The card turns into *Repair applied* with the before and now locators and **Undo this repair**. Undo puts the old locator back in that one step through the steps editor's save (a new version in the test's history, the script made again, the test run again). It is offered only while the step still has the repaired locator. A repair of a shared element has no one-press undo (it changed other tests too): the card shows what the element was so it can be set back under Shared elements. See `ux-explain.md`.
