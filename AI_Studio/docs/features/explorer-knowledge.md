# What the explorer knows

Every web exploration says what it found, what it took from the last exploration instead of doing again, and what the AI caches saved.
The card is called **What the explorer knows**. It is read-only: it shows what the exploration recorded and asks nothing of the AI.

## Where it is

* **A run page** of a web exploration, while it runs (it refreshes every few seconds) and after it ends. Plan-only explorations have it too.
* **The project's Dashboard**, for the latest finished web exploration of an AI agent project.

Phone explorations and code projects do not show it. The card is hidden until the exploration has found a page or has something to say about
reuse.

A line on top sums it up, for example "12 pages found, 9 pages reused from the last exploration; reuse was switched off." Two tabs follow,
and only the chosen one shows.

### Site map

The pages the exploration found, as a tree by address, with each page's title and type. Each page lists the tests of this exploration that
start on it, as links. A page that took its probe results from an earlier exploration has a **Reused &lt;date&gt;** badge. A page tried
again after reuse went off loses the badge. The map comes from the model the exploration saved. While it runs, the map comes from the pages
its events name.

**Thumbnails.** Each page can carry a small picture taken right after the page opened, before anything was clicked or typed:

* 320 px wide JPEG, at most 40 KB each, and at most 300 pictures or 4 MB per exploration. The platform checks the size and that the
  bytes are a JPEG again before it stores one, because a runner's pictures come from another machine.
* **Covered.** Password, one-time code and card fields, and any field holding one of the project's saved secrets, are covered before the
  picture is taken. This is the same covering the Explorer view uses. **It fails closed:** a page that cannot be covered gets no picture.
* Stored as job artifacts (kind `screenshot`, `thumb-<n>.jpg`), served as `image/jpeg` by `GET /api/artifacts/:id` to people who may see the
  project (another project's picture is a `404`). They expire with the project's screenshots under its retention policy; the map names a
  picture only while its file is kept.

**The switch.** Project **Settings → General → Keep page thumbnails** (owner decision 2026-11-21): **on by default**. Off means later
explorations take and store no pictures. Pictures kept before stay until they expire. Only people who may change the project's settings
can change it, and it can be saved once the application has an address. It is saved with what the agents need
(`project_agent_inputs.settings_json`, `keepThumbnails`; never saved means on) and travels in a project backup.

### Reused and why

* **Pages not tried again**: the reused pages with the date of the exploration they came from, and how many pages were probed anyway as
  a spot check and matched.
* One sentence for each other saving: the exploration started from the pages known last time (and how many are gone), went straight to
  the sign-in page (the form was still filled and the sign-in checked), did not send unchanged pages to the AI again, and how many
  requirements reached the planning of their pages and how many went to a pass of their own.
* Pages tried again because their results were over 30 days old or reused 5 times in a row, or because they had changed.
* **Reuse was switched off**, as a warning, with its reason as a sentence: a spot check found a page behaving differently, more than half
  of the known pages changed, or you chose Explore everything again. Every page was tried again from then on.
* "Nothing was reused" when nothing was.

Tests, checks, validations and repairs are never taken from an earlier exploration, and the card says so. The rules of reuse are in
[site-memory.md](site-memory.md).

### AI use and cache savings (who sees them)

Under Reused and why, people who may see AI usage (`ai_studio.usage.view`) see the exploration's AI figures:

| Figure | From |
|---|---|
| AI calls made | `ai_usage.calls` of this job |
| Input read from the prompt cache | cache read tokens as a share of the input tokens ([prompt-caching.md](prompt-caching.md)) |
| Cache read tokens, cache write tokens | `ai_usage.cache_read_tokens`, `cache_write_tokens` |
| AI calls saved | answers the response cache gave instead of an AI call (`ai_usage.cached_calls`) |
| Tokens saved | the input and output tokens those answers would have used (`saved_input_tokens` + `saved_output_tokens`) |

For anyone else the whole `cacheSavings` object is left out of the answer, by the route and again by the shared cost-field filter
(`auth/cost-hiding.ts`), so no token count or call count reaches them. The rest of the card is the same for both. Money is not shown here;
the AI usage page in Settings has the cost.

## API

`GET /api/projects/:id/jobs/:jobId/knowledge` (read access to the project):

```
{
  siteMap: { pages: [{ path, title, type, depth, reusedFrom?, thumbnail?, tests: [{ id, testKey, title }] }], from: "model" | "events" },
  reused: { pages: [{ path, since }], total, spotChecked, expired, changed, reprobed, signIn, pagesFromMemory, understanding, requirements, memory },
  reuseOff: [{ reason, message }],
  thumbnails: { keep, count },
  cacheSavings?: { aiCalls, inputTokens, cacheReadTokens, cacheWriteTokens, cacheReadPercent, aiCallsSaved, savedInputTokens, savedOutputTokens }
}
```

It is built only from what the job recorded: its events (`page_visited`, `probes_reused`, `reuse_off`, `reuse_reprobed`, `pages_from_memory`,
`signin_reused`, `understanding_reused`, `full_exploration`, `requirements_retrieved`, `memory_used`, `response_cache_hit`), the model it
saved, its tests and its AI usage rows. Another project's job is a `404`.

## For developers

* Route: `src/platform/routes/knowledge.ts`. Thumbnails: `src/engine/discovery/thumbnails.ts` (covering in `engine/frames/shoot.ts`), stored
  through `GenerationSink.savePageThumbnail` (`RepoSink`, and the explore sink for runners). The switch: `agent-inputs-store.ts`,
  `routes/agent-inputs.ts`; the job runner passes `pageThumbnails` from it.
* UI: `web/src/features/explore/ExplorerKnowledge.tsx` (the card), `KeepThumbnails.tsx` (the switch), on `RunDetail.tsx` and
  `ProjectOverview.tsx`. The progress tree's reused badges: `explore-tree.ts`.
* Tests: `tests/explorer-knowledge.test.ts` (the route's shape, cost fields hidden, 404 across projects, thumbnails as artifacts),
  `tests/explore-thumbnails.test.ts` (a real crawl: pixel check of the covering, fail closed, the switch on and off),
  `tests/explorer-knowledge-ui.test.ts` (axe in light and dark, 390 px), `tests/explore-tree-unit.test.ts`, `tests/explore-sink.test.ts`.
