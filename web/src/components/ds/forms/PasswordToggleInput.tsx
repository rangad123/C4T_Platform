'use client'

import type { ChangeEvent, CSSProperties, InputHTMLAttributes } from 'react'
import { useState } from 'react'
import { Icon } from '../core/Icon'
import { controlBase } from './Input'
import { PasswordStrengthMeter } from './PasswordStrengthMeter'

interface PasswordToggleInputProps extends InputHTMLAttributes<HTMLInputElement> {
  iconLeft?: string
  invalid?: boolean
  disabled?: boolean
  style?: CSSProperties
  className?: string
  passwordToggleLabel?: string
  showStrength?: boolean
}

/**
 * The genuinely interactive leaves of `Input` — the show/hide toggle on a
 * password field, and (when asked for) the live strength meter beneath it.
 * Split into its own client module so the far more common plain-`<Input>`
 * path (every non-password field in the app) stays a Server Component with
 * zero client JS, per this project's "Server Components by default" rule.
 * Only a password field with `showPasswordToggle` or `showStrength` ever
 * loads this file's bundle.
 *
 * `showStrength` is the one thing that makes this component's input
 * controlled — every other caller (login, "current password" fields) never
 * sets it, so the input stays exactly as uncontrolled as it always was.
 */
export function PasswordToggleInput({
  iconLeft,
  invalid,
  disabled,
  style,
  className,
  passwordToggleLabel,
  showStrength = false,
  defaultValue,
  onChange,
  ...rest
}: PasswordToggleInputProps) {
  const [revealed, setRevealed] = useState(false)
  const [value, setValue] = useState(typeof defaultValue === 'string' ? defaultValue : '')

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    setValue(event.target.value)
    onChange?.(event)
  }

  const input = (
    <input
      className={['c4t-input', className].filter(Boolean).join(' ')}
      aria-invalid={invalid ? true : undefined}
      disabled={disabled}
      type={revealed ? 'text' : 'password'}
      style={{
        ...controlBase,
        paddingLeft: iconLeft ? 42 : 14,
        paddingRight: 42,
        background: disabled ? 'var(--surface-sunken)' : controlBase.background,
        color: disabled ? 'var(--text-disabled)' : controlBase.color,
        ...style,
      }}
      {...(showStrength ? { value, onChange: handleChange } : { defaultValue, onChange })}
      {...rest}
    />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <span style={{ position: 'relative', display: 'block' }}>
        {iconLeft ? (
          <Icon
            name={iconLeft}
            size={18}
            style={{
              position: 'absolute',
              left: 14,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
              pointerEvents: 'none',
            }}
          />
        ) : null}
        {input}
        <button
          type="button"
          aria-label={passwordToggleLabel ?? (revealed ? 'Hide password' : 'Show password')}
          aria-pressed={revealed}
          onClick={() => setRevealed((v) => !v)}
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 32,
            height: 32,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            color: 'var(--text-muted)',
            borderRadius: 'var(--radius-input)',
          }}
        >
          <Icon name={revealed ? 'eye-off' : 'eye'} size={18} />
        </button>
      </span>
      {showStrength ? <PasswordStrengthMeter value={value} /> : null}
    </div>
  )
}
