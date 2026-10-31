# Smaller page snapshots

*The AI reads a shorter version of each page while it writes a web test, and of each screen while it explores a phone app, so the same work costs fewer tokens.*

## What it does for you

When the AI writes a web test it performs the scenario in a real browser and, after every action, reads the page as an accessibility snapshot (the list of headings, links, buttons, fields and text a screen reader would see). Every earlier snapshot stays in the conversation, so on a long page the snapshots are most of what a test costs. With this setting on (the default):

- the first look at a page is complete but compact;
- after an action on the same page the AI gets only what changed;
- it can always ask for the whole page again (the `seeWholePage` tool).

Nothing changes in what a test does or how it is judged: the names and roles the AI copies into a test are never altered, and the scripted tests in `tests/snapshot-agent.test.ts` show the same scenario producing the same steps and a byte-identical script with the setting off and on.

**Settings, AI model**, **Send smaller page snapshots to the AI** turns it off and on (a choice saved there wins over the server's `LLM_COMPACT_SNAPSHOTS`; **Use the server's setting** goes back). It applies from the next test the AI writes or the next phone exploration. A job's technical details show **Page snapshots: … saved about N tokens** (an estimate), and the job's activity has one line per test the AI wrote.

## The rules (src/engine/snapshots/compact.ts)

Compaction of one snapshot, applied to Playwright's own snapshot text:

| Rule | Example |
|---|---|
| Hidden and `aria-hidden` elements are not there | Playwright already leaves them out of the snapshot; nothing extra is needed |
| Decorations are dropped | an image without a name, a separator, text that is only punctuation (`|`, `·`) |
| Layout-only wrappers are unwrapped | an unnamed `generic`, `none` or `presentation` node: its children move up |
| A link's address goes on its line | `- link "Home":` + `- /url: /` → `- link "Home" [url=/]` |
| Long text is shortened | a text value over 200 characters keeps its first ~160 and ends `… (N more characters)` |
| Runs of look-alike siblings are collapsed | 6 or more siblings with the same structure (names and text ignored): the first 3 stay in full, then one line `(37 more article like the 3 above, each: heading [link], paragraph, button "Add to cart". In order: link "Headlamp Pro 1", $31.50; …)`. The line names every collapsed actionable element by its exact `role "name"`, in page order, and what all of them share once. A collapse that would not save at least 30% is not made; past about 2,000 characters of names the line ends `and N more, see the whole page`. |

Every line that stays is copied verbatim (role, accessible name, states, values). Actionable roles (button, link, textbox, checkbox, radio, combobox, option, menuitem, tab, switch, slider, …) always keep their exact `role "name"`; `tests/snapshot-compact.test.ts` checks this on every recorded snapshot.

**What changed.** After the first snapshot of a page (same origin and path; the query may differ), the next one is compared line by line with the last one the AI saw and only the differences are sent, each under the path of its parents: `At main > search "Filter":` then `added:`, `removed:` or `changed:` with `(was: …)`. The message starts with a short page summary, `Same page (/cart, heading "Your cart", 12 controls)`. When nothing changed it says so in one line. The compact snapshot is sent instead when the page is a different one, the list of changes would be longer than 60% of it, the snapshot is unavailable, or after 10 change lists in a row (so the picture never drifts far).

**Instructions.** With the setting on, one short constant paragraph is added to the authoring instructions (it explains the markers and the tool; constant, so prompt caching still applies) and the `seeWholePage` tool is offered. With it off, the instructions, tools and snapshots are exactly as before.

**Limits kept.** The page is read up to 60,000 characters before compacting; what is sent is still cut at the old limits (9,000 characters for the first snapshot, 7,000 after an action), so a large page now shows more of itself within the same limit. `seeWholePage` returns up to 16,000 characters.

## Phone exploration (src/engine/snapshots/phone.ts)

Each exploration turn is a fresh question (the model keeps no history), so there is no "what changed" list on phones; only the screen description is made smaller:

- an element that cannot be acted on or read (not clickable, editable, scrollable or checkable, with no text or label) is left out;
- 6 or more consecutive elements with the same class, kind and id pattern keep their first 3 lines, then `(27 more TextView id like product_# like the 3 above; each listed by number and name only)` and one `[15] "Product 4"` line per element.

Every remaining element keeps its number and its exact text and label, so an answer means the same element. Elements in different states (checked and not checked) are never collapsed together. Freed room lets more elements of a long screen fit under the description's existing limits.

## Measured effect (scripted model, recorded traffic)

From `tests/snapshot-compact.test.ts` and `tests/snapshot-agent.test.ts` (characters / 4 ≈ tokens):

| Case | Without | With |
|---|---|---|
| Catalog page snapshot (40 products, 24 orders) | 14,835 characters | 5,054 (66% fewer) |
| Sample app sign-in, 7 model steps, whole prompts | 36,466 characters | 33,874 (7% fewer); snapshot text read over the run 43% fewer |
| Catalog scenario, 6 model steps, whole prompts | 190,230 characters | 56,874 (70% fewer) |
| Same, when the AI also asks for the whole page once | 190,230 | 162,177 (15% fewer) |
| Phone screen with a 30-item list | 1,752 characters | 1,199 (32% fewer) |
| Phone shop fixture (small screens) | unchanged | unchanged |

Small pages gain little (the added paragraph of instructions costs about as much as it saves); long pages and pages where many actions change little gain most. A whole-page look is expensive because it stays in the conversation.

## How savings are counted

Each authoring session writes a job event `snapshot_savings` (phone exploration: one per exploration) with the snapshot characters it would have sent before and what it sent, counted as the model read them (each model step re-reads the earlier snapshots), converted to tokens at 4 characters per token. `GET /api/jobs/:id/usage` adds them up in `snapshotSavings` (`null` when the job did not use smaller snapshots). These are estimates of snapshot text only; the real tokens the provider reports are counted as before.

## Switch

- Environment: `LLM_COMPACT_SNAPSHOTS` (on unless `false`, `off`, `0` or `no`).
- Settings: `GET/PUT /api/llm/compact-snapshots` `{ enabled: true | false | null }` (owner; null = follow the environment), stored in `ai_settings` (key `llm_compact_snapshots`).

## What is not covered

- Not measured with a real model: whether a real model makes the same choices from shorter snapshots is untested here (no real AI calls in tests). The evaluation harness's compare mode is the way to check it with a real key.
- Collapsed items show only their names; acting on something inside one (for example the 20th "Add to cart" button) needs `nth` counted from the "In order" list or a whole-page look.
- Repeating `seeWholePage` many times can make a session cost more than before.
- The usage page across projects does not add up snapshot savings; the per-job usage does.
