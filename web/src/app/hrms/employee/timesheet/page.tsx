import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import {
  currentFinancialYear,
  isValidFinancialYear,
  financialYearMonths,
  currentMonthInFinancialYear,
  recentFinancialYears,
} from '@/lib/hrms/financial-year'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { saveTimesheetEntry, deleteTimesheetEntry } from '../actions'

export const metadata: Metadata = { title: 'Timesheet' }

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

export default async function HrEmployeeTimesheetPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; month?: string; error?: string }>
}) {
  const params = await searchParams
  const financialYear =
    params.fy && isValidFinancialYear(params.fy) ? params.fy : currentFinancialYear()
  const months = financialYearMonths(financialYear)
  const month = months.some((m) => String(m.month) === params.month)
    ? Number(params.month)
    : currentMonthInFinancialYear(financialYear)

  const [entries, summary] = await Promise.all([
    serverFetchOrNull<EntryRow[]>('hrms/timesheet/entries', { query: { financialYear, month } }),
    serverFetchOrNull<Summary>('hrms/timesheet/summary', { query: { financialYear, month } }),
  ])

  const columns: readonly TableColumn<EntryRow>[] = [
    { key: 'date', header: 'Date', render: (row) => new Date(row.date).toLocaleDateString() },
    { key: 'description', header: 'Description', render: (row) => row.description ?? '—' },
    { key: 'hours', header: 'Hours', render: (row) => row.hours },
    { key: 'extraHours', header: 'Extra hours', render: (row) => row.extraHours },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) => (
        <form action={deleteTimesheetEntry.bind(null, row.id)}>
          <input type="hidden" name="financialYear" value={financialYear} />
          <input type="hidden" name="month" value={month} />
          <ConfirmSubmit question="Remove this entry?" size="sm" iconLeft="trash-2">
            Remove
          </ConfirmSubmit>
        </form>
      ),
    },
  ]

  return (
    <HrPageShell
      crumbs={[{ label: 'Timesheet' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Timesheet"
      title="Timesheet"
      subtitle="Your logged working days for the month."
    >
      <LiveGetForm
        action="/employee/timesheet"
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
      >
        <Select name="fy" defaultValue={financialYear} options={recentFinancialYears(6)} />
        <Select
          name="month"
          defaultValue={String(month)}
          options={months.map((m) => ({ value: String(m.month), label: m.label }))}
        />
        <LiveFormStatus />
      </LiveGetForm>

      {params.error ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-5)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            borderRadius: 'var(--radius-input)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          <Icon name="alert-triangle" size={18} style={{ flex: 'none', marginTop: 2 }} />
          <span>{decodeURIComponent(params.error)}</span>
        </div>
      ) : null}

      <Panel title="Summary">
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
        <TrackedForm
          action={saveTimesheetEntry}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 'var(--space-4)',
            marginBottom: 'var(--space-6)',
            alignItems: 'end',
          }}
        >
          <input type="hidden" name="financialYear" value={financialYear} />
          <input type="hidden" name="month" value={month} />
          <Field label="Date" htmlFor="entryDate" required>
            <Input id="entryDate" name="date" type="date" required />
          </Field>
          <Field label="Hours" htmlFor="hours" required>
            <Input
              id="hours"
              name="hours"
              type="number"
              min={0}
              max={24}
              step="0.5"
              required
              defaultValue={8}
            />
          </Field>
          <Field label="Extra hours" htmlFor="extraHours">
            <Input
              id="extraHours"
              name="extraHours"
              type="number"
              min={0}
              max={24}
              step="0.5"
              defaultValue={0}
            />
          </Field>
          <Field label="Description" htmlFor="entryDescription">
            <Input id="entryDescription" name="description" maxLength={500} />
          </Field>
          <SubmitButton variant="primary" pendingLabel="Saving…">
            Save entry
          </SubmitButton>
        </TrackedForm>
        {entries && entries.length > 0 ? (
          <Table
            ariaLabel="Timesheet entries"
            columns={columns}
            rows={entries}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="clock" title="No timesheet entries yet" />
        )}
      </Panel>
    </HrPageShell>
  )
}
