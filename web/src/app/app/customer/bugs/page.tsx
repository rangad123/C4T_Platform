import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { CountryFlag } from '@/components/admin/CountryFlag'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge, SeverityBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, personName, searchTerm, titleCase, hasFilter } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/customer/bugs'
const ROOT = { label: 'Customer', href: '/app/customer' }
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

interface BugRow {
  id: string
  reference: string
  title: string
  severity: string
  status: string
  type: string | null
  createdAt: string
  project: { id: string; reference: string; title: string } | null
  reportedBy: {
    id: string
    firstName: string | null
    lastName: string | null
    testerProfile: { countryCode: string | null } | null
  } | null
}

/**
 * `/app/customer/bugs` — every defect on this organisation's projects.
 * `GET /bugs` is already scoped by `bugScope` — no org filter needed.
 * No "Report a bug" button: `bug.create` requires `project:tester_active`,
 * never true for a customer.
 */
export default async function CustomerBugsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; severity?: string; search?: string; page?: string; projectId?: string }>
}) {
  await requireRole(['CUSTOMER'])

  const params = await searchParams
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number]) ? params.status : undefined
  const severity = SEVERITIES.includes(params.severity as (typeof SEVERITIES)[number]) ? params.severity : undefined
  const search = searchTerm(params.search)
  const projectId = params.projectId?.length === 25 ? params.projectId : undefined
  const page = parsePage(params.page)

  const result = await loadList<BugRow>('bugs', {
    page,
    limit: PAGE_SIZE,
    query: { status, severity, search, projectId },
  })

  const columns: readonly TableColumn<BugRow>[] = [
    {
      key: 'title',
      header: 'Bug',
      render: (row) => row.title,
      renderSecondary: (row) => [row.reference, row.project?.reference].filter(Boolean).join(' · '),
    },
    { key: 'severity', header: 'Severity', render: (row) => <SeverityBadge severity={row.severity} /> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'type', header: 'Type', render: (row) => (row.type ? titleCase(row.type) : '—') },
    {
      key: 'reporter',
      header: 'Reported by',
      render: (row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <CountryFlag countryCode={row.reportedBy?.testerProfile?.countryCode ?? null} size={14} />
          <span>{personName(row.reportedBy)}</span>
        </span>
      ),
    },
    { key: 'created', header: 'Reported', align: 'right', render: (row) => formatDate(row.createdAt) },
  ]

  return (
    <AdminListPage
      root={ROOT}
      eyebrow="Delivery"
      title="Bugs"
      description="Every defect across your projects, newest first."
      crumbs={
        projectId
          ? [{ label: 'Projects', href: '/app/customer/projects' }, { label: 'Project', href: `/app/customer/projects/${projectId}` }, { label: 'Bugs' }]
          : [{ label: 'Bugs' }]
      }
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { status, severity, search, projectId })}
      filtered={hasFilter([status, severity, search, projectId])}
      permission="bug.read"
      emptyIcon="clipboard-check"
      emptyTitle={projectId ? 'No bugs on this project yet' : 'No bugs reported yet'}
      emptyDescription={
        projectId
          ? 'Bugs filed against this project appear here. Clear the project filter to see all bugs.'
          : 'Defects appear here as soon as a tester files one against one of your active projects.'
      }
      toolbar={
        <div style={{ flex: 1, minWidth: 280 }}>
          <ListFilters
            action={BASE}
            search={{ value: search, placeholder: 'Title or reference' }}
            selects={[
              { name: 'severity', label: 'Severity', options: SEVERITIES, value: severity, allLabel: 'All severities' },
              { name: 'status', label: 'Status', options: STATUSES, value: status, allLabel: 'All statuses' },
            ]}
          />
        </div>
      }
    />
  )
}
