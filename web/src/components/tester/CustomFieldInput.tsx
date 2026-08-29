import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'

export interface CustomFieldInputProps {
  field: {
    id: string
    name: string
    type: string
    options: readonly string[]
    isRequired: boolean
  }
}

/**
 * One of the client's extra bug questions, rendered as the right control.
 *
 * ── HOW THE ANSWER REACHES THE SERVER
 *
 * Every control posts under the name `custom:<fieldId>`. The action pairs each
 * such key back to its field id, so the form needs no parallel list of ids and
 * no JSON blob — and a field removed between page load and submit simply has
 * no matching definition server-side, which the API already rejects.
 *
 * CHECKBOX is the one type that can produce several values. The browser posts
 * one entry per ticked box under the same name, and the action joins them with
 * a newline — the separator the schema documents, chosen because an option
 * label is single-line text and cannot contain one.
 *
 * A Server Component: none of these controls needs state, only the right
 * `name` and `type`.
 */
export function CustomFieldInput({ field }: CustomFieldInputProps) {
  const name = `custom:${field.id}`
  const id = `custom-${field.id}`

  if (field.type === 'TEXTAREA') {
    return (
      <Field label={field.name} htmlFor={id} required={field.isRequired}>
        <Textarea id={id} name={name} rows={4} maxLength={4000} required={field.isRequired} />
      </Field>
    )
  }

  if (field.type === 'SELECT') {
    return (
      <Field label={field.name} htmlFor={id} required={field.isRequired}>
        <Select
          id={id}
          name={name}
          required={field.isRequired}
          defaultValue=""
          options={[
            { value: '', label: field.isRequired ? 'Choose one' : 'Not specified' },
            ...field.options.map((o) => ({ value: o, label: o })),
          ]}
        />
      </Field>
    )
  }

  if (field.type === 'RADIO' || field.type === 'CHECKBOX') {
    const inputType = field.type === 'RADIO' ? 'radio' : 'checkbox'
    return (
      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend
          style={{
            padding: 0,
            marginBottom: 'var(--space-3)',
            fontSize: 'var(--type-body-sm-size)',
            fontWeight: 'var(--fw-medium)',
            color: 'var(--text-primary)',
          }}
        >
          {field.name}
          {field.isRequired ? (
            <>
              <span aria-hidden="true"> *</span>
              <span className="c4t-visually-hidden"> (required)</span>
            </>
          ) : null}
        </legend>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {field.options.map((option, index) => (
            <label
              key={option}
              htmlFor={`${id}-${index}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                fontSize: 'var(--type-body-sm-size)',
                color: 'var(--text-primary)',
              }}
            >
              <input
                id={`${id}-${index}`}
                type={inputType}
                name={name}
                value={option}
                /* Required on a radio group means "pick one", so it goes on
                   every member; on checkboxes the browser would demand EVERY
                   box, so the API enforces that one instead. */
                required={field.isRequired && field.type === 'RADIO'}
              />
              {option}
            </label>
          ))}
        </div>
      </fieldset>
    )
  }

  const inputType =
    field.type === 'NUMBER' ? 'number' : field.type === 'DATE' ? 'date' : field.type === 'URL' ? 'url' : 'text'

  return (
    <Field
      label={field.name}
      htmlFor={id}
      required={field.isRequired}
      hint={field.type === 'URL' ? 'Include http:// or https://.' : undefined}
    >
      <Input
        id={id}
        name={name}
        type={inputType}
        required={field.isRequired}
        maxLength={inputType === 'text' || inputType === 'url' ? 4000 : undefined}
      />
    </Field>
  )
}
