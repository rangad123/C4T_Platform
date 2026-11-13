# AI usage and budgets

The platform uses the AI model to understand an application, plan tests, write web tests, repair failing tests, look at screenshots and build tests from plain English. This feature counts that use, shows what a month cost, and lets you set limits that **stop AI work cleanly** instead of letting a runaway job spend without end.

## What you see

**Settings, "AI usage"**

- This month's tokens (input plus output, all projects), a bar against the monthly limit when one is set, and a warning colour once the limit is nearly used.
- A small bar per day of the month and a table of where the tokens went, by project, by purpose or by model.
- A cost, but only for models you have priced. No prices are built in, because they go stale. Without a price the panel says "Set a price to see a cost." Enter what your provider charges per million tokens (input and output separately) and, if you like, a currency label such as USD. The label is only text; nothing is converted.
- Limit forms. Leave a field empty for no limit.
  - Tokens per month for all projects.
  - Tokens per job: one analysis or repair run stops when it reaches this.
  - A warning percentage (default 80). When a limit is this full, a note appears in the job's activity log.
  - The same two limits for one chosen project. The lower of the two job limits applies; the monthly limits all apply at once.

**A job that reached a limit** stops with the plain message "The AI token limit for this job / project / month was reached". The Overview shows a callout "AI limit reached" with a link to Settings ("Raise the limit in Settings, or wait until next month. Tests that were already created are kept."). The job's technical details show "AI use: 41K in, 6K out, 12 calls" (and the cost, when priced) and "Stopped by" with the numbers.

## What happens when a limit is reached

Before every model call the platform checks the job, the project's month and the whole month against their limits. A call that would pass a limit is refused with a typed `BudgetExceeded` error and never reaches the model. Nothing is truncated or cut short.

- **Analysis and planning:** the job stops with the message above. Deterministic work that does not need the model (API tests from an OpenAPI description, checks) still happens, and tests already made are kept and validated.
- **Writing web tests:** scenarios that were already authored are kept, run and validated; scenarios still waiting are skipped, with one line in the log. The job ends "partially completed".
- **Repair:** a failing test is left as it failed, and its reason says "automatic repair skipped: The AI token limit for this month was reached" (the same way it does when no model is configured).
- **Vision checks, plain-English tests, requirements:** they degrade the way they do without a model, with the limit message as the reason.
- **Validation-only runs** (re-running existing tests, deploy triggers, "re-run all tests" schedules) need no model and are not affected. Triggers only start validation-only runs, so they never ask for AI.
- **Schedules** that would run a new analysis are skipped with a plain reason when the month's limit (platform or project) is already used up, and no job is created. The schedule moves on to its next slot. Manual "Run now" tells you the same reason.

## How it works

- `src/engine/llm/usage.ts` is pure: the decision rules, estimates, month keys, the price maths and the grouping. The tests cover every cap, the exact boundary, the warning threshold and month rollover.
- `src/engine/llm/metered.ts` wraps one job's `LlmClient` (the job runner does this where it builds the client). `object`, `text` and `imageObject` keep their signatures; call sites may pass an optional `purpose` label (analysis, planning, authoring, repair, vision, plain, other; unlabelled calls count as "other"). The web-authoring agent talks to `client.model` directly, so that model is wrapped too and each agent step is checked. A client that cannot look at images still cannot.
- Token numbers are the client's own usage counters. If a call reports none, it is counted as characters divided by 4 and the row is flagged "estimated" (the UI says "some counts are estimates").
- `src/platform/usage-store.ts` (migration slot 17) keeps one row per job, purpose, model and day with sums and counts, never one row per call. It also keeps your prices, limits, and the record of which jobs a limit stopped.
- **Only counts and labels are stored.** Never a prompt, an answer, an image or page text. A test fills the model double with sentinel text and checks the database does not contain it, and that the model key never appears in a usage answer.

### Limits you can set, and where

| Limit | Set with | Default |
|---|---|---|
| Tokens per month, all projects (what Crowd4Test pays for: organisational keys and the server's own key; work on a personal key is not counted against it, [ai-keys.md](ai-keys.md)) | Settings, or `PUT /api/usage/budgets` `{ monthlyTokens }`; env default `AI_MONTHLY_TOKEN_LIMIT` | none |
| Tokens per job | Settings, or `PUT /api/usage/budgets` `{ jobTokens }`; env default `AI_JOB_TOKEN_LIMIT` | none |
| Warning percentage | `PUT /api/usage/budgets` `{ warnPercent }` (1 to 99) | 80 |
| One project's month and job limits | Settings, or `PUT /api/projects/:id/usage-budget` `{ monthlyTokens, jobTokens }` | none |

`null` removes a limit. A value set in the app wins over the `.env` default; saving an empty field in the app means "no limit" even when `.env` has one. Limits are whole numbers of 1 or more. The month is the calendar month in UTC.

### API

All behind the normal API key.

- `GET /api/usage?from=&to=&projectId=&groupBy=day|project|purpose|model`: totals, groups, a series with a value for every day, and this month against its limit. Ranges are `YYYY-MM-DD`, at most 366 days; the default is the current month.
- `GET /api/jobs/:id/usage`: one job's totals by purpose and model, a one-line summary, and the limit that stopped it, if any.
- `GET` / `PUT /api/usage/prices` `{ model, inputPerMTok, outputPerMTok }` and/or `{ currency }`, `DELETE /api/usage/prices?model=`.
- `GET` / `PUT /api/usage/budgets`, `GET` / `PUT /api/projects/:id/usage-budget`.

## Limits of this feature (be aware)

- **A limit can be passed by one call.** The check happens before a call, and a call's answer size is unknown until it ends. A call that starts under a limit finishes, so a limit can be exceeded by about one call per running process. A call whose own estimated input would not fit is refused up front.
- **Other processes are seen after a few calls.** Counters are read from the database at the first call and again every 5 calls (and when the month changes), so a worker and the API process, or two workers, see each other's spending with a small delay.
- **Tokens, not money.** Limits are in tokens. Cost is only a display, from prices you typed in.
- **Cached input counts at its weight** ([prompt-caching.md](prompt-caching.md)): a token read from the provider's prompt cache counts as 0.1 of a token toward the limits, a token written to it as 1.25. Without caching, limits count input + output as before.
- **Counts follow the model client.** If a provider reports wrong usage, the numbers are wrong. When several calls run at the same moment, the split between purposes can be off by a call; the totals stay exact.
- **Accounting never breaks a job.** If the usage store cannot be read or written, a message is logged once and the calls go ahead unmetered.
- The agent that writes web tests is counted under "authoring", including when it is asked to fix a test during repair.
- Usage rows stay when a project or job is deleted, so what was spent stays counted.
