import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'

export interface CardProps {
  /** Heading. Sentence case. */
  title: ReactNode
  /** One line under the title — a status line, a category, a date. */
  meta?: ReactNode
  /**
   * Rendered top-right: usually one small action, or a badge. Anything
   * interactive here forces `href` to stay unset — `<a>` may not contain an
   * `<a>`, a `<button>` or a `<form>`, and a nested one is a hydration error
   * rather than a style problem.
   */
  actions?: ReactNode
  /** Body copy or fields, under the title block. */
  children?: ReactNode
  /** Makes the whole card a link. See the note on `actions`. */
  href?: string
  style?: CSSProperties
}

const CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  padding: 'var(--space-5)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-card)',
  background: 'var(--surface-canvas)',
  // A card is a whole item: it does not shrink below its content and leave a
  // title clipped mid-word.
  minWidth: 0,
}

/**
 * One item in a collection of peers. Always inside a `CardGrid` — it renders
 * an `<li>`, so the two go together.
 *
 * ── Card or panel?
 *
 * A `Panel` is a region of a page: one concern, one heading, one form, and
 * there are a handful per page. A `Card` is one of many interchangeable
 * things — a saved template, a registered device — and the page holds as many
 * as the data does. The shape scale encodes the difference: 14px radius for
 * panels, 10px for cards, so cards inside a panel still read as two levels.
 *
 * ── Why this exists
 *
 * The same twelve lines of border / radius / padding / background were
 * hand-written across the admin and tester pages, drifting a little each
 * time — some at `--border-subtle` and some at `--border-default`, some
 * padding 4 and some 5. Every one of those was a card. This is that card.
 */
export function Card({ title, meta, actions, children, href, style }: CardProps) {
  const body = (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: actions ? '1fr auto' : '1fr',
          gap: 'var(--space-4)',
          alignItems: 'start',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-primary)' }}>
            {title}
          </div>
          {meta ? (
            <div
              style={{
                marginTop: 'var(--space-1)',
                fontSize: 'var(--type-body-sm-size)',
                color: 'var(--text-secondary)',
              }}
            >
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? <div style={{ flexShrink: 0 }}>{actions}</div> : null}
      </div>
      {children}
    </>
  )

  if (href) {
    return (
      <li style={{ display: 'flex', minWidth: 0 }}>
        <Link
          href={href}
          className="c4t-card-hover"
          style={{
            ...CARD_STYLE,
            flex: 1,
            textDecoration: 'none',
            color: 'inherit',
            transition: 'var(--transition-surface)',
            ...style,
          }}
        >
          {body}
        </Link>
      </li>
    )
  }

  return <li style={{ ...CARD_STYLE, ...style }}>{body}</li>
}

export interface CardGridProps {
  children: ReactNode
  /**
   * Narrowest a card may get before the grid drops a column. Cards holding a
   * paragraph want ~320; a name and one line of meta is fine at ~240.
   */
  min?: number
  style?: CSSProperties
}

/**
 * Lays cards out in as many columns as fit.
 *
 * A stack of full-width cards wastes the right two thirds of a 1200px
 * container and turns eight items into an eight-screen scroll. `auto-fill`
 * rather than `auto-fit`, so a single card keeps its natural width instead of
 * stretching across the row and pretending to be a panel.
 */
export function CardGrid({ children, min = 280, style }: CardGridProps) {
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`,
        gap: 'var(--space-4)',
        alignItems: 'start',
        ...style,
      }}
    >
      {children}
    </ul>
  )
}
