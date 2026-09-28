import { Icon } from '../core/Icon'

export interface PasswordCheck {
  id: string
  label: string
  test: (value: string) => boolean
}

/**
 * Mirrors `api/src/lib/password-policy.ts`'s `refine()` checks exactly — same
 * duplication-on-purpose reasoning as `PHONE_PATTERN` (`PhoneInput.tsx`'s
 * former comment, now `PhoneNumberField`'s): the two packages share no
 * module, and a client-side hint that disagrees with the server is worse
 * than none. If either changes, change both.
 */
export const PASSWORD_CHECKS: readonly PasswordCheck[] = [
  { id: 'length', label: 'At least 12 characters', test: (v) => v.length >= 12 },
  { id: 'lower', label: 'A lowercase letter', test: (v) => /[a-z]/.test(v) },
  { id: 'upper', label: 'An uppercase letter', test: (v) => /[A-Z]/.test(v) },
  { id: 'digit', label: 'A number', test: (v) => /[0-9]/.test(v) },
  { id: 'symbol', label: 'A symbol', test: (v) => /[^a-zA-Z0-9]/.test(v) },
]

const BAR_TONE = [
  'var(--status-error-fg)',
  'var(--status-error-fg)',
  'var(--status-warning-fg)',
  'var(--status-warning-fg)',
  'var(--status-info-fg)',
  'var(--status-success-fg)',
] as const

/**
 * A live strength bar + requirements checklist for a NEW password field.
 *
 * Pure and stateless — `value` is read from whatever tracks the actual input
 * (`PasswordToggleInput`, when its `showStrength` prop is set). Deliberately
 * checks the exact same rules the server enforces rather than a fuzzy
 * entropy estimate: showing "strong" for something the API will then reject
 * is worse than showing nothing.
 */
export function PasswordStrengthMeter({ value }: { value: string }) {
  const metCount = PASSWORD_CHECKS.filter((check) => check.test(value)).length
  const tone = BAR_TONE[metCount]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div
        role="progressbar"
        aria-label="Password strength"
        aria-valuenow={metCount}
        aria-valuemin={0}
        aria-valuemax={PASSWORD_CHECKS.length}
        style={{
          display: 'flex',
          gap: 4,
          height: 4,
        }}
      >
        {PASSWORD_CHECKS.map((check, index) => (
          <span
            key={check.id}
            style={{
              flex: 1,
              borderRadius: 'var(--radius-full)',
              background: index < metCount ? tone : 'var(--border-default)',
              transition: 'var(--transition-surface)',
            }}
          />
        ))}
      </div>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 'var(--space-1) var(--space-4)',
        }}
      >
        {PASSWORD_CHECKS.map((check) => {
          const met = check.test(value)
          return (
            <li
              key={check.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 'var(--type-caption-size)',
                color: met ? 'var(--status-success-fg)' : 'var(--text-muted)',
              }}
            >
              {met ? (
                <Icon name="check-circle-2" size={14} />
              ) : (
                <span
                  aria-hidden="true"
                  style={{
                    width: 10,
                    height: 10,
                    flex: 'none',
                    borderRadius: 'var(--radius-full)',
                    border: '1.5px solid var(--border-default)',
                  }}
                />
              )}
              {check.label}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
