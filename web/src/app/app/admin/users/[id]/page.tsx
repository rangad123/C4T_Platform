import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { SectionTabs, resolveSection, type SectionTab } from '@/components/admin/SectionTabs'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { CountryLabel } from '@/components/admin/CountryFlag'
import { RoleBadge, StatusBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { hasPermission, requirePermission } from '@/lib/auth/session'
import { formatDate, personName, stars, titleCase } from '@/lib/admin/format'
import {
  archiveUserAccount,
  changeUserRole,
  changeUserStatus,
  setSubAdminPermissions,
  updateUserIdentity,
} from './actions'

/**
 * `/app/admin/users/[id]` — one account, everything an administrator can change
 * about it, and the §2.2 "Sub-Admin Permissions" editor.
 *
 * The page is deliberately several small forms rather than one big one. Each
 * panel maps to exactly one API call (PATCH the profile, POST the role, POST the
 * status, PUT the grants, DELETE the account), so a rejected write only ever
 * loses the fields in the panel that was submitted, and the audit entry the API
 * records names one intent instead of five.
 *
 * Three permissions are in play and they are not the same thing:
 *
 *   user.read       — see this page at all
 *   user.write      — change the identity, role, status; archive the account
 *   subadmin.manage — read the permission catalogue and edit a sub-admin's grants
 *
 * A viewer holding only `user.read` gets the same page with every form replaced
 * by the values it would have edited, rather than forms that 403 on submit.
 */

const BASE = '/app/admin/users'

const ROLES = ['USER', 'CUSTOMER', 'TESTER', 'ADMIN', 'SUB_ADMIN'] as const
const STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const

const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: titleCase(role) }))
const STATUS_OPTIONS = STATUSES.map((status) => ({ value: status, label: titleCase(status) }))

interface PermissionEntry {
  /** Absent when the API falls back to its in-code catalogue. */
  id?: string
  code: string
  group: string
  label: string
  description?: string
}

interface GrantEntry {
  id?: string
  code: string
  group: string
  label: string
  grantedAt?: string
}

interface UserDetail {
  id: string
  email: string
  role: string
  status: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  countryCode: string | null
  timezone: string | null
  avatarFileId: string | null
  emailVerifiedAt: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
  permissions: readonly { permission: { code: string; label: string; group: string } }[]
  orgMemberships: readonly {
    orgRole: string
    organisation: { id: string; name: string; status: string }
  }[]
  /** `ratingAverage` is a Prisma Decimal, which serialises as a string. */
  testerProfile: { id: string; status: string; ratingAverage: number | string | null } | null
  _count: { bugsReported: number; assignments: number; projectsCreated: number }
}

interface MembershipRow {
  id: string
  name: string
  status: string
  orgRole: string
}

const formStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-6)',
}

const fieldGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 'var(--space-5) var(--space-6)',
}

const noteStyle = {
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: 'var(--type-body-sm-size)',
  lineHeight: 1.55,
}

/** Groups the catalogue in the order the API returned it (group, then code). */
function groupCatalogue(catalogue: readonly PermissionEntry[]) {
  const groups: { group: string; items: PermissionEntry[] }[] = []
  for (const entry of catalogue) {
    const bucket = groups.find((candidate) => candidate.group === entry.group)
    if (bucket) bucket.items.push(entry)
    else groups.push({ group: entry.group, items: [entry] })
  }
  return groups
}

