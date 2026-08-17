import type { ReactNode } from 'react'
import { Icon } from '@/components/ds/core/Icon'
import type { IconName } from '@/components/ds/core/icon-registry'

export interface EmptyStateProps {
  /** Lucide icon name. */
  icon?: IconName
  /** Headline — short, sentence case. */
  title: string
  /** Supporting copy. */
  description?: string
  /** Optional CTA — usually a Button or Link. */
  action?: ReactNode
  /**
   * `block` (default) — the centred panel with a glyph and generous padding.
   * Right for a genuinely empty collection, where the absence is an
   * onboarding moment worth explaining.
   *
   * `inline` — one quiet line. Right when a FILTER matched nothing: the user
   * knows why the list is empty because they just narrowed it, and a
   * full-height panel between the filter bar and the pagination overstates a
   * non-event. It also keeps the filter controls close to the result, so
   * widening the search is one glance away rather than one scroll away.
   */
  variant?: 'block' | 'inline'
}

/**
 * The empty-list primitive. Used both for "no leads yet" and for "your
 * filter returned nothing" — see `variant` for why those two want different
 * shapes.
 *
 * The point of either is to make the absence feel intentional, not like the
 * page failed to load.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'block',
}: EmptyStateProps) {
  if (variant === 'inline') {
    return (
      <div
        role="status"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-4) var(--space-5)',
          background: 'var(--surface-canvas)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-card)',
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-sm-size)',
        }}
      >
        {icon ? (
          <Icon name={icon} size={16} style={{ color: 'var(--text-muted)', flex: 'none' }} />
        ) : null}
        <span style={{ color: 'var(--text-primary)' }}>{title}</span>
        {description ? <span>{description}</span> : null}
        {action ? <span style={{ marginLeft: 'auto' }}>{action}</span> : null}
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-12) var(--space-7)',
        textAlign: 'center',
        background: 'var(--surface-canvas)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      {icon ? <Icon name={icon} size={28} style={{ color: 'var(--text-muted)' }} /> : null}
      <h2 className="c4t-heading-sm" style={{ margin: 0 }}>
        {title}
      </h2>
      {description ? (
        <p
          style={{
            margin: 0,
            maxWidth: 420,
            color: 'var(--text-secondary)',
            fontSize: 'var(--type-body-sm-size)',
            lineHeight: 1.5,
          }}
        >
          {description}
        </p>
      ) : null}
      {action ? <div style={{ marginTop: 'var(--space-3)' }}>{action}</div> : null}
    </div>
  )
}
