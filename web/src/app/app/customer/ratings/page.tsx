import { requireRole } from '@/lib/auth/session'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Pagination } from '@/components/ds/admin/Pagination'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { formatDate, personName, stars, titleCase } from '@/lib/admin/format'

const ROOT = { label: 'Customer', href: '/app/customer' }
const BASE = '/app/customer/ratings'
const PAGE_SIZE = 25

/**
 * `/app/customer/ratings` — feedback on this organisation's projects.
 *
 * `GET /ratings` is org-scoped for a CUSTOMER caller, so this shows the
 * ratings your own people left on testers and the ones testers left on your
 * projects — never another organisation's.
 *
 * Read-only. Leaving a rating happens where the judgement is being made — on
 * the project once work finishes — not from a list page, and the API scopes
 * who may rate whom. Rendering a compose form here would offer something the
 * page has no context for.
 *
 * The API does not send the rated tester's email to a customer, so only names
 * appear.
 */

interface RatingRow {
  id: string
  subjectType: string
  score: number
  comment: string | null
  isVisible: boolean
  createdAt: string
  author: { id: string; firstName: string | null; lastName: string | null; role: string } | null
  subjectUser: { id: string; firstName: string | null; lastName: string | null; role: string } | null
  project: { id: string; reference: string; title: string } | null
}

export default async function CustomerRatingsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  await requireRole(['CUSTOMER'])
  const params = await searchParams
  const page = parsePage(params.page)

  const result = await loadList<RatingRow>('ratings', {
    page,
    limit: PAGE_SIZE,
    query: { sort: 'createdAt', order: 'desc' },
  })

  const rows = 'items' in result ? result.items : []
  const failed = 'error' in result
  const meta = 'meta' in result ? result.meta : null

  /** Mean across what is on this page, shown only when there is enough to mean anything. */
  const average =
    rows.length > 0 ? rows.reduce((sum, r) => sum + r.score, 0) / rows.length : null

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Ratings' }]}
      eyebrow="Insights"
      title="Ratings"
      subtitle={
        average != null
          ? `${meta?.total ?? rows.length} rating${(meta?.total ?? rows.length) === 1 ? '' : 's'}, averaging ${average.toFixed(1)} out of 5.`
          : 'Feedback given and received on your projects.'
      }
    >
      {failed ? (
        <EmptyState
          icon="alert-triangle"
          title="Ratings could not be loaded"
          description="Refresh in a moment."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="star"
          title="No ratings yet"
          description="Once testing finishes on a project, ratings left by and about your team appear here."
        />
      ) : (
        <>
          <Panel title="Feedback" description="Most recent first.">
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-4)',
              }}
            >
              {rows.map((rating) => (
                <li
                  key={rating.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-5)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-card)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 'var(--space-3)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 'var(--fw-semibold)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {/* Direct-labelled: the stars carry the score visually,
                          the number carries it for a screen reader. */}
                      <span aria-hidden="true">{stars(rating.score)}</span>{' '}
                      <span className="c4t-visually-hidden">
                        {rating.score} out of 5.
                      </span>
                      {rating.subjectUser ? personName(rating.subjectUser) : titleCase(rating.subjectType)}
                    </span>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                      {/* A hidden rating is one an admin has withheld from the
                          rated person; saying so beats it silently differing. */}
                      {!rating.isVisible ? (
                        <Badge tone="neutral" uppercase={false}>
                          Not shown to them
                        </Badge>
                      ) : null}
                      <span
                        style={{
                          fontSize: 'var(--type-caption-size)',
                          color: 'var(--text-muted)',
                        }}
                      >
                        {formatDate(rating.createdAt)}
                      </span>
                    </div>
                  </div>

                  {rating.comment ? (
                    <p style={{ margin: 0, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
                      {rating.comment}
                    </p>
                  ) : null}

                  <span
                    style={{ fontSize: 'var(--type-caption-size)', color: 'var(--text-muted)' }}
                  >
                    {rating.author ? `By ${personName(rating.author)}` : 'By your team'}
                    {rating.project ? ` · ${rating.project.reference}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          {meta ? (
            <Pagination
              page={meta.page}
              totalPages={meta.totalPages}
              total={meta.total}
              limit={meta.limit}
              hrefFor={pageHrefBuilder(BASE, {})}
            />
          ) : null}
        </>
      )}
    </DetailShell>
  )
}
