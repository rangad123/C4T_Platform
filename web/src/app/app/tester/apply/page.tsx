import { DetailShell } from '@/components/admin/DetailShell'
import { Notice } from '@/components/admin/Notice'
import { Panel } from '@/components/admin/Panel'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { serverFetchOrNull } from '@/lib/api/server'
import { loadList } from '@/lib/admin/list'
import { requireRole } from '@/lib/auth/session'
import { formatDate } from '@/lib/admin/format'
import { workflowNotices, type ApplicationRow, type OpenBuildRow } from '@/lib/testing/workflow'
import { applyToBuild, withdrawApplication } from './actions'

const NOTICES = {
  applied: {
    tone: 'success',
    message: 'Your application is in. You will be told when the project team answers.',
  },
  withdrawn: { tone: 'success', message: 'Your application was withdrawn.' },
} as const

/**
 * `/app/tester/apply` — builds open to applications, and the tester's own
 * applications. Accepting one puts the tester straight onto the build, so the
 * project then appears under Projects with nothing more to answer.
 */
export default async function TesterApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; detail?: string }>
}) {
  await requireRole(['TESTER'])
  const { notice, detail } = await searchParams

  const [openBuilds, mine] = await Promise.all([
    serverFetchOrNull<readonly OpenBuildRow[]>('open-builds'),
    loadList<ApplicationRow>('applications', { page: 1, limit: 50 }),
  ])

  const columns: readonly TableColumn<ApplicationRow>[] = [
    {
      key: 'project',
      header: 'Project',
      render: (row) => row.project.title,
      renderSecondary: (row) => row.build.name,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'note', header: 'Note from the team', render: (row) => row.decisionNote ?? '—' },
    {
      key: 'applied',
      header: 'Applied',
      align: 'right',
      render: (row) =>
        row.status === 'PENDING' ? (
          <form action={withdrawApplication}>
            <input type="hidden" name="applicationId" value={row.id} />
            <SubmitButton variant="ghost" size="sm" pendingLabel="Withdrawing…">
              Withdraw
            </SubmitButton>
          </form>
        ) : (
          formatDate(row.createdAt)
        ),
    },
  ]

  return (
    <DetailShell
      root={{ label: 'Tester', href: '/app/tester' }}
      crumbs={[{ label: 'Find work' }]}
      eyebrow="Work"
      title="Find work"
      subtitle="Builds whose teams are taking applications. Apply to the ones that match your devices."
    >
      <Notice code={notice} notices={workflowNotices(NOTICES, detail)} />

      <Panel title="Open to applications">
        {openBuilds === null ? (
          <Muted>Open builds could not be loaded. Refresh in a moment.</Muted>
        ) : openBuilds.length === 0 ? (
          <EmptyState
            icon="handshake"
            title="Nothing open right now"
            description="When a project team opens a build to applications, it appears here."
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
            {openBuilds.map((b) => {
              const onBuild =
                b.myAssignmentStatus !== null &&
                !['DECLINED', 'REMOVED'].includes(b.myAssignmentStatus)
              const pending = b.myApplication?.status === 'PENDING'
              return (
                <li
                  key={b.id}
                  style={{
                    padding: 'var(--space-5)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-card)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                  }}
                >
                  <strong style={{ color: 'var(--text-primary)' }}>
                    {b.project.title} · {b.name}
                  </strong>
                  {b.project.summary ? (
                    <p style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '75ch' }}>
                      {b.project.summary}
                    </p>
                  ) : null}
                  <DescriptionList
                    items={[
                      { label: 'Type of testing', value: b.testType ?? '—' },
                      {
                        label: 'Platforms',
                        value: b.project.platformTargets.join(', ') || '—',
                      },
                      { label: 'Devices', value: b.targetDevices.join(', ') || '—' },
                      { label: 'Browsers', value: b.targetBrowsers.join(', ') || '—' },
                      {
                        label: 'Dates',
                        value:
                          b.startDate || b.endDate
                            ? `${formatDate(b.startDate)} – ${formatDate(b.endDate)}`
                            : '—',
                      },
                    ]}
                  />
                  {onBuild ? (
                    <div>
                      <Button
                        href={`/app/tester/projects/${b.project.id}?buildId=${b.id}`}
                        variant="secondary"
                        size="sm"
                        iconRight="arrow-right"
                      >
                        Open the project
                      </Button>
                    </div>
                  ) : pending ? (
                    <Muted>You have applied. The team has not answered yet.</Muted>
                  ) : (
                    <form
                      action={applyToBuild}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-end',
                        gap: 'var(--space-3)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <input type="hidden" name="buildId" value={b.id} />
                      <Field
                        label="Note to the team"
                        htmlFor={`message-${b.id}`}
                        hint="Optional. Say what you would test it on."
                      >
                        <Input id={`message-${b.id}`} name="message" maxLength={2000} />
                      </Field>
                      <SubmitButton variant="primary" pendingLabel="Applying…">
                        {b.myApplication ? 'Apply again' : 'Apply'}
                      </SubmitButton>
                    </form>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Your applications" flush={'items' in mine && mine.items.length > 0}>
        {'error' in mine ? (
          <Muted>Your applications could not be loaded. Refresh in a moment.</Muted>
        ) : mine.items.length === 0 ? (
          <Muted>You have not applied to anything yet.</Muted>
        ) : (
          <Table
            ariaLabel="Your applications"
            columns={columns}
            rows={mine.items}
            rowKey={(row) => row.id}
          />
        )}
      </Panel>
    </DetailShell>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{children}</p>
}
