import type { CSSProperties, ReactNode } from 'react'
import { Button } from '../core/Button'
import { Icon } from '../core/Icon'
import { Media } from './Media'

export interface HeroProps {
  eyebrow?: string
  title?: ReactNode
  description?: ReactNode
  primaryCta?: string
  /** Destination for the primary CTA. */
  primaryHref?: string
  secondaryCta?: string
  secondaryHref?: string
  /** Checklist under the deck — max 3. */
  bullets?: string[]
  /** Custom media node; pass false to omit entirely (centred layout only). */
  media?: ReactNode | false
  /**
   * How the split layout divides its two columns.
   *
   *   'default' — `1.05fr 1fr`, copy slightly wider. Every hub and company page.
   *   'wide'    — `1fr 1.25fr`, media wider than copy. The homepage, which
   *               carries a video rather than a still and needs the room.
   *
   * The ratios stay inside this component rather than being passed in as raw
   * CSS, so a call site cannot invent a third geometry. Ignored when
   * `align="center"`.
   */
  mediaWidth?: 'default' | 'wide'
  tone?: 'canvas' | 'sunken' | 'inverse'
  align?: 'split' | 'center'
  /** Small line under the CTAs — compliance or social proof. */
  trustLine?: string
  style?: CSSProperties
  className?: string
}

/**
 * The page hero, split or centred.
 *
 * PORT NOTES.
 *  - `onAction(label)` is replaced by `primaryHref` / `secondaryHref`. The
 *    prototype routed by label through a callback; here the CTAs are real links,
 *    which keeps Hero a Server Component and makes the buttons work without JS.
 *  - Accent references moved off the raw coral ramp: the inverse eyebrow uses
 *    `--text-brand-inverse`, the bullet ticks `--accent-base`.
 *  - The split layout is `1.05fr 1fr` by default (`mediaWidth="wide"` gives the
 *    media the larger share instead) and collapses to one column under 900px via
 *    `.c4t-hero-split` in tokens/interactions.css; the title also steps down
 *    there through `.c4t-hero-title`. Both class names are load-bearing.
 */
export function Hero({
  eyebrow,
  title,
  description,
  primaryCta,
  primaryHref,
  secondaryCta,
  secondaryHref,
  bullets,
  media,
  mediaWidth = 'default',
  tone = 'canvas',
  align = 'split',
  trustLine,
  style,
  className,
}: HeroProps) {
  const inverse = tone === 'inverse'
  const centered = align === 'center'
  // Both collapse to one column under 900px via `.c4t-hero-split`, so neither
  // ratio survives to mobile and neither can cause a horizontal overflow there.
  const splitColumns = mediaWidth === 'wide' ? '1fr 1.25fr' : '1.05fr 1fr'

  const copy = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: centered ? 'center' : 'flex-start',
        textAlign: centered ? 'center' : 'left',
        maxWidth: centered ? 820 : 560,
        marginInline: centered ? 'auto' : 0,
      }}
    >
      {eyebrow ? (
        <span
          className="c4t-eyebrow"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            color: inverse ? 'var(--text-brand-inverse)' : 'var(--text-brand)',
            marginBottom: 18,
          }}
        >
          {eyebrow}
        </span>
      ) : null}

      <h1
        className="c4t-hero-title"
        style={{
          fontSize: centered ? 'var(--type-display-2xl-size)' : 'var(--type-display-xl-size)',
          lineHeight: centered ? 'var(--type-display-2xl-line)' : 'var(--type-display-xl-line)',
          letterSpacing: centered
            ? 'var(--type-display-2xl-tracking)'
            : 'var(--type-display-xl-tracking)',
          color: 'inherit',
          textWrap: 'balance',
        }}
      >
        {title}
      </h1>

      {description ? (
        <p
          style={{
            marginTop: 'var(--space-6)',
            fontSize: 'var(--type-body-lg-size)',
            lineHeight: 'var(--type-body-lg-line)',
            color: inverse ? 'var(--text-inverse-muted)' : 'var(--text-secondary)',
            maxWidth: 540,
          }}
        >
          {description}
        </p>
      ) : null}

      {bullets?.length ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 'var(--space-7) 0 0',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            textAlign: 'left',
          }}
        >
          {bullets.map((b) => (
            <li
              key={b}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                fontSize: 'var(--type-body-md-size)',
                color: inverse ? 'var(--text-inverse-muted)' : 'var(--text-secondary)',
              }}
            >
              <Icon name="check" size={18} style={{ color: 'var(--accent-base)', marginTop: 3 }} />
              {b}
            </li>
          ))}
        </ul>
      ) : null}

      {(primaryCta ?? secondaryCta) ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            marginTop: 'var(--space-8)',
            justifyContent: centered ? 'center' : 'flex-start',
          }}
        >
          {primaryCta ? (
            <Button size="lg" variant="primary" iconRight="arrow-right" href={primaryHref}>
              {primaryCta}
            </Button>
          ) : null}
          {secondaryCta ? (
            <Button
              size="lg"
              variant={inverse ? 'inverse-ghost' : 'secondary'}
              href={secondaryHref}
            >
              {secondaryCta}
            </Button>
          ) : null}
        </div>
      ) : null}

      {trustLine ? (
        <p
          style={{
            marginTop: 'var(--space-6)',
            fontSize: 'var(--type-caption-size)',
            color: inverse ? 'var(--text-inverse-muted)' : 'var(--text-muted)',
          }}
        >
          {trustLine}
        </p>
      ) : null}
    </div>
  )

  return (
    <section
      className={className}
      style={{
        background: inverse
          ? 'var(--surface-inverse)'
          : tone === 'sunken'
            ? 'var(--surface-sunken)'
            : 'var(--surface-canvas)',
        color: inverse ? 'var(--text-inverse)' : 'var(--text-primary)',
        paddingBlock: 'var(--space-13)',
        borderBottom: inverse ? 'none' : '1px solid var(--border-subtle)',
        ...style,
      }}
    >
      <div
        style={{
          maxWidth: 'var(--container-max)',
          margin: '0 auto',
          paddingInline: 'var(--container-gutter)',
        }}
      >
        {centered ? (
          <>
            {copy}
            {media !== false ? (
              <div style={{ marginTop: 56 }}>
                {media ?? (
                  <Media
                    ratio="21 / 9"
                    label="Product view"
                    icon="monitor"
                    tone={inverse ? 'inverse' : 'sunken'}
                  />
                )}
              </div>
            ) : null}
          </>
        ) : (
          <div
            className="c4t-hero-split"
            style={{
              display: 'grid',
              gridTemplateColumns: splitColumns,
              gap: 56,
              alignItems: 'center',
            }}
          >
            {copy}
            <div>
              {media ?? (
                <Media
                  ratio="4 / 3"
                  label="Product view"
                  icon="monitor"
                  tone={inverse ? 'inverse' : 'sunken'}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
