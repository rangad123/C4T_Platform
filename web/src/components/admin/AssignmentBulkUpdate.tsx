'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { titleCase } from '@/lib/admin/format'

/**
 * Move several assignments to the same status in one pass.
 *
 * ── WHY THIS REPLACED A DROPDOWN
 *
 * It was a `<select>` of every tester on the build, one status, one submit.
 * A build can carry a hundred and fifty testers, and picking them out of a
 * single-select one at a time means a hundred and fifty page round trips to
 * do what is nearly always one decision applied to a group — "everyone who
 * accepted is now active", "these twelve are done". The control could not
 * express the task.
 *
 * So: narrow by status, tick who you mean, set the new status once.
 *
 * ── WHY THE FILTER IS CLIENT-SIDE HERE
 *
 * `assignments` arrives embedded in the project read and holds at most one
 * row per tester per build — there is no page to fetch and nothing to
 * paginate, which is the same reason the roster panel above filters in place.
 * A server round trip would also throw away the ticks, which is the one piece
 * of state this component exists to hold.
 */

export interface AssignmentRow {
  testerId: string
  name: string
  email: string
  status: string
}

export interface AssignmentBulkUpdateProps {
  projectId: string
  buildId: string
  assignments: readonly AssignmentRow[]
  /** Statuses an assignment may be moved to. */
  statuses: readonly string[]
  action: (formData: FormData) => void | Promise<void>
}

export function AssignmentBulkUpdate({
  projectId,
  buildId,
  assignments,
  statuses,
  action,
}: AssignmentBulkUpdateProps) {
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  const visible = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
    return assignments.filter((row) => {
      if (statusFilter && row.status !== statusFilter) return false
      if (terms.length === 0) return true
      const haystack = `${row.name} ${row.email}`.toLowerCase()
      return terms.every((t) => haystack.includes(t))
    })
  }, [assignments, statusFilter, search])

  /*
    Selection is kept across filter changes on purpose: narrowing to Accepted,
    ticking eight, then narrowing to Invited and ticking four should submit
    twelve. The summary below says how many are chosen in total precisely
    because some of them may be out of view.
  */
  const visibleIds = useMemo(() => visible.map((r) => r.testerId), [visible])
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((testerId) => selected.has(testerId))

  function toggle(testerId: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(testerId)) next.delete(testerId)
      else next.add(testerId)
      return next
    })
  }

  function toggleAllVisible() {
    setSelected((current) => {
      const next = new Set(current)
      if (allVisibleSelected) for (const id of visibleIds) next.delete(id)
      else for (const id of visibleIds) next.add(id)
      return next
    })
  }

  const hiddenSelected = selected.size - visibleIds.filter((id) => selected.has(id)).length

  return (
    <form
      action={action}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
    >
      <input type="hidden" name="id" value={projectId} />
      <input type="hidden" name="buildId" value={buildId} />
      {/*
        The ticks travel as one hidden input each rather than as the checkbox
        inputs themselves: a checkbox that is filtered out of view is unmounted,
        and an unmounted control submits nothing — so filtering after choosing
        would silently drop those people from the update.
      */}
      {[...selected].map((testerId) => (
        <input key={testerId} type="hidden" name="testerIds" value={testerId} />
      ))}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        <Field label="Filter by status" htmlFor="bulk-status-filter">
          <Select
            id="bulk-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: '', label: `Any status (${assignments.length})` },
              ...statuses.map((value) => ({
                value,
                label: `${titleCase(value)} (${assignments.filter((r) => r.status === value).length})`,
              })),
            ]}
          />
        </Field>
        <Field label="Search" htmlFor="bulk-search">
          <Input
            id="bulk-search"
            type="search"
            iconLeft="search"
            value={search}
            placeholder="Name or email"
            onChange={(e) => setSearch(e.target.value)}
          />
        </Field>
      </div>

      <div
        style={{
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-panel)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            padding: 'var(--space-3) var(--space-4)',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--surface-sunken)',
            flexWrap: 'wrap',
          }}
        >
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <input
              type="checkbox"
              className="c4t-checkbox"
              checked={allVisibleSelected}
              disabled={visibleIds.length === 0}
              onChange={toggleAllVisible}
              style={{ width: 18, height: 18 }}
            />
            <span style={{ fontWeight: 'var(--fw-medium)' }}>
              {allVisibleSelected ? 'Clear these' : `Select these ${visibleIds.length}`}
            </span>
          </label>
          <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
            {selected.size} selected
            {hiddenSelected > 0 ? ` (${hiddenSelected} not shown by this filter)` : ''}
          </span>
        </div>

        {visible.length === 0 ? (
          <p style={{ margin: 0, padding: 'var(--space-5)', color: 'var(--text-secondary)' }}>
            No tester on this build matches that filter.
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              maxHeight: 340,
              overflowY: 'auto',
            }}
          >
            {visible.map((row) => (
              <li key={row.testerId}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-3) var(--space-4)',
                    borderBottom: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                    background: selected.has(row.testerId)
                      ? 'var(--surface-sunken)'
                      : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    className="c4t-checkbox"
                    checked={selected.has(row.testerId)}
                    onChange={() => toggle(row.testerId)}
                    style={{ flex: 'none', width: 18, height: 18 }}
                  />
                  <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 'var(--fw-medium)' }}>
                      {row.name}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        color: 'var(--text-secondary)',
                        fontSize: 'var(--type-body-sm-size)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row.email}
                    </span>
                  </span>
                  <StatusBadge status={row.status} />
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        <Field label="New assignment status" htmlFor="bulk-new-status" required>
          <Select
            id="bulk-new-status"
            name="status"
            required
            defaultValue="ACTIVE"
            options={statuses.map((value) => ({ value, label: titleCase(value) }))}
          />
        </Field>
      </div>

      <Field
        label="Note"
        htmlFor="bulk-notes"
        hint="Replaces the note on every assignment you selected. Leave blank to keep each one."
      >
        <Textarea id="bulk-notes" name="notes" rows={3} maxLength={1000} />
      </Field>

      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        {/*
          Disabled with nothing ticked, and the label says the number rather
          than "Update assignment" — with a bulk control the count IS the
          thing worth confirming before the click.
        */}
        <SubmitButton variant="secondary" pendingLabel="Updating…" disabled={selected.size === 0}>
          {selected.size === 0
            ? 'Select testers to update'
            : `Update ${selected.size} assignment${selected.size === 1 ? '' : 's'}`}
        </SubmitButton>
        {selected.size > 0 ? (
          <Button type="button" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        ) : null}
      </div>
    </form>
  )
}
