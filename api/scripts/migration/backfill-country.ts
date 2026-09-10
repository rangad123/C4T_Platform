import { PrismaClient } from '@prisma/client'
import { closeLegacyPool, query } from './legacy/client.js'

/**
 * Recovers the country of every tester whose country lives only in
 * `users.country_flag`.
 *
 * ── WHY THE MIGRATION MISSED IT
 *
 * `users` carries the country twice, and the obvious column is the empty one.
 * `usr_country` is set on 303 of 6,665 rows; `country_flag` is set on 5,863.
 * The old sign-up form used intl-tel-input, which records its flag as a CSS
 * class — `"iti-flag ar"` — and only a later, little-used profile screen ever
 * wrote `usr_country`. The loader read `usr_country` alone, so 5,736 testers
 * arrived with no country at all and country filtering was close to useless:
 * searching Argentina returned nobody, though twenty testers carry
 * `iti-flag ar`.
 *
 * `load/identity.ts` now reads both, so a fresh run is correct. This exists
 * for the rows already in the database.
 *
 * ── WHY NOT JUST RE-RUN THE users LOADER
 *
 * `--only=users` would work, but it upserts every column from the legacy row
 * — name, phone, status, role, password hash. Against a live database that
 * silently reverts anything a person has changed since the migration. This
 * touches one column, and only where it is currently empty, so a country
 * somebody has set by hand always wins.
 *
 *   npm run migration:backfill-country -- --dry-run
 *   npm run migration:backfill-country
 */

const prisma = new PrismaClient()

interface LegacyRow {
  usr_id: number | string
  usr_country: string | null
  country_flag: string | null
}

/** `"iti-flag ar"` → `"AR"`. Null for anything that is not a 2-letter suffix. */
function codeFromFlag(flag: string | null): string | null {
  const suffix = flag?.trim().split(/\s+/).pop() ?? ''
  return /^[a-z]{2}$/i.test(suffix) ? suffix.toUpperCase() : null
}

/** The country a row really has, preferring the one a person typed on purpose. */
function resolveCode(row: LegacyRow): string | null {
  const explicit = row.usr_country?.trim() ?? ''
  if (/^[a-z]{2}$/i.test(explicit)) return explicit.toUpperCase()
  return codeFromFlag(row.country_flag)
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\nCountry backfill${dryRun ? ' — DRY RUN, nothing will be written' : ''}\n`)

  const rows = await query<LegacyRow>('SELECT `usr_id`, `usr_country`, `country_flag` FROM `users`')
  console.log(`  read ${rows.length} legacy users`)

  const wanted = new Map<string, string>()
  for (const row of rows) {
    const code = resolveCode(row)
    if (code) wanted.set(String(row.usr_id), code)
  }
  console.log(`  ${wanted.size} of them resolve to a country code\n`)

  let usersUpdated = 0
  let profilesUpdated = 0
  let noMatch = 0

  for (const [legacyId, code] of wanted) {
    const user = await prisma.user.findUnique({
      where: { legacyId },
      select: {
        id: true,
        countryCode: true,
        testerProfile: { select: { id: true, countryCode: true } },
      },
    })
    if (!user) {
      noMatch += 1
      continue
    }

    // Only ever fills a blank. A country already on the record — set by the
    // migration from `usr_country`, or by the person since — is left alone.
    if (!user.countryCode) {
      if (!dryRun) {
        await prisma.user.update({ where: { id: user.id }, data: { countryCode: code } })
      }
      usersUpdated += 1
    }
    if (user.testerProfile && !user.testerProfile.countryCode) {
      if (!dryRun) {
        await prisma.testerProfile.update({
          where: { id: user.testerProfile.id },
          data: { countryCode: code },
        })
      }
      profilesUpdated += 1
    }
  }

  console.log('  users updated          :', usersUpdated)
  console.log('  tester profiles updated:', profilesUpdated)
  console.log('  legacy ids not migrated:', noMatch)
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
