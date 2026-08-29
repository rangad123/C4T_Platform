import * as Flags from 'country-flag-icons/react/3x2'

/**
 * Country and language options for the targeting pickers.
 *
 * ── WHY DERIVED, NOT LISTED
 *
 * A hardcoded array of 250 countries is a file nobody maintains and everybody
 * distrusts. `country-flag-icons` already ships the exact ISO 3166-1 alpha-2
 * set this app can render a flag for — so that package IS the source of truth
 * for "which codes are real here", and `Intl.DisplayNames` turns each into a
 * name the platform does not have to translate or keep current.
 *
 * The API validates these independently (`isoCountry` / `isoLanguage` in
 * `projects.schema.ts`), so this list is a convenience for the person filling
 * the form, never the thing that decides what is acceptable.
 */

/** Computed once per server process — the lists never change at runtime. */
let countryCache: readonly { value: string; label: string }[] | null = null
let languageCache: readonly { value: string; label: string }[] | null = null

export function countryOptions(): readonly { value: string; label: string }[] {
  if (countryCache) return countryCache

  const names = new Intl.DisplayNames(['en'], { type: 'region' })
  countryCache = Object.keys(Flags)
    .filter((code) => /^[A-Z]{2}$/.test(code))
    .map((code) => {
      let label = code
      try {
        label = names.of(code) ?? code
      } catch {
        // An unassigned or withdrawn code. Keep it selectable under its own
        // code rather than dropping it — the API is what accepts or rejects.
      }
      return { value: code, label }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  return countryCache
}

/**
 * ISO 639-1 codes worth offering.
 *
 * Deliberately a curated set rather than all ~180: this is the language a
 * tester is asked to test IN, and the long tail is noise in a picker. The API
 * accepts any valid two-letter code, so nothing here is a ceiling — if a
 * client needs one that is missing, the field still takes it.
 *
 * Ordered by name below, so the order written here does not matter.
 */
const LANGUAGE_CODES = [
  'ar', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'gu', 'he',
  'hi', 'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'ml', 'mr', 'ms', 'nl', 'no',
  'pa', 'pl', 'pt', 'ro', 'ru', 'sk', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr',
  'uk', 'ur', 'vi', 'zh',
] as const

export function languageOptions(): readonly { value: string; label: string }[] {
  if (languageCache) return languageCache

  const names = new Intl.DisplayNames(['en'], { type: 'language' })
  languageCache = LANGUAGE_CODES.map((code) => {
    let label: string = code
    try {
      label = names.of(code) ?? code
    } catch {
      // Fall back to the bare code.
    }
    return { value: code, label }
  }).sort((a, b) => a.label.localeCompare(b.label))

  return languageCache
}
