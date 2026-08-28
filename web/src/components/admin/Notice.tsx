'use client'

import { useState } from 'react'
import { IconButton } from '@/components/ds/core/IconButton'

export type NoticeTone = 'success' | 'warning' | 'error' | 'info'

export interface NoticeCopy {
  tone: NoticeTone
  message: string
}

export interface NoticeProps {
  /** The code from the URL — `?notice=saved`, `?error=forbidden`. */
  code: string | undefined
  /** This page's code→copy map. An unknown code renders nothing. */
  notices: Readonly<Record<string, NoticeCopy>>
  /**
   * Which query parameter carried the code. Dismissing strips it, so it has
   * to know the name. Defaults to `notice`.
   */
  param?: string
}

const TONES: Record<NoticeTone, { background: string; color: string }> = {
  success: { background: 'var(--status-success-bg)', color: 'var(--status-success-fg)' },
  warning: { background: 'var(--status-warning-bg)', color: 'var(--status-warning-fg)' },
  error: { background: 'var(--status-error-bg)', color: 'var(--status-error-fg)' },
  info: { background: 'var(--status-info-bg)', color: 'var(--status-info-fg)' },
}

/**
 * The result of the last action, read from the URL.
 *
 * ── WHY THE URL AND NOT A FLOATING TOAST
 *
 * Server Actions here redirect with a result code (`?notice=saved`). That
 * survives the redirect and needs no shared client state, which a toast
 * provider would — mounted at the layout root and threaded through every
 * action that wants to say anything. It also degrades correctly: the message
 * is in the server-rendered HTML, so it is present on first paint rather than
 * being announced into a live region only after hydration.
 *
 * Four near-identical copies of this had accumulated — the tester project
 * workspace, the customer organisation page, the admin organisation page and
 * tester settings — differing in corner radius, whether they drew a border,
 * and whether the copy field was called `message` or `text`. One component
 * ends that drift.
 *
 * ── WHY IT IS A CLIENT COMPONENT
 *
 * Only so it can be dismissed. Its own `useState` is what hides it; the
 * earlier sketch had a server-rendered banner and a client button that called
 * `element.remove()`, which tears a node out from under React and invites a
 * reconciliation crash later. Owning the state here is both simpler and safe.
 * The URL is rewritten with `history.replaceState` rather than `router.replace`
 * so dismissing costs no round trip and Back does not walk the user through
 * notices they have already closed.
 *
 * `role` follows tone rather than being hardcoded: `alert` interrupts a
 * screen-reader user, which is right for a failure and rude for a confirmation.
 */
export function Notice({ code, notices, param = 'notice' }: NoticeProps) {
  const [dismissed, setDismissed] = useState(false)

  const notice = code ? notices[code] : undefined
  if (!notice || dismissed) return null

  return (
    <div
      role={notice.tone === 'error' || notice.tone === 'warning' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-4)',
        margin: 0,
        padding: 'var(--space-4) var(--space-5)',
        borderRadius: 'var(--radius-card)',
        border: '1px solid var(--border-default)',
        fontSize: 'var(--type-body-sm-size)',
        lineHeight: 1.5,
        ...TONES[notice.tone],
      }}
    >
      <p style={{ margin: 0, flex: 1 }}>{notice.message}</p>
      <IconButton
        icon="x"
        label="Dismiss this message"
        size="sm"
        onClick={() => {
          setDismissed(true)
          const url = new URL(window.location.href)
          url.searchParams.delete(param)
          window.history.replaceState(null, '', url.toString())
        }}
        style={{ flex: 'none', color: 'inherit', marginTop: -2 }}
      />
    </div>
  )
}
