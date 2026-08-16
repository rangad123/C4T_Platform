import Link from 'next/link'
import { requirePermission } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Button } from '@/components/ds/core/Button'
import { RoleBadge, StatusBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { personName, searchTerm, hasFilter } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/managers'
const SORT_OPTIONS = [
  { value: 'createdAt', label: 'Created' },
  { value: 'firstName', label: 'First name' },
  { value: 'lastName', label: 'Last name' },
  { value: 'email', label: 'Email' },
  { value: 'role', label: 'Role' },
  { value: 'status', label: 'Status' },
] as const
const SORT_FIELDS = SORT_OPTIONS.map((o) => o.value)

/**
 * Build the CSV export URL for the current filter set. Goes through the
 * catch-all Route Handler at `/app/admin/export/[...path]` so the export
 * stays same-origin (the route streams from the API on behalf of the browser).
 */
function buildExportHref(filters: {
  search?: string
  sort?: string
  order?: string
}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value)
  }
  const qs = params.toString()
  return qs ? `/app/admin/export/managers?${qs}` : '/app/admin/export/managers'
}

/**
 * The manager list is the API's "users with role ADMIN or SUB_ADMIN" view.
 * For the type here, the API returns `projectsManagedCount` (the
 * `_count.projectsManaged` field). Joined-in lists are still subject to the
 * same lookup; rows are all-admin by the route's permission gate.
 */
interface ManagerRow {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  role: string
  status: string
  _count: { projectsManaged: number }
}

/**
 * `/app/admin/managers` — admins and sub-admins who oversee projects.
 *
 * Under the hood this is a filtered users query, not a dedicated entity:
 * "manager" is a role-based projection, not a separate table. The API
 * already restricts this list to role IN (ADMIN, SUB_ADMIN), so a sub-admin
 * calling this endpoint sees exactly the same view as an admin.
 *
 * Naming follows the agreement — "Manager Management" — even though the set
 * is defined by role rather than by an entity, because what users actually
 * do with this page is hand out projects to oversee.
 */
export default async function ManagersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; page?: string; sort?: string; order?: string }>
}) {
  await requirePermission('manager.read')

  const params = await searchParams
  const search = searchTerm(params.search)
  const sort = SORT_FIELDS.includes(params.sort as (typeof SORT_FIELDS)[number])
    ? params.sort
    : undefined
  const order = params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined
  const page = parsePage(params.page)

  const result = await loadList<ManagerRow>('managers', {
    page,
    limit: PAGE_SIZE,
    query: { search, sort, order },
  })

  const columns: readonly TableColumn<ManagerRow>[] = [
    {
      key: 'name',
      header: 'Manager',
      render: (row) => personName(row),
      renderSecondary: (row) => row.email,
    },
    { key: 'role', header: 'Role', render: (row) => <RoleBadge role={row.role} /> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'projects',
      header: 'Projects overseen',
      align: 'right',
      render: (row) => row._count.projectsManaged,
    },
  ]

  return (
    <AdminListPage
      eyebrow="Accounts"
      title="Managers"
      description="Admins and sub-admins who oversee projects. Pick one to see the projects they manage, or assign a new project to them."
      crumbs={[{ label: 'Managers' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { search, sort, order })}
      filtered={hasFilter([search])}
      permission="manager.read"
      emptyIcon="shield-check"
      emptyTitle="No managers yet"
      emptyDescription="An admin or sub-admin appears here as soon as they exist. Promote someone from the Users page to add a manager."
      toolbar={
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <ListFilters
              action={BASE}
              search={{ value: search, placeholder: 'Name or email' }}
              sort={{ name: 'sort', orderName: 'order', options: SORT_OPTIONS, value: sort, order }}
            />
          </div>
          <Link href={buildExportHref({ search, sort, order })} prefetch={false}>
            <Button variant="secondary" iconLeft="download">
              Export CSV
            </Button>
          </Link>
        </div>
      }
    />
  )
}
