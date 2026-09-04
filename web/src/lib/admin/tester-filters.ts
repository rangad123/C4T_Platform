import 'server-only'
import type { FilterOptions } from '@/components/admin/assign/types'

/**
 * The filter vocabulary every tester picker offers.
 *
 * Both places that search testers — the assignment workspace and the message
 * composer — need the same dropdowns filled from the same catalog, and both
 * were about to hand-roll the same three `.map()` calls plus the same country
 * list. One transform means a country added here appears on both, and a
 * catalog shape change breaks in one place instead of silently diverging.
 *
 * Server-only: it is called during render and its output is serialised into
 * the client component's props, so there is no reason for the list itself to
 * ship in the bundle.
 */

export interface CatalogPayload {
  operatingSystems?: readonly { id: string; name: string }[]
  browsers?: readonly { id: string; name: string }[]
  skillCategories?: readonly {
    name: string
    slug: string
    skills: readonly { name: string; slug: string }[]
  }[]
}

export function testerFilterOptions(catalog: CatalogPayload | null): FilterOptions {
  return {
    countries: COUNTRIES,
    operatingSystems: (catalog?.operatingSystems ?? []).map((o) => ({
      value: o.name,
      label: o.name,
    })),
    browsers: (catalog?.browsers ?? []).map((b) => ({ value: b.name, label: b.name })),
    skillCategories: (catalog?.skillCategories ?? []).map((c) => ({
      name: c.name,
      slug: c.slug,
      skills: c.skills.map((s) => ({ value: s.slug, label: s.name })),
    })),
  }
}

/**
 * The countries testers are actually in would need an aggregate the API does
 * not expose, so this is the ISO subset the rest of the admin already filters
 * by.
 */
const COUNTRIES: readonly { value: string; label: string }[] = [
  ['IN', 'India'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['AE', 'United Arab Emirates'],
  ['AU', 'Australia'],
  ['CA', 'Canada'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['HR', 'Croatia'],
  ['MX', 'Mexico'],
  ['SG', 'Singapore'],
  ['ZA', 'South Africa'],
].map(([value, label]) => ({ value: value!, label: label! }))
