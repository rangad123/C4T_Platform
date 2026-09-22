import { serverFetchOrNull } from '@/lib/api/server'
import { financialYearMonths } from '@/lib/hrms/financial-year'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Button } from '@/components/ds/core/Button'

interface PayslipRow {
  id: string
  financialYear: string
  month: number
  generatedAt: string
  downloadUrl: string | null
}

/**
 * Read-only. Payslips are generated in one run for every active employee, on
 * the Payslip page under Employees — not per person here. That page's rows
 * link back to this tab, which is where the result is downloaded from and,
 * for someone the run could not handle (no salary breakdown, say), where the
 * fix belongs.
 */
export async function PayslipTab({
  employeeId,
  detailPath,
  financialYear,
}: {
  employeeId: string
  detailPath: string
  financialYear: string
}) {
  const payslips = await serverFetchOrNull<PayslipRow[]>(`hrms/employees/${employeeId}/payslips`)
  const forThisYear = (payslips ?? []).filter((p) => p.financialYear === financialYear)

  const columns: readonly TableColumn<PayslipRow>[] = [
    {
      key: 'month',
      header: 'Month',
      render: (row) =>
        financialYearMonths(row.financialYear).find((m) => m.month === row.month)?.label ??
        row.month,
    },
    {
      key: 'generatedAt',
      header: 'Generated',
      render: (row) => new Date(row.generatedAt).toLocaleString(),
    },
    {
      key: 'download',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) =>
        row.downloadUrl ? (
          <Button
            href={row.downloadUrl}
            variant="secondary"
            size="sm"
            iconLeft="download"
            prefetch={false}
          >
            Download
          </Button>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>Unavailable</span>
        ),
    },
  ]

  return (
    <>
      <HrFinancialYearPicker action={detailPath} section="payslip" financialYear={financialYear} />

      <Panel
        title="Payslips"
        description={`Generated payslips for ${financialYear}. Payslips are generated for everyone at once from the Payslip page under Employees.`}
        actions={
          <Button href="/admin/payslip" variant="secondary" size="sm" iconLeft="credit-card">
            Go to payslip run
          </Button>
        }
      >
        {forThisYear.length > 0 ? (
          <Table
            ariaLabel="Payslips"
            columns={columns}
            rows={forThisYear}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState
            icon="credit-card"
            title="No payslips generated for this year"
            description="Run the payslip generator from the Payslip page under Employees."
          />
        )}
      </Panel>
    </>
  )
}
