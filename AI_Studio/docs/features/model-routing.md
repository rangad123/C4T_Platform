# The right model for each job: a fast model for routine steps, with escalation

Most AI calls of a job are routine: the next step of the agent that writes a web test, the next tap of the phone exploration. They do
not need the strongest (and most expensive) model. With a **fast model** set next to the main one, routine steps go to it, and the main
model keeps the work that decides what a test is: understanding the application, planning, repairs, and anything with images. When the
fast model struggles, the main model takes over, and the job says so.

Empty setting = the main model does everything, exactly as before (the job gets the very same client object it always had).

## What a tester sees

- **Settings, AI model, "Fast model for routine steps"**: a model name (for example `claude-haiku-4-5`; another provider is written
  `openai:gpt-5.4-mini` and needs that provider's key on the server), a box "The fast model can look at screenshots" (off by default),
  **Save fast model**, and **Use the server's setting** when one is saved here. A line says what is in force ("On: routine steps use
  claude-haiku-4-5, the rest uses claude-sonnet-5-5" or "Off: … does everything"). **What goes to which model** opens the table below.
  A fast model the server cannot use (no key for its provider, a custom endpoint without an address) is shown with the reason, and the
  main model does everything.
- **A job's activity**: each hand-over, in words. "Scenario S-002: the fast AI model claude-haiku-4-5 tried the same action twice and
  it failed both times, so the main model claude-sonnet-5-5 does the rest of it." or "… gave no usable answer, so the main model …
  answered that step again and does the rest of it." A fast model that is set but cannot be used is said once per job (not in runs that
  only re-run tests).
- **AI usage**: tokens per model as before (the fast model gets its own row, so its price applies), and the number of hand-overs:
  "The fast model handed work to the main model 3 times (escalated to the main model)" in the month's totals, and
  ", 1 escalated to the main model" at the end of a job's one-line AI use.

## The routing table

| What the call is doing | Model |
|---|---|
| Steps of the agent that writes a web test (new scenarios and plain-English web tests) | fast |
| Turns of the phone exploration (one action per screen) | fast |
| Choosing the API operation and checks of a plain-English API test | fast |
| Understanding the application, reading its documentation | main |
| Planning tests, phone test ideas, reading a requirements document | main |
| Why a test failed, repairing it (including the agent re-writing a failing web test), phone repair suggestions | main |
| Anything with images (screenshot judgements, "look at the screen" while writing a test) | main, or fast when "The fast model can look at screenshots" is on |
| Anything not labelled | main |

The table is `ROUTE_TABLE` in `src/engine/llm/routing.ts`; Settings shows the same rows. Summaries, naming and classification calls would
be routine too, but none exists as a call of its own today (the one choice-like call, which API operation a plain-English sentence is
about, is in the table). Failure triage stays on the main model on purpose: it decides whether a failure is a product defect, which is a
judgement, and nothing here may change what is judged.

## Escalation: when the main model takes over

- **A single call** to the fast model fails: no valid structured answer after the existing re-ask (the client already asks once more
  with what was wrong), the fast model unavailable after its own retries (out of credit, paused, overloaded, …), or the request refused or
  rejected. The **same call** is asked again on the main model (which has the fallback models behind it). A reached AI limit, a stopped
  job or a missing model are never escalated.
- **An agent loop** (one web scenario, one phone exploration) leaves the fast model for the rest of that scenario when:
  - the same action (tool and arguments; the free-text "why" is ignored) fails twice;
  - the same action is chosen 3 times in a row (on the phone: an action the explorer refuses because it was just done 3 times);
  - 4 steps in a row make no progress (no action that worked, or on the phone nothing on the screen changed);
  - on the phone also: an answer that does not fit the format (that turn is asked again on the main model), or choosing an element that
    is not on the screen twice.
  Read-only looks (`seeWholePage`, the whole page again with compact snapshots; `lookAtScreen`) are not actions: they never count as
  a repeat, a failure or a step without progress (`LOOK_TOOLS`).
  The step that tripped the rule has already happened; the next step goes to the main model, with the whole conversation so far.
- Scenarios authored at the same time never share this state (each runs in its own `AsyncLocalStorage` scope). Steps of the web agent
  outside any scope (none today) stay on the main model, because nothing would protect them.
- Limits: `ESCALATION_LIMITS` in `routing.ts` (2 failures, 3 repeats, 4 steps).

## How it works

