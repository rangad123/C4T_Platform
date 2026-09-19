import type { Metadata } from 'next'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { searchTerm, hasFilter } from '@/lib/admin/format'
import { HrAdminListPage } from '@/components/hrms/HrAdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { HrAvatar } from '@/components/hrms/HrAvatar'
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
  }>
}) {
  const params = await searchParams
  const page = parsePage(params.page)
  const role = ROLES.includes(params.role ?? '') ? params.role : undefined
  const search = searchTerm(params.search)

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
      hrefFor={pageHrefBuilder(BASE, { role, search, sort: params.sort, order: params.order })}
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
          <Button href={`${BASE}/new`} variant="primary" iconLeft="plus">
            Add employee
          </Button>
        </div>
      }
    />
  )
}
