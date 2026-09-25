import { Field } from './Field'
import { Select, type SelectOption } from './Select'
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
          style={{ flex: '0 0 168px' }}
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