function ratingLabel(value: number | string | null): string {
  if (value === null || value === '') return '—'
  const score = Number(value)
  if (!Number.isFinite(score)) return '—'
  return `${stars(score)} ${score.toFixed(1)}`
}

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ section?: string }>
}) {
  const { id } = await params
  const viewer = await requirePermission('user.read', `${BASE}/${id}`)

  let user: UserDetail | null = null
  let loadError: 'forbidden' | 'not_found' | 'unknown' | null = null

  try {
    // `serverFetch` unwraps the `{ data }` envelope — this IS the user.
    user = await serverFetch<UserDetail>(`users/${id}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) loadError = 'not_found'
    else if (err instanceof ApiError && err.status === 403) loadError = 'forbidden'
    else loadError = 'unknown'
  }

  if (loadError === 'not_found') notFound()

  if (loadError !== null || user === null) {
    const forbidden = loadError === 'forbidden'
    return (
      <DetailShell
        crumbs={[{ label: 'Users', href: BASE }, { label: forbidden ? 'Restricted' : 'Error' }]}
        eyebrow="Accounts"
        title={forbidden ? 'Restricted account' : 'Account unavailable'}
      >
        <EmptyState
          icon={forbidden ? 'lock' : 'alert-triangle'}
          title={forbidden ? "You don't have access to this account" : "Couldn't load this account"}
          description={
            forbidden
              ? 'Ask an administrator to grant you the user.read permission.'
              : 'The users service is unreachable. Refresh in a moment.'
          }
          action={
            <Button href={BASE} variant="secondary" iconLeft="arrow-left">
              Back to users
            </Button>
          }
        />
      </DetailShell>
    )
  }

  const canWrite = hasPermission(viewer, 'user.write')
  const canManageSubAdmins = hasPermission(viewer, 'subadmin.manage')
  const isSubAdmin = user.role === 'SUB_ADMIN'
  const isSelf = viewer.id === user.id
  const displayName = personName(user)

  // The grant set embedded in the detail read needs only user.read, so it stays
  // the fallback when the dedicated permissions endpoints are out of reach.
  const embeddedGrants: GrantEntry[] = user.permissions.map((entry) => entry.permission)

  let catalogue: PermissionEntry[] = []
  let grants: GrantEntry[] = embeddedGrants
  let permissionsError: 'forbidden' | 'unknown' | null = null

  if (isSubAdmin) {
    if (!canManageSubAdmins) {
      permissionsError = 'forbidden'
    } else {
      try {
        const [catalogueResult, grantsResult] = await Promise.all([
          serverFetch<PermissionEntry[]>('users/permissions/catalogue'),
          serverFetch<GrantEntry[]>(`users/${id}/permissions`),
        ])
        catalogue = catalogueResult
        grants = grantsResult
      } catch (err) {
        permissionsError = err instanceof ApiError && err.status === 403 ? 'forbidden' : 'unknown'
      }
    }
  }

  const grantedCodes = new Set(grants.map((grant) => grant.code))
  const permissionGroups = groupCatalogue(catalogue)
  const permissionsEditable = canManageSubAdmins && !isSelf && permissionGroups.length > 0

  const membershipRows: MembershipRow[] = user.orgMemberships.map((membership) => ({
    id: membership.organisation.id,
    name: membership.organisation.name,
    status: membership.organisation.status,
    orgRole: membership.orgRole,
  }))

  const membershipColumns: readonly TableColumn<MembershipRow>[] = [
    { key: 'name', header: 'Organisation', render: (row) => row.name },
    { key: 'orgRole', header: 'Membership', render: (row) => titleCase(row.orgRole) },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      render: (row) => <StatusBadge status={row.status} />,
    },
  ]

  /*
    Two of the four sections are conditional — a customer has no permission
    grid, and a read-only viewer gets no danger zone — so the tab set is
    built here rather than declared at module scope. `resolveSection` then
    falls back to Identity if someone lands on `?section=permissions` for an
    account that has none.
  */
  const sections: SectionTab[] = [
    { value: 'identity', label: 'Identity', icon: 'user-check' },
    ...(isSubAdmin ? [{ value: 'permissions', label: 'Permissions', icon: 'shield-check' as const, count: grantedCodes.size }] : []),
    { value: 'organisations', label: 'Organisations', icon: 'building-2', count: membershipRows.length },
    ...(canWrite ? [{ value: 'danger', label: 'Danger zone', icon: 'shield-alert' as const }] : []),
  ]
  const section = resolveSection(sections, (await searchParams).section)

  return (
    <DetailShell
      crumbs={[{ label: 'Users', href: BASE }, { label: displayName }]}
      eyebrow="Accounts"
      title={displayName}
      subtitle={user.email}
      badges={
        <>
          <RoleBadge role={user.role} />
          <StatusBadge status={user.status} />
          {user.emailVerifiedAt === null ? (
            <Badge tone="warning" uppercase={false}>
              Email unverified
            </Badge>
          ) : null}
          {isSelf ? (
            <Badge tone="neutral" uppercase={false}>
              This is you
            </Badge>
          ) : null}
        </>
      }
      tabs={<SectionTabs basePath={`${BASE}/${user.id}`} tabs={sections} active={section} />}
      aside={
        <>
          <Panel
            title="Role"
            description="What this account can sign in as."
          >
            {canWrite ? (
              <form action={changeUserRole} style={formStyle}>
                <input type="hidden" name="id" value={user.id} />
                <Field
                  label="Role"
                  htmlFor="role"
                  hint="Moving into sub-admin seeds a default read-only grant set. Moving out of it revokes every grant."
                >
                  <Select id="role" name="role" defaultValue={user.role} options={ROLE_OPTIONS} />
                </Field>
                <Button type="submit" variant="secondary" fullWidth>
                  Change role
                </Button>
              </form>
            ) : (
              <DescriptionList items={[{ label: 'Role', value: titleCase(user.role) }]} />
            )}
          </Panel>

          <Panel
            title="Status"
            description="Anything other than active ends every live session for this account."
          >
            {canWrite ? (
              <form action={changeUserStatus} style={formStyle}>
                <input type="hidden" name="id" value={user.id} />
                <Field label="Status" htmlFor="status">
                  <Select
                    id="status"
                    name="status"
                    defaultValue={user.status}
                    options={STATUS_OPTIONS}
                  />
                </Field>
                <Field label="Reason" htmlFor="reason" hint="Optional. Recorded in the audit log.">
                  <Textarea
                    id="reason"
                    name="reason"
                    rows={3}
                    maxLength={1000}
                    placeholder="Why is this changing?"
                  />
                </Field>
                <Button type="submit" variant="secondary" fullWidth>
                  Update status
                </Button>
              </form>
            ) : (
              <DescriptionList items={[{ label: 'Status', value: titleCase(user.status) }]} />
            )}
          </Panel>

          <Panel title="Account">
            <DescriptionList
              items={[
                { label: 'Email', value: user.email },
                {
                  label: 'Email verified',
                  value: user.emailVerifiedAt ? formatDate(user.emailVerifiedAt) : 'Not verified',
                },
                {
                  label: 'Last sign-in',
                  value: user.lastLoginAt ? formatDate(user.lastLoginAt) : 'Never',
                },
                { label: 'Created', value: formatDate(user.createdAt) },
                { label: 'Last updated', value: formatDate(user.updatedAt) },
                { label: 'Timezone', value: user.timezone ?? '' },
                {
                  label: 'Account id',
                  value: (
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{user.id}</span>
                  ),
                },
              ]}
            />
          </Panel>

          <Panel title="Contribution">
            <DescriptionList
              items={[
                { label: 'Bugs reported', value: String(user._count.bugsReported) },
                { label: 'Assignments', value: String(user._count.assignments) },
                { label: 'Projects created', value: String(user._count.projectsCreated) },
                ...(user.testerProfile
                  ? [
                      {
                        label: 'Tester rating',
                        value: ratingLabel(user.testerProfile.ratingAverage),
                      },
                      {
                        label: 'Tester profile',
                        value: (
                          <Link
                            href={`/app/admin/testers/${user.testerProfile.id}`}
                            style={{
                              color: 'var(--text-brand)',
                              textDecoration: 'underline',
                              textUnderlineOffset: 3,
                            }}
                          >
                            {titleCase(user.testerProfile.status)}
                          </Link>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </Panel>
        </>
      }
    >
      {section === 'identity' ? (
        <>
          <Panel
            title="Identity"
            description="The name, phone and locale on the account. Email addresses change through account recovery, not here."
          >
            {canWrite ? (
              <TrackedForm action={updateUserIdentity} style={formStyle}>
                <input type="hidden" name="id" value={user.id} />
                <div style={fieldGridStyle}>
                  <Field label="First name" htmlFor="firstName" required>
                    <Input
                      id="firstName"
                      name="firstName"
                      defaultValue={user.firstName ?? ''}
                      maxLength={80}
                      required
                      autoComplete="off"
                    />
                  </Field>
                  <Field label="Last name" htmlFor="lastName">
                    <Input
                      id="lastName"
                      name="lastName"
                      defaultValue={user.lastName ?? ''}
                      maxLength={80}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label="Phone" htmlFor="phone" hint="Include the country dialling code.">
                    <Input
                      id="phone"
                      name="phone"
                      type="tel"
                      defaultValue={user.phone ?? ''}
                      maxLength={32}
                      autoComplete="off"
                    />
                  </Field>
                  <Field
                    label="Country"
                    htmlFor="countryCode"
                    hint="Two-letter code, for example IN. It can be changed but not cleared."
                  >
                    <Input
                      id="countryCode"
                      name="countryCode"
                      defaultValue={user.countryCode ?? ''}
                      minLength={2}
                      maxLength={2}
                      autoComplete="off"
                    />
                  </Field>
                  <Field
                    label="Timezone"
                    htmlFor="timezone"
                    hint="An IANA name, for example Asia/Kolkata."
                  >
                    <Input
                      id="timezone"
                      name="timezone"
                      defaultValue={user.timezone ?? ''}
                      maxLength={60}
                      autoComplete="off"
                    />
                  </Field>
                </div>
                <div>
                  <Button type="submit" variant="primary">
                    Save identity
                  </Button>
                </div>
              </TrackedForm>
            ) : (
              <div style={formStyle}>
                <DescriptionList
                  items={[
                    { label: 'First name', value: user.firstName ?? '' },
                    { label: 'Last name', value: user.lastName ?? '' },
                    { label: 'Phone', value: user.phone ?? '' },
                    {
                      label: 'Country',
                      value: user.countryCode ? <CountryLabel countryCode={user.countryCode} /> : '',
                    },
                    { label: 'Timezone', value: user.timezone ?? '' },
                  ]}
                />
                <p style={noteStyle}>
                  You can read this account but not change it. Editing needs the user.write permission.
                </p>
              </div>
            )}
          </Panel>
        </>
      ) : null}

      {/* The tab only exists for a sub-admin, so `section` can never resolve
          here for anyone else — the second test is belt and braces. */}
      {section === 'permissions' && isSubAdmin ? (
            <Panel
              title="Sub-admin permissions"
              description="What this sub-admin can do in the back office. Saving replaces the whole grant set, so anything left unticked is revoked."
              actions={
                <Badge tone="accent" uppercase={false}>
                  {grantedCodes.size} granted
                </Badge>
              }
            >
              {permissionsError !== null ? (
                <div style={formStyle}>
                  <EmptyState
                    icon={permissionsError === 'forbidden' ? 'lock' : 'alert-triangle'}
                    title={
                      permissionsError === 'forbidden'
                        ? "You can't edit these permissions"
                        : "Couldn't load the permission catalogue"
                    }
                    description={
                      permissionsError === 'forbidden'
                        ? "Editing a sub-admin's access needs the subadmin.manage permission. Ask an administrator to grant it."
                        : 'The users service is unreachable. Refresh in a moment.'
                    }
                  />
                  <GrantSummary grants={embeddedGrants} />
                </div>
              ) : permissionsEditable ? (
                <TrackedForm action={setSubAdminPermissions} style={formStyle}>
                  <input type="hidden" name="id" value={user.id} />
                  {permissionGroups.map((group) => (
                    <fieldset
                      key={group.group}
                      style={{
                        margin: 0,
                        padding: 0,
                        border: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'var(--space-4)',
                      }}
                    >
                      <legend
                        className="c4t-eyebrow"
                        style={{ padding: 0, color: 'var(--text-muted)' }}
                      >
                        {group.group}
                      </legend>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                          gap: 'var(--space-4) var(--space-6)',
                        }}
                      >
                        {group.items.map((permission) => (
                          <Checkbox
                            key={permission.code}
                            id={`perm-${permission.code}`}
                            name="permissionCodes"
                            value={permission.code}
                            defaultChecked={grantedCodes.has(permission.code)}
                            label={permission.label}
                            description={permission.description}
                          />
                        ))}
                      </div>
                    </fieldset>
                  ))}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-5)',
                      flexWrap: 'wrap',
                      paddingTop: 'var(--space-6)',
                      borderTop: '1px solid var(--border-subtle)',
                    }}
                  >
                    <Button type="submit" variant="primary">
                      Save permissions
                    </Button>
                    <span style={noteStyle}>
                      This is a full replacement, not a change list. Every unticked box is revoked.
                    </span>
                  </div>
                </TrackedForm>
              ) : (
                <div style={formStyle}>
                  <p style={noteStyle}>
                    {isSelf
                      ? 'These are your own permissions, and the API refuses to let anyone edit their own grants. Ask another administrator to change them.'
                      : 'The permission catalogue came back empty, so there is nothing to grant. Seed the permissions table on the API and reload.'}
                  </p>
                  <GrantSummary grants={grants} />
                </div>
              )}
            </Panel>
      ) : null}

      {section === 'organisations' ? (
        <>
          <Panel
            title="Organisations"
            description="Customer organisations this account belongs to."
          >
            {membershipRows.length > 0 ? (
              <Table
                ariaLabel="Organisation memberships"
                columns={membershipColumns}
                rows={membershipRows}
                rowKey={(row) => row.id}
                rowHref={(row) => `/app/admin/organisations/${row.id}`}
              />
            ) : (
              <p style={noteStyle}>
                This account is not a member of any organisation. Administrators, sub-admins and testers
                normally are not.
              </p>
            )}
          </Panel>
        </>
      ) : null}

      {section === 'danger' && canWrite ? (
            <Panel
              title="Danger zone"
              description="Archiving is the only removal the platform offers, and it cannot be undone from here."
            >
              <form action={archiveUserAccount} style={formStyle}>
                <input type="hidden" name="id" value={user.id} />
                <div
                  style={{
                    padding: 'var(--space-5)',
                    borderRadius: 'var(--radius-card)',
                    background: 'var(--status-error-bg)',
                    color: 'var(--status-error-fg)',
                    fontSize: 'var(--type-body-sm-size)',
                    lineHeight: 1.55,
                  }}
                >
                  The record is kept for audit and marked deactivated, every live session is revoked, and
                  the email address is released so it can be used again. The account then drops out of
                  the users list. The last active administrator cannot be archived.
                </div>
                <div>
                  <Button
                    type="submit"
                    variant="secondary"
                    iconLeft="shield-alert"
                    style={{
                      color: 'var(--status-error-fg)',
                      borderColor: 'var(--status-error-fg)',
                    }}
                  >
                    Deactivate and archive this account
                  </Button>
                </div>
              </form>
            </Panel>
      ) : null}
    </DetailShell>
  )
}

/**
 * The current grants as read-only pills.
 *
 * Shown wherever the editor cannot be: a viewer without `subadmin.manage`, and
 * an administrator looking at their own record. Knowing what a sub-admin can do
 * is a `user.read` question; changing it is not.
 */
function GrantSummary({ grants }: { grants: readonly GrantEntry[] }) {
  if (grants.length === 0) {
    return <p style={noteStyle}>This sub-admin holds no permissions yet.</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <p className="c4t-eyebrow" style={{ margin: 0, color: 'var(--text-muted)' }}>
        Currently granted
      </p>
      <ul
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
          listStyle: 'none',
          margin: 0,
          padding: 0,
        }}
      >
        {grants.map((grant) => (
          <li key={grant.code}>
            <Badge tone="neutral" uppercase={false}>
              {grant.label}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  )
}
