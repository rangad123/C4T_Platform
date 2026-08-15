import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { Button } from '@/components/ds/core/Button'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, searchTerm, hasFilter } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/organisations'
const STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const

interface OrganisationRow {
  id: string
  name: string
  slug: string
  status: string
  industry: string | null
  contactEmail: string | null
  city: string | null
  countryCode: string | null
  onboardedAt: string | null
  createdAt: string
  _count: { members: number; projects: number }
}

/**
 * `/app/admin/organisations` — every customer organisation on the platform.
 *
 * The API scopes this list by caller rather than by permission: an admin sees
 * all organisations, a customer sees only theirs. The route is still gated to
 * ADMIN/SUB_ADMIN by the layout, so reaching this page at all means the wider
 * view — but a sub-admin without `organisation.read` still gets a 403 from the
 * API, which `loadList` turns into the forbidden empty state.
 */
export default async function OrganisationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string; page?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : undefined
  const search = searchTerm(params.search)
  const page = parsePage(params.page)

  const result = await loadList<OrganisationRow>('organisations', {
    page,
    limit: PAGE_SIZE,
    query: { status, search },
  })

  const columns: readonly TableColumn<OrganisationRow>[] = [
    {
      key: 'name',
      header: 'Organisation',
      render: (row) => row.name,
      renderSecondary: (row) => row.contactEmail ?? row.slug,
    },
    {
      key: 'industry',
      header: 'Industry',
      render: (row) => row.industry ?? '—',
      renderSecondary: (row) =>
        [row.city, row.countryCode].filter(Boolean).join(', ') || undefined,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'members',
      header: 'Members',
      align: 'right',
      render: (row) => row._count.members,
    },
    {
      key: 'projects',
      header: 'Projects',
      align: 'right',
      render: (row) => row._count.projects,
    },
    {
      key: 'onboarded',
      header: 'Onboarded',
      align: 'right',
      render: (row) => formatDate(row.onboardedAt ?? row.createdAt),
    },
  ]

  return (
    <AdminListPage
      eyebrow="Accounts"
      title="Organisations"
      description="Every customer organisation, with the size of its team and how many projects it has run. Approve a pending application, freeze an account, or open one to see its members."
      crumbs={[{ label: 'Organisations' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      hrefFor={pageHrefBuilder(BASE, { status, search })}
      filtered={hasFilter([status, search])}
      permission="organisation.read"
      emptyIcon="building-2"
      emptyTitle="No organisations yet"
      emptyDescription="An organisation appears here when a lead is converted, or when you create one directly."
      toolbar={
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <ListFilters
              action={BASE}
              search={{ value: search, placeholder: 'Name, slug or contact email' }}
              selects={[
                {
                  name: 'status',
                  label: 'Status',
                  options: STATUSES,
                  value: status,
                  allLabel: 'All statuses',
                },
              ]}
            />
          </div>
          <Link href="/app/admin/organisations/new">
            <Button variant="primary" iconLeft="plus">
              New organisation
            </Button>
          </Link>
        </div>
      }
    />
  )
}
