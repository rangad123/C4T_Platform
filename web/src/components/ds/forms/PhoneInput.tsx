import { Input, type InputProps } from './Input'

/** Matches `PHONE_MAX_LENGTH` in `api/src/lib/phone.ts`. */
export const PHONE_MAX_LENGTH = 24

/**
 * The same rule `phoneField` enforces on the API, written as an HTML pattern.
 *
 * The lookahead counts digits (7–15, E.164's ceiling) while the body allows the
 * separators people type between them. `pattern` is implicitly anchored, and
 * the browser compiles it with the `v` flag — under which `(`, `)` and `-` are
 * reserved inside a character class — so those are escaped. Verified to compile
 * under both `u` and `v`.
 *
 * Duplicated across the two packages on purpose: they do not share a module,
 * and a client-side hint that disagrees with the server is worse than none. If
 * either changes, change both.
 */
export const PHONE_PATTERN = String.raw`(?=(?:[^0-9]*[0-9]){7,15}[^0-9]*$)\+?[0-9][0-9 \(\)\.\-]*`

/** Shown by the browser when the pattern rejects, and usable as a `Field` hint. */
export const PHONE_HINT =
  'Digits, optionally with a leading + and spaces, hyphens or parentheses. Between 7 and 15 digits.'

/**
 * A phone number field, constrained in the browser the way the API constrains
 * it on arrival.
 *
 * Every phone input in the app used to be a bare `type="tel"`, which validates
 * nothing — `type="tel"` exists to pick a keypad, not to check a number. A
 * customer's contact phone could be saved as thirty-one 9s. The constraints
 * here are the visible half of that fix; `phoneField` on the API is the half
 * that actually matters, since a form is not a security boundary.
 *
 * `pattern` is skipped by the browser on an empty value, so an optional field
 * stays optional — mark required ones with `required` as usual.
 */
export function PhoneInput({ title, ...rest }: Omit<InputProps, 'type'>) {
  return (
    <Input
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      maxLength={PHONE_MAX_LENGTH}
      pattern={PHONE_PATTERN}
      title={title ?? PHONE_HINT}
      {...rest}
    />
  )
}
