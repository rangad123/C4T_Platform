import type { ReactNode } from 'react'

export interface PanelProps {
  /** Panel heading. Sentence case. */
  title?: string
  /** Optional one-line explanation under the heading. */
  description?: string
  /** Rendered top-right — usually a single action button. */
  actions?: ReactNode
  children: ReactNode
  /** Removes the inner padding, for panels that hold a full-bleed table. */
  flush?: boolean
}

/**
 * A bordered card on a detail page.
 *
 * Panels are the unit of composition for the admin detail pages: one panel per
 * concern (identity, status, members, danger zone), each with its own form and
 * its own submit. Splitting a detail page into several small forms instead of
 * one big one means a failed save only ever loses the fields in that panel, and
 * every submit maps to exactly one API call.
 *
 * 14px radius per the shape scale — panels, not cards.
 */
export function Panel({ title, description, actions, children, flush = false }: PanelProps) {
  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-panel)',
        background: 'var(--surface-raised)',
        overflow: 'hidden',
      }}
    >
      {title ? (
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            padding: 'var(--space-5) var(--space-6)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <h2
              style={{
                margin: 0,
                fontSize: 'var(--type-body-md-size)',
                fontWeight: 'var(--fw-semibold)',
                color: 'var(--text-primary)',
              }}
            >
              {title}
            </h2>
            {description ? (
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--type-body-sm-size)',
                  color: 'var(--text-secondary)',
                }}
              >
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div style={{ flexShrink: 0 }}>{actions}</div> : null}
        </header>
      ) : null}

      <div style={flush ? undefined : { padding: 'var(--space-6)' }}>{children}</div>
    </section>
  )
}
