'use client'

import { useId, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Logo } from '@/components/ds/core/Logo'
import { Icon } from '@/components/ds/core/Icon'
import type { IconName } from '@/components/ds/core/icon-registry'
import type { HrRole } from '@/lib/hrms/hr-types'
import { HrAvatar } from './HrAvatar'
import styles from '@/components/admin/Sidebar.module.css'

/**
 * HRMS's own sidebar. Structural copy of `components/admin/Sidebar.tsx` —
 * same collapse/mobile/active-link behaviour, same stylesheet (imported
 * directly; it is plain CSS Modules classnames with no logic tying it to the
 * platform's component) — with `HrRole` in place of the platform's `Role`.
 * Not reusable as a shared component: `Sidebar` hardcodes `Role`'s five
 * values and an `ROLE_LABEL` keyed by them, and `HrRole`'s three values
 * (ADMIN | ACCOUNT_MANAGER | EMPLOYEE) share none of them.
 */

export interface HrSidebarLink {
  href: string
  label: string
  icon: IconName
  disabled?: boolean
  roles?: readonly HrRole[]
}

export interface HrSidebarSection {
  label?: string
  links: readonly HrSidebarLink[]
}

export interface HrSidebarProps {
  userName: string
  avatarFileId?: string | null
  role: HrRole
  sections: readonly HrSidebarSection[]
  homeHref: string
  portalLabel: string
  /**
   * Where the bottom-left profile card links to. Defaults to `${homeHref}/profile`,
   * which is right for Admin and Employee — each owns a `/profile` page — but wrong
   * for CRM, which does not: CRM tier is a separate axis from `HrRole`, so "your
   * profile" there means the Admin or Employee profile page, not a fourth one.
   */
  profileHref?: string
}

const HR_ROLE_LABEL: Record<HrRole, string> = {
  ADMIN: 'HR administrator',
  ACCOUNT_MANAGER: 'Account manager',
  EMPLOYEE: 'Employee',
}

const STORAGE_KEY = 'c4t.hrms-sidebar.collapsed'
const CHANGE_EVENT = 'c4t:hrms-sidebar-collapsed'

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
    return false
  }
}

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
 * The path as the sidebar's own hrefs spell it.
 *
 * HRMS is served from its own hostname, and `hrmsRewrite` in `proxy.ts`
 * rewrites every request on it to `/hrms` + the path. Nav hrefs are written
 * without that prefix, because that is what the address bar shows — but
 * `usePathname()` does not agree with itself across the boundary: rendering
 * on the server it reports the rewritten route (`/hrms/admin`), and in the
 * browser it reports the address (`/admin`).
 *
 * Nothing matched server-side, so the sidebar shipped with no section
 * highlighted; the client then wanted to add the class and React refused,
 * since a hydration mismatch on an attribute is reported and left alone. The
 * result was navigation that never showed you where you were.
 *
 * Stripping the prefix makes both sides agree on the address-bar form, which
 * is the one the hrefs are written in. Under plain `localhost/hrms/...` in
 * development both sides say `/hrms/admin` and this still resolves to the
 * same `/admin`.
 */
function hrPathname(pathname: string): string {
  if (pathname === '/hrms') return '/'
  return pathname.startsWith('/hrms/') ? pathname.slice('/hrms'.length) : pathname
}

