import type { PrismaClient } from '@prisma/client'
import { countRows, tableExists } from '../legacy/client.js'
import { REGISTRY, isMigrated } from '../mapping/registry.js'
import type { Reporter } from '../report/reporter.js'

/**
 * Post-migration verification.
 *
 * ── COUNTS ARE NOT ENOUGH
 *
 * "12,450 in, 12,450 out" says nothing about whether the rows point at the
 * right parents. The legacy database has almost no declared foreign keys, so
 * its referential integrity was only ever enforced by application code that no
 * longer runs — orphans in the SOURCE are expected, and the migration's job is
 * to report them rather than propagate them. These checks therefore look at
 * both sides: did the counts land, and does the destination graph hold
 * together.
 */

export interface CountCheck {
  legacyTable: string
  targetModel: string
  sourceCount: number | null
  destinationCount: number
  migratedCount: number
  difference: number | null
  note: string
}

export interface IntegrityCheck {
  name: string
  failures: number
  detail: string
}

/** How many destination rows this run claims to have written for a table. */
async function mappedCount(
  prisma: PrismaClient,
  legacyTable: string,
  targetModel: string,
): Promise<number> {
  return prisma.migrationRecordMap.count({ where: { legacyTable, targetModel } })
}

export async function compareCounts(
  prisma: PrismaClient,
  reporter: Reporter,
): Promise<CountCheck[]> {
  const results: CountCheck[] = []

  for (const mapping of REGISTRY) {
    if (!isMigrated(mapping)) continue

    const exists = await tableExists(mapping.legacyTable)
    const sourceCount = exists ? await countRows(mapping.legacyTable) : null
    const target = mapping.targets[0] ?? '—'
    const migratedCount = await mappedCount(prisma, mapping.legacyTable, target)

    const counter = reporter
      .allCounters()
      .find((c) => c.legacyTable === mapping.legacyTable && c.targetModel === target)

    const accountedFor = counter
      ? counter.inserted + counter.updated + counter.skipped + counter.failed
      : migratedCount

    const difference = sourceCount === null ? null : sourceCount - accountedFor

    results.push({
      legacyTable: mapping.legacyTable,
      targetModel: target,
      sourceCount,
      destinationCount: migratedCount,
      migratedCount,
      difference,
      note:
        sourceCount === null
          ? 'table absent from the source database'
          : difference === 0
            ? 'every source row accounted for'
            : `${difference} source rows unaccounted for — investigate`,
    })
  }

  return results
}

/**
 * Relationship checks against the DESTINATION.
 *
 * Each of these would have been impossible to express in the legacy schema,
 * which is exactly why they are worth asserting once the data has landed.
 */
export async function checkIntegrity(prisma: PrismaClient): Promise<IntegrityCheck[]> {
  const checks: IntegrityCheck[] = []

  const add = (name: string, failures: number, detail: string) =>
    checks.push({ name, failures, detail })

  // Builds whose project is soft-deleted — a migrated build must not outlive
  // its project.
  add(
    'builds with a deleted project',
    await prisma.build.count({ where: { project: { deletedAt: { not: null } } } }),
    'Build.projectId points at a soft-deleted Project.',
  )

  // Bugs whose build belongs to a different project than the bug does. The new
  // schema stores both, so they can disagree; the legacy data cannot express
  // the constraint at all.
  const mismatched = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n
      FROM bugs b
      JOIN builds bl ON bl.id = b.build_id
     WHERE bl.project_id <> b.project_id
  `
  add(
    'bugs whose build belongs to another project',
    Number(mismatched[0]?.n ?? 0),
    'Bug.projectId and Bug.build.projectId disagree.',
  )

  // Assignments pointing at a build from a different project — same class.
  const badAssignments = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n
      FROM project_assignments a
      JOIN builds bl ON bl.id = a.build_id
     WHERE bl.project_id <> a.project_id
  `
  add(
    'assignments whose build belongs to another project',
    Number(badAssignments[0]?.n ?? 0),
    'ProjectAssignment.projectId and its build disagree.',
  )

  // Test reports whose linked bug is on a different build.
  const badReports = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n
      FROM test_reports r
      JOIN bugs b ON b.id = r.linked_bug_id
     WHERE r.linked_bug_id IS NOT NULL AND b.build_id <> r.build_id
  `
  add(
    'test reports linked to a bug on another build',
    Number(badReports[0]?.n ?? 0),
    'TestReport.linkedBugId points outside the report’s own build.',
  )

  // Payout accounts with an empty envelope — a row that would fail to decrypt.
  add(
    'payment accounts with no encrypted payload',
    await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM payment_accounts WHERE octet_length(secure_details) = 0
    `.then((r) => Number(r[0]?.n ?? 0)),
    'PaymentAccount.secureDetails is empty; the create-then-seal step did not complete.',
  )

  // Organisations with no members — migrated but unreachable by anyone.
  add(
    'organisations with no members',
    await prisma.organisation.count({ where: { members: { none: {} } } }),
    'Nobody can sign in and see these organisations.',
  )

  // Legacy users carrying a legacy password algorithm, for visibility rather
  // than as a failure: these are the accounts that will be upgraded on first
  // sign-in, and the number should fall over time.
  add(
    'users still on a legacy password hash',
    await prisma.user.count({ where: { passwordAlgo: { in: ['LEGACY_MD5', 'LEGACY_SHA1'] } } }),
    'Expected after a migration. Each is upgraded to Argon2id on first successful sign-in.',
  )

  return checks
}

/**
 * PostgreSQL sequence check (brief §25).
 *
 * The new schema uses cuid primary keys everywhere, so no identity sequence is
 * fed by migrated ids and there is nothing to advance. The one place a counter
 * matters is `lib/reference.ts`, which mints C4T-/BUG-/TXN- numbers from a
 * per-year Postgres sequence — and migrated rows deliberately use a
 * `-LEG-` reference derived from the legacy id instead of drawing from it, so
 * they cannot collide with numbers the application later issues.
 *
 * This verifies that: any migrated row holding a sequence-shaped reference
 * would be a bug in the loaders.
 */
export async function checkReferenceCollisions(prisma: PrismaClient): Promise<IntegrityCheck[]> {
  const checks: IntegrityCheck[] = []

  const projects = await prisma.project.count({
    where: { legacyId: { not: null }, reference: { not: { contains: '-LEG-' } } },
  })
  checks.push({
    name: 'migrated projects drawing from the live reference sequence',
    failures: projects,
    detail: 'A migrated project must use a C4T-LEG- reference, never a sequence value.',
  })

  const bugs = await prisma.bug.count({
    where: { legacyId: { not: null }, reference: { not: { contains: '-LEG-' } } },
  })
  checks.push({
    name: 'migrated bugs drawing from the live reference sequence',
    failures: bugs,
    detail: 'A migrated bug must use a BUG-LEG- reference.',
  })

  const transactions = await prisma.transaction.count({
    where: { legacyId: { not: null }, reference: { not: { contains: '-LEG-' } } },
  })
  checks.push({
    name: 'migrated transactions drawing from the live reference sequence',
    failures: transactions,
    detail: 'A migrated transaction must use a TXN-LEG- reference.',
  })

  return checks
}
