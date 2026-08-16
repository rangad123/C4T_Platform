import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { CountryFlag } from '@/components/admin/CountryFlag'
import { ListFilters } from '@/components/admin/ListFilters'
import { Button } from '@/components/ds/core/Button'
import { StatusBadge, SeverityBadge } from '@/components/admin/StatusBadge'
import { Select } from '@/components/ds/forms/Select'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, personName, searchTerm, titleCase, hasFilter } from '@/lib/admin/format'
import { bulkChangeBugStatusAction } from './actions'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/bugs'
const STATUSES = [
  'NEW',
  'TRIAGED',
  'CONFIRMED',
  'IN_PROGRESS',
  'FIXED',
  'VERIFIED',
  'REOPENED',
  'REJECTED',
  'DUPLICATE',
  'WONT_FIX',
  'FEATURE_REQUEST',
] as const
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
const SORT_OPTIONS = [
  { value: 'createdAt', label: 'Reported' },
  { value: 'updatedAt', label: 'Last updated' },
  { value: 'severity', label: 'Severity' },
  { value: 'status', label: 'Status' },
  { value: 'reference', label: 'Reference' },
] as const
const SORT_FIELDS = SORT_OPTIONS.map((o) => o.value)

/**
 * Build the CSV export URL for the current filter set. Goes through the
 * catch-all Route Handler at `/app/admin/export/[...path]` so the export
 * stays same-origin (the route streams from the API on behalf of the browser).
 *
 * Empty/undefined values are dropped so the link does not carry `?status=`
 * placeholders into the export — the API treats an empty query param as
 * "no filter applied" anyway, but a clean URL is easier to bookmark.
 */
function buildExportHref(filters: {
  status?: string
  severity?: string
  type?: string
  search?: string
  projectId?: string
  sort?: string
  order?: string
}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value)
  }
  const qs = params.toString()
  return qs ? `/app/admin/export/bugs?${qs}` : '/app/admin/export/bugs'
}

/** Independent of severity/status — what kind of defect this is. */
export const BUG_TYPES = [
  'CRASH',
  'APP_FREEZE',
  'FUNCTIONAL',
  'UI',
  'UX',
  'SECURITY',
  'PERFORMANCE',
] as const

interface BugRow {
  id: string
  reference: string
  title: string
  severity: string
  status: string
  type: string | null
  featureId: string | null
  feature: { id: string; name: string } | null
  deviceModel: string | null
  osName: string | null
  osVersion: string | null
  browser: string | null
  createdAt: string
  project: { id: string; reference: string; title: string } | null
  reportedBy: {
    id: string
    firstName: string | null
    lastName: string | null
    testerProfile: { countryCode: string | null } | null
  } | null
  _count: { attachments: number; comments: number }
}

/**
 * `/app/admin/bugs` — every defect reported across every project.
 *
 * Severity comes before status in the column order on purpose: triage reads
 * "how bad is it" first and "where is it in the workflow" second.
 *
 * The environment column collapses device / OS / browser into one line. They
 * are separate fields on the API because a report may only carry some of them,
 * but as three columns they were mostly em dashes.
 */
