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
          A straight 1:2 flex ratio — the code picker is exactly half the
          number input's width. No minimum floor: an earlier version added
          one (first 72px, then 120px) to keep the code legible in a narrow
          row, but on this exact form that floor was the one actually
          winning — the literal ratio came out well under it, so the floor
          made the "ratio" fiction and the two fields came out nearly equal.
          The floor is gone; the ratio is now the ratio.

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
          required={required}
          invalid={Boolean(error)}
          style={{ flex: '1 1 0%' }}
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
          style={{ flex: '2 1 0%' }}
        />
      </div>
    </Field>
  )
}
