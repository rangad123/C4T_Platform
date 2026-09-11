import { PrismaClient } from '@prisma/client'
import { osDetailsIfNotADate, versionWithoutFamily } from './load/assets.js'

/**
 * Gives a tester's device the operating system it was actually declared on.
 *
 * ── WHY IT WAS WRONG
 *
 * The device loader read `devices.dvc_os_details` into `osName`. That column
 * is free text and a large share of it holds the day the device was added
 * rather than an operating system, so a Dell Inspiron arrived running
 * "11-03-2015" and an iPhone 5s "10-05-2015". `osVersion` was never written at
 * all — null on all 5,917 devices — even though the tester profile renders
 * `osName · osVersion`.
 *
 * Meanwhile `dvc_mob_os_ver_id` resolved cleanly for 5,888 of them, giving a
 * real catalog version: "iOS 10.3", "Android 11.0", "Windows Mobile 6.5.3".
 * The reference was migrated and then never read.
 *
 * `load/assets.ts` now derives both columns from that reference. This exists
 * for the rows already in the database.
 *
 * Only rows whose `osVersion` is still null are touched, which is every
 * migrated device and no device anyone has edited since.
 *
 *   npm run migration:backfill-device-os -- --dry-run
 *   npm run migration:backfill-device-os
 */

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\nDevice OS backfill${dryRun ? ' — DRY RUN, nothing will be written' : ''}\n`)

  const devices = await prisma.testerDevice.findMany({
    where: { osVersion: null },
    select: {
      id: true,
      osName: true,
      osVersionRef: { select: { version: true, operatingSystem: { select: { name: true } } } },
    },
  })
  console.log(`  ${devices.length} devices have no OS version recorded`)

  let fromCatalog = 0
  let junkCleared = 0
  let leftAlone = 0

  for (const device of devices) {
    if (device.osVersionRef) {
      const name = device.osVersionRef.operatingSystem.name
      const version = versionWithoutFamily(device.osVersionRef.version, name)
      if (!dryRun) {
        await prisma.testerDevice.update({
          where: { id: device.id },
          data: { osName: name, osVersion: version },
        })
      }
      fromCatalog += 1
      continue
    }

    // No reference to go on. The most that can be done is to stop claiming a
    // date is an operating system.
    const kept = osDetailsIfNotADate(device.osName)
    if (device.osName && !kept) {
      if (!dryRun) {
        await prisma.testerDevice.update({ where: { id: device.id }, data: { osName: null } })
      }
      junkCleared += 1
    } else {
      leftAlone += 1
    }
  }

  console.log(`\n  ${dryRun ? 'would set' : 'set'} from the catalog : ${fromCatalog}`)
  console.log(`  ${dryRun ? 'would clear' : 'cleared'} a date as the OS: ${junkCleared}`)
  console.log('  left alone            :', leftAlone)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
