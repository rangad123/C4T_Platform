import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import { financialYearMonths } from '@/lib/hrms/financial-year'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { hrMoney } from '@/components/hrms/hr-money'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Button } from '@/components/ds/core/Button'

export const metadata: Metadata = { title: 'Payslips' }

interface PayslipRow {
  id: string
  financialYear: string
  month: number
  generatedAt: string
  downloadUrl: string | null
  snapshot?: { netPay?: number } | null
}

export default async function HrEmployeePayslipPage() {
  const payslips = await serverFetchOrNull<PayslipRow[]>('hrms/me/payslips')
  const rows = payslips ?? []

  const columns: readonly TableColumn<PayslipRow>[] = [
    { key: 'financialYear', header: 'Financial year', render: (row) => row.financialYear },
    {
      key: 'month',
      header: 'Month',
      render: (row) =>
        financialYearMonths(row.financialYear).find((m) => m.month === row.month)?.label ??
        row.month,
    },
    {
      key: 'netPay',
      header: 'Net pay',
      align: 'right',
      render: (row) =>
        typeof row.snapshot?.netPay === 'number' ? hrMoney(row.snapshot.netPay) : '—',
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
            size="sm"
            variant="secondary"
            iconLeft="download"
            prefetch={false}
          >
            Download
          </Button>
        ) : (
          // Payslips imported from the old HR system carry their figures but no
          // PDF, so there is nothing to hand over for those months.
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
            No PDF
          </span>
        ),
    },
  ]

  return (
    <HrPageShell
      crumbs={[{ label: 'Payslips' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Payslips"
      title="Payslips"
      subtitle="Every payslip issued to you."
    >
      <Panel title="Your payslips">
        {rows.length > 0 ? (
          <Table ariaLabel="Payslips" columns={columns} rows={rows} rowKey={(row) => row.id} />
        ) : (
          <EmptyState
            icon="file-text"
            title="No payslips yet"
            description="Payslips appear here once HR generates them."
          />
        )}
      </Panel>
    </HrPageShell>
  )
}
