import { requireRole } from '@/lib/auth/session'
import { serverFetchPage } from '@/lib/api/server'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Icon } from '@/components/ds/core/Icon'
import { formatDate, personName } from '@/lib/admin/format'

const ROOT = { label: 'Tester', href: '/app/tester' }

/**
 * `/app/tester/ratings` — the ratings this tester has received.
 *
 * This page exists because something already linked to it: every
 * `RATING_RECEIVED` notification the API sends points here, and has since
 * ratings were built. `GET /ratings/mine` was written for it too, average and
 * count included, and had no caller. So the endpoint and the link were both
 * waiting on a page.
 *
 * Hidden ratings are filtered out by the API — a moderated review is not
 * shown to its subject, only to the admin side.
 */

interface RatingRow {
  id: string
  score: number
  comment: string | null
  createdAt: string
  author: { id: string; firstName: string | null; lastName: string | null; role: string } | null
  project: { id: string; reference: string; title: string } | null
}

interface RatingMeta {
  average?: number | null
  count?: number | null
}

function Stars({ score }: { score: number }) {
  return (
    <span
      style={{ display: 'inline-flex', gap: 2, color: 'var(--teal-500, #0b7a6e)' }}
      aria-label={`${score} out of 5`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon
          key={n}
          name="star"
          size={16}
          style={{ opacity: n <= score ? 1 : 0.25 }}
          aria-hidden="true"
        />
      ))}
    </span>
  )
}

export default async function TesterRatingsPage() {
  await requireRole(['TESTER'])

  const { data: ratings, meta } = await serverFetchPage<RatingRow>('ratings/mine', {
    query: { page: 1, limit: 50 },
  })
  const stats = (meta ?? {}) as RatingMeta
  const average = typeof stats.average === 'number' ? stats.average : null

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Ratings' }]}
      eyebrow="Account"
      title="Your ratings"
      subtitle="What the teams you have worked with thought of the work."
    >
      <Panel title="Overall">
        <DescriptionList
          items={[
            { label: 'Average', value: average === null ? 'Not yet rated' : average.toFixed(1) },
            { label: 'Ratings received', value: String(stats.count ?? ratings.length) },
          ]}
        />
      </Panel>

      <Panel title="Ratings">
        {ratings.length === 0 ? (
          <EmptyState
            icon="star"
            title="No ratings yet"
            description="Once a team you have worked with rates your work, it appears here."
          />
        ) : (
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
            {ratings.map((rating) => (
              <li
                key={rating.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-4)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-card)',
                  background: 'var(--surface-canvas)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    flexWrap: 'wrap',
                  }}
                >
                  <Stars score={rating.score} />
                  <span
                    style={{
                      color: 'var(--text-muted)',
                      fontSize: 'var(--type-body-sm-size)',
                    }}
                  >
                    {formatDate(rating.createdAt)}
                  </span>
                </div>
                {rating.project ? (
                  <span
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: 'var(--type-body-sm-size)',
                    }}
                  >
                    {rating.project.reference} · {rating.project.title}
                  </span>
                ) : null}
                {rating.comment ? (
                  <p style={{ margin: 0, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                    {rating.comment}
                  </p>
                ) : null}
                {rating.author ? (
                  <span
                    style={{ color: 'var(--text-muted)', fontSize: 'var(--type-caption-size)' }}
                  >
                    — {personName(rating.author)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </DetailShell>
  )
}
