import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { RoleBadge, StatusBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requireRole } from '@/lib/auth/session'
import { serverFetch } from '@/lib/api/server'
import { ApiError, type ActiveSession } from '@/lib/api/types'
import { personName } from '@/lib/admin/format'
import { saveProfile, changePassword, revokeSession, signOutEverywhere } from './actions'

export const metadata: Metadata = {
  title: 'Your profile',
  robots: { index: false, follow: false },
}

/**
 * The admin's own account — `/app/admin/profile`.
 *
 * Agreement §2.2, "Profile Management": the one page in the panel whose subject
 * is the person reading it. Four concerns, four panels, four independent
 * submits — a failed password change must never discard a name edit.
 *
 * WHAT IS DELIBERATELY READ-ONLY HERE. Role and status are shown but not
 * editable. `PATCH users/me` does not accept them (the API's own
 * `updateOwnProfileSchema` omits both), and that is the right shape: an admin
 * demoting or suspending themselves is a lockout, and the API guards the "last
 * active admin" case on `users/:id` precisely because it expects the change to
 * arrive from a user record, not from a self-edit.
 *
 * FEEDBACK. The actions redirect back here with `?ok=` or `?error=` and the
 * banner below turns the code into a sentence. That is the whole feedback
 * channel, so every form on the page stays a Server Component.
 */

const PROFILE_PATH = '/app/admin/profile'

/** Shape of `GET users/me` — the `userSelect` in the API's users.service. */
interface OwnProfile {
  id: string
  email: string
  role: string
  status: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  countryCode: string | null
  timezone: string | null
  emailVerifiedAt: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

interface Notice {
  tone: 'success' | 'error'
  text: string
}

/**
 * Every code the actions can send back, as a sentence.
 *
 * Kept in the page rather than beside the actions because a `'use server'`
 * module may export nothing but async functions — a map exported from there
 * would unregister all four actions.
 */
const NOTICES: Record<string, Notice> = {
  // Successes
  profile: { tone: 'success', text: 'Your profile has been updated.' },
  password: {
    tone: 'success',
    text: 'Your password has been changed. Every other device has been signed out.',
  },
  session_revoked: { tone: 'success', text: 'That session has been signed out.' },

  // Profile failures
  name_required: { tone: 'error', text: 'Enter a first name — it cannot be blank.' },
  country_code: {
    tone: 'error',
    text: 'Give the country as a two-letter code, for example IN or US.',
  },
  profile_invalid: {
    tone: 'error',
    text: 'The API rejected those details. Check the lengths: 80 characters for each name, 32 for the phone number.',
  },
  profile_forbidden: {
    tone: 'error',
    text: 'Your account is not allowed to edit its own profile. Ask another administrator to make the change.',
  },
  profile_failed: {
    tone: 'error',
    text: 'We could not save your profile. Try again in a moment.',
  },

  // Password failures
  password_missing: {
    tone: 'error',
    text: 'Fill in your current password and the new one.',
  },
  password_mismatch: {
    tone: 'error',
    text: 'The two new passwords do not match. Retype them and submit again.',
  },
  password_short: {
    tone: 'error',
    text: 'Your new password must be at least 12 characters.',
  },
  password_reused: {
    tone: 'error',
    text: 'The new password is the same as your current one. Choose a different one.',
  },
  password_wrong: { tone: 'error', text: 'That is not your current password.' },
  password_weak: {
    tone: 'error',
    text: 'The API rejected that password. It must be 12 to 200 characters and not a commonly used string.',
  },
  password_google: {
    tone: 'error',
    text: 'This account signs in with Google and has no password to replace. Use the reset link on the sign-in page to set one.',
  },
  password_failed: {
    tone: 'error',
    text: 'We could not change your password. Try again in a moment.',
  },

  // Session failures
  session_missing: { tone: 'error', text: 'That session has already ended.' },
  session_forbidden: { tone: 'error', text: 'You can only end your own sessions.' },
  session_failed: {
    tone: 'error',
    text: 'We could not end that session. Try again in a moment.',
  },
}

/** `2026-08-14T12:09:18.713Z` → `14 Aug 2026, 12:09`. */
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * A readable device name from a user-agent string.
 *
 * Order is load-bearing: Edge and Opera both claim to be Chrome, and Chrome
 * claims to be Safari, so the narrower tokens have to be tested first. Nothing
 * here is a security decision — it is a label, and the raw string stays on the
 * row underneath it so an admin can always read what the server actually saw.
 */
function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'

