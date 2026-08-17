import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Badge } from '@/components/ds/core/Badge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { personName, titleCase } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'
import { CommunicationTabs } from '../tabs'

const PAGE_SIZE = 25
const BASE = '/app/admin/communication/threads'
const TYPES = ['PROJECT', 'SUPPORT', 'DIRECT'] as const

interface ThreadParticipant {
  lastReadAt: string | null
  user: { id: string; firstName: string | null; lastName: string | null; role: string }
}

interface ThreadRow {
  id: string
  type: string
  subject: string | null
  isClosed: boolean
  lastMessageAt: string | null
  createdAt: string
  project: { id: string; reference: string; title: string } | null
  createdBy: { id: string; firstName: string | null; lastName: string | null; role: string } | null
  participants: readonly ThreadParticipant[]
  _count: { messages: number }
}

/**
 * Day and time, not just the day.
 *
 * `formatDate` in `@/lib/admin/format` drops the clock, which is right for a
 * start date and wrong for "last activity" — two threads that both say
 * "14 Aug 2026" tell you nothing about which one is moving. Local to this page
 * rather than added to the shared module, which is not mine to extend.
 */
function formatWhen(iso: string | null | undefined): string {
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

/** A thread's subject is optional in the schema, so every row needs a fallback. */
function threadTitle(row: Pick<ThreadRow, 'subject' | 'type'>): string {
  const subject = row.subject?.trim()
  if (subject) return subject
  return `${titleCase(row.type)} conversation`
}

/**
 * `/app/admin/communication/threads` — every message thread on the platform.
 *
 * The API scopes thread reads by participation for customers and testers, and
 * returns everything to the admin side (`threadScope` in the API's
 * `lib/access/scopes.ts`). That difference is the whole point of this page, so
 * the description says it out loud: an admin reading this list is seeing
 * conversations they were never part of.
 *
 * The endpoint's only control over closed threads is a boolean — it can hide
 * them or include them, and cannot return closed ones alone. So the filter is
 * two-state ("Closed threads: hidden / shown") rather than a three-way status
 * select, because offering "Closed only" would be a control the API cannot
 * honour.
 */
export default async function CommunicationThreadsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; closed?: string; page?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const type = TYPES.includes(params.type as (typeof TYPES)[number]) ? params.type : undefined
  const closed = params.closed === 'SHOWN' ? 'SHOWN' : undefined
  const page = parsePage(params.page)

  const result = await loadList<ThreadRow>('communication/threads', {
    page,
    limit: PAGE_SIZE,
    // `includeClosed` is parsed as the literal string 'true' by the API's query
    // schema, so it is sent only when closed threads are wanted. Omitting it
    // and sending 'false' mean the same thing there.
    query: { type, includeClosed: closed === 'SHOWN' ? 'true' : undefined },
  })

  const columns: readonly TableColumn<ThreadRow>[] = [
    {
      key: 'subject',
      header: 'Conversation',
      render: (row) => threadTitle(row),
      renderSecondary: (row) =>
        [
          `${row._count.messages} ${row._count.messages === 1 ? 'message' : 'messages'}`,
          row.createdBy ? `started by ${personName(row.createdBy)}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
    },
    {
      key: 'participants',
      header: 'Participants',
      render: (row) => {
        const names = row.participants.map((p) => personName(p.user))
        if (names.length === 0) return '—'
        const shown = names.slice(0, 2).join(', ')
        const rest = names.length - 2
        return rest > 0 ? `${shown} and ${rest} more` : shown
      },
      renderSecondary: (row) =>
        [...new Set(row.participants.map((p) => p.user.role))].map(titleCase).join(' · '),
    },
    {
      key: 'project',
      header: 'Project',
      render: (row) => row.project?.reference ?? '—',
      // Reference first, title underneath: the reference is what an admin
      // matches against a ticket, the title is what confirms they got the
      // right one.
      renderSecondary: (row) => row.project?.title ?? '',
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => (
        <Badge tone="info" uppercase={false}>
          {titleCase(row.type)}
        </Badge>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (row) =>
        row.isClosed ? (
          <Badge tone="neutral" uppercase={false}>
            Closed
          </Badge>
        ) : (
          <Badge tone="success" dot uppercase={false}>
            Open
          </Badge>
        ),
    },
    {
      key: 'activity',
      header: 'Last activity',
      align: 'right',
      render: (row) => formatWhen(row.lastMessageAt ?? row.createdAt),
    },
  ]

  return (
    <AdminListPage
      eyebrow="Operations"
      title="Threads"
      description="Every conversation between customers, testers and the admin side — including threads you are not a participant in, because the admin side oversees all of them. Closed threads stay hidden until you show them."
      crumbs={[
        { label: 'Communication', href: '/app/admin/communication' },
        { label: 'Threads' },
      ]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { type, closed })}
      // Only the type filter narrows the list. Showing closed threads widens
      // it, so an empty result there is a genuinely empty inbox, not a filter
      // that excluded everything.
      filtered={Boolean(type)}
      permission="communication.read"
      tabs={<CommunicationTabs active="threads" />}
      emptyIcon="message-square"
      emptyTitle="No conversations yet"
      emptyDescription="A thread appears here when a customer or a tester starts one on a project, or when someone opens a support conversation."
      toolbar={
        <ListFilters
          action={BASE}
          selects={[
            {
              name: 'type',
              label: 'Type',
              options: TYPES,
              value: type,
              allLabel: 'All types',
            },
            {
              name: 'closed',
              label: 'Closed threads',
              options: ['SHOWN'],
              value: closed,
              allLabel: 'Hidden',
            },
          ]}
        />
      }
    />
  )
}
