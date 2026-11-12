import type { ReactNode } from 'react'
import Link from 'next/link'
import { DetailShell } from '@/components/admin/DetailShell'
import { Notice } from '@/components/admin/Notice'
import { Panel } from '@/components/admin/Panel'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Pagination } from '@/components/ds/admin/Pagination'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Input } from '@/components/ds/forms/Input'
import { loadList, parsePage, type ListResult } from '@/lib/admin/list'
import { requirePermission } from '@/lib/auth/session'
import { formatDate, personName } from '@/lib/admin/format'
import {
  formatMinutes,
  workflowNotices,
  type ApplicationRow,
  type ExecutionRow,
  type TimesheetRow,
} from '@/lib/testing/workflow'
import { decideApplication, reviewExecution, reviewTimesheet } from './actions'

const BASE = '/app/admin/testing'
const PAGE_SIZE = 25

const SECTIONS = [
  { value: 'applications', label: 'Applications', icon: 'handshake' },
  { value: 'executions', label: 'Executions', icon: 'test-tube-diagonal' },
  { value: 'timesheets', label: 'Timesheets', icon: 'clock' },
] as const

const NOTICES = { decided: { tone: 'success', message: 'Decision saved.' } } as const

/**
 * `/app/admin/testing` — what testers are waiting on: applications to join a
 * build, executions to approve before they count, and time to approve.
 *
 * Only PENDING rows are listed; each is decided once. The API scopes the
 * queue — a sub-admin without the permission sees only the projects they
 * manage. Opening a build to applications is done on the project's Test
 * reports tab.
 */
export default async function AdminTestingPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; page?: string; notice?: string; detail?: string }>
}) {
  await requirePermission('project.read')
  const params = await searchParams
  const section = resolveSection(SECTIONS, params.section)
  const page = parsePage(params.page)
  const opts = { page, limit: PAGE_SIZE, query: { order: 'asc' } }

  const [applications, executions, timesheets] = await Promise.all([
    section === 'applications'
      ? loadList<ApplicationRow>('applications', {
          ...opts,
          query: { ...opts.query, status: 'PENDING' },
        })
      : null,
    section === 'executions'
      ? loadList<ExecutionRow>('test-reports', {
          ...opts,
          query: { ...opts.query, reviewStatus: 'PENDING' },
        })
      : null,
    section === 'timesheets'
      ? loadList<TimesheetRow>('timesheets', {
          ...opts,
          query: { ...opts.query, status: 'PENDING' },
        })
      : null,
  ])
  const result = applications ?? executions ?? timesheets

  return (
    <DetailShell
      crumbs={[{ label: 'Testing reviews' }]}
      eyebrow="Delivery"
      title="Testing reviews"
      subtitle="Applications, executions and time waiting for a decision, oldest first."
      tabs={<SectionTabs basePath={BASE} tabs={SECTIONS} active={section} />}
    >
      <Notice code={params.notice} notices={workflowNotices(NOTICES, params.detail)} />

      {applications ? (
        <Queue result={applications} empty="No applications waiting." title="Applications">
          {(row) => (
            <Item
              key={row.id}
              heading={`${personName(row.tester)} · ${row.project.title} · ${row.build.name}`}
              meta={`${row.project.reference} · applied ${formatDate(row.createdAt)}`}
              body={row.message}
              projectId={row.project.id}
            >
              <DecisionForm
                action={decideApplication}
                id={row.id}
                approve="ACCEPTED"
                reject="DECLINED"
                approveLabel="Accept"
                rejectLabel="Decline"
              />
            </Item>
          )}
        </Queue>
      ) : null}

      {executions ? (
        <Queue result={executions} empty="No executions waiting." title="Executions">
          {(row) => (
            <Item
              key={row.id}
              heading={`${row.testCase.title} · ${personName(row.tester)}`}
              meta={`${row.build.project.reference} · ${row.build.name} · ${formatDate(row.createdAt)}`}
              body={row.notes}
              badge={<StatusBadge status={row.result} />}
              projectId={row.build.project.id}
              extra={
                row.linkedBug ? (
                  <Link href={`/app/admin/bugs/${row.linkedBug.id}`} style={linkStyle}>
                    {row.linkedBug.reference} — {row.linkedBug.title}
                  </Link>
                ) : null
              }
            >
              <DecisionForm
                action={reviewExecution}
                id={row.id}
                approve="APPROVED"
                reject="REJECTED"
                approveLabel="Approve"
                rejectLabel="Reject"
              />
            </Item>
          )}
        </Queue>
      ) : null}

      {timesheets ? (
        <Queue result={timesheets} empty="No time waiting." title="Timesheets">
          {(row) => (
            <Item
              key={row.id}
              heading={`${personName(row.tester)} · ${formatMinutes(row.minutes)} on ${formatDate(row.workDate)}`}
              meta={`${row.project.reference} · ${row.project.title} · ${row.build.name}`}
              body={row.description}
              projectId={row.project.id}
            >
              <DecisionForm
                action={reviewTimesheet}
                id={row.id}
                approve="APPROVED"
                reject="REJECTED"
                approveLabel="Approve"
                rejectLabel="Reject"
                minutes={row.minutes}
              />
            </Item>
          )}
        </Queue>
      ) : null}

      {result && 'meta' in result && result.meta.totalPages > 1 ? (
        <Pagination
          page={result.meta.page}
          totalPages={result.meta.totalPages}
          total={result.meta.total}
          limit={result.meta.limit}
          hrefFor={(p: number) => `${BASE}?section=${section}&page=${p}`}
        />
      ) : null}
    </DetailShell>
  )
}