  const browser = userAgent.includes('Edg/')
    ? 'Edge'
    : /OPR\/|Opera/.test(userAgent)
      ? 'Opera'
      : userAgent.includes('Chrome/')
        ? 'Chrome'
        : userAgent.includes('Firefox/')
          ? 'Firefox'
          : userAgent.includes('Safari/')
            ? 'Safari'
            : null

  const platform = userAgent.includes('Windows NT')
    ? 'Windows'
    : userAgent.includes('Android')
      ? 'Android'
      : /iPhone|iPad|iPod/.test(userAgent)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : userAgent.includes('Linux')
            ? 'Linux'
            : null

  if (browser && platform) return `${browser} on ${platform}`
  return browser ?? platform ?? 'Unknown device'
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

const SESSION_COLUMNS: readonly TableColumn<ActiveSession>[] = [
  {
    key: 'device',
    header: 'Device',
    render: (session) => (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        {deviceLabel(session.userAgent)}
        {session.isCurrent ? (
          <Badge tone="accent" uppercase={false}>
            This device
          </Badge>
        ) : null}
      </span>
    ),
    renderSecondary: (session) =>
      session.userAgent ? truncate(session.userAgent, 78) : 'No user-agent was sent',
  },
  {
    key: 'ip',
    header: 'IP address',
    render: (session) =>
      session.ipAddress ? (
        <span style={{ fontFamily: 'var(--font-mono)' }}>{session.ipAddress}</span>
      ) : (
        <span style={{ color: 'var(--text-muted)' }}>—</span>
      ),
  },
  {
    key: 'created',
    header: 'Signed in',
    render: (session) => formatDateTime(session.createdAt),
  },
  {
    key: 'lastUsed',
    header: 'Last used',
    render: (session) => formatDateTime(session.lastUsedAt),
    renderSecondary: (session) => `Expires ${formatDateTime(session.absoluteExpiresAt)}`,
  },
  {
    key: 'revoke',
    header: <span className="c4t-visually-hidden">End session</span>,
    align: 'right',
    render: (session) => (
      /**
       * One form per row rather than one form with a per-row submit value: the
       * `Button` primitive takes no `name`, `value` or `form` prop, and
       * restating the control geometry on a bare `<button>` would duplicate the
       * size scale that the design system owns.
       */
      <form action={revokeSession} style={{ display: 'inline-flex' }}>
        <input type="hidden" name="sessionId" value={session.id} />
        <Button type="submit" variant="secondary" size="sm">
          {session.isCurrent ? 'Sign out here' : 'End session'}
        </Button>
      </form>
    ),
  },
]

/**
 * IANA zone names straight from the platform's own ICU data, so the list cannot
 * drift from what `Intl` will accept. Computed once per module load, not per
 * request.
 */
const TIMEZONES: readonly string[] = Intl.supportedValuesOf('timeZone')

/**
 * Contact details, credentials and live sessions are three different jobs,
 * and the last two are what someone reaches for when something is wrong.
 * Tabs put both one click away instead of below a form nobody is editing.
 */
const SECTIONS = [
  { value: 'profile', label: 'Profile', icon: 'user-check' },
  { value: 'password', label: 'Password', icon: 'lock' },
  { value: 'sessions', label: 'Active sessions', icon: 'monitor' },
] as const

export default async function AdminProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; section?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'], PROFILE_PATH)

