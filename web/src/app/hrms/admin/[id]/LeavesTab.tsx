import { serverFetchOrNull } from '@/lib/api/server'
import { HrFinancialYearPicker } from '@/components/hrms/HrFinancialYearPicker'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Button } from '@/components/ds/core/Button'
import { decideLeaveRequest } from './actions'

interface BalanceRow {
  leaveType: { id: string; name: string }
  allocated: number
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

export async function LeavesTab({
  employeeId,
  detailPath,
  financialYear,
}: {
  employeeId: string
  detailPath: string
  financialYear: string
}) {
  const [balances, requests] = await Promise.all([
    serverFetchOrNull<BalanceRow[]>(`hrms/employees/${employeeId}/leaves/balances`, {
      query: { financialYear },
    }),
    serverFetchOrNull<RequestRow[]>(`hrms/employees/${employeeId}/leaves/requests`),
  ])

  const balanceColumns: readonly TableColumn<BalanceRow>[] = [
    { key: 'type', header: 'Leave type', render: (row) => row.leaveType.name },
    { key: 'allocated', header: 'Allocated', render: (row) => row.allocated },
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
    { key: 'reason', header: 'Reason', render: (row) => row.reason ?? '—' },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) =>
        row.status === 'PENDING' ? (
          <span style={{ display: 'inline-flex', gap: 'var(--space-3)' }}>
            <form action={decideLeaveRequest.bind(null, employeeId)}>
              <input type="hidden" name="financialYear" value={financialYear} />
              <input type="hidden" name="requestId" value={row.id} />
              <input type="hidden" name="status" value="APPROVED" />
              <Button type="submit" variant="secondary" size="sm" iconLeft="check-circle-2">
                Approve
              </Button>
            </form>
            <form action={decideLeaveRequest.bind(null, employeeId)}>
              <input type="hidden" name="financialYear" value={financialYear} />
              <input type="hidden" name="requestId" value={row.id} />
              <input type="hidden" name="status" value="REJECTED" />
              <Button type="submit" variant="secondary" size="sm" iconLeft="x">
                Reject
              </Button>
            </form>
          </span>
        ) : null,
    },
  ]

  return (
    <>
      <HrFinancialYearPicker action={detailPath} section="leaves" financialYear={financialYear} />

      <Panel title="Balance" description={`For ${financialYear}.`}>
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

      <Panel title="Requests">
        {requests && requests.length > 0 ? (
          <Table
            ariaLabel="Leave requests"
            columns={requestColumns}
            rows={requests}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState icon="plane" title="No leave requests yet" />
        )}
      </Panel>
    </>
  )
}
