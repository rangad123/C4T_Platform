import Link from 'next/link'
import { Icon } from '@/components/ds/core/Icon'
import { HrSignOutButton } from './HrSignOutButton'
import styles from '@/components/admin/Topbar.module.css'

export interface HrCrumb {
  label: string
  href?: string
}

export interface HrTopbarProps {
  crumbs: readonly HrCrumb[]
  root: { label: string; href: string }
}

/**
 * HRMS's own topbar — breadcrumb + sign-out, reusing the platform's
 * `Topbar.module.css` (plain classnames, no coupling). No notification bell:
 * the spec has no HRMS notifications module, so there is nothing for one to
 * show. `getUser()`/`serverFetchOrNull('notifications/unread-count')` from
 * the platform's `Topbar` are platform-session reads and would be wrong
 * here regardless.
 */
export function HrTopbar({ crumbs, root }: HrTopbarProps) {
  return (
    <header className={styles.topbar}>
      <nav aria-label="Breadcrumb" className={styles.breadcrumb}>
        <Link href={root.href} style={{ color: 'inherit', textDecoration: 'none' }}>
          {root.label}
        </Link>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1
          return (
            <span
              key={`${crumb.label}-${index}`}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <Icon name="chevron-right" size={14} style={{ color: 'var(--text-muted)' }} />
              {crumb.href && !isLast ? (
                <Link href={crumb.href} style={{ color: 'inherit', textDecoration: 'none' }}>
                  {crumb.label}
                </Link>
              ) : (
                <span className={isLast ? styles.crumbCurrent : undefined}>{crumb.label}</span>
              )}
            </span>
          )
        })}
      </nav>

      <div className={styles.actions}>
        <HrSignOutButton className={styles.logoutButton} />
      </div>
    </header>
  )
}
