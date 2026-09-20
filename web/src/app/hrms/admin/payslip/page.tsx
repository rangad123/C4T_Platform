import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import {
  financialYearMonths,
  financialYearOf,
  isValidFinancialYear,
  recentFinancialYears,
} from '@/lib/hrms/financial-year'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { PayslipRun, type RunRow } from './PayslipRun'

export const metadata: Metadata = { title: 'Payslip' }

const BASE = '/admin/payslip'

/**
 * A payslip is for a month that has ended, so the run opens on last month —
 * the one an admin is almost always here to do.
 */
function previousMonth(): { financialYear: string; month: number } {
  const now = new Date()
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return { financialYear: financialYearOf(last), month: last.getMonth() + 1 }
}

/**
 * Generates a month's payslips for every active employee in one run. There is
 * no per-employee picker here: one person's payslip can still be generated,
 * regenerated and downloaded from the Payslip tab on their own record, which
 * is where the run's rows link to.
 */
export default async function HrAdminPayslipPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; month?: string }>
}) {
  const params = await searchParams
  const fallback = previousMonth()
  const financialYear =
    params.fy && isValidFinancialYear(params.fy) ? params.fy : fallback.financialYear
  const requested = Number(params.month)
  const month =
    Number.isInteger(requested) && requested >= 1 && requested <= 12 ? requested : fallback.month

  const months = financialYearMonths(financialYear)
  const monthLabel = months.find((m) => m.month === month)?.label ?? String(month)

  const rows = await serverFetchOrNull<RunRow[]>('hrms/payslips/run', {
    query: { financialYear, month },
  })

  return (
    <HrPageShell
      crumbs={[{ label: 'Payslip' }]}
      root={{ label: 'Admin', href: '/admin' }}
      eyebrow="Payslip"
      title="Payslip"
      subtitle="Generate a month's payslips for every active employee in one run. To download or regenerate one person's, open their record."
    >
      <Panel title="Pay period">
        <LiveGetForm
          action={BASE}
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <Field label="Financial year" htmlFor="run-fy">
            <Select
              id="run-fy"
              name="fy"
              defaultValue={financialYear}
              options={recentFinancialYears(6).map((fy) => ({ value: fy, label: fy }))}
            />
          </Field>
          <Field label="Month" htmlFor="run-month">
            <Select
              id="run-month"
              name="month"
              defaultValue={String(month)}
              options={months.map((m) => ({ value: String(m.month), label: m.label }))}
            />
          </Field>
          <LiveFormStatus />
        </LiveGetForm>
      </Panel>

      <Panel title={`Payslips for ${monthLabel}`}>
        {rows ? (
          rows.length > 0 ? (
            <PayslipRun
              // A different period is a different run: remounting drops the
              // progress the last one was showing.
              key={`${financialYear}-${month}`}
              rows={rows}
              financialYear={financialYear}
              month={month}
              monthLabel={monthLabel}
            />
          ) : (
            <EmptyState
              icon="users"
              title="No active employees"
              description="Add an employee first."
            />
          )
        ) : (
          <EmptyState
            icon="alert-triangle"
            title="Couldn't load the payslip run"
            description="The service is unreachable. Refresh in a moment."
          />
        )}
      </Panel>
    </HrPageShell>
  )
}
