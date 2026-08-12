import type { CSSProperties, ReactNode } from 'react'

export interface SectionHeaderProps {
  /** Mono uppercase kicker. */
  eyebrow?: string
  title?: ReactNode
  /**
   * A trailing clause of the heading, set smaller and on its own line inside
   * the same `<h2>`.
   *
   * One heading element, not two: "AI-Powered Testing Platform" and
   * "Intelligent, Autonomous, Faster" are one thought, and splitting them into
   * an h2 plus a sibling paragraph would either invent a heading level or
   * demote half the sentence to body copy. Screen readers announce the whole
   * string as a single heading, which is what it is — the size change is
   * visual hierarchy, not structure.
   */
  titleSmall?: ReactNode
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
  titleSmall,
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
          {titleSmall ? (
            <span
              style={{
                display: 'block',
                // One step down the display scale, not an arbitrary fraction:
                // the qualities read as a subordinate clause while staying
                // clearly part of the heading rather than turning into a deck.
                fontSize: 'var(--type-heading-lg-size)',
                lineHeight: 'var(--type-heading-lg-line)',
                letterSpacing: 'var(--type-heading-lg-tracking)',
                marginTop: 6,
                // Slightly receded so the claim leads and the qualities follow.
                color: inverse ? 'var(--text-inverse-muted)' : 'var(--text-secondary)',
              }}
            >
              {titleSmall}
            </span>
          ) : null}
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