  const params = await searchParams
  const section = resolveSection(SECTIONS, params.section)
  const notice = NOTICES[params.error ?? ''] ?? NOTICES[params.ok ?? ''] ?? null

  let profile: OwnProfile | null = null
  let profileError: 'forbidden' | 'unknown' | null = null

  try {
    profile = await serverFetch<OwnProfile>('users/me')
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    else if (error instanceof ApiError && error.status === 403) profileError = 'forbidden'
    else profileError = 'unknown'
  }

  if (!profile) {
    return (
      <DetailShell crumbs={[{ label: 'Your profile' }]} eyebrow="Account" title="Your profile">
        <EmptyState
          icon={profileError === 'forbidden' ? 'lock' : 'alert-triangle'}
          title={
            profileError === 'forbidden'
              ? 'Your account cannot read its own profile'
              : "We couldn't load your profile"
          }
          description={
            profileError === 'forbidden'
              ? 'The API refused the request. Ask another administrator to check your account.'
              : 'The accounts service is unreachable. Refresh in a moment.'
          }
        />
      </DetailShell>
    )
  }

  // Sessions are a second read: a failure there must not blank the profile.
  let sessions: readonly ActiveSession[] = []
  let sessionsFailed = false
  try {
    sessions = await serverFetch<ActiveSession[]>('auth/sessions')
  } catch {
    sessionsFailed = true
  }

  const displayName = personName(profile)
  // Every zone the account might already hold, even one ICU no longer lists.
  const zoneOptions =
    profile.timezone && !TIMEZONES.includes(profile.timezone)
      ? [profile.timezone, ...TIMEZONES]
      : TIMEZONES

  return (
    <DetailShell
      crumbs={[{ label: 'Your profile' }]}
      eyebrow="Account"
      title={displayName}
      subtitle={profile.email}
      badges={
        <>
          <RoleBadge role={profile.role} />
          <StatusBadge status={profile.status} />
        </>
      }
      tabs={<SectionTabs basePath="/app/admin/profile" tabs={SECTIONS} active={section} />}
      aside={
        <Panel
          title="Account"
          description="Set by the platform, not editable from this page."
        >
          <DescriptionList
            items={[
              { label: 'Email', value: profile.email, wide: true },
              { label: 'Role', value: <RoleBadge role={profile.role} /> },
              { label: 'Status', value: <StatusBadge status={profile.status} /> },
              {
                label: 'Email verified',
                value: profile.emailVerifiedAt
                  ? formatDateTime(profile.emailVerifiedAt)
                  : 'Not verified',
                wide: true,
              },
              {
                label: 'Last sign-in',
                value: formatDateTime(profile.lastLoginAt),
                wide: true,
              },
            ]}
          />
          <p
            style={{
              margin: 'var(--space-5) 0 0',
              paddingTop: 'var(--space-5)',
              borderTop: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
              lineHeight: 1.5,
            }}
          >
            Role and status are changed on your record under Users, by another administrator —
            never here. Editing your own would let you lock yourself out of the panel.
          </p>
        </Panel>
      }
    >
      {notice ? (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          style={{
            margin: 0,
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-default)',
            background:
              notice.tone === 'error' ? 'var(--status-error-bg)' : 'var(--status-success-bg)',
            color: notice.tone === 'error' ? 'var(--status-error-fg)' : 'var(--status-success-fg)',
            fontSize: 'var(--type-body-sm-size)',
            lineHeight: 1.5,
          }}
        >
          {notice.text}
        </p>
      ) : null}

      {section === 'profile' ? (
          <Panel
            title="Profile"
            description="How your name and contact details appear across the panel."
          >
            <TrackedForm
              action={saveProfile}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 'var(--space-5)',
                }}
              >
                <Field label="First name" htmlFor="firstName" required>
                  <Input
                    id="firstName"
                    name="firstName"
                    defaultValue={profile.firstName ?? ''}
                    maxLength={80}
                    autoComplete="given-name"
                    required
                  />
                </Field>

