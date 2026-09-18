import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import { currentFinancialYear, isValidFinancialYear } from '@/lib/hrms/financial-year'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { hrMoney } from '@/components/hrms/hr-money'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'

export const metadata: Metadata = { title: 'Salary details' }

interface SalaryStructure {
  basic: number
  hra: number
  specialAllowance: number
  totalFixedAnnual: number
  performanceIncentive: number
  projectIncentive: number
  extraHoursIncentive: number
  totalVariableAnnual: number
}

interface OldSalary {
  id: string
  ctc: number
  fromDate: string
  toDate: string
}

interface Incentive {
  id: string
  month: number
  amount: number
  incentiveType: { name: string } | null
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

export default async function HrEmployeeSalaryPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>
}) {
  const params = await searchParams
  const financialYear =
    params.fy && isValidFinancialYear(params.fy) ? params.fy : currentFinancialYear()

  const [structure, oldSalaries, incentives] = await Promise.all([
    serverFetchOrNull<SalaryStructure>('hrms/me/salary', { query: { financialYear } }),
    serverFetchOrNull<OldSalary[]>('hrms/me/salary/old'),
    serverFetchOrNull<Incentive[]>('hrms/me/salary/incentives', { query: { financialYear } }),
  ])

  const oldColumns: readonly TableColumn<OldSalary>[] = [
    { key: 'ctc', header: 'CTC', render: (row) => hrMoney(row.ctc) },
    {
      key: 'from',
      header: 'From',
      render: (row) => new Date(row.fromDate).toLocaleDateString(),
    },
    { key: 'to', header: 'To', render: (row) => new Date(row.toDate).toLocaleDateString() },
  ]

  const incentiveColumns: readonly TableColumn<Incentive>[] = [
    { key: 'month', header: 'Month', render: (row) => MONTHS[row.month - 1] ?? '—' },
    { key: 'type', header: 'Type', render: (row) => row.incentiveType?.name ?? '—' },
    { key: 'amount', header: 'Amount', align: 'right', render: (row) => hrMoney(row.amount) },
  ]

  return (
    <HrPageShell
      crumbs={[{ label: 'Salary details' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Salary details"
      title="Salary details"
      subtitle="Your pay structure, CTC history and incentives."
    >
      <HrFinancialYearPicker action="/employee/salary" financialYear={financialYear} />

      <Panel title={`Salary structure — ${financialYear}`}>
        {structure ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            <DescriptionList
              items={[
                { label: 'Basic', value: hrMoney(structure.basic) },
                { label: 'HRA', value: hrMoney(structure.hra) },
                { label: 'Special allowance', value: hrMoney(structure.specialAllowance) },
                { label: 'Total fixed (annual)', value: hrMoney(structure.totalFixedAnnual) },
              ]}
            />
            <DescriptionList
              items={[
                { label: 'Performance incentive', value: hrMoney(structure.performanceIncentive) },
                { label: 'Project incentive', value: hrMoney(structure.projectIncentive) },
                { label: 'Extra hours incentive', value: hrMoney(structure.extraHoursIncentive) },
                { label: 'Total variable (annual)', value: hrMoney(structure.totalVariableAnnual) },
              ]}
            />
          </div>
        ) : (
          <EmptyState
            icon="banknote"
            title="No salary structure on file"
            description={`Nothing has been recorded for ${financialYear} yet.`}
          />
        )}
      </Panel>

      <Panel title="Monthly incentives">
        {incentives && incentives.length > 0 ? (
          <Table
            ariaLabel="Monthly incentives"
            columns={incentiveColumns}
            rows={incentives}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="award" title="No incentives recorded for this year" />
        )}
      </Panel>

      <Panel title="CTC history">
        {oldSalaries && oldSalaries.length > 0 ? (
          <Table
            ariaLabel="CTC history"
            columns={oldColumns}
            rows={oldSalaries}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="trending-up" title="No earlier salary on record" />
        )}
      </Panel>
    </HrPageShell>
  )
}