const linkStyle = {
  color: 'var(--text-brand)',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
} as const

function Queue<Row>({
  result,
  title,
  empty,
  children,
}: {
  result: ListResult<Row>
  title: string
  empty: string
  children: (row: Row) => ReactNode
}) {
  return (
    <Panel title={title}>
      {'error' in result ? (
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          {result.error === 'forbidden'
            ? 'You do not have a review queue.'
            : 'The queue could not be loaded. Refresh in a moment.'}
        </p>
      ) : result.items.length === 0 ? (
        <EmptyState icon="check-check" title={empty} description="New ones appear here." />
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
          {result.items.map(children)}
        </ul>
      )}
    </Panel>
  )
}

function Item({
  heading,
  meta,
  body,
  badge,
  extra,
  projectId,
  children,
}: {
  heading: string
  meta: string
  body: string | null
  badge?: ReactNode
  extra?: ReactNode
  projectId: string
  children: ReactNode
}) {
  return (
    <li
      style={{
        padding: 'var(--space-5)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}
      >
        <strong style={{ color: 'var(--text-primary)' }}>{heading}</strong>
        {badge}
      </div>
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
        {meta} ·{' '}
        <Link href={`/app/admin/projects/${projectId}?section=testing`} style={linkStyle}>
          Open project
        </Link>
      </span>
      {body ? <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{body}</p> : null}
      {extra}
      {children}
    </li>
  )
}

function DecisionForm({
  action,
  id,
  approve,
  reject,
  approveLabel,
  rejectLabel,
  minutes,
}: {
  action: (formData: FormData) => Promise<void>
  id: string
  approve: string
  reject: string
  approveLabel: string
  rejectLabel: string
  /** Timesheets only: the minutes logged, which approval may cut. */
  minutes?: number
}) {
  return (
    <form
      action={action}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        flexWrap: 'wrap',
        marginTop: 'var(--space-2)',
      }}
    >
      <input type="hidden" name="id" value={id} />
      <Input
        name="note"
        aria-label="Note"
        placeholder={`Note (required to ${rejectLabel.toLowerCase()})`}
        maxLength={2000}
        style={{ flex: '1 1 16rem' }}
      />
      {minutes !== undefined ? (
        <Input
          name="approvedMinutes"
          type="number"
          aria-label="Minutes to approve"
          min={0}
          max={minutes}
          defaultValue={String(minutes)}
          style={{ width: '7rem' }}
        />
      ) : null}
      <SubmitButton
        name="decision"
        value={approve}
        variant="primary"
        size="sm"
        pendingLabel="Saving…"
      >
        {approveLabel}
      </SubmitButton>
      <SubmitButton
        name="decision"
        value={reject}
        variant="secondary"
        size="sm"
        pendingLabel="Saving…"
      >
        {rejectLabel}
      </SubmitButton>
    </form>
  )
}
