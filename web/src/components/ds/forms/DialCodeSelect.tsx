'use client'

import { useState } from 'react'
import { Icon } from '../core/Icon'
import { controlBase } from './Input'
import type { SelectOption } from './Select'

/** The part of a "+91 · India" label before the separator — what the closed box shows. */
function codeOnly(label: string): string {
  return label.split(' · ')[0] ?? label
}

function labelFor(options: readonly SelectOption[], value: string, placeholder: string): string {
  const match = options.find((o) => o.value === value)
  return match ? codeOnly(match.label) : placeholder
}

/**
 * The dial-code picker, as its own small client component — NOT the shared
 * `Select`, because this one needs to show different text in two places at
 * once: the OPEN dropdown lists full "+91 · India" labels (see
 * `dialCodeOptions` in `lib/geo/source.ts`), but the CLOSED box shows only
 * the code. A native `<select>` has no way to do that on its own — the
 * closed box and the dropdown both render from the same option text — so
 * this layers a real, fully-native `<select>` (unchanged: full labels, full
 * keyboard/screen-reader behaviour, a real focus ring from the shared
 * `.c4t-input:focus` rule) underneath a purely decorative code-only label,
 * the same way the chevron icon already overlays the shared `Select`.
 *
 * The select's own text is `color: transparent` — NOT `opacity: 0` — on
 * purpose: opacity would also hide the border, background and focus
 * outline, which have their own explicit colours in `controlBase` and the
 * `.c4t-input:focus` rule and so stay fully visible regardless of the
 * element's own (invisible) text colour. Each `<option>` gets its colour
 * set back explicitly, since `color` would otherwise inherit as
 * transparent into the dropdown too.
 *
 * The one bit of client JS this needs is keeping the decorative label in
 * sync with the real selection on `change` — everything else (opening the
 * list, moving through it, submitting the chosen value) is the native
 * select doing what it already does.
 */
export function DialCodeSelect({
  id,
  name,
  defaultValue,
  options,
  placeholder = '',
  required = false,
  invalid = false,
  style,
}: {
  id: string
  name: string
  defaultValue: string
  options: readonly SelectOption[]
  placeholder?: string
  required?: boolean
  invalid?: boolean
  style?: React.CSSProperties
}) {
  const [code, setCode] = useState(() => labelFor(options, defaultValue, placeholder))

  return (
    <span style={{ position: 'relative', display: 'block', ...style }}>
      <select
        id={id}
        name={name}
        className="c4t-input"
        defaultValue={defaultValue}
        required={required}
        aria-invalid={invalid ? true : undefined}
        onChange={(event) => setCode(labelFor(options, event.target.value, placeholder))}
        style={{
          ...controlBase,
          appearance: 'none',
          paddingRight: 40,
          cursor: 'pointer',
          color: 'transparent',
        }}
      >
        <option value="" style={{ color: 'var(--text-primary)' }}>
          {placeholder}
        </option>
        {options.map((option, index) => (
          // Index in the key, not just `value` — several countries share a
          // dial code (`+1` for the US, Canada, …), and duplicate keys make
          // React drop or duplicate the extra rows.
          <option
            key={`${option.value}-${index}`}
            value={option.value}
            style={{ color: 'var(--text-primary)' }}
          >
            {option.label}
          </option>
        ))}
      </select>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 14,
          paddingRight: 40,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--type-body-md-size)',
          color: code === placeholder ? 'var(--text-disabled)' : 'var(--text-primary)',
        }}
      >
        {code}
      </span>
      <Icon
        name="chevron-down"
        size={18}
        style={{
          position: 'absolute',
          right: 14,
          top: '50%',
          transform: 'translateY(-50%)',
          color: 'var(--text-muted)',
          pointerEvents: 'none',
        }}
      />
    </span>
  )
}
