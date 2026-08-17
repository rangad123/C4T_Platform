import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Avatar } from '@/components/admin/Avatar'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Panel } from '@/components/admin/Panel'
import { TemplatePicker } from '@/components/admin/TemplatePicker'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Textarea } from '@/components/ds/forms/Textarea'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { personName, searchTerm, hasFilter, formatRating } from '@/lib/admin/format'
import { serverFetchOrNull } from '@/lib/api/server'
import type { TableColumn } from '@/components/ds/admin/Table'
import { sendBroadcastAction } from './actions'

const PAGE_SIZE = 25
const BASE = '/app/admin/communication/broadcast'
const STATUSES = ['APPLIED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED'] as const
const SORT_OPTIONS = [
  { value: 'ratingAverage', label: 'Rating' },
  { value: 'createdAt', label: 'Applied' },
  { value: 'bugsReportedCount', label: 'Bugs reported' },
] as const
const SORT_FIELDS = SORT_OPTIONS.map((o) => o.value)

interface TesterRow {
  id: string
  status: string
  headline: string | null
  /** Prisma Decimal — arrives as a STRING. Never call .toFixed() on it directly. */
  ratingAverage: string | number | null
  ratingCount: number
  bugsReportedCount: number
  user: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    avatarFileId: string | null
  }
}

/**
 * `/app/admin/communication/broadcast` — send one message to many testers.
 *
 * There is no group-broadcast entity on the API — this composes the same
 * `POST /threads` call the one-to-one messaging UI would use, once per
 * selected tester, so each recipient gets a private conversation with the
 * sender rather than a shared group thread. See `sendBroadcastAction` for
 * why that fan-out shape was chosen over one big thread.
 *
 * Selection is checkbox-per-row via the native `form="broadcast-form"`
 * attribute — the checkboxes live inside the table `AdminListPage` renders,
 * the compose form lives beside it, and the browser submits both together
 * without any client-side state. Selection only covers the current page:
 * there is no cross-page "select all 400 testers" here, matching the same
 * scoping the bulk bug-status action uses.
 */
export default async function BroadcastPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string
    status?: string
    sort?: string
    order?: string
    page?: string
    sent?: string
    of?: string
  }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const search = searchTerm(params.search)
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : 'VERIFIED'
  const sort = SORT_FIELDS.includes(params.sort as (typeof SORT_FIELDS)[number])
    ? params.sort
    : 'ratingAverage'
  const order = params.order === 'asc' ? 'asc' : 'desc'
  const page = parsePage(params.page)
  const sentNotice =
    params.sent !== undefined && params.of !== undefined
      ? { sent: Number(params.sent), of: Number(params.of) }
      : null
  const templates = await serverFetchOrNull<
    readonly { id: string; name: string; subject: string | null; body: string }[]
  >('communication/templates')

  const result = await loadList<TesterRow>('testers', {
    page,
    limit: PAGE_SIZE,
    query: { search, status, sort, order },
  })

  const columns: readonly TableColumn<TesterRow>[] = [
    {
      key: 'select',
      header: '',
      width: 36,
      render: (row) => (
        <input
          type="checkbox"
          name="testerIds"
          value={row.user.id}
          form="broadcast-form"
          aria-label={`Select ${personName(row.user)}`}
          style={{ margin: 0, cursor: 'pointer' }}
        />
      ),
    },
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
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'rating',
      header: 'Rating',
      align: 'right',
      render: (row) => formatRating(row.ratingAverage, { suffix: false }),
      renderSecondary: (row) => (row.ratingCount > 0 ? `${row.ratingCount} reviews` : undefined),
    },
    {
      key: 'bugs',
      header: 'Bugs reported',
      align: 'right',
      render: (row) => row.bugsReportedCount,
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {sentNotice ? (
        <div
          role="status"
          style={{
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--status-success-bg)',
            color: 'var(--status-success-fg)',
          }}
        >
          Sent to {sentNotice.sent} of {sentNotice.of} selected tester
          {sentNotice.of === 1 ? '' : 's'}
          {sentNotice.sent < sentNotice.of
            ? ' — the rest could not be reached, most likely because the account changed between loading this page and sending.'
            : '.'}
        </div>
      ) : null}

      {/*
        The compose panel is declared before the list so the recipient picker
        below it reads as "now choose who gets this" — but the <form> tag
        itself has to exist somewhere in the DOM for the table's checkboxes
        to target via `form="broadcast-form"`, and tag order does not affect
        that association.
      */}
      <Panel
        title="Compose"
        description="Sent as a private one-to-one conversation with each tester you select below — nobody sees who else received it."
        actions={
          templates && templates.length > 0 ? (
            <TemplatePicker templates={templates} subjectFieldId="subject" bodyFieldId="message" />
          ) : undefined
        }
      >
        <form
          id="broadcast-form"
          action={sendBroadcastAction}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <Field label="Subject" htmlFor="subject" hint="Optional.">
            <Input id="subject" name="subject" maxLength={200} placeholder="Update on this week's builds" />
          </Field>
          <Field label="Message" htmlFor="message" required>
            <Textarea
              id="message"
              name="message"
              rows={5}
              required
              maxLength={5000}
              placeholder="What you want every selected tester to know."
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" iconLeft="message-square">
              Send to selected testers
            </Button>
          </div>
        </form>
      </Panel>

      <AdminListPage
        eyebrow="Operations"
        title="Select recipients"
        description="Verified testers by default — widen the status filter to reach applicants or suspended accounts. Tick the testers you want this message to reach, then submit from the panel above."
        crumbs={[
          { label: 'Communication', href: '/app/admin/communication' },
          { label: 'Broadcast' },
        ]}
        result={result}
        columns={columns}
        rowKey={(row) => row.id}
        hrefFor={pageHrefBuilder(BASE, { search, status, sort, order })}
        filtered={hasFilter([search, status !== 'VERIFIED' ? status : undefined])}
        permission="tester.read"
        emptyIcon="users"
        emptyTitle="No testers match"
        emptyDescription="Widen the status filter or clear the search to find recipients."
        toolbar={
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
            sort={{ name: 'sort', orderName: 'order', options: SORT_OPTIONS, value: sort, order }}
          />
        }
      />
    </div>
  )
}
