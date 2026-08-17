import Link from 'next/link'
import { Icon } from '@/components/ds/core/Icon'
import type { IconName } from '@/components/ds/core/icon-registry'

export interface SectionTab {
  /** Value written to the `?section=` param. The first tab's value is the default. */
  value: string
  label: string
  icon?: IconName
  /** Optional count rendered as a pill — omit rather than passing 0 if a zero is uninteresting. */
  count?: number
  /**
   * Link to a real route instead of a `?section=` value on the current one.
   *
   * Use this when the sections are already separate pages with their own data
   * loading — a query param would then be a second, competing way to express
   * the same navigation. Use the `value` form when the sections are panels of
   * one page that share a single fetch.
   */
  href?: string
}

export interface SectionTabsProps {
  /** Path the tabs link to, without a query string. */
  basePath: string
  tabs: readonly SectionTab[]
  /** The resolved active tab value. */
  active: string
  /**
   * Query params to carry across tab switches — a page filter, say. `section`
   * is added automatically and must not be included here.
   */
  preserve?: Record<string, string | undefined>
}

/**
 * Sub-navigation inside one record or one module.
 *
 * ── Why the URL and not client state
 *
 * A tab is a place, not a widget setting: it should be linkable, survive a
 * refresh, and respond to the back button. Holding it in `useState` breaks all
 * three and forces `"use client"` onto the page, which for these pages means
 * every panel below it too. Driving it from `?section=` keeps the whole page a
 * Server Component and matches how filtering already works here — the URL
 * always describes what you are looking at.
 *
 * The cost is a server round trip per tab. That is the right trade for pages
 * whose panels each do their own data fetching: the alternative is fetching
 * every section's data on load to render tabs the user may never open.
 *
 * ── Why sections at all
 *
 * The project detail page had fifteen panels in one column. Nothing was
 * findable without scrolling past everything else, and the page paid to render
 * all of it every time. Sections make the page's structure legible before you
 * read any of it.
 */
export function SectionTabs({ basePath, tabs, active, preserve }: SectionTabsProps) {
  function hrefFor(value: string): string {
    const routed = tabs.find((t) => t.value === value)?.href
    if (routed) return routed

    const sp = new URLSearchParams()
    for (const [key, val] of Object.entries(preserve ?? {})) {
      if (val) sp.set(key, val)
    }
    // The first tab is the default view, so it gets the bare URL — one
    // canonical address for the page rather than two that render the same thing.
    if (value !== tabs[0]?.value) sp.set('section', value)
    const qs = sp.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }

  return (
    <nav
      aria-label="Sections"
      style={{
        display: 'flex',
        gap: 'var(--space-1)',
        flexWrap: 'wrap',
        borderBottom: '1px solid var(--border-default)',
        paddingBottom: 0,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.value === active
        return (
          <Link
            key={tab.value}
            href={hrefFor(tab.value)}
            aria-current={isActive ? 'page' : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-3) var(--space-4)',
              // The active tab sits on the container's border, so the two
              // read as one continuous edge rather than a floating pill.
              marginBottom: -1,
              borderBottom: `2px solid ${isActive ? 'var(--accent-base)' : 'transparent'}`,
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
              fontWeight: isActive ? 'var(--fw-semibold)' : 'var(--fw-medium)',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              transition: 'var(--transition-control)',
            }}
          >
            {tab.icon ? <Icon name={tab.icon} size={16} /> : null}
            <span>{tab.label}</span>
            {typeof tab.count === 'number' ? (
              <span
                style={{
                  minWidth: 20,
                  padding: '1px var(--space-2)',
                  borderRadius: 'var(--radius-full)',
                  background: isActive ? 'var(--accent-base)' : 'var(--surface-sunken)',
                  color: isActive ? 'var(--ink-50)' : 'var(--text-muted)',
                  fontSize: 'var(--type-caption-size)',
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'center',
                }}
              >
                {tab.count}
              </span>
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * Narrows an untrusted `?section=` value to one the caller actually renders.
 * Falls back to the first tab, so a stale bookmark or a hand-edited URL lands
 * on the default view instead of an empty page.
 */
export function resolveSection<T extends readonly SectionTab[]>(
  tabs: T,
  raw: string | undefined,
): T[number]['value'] {
  const match = tabs.find((t) => t.value === raw)
  return match?.value ?? tabs[0]!.value
}
