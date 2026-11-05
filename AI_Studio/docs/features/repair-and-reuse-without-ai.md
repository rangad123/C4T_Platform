# No AI where it is not needed: repair without AI first, exploration reuse, and the savings comparison

Two savings that answer some questions without asking the AI model, and the quality gate that checks all the AI savings together
(prompt caching, smaller snapshots, the fast model and these two) do not cost quality. Nothing here changes what a test does or what is
judged: a fix made without AI is kept only when the test then passes, and reuse only changes what the AI is shown.

## Repair without AI first

When a web test that is being created (or re-run with its test idea, the cases where the AI repairs it today) fails because **an element
could not be found**, the platform first tries fixes worked out by plain comparison, in this order:

| Kind (`kind` in the log) | What it looks for |
|---|---|
| `shared-element` | The step uses a shared element that has **other ways to find it** on record (see below), and one of them finds exactly one element the step can use. |
| `role-name` | The same role with a name that reads the same once case, spacing and punctuation are tidied ("Sign In" / "Sign in"), or means the same by the fixed synonym list used by healing ("Add to cart" / "Add to basket", "Sign in" / "Log in"). For a text, label or hint locator: a control whose accessible name reads the same. |
| `same-text` | An element showing the same text (a button that became a link), or a field whose hint reads like its old label (and the reverse). |
| `moved` | The element a test id or CSS selector meant, found by its own attributes elsewhere: its id, name or test id reads like the old test id, or it carries every id, class and attribute value of the selector's last part. |

