/**
 * Every claim-bearing figure on the site, in one place.
 *
 * content.md writes these as `{{5,000+}}`, `{{120+}}` and so on: real values
 * awaiting confirmation, not decoration. CLAUDE.md requires them to be resolved
 * in a single content module so a correction propagates everywhere instead of
 * being hunted across 40 pages.
 *
 * ⚠ NONE OF THESE ARE VERIFIED. The handoff is explicit that customer names,
 * logos, statistics, quotes and case studies are invented placeholders, and
 * that the brand voice makes measurable claims — so an unverified number is a
 * liability, not a rounding error. Confirm each against real records before
 * launch and delete this warning.
 *
 * The numbers below are the defensible ones from public record, NOT the
 * aspirational figures in the original brief (which claimed 50,000+ testers and
 * 2M+ test hours).
 */
export const STATS = {
  /** Vetted testers on the platform. */
  testers: '6,000+',
  /** Countries with at least one active tester. */
  countries: '120+',
  /** Unique real devices available. */
  devices: '2,000+',
  /** Enterprise clients served. */
  clients: '100+',
  /** Languages with native-speaker coverage. */
  languages: '40+',
  /** Teams surveyed for the State of AI Quality 2026 report. */
  surveyedTeams: '1,200',
} as const

export type StatKey = keyof typeof STATS

/**
 * The five-across band under the homepage hero (`window.C4TH.stats`).
 *
 * "11 years" is the one figure here that is not in `STATS`, because it is not a
 * count — it is derived from the 2015 founding date and goes stale on its own.
 * ⚠ It is hardcoded rather than computed from the current year deliberately:
 * the site is a static export, so a computed value would freeze at build time
 * and quietly disagree with itself. Update it with the rest of the figures.
 */
export const STAT_BAND: readonly { value: string; label: string }[] = [
  { value: STATS.testers, label: 'Vetted testers' },
  { value: STATS.countries, label: 'Countries' },
  { value: STATS.devices, label: 'Real devices' },
  { value: STATS.clients, label: 'Enterprise clients' },
  { value: '11 years', label: 'Delivering quality' },
]
