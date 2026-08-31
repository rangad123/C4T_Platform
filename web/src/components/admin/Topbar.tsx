import Link from 'next/link'
import { Icon } from '@/components/ds/core/Icon'
import { logoutAction } from '@/lib/auth/actions'
import { getUser } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { NotificationBell } from './NotificationBell'
import { Avatar } from './Avatar'
import styles from './Topbar.module.css'

export interface Crumb {
  label: string
  href?: string
}

export interface RootCrumb {
  label: string
  href: string
}

export interface TopbarProps {
  crumbs: readonly Crumb[]
  /** The portal's own home crumb. Default `{ label: 'Admin', href: '/app/admin' }`. */
  root?: RootCrumb
}

const DEFAULT_ROOT: RootCrumb = { label: 'Admin', href: '/app/admin' }

/**
 * The portal topbar: breadcrumb on the left, sign-out on the right.
 *
 * Sign-out is a real `<form action={logoutAction}>` — the action clears the
 * bridged cookies and calls the API's `/v1/auth/logout` to destroy the
 * server-side session row, then redirects to /login. The button is a submit,
 * not a client handler, so there is no `"use client"` here.
 */
export async function Topbar({ crumbs, root = DEFAULT_ROOT }: TopbarProps) {
  /**
   * The unread count is read here, on the server, so the badge is correct in
   * the first paint rather than appearing a moment later. Both reads are
   * optional: a topbar that cannot reach the API should still render its
   * breadcrumb and sign-out rather than take the page down with it.
   */
  const user = await getUser()
  const unread = user
    ? ((await serverFetchOrNull<{ unreadCount: number }>('notifications/unread-count'))
        ?.unreadCount ?? 0)
    : 0

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
        {user ? <NotificationBell initialUnread={unread} /> : null}
        {user ? (
          /* The avatar is a picture of who is signed in, not a control — the
             profile link lives in the sidebar, and duplicating it here would
             give the same destination two places to go wrong. */
          <Avatar
            name={[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
            fileId={user.avatarFileId ?? null}
            size="sm"
          />
        ) : null}
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
