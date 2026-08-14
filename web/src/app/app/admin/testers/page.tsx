import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, personName } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/testers'
const STATUSES = ['APPLIED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED'] as const

interface TesterRow {
  id: string
  status: string
  headline: string | null
  experienceYears: number | null
  city: string | null
  countryCode: string | null
  ratingAverage: number | null
  ratingCount: number
  bugsReportedCount: number
  bugsAcceptedCount: number
  projectsCompletedCount: number
  verifiedAt: string | null
  createdAt: string
  user: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    status: string
  }
  devices: readonly { id: string; model: string | null; osName: string | null }[]
  skills: readonly { skill?: { name: string } }[]
}

/**
 * `/app/admin/testers` — the tester pool, including applications awaiting
 * review.
 *
 * The default sort puts newest first, which means an unreviewed APPLIED profile
 * surfaces at the top without needing a filter — the common reason to open this
 * page is "who is waiting on me".
 *
 * `bugsAccepted / bugsReported` is shown as a pair rather than an acceptance
 * percentage: a tester with 1-of-1 accepted is not more reliable than one with
 * 40-of-50, and a bare percentage hides that.
 */
export default async function TestersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; countryCode?: string; page?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : undefined
  // The API validates this as exactly two letters, so anything else is dropped
  // here rather than sent on to earn a 422.
  const raw = params.countryCode?.trim().toUpperCase()
  const countryCode = raw && /^[A-Z]{2}$/.test(raw) ? raw : undefined
  const page = parsePage(params.page)

  const result = await loadList<TesterRow>('testers', {
    page,
    limit: PAGE_SIZE,
    query: { status, countryCode },
  })

  const columns: readonly TableColumn<TesterRow>[] = [
    {
      key: 'name',
      header: 'Tester',
      render: (row) => personName(row.user),
      renderSecondary: (row) => row.user.email,
    },
    {
      key: 'headline',
      header: 'Profile',
      render: (row) => row.headline ?? '—',
      renderSecondary: (row) => {
        const bits = [
          row.experienceYears ? `${row.experienceYears} yrs` : null,
          [row.city, row.countryCode].filter(Boolean).join(', ') || null,
        ].filter(Boolean)
        return bits.length > 0 ? bits.join(' · ') : undefined
      },
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'rating',
      header: 'Rating',
      align: 'right',
      render: (row) => (row.ratingAverage === null ? '—' : row.ratingAverage.toFixed(1)),
      renderSecondary: (row) => (row.ratingCount > 0 ? `${row.ratingCount} reviews` : undefined),
    },
    {
      key: 'bugs',
      header: 'Bugs',
      align: 'right',
      render: (row) => `${row.bugsAcceptedCount} / ${row.bugsReportedCount}`,
    },
    {
      key: 'joined',
      header: 'Applied',
      align: 'right',
      render: (row) => formatDate(row.createdAt),
    },
  ]

  return (
    <AdminListPage
      eyebrow="Accounts"
      title="Testers"
      description="The tester pool and the applications waiting on review. Bugs shows accepted against reported, so a high reported count with few accepted is visible at a glance."
      crumbs={[{ label: 'Testers' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { status, countryCode })}
      filtered={Boolean(status || countryCode)}
      permission="tester.read"
      emptyIcon="users"
      emptyTitle="No testers yet"
      emptyDescription="Testers appear here as soon as someone completes the sign-up form."
      toolbar={
        <ListFilters
          action={BASE}
          selects={[
            {
              name: 'status',
              label: 'Status',
              options: STATUSES,
              value: status,
              allLabel: 'All statuses',
            },
          ]}
        />
      }
    />
  )
}
