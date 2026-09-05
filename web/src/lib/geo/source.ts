import 'server-only'
import { Country, State, City } from 'country-state-city'

/**
 * Countries, states and cities — the one source for all three.
 *
 * ── `server-only` IS LOAD-BEARING
 *
 * `country-state-city` is ~17MB on disk: every state and city on earth. That
 * is fine on a server and catastrophic in a browser bundle, so this module
 * refuses to be imported from a Client Component and the dependent pickers
 * reach it through the `/app/geo` route handler instead. Import it into a
 * `'use client'` file and the build fails, which is the intended behaviour —
 * not an obstacle to work around.
 *
 * ── WHAT IS STORED, AND WHY IT LOOKS INCONSISTENT
 *
 * The shapes here match the columns that already exist rather than the
 * package's own idea of an identifier:
 *
 *   country → ISO 3166-1 alpha-2  (`User.countryCode`, `Organisation.countryCode`)
 *   state   → the state's NAME    (`Organisation.state`, a plain string)
 *   city    → the city's NAME     (`TesterProfile.city`, a plain string)
 *
 * A state's ISO code would be the better key, and it is what the city lookup
 * needs — but the database has stored names since before this picker existed,
 * and switching the stored value would render every existing row as a code
 * nobody recognises. So the picker carries the code in its own state for the
 * dependent lookup and submits the name, and no migration is required.
 *
 * ── UNKNOWN VALUES SURVIVE
 *
 * `withCurrent` exists because a stored value that is not in the list must
 * still show. Records predate this list, and a country can be renamed or
 * withdrawn. Dropping such a value would silently blank a field the moment
 * someone opened the form to edit something else.
 */

export interface Option {
  value: string
  label: string
}

/** Computed once per server process — the package's data never changes at runtime. */
let countryCache: readonly Option[] | null = null

export function countryOptions(): readonly Option[] {
  if (countryCache) return countryCache
  countryCache = Country.getAllCountries()
    .map((c) => ({ value: c.isoCode, label: c.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return countryCache
}

/** The label for a stored code, or the code itself when it is not in the list. */
export function countryLabel(code: string | null | undefined): string {
  if (!code) return ''
  return Country.getCountryByCode(code)?.name ?? code
}

/**
 * States of one country, as `{ value: isoCode, label: name }`.
 *
 * The code is the value because the city lookup needs it. Callers that store
 * the NAME — which is all of them — submit `label`, not `value`; see the note
 * at the top and `LocationSelect`, which does exactly that.
 */
export function stateOptions(countryCode: string): readonly Option[] {
  if (!countryCode) return []
  return State.getStatesOfCountry(countryCode)
    .map((s) => ({ value: s.isoCode, label: s.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** Cities of one state. Names only — cities have no stable code to key on. */
export function cityOptions(countryCode: string, stateCode: string): readonly Option[] {
  if (!countryCode || !stateCode) return []
  return City.getCitiesOfState(countryCode, stateCode)
    .map((c) => ({ value: c.name, label: c.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The ISO code of a state given its stored NAME.
 *
 * The reverse lookup an edit form needs: the record holds "Karnataka", and the
 * city list cannot be fetched without "KA". Case-insensitive because the data
 * predates the picker and was typed by hand.
 */
export function stateCodeForName(countryCode: string, name: string): string | null {
  if (!countryCode || !name) return null
  const wanted = name.trim().toLowerCase()
  const match = State.getStatesOfCountry(countryCode).find(
    (s) => s.name.toLowerCase() === wanted || s.isoCode.toLowerCase() === wanted,
  )
  return match?.isoCode ?? null
}

/**
 * IANA time zones.
 *
 * `Intl.supportedValuesOf` rather than the zone list hanging off each country
 * in `country-state-city`: it is the platform's own list, needs no package to
 * stay current, and is what two of the three pages that show this field were
 * already using — each with its own private copy of the constant. This is
 * that constant, once.
 */
let zoneCache: readonly Option[] | null = null

export function timezoneOptions(): readonly Option[] {
  if (zoneCache) return zoneCache
  zoneCache = Intl.supportedValuesOf('timeZone').map((zone) => ({ value: zone, label: zone }))
  return zoneCache
}

/**
 * The options a select should render, given what the record actually holds.
 *
 * If the stored value is missing from the list it is prepended rather than
 * dropped, so opening an edit form never silently discards a value somebody
 * entered before this picker existed. See the note at the top of the file.
 */
export function withCurrent(options: readonly Option[], current: string | null | undefined) {
  const value = (current ?? '').trim()
  if (!value) return options
  if (options.some((o) => o.value === value)) return options
  return [{ value, label: value }, ...options]
}
