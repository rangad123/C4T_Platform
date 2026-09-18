import { serverFetchOrNull } from '@/lib/api/server'
import { financialYearMonths } from '@/lib/hrms/financial-year'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { generatePayslip } from './actions'

interface PayslipRow {
  id: string
  financialYear: string
  month: number
  generatedAt: string
  downloadUrl: string | null
}

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

      <Panel title="Payslips" description={`Generated payslips for ${financialYear}.`}>
        {forThisYear.length > 0 ? (
          <Table
            ariaLabel="Payslips"
            columns={columns}
            rows={forThisYear}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="credit-card" title="No payslips generated for this year" />
        )}

        <TrackedForm
          action={generatePayslip.bind(null, employeeId)}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 'var(--space-4)',
            marginTop: 'var(--space-6)',
            alignItems: 'end',
          }}
        >
          <input type="hidden" name="financialYear" value={financialYear} />
          <Field label="Month" htmlFor="payslipMonth" required>
            <Select
              id="payslipMonth"
              name="month"
              required
              options={financialYearMonths(financialYear).map((m) => ({
                value: String(m.month),
                label: m.label,
              }))}
            />
          </Field>
          <SubmitButton variant="primary" pendingLabel="Generating…">
            Generate payslip
          </SubmitButton>
        </TrackedForm>
      </Panel>
    </>
  )
}
