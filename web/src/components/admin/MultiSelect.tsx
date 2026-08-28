'use client'

import { useMemo, useState } from 'react'
import { Icon } from '@/components/ds/core/Icon'
import { Input } from '@/components/ds/forms/Input'

export interface MultiSelectOption {
  value: string
  label: string
}

export interface MultiSelectProps {
  /** Form field name. One hidden input is emitted per selected value. */
  name: string
  /** Everything selectable. Filtered client-side as the user types. */
  options: readonly MultiSelectOption[]
  /** Values selected on first render, e.g. carried in from a previous step. */
  defaultValue?: readonly string[]
  /** Placeholder for the search box. */
  placeholder?: string
  /** `id` of the search box, so a `<Field label>` can point at it. */
  id: string
  /**
   * Stop offering more once this many are chosen. The API caps these lists
   * (60 countries, 40 languages), and silently accepting more only to have
   * the request rejected is worse than saying so.
   */
  max?: number
}

/**
 * A searchable, chip-based multi-select that posts through a plain form.
 *
 * WHY THIS EXISTS. The country list is ~250 entries. A native `<select
 * multiple>` of that length is unusable — no search, and ctrl-click to
 * multi-select is close to undiscoverable — and a plain comma-separated text
 * box (what the create form used) asks the user to know ISO codes by heart.
 *
 * WHY IT POSTS HIDDEN INPUTS. Selection lives in React state, but what the
 * server receives is one `<input type="hidden">` per chosen value. So the
 * enclosing form stays an ordinary form: no controlled `<select multiple>` to
 * serialise, no JSON blob, and `formData.getAll(name)` on the other side.
 * That is also what lets the wizard carry a selection between steps as
 * ordinary form fields.
 *
 * Options are filtered, never re-ordered, so a list the caller sorted
 * deliberately keeps that order.
 */
export function MultiSelect({
  name,
  options,
  defaultValue = [],
  placeholder = 'Search…',
  id,
  max,
}: MultiSelectProps) {
  const [selected, setSelected] = useState<readonly string[]>(defaultValue)
  const [query, setQuery] = useState('')

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o.label])), [options])

  const atLimit = max !== undefined && selected.length >= max

  /**
   * Matches on label or value, so both "India" and "IN" find the same entry.
   * Already-selected values drop out of the list rather than rendering as
   * disabled rows — the chips above already show them.
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = options.filter((o) => !selected.includes(o.value))
    if (!q) return pool.slice(0, 8)
    return pool
      .filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
      .slice(0, 8)
  }, [options, query, selected])

  function add(value: string) {
    if (atLimit) return
    setSelected((prev) => (prev.includes(value) ? prev : [...prev, value]))
    setQuery('')
    /**
     * Refocus by id rather than a ref: `Input` extends
     * `InputHTMLAttributes`, which does not declare `ref`, and widening that
     * shared primitive for one call site is the wrong trade. The id is
     * required here anyway so a `<Field label>` can point at it.
     */
    document.getElementById(id)?.focus()
  }

  function remove(value: string) {
    setSelected((prev) => prev.filter((v) => v !== value))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {/* What the server actually reads. */}
      {selected.map((value) => (
        <input key={value} type="hidden" name={name} value={value} />
      ))}

      {selected.length > 0 ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
          }}
        >
          {selected.map((value) => (
            <li key={value}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  height: 28,
                  padding: '0 var(--space-2) 0 var(--space-3)',
                  borderRadius: 'var(--radius-full)',
                  background: 'var(--surface-sunken)',
                  border: '1px solid var(--border-default)',
                  fontSize: 'var(--type-body-sm-size)',
                }}
              >
                {byValue.get(value) ?? value}
                <button
                  type="button"
                  onClick={() => remove(value)}
                  aria-label={`Remove ${byValue.get(value) ?? value}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 20,
                    height: 20,
                    padding: 0,
                    border: 'none',
                    borderRadius: 'var(--radius-full)',
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <Input
        id={id}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={atLimit ? `That is the maximum of ${max}` : placeholder}
        disabled={atLimit}
        iconLeft="search"
        autoComplete="off"
      />

      {/*
        A plain list of buttons rather than a combobox listbox: it needs no
        active-descendant bookkeeping, every option is a real focusable control
        in tab order, and it works identically with a screen reader.
      */}
      {!atLimit && matches.length > 0 ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
          }}
        >
          {matches.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                onClick={() => add(option.value)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  height: 28,
                  padding: '0 var(--space-3)',
                  borderRadius: 'var(--radius-full)',
                  background: 'var(--surface-canvas)',
                  border: '1px dashed var(--border-default)',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--type-body-sm-size)',
                  fontFamily: 'var(--font-sans)',
                  cursor: 'pointer',
                }}
              >
                <Icon name="plus" size={14} />
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {query.trim() && matches.length === 0 && !atLimit ? (
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
          Nothing matches “{query.trim()}”.
        </p>
      ) : null}
    </div>
  )
}
