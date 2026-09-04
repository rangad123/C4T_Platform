import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { searchTerm } from '@/lib/admin/format'
import { requirePermission } from '@/lib/auth/session'
import type { TableColumn } from '@/components/ds/admin/Table'
import { CommunicationTabs } from './tabs'

const PAGE_SIZE = 25
const BASE = '/app/admin/communication'
const TABS = ['SENT', 'DRAFT'] as const

interface BroadcastRow {
  id: string
  subject: string | null
  body: string
  status: 'DRAFT' | 'SENT'
  sentAt: string | null
  createdAt: string
  updatedAt: string
  template: { id: string; name: string } | null
  _count: { recipients: number }
  /** Derived from `ThreadParticipant.lastReadAt`. Never stored, never guessed. */
  readCount: number
}

/**
 * `/app/admin/communication` — everything you have sent, and everything you
 * have not sent yet.
 *
 * ── WHY THE LANDING PAGE IS A LIST AND NOT THE COMPOSER
 *
 * It used to be the composer: a textarea above a paginated table of every
 * tester, with a checkbox column. That screen could only answer one question
 * ("who do I send this to right now") and had no answer at all for the one
 * asked far more often — "what did I send, to whom, and did they read it".
 * Nothing recorded a send, so nothing could.
 *
 * Now the archive is the landing page and composing is a route of its own,
 * because sending is a task with steps and reading back what you sent is a
 * list. `Broadcast` is what made this possible: it owns the private threads
 * it created, so a row here is one message rather than N unrelated
 * conversations that happen to share a timestamp.
 *
 * ── WHAT THE COLUMNS DO NOT SAY
 *
 * There is no "delivered" and no "pending". Nothing in this platform observes
 * either, and a column that always reads 100% is not information. Recipients
 * is how many threads were created; Read is how many of those people have
 * actually opened theirs, taken live from `ThreadParticipant.lastReadAt`. A
 * failure is reported per recipient on the message itself, where the reason
 * can be shown.
 */
export default async function CommunicationPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string
    search?: string
    page?: string
    deleted?: string
    error?: string
  }>
}) {
  await requirePermission('communication.read')

  const params = await searchParams
  const tab = TABS.includes(params.tab as (typeof TABS)[number])
    ? (params.tab as (typeof TABS)[number])
    : 'SENT'
  const search = searchTerm(params.search)
  const page = parsePage(params.page)

  const result = await loadList<BroadcastRow>('communication/broadcasts', {
    page,
    limit: PAGE_SIZE,
    query: { status: tab, search },
  })

  const columns: readonly TableColumn<BroadcastRow>[] = [
    {
      key: 'subject',
      header: 'Message',
      render: (row) => {
        // Length-checked, not `??`: "   " trims to '', which is not nullish.
        const trimmed = row.subject?.trim() ?? ''
        return trimmed.length > 0 ? trimmed : 'No subject'
      },
      // The first line of the body, so a subject-less message is still
      // recognisable without opening it.
      renderSecondary: (row) => firstLine(row.body),
    },
    {
      key: 'recipients',
      header: 'Recipients',
      align: 'right',
      render: (row) => row._count.recipients,
    },
    {
      key: 'read',
      header: 'Read',
      align: 'right',
      /*
        Only meaningful once something has been sent. A draft shows an em dash
        rather than "0 read", which would imply it went out and nobody opened
        it.
      */
      render: (row) => (row.status === 'SENT' ? row.readCount : '—'),
      renderSecondary: (row) =>
        row.status === 'SENT' && row._count.recipients > 0
          ? `of ${row._count.recipients}`
          : undefined,
    },
    {
      key: 'template',
      header: 'Template',
      render: (row) => row.template?.name ?? '—',
    },
    {
      key: 'when',
      header: tab === 'SENT' ? 'Sent' : 'Last edited',
      align: 'right',
      render: (row) => formatWhen(row.status === 'SENT' ? row.sentAt : row.updatedAt),
    },
  ]

  const notice = params.deleted
    ? { tone: 'success' as const, text: 'Draft deleted.' }
    : params.error
      ? { tone: 'error' as const, text: params.error }
      : null

  return (
    <AdminListPage
      eyebrow="Operations"
      title="Communication"
      description="Messages you have sent to testers, and the drafts you have not. Each recipient gets a private conversation, so a reply comes back as an ordinary thread."
      crumbs={[{ label: 'Communication' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/messages/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { tab, search })}
      filtered={Boolean(search)}
      permission="communication.read"
      emptyIcon="message-square"
      emptyTitle={tab === 'SENT' ? 'Nothing sent yet' : 'No drafts'}
      emptyDescription={
        tab === 'SENT'
          ? 'Messages you send to testers are kept here, with how many people opened each one.'
          : 'A message you save without sending waits here until you come back to it.'
      }
      tabs={<CommunicationTabs active="messages" />}
      toolbar={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {notice ? (
            <p
              role={notice.tone === 'error' ? 'alert' : 'status'}
              style={{
                margin: 0,
                padding: 'var(--space-4) var(--space-5)',
                borderRadius: 'var(--radius-card)',
                background:
                  notice.tone === 'error' ? 'var(--status-error-bg)' : 'var(--status-success-bg)',
                color:
                  notice.tone === 'error' ? 'var(--status-error-fg)' : 'var(--status-success-fg)',
              }}
            >
              {notice.text}
            </p>
          ) : null}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            {/*
              Sent and Drafts are one list filtered two ways, not two pages —
              the same columns answer both, and the API takes a status filter.
            */}
            <nav aria-label="Message status" style={{ display: 'flex', gap: 'var(--space-2)' }}>
              {TABS.map((value) => (
                <Button
                  key={value}
                  href={value === 'SENT' ? BASE : `${BASE}?tab=${value}`}
                  variant={tab === value ? 'secondary' : 'ghost'}
                  size="sm"
                >
                  {value === 'SENT' ? 'Sent' : 'Drafts'}
                </Button>
              ))}
            </nav>
            <Button href={`${BASE}/compose`} variant="primary" iconLeft="message-square">
              New message
            </Button>
          </div>

          <ListFilters
            action={BASE}
            hidden={{ tab }}
            search={{ value: search, placeholder: 'Subject or message text' }}
          />
        </div>
      }
      summary={
        'items' in result && result.items.length > 0 && tab === 'SENT' ? (
          <ReadSummary rows={result.items} />
        ) : undefined
      }
    />
  )
}

/**
 * How much of what is on this page has been read.
 *
 * Real numbers or nothing: both sides come from the same rows the table is
 * showing, and neither is a projection.
 */
function ReadSummary({ rows }: { rows: readonly BroadcastRow[] }) {
  const recipients = rows.reduce((sum, r) => sum + r._count.recipients, 0)
  const read = rows.reduce((sum, r) => sum + r.readCount, 0)
  if (recipients === 0) return null

  return (
    <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
      {rows.length === 1 ? 'This message' : `Across these ${rows.length} messages`}: {recipients}{' '}
      recipient{recipients === 1 ? '' : 's'},{' '}
      <Badge tone={read === recipients ? 'success' : 'neutral'} uppercase={false}>
        {read} read
      </Badge>
    </p>
  )
}

/** The message's opening line, for rows whose subject is blank. */
function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/**
 * Day and time, not just the day — two messages that both say "14 Aug 2026"
 * tell you nothing about which went out first.
 */
function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
