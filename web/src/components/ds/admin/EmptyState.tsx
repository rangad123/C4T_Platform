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
}

/**
 * The empty-list primitive. Used both for "no leads yet" and for "your
 * filter returned nothing" — the latter passes a different description and
 * drops the CTA.
 *
 * Centred, generous padding, a single muted glyph. The point is to make the
 * absence feel intentional, not like the page failed to load.
 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
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
