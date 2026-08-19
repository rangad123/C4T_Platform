import { OsKind, type PrismaClient } from '@prisma/client'
import { readCsv, field } from './csv-parse.js'

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A handful of the legacy export's brand names are inconsistently cased
 * relative to the rest of the list (and relative to the hand-picked demo
 * brands `seed.ts` already creates for device models) — reconciled here so
 * the CSV import and the demo device-model seed land on the same row instead
 * of creating a case-sensitive duplicate. "lge" is dropped outright: it's the
 * same manufacturer as "LG", just a second legacy row for it.
 */
const BRAND_NAME_FIXES: Record<string, string | null> = {
  google: 'Google',
  vivo: 'Vivo',
  vsmart: 'Vsmart',
  lge: null,
}

/**
 * A few skill names in the legacy export carry a bracketed abbreviation
 * (`"Security Testing(Sc)"`, `"Usability Testing(UX)"`) or a spelling that
 * diverges from the skill this platform already seeded under a different
 * name (`"Localisation Testing"` vs. the existing "Localization Testing").
 * Both are normalised here so the import reconciles onto one row instead of
 * creating a near-duplicate — see brief §29, "prefer a deterministic mapping,
 * do not blindly duplicate records".
 */
const SKILL_NAME_FIXES: Record<string, string> = {
  'Security Testing(Sc)': 'Security Testing',
  'Usability Testing(UX)': 'Usability Testing',
  'Localisation Testing': 'Localization Testing',
}

/** `os.csv`'s `os_id` values that `os_versions.csv`'s `os_type_id` targets. */
const OS_KIND_BY_LEGACY_ID: Record<string, OsKind> = {
  '1': OsKind.DESKTOP, // Windows
  '3': OsKind.DESKTOP, // Mac IOS
  '4': OsKind.MOBILE, // Android
  '5': OsKind.DESKTOP, // Linux
  '6': OsKind.MOBILE, // iOS
  '7': OsKind.MOBILE, // Fire OS
  // '2' ("Cross") has no rows in os_versions.csv — deliberately unmapped.
}

/**
 * Seeds the device/browser/skill catalog from the legacy CSV export in
 * `prisma/csv/` (copied from `api/old sql/DataCSV/`, which is the folder the
 * platform brief calls `DataCSV/`). Everything upserts on a natural key, so
 * re-running never duplicates and never clobbers an admin's `isActive` edit.
 *
 * Two tables in the legacy export have no new-platform equivalent to build
 * here and are intentionally not imported: `roles.csv` (the `Role` enum
 * already covers this) and `app_types.csv`/`bug_types.csv`/`test_status.csv`/
 * `test_types.csv` (the first already has an adequate `BugType` enum; the
 * other three belong to the structured-testing-workflow feature that is
 * explicitly parked, not to this pass).
 */
