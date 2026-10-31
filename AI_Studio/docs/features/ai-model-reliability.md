# AI model reliability: retries, fallback models, provider errors

AI providers have bad minutes: rate limits, overloads, timeouts, a key that ran out of credit. This feature keeps jobs going through
those, says plainly what happened, and shows the model's recent health in Settings.

## What a tester sees

- **Plain errors.** A failed AI call says what went wrong in words, for every supported provider (Anthropic, OpenAI, Google, OpenRouter,
  local OpenAI-compatible servers): "The AI provider is out of credit. Add credit or raise the spending limit with the provider." instead
  of a status code. OpenRouter's generic "Provider returned error" is unpacked: the sentence names the upstream provider and its own message,
  for example "The AI provider is overloaded right now. (upstream Anthropic: Overloaded)".
- **Job events** (the job's activity log) say when the platform asked again ("…rate limited. Asking main-model again in 4 s (attempt 2 of 6)"),
  when it switched to a fallback model ("main-model is unavailable (out of credit); asking the fallback model backup-model."), when a
  provider was paused, and which model answered. At most 40 such events per job.
- **Settings, AI model**:
  - recent health per model over the last 24 hours: share of requests that worked, average time to answer, the last problem in words;
  - a warning while calls to a provider are paused;
  - **Check the connection**: one tiny request to the main model (one attempt, no fallback, sent even while the provider is paused). It
    counts as AI usage (listed as "Connection checks" in AI usage) and is refused when the monthly AI limit is reached. One check at a time,
    at most one every 5 seconds;
  - **Fallback models**: the list saved here wins over the server's `LLM_FALLBACK_MODELS`; "Use the server's list" forgets it. Entries the
    server cannot use (no key for that provider, no address for a custom endpoint, the main model itself) are listed with the reason and skipped.

## How it works

- `src/engine/llm/errors.ts` classifies any failure into one class: rate limited, overloaded, provider error, no answer in time, network,
  key refused, out of credit, unknown model, answer refused, unusable answer, request rejected, paused, unknown. It reads status codes,
  the provider's JSON error body (OpenRouter's `error.code`, `error.metadata.raw`, `error.metadata.provider_name`, `reasons`), the
  `retry-after-ms` / `retry-after` headers and Google's `retryDelay`. Anything key-like is hidden from the text.
- `src/engine/llm/resilience.ts`: `ResilientModel` is an ordinary AI SDK model in front of a chain (main model, then fallbacks), so the
  engine, the usage meter and the web authoring agent use it unchanged.
  - Each request has a time limit (`LLM_TIMEOUT_MS`, default 120 s) and the whole call a deadline (`LLM_CALL_DEADLINE_MS`, default 10 min).
  - Retryable classes (rate limited, overloaded, provider error, timeout, network) are asked again up to `LLM_RETRY_ATTEMPTS` requests
    per model (default 6) with exponential backoff from 1 s (cap 30 s) and jitter (half to all of the wait), never shorter than the
    provider's Retry-After. A provider asking for more than 60 s, or a wait past the deadline, moves on to the next model.
  - Out of credit, key refused, unknown model, paused and exhausted retryable classes move to the next model. A refused answer, an invalid
    request and an unusable answer do not (another model would not fix them).
  - **Circuit breaker** per provider (and address, for custom endpoints), shared by every job of the process: after 5 failures in a row
    of the availability classes, calls to it stop for 60 s; then one trial request decides. A stopped job (cancel) is never counted.
  - The SDK's own retries are set to 0 for this model and its final error is not one the SDK retries, so nothing is retried twice over.
- `src/engine/llm/provider.ts`: builds the chain from `LLM_PROVIDER`/`LLM_MODEL` plus the fallback list (`[provider:]model`, comma or
  line separated, at most 5; a known provider prefix only, so OpenRouter names with a colon stay whole). A fallback on another provider
  uses that provider's usual key variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`).
  **Structured output**: an answer that is not valid JSON or does not match the schema is asked for once more with what was wrong
  ("Your previous answer could not be used: steps: …"); a second unusable answer fails plainly (class "unusable answer"). The tokens
  of the unusable answer are counted.
- **Usage per model**: the usage meter runs each call in an `AsyncLocalStorage` slot that the resilient model fills with the model that
  answered, so tokens and cost are recorded under the fallback model when it answered (concurrent calls of one job stay apart).
- `src/engine/llm/health.ts` keeps the last 100 samples per model in memory (time, model, worked or not, duration, error class).
  `src/platform/llm-health.ts` writes them, at most once a second, to the `ai_settings` table under one row per process
  (`llm_health:<id>`), so the API process also sees what a separate worker saw; rows silent for 7 days are removed. The saved fallback list
  is the `llm_fallback_models` row. No migration of its own.
- Routes (`src/platform/llm-health-routes.ts`, API key required): `GET /api/llm/health`, `PUT /api/llm/fallbacks { models: string[] | null }`,
  `POST /api/llm/check`. Answers never contain a key or the custom endpoint's address.

## Settings (server environment)

| Variable | Default | Meaning |
|---|---|---|
| `LLM_FALLBACK_MODELS` | none | Fallback models in order, e.g. `claude-haiku-4-5, openai:gpt-5.4`. Settings wins when a list is saved there. |
| `LLM_RETRY_ATTEMPTS` | 6 | Requests per model for one call (1-10). |
| `LLM_TIMEOUT_MS` | 120000 | Time limit of one request. |
| `LLM_CALL_DEADLINE_MS` | 600000 | Time limit of one call, retries and fallbacks included. |

An empty or unreadable value keeps the default.

## Tests

- `tests/llm-resilience-unit.test.ts` (fast tier): error classes for each provider's error shapes including OpenRouter's "Provider returned
  error", Retry-After, backoff, the breaker's states, fallback parsing and readiness, the health summary, retry/fallback/pause/timeout/stop
  decisions with scripted model doubles, the repair re-ask, usage recorded per model.
- `tests/llm-resilience.test.ts`: the real provider SDKs over HTTP against a local fake provider (`tests/fixtures/fake-llm-provider.ts`,
  OpenAI chat, Anthropic messages, Google generateContent): rate limit with Retry-After, 402 to a fallback with events and usage per model,
  "Provider returned error", a hanging request, a closed port, a refused key, a filtered answer, invalid JSON repaired and not repaired,
  the breaker stopping requests, Anthropic 529 and low credit to a Google fallback, Google RESOURCE_EXHAUSTED; and the Settings routes on a
  real platform (API key, fallback list from the environment and from Settings, the check, its usage row, health).

## What is not covered

- No real provider was called: the error shapes come from the providers' documentation and the fake reproduces them. A provider changing
  its error wording can land in a less precise class (the status code still decides the common cases).
- The breaker and the in-memory health are per process; another process learns about a paused provider only through the health rows
  (shown in Settings), not by pausing its own calls.
- Streams are retried or moved to a fallback only before the first part arrives (the engine does not stream today).
- The phone explorer still has its own one re-ask on an unusable turn on top of the central one, so an unusable turn can cost up to four
  requests (its turn budget still counts two).
- Usage of the web authoring agent's steps is attributed to the model of its most recent call.
- The connection check uses the main model only; fallbacks are checked by real use.

## What the owner must provide

A key for each provider used (`LLM_API_KEY` or the provider's variable; for fallbacks on another provider that provider's variable), and
for a custom endpoint `LLM_BASE_URL`.
