'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Avatar } from '@/components/admin/Avatar'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { Spinner } from '@/components/ds/core/Spinner'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { TesterDetailDrawer } from './TesterDetailDrawer'
import { MultiSelect } from './MultiSelect'
import type { Candidate, CandidateMeta, FilterOptions, Filters } from './types'
import {
  ASSIGNABLE_AGAIN,
  RECIPIENT_STATUSES,
  describeAssignment,
  filterChips,
  personLabel,
} from './types'

/**
 * Find testers, look at them, choose some. Used by both places that do it.
 *
 * ── WHY THIS IS ITS OWN COMPONENT
 *
 * Two workflows ask the identical question — "which testers do I want?" —
 * and then do entirely different things with the answer: the assignment
 * workspace puts them on a build, the message composer sends them something.
 * The finding half was written first for assignment; when the composer needed
 * it, copying ~450 lines would have meant two search boxes that drift apart,
 * two race guards to keep correct, and a filter fixed in one place and still
 * broken in the other.
 *
 * So the parent owns the selection and what it is FOR; this owns finding.
 * Selection is passed in and back out rather than held here, because the
 * parent is what survives a step change (find → configure → confirm) and
 * would otherwise lose it.
 *
 * ── WHY IT FETCHES FROM THE CLIENT
 *
 * Selection has to survive typing, filtering, opening a tester and paging. If
 * each of those were a server navigation the list would re-render from the
 * top and the chosen testers would have to be carried in the URL — which does
 * not scale past a handful. `API_ORIGIN` is server-side only, so the browser
 * goes through a same-origin route handler; `endpoint` names which one.
 */

const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 300

export const EMPTY_FILTERS: Filters = {
  search: '',
  countryCode: '',
  city: '',
  status: 'VERIFIED',
  minRating: '',
  osName: '',
  browser: '',
  skills: [],
}

export interface TesterPickerProps {
  /** Same-origin route handler that answers the search. */
  endpoint: string
  /** Sent on every request. The assignment picker passes its `buildId` here. */
  fixedQuery?: Readonly<Record<string, string>>
  options: FilterOptions
  /** Rendered by the server so the first paint has rows, not a spinner. */
  initialCandidates: readonly Candidate[]
  initialMeta: CandidateMeta
  /** Keyed by `user.id` — that is what both the assign and broadcast APIs take. */
  selected: Map<string, Candidate>
  onSelectionChange: (next: Map<string, Candidate>) => void
  /**
   * Drawer context. Only ever rendered for a candidate who already holds a
   * standing on a build, which no broadcast recipient does — so the composer
   * leaves both unset and the strings are never reached.
   */
  buildName?: string
  projectLabel?: string
  /** What the sticky summary offers once something is chosen. */
  summaryAction: ReactNode
  /** Shown when nothing matches and no filter is to blame. */
  emptyMessage?: string
  /** Field id prefix, so two pickers on one page never collide. */
  idPrefix?: string
  /**
   * Offer the tester-status filter. The composer does; the assignment picker
   * does not — see `RECIPIENT_STATUSES` for why widening it there would list
   * people the caller cannot actually assign.
   */
  showStatusFilter?: boolean
}

