import { serverFetchOrNull } from '@/lib/api/server'
import { financialYearMonths, recentFinancialYears } from '@/lib/hrms/financial-year'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { Select } from '@/components/ds/forms/Select'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'

interface EntryRow {
  id: string
  date: string
  description: string | null
  hours: number
  extraHours: number
}

interface Summary {
  workingDays: number
  paidDays: number
  unpaidLeaveDays: number
  loggedHours: number
  entryCount: number
}

export async function TimesheetTab({
  employeeId,
  detailPath,
  financialYear,
  month,
}: {
  employeeId: string
  detailPath: string
  financialYear: string
  month: number
}) {
  const months = financialYearMonths(financialYear)

  const [entries, summary] = await Promise.all([
    serverFetchOrNull<EntryRow[]>(`hrms/employees/${employeeId}/timesheet/entries`, {
      query: { financialYear, month },
    }),
    serverFetchOrNull<Summary>(`hrms/employees/${employeeId}/timesheet/summary`, {
      query: { financialYear, month },
    }),
  ])

  const columns: readonly TableColumn<EntryRow>[] = [
    { key: 'date', header: 'Date', render: (row) => new Date(row.date).toLocaleDateString() },
    { key: 'description', header: 'Description', render: (row) => row.description ?? '—' },
    { key: 'hours', header: 'Hours', render: (row) => row.hours },
    { key: 'extraHours', header: 'Extra hours', render: (row) => row.extraHours },
  ]

  return (
    <>
      <LiveGetForm
        action={detailPath}
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
      >
        <input type="hidden" name="section" value="timesheet" />
        <Select name="fy" defaultValue={financialYear} options={recentFinancialYears(6)} />
        <Select
          name="month"
          defaultValue={String(month)}
          options={months.map((m) => ({ value: String(m.month), label: m.label }))}
        />
        <LiveFormStatus />
      </LiveGetForm>

      <Panel
        title="Summary"
        description="Read-only — timesheets are logged by the employee themselves."
      >
        {summary ? (
          <DescriptionList
            items={[
              { label: 'Working days', value: summary.workingDays },
              { label: 'Paid days', value: summary.paidDays },
              { label: 'Unpaid leave days', value: summary.unpaidLeaveDays },
              { label: 'Logged hours', value: summary.loggedHours },
            ]}
          />
        ) : (
          <EmptyState icon="clock" title="Could not load this month's summary" />
        )}
      </Panel>

      <Panel title="Entries">
        {entries && entries.length > 0 ? (
          <Table
            ariaLabel="Timesheet entries"
            columns={columns}
            rows={entries}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="clock" title="No timesheet entries for this month" />
        )}
      </Panel>
    </>
  )
}
