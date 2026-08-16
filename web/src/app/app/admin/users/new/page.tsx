import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Button } from '@/components/ds/core/Button'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { hasPermission, requirePermission } from '@/lib/auth/session'
import { formString, formTrimmed } from '@/lib/form-data'
import { titleCase } from '@/lib/admin/format'

/**
 * `/app/admin/users/new` — the admin-created account, including the Sub-Admin
 * that §2.2 names explicitly.
 *
 * Self-registration covers customers and testers who arrive on their own. This
 * page covers the accounts that cannot arrive on their own: internal staff, a
 * customer contact being onboarded by hand, and above all a sub-admin, which has
 * no sign-up path at all by design.
 *
 * The permission checkboxes are always rendered rather than revealed when the
 * role select changes, because revealing them would need client state for a
 * form that otherwise needs none. The API ignores `permissionCodes` for every
 * role except SUB_ADMIN, so an unread section is harmless — and the panel says
 * as much instead of leaving the reader to guess.
 */

const BASE = '/app/admin/users'
const MIN_PASSWORD_LENGTH = 12

const ROLES = ['USER', 'CUSTOMER', 'TESTER', 'ADMIN', 'SUB_ADMIN'] as const
const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: titleCase(role) }))

type RoleValue = (typeof ROLES)[number]

interface PermissionEntry {
  /** Absent when the API falls back to its in-code catalogue. */
  id?: string
  code: string
  group: string
  label: string
  description?: string
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

function isRole(value: string): value is RoleValue {
  return (ROLES as readonly string[]).includes(value)
}

function groupCatalogue(catalogue: readonly PermissionEntry[]) {
  const groups: { group: string; items: PermissionEntry[] }[] = []
  for (const entry of catalogue) {
    const bucket = groups.find((candidate) => candidate.group === entry.group)
    if (bucket) bucket.items.push(entry)
    else groups.push({ group: entry.group, items: [entry] })
  }
  return groups
}

/**
 * POSTs the account and returns its id.
 *
 * A duplicate email (409) and a schema rejection (422) are ordinary outcomes of
 * a human filling in a form, so they come back to this page as a query flag and
 * render inline. Everything else is a genuine fault and propagates to the error
 * boundary. Nothing is created in either case.
 */
async function postUser(body: Record<string, unknown>): Promise<string> {
  try {
    const created = await serverFetch<{ id: string }>('users', { method: 'POST', body })
    return created.id
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) redirect(`${BASE}/new?error=email-taken`)
    if (err instanceof ApiError && err.status === 422) redirect(`${BASE}/new?error=rejected`)
    throw err
  }
}

