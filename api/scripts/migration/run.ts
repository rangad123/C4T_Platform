import { PrismaClient } from '@prisma/client'
import {
  TOOL_VERSION,
  migrationEnv,
  optionsFromArgv,
  sourceDescriptor,
  type MigrationMode,
} from './config.js'
import { IdMap } from './idmap.js'
import { closeLegacyPool, query } from './legacy/client.js'
import { REGISTRY_BY_TABLE, isMigrated, selectedMappings } from './mapping/registry.js'
import { Reporter } from './report/reporter.js'
import { estimate, runLoader, type LoadContext, type Loader } from './load/context.js'
import { identityLoaders } from './load/identity.js'
import { projectLoaders } from './load/projects.js'
import { defectLoaders, linkTestReportsToBugs } from './load/defects.js'
import { communicationLoaders, financeLoaders } from './load/finance.js'
import { assetLoaders } from './load/assets.js'
import { checkIntegrity, checkReferenceCollisions, compareCounts } from './validate/checks.js'

/**
 * The migration orchestrator.
 *
 * ── ORDER COMES FROM THE REGISTRY, NOT FROM THIS FILE
 *
 * Loaders declare the table they read; the registry declares which phase that
 * table belongs to. Sorting by phase is what produces a dependency-correct
 * order, so adding a loader cannot silently run before its parents — and a
 * loader whose declared `dependsOn` has not run yet is a configuration error
 * this file reports rather than a mystery orphan in the output.
 */

const ALL_LOADERS: Loader[] = [
  ...assetLoaders,
  ...identityLoaders,
  ...projectLoaders,
  ...defectLoaders,
  ...financeLoaders,
  ...communicationLoaders,
]

function loaderFor(table: string): Loader | undefined {
  return ALL_LOADERS.find((l) => l.table === table)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const fallbackMode = (process.env.MIGRATION_MODE as MigrationMode | undefined) ?? 'dry-run'
  const options = optionsFromArgv(argv, fallbackMode)
  const env = migrationEnv()
  const dryRun = options.mode === 'dry-run'

  const startedAt = new Date()
  const reporter = new Reporter(options.reportDir)
  const prisma = new PrismaClient()
  const idMap = new IdMap(prisma)

  console.log(`\nCrowd4Test legacy migration — ${options.mode}`)
  console.log(`  source      : ${sourceDescriptor()}`)
  console.log(`  destination : ${maskUrl(env.DATABASE_URL)}`)
  console.log(`  batch size  : ${options.batchSize}`)
  if (options.mode !== 'full') console.log(`  row limit   : ${options.sampleSize} per table`)
  if (dryRun) console.log('  NOTHING WILL BE WRITTEN — every transaction is rolled back.\n')
  else console.log('')

  // ── Preflight ───────────────────────────────────────────────────────────
  await assertConnectivity(prisma)

  let runId: string | null = null
  if (!dryRun) {
    const run = await prisma.migrationRun.create({
      data: {
        mode: options.mode === 'full' ? 'FULL' : 'SAMPLE',
        sourceDatabase: sourceDescriptor(),
        toolVersion: TOOL_VERSION,
        schemaVersion: await schemaHead(prisma),
      },
      select: { id: true },
    })
    runId = run.id
    console.log(`  run id      : ${runId}\n`)
  }

  const ctx: LoadContext = { prisma, idMap, reporter, options, runId, dryRun }

  const mappings = selectedMappings(options.only, options.skip)
  let failedTables = 0

  try {
    for (const mapping of mappings) {
      if (!isMigrated(mapping)) {
        // Still counted, so the report can say what was left behind and how big it was.
        const rows = await estimate(mapping.legacyTable)
        if (rows && rows > 0) {
          reporter.review(
            mapping.legacyTable,
            `${rows} rows NOT migrated (${mapping.disposition}): ${mapping.notes}`,
          )
        }
        continue
      }

      const loader = loaderFor(mapping.legacyTable)
      if (!loader) {
        reporter.review(
          mapping.legacyTable,
          `Registry maps this to ${mapping.targets.join(', ')} but no loader is implemented yet.`,
        )
        continue
      }

      // Warm the caches this loader's parents wrote.
      for (const dep of loader.dependsOn ?? []) {
        await idMap.preload(dep.table, dep.model)
      }

      const label = `${mapping.legacyTable} → ${loader.target}`
      process.stdout.write(`  ${label.padEnd(46)}`)

      try {
        await runLoader(ctx, loader, mapping)
        const c = reporter.counter(loader.table, loader.target)
        console.log(
          `read ${String(c.read).padStart(7)}  ins ${String(c.inserted).padStart(6)}  upd ${String(
            c.updated,
          ).padStart(5)}  skip ${String(c.skipped).padStart(5)}  fail ${String(c.failed).padStart(4)}`,
        )
      } catch (error) {
        failedTables += 1
        console.log('FAILED')
        reporter.fail(
          mapping.legacyTable,
          null,
          loader.target,
          'TABLE_FAILED',
          error instanceof Error ? error.message : String(error),
        )
        if (!options.continueOnError) throw error
      }
    }

    // Deferred: the test-report → bug link points forward in phase order.
    if (!dryRun) {
      const linked = await linkTestReportsToBugs(ctx)
      if (linked > 0) console.log(`\n  linked ${linked} test reports to their bugs`)
    }

    // ── Validation ────────────────────────────────────────────────────────
    console.log('\nValidating…')
    const counts = await compareCounts(prisma, reporter)
    const unbalanced = counts.filter((c) => c.difference !== null && c.difference !== 0)
    for (const c of unbalanced) {
      reporter.review(c.legacyTable, `Count check: ${c.note}`)
    }
    console.log(
      `  count checks     : ${counts.length - unbalanced.length}/${counts.length} balanced`,
    )

    if (!dryRun) {
      const integrity = [
        ...(await checkIntegrity(prisma)),
        ...(await checkReferenceCollisions(prisma)),
      ]
      for (const check of integrity) {
        if (check.failures > 0) {
          reporter.review('(integrity)', `${check.name}: ${check.failures} — ${check.detail}`)
        }
      }
      const failing = integrity.filter(
        (c) => c.failures > 0 && !c.name.startsWith('users still on'),
      )
      console.log(
        `  integrity checks : ${integrity.length - failing.length}/${integrity.length} clean`,
      )
      for (const f of failing) console.log(`    ! ${f.name}: ${f.failures}`)
    }

    // ── Persist metadata ──────────────────────────────────────────────────
    if (runId) {
      await persistRun(prisma, runId, reporter, failedTables)
    }
  } catch (error) {
    if (runId) {
      await prisma.migrationRun.update({
        where: { id: runId },
        data: { status: 'FAILED', completedAt: new Date(), notes: String(error) },
      })
    }
    throw error
  } finally {
    const dir = reporter.write({
      mode: options.mode,
      runId,
      source: sourceDescriptor(),
      startedAt,
      finishedAt: new Date(),
      notMigrated: [...REGISTRY_BY_TABLE.values()]
        .filter((m) => !isMigrated(m))
        .map((m) => ({
          legacyTable: m.legacyTable,
          disposition: m.disposition,
          notes: m.notes,
        })),
    })
    console.log(`\nReports written to ${dir}/`)
    await closeLegacyPool()
    await prisma.$disconnect()
  }
}

