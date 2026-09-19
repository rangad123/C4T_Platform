import type { Metadata } from 'next'
import {
  currentFinancialYear,
  recentFinancialYears,
  financialYearMonths,
} from '@/lib/hrms/financial-year'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { Icon } from '@/components/ds/core/Icon'
import { ReportForm } from './ReportForm'

export const metadata: Metadata = { title: 'Reports' }

const REPORT_TYPES = [
  { value: 'TIMESHEET', label: 'Timesheet' },
  { value: 'TDS', label: 'TDS' },
  { value: 'PT', label: 'Professional tax' },
]
const PERIODS = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'YEARLY', label: 'Yearly' },
]
const QUARTERS = [
  { value: '1', label: 'Q1 — Apr, May, Jun' },
  { value: '2', label: 'Q2 — Jul, Aug, Sep' },
  { value: '3', label: 'Q3 — Oct, Nov, Dec' },
  { value: '4', label: 'Q4 — Jan, Feb, Mar' },
]

export default async function HrAdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const financialYear = currentFinancialYear()
  const yearOptions = recentFinancialYears(6).map((fy) => ({ value: fy, label: fy }))
  const monthOptions = financialYearMonths(financialYear).map((m) => ({
    value: String(m.month),
    label: m.label,
  }))

  return (
    <HrPageShell
      crumbs={[{ label: 'Reports' }]}
      root={{ label: 'Admin', href: '/admin' }}
      eyebrow="Reports"
      title="Reports"
      subtitle="Timesheet, TDS and PT reports for a financial year, period and type."
    >
      <Panel title="Generate a report">
        {error ? (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-3)',
              padding: 'var(--space-4) var(--space-5)',
              marginBottom: 'var(--space-5)',
              background: 'var(--status-error-bg)',
              color: 'var(--status-error-fg)',
              borderRadius: 'var(--radius-input)',
              fontSize: 'var(--type-body-sm-size)',
              lineHeight: 1.45,
            }}
          >
            <Icon name="alert-triangle" size={18} style={{ flex: 'none', marginTop: 2 }} />
            <span>{error}</span>
          </div>
        ) : null}

        <ReportForm
          financialYear={financialYear}
          yearOptions={yearOptions}
          monthOptions={monthOptions}
          reportTypes={REPORT_TYPES}
          periods={PERIODS}
          quarters={QUARTERS}
        />
      </Panel>
    </HrPageShell>
  )
}
