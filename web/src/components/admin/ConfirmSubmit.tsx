'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'

export interface ConfirmSubmitProps {
  /** Resting label — "Remove", "Delete". */
  children: React.ReactNode
  /** The question asked once armed. Keep it specific: name the thing. */
  question: string
  /** Label on the button that actually submits. Defaults to "Yes, remove". */
  confirmLabel?: string
  /**
   * Label on the button that backs out. Defaults to "Cancel".
   *
   * Overridable because "Cancel" is ambiguous when the ACTION is also a
   * cancellation — "Yes, cancel it" beside "Cancel" gives the reader two
   * buttons that both read as cancelling, and the safe one is not obviously
   * the safe one.
   */
  dismissLabel?: string
  /** Label while the form is in flight. */
  pendingLabel?: string
  /** Lucide icon on the resting button. Pass `""` for no icon. */
  iconLeft?: string
  size?: 'sm' | 'md' | 'lg'
}

/**
 * A destructive submit that asks first.
 *
 * ── WHY NOT `window.confirm`
 *
 * It cannot be styled, it reads as a browser-level warning rather than part
 * of the page, some embedded contexts suppress it outright, and it blocks the
 * main thread. Swapping the button for an inline question keeps the
 * confirmation next to the row it affects, which is also where the user is
 * already looking.
 *
 * ── WHY NOT A MODAL
 *
 * `Modal` here is URL-driven (`?edit=…`), which is right for a form you might
 * refresh into and wrong for a yes/no on a row you can re-add in seconds.
 * This is deliberately the light-touch tier: an inline arm-then-confirm. The
 * typed-confirmation pattern used for archiving a project stays reserved for
 * things that are genuinely hard to undo.
 *
 * The confirm button is a real `SubmitButton`, so it submits the enclosing
 * `<form action={serverAction}>` exactly as the bare button did — this is a
 * drop-in wrap, and `useFormStatus` still reports that form's state.
 *
 * Arming is abandoned on Escape and on a click elsewhere, so an accidental
 * arm does not leave a live delete control sitting on the page.
 */
export function ConfirmSubmit({
  children,
  question,
  confirmLabel = 'Yes, remove',
  dismissLabel = 'Cancel',
  pendingLabel = 'Removing…',
  iconLeft = 'trash-2',
  size = 'sm',
}: ConfirmSubmitProps) {
  const [armed, setArmed] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)

  /**
   * Move focus onto the confirm button when it appears, so a keyboard user is
   * not left on a control that no longer exists.
   *
   * Found by query rather than by ref: `Button` takes no `ref` and does not
   * spread unknown props onto its `<button>`, and widening that shared
   * primitive for one call site is the wrong trade.
   */
  useEffect(() => {
    if (!armed) return
    wrapRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus()
  }, [armed])

  useEffect(() => {
    if (!armed) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setArmed(false)
    }
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setArmed(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [armed])

  if (!armed) {
    return (
      <Button
        type="button"
        variant="ghost"
        size={size}
        // `""` collapses to no icon; `undefined` would re-trigger the default.
        iconLeft={iconLeft || undefined}
        style={{ color: 'var(--status-error-fg)' }}
        onClick={() => setArmed(true)}
      >
        {children}
      </Button>
    )
  }

  return (
    <span
      ref={wrapRef}
      role="group"
      aria-label={question}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontSize: 'var(--type-body-sm-size)', color: 'var(--text-secondary)' }}>
        {question}
      </span>
      <SubmitButton
        variant="ghost"
        size={size}
        style={{ color: 'var(--status-error-fg)' }}
        pendingLabel={pendingLabel}
      >
        {confirmLabel}
      </SubmitButton>
      <Button type="button" variant="ghost" size={size} onClick={() => setArmed(false)}>
        {dismissLabel}
      </Button>
    </span>
  )
}
