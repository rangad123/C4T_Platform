import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { Select } from '@/components/ds/forms/Select'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'

export const metadata: Metadata = { title: 'Holidays list' }

interface HolidayRow {
  id: string
  date: string
  name: string
}

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => String(CURRENT_YEAR - i))

export default async function HrEmployeeHolidaysPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>
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
  ]

  return (
    <HrPageShell
      crumbs={[{ label: 'Holidays list' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Holidays"
      title="Holidays list"
      subtitle="The company holiday calendar."
    >
      <LiveGetForm
        action="/employee/holidays"
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
      >
        <Select name="year" defaultValue={String(year)} options={YEAR_OPTIONS} aria-label="Year" />
        <LiveFormStatus />
      </LiveGetForm>

      <Panel title={`Holidays in ${year}`}>
        {holidays && holidays.length > 0 ? (
          <Table ariaLabel="Holidays" columns={columns} rows={holidays} rowKey={(row) => row.id} />
        ) : (
          <EmptyState icon="calendar" title="No holidays added for this year" />
        )}
      </Panel>
    </HrPageShell>
  )
}
