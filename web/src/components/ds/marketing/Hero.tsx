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
  /**
   * A substring of `title` to render in the accent colour.
   *
   * Takes a string, not JSX, so the content modules stay plain data — the OG
   * card and the page metadata read the same `title` and cannot hold markup.
   * Only the first occurrence is highlighted, and a value that does not appear
   * in `title` is ignored rather than throwing, so a copy edit that breaks the
   * pairing degrades to an unhighlighted headline instead of a crash.
   */
  titleHighlight?: string
  /**
   * How the split hero divides its two columns.
   *
   *   default   `1.05fr 1fr`  — near-even, what every inner page uses.
   *   wide      `1fr 1.25fr`  — media-led, for art that carries the page.
   *   copy-led  `1.5fr 1fr`   — for a long headline that needs the measure.
   *
   * `copy-led` also RAISES THE COPY COLUMN'S maxWidth, which is the part that
   * actually matters. The copy is capped at 560px independently of the grid, so
   * widening the track alone changes nothing — the headline keeps wrapping at
   * the same place and only the whitespace beside it grows. Both have to move
   * together.
   */
  mediaWidth?: 'default' | 'wide' | 'copy-led'
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
  titleHighlight,
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
  const splitColumns =
    mediaWidth === 'wide' ? '1fr 1.25fr' : mediaWidth === 'copy-led' ? '1.15fr 1fr' : '1.05fr 1fr'

  /**
   * The measure the headline actually gets. 560px is the default and the reason
   * a long title wraps early; `copy-led` lifts it to 760 so nine words set in
   * three lines rather than four. The description keeps its own 540px cap below
   * — body text at 760 would run past the ~75ch comfortable measure, so the
   * headline widens and the paragraph does not.
   */
  const copyMaxWidth = centered ? 820 : mediaWidth === 'copy-led' ? 760 : 560

  /**
   * The headline, with `titleHighlight` tinted if it is present in `title`.
   *
   * ⚠ THIS USES `--accent-base` ON DARK, WHICH IS ONLY SAFE AT DISPLAY SIZE.
   *
   * colors.css routes the accent-on-dark role to `--text-brand-inverse`
   * (teal-100) and warns that "teal-500 on ink-950 is unreadable". That
   * guidance is written for text in general, and it is right for body copy —
   * measured, `--accent-base` (#0b7a6e) on `--ink-950` (#17130f) is 3.54:1,
   * short of the 4.5:1 WCAG 1.4.3 requires at normal size.
   *
   * A hero headline is not normal size. At ~56px it is comfortably past the
   * 24px "large text" threshold, where the requirement is 3:1 — so 3.54:1
   * conforms. The Client asked for the deeper teal of the primary button, and
   * at this size it is legitimately available.
   *
   * DO NOT LIFT THIS PAIRING INTO SMALLER TEXT. Below 24px (or 18.66px bold)
   * it silently becomes a contrast failure. Anything at body size on a dark
   * band must go back to `--text-brand-inverse`, which measures 14.45:1.
   *
   * The span carries no semantics: it is a colour change, not emphasis. A
   * screen reader reads the headline as one continuous sentence, which is
   * right — the tint is a visual accent, and marking it up as <em> or <strong>
   * would put stress on two words that are not being contrasted with anything.
   */
  const headline = (() => {
    // `title` is ReactNode — callers may pass an element. Splitting only makes
    // sense on a plain string, so anything else passes straight through.
    if (!titleHighlight || typeof title !== 'string') return title
    const at = title.indexOf(titleHighlight)
    if (at === -1) return title
    return (
      <>
        {title.slice(0, at)}
        <span
          style={{
            /**
             * MONO UPPERCASE, borrowed from the eyebrow treatment — same face,
             * same weight, same 0.12em tracking as `.c4t-eyebrow`, so the two
             * read as one typographic voice even though this sits inside a
             * display headline rather than above it.
             *
             * SIZED IN `em`, NOT A TOKEN — this is the important part.
             *
             * 0.64em is 36px against the 56px desktop headline, which is where
             * this landed by eye: the eyebrow's own 12px disappears inside a
             * display line, and 28px still read as a footnote rather than part
             * of the sentence. Mono runs optically smaller than the display
             * face at the same nominal size, so it has to sit higher on the
             * scale than a like-for-like swap suggests.
             *
             * It was briefly a fixed `--type-display-md-size`. That breaks on
             * small screens: the headline scales down to 34px at 375px wide
             * while a fixed 36px does not, so the phrase meant to be SMALLER
             * than the headline rendered LARGER than it. `em` inherits from the
             * h1, so the ratio holds at every breakpoint.
             *
             * `text-transform` rather than uppercased source text: the string
             * in content/home.ts stays "Human Intelligence", so the OG card,
             * page metadata and any screen reader get the sentence-cased form.
             * Only the rendering shouts.
             */
            fontFamily: 'var(--font-mono)',
            fontSize: '0.64em',
            fontWeight: 'var(--fw-semibold)',
            letterSpacing: 'var(--type-eyebrow-tracking)',
            textTransform: 'uppercase',
            color: inverse ? 'var(--accent-base)' : 'var(--text-brand)',
          }}
        >
          {titleHighlight}
        </span>
        {title.slice(at + titleHighlight.length)}
      </>
    )
  })()

  const copy = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: centered ? 'center' : 'flex-start',
        textAlign: centered ? 'center' : 'left',
        maxWidth: copyMaxWidth,
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
        {headline}
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
