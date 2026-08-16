import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Avatar } from '@/components/admin/Avatar'
import { CountryFlag } from '@/components/admin/CountryFlag'
import { Button } from '@/components/ds/core/Button'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, personName, searchTerm, hasFilter } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/testers'
const STATUSES = ['APPLIED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED'] as const
const SORT_OPTIONS = [
  { value: 'createdAt', label: 'Applied' },
  { value: 'ratingAverage', label: 'Rating' },
  { value: 'bugsReportedCount', label: 'Bugs reported' },
  { value: 'projectsCompletedCount', label: 'Projects completed' },
  { value: 'status', label: 'Status' },
] as const
const SORT_FIELDS = SORT_OPTIONS.map((o) => o.value)

/**
 * Build the CSV export URL for the current filter set. Goes through the
 * catch-all Route Handler at `/app/admin/export/[...path]` so the export
 * stays same-origin (the route streams from the API on behalf of the browser).
 */
function buildExportHref(filters: {
  status?: string
  countryCode?: string
  search?: string
  sort?: string
  order?: string
}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value)
  }
  const qs = params.toString()
  return qs ? `/app/admin/export/testers?${qs}` : '/app/admin/export/testers'
}

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
    avatarFileId: string | null
  }
  devices: readonly {
    id: string
    model: string | null
    osName: string | null
    osVersion: string | null
    ramGb: string | null
    network: string | null
    browser: string | null
  }[]
  skills: readonly { skill?: { name: string; category?: string } }[]
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
  searchParams: Promise<{
    status?: string
    countryCode?: string
    search?: string
    page?: string
    sort?: string
    order?: string
  }>
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
  const search = searchTerm(params.search)
  const sort = SORT_FIELDS.includes(params.sort as (typeof SORT_FIELDS)[number])
    ? params.sort
    : undefined
  const order = params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined
  const page = parsePage(params.page)

  const result = await loadList<TesterRow>('testers', {
    page,
    limit: PAGE_SIZE,
    query: { status, countryCode, search, sort, order },
  })

  const columns: readonly TableColumn<TesterRow>[] = [
    {
      key: 'name',
      header: 'Tester',
      render: (row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <Avatar name={personName(row.user)} fileId={row.user.avatarFileId} size="sm" />
          {personName(row.user)}
        </span>
      ),
      renderSecondary: (row) => row.user.email,
    },
    {
      key: 'headline',
      header: 'Profile',
      render: (row) => row.headline ?? '—',
      renderSecondary: (row) => {
        const experience = row.experienceYears ? `${row.experienceYears} yrs` : null
        const location = [row.city, row.countryCode].filter(Boolean).join(', ') || null
        if (!experience && !location) return undefined
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {experience ? <span>{experience}</span> : null}
            {experience && location ? <span aria-hidden="true">·</span> : null}
            {location ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                <CountryFlag countryCode={row.countryCode} size={14} />
                <span>{location}</span>
              </span>
            ) : null}
          </span>
        )
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
      hrefFor={pageHrefBuilder(BASE, { status, countryCode, search, sort, order })}
      filtered={hasFilter([status, countryCode, search])}
      permission="tester.read"
      emptyIcon="users"
      emptyTitle="No testers yet"
      emptyDescription="Testers appear here as soon as someone completes the sign-up form."
      toolbar={
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <ListFilters
              action={BASE}
              search={{ value: search, placeholder: 'Name, email or headline' }}
              selects={[
                {
                  name: 'status',
                  label: 'Status',
                  options: STATUSES,
                  value: status,
                  allLabel: 'All statuses',
                },
              ]}
              texts={[
                {
                  name: 'countryCode',
                  label: 'Country',
                  value: countryCode,
                  placeholder: 'ISO 2-letter',
                  maxLength: 2,
                },
              ]}
              sort={{ name: 'sort', orderName: 'order', options: SORT_OPTIONS, value: sort, order }}
            />
          </div>
          <Link href={buildExportHref({ status, countryCode, search, sort, order })} prefetch={false}>
            <Button variant="secondary" iconLeft="download">
              Export CSV
            </Button>
          </Link>
        </div>
      }
    />
  )
}
