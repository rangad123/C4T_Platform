import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { serverFetchPage } from '@/lib/api/server'
import { Button } from '@/components/ds/core/Button'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { StatusBadge, SeverityBadge } from '@/components/admin/StatusBadge'
import { formatDate, titleCase } from '@/lib/admin/format'

interface BugRow {
  id: string
  reference: string
  title: string
  severity: string
  status: string
  type: string | null
  createdAt: string
  project: { id: string; reference: string; title: string } | null
}

/**
 * `/app/tester/bugs` — the defects this tester has filed.
 *
 * `GET /v1/bugs` is auto-scoped by `bugScope`: a tester sees the bugs they
 * reported, plus — only where the project has `testersCanSeeOtherBugs`
 * enabled — bugs filed by others on that project. So this list is not
 * strictly "my reports"; it is "bugs I am allowed to see", which is why the
 * Reported-by column exists on the admin view but the heading here stays
 * neutral rather than claiming authorship of every row.
 */
export default async function TesterBugsPage({
  searchParams,
}: {
  searchParams: Promise<{ reported?: string }>
}) {
  await requireRole(['TESTER'])
  const params = await searchParams
  const justReported = params.reported === '1'

  let rows: BugRow[] = []
  let failed = false
  try {
    const result = await serverFetchPage<BugRow>('bugs', {
      query: { limit: 50, sort: 'createdAt', order: 'desc' },
    })
    rows = result.data
  } catch {
    failed = true
  }

  const columns: readonly TableColumn<BugRow>[] = [
    {
      key: 'title',
      header: 'Bug',
      render: (row) => row.title,
      renderSecondary: (row) =>
        [row.reference, row.project?.reference].filter(Boolean).join(' · '),
    },
    {
      key: 'severity',
      header: 'Severity',
      render: (row) => <SeverityBadge severity={row.severity} />,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'type',
      header: 'Type',
      render: (row) => (row.type ? titleCase(row.type) : '—'),
    },
    {
      key: 'created',
      header: 'Reported',
      align: 'right',
      render: (row) => formatDate(row.createdAt),
    },
  ]

  return (
    <main
      id="main"
      style={{
        maxWidth: 960,
        margin: '0 auto',
        padding: 'var(--space-9) var(--space-7)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      {justReported ? (
        <div
          role="status"
          style={{
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--status-success-bg)',
            color: 'var(--status-success-fg)',
          }}
        >
          Bug reported. It appears below with status New until someone triages it.
        </div>
      ) : null}

      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <Link
            href="/app/tester"
            style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}
          >
            ← Back to your account
          </Link>
          <h1 className="c4t-display-md" style={{ margin: 0 }}>
            Bugs
          </h1>
        </div>
        <Button href="/app/tester/bugs/new" variant="primary" iconLeft="plus">
          Report a bug
        </Button>
      </header>

      {failed ? (
        <EmptyState
          icon="alert-triangle"
          title="Could not load your bugs"
          description="The service is unreachable. Refresh in a moment."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="clipboard-check"
          title="No bugs yet"
          description="Report the first defect you find on a project you are assigned to."
        />
      ) : (
        <Table ariaLabel="Bugs" columns={columns} rows={rows} rowKey={(row) => row.id} />
      )}
    </main>
  )
}
