import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { serverFetchPage } from '@/lib/api/server'
import { Badge } from '@/components/ds/core/Badge'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { formatDateTime, titleCase } from '@/lib/admin/format'

interface AnnouncementRow {
  id: string
  title: string
  body: string
  audience: string
  projectId: string | null
  project: { id: string; reference: string; title: string } | null
  publishedAt: string | null
  expiresAt: string | null
  author: { id: string; firstName: string | null; lastName: string | null } | null
}

/**
 * `/app/tester/announcements` — what the platform has told this tester.
 *
 * The API does all the scoping, and it is two independent axes:
 *
 *   audience — `announcementAudienceFor` maps TESTER to [ALL, TESTERS], so an
 *              admin-only note never reaches this page.
 *   project  — a project-scoped announcement is only visible to testers with
 *              an ACCEPTED/ACTIVE assignment on that project.
 *
 * Both are enforced server-side; this page adds no filtering of its own, so
 * there is no second definition of visibility to drift out of step. Drafts
 * and expired items are already excluded by the endpoint.
 */
export default async function TesterAnnouncementsPage() {
  await requireRole(['TESTER'])

  let rows: AnnouncementRow[] = []
  let failed = false
  try {
    const result = await serverFetchPage<AnnouncementRow>('communication/announcements', {
      query: { limit: 50 },
    })
    rows = result.data
  } catch {
    failed = true
  }

  return (
    <main
      id="main"
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: 'var(--space-9) var(--space-7)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <Link
          href="/app/tester"
          style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}
        >
          ← Back to your account
        </Link>
        <h1 className="c4t-display-md" style={{ margin: 0 }}>
          Announcements
        </h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          Platform notices, plus anything posted to a project you are on.
        </p>
      </header>

      {failed ? (
        <EmptyState
          icon="alert-triangle"
          title="Could not load announcements"
          description="The service is unreachable. Refresh in a moment."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="message-square"
          title="Nothing to read yet"
          description="Notices from the platform and from projects you are on will appear here."
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
          {rows.map((row) => (
            <li
              key={row.id}
              style={{
                padding: 'var(--space-5)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-card)',
                background: 'var(--surface-raised)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 'var(--space-3)',
                  flexWrap: 'wrap',
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: 'var(--type-body-md-size)',
                    fontWeight: 'var(--fw-semibold)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {row.title}
                </h2>
                {row.project ? (
                  <Badge tone="info" uppercase={false}>
                    {row.project.reference}
                  </Badge>
                ) : (
                  <Badge tone="neutral" uppercase={false}>
                    {titleCase(row.audience)}
                  </Badge>
                )}
              </div>

              <p
                style={{
                  margin: 0,
                  color: 'var(--text-secondary)',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {row.body}
              </p>

              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
                {formatDateTime(row.publishedAt)}
                {row.expiresAt ? ` · until ${formatDateTime(row.expiresAt)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
