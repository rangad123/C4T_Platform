import { PrismaClient, ProjectStatus } from '@prisma/client'

/**
 * Puts a completed project's progress bar at 100%.
 *
 * ── WHY IT WAS 0
 *
 * `progress_percent` is `Int @default(0)`, and the projects loader never set
 * it. The legacy `projects` table has no status column at all — status was
 * implied by whether builds existed and had been tested — so every migrated
 * project lands as COMPLETED, and every one of them landed beside a progress
 * bar reading 0%. A record that says "Completed" and "0%" in the same row
 * makes a reader distrust both numbers.
 *
 * 100 is not invented here: `changeStatus` writes exactly that whenever the
 * platform completes a project itself, so this is the same convention applied
 * to the rows that predate it.
 *
 * `load/projects.ts` now sets it too, so a fresh run needs none of this.
 *
 * Only ever raises a COMPLETED project sitting at 0. A figure somebody has
 * set deliberately, and any project in another status, are left alone.
 *
 *   npm run migration:backfill-progress -- --dry-run
 *   npm run migration:backfill-progress
 */

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\nProgress backfill${dryRun ? ' — DRY RUN, nothing will be written' : ''}\n`)

  const where = {
    status: ProjectStatus.COMPLETED,
    deletedAt: null,
    progressPercent: 0,
  }

  const candidates = await prisma.project.count({ where })
  console.log(`  ${candidates} completed projects are sitting at 0%`)

  if (candidates === 0 || dryRun) {
    console.log(`\n  ${dryRun ? 'would set' : 'nothing to set'}: ${candidates} → 100%`)
    return
  }

  const result = await prisma.project.updateMany({ where, data: { progressPercent: 100 } })
  console.log(`\n  set to 100%: ${result.count}`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
