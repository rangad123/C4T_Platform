'use client'

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import { Logo } from '../core/Logo'
import { Button } from '../core/Button'
import { Icon } from '../core/Icon'
import { IconButton } from '../core/IconButton'
import type { NavItem } from '@/content/nav'

export interface TopNavProps {
  items: NavItem[]
  /** Label of the current section — renders the link in ink. */
  active?: string
  sticky?: boolean
  /** Optional dark strip above the bar. */
  announcement?: ReactNode
  style?: CSSProperties
  className?: string
}

/**
 * The global header.
 *
 * PORT NOTES.
 *  - The prototype's `onNavigate(label)` callback is gone. Every link carries a
 *    real href from content/nav.ts and renders next/link, so navigation is
 *    prefetched and works without JavaScript.
 *  - `DEFAULT_NAV` is deliberately not ported: it is the design kit's generic
 *    demo IA and carries invented figures that contradict content.md. `items`
 *    is required.
 *  - The prototype opened mega menus on hover only, which is unreachable by
 *    keyboard and unusable on touch. The trigger is now a real <button> with
 *    aria-expanded and aria-controls; hover still opens it on pointer devices,
 *    click and Enter/Space toggle it, and Escape closes and restores focus.
 *
 * One of only five client components in the build — it holds open-menu and
 * drawer state.
 */
