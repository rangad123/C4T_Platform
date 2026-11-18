# Prompt caching

Many AI calls repeat the same opening: the instructions, the descriptions of the tools the agent may use, and, while a web test is being written step by step, the whole conversation so far. Providers that support prompt caching can read a repeated opening from their cache at a fraction of the input price. The platform marks that part of each request so they can. **What is asked never changes**: the same text reaches the model in the same order, with or without caching, so the tests written and the judgements made are the same.

## What you see

- **Settings, AI model**: a switch "Reuse repeated instructions (prompt caching)", **on by default**. Under it, one sentence says what caching does for the model in use (marked for Anthropic's cache, marked through the endpoint, cached by the provider on its own, or nothing the platform knows of). Turning it off applies to the next request, also in jobs that are already running. **Use the server's setting** goes back to `LLM_PROMPT_CACHE`.
- **Settings, AI usage**: when anything was cached, a line says how much of the input came from the prompt cache and how much went into it, and the table gets a **From cache** column.
- **A job's technical details**: "AI use: 41K in, 6K out, 12 calls, 30K of the input read from the prompt cache and 6K written to it".
- **Prices** take two optional numbers next to input and output: **Cached input** and **Cache writes**, per million tokens. Empty means cached input is charged at the input price (a cost that is too high rather than too low).

## Which providers, and how

| Provider / model | What the platform sends | Notes |
|---|---|---|
| Anthropic (`LLM_PROVIDER=anthropic`, also MiniMax's gateway through `ANTHROPIC_BASE_URL`) | A cache breakpoint on the instructions (system), which also covers the tool descriptions (Anthropic puts tools before the system text); instructions sent in two parts (the objective agent: the same rules every run, then this run's page-content fence) get one on each, so runs share the rules. A series of calls that start their prompt with the same text sends that text as a block of its own with a breakpoint (the application summary of every planning call of a job; the known workflows of every part of one source in rule extraction), so each later call reads it. A call with tools (an agent loop) also gets the request-level marker, which caches the conversation up to its last block, so each step reads what the previous step wrote. | 5-minute cache. At most Anthropic's 4 breakpoints: the request-level marker and the last instructions first, then a shared prefix, then earlier instructions. A prefix under the model's minimum (512 to 4096 tokens depending on the model) is simply not cached; nothing fails. |
| OpenRouter or another OpenAI-compatible gateway, with an Anthropic model (`anthropic/...` or a `claude` name) | Anthropic's `cache_control` passed through in the Chat Completions body: on the system message, in an agent loop also on the first user message (the scenario and the first page snapshot, which every later step repeats), and otherwise on the first part of a first user message made only of text parts (a shared prefix). | The `ai` SDK has no option for it, so a `fetch` wrapper adds it to `/chat/completions` requests only. |
| OpenAI, Google (Gemini 2.5 and later), other models on OpenRouter | Nothing | They cache repeated prefixes on their own. OpenAI reports cache reads, and they are counted. |
| Other OpenAI-compatible endpoints (Ollama, vLLM, LM Studio) | Nothing | No known cache; unknown fields could be refused. |

Where the markers go:

- **Agent loops** (the web authoring agent in `src/engine/web/author.ts`, including plain-English tests and repair through it): instructions + tools, and the growing conversation. The first message is ordered stable-first already: the scenario, then the page and its snapshot last. Later steps only append.
- **One-off calls** (understanding the app, planning, repair triage, the phone explorer's one call per screen, phone repair, screenshot review): only the instructions, which are fixed texts. Their prompt is different every call, so caching it would only add the write premium.

## How it is counted

- The provider's usage answer has cache reads and writes inside the input tokens (`inputTokenDetails.cacheReadTokens` / `cacheWriteTokens` in the `ai` SDK, from Anthropic's `cache_read_input_tokens` / `cache_creation_input_tokens` and OpenRouter's `prompt_tokens_details.cached_tokens` / `cache_write_tokens`). The client's counters keep them separately next to the input total (`Usage.cacheReadTokens`, `cacheWriteTokens`; they appear only once a provider reported any).
- The meter (`metered.ts`) passes them to the usage store, which keeps two more sums per job, purpose, model and day (`ai_usage.cache_read_tokens`, `cache_write_tokens`; added to an existing database when it opens, no numbered migration).
- **Limits count cached tokens at their weight**: a token read from the cache counts as 0.1 of a token, a token written to it as 1.25 (Anthropic's 5-minute rates; `CACHE_READ_WEIGHT`, `CACHE_WRITE_WEIGHT` in `usage.ts`). So limit tokens = input − 0.9 × reads + 0.25 × writes + output. Without caching this is exactly input + output, as before. The meter and the store use the same rule (`budgetTokens`, `BUDGET_TOKENS_SQL`), so a limit means the same before and after the meter re-reads the database. The month figure in Settings is this weighted number; "in" and "out" stay the raw counts.
- **Cost**: uncached input at the input price, reads at the cached-input price, writes at the cache-write price (each falls back to the input price when empty), output at the output price.

## Settings and API

| Setting | Where | Default |
|---|---|---|
| Prompt caching on or off | Settings, AI model; `PUT /api/llm/prompt-cache { enabled: true \| false \| null }` (null = follow the server) | on |
| `LLM_PROMPT_CACHE` | `.env`: `false`, `off`, `0` or `no` turn it off | on |
| Cache prices | Settings, AI usage, Prices; `PUT /api/usage/prices { model, inputPerMTok, outputPerMTok, cachedInputPerMTok?, cacheWritePerMTok? }` | none (input price) |

`GET /api/llm/prompt-cache` answers `{ enabled, source: app | environment | default, environment, provider, model, style, explanation }`. Reading needs a viewer, changing needs an owner, like the fallback models.

## How it is built

- `src/engine/llm/prompt-cache.ts` (all of it): which style a provider and model get, the Anthropic middleware (`transformParams` adds `providerOptions.anthropic.cacheControl` to the system messages, to a text part tagged as a shared prefix (`SHARED_PREFIX_TAG`), and at request level when the call has tools, at most `MAX_BREAKPOINTS`), the passthrough `fetch` for Chat Completions bodies, the switch (`promptCacheSetting`: Settings, then `LLM_PROMPT_CACHE`, then on), and `addUsage` for the counters.
- `provider.ts`: `LlmClient.object` takes `cachePrefix`, the leading part of the prompt that a series of calls shares; `promptWithPrefix` sends it as a tagged text part before the rest (the same text, in the same order). Callers: `planning/planner.ts` (the summary) and `intel/extract/rules.ts` (the known workflows). The objective agent's instructions are `objectiveSystem` (agent/objective.ts): the rules, then the fence.
- `provider.ts` builds every model of the chain (main and fallbacks) through `buildProviderModel(..., { promptCache })`, so a fallback on another provider gets that provider's own markers. Scripted doubles (`llmClientFromModel`) are not wrapped.
- `platform/prompt-cache-settings.ts`: the saved choice (key `llm_prompt_cache` in `ai_settings`), the routes, and `installPromptCache` (bootstrap, every process).

## Tests

- `tests/prompt-cache.test.ts` (19 tests, no browser; ports 7290-7291): the real `@ai-sdk/anthropic` and `@ai-sdk/openai` clients against a local fake Anthropic and fake OpenRouter: markers in the right place for a single call and for an agent loop, byte-identical requests apart from the markers, identical answers, the off switch from Settings (applied to a client that already exists) and from `LLM_PROMPT_CACHE`, nothing sent to other OpenRouter models, OpenAI or Google; usage parsing of cached tokens for both dialects; the weighted budget in the meter and the store agreeing; an older database gaining the columns; the Settings and usage routes; cache prices in the cost.
- The same file measures the effect on a **simulated** Anthropic cache (the documented prefix rules: breakpoints, a 20-block lookback, a 512-token minimum, characters / 4 as tokens), with the platform's real exploration instructions and a 2,400-character page snapshot per step:
  - a 10-step agent loop: 31,685 tokens without caching, 9,324 with it (26,289 of the input read from the cache, 5,196 written), **71% less**, same conversation and same answer;
  - 10 one-off calls with the same instructions: 9,610 tokens without, 4,931 with, **49% less**.
  These numbers are from the simulation, not from a provider bill.
- `tests/prompt-cache-prefix.test.ts` (10 tests, no browser; ports 7292-7293): the shared prefix as its own marked block (and nothing marked with caching off, the same text), a prefix that is not one ignored, the repair re-ask keeping it first, never more than 4 markers, the objective agent's rules identical across runs with the fence in a second instruction, planning and rule extraction passing their prefix, MiniMax through `ANTHROPIC_BASE_URL` (markers sent; its structured answers come through the SDK's `json` tool, which renders before the instructions; cache reads and writes counted), and OpenRouter's passthrough of the prefix. On the simulated cache, planning a 37-page app with site memory: 27,356 tokens without caching, 22,000 effective with the instructions marked only (as before), **12,890** with the shared summary (53% less than none, 41% less than before).
- `tests/prompt-cache-ui.test.ts` (3 tests, Chromium, port 7292): the switch in Settings (default on, off saved, back to the server's setting), the cache line and column in AI usage, a cached-input price in the cost, axe in light and dark, 44 px label row, 375 px without sideways scroll.

## Limits (be aware)

- **Never verified against a real provider.** The markers follow the installed SDKs (`@ai-sdk/anthropic` 3.0, `@ai-sdk/openai` 3.0) and the providers' documentation; whether a real account gets cache hits, and how many, was not measured here. Check `cacheReadTokens` in AI usage after a real run.
- **OpenRouter passthrough is an assumption about OpenRouter**: it forwards `cache_control` in content parts to Anthropic. A gateway that refuses unknown fields would fail the request; turn caching off for it.
- **The weights are Anthropic's.** OpenAI's cached input is priced differently by model (a tenth to a half), and writes are free there; the limits still count reads at 0.1. Money follows the prices you type in.
- The 5-minute cache expires between slow steps (a long page load, a paused job); a step after that writes again.
- Caches are per model: a fallback model, or the fast model of model routing, starts its own cache.
- One-off calls only cache their instructions and, where a series shares it, the start of the prompt; the rest of their input (page content, the app model) differs every call.
- The 1-hour cache is not used. It costs twice the input price to write (the 5-minute one 1.25 times) and pays off only when the same prefix comes back after more than 5 minutes and within the hour. The platform's repeats are either seconds apart (the calls of one job, the steps of an agent loop) or days apart (the next exploration), so it would add write cost and save nothing; measure the gaps in a real run before turning it on.
- A one-off call whose instructions never repeat within 5 minutes (for example the single "understand the app" call of a job) pays the 25% write premium on its instructions for nothing; on the sizes the platform uses that is a few hundred tokens.

## The response cache (a stored answer instead of a new AI call)

Prompt caching makes a repeated *opening* cheaper; the call is still made. The **response cache** (sheet #8) goes one step further for a
few calls that only read something and describe it: when the same project asks exactly the same question again, the answer kept from the
first time is used and **no AI call is made**. A repeat exploration of an unchanged application asks many such questions again.

**Which calls** (the allow-list, `src/engine/llm/response-cache-calls.ts`; a call opts in with `cacheAs`, and the platform refuses any
other id):

| Call | Where |
|---|---|
| `understanding` | the understanding of the explored pages (`understanding/analyzer.ts`) |
| `rules` | the business rules read from a source (`intel/extract/rules.ts`) |
| `docs` | a documentation page read during discovery (`discovery/docs.ts`) |
| `requirements` | the requirements read from a document (`requirements/parse.ts`) |

**Never cached**, whatever their inputs: test plans and suite proposals (planning), test authoring and every agent tool loop (they are tied
to the live browser), vision, review and oracle verdicts, repairs, and anything that judges a result. A verdict is never served from the
cache. On a runner only a structured call without tools and without images can be answered from it.

**The key** is a sha256 over the project, the AI in use (provider, endpoint, model, fast model, and for a key its id and when it last
changed), the call and its version, the system text, the prompt, the answer's schema and the answer size. Any byte different, or another
model or key, misses by construction. Rows are read and written by project id: one project never reads another's answer, even for the
same bytes.

**What is kept**: only a whole answer that passed its schema, never a failed, refused, cut or empty one, and only when the run's secrets and
the shared redaction patterns find nothing in it. An answer that would need masking is not kept at all, so a stored answer is always
exactly what the model said. Each answer is kept for **14 days** from when it was made; each project keeps at most **1,000 answers or
20 MB** (least recently used go first, one answer over 512 KB is not kept). Table `llm_response_cache`, migration 68.

**How it is counted**: the cache sits around the job's model client outside the usage meter (`jobLlm` in `platform/job-runner.ts`), so a
stored answer is never a model call and never counts against a limit. It adds a row with `cached_calls` and the tokens it saved
(`ai_usage.cached_calls`, `saved_input_tokens`, `saved_output_tokens`), never `calls`. Each use writes a `response_cache_hit` event. The
run's **What the explorer knows** view shows "AI calls saved" and "Tokens saved" to people who may see AI usage
([explorer-knowledge.md](explorer-knowledge.md)); like the other cost fields, they are hidden from everyone else (`auth/cost-hiding.ts`).

**Explorations on a runner** send their calls to the platform (`explore-llm.ts`), which answers them from the same cache
(`platform/llm-response-cache-runner.ts`). The runner never sees a key or another project's stored answer.

**Turning it off**:

| Where | Effect |
|---|---|
| `LLM_RESPONSE_CACHE=false` (`off`, `0`, `no`) in `.env` | off for the whole server |
| job option `responseCache: false` | off for that run |
| **Explore everything again** (`fullExploration`) | off for that run, with the other savings |
| **Forget what we learned** | removes the project's stored answers (with the site memory) |
| deleting the project | removes them |

Code: `src/platform/llm-response-cache.ts` (store, key, limits, the job wrapper), `src/platform/llm-response-cache-runner.ts` (a runner's
calls). Tests: `tests/llm-response-cache.test.ts` (a hit with zero provider calls and a meter row; misses for any input, model, version or
project difference; calls off the allow-list never kept; failed, cut, schema-breaking and secret-holding answers never kept; the off
switches; Forget; the 14 days; the LRU limits; the runner path) and `tests/llm-response-cache-migration-68.test.ts`.
