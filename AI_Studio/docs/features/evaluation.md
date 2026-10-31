# Evaluation: measure the AI tester on real apps

"Production grade" should be measured, not claimed. The evaluation harness runs the AI tester on a list of real websites and Android apps (the **corpus**), exactly as a person would use it, and measures how good the result is: how many tests it plans and creates, how many pass, whether they give the same result every time, what they cover, how long it takes and what the AI costs. Every run is kept by the platform (Settings, **Quality of the AI tester**) and compared with the run before it, so a change to the platform or the model shows up as better or worse numbers.

## Run it (the owner)

One command, on the computer that has the platform's code and your AI model key in `.env`:

```
node scripts/eval.mjs
```

It reads `eval/corpus.json`, starts its own platform (data in `eval/.data`, never `./data`), and for each entry:

1. creates a project "Eval: <id> (<date>)", sets the Android app for an app entry (and sends the `.apk` if one is named);
2. explores and plans (`POST /api/projects/:id/test-generation` with `plan: true`, the same start the screens use);
3. creates the tests from the plan (`POST …/plans/:jobId/create`): they are written and run once, as always;
4. runs every created test again **N times** (`--repeat`, default 3) with `POST /api/projects/:id/runs`;
5. reads the results from the platform's own records and works out the numbers.

To use a platform that is already running (for example the shared server), set `AITP_EVAL_URL=http://host:port` and, when it has a key, `AITP_EVAL_API_KEY`. The projects are then created there.

Options: `--corpus <file>`, `--repeat <1-10>`, `--only <id,id>`, `--plan-only` (explore and plan only: nothing is created or run; much cheaper), `--fail-under <gates>`, `--out <dir>` (default `eval/results`), `--data-dir <dir>`, `--yes` (skip the 5 second wait after the cost warning). Ctrl+C stops the run **and the job in progress on the platform**.

**Cost warning.** This uses your AI model on every entry: one exploration, one plan and the writing of every web test, typically tens to a few hundred AI calls per entry (a phone exploration is capped at 100 calls). The reruns make no AI calls. Set limits first in Settings, AI usage (a job limit stops a runaway entry; the run then reports that entry as failed). `--plan-only` costs roughly the exploration and the plan only.

### What to send back

The two files the run wrote, `eval/results/<date>-<corpus>.json` and `.md`. They hold numbers, test titles and one-line failure reasons; no password, token or page content. Also say which model you used (it is in the file) and anything odd you saw on the screens. The `.md` file is meant to be read as is.

## The corpus

`eval/corpus.json` (checked when read; every problem is listed in plain words):

```json
{
  "name": "default",
  "entries": [
    { "id": "shop", "kind": "web", "url": "https://shop.example.com", "credentials": { "username": "SHOP_USER", "password": "SHOP_PASSWORD" }, "maxPages": 15 },
    { "id": "app", "kind": "android", "appPackage": "com.example.app", "apk": "C:/apps/app.apk" }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | lower-case letters, digits, dashes; unique; used to compare runs |
| `kind` | `web` or `android` |
| `url` | the website (web) |
| `appPackage`, `apk` | the Android app's package name, and optionally an `.apk` on this computer (android) |
| `credentials` | **names of environment variables** holding the test account (`username` + `password`, and/or `apiToken`), never the values; a name that is not set skips the entry with the reason |
| `targets` | default `["web"]` for a website, `["mobile"]` for an app; `["web","api"]` adds API tests |
| `maxPages`, `maxScenarios` | smaller is faster and cheaper |
| `checks` | `false`: journey tests only (no accessibility, page health, security, input, contract or access checks) |
| `fixture` | `sample-app` or `fake-shop`: the two local fixtures (below) |
| `notes` | free text |

Keys that start with `//` are comments. It ships with only the two **local fixtures**, so the harness can be checked without any outside site: `sample-app` (the DemoShop sample site, started by the harness on `127.0.0.1`) and `fake-shop` (the mock shop app on the fake adb used by the phone tests: no phone, no emulator; only with the platform the harness starts itself). `eval/corpus.example.json` lists public practice sites and an app entry as examples; it is documentation and never run by the tests.

The phone or emulator an app entry uses is the project's normal one (this computer's, or a runner); set up the phone as for any phone test (`phone-ai-tests.md`).

## The numbers

Per entry and overall (overall rates are worked out from the summed counts, not averaged):

