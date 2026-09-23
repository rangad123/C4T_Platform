import Link from 'next/link'
import { Icon } from '@/components/ds/core/Icon'
import styles from './HrAuthCard.module.css'

/** Enough tiles to cover any window size once the grid is rotated and overscanned. */
const WATERMARK_TILES = 48

/**
 * The centred card the unauthenticated HRMS screens sit in. Extracted when
 * forgot-password and reset-password were added rather than copying the
 * login screen's chrome a third time.
 */
export function HrAuthCard({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string
  subtitle?: string
  footer?: { href: string; label: string }
  children: React.ReactNode
}) {
  return (
    <div className={styles.page}>
      {/* Decorative — see the identical note on `login/page.tsx`'s watermark. */}
      <div className={styles.watermark} aria-hidden="true">
        {Array.from({ length: WATERMARK_TILES }, (_, i) => (
          <span key={i} className={styles.watermarkWord}>
            Crowd<span className={styles.watermarkAccent}>4</span>Test
          </span>
        ))}
      </div>
      <div className={styles.card}>
        <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
          {title}
        </h1>
        {subtitle ? (
          <p
            style={{
              margin: '0 0 var(--space-6)',
              fontSize: 'var(--type-body-sm-size)',
              color: 'var(--text-secondary)',
            }}
          >
            {subtitle}
          </p>
        ) : null}

        {children}

        {footer ? (
          <p
            style={{
              margin: 'var(--space-6) 0 0',
              fontSize: 'var(--type-body-sm-size)',
              textAlign: 'center',
            }}
          >
            <Link href={footer.href}>{footer.label}</Link>
          </p>
        ) : null}
      </div>
    </div>
  )
}

export function HrAuthNotice({
  tone,
  icon,
  children,
}: {
  tone: 'success' | 'error'
  icon: string
  children: React.ReactNode
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-3)',
        padding: 'var(--space-4) var(--space-5)',
        marginBottom: 'var(--space-6)',
        background: tone === 'error' ? 'var(--status-error-bg)' : 'var(--status-success-bg)',
        color: tone === 'error' ? 'var(--status-error-fg)' : 'var(--status-success-fg)',
        borderRadius: 'var(--radius-input)',
        fontSize: 'var(--type-body-sm-size)',
        lineHeight: 1.45,
      }}
    >
      <Icon name={icon} size={18} style={{ flex: 'none', marginTop: 2 }} />
      <span>{children}</span>
    </div>
  )
}
