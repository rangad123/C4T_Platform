'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Props for the unsaved-changes warning.
 *
 * The component is opt-in: a form attaches a `ref` to it; the warning
 * component tracks dirty state via `input`/`change` events on the form and
 * registers a `beforeunload` listener while dirty. Browser-native dialog
 * handles the actual prompt — there is no custom modal, because the browser
 * keeps the wording consistent and unbranded.
 *
 * Submission resets the dirty flag so the user does not see a warning when
 * their form is being saved (the page navigates away). The listener is
 * removed on unmount.
 */
export interface UnsavedChangesWarningProps {
  /** Ref to the `<form>` whose dirty state should be tracked. */
  formRef: React.RefObject<HTMLFormElement | null>
  /**
   * Override the default browser warning. Most browsers ignore the supplied
   * string and use their own copy, but returning one is required by the
   * spec — setting it to an empty string suppresses the dialog.
   *
   * The default is a generic "Changes you made may not be saved" so the
   * underlying form is never referenced by name.
   */
  message?: string
}

/** The value this component compares a control against, for one element. */
function snapshotValue(el: Element): string | null {
  if (el instanceof HTMLInputElement) {
    // A checkbox/radio's `.value` is the static value attribute — it never
    // changes when the box is (un)checked, so comparing `.value` alone would
    // never see a toggle. `.checked` is the thing that actually moves.
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : '0'
    return el.value
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value
  return null
}

/**
 * Tracks dirty state on a form and warns before unload.
 *
 * Drop inside a `<form>` — or anywhere a sibling — as a client component, and
 * pass the form's `ref`. The component renders nothing.
 *
 *   const formRef = useRef<HTMLFormElement>(null)
 *   <form ref={formRef} action={serverAction}>
 *     ...
 *     <UnsavedChangesWarning formRef={formRef} />
 *   </form>
 *
 * Why a separate component rather than wiring `onChange` into every
 * `<Input>`: forms are written as Server Components with server actions,
 * and the dirty-detection is a generic concern that should not leak into
 * the form-control markup. One opt-in per form is the right granularity.
 *
 * The initial snapshot is keyed by DOM element identity (a `WeakMap`), not by
 * `name` — a form with N checkboxes sharing one `name` (a "pick many"
 * group, like a permission list) is common in this codebase, and keying by
 * name alone would let every checkbox but the last overwrite the same map
 * entry, silently breaking dirty detection for every grouped control.
 */
export function UnsavedChangesWarning({
  formRef,
  message = 'Changes you made may not be saved.',
}: UnsavedChangesWarningProps) {
  const [isDirty, setIsDirty] = useState(false)
  const initialValuesRef = useRef<WeakMap<Element, string> | null>(null)

  useEffect(() => {
    const form = formRef.current
    if (!form) return

    // Capture initial values once. Subsequent renders re-mount the same
    // form, so this is stable.
    if (initialValuesRef.current === null) {
      const initial = new WeakMap<Element, string>()
      for (const el of form.elements) {
        const value = snapshotValue(el)
        if (value !== null) initial.set(el, value)
      }
      initialValuesRef.current = initial
    }

    const checkDirty = () => {
      const initial = initialValuesRef.current
      if (!initial) return
      for (const el of form.elements) {
        const current = snapshotValue(el)
        if (current === null) continue
        if (initial.get(el) !== current) {
          setIsDirty(true)
          return
        }
      }
      setIsDirty(false)
    }

    // `input` bubbles for text inputs/textareas/selects; `change` covers
    // checkboxes and radios that don't fire `input`. Use both.
    form.addEventListener('input', checkDirty)
    form.addEventListener('change', checkDirty)

    // Reset on submit so navigating away after save does not trigger a
    // false warning. The beforeunload handler is a no-op once `isDirty`
    // is false anyway, but the explicit reset is easier to reason about.
    const handleSubmit = () => setIsDirty(false)
    form.addEventListener('submit', handleSubmit)

    return () => {
      form.removeEventListener('input', checkDirty)
      form.removeEventListener('change', checkDirty)
      form.removeEventListener('submit', handleSubmit)
    }
  }, [formRef])

  useEffect(() => {
    if (!isDirty) return

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      // Spec: set returnValue to a non-empty string to trigger the prompt.
      // The browser ignores the actual text and uses its own — that's
      // intentional, prevents spoofing.
      event.preventDefault()
      event.returnValue = message
      return message
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty, message])

  return null
}
