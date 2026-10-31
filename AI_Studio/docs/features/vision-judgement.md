# AI judgement of screenshots ("does this screen look right?")

A vision-capable AI model looks at a screenshot and says whether the screen looks right: elements overlapping or cut off, missing
or broken images, unreadable text, error banners that do not belong. It catches what text and accessibility snapshots cannot.
**Off by default**; switch it on under *Advanced options → AI screen review*. It needs an AI model that accepts images.

The idea comes from [autospec](https://github.com/zachblume/autospec) (MIT): look at the screen after an interaction. autospec
saves screenshots but only sends accessibility text to its model, so sending the picture to a vision model is new here. See
`THIRD_PARTY_LICENSES.md`.

## Two uses, both behind the same switch
1. **While a test is being created.** The authoring agent gets a `lookAtScreen` tool ("is anything visibly wrong?"). It may use it
   after key steps, at most **3 times per scenario**. A screen the model finds wrong (high or medium confidence) is recorded as an
   **observation** on the test: a job event, `visionObservations` in the test's creation notes (shown on the test page: "The AI
   reviewer noticed something while this test was being created"), and the agent's action log. It never becomes a step and never
   silently disappears. If the model cannot look, the tool says so once and authoring carries on from text snapshots as before.
2. **As a replayable check.** A test step *"AI judgement: the page looks right"* (spec assertion `looksRight`, optional `expected` =
   what to look for, for example "the cart total is visible and not overlapped"; optional locator = judge that element only).
   With the switch on, key pages (up to 3) get such a check automatically; you can also add the step to your own specs.

## What the model must answer
A **structured verdict**, checked against a schema every time: `{ ok, confidence: "low" | "medium" | "high", problems: [...] }`.
Temperature is sent as 0 (if a model refuses a temperature, the call is repeated once without it). Anything that does not match the
schema is treated as "the model could not judge", never as a pass.

| Verdict | Result |
|---|---|
| `ok = true` | Passes. |
| `ok = false`, **high** confidence | **Finding** (needs review), severity **medium** |
| `ok = false`, **medium** confidence | **Finding**, severity **low** |
| `ok = false`, **low** confidence | **Still passes**, with a plain note kept on the test ("AI judgement note (not sure): ...") |

A finding is always labelled **"AI judgement — please look"**, lists each problem (with the step and the confidence), carries the
screenshot the model looked at as evidence (*What the AI reviewer looked at*), and ends with "A vision model judged the attached
screenshot, so it can be wrong: open it and decide for yourself". It is a judgement, not a measurement. The `ai-test` CLI reports it
as category `ai-judgement` (SARIF rule `AiJudgement`), and the severity above feeds `--fail-on`.

## When the judgement cannot run
The test is **FAILED_VALIDATION with a plain reason**, never a pass and never a finding ("AI judgement could not run: ... Nothing was
judged, so this test is neither passed nor flagged"). Reasons:
- no AI model is set up for this platform;
- the configured model does not accept images (the provider refused the picture);
- the model could not be reached or did not answer;
- the model's answer was not a usable verdict;
- the screenshot could not be prepared (not a PNG/JPEG, still too large after shrinking);
- the job's image limit was reached.

Such a test is not repaired by the AI (a rewrite cannot fix a missing model) and is not retried. If the switch is on and no model is
configured at all, the job log says so up front. Use `scripts/vision-probe.mjs` to find out whether your model takes images (it sends
one real 1-pixel picture; run it by hand: `npx tsx --env-file-if-exists=.env scripts/vision-probe.mjs`).

## Cost and size limits
| Limit | Value |
|---|---|
| Looks per scenario while authoring | 3 |
| Screenshots judged per test (extra ones are reported as "not judged") | 4 |
| Screenshots per job (authoring + validation) | 40 |
| Longest side of a picture sent (larger ones are shrunk to JPEG in the browser) | 1024 px |
| Largest picture sent after shrinking | 1.5 MB (otherwise the judgement cannot run) |
| Size of the answer | 600 tokens |

Only runs that **passed** and captured a screenshot are judged; a test that already failed costs nothing. The screenshots are sent to
your AI provider: do not switch this on for pages that show data you may not share with it.

## What a downloaded script does
A generated script **cannot call a model**: that would put an API key into a file people download and share. For a `looksRight`
step the script only **saves a screenshot** (JPEG, viewport or element) and attaches it, together with the question, to the
Playwright report, with a clearly commented no-op in the code and an `ai-judgement` annotation. Run anywhere else (your own CI,
`npx playwright test`) the step records the screenshot and **never fails**: the judgement exists only inside the platform, which reads the
attachments after its own validation run and asks its model. The question text is written into the script as plain text; `{{...}}`
placeholders in it are **not** expanded, so a password can never end up in what the model is asked.

Browser/screen-size variant runs and environment runs also only capture the screenshot; environment runs skip such tests and say so
(a pass there would prove nothing), while a variant result still means "the flow works in that browser".

## How it works (for developers)
- `src/engine/vision/verdict.ts` verdict schema, confidence rules, prompts, limits, plain failure wording.
- `src/engine/vision/image.ts` PNG/JPEG size reading, shrinking (canvas in the browser we already have), size ceiling.
- `src/engine/vision/judge.ts` `judgeImage` (never throws) and `applyVisionJudgement`, called by the validator right after a script run:
  verdicts are folded into the run (failed step with the finding text, or "could not run"), so recording, severity, retries and the
  CLI all see one consistent picture. Per-job image budget lives here.
- `src/engine/vision/capture.ts` the helper pasted into scripts; `look.ts` the authoring tool; `specs.ts` spec generation and finding
  classification. `LlmClient.imageObject` (`src/engine/llm/provider.ts`) is the image-capable call.
- Failure prefixes: `AI judgement — please look:` (finding), `AI judgement could not run:` (plain failure).

## Limits
- Models are not deterministic: temperature 0 makes the same picture give the same answer as far as the provider allows, but it is
  not guaranteed, so a finding may appear or vanish between runs. That is why low confidence never fails a test.
- A screenshot shows one moment of one viewport; animations, hover states and anything off screen are not judged.
- Whether a model accepts images is discovered when it is used (or with `scripts/vision-probe.mjs`), not by a built-in list.
- Quality of the judgement depends on the model; this was tested with scripted model doubles (including a local server speaking the
  OpenAI-compatible protocol), not with a real model.
