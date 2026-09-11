import { PrismaClient } from '@prisma/client'
import { closeLegacyPool, query } from './legacy/client.js'
import { loadLegacyLabels } from './mapping/legacy-labels.js'

/**
 * Replaces the id a bug shows as its device and browser with their names.
 *
 * ── WHY THEY WERE NUMBERS
 *
 * `bugs_report.bug_device_used` and `bug_browsers_used` look like free text
 * and are not: they are ids into `devices` and `user_browsers`. The loader
 * read them straight across, so bugs displayed "588" where the device should
 * be and "512" where the browser should be — 11,729 and 9,382 rows of it.
 *
 * `load/defects.ts` now resolves them through `mapping/legacy-labels.ts`.
 * This exists for the rows already in the database, and shares that module so
 * the two cannot disagree about what a device is called.
 *
 * `osName` comes from `user_browsers.os_id` — the OS the tester registered
 * that browser on, and the only place a legacy bug's operating system
 * survives at all. `bugs_report` has no OS column, which is why `Bug.osName`
 * was null on all 21,554 rows.
 *
 * ── WHAT IT WILL NOT TOUCH
 *
 * Only a value that is still a bare number, which is exactly what the bad
 * migration wrote and nothing a person would type. Anything already reading
 * as a name — edited since, or filed on the new platform — is left alone.
 *
 *   npm run migration:backfill-bug-environment -- --dry-run
 *   npm run migration:backfill-bug-environment
 */

const prisma = new PrismaClient()

/** The shape the bad migration left: digits and nothing else. */
function isBareId(value: string | null): boolean {
  return value !== null && /^\d+$/.test(value.trim())
}

interface LegacyBug {
  bug_id: number | string
  bug_device_used: string | null
  bug_browsers_used: string | null
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\nBug environment backfill${dryRun ? ' — DRY RUN, nothing will be written' : ''}\n`)

  const labels = await loadLegacyLabels()
  console.log(`  ${labels.devices.size} device labels, ${labels.browsers.size} browser labels`)

  const rows = await query<LegacyBug>(
    'SELECT `bug_id`, `bug_device_used`, `bug_browsers_used` FROM `bugs_report`',
  )
  console.log(`  ${rows.length} legacy bugs to check\n`)

  let deviceFixed = 0
  let browserFixed = 0
  let osFilled = 0
  let unresolved = 0
  let untouched = 0

  for (const row of rows) {
    const legacyId = String(row.bug_id)
    const bug = await prisma.bug.findUnique({
      where: { legacyId },
      select: { id: true, deviceModel: true, browser: true, osName: true },
    })
    if (!bug) continue

    const data: { deviceModel?: string | null; browser?: string | null; osName?: string | null } =
      {}

    if (isBareId(bug.deviceModel)) {
      const label = labels.devices.get(bug.deviceModel!.trim())
      // An id the catalog cannot name is cleared: a number is not a device,
      // and leaving it there is the defect being reported.
      data.deviceModel = label ?? null
      if (label) deviceFixed += 1
      else unresolved += 1
    }

    if (isBareId(bug.browser)) {
      const found = labels.browsers.get(bug.browser!.trim())
      data.browser = found?.label ?? null
      if (found) {
        browserFixed += 1
        if (!bug.osName && found.osName) {
          data.osName = found.osName
          osFilled += 1
        }
      } else {
        unresolved += 1
      }
    }

    if (Object.keys(data).length === 0) {
      untouched += 1
      continue
    }
    if (!dryRun) await prisma.bug.update({ where: { id: bug.id }, data })
  }

  console.log(`  ${dryRun ? 'would name' : 'named'} the device  : ${deviceFixed}`)
  console.log(`  ${dryRun ? 'would name' : 'named'} the browser : ${browserFixed}`)
  console.log(`  ${dryRun ? 'would fill' : 'filled'} the OS      : ${osFilled}`)
  console.log(`  ids with no match, cleared: ${unresolved}`)
  console.log('  already fine              :', untouched)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
    void closeLegacyPool()
  })
