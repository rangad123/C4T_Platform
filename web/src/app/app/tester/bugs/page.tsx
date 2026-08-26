import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Button } from '@/components/ds/core/Button'
import { StatusBadge, SeverityBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, searchTerm, titleCase, hasFilter } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/tester/bugs'
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
}

/**
 * `/app/tester/bugs` — the defects this tester has filed.
 *
 * `GET /v1/bugs` is auto-scoped by `bugScope`: a tester sees the bugs they
 * reported, plus — only where the project has `testersCanSeeOtherBugs`
 * enabled — bugs filed by others on that project. So this list is not
 * strictly "my reports"; it is "bugs I am allowed to see", which is why the
 * heading stays neutral rather than claiming authorship of every row.
 */
export default async function TesterBugsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string
    severity?: string
    search?: string
    page?: string
    reported?: string
  }>
}) {
  await requireRole(['TESTER'])
  const params = await searchParams
  const justReported = params.reported === '1'

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
      key: 'type',
      header: 'Type',
      render: (row) => (row.type ? titleCase(row.type) : '—'),
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
      root={{ label: 'Tester', href: '/app/tester' }}
      eyebrow="Work"
      title="Bugs"
      description="Defects you filed, plus anything else you're allowed to see on your assigned projects."
      crumbs={[{ label: 'Bugs' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { status, severity, search })}
      filtered={hasFilter([status, severity, search])}
      permission="bug.read"
      emptyIcon="clipboard-check"
      emptyTitle="No bugs yet"
      emptyDescription="Report the first defect you find on a project you are assigned to."
      toolbar={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {justReported ? (
            <div
              role="status"
              style={{
                padding: 'var(--space-4) var(--space-5)',
                borderRadius: 'var(--radius-card)',
                background: 'var(--status-success-bg)',
                color: 'var(--status-success-fg)',
              }}
            >
              Bug reported. It appears below with status New until someone triages it.
            </div>
          ) : null}
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
                ]}
              />
            </div>
            <Button href="/app/tester/bugs/new" variant="primary" iconLeft="plus">
              Report a bug
            </Button>
          </div>
        </div>
      }
    />
  )
}
