'use client'

import { useMemo, useState, useTransition } from 'react'
import { Icon } from '@/components/ds/core/Icon'
import { Input } from '@/components/ds/forms/Input'

export interface TagOption {
  id: string
  name: string
  slug: string
}

export interface TagComboboxProps {
  /** Hidden input name each selected tag's id is posted under — repeat field, read with `formData.getAll(name)`. */
  name: string
  allTags: readonly TagOption[]
  defaultSelected: readonly TagOption[]
  /**
   * A Server Action, passed down from the page — finds an existing tag by
   * case-insensitive name or creates one. §71 of the blog spec: tags are
   * managed entirely from here, there is no separate tag admin page.
   */
  findOrCreateTag: (name: string) => Promise<TagOption>
}

/**
 * Tag picker: chips for what's selected, a text field that filters the
 * existing tag list client-side (there's no live search endpoint — the full
 * list is small enough to filter in memory, matching the "don't build
 * unnecessary complexity" note in the spec), and a "Create" option when the
 * typed name matches nothing.
 */
export function TagCombobox({ name, allTags, defaultSelected, findOrCreateTag }: TagComboboxProps) {
  const [selected, setSelected] = useState<TagOption[]>(() => [...defaultSelected])
  const [query, setQuery] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const trimmedQuery = query.trim()

  const matches = useMemo(() => {
    if (!trimmedQuery) return []
    const q = trimmedQuery.toLowerCase()
    const selectedIds = new Set(selected.map((t) => t.id))
    return allTags
      .filter((t) => !selectedIds.has(t.id) && t.name.toLowerCase().includes(q))
      .slice(0, 8)
  }, [trimmedQuery, allTags, selected])

  const exactMatch = allTags.some((t) => t.name.toLowerCase() === trimmedQuery.toLowerCase())

  function addTag(tag: TagOption) {
    setSelected((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]))
    setQuery('')
  }

  function removeTag(id: string) {
    setSelected((prev) => prev.filter((t) => t.id !== id))
  }

  function createTag() {
    if (!trimmedQuery) return
    setError(null)
    startTransition(async () => {
      try {
        const tag = await findOrCreateTag(trimmedQuery)
        addTag(tag)
      } catch {
        setError('Could not create that tag. Try again.')
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {selected.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          {selected.map((tag) => (
            <span
              key={tag.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 4px 4px 10px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-sunken)',
                border: '1px solid var(--border-default)',
                fontSize: 'var(--type-caption-size)',
                color: 'var(--text-primary)',
              }}
            >
              <input type="hidden" name={name} value={tag.id} />
              {tag.name}
              <button
                type="button"
                onClick={() => removeTag(tag.id)}
                aria-label={`Remove ${tag.name}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 18,
                  borderRadius: 'var(--radius-full)',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div style={{ position: 'relative' }}>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search or create a tag"
          iconLeft="tag"
        />
        {trimmedQuery ? (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
              padding: 'var(--space-2)',
              background: 'var(--surface-raised)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-md)',
              maxHeight: 240,
              overflowY: 'auto',
            }}
          >
            {matches.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => addTag(tag)}
                style={{
                  textAlign: 'left',
                  padding: 'var(--space-2) var(--space-3)',
                  border: 'none',
                  background: 'transparent',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontSize: 'var(--type-body-sm-size)',
                  cursor: 'pointer',
                }}
              >
                {tag.name}
              </button>
            ))}
            {!exactMatch ? (
              <button
                type="button"
                onClick={createTag}
                disabled={pending}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  textAlign: 'left',
                  padding: 'var(--space-2) var(--space-3)',
                  border: 'none',
                  background: 'transparent',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-brand)',
                  fontSize: 'var(--type-body-sm-size)',
                  cursor: pending ? 'default' : 'pointer',
                  opacity: pending ? 0.6 : 1,
                }}
              >
                <Icon name="plus" size={14} />
                Create &quot;{trimmedQuery}&quot;
              </button>
            ) : null}
            {matches.length === 0 && exactMatch ? (
              <span
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  color: 'var(--text-muted)',
                  fontSize: 'var(--type-body-sm-size)',
                }}
              >
                Already added
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          style={{
            margin: 0,
            color: 'var(--status-error-fg)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
