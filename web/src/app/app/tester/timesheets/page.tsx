import { DetailShell } from '@/components/admin/DetailShell'
import { Notice } from '@/components/admin/Notice'
import { Panel } from '@/components/admin/Panel'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { serverFetchOrNull } from '@/lib/api/server'
import { loadList } from '@/lib/admin/list'
import { requireRole } from '@/lib/auth/session'
import { formatDate } from '@/lib/admin/format'
import { formatMinutes, workflowNotices, type TimesheetRow } from '@/lib/testing/workflow'
import { logTime } from './actions'

interface Assignment {
  status: string
  build: { id: string; name: string }
  project: { id: string; title: string } | null
}

const NOTICES = {
  logged: {
    tone: 'success',
    message: 'Time saved. Logging the same build and day again replaces it until it is reviewed.',
  },
  invalid: { tone: 'error', message: 'Choose a build, a day and how long you worked.' },
} as const

/**
 * `/app/tester/timesheets` — time logged per build per day, and what the
 * team made of it. Recording only: approved time is not a payment.
 */
export default async function TesterTimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; detail?: string }>
}) {
  await requireRole(['TESTER'])
  const { notice, detail } = await searchParams

  const [assignments, entries] = await Promise.all([
    serverFetchOrNull<readonly Assignment[]>('projects/my-assignments'),
    loadList<TimesheetRow>('timesheets', { page: 1, limit: 100 }),
  ])
  const working = (assignments ?? []).filter(
    (a) => a.project !== null && ['ACCEPTED', 'ACTIVE'].includes(a.status),
  )
  const today = new Date().toISOString().slice(0, 10)

  const columns: readonly TableColumn<TimesheetRow>[] = [
    { key: 'day', header: 'Day', render: (row) => formatDate(row.workDate) },
    {
      key: 'project',
      header: 'Project',
      render: (row) => row.project.title,
      renderSecondary: (row) => row.build.name,
    },
    {
      key: 'time',
      header: 'Logged',
      align: 'right',
      render: (row) => formatMinutes(row.minutes),
      renderSecondary: (row) =>
        row.approvedMinutes !== null ? `${formatMinutes(row.approvedMinutes)} approved` : undefined,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'note',
      header: 'Note',
      render: (row) => row.reviewNote ?? row.description ?? '—',
    },
  ]

  return (
    <DetailShell
      root={{ label: 'Tester', href: '/app/tester' }}
      crumbs={[{ label: 'Timesheets' }]}
      eyebrow="Work"
      title="Timesheets"
      subtitle="Log the time you spend testing, one entry per build per day. The project team reviews each day."
    >
      <Notice code={notice} notices={workflowNotices(NOTICES, detail)} />

      <Panel title="Log time">
        {working.length === 0 ? (
          <EmptyState
            icon="clock"
            title="No build to log time against"
            description="You can log time once you are working on a build."
            action={
              <Button href="/app/tester/apply" variant="secondary">
                Find work
              </Button>
            }
          />
        ) : (
          <form
            action={logTime}
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
            }}
          >
            <Field label="Build" htmlFor="ts-build" required>
              <Select
                id="ts-build"
                name="buildId"
                required
                options={working.map((a) => ({
                  value: a.build.id,
                  label: `${a.project?.title ?? ''} · ${a.build.name}`,
                }))}
              />
            </Field>
            <Field label="Day" htmlFor="ts-day" required>
              <Input
                id="ts-day"
                name="workDate"
                type="date"
                required
                max={today}
                defaultValue={today}
              />
            </Field>
            <Field label="Hours" htmlFor="ts-hours">
              <Input
                id="ts-hours"
                name="hours"
                type="number"
                min={0}
                max={24}
                step={1}
                defaultValue="0"
              />
            </Field>
            <Field label="Minutes" htmlFor="ts-minutes">
              <Input
                id="ts-minutes"
                name="minutes"
                type="number"
                min={0}
                max={59}
                step={5}
                defaultValue="0"
              />
            </Field>
            <Field label="What you did" htmlFor="ts-description" hint="Optional.">
              <Input id="ts-description" name="description" maxLength={2000} />
            </Field>
            <SubmitButton variant="primary" pendingLabel="Saving…">
              Save time
            </SubmitButton>
          </form>
        )}
      </Panel>

      <Panel title="Your time" flush={'items' in entries && entries.items.length > 0}>
        {'error' in entries ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            Your timesheets could not be loaded. Refresh in a moment.
          </p>
        ) : entries.items.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>Nothing logged yet.</p>
        ) : (
          <Table
            ariaLabel="Your time"
            columns={columns}
            rows={entries.items}
            rowKey={(row) => row.id}
          />
        )}
      </Panel>
    </DetailShell>
  )
}
