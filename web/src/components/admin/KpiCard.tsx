import Link from 'next/link'
import { Icon } from '@/components/ds/core/Icon'
import type { IconName } from '@/components/ds/core/icon-registry'

export interface KpiCardProps {
  icon: IconName
  label: string
  value: string | number
  href: string
}

/**
 * A linked stat tile — a number that means something plus the filtered list
 * behind it. Shared by every portal's dashboard (admin, customer, ...) rather
 * than redefined per page.
 */
export function KpiCard({ icon, label, value, href }: KpiCardProps) {
  return (
    <Link
      href={href}
      className="c4t-card-hover"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        padding: 'var(--space-5)',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'var(--transition-surface)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Icon name={icon} size={16} style={{ color: 'var(--text-muted)' }} />
        <span
          className="c4t-eyebrow"
          style={{
            color: 'var(--text-muted)',
            fontSize: 'var(--type-caption-size)',
            textWrap: 'balance',
          }}
        >
          {label}
        </span>
      </span>
      <span
        style={{
          fontSize: 28,
          fontWeight: 'var(--fw-semibold)',
          letterSpacing: '-0.02em',
          color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </Link>
  )
}
