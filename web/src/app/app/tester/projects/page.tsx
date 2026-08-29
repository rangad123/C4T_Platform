import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, titleCase, hasFilter } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/tester/projects'
const ROOT = { label: 'Tester', href: '/app/tester' }

/**
 * The assignment lifecycle, from `AssignmentStatus` on the API. This is the
 * tester's own standing on a project — not the project's status.
 */
const ASSIGNMENT_STATUSES = [
  'INVITED',
  'ACCEPTED',
  'ACTIVE',
  'DECLINED',
  'COMPLETED',
  'REMOVED',
] as const

/** Row shape of `GET /v1/projects/my-assignments` — see `listMyAssignments`. */
interface AssignmentRow {
  status: string
  invitedAt: string
  respondedAt: string | null
  completedAt: string | null
  notes: string | null
  project: {
    id: string
    reference: string
    title: string
    summary: string | null
    status: string
    priority: string
    startDate: string | null
    endDate: string | null
    platformTargets: readonly string[]
    organisation: { id: string; name: string } | null
  } | null
}

/**
 * `/app/tester/projects` — everything this tester has been invited to or is
 * working on.
 *
 * Reads `GET /v1/projects/my-assignments`, which is TESTER-only and already
 * scoped to the caller — there is no tester-supplied filter that could widen
 * it. The row is the ASSIGNMENT, not the project: two testers on the same
 * project see different statuses here, and that difference is the whole point
 * of the page.
 *
 * `loadList` returns a discriminated result rather than throwing, so the three
 * terminal states (forbidden / service down / genuinely empty) stay distinct
 * — `AdminListPage` renders each differently.
 */
export default async function TesterProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>
}) {
  await requireRole(['TESTER'])

  const params = await searchParams
  const status = ASSIGNMENT_STATUSES.includes(params.status as (typeof ASSIGNMENT_STATUSES)[number])
    ? params.status
    : undefined
  const page = parsePage(params.page)

  const result = await loadList<AssignmentRow>('projects/my-assignments', {
    page,
    limit: PAGE_SIZE,
    query: { status },
  })

  const columns: readonly TableColumn<AssignmentRow>[] = [
    {
      key: 'project',
      header: 'Project',
      render: (row) => row.project?.title ?? 'Project unavailable',
      renderSecondary: (row) =>
        [row.project?.reference, row.project?.organisation?.name].filter(Boolean).join(' · '),
    },
    {
      key: 'assignment',
      header: 'Your status',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'projectStatus',
      header: 'Project',
      render: (row) => (row.project ? <StatusBadge status={row.project.status} /> : '—'),
    },
    {
      key: 'priority',
      header: 'Priority',
      render: (row) => (row.project ? titleCase(row.project.priority) : '—'),
    },
    {
      key: 'window',
      header: 'Window',
      align: 'right',
      render: (row) =>
        row.project
          ? `${formatDate(row.project.startDate)} to ${formatDate(row.project.endDate)}`
          : '—',
    },
    {
      key: 'invited',
      header: 'Invited',
      align: 'right',
      render: (row) => formatDate(row.invitedAt),
    },
  ]

  return (
    <AdminListPage
      root={ROOT}
      eyebrow="Work"
      title="Projects"
      description="Everything you've been invited to or are testing. Open one to read the brief and file bugs against it."
      crumbs={[{ label: 'Projects' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.project?.id ?? row.invitedAt}
      /* A row without a project is a soft-deleted project the assignment
         outlived — there is nothing to open, so it stays unlinked rather
         than pointing at a 404. */
      rowHref={(row) => (row.project ? `${BASE}/${row.project.id}` : '')}
      hrefFor={pageHrefBuilder(BASE, { status })}
      filtered={hasFilter([status])}
      permission="project.read"
      emptyIcon="briefcase"
      emptyTitle="No projects yet"
      emptyDescription="When a project invites you to test, it appears here."
      toolbar={
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 280 }}>
            <ListFilters
              action={BASE}
              selects={[
                {
                  name: 'status',
                  label: 'Your status',
                  options: ASSIGNMENT_STATUSES,
                  value: status,
                  allLabel: 'All assignments',
                },
              ]}
            />
          </div>
        </div>
      }
    />
  )
}
