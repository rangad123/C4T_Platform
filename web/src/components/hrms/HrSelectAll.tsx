'use client'

import { useId } from 'react'
import { Checkbox } from '@/components/ds/forms/Checkbox'

/**
 * Ticks or clears every checkbox that belongs to a form, from outside it.
 *
 * The row checkboxes sit inside a table the page shell renders, so they cannot
 * be children of the form that submits them. They point at it with the `form`
 * attribute instead, and this control finds them the same way. The boxes are
 * uncontrolled DOM inputs, so setting `checked` directly is all it takes — no
 * shared state to keep in step.
 */
export function HrSelectAll({
  formId,
  name,
  label,
}: {
  formId: string
  name: string
  label: string
}) {
  const id = useId()

  return (
    <Checkbox
      id={id}
      label={label}
      onChange={(event) => {
        const checked = event.currentTarget.checked
        document
          .querySelectorAll<HTMLInputElement>(
            `input[type="checkbox"][name="${name}"][form="${formId}"]`,
          )
          .forEach((box) => {
            if (!box.disabled) box.checked = checked
          })
      }}
    />
  )
}
