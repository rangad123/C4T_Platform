import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, hasFilter, personName, stars, titleCase } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/customer/ratings'
const ROOT = { label: 'Customer', href: '/app/customer' }
const SUBJECT_TYPES = ['TESTER', 'CUSTOMER', 'PROJECT'] as const

interface RatingRow {
  id: string
  subjectType: string
  score: number
  comment: string | null
  createdAt: string
  author: { id: string; firstName: string | null; lastName: string | null; role: string } | null
  subjectUser: { id: string; firstName: string | null; lastName: string | null } | null
  project: { id: string; reference: string; title: string } | null
}

/**
 * `/app/customer/ratings` — reviews on this organisation's projects, and
 * those the reader gave or received. `GET /ratings` applies `ratingScope`, so
 * hidden reviews and other organisations' projects never arrive here.
 * Ratings are left from a project's Testers tab, not from this list.
 */
export default async function CustomerRatingsPage({
  searchParams,
}: {
  searchParams: Promise<{ subjectType?: string; projectId?: string; page?: string }>
}) {
  await requireRole(['CUSTOMER'])

  const params = await searchParams
  const subjectType = SUBJECT_TYPES.includes(params.subjectType as (typeof SUBJECT_TYPES)[number])
    ? params.subjectType
    : undefined
  const projectId = params.projectId?.length === 25 ? params.projectId : undefined
  const page = parsePage(params.page)

  const result = await loadList<RatingRow>('ratings', {
    page,
    limit: PAGE_SIZE,
    query: { subjectType, projectId },
  })

  const columns: readonly TableColumn<RatingRow>[] = [
    {
      key: 'score',
      header: 'Score',
      width: 130,
      render: (row) => (
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
          <span aria-hidden="true" style={{ color: 'var(--accent-base)' }}>
            {stars(row.score)}
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.score}</span>
        </span>
      ),
    },
    {
      key: 'subject',
      header: 'About',
      render: (row) =>
        row.subjectType === 'PROJECT' ? (row.project?.title ?? '—') : personName(row.subjectUser),
      renderSecondary: (row) => titleCase(row.subjectType),
    },
    {
      key: 'author',
      header: 'From',
      render: (row) => personName(row.author),
      renderSecondary: (row) => (row.author ? titleCase(row.author.role) : undefined),
    },
    {
      key: 'comment',
      header: 'Comment',
      render: (row) => row.comment ?? '—',
      renderSecondary: (row) => row.project?.reference,
    },
    {
      key: 'created',
      header: 'Left',
      align: 'right',
      render: (row) => formatDate(row.createdAt),
    },
  ]

  return (
    <AdminListPage
      root={ROOT}
      eyebrow="Insights"
      title="Ratings"
      description="Reviews on your projects: the ratings you gave testers, and what testers said about the work."
      crumbs={
        projectId
          ? [
              { label: 'Projects', href: '/app/customer/projects' },
              { label: 'Project', href: `/app/customer/projects/${projectId}` },
              { label: 'Ratings' },
            ]
          : [{ label: 'Ratings' }]
      }
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      hrefFor={pageHrefBuilder(BASE, { subjectType, projectId })}
      filtered={hasFilter([subjectType, projectId])}
      permission="rating.read"
      emptyIcon="star"
      emptyTitle="No ratings yet"
      emptyDescription="A rating appears here when you review a tester from a project's Testers tab, or a tester reviews one of your projects."
      toolbar={
        <ListFilters
          action={BASE}
          hidden={{ projectId }}
          selects={[
            {
              name: 'subjectType',
              label: 'About',
              options: SUBJECT_TYPES,
              value: subjectType,
              allLabel: 'Everything',
            },
          ]}
        />
      }
    />
  )
}
