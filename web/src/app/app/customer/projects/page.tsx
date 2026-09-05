import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { Button } from '@/components/ds/core/Button'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, titleCase, searchTerm, hasFilter } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'
import { PROJECT_STATUSES } from '@/lib/domain/enums'

const PAGE_SIZE = 25
const BASE = '/app/customer/projects'
const ROOT = { label: 'Customer', href: '/app/customer' }
const STATUSES = PROJECT_STATUSES

interface ProjectRow {
  id: string
  reference: string
  title: string
  status: string
  priority: string
  startDate: string | null
  createdAt: string
  _count: { bugs: number; assignments: number }
}

/**
 * `/app/customer/projects` — every test cycle this organisation has
 * submitted. `GET /projects` is already scoped to "my organisation" by
 * `projectScope` server-side — no org filter needed here, unlike admin's
 * version, since there's only ever one.
 */
export default async function CustomerProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string; page?: string }>
}) {
  await requireRole(['CUSTOMER'])

  const params = await searchParams
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : undefined
  const search = searchTerm(params.search)
  const page = parsePage(params.page)

  const result = await loadList<ProjectRow>('projects', {
    page,
    limit: PAGE_SIZE,
    query: { status, search },
  })

  const columns: readonly TableColumn<ProjectRow>[] = [
    {
      key: 'title',
      header: 'Project',
      render: (row) => row.title,
      renderSecondary: (row) => row.reference,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'priority', header: 'Priority', render: (row) => titleCase(row.priority) },
    { key: 'bugs', header: 'Bugs', align: 'right', render: (row) => row._count.bugs },
    { key: 'testers', header: 'Testers', align: 'right', render: (row) => row._count.assignments },
    {
      key: 'start',
      header: 'Started',
      align: 'right',
      render: (row) => formatDate(row.startDate ?? row.createdAt),
    },
  ]

  return (
    <AdminListPage
      root={ROOT}
      eyebrow="Delivery"
      title="Projects"
      description="Every test cycle you've submitted, newest first."
      crumbs={[{ label: 'Projects' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { status, search })}
      filtered={hasFilter([status, search])}
      permission="project.read"
      emptyIcon="briefcase"
      emptyTitle="No projects yet"
      emptyDescription="Submit your first project to get testers looking at it."
      toolbar={
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 280 }}>
            <ListFilters
              action={BASE}
              search={{ value: search, placeholder: 'Title or reference' }}
              selects={[
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
          <Button href="/app/customer/projects/new" variant="primary" iconLeft="plus">
            New project
          </Button>
        </div>
      }
    />
  )
}
