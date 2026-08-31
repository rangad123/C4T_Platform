'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Marks a notification read once the thing it points at is actually on
 * screen, then refreshes so the badge in the header drops immediately.
 *
 * ── Why a component and not a Server Action
 *
 * Opening an announcement is a GET. A Server Component render must not have
 * side effects — the same render runs on a prefetch, and marking something
 * read because a link was hovered is a bug the reader cannot undo. Doing it
 * from an effect ties the write to the page genuinely being displayed.
 *
 * ── Why it lives here rather than on the bell
 *
 * The bell already marks its own rows read on click, but that is only one of
 * two ways in: an announcement is just as often opened from the inbox list,
 * where no notification was clicked at all. Both paths land on the same page,
 * so putting it on the page covers both without either knowing about the
 * other.
 *
 * The write is fire-and-forget. If it fails the item stays unread, which is
 * the safe direction to fail in — the reader sees it again rather than losing
 * it silently.
 */
export function MarkReadOnView({ notificationId }: { notificationId: string | null }) {
  const router = useRouter()
  // Strict mode runs effects twice in development; the ref keeps that from
  // firing two writes for one view.
  const sent = useRef<string | null>(null)

  useEffect(() => {
    if (!notificationId || sent.current === notificationId) return
    sent.current = notificationId

    void fetch('/app/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: notificationId }),
    })
      .then((res) => {
        // Only refresh on success. A failed write with a refresh would redraw
        // the same unread state and look like the click did nothing.
        if (res.ok) router.refresh()
      })
      .catch(() => {
        // Left unread deliberately — see above.
      })
  }, [notificationId, router])

  return null
}
