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
| Anthropic (`LLM_PROVIDER=anthropic`) | A cache breakpoint on the instructions (system), which also covers the tool descriptions (Anthropic puts tools before the system text). A call with tools (an agent loop) also gets the request-level marker, which caches the conversation up to its last block, so each step reads what the previous step wrote. | 5-minute cache. At most 2 of Anthropic's 4 breakpoints. A prefix under the model's minimum (512 to 4096 tokens depending on the model) is simply not cached; nothing fails. |
| OpenRouter or another OpenAI-compatible gateway, with an Anthropic model (`anthropic/...` or a `claude` name) | Anthropic's `cache_control` passed through in the Chat Completions body: on the system message, and in an agent loop also on the first user message (the scenario and the first page snapshot, which every later step repeats). | The `ai` SDK has no option for it, so a `fetch` wrapper adds it to `/chat/completions` requests only. |
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

- `src/engine/llm/prompt-cache.ts` (all of it): which style a provider and model get, the Anthropic middleware (`transformParams` adds `providerOptions.anthropic.cacheControl` to the last system message, and at request level when the call has tools), the passthrough `fetch` for Chat Completions bodies, the switch (`promptCacheSetting`: Settings, then `LLM_PROMPT_CACHE`, then on), and `addUsage` for the counters.
- `provider.ts` builds every model of the chain (main and fallbacks) through `buildProviderModel(..., { promptCache })`, so a fallback on another provider gets that provider's own markers. Scripted doubles (`llmClientFromModel`) are not wrapped.
- `platform/prompt-cache-settings.ts`: the saved choice (key `llm_prompt_cache` in `ai_settings`), the routes, and `installPromptCache` (bootstrap, every process).

## Tests

- `tests/prompt-cache.test.ts` (19 tests, no browser; ports 7290-7291): the real `@ai-sdk/anthropic` and `@ai-sdk/openai` clients against a local fake Anthropic and fake OpenRouter: markers in the right place for a single call and for an agent loop, byte-identical requests apart from the markers, identical answers, the off switch from Settings (applied to a client that already exists) and from `LLM_PROMPT_CACHE`, nothing sent to other OpenRouter models, OpenAI or Google; usage parsing of cached tokens for both dialects; the weighted budget in the meter and the store agreeing; an older database gaining the columns; the Settings and usage routes; cache prices in the cost.
- The same file measures the effect on a **simulated** Anthropic cache (the documented prefix rules: breakpoints, a 20-block lookback, a 512-token minimum, characters / 4 as tokens), with the platform's real exploration instructions and a 2,400-character page snapshot per step:
  - a 10-step agent loop: 31,685 tokens without caching, 9,324 with it (26,289 of the input read from the cache, 5,196 written), **71% less**, same conversation and same answer;
  - 10 one-off calls with the same instructions: 9,610 tokens without, 4,931 with, **49% less**.
  These numbers are from the simulation, not from a provider bill.
- `tests/prompt-cache-ui.test.ts` (3 tests, Chromium, port 7292): the switch in Settings (default on, off saved, back to the server's setting), the cache line and column in AI usage, a cached-input price in the cost, axe in light and dark, 44 px label row, 375 px without sideways scroll.

## Limits (be aware)

- **Never verified against a real provider.** The markers follow the installed SDKs (`@ai-sdk/anthropic` 3.0, `@ai-sdk/openai` 3.0) and the providers' documentation; whether a real account gets cache hits, and how many, was not measured here. Check `cacheReadTokens` in AI usage after a real run.
- **OpenRouter passthrough is an assumption about OpenRouter**: it forwards `cache_control` in content parts to Anthropic. A gateway that refuses unknown fields would fail the request; turn caching off for it.
- **The weights are Anthropic's.** OpenAI's cached input is priced differently by model (a tenth to a half), and writes are free there; the limits still count reads at 0.1. Money follows the prices you type in.
- The 5-minute cache expires between slow steps (a long page load, a paused job); a step after that writes again.
- Caches are per model: a fallback model, or the fast model of model routing, starts its own cache.
- One-off calls only cache their instructions; most of their input (page content, the app model) differs every call.
- A one-off call whose instructions never repeat within 5 minutes (for example the single "understand the app" call of a job) pays the 25% write premium on its instructions for nothing; on the sizes the platform uses that is a few hundred tokens.
