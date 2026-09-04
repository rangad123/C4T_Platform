'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { IconButton } from '@/components/ds/core/IconButton'
import styles from './AuthModal.module.css'

/**
 * The dialog an intercepted auth route renders in.
 *
 * ── WHAT THIS IS FOR
 *
 * Clicking "Sign in" in the marketing nav should not throw the reader out of
 * the page they were reading. `app/(marketing)/@auth/(.)login` intercepts that
 * navigation and renders the same form in here instead, over a dimmed copy of
 * wherever they already were.
 *
 * ── THE LIMIT, STATED PLAINLY
 *
 * Interception only happens on a CLIENT-SIDE navigation. A refresh, a pasted
 * or emailed link, an invitation link, a protected page bouncing to `/login`,
 * and the redirect after signing out all arrive as a hard load with no page
 * underneath — Next renders `@auth/default.tsx` (nothing) and the standalone
 * page instead. That is why the earlier version of this was removed: the two
 * looked like different products. The standalone pages are now styled to sit
 * on the same dark band, so the fallback reads as the same screen rather than
 * a blank white one.
 *
 * ── WHY `<dialog>` AND NOT A DIV
 *
 * The native element gives focus trapping, inertness of the page behind, and
 * Escape for free — all of which a hand-rolled overlay has to reimplement and
 * usually gets wrong. `showModal()` is imperative, so it is called from an
 * effect on mount; React never renders `open` itself.
 */
export function AuthModal({
  children,
  wide = false,
}: {
  children: ReactNode
  /**
   * The register dialog's wider measure. Sign-in stays at the standard one —
   * it holds an email and a password, and widening it only stretched two
   * fields across space they did not need.
   */
  wide?: boolean
}) {
  const router = useRouter()
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  /**
   * `router.back()`, not a push to `/`.
   *
   * The reader arrived here from somewhere, and closing should return them to
   * it — including the scroll position. Pushing a route instead would strand
   * them on the home page having merely dismissed a dialog.
   */
  function close() {
    router.back()
  }

  return (
    <dialog
      ref={ref}
      className={`${styles.dialog} ${wide ? styles.wide : ''}`.trim()}
      aria-label="Account"
      /* Escape fires `cancel`; preventing the default close keeps the DOM and
         the URL in step, since `router.back()` is what actually unmounts this. */
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      /* A click landing on the dialog element itself is the backdrop — the
         panel inside stops its own clicks from reaching here. */
      onClick={(event) => {
        if (event.target === ref.current) close()
      }}
    >
      <div className={styles.panel}>
        {/* `sm`, not the default `md`. The card reserves a band above its
            first row for this button (see `.inDialog` in AuthCard's module);
            a 40px box would have cost 8px more of the register form's height
            than a 32px one, and 32px is still a comfortable target. */}
        <div className={styles.dismiss}>
          <IconButton icon="x" label="Close" size="sm" onClick={close} />
        </div>
        {children}
      </div>
    </dialog>
  )
}
