import type { CSSProperties } from 'react'
import { Icon } from '../core/Icon'
import { Media } from './Media'
import { SiteImage } from './SiteImage'

export interface CaseStudyResult {
  value: string
  label: string
}

export interface CaseStudyCardProps {
  /**
   * The client, or an anonymised descriptor. Optional: a case study published
   * as a blog post has a headline and a photograph but no separate client
   * field, and inventing one to fill the slot would be wrong.
   */
  client?: string
  industry: string
  headline: string
  /** A sentence or two under the headline, for a study with no metrics to show. */
  description?: string
  /**
   * A real photograph in place of the placeholder plate. Additive, like
   * `ResourceCard`'s: every call site that omits it renders as before.
   */
  image?: { src: string; alt: string }
  results?: readonly CaseStudyResult[]
  /** Two-column hero treatment for the lead study on a hub page. */
  featured?: boolean
  href: string
  style?: CSSProperties
  className?: string
}

/** Caps text at a number of lines, for a card that lives in a fixed-height carousel track. */
function clampLines(lines: number): CSSProperties {
  return {
    display: '-webkit-box',
    WebkitLineClamp: lines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  }
}

/**
 * A customer outcome, compact or featured.
 *
 * PORT NOTES.
 *  - The source's metric sizes (32px featured, 22px compact) have no token.
 *    They map to `--type-heading-lg-size` (28px) and `--type-heading-md-size`
 *    (22px) — the compact one is exact, the featured one steps down 4px rather
 *    than inventing a value. CLAUDE.md rule 1.
 *  - `results.map(r => key={r.label})` assumed labels are unique within a card.
 *    They are in the real data, but the placeholder set repeats "Result metric
 *    one", so the key is now the index.
 *  - `onClick`/`href="#"` became a required `href`.
 *
 * Figures use tabular numerals so a column of metrics stays aligned.
 */
export function CaseStudyCard({
  client,
  industry,
  headline,
  description,
  image,
  results = [],
  featured,
  href,
  style,
  className,
}: CaseStudyCardProps) {
  if (featured) {
    return (
      <a
        href={href}
        className={['c4t-card-hover', 'c4t-casestudy-featured', className]
          .filter(Boolean)
          .join(' ')}
        style={{
          display: 'grid',
          gridTemplateColumns: '1.1fr 1fr',
          gap: 0,
          overflow: 'hidden',
          background: 'var(--surface-canvas)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-panel)',
          textDecoration: 'none',
          color: 'inherit',
          ...style,
        }}
      >
        <div style={{ padding: 40, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--type-eyebrow-size)',
              fontWeight: 'var(--fw-semibold)',
              letterSpacing: 'var(--type-eyebrow-tracking)',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
            }}
          >
            <span style={{ color: 'var(--text-brand)' }}>Case study</span>
            {industry}
          </div>

          <h3
            style={{
              marginTop: 16,
              fontSize: 'var(--type-heading-lg-size)',
              lineHeight: 'var(--type-heading-lg-line)',
              letterSpacing: 'var(--type-heading-lg-tracking)',
              textWrap: 'pretty',
            }}
          >
            {headline}
          </h3>

          <div
            style={{
              marginTop: 28,
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.min(results.length, 3) || 1}, 1fr)`,
              gap: 20,
            }}
          >
            {results.map((r, i) => (
              <div key={i}>
                <div
                  style={{
                    fontSize: 'var(--type-heading-lg-size)',
                    fontWeight: 'var(--fw-semibold)',
                    letterSpacing: 'var(--type-heading-lg-tracking)',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--text-primary)',
                  }}
                >
                  {r.value}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 'var(--type-caption-size)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {r.label}
                </div>
              </div>
            ))}
          </div>

          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 'auto',
              paddingTop: 32,
              fontSize: 'var(--type-body-sm-size)',
              fontWeight: 'var(--fw-medium)',
              color: 'var(--text-brand)',
            }}
          >
            {client ? `Read the ${client} story` : 'Read the case study'}{' '}
            <Icon name="arrow-right" size={15} />
          </span>
        </div>

        <Media
          ratio="auto"
          label={client ?? industry}
          icon="building-2"
          tone="sunken"
          radius="0"
          style={{
            height: '100%',
            aspectRatio: 'auto',
            borderWidth: 0,
            borderLeft: '1px solid var(--border-subtle)',
          }}
        />
      </a>
    )
  }

  return (
    <a
      href={href}
      className={['c4t-card-hover', className].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--surface-canvas)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        textDecoration: 'none',
        color: 'inherit',
        height: '100%',
        ...style,
      }}
    >
      {image ? (
        <SiteImage
          src={image.src}
          alt={image.alt}
          fill
          ratio="16 / 9"
          sizes="(max-width: 900px) 100vw, 540px"
          radius="0"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        />
      ) : (
        <Media
          ratio="16 / 9"
          label={client ?? industry}
          icon="building-2"
          tone="sunken"
          radius="0"
          style={{ borderWidth: 0, borderBottom: '1px solid var(--border-subtle)' }}
        />
      )}

      <div
        style={{
          padding: 'var(--space-card-padding)',
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--type-eyebrow-size)',
            fontWeight: 'var(--fw-semibold)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
          }}
        >
          {industry}
        </div>

        <h3
          style={{
            marginTop: 10,
            fontSize: 'var(--type-heading-sm-size)',
            lineHeight: 'var(--type-heading-sm-line)',
            letterSpacing: 'var(--type-heading-sm-tracking)',
            textWrap: 'pretty',
            ...clampLines(3),
          }}
        >
          {headline}
        </h3>

        {description ? (
          <p
            style={{
              marginTop: 12,
              fontSize: 'var(--type-body-sm-size)',
              lineHeight: 'var(--type-body-sm-line)',
              color: 'var(--text-secondary)',
              ...clampLines(2),
            }}
          >
            {description}
          </p>
        ) : null}

        {results.length ? (
          <div
            style={{
              marginTop: 18,
              paddingTop: 16,
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              gap: 'var(--space-6)',
            }}
          >
            {results.slice(0, 2).map((r, i) => (
              <div key={i}>
                <div
                  style={{
                    fontSize: 'var(--type-heading-md-size)',
                    fontWeight: 'var(--fw-semibold)',
                    letterSpacing: 'var(--type-heading-md-tracking)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {r.value}
                </div>
                <div
                  style={{
                    fontSize: 'var(--type-caption-size)',
                    color: 'var(--text-muted)',
                    marginTop: 2,
                  }}
                >
                  {r.label}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </a>
  )
}
