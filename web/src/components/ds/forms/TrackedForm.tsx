'use client'

import type { CSSProperties, FormEventHandler, ReactNode } from 'react'
import { useRef } from 'react'
import { UnsavedChangesWarning } from './UnsavedChangesWarning'

/**
 * Props for the tracked form wrapper.
 *
 * A `<form>` element that tracks dirty state on its inputs and warns the
 * user before they navigate away with unsaved changes. Renders the same
 * DOM as a plain `<form>` — the only thing it adds is an unattached
 * `<UnsavedChangesWarning>` child that listens to `input`/`change` events
 * and registers a `beforeunload` listener while dirty.
 *
 * Use this for any form that takes more than a single click to fill in —
 * the warning is never useful for a one-button "archive" form, and adds
 * a small amount of client JS for every form that opts in.
 */
export interface TrackedFormProps {
  /**
   * The form's action. Either a Server Action (the common case in this
   * codebase) or a plain string URL. Passed through to the underlying
   * `<form>` unchanged.
   */
  action: ((formData: FormData) => void | Promise<void>) | string
  children: ReactNode
  /** Optional inline style passthrough. */
  style?: CSSProperties
  /** Optional hook called before the form is submitted. */
  onSubmit?: FormEventHandler<HTMLFormElement>
  /** Optional id passthrough. */
  id?: string
  /** Optional className passthrough. */
  className?: string
}

/**
 * `<form>` with built-in unsaved-changes tracking.
 *
 * Drop-in replacement for the Server-Component `<form action={...}>`
 * pattern. Server Actions are still serialised and called by the Next.js
 * runtime exactly as before — the only added behaviour is the beforeunload
 * warning.
 */
export function TrackedForm({ action, children, style, onSubmit, id, className }: TrackedFormProps) {
  const formRef = useRef<HTMLFormElement>(null)

  return (
    <form ref={formRef} action={action} style={style} onSubmit={onSubmit} id={id} className={className}>
      {children}
      <UnsavedChangesWarning formRef={formRef} />
    </form>
  )
}
