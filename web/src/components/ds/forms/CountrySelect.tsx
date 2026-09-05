import { Select } from './Select'
import { countryOptions, withCurrent } from '@/lib/geo/source'

/**
 * A country picker for the records that store a country and nothing else.
 *
 * `LocationSelect` is the three-field dependent picker for tables that also
 * hold a state and a city — an organisation, say. A `User` has only
 * `countryCode`, so pairing it with a state select would offer a field with
 * nowhere to go.
 *
 * A Server Component on purpose: `lib/geo/source` is `server-only` because it
 * pulls in ~17MB of place data, and a country list needs no interactivity, so
 * there is nothing here worth shipping to the browser.
 *
 * The stored value is prepended when the list does not contain it. Records
 * predate this picker and were typed by hand, so a column can hold anything
 * from `IN` to `india` to a country that no longer exists — and blanking that
 * the moment somebody opens the form to change their phone number would be
 * the worse failure.
 */
export function CountrySelect({
  id,
  name = 'countryCode',
  defaultValue,
  required = false,
  placeholder = 'Select country',
}: {
  id: string
  name?: string
  defaultValue?: string | null
  required?: boolean
  placeholder?: string
}) {
  return (
    <Select
      id={id}
      name={name}
      defaultValue={defaultValue ?? ''}
      options={withCurrent(countryOptions(), defaultValue)}
      placeholder={placeholder}
      required={required}
    />
  )
}