export function TopNav({
  items,
  active,
  sticky = true,
  announcement,
  style,
  className,
}: TopNavProps) {
  const [open, setOpen] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const headerRef = useRef<HTMLElement>(null)
  const menuIdBase = useId()

  const close = useCallback(() => setOpen(null), [])

  // Escape closes whichever surface is open and returns focus to the header.
  useEffect(() => {
    if (!open && !mobileOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(null)
      setMobileOpen(false)
      headerRef.current?.querySelector<HTMLElement>('[data-nav-trigger]')?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, mobileOpen])

  const openItem = open ? items.find((i) => i.label === open) : undefined

  return (
    <header
      ref={headerRef}
      className={className}
      onMouseLeave={close}
      style={{
        position: sticky ? 'sticky' : 'relative',
        top: 0,
        zIndex: 50,
        background: 'var(--surface-canvas)',
        borderBottom: '1px solid var(--border-subtle)',
        ...style,
      }}
    >
      {announcement ? (
        <div
          style={{
            background: 'var(--surface-inverse)',
            color: 'var(--text-inverse)',
            fontSize: 'var(--type-body-sm-size)',
            textAlign: 'center',
            padding: '9px var(--space-5)',
          }}
        >
          {announcement}
        </div>
      ) : null}

      <div
        style={{
          maxWidth: 'var(--container-wide)',
          margin: '0 auto',
          padding: '0 var(--container-gutter)',
          height: 72,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-8)',
        }}
      >
        {/* The supplied one-piece lockup. It contains the wordmark, so this
            replaces the previous mark-plus-live-text pairing rather than
            sitting beside it.

            SIZED BY OPTICAL WEIGHT, NOT BY THE NUMBER IT REPLACES. The old
            lockup was a 32px mark plus 24px live text and measured ~140px
            across. Setting this artwork to a matching 32–34px height rendered
            it 79px wide and visibly smaller, because the PNG carries its own
            padding above and below the glyphs — height here buys less type
            than it did on the bare mark. 50px brings it to ~116px, close to
            the old footprint, and still leaves 11px of clearance top and
            bottom inside the 72px bar. */}
        <Logo variant="horizontal" size={50} href="/" />

        <nav
          aria-label="Primary"
          className="c4t-nav-desktop"
          style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 'auto' }}
        >
          {items.map((item) => {
            const isOpen = open === item.label
            const isActive = active === item.label
            const shared: CSSProperties = {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-3) var(--space-4)',
              borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--type-body-sm-size)',
              fontWeight: 'var(--fw-medium)',
              color: isActive || isOpen ? 'var(--text-primary)' : 'var(--text-secondary)',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }

            if (!item.columns) {
              return (
                <Link
                  key={item.label}
                  href={item.href ?? '/'}
                  data-nav-trigger
                  className="c4t-navlink"
                  onMouseEnter={close}
                  style={shared}
                >
                  {item.label}
                </Link>
              )
            }

            return (
              <button
                key={item.label}
                type="button"
                data-nav-trigger
                className="c4t-navlink"
                aria-expanded={isOpen}
                aria-controls={`${menuIdBase}-${item.label.replace(/\s+/g, '-')}`}
                onMouseEnter={() => setOpen(item.label)}
                onClick={() => setOpen(isOpen ? null : item.label)}
                style={shared}
              >
                {item.label}
                <Icon
                  name="chevron-down"
                  size={14}
                  style={{
                    opacity: 0.6,
                    transform: isOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform var(--duration-fast) var(--ease-standard)',
                  }}
                />
              </button>
            )
          })}
        </nav>

        <div className="c4t-nav-desktop" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button variant="ghost" size="sm" href="/app">
            Sign in
          </Button>
          <Button variant="primary" size="sm" href="/contact">
            Book a demo
          </Button>
        </div>

        <span className="c4t-nav-mobile" style={{ marginLeft: 'auto' }}>
          <IconButton
            icon={mobileOpen ? 'x' : 'menu'}
            label={mobileOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMobileOpen((v) => !v)}
          />
        </span>
      </div>

      {openItem?.columns ? (
        <div
          id={`${menuIdBase}-${openItem.label.replace(/\s+/g, '-')}`}
          onMouseEnter={() => setOpen(openItem.label)}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            background: 'var(--surface-canvas)',
            borderTop: '1px solid var(--border-subtle)',
            borderBottom: '1px solid var(--border-default)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <div
            style={{
              maxWidth: 'var(--container-wide)',
              margin: '0 auto',
              padding: '28px var(--container-gutter) var(--space-8)',
              display: 'grid',
              gridTemplateColumns: `repeat(${openItem.columns.length}, minmax(0,1fr))${
                openItem.feature ? ' 320px' : ''
              }`,
              gap: 'var(--space-8)',
            }}
          >
            {openItem.columns.map((col) => (
              <div key={col.title}>
                <div
                  className="c4t-eyebrow"
                  style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-4)' }}
                >
                  {col.title}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {col.links.map((l) => (
                    <Link
                      key={l.label}
                      href={l.href}
                      className="c4t-megalink"
                      onClick={close}
                      style={{
                        display: 'flex',
                        gap: 'var(--space-4)',
                        padding: '10px var(--space-4)',
                        margin: '0 calc(var(--space-4) * -1)',
                        borderRadius: 'var(--radius-sm)',
                        textDecoration: 'none',
                        transition: 'var(--transition-control)',
                      }}
                    >
                      <Icon
                        name={l.icon}
                        size={18}
                        style={{ color: 'var(--accent-base)', marginTop: 2 }}
                      />
                      <span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 'var(--type-body-sm-size)',
                            fontWeight: 'var(--fw-medium)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          {l.label}
                        </span>
                        {l.desc ? (
                          <span
                            style={{
                              display: 'block',
                              fontSize: 'var(--type-caption-size)',
                              color: 'var(--text-muted)',
                              marginTop: 2,
                            }}
                          >
                            {l.desc}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}

            {openItem.feature ? (
              <div
                style={{
                  background: 'var(--surface-sunken)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-card)',
                  padding: 'var(--space-6)',
                }}
              >
                {openItem.feature.badge ? (
                  <span
                    style={{
                      display: 'inline-flex',
                      height: 22,
                      alignItems: 'center',
                      padding: '0 var(--space-3)',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--surface-brand-subtle)',
                      color: 'var(--text-brand)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      fontWeight: 'var(--fw-semibold)',
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {openItem.feature.badge}
                  </span>
                ) : null}
                <div
                  style={{
                    fontSize: 'var(--type-heading-sm-size)',
                    fontWeight: 'var(--fw-semibold)',
                    marginTop: 'var(--space-4)',
                    letterSpacing: '-0.1px',
                  }}
                >
                  {openItem.feature.title}
                </div>
                <p
                  style={{
                    fontSize: 'var(--type-body-sm-size)',
                    color: 'var(--text-secondary)',
                    marginTop: 6,
                  }}
                >
                  {openItem.feature.desc}
                </p>
                <Link
                  href={openItem.feature.href}
                  onClick={close}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    marginTop: 14,
                    fontSize: 'var(--type-body-sm-size)',
                    fontWeight: 'var(--fw-medium)',
                    color: 'var(--text-brand)',
                    textDecoration: 'none',
                  }}
                >
                  {openItem.feature.cta} <Icon name="arrow-right" size={15} />
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {mobileOpen ? (
        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            padding: 'var(--space-4) var(--container-gutter) var(--space-7)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            maxHeight: '70vh',
            overflowY: 'auto',
          }}
        >
          {items.map((item) => (
            <div key={item.label}>
              <Link
                href={item.href ?? '/'}
                onClick={() => setMobileOpen(false)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '13px 0',
                  borderBottom: '1px solid var(--border-subtle)',
                  fontSize: 'var(--type-body-md-size)',
                  fontWeight: 'var(--fw-medium)',
                  color: 'var(--text-primary)',
                  textDecoration: 'none',
                }}
              >
                {item.label}
              </Link>
              {/* The prototype's drawer stopped at top-level labels, leaving the
                  33 detail pages unreachable on mobile. The children are listed
                  inline instead. */}
              {item.columns ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    padding: 'var(--space-3) 0 var(--space-4) var(--space-4)',
                  }}
                >
                  {item.columns
                    .flatMap((c) => c.links)
                    .map((l) => (
                      <Link
                        key={l.href}
                        href={l.href}
                        onClick={() => setMobileOpen(false)}
                        style={{
                          padding: '9px 0',
                          fontSize: 'var(--type-body-sm-size)',
                          color: 'var(--text-secondary)',
                          textDecoration: 'none',
                        }}
                      >
                        {l.label}
                      </Link>
                    ))}
                </div>
              ) : null}
            </div>
          ))}

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
              marginTop: 'var(--space-5)',
            }}
          >
            <Button variant="primary" fullWidth href="/contact">
              Book a demo
            </Button>
            <Button variant="secondary" fullWidth href="/app">
              Sign in
            </Button>
          </div>
        </div>
      ) : null}
    </header>
  )
}
