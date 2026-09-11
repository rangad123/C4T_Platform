import { PrismaClient } from '@prisma/client'
import { loadLegacyOsMaps, resolveBrowserOs } from './load/assets.js'
import { closeLegacyPool, query } from './legacy/client.js'

/**
 * Gives every migrated tester browser the operating system it was declared on.
 *
 * ── WHY IT WAS MISSING
 *
 * `user_browsers.os_id` names a row in the legacy `os_versions` table — the
 * specific OS, "Windows 10", not the family in `os`. All 6,096 legacy rows
 * carry one and 6,095 of them join, but the loader only ever read
 * `browser_id` and `browser_version_id`. So all 5,469 migrated browsers
 * arrived with `operating_system_id` and `os_version_ref_id` null, and a
 * browser with no OS beside it is most of what "browser data is not coming"
 * meant.
 *
 * The catalog seed already holds these exact names — "Windows Xp",
 * "Mac os X 10.6", "Ubuntu 12.04" — so this matches by name and invents no
 * catalog rows.
 *
 * `load/assets.ts` now does this during a normal run, and shares the resolver
 * with this script so the two cannot drift.
 *
 * Only fills a blank: a browser whose OS is already set is left alone.
 *
 *   npm run migration:backfill-browser-os -- --dry-run
 *   npm run migration:backfill-browser-os
 */

const prisma = new PrismaClient()

interface LegacyRow {
  user_browsers_id: number | string
  os_id: number | string | null
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\nBrowser OS backfill${dryRun ? ' — DRY RUN, nothing will be written' : ''}\n`)

  const maps = await loadLegacyOsMaps()
  console.log(`  legacy catalog: ${maps.versions.size} os_versions, ${maps.families.size} families`)

  const rows = await query<LegacyRow>('SELECT `user_browsers_id`, `os_id` FROM `user_browsers`')
  console.log(`  ${rows.length} legacy browser rows\n`)

  let filled = 0
  let alreadySet = 0
  let unresolved = 0
  let notMigrated = 0

  for (const row of rows) {
    const legacyId = String(row.user_browsers_id)
    const map = await prisma.migrationRecordMap.findUnique({
      where: {
        legacyTable_legacyId_targetModel: {
          legacyTable: 'user_browsers',
          legacyId,
          targetModel: 'TesterBrowser',
        },
      },
      select: { targetId: true },
    })
    if (!map) {
      notMigrated += 1
      continue
    }

    const current = await prisma.testerBrowser.findUnique({
      where: { id: map.targetId },
      select: { id: true, operatingSystemId: true, osVersionRefId: true },
    })
    if (!current) {
      notMigrated += 1
      continue
    }
    if (current.operatingSystemId ?? current.osVersionRefId) {
      alreadySet += 1
      continue
    }

    const os = await resolveBrowserOs(prisma, maps, row.os_id ? String(row.os_id) : null)
    if (!os.operatingSystemId && !os.osVersionRefId) {
      unresolved += 1
      continue
    }

    if (!dryRun) {
      await prisma.testerBrowser.update({ where: { id: current.id }, data: os })
    }
    filled += 1
  }

  console.log(`  ${dryRun ? 'would fill' : 'filled'}    : ${filled}`)
  console.log('  already set  :', alreadySet)
  console.log('  unresolvable :', unresolved)
  console.log('  not migrated :', notMigrated)
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