export function TesterPicker({
  endpoint,
  fixedQuery,
  options,
  initialCandidates,
  initialMeta,
  selected,
  onSelectionChange,
  buildName = '',
  projectLabel = '',
  summaryAction,
  emptyMessage = 'No testers are available yet.',
  idPrefix = 'picker',
  showStatusFilter = false,
}: TesterPickerProps) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<readonly Candidate[]>(initialCandidates)
  const [meta, setMeta] = useState<CandidateMeta>(initialMeta)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailOf, setDetailOf] = useState<Candidate | null>(null)

  /**
   * Guards against a slow response overwriting a fast one. Without it, typing
   * "chr" then "chrome" can leave the "chr" results on screen if the first
   * request lands second — the classic search race.
   */
  const requestSeq = useRef(0)

  /**
   * Read through a ref so a caller passing an inline object literal does not
   * re-create `load` on every render and re-fire the search forever.
   */
  const fixedRef = useRef(fixedQuery)
  fixedRef.current = fixedQuery

  const load = useCallback(
    async (nextFilters: Filters, nextPage: number) => {
      const seq = ++requestSeq.current
      setLoading(true)
      setError(null)

      const params = new URLSearchParams({
        ...(fixedRef.current ?? {}),
        page: String(nextPage),
        limit: String(PAGE_SIZE),
        sort: 'ratingAverage',
        order: 'desc',
      })
      if (nextFilters.search) params.set('search', nextFilters.search)
      if (nextFilters.countryCode) params.set('countryCode', nextFilters.countryCode)
      if (nextFilters.city) params.set('city', nextFilters.city)
      if (nextFilters.status) params.set('status', nextFilters.status)
      if (nextFilters.minRating) params.set('minRating', nextFilters.minRating)
      if (nextFilters.osName) params.set('osName', nextFilters.osName)
      if (nextFilters.browser) params.set('browser', nextFilters.browser)
      if (nextFilters.skills.length > 0) params.set('skills', nextFilters.skills.join(','))

      try {
        const response = await fetch(`${endpoint}?${params.toString()}`, { cache: 'no-store' })
        const payload = (await response.json()) as {
          data?: Candidate[]
          meta?: CandidateMeta
          error?: string
        }
        // A superseded request must not touch state, even to report a failure.
        if (seq !== requestSeq.current) return

        if (!response.ok || !payload.data) {
          setError(payload.error ?? 'Could not search testers. Try again.')
          return
        }
        setRows(payload.data)
        if (payload.meta) setMeta(payload.meta)
      } catch {
        if (seq !== requestSeq.current) return
        setError('Could not reach the server. Check your connection and try again.')
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [endpoint],
  )

  /**
   * Debounced on the search box only. A dropdown change is a deliberate act
   * and should feel immediate; a keystroke is not, and firing per character
   * would put a request behind every letter.
   */
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const timer = setTimeout(() => void load(filters, page), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filters, page, load])

  const update = useCallback((patch: Partial<Filters>) => {
    setPage(1)
    setFilters((current) => ({ ...current, ...patch }))
  }, [])

  const clearAll = useCallback(() => {
    setPage(1)
    setFilters(EMPTY_FILTERS)
  }, [])

  const toggle = useCallback(
    (candidate: Candidate) => {
      const next = new Map(selected)
      if (next.has(candidate.user.id)) next.delete(candidate.user.id)
      else next.set(candidate.user.id, candidate)
      onSelectionChange(next)
    },
    [selected, onSelectionChange],
  )

  /** Only the rows that can actually be chosen — already-assigned are skipped. */
  const selectableRows = useMemo(
    () => rows.filter((row) => !row.assignment || ASSIGNABLE_AGAIN.has(row.assignment.status)),
    [rows],
  )
  const allVisibleSelected =
    selectableRows.length > 0 && selectableRows.every((row) => selected.has(row.user.id))

  const toggleAllVisible = useCallback(() => {
    const next = new Map(selected)
    const everySelected = selectableRows.every((row) => next.has(row.user.id))
    for (const row of selectableRows) {
      if (everySelected) next.delete(row.user.id)
      else next.set(row.user.id, row)
    }
    onSelectionChange(next)
  }, [selectableRows, selected, onSelectionChange])

  const chips = useMemo(() => filterChips(filters, options), [filters, options])
  const totalPages = Math.max(1, Math.ceil((meta.total ?? 0) / PAGE_SIZE))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <section
        aria-label="Find testers"
        style={{
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-panel)',
          background: 'var(--surface-raised)',
          padding: 'var(--space-5)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <div style={FILTER_GRID}>
          <Field
            label="Search"
            htmlFor={`${idPrefix}-search`}
            hint="Name, email, headline or profession."
          >
            <Input
              id={`${idPrefix}-search`}
              type="search"
              iconLeft="search"
              value={filters.search}
              placeholder="Search testers…"
              onChange={(e) => update({ search: e.target.value })}
            />
          </Field>
          <Field label="Country" htmlFor={`${idPrefix}-country`}>
            <Select
              id={`${idPrefix}-country`}
              value={filters.countryCode}
              onChange={(e) => update({ countryCode: e.target.value })}
              options={[{ value: '', label: 'Any country' }, ...options.countries]}
            />
          </Field>
          <Field label="City" htmlFor={`${idPrefix}-city`}>
            <Input
              id={`${idPrefix}-city`}
              value={filters.city}
              placeholder="Any city"
              onChange={(e) => update({ city: e.target.value })}
            />
          </Field>
          <Field label="Operating system" htmlFor={`${idPrefix}-os`}>
            <Select
              id={`${idPrefix}-os`}
              value={filters.osName}
              onChange={(e) => update({ osName: e.target.value })}
              options={[{ value: '', label: 'Any OS' }, ...options.operatingSystems]}
            />
          </Field>
          <Field label="Browser" htmlFor={`${idPrefix}-browser`}>
            <Select
              id={`${idPrefix}-browser`}
              value={filters.browser}
              onChange={(e) => update({ browser: e.target.value })}
              options={[{ value: '', label: 'Any browser' }, ...options.browsers]}
            />
          </Field>
          {showStatusFilter ? (
            <Field
              label="Tester status"
              htmlFor={`${idPrefix}-status`}
              hint="Verified testers only, unless you widen this."
            >
              <Select
                id={`${idPrefix}-status`}
                value={filters.status}
                onChange={(e) => update({ status: e.target.value })}
                options={RECIPIENT_STATUSES}
              />
            </Field>
          ) : null}
          <Field label="Minimum rating" htmlFor={`${idPrefix}-rating`}>
            <Select
              id={`${idPrefix}-rating`}
              value={filters.minRating}
              onChange={(e) => update({ minRating: e.target.value })}
              options={[
                { value: '', label: 'Any rating' },
                { value: '4', label: '4 and above' },
                { value: '3', label: '3 and above' },
                { value: '2', label: '2 and above' },
              ]}
            />
          </Field>
        </div>

        {/*
          One multi-select per skill CATEGORY rather than one giant skill box.
          The catalog already groups them — Type of Testing, Domain Knowledge,
          Applications Tested, Testing Tools — and collapsing four questions
          into one list is what made the old filter unusable.
        */}
        <div style={FILTER_GRID}>
          {options.skillCategories.map((category) => (
            <MultiSelect
              key={category.slug}
              label={category.name}
              options={category.skills}
              selected={filters.skills}
              onChange={(slugs) => update({ skills: slugs })}
            />
          ))}
        </div>

        {chips.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
              alignItems: 'center',
              paddingTop: 'var(--space-3)',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => update(chip.clear)}
                className="c4t-btn"
                style={CHIP_STYLE}
                aria-label={`Remove filter ${chip.label}`}
              >
                {chip.label}
                <Icon name="x" size={12} />
              </button>
            ))}
            <button type="button" onClick={clearAll} style={CLEAR_ALL_STYLE}>
              Clear all
            </button>
          </div>
        ) : null}
      </section>

      <section
        aria-label="Tester results"
        style={{
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-panel)',
          background: 'var(--surface-raised)',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            padding: 'var(--space-4) var(--space-5)',
            borderBottom: '1px solid var(--border-subtle)',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <strong style={{ fontSize: 'var(--type-body-md-size)' }}>
              {meta.total} tester{meta.total === 1 ? '' : 's'}
            </strong>
            {loading ? <Spinner size={16} /> : null}
          </span>
          {selectableRows.length > 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={toggleAllVisible}>
              {allVisibleSelected ? 'Clear these' : `Select these ${selectableRows.length}`}
            </Button>
          ) : null}
        </header>

        {error ? (
          <div style={{ padding: 'var(--space-6) var(--space-5)' }}>
            <p role="alert" style={{ margin: 0, color: 'var(--status-error-fg)' }}>
              {error}
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              style={{ marginTop: 'var(--space-4)' }}
              onClick={() => void load(filters, page)}
            >
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 'var(--space-8) var(--space-5)', textAlign: 'center' }}>
            <Icon name="users-round" size={24} style={CENTRED_ICON} />
            <p style={{ margin: 'var(--space-3) 0 0', color: 'var(--text-secondary)' }}>
              {chips.length > 0
                ? 'No tester matches these filters. Try removing one.'
                : emptyMessage}
            </p>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map((row) => (
              <CandidateRow
                key={row.user.id}
                candidate={row}
                checked={selected.has(row.user.id)}
                onToggle={() => toggle(row)}
                onOpen={() => setDetailOf(row)}
              />
            ))}
          </ul>
        )}

        {totalPages > 1 ? (
          <footer
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              padding: 'var(--space-4) var(--space-5)',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              iconLeft="chevron-left"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
              Page {page} of {totalPages}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              iconRight="chevron-right"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </footer>
        ) : null}
      </section>

      {selected.size > 0 ? (
        <div
          role="status"
          style={{
            position: 'sticky',
            bottom: 0,
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            flexWrap: 'wrap',
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-panel)',
            border: '1px solid var(--border-strong)',
            background: 'var(--surface-inverse)',
            color: 'var(--text-inverse)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <span style={{ fontWeight: 'var(--fw-medium)' }}>
            {selected.size} tester{selected.size === 1 ? '' : 's'} selected
          </span>
          <span style={{ display: 'inline-flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSelectionChange(new Map())}
            >
              Clear selection
            </Button>
            {summaryAction}
          </span>
        </div>
      ) : null}

      <TesterDetailDrawer
        candidate={detailOf}
        buildName={buildName}
        projectLabel={projectLabel}
        onClose={() => setDetailOf(null)}
        onToggle={detailOf ? () => toggle(detailOf) : undefined}
        selected={detailOf ? selected.has(detailOf.user.id) : false}
      />
    </div>
  )
}

/** One result. Compact by design — everything here helps decide, nothing decorates. */
function CandidateRow({
  candidate,
  checked,
  onToggle,
  onOpen,
}: {
  candidate: Candidate
  checked: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const standing = describeAssignment(candidate.assignment)
  const blocked = Boolean(standing && !standing.assignableAgain)
  const skills = candidate.skills.slice(0, 3)

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-4) var(--space-5)',
        borderBottom: '1px solid var(--border-subtle)',
        background: checked ? 'var(--surface-sunken)' : 'transparent',
        opacity: blocked ? 0.62 : 1,
      }}
    >
      <input
        type="checkbox"
        className="c4t-checkbox"
        checked={checked}
        disabled={blocked}
        onChange={onToggle}
        aria-label={`Select ${personLabel(candidate)}`}
        style={{ flex: 'none', width: 18, height: 18, cursor: blocked ? 'not-allowed' : 'pointer' }}
      />

      <Avatar name={personLabel(candidate)} fileId={candidate.user.avatarFileId} size="sm" />

      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}
        >
          <span style={{ fontWeight: 'var(--fw-medium)', color: 'var(--text-primary)' }}>
            {personLabel(candidate)}
          </span>
          {standing ? (
            <Badge tone={standing.tone} uppercase={false}>
              {standing.label}
            </Badge>
          ) : null}
        </div>
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
          {[candidate.profession ?? candidate.headline, locationOf(candidate)]
            .filter(Boolean)
            .join(' · ') || '—'}
        </span>
      </div>

      <div style={{ flex: '1 1 180px', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {skills.map((s) => (
          <Badge key={s.skill.slug} tone="neutral" uppercase={false}>
            {s.skill.name}
          </Badge>
        ))}
        {candidate.skills.length > skills.length ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
            +{candidate.skills.length - skills.length}
          </span>
        ) : null}
      </div>

      <span style={COLUMN_META} title="Rating">
        {candidate.ratingAverage ? `★ ${candidate.ratingAverage}` : '—'}
      </span>
      <span style={COLUMN_META} title="Devices and browsers">
        {candidate.devices.length}d / {candidate.browsers.length}b
      </span>

      <Button type="button" variant="ghost" size="sm" onClick={onOpen}>
        View details
      </Button>
    </li>
  )
}

