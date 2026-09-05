'use client'

import { useEffect, useState } from 'react'
import { Field } from './Field'
import { Select, type SelectOption } from './Select'

/**
 * Country → State → City, as three dependent selects.
 *
 * ── WHAT IT SUBMITS
 *
 * The names below match the columns that already exist, so this drops into a
 * form where three text inputs used to be and the Server Action needs no
 * change:
 *
 *   countryCode → ISO 3166-1 alpha-2   ("IN")
 *   state       → the state's NAME     ("Karnataka")
 *   city        → the city's NAME      ("Bengaluru")
 *
 * The state's ISO code is what the city lookup needs and is NOT what gets
 * stored — the database has held names since long before this picker, and
 * changing that would turn every existing row into a code nobody recognises.
 * So the code lives in component state and the name goes in a hidden input.
 *
 * ── WHY THE OPTIONS ARRIVE OVER HTTP
 *
 * `country-state-city` is ~17MB. It stays on the server behind `/app/geo`,
 * and this component asks for the fifty rows it needs when it needs them. A
 * country list is small enough to render from the server as a prop, so it is.
 *
 * ── STALE SELECTIONS
 *
 * Changing the country clears the state and the city; changing the state
 * clears the city. Anything else leaves a record claiming a city that is not
 * in the country it also claims.
 *
 * The clearing lives in the change handlers, NOT in the effects that fetch.
 * An effect keyed on `country` also runs on mount, so clearing there would
 * wipe the values an edit form was just given before the reader touched
 * anything.
 *
 * ── EXISTING VALUES SURVIVE
 *
 * A stored value missing from the list is prepended rather than dropped, so
 * opening a form to edit a phone number cannot silently blank a city that was
 * typed before this picker existed.
 */

/**
 * A fetch result, tagged with the query it answers.
 *
 * Keyed rather than cleared. The obvious shape — a plain `states` array reset
 * whenever the country changes — needs a synchronous `setState` inside the
 * effect, which costs an extra render and which `react-hooks/set-state-in-
 * effect` rightly refuses. Tagging the result with the country it belongs to
 * means "no data for this country yet" is derived, and the only `setState`
 * calls left are the asynchronous ones in the callbacks.
 */
interface Loaded {
  key: string
  options: readonly SelectOption[]
  failed: boolean
}

export interface LocationSelectProps {
  countryOptions: readonly SelectOption[]
  /** Current values, for an edit form. */
  defaultCountry?: string | null
  defaultState?: string | null
  defaultCity?: string | null
  /**
   * The ISO code of `defaultState`, resolved on the server so the city list
   * can load on first paint instead of after a round trip the reader watches.
   */
  defaultStateCode?: string | null
  /** Field names, for the rare form that differs. */
  countryName?: string
  stateName?: string
  cityName?: string
  required?: boolean
  /** Omit the city row where a record has no city column. */
  withCity?: boolean
  /**
   * Whether the state is part of the record.
   *
   * False where the table has no state column — a tester profile stores only
   * country and city. The state select still renders, because a city list
   * cannot be fetched without one and "every city in India" is not a picker;
   * it just acts as a way to reach the city rather than a stored value.
   */
  submitState?: boolean
  idPrefix?: string
}

/** Prepends a stored value the list does not know about. See the note above. */
function withCurrent(
  options: readonly SelectOption[],
  current: string | null | undefined,
): readonly SelectOption[] {
  const value = (current ?? '').trim()
  if (!value) return options
  if (options.some((o) => o.value === value)) return options
  return [{ value, label: value }, ...options]
}

/** Fetches one list, tagging the answer with the query that asked for it. */
function useGeo(key: string): {
  options: readonly SelectOption[]
  loading: boolean
  failed: boolean
} {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    const [country = '', state = ''] = key.split(':')
    const query = state
      ? `country=${encodeURIComponent(country)}&state=${encodeURIComponent(state)}`
      : `country=${encodeURIComponent(country)}`

    fetch(`/app/geo?${query}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { options: SelectOption[] }) => {
        if (!cancelled) setLoaded({ key, options: body.options, failed: false })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, options: [], failed: true })
      })

    return () => {
      cancelled = true
    }
  }, [key])

  const answered = loaded?.key === key
  return {
    options: answered ? loaded.options : [],
    loading: Boolean(key) && !answered,
    failed: answered ? loaded.failed : false,
  }
}

export function LocationSelect({
  countryOptions,
  defaultCountry,
  defaultState,
  defaultCity,
  defaultStateCode,
  countryName = 'countryCode',
  stateName = 'state',
  cityName = 'city',
  required = false,
  withCity = true,
  submitState = true,
  idPrefix = 'loc',
}: LocationSelectProps) {
  const [country, setCountry] = useState(defaultCountry ?? '')
  const [stateCode, setStateCode] = useState(defaultStateCode ?? '')
  const [stateLabel, setStateLabel] = useState(defaultState ?? '')
  const [city, setCity] = useState(defaultCity ?? '')

  const stateList = useGeo(country)
  const cityList = useGeo(country && stateCode ? `${country}:${stateCode}` : '')
  const states = stateList.options
  const cities = cityList.options

  function chooseCountry(next: string) {
    setCountry(next)
    // A state and city from the previous country are now wrong, not merely
    // unselected. Clear both rather than leave a contradiction to be saved.
    setStateCode('')
    setStateLabel('')
    setCity('')
  }

  function chooseState(nextCode: string) {
    setStateCode(nextCode)
    setStateLabel(states.find((s) => s.value === nextCode)?.label ?? '')
    setCity('')
  }

  const stateHint = stateList.loading
    ? 'Loading states…'
    : stateList.failed
      ? 'Could not load states. Choose the country again to retry.'
      : country && states.length === 0
        ? 'This country has no states listed.'
        : undefined

  const cityHint = cityList.loading
    ? 'Loading cities…'
    : cityList.failed
      ? 'Could not load cities. Choose the state again to retry.'
      : stateCode && cities.length === 0
        ? 'This state has no cities listed.'
        : undefined

  return (
    <>
      <Field label="Country" htmlFor={`${idPrefix}-country`} required={required}>
        <Select
          id={`${idPrefix}-country`}
          name={countryName}
          value={country}
          onChange={(e) => chooseCountry(e.target.value)}
          options={withCurrent(countryOptions, defaultCountry)}
          placeholder="Select country"
          required={required}
        />
      </Field>

      <Field label="State" htmlFor={`${idPrefix}-state`} hint={stateHint}>
        {/*
          The submitted value is the NAME, in a hidden field; the select itself
          trades in ISO codes because that is what the city lookup takes. See
          the note at the top of this file for why the two differ.
        */}
        {submitState ? <input type="hidden" name={stateName} value={stateLabel} /> : null}
        <Select
          id={`${idPrefix}-state`}
          value={stateCode}
          onChange={(e) => chooseState(e.target.value)}
          options={
            // An existing state whose code did not resolve still has to show.
            stateCode === '' && stateLabel ? [{ value: '', label: stateLabel }, ...states] : states
          }
          placeholder={country ? 'Select state' : 'Choose a country first'}
          disabled={!country || stateList.loading}
        />
      </Field>

      {withCity ? (
        <Field label="City" htmlFor={`${idPrefix}-city`} hint={cityHint}>
          <Select
            id={`${idPrefix}-city`}
            name={cityName}
            value={city}
            onChange={(e) => setCity(e.target.value)}
            options={withCurrent(cities, city)}
            placeholder={stateCode ? 'Select city' : 'Choose a state first'}
            disabled={!stateCode || cityList.loading}
          />
        </Field>
      ) : null}
    </>
  )
}
