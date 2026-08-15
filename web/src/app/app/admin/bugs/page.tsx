import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge, SeverityBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, personName, searchTerm, hasFilter } from '@/lib/admin/format'
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
] as const
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const

interface BugRow {
  id: string
  reference: string
  title: string
  severity: string
  status: string
  deviceModel: string | null
  osName: string | null
  osVersion: string | null
  browser: string | null
  createdAt: string
  project: { id: string; reference: string; title: string } | null
  reportedBy: { id: string; firstName: string | null; lastName: string | null } | null
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
  searchParams: Promise<{ status?: string; severity?: string; search?: string; page?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : undefined
  const severity = SEVERITIES.includes(params.severity as (typeof SEVERITIES)[number])
    ? params.severity
    : undefined
  const search = searchTerm(params.search)
  const page = parsePage(params.page)

  const result = await loadList<BugRow>('bugs', {
    page,
    limit: PAGE_SIZE,
    query: { status, severity, search },
  })

  const columns: readonly TableColumn<BugRow>[] = [
    {
      key: 'title',
      header: 'Bug',
      render: (row) => row.title,
      renderSecondary: (row) =>
        [row.reference, row.project?.reference].filter(Boolean).join(' · '),
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
      render: (row) => personName(row.reportedBy),
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
      crumbs={[{ label: 'Bugs' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { status, severity, search })}
      
      filtered={hasFilter([status, severity, search])}
      permission="bug.read"
      emptyIcon="clipboard-check"
      emptyTitle="No bugs reported yet"
      emptyDescription="Defects appear here as soon as a tester files one against an active project."
      toolbar={
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
          ]}
        />
      }
    />
  )
}
