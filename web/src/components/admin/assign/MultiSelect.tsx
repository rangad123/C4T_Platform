'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '@/components/ds/core/Icon'

export interface MultiSelectProps {
  label: string
  options: readonly { value: string; label: string }[]
  /** The whole selection across every category — this control edits its own slice. */
  selected: readonly string[]
  onChange: (next: string[]) => void
}

/**
 * A compact multi-select for one skill category.
 *
 * Replaces the oversized filter popup: a labelled button that opens a short
 * checkbox list, closes on outside click and on Escape, and reports how many
 * of its own options are chosen. Native `<select multiple>` was the other
 * option and is worse — it needs ctrl-click to deselect, cannot show a count,
 * and on a phone renders as a scrolling column that fills the screen.
 *
 * `selected` is the FULL slug list rather than this category's, because the
 * API takes one `skills` parameter. The control only ever adds or removes its
 * own options, so several of these compose without knowing about each other.
 */
export function MultiSelect({ label, options, selected, onChange }: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const id = useId()

  const ownValues = options.map((o) => o.value)
  const chosen = selected.filter((s) => ownValues.includes(s))

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function toggle(value: string) {
    onChange(
      selected.includes(value) ? selected.filter((s) => s !== value) : [...selected, value],
    )
  }

  return (
    <div ref={wrapper} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        id={`${id}-label`}
        style={{
          fontSize: 'var(--type-label-size)',
          fontWeight: 'var(--fw-medium)',
          color: 'var(--text-primary)',
        }}
      >
        {label}
      </span>
      <button
        type="button"
        className="c4t-input"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label`}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          minHeight: 44,
          padding: '10px 12px',
          textAlign: 'left',
          cursor: 'pointer',
          color: chosen.length > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {chosen.length === 0 ? `Any ${label.toLowerCase()}` : `${chosen.length} selected`}
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-multiselectable
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 20,
            maxHeight: 240,
            overflowY: 'auto',
            padding: 'var(--space-2)',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-default)',
            background: 'var(--surface-raised)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {options.map((option) => (
            <label
              key={option.value}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                padding: '6px 8px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                fontSize: 'var(--type-body-sm-size)',
              }}
            >
              <input
                type="checkbox"
                className="c4t-checkbox"
                checked={selected.includes(option.value)}
                onChange={() => toggle(option.value)}
                style={{ width: 16, height: 16 }}
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}
