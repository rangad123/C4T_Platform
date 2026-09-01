import { DetailShell } from '@/components/admin/DetailShell'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Modal } from '@/components/admin/Modal'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { PhoneInput, PHONE_HINT } from '@/components/ds/forms/PhoneInput'
import { Select } from '@/components/ds/forms/Select'
import { serverFetchOrNull } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { CountryLabel } from '@/components/admin/CountryFlag'
import { formatDate, personName, titleCase } from '@/lib/admin/format'
import { Textarea } from '@/components/ds/forms/Textarea'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import {
  addOrgMemberAction,
  removeOrgMemberAction,
  updateOrgMemberAction,
  updateOrgProfileAction,
  inviteTeamMemberAction,
  revokeInvitationAction,
} from './actions'

const ROOT = { label: 'Customer', href: '/app/customer' }
const DETAIL_PATH = '/app/customer/organisation'
const MEMBER_ROLE_OPTIONS = ['OWNER', 'MEMBER'].map((value) => ({ value, label: titleCase(value) }))

const SECTIONS = [
  { value: 'profile', label: 'Profile', icon: 'building-2' },
  { value: 'members', label: 'Members', icon: 'users' },
] as const

interface MyOrganisation {
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
  orgRole: string
}

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
  members: OrganisationMember[]
  _count: { projects: number; transactions: number }
}

const NOTICES: Record<string, NoticeCopy> = {
  'profile-saved': { tone: 'success', message: 'Profile saved.' },
  'member-added': { tone: 'success', message: 'Member added.' },
  'member-role-saved': { tone: 'success', message: 'Member role updated.' },
  'member-removed': { tone: 'success', message: 'Member removed.' },
  'member-missing-account': {
    tone: 'warning',
    message: 'Enter an account id before adding a member.',
  },
  'member-exists': { tone: 'warning', message: 'That account is already a member here.' },
  'member-invalid': {
    tone: 'error',
    message: 'That account cannot join — check the id, or ask them to sign up first.',
  },
  'last-owner': {
    tone: 'warning',
    message: 'Your organisation needs at least one owner. Promote another member first.',
  },
  invalid: {
    tone: 'error',
    message: 'Those values were not accepted. Check the highlighted fields.',
  },
  'forbidden-write': { tone: 'error', message: 'Only an owner can make that change.' },
  missing: { tone: 'error', message: 'That record is no longer there. Reload the page.' },
  failed: { tone: 'error', message: 'That did not save. Try again in a moment.' },
  'invite-sent': {
    tone: 'success',
    message: 'The invitation is on its way. It expires in 14 days if it is not used.',
  },
  'invite-revoked': { tone: 'success', message: 'That invitation has been withdrawn.' },
  'invite-email': { tone: 'warning', message: 'Enter a valid email address to invite someone.' },
  'invite-exists': { tone: 'warning', message: 'That person is already on your team.' },
  'invite-forbidden': { tone: 'error', message: 'Only an owner can invite people.' },
  'invite-failed': {
    tone: 'error',
    message: 'That invitation could not be sent. Try again in a moment.',
  },
}

/** A row of `GET /v1/organisations/:id/invitations`. */
interface InvitationRow {
  id: string
  email: string
  orgRole: string
  message: string | null
  expiresAt: string
  createdAt: string
  state: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED'
  invitedBy: { id: string; firstName: string | null; lastName: string | null } | null
}

/** Tone per invitation state, so the table reads at a glance. */
const INVITATION_TONE: Record<InvitationRow['state'], 'success' | 'warning' | 'neutral'> = {
  ACCEPTED: 'success',
  PENDING: 'warning',
  EXPIRED: 'neutral',
  REVOKED: 'neutral',
}

/**
 * `/app/customer/organisation` — the customer's own organisation.
 *
 * `GET /organisations/mine` returns each org the caller belongs to with
 * their own `orgRole` attached, so gating the edit forms on `orgRole ===
 * 'OWNER'` needs no second lookup. Seed data guarantees exactly one org for
 * the demo account; a real customer could in principle belong to more than
 * one, but nothing in this platform currently creates that — so the first
 * membership is treated as the org.
 *
 * The "add a member" form always uses the plain account-id field, never a
 * searchable picker: `GET /users` (what admin's picker searches) is an
 * admin-permission-gated, platform-wide user directory, and would let one
 * customer search other users' names and emails. This mirrors the fallback
 * admin's own page already renders when that search is unavailable — no new
 * UI, just always taking that branch here.
 */