- `src/engine/llm/routing.ts`
  - `routedClient(main, { fast, fastImages, onEscalation })` is an ordinary `LlmClient`: `object`, `text`, `imageObject` are routed by the
    task of the current scope (`withRoute`) or else the call's `purpose` label; `model` is a `RoutedModel` (an AI SDK v3 model) that sends
    each step of the web agent to fast or main and retries a failed step on main. Usage counters are one object over both clients
    (`combinedUsage`), so the meter, the job counters and the agent's own additions keep working unchanged.
  - The meter (`metered.ts`) wraps the routed client as it wraps any client. The routed client writes the model it chose into the meter's
    "which model answered" slot (a resilient model then overwrites it with the model that really answered), so usage rows are per model.
  - `withModelRouting(config, main)` builds the fast client (`createFastClient`: the fast model alone, no fallbacks; an unavailable fast
    model escalates to the main model and its fallbacks) or returns `main` itself when no usable fast model is set.
- The loops open a scope: `authorWebSpec` (task "authoring", or "repair" when it resumes a failing test), `explore` on the phone
  ("phone-explore"). `author.ts` reports each finished step (`noteAgentStep` in `onStepFinish`); the phone explorer reports its actions,
  refusals and unusable answers (`noteRouteActions`, `escalateRoute`).
- `src/platform/llm-routing.ts`: the Settings value (`ai_settings` row `llm_fast_model`, `{ model, images }`; empty model = off), the
  job's client (`routedLlmForJob`, called by `job-runner.ts`), and the routes. Escalations are usage rows with the label `escalation`
  (`ESCALATION_PURPOSE` in `usage.ts`): their `calls` column is the number of hand-overs, they carry no tokens, and totals keep them apart
  from calls (`Totals.escalations`; not shown as a purpose of their own). No migration.
- Routes (owner to change, viewer to read; platform-wide, so "all projects" access):
  - `GET /api/llm/fast-model`: `{ provider, model, entry, images, source: app|environment|none, environment, ready, reason?, configured, mainModel, active, fastFor[], mainFor[], limits }`
  - `PUT /api/llm/fast-model` `{ model: string | null, images?: boolean }`: `""` = no fast model, `null` = follow `LLM_MODEL_FAST` again.

## Settings (server environment)

| Variable | Default | Meaning |
|---|---|---|
| `LLM_MODEL_FAST` | empty | `[provider:]model` for routine steps. Empty = the main model does everything. A value saved in Settings wins (an empty one saved there switches routing off even when this is set). |
| `LLM_MODEL_FAST_IMAGES` | off | `true`: calls with images may go to the fast model too. |

The main model named again as the fast one changes nothing (and is not warned about).

## Batch planning

Already one call: the web planner asks for every scenario of a job in one call (`planScenarios`), the phone planner for every test idea
in one call (`chooseIdeas`), and a requirements document is read in batches of candidates. Nothing was changed; a test proves the web
planner makes one call for six scenarios.

## Tests

- `tests/model-routing-unit.test.ts` (fast tier, no browser): the table; routing by purpose, text and images; an unusable answer after the
  re-ask and an unavailable fast model asked again on the main model; no escalation of a reached AI limit or a missing model; a scope that
  stays on the main model after an escalation while a concurrent one does not; the combined usage counters; each agent rule; reading
  failed actions from an AI SDK step; the web agent's model inside a real AI SDK tool loop (stays fast, hands over after the same failure
  twice, a failed step answered again by the main model, steps outside a scope on the main model); the phone explorer on an in-memory
  phone (same screens as a main-only run, hand-over after an unusable answer and after choosing a missing element twice); usage rows per
  model and the escalation row in a real usage store; the empty setting returning the very same client; a fast model without its key;
  Settings winning over the environment; planning in one call.
- `tests/model-routing.test.ts` (browser and platform, under the lock): the Settings routes; a real generate job on a local site with two
  scripted models (understanding and planning on the main one, web steps on the fast one, a scenario fumbled by the fast model handed to
  the main one, both tests passing when run for real, the event, usage by model, the escalation in the job's and the month's usage); the
  setting emptied in Settings: the main model does everything and nothing about routing is said or counted; `null` goes back to the
  environment.

## What is not covered

- No real model was called. Whether a given fast model is good enough for your application is not something this feature can know: the
  escalation rules catch a fast model that fumbles, not one that writes a plausible but weaker test. Compare with the evaluation harness
  (`docs/features/evaluation.md`, the compare mode) before relying on it.
- Switching models in the middle of one web scenario sends the main model the fast model's earlier steps. This is ordinary AI SDK
  message history and works for models of one provider; a fast model on another provider than the main one was not tried against real
  providers. The main model's prompt cache starts cold at the hand-over.
- The tokens of the fast model's unusable answers in an escalated call are recorded under the main model (one call, one row).
- A test's "model" note still names the main model, also when the fast model wrote it.
- On the phone, the explorer's own rule (3 actions in a row with no change ends the exploration) comes before the "4 steps without
  progress" rule.
- Repair of a failing web test re-authors on the main model (it is a repair), so routing saves nothing there.

## What the owner must provide

A fast model the provider offers, and its key on the server when it is another provider than the main model's.