export default async function BugsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string
    severity?: string
    type?: string
    search?: string
    page?: string
    sort?: string
    order?: string
    /**
     * Project-scoped view. Set when arriving from a project's "View all
     * bugs" link — narrows the list to that project only. The API filter
     * accepts this on `listBugsQuery`.
     */
    projectId?: string
  }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : undefined
  const severity = SEVERITIES.includes(params.severity as (typeof SEVERITIES)[number])
    ? params.severity
    : undefined
  const sort = SORT_FIELDS.includes(params.sort as (typeof SORT_FIELDS)[number])
    ? params.sort
    : undefined
  const order = params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined
  const type = BUG_TYPES.includes(params.type as (typeof BUG_TYPES)[number])
    ? params.type
    : undefined
  const search = searchTerm(params.search)
  const projectId = params.projectId?.length === 25 ? params.projectId : undefined
  const page = parsePage(params.page)

  const result = await loadList<BugRow>('bugs', {
    page,
    limit: PAGE_SIZE,
    query: { status, severity, type, search, projectId, sort, order },
  })

  const columns: readonly TableColumn<BugRow>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          name="select-all"
          aria-label="Select all bugs on this page"
          form="bugs-bulk-form"
          style={{ margin: 0, cursor: 'pointer' }}
        />
      ),
      width: 36,
      render: (row) => (
        <input
          type="checkbox"
          name="ids"
          value={row.id}
          form="bugs-bulk-form"
          aria-label={`Select ${row.reference}`}
          style={{ margin: 0, cursor: 'pointer' }}
        />
      ),
    },
    {
      key: 'title',
      header: 'Bug',
      render: (row) => row.title,
      renderSecondary: (row) =>
        [row.reference, row.project?.reference, row.feature?.name].filter(Boolean).join(' · '),
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => (row.type ? titleCase(row.type) : '—'),
    },
    {
      key: 'severity',
      header: 'Severity',
      render: (row) => <SeverityBadge severity={row.severity} />,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'environment',
      header: 'Environment',
      render: (row) => {
        const bits = [
          row.deviceModel,
          [row.osName, row.osVersion].filter(Boolean).join(' ') || null,
          row.browser,
        ].filter(Boolean)
        return bits.length > 0 ? bits.join(' · ') : '—'
      },
    },
    {
      key: 'reporter',
      header: 'Reported by',
      render: (row) => {
        const countryCode = row.reportedBy?.testerProfile?.countryCode ?? null
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <CountryFlag countryCode={countryCode} size={14} />
            <span>{personName(row.reportedBy)}</span>
          </span>
        )
      },
    },
    {
      key: 'created',
      header: 'Reported',
      align: 'right',
      render: (row) => formatDate(row.createdAt),
    },
  ]

  return (
    <AdminListPage
      eyebrow="Delivery"
      title="Bugs"
      description="Every defect across every project, newest first. Filter by severity to work the critical queue, or by status to find what is waiting on triage."
      crumbs={
        projectId
          ? [
              { label: 'Projects', href: '/app/admin/projects' },
              { label: 'Project', href: `/app/admin/projects/${projectId}` },
              { label: 'Bugs' },
            ]
          : [{ label: 'Bugs' }]
      }
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { status, severity, type, search, projectId, sort, order })}
      filtered={hasFilter([status, severity, type, search, projectId])}
      permission="bug.read"
      emptyIcon="clipboard-check"
      emptyTitle={projectId ? 'No bugs on this project yet' : 'No bugs reported yet'}
      emptyDescription={
        projectId
          ? 'Bugs filed against this project appear here. Clear the project filter to see all bugs.'
          : 'Defects appear here as soon as a tester files one against an active project.'
      }
      toolbar={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 280 }}>
              <ListFilters
                action={BASE}
                search={{ value: search, placeholder: 'Title or reference' }}
                selects={[
                  {
                    name: 'severity',
                    label: 'Severity',
                    options: SEVERITIES,
                    value: severity,
                    allLabel: 'All severities',
                  },
                  {
                    name: 'status',
                    label: 'Status',
                    options: STATUSES,
                    value: status,
                    allLabel: 'All statuses',
                  },
                  {
                    name: 'type',
                    label: 'Type',
                    options: BUG_TYPES,
                    value: type,
                    allLabel: 'All types',
                  },
                ]}
                sort={{ name: 'sort', orderName: 'order', options: SORT_OPTIONS, value: sort, order }}
              />
            </div>
            <Link
              href={buildExportHref({ status, severity, type, search, projectId, sort, order })}
              prefetch={false}
            >
              <Button variant="secondary" iconLeft="download">
                Export CSV
              </Button>
            </Link>
          </div>

          {/*
            Bulk-action form. The form lives here but the checkboxes it reads
            are inside the table rendered by `AdminListPage` below — they
            reference this form via `form="bugs-bulk-form"`, which is the
            standard HTML mechanism for submitting inputs from outside their
            owning form. Net effect: one form, two subtrees, no client JS.
          */}
          <form
            id="bugs-bulk-form"
            action={bulkChangeBugStatusAction}
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
              padding: 'var(--space-4)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-card)',
              background: 'var(--surface-sunken)',
            }}
          >
            <Select
              name="status"
              defaultValue=""
              options={[
                { value: '', label: 'Set status…' },
                ...STATUSES.map((value) => ({ value, label: titleCase(value) })),
              ]}
              aria-label="Bulk status change"
            />
            <Select
              name="severity"
              defaultValue=""
              options={[
                { value: '', label: 'Set severity…' },
                ...SEVERITIES.map((value) => ({ value, label: titleCase(value) })),
              ]}
              aria-label="Bulk severity change"
            />
            <Button type="submit" variant="secondary" iconLeft="check-check">
              Apply to selected
            </Button>
            <p
              style={{
                margin: 0,
                color: 'var(--text-muted)',
                fontSize: 'var(--type-body-sm-size)',
                flex: 1,
                minWidth: 240,
              }}
            >
              Tick the checkboxes on the rows you want to update, then choose a
              new status or severity and submit. Rows that cannot make the
              change are skipped rather than aborting the batch.
            </p>
          </form>
        </div>
      }
    />
  )
}
