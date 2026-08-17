'use client'

/**
 * A `<select>` that, when the user picks a template, copies its subject and
 * body into the sibling form fields it's told to target.
 *
 * This is the one genuinely interactive piece a template system needs
 * ("Selecting a template populates the message") and it cannot be done
 * without client JS — a plain `<select>` has no way to write into two other
 * inputs on change. Kept as a small, self-contained leaf so the composer
 * pages around it stay Server Components; only this one control ships JS.
 *
 * Subject and body are read from data attributes on each `<option>` rather
 * than fetched again on selection — the whole template set is already on
 * the page (there's no pagination on the API side, template counts are
 * small), so re-fetching per pick would just be a slower, network-dependent
 * version of data already sitting in the DOM.
 */
export interface TemplateOption {
  id: string
  name: string
  subject: string | null
  body: string
}

export interface TemplatePickerProps {
  templates: readonly TemplateOption[]
  /** `id` of the subject `<input>` this picker should fill. Omit if the form has no subject field. */
  subjectFieldId?: string
  /** `id` of the body `<textarea>` this picker should fill. */
  bodyFieldId: string
}

export function TemplatePicker({ templates, subjectFieldId, bodyFieldId }: TemplatePickerProps) {
  if (templates.length === 0) return null

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const id = event.target.value
    if (!id) return
    const template = templates.find((t) => t.id === id)
    if (!template) return

    if (subjectFieldId && template.subject) {
      const subjectEl = document.getElementById(subjectFieldId)
      if (subjectEl instanceof HTMLInputElement) subjectEl.value = template.subject
    }
    const bodyEl = document.getElementById(bodyFieldId)
    if (bodyEl instanceof HTMLTextAreaElement) {
      bodyEl.value = template.body
      // Dirty-tracking (TrackedForm/UnsavedChangesWarning) listens for real
      // DOM events, not property assignment — a direct `.value =` write is
      // invisible to it, so this dispatches the event by hand.
      bodyEl.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // Reset the picker itself so it reads as an action ("apply this
    // template") rather than a persistent selection the user might expect
    // to stay in sync with further edits.
    event.target.value = ''
  }

  return (
    <select
      aria-label="Insert a template"
      defaultValue=""
      onChange={handleChange}
      style={{
        padding: 'var(--space-2) var(--space-3)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-input)',
        background: 'var(--surface-canvas)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--type-body-sm-size)',
      }}
    >
      <option value="">Insert a template…</option>
      {templates.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  )
}
