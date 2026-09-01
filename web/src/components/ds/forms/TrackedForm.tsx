'use client'

import type { CSSProperties, FormEvent, FormEventHandler, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../core/Icon'
import { UnsavedChangesWarning } from './UnsavedChangesWarning'
import { describeInvalid, validatableControls, type FormControl } from './validation-message'

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
  /**
   * Opt out of the error summary and fall back to the browser's own bubbles.
   * Nothing needs this today; it exists so a form with an unusual layout can
   * decline without forking the component.
   */
  nativeValidation?: boolean
}

interface Problem {
  /** The control's `id`, when it has one — the summary links to it. */
  id: string | null
  message: string
  control: FormControl
}

/**
 * `<form>` with built-in unsaved-changes tracking and a real error summary.
 *
 * Drop-in replacement for the Server-Component `<form action={...}>`
 * pattern. Server Actions are still serialised and called by the Next.js
 * runtime exactly as before.
 *
 * ── Validation
 *
 * The browser's native bubble ("Please fill out this field.") is replaced by a
 * summary at the top of the form listing EVERY problem at once, each line
 * naming its field and linking to it. See `validation-message.ts` for what was
 * wrong with the bubble; the short version is that it names no field, reports
 * one problem at a time, and points at a control the sticky header is often
 * covering.
 *
 * Three deliberate choices:
 *
 *  - `noValidate` is set in an effect, never in the rendered HTML. Before
 *    hydration the native bubbles are still the only thing standing between a
 *    reader and an empty submission, so the handover happens only once this
 *    component is live to take over.
 *  - Focus moves to the summary rather than to the first bad field, so a
 *    screen reader hears the whole list instead of one item, and the links
 *    then take the reader to whichever field they want to fix first.
 *  - `aria-invalid` is set on the controls imperatively. `Field` and `Input`
 *    are Server Components on these pages and cannot be handed state; the
 *    attribute is one React never set itself, and `.c4t-input[aria-invalid]`
 *    in interactions.css already carries the red border.
 *
 * None of this is a security boundary — the API validates every one of these
 * fields on arrival, which is what actually protects the data.
 */
export function TrackedForm({
  action,
  children,
  style,
  onSubmit,
  id,
  className,
  nativeValidation = false,
}: TrackedFormProps) {
  const formRef = useRef<HTMLFormElement>(null)
  const summaryRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef(false)
  const [problems, setProblems] = useState<Problem[]>([])
  /** Errors appear only after a first attempt — never while the form is still being filled in. */
  const [attempted, setAttempted] = useState(false)

  // Hand validation over from the browser only once this component can do it.
  useEffect(() => {
    if (nativeValidation) return
    const form = formRef.current
    if (!form) return
    form.noValidate = true
    return () => {
      form.noValidate = false
    }
  }, [nativeValidation])

  const collect = useCallback((form: HTMLFormElement): Problem[] => {
    return validatableControls(form)
      .filter((control) => !control.checkValidity())
      .map((control) => ({
        id: control.id || null,
        message: describeInvalid(control),
        control,
      }))
  }, [])

  /** Mark the bad controls and clear the rest. Cheap enough to redo wholesale. */
  const paint = useCallback((form: HTMLFormElement, found: Problem[]) => {
    const bad = new Set(found.map((problem) => problem.control))
    for (const control of validatableControls(form)) {
      if (bad.has(control)) control.setAttribute('aria-invalid', 'true')
      else control.removeAttribute('aria-invalid')
    }
  }, [])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    onSubmit?.(event)
    if (event.defaultPrevented || nativeValidation) return

    const form = event.currentTarget
    const found = collect(form)
    paint(form, found)
    setProblems(found)

    if (found.length === 0) return

    event.preventDefault()
    setAttempted(true)
    pendingFocus.current = true
  }

  // The summary does not exist until the commit that `setProblems` triggers, so
  // focus waits for that commit rather than for a frame that may beat it.
  useEffect(() => {
    if (!pendingFocus.current || problems.length === 0) return
    pendingFocus.current = false
    summaryRef.current?.focus()
    summaryRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [problems])

  /**
   * Once the reader has seen the list, keep it honest as they work: a field
   * that becomes valid drops off it immediately rather than sitting there
   * contradicting the form.
   */
  const handleChange = () => {
    if (!attempted) return
    const form = formRef.current
    if (!form) return
    const found = collect(form)
    paint(form, found)
    setProblems(found)
  }

  const focusProblem = (event: React.MouseEvent, problem: Problem) => {
    event.preventDefault()
    problem.control.focus()
    problem.control.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  return (
    <form
      ref={formRef}
      action={action}
      style={style}
      onSubmit={handleSubmit}
      onChange={handleChange}
      id={id}
      className={className}
    >
      {problems.length > 0 ? (
        <div
          ref={summaryRef}
          role="alert"
          tabIndex={-1}
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-5)',
            border: '1px solid var(--status-error-fg)',
            borderRadius: 'var(--radius-input)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            fontSize: 'var(--type-body-sm-size)',
            lineHeight: 1.45,
          }}
        >
          <Icon name="alert-triangle" size={20} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <p style={{ margin: 0, fontWeight: 'var(--fw-medium)' }}>
              {problems.length === 1
                ? 'One field needs your attention before this can be saved.'
                : `${problems.length} fields need your attention before this can be saved.`}
            </p>
            <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-5)' }}>
              {problems.map((problem, index) => (
                <li key={problem.id ?? index} style={{ marginTop: index === 0 ? 0 : 4 }}>
                  {problem.id ? (
                    <a
                      href={`#${problem.id}`}
                      onClick={(event) => focusProblem(event, problem)}
                      style={{ color: 'inherit' }}
                    >
                      {problem.message}
                    </a>
                  ) : (
                    problem.message
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {children}
      <UnsavedChangesWarning formRef={formRef} />
    </form>
  )
}
