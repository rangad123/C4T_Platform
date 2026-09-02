import Link from 'next/link'
import { formatDateTime } from '@/lib/admin/format'
import { notificationTypeLabel } from '@/lib/notifications/labels'

export interface ActivityItem {
  id: string
  type: string
  title: string
  body: string | null
  /** Already resolved to this portal by `resolveNotificationHref`. */
  href: string | null
  readAt: string | null
  createdAt: string
}

/**
 * The latest notifications, newest first, in a box that scrolls.
 *
 * ── Why this is not the bell
 *
 * The bell answers "what still needs me?" and so shows unread only, capped,
 * behind a click. This answers "what has been happening?", which is a
 * different question and the one a dashboard is for: read rows belong in it,
 * because a feed that deletes each entry as you look at it cannot be used to
 * catch up on a morning.
 *
 * Read state is kept visible rather than dropped — an unread row is marked
 * and weighted, a read row is plain. That is the "activity status" the list
 * is here to carry, and it is also why nothing here marks anything read:
 * scrolling past an entry is not the same as dealing with it, and the bell's
 * badge is the count this must not quietly change.
 *
 * ── Why it scrolls rather than grows
 *
 * A dashboard is a fixed thing you take in at a glance. Thirty rows rendered
 * inline would push every chart above it off the screen and make the page
 * length depend on how busy the week was. A fixed box with its own scrollbar
 * keeps the page stable and puts the whole history one gesture away.
 */
export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <p style={{ margin: 0, color: 'var(--text-muted)' }}>
        Nothing has happened yet. Assignments, bug reports, payments and messages all show up here.
      </p>
    )
  }

  return (
    <div
      style={{
        // The scrollport. `maxHeight` rather than `height` so a quiet account
        // shows three rows and a short box instead of three rows and a void.
        maxHeight: 360,
        overflowY: 'auto',
        margin: 'calc(var(--space-3) * -1)',
        padding: 'var(--space-3)',
      }}
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((item) => {
          const unread = item.readAt === null
          const inner = (
            <>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  fontWeight: unread ? 'var(--fw-semibold)' : 'var(--fw-regular)',
                  color: 'var(--text-primary)',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    flexShrink: 0,
                    // The dot's space is reserved on every row, unread or not,
                    // so the titles line up in a column instead of stepping in
                    // and out as the read ones are interleaved.
                    background: unread ? 'var(--accent-base)' : 'transparent',
                  }}
                />
                <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                  {notificationTypeLabel(item.type)}
                </span>
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {item.title}
                </span>
                {unread ? <span className="c4t-visually-hidden">(unread)</span> : null}
              </span>

              {item.body ? (
                <span
                  style={{
                    color: 'var(--text-secondary)',
                    fontSize: 'var(--type-body-sm-size)',
                    paddingLeft: 15,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.body}
                </span>
              ) : null}

              <span
                style={{
                  color: 'var(--text-muted)',
                  fontSize: 'var(--type-caption-size)',
                  paddingLeft: 15,
                }}
              >
                {formatDateTime(item.createdAt)}
              </span>
            </>
          )

          const rowStyle = {
            display: 'flex',
            flexDirection: 'column' as const,
            gap: 4,
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            background: unread ? 'var(--surface-sunken)' : 'transparent',
            textDecoration: 'none',
            color: 'inherit',
          }

          return (
            <li key={item.id} style={{ marginBottom: 'var(--space-2)' }}>
              {item.href ? (
                <Link
                  href={item.href}
                  prefetch={false}
                  className="c4t-activity-row"
                  style={rowStyle}
                >
                  {inner}
                </Link>
              ) : (
                <div style={rowStyle}>{inner}</div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
