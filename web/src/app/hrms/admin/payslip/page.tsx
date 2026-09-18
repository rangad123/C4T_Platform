import type { Metadata } from 'next'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { searchTerm, hasFilter } from '@/lib/admin/format'
import { HrAdminListPage } from '@/components/hrms/HrAdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Avatar } from '@/components/admin/Avatar'
import type { TableColumn } from '@/components/ds/admin/Table'

export const metadata: Metadata = { title: 'Payslip' }

const BASE = '/admin/payslip'

interface EmployeeRow {
  id: string
  employeeCode: string
  firstName: string
  lastName: string
  email: string
  profilePictureFileId: string | null
  designation: { id: string; name: string } | null
}

/**
 * Payslip is generated per employee, on that employee's own detail page —
 * this sidebar entry is the picker that gets an admin there, per the
 * brief's own "Generate and download payslips for any employee."
 */
export default async function HrAdminPayslipPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string }>
}) {
  const params = await searchParams
  const page = parsePage(params.page)
  const search = searchTerm(params.search)

  const result = await loadList<EmployeeRow>('hrms/employees', {
    page,
    limit: 20,
    query: { search },
  })

  const columns: readonly TableColumn<EmployeeRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <Avatar
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
  ]

  return (
    <HrAdminListPage
      eyebrow="Payslip"
      title="Payslip"
      description="Pick an employee to generate or download their payslips."
      crumbs={[{ label: 'Payslip' }]}
      root={{ label: 'Admin', href: '/admin' }}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `/admin/${row.id}?section=payslip`}
      hrefFor={pageHrefBuilder(BASE, { search })}
      filtered={hasFilter([search])}
      emptyIcon="credit-card"
      emptyTitle="No employees yet"
      emptyDescription="Add an employee first."
      toolbar={
        <ListFilters
          action={BASE}
          search={{ value: search, placeholder: 'Search name, email or employee code' }}
        />
      }
    />
  )
}
