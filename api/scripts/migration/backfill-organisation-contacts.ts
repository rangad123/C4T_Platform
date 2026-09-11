import { PrismaClient } from '@prisma/client'
import { closeLegacyPool, query } from './legacy/client.js'
import { ISO_COUNTRY_CODES } from '../../src/lib/iso-countries.js'

/**
 * Fills an organisation's contact details from the customer who owns it.
 *
 * ── WHERE THE DATA ACTUALLY LIVES
 *
 * The legacy `organisation` table carries almost nothing: a title, an image,
 * one free-text address, a description and some billing settings. I read that
 * and reported these fields as never collected. That was wrong.
 *
 * In the old model a "Company" was a USER — role 2 — and the organisation row
 * was little more than a grouping. The company's email, phone and city sit on
 * `users`, on the account that created the organisation. Of the 276
 * organisations, that owner has an email on 265, a phone on 251 and a city on
 * 70.
 *
 * ── COUNTRY, FROM THE PHONE
 *
 * `usr_country` is set on only 15 owners, but `usr_cont_info` holds what
 * intl-tel-input recorded beside the phone number — "India (भारत): +91" — on
 * 196 of them. The English name in front of the bracket resolves to an ISO
 * code, so the country of the phone number stands in for the country of the
 * organisation. It is the same source the tester country backfill used.
 *
 * ── STILL GENUINELY ABSENT
 *
 * Website, state, postal code, Tax ID and a second address line have no
 * column anywhere in the legacy schema. Those were never collected and cannot
 * be recovered — they have to be gathered going forward.
 *
 * Only blank fields are filled, so anything edited since is left alone.
 *
 *   npm run migration:backfill-org-contacts -- --dry-run
 *   npm run migration:backfill-org-contacts
 */

const prisma = new PrismaClient()

interface LegacyRow {
  org_id: number | string
  usr_email: string | null
  usr_phone: string | null
  usr_city: string | null
  usr_country: string | null
  usr_cont_info: string | null
}

function text(value: string | null): string | null {
  const s = value?.trim()
  return !s || s === '0' ? null : s
}

/** "India (भारत): +91" → "India". The English name is always first. */
function countryNameFromDialInfo(value: string | null): string | null {
  const s = text(value)
  if (!s) return null
  const name = s.split(/[(:]/)[0]?.trim()
  return name && name.length > 1 ? name : null
}

let index: Map<string, string> | null = null
function isoFromName(name: string): string | null {
  if (!index) {
    index = new Map()
    const display = new Intl.DisplayNames(['en'], { type: 'region' })
    for (const code of ISO_COUNTRY_CODES) {
      try {
        const n = display.of(code)
        if (n) index.set(n.toLowerCase(), code)
      } catch {
        // A code Intl does not know still stays valid as a code.
      }
    }
    // Spellings the legacy widget uses that Intl does not return.
    for (const [n, c] of Object.entries({
      russia: 'RU',
      'united states': 'US',
      'south korea': 'KR',
      vietnam: 'VN',
      'united kingdom': 'GB',
    })) {
      index.set(n, c)
    }
  }
  return index.get(name.trim().toLowerCase()) ?? null
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\nOrganisation contact backfill${dryRun ? ' — DRY RUN, nothing written' : ''}\n`)

  const rows = await query<LegacyRow>(
    'SELECT o.`org_id`, u.`usr_email`, u.`usr_phone`, u.`usr_city`, u.`usr_country`, ' +
      'u.`usr_cont_info` FROM `organisation` o ' +
      'JOIN `users` u ON u.`usr_id` = o.`org_created_by`',
  )
  console.log(`  ${rows.length} organisations have an owner record to read from`)

  const filled = { contactEmail: 0, contactPhone: 0, city: 0, countryCode: 0 }
  let touched = 0
  let noMatch = 0

  for (const row of rows) {
    const org = await prisma.organisation.findUnique({
      where: { legacyId: String(row.org_id) },
      select: { id: true, contactEmail: true, contactPhone: true, city: true, countryCode: true },
    })
    if (!org) {
      noMatch += 1
      continue
    }

    const explicit = text(row.usr_country)
    const fromPhone = countryNameFromDialInfo(row.usr_cont_info)
    const country =
      (explicit && /^[a-z]{2}$/i.test(explicit) ? explicit.toUpperCase() : null) ??
      (fromPhone ? isoFromName(fromPhone) : null)

    const data: Record<string, string> = {}
    if (!org.contactEmail && text(row.usr_email)) data.contactEmail = text(row.usr_email)!
    if (!org.contactPhone && text(row.usr_phone)) data.contactPhone = text(row.usr_phone)!
    if (!org.city && text(row.usr_city)) data.city = text(row.usr_city)!
    if (!org.countryCode && country) data.countryCode = country

    if (Object.keys(data).length === 0) continue
    for (const key of Object.keys(data)) filled[key as keyof typeof filled] += 1
    touched += 1
    if (!dryRun) await prisma.organisation.update({ where: { id: org.id }, data })
  }

  console.log(`\n  organisations ${dryRun ? 'to update' : 'updated'}: ${touched}`)
  console.log('    contact email :', filled.contactEmail)
  console.log('    contact phone :', filled.contactPhone)
  console.log('    city          :', filled.city)
  console.log('    country       :', filled.countryCode)
  console.log('  legacy orgs not migrated:', noMatch)
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
