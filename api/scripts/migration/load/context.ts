import type { Prisma, PrismaClient } from '@prisma/client'
import type { MigrationOptions } from '../config.js'
import type { IdMap } from '../idmap.js'
import type { Reporter } from '../report/reporter.js'
import type { TableMapping } from '../mapping/registry.js'
import { batches, countRows, tableExists } from '../legacy/client.js'
import type { LegacyRow } from '../legacy/client.js'
import type { Problem } from '../transform/values.js'

/** Everything a loader needs, passed once rather than threaded through calls. */
export interface LoadContext {
  prisma: PrismaClient
  idMap: IdMap
  reporter: Reporter
  options: MigrationOptions
  runId: string | null
  /** True when nothing may be written. */
  dryRun: boolean
}

/**
 * What one legacy row becomes.
 *
 * `skip` is a first-class outcome rather than a thrown error, because most
 * skips are expected (an orphan, a deliberately-unmigrated status) and a
 * migration that treats them as failures buries the real ones.
 */
export type RowOutcome =
  | { kind: 'written'; created: boolean }
  | { kind: 'skipped'; code: string; message: string; field?: string; value?: string }

export interface Loader {
  /** Legacy table this reads. Must exist in the registry. */
  table: string
  /** Primary target, for reporting. */
  target: string
  /**
   * Mappings this loader needs already resolved. The runner preloads each into
   * the id cache before calling, and a missing dependency is a configuration
   * error rather than something discovered mid-stream.
   */
  dependsOn?: { table: string; model: string }[]
  /** Called once before streaming, for catalog lookups a row-handler needs. */
  prepare?: (ctx: LoadContext) => Promise<void>
  /** Handles one legacy row inside a batch transaction. */
  row: (ctx: LoadContext, tx: Prisma.TransactionClient, row: LegacyRow) => Promise<RowOutcome>
}

/**
 * Runs one loader over its whole table.
 *
 * ── BATCH TRANSACTIONS, NOT ONE BIG ONE
 *
 * The brief is explicit, and it is right: a single transaction around 200k
 * bugs holds locks for the length of the run and loses everything on the last
 * row. Each batch commits on its own, so a failure costs one batch and the
 * report says exactly which rows were in it.
 *
 * A row that throws does NOT take its batch down. The batch is retried once,
 * row by row, so one malformed record cannot cost the other 499 — and the one
 * that actually fails is named in `migration-errors.csv`.
 */
export async function runLoader(
  ctx: LoadContext,
  loader: Loader,
  mapping: TableMapping,
): Promise<void> {
  const counter = ctx.reporter.counter(loader.table, loader.target)

  if (!(await tableExists(loader.table))) {
    ctx.reporter.review(
      loader.table,
      'Table is in the legacy schema dump but not in the source database — nothing read.',
    )
    return
  }

  if (!mapping.legacyPk) {
    ctx.reporter.review(loader.table, 'No primary key; cannot be streamed safely.')
    return
  }

  await loader.prepare?.(ctx)

  const limit = ctx.options.mode === 'full' ? undefined : ctx.options.sampleSize

  for await (const rows of batches(loader.table, mapping.legacyPk, {
    batchSize: ctx.options.batchSize,
    limit,
  })) {
    counter.read += rows.length

    if (ctx.dryRun) {
      // Validate transformations without writing: the row handlers run against
      // a transaction that is always rolled back, so a dry run exercises the
      // same code path a real one does instead of a simplified imitation.
      await dryRunBatch(ctx, loader, mapping, rows, counter)
      continue
    }

    try {
      await ctx.prisma.$transaction(async (tx) => {
        for (const row of rows) {
          await applyRow(ctx, loader, mapping, tx, row, counter)
        }
      })
    } catch (error) {
      // The batch rolled back. Replay row by row so one bad record does not
      // cost the rest, and so the failure is attributable.
      counter.inserted = 0
      counter.updated = 0
      await replayIndividually(ctx, loader, mapping, rows, counter, error)
    }
  }
}

async function applyRow(
  ctx: LoadContext,
  loader: Loader,
  mapping: TableMapping,
  tx: Prisma.TransactionClient,
  row: LegacyRow,
  counter: { inserted: number; updated: number; skipped: number; failed: number },
): Promise<void> {
  const outcome = await loader.row(ctx, tx, row)
  if (outcome.kind === 'skipped') {
    counter.skipped += 1
    ctx.reporter.skip(
      loader.table,
      legacyIdOf(row, mapping),
      loader.target,
      outcome.code,
      outcome.message,
      { field: outcome.field, value: outcome.value },
    )
    return
  }
  if (outcome.created) counter.inserted += 1
  else counter.updated += 1
}

async function dryRunBatch(
  ctx: LoadContext,
  loader: Loader,
  mapping: TableMapping,
  rows: LegacyRow[],
  counter: { inserted: number; updated: number; skipped: number; failed: number },
): Promise<void> {
  for (const row of rows) {
    try {
      // A rolled-back transaction gives the row handler a real client without
      // leaving anything behind. `Rollback` is thrown deliberately.
      await ctx.prisma
        .$transaction(async (tx) => {
          await applyRow(ctx, loader, mapping, tx, row, counter)
          throw new Rollback()
        })
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e
        })
    } catch (error) {
      counter.failed += 1
      ctx.reporter.fail(
        loader.table,
        legacyIdOf(row, mapping),
        loader.target,
        'TRANSFORM_FAILED',
        messageOf(error),
      )
    }
  }
}

async function replayIndividually(
  ctx: LoadContext,
  loader: Loader,
  mapping: TableMapping,
  rows: LegacyRow[],
  counter: { inserted: number; updated: number; skipped: number; failed: number },
  batchError: unknown,
): Promise<void> {
  ctx.reporter.review(
    loader.table,
    `A batch of ${rows.length} rolled back (${messageOf(batchError)}); replaying row by row.`,
  )
  for (const row of rows) {
    try {
      await ctx.prisma.$transaction(async (tx) => {
        await applyRow(ctx, loader, mapping, tx, row, counter)
      })
    } catch (error) {
      counter.failed += 1
      ctx.reporter.fail(
        loader.table,
        legacyIdOf(row, mapping),
        loader.target,
        'WRITE_FAILED',
        messageOf(error),
      )
    }
  }
}

class Rollback extends Error {}

export function legacyIdOf(row: LegacyRow, mapping: TableMapping): string | null {
  if (!mapping.legacyPk) return null
  const v = row[mapping.legacyPk]
  return v === null || v === undefined ? null : String(v)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Records any transformation problems a row produced. */
export function reportProblems(
  ctx: LoadContext,
  table: string,
  legacyId: string | null,
  target: string,
  problems: (Problem | null)[],
): void {
  for (const p of problems) {
    if (!p) continue
    ctx.reporter.problem({
      legacyTable: table,
      legacyId,
      targetModel: target,
      code: 'INVALID_VALUE',
      field: p.field,
      value: p.value,
      message: p.problem,
      action: 'DEFAULTED',
    })
  }
}

/** Counts every row in the table, for the dry run's estimate. */
export async function estimate(table: string): Promise<number | null> {
  if (!(await tableExists(table))) return null
  return countRows(table)
}