Rules: a kind counts only when **exactly one** element of the page matches it (two candidates are a guess, so that kind gives nothing);
names must read the same or be listed synonyms, never only "similar" (opposites like Add/Remove never match); the element must suit the step
(a field for typing, enabled for an action). The steps before the failing one are replayed in a real browser to look at the page, as healing
does. Each fix found (at most 3) is tried with a **real run of the test**; the first with which the test passes is kept (an Auto-fix, listed
in the test's history like any other), and the job log says `repaired_without_ai`: "WEB-003: Fixed without AI: the “Checkout” button was not
on the page; with the text “Checkout” instead (found by the same text) the test passed." A fix with which the test still fails is logged as
`repair_without_ai_tried` and the model is then asked **exactly as before**, with the original failure. Runs that only tried a fix that
failed are not stored as executions (like the phone repair's trial run).

Never repaired this way (healing's own rules, `healing/failure.ts`): failures that are not a missing element, checks of content (a heading
or message found by its name, text on the page, counts, URLs), built-in check families, steps that pick one of several matches by position,
tests with reusable steps, elements inside frames, hand-written (code) tests, API tests.

**Phone tests** (`mobile/repair/`): the same rules, on the elements the phone's screen shows at the failing step, run before the AI is asked
to choose. A pick is tried once; if the test passes it becomes the Repair suggestion (a person applies it, as always), with the reason
"Found without AI: …". Otherwise the AI chooses as before. The session with the phone is closed before the trial run.

**Shared elements' other locators.** A shared element may carry up to 4 other ways to find it (`alternatives`, same shape as a locator) in
the API (`POST/PUT /api/projects/:id/objects`, exports and imports). They are never rendered into a script; they are only tried by this
repair when the element's locator finds nothing. A fix found this way changes only the failing test's step (the shared element is left as it
is: update it in Shared elements so every test uses the working locator). Stored next to the locator in `locator_json` (no migration);
an element without them is stored and answered exactly as before. There is no field for them in the Shared elements screen yet.

## Exploration reuse

With site memory on ("Start from what we learned last time"), a page whose fingerprints have not changed since the last exploration is
**not sent to the AI again**: the understanding step gets one line for it (address, kind, and what the AI understood it is for last time)
instead of its accessibility snapshot, and that earlier understanding is kept unless the AI says otherwise. The job log says
`understanding_reused`: "4 of 6 pages have not changed since the exploration of 2026-10-01: what the AI understood about them then is used,
and they are not sent to the AI again (/, /about, …)."

"Not changed" is strict: the same address, the same structural fingerprint (headings and form fields, the change summary's) and the same
**understanding fingerprint** (title, every control's role and name with numbers blurred, the API calls the page makes). Site memory now also
keeps, per page, that second fingerprint (a hash) and the AI's one-sentence purpose of the page (scrubbed like the other free text; see
site-memory.md). Records saved before this have neither, so their pages are sent again once.

The crawl always runs in full; planning, authoring and validation are unchanged (planning never got snapshots). The whole understanding call
is not skipped even when nothing changed, because journeys need the page detail the AI wrote last time and site memory does not keep journey
steps (privacy rule). Measured on the tests' tiny fixture site the prompt barely shrinks (2,126 to 2,043 characters, of which ~1k is the
memory section that appears on every later exploration anyway); on real pages each snapshot is up to ~1,500 characters, all of which is saved
for an unchanged page.

**Force a full exploration**: start an exploration through the API with `fullExploration: true` (the log says `full_exploration`; the
Explore page has no switch for it), or switch the saving off.

## Switches and usage

| Saving | Environment | Settings, AI model | Default |
|---|---|---|---|
| Repair without AI first | `LLM_DETERMINISTIC_REPAIR` (`false`/`off`/`0`/`no` = off) | "Repair without AI first" | on |
| Exploration reuse | `LLM_EXPLORATION_REUSE` | "Reuse what was understood about unchanged pages" | on |

A choice saved in Settings wins over the environment (API: `GET/PUT /api/llm/without-ai` `{ deterministicRepair?, explorationReuse? }`,
`true`/`false`/`null` = follow the environment again; viewer reads, owner changes). Read when the work starts (a change applies to the
next job). The job's AI usage (`GET /api/jobs/:id/usage`) has `withoutAi: { repairs, repairsByKind, pagesReused, summary } | null`, counted
from the job's events, shown as "Done without AI" in the job's technical details.

## The savings comparison (quality gate)

```
node scripts/eval.mjs --compare [--warm] [--toggle A,B=value] [--max-quality-drop pass=2,false=0] [--only id] [--repeat N] [--yes]
```

It runs the corpus **twice**, each time on a fresh platform started by the command (`<data-dir>/compare/baseline` and `/candidate`, emptied
first, so no saved Settings or site memory carries over): the **baseline** with every saving off, the **candidate** with every saving on
(through the environment variables above, `LLM_PROMPT_CACHE`, `LLM_COMPACT_SNAPSHOTS` and `LLM_MODEL_FAST`). `--toggle` limits or extends the
list; a model setting takes its value (`--toggle LLM_MODEL_FAST=claude-haiku-...`, otherwise the environment's; not set = not compared).
`--warm` explores and creates each entry once first in the same project (not measured), so that exploration reuse has something to reuse;
without it the reuse saving is always zero, because every evaluation project starts empty. It costs about twice a normal evaluation (more
with `--warm`). A running platform (`AITP_EVAL_URL`) cannot be used.

It writes `eval/results/<date>-<corpus>-compare.json` (the report and both full runs) and `.md`:

| Measure | Meaning |
|---|---|
| Tests created, planned, entries finished | per side |
| Pass rate | created tests that passed in every rerun |
| False failures | flaky tests plus tests that kept failing because the test was wrong (the evaluation's heuristic on the stored reason) |
| Repairs that fixed a test (of them without AI) | created tests that passed in their creation run after at least one repair |
| Unchanged pages not sent to the AI | exploration reuse |
| AI calls, escalations, input / cache read / cache write / output tokens, tokens by model, cost | the platform's own usage records |

**Verdict**: **pass** when the candidate's pass rate is at most 2 points below the baseline's, it has no more false failures, and it finished
as many entries (margins: `--max-quality-drop pass=<points>,false=<tests>`); **fail** otherwise, with one line per broken rule; **not judged**
with `--plan-only` or when the baseline created nothing. Tokens decide nothing; they are reported with the difference. Exit codes: 0 pass or
not judged, 1 fail, 2 nothing could start, 3 a side finished no entry. Comparison runs are not kept in Settings, Quality.

How to read it: look at the verdict and its reasons first, then the per-entry table (a drop on one site can hide in the total), then "All
tokens" and "Tokens by model". On the owner's first real run, also open a few repaired tests' histories to check the fixes without AI look right.

## What is not covered / not verified

- **No real model was used.** The tests use scripted doubles: repairs on a local fixture page in a real browser (each kind), phone repair on
  an in-memory phone (no real phone or fake adb run), reuse on the local memory-site fixture, the comparison on the DemoShop sample site.
  The real numbers are the owner's `--compare` run.
- Token savings in the tests are the meter's estimates (characters / 4) of a scripted model.
- Repair without AI only covers "element not found"; a timing or data problem still goes to the model.
- The phone repair still needs the phone for the look at the screen (no AI call is made when a rule's pick passes).
- Exploration reuse never skips the understanding call, and its fingerprint is strict, so pages whose controls carry changing names (product
  lists) are sent every time.
- The comparison measures quality only through the evaluation's own measures; false failures rely on its reason heuristic.

## For developers

`src/engine/llm/without-ai.ts` (switches, event kinds), `src/engine/healing/deterministic.ts` (web rules), `src/engine/validation/det-repair.ts`
(the validator's step), `src/engine/mobile/repair/deterministic.ts` + `phone-repair.ts`, `src/engine/memory/reuse.ts` + `distill.ts`
(`understandingFingerprint`) + `understanding/analyzer.ts`, `src/platform/without-ai-settings.ts`, `src/eval/compare.ts` + `cli.ts` +
`harness.ts` (`warm`, usage detail). UI: `web/src/features/usage/WithoutAiSetting.tsx`, `JobUsage.tsx`, `NewProject.tsx`.
Tests: `tests/det-repair-unit.test.ts` (fast tier), `tests/det-repair.test.ts`, `tests/exploration-reuse.test.ts`, `tests/eval-compare.test.ts`
(ports 7350-7352, under the browser lock).
