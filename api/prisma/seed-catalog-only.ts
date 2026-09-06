import { PrismaClient } from '@prisma/client'
import { seedCatalog } from './seed-catalog.js'

/**
 * The device/browser/skill catalog on its own.
 *
 * `seed.ts` calls `seedCatalog` from BELOW its `NODE_ENV=production` guard, so
 * a production seed returns at "skipping demo data" before ever reaching it.
 * That is harmless on a database that was seeded once in development and then
 * promoted — and a trap on a production database rebuilt from scratch, because
 * the legacy migration resolves browsers by NAME against these rows. Without
 * them every `browser_versions` and `user_browsers` row orphans.
 *
 * Run after `prisma db push --force-reset` and `db:seed`, before the migration.
 */
const prisma = new PrismaClient()

async function main(): Promise<void> {
  await seedCatalog(prisma)

  const [browsers, skills, brands, osVersions] = await Promise.all([
    prisma.browser.count(),
    prisma.skill.count(),
    prisma.deviceBrand.count(),
    prisma.osVersion.count(),
  ])
  console.log(
    `catalog ready — browsers: ${browsers}, skills: ${skills}, ` +
      `device brands: ${brands}, os versions: ${osVersions}`,
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