async function createAccount(formData: FormData): Promise<void> {
  'use server'
  await requirePermission('user.write')

  const role = formTrimmed(formData, 'role')
  if (!isRole(role)) throw new Error(`Unknown role: ${role}`)

  const email = formTrimmed(formData, 'email')
  const password = formString(formData, 'password')
  const firstName = formTrimmed(formData, 'firstName')
  const lastName = formTrimmed(formData, 'lastName')
  const phone = formTrimmed(formData, 'phone')
  const countryCode = formTrimmed(formData, 'countryCode').toUpperCase()

  const permissionCodes = [
    ...new Set(
      formData
        .getAll('permissionCodes')
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ]

  const id = await postUser({
    email,
    password,
    role,
    firstName,
    ...(lastName ? { lastName } : {}),
    ...(phone ? { phone } : {}),
    ...(countryCode.length === 2 ? { countryCode } : {}),
    // Meaningful only for a sub-admin; sending them for any other role would be
    // noise in the audit entry.
    ...(role === 'SUB_ADMIN' && permissionCodes.length > 0 ? { permissionCodes } : {}),
    activateImmediately: formString(formData, 'activateImmediately') !== '',
  })

  revalidatePath(BASE)
  redirect(`${BASE}/${id}`)
}

export default async function NewUserPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const viewer = await requirePermission('user.write', `${BASE}/new`)
  const { error } = await searchParams

  const emailError =
    error === 'email-taken' ? 'An account with this email already exists.' : undefined
  const rejected = error === 'rejected'

  let catalogue: PermissionEntry[] = []
  let catalogueError: 'forbidden' | 'unknown' | null = null

  if (hasPermission(viewer, 'subadmin.manage')) {
    try {
      catalogue = await serverFetch<PermissionEntry[]>('users/permissions/catalogue')
    } catch (err) {
      catalogueError = err instanceof ApiError && err.status === 403 ? 'forbidden' : 'unknown'
    }
  } else {
    catalogueError = 'forbidden'
  }

  const permissionGroups = groupCatalogue(catalogue)

  return (
    <DetailShell
      crumbs={[{ label: 'Users', href: BASE }, { label: 'New account' }]}
      eyebrow="Accounts"
      title="Create an account"
      subtitle="For people who cannot sign themselves up: internal staff, a customer contact you are onboarding, and every sub-admin."
      aside={
        <Panel title="What this does">
          <ul
            style={{
              margin: 0,
              paddingLeft: 'var(--space-6)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
              lineHeight: 1.55,
            }}
          >
            <li>
              The password is hashed by the API and never shown again. Send it over a channel you
              trust and ask the account holder to change it on first sign-in.
            </li>
            <li>
              Activating now marks the email address verified and skips the verification email.
              Leave it unticked and the account waits at pending verification.
            </li>
            <li>
              The tester role also creates the tester profile that the tester pool page reads, at
              status applied.
            </li>
            <li>
              The sub-admin role with nothing ticked below grants the default read-only set, which
              you can change on the account afterwards.
            </li>
          </ul>
        </Panel>
      }
    >
      <TrackedForm action={createAccount} style={formStyle}>
        {rejected ? (
          <div
            role="alert"
            style={{
              padding: 'var(--space-5)',
              borderRadius: 'var(--radius-card)',
              background: 'var(--status-error-bg)',
              color: 'var(--status-error-fg)',
              fontSize: 'var(--type-body-sm-size)',
              lineHeight: 1.55,
            }}
          >
            The API rejected those details, so no account was created. Check the email address, the
            password length and the country code, then enter the details again.
          </div>
        ) : null}

        <Panel
          title="Sign-in"
          description="How the account holder gets in, and what they can reach once they are in."
        >
          <div style={fieldGridStyle}>
            <Field label="Email" htmlFor="email" required error={emailError}>
              <Input
                id="email"
                name="email"
                type="email"
                iconLeft="mail"
                maxLength={255}
                required
                invalid={emailError !== undefined}
                autoComplete="off"
                placeholder="name@company.com"
              />
            </Field>
            <Field
              label="Password"
              htmlFor="password"
              required
              hint={`At least ${MIN_PASSWORD_LENGTH} characters. The account holder should change it after signing in.`}
            >
              <Input
                id="password"
                name="password"
                type="password"
                minLength={MIN_PASSWORD_LENGTH}
                maxLength={200}
                required
                autoComplete="new-password"
              />
            </Field>
            <Field
              label="Role"
              htmlFor="role"
              required
              hint="Choose sub-admin to create a back-office account with delegated permissions."
            >
              <Select
                id="role"
                name="role"
                options={ROLE_OPTIONS}
                placeholder="Choose a role"
                defaultValue=""
                required
              />
            </Field>
          </div>

          <div style={{ marginTop: 'var(--space-6)' }}>
            <Checkbox
              id="activateImmediately"
              name="activateImmediately"
              value="yes"
              defaultChecked
              label="Activate the account immediately"
              description="Skips the verification email and lets the account holder sign in straight away."
            />
          </div>
        </Panel>

        <Panel
          title="Profile"
          description="Only the first name is required. The rest can be filled in on the account later."
        >
          <div style={fieldGridStyle}>
            <Field label="First name" htmlFor="firstName" required>
              <Input id="firstName" name="firstName" maxLength={80} required autoComplete="off" />
            </Field>
            <Field label="Last name" htmlFor="lastName">
              <Input id="lastName" name="lastName" maxLength={80} autoComplete="off" />
            </Field>
            <Field label="Phone" htmlFor="phone" hint="Include the country dialling code.">
              <Input id="phone" name="phone" type="tel" maxLength={32} autoComplete="off" />
            </Field>
            <Field
              label="Country"
              htmlFor="countryCode"
              hint="Two-letter code, for example IN."
            >
              <Input
                id="countryCode"
                name="countryCode"
                minLength={2}
                maxLength={2}
                autoComplete="off"
              />
            </Field>
          </div>
        </Panel>

        <Panel
          title="Sub-admin permissions"
          description="Applied only when the role above is sub-admin. Leave every box unticked and the API grants its default read-only set instead."
        >
          {catalogueError !== null ? (
            <EmptyState
              icon={catalogueError === 'forbidden' ? 'lock' : 'alert-triangle'}
              title={
                catalogueError === 'forbidden'
                  ? 'You can still create a sub-admin'
                  : "Couldn't load the permission catalogue"
              }
              description={
                catalogueError === 'forbidden'
                  ? 'It will start with the default read-only set. Choosing the grants yourself needs the subadmin.manage permission.'
                  : 'The users service is unreachable. A sub-admin created now starts with the default read-only set.'
              }
            />
          ) : permissionGroups.length === 0 ? (
            <p style={noteStyle}>
              The permission catalogue came back empty, so there is nothing to tick. Seed the
              permissions table on the API and reload.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-7)' }}>
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
                        label={permission.label}
                        description={permission.description}
                      />
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          )}
        </Panel>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <Button type="submit" variant="primary">
            Create the account
          </Button>
          <Button href={BASE} variant="secondary" iconLeft="arrow-left">
            Back to users
          </Button>
        </div>
      </TrackedForm>
    </DetailShell>
  )
}
