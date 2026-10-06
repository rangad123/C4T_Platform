import { Field } from './Field'
import { Select, type SelectOption } from './Select'
import { Input } from './Input'

/** Matches `PHONE_MAX_LENGTH` in `api/src/lib/phone.ts` (the combined value; the number half alone is always shorter). */
export const PHONE_NUMBER_MAX_LENGTH = 24

/**
 * Ceiling on the dial-code picker's width calculation, in characters. Of the
 * 251 codes, all but 5 fit in 8 ("+1234" is 5, the common case is 2-4) — the
 * 5 that don't (Dominican Republic "+18091829", Puerto Rico "+17871939",
 * and the Channel Islands/Isle of Man "+4414xx" numbers, an artifact of how
 * the underlying country data encodes NANP area codes) would otherwise
 * stretch the box for every reader to cover five rare exceptions. Those
 * still work — their label just clips in the closed box, same trade-off as
 * a long country name used to be.
 */
const MAX_CODE_WIDTH_CH = 8

/**
 * The actual dial-code-select + number-input row `PhoneNumberField` renders.
 *
 * Split into its own file, with no `geo/source.ts` import, so it can also be
 * used from a Client Component (`ContactForm` — see its own doc comment for
 * why it is one of the five CLAUDE.md exceptions) — `geo/source.ts` is
 * `server-only` and would break that component's build if pulled in
 * transitively. The client caller computes `dialCodeOptions` in whatever
 * Server Component renders it and passes the plain array down as a prop.
 */
export function PhoneNumberControls({
  id,
  name = 'phone',
  label = 'Phone',
  dialCode,
  number,
  dialCodeOptions,
  required = false,
  hint,
  error,
}: {
  id: string
  name?: string
  label?: string
  dialCode: string
  number: string
  dialCodeOptions: readonly SelectOption[]
  required?: boolean
  hint?: string
  error?: string
}) {
  /**
   * Sized from the options actually passed in, not a guessed constant — the
   * label is now just the code ("+91", "+1876", ...), so its longest form is
   * a handful of characters, and asking for exactly that (plus the select's
   * own fixed chrome: 14px left padding + 40px reserved for the chevron)
   * leaves everything else in the row for the number input. Whatever is left
   * over goes to `Input`'s `flex: 1` below.
   */
  const codeWidthCh = Math.min(
    Math.max('Code'.length, ...dialCodeOptions.map((o) => o.label.length)),
    MAX_CODE_WIDTH_CH,
  )

  return (
    <Field
      label={label}
      htmlFor={id}
      required={required}
      error={error}
      hint={hint ?? 'Pick your country, then enter the number without its dialing code.'}
    >
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Select
          id={`${id}-code`}
          name={`${name}DialCode`}
          defaultValue={dialCode}
          options={dialCodeOptions}
          placeholder="Code"
          required={required}
          invalid={Boolean(error)}
          style={{ flex: `0 0 calc(${codeWidthCh}ch + 54px)` }}
        />
        <Input
          id={id}
          name={`${name}Number`}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          defaultValue={number}
          required={required}
          invalid={Boolean(error)}
          maxLength={PHONE_NUMBER_MAX_LENGTH}
          style={{ flex: 1 }}
        />
      </div>
    </Field>
  )
}
