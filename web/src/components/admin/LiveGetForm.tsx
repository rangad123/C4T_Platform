'use client'

import { createContext, useContext, useEffect, useRef, useTransition } from 'react'
import type { CSSProperties, FormEvent, ReactNode, SyntheticEvent } from 'react'
import { useRouter } from 'next/navigation'

/** How long a text field waits after the last keystroke before it applies. */
const DEBOUNCE_MS = 350

const PendingContext = createContext(false)

/**
 * Whether this `LiveGetForm`'s update is currently in flight — e.g. to show a
 * small "Updating…" cue in place of the submit button a live form no longer
 * needs. Only meaningful inside a `LiveGetForm`; returns `false` elsewhere.
 */
export function useLiveFormPending(): boolean {
  return useContext(PendingContext)
}

/**
 * The small "Updating…" status a `LiveGetForm` shows instead of a submit
 * button. `aria-live` so it's announced for anyone not watching the table
 * itself re-render. Renders nothing while idle — there is no permanent
 * "Filter" button to replace it, since every field already applies itself.
 */
export function LiveFormStatus(): ReactNode {
  const isPending = useLiveFormPending()
  if (!isPending) return null
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        fontSize: 'var(--type-caption-size)',
        color: 'var(--text-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      Updating…
    </span>
  )
}

export interface LiveGetFormProps {
  /** The page path this form's fields navigate to — same as the old `action`. */
  action: string
  style?: CSSProperties
  className?: string
  children: ReactNode
}

/**
 * A GET filter form that applies on every change instead of waiting for a
 * submit click — pick a status, and the list behind it updates right away.
 *
 * One `onChange` on the `<form>` itself, not one per field: a native `change`
 * event bubbles up from whichever control fired it, so a page can add a new
 * filter to its `ListFilters`/picker without wiring a new handler. A
 * `<select>` or a date input commits immediately, since picking one already
 * is the deliberate, completed action; a text field is debounced so the page
 * isn't re-navigated on every keystroke. `useTransition` marks the resulting
 * `router.replace` as non-urgent so typing itself never blocks on it —
 * `useLiveFormPending` exposes that pending state so a caller can show a
 * small status instead of a submit button, since there is nothing left to
 * submit once every field applies itself.
 *
 * `replace`, not `push`: a history entry per keystroke would make the back
 * button useless. The URL is still the single source of truth — bookmarkable,
 * shareable, restored correctly on reload — it simply no longer takes a click
 * to get there. The real `method="get"`/`action` attributes stay on the tag
 * too, so a visitor whose JS hasn't hydrated yet still gets a working (if not
 * live) filter on Enter, exactly as this form behaved before.
 */
export function LiveGetForm({ action, style, className, children }: LiveGetFormProps) {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  function apply() {
    const form = formRef.current
    if (!form) return
    const data = new FormData(form)
    const query = new URLSearchParams()
    for (const [key, value] of data.entries()) {
      // Every field here is a text/select/date control, never a file input —
      // but FormDataEntryValue is typed as `string | File`, so narrow first.
      if (typeof value !== 'string') continue
      const text = value.trim()
      if (text) query.set(key, text)
    }
    const qs = query.toString()
    startTransition(() => {
      router.replace(qs ? `${action}?${qs}` : action, { scroll: false })
    })
  }

  function handleChange(event: SyntheticEvent<HTMLFormElement>) {
    const target = event.target as HTMLInputElement
    const isDiscrete =
      target.tagName === 'SELECT' ||
      target.type === 'date' ||
      target.type === 'checkbox' ||
      target.type === 'radio'

    if (timerRef.current) clearTimeout(timerRef.current)
    if (isDiscrete) {
      apply()
    } else {
      timerRef.current = setTimeout(apply, DEBOUNCE_MS)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (timerRef.current) clearTimeout(timerRef.current)
    apply()
  }

  return (
    <form
      ref={formRef}
      method="get"
      action={action}
      onChange={handleChange}
      onSubmit={handleSubmit}
      style={style}
      className={className}
    >
      <PendingContext.Provider value={isPending}>{children}</PendingContext.Provider>
    </form>
  )
}
