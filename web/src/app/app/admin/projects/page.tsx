import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { Button } from '@/components/ds/core/Button'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, titleCase, searchTerm, hasFilter } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/projects'
const STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'IN_PROGRESS',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

interface ProjectRow {
  id: string
  reference: string
  title: string
  summary: string | null
  status: string
  priority: string
  platformTargets: readonly string[]
  startDate: string | null
  endDate: string | null
  progressPercent: number
  createdAt: string
  organisation: { id: string; name: string; slug: string } | null
  createdBy: { id: string; firstName: string | null; lastName: string | null } | null
  _count: { bugs: number; assignments: number }
}

/**
 * `/app/admin/projects` — every test cycle across all organisations.
 *
 * Progress is rendered as a bar rather than a number because the useful read is
 * comparative — scanning a column of bars finds the stalled project faster than
 * reading a column of percentages.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; priority?: string; search?: string; page?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : undefined
  const priority = PRIORITIES.includes(params.priority as (typeof PRIORITIES)[number])
    ? params.priority
    : undefined
  const search = searchTerm(params.search)
  const page = parsePage(params.page)

  const result = await loadList<ProjectRow>('projects', {
    page,
    limit: PAGE_SIZE,
    query: { status, priority, search },
  })

  const columns: readonly TableColumn<ProjectRow>[] = [
    {
      key: 'title',
      header: 'Project',
      render: (row) => row.title,
      renderSecondary: (row) =>
        [row.reference, row.organisation?.name].filter(Boolean).join(' · '),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'priority',
      header: 'Priority',
      render: (row) => titleCase(row.priority),
    },
    {
      key: 'progress',
      header: 'Progress',
      width: 140,
      render: (row) => (
        <span
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
          aria-label={`${row.progressPercent}% complete`}
        >
          <span
            aria-hidden="true"
            style={{
              flex: 1,
              height: 6,
              borderRadius: 'var(--radius-full)',
              background: 'var(--surface-sunken)',
              border: '1px solid var(--border-subtle)',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${Math.max(0, Math.min(100, row.progressPercent))}%`,
                background: 'var(--accent-base)',
              }}
            />
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
            {row.progressPercent}%
          </span>
        </span>
      ),
    },
    {
      key: 'bugs',
      header: 'Bugs',
      align: 'right',
      render: (row) => row._count.bugs,
    },
    {
      key: 'testers',
      header: 'Testers',
      align: 'right',
      render: (row) => row._count.assignments,
    },
    {
      key: 'start',
      header: 'Started',
      align: 'right',
      render: (row) => formatDate(row.startDate ?? row.createdAt),
    },
  ]

  return (
    <AdminListPage
      eyebrow="Delivery"
      title="Projects"
      description="Every test cycle across all organisations, newest first. Progress is the figure the project owner reported, not a computed one."
      crumbs={[{ label: 'Projects' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      hrefFor={pageHrefBuilder(BASE, { status, priority, search })}
      
      filtered={hasFilter([status, priority, search])}
      permission="project.read"
      emptyIcon="briefcase"
      emptyTitle="No projects yet"
      emptyDescription="A project appears here once a customer submits one, or when you create it on their behalf."
      toolbar={
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <ListFilters
              action={BASE}
              search={{ value: search, placeholder: 'Title or reference' }}
              selects={[
                {
                  name: 'status',
                  label: 'Status',
                  options: STATUSES,
                  value: status,
                  allLabel: 'All statuses',
                },
                {
                  name: 'priority',
                  label: 'Priority',
                  options: PRIORITIES,
                  value: priority,
                  allLabel: 'All priorities',
                },
              ]}
            />
          </div>
          <Link href="/app/admin/projects/new">
            <Button variant="primary" iconLeft="plus">
              New project
            </Button>
          </Link>
        </div>
      }
    />
  )
}
