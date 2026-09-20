import type { Metadata } from 'next'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { searchTerm, hasFilter } from '@/lib/admin/format'
import { HrAdminListPage } from '@/components/hrms/HrAdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { HrAvatar } from '@/components/hrms/HrAvatar'
import { HrEmployeeCards } from '@/components/hrms/HrEmployeeCards'
import { HrViewToggle } from '@/components/hrms/HrViewToggle'
import { resolveListView } from '@/lib/hrms/list-view'
import { Button } from '@/components/ds/core/Button'
import type { TableColumn } from '@/components/ds/admin/Table'

export const metadata: Metadata = { title: 'Employees' }

const BASE = '/admin'

interface EmployeeRow {
  id: string
  employeeCode: string
  firstName: string
  lastName: string
  email: string
  role: 'ADMIN' | 'ACCOUNT_MANAGER' | 'EMPLOYEE'
  status: 'ACTIVE' | 'RESIGNED' | 'TERMINATED'
  phone: string | null
  profilePictureFileId: string | null
  designation: { id: string; name: string } | null
}

const ROLES = ['ADMIN', 'ACCOUNT_MANAGER', 'EMPLOYEE']
const SORT_OPTIONS = [
  { value: 'createdAt', label: 'Newest first' },
  { value: 'firstName', label: 'Name' },
  { value: 'employeeCode', label: 'Employee code' },
  { value: 'joiningDate', label: 'Joining date' },
]

export default async function HrAdminEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string
    role?: string
    search?: string
    sort?: string
    order?: 'asc' | 'desc'
    view?: string
  }>
}) {
  const params = await searchParams
  const page = parsePage(params.page)
  const role = ROLES.includes(params.role ?? '') ? params.role : undefined
  const search = searchTerm(params.search)
  const view = await resolveListView(params.view)

  const listQuery = { role, search, sort: params.sort, order: params.order, view: params.view }
  const hrefFor = pageHrefBuilder(BASE, listQuery)
  // Where the view toggle sends you back to: this same list, filters, sort and
  // page intact, so switching how it is drawn never also moves you.
  const returnTo = hrefFor(page)

  const result = await loadList<EmployeeRow>('hrms/employees', {
    page,
    limit: 20,
    query: { role, search, sort: params.sort, order: params.order },
  })

  const columns: readonly TableColumn<EmployeeRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <HrAvatar
            name={`${row.firstName} ${row.lastName}`}
            fileId={row.profilePictureFileId}
            size="sm"
          />
          {row.firstName} {row.lastName}
        </span>
      ),
      renderSecondary: (row) => row.email,
    },
    { key: 'employeeCode', header: 'Employee code', render: (row) => row.employeeCode },
    {
      key: 'designation',
      header: 'Designation',
      render: (row) => row.designation?.name ?? '—',
    },
    { key: 'role', header: 'Role', render: (row) => <StatusBadge status={row.role} /> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
  ]

  return (
    <HrAdminListPage
      eyebrow="Employees"
      title="Employees"
      description="Active staff, organised by role and reporting line."
      crumbs={[{ label: 'Employees' }]}
      root={{ label: 'Admin', href: BASE }}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={hrefFor}
      view={view}
      cards={'items' in result ? <HrEmployeeCards rows={result.items} basePath={BASE} /> : null}
      filtered={hasFilter([role, search])}
      emptyIcon="users"
      emptyTitle="No employees yet"
      emptyDescription="Add the first employee to get started."
      toolbar={
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <ListFilters
            action={BASE}
            search={{ value: search, placeholder: 'Search name, email or employee code' }}
            selects={[
              { name: 'role', label: 'Role', options: ROLES, value: role, allLabel: 'All roles' },
            ]}
            sort={{
              name: 'sort',
              orderName: 'order',
              options: SORT_OPTIONS,
              value: params.sort,
              order: params.order,
            }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <HrViewToggle active={view} returnTo={returnTo} />
            <Button href={`${BASE}/invitations`} variant="secondary" iconLeft="mail">
              Send invitations
            </Button>
            <Button href={`${BASE}/new`} variant="primary" iconLeft="plus">
              Add employee
            </Button>
          </div>
        </div>
      }
    />
  )
}
