import 'server-only'
import type { FilterOptions } from '@/components/admin/assign/types'
import { countryOptions } from '@/lib/geo/source'

/**
 * The filter vocabulary every tester picker offers.
 *
 * Both places that search testers — the assignment workspace and the message
 * composer — need the same dropdowns filled from the same catalog, and both
 * were about to hand-roll the same three `.map()` calls plus the same country
 * list. One transform means a country added here appears on both, and a
 * catalog shape change breaks in one place instead of silently diverging.
 *
 * Countries come from `lib/geo/source`, the same list every address and
 * project-target picker uses. They used to be a hardcoded twelve — chosen,
 * per the comment that stood here, because "the countries testers are
 * actually in would need an aggregate the API does not expose". True, and it
 * meant a tester in the thirteenth country could not be filtered for at all.
 * Offering every country costs nothing and cannot hide anybody.
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
    countries: countryOptions(),
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
