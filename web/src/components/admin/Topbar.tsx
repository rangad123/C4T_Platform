import Link from 'next/link'
import { Icon } from '@/components/ds/core/Icon'
import { logoutAction } from '@/lib/auth/actions'
import styles from './Topbar.module.css'

export interface Crumb {
  label: string
  href?: string
}

export interface TopbarProps {
  crumbs: readonly Crumb[]
}

/**
 * The admin topbar: breadcrumb on the left, sign-out on the right.
 *
 * Sign-out is a real `<form action={logoutAction}>` — the action clears the
 * bridged cookies and calls the API's `/v1/auth/logout` to destroy the
 * server-side session row, then redirects to /login. The button is a submit,
 * not a client handler, so there is no `"use client"` here.
 */
export function Topbar({ crumbs }: TopbarProps) {
  return (
    <header className={styles.topbar}>
      <nav aria-label="Breadcrumb" className={styles.breadcrumb}>
        <Link href="/app/admin" style={{ color: 'inherit', textDecoration: 'none' }}>
          Admin
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
        <form action={logoutAction} className={styles.logoutForm}>
          <button type="submit" className={styles.logoutButton}>
            <Icon name="log-out" size={16} />
            Sign out
          </button>
        </form>
      </div>
    </header>
  )
}
