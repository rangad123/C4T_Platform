import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import { currentFinancialYear, isValidFinancialYear } from '@/lib/hrms/financial-year'
import { loadLeaveTypeOptions } from '@/lib/hrms/hr-catalog'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { applyForLeave, cancelLeaveRequest } from '../actions'

export const metadata: Metadata = { title: 'Leaves' }

interface BalanceRow {
  leaveType: { id: string; name: string }
  allocated: number
  annualDays: number
  accruesMonthly: boolean
  used: number
  remaining: number
}

interface RequestRow {
  id: string
  startDate: string
  endDate: string
  days: number
  reason: string | null
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
  leaveType: { id: string; name: string }
}

export default async function HrEmployeeLeavesPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; error?: string }>
}) {
  const params = await searchParams
  const financialYear =
    params.fy && isValidFinancialYear(params.fy) ? params.fy : currentFinancialYear()

  const [balances, requests, leaveTypes] = await Promise.all([
    serverFetchOrNull<BalanceRow[]>('hrms/leaves/balances', { query: { financialYear } }),
    serverFetchOrNull<RequestRow[]>('hrms/leaves/requests'),
    loadLeaveTypeOptions(),
  ])

  const balanceColumns: readonly TableColumn<BalanceRow>[] = [
    { key: 'type', header: 'Leave type', render: (row) => row.leaveType.name },
    { key: 'allocated', header: 'Earned so far', render: (row) => row.allocated },
    { key: 'annual', header: 'For the year', render: (row) => row.annualDays },
    { key: 'used', header: 'Used', render: (row) => row.used },
    { key: 'remaining', header: 'Remaining', render: (row) => row.remaining },
  ]

  const requestColumns: readonly TableColumn<RequestRow>[] = [
    { key: 'type', header: 'Type', render: (row) => row.leaveType.name },
    {
      key: 'dates',
      header: 'Dates',
      render: (row) =>
        `${new Date(row.startDate).toLocaleDateString()} – ${new Date(row.endDate).toLocaleDateString()}`,
    },
    { key: 'days', header: 'Days', render: (row) => row.days },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) =>
        row.status === 'PENDING' || row.status === 'APPROVED' ? (
          <form action={cancelLeaveRequest.bind(null, row.id)}>
            <input type="hidden" name="financialYear" value={financialYear} />
            <ConfirmSubmit question="Cancel this leave request?" size="sm" iconLeft="x">
              Cancel
            </ConfirmSubmit>
          </form>
        ) : null,
    },
  ]

  return (
    <HrPageShell
      crumbs={[{ label: 'Leaves' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Leaves"
      title="Leaves"
      subtitle="Your leave balance, applications and history."
    >
      <HrFinancialYearPicker action="/employee/leaves" section="" financialYear={financialYear} />

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

      <Panel
        title="Balance"
        description={`For ${financialYear}. Casual and privilege leave are earned a month at a time, on the 1st, so the balance grows through the year.`}
      >
        {balances && balances.length > 0 ? (
          <Table
            ariaLabel="Leave balance"
            columns={balanceColumns}
            rows={balances}
            rowKey={(row) => row.leaveType.id}
          />
        ) : (
          <EmptyState icon="plane" title="No leave types configured" />
        )}
      </Panel>

      <Panel title="Apply for leave">
        <TrackedForm
          action={applyForLeave}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 'var(--space-4)',
            alignItems: 'end',
          }}
        >
          <input type="hidden" name="financialYear" value={financialYear} />
          <Field label="Leave type" htmlFor="leaveTypeId" required>
            <Select
              id="leaveTypeId"
              name="leaveTypeId"
              required
              options={leaveTypes}
              placeholder="Select type"
            />
          </Field>
          <Field label="From" htmlFor="startDate" required>
            <Input id="startDate" name="startDate" type="date" required />
          </Field>
          <Field label="To" htmlFor="endDate" required>
            <Input id="endDate" name="endDate" type="date" required />
          </Field>
          <Field label="Reason" htmlFor="reason">
            <Input id="reason" name="reason" maxLength={500} />
          </Field>
          <SubmitButton variant="primary" pendingLabel="Applying…">
            Apply
          </SubmitButton>
        </TrackedForm>
      </Panel>

      <Panel title="Your requests">
        {requests && requests.length > 0 ? (
          <Table
            ariaLabel="Leave requests"
            columns={requestColumns}
            rows={requests}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState
            icon="plane"
            title="No leave requests yet"
            description="Apply for leave to see it listed here."
          />
        )}
      </Panel>
    </HrPageShell>
  )
}
