import Link from 'next/link'
import { Topbar } from '@/components/admin/Topbar'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Pagination } from '@/components/ds/admin/Pagination'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { LeadStatusBadge, type LeadStatusValue } from '@/components/admin/LeadStatusBadge'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Button } from '@/components/ds/core/Button'
import { requirePermission } from '@/lib/auth/session'
import { serverFetchPage } from '@/lib/api/server'
import { ApiError, type PageMeta } from '@/lib/api/types'

/** Rows per page. Mirrored into the API query and the Pagination summary. */
const PAGE_SIZE = 25

/**
 * The leads inbox. `/app/admin/leads`.
 *
 * The page is a Server Component. Filter and search are GET-form inputs that
 * mutate the URL; status changes happen on the detail page (a status pill on
 * a list row would be a select inside a table cell, which is fiddly to
 * keyboard and not what an inbox looks like — triage happens on open).
 *
 * `requirePermission(LEAD_READ)` is checked at the API too, so a sub-admin
 * without the grant gets a 403 here. The page renders that as a plain error
 * message rather than throwing into the error boundary, because "you don't
 * have access" is a state, not a crash.
 */

const LEAD_STATUSES: readonly LeadStatusValue[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'WON',
  'LOST',
  'SPAM',
]

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All statuses' },
  ...LEAD_STATUSES.map((s) => ({ value: s, label: titleCase(s) })),
]

interface LeadRow {
  id: string
  firstName: string
  lastName: string
  email: string
  company: string
  teamSize: string | null
  status: string
  createdAt: string
  convertedOrg: { id: string; name: string } | null
}

function titleCase(value: string): string {
  if (!value) return value
  return value
    .toLowerCase()
    .replace(
      /(^|[\s_-])(\w)/g,
      (_match: string, sep: string, ch: string) => (sep === '_' ? ' ' : sep) + ch.toUpperCase(),
    )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string; page?: string }>
}) {
  await requirePermission('lead.read')

  const params = await searchParams
  const status = LEAD_STATUSES.includes(params.status as LeadStatusValue)
    ? params.status
    : undefined
  const trimmedSearch = params.search?.trim()
  const search = trimmedSearch && trimmedSearch.length > 0 ? trimmedSearch : undefined
  const parsedPage = Number.parseInt(params.page ?? '1', 10)
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1

  let result: { items: LeadRow[]; meta: PageMeta } | { error: 'forbidden' | 'unknown' }
  try {
    // `serverFetchPage`, not `serverFetch` — the latter unwraps to `data` and
    // drops `meta`, which is where the total and page count live.
    const response = await serverFetchPage<LeadRow>('leads', {
      query: {
        ...(status ? { status } : {}),
        ...(search ? { search } : {}),
        page,
        limit: PAGE_SIZE,
      },
    })
    result = {
      items: response.data,
      meta: response.meta ?? {
        page,
        limit: PAGE_SIZE,
        total: response.data.length,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      result = { error: 'forbidden' }
    } else {
      result = { error: 'unknown' }
    }
  }

  const hrefFor = (targetPage: number) => {
    const sp = new URLSearchParams()
    if (status) sp.set('status', status)
    if (search) sp.set('search', search)
    if (targetPage > 1) sp.set('page', String(targetPage))
    const qs = sp.toString()
    return qs ? `/app/admin/leads?${qs}` : '/app/admin/leads'
  }

  const columns: readonly TableColumn<LeadRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => {
        const name = `${row.firstName} ${row.lastName}`.trim()
        return name.length > 0 ? name : row.email
      },
      renderSecondary: (row) => row.email,
    },
    {
      key: 'company',
      header: 'Company',
      render: (row) => row.company,
      renderSecondary: (row) => row.teamSize ?? undefined,
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <LeadStatusBadge status={row.status} />,
    },
    {
      key: 'created',
      header: 'Received',
      align: 'right',
      render: (row) => formatDate(row.createdAt),
    },
  ]

  return (
    <>
      <Topbar crumbs={[{ label: 'Leads' }]} />

      <main
        id="main"
        style={{
          padding: 'var(--space-9)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-7)',
        }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: 0 }}>
            Pipeline
          </p>
          <h1 className="c4t-display-md" style={{ margin: 0 }}>
            Leads
          </h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            Demo requests from the website, in arrival order. Open one to triage: change its status,
            leave a note, or convert it into a customer organisation.
          </p>
        </header>

        <form
          method="get"
          action="/app/admin/leads"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(220px, 1fr) minmax(180px, 240px) auto',
            gap: 'var(--space-4)',
            alignItems: 'end',
          }}
        >
          <Field label="Search" htmlFor="search">
            <Input
              id="search"
              name="search"
              type="search"
              defaultValue={search ?? ''}
              placeholder="Name, email or company"
              iconLeft="search"
            />
          </Field>

          <Field label="Status" htmlFor="status">
            <Select
              id="status"
              name="status"
              defaultValue={status ?? ''}
              options={STATUS_FILTER_OPTIONS}
            />
          </Field>

          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Button type="submit" variant="primary" iconLeft="filter">
              Filter
            </Button>
            {status !== undefined || search !== undefined ? (
              <Link href="/app/admin/leads">
                <Button type="button" variant="ghost">
                  Clear
                </Button>
              </Link>
            ) : null}
          </div>
        </form>

        {'error' in result ? (
          result.error === 'forbidden' ? (
            <EmptyState
              icon="lock"
              title="You don't have access to leads"
              description="Ask an administrator to grant you the lead.read permission."
            />
          ) : (
            <EmptyState
              icon="alert-triangle"
              title="Couldn't load leads"
              description="The leads service is unreachable. Refresh in a moment."
            />
          )
        ) : result.items.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={search || status ? 'No leads match your filters' : 'No leads yet'}
            description={
              search || status
                ? 'Try widening the search or clearing the status filter.'
                : 'New demo requests land here as soon as a visitor submits the contact form.'
            }
          />
        ) : (
          <>
            <Table
              ariaLabel="Leads"
              columns={columns}
              rows={result.items}
              rowKey={(row) => row.id}
              rowHref={(row) => `/app/admin/leads/${row.id}`}
            />
            <Pagination
              page={result.meta.page}
              totalPages={Math.max(1, result.meta.totalPages)}
              total={result.meta.total}
              limit={result.meta.limit}
              hrefFor={hrefFor}
            />
          </>
        )}
      </main>
    </>
  )
}