async function persistRun(
  prisma: PrismaClient,
  runId: string,
  reporter: Reporter,
  failedTables: number,
): Promise<void> {
  for (const c of reporter.allCounters()) {
    await prisma.migrationTableStat.upsert({
      where: {
        runId_legacyTable_targetModel: {
          runId,
          legacyTable: c.legacyTable,
          targetModel: c.targetModel,
        },
      },
      create: {
        runId,
        legacyTable: c.legacyTable,
        targetModel: c.targetModel,
        recordsRead: c.read,
        recordsInserted: c.inserted,
        recordsUpdated: c.updated,
        recordsSkipped: c.skipped,
        recordsFailed: c.failed,
        completedAt: new Date(),
      },
      update: {
        recordsRead: c.read,
        recordsInserted: c.inserted,
        recordsUpdated: c.updated,
        recordsSkipped: c.skipped,
        recordsFailed: c.failed,
        completedAt: new Date(),
      },
    })
  }

  // Errors are persisted in chunks; a big run can produce a lot of them.
  const errors = reporter.problems.filter((p) => p.action === 'FAILED' || p.action === 'SKIPPED')
  for (let i = 0; i < errors.length; i += 500) {
    await prisma.migrationError.createMany({
      data: errors.slice(i, i + 500).map((p) => ({
        runId,
        legacyTable: p.legacyTable,
        legacyId: p.legacyId,
        targetModel: p.targetModel,
        code: p.code,
        field: p.field,
        value: p.value,
        message: p.message,
        action: p.action,
      })),
    })
  }

  await prisma.migrationRun.update({
    where: { id: runId },
    data: {
      status: failedTables > 0 ? 'FAILED' : 'COMPLETED',
      completedAt: new Date(),
    },
  })
}

async function assertConnectivity(prisma: PrismaClient): Promise<void> {
  try {
    await query('SELECT 1')
  } catch (error) {
    throw new Error(
      `Cannot read the legacy database at ${sourceDescriptor()}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (error) {
    throw new Error(
      `Cannot reach the destination database: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  // The metadata tables must exist, or idempotency silently degrades.
  try {
    await prisma.migrationRecordMap.count()
  } catch {
    throw new Error(
      // `db push`, not `migrate dev`: this repo's migrations folder holds only
      // the init migration, so `migrate dev` would offer to reset the database.
      'migration_record_map is missing. Apply the schema first:  cd api && npx prisma db push',
    )
  }
}

async function schemaHead(prisma: PrismaClient): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
       WHERE finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT 1
    `
    return rows[0]?.migration_name ?? null
  } catch {
    return null
  }
}

function maskUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')
}

main().catch((error: unknown) => {
  console.error('\nMigration failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
