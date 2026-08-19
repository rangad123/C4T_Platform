'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { IconButton } from '@/components/ds/core/IconButton'

export interface ModalProps {
  /** The page computes this from `searchParams.edit === 'thisModalsKey'`. */
  open: boolean
  /** URL to navigate to when the dialog closes itself — the same URL with `edit` (and any error/echo params) stripped. */
  closedHref: string
  title: string
  /** The page's own already-existing Server Component form — unchanged, `Field`/`Input`/`TrackedForm` untouched. */
  children: ReactNode
}

/**
 * A button-triggered popup for an edit form that would otherwise sit
 * permanently inline (§10-11) — generalizes `AuthModal`
 * (`components/auth/AuthBackdrop.tsx`), the one native-`<dialog>` precedent
 * already in this codebase, rather than pulling in a dialog library.
 *
 * ── Why `open` is a prop, not local state
 *
 * The trigger is a plain `<Button href="?edit=name">`, so opening a modal is
 * a normal navigation — the page re-renders with `searchParams.edit` set,
 * computes `open=true`, and passes it down. Closing works the same way in
 * reverse: a successful Server Action redirects to a URL without `edit=`,
 * this component re-renders with `open=false`. Because `<dialog>`'s
 * open/closed state is imperative DOM state, decoupled from React's
 * reconciliation, a `redirect()` does NOT close the dialog on its own — the
 * `useEffect` below is what turns the declarative `open` prop into the
 * imperative `showModal()`/`close()` call, same trick `AuthModal` already
 * uses for its own back-navigation case.
 *
 * ── Why validation errors still work without client form state
 *
 * A rejected submit redirects to `${pathname}?edit=name&error=...&<echoed
 * fields>` — exactly the `backToForm()`/`ECHO_KEYS` pattern already used in
 * `transactions/new/page.tsx`. The page recomputes `open=true` for the
 * matching modal and re-renders the same inline error + `defaultValue`-
 * prefilled fields, now inside the dialog instead of the page body. Nothing
 * here introduces client-side form state.
 */
export function Modal({ open, closedHref, title, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const router = useRouter()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }

    function onClose() {
      router.push(closedHref)
    }
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closedHref changes with every render (it carries the current filters); re-binding the listener on it would be a no-op churn, not a behavior fix.
  }, [open, router])

  function close() {
    ref.current?.close()
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      style={{
        width: '100%',
        maxWidth: 560,
        padding: 0,
        border: 0,
        background: 'transparent',
        margin: 'auto',
      }}
    >
      <style
        // Scoped by nesting, not a global selector — this file's own dialog only.
        dangerouslySetInnerHTML={{
          __html: `dialog::backdrop { background: rgb(23 19 15 / 0.5); backdrop-filter: blur(3px); }`,
        }}
      />
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
          padding: 'var(--space-7)',
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-panel)',
          boxShadow: 'var(--shadow-lg)',
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 id="modal-title" className="c4t-heading-md" style={{ margin: 0 }}>
            {title}
          </h2>
          <IconButton icon="x" label="Close" onClick={close} />
        </div>
        {children}
      </div>
    </dialog>
  )
}
