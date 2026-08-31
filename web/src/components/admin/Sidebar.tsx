'use client'

import { useId, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Logo } from '@/components/ds/core/Logo'
import { Icon } from '@/components/ds/core/Icon'
import type { IconName } from '@/components/ds/core/icon-registry'
import type { Role } from '@/lib/api/types'
import { Avatar } from './Avatar'
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
  /** Display name of the signed-in user. */
  userName: string
  /**
   * The signed-in user's profile picture, if they have set one. Null falls
   * back to their initials, which `Avatar` draws — so the row keeps the same
   * shape whether or not a picture exists.
   */
  avatarFileId?: string | null
  /** Role of the signed-in user — used for the role chip and section gating. */
  role: Role
  sections: readonly SidebarSection[]
  /** The portal's own home route. Default `/app/admin`. */
  homeHref?: string
  /**
   * Where the user block links to. Defaults to `<homeHref>/profile`, which is
   * where all three portals keep it.
   */
  profileHref?: string
  /** Shown in the brand-row and section `aria-label`s. Default `'Admin'`. */
  portalLabel?: string
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
 * Two independent reasons.
 *
 * 1. The collapse toggle. This component lives in the admin *layout*, which
 *    Next does not re-mount on client-side navigation, so the open/closed
 *    state survives moving between pages for free — no context, no URL
 *    parameter, no cookie round trip. `localStorage` then carries it across
 *    full reloads and sessions.
 *
 * 2. The active-link highlight. This ALSO has to live here rather than be
 *    passed down from the layout as a prop, and for the same underlying
 *    reason: a layout does not re-render on a client-side navigation within
 *    its own segment. A server-computed `pathname` prop would be correct on
 *    the page that first mounted this layout and then silently stale on
 *    every subsequent sidebar click — every page would look like "Dashboard"
 *    is still open, because the layout never ran again to recompute it.
 *    `usePathname()` is the client hook built exactly for this: it re-reads
 *    on every navigation regardless of which layout does or doesn't re-run.
 *
 * The collapse state is read in an effect rather than during render on
 * purpose: reading `localStorage` while rendering would produce different
 * markup on the server (where it does not exist) than on the client, which
 * is a hydration mismatch. So the first paint is always expanded, and a
 * stored preference applies immediately after. `suppressHydrationWarning` is
 * deliberately NOT used here — there is no mismatch to suppress, because the
 * first render genuinely is the default on both sides.
 */
export function Sidebar({
  userName,
  avatarFileId = null,
  role,
  sections,
  homeHref = '/app/admin',
  profileHref,
  portalLabel = 'Admin',
}: SidebarProps) {
  const profileTarget = profileHref ?? `${homeHref}/profile`
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const pathname = usePathname()

  /**
   * The mobile menu, open/closed.
   *
   * Deliberately NOT the persisted `collapsed` preference. That one belongs to
   * the desktop rail and survives reloads; a nav menu that reopened itself on
   * every page load would be wrong. Plain state, always closed to begin with,
   * and below 900px CSS is what makes it the control that matters.
   */
  const [mobileOpen, setMobileOpen] = useState(false)
  const navId = useId()

  /**
   * Close on navigation. This layout does not re-mount between pages, so
   * without this the menu would stay open over the page just navigated to.
   *
   * Adjusted during render rather than in an effect. React re-runs the
   * component immediately without committing the first pass, so there is no
   * flash of the open menu and no cascading render — the pattern React's own
   * docs give for "reset state when a value changes". An effect calling
   * `setMobileOpen` would paint the open menu first and then close it, and
   * `onClick` on each link would miss browser back/forward.
   */
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
    >
      <div className={styles.brandRow}>
        {/* `href={null}` makes Logo render a plain <span>. Logo links to "/"
            by default, and an anchor inside this anchor is invalid HTML — it
            threw a hydration error and made the whole lockup unclickable. The
            wrapping Link owns the destination; Logo just draws the mark. */}
        <Link href={homeHref} aria-label={`Crowd4Test ${portalLabel.toLowerCase()} home`}>
          <Logo size={28} wordmarkSize={14} withWordmark={!collapsed} href={null} />
        </Link>

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

        {/*
          The mobile control. Rendered always and shown by CSS below 900px,
          rather than being conditional on a measured viewport — that would
          need a media-query hook, and its first render on the server would
          have to guess a width it cannot know.

          `aria-controls` points at the nav it reveals, and the nav follows
          immediately in DOM order, so tab order and screen-reader order both
          match what the button does.
        */}
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

      {/* Layout is in the stylesheet, not inline: the mobile rules need to
          hide this, and an inline `display` would outrank them. */}
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
                const isActive =
                  !link.disabled &&
                  (pathname === link.href ||
                    (link.href !== homeHref && pathname.startsWith(`${link.href}/`)))

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

      {/*
        Both the icon and the name are always rendered; CSS picks one.

        This used to branch on `collapsed`, which meant the name simply was not
        in the DOM whenever the rail was collapsed. That is fine on desktop,
        where the icon is the point — but the mobile menu reuses this markup at
        full width, and CSS cannot restore text that was never rendered. A
        tester who had collapsed the rail on a laptop then got a nameless menu
        on their phone.
      */}
      <Link
        className={styles.user}
        href={profileTarget}
        aria-current={pathname === profileTarget ? 'page' : undefined}
        title={collapsed ? `${userName} — ${ROLE_LABEL[role]}` : undefined}
      >
        {/*
          The signed-in user's own face, next to their name. This replaced a
          generic user-check glyph, which said nothing the name did not
          already say. `Avatar` falls back to initials, so a user with no
          picture still gets a filled circle rather than a gap.
        */}
        <span className={styles.userAvatar}>
          <Avatar name={userName} fileId={avatarFileId} size="md" />
        </span>
        <div className={styles.userMeta}>
          <span className={styles.userName}>{userName}</span>
          <span className={styles.userRole}>{ROLE_LABEL[role]}</span>
        </div>
      </Link>
    </aside>
  )
}
