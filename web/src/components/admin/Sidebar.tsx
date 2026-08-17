'use client'

import { useSyncExternalStore } from 'react'
import Link from 'next/link'
import { Logo } from '@/components/ds/core/Logo'
import { Icon } from '@/components/ds/core/Icon'
import type { IconName } from '@/components/ds/core/icon-registry'
import type { Role } from '@/lib/api/types'
import styles from './Sidebar.module.css'

export interface SidebarLink {
  href: string
  label: string
  icon: IconName
  /** When true, the link is rendered but disabled — feature not yet built. */
  disabled?: boolean
  /** Restrict to specific roles. Missing = available to anyone on the admin side. */
  roles?: readonly Role[]
}

export interface SidebarSection {
  /** Optional mono-uppercase label rendered above the group. */
  label?: string
  links: readonly SidebarLink[]
}

export interface SidebarProps {
  /** Pathname of the current page, used to derive the active link. */
  pathname: string
  /** Display name of the signed-in user. */
  userName: string
  /** Role of the signed-in user — used for the role chip and section gating. */
  role: Role
  sections: readonly SidebarSection[]
}

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrator',
  SUB_ADMIN: 'Sub-admin',
  CUSTOMER: 'Customer',
  TESTER: 'Tester',
  USER: 'User',
}

const STORAGE_KEY = 'c4t.sidebar.collapsed'
/** Same-tab change signal. The native `storage` event only fires in OTHER tabs. */
const CHANGE_EVENT = 'c4t:sidebar-collapsed'

/**
 * `localStorage` as an external store.
 *
 * Read through `useSyncExternalStore` rather than an effect: an effect that
 * calls `setState` on mount causes a cascading re-render, and reading storage
 * during render would desync server and client markup. This hook is the
 * primitive built for exactly this shape — `getServerSnapshot` supplies the
 * SSR value, so there is no hydration mismatch and no extra render.
 *
 * Subscribing to both the native `storage` event and our own means the rail
 * also stays in step across browser tabs.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

function getSnapshot(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // Private mode or a blocked store — behave as expanded.
    return false
  }
}

/** The server has no storage, so it always renders the expanded rail. */
function getServerSnapshot(): boolean {
  return false
}

function setCollapsedPreference(next: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
  } catch {
    // Preference will not persist; the toggle still works for this page view.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/**
 * The admin sidebar.
 *
 * Sticky, full-height, single column. Sections are grouped by area so the
 * list stays scannable when it grows. The link's `href` is compared against
 * the current pathname — a leading-segment match for nested routes (so
 * `/app/admin/leads/123` highlights the `/app/admin/leads` link).
 *
 * Disabled links (`disabled: true`) render with the muted style and no
 * pointer events; they exist so the shape of the eventual sidebar is visible
 * while the other admin areas are still being built.
 *
 * ── Why this is a client component
 *
 * Only for the collapse toggle. It lives in the admin *layout*, which Next
 * does not re-mount on client-side navigation, so the open/closed state
 * survives moving between pages for free — no context, no URL parameter, no
 * cookie round trip. `localStorage` then carries it across full reloads and
 * sessions.
 *
 * The state is read in an effect rather than during render on purpose: reading
 * `localStorage` while rendering would produce different markup on the server
 * (where it does not exist) than on the client, which is a hydration
 * mismatch. So the first paint is always expanded, and a stored preference
 * applies immediately after. `suppressHydrationWarning` is deliberately NOT
 * used here — there is no mismatch to suppress, because the first render
 * genuinely is the default on both sides.
 */
export function Sidebar({ pathname, userName, role, sections }: SidebarProps) {
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  return (
    <aside
      className={[styles.sidebar, collapsed ? styles.collapsed : null].filter(Boolean).join(' ')}
      aria-label="Admin navigation"
    >
      <div className={styles.brand}>
        {/* `href={null}` makes Logo render a plain <span>. Logo links to "/"
            by default, and an anchor inside this anchor is invalid HTML — it
            threw a hydration error and made the whole lockup unclickable. The
            wrapping Link owns the destination; Logo just draws the mark. */}
        <Link href="/app/admin" aria-label="Crowd4Test admin home">
          <Logo size={28} wordmarkSize={14} withWordmark={!collapsed} href={null} />
        </Link>
      </div>

      <div className={styles.toggleRow}>
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setCollapsedPreference(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
        </button>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        {sections.map((section, sectionIndex) => {
          const visibleLinks = section.links.filter(
            (link) => !link.roles || link.roles.includes(role),
          )
          if (visibleLinks.length === 0) return null

          return (
            <div key={section.label ?? `section-${sectionIndex}`} className={styles.section}>
              {section.label ? <span className={styles.sectionLabel}>{section.label}</span> : null}
              {visibleLinks.map((link) => {
                const isActive =
                  !link.disabled &&
                  (pathname === link.href ||
                    (link.href !== '/app/admin' && pathname.startsWith(`${link.href}/`)))

                const linkClass = [
                  styles.link,
                  isActive ? styles.linkActive : null,
                  link.disabled ? styles.linkDisabled : null,
                ]
                  .filter(Boolean)
                  .join(' ')

                // Collapsed, the label is hidden, so the only accessible name
                // left is the title/aria-label — without them the rail is a
                // column of unlabelled icons to a screen reader.
                const collapsedProps = collapsed
                  ? { title: link.label, 'aria-label': link.label }
                  : {}

                if (link.disabled) {
                  return (
                    <span
                      key={link.href}
                      className={linkClass}
                      aria-disabled="true"
                      title={collapsed ? `${link.label} — coming soon` : 'Coming soon'}
                    >
                      <Icon name={link.icon} size={18} className={styles.icon} />
                      <span className={styles.linkLabel}>{link.label}</span>
                    </span>
                  )
                }

                return (
                  <Link key={link.href} href={link.href} className={linkClass} {...collapsedProps}>
                    <Icon name={link.icon} size={18} className={styles.icon} />
                    <span className={styles.linkLabel}>{link.label}</span>
                  </Link>
                )
              })}
            </div>
          )
        })}
      </nav>

      <div className={styles.spacer} />

      <div className={styles.user} title={collapsed ? `${userName} — ${ROLE_LABEL[role]}` : undefined}>
        {collapsed ? (
          <Icon name="user-check" size={18} className={styles.icon} />
        ) : (
          <div className={styles.userMeta}>
            <span className={styles.userName}>{userName}</span>
            <span className={styles.userRole}>{ROLE_LABEL[role]}</span>
          </div>
        )}
      </div>
    </aside>
  )
}