function locationOf(candidate: Candidate): string {
  return [candidate.city, candidate.countryCode].filter(Boolean).join(', ')
}

const FILTER_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
  gap: 'var(--space-4)',
} as const

const COLUMN_META = {
  flex: '0 0 auto',
  minWidth: 62,
  textAlign: 'right' as const,
  color: 'var(--text-secondary)',
  fontSize: 'var(--type-body-sm-size)',
  fontFamily: 'var(--font-mono)',
}

const CHIP_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 26,
  padding: '0 10px',
  borderRadius: 'var(--radius-full)',
  border: '1px solid var(--border-default)',
  background: 'var(--surface-sunken)',
  color: 'var(--text-primary)',
  fontSize: 'var(--type-body-sm-size)',
  cursor: 'pointer',
} as const

const CLEAR_ALL_STYLE = {
  border: 'none',
  background: 'none',
  padding: 0,
  color: 'var(--text-brand)',
  fontSize: 'var(--type-body-sm-size)',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
  cursor: 'pointer',
} as const

/**
 * Centred by `display: inline-block`, not by the parent's `text-align`.
 *
 * Lucide's SVGs compute to `display: block` here, and a block-level child
 * ignores `text-align` on its parent — so the tick sat hard against the left
 * edge of a panel that was otherwise centred. Making it inline-block is what
 * lets the parent's centring reach it.
 */
const CENTRED_ICON = { display: 'inline-block' } as const
