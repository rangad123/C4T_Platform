'use client'

import { useId, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
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
  /**
   * Permission code the destination requires. Missing = no permission gate.
   *
   * Filtered by the LAYOUT, not here: only a Server Component knows the
   * signed-in user, and deciding it there keeps the whole permission set off
   * the wire. A link that survives to this component is one the reader may
   * open.
   */
  permission?: string
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
  const searchParams = useSearchParams()

  /**
   * Which query keys tell two links on the SAME path apart.
   *
   * The profile's sections are tabs on one page, so their nav entries differ
   * only by `?section=`. `usePathname` drops the query, so without this every
   * one of them would light up at once — and the bare "Your profile" link
   * would stay lit while a section was open, since its path matches too.
   *
   * Collected from the links themselves rather than hardcoded, so any future
   * group of query-distinguished entries works the same way.
   */
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
      title={collapsed ? 'Expand navigation' : undefined}
      /*
        Collapsed, the entire rail is one control: any click reopens it,
        including one on a section icon.

        ── WHY CAPTURE, AND WHY BOTH CALLS

        `onClickCapture` runs on the way DOWN, before the event reaches the
        link it started on. `stopPropagation` there means the anchor's own
        handler never fires, which is what actually stops `next/link` from
        navigating -- its router call is a click handler like any other, and
        by the bubble phase it has already run. `preventDefault` separately
        cancels the browser's own follow of the `href`, which is a different
        mechanism and needs cancelling too.

        So a collapsed icon is a picture of where you would go, not a way to
        go there. Expanding first costs one extra click and removes the
        guesswork of navigating by a 20px glyph with no label beside it.

        ── ONLY WHEN IT IS ACTUALLY A RAIL

        `collapsed` is a stored preference, not a description of the layout.
        Below 900px the stylesheet ignores it and lays the sidebar out full
        width as a header, so a reader whose saved preference is "collapsed"
        would arrive on a phone to a nav where every tap -- including the
        menu button -- did nothing but toggle an invisible setting.
        Measuring the element at click time settles it without guessing a
        viewport during render: a rail is 64px, the mobile header is the
        width of the screen, and nothing sits between them.
      */
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
        {/* `href={null}` makes Logo render a plain <span>. Logo links to "/"
            by default, and an anchor inside this anchor is invalid HTML — it
            threw a hydration error and made the whole lockup unclickable. The
            wrapping Link owns the destination; Logo just draws the mark. */}
        <Link
          href={homeHref}
          className={styles.brand}
          aria-label={`Crowd4Test ${portalLabel.toLowerCase()} home`}
        >
          <Logo size={28} wordmarkSize={14} withWordmark={!collapsed} href={null} />
        </Link>

        {/*
          Only while expanded. Collapsed, the rail is narrow enough that a
          second control beside the mark crowds it, and the rail's own click
          handler above already reopens it — so the button would be a second
          way to do the one thing the whole surface already does.
        */}
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
                const [linkPath = link.href, linkQuery] = link.href.split('?')
                const linkParams = new URLSearchParams(linkQuery ?? '')

                const pathMatches =
                  pathname === linkPath ||
                  (linkPath !== homeHref && pathname.startsWith(`${linkPath}/`))

                // Every parameter the link names must match the current URL.
                const queryMatches = [...linkParams.entries()].every(
                  ([key, value]) => searchParams.get(key) === value,
                )

                /**
                 * A link carrying no query of its own is the group's landing
                 * entry. It stays lit only while none of its siblings' keys
                 * are set — otherwise opening a section would highlight both
                 * that section and the entry above it.
                 */
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
