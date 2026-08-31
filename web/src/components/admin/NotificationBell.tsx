'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/ds/core/Icon'
import { formatDateTime } from '@/lib/admin/format'

interface NotificationItem {
  id: string
  type: string
  title: string
  body: string | null
  href: string | null
  readAt: string | null
  createdAt: string
}

/**
 * The bell, its unread count, and the panel behind it.
 *
 * ── Why the initial count is a prop
 *
 * The badge is the part everyone sees, on every page. Fetching it from the
 * client would mean every page load flashing an empty bell and then
 * populating it. The Topbar is a Server Component, so it already knows the
 * count when the page renders and passes it in; the list itself is only
 * fetched when someone actually opens the panel.
 *
 * ── Why the count is then held in state
 *
 * Reading a notification has to move the badge immediately. `router.refresh()`
 * would eventually re-render the Topbar with a new count, but "eventually" is
 * a whole round trip, and the click that caused it usually navigates away
 * anyway. So the count is owned here once mounted, and the refresh is fired
 * alongside for anything else on the page that cares.
 */
export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(initialUnread)
  const [items, setItems] = useState<NotificationItem[] | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  /**
   * The server's count wins whenever the page re-renders — a notification
   * that arrived while this tab sat idle would otherwise never appear.
   *
   * Adjusted during render rather than in an effect: React documents this
   * as the way to reset state from a changed prop, and it avoids the extra
   * render pass an effect would cost on every navigation.
   */
  const [seenInitial, setSeenInitial] = useState(initialUnread)
  if (seenInitial !== initialUnread) {
    setSeenInitial(initialUnread)
    setUnread(initialUnread)
  }

  // Loading is a fact about the data, not a separate thing to remember:
  // the panel is open and nothing has arrived yet.
  const loading = open && items === null

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/app/notifications')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { notifications: NotificationItem[]; unread: number }) => {
        if (cancelled) return
        setItems(data.notifications)
        setUnread(data.unread)
      })
      .catch(() => {
        // An empty list reads as "nothing to catch up on", which is the
        // right thing to show when the list cannot be fetched — the badge
        // still carries the count the server rendered.
        if (!cancelled) setItems([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function markRead(id: string): void {
    setItems((prev) =>
      prev ? prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) : prev,
    )
    setUnread((n) => Math.max(0, n - 1))
    void fetch('/app/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
      .then(() => router.refresh())
      .catch(() => {
        // The badge is a convenience, not a record. If the write failed the
        // next server render puts the true count back.
      })
  }

  function markAllRead(): void {
    setItems((prev) =>
      prev ? prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) : prev,
    )
    setUnread(0)
    void fetch('/app/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
      .then(() => router.refresh())
      .catch(() => {
        // Same as marking one read: the badge is a convenience, and the next
        // server render restores the true count if the write did not land.
        router.refresh()
      })
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: 'var(--radius-control)',
          // Chromeless, like the Sign out control it sits beside. A boxed
          // icon read as a separate widget rather than part of the bar.
          border: 0,
          background: 'transparent',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
        }}
      >
        <Icon name="bell" size={18} />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              // Overlapping the glyph's top-right, not orbiting it. With the
              // button's border gone there is no box edge to sit outside of,
              // so the badge hugs the bell itself.
              top: 2,
              right: 2,
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              borderRadius: 999,
              background: 'var(--accent-strong, var(--teal-500, #0b7a6e))',
              color: '#fff',
              fontSize: 10,
              fontWeight: 'var(--fw-semibold)',
              lineHeight: '16px',
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            zIndex: 40,
            width: 360,
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 420,
            overflowY: 'auto',
            padding: 'var(--space-3)',
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-card)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              padding: 'var(--space-2) var(--space-3)',
            }}
          >
            <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
              Notifications
            </span>
            {unread > 0 ? (
              <button
                type="button"
                onClick={markAllRead}
                style={{
                  border: 0,
                  background: 'none',
                  padding: 0,
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--type-body-sm-size)',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Mark all read
              </button>
            ) : null}
          </div>

          {loading && items === null ? (
            <p style={{ margin: 0, padding: 'var(--space-4)', color: 'var(--text-muted)' }}>
              Loading…
            </p>
          ) : !items || items.length === 0 ? (
            <p style={{ margin: 0, padding: 'var(--space-4)', color: 'var(--text-muted)' }}>
              Nothing to catch up on.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {items.map((n) => {
                const unreadRow = n.readAt === null
                const inner = (
                  <>
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        fontWeight: unreadRow ? 'var(--fw-semibold)' : 'var(--fw-regular)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {unreadRow ? (
                        <span
                          aria-hidden="true"
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 999,
                            background: 'var(--teal-500, #0b7a6e)',
                            flexShrink: 0,
                          }}
                        />
                      ) : null}
                      {n.title}
                    </span>
                    {n.body ? (
                      <span
                        style={{
                          color: 'var(--text-secondary)',
                          fontSize: 'var(--type-body-sm-size)',
                        }}
                      >
                        {n.body}
                      </span>
                    ) : null}
                    <span
                      style={{ color: 'var(--text-muted)', fontSize: 'var(--type-caption-size)' }}
                    >
                      {formatDateTime(n.createdAt)}
                    </span>
                  </>
                )

                const rowStyle = {
                  display: 'flex',
                  flexDirection: 'column' as const,
                  gap: 4,
                  width: '100%',
                  padding: 'var(--space-3)',
                  borderRadius: 'var(--radius-sm)',
                  background: unreadRow ? 'var(--surface-sunken)' : 'transparent',
                  textAlign: 'left' as const,
                  textDecoration: 'none',
                  border: 0,
                  cursor: 'pointer',
                }

                return (
                  <li key={n.id} style={{ marginBottom: 4 }}>
                    {n.href ? (
                      // A link, so it opens in a new tab on middle-click like
                      // any other. Reading is marked on the way out.
                      <a href={n.href} onClick={() => markRead(n.id)} style={rowStyle}>
                        {inner}
                      </a>
                    ) : (
                      <button type="button" onClick={() => markRead(n.id)} style={rowStyle}>
                        {inner}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
