'use client'

import { useState } from 'react'
import { Field } from './Field'
import { Select, type SelectOption } from './Select'

/**
 * Two dependent selects where the second's options come from the first —
 * operating system and its version, browser and its version.
 *
 * ── WHY THIS FETCHES NOTHING
 *
 * `LocationSelect` reaches for `/app/geo` because the place data is ~17MB and
 * cannot ship to a browser. The catalog is the opposite: a few dozen
 * operating systems and browsers with their versions, already read on the
 * server for the page around it. So the whole tree arrives as a prop and the
 * dependency is a filter, not a round trip — no loading state, because there
 * is nothing to wait for.
 *
 * ── STALE SELECTIONS
 *
 * Changing the parent clears the child. A record claiming Android with a
 * version that only exists on iOS is worse than one with no version at all,
 * and it is the kind of thing nobody notices until a tester is assigned work
 * their device cannot run.
 *
 * ── EXISTING VALUES SURVIVE
 *
 * A stored value the catalog no longer offers — a browser version dropped
 * from the catalog, an OS an admin retired — is prepended rather than
 * discarded. Editing an old bug report must not silently rewrite the
 * environment it was found in. This is the same rule `LocationSelect` and
 * `CountrySelect` follow, for the same reason.
 */

export interface PairGroup {
  value: string
  label: string
  children: readonly SelectOption[]
}

export interface PairSelectProps {
  groups: readonly PairGroup[]
  parentName: string
  childName: string
  parentLabel: string
  childLabel: string
  parentPlaceholder?: string
  childPlaceholder?: string
  defaultParent?: string | null
  defaultChild?: string | null
  idPrefix: string
  /** Shown under the parent when the catalog had nothing to offer. */
  emptyHint?: string
}

function withCurrent(
  options: readonly SelectOption[],
  current: string | null | undefined,
): readonly SelectOption[] {
  const value = (current ?? '').trim()
  if (!value) return options
  if (options.some((o) => o.value === value)) return options
  return [{ value, label: value }, ...options]
}

export function PairSelect({
  groups,
  parentName,
  childName,
  parentLabel,
  childLabel,
  parentPlaceholder = 'Not specified',
  childPlaceholder = 'Not specified',
  defaultParent,
  defaultChild,
  idPrefix,
  emptyHint,
}: PairSelectProps) {
  const [parent, setParent] = useState(defaultParent ?? '')
  const [child, setChild] = useState(defaultChild ?? '')

  const parentOptions = withCurrent(
    groups.map((g) => ({ value: g.value, label: g.label })),
    defaultParent,
  )
  const childOptions = withCurrent(
    groups.find((g) => g.value === parent)?.children ?? [],
    // Only defend the value this render actually shows: once the reader has
    // switched parents, a leftover child is exactly what should disappear.
    parent === (defaultParent ?? '') ? defaultChild : null,
  )

  return (
    <>
      <Field
        label={parentLabel}
        htmlFor={`${idPrefix}-parent`}
        hint={groups.length === 0 ? emptyHint : undefined}
      >
        <Select
          id={`${idPrefix}-parent`}
          name={parentName}
          value={parent}
          onChange={(e) => {
            setParent(e.target.value)
            setChild('')
          }}
          options={parentOptions}
          placeholder={parentPlaceholder}
        />
      </Field>

      <Field label={childLabel} htmlFor={`${idPrefix}-child`}>
        <Select
          id={`${idPrefix}-child`}
          name={childName}
          value={child}
          onChange={(e) => setChild(e.target.value)}
          options={childOptions}
          placeholder={parent ? childPlaceholder : `Choose a ${parentLabel.toLowerCase()} first`}
          disabled={!parent || childOptions.length === 0}
        />
      </Field>
    </>
  )
}
