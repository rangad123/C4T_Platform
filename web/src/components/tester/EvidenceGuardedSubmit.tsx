'use client'

import { useState, type MouseEvent, type ReactNode } from 'react'
import { SubmitButton } from '@/components/ds/core/SubmitButton'

/**
 * The bug form's submit, which refuses to post a report with no evidence.
 *
 * The rule itself lives on the server (`actions.ts` re-checks it, and that is
 * the check that actually enforces it — this one is only reachable with
 * JavaScript). What this adds is that the tester keeps their work: the server
 * answers a missing attachment with a redirect back to an empty form, so
 * catching it before the submit is the difference between fixing one field and
 * retyping a long report from memory.
 *
 * Evidence is either a finished upload — `EvidenceUpload` emits one hidden
 * `attachmentFileIds` input per file — or a pasted `videoUrl`. Reading them
 * out of `FormData` at click time means this stays correct however those
 * fields are rendered, rather than duplicating either component's internals.
 */
export function EvidenceGuardedSubmit({
  children,
  pendingLabel,
}: {
  children: ReactNode
  pendingLabel?: string
}) {
  const [blocked, setBlocked] = useState(false)

  function guard(event: MouseEvent) {
    const form = (event.currentTarget as HTMLElement).closest('form')
    if (!form) return

    const data = new FormData(form)
    const hasFile = data
      .getAll('attachmentFileIds')
      .some((value) => typeof value === 'string' && value.trim() !== '')
    /* `FormData.get` is typed `string | File | null`; a File here would
       stringify to "[object File]" and read as evidence when it is not. */
    const video = data.get('videoUrl')
    const hasVideo = typeof video === 'string' && video.trim() !== ''

    if (hasFile || hasVideo) {
      setBlocked(false)
      return
    }

    event.preventDefault()
    setBlocked(true)

    /* Send them to the field they need, not just to a message about it. The
       evidence panel is well below the fold on a long report. */
    const target = form.querySelector<HTMLElement>('#videoUrl')
    target?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <SubmitButton
        variant="primary"
        iconLeft="clipboard-check"
        pendingLabel={pendingLabel}
        onClick={guard}
      >
        {children}
      </SubmitButton>
      {blocked ? (
        <p
          role="alert"
          style={{
            margin: 0,
            fontSize: 'var(--type-body-sm-size)',
            color: 'var(--status-error-fg)',
          }}
        >
          Attach a screenshot or recording, or paste a video link, before filing. Nothing you have
          written has been lost.
        </p>
      ) : null}
    </div>
  )
}
