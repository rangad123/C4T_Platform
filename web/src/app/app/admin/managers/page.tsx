import { requirePermission } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { RoleBadge, StatusBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { personName } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/managers'

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
  searchParams: Promise<{ search?: string; page?: string }>
}) {
  await requirePermission('manager.read')

  const params = await searchParams
  const search = params.search?.trim() || undefined
  const page = parsePage(params.page)

  const result = await loadList<ManagerRow>('managers', {
    page,
    limit: PAGE_SIZE,
    query: { search },
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
      hrefFor={pageHrefBuilder(BASE, { search })}
      filtered={Boolean(search)}
      permission="manager.read"
      emptyIcon="shield-check"
      emptyTitle="No managers yet"
      emptyDescription="An admin or sub-admin appears here as soon as they exist. Promote someone from the Users page to add a manager."
      toolbar={
        <ListFilters
          action={BASE}
          search={{ value: search, placeholder: 'Name or email' }}
        />
      }
    />
  )
}
