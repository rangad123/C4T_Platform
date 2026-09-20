import type { ReactNode } from 'react'

export interface DescriptionItem {
  label: string
  value: ReactNode
  /** Make this row span the full width — for long text like a description. */
  wide?: boolean
}

/**
 * Field/value pairs on a detail page.
 *
 * A real `<dl>` rather than a two-column grid of divs: the label/value
 * relationship is the whole point of the component, and `dt`/`dd` is the one
 * markup that carries it to a screen reader without extra ARIA.
 *
 * A null or empty value renders an em dash rather than collapsing the row, so
 * the shape of the record stays constant between two entities where one has
 * more fields filled in than the other.
 */
export function DescriptionList({ items }: { items: readonly DescriptionItem[] }) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 'var(--space-5) var(--space-6)',
        margin: 0,
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
            ...(item.wide ? { gridColumn: '1 / -1' } : {}),
          }}
        >
          {/*
            `--text-secondary`, not `--text-muted`. These are small, uppercase
            monospace labels, so the 4.5:1 text threshold applies, and muted ink
            only just meets it on the page floor (4.50:1) and misses it on the
            sunken surface many panels sit on (4.10:1). A field label that is
            hard to read is the one job it has. The value keeps the primary
            ink, so label and value still read as two different things.
          */}
          <dt className="c4t-eyebrow" style={{ color: 'var(--text-secondary)', margin: 0 }}>
            {item.label}
          </dt>
          <dd
            style={{
              margin: 0,
              color: 'var(--text-primary)',
              fontSize: 'var(--type-body-md-size)',
              lineHeight: 1.55,
              wordBreak: 'break-word',
            }}
          >
            {item.value === null || item.value === undefined || item.value === '' ? (
              <span style={{ color: 'var(--text-muted)' }}>—</span>
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