export async function seedCatalog(prisma: PrismaClient): Promise<void> {
  console.log('Seeding catalog from legacy CSV export…')

  // ─── Device brands (mobile_brands.csv) ─────────────────────────────────────
  const brandRows = readCsv('mobile_brands')
  const seenBrandNames = new Set<string>()
  for (const row of brandRows) {
    const raw = field(row, 'mbr_name').trim()
    if (!raw) continue
    const fixed = raw in BRAND_NAME_FIXES ? BRAND_NAME_FIXES[raw] : raw
    if (fixed === null || fixed === undefined) continue // deliberately dropped duplicate
    if (seenBrandNames.has(fixed)) continue
    seenBrandNames.add(fixed)
    await prisma.deviceBrand.upsert({
      where: { name: fixed },
      create: { name: fixed },
      update: {},
    })
  }
  console.log(`  device brands: ${seenBrandNames.size}`)

  // ─── Operating systems + versions (os.csv + os_versions.csv) ───────────────
  const osRows = readCsv('os')
  const osIdToName = new Map(osRows.map((r) => [field(r, 'os_id'), field(r, 'os_name').trim()]))
  const osVersionRows = readCsv('os_versions')

  const osByLegacyId = new Map<string, string>() // legacy os_type_id -> new OperatingSystem.id
  let osCount = 0
  let osVersionCount = 0
  const legacyOsTypeIds = new Set(osVersionRows.map((r) => field(r, 'os_type_id')).filter(Boolean))
  for (const legacyId of legacyOsTypeIds) {
    const kind = OS_KIND_BY_LEGACY_ID[legacyId]
    const name = osIdToName.get(legacyId)
    if (!kind || !name) continue // "Cross" and anything unmapped
    const os = await prisma.operatingSystem.upsert({
      where: { name_kind: { name, kind } },
      create: { name, kind },
      update: {},
      select: { id: true },
    })
    osByLegacyId.set(legacyId, os.id)
    osCount += 1
  }

  const seenVersions = new Set<string>()
  for (const row of osVersionRows) {
    const operatingSystemId = osByLegacyId.get(field(row, 'os_type_id'))
    const version = field(row, 'os_name').trim()
    if (!operatingSystemId || !version) continue
    const key = `${operatingSystemId}:${version}`
    if (seenVersions.has(key)) continue // e.g. duplicate "android 11.0" casing
    seenVersions.add(key)
    await prisma.osVersion.upsert({
      where: { operatingSystemId_version: { operatingSystemId, version } },
      create: { operatingSystemId, version },
      update: {},
    })
    osVersionCount += 1
  }
  console.log(`  operating systems: ${osCount}, versions: ${osVersionCount}`)

  // ─── Browsers (browsers.csv) ────────────────────────────────────────────────
  const browserRows = readCsv('browsers')
  const seenBrowsers = new Set<string>()
  for (const row of browserRows) {
    const name = field(row, 'brw_name').trim()
    if (!name || seenBrowsers.has(name)) continue
    seenBrowsers.add(name)
    await prisma.browser.upsert({ where: { name }, create: { name }, update: {} })
  }
  console.log(`  browsers: ${seenBrowsers.size}`)

  // ─── Skill categories (skill_categories.csv) ────────────────────────────────
  const categoryRows = readCsv('skill_categories')
  const categoryByLegacyId = new Map<string, string>()
  for (const row of categoryRows) {
    const name = field(row, 'scat_name').trim()
    if (!name) continue
    const slug = slugify(field(row, 'scat_identifier').trim() || name)
    const category = await prisma.skillCategory.upsert({
      where: { slug },
      create: { name, slug },
      update: { name },
      select: { id: true },
    })
    categoryByLegacyId.set(field(row, 'scat_id'), category.id)
  }
  console.log(`  skill categories: ${categoryByLegacyId.size}`)

  // ─── Skills (skills.csv) ─────────────────────────────────────────────────────
  const skillRows = readCsv('skills')
  const seenSkillSlugs = new Set<string>()
  for (const row of skillRows) {
    const rawName = field(row, 'sname_name').trim()
    if (!rawName) continue
    const name = SKILL_NAME_FIXES[rawName] ?? rawName
    const slug = slugify(name)
    if (seenSkillSlugs.has(slug)) continue
    seenSkillSlugs.add(slug)
    const categoryId = categoryByLegacyId.get(field(row, 'sname_cat_id'))
    if (!categoryId) continue
    await prisma.skill.upsert({
      where: { slug },
      create: { name, slug, categoryId },
      update: { categoryId },
    })
  }

  // Two skills this platform seeded before the catalog existed have no
  // counterpart in the legacy export at all — created explicitly here rather
  // than left to a "backfill any null categoryId" pass, which would silently
  // stop creating them on a fresh database that never had the old rows.
  const typeOfTesting = categoryByLegacyId.get('2')
  if (typeOfTesting) {
    for (const name of ['Payment Testing', 'Accessibility Testing']) {
      const slug = slugify(name)
      await prisma.skill.upsert({
        where: { slug },
        create: { name, slug, categoryId: typeOfTesting },
        update: { categoryId: typeOfTesting },
      })
    }
  }
  console.log(`  skills: ${seenSkillSlugs.size} from CSV, plus 2 platform-only additions`)
}
