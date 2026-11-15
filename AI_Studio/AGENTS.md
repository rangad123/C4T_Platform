# AI Studio: notes for coding agents

Project-specific commands and conventions. Node 24 or later (`engines`). Run everything from `AI_Studio/`.

## Commands
- Typecheck both projects: `npx tsc --noEmit` (server) and `npx tsc --noEmit -p web` (web UI).
- Web build: `npx vite build web` (UI tests read `web/dist`).
- Missed `await` check: `npx tsx scripts/floating-promises.ts` (exit 1 on new findings).
- After adding a migration slot: `npx tsx scripts/pg-baseline.ts`, then read the diff of `src/platform/pg/baseline.sql`.

### Test tiers (details: `docs/features/test-suite.md`)
| Command | Runs |
|---|---|
| `npm run test:fast` | files listed in `vitest.fast.config.ts`, no browser, in parallel |
| `npm run test:browser` | every other non-phone file, one at a time |
| `npm run test:phone` | files using the fake phone tools, one at a time |
| `npm run test:release` | the release gate: all tiers, retry once, flaky allow-list in `tests/flaky-allowlist.json` |
| `node scripts/test-tiers.mjs` | prints which tier each file is in |

A new browser-free test file goes in the fast tier by adding one line to `vitest.fast.config.ts`. The fast tier must never start a
browser (CI watches for it with `scripts/no-browser-watch.mjs`).

### Locks (machine-wide, shared by every checkout)
Anything that starts a browser or builds `web/dist` runs under a lock; never bypass it.
- One browser test file: `node scripts/with-lock.mjs browser -- npx vitest run tests/<file>`
- Web build: `node scripts/with-lock.mjs build -- npx vite build web`
- Build, then a browser test: `node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/<file>"`
- Who holds what: `node scripts/lock-status.mjs`

Locks are taken in the fixed order build < browser and released in reverse. `with-lock` runs its command without a shell.

## Layout
- `src/engine/`: test generation and execution (spec schema, generators, live interpreter, authoring agent, healing, evidence,
  retention rules, identity checks).
- `src/platform/`: the HTTP server, stores, routes (`routes/`), auth and permissions (`auth/`), migrations (`db.ts`),
  PostgreSQL baseline (`pg/baseline.sql`).
- `src/security/`: security assessments, scanner adapters, egress guard, authorization and approval gates.
- `src/agent/`: the runner program people install on their own machine.
- `src/shared/`: code used by more than one side (for example `redact-text.ts`).
- `web/src/`: the React UI (`features/`, `pages/`, `components/`, `styles/`).
- `tests/`: vitest files; tiers are worked out from the files themselves.
- `docs/`: user, admin, API and architecture guides; `docs/features/*.md` per feature.

## Conventions
- 4-space indentation, double quotes, semicolons, long lines allowed. Do not run prettier on this folder; match the surrounding file.
- User-facing text is plain language: short whole sentences that say what happened and what to do next, without jargon. Refusals are `HttpError` with a status (often 409/403/422) and a sentence, never a 500.
- Permission checks happen on the server for every route and action (`src/platform/auth/`); hiding a button is not a check.
- Secrets are write-only and SecretBox-encrypted; the API never returns them. `tests/secret-leak.test.ts` must keep passing.
- Mask on write: text that can hold application content (URLs, step errors, logs, AI reasoning) goes through `maskText` /
  the shared redaction before it is stored (`tests/masking-on-write.test.ts`).
- Migrations are append-only: add a new numbered slot at the end of `MIGRATIONS` in `src/platform/db.ts` with a comment saying what it
  does; never edit a shipped slot. Mirror the schema in `src/platform/pg/baseline.sql` (`tests/pg-baseline-unit.test.ts` compares them).
  Write slots in the portable SQL subset.
- Stores are async: `await` every store call; a promise in a condition makes a permission check silently pass.
- Tests use scripted doubles for AI providers and external services; they never contact a real provider or a production host.
  Phone tests run with `TAQWRIGHT_HOME` pointing at a folder that does not exist.
- A bug fix comes with a test that fails without the fix. Never weaken or skip a test to make it pass.
- Tests and experiments stop only the processes they started (by captured PID or process group), never by name.
- A new step or check kind in the spec must be added to the schema (`src/engine/spec/schema.ts`), the Playwright generator, the live
  interpreter (`src/engine/web/interpreter.ts`), the authoring tools (`src/engine/web/author.ts`) and the healing paths; other
  generators refuse it in plain words if they cannot render it.
- No new dependency without the maintainers' approval.
