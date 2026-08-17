import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import Link from 'next/link'
import { Icon } from './Icon'

export interface ButtonProps {
  children?: ReactNode
  /** primary = accent CTA; secondary = outlined; ghost = bare; link = inline text; inverse* = on dark bands. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'link' | 'inverse' | 'inverse-ghost'
  size?: 'sm' | 'md' | 'lg'
  /** Lucide icon name rendered before the label. */
  iconLeft?: string
  /** Lucide icon name rendered after the label. Use "arrow-right" on forward CTAs. */
  iconRight?: string
  fullWidth?: boolean
  disabled?: boolean
  /** Renders a link instead of a <button>. */
  href?: string
  /**
   * Passed to next/link when `href` is internal. Set `false` for links whose
   * target does real work on GET — a CSV export endpoint, for instance, which
   * would otherwise run on hover as Next prefetches it.
   */
  prefetch?: boolean
  type?: 'button' | 'submit' | 'reset'
  onClick?: (e: MouseEvent) => void
  className?: string
  style?: CSSProperties
}

/**
 * The control scale, ported verbatim from the design system source.
 *
 * These px values are the definition of the control scale, not ad-hoc numbers —
 * this is the layer that turns tokens into controls, and they live in exactly
 * one place. Page and section code must never restate them; it passes `size`.
 * The heights (36/44/52) deliberately sit off the 4px spacing grid because
 * they are optical control heights, not spacing.
 */
const SIZES = {
  sm: { height: 36, padding: '0 14px', fontSize: 'var(--type-button-sm-size)', icon: 16, gap: 6 },
  md: { height: 44, padding: '0 20px', fontSize: 'var(--type-button-md-size)', icon: 18, gap: 8 },
  lg: { height: 52, padding: '0 26px', fontSize: 'var(--type-button-lg-size)', icon: 20, gap: 8 },
} as const

const VARIANTS = {
  primary: {
    background: 'var(--action-primary-bg)',
    color: 'var(--text-on-brand)',
    border: '1px solid transparent',
  },
  secondary: {
    background: 'var(--action-secondary-bg)',
    color: 'var(--text-primary)',
    border: '1px solid var(--action-secondary-border)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-primary)',
    border: '1px solid transparent',
  },
  link: {
    background: 'transparent',
    color: 'var(--text-brand)',
    border: '1px solid transparent',
    padding: 0,
    height: 'auto',
  },
  inverse: {
    background: 'var(--action-inverse-bg)',
    color: 'var(--action-inverse-text)',
    border: '1px solid transparent',
  },
  'inverse-ghost': {
    background: 'transparent',
    color: 'var(--text-inverse)',
    border: '1px solid var(--border-inverse)',
  },
} as const satisfies Record<NonNullable<ButtonProps['variant']>, CSSProperties>

/**
 * The primary action control.
 *
 * PORT NOTES.
 *  - `href` renders a next/link <Link> rather than a bare <a>, so internal
 *    navigation is client-side and prefetched. External and mailto/tel hrefs
 *    fall back to a plain anchor.
 *  - This stays a Server Component. Passing `onClick` makes the CALLER a client
 *    component, which is correct — Button itself holds no state.
 *  - `aria-disabled` is load-bearing for styling, not just accessibility: every
 *    hover rule in interactions.css is gated on `:not([aria-disabled="true"])`.
 *    It is emitted on the anchor form too, where the native `disabled`
 *    attribute does not exist.
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  fullWidth,
  disabled,
  href,
  prefetch,
  type = 'button',
  onClick,
  className,
  style,
}: ButtonProps) {
  const s = SIZES[size]
  const v = VARIANTS[variant]

  const base: CSSProperties = {
    display: fullWidth ? 'flex' : 'inline-flex',
    width: fullWidth ? '100%' : undefined,
    alignItems: 'center',
    justifyContent: 'center',
    gap: s.gap,
    height: s.height,
    padding: s.padding,
    fontFamily: 'var(--font-sans)',
    fontSize: s.fontSize,
    fontWeight: 'var(--fw-medium)',
    lineHeight: 1,
    letterSpacing: '-0.1px',
    borderRadius: 'var(--radius-button)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    textDecoration: variant === 'link' ? 'underline' : 'none',
    textUnderlineOffset: 4,
    whiteSpace: 'nowrap',
    transition: 'var(--transition-control)',
    opacity: disabled ? 0.55 : 1,
    ...v,
    ...style,
  }

  const classes = ['c4t-btn', `c4t-btn--${variant}`, className].filter(Boolean).join(' ')

  const content = (
    <>
      {iconLeft ? <Icon name={iconLeft} size={s.icon} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={s.icon} /> : null}
    </>
  )

  if (href) {
    const isInternal = href.startsWith('/') && !href.startsWith('//')
    const shared = {
      className: classes,
      style: base,
      // `? true : undefined`, not `??` — false must collapse to undefined so
      // React omits the attribute entirely rather than emitting "false".
      'aria-disabled': disabled ? true : undefined,
      onClick: disabled ? undefined : onClick,
    }

    return isInternal ? (
      <Link href={href} prefetch={prefetch} {...shared}>
        {content}
      </Link>
    ) : (
      <a href={href} {...shared}>
        {content}
      </a>
    )
  }

  return (
    <button
      className={classes}
      type={type}
      disabled={disabled}
      aria-disabled={disabled ? true : undefined}
      onClick={disabled ? undefined : onClick}
      style={base}
    >
      {content}
    </button>
  )
}
