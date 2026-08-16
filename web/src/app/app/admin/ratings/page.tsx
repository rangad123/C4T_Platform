import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Badge } from '@/components/ds/core/Badge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, personName, stars, titleCase } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/ratings'
const SUBJECT_TYPES = ['TESTER', 'CUSTOMER', 'PROJECT'] as const

interface RatingRow {
  id: string
  subjectType: string
  score: number
  comment: string | null
  isVisible: boolean
  createdAt: string
  author: { id: string; firstName: string | null; lastName: string | null; role: string } | null
  subjectUser: { id: string; firstName: string | null; lastName: string | null } | null
  project: { id: string; reference: string; title: string } | null
}

/**
 * `/app/admin/ratings` — reviews left on testers, customers and projects.
 *
 * The score is shown as stars *and* as a number. Stars alone are hard to read
 * quickly in a dense column and impossible to read at all through a screen
 * reader, so the glyphs are decorative and the number carries the value.
 *
 * Hidden reviews stay in the list with a "Hidden" pill rather than being
 * filtered out: an admin hiding an abusive review needs to still see it, and a
 * moderation action that makes its own target disappear is hard to undo.
 */
export default async function RatingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    subjectType?: string
    /**
     * Tester-scoped view. Set when arriving from a tester's "View all
     * ratings" link — narrows the list to ratings where this user is the
     * subject. The API filter accepts this on `listRatingsQuery`.
     */
    subjectUserId?: string
    page?: string
  }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const subjectType = SUBJECT_TYPES.includes(params.subjectType as (typeof SUBJECT_TYPES)[number])
    ? params.subjectType
    : undefined
  const subjectUserId = params.subjectUserId?.length === 25 ? params.subjectUserId : undefined
  const page = parsePage(params.page)

  const result = await loadList<RatingRow>('ratings', {
    page,
    limit: PAGE_SIZE,
    query: { subjectType, subjectUserId },
  })

  const columns: readonly TableColumn<RatingRow>[] = [
    {
      key: 'score',
      header: 'Score',
      width: 130,
      render: (row) => (
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
          <span aria-hidden="true" style={{ color: 'var(--accent-base)', letterSpacing: 1 }}>
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
        row.subjectType === 'PROJECT'
          ? (row.project?.title ?? '—')
          : personName(row.subjectUser),
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
      key: 'visible',
      header: 'Visibility',
      render: (row) =>
        row.isVisible ? (
          <Badge tone="success" uppercase={false}>
            Visible
          </Badge>
        ) : (
          <Badge tone="error" uppercase={false}>
            Hidden
          </Badge>
        ),
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
      eyebrow="Delivery"
      title="Ratings"
      description="Reviews left on testers, customers and projects. Hidden reviews stay listed so a moderation decision can be reversed."
      crumbs={
        subjectUserId
          ? [
              { label: 'Testers', href: '/app/admin/testers' },
              { label: 'Tester', href: `/app/admin/testers/${subjectUserId}` },
              { label: 'Ratings' },
            ]
          : [{ label: 'Ratings' }]
      }
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      hrefFor={pageHrefBuilder(BASE, { subjectType, subjectUserId })}
      filtered={Boolean(subjectType || subjectUserId)} /* eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- any-of filter set */
      permission="rating.read"
      emptyIcon="trophy"
      emptyTitle={subjectUserId ? 'No ratings for this tester yet' : 'No ratings yet'}
      emptyDescription={
        subjectUserId
          ? 'Reviews written about this tester appear here. Clear the subject filter to see all ratings.'
          : 'A rating appears here when a customer reviews a tester, or a tester reviews a project.'
      }
      toolbar={
        <ListFilters
          action={BASE}
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