                <Field label="Last name" htmlFor="lastName">
                  <Input
                    id="lastName"
                    name="lastName"
                    defaultValue={profile.lastName ?? ''}
                    maxLength={80}
                    autoComplete="family-name"
                  />
                </Field>

                <Field label="Phone" htmlFor="phone" hint="Up to 32 characters, including the code.">
                  <Input
                    id="phone"
                    name="phone"
                    type="tel"
                    defaultValue={profile.phone ?? ''}
                    maxLength={32}
                    autoComplete="tel"
                  />
                </Field>

                <Field
                  label="Country"
                  htmlFor="countryCode"
                  hint="Two-letter code, for example IN or US."
                >
                  <Input
                    id="countryCode"
                    name="countryCode"
                    defaultValue={profile.countryCode ?? ''}
                    maxLength={2}
                    pattern="[A-Za-z]{2}"
                    autoComplete="country"
                    style={{ textTransform: 'uppercase' }}
                  />
                </Field>

                <Field
                  label="Timezone"
                  htmlFor="timezone"
                  hint="Used for the dates and times shown to you."
                >
                  <Select
                    id="timezone"
                    name="timezone"
                    defaultValue={profile.timezone ?? ''}
                    placeholder="Not set"
                    options={zoneOptions}
                  />
                </Field>
              </div>

              <div>
                <Button type="submit" variant="primary">
                  Save profile
                </Button>
              </div>
            </TrackedForm>
          </Panel>
      ) : null}

      {section === 'password' ? (
          <Panel
            title="Password"
            description="Changing it keeps you signed in here and signs you out on every other device."
          >
            <TrackedForm
              action={changePassword}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-5)',
                maxWidth: 'var(--container-form)',
              }}
            >
              <Field label="Current password" htmlFor="currentPassword" required>
                <Input
                  id="currentPassword"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  showPasswordToggle
                />
              </Field>

              <Field
                label="New password"
                htmlFor="newPassword"
                hint="At least 12 characters. Length is what the API checks, so a long phrase beats a short scramble."
                required
              >
                <Input
                  id="newPassword"
                  name="newPassword"
                  type="password"
                  minLength={12}
                  maxLength={200}
                  autoComplete="new-password"
                  required
                  showPasswordToggle
                />
              </Field>

              <Field label="Confirm new password" htmlFor="confirmPassword" required>
                <Input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  minLength={12}
                  maxLength={200}
                  autoComplete="new-password"
                  required
                  showPasswordToggle
                />
              </Field>

              <div style={{ marginTop: 'var(--space-1)' }}>
                <Button type="submit" variant="secondary">
                  Change password
                </Button>
              </div>
            </TrackedForm>
          </Panel>
      ) : null}

      {section === 'sessions' ? (
          <Panel
            title="Active sessions"
            description="Every device holding a live sign-in for your account."
            actions={
              <form action={signOutEverywhere}>
                <Button type="submit" variant="secondary" size="sm" iconLeft="log-out">
                  Sign out everywhere, including here
                </Button>
              </form>
            }
            flush={!sessionsFailed && sessions.length > 0}
          >
            {sessionsFailed ? (
              <EmptyState
                icon="alert-triangle"
                title="We couldn't read your sessions"
                description="The sign-in service did not answer. Refresh in a moment."
              />
            ) : sessions.length === 0 ? (
              <EmptyState
                icon="shield-check"
                title="No live sessions are recorded"
                description="Your current sign-in should appear here. If it does not, the session store is out of step with your cookies — sign out and back in."
              />
            ) : (
              <Table
                columns={SESSION_COLUMNS}
                rows={sessions}
                rowKey={(session) => session.id}
                ariaLabel="Devices where you are signed in"
                /* The panel already draws the frame — drop the table's own so the
                   two hairlines do not stack into one heavy 2px rule. */
                style={{
                  border: 'none',
                  borderRadius: 'var(--radius-none)',
                  background: 'transparent',
                }}
              />
            )}
          </Panel>
      ) : null}

    </DetailShell>
  )
}
