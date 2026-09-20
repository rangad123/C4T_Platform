import type { Metadata } from 'next'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { searchTerm, hasFilter } from '@/lib/admin/format'
import { HrAdminListPage } from '@/components/hrms/HrAdminListPage'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Button } from '@/components/ds/core/Button'
import type { TableColumn } from '@/components/ds/admin/Table'
import { decideLeaveFromList } from './actions'

export const metadata: Metadata = { title: 'Leaves' }

const BASE = '/admin/leaves'

/**
 * The status filter is a tab rather than a dropdown, and Pending is the first
 * tab. An admin comes here to decide what is waiting, so that is the view the
 * bare URL shows; a dropdown would have needed an "All" that also meant "no
 * choice made yet", which is exactly the ambiguity that made the default
 * unrepresentable.
 */
const TABS = [
  { value: 'pending', label: 'Pending', icon: 'clock' },
  { value: 'approved', label: 'Approved', icon: 'check-circle-2' },
  { value: 'rejected', label: 'Rejected', icon: 'x' },
  { value: 'cancelled', label: 'Cancelled', icon: 'x' },
  { value: 'all', label: 'All', icon: 'list' },
] as const

const STATUS_FOR_TAB: Record<string, string | undefined> = {
  pending: 'PENDING',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  cancelled: 'CANCELLED',
  all: undefined,
}

const NOTICES: Record<string, NoticeCopy> = {
  refused: { tone: 'warning', message: 'That could not be done.' },
}

interface LeaveRow {
  id: string
  startDate: string
  endDate: string
  days: number
  reason: string | null
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
  decidedAt: string | null
  createdAt: string
  leaveType: { id: string; name: string }
  decidedBy: { id: string; firstName: string; lastName: string } | null
  employee: { id: string; firstName: string; lastName: string; employeeCode: string }
}

/** Dates are calendar days, not moments: read them as UTC or they can slip a day. */
function day(iso: string, withYear = false): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  })
}

function range(start: string, end: string): string {
  return start === end ? day(start, true) : `${day(start)} – ${day(end, true)}`
}

export default async function HrAdminLeavesPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string
    section?: string
    search?: string
    notice?: string
    reason?: string
  }>
}) {
  const params = await searchParams
  const page = parsePage(params.page)
  const section = resolveSection(TABS, params.section)
  const search = searchTerm(params.search)

  const result = await loadList<LeaveRow>('hrms/leaves/all', {
    page,
    limit: 20,
    query: { status: STATUS_FOR_TAB[section], search },
  })

  // Comes back with every page whatever the filter, so the Pending tab's count
  // stays true while someone is looking at Approved or All.
  const pending = 'meta' in result ? (result.meta as { pending?: number }).pending : undefined

  const tabs = TABS.map((t) => (t.value === 'pending' && pending ? { ...t, count: pending } : t))

  const columns: readonly TableColumn<LeaveRow>[] = [
    {
      key: 'employee',
      header: 'Employee',
      render: (row) => `${row.employee.firstName} ${row.employee.lastName}`,
      renderSecondary: (row) => row.employee.employeeCode,
    },
    { key: 'type', header: 'Type', render: (row) => row.leaveType.name },
    {
      key: 'dates',
      header: 'Dates',
      render: (row) => range(row.startDate, row.endDate),
      renderSecondary: (row) => `${row.days} ${row.days === 1 ? 'day' : 'days'}`,
    },
    { key: 'reason', header: 'Reason', render: (row) => row.reason ?? '—' },
    { key: 'requested', header: 'Requested', render: (row) => day(row.createdAt, true) },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={row.status} />,
      renderSecondary: (row) =>
        row.decidedBy && row.decidedAt
          ? `${row.decidedBy.firstName} ${row.decidedBy.lastName} · ${day(row.decidedAt, true)}`
          : null,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      // Its own controls, so the row's link to the employee must not swallow
      // the click — see `interactive` on `TableColumn`.
      interactive: true,
      render: (row) =>
        row.status === 'PENDING' ? (
          <span style={{ display: 'inline-flex', gap: 'var(--space-3)' }}>
            {(['APPROVED', 'REJECTED'] as const).map((decision) => (
              <form key={decision} action={decideLeaveFromList}>
                <input type="hidden" name="employeeId" value={row.employee.id} />
                <input type="hidden" name="requestId" value={row.id} />
                <input type="hidden" name="status" value={decision} />
                <input type="hidden" name="section" value={section} />
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  iconLeft={decision === 'APPROVED' ? 'check-circle-2' : 'x'}
                >
                  {decision === 'APPROVED' ? 'Approve' : 'Reject'}
                </Button>
              </form>
            ))}
          </span>
        ) : null,
    },
  ]

  const tabLabel = TABS.find((t) => t.value === section)?.label.toLowerCase() ?? ''

  return (
    <HrAdminListPage
      eyebrow="Leaves"
      title="Leaves"
      description="Every employee's leave requests. Approve or reject what is waiting, or look back at what was decided."
      crumbs={[{ label: 'Leaves' }]}
      root={{ label: 'Admin', href: '/admin' }}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `/admin/${row.employee.id}?section=leaves`}
      hrefFor={pageHrefBuilder(BASE, {
        section: section === 'pending' ? undefined : section,
        search,
      })}
      filtered={hasFilter([search])}
      emptyIcon="plane"
      emptyTitle={section === 'all' ? 'No leave requests yet' : `Nothing ${tabLabel}`}
      emptyDescription={
        section === 'pending'
          ? 'Requests employees submit will appear here for you to approve.'
          : 'Requests in this state will appear here.'
      }
      tabs={<SectionTabs basePath={BASE} tabs={tabs} active={section} preserve={{ search }} />}
      toolbar={
        <>
          <Notice
            code={params.notice}
            notices={
              params.notice && params.reason
                ? { ...NOTICES, [params.notice]: { tone: 'warning', message: params.reason } }
                : NOTICES
            }
          />
          <ListFilters
            action={BASE}
            search={{ value: search, placeholder: 'Search name, email or employee code' }}
            hidden={{ section: section === 'pending' ? undefined : section }}
          />
        </>
      }
    />
  )
}
