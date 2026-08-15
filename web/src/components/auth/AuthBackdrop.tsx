'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Logo } from '@/components/ds/core/Logo'
import { IconButton } from '@/components/ds/core/IconButton'

/**
 * The native `<dialog>` modal that wraps every auth page.
 *
 * The dialog is opened imperatively via `showModal()` so it participates in
 * the top layer. Concretely that does three things the rest of the page
 * does not need to know about:
 *
 *  1. The page underneath is automatically `inert`. Pointer events and
 *     keyboard focus cannot reach it. Clicks on the dim layer land on
 *     the dialog, not on links in the page below; tab cannot reach a
 *     `<button>` in the page below; screen readers do not see the rest
 *     of the document.
 *  2. The dialog paints its own `::backdrop` over the page. That is the
 *     ONLY cover the dialog puts on the page — the page itself is still
 *     rendered and visible. A hand-rolled `position: fixed` overlay would
 *     cover the page entirely, which is what the previous draft of this
 *     component did and what the user was seeing as a white screen.
 *  3. Esc closes the dialog and the `close` event fires exactly once.
 *     That is the single place from which we navigate back.
 *
 * Three ways to close the modal: the back-arrow button at the top-left
 * (visible, keyboard-accessible, the obvious affordance), the Esc key
 * (power-user shortcut), and the dim backdrop area (click-outside).
 * All three call the same `close()` so the close event is the single
 * resolver of "the modal is going away".
 *
 * The Logo sits above the form inside the dialog. The page itself does not
 * render any chrome around the modal — there is no fixed-position wrapper.
 */
export function AuthModal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const router = useRouter()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    if (!dialog.open) {
      dialog.showModal()
    }

    function onClose() {
      if (window.history.length > 1) {
        router.back()
      } else {
        router.push('/')
      }
    }
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [router])

  function close() {
    ref.current?.close()
  }

  return (
    <dialog
      ref={ref}
      style={{
        width: '100%',
        maxWidth: 'var(--container-form)',
        padding: 0,
        border: 0,
        background: 'transparent',
        margin: 'auto',
        // The dialog itself has no max-height so it sits centered in the
        // viewport. The inner card has its own padding so the form has
        // breathing room.
      }}
    >
      <style
        // ::backdrop only matches when the dialog is in the top layer (i.e.
        // opened via showModal()). The rule is inline with the dialog so the
        // styling lives next to the component that owns the modal.
        dangerouslySetInnerHTML={{
          __html: `dialog::backdrop { background: rgb(23 19 15 / 0.55); backdrop-filter: blur(4px); }`,
        }}
      />
      <div
        style={{
          position: 'relative',
          padding: 'var(--space-9)',
          background: 'var(--surface-canvas)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-card)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <IconButton
          icon="arrow-left"
          label="Back"
          onClick={close}
          style={{
            position: 'absolute',
            top: 'var(--space-4)',
            left: 'var(--space-4)',
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            marginBottom: 'var(--space-7)',
          }}
        >
          <Logo size={32} withWordmark />
        </div>
        {children}
      </div>
    </dialog>
  )
}

