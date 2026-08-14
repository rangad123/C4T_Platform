import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { serverFetch, serverFetchPage } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { hasPermission, requireRole } from '@/lib/auth/session'
import { formatDate, personName, titleCase } from '@/lib/admin/format'
import {
  addOrganisationMember,
  archiveOrganisation,
  removeOrganisationMember,
  saveMemberRole,
  saveOrganisationNotes,
  saveOrganisationProfile,
  saveOrganisationStatus,
} from './actions'

/**
 * `/app/admin/organisations/[id]` — one customer organisation (§2.2).
 *
 * Five concerns, five panels, five separate writes: identity, internal notes,
 * members, status and archival. Splitting them means a rejected save only ever
 * costs the reader the fields in that one panel, and every submit maps to
 * exactly one API call.
 *
 * The API gates the profile, status and archive writes on `organisation.write`
 * and `organisation.delete`, while member changes are open to any admin-side
 * caller (the service short-circuits its membership check for them). This page
 * mirrors that split: without the grant it renders the same values read-only
 * instead of offering a control that would 403.
 */

const BASE = '/app/admin/organisations'
const STATUS_OPTIONS = ['PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'].map((value) => ({
  value,
  label: titleCase(value),
}))
const MEMBER_ROLE_OPTIONS = ['OWNER', 'MEMBER'].map((value) => ({
  value,
  label: titleCase(value),
}))

/** Roles that may hold a customer-organisation membership. */
const ELIGIBLE_MEMBER_ROLES: readonly string[] = ['CUSTOMER', 'USER']

interface OrganisationMember {
  orgRole: string
  joinedAt: string | null
  user: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    status: string
  }
}

interface OrganisationDetail {
  id: string
  name: string
  slug: string
  status: string
  website: string | null
  industry: string | null
  contactEmail: string | null
  contactPhone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  countryCode: string | null
  taxId: string | null
  onboardedAt: string | null
  createdAt: string
  updatedAt: string
  notes: string | null
  members: OrganisationMember[]
  _count: { projects: number; transactions: number }
}

interface AccountOption {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  role: string
}

/**
 * Every notice an action on this page can hand back, keyed by the `?notice=`
 * code the Server Action redirects with.
 *
 * The copy is written here rather than passed through the URL on purpose: a
 * message assembled from a query string is a message an attacker can put in
 * front of an admin, and the API's own wording is not always the wording the
 * reader needs.
 */
const NOTICES: Record<string, { tone: 'success' | 'warning' | 'error'; message: string }> = {
  created: { tone: 'success', message: 'Organisation created. Add its owner below.' },
  'profile-saved': { tone: 'success', message: 'Profile saved.' },
  'status-saved': { tone: 'success', message: 'Status updated.' },
  'notes-saved': { tone: 'success', message: 'Internal notes saved.' },
  'member-added': { tone: 'success', message: 'Member added.' },
  'member-role-saved': { tone: 'success', message: 'Member role updated.' },
  'member-removed': { tone: 'success', message: 'Member removed.' },
  'member-missing-account': {
    tone: 'warning',
    message: 'Choose an account before adding a member.',
  },
  'member-exists': { tone: 'warning', message: 'That account is already a member here.' },
  'member-invalid': {
    tone: 'error',
    message:
      'That account cannot join a customer organisation. Tester accounts are held apart from customer teams.',
  },
  'last-owner': {
    tone: 'warning',
    message:
      'An organisation has to keep at least one owner. Promote another member first, then change this one.',
  },
  'archive-unconfirmed': {
    tone: 'warning',
    message: 'Nothing was archived. Type ARCHIVE in the confirmation field to go ahead.',
  },
  'archive-blocked': {
    tone: 'warning',
    message:
      'This organisation still has projects in flight. Close or cancel them, then archive the account.',
  },
  invalid: {
    tone: 'error',
    message: 'The API rejected those values. Check the highlighted formats and save again.',
  },
  'forbidden-write': {
    tone: 'error',
    message: 'That change needs the organisation.write permission, so nothing was saved.',
  },
  'forbidden-delete': {
    tone: 'error',
    message: 'Archiving needs the organisation.delete permission, so nothing was archived.',
  },
  missing: { tone: 'error', message: 'That record is no longer there. Reload the page.' },
  failed: {
    tone: 'error',
    message: 'The organisations service did not accept that change. Try again in a moment.',
  },
}

