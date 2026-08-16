import type { CSSProperties, InputHTMLAttributes } from 'react'
import { Icon } from '../core/Icon'
import { PasswordToggleInput } from './PasswordToggleInput'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Lucide icon name rendered inside the left edge. */
  iconLeft?: string
  /** Marks the control invalid — red border + aria-invalid. */
  invalid?: boolean
  disabled?: boolean
  style?: CSSProperties
  className?: string
  /**
   * Render a show/hide toggle on the right edge. Only meaningful for
   * `type="password"`. Delegates to `PasswordToggleInput`, the only client
   * leaf in this file — see that module's comment for why.
   */
  showPasswordToggle?: boolean
  /** Accessible label for the toggle button. Defaults to "Show password". */
  passwordToggleLabel?: string
}

/**
 * Shared control geometry for Input, Textarea and Select, so the three line up
 * in a form row. Exported because the other two consume it — the design system
 * keeps it unexposed, but in TypeScript sharing the object beats restating it.
 */
export const controlBase: CSSProperties = {
  width: '100%',
  minHeight: 48,
  padding: '12px 14px',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--type-body-md-size)',
  lineHeight: 1.4,
  color: 'var(--text-primary)',
  background: 'var(--surface-canvas)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-input)',
  transition: 'var(--transition-control)',
}

/**
 * A text control. Focus ring, placeholder colour and the invalid state all live
 * in the `.c4t-input` rules in tokens/interactions.css — never restyle them
 * here, and never suppress the focus ring.
 *
 * Server Component by default. The password show/hide toggle is the only
 * interactive path, and it delegates to `PasswordToggleInput` (a client
 * component) rather than pulling `useState` into this file — every other
 * `<Input>` in the app renders with zero client JS.
 */
export function Input({
  iconLeft,
  invalid,
  disabled,
  style,
  className,
  showPasswordToggle = false,
  passwordToggleLabel,
  type,
  ...rest
}: InputProps) {
  const isPassword = type === 'password'
  const canToggle = isPassword && showPasswordToggle

  if (canToggle) {
    return (
      <PasswordToggleInput
        iconLeft={iconLeft}
        invalid={invalid}
        disabled={disabled}
        style={style}
        className={className}
        passwordToggleLabel={passwordToggleLabel}
        {...rest}
      />
    )
  }

  const input = (
    <input
      className={['c4t-input', className].filter(Boolean).join(' ')}
      aria-invalid={invalid ? true : undefined}
      disabled={disabled}
      type={type}
      style={{
        ...controlBase,
        paddingLeft: iconLeft ? 42 : 14,
        paddingRight: 14,
        background: disabled ? 'var(--surface-sunken)' : controlBase.background,
        color: disabled ? 'var(--text-disabled)' : controlBase.color,
        ...style,
      }}
      {...rest}
    />
  )

  if (!iconLeft) return input

  return (
    <span style={{ position: 'relative', display: 'block' }}>
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
      {input}
    </span>
  )
}
