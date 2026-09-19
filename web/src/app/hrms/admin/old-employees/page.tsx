import type { Metadata } from 'next'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { searchTerm, hasFilter } from '@/lib/admin/format'
import { HrAdminListPage } from '@/components/hrms/HrAdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { HrAvatar } from '@/components/hrms/HrAvatar'
import type { TableColumn } from '@/components/ds/admin/Table'

export const metadata: Metadata = { title: 'Old employees' }

const BASE = '/admin/old-employees'

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

const STATUSES = ['RESIGNED', 'TERMINATED']

/** Resigned/terminated staff — same HrEmployee table as Employees, filtered by status. */
export default async function HrAdminOldEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; search?: string }>
}) {
  const params = await searchParams
  const page = parsePage(params.page)
  const status = STATUSES.includes(params.status ?? '') ? params.status : undefined
  const search = searchTerm(params.search)

  const result = await loadList<EmployeeRow>('hrms/employees', {
    page,
    limit: 20,
    query: { former: true, status, search },
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
    { key: 'designation', header: 'Designation', render: (row) => row.designation?.name ?? '—' },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
  ]

  return (
    <HrAdminListPage
      eyebrow="Employees"
      title="Old employees"
      description="Resigned and terminated staff."
      crumbs={[{ label: 'Old employees' }]}
      root={{ label: 'Admin', href: '/admin' }}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `/admin/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { status, search })}
      filtered={hasFilter([status, search])}
      emptyIcon="user-check"
      emptyTitle="No former employees"
      emptyDescription="Employees who resign or are terminated appear here."
      toolbar={
        <ListFilters
          action={BASE}
          search={{ value: search, placeholder: 'Search name, email or employee code' }}
          selects={[
            { name: 'status', label: 'Status', options: STATUSES, value: status, allLabel: 'All' },
          ]}
        />
      }
    />
  )
}
