'use client'

import { useState } from 'react'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Checkbox } from '@/components/ds/forms/Checkbox'

/**
 * Field types, and which of them are answered from a fixed list.
 *
 * Mirrors the API's `BugFieldType` enum. Kept as a literal rather than fetched
 * because the tester form has to be able to RENDER each one — a type this UI
 * does not know how to draw is not a type the platform can offer, so the two
 * are genuinely coupled and a runtime list would only hide that.
 */
const FIELD_TYPES = [
  { value: 'TEXT', label: 'Short text', choice: false },
  { value: 'TEXTAREA', label: 'Long text', choice: false },
  { value: 'NUMBER', label: 'Number', choice: false },
  { value: 'DATE', label: 'Date', choice: false },
  { value: 'URL', label: 'Link', choice: false },
  { value: 'SELECT', label: 'Dropdown', choice: true },
  { value: 'RADIO', label: 'Single choice', choice: true },
  { value: 'CHECKBOX', label: 'Multiple choice', choice: true },
] as const

const CHOICE_TYPES = FIELD_TYPES.filter((t) => t.choice).map((t) => t.value) as readonly string[]

export interface CustomFieldFormProps {
  /** The Server Action that creates the field. */
  action: (formData: FormData) => Promise<void>
  projectId: string
  buildId: string
  /** Section to return to, so the redirect lands where the user was. */
  section: string
}

/**
 * The Add Custom Bug Field form (§38).
 *
 * A client component for one reason: the option rows only exist for the choice
 * types, and that has to react to the type dropdown without a round trip. The
 * reference product shows the same behaviour — pick Dropdown and the options
 * appear.
 *
 * Options post as repeated `option` inputs rather than one comma-separated
 * string, so an option containing a comma is not silently split in two.
 */
export function CustomFieldForm({ action, projectId, buildId, section }: CustomFieldFormProps) {
  const [type, setType] = useState<string>('TEXT')
  /** One entry per option row. Empty rows are dropped by the action. */
  const [options, setOptions] = useState<string[]>([''])

  const needsOptions = CHOICE_TYPES.includes(type)

  return (
    <form
      action={action}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
    >
      <input type="hidden" name="id" value={projectId} />
      <input type="hidden" name="buildId" value={buildId} />
      <input type="hidden" name="section" value={section} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 'var(--space-5)',
        }}
      >
        <Field label="Field name" htmlFor="cf-name" required>
          <Input id="cf-name" name="name" required maxLength={80} placeholder="Environment" />
        </Field>
        <Field label="Field type" htmlFor="cf-type" required>
          <Select
            id="cf-type"
            name="type"
            value={type}
            onChange={(event) => setType(event.target.value)}
            options={FIELD_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          />
        </Field>
      </div>

      {needsOptions ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <span
            style={{
              fontSize: 'var(--type-body-sm-size)',
              fontWeight: 'var(--fw-medium)',
              color: 'var(--text-primary)',
            }}
          >
            Options
          </span>
          <span style={{ fontSize: 'var(--type-body-sm-size)', color: 'var(--text-secondary)' }}>
            What a tester can choose from. At least one is needed, and they must be different from
            each other.
          </span>

          {options.map((value, index) => (
            <div
              key={index}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
            >
              <label className="c4t-visually-hidden" htmlFor={`cf-option-${index}`}>
                Option {index + 1}
              </label>
              <Input
                id={`cf-option-${index}`}
                name="option"
                value={value}
                maxLength={120}
                placeholder={index === 0 ? 'Production' : 'Another option'}
                onChange={(event) =>
                  setOptions((prev) => prev.map((v, i) => (i === index ? event.target.value : v)))
                }
              />
              {/* The last remaining row is not removable — a choice field with
                  no options is refused by the API anyway, so offering to reach
                  that state would only produce an error. */}
              {options.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOptions((prev) => prev.filter((_, i) => i !== index))}
                >
                  <Icon name="x" size={16} />
                  <span className="c4t-visually-hidden">Remove option {index + 1}</span>
                </Button>
              ) : null}
            </div>
          ))}

          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              iconLeft="plus"
              onClick={() => setOptions((prev) => [...prev, ''])}
            >
              Add an option
            </Button>
          </div>
        </div>
      ) : null}

      <Checkbox
        id="cf-required"
        name="isRequired"
        label="Testers must answer this"
        description="A bug report cannot be submitted without it."
      />

      <div>
        <SubmitButton variant="primary" pendingLabel="Adding the field…">
          Add field
        </SubmitButton>
      </div>
    </form>
  )
}
