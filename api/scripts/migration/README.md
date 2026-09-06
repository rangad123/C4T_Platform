# scripts/migration

Legacy MariaDB → PostgreSQL data migration.

**Operator documentation is [`docs/MIGRATION.md`](../../../docs/MIGRATION.md).**
**The table-by-table mapping is [`docs/MIGRATION-MATRIX.md`](../../../docs/MIGRATION-MATRIX.md)**,
generated from `mapping/registry.ts`.

This file is for whoever has to change the code.

## Layout

```
config.ts              env + CLI flags, validated with zod
idmap.ts               legacy (table, id) → new id
run.ts                 the orchestrator

legacy/client.ts       read-only MariaDB pool, keyset batching
mapping/registry.ts    all 66 legacy tables and what happens to each
mapping/lookups.ts     legacy value → new enum member
transform/values.ts    MySQL → Postgres value coercion
load/context.ts        the Loader interface and the batch runner
load/*.ts              one loader per legacy table
validate/checks.ts     count and relationship verification
report/reporter.ts     CSV/JSON/Markdown output
report/matrix.ts       regenerates the matrix doc
```

## Adding a loader

1. Add or update the table's entry in `mapping/registry.ts`. Its `phase`
   decides when it runs; parents must be in an earlier phase.
2. Write a `Loader` and export it from one of the `load/*.ts` files.
3. Add it to the array `run.ts` builds `ALL_LOADERS` from.
4. `npm run migration:matrix` and commit the regenerated doc.

A loader returns either `{ kind: 'written', created }` or
`{ kind: 'skipped', code, message }`. There is no third option, which is what
makes "nothing is dropped silently" structural rather than a convention: a row
cannot leave a loader without being counted.

## Rules this code follows

- **Never resolve a reference by name when a legacy id exists.** Two projects
  called "Regression" in different organisations must not merge. `idmap.ts` is
  the mechanism; the two deliberate exceptions (browsers, which the catalog
  seed imported by name without recording legacy ids) are commented where they
  occur.
- **Never write to the legacy database.** `legacy/client.ts` refuses anything
  that is not a `SELECT`.
- **Never log a secret.** Password hashes are reported by length, bank details
  never at all.
- **Report, do not guess.** An unmapped enum value returns the fallback _and_ a
  problem record. A truncation returns the shortened value _and_ a problem
  record.

## Tests

`tests/migration/values.test.ts` covers the transformation layer — zero dates,
the four spellings of boolean, comma-separated id columns, money to minor
units. These run without either database:

```bash
npx vitest run tests/migration/values.test.ts
```

The loaders themselves need a legacy database to exercise; see
`docs/MIGRATION.md` for the dry-run → sample → full sequence.