const NOTICE_TONES = {
  success: { background: 'var(--status-success-bg)', color: 'var(--status-success-fg)' },
  warning: { background: 'var(--status-warning-bg)', color: 'var(--status-warning-fg)' },
  error: { background: 'var(--status-error-bg)', color: 'var(--status-error-fg)' },
} as const

function Notice({ code }: { code: string | undefined }) {
  const notice = code ? NOTICES[code] : undefined
  if (!notice) return null

  return (
    <p
      role={notice.tone === 'success' ? 'status' : 'alert'}
      style={{
        margin: 0,
        padding: 'var(--space-4) var(--space-5)',
        borderRadius: 'var(--radius-card)',
        fontSize: 'var(--type-body-sm-size)',
        ...NOTICE_TONES[notice.tone],
      }}
    >
      {notice.message}
    </p>
  )
}

function accountLabel(account: AccountOption): string {
  const name = personName(account)
  return name === account.email ? account.email : `${name} — ${account.email}`
}

/**
 * Accounts that could be added to this organisation.
 *
 * `GET users` is gated on `user.read`, which an admin holding only
 * `organisation.write` will not have — so a failure is a state, not a crash:
 * the panel falls back to accepting a pasted account id.
 *
 * Testers and staff accounts are filtered out. The API only refuses testers,
 * but binding an admin account to a customer team is never the intent, and the
 * shorter list is the one worth reading.
 */
async function loadAccounts(
  search: string | undefined,
): Promise<{ accounts: AccountOption[]; available: boolean }> {
  try {
    const page = await serverFetchPage<AccountOption>('users', {
      query: { limit: 100, sort: 'email', order: 'asc', search },
    })
    return {
      accounts: page.data.filter((account) => ELIGIBLE_MEMBER_ROLES.includes(account.role)),
      available: true,
    }
  } catch {
    return { accounts: [], available: false }
  }
}