export default async function CustomerOrganisationPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; section?: string; edit?: string }>
}) {
  await requireRole(['CUSTOMER'])
  const { notice, section: rawSection, edit } = await searchParams
  const section = resolveSection(SECTIONS, rawSection)

  const mine = await serverFetchOrNull<readonly MyOrganisation[]>('organisations/mine')
  const organisation = mine?.[0]

  if (!organisation) {
    return (
      <>
        <DetailShell
          root={ROOT}
          crumbs={[{ label: 'Organisation' }]}
          eyebrow="Account"
          title="Organisation"
        >
          <p style={{ color: 'var(--text-secondary)' }}>
            You are not attached to an organisation yet. Contact support if this looks wrong.
          </p>
        </DetailShell>
      </>
    )
  }

  const isOwner = organisation.orgRole === 'OWNER'
  const closedHref =
    section === SECTIONS[0].value ? DETAIL_PATH : `${DETAIL_PATH}?section=${section}`
  const profileModalOpen = edit === 'profile'

  const [detail, invitations] = await Promise.all([
    serverFetchOrNull<OrganisationDetail>(`organisations/${organisation.id}`),
    // Only an owner can act on these, but everyone on the team can see who is
    // pending — it stops two owners inviting the same person twice.
    section === 'members'
      ? serverFetchOrNull<readonly InvitationRow[]>(`organisations/${organisation.id}/invitations`)
      : Promise.resolve(null),
  ])
  const members = detail?.members ?? []
  const owners = members.filter((m) => m.orgRole === 'OWNER')

  const profileItems = [
    { label: 'Name', value: organisation.name },
    { label: 'Website', value: organisation.website },
    { label: 'Industry', value: organisation.industry },
    { label: 'Contact email', value: organisation.contactEmail },
    { label: 'Contact phone', value: organisation.contactPhone },
    { label: 'Address line 1', value: organisation.addressLine1, wide: true },
    { label: 'Address line 2', value: organisation.addressLine2, wide: true },
    { label: 'City', value: organisation.city },
    { label: 'State', value: organisation.state },
    { label: 'Postal code', value: organisation.postalCode },
    {
      label: 'Country',
      value: organisation.countryCode ? (
        <CountryLabel countryCode={organisation.countryCode} />
      ) : null,
    },
    { label: 'Tax id', value: organisation.taxId },
  ]

  const invitationColumns: readonly TableColumn<InvitationRow>[] = [
    {
      key: 'email',
      header: 'Invited',
      render: (row) => row.email,
      renderSecondary: (row) =>
        row.invitedBy
          ? `by ${personName(row.invitedBy)} on ${formatDate(row.createdAt)}`
          : formatDate(row.createdAt),
    },
    { key: 'role', header: 'Org role', render: (row) => titleCase(row.orgRole) },
    {
      key: 'state',
      header: 'Status',
      render: (row) => (
        <Badge tone={INVITATION_TONE[row.state]} uppercase={false}>
          {titleCase(row.state)}
        </Badge>
      ),
      /* An expiry only means something while the invitation could still be
         used, so it is shown for pending rows and nothing else. */
      renderSecondary: (row) =>
        row.state === 'PENDING' ? `Expires ${formatDate(row.expiresAt)}` : undefined,
    },
    {
      key: 'action',
      header: 'Action',
      align: 'right',
      render: (row) =>
        isOwner && row.state === 'PENDING' ? (
          <form action={revokeInvitationAction}>
            <input type="hidden" name="id" value={organisation.id} />
            <input type="hidden" name="invitationId" value={row.id} />
            <ConfirmSubmit
              iconLeft=""
              question={`Withdraw the invitation to ${row.email}?`}
              confirmLabel="Yes, withdraw"
              pendingLabel="Withdrawing…"
            >
              Withdraw
            </ConfirmSubmit>
          </form>
        ) : (
          '—'
        ),
    },
  ]

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
    { key: 'joined', header: 'Joined', render: (member) => formatDate(member.joinedAt) },
    {
      key: 'manage',
      header: 'Org role',
      render: (member) =>
        isOwner ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            {titleCase(member.orgRole)}
            <Button
              href={`${DETAIL_PATH}?section=members&edit=member:${member.user.id}`}
              variant="primary"
              size="sm"
              iconLeft="pencil"
            >
              Edit role
            </Button>
            <form action={removeOrgMemberAction}>
              <input type="hidden" name="id" value={organisation.id} />
              <input type="hidden" name="userId" value={member.user.id} />
              <ConfirmSubmit
                iconLeft=""
                size="md"
                question={`Remove ${personName(member.user)} from ${organisation.name}?`}
              >
                Remove
              </ConfirmSubmit>
            </form>
          </span>
        ) : (
          titleCase(member.orgRole)
        ),
    },
  ]

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Organisation' }]}
      eyebrow="Account"
      title={organisation.name}
      badges={<StatusBadge status={organisation.status} />}
      subtitle={organisation.slug}
      tabs={<SectionTabs basePath={DETAIL_PATH} tabs={SECTIONS} active={section} />}
    >
      <Notice code={notice} notices={NOTICES} />

      {section === 'profile' ? (
        <>
          <Panel
            title="Profile"
            description="The billing and contact details we hold for your organisation."
            actions={
              isOwner ? (
                <Button
                  href={`${DETAIL_PATH}?section=profile&edit=profile`}
                  variant="primary"
                  size="sm"
                >
                  Edit
                </Button>
              ) : undefined
            }
          >
            <DescriptionList items={profileItems} />
          </Panel>
          <Panel title="Record" description="What the platform knows about your account.">
            <DescriptionList
              items={[
                { label: 'Members', value: members.length },
                { label: 'Owners', value: owners.length },
                { label: 'Projects', value: detail?._count.projects ?? '—' },
              ]}
            />
          </Panel>
        </>
      ) : null}

      {section === 'profile' && isOwner ? (
        <Modal open={profileModalOpen} closedHref={closedHref} title="Edit profile">
          <form
            action={updateOrgProfileAction}
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
                hint="Cannot be cleared once set."
              >
                <Input
                  id="contactEmail"
                  name="contactEmail"
                  type="email"
                  defaultValue={organisation.contactEmail ?? ''}
                  maxLength={255}
                />
              </Field>
              <Field label="Contact phone" htmlFor="contactPhone" hint={PHONE_HINT}>
                <PhoneInput
                  id="contactPhone"
                  name="contactPhone"
                  defaultValue={organisation.contactPhone ?? ''}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Country"
                htmlFor="countryCode"
                hint="Two-letter code. Cannot be cleared once set."
              >
                <Input
                  id="countryCode"
                  name="countryCode"
                  defaultValue={organisation.countryCode ?? ''}
                  maxLength={2}
                  style={{ textTransform: 'uppercase' }}
                />
              </Field>
              <Field label="Address line 1" htmlFor="addressLine1">
                <Input
                  id="addressLine1"
                  name="addressLine1"
                  defaultValue={organisation.addressLine1 ?? ''}
                  maxLength={255}
                />
              </Field>
              <Field label="Address line 2" htmlFor="addressLine2">
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
              <Field label="Tax id" htmlFor="taxId">
                <Input
                  id="taxId"
                  name="taxId"
                  defaultValue={organisation.taxId ?? ''}
                  maxLength={40}
                />
              </Field>
            </div>
            <div>
              <SubmitButton variant="primary" pendingLabel="Saving…">
                Save profile
              </SubmitButton>
            </div>
          </form>
        </Modal>
      ) : null}

      {section === 'members' ? (
        <>
          <Panel
            title="Members"
            description="Who can sign in for your organisation. An owner can edit the profile and submit projects; a member can only work inside them."
            flush
            actions={
              isOwner ? (
                <Button
                  href={`${DETAIL_PATH}?section=members&edit=add-member`}
                  variant="primary"
                  size="sm"
                  iconLeft="user-plus"
                >
                  Add member
                </Button>
              ) : undefined
            }
          >
            {members.length > 0 ? (
              <Table
                ariaLabel="Organisation members"
                columns={memberColumns}
                rows={members}
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
                No members yet.
              </p>
            )}
          </Panel>

          {isOwner ? (
            <Modal
              open={edit === 'add-member'}
              closedHref={`${DETAIL_PATH}?section=members`}
              title="Add member"
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
                {/*
                §42 — invite by EMAIL, which is what the reference does and
                what actually works for someone with no account yet. The
                account-id form below it stays for adding a colleague who has
                already signed up, where an email round trip is needless.
              */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 'var(--type-body-md-size)',
                      fontWeight: 'var(--fw-semibold)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    Invite a new team member
                  </h3>
                  <form
                    action={inviteTeamMemberAction}
                    style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
                  >
                    <input type="hidden" name="id" value={organisation.id} />
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-end',
                        gap: 'var(--space-4)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <Field
                        label="Email address"
                        htmlFor="inviteEmail"
                        hint="They do not need an account yet — the invitation walks them through it."
                        style={{ flex: '2 1 240px' }}
                      >
                        <Input
                          id="inviteEmail"
                          name="email"
                          type="email"
                          required
                          placeholder="colleague@example.com"
                        />
                      </Field>
                      <Field label="Org role" htmlFor="inviteRole">
                        <Select
                          id="inviteRole"
                          name="orgRole"
                          defaultValue="MEMBER"
                          options={MEMBER_ROLE_OPTIONS}
                          style={{ width: 150 }}
                        />
                      </Field>
                    </div>
                    <Field
                      label="Invitation message"
                      htmlFor="inviteMessage"
                      hint="Optional. Included in the email so they know why they are being added."
                    >
                      <Textarea id="inviteMessage" name="message" rows={3} maxLength={1000} />
                    </Field>
                    <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
                      <SubmitButton
                        variant="primary"
                        iconLeft="plus"
                        pendingLabel="Sending the invitation…"
                      >
                        Send invitation
                      </SubmitButton>
                      <Button href={`${DETAIL_PATH}?section=members`} variant="ghost">
                        Cancel
                      </Button>
                    </div>
                  </form>
                </div>

                <details>
                  <summary
                    style={{
                      cursor: 'pointer',
                      fontSize: 'var(--type-body-sm-size)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Add someone who already has an account
                  </summary>
                  <form
                    action={addOrgMemberAction}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-end',
                      gap: 'var(--space-4)',
                      marginTop: 'var(--space-4)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <input type="hidden" name="id" value={organisation.id} />
                    <Field
                      label="Account id"
                      htmlFor="userId"
                      hint="Adds them straight away, with no email."
                      style={{ flex: '1 1 240px' }}
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
                    <SubmitButton variant="secondary" pendingLabel="Adding…">
                      Add member
                    </SubmitButton>
                  </form>
                </details>
              </div>
            </Modal>
          ) : null}

          {/* One dialog per member, opened by `?edit=member:<userId>`. */}
          {isOwner
            ? members.map((member) => (
                <Modal
                  key={`edit-role-${member.user.id}`}
                  open={edit === `member:${member.user.id}`}
                  closedHref={`${DETAIL_PATH}?section=members`}
                  title={`Edit role — ${personName(member.user)}`}
                >
                  <form
                    action={updateOrgMemberAction}
                    style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
                  >
                    <input type="hidden" name="id" value={organisation.id} />
                    <input type="hidden" name="userId" value={member.user.id} />
                    <Field label="Organisation role" htmlFor={`role-${member.user.id}`}>
                      <Select
                        id={`role-${member.user.id}`}
                        name="orgRole"
                        defaultValue={member.orgRole}
                        options={MEMBER_ROLE_OPTIONS}
                      />
                    </Field>
                    <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
                      <SubmitButton variant="primary" pendingLabel="Saving…">
                        Save changes
                      </SubmitButton>
                      <Button href={`${DETAIL_PATH}?section=members`} variant="ghost">
                        Cancel
                      </Button>
                    </div>
                  </form>
                </Modal>
              ))
            : null}
        </>
      ) : null}

      {/* ── Pending and past invitations (§41) ──────────────────────────── */}
      {section === 'members' ? (
        <Panel
          title="Invitations"
          description="People invited by email who have not joined yet, and the ones who have."
          flush
        >
          {invitations === null ? (
            <p style={{ margin: 0, padding: 'var(--space-6)', color: 'var(--text-secondary)' }}>
              Invitations could not be loaded. Refresh in a moment.
            </p>
          ) : invitations.length === 0 ? (
            <div style={{ padding: 'var(--space-6)' }}>
              <EmptyState
                icon="message-square"
                title="No invitations yet"
                description="Invite a colleague by email above and it appears here until they join."
              />
            </div>
          ) : (
            <Table
              ariaLabel="Team invitations"
              columns={invitationColumns}
              rows={[...invitations]}
              rowKey={(row) => row.id}
              style={{ border: 'none', borderRadius: 0 }}
            />
          )}
        </Panel>
      ) : null}
    </DetailShell>
  )
}
