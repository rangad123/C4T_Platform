'use client'

import type { MouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ds/core/Button'

/**
 * "Back" for the wizard's final step.
 *
 * The earlier steps are plain GET forms, so their Back is just a second submit
 * button and needs no JavaScript. This step is not: it posts to a Server
 * Action, and its four tester filters are `MultiSelect`s whose chosen values
 * live in client state. A `<a href>` back would therefore navigate away and
 * silently drop every chip the customer had picked — the exact loss the brief
 * says must not happen when moving between steps.
 *
 * So this reads the form it sits in at the moment of the click — `FormData`
 * sees the hidden inputs `MultiSelect` emits, the same ones the real
 * submission would have posted — and puts them in the URL, which is where the
 * rest of the wizard already keeps its state. Coming forward again re-reads
 * them from there.
 *
 * `type="button"`, so it never submits the action form it is inside.
 */
export function FormBackButton({
  action,
  step,
  children,
}: {
  /** The wizard's own path; the step's values are appended as a query. */
  action: string
  /** Which step to land on. */
  step: string
  children: React.ReactNode
}) {
  const router = useRouter()

  function goBack(event: MouseEvent) {
    const form = (event.currentTarget as HTMLElement).closest('form')
    const query = new URLSearchParams()

    if (form) {
      for (const [key, value] of new FormData(form)) {
        /* React injects its own `$ACTION_*` fields into a Server Action form
           for the no-JS path. They belong to React, not to the wizard, and
           have no business in a URL the customer can see or share. */
        if (typeof value !== 'string' || value === '' || key.startsWith('$')) continue
        query.append(key, value)
      }
    }

    query.set('step', step)
    router.push(`${action}?${query.toString()}`)
  }

  return (
    <Button type="button" variant="ghost" iconLeft="arrow-left" onClick={goBack}>
      {children}
    </Button>
  )
}
