'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconButton } from '@/components/ds/core/IconButton'
import { Button } from '@/components/ds/core/Button'

export interface ModalProps {
  /** The page computes this from `searchParams.edit === 'thisModalsKey'`. */
  open: boolean
  /** URL to navigate to when the dialog closes itself — the same URL with `edit` (and any error/echo params) stripped. */
  closedHref: string
  title: string
  /**
   * Whether clicking the backdrop dismisses the dialog. Default `true`.
   *
   * Set `false` for a step the user should leave deliberately — a
   * confirmation they must answer, or anything irreversible where a stray
   * click landing outside the panel should not count as "no". Escape and the
   * X button still work, so the dialog is never a trap.
   */
  closeOnBackdropClick?: boolean
  /** The page's own already-existing Server Component form — unchanged, `Field`/`Input`/`TrackedForm` untouched. */
  children: ReactNode
}

/**
 * The value this component compares a control against, for one element.
 * Parallels `UnsavedChangesWarning`'s own snapshot function — that one
 * instruments a specific `<form>` a caller opts into; this one has to
 * discover whatever form(s) a modal happens to contain, so the two stay
 * separate rather than forced to share one signature.
 */
function snapshotValue(el: Element): string | null {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : '0'
    return el.value
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value
  return null
}

/**
 * `sessionStorage` key marking "a modal just submitted a form or a Cancel
 * link, so whatever page loads next should try to restore focus".
 *
 * This cannot be a React ref. A save goes through a Server Action's
 * `redirect()`, which is a full route transition — confirmed by testing, not
 * assumed, this tears down and remounts the whole component tree, so any
 * ref/state on the Modal instance that closed is gone by the time the
 * redirect lands; there is no component left to have remembered "I was just
 * open". `sessionStorage` is the one thing that actually survives that.
 */
const FOCUS_RESTORE_KEY = 'c4t-modal-restore-focus'

/**
 * A button-triggered popup for an edit form that would otherwise sit
 * permanently inline (§10-11) — generalizes the native-`<dialog>` approach
 * this codebase used first for the sign-in modal (since removed; see the
 * note on `AuthCard` for why), rather than pulling in a dialog library.
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
 * imperative `showModal()`/`close()` call, the same trick the removed
 * sign-in modal used for its own back-navigation case.
 *
 * ── Why validation errors still work without client form state
 *
 * A rejected submit redirects to `${pathname}?edit=name&error=...&<echoed
 * fields>` — exactly the `backToForm()`/`ECHO_KEYS` pattern already used in
 * `transactions/new/page.tsx`. The page recomputes `open=true` for the
 * matching modal and re-renders the same inline error + `defaultValue`-
 * prefilled fields, now inside the dialog instead of the page body. Nothing
 * here introduces client-side form state.
 *
 * ── Discarding unsaved changes
 *
 * Escape and the X both go through `requestClose`, not straight to
 * `dialog.close()`. If nothing inside has changed since the dialog opened,
 * it closes immediately — that is the common case and should not make the
 * user confirm a no-op. If something has changed, an inline banner takes
 * over the dialog's own body ("Discard changes?" / Continue editing /
 * Discard changes) rather than a second stacked dialog, so there is only
 * ever one native `<dialog>` on screen at a time. Picking "Continue editing"
 * just hides the banner — the form underneath was never unmounted, so
 * nothing typed is lost. A successful save closes through the `open` prop
 * going false, which calls `dialog.close()` directly and never passes
 * through this check — a save is not a thing to confirm discarding.
 *
 * ── Returning focus after a save
 *
 * Escape/X restore focus to the trigger for free — that is `<dialog>`'s own
 * native behavior, confirmed by testing. A save does not get that for free:
 * it closes via a Server Action's `redirect()`, a full route transition that
 * leaves focus on `<body>`. See `FOCUS_RESTORE_KEY` above and the two
 * `useEffect`s below for how that path is covered instead.
 */