| Measure | Meaning |
|---|---|
| Planned | test ideas in the plan (`total` of the plan) |
| Created | tests the creation stored |
| Passing first time | passed in the run that created it |
| Stable | the same verdict (passing, or not passing) in all N reruns |
| Flaky | passed in some reruns and not in others |
| Not run | at least one rerun could not run it (no phone, runner offline): its stability is not judged |
| Kept failing: product / test wrong / unclear | for a stable failing test, a **heuristic** on the reason the platform stored: an element not found or a wait that timed out means the test is wrong; other content than expected, a server error (5xx) or a check's finding means a product finding; anything else is unclear |
| Duplicates | tests with exactly the same steps, or the same title, as an earlier test of the entry |
| Coverage | pages (web) or screens (phone) found by the exploration that at least one created test visits (web: the test navigates to the page; phone: the screen is on the test's path) |
| Time | wall time of the entry |
| AI calls, tokens, cost | the platform's usage records of the exploration and the creation jobs; a cost only when a price is set (Settings, AI usage) |
| Safety refusals | phone: actions the AI wanted and the platform refused as unsafe (`mobile_action_skipped` events). Web: not recorded by the crawler, shown as n/a |

**Comparison**: each run is compared with the previous kept run of the same corpus name and the same kind (full, or plan only): rates up or down by more than half a point, time by more than a tenth, AI calls and cost by any amount count as better or worse; planned and created only "changed".

**Quality gates** for CI: `--fail-under stable=0.8,flaky=0.1`. `stable`, `firstPass`, `coverage` must be at least the limit; `flaky`, `duplicates`, `testWrong` at most. Nothing to measure (no test created) fails an "at least" gate. Exit codes: 0 done, 1 a gate failed, 2 nothing could start (options, corpus, no AI model, platform not reachable), 3 no entry finished.

## Savings off against savings on (`--compare`)

`node scripts/eval.mjs --compare --warm` runs the corpus twice on two fresh platforms the command starts, with the AI savings (prompt caching,
smaller snapshots, the fast model, repair without AI, exploration reuse) off and then on, and writes `<date>-<corpus>-compare.json` and `.md`
with tests created, pass rate, false failures, repairs, pages reused and tokens (input, cached, output, by model), and a verdict against
`--max-quality-drop` (default: pass rate at most 2 points lower, no extra false failures). How to run and read it:
[repair-and-reuse-without-ai.md](repair-and-reuse-without-ai.md#the-savings-comparison-quality-gate).

## In the app

Settings, **Quality of the AI tester**: the kept runs, newest first, with stable, flaky, passing first time and coverage, and "Better" or "Worse" against the run before. Opening a run shows every entry (with the reason when it was skipped or could not finish), the gates, the tests to look at and every measure that moved. A run can be removed from the list (asked first; the projects it created stay). With no runs it shows the command to copy.

API (API key protected like every route): `GET /api/eval/runs`, `GET /api/eval/runs/:id`, `POST /api/eval/runs` (a run as the harness writes it, validated, at most 4 MB, at most 100 entries and 500 tests each), `DELETE /api/eval/runs/:id`. At most 500 runs are kept. Database: migration slot 30, table `eval_runs` (SQL in `src/platform/eval-store.ts`).

## What is not covered

- **No real run has been made here.** The tests run the whole harness only on the two local fixtures with scripted AI doubles (never a real model or an outside site). How the numbers come out on real apps with a real model is exactly what the owner's first run will show.
- The failure split (product vs wrong test) is a guess from the stored reason, not a judgement; check a few by hand.
- Coverage only counts pages and screens the exploration found; what it never found is invisible to it. Web coverage reads `navigate` steps, so a page reached only by clicking is not counted.
- Duplicates are exact (same steps or same title); two tests that check the same thing differently are not caught.
- Projects created by a run are not deleted (there is no project delete yet); they are named "Eval: …".
- The `fake-shop` fixture only works with the platform the harness starts; a remote run skips it with the reason. The `sample-app` fixture runs on this computer, so a remote platform must be able to reach `127.0.0.1` of this computer (same machine).
- Web exploration does not record refused actions, so safety refusals are phone only.
- Once user accounts exist (USR), the eval routes need the same access rule as other platform-wide settings; today they need the API key.

## For contributors

`src/eval/`: `corpus.ts` (schema, env-name credentials), `metrics.ts` (pure: judgement, numbers, gates, comparison), `harness.ts` (the API calls), `client.ts` (remote fetch or in-process `inject`), `fixtures.ts` (sample site, fake phone), `report.ts` (Markdown), `run.ts` (the run's shape), `cli.ts` (the command). `scripts/eval.mjs` loads `.env` and runs `cli.ts` through tsx. Platform: `src/platform/eval-store.ts`, `src/platform/routes/eval.ts`. UI: `web/src/features/eval/*`. Tests: `tests/eval-unit.test.ts` (fast tier) and `tests/eval.test.ts` (both fixtures end to end, remote mode, stop, no model, the Settings panel; ports 6711-6712).
