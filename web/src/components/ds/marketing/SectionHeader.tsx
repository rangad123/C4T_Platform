import type { CSSProperties, ReactNode } from 'react'

export interface SectionHeaderProps {
  /** Mono uppercase kicker. */
  eyebrow?: string
  title?: ReactNode
  description?: ReactNode
  align?: 'left' | 'center'
  tone?: 'default' | 'inverse'
  /** Buttons or links rendered under the copy. */
  actions?: ReactNode
  style?: CSSProperties
  className?: string
}

/**
 * Eyebrow + heading + deck, the opener for nearly every section.
 *
 * PORT NOTE: the inverse eyebrow used the raw `--coral-400` ramp step. That is
 * the accent-on-dark role, which step 1 named `--text-brand-inverse` — a pale
 * tint, because the accent at full strength is unreadable on `--ink-950`.
 */
export function SectionHeader({
  eyebrow,
  title,
  description,
  align = 'left',
  tone = 'default',
  actions,
  style,
  className,
}: SectionHeaderProps) {
  const inverse = tone === 'inverse'

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        maxWidth: align === 'center' ? 760 : 720,
        marginInline: align === 'center' ? 'auto' : 0,
        textAlign: align,
        alignItems: align === 'center' ? 'center' : 'flex-start',
        ...style,
      }}
    >
      {eyebrow ? (
        <span
          className="c4t-eyebrow"
          style={{ color: inverse ? 'var(--text-brand-inverse)' : 'var(--text-brand)' }}
        >
          {eyebrow}
        </span>
      ) : null}

      {title ? (
        <h2
          style={{
            fontSize: 'var(--type-display-md-size)',
            lineHeight: 'var(--type-display-md-line)',
            letterSpacing: 'var(--type-display-md-tracking)',
            color: inverse ? 'var(--text-inverse)' : 'var(--text-primary)',
            textWrap: 'balance',
          }}
        >
          {title}
        </h2>
      ) : null}

      {description ? (
        <p
          style={{
            fontSize: 'var(--type-body-lg-size)',
            lineHeight: 'var(--type-body-lg-line)',
            color: inverse ? 'var(--text-inverse-muted)' : 'var(--text-secondary)',
          }}
        >
          {description}
        </p>
      ) : null}

      {actions ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>{actions}</div>
      ) : null}
    </div>
  )
}