export function Modal({
  open,
  closedHref,
  title,
  closeOnBackdropClick = true,
  children,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  // A page can and does render more than one Modal at once (a list of
  // per-row edit dialogs, say). A hardcoded id would give every instance's
  // <h2> the same id, so `aria-labelledby` — and anything else that looks up
  // "the modal title" by id — would resolve to whichever one happens to sit
  // first in the DOM, not the one actually open.
  const titleId = useId()
  const router = useRouter()
  const [confirmingClose, setConfirmingClose] = useState(false)
  const confirmRef = useRef<HTMLDivElement>(null)
  const initialValuesRef = useRef<WeakMap<Element, string> | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    if (open && !dialog.open) {
      dialog.showModal()
      // Snapshot fresh every time the dialog opens — the same modal
      // component instance re-opens for a different record across
      // navigations, so a snapshot from a previous open would compare
      // against the wrong values.
      const initial = new WeakMap<Element, string>()
      for (const el of dialog.querySelectorAll('input, textarea, select')) {
        const value = snapshotValue(el)
        if (value !== null) initial.set(el, value)
      }
      initialValuesRef.current = initial
      setConfirmingClose(false)
    } else if (!open && dialog.open) {
      dialog.close()
    }

    function onClose() {
      router.push(closedHref)
    }
    // Both listened for on the dialog itself, so one place covers every
    // "the user is leaving this dialog toward a new page" path:
    //  - a form inside it submitting (Save) — `submit` bubbles to the dialog
    //  - a plain `<a>` inside it being clicked (Cancel, or the same "Done"
    //    link the upload-only modals use instead of a Save button)
    // Both are marked here, before the navigation actually happens, rather
    // than from the destination page guessing after the fact.
    function onSubmit() {
      try {
        sessionStorage.setItem(FOCUS_RESTORE_KEY, '1')
      } catch {
        // Private-browsing/storage-disabled: focus just stays wherever the
        // browser puts it. Not worth failing the save over.
      }
    }
    function onClickCapture(event: Event) {
      if ((event.target as Element).closest('a[href]')) onSubmit()
    }
    dialog.addEventListener('close', onClose)
    dialog.addEventListener('submit', onSubmit)
    dialog.addEventListener('click', onClickCapture, true)
    return () => {
      dialog.removeEventListener('close', onClose)
      dialog.removeEventListener('submit', onSubmit)
      dialog.removeEventListener('click', onClickCapture, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closedHref changes with every render (it carries the current filters); re-binding the listener on it would be a no-op churn, not a behavior fix.
  }, [open, router])

  // Reading — and clearing — the marker happens in a lazy `useState`
  // initializer, not inside the effect below, and that is load-bearing, not
  // a style choice. React (in dev, under Strict Mode) mounts an effect, runs
  // its cleanup, then mounts it again, to surface exactly this class of bug:
  // an effect that does something non-idempotent (consume a one-time flag)
  // paired with a cleanup that undoes its OTHER side effect (cancels the
  // scheduled timer) left the second mount finding nothing, because the
  // first mount had already deleted the marker before its own timer ever got
  // to fire. A lazy initializer runs once per component instance with no
  // matching "cleanup" step to race against, so the flag is consumed exactly
  // once regardless of Strict Mode. Confirmed with temporary logging during
  // debugging, not assumed.
  const [shouldRestoreFocus] = useState(() => {
    // Deliberately a read only — no `removeItem` here. Strict Mode (dev
    // only) invokes a lazy `useState` initializer twice for the same reason
    // it double-invokes effects, and `removeItem` is exactly the kind of
    // side effect that behavior exists to catch: call 1 reads `true` and
    // deletes the key, call 2 reads `false` because call 1 already deleted
    // it, and if React keeps call 2's result, `shouldRestoreFocus` is wrong
    // regardless of which call actually happened first. Confirmed by testing
    // — this is not a hypothetical. Reading without deleting means both
    // calls agree, so it does not matter which one React keeps. The actual
    // deletion happens in the effect below, where running it twice is
    // harmless (removing an already-removed key is a no-op).
    try {
      return sessionStorage.getItem(FOCUS_RESTORE_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (!shouldRestoreFocus) return
    try {
      sessionStorage.removeItem(FOCUS_RESTORE_KEY)
    } catch {
      /* noop */
    }
  }, [shouldRestoreFocus])

  // If the dialog that closed just before this page loaded left the marker
  // behind, this is that dialog's trigger link asking to be found again.
  useEffect(() => {
    if (!shouldRestoreFocus) return

    // This runs once per Modal instance on the page; only the one whose
    // `document.querySelector` below finds something live actually moves
    // focus, so running in more than one instance is harmless — including
    // running twice under Strict Mode, since scheduling and clearing the same
    // kind of timer twice has no observable effect either way. The delay is
    // longer than it looks like it should need to be — Next moves focus to
    // `<body>` itself once navigation settles (its own accessibility
    // behavior, so a freshly-landed page doesn't leave focus on a removed
    // element), and at 100ms this was still running before that happened and
    // immediately losing the race. 400ms is confirmed by testing to run
    // after it, not derived from a spec number.
    const timer = setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      // Every trigger in this codebase is a plain `<a href="...&edit=…">`
      // (`Button` with an `href`), so the reopen link is identifiable by
      // that alone — no id has to be threaded through every call site for
      // this. A page with several such triggers (one per row in a list)
      // focuses the first; that is the closest related control on the page,
      // not necessarily the exact row, but is still far better than focus
      // silently landing on `<body>`.
      const trigger = document.querySelector<HTMLElement>('a[href*="edit="]')
      trigger?.focus()
    }, 400)
    return () => clearTimeout(timer)
  }, [shouldRestoreFocus])

  /** True if any tracked control's value has moved since the dialog opened. */
  function isDirty(): boolean {
    const dialog = ref.current
    const initial = initialValuesRef.current
    if (!dialog || !initial) return false
    for (const el of dialog.querySelectorAll('input, textarea, select')) {
      const current = snapshotValue(el)
      if (current === null) continue
      // An element that did not exist at snapshot time (a field that only
      // appears after a choice made inside the modal) counts as dirty too —
      // `.get` on a WeakMap simply misses rather than throwing.
      if (initial.get(el) !== current) return true
    }
    return false
  }

  /**
   * Move focus into the confirmation when it appears.
   *
   * The form behind it goes `inert` at the same moment, so whichever control
   * asked to close — a Cancel button inside the form — takes focus with it
   * and leaves the keyboard on `<body>`. Focusing the safe option is also
   * what `role="alertdialog"` implies, and it scrolls the banner into view on
   * its own for anyone who was further up the form.
   */
  useEffect(() => {
    if (!confirmingClose) return
    confirmRef.current?.querySelector('button')?.focus()
  }, [confirmingClose])

  /** Escape and the X both call this instead of closing outright. */
  function requestClose() {
    if (isDirty()) {
      setConfirmingClose(true)
      return
    }
    ref.current?.close()
  }

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // The native event Escape fires. Preventing it stops the dialog from
    // closing on its own, so `requestClose` is the only path to an actual
    // `close()` — Escape and the X button behave identically.
    function onCancel(event: Event) {
      event.preventDefault()
      requestClose()
    }

    /**
     * Click-outside-to-dismiss.
     *
     * A `showModal()` dialog paints its own `::backdrop`, and a click landing
     * there reports the DIALOG ELEMENT as its target — content clicks report
     * whatever inner node was hit. That identity check is the whole test;
     * there is no separate backdrop node to bind a handler to. It only works
     * because this dialog has `padding: 0`: padding belongs to the element,
     * so a padded dialog would report clicks in its own gutter as backdrop
     * hits and close when the user meant to click near a field.
     *
     * ── Why `pointerdown` is tracked too
     *
     * Selecting text in a field and releasing the mouse past the panel's
     * edge produces a click whose target is the dialog, which would dismiss
     * the form mid-edit and — since a drag means the user was working — very
     * likely take unsaved changes with it. Requiring the gesture to have
     * BEGUN on the backdrop keeps a sloppy drag from being read as a
     * dismissal.
     *
     * Dismissal goes through `requestClose`, so it inherits the same
     * unsaved-changes gate as Escape and the X.
     */
    let pressedOnBackdrop = false
    function onPointerDown(event: PointerEvent) {
      pressedOnBackdrop = event.target === dialog
    }
    function onClick(event: MouseEvent) {
      if (!closeOnBackdropClick) return
      if (event.target !== dialog || !pressedOnBackdrop) return
      pressedOnBackdrop = false
      requestClose()
    }

    dialog.addEventListener('cancel', onCancel)
    dialog.addEventListener('pointerdown', onPointerDown)
    dialog.addEventListener('click', onClick)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      dialog.removeEventListener('pointerdown', onPointerDown)
      dialog.removeEventListener('click', onClick)
    }
  })

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="c4t-modal-dialog"
      style={{
        width: '100%',
        maxWidth: 880,
        padding: 0,
        border: 0,
        background: 'transparent',
        margin: 'auto',
      }}
    >
      <style
        // Scoped by nesting, not a global selector — this file's own dialog only.
        dangerouslySetInnerHTML={{
          __html: `
            dialog.c4t-modal-dialog::backdrop { background: rgb(23 19 15 / 0.5); backdrop-filter: blur(3px); }

            /*
             * §38 — a subtle fade/scale on the panel and a fade on the
             * backdrop, nothing more (no slide, no bounce): matches this
             * design system's own "nothing bounces; nothing slides more than
             * 8px" rule for every OTHER transition in the app, applied here
             * for the first time to a native <dialog>.
             *
             * The exit half needs "overlay"/"display" named as transitioning
             * properties with allow-discrete — without that, a <dialog> is
             * removed from the top layer and set display:none the instant
             * .close() runs, and only the OPEN animation would ever be seen.
             * @starting-style is what lets the OPEN animation exist at all:
             * it is the browser-native way to say "the very first frame
             * after appearing should look like this", which a plain
             * transition cannot express on its own (there is no prior frame
             * to transition from — the element did not exist a moment ago).
             *
             * Both durations come from the shared motion tokens, not a
             * number invented here, so prefers-reduced-motion already zeroes
             * them for free — that override lives in tokens/motion.css, not
             * repeated in this file.
             */
            dialog.c4t-modal-dialog {
              opacity: 1;
              transform: scale(1) translateY(0);
              transition: opacity var(--duration-base) var(--ease-standard),
                transform var(--duration-base) var(--ease-standard),
                overlay var(--duration-base) allow-discrete,
                display var(--duration-base) allow-discrete;
            }
            dialog.c4t-modal-dialog:not([open]) {
              opacity: 0;
              transform: scale(0.98) translateY(4px);
            }
            @starting-style {
              dialog.c4t-modal-dialog[open] {
                opacity: 0;
                transform: scale(0.98) translateY(4px);
              }
            }
            dialog.c4t-modal-dialog::backdrop {
              transition: background-color var(--duration-base) var(--ease-standard),
                overlay var(--duration-base) allow-discrete,
                display var(--duration-base) allow-discrete;
            }
            @starting-style {
              dialog.c4t-modal-dialog[open]::backdrop {
                background-color: rgb(23 19 15 / 0);
              }
            }
          `,
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
          <h2 id={titleId} className="c4t-heading-md" style={{ margin: 0 }}>
            {title}
          </h2>
          <IconButton icon="x" label="Close" onClick={requestClose} />
        </div>
        {/*
         * `children` stays mounted underneath the banner rather than being
         * swapped out for it — swapping was the first version of this and it
         * had a real bug: conditionally rendering `confirmingClose ? banner :
         * children` unmounts the form while the banner shows, so "Continue
         * editing" came back to a blank/reset form instead of the edit the
         * user was in the middle of. `inert` freezes the form in place
         * (unfocusable, unclickable, hidden from assistive tech) without
         * touching its DOM, which is also what stops a click from reaching
         * the background form while the banner is up.
         */}
        <div style={{ position: 'relative' }} inert={confirmingClose || undefined}>
          {children}
        </div>
        {confirmingClose ? (
          <div
            ref={confirmRef}
            role="alertdialog"
            aria-label="Discard changes?"
            style={{
              /*
               * Pinned to the bottom of the panel's own scrollport.
               *
               * The banner is the last child of a container that scrolls at
               * 85vh, so on a form as long as "New build" it rendered below
               * everything else — a question the user had to go looking for,
               * having just asked to close. Sticky keeps it on screen from
               * wherever they were when they pressed Cancel, and keeps it
               * there if they scroll while deciding.
               *
               * The negative bottom offset is the panel's own padding, so the
               * banner sits flush with the bottom edge instead of leaving a
               * strip the form scrolls through underneath it.
               */
              position: 'sticky',
              bottom: 'calc(var(--space-7) * -1)',
              zIndex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
              padding: 'var(--space-5)',
              background: 'var(--surface-sunken)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-card)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <p className="c4t-heading-sm" style={{ margin: 0 }}>
                Discard changes?
              </p>
              <p
                style={{
                  margin: 0,
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--type-body-sm-size)',
                }}
              >
                You have unsaved changes. Are you sure you want to close?
              </p>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setConfirmingClose(false)}
              >
                Continue editing
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => ref.current?.close()}>
                Discard changes
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </dialog>
  )
}