export default async function OrganisationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ notice?: string; q?: string }>
}) {
  const user = await requireRole(['ADMIN', 'SUB_ADMIN'])

  const { id } = await params
  const { notice, q } = await searchParams
  const accountSearch = q?.trim() || undefined

  let organisation: OrganisationDetail | null = null
  let loadError: 'forbidden' | 'unknown' | null = null

  try {
    organisation = await serverFetch<OrganisationDetail>(`organisations/${id}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    if (error instanceof ApiError && error.status === 403) loadError = 'forbidden'
    else loadError = 'unknown'
  }

  if (loadError || !organisation) {
    return (
      <DetailShell
        crumbs={[
          { label: 'Organisations', href: BASE },
          { label: loadError === 'forbidden' ? 'Restricted' : 'Unavailable' },
        ]}
        eyebrow="Accounts"
        title="Organisation"
      >
        {loadError === 'forbidden' ? (
          <EmptyState
            icon="lock"
            title="You don't have access to this organisation"
            description="Ask an administrator to grant you the organisation.read permission."
            action={
              <Button href={BASE} variant="secondary" iconLeft="arrow-left">
                Back to organisations
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon="alert-triangle"
            title="Couldn't load this organisation"
            description="The organisations service is unreachable. Refresh in a moment."
            action={
              <Button href={BASE} variant="secondary" iconLeft="arrow-left">
                Back to organisations
              </Button>
            }
          />
        )}
      </DetailShell>
    )
  }

  const canWrite = hasPermission(user, 'organisation.write')
  const canArchive = hasPermission(user, 'organisation.delete')
  const detailHref = `${BASE}/${organisation.id}`

  const memberIds = new Set(organisation.members.map((member) => member.user.id))
  const { accounts, available: accountsAvailable } = await loadAccounts(accountSearch)
  const candidates = accounts.filter((account) => !memberIds.has(account.id))

  const memberColumns: readonly TableColumn<OrganisationMember>[] = [
    {
      key: 'member',
      header: 'Member',
      render: (member) => personName(member.user),
      renderSecondary: (member) => member.user.email,
    },
    {
      key: 'account',
      header: 'Account',
      render: (member) => <StatusBadge status={member.user.status} />,
    },
    {
      key: 'joined',
      header: 'Joined',
      render: (member) => formatDate(member.joinedAt),
    },
    {
      key: 'manage',
      header: 'Org role',
      render: (member) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <form
            action={saveMemberRole}
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
          >
            <input type="hidden" name="id" value={organisation.id} />
            <input type="hidden" name="userId" value={member.user.id} />
            <label className="c4t-visually-hidden" htmlFor={`role-${member.user.id}`}>
              Organisation role for {personName(member.user)}
            </label>
            <Select
              id={`role-${member.user.id}`}
              name="orgRole"
              defaultValue={member.orgRole}
              options={MEMBER_ROLE_OPTIONS}
              style={{ width: 150, minHeight: 44 }}
            />
            <Button type="submit" variant="secondary">
              Save role
            </Button>
          </form>
          <form action={removeOrganisationMember}>
            <input type="hidden" name="id" value={organisation.id} />
            <input type="hidden" name="userId" value={member.user.id} />
            <Button type="submit" variant="ghost" style={{ color: 'var(--status-error-fg)' }}>
              Remove
            </Button>
          </form>
        </span>
      ),
    },
  ]

  const owners = organisation.members.filter((member) => member.orgRole === 'OWNER')

  return (
    <DetailShell
      crumbs={[{ label: 'Organisations', href: BASE }, { label: organisation.name }]}
      eyebrow="Accounts"
      title={organisation.name}
      badges={<StatusBadge status={organisation.status} />}
      subtitle={
        <>
          {organisation.slug}
          {organisation.contactEmail ? ` · ${organisation.contactEmail}` : ''}
        </>
      }
      aside={
        <>
          <Panel
            title="Status"
            description="Where this account sits in onboarding. Moving it to active stamps the onboarding date if it has none."
          >
            {canWrite ? (
              <form
                action={saveOrganisationStatus}
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
              >
                <input type="hidden" name="id" value={organisation.id} />
                <Field
                  label="Account status"
                  htmlFor="status"
                  hint="Archived here still lists the account. To retire it, use the danger zone."
                >
                  <Select
                    id="status"
                    name="status"
                    defaultValue={organisation.status}
                    options={STATUS_OPTIONS}
                  />
                </Field>
                <Button type="submit" variant="primary" fullWidth>
                  Save status
                </Button>
              </form>
            ) : (
              <ReadOnlyHint
                items={[{ label: 'Account status', value: titleCase(organisation.status) }]}
                permission="organisation.write"
              />
            )}
          </Panel>

          <Panel title="Record" description="What the platform knows about this account.">
            <DescriptionList
              items={[
                { label: 'Slug', value: organisation.slug },
                { label: 'Created', value: formatDate(organisation.createdAt) },
                { label: 'Onboarded', value: formatDate(organisation.onboardedAt) },
                { label: 'Last updated', value: formatDate(organisation.updatedAt) },
                { label: 'Members', value: organisation.members.length },
                { label: 'Owners', value: owners.length },
                { label: 'Projects', value: organisation._count.projects },
                { label: 'Transactions', value: organisation._count.transactions },
              ]}
            />
          </Panel>
        </>
      }
    >
      <Notice code={notice} />

      <Panel
        title="Profile"
        description="The billing and contact details we hold for this organisation."
      >
        {canWrite ? (
          <form
            action={saveOrganisationProfile}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
          >
            <input type="hidden" name="id" value={organisation.id} />

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 'var(--space-5)',
              }}
            >
              <Field label="Name" htmlFor="name" required>
                <Input
                  id="name"
                  name="name"
                  defaultValue={organisation.name}
                  required
                  minLength={2}
                  maxLength={160}
                />
              </Field>

              <Field
                label="Slug"
                htmlFor="slug"
                hint="Derived from the name when the record was created. The API does not accept changes."
              >
                <Input id="slug" name="slug" defaultValue={organisation.slug} disabled />
              </Field>

              <Field label="Website" htmlFor="website" hint="Include https://. Blank clears it.">
                <Input
                  id="website"
                  name="website"
                  type="url"
                  defaultValue={organisation.website ?? ''}
                  maxLength={255}
                  placeholder="https://example.com"
                />
              </Field>

              <Field label="Industry" htmlFor="industry">
                <Input
                  id="industry"
                  name="industry"
                  defaultValue={organisation.industry ?? ''}
                  maxLength={120}
                />
              </Field>

              <Field
                label="Contact email"
                htmlFor="contactEmail"
                hint="Blank keeps the address on file — the API cannot clear this field."
              >
                <Input
                  id="contactEmail"
                  name="contactEmail"
                  type="email"
                  defaultValue={organisation.contactEmail ?? ''}
                  maxLength={255}
                />
              </Field>

              <Field label="Contact phone" htmlFor="contactPhone">
                <Input
                  id="contactPhone"
                  name="contactPhone"
                  type="tel"
                  defaultValue={organisation.contactPhone ?? ''}
                  maxLength={32}
                />
              </Field>

              <Field label="Address line 1" htmlFor="addressLine1" style={{ gridColumn: '1 / -1' }}>
                <Input
                  id="addressLine1"
                  name="addressLine1"
                  defaultValue={organisation.addressLine1 ?? ''}
                  maxLength={255}
                />
              </Field>

              <Field label="Address line 2" htmlFor="addressLine2" style={{ gridColumn: '1 / -1' }}>
                <Input
                  id="addressLine2"
                  name="addressLine2"
                  defaultValue={organisation.addressLine2 ?? ''}
                  maxLength={255}
                />
              </Field>

              <Field label="City" htmlFor="city">
                <Input
                  id="city"
                  name="city"
                  defaultValue={organisation.city ?? ''}
                  maxLength={120}
                />
              </Field>

              <Field label="State" htmlFor="state">
                <Input
                  id="state"
                  name="state"
                  defaultValue={organisation.state ?? ''}
                  maxLength={120}
                />
              </Field>

              <Field label="Postal code" htmlFor="postalCode">
                <Input
                  id="postalCode"
                  name="postalCode"
                  defaultValue={organisation.postalCode ?? ''}
                  maxLength={20}
                />
              </Field>

              <Field
                label="Country"
                htmlFor="countryCode"
                hint="Two-letter code, such as IN. Blank keeps the current code."
              >
                <Input
                  id="countryCode"
                  name="countryCode"
                  defaultValue={organisation.countryCode ?? ''}
                  minLength={2}
                  maxLength={2}
                  placeholder="IN"
                />
              </Field>

              <Field label="Tax id" htmlFor="taxId" hint="GSTIN or the local equivalent.">
                <Input
                  id="taxId"
                  name="taxId"
                  defaultValue={organisation.taxId ?? ''}
                  maxLength={40}
                />
              </Field>
            </div>

            <div>
              <Button type="submit" variant="primary">
                Save profile
              </Button>
            </div>
          </form>
        ) : (
          <ReadOnlyHint
            items={[
              { label: 'Name', value: organisation.name },
              { label: 'Slug', value: organisation.slug },
              { label: 'Website', value: organisation.website },
              { label: 'Industry', value: organisation.industry },
              { label: 'Contact email', value: organisation.contactEmail },
              { label: 'Contact phone', value: organisation.contactPhone },
              { label: 'Address line 1', value: organisation.addressLine1, wide: true },
              { label: 'Address line 2', value: organisation.addressLine2, wide: true },
              { label: 'City', value: organisation.city },
              { label: 'State', value: organisation.state },
              { label: 'Postal code', value: organisation.postalCode },
              { label: 'Country', value: organisation.countryCode },
              { label: 'Tax id', value: organisation.taxId },
            ]}
            permission="organisation.write"
          />
        )}
      </Panel>

      <Panel
        title="Internal notes"
        description="Visible to admin-side roles only. The customer never sees this."
      >
        {canWrite ? (
          <form
            action={saveOrganisationNotes}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
          >
            <input type="hidden" name="id" value={organisation.id} />
            <Field label="Notes" htmlFor="notes" hint="Up to 4,000 characters.">
              <Textarea
                id="notes"
                name="notes"
                defaultValue={organisation.notes ?? ''}
                rows={5}
                maxLength={4000}
                placeholder="Who introduced this account, what they test, and anything the next admin should know."
              />
            </Field>
            <div>
              <Button type="submit" variant="secondary">
                Save notes
              </Button>
            </div>
          </form>
        ) : (
          <ReadOnlyHint
            items={[{ label: 'Notes', value: organisation.notes, wide: true }]}
            permission="organisation.write"
          />
        )}
      </Panel>

      <Panel
        title="Members"
        description="Who can sign in for this organisation. An owner can edit the profile and submit projects; a member can only work inside them."
        flush
      >
        {organisation.members.length > 0 ? (
          <Table
            ariaLabel="Organisation members"
            columns={memberColumns}
            rows={organisation.members}
            rowKey={(member) => member.user.id}
            style={{ border: 'none', borderRadius: 0 }}
          />
        ) : (
          <p
            style={{
              margin: 0,
              padding: 'var(--space-6)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            No members yet. Add an owner so someone can sign in and submit projects for this
            account.
          </p>
        )}

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-5)',
            padding: 'var(--space-6)',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--surface-sunken)',
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 'var(--type-body-md-size)',
              fontWeight: 'var(--fw-semibold)',
              color: 'var(--text-primary)',
            }}
          >
            Add a member
          </h3>

          {accountsAvailable ? (
            <>
              <form
                method="get"
                action={detailHref}
                style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)' }}
              >
                <Field
                  label="Find an account"
                  htmlFor="q"
                  hint="The picker holds the first 100 customer and unassigned accounts. Search to reach the rest."
                  style={{ flex: 1 }}
                >
                  <Input
                    id="q"
                    name="q"
                    defaultValue={accountSearch ?? ''}
                    placeholder="Name or email"
                    iconLeft="search"
                  />
                </Field>
                <Button type="submit" variant="secondary">
                  Search accounts
                </Button>
              </form>

              <form
                action={addOrganisationMember}
                style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)' }}
              >
                <input type="hidden" name="id" value={organisation.id} />
                <Field label="Account" htmlFor="userId" style={{ flex: 1 }}>
                  <Select
                    id="userId"
                    name="userId"
                    required
                    placeholder={
                      candidates.length > 0
                        ? 'Choose an account'
                        : 'No matching account is free to join'
                    }
                    options={candidates.map((account) => ({
                      value: account.id,
                      label: accountLabel(account),
                    }))}
                  />
                </Field>
                <Field label="Org role" htmlFor="orgRole">
                  <Select
                    id="orgRole"
                    name="orgRole"
                    defaultValue="MEMBER"
                    options={MEMBER_ROLE_OPTIONS}
                    style={{ width: 150 }}
                  />
                </Field>
                <Button type="submit" variant="primary" iconLeft="plus">
                  Add member
                </Button>
              </form>
            </>
          ) : (
            <form
              action={addOrganisationMember}
              style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)' }}
            >
              <input type="hidden" name="id" value={organisation.id} />
              <Field
                label="Account id"
                htmlFor="userId"
                hint="Browsing accounts needs the user.read permission. Paste the account id instead."
                style={{ flex: 1 }}
              >
                <Input id="userId" name="userId" required placeholder="Account id" />
              </Field>
              <Field label="Org role" htmlFor="orgRole">
                <Select
                  id="orgRole"
                  name="orgRole"
                  defaultValue="MEMBER"
                  options={MEMBER_ROLE_OPTIONS}
                  style={{ width: 150 }}
                />
              </Field>
              <Button type="submit" variant="primary" iconLeft="plus">
                Add member
              </Button>
            </form>
          )}
        </div>
      </Panel>

      <Panel
        title="Danger zone"
        description="Archiving keeps the record. It sets the status to archived, hides the account from the lists, and the API refuses while projects are still in flight."
      >
        {canArchive ? (
          <form
            action={archiveOrganisation}
            style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)' }}
          >
            <input type="hidden" name="id" value={organisation.id} />
            <Field
              label="Type ARCHIVE to confirm"
              htmlFor="confirm"
              hint="Nothing is deleted. An admin can restore the record through the API."
              style={{ flex: 1 }}
            >
              <Input id="confirm" name="confirm" required placeholder="ARCHIVE" />
            </Field>
            <Button
              type="submit"
              variant="secondary"
              iconLeft="shield-alert"
              style={{ color: 'var(--status-error-fg)' }}
            >
              Archive this organisation
            </Button>
          </form>
        ) : (
          <p
            style={{
              margin: 0,
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            Archiving needs the organisation.delete permission. Ask an administrator to grant it.
          </p>
        )}
      </Panel>
    </DetailShell>
  )
}

/**
 * The read-only half of a panel, for a reader without the write grant.
 *
 * Same values, same order, no controls — and one line naming the permission
 * that would turn them back into a form. Hiding the panel entirely would leave
 * a reader wondering whether the organisation has no profile at all.
 */
function ReadOnlyHint({
  items,
  permission,
}: {
  items: readonly { label: string; value: React.ReactNode; wide?: boolean }[]
  permission: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <DescriptionList items={items} />
      <p
        style={{
          margin: 0,
          color: 'var(--text-muted)',
          fontSize: 'var(--type-body-sm-size)',
        }}
      >
        Editing needs the {permission} permission. Ask an administrator to grant it.
      </p>
    </div>
  )
}

export function generateMetadata() {
  return { title: 'Organisation' }
}
