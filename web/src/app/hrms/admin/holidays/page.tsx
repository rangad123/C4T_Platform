import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { Select } from '@/components/ds/forms/Select'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { Icon } from '@/components/ds/core/Icon'
import { addHoliday, deleteHoliday } from './actions'

export const metadata: Metadata = { title: 'Holidays list' }

interface HolidayRow {
  id: string
  date: string
  name: string
}

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => String(CURRENT_YEAR - i))

export default async function HrAdminHolidaysPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; error?: string }>
}) {
  const params = await searchParams
  const year = YEAR_OPTIONS.includes(params.year ?? '') ? Number(params.year) : CURRENT_YEAR

  const holidays = await serverFetchOrNull<HolidayRow[]>('hrms/holidays', { query: { year } })

  const columns: readonly TableColumn<HolidayRow>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (row) =>
        new Date(row.date).toLocaleDateString('en-IN', {
          weekday: 'short',
          day: 'numeric',
          month: 'long',
        }),
    },
    { key: 'name', header: 'Holiday', render: (row) => row.name },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) => (
        <form action={deleteHoliday.bind(null, row.id)}>
          <input type="hidden" name="year" value={year} />
          <ConfirmSubmit question={`Remove "${row.name}"?`} size="sm" iconLeft="trash-2">
            Remove
          </ConfirmSubmit>
        </form>
      ),
    },
  ]

  return (
    <HrPageShell
      crumbs={[{ label: 'Holidays list' }]}
      root={{ label: 'Admin', href: '/admin' }}
      eyebrow="Holidays"
      title="Holidays list"
      subtitle="The company holiday calendar, by year."
    >
      <LiveGetForm
        action="/admin/holidays"
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
      >
        <Select name="year" defaultValue={String(year)} options={YEAR_OPTIONS} aria-label="Year" />
        <LiveFormStatus />
      </LiveGetForm>

      {params.error === 'duplicate' ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-5)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            borderRadius: 'var(--radius-input)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          <Icon name="alert-triangle" size={18} style={{ flex: 'none' }} />
          <span>A holiday is already recorded for that date.</span>
        </div>
      ) : null}

      <Panel title={`Holidays in ${year}`}>
        <TrackedForm
          action={addHoliday}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 'var(--space-4)',
            marginBottom: 'var(--space-6)',
            alignItems: 'end',
          }}
        >
          <Field label="Date" htmlFor="holidayDate" required>
            <Input id="holidayDate" name="date" type="date" required />
          </Field>
          <Field label="Name" htmlFor="holidayName" required>
            <Input
              id="holidayName"
              name="name"
              required
              maxLength={160}
              placeholder="e.g. Diwali"
            />
          </Field>
          <SubmitButton variant="primary" pendingLabel="Adding…">
            Add holiday
          </SubmitButton>
        </TrackedForm>
        {holidays && holidays.length > 0 ? (
          <Table ariaLabel="Holidays" columns={columns} rows={holidays} rowKey={(row) => row.id} />
        ) : (
          <EmptyState
            icon="calendar"
            title="No holidays added for this year"
            description="Use the form above to add the first one."
          />
        )}
      </Panel>
    </HrPageShell>
  )
}
