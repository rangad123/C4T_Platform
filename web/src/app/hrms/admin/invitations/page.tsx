import type { Metadata } from 'next'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { searchTerm, hasFilter } from '@/lib/admin/format'
import { HrAdminListPage } from '@/components/hrms/HrAdminListPage'
import { HrSelectAll } from '@/components/hrms/HrSelectAll'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { ListFilters } from '@/components/admin/ListFilters'
import { Badge } from '@/components/ds/core/Badge'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import type { TableColumn } from '@/components/ds/admin/Table'
import { sendInvitations } from './actions'

export const metadata: Metadata = { title: 'Invitations' }

const BASE = '/admin/invitations'
const FORM_ID = 'invitations-form'

/**
 * Not signed in is the first tab because it is the question this page exists
 * to answer: who has been added but never got in. All active staff is there
 * for re-sending to someone whose link lapsed after they had signed in once.
 */
const TABS = [
  { value: 'not-signed-in', label: 'Not signed in', icon: 'clock' },
  { value: 'all', label: 'All active staff', icon: 'users' },
] as const

// The most one request will send. The API enforces the same number.
const PAGE_SIZE = 50

interface InvitationRow {
  id: string
  employeeCode: string
  firstName: string
  lastName: string
  email: string
  signedIn: boolean
  lastLinkSentAt: string | null
}

function sentOn(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function wholeNumber(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

export default async function HrAdminInvitationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string
    section?: string
    search?: string
    notice?: string
    reason?: string
    sent?: string
    failed?: string
  }>
}) {
  const params = await searchParams
  const page = parsePage(params.page)
  const section = resolveSection(TABS, params.section)
  const search = searchTerm(params.search)

  const result = await loadList<InvitationRow>('hrms/employees/invitations', {
    page,
    limit: PAGE_SIZE,
    query: { filter: section, search },
  })

  // Comes back with every page whatever the search, so the first tab's number
  // stays true while someone is looking at the second.
  const notSignedIn =
    'meta' in result ? (result.meta as { notSignedIn?: number }).notSignedIn : undefined
  const tabs = TABS.map((t) =>
    t.value === 'not-signed-in' && notSignedIn ? { ...t, count: notSignedIn } : t,
  )

  const hrefFor = pageHrefBuilder(BASE, {
    section: section === 'not-signed-in' ? undefined : section,
    search,
  })

  const sent = wholeNumber(params.sent)
  const failed = wholeNumber(params.failed)
  const notices: Record<string, NoticeCopy> = {
    invited:
      failed > 0
        ? {
            tone: 'warning',
            message: `${count(sent, 'invitation')} sent, ${failed} could not be sent.`,
          }
        : {
            tone: 'success',
            message: `${count(sent, 'invitation')} sent. Each link lets the person choose their own password and expires in 7 days.`,
          },
    invite_none: { tone: 'warning', message: 'Tick at least one person to invite.' },
    refused: { tone: 'warning', message: params.reason ?? 'That could not be done.' },
  }

  const columns: readonly TableColumn<InvitationRow>[] = [
    {
      key: 'name',
      header: 'Name',
      // Holds its own control, so nothing here may be wrapped in a row link.
      interactive: true,
      render: (row) => (
        <Checkbox
          id={`invite-${row.id}`}
          name="employeeIds"
          value={row.id}
          form={FORM_ID}
          label={`${row.firstName} ${row.lastName}`}
        />
      ),
    },
    { key: 'employeeCode', header: 'Employee code', render: (row) => row.employeeCode },
    { key: 'email', header: 'Email', render: (row) => row.email },
    {
      key: 'signedIn',
      header: 'Sign-in',
      render: (row) =>
        row.signedIn ? (
          <Badge tone="success">Signed in</Badge>
        ) : (
          <Badge tone="warning">Not signed in yet</Badge>
        ),
    },
    {
      key: 'lastLinkSentAt',
      header: 'Link last sent',
      render: (row) => (row.lastLinkSentAt ? sentOn(row.lastLinkSentAt) : 'Never'),
    },
  ]

  return (
    <HrAdminListPage
      eyebrow="Employees"
      title="Invitations"
      description="Email active staff a link to choose their own password. A new link replaces the one before it, and each lasts 7 days."
      crumbs={[{ label: 'Employees', href: '/admin' }, { label: 'Invitations' }]}
      root={{ label: 'Admin', href: '/admin' }}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      hrefFor={hrefFor}
      filtered={hasFilter([search])}
      emptyIcon="mail"
      emptyTitle={section === 'all' ? 'No active employees yet' : 'Everyone has signed in'}
      emptyDescription={
        section === 'all'
          ? 'Add an employee and they will appear here.'
          : 'New starters appear here until they sign in for the first time.'
      }
      tabs={<SectionTabs basePath={BASE} tabs={tabs} active={section} preserve={{ search }} />}
      toolbar={
        <>
          <Notice code={params.notice} notices={notices} />
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <ListFilters
              action={BASE}
              search={{ value: search, placeholder: 'Search name, email or employee code' }}
              hidden={{ section: section === 'not-signed-in' ? undefined : section }}
            />
            <form
              id={FORM_ID}
              action={sendInvitations}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-5)',
                flexWrap: 'wrap',
              }}
            >
              <input type="hidden" name="back" value={hrefFor(page)} />
              <HrSelectAll
                formId={FORM_ID}
                name="employeeIds"
                label="Select everyone on this page"
              />
              <SubmitButton variant="primary" iconLeft="mail" pendingLabel="Sending…">
                Send invitations
              </SubmitButton>
            </form>
          </div>
        </>
      }
    />
  )
}
