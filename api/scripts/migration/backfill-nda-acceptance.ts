import { PrismaClient } from '@prisma/client'

/**
 * Records the NDA as accepted for every tester carried over from the old
 * platform.
 *
 * ── THE DECISION THIS IMPLEMENTS
 *
 * This is a policy choice, not a data repair, and it was made deliberately:
 * the client's instruction was to treat a tester's working relationship with
 * the old platform as their acceptance.
 *
 * ── WHY IT WAS NEEDED
 *
 * `assertAssignable` refuses any tester without `ndaAcceptedAt`. The legacy
 * column behind it, `users.usr_agreement_verification`, is null on 6,704 of
 * 6,710 rows — 4 "verified", 2 "rejected", nothing else — because the old
 * platform never gated assignment on it. It has 4,393 project assignments
 * against 5 accepted NDAs.
 *
 * So nothing was lost in migration; the new platform introduced a rule the
 * old one did not enforce, and the result was that 5,965 verified, active
 * testers existed and exactly 5 of them could be put on a project. The
 * platform could not staff anything.
 *
 * ── SCOPE, AND WHY IT IS DRAWN HERE
 *
 * Migrated testers only — `user.legacyId` is set. Anyone who signs up on the
 * new platform accepts for themselves through the prompt already on their
 * profile; inheriting an agreement makes sense only for people who had the
 * prior relationship being inherited from. That guard matches 0 accounts
 * today and is the whole point of writing it down now.
 *
 * Status is deliberately NOT part of the filter. The basis is the
 * relationship, not the tester's current standing, and scoping to VERIFIED
 * would leave the 369 APPLIED profiles to hit this same wall the moment an
 * admin verified one.
 *
 * ── THE TIMESTAMP
 *
 * The run time, not a backdated one. What is true is that the platform
 * recorded this acceptance today, on the basis above; writing 2015 against a
 * tester's name would claim a contemporaneous record that does not exist.
 *
 * Deliberately NOT part of the loaders: a migration should not assert a legal
 * agreement as a side effect of copying rows. It lives here, where running it
 * is a decision somebody takes on purpose.
 *
 *   npm run migration:backfill-nda -- --dry-run
 *   npm run migration:backfill-nda
 */

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\nNDA acceptance backfill${dryRun ? ' — DRY RUN, nothing will be written' : ''}\n`)

  const where = {
    ndaAcceptedAt: null,
    user: { legacyId: { not: null } },
  }

  const candidates = await prisma.testerProfile.count({ where })
  const byStatus = await prisma.testerProfile.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  })

  console.log(`  ${candidates} migrated testers have no NDA acceptance recorded`)
  for (const row of byStatus) {
    console.log(`    ${row.status.padEnd(10)}: ${row._count._all}`)
  }

  if (dryRun || candidates === 0) {
    console.log(`\n  ${dryRun ? 'would record' : 'nothing to record'}: ${candidates}`)
    return
  }

  const acceptedAt = new Date()
  const result = await prisma.testerProfile.updateMany({
    where,
    data: { ndaAcceptedAt: acceptedAt },
  })
  console.log(`\n  recorded as accepted at ${acceptedAt.toISOString()}: ${result.count}`)

  const assignable = await prisma.testerProfile.count({
    where: {
      status: 'VERIFIED',
      ndaAcceptedAt: { not: null },
      user: { status: 'ACTIVE', role: 'TESTER' },
    },
  })
  console.log(`  testers now assignable to a project: ${assignable}`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
