import { Field } from './Field'
import { DialCodeSelect } from './DialCodeSelect'
import { type SelectOption } from './Select'
import { Input } from './Input'

/** Matches `PHONE_MAX_LENGTH` in `api/src/lib/phone.ts` (the combined value; the number half alone is always shorter). */
export const PHONE_NUMBER_MAX_LENGTH = 24

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
  return (
    <Field label={label} htmlFor={id} required={required} error={error} hint={hint}>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        {/*
          A fixed 1:3 ratio, not a character-count estimate — the code
          picker is exactly a third of the number input's width whenever
          there is room for that, rather than a width guessed from the
          longest label. `minWidth` is the floor: the row's own 14px left
          padding + 40px reserved for the chevron already eat 54px before a
          single character of text fits, so in a narrow two-column cell a
          literal 1:3 split can shrink the box past the point of showing
          anything at all — tried at 72px, which fit one character of a
          multi-digit code before the ellipsis, worse than no code at all.
          120px is enough room for the common 2-5 digit case in full.

          `DialCodeSelect`, not the shared `Select`: the dropdown shows full
          "+91 · India" labels, but the closed box shows the code alone —
          see that component's own doc comment for why a plain native
          select can't do both at once.
        */}
        <DialCodeSelect
          id={`${id}-code`}
          name={`${name}DialCode`}
          defaultValue={dialCode}
          options={dialCodeOptions}
          placeholder="Code"
          required={required}
          invalid={Boolean(error)}
          style={{ flex: '1 1 0%', minWidth: 120 }}
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
          style={{ flex: '3 1 0%' }}
        />
      </div>
    </Field>
  )
}
