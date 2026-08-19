import { PrismaClient } from '@prisma/client'

/**
 * One-off backfill for the multi-build migration.
 *
 * Run once, by hand (`npx tsx prisma/backfill-builds.ts`), AFTER `db push`
 * has added the nullable `Build` table and `buildId` columns, and BEFORE the
 * follow-up `db push` that flips those columns to required. Not part of
 * `seed.ts` — this fixes up existing data for a schema change, it does not
 * create demo data, and it must not run again on every seed.
 *
 * Raw SQL, deliberately: the checked-in `schema.prisma` already shows
 * `buildId` as required on these four tables (that is the END state, applied
 * by the `db push` that follows a clean run of this script), so the
 * generated Prisma Client's typed `where` no longer permits filtering by
 * null on them. The actual database column is still nullable at the point
 * this script is meant to run — raw SQL targets that real column state
 * rather than fighting whichever schema version generated the installed
 * client.
 *
 * Idempotent: safe to run more than once. Every project gets exactly one
 * `isDefault` build (upserted on the `[projectId, name]` unique constraint,
 * so re-running finds the same row rather than creating a second one), and
 * every child row's `buildId` is only ever set when it is still null.
 */
const prisma = new PrismaClient()

const DEFAULT_BUILD_NAME = 'Original build'

async function main() {
  const projects = await prisma.project.findMany({ select: { id: true } })
  console.log(`Backfilling ${projects.length} project(s)...`)

  let featuresUpdated = 0
  let materialsUpdated = 0
  let assignmentsUpdated = 0
  let bugsUpdated = 0

  for (const { id: projectId } of projects) {
    const build = await prisma.build.upsert({
      where: { projectId_name: { projectId, name: DEFAULT_BUILD_NAME } },
      update: {},
      create: { projectId, name: DEFAULT_BUILD_NAME, isDefault: true },
      select: { id: true },
    })

    featuresUpdated += await prisma.$executeRaw`
      UPDATE features SET build_id = ${build.id}
      WHERE project_id = ${projectId} AND build_id IS NULL
    `
    materialsUpdated += await prisma.$executeRaw`
      UPDATE project_materials SET build_id = ${build.id}
      WHERE project_id = ${projectId} AND build_id IS NULL
    `
    assignmentsUpdated += await prisma.$executeRaw`
      UPDATE project_assignments SET build_id = ${build.id}
      WHERE project_id = ${projectId} AND build_id IS NULL
    `
    bugsUpdated += await prisma.$executeRaw`
      UPDATE bugs SET build_id = ${build.id}
      WHERE project_id = ${projectId} AND build_id IS NULL
    `
  }

  console.log(
    `Backfilled: ${featuresUpdated} feature(s), ${materialsUpdated} material(s), ${assignmentsUpdated} assignment(s), ${bugsUpdated} bug(s).`,
  )

  const [featureRows, materialRows, assignmentRows, bugRows] = await Promise.all([
    prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM features WHERE build_id IS NULL`,
    prisma.$queryRaw<
      { count: bigint }[]
    >`SELECT COUNT(*) AS count FROM project_materials WHERE build_id IS NULL`,
    prisma.$queryRaw<
      { count: bigint }[]
    >`SELECT COUNT(*) AS count FROM project_assignments WHERE build_id IS NULL`,
    prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM bugs WHERE build_id IS NULL`,
  ])
  const nullFeatures = featureRows[0]?.count ?? 0n
  const nullMaterials = materialRows[0]?.count ?? 0n
  const nullAssignments = assignmentRows[0]?.count ?? 0n
  const nullBugs = bugRows[0]?.count ?? 0n

  const remaining = nullFeatures + nullMaterials + nullAssignments + nullBugs
  if (remaining > 0n) {
    console.error(
      `GATE FAILED: ${remaining} row(s) still have a null buildId ` +
        `(features=${nullFeatures}, materials=${nullMaterials}, assignments=${nullAssignments}, bugs=${nullBugs}). ` +
        'Do NOT run the follow-up `db push` that makes buildId required until this is zero.',
    )
    process.exitCode = 1
    return
  }

  console.log('Gate passed: every row has a buildId. Safe to flip the columns to required.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
