import { PhoneNumberControls } from './PhoneNumberControls'
import { dialCodeOptions, withCurrent } from '@/lib/geo/source'
import { splitStoredPhone } from '@/lib/phone/combine'

/**
 * A phone number field with a country dial-code picker in front of it.
 *
 * Submits as TWO form fields — `${name}DialCode` and `${name}Number` — rather
 * than one. Every existing action reads a single `phone` string, so call
 * `combinePhoneFromForm(formData, name)` (`lib/phone/combine.ts`) in place of
 * the old `formTrimmed(formData, name)` to get that same string back; nothing
 * downstream of the action needs to change.
 *
 * A Server Component, same as `CountrySelect` — `dialCodeOptions()` is a
 * plain in-memory list, and the picker needs no interactivity beyond what a
 * native `<select>` already gives for free (scrollable, and searchable by
 * country name via the browser's own type-ahead). The actual markup lives in
 * `PhoneNumberControls`, which has no `server-only` dependency and is what
 * `ContactForm` (a Client Component) uses directly, fed by a
 * `dialCodeOptions()` call made in ITS server-rendered parent.
 */
export function PhoneNumberField({
  id,
  name = 'phone',
  label = 'Phone',
  defaultValue,
  required = false,
  hint,
}: {
  id: string
  name?: string
  label?: string
  defaultValue?: string | null
  required?: boolean
  hint?: string
}) {
  const { dialCode, number } = splitStoredPhone(defaultValue)

  return (
    <PhoneNumberControls
      id={id}
      name={name}
      label={label}
      dialCode={dialCode}
      number={number}
      dialCodeOptions={withCurrent(dialCodeOptions(), dialCode)}
      required={required}
      hint={hint}
    />
  )
}
