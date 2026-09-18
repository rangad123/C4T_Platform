import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import { currentFinancialYear, isValidFinancialYear } from '@/lib/hrms/financial-year'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { hrMoney } from '@/components/hrms/hr-money'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'

export const metadata: Metadata = { title: 'Investments' }

interface Declaration {
  id: string
  description: string | null
  declaredAmount: number
  verifiedAmount: number | null
  section: { code: string; name: string } | null
}

interface Deduction {
  id: string
  month: number
  amount: number
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export default async function HrEmployeeInvestmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>
}) {
  const params = await searchParams
  const financialYear =
    params.fy && isValidFinancialYear(params.fy) ? params.fy : currentFinancialYear()

  const [declarations, deductions] = await Promise.all([
    serverFetchOrNull<Declaration[]>('hrms/me/investments', { query: { financialYear } }),
    serverFetchOrNull<Deduction[]>('hrms/me/investments/deductions', { query: { financialYear } }),
  ])

  const declarationColumns: readonly TableColumn<Declaration>[] = [
    { key: 'section', header: 'Section', render: (row) => row.section?.code ?? '—' },
    {
      key: 'description',
      header: 'Description',
      render: (row) => row.description ?? row.section?.name ?? '—',
    },
    {
      key: 'declared',
      header: 'Declared',
      align: 'right',
      render: (row) => hrMoney(row.declaredAmount),
    },
    {
      key: 'verified',
      header: 'Verified',
      align: 'right',
      // Null means HR has not checked it yet, which is different from zero.
      render: (row) =>
        row.verifiedAmount === null ? 'Not yet verified' : hrMoney(row.verifiedAmount),
    },
  ]

  const deductionColumns: readonly TableColumn<Deduction>[] = [
    { key: 'month', header: 'Month', render: (row) => MONTHS[row.month - 1] ?? '—' },
    { key: 'amount', header: 'TDS deducted', align: 'right', render: (row) => hrMoney(row.amount) },
  ]

  const totalDeducted = (deductions ?? []).reduce((sum, row) => sum + row.amount, 0)

  return (
    <HrPageShell
      crumbs={[{ label: 'Investments' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Investments"
      title="Investments"
      subtitle="Your declarations for the year and the tax deducted so far."
    >
      <HrFinancialYearPicker action="/employee/investments" financialYear={financialYear} />

      <Panel
        title="Declarations"
        description="Submitted to HR. Contact HR to add or change a declaration."
      >
        {declarations && declarations.length > 0 ? (
          <Table
            ariaLabel="Investment declarations"
            columns={declarationColumns}
            rows={declarations}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState
            icon="file-text"
            title="No declarations for this year"
            description={`Nothing has been recorded for ${financialYear}.`}
          />
        )}
      </Panel>

      <Panel
        title="Tax deducted at source"
        description={
          deductions && deductions.length > 0
            ? `${hrMoney(totalDeducted)} so far this year.`
            : undefined
        }
      >
        {deductions && deductions.length > 0 ? (
          <Table
            ariaLabel="Monthly tax deductions"
            columns={deductionColumns}
            rows={deductions}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="landmark" title="No TDS recorded for this year" />
        )}
      </Panel>
    </HrPageShell>
  )
}