export function HrSidebar({
  userName,
  avatarFileId = null,
  role,
  sections,
  homeHref,
  portalLabel,
  profileHref,
}: HrSidebarProps) {
  const profileTarget = profileHref ?? `${homeHref}/profile`
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const pathname = hrPathname(usePathname())
  const searchParams = useSearchParams()

  const qualifyingKeys = new Map<string, Set<string>>()
  for (const section of sections) {
    for (const link of section.links) {
      const [linkPath, linkQuery] = link.href.split('?')
      if (!linkQuery || !linkPath) continue
      const keys = qualifyingKeys.get(linkPath) ?? new Set<string>()
      for (const key of new URLSearchParams(linkQuery).keys()) keys.add(key)
      qualifyingKeys.set(linkPath, keys)
    }
  }

  const [mobileOpen, setMobileOpen] = useState(false)
  const navId = useId()

  const [lastPathname, setLastPathname] = useState(pathname)
  if (pathname !== lastPathname) {
    setLastPathname(pathname)
    setMobileOpen(false)
  }

  return (
    <aside
      className={[
        styles.sidebar,
        collapsed ? styles.collapsed : null,
        mobileOpen ? styles.sidebarMobileOpen : null,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={`${portalLabel} navigation`}
      title={collapsed ? 'Expand navigation' : undefined}
      onClickCapture={
        collapsed
          ? (event) => {
              if (event.currentTarget.getBoundingClientRect().width > 120) return
              event.preventDefault()
              event.stopPropagation()
              setCollapsedPreference(false)
            }
          : undefined
      }
    >
      <div className={styles.brandRow}>
        <Link
          href={homeHref}
          className={styles.brand}
          aria-label={`Crowd4Test ${portalLabel.toLowerCase()} home`}
        >
          <Logo size={28} wordmarkSize={14} withWordmark={!collapsed} href={null} />
        </Link>

        {!collapsed ? (
          <button
            type="button"
            className={styles.toggle}
            onClick={() => setCollapsedPreference(true)}
            aria-expanded
            aria-label="Collapse navigation"
            title="Collapse navigation"
          >
            <Icon name="panel-left" size={18} />
          </button>
        ) : null}

        <button
          type="button"
          className={styles.menuButton}
          onClick={() => setMobileOpen((open) => !open)}
          aria-expanded={mobileOpen}
          aria-controls={navId}
        >
          <Icon name={mobileOpen ? 'x' : 'menu'} size={18} />
          {mobileOpen ? 'Close' : 'Menu'}
        </button>
      </div>

      <nav id={navId} className={styles.nav}>
        {sections.map((section, sectionIndex) => {
          const visibleLinks = section.links.filter(
            (link) => !link.roles || link.roles.includes(role),
          )
          if (visibleLinks.length === 0) return null

          return (
            <div key={section.label ?? `section-${sectionIndex}`} className={styles.section}>
              {section.label ? <span className={styles.sectionLabel}>{section.label}</span> : null}
              {visibleLinks.map((link) => {
                const [linkPath = link.href, linkQuery] = link.href.split('?')
                const linkParams = new URLSearchParams(linkQuery ?? '')

                const pathMatches =
                  pathname === linkPath ||
                  (linkPath !== homeHref && pathname.startsWith(`${linkPath}/`))

                const queryMatches = [...linkParams.entries()].every(
                  ([key, value]) => searchParams.get(key) === value,
                )

                const siblingKeys = qualifyingKeys.get(linkPath)
                const isLandingEntry = linkParams.size === 0 && siblingKeys
                const landingMatches =
                  !isLandingEntry || ![...siblingKeys].some((key) => searchParams.get(key))

                const isActive = !link.disabled && pathMatches && queryMatches && landingMatches

                const linkClass = [
                  styles.link,
                  isActive ? styles.linkActive : null,
                  link.disabled ? styles.linkDisabled : null,
                ]
                  .filter(Boolean)
                  .join(' ')

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

      <Link
        className={styles.user}
        href={profileTarget}
        aria-current={pathname === profileTarget ? 'page' : undefined}
        title={collapsed ? `${userName} — ${HR_ROLE_LABEL[role]}` : undefined}
      >
        <span className={styles.userAvatar}>
          <HrAvatar name={userName} fileId={avatarFileId} size="md" />
        </span>
        <div className={styles.userMeta}>
          <span className={styles.userName}>{userName}</span>
          <span className={styles.userRole}>{HR_ROLE_LABEL[role]}</span>
        </div>
      </Link>
    </aside>
  )
}
