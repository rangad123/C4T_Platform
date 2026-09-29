import { PrismaClient } from '@prisma/client'

/**
 * The `Industry` catalog (offered on an organisation, `/app/admin/catalog` →
 * Industries) has never been seeded — the table has existed since the
 * catalog page shipped, but nothing ever put a row in it, so every
 * "Industry" dropdown across the app has only ever shown its "Not
 * specified" placeholder. Not a code defect; the admin UI to add one at a
 * time already exists. This is a one-off backfill of a standard starter
 * list, safe to re-run (upserts by name) — an admin can rename, retire or
 * add to it from that same page afterwards.
 */
const INDUSTRIES = [
  'Software & IT',
  'Financial Services',
  'Healthcare',
  'E-commerce & Retail',
  'Education',
  'Manufacturing',
  'Real Estate',
  'Telecommunications',
  'Media & Entertainment',
  'Government & Public Sector',
  'Non-profit',
  'Hospitality & Travel',
  'Transportation & Logistics',
  'Energy & Utilities',
  'Construction',
  'Automotive',
  'Insurance',
  'Legal Services',
  'Consulting',
  'Agriculture',
  'Pharmaceuticals',
  'Gaming',
  'Marketing & Advertising',
  'Human Resources',
  'Other',
]

const prisma = new PrismaClient()

// Matches `slugify` in api/src/modules/catalog/catalog.routes.ts exactly —
// the same admin "Add industry" action generates a slug this way, and the
// column is unique, so a mismatched scheme here would collide with it later.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

for (const name of INDUSTRIES) {
  await prisma.industry.upsert({
    where: { name },
    update: {},
    create: { name, slug: slugify(name), isActive: true },
  })
}

console.log(`seeded ${INDUSTRIES.length} industries`)
await prisma.$disconnect()
