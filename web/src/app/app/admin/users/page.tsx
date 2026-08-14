import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { StatusBadge, RoleBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, personName } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/users'
const ROLES = ['USER', 'CUSTOMER', 'TESTER', 'ADMIN', 'SUB_ADMIN'] as const
const STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const

interface UserRow {
  id: string
  email: string
  role: string
  status: string
  firstName: string | null
  lastName: string | null
  countryCode: string | null
  emailVerifiedAt: string | null
  lastLoginAt: string | null
  createdAt: string
  orgMemberships: readonly { organisation: { id: string; name: string } }[]
  testerProfile: { id: string; status: string } | null
}

/**
 * `/app/admin/users` — every account on the platform, across all roles.
 *
 * This is the account-level view. Testers get their own page because a tester
 * is an account *plus* a profile, devices, skills and a rating history, none of
 * which fits in this table — so the two lists overlap by design and answer
 * different questions. This one answers "can this person sign in, and as what".
 *
 * "Never" in the last-seen column is a real signal, not a missing value: an
 * account created weeks ago that has never logged in is usually an invitation
 * that was never accepted.
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; status?: string; search?: string; page?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const role = ROLES.includes(params.role as (typeof ROLES)[number]) ? params.role : undefined
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : undefined
  const search = params.search?.trim() || undefined
  const page = parsePage(params.page)

  const result = await loadList<UserRow>('users', {
    page,
    limit: PAGE_SIZE,
    query: { role, status, search },
  })

  const columns: readonly TableColumn<UserRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => personName(row),
      renderSecondary: (row) => row.email,
    },
    { key: 'role', header: 'Role', render: (row) => <RoleBadge role={row.role} /> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'org',
      header: 'Organisation',
      render: (row) =>
        row.orgMemberships.length > 0
          ? (row.orgMemberships[0]?.organisation.name ?? '—')
          : '—',
      renderSecondary: (row) =>
        row.orgMemberships.length > 1 ? `+${row.orgMemberships.length - 1} more` : undefined,
    },
    {
      key: 'verified',
      header: 'Email',
      render: (row) => (row.emailVerifiedAt ? 'Verified' : 'Unverified'),
    },
    {
      key: 'lastLogin',
      header: 'Last seen',
      align: 'right',
      render: (row) => (row.lastLoginAt ? formatDate(row.lastLoginAt) : 'Never'),
      renderSecondary: (row) => `Joined ${formatDate(row.createdAt)}`,
    },
  ]

  return (
    <AdminListPage
      eyebrow="Accounts"
      title="Users"
      description="Every account and what it can sign in as. Testers also appear on their own page, which adds the profile, devices and rating history this table leaves out."
      crumbs={[{ label: 'Users' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { role, status, search })}
      filtered={Boolean(role || status || search)}
      permission="user.read"
      emptyIcon="user-check"
      emptyTitle="No users match"
      emptyDescription="Every account on the platform is listed here, including administrators."
      toolbar={
        <ListFilters
          action={BASE}
          search={{ value: search, placeholder: 'Name or email' }}
          selects={[
            { name: 'role', label: 'Role', options: ROLES, value: role, allLabel: 'All roles' },
            {
              name: 'status',
              label: 'Status',
              options: STATUSES,
              value: status,
              allLabel: 'All statuses',
            },
          ]}
        />
      }
    />
  )
}
