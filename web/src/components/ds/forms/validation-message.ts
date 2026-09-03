/**
 * Turning a browser `ValidityState` into a sentence a person can act on.
 *
 * ── The bug this exists to stop
 *
 * Submitting an admin form with an empty required field produced the browser's
 * own bubble: "Please fill out this field." Four things are wrong with it, and
 * all four are why `TrackedForm` now renders its own summary instead.
 *
 *  1. It says "this field", never which one — and it is anchored to a control
 *     that is often scrolled behind the sticky header, so on a long form the
 *     arrow points at nothing the reader can see.
 *  2. It reports ONE problem. On the organisation form you fix the name,
 *     submit, and are then told about the contact email — three round trips to
 *     learn three things the browser knew at once.
 *  3. It is an OS tooltip. It ignores the design system, and it vanishes on
 *     its own after a few seconds.
 *  4. It is announced inconsistently by screen readers, and it cannot be
 *     re-read once it has gone.
 *
 * ── What replaces it
 *
 * The same `ValidityState` the browser already computed, phrased against the
 * field's own visible label. No new validation rules live here — a rule that
 * matters is enforced by the API (see `api/src/lib/phone.ts` for the shape of
 * one), and this module only explains what the markup already declares.
 */

/** The three controls the design system renders, all of which validate. */
export type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

const CONTROL_SELECTOR = 'input, select, textarea'

/** Every control in the form that participates in constraint validation. */
export function validatableControls(form: HTMLFormElement): FormControl[] {
  return Array.from(form.querySelectorAll<FormControl>(CONTROL_SELECTOR)).filter(
    (control) => control.willValidate,
  )
}

/** Strips the required-marker asterisk/visually-hidden text a clone carries, then trims it. */
function textOf(node: Node): string | null {
  const clone = node.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[aria-hidden="true"], .c4t-visually-hidden').forEach((el) => {
    el.remove()
  })
  return clone.textContent?.replace(/\s+/g, ' ').trim() || null
}

/**
 * The question a radio group is answering, from its enclosing `<legend>`.
 *
 * `CustomFieldInput` groups a RADIO field's options in a `<fieldset>` whose
 * `<legend>` names the QUESTION ("Where did you see it?"); each `<label>`
 * inside it names an OPTION ("Web", "Android"). `control.labels` returns the
 * option label, never the legend, so without this a required-but-unanswered
 * group produced one message per option, each naming the option rather than
 * the question. Tried first only for a radio — a checkbox's own label already
 * names the right thing, and nothing else in this app groups controls this way.
 */
function legendFor(control: FormControl): string | null {
  if (!(control instanceof HTMLInputElement) || control.type !== 'radio') return null
  const legend = control.closest('fieldset')?.querySelector(':scope > legend')
  return legend ? textOf(legend) : null
}

/**
 * The field's visible label text.
 *
 * `Field` renders the required marker as an `aria-hidden` asterisk plus a
 * visually hidden "(required)", both of which are in the label's `textContent`
 * and neither of which belongs in a sentence. They are stripped from a clone
 * so the live DOM is untouched.
 */
export function labelFor(control: FormControl): string {
  const legend = legendFor(control)
  if (legend) return legend

  const label = control.labels?.[0]
  if (label) {
    const text = textOf(label)
    if (text) return text
  }
  const ariaLabel = control.getAttribute('aria-label')?.trim()
  if (ariaLabel) return ariaLabel
  return 'This field'
}

/**
 * Why this control is invalid, as one sentence.
 *
 * Ordered by how specific the answer is. `patternMismatch` defers to the
 * control's `title`, which is exactly what that attribute is for and what
 * `PhoneInput` already sets — so the phone rule is stated once and read here
 * rather than restated. The last line falls back to the browser's own wording,
 * which is still better than inventing a message for a constraint this list
 * has not met yet.
 */
export function describeInvalid(control: FormControl): string {
  const { validity } = control
  const label = labelFor(control)

  if (validity.valueMissing) {
    if (control instanceof HTMLSelectElement) return `Choose a ${label.toLowerCase()}.`
    if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      return `${label} has to be ticked.`
    }
    return `${label} is required.`
  }

  if (validity.typeMismatch) {
    const type = control instanceof HTMLInputElement ? control.type : ''
    if (type === 'email') return `${label} needs to be an email address, like name@example.com.`
    if (type === 'url') return `${label} needs to be a full URL, including https://`
  }

  if (validity.patternMismatch) {
    const title = control.title.trim()
    return title ? `${label}: ${lowerFirst(title)}` : `${label} is not in the expected format.`
  }

  // `minLength`/`maxLength` are on the two text controls, not on `<select>`.
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    if (validity.tooShort && control.minLength > 0) {
      return `${label} needs at least ${control.minLength} characters.`
    }
    if (validity.tooLong && control.maxLength > 0) {
      return `${label} can be at most ${control.maxLength} characters.`
    }
  }

  if (control instanceof HTMLInputElement) {
    if (validity.rangeUnderflow) return `${label} cannot be less than ${control.min}.`
    if (validity.rangeOverflow) return `${label} cannot be more than ${control.max}.`
    if (validity.stepMismatch) return `${label} is not one of the allowed values.`
  }

  return control.validationMessage.trim() || `${label} is not valid.`
}

/** "Between 7 and 15 digits." → "between 7 and 15 digits." — for use mid-sentence. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}
