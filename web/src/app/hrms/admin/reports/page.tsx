import type { Metadata } from 'next'
import {
  currentFinancialYear,
  recentFinancialYears,
  financialYearMonths,
} from '@/lib/hrms/financial-year'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { Button } from '@/components/ds/core/Button'

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

export default function HrAdminReportsPage() {
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
        <form
          method="get"
          action="/admin/reports/download"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 'var(--space-5)',
            alignItems: 'end',
          }}
        >
          <Field label="Financial year" htmlFor="financialYear" required>
            <Select
              id="financialYear"
              name="financialYear"
              required
              defaultValue={financialYear}
              options={yearOptions}
            />
          </Field>
          <Field label="Report type" htmlFor="reportType" required>
            <Select id="reportType" name="reportType" required options={REPORT_TYPES} />
          </Field>
          <Field label="Report period" htmlFor="period" required>
            <Select id="period" name="period" required options={PERIODS} />
          </Field>
          <Field label="Month" htmlFor="month" hint="Used for a monthly report.">
            <Select id="month" name="month" options={monthOptions} />
          </Field>
          <Field label="Quarter" htmlFor="quarter" hint="Used for a quarterly report.">
            <Select id="quarter" name="quarter" options={QUARTERS} placeholder="Select quarter" />
          </Field>
          <Button type="submit" variant="primary" iconLeft="download">
            Generate report
          </Button>
        </form>
      </Panel>
    </HrPageShell>
  )
}
