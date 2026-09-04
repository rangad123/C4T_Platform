import type { Metadata } from 'next'
import { DetailShell } from '@/components/admin/DetailShell'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Panel } from '@/components/admin/Panel'
import { Modal } from '@/components/admin/Modal'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requireRole } from '@/lib/auth/session'
import { serverFetch } from '@/lib/api/server'
import { type ActiveSession } from '@/lib/api/types'
import { formatDateTime } from '@/lib/admin/format'
import { EmailNotificationsPanel } from '@/components/settings/EmailNotificationsPanel'
import { changePassword, revokeSession, signOutEverywhere } from './actions'

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
}

const ROOT = { label: 'Tester', href: '/app/tester' }
const SETTINGS_PATH = '/app/tester/settings'

/**
 * `/app/tester/settings` — credentials and live sessions.
 *
 * Split from "Your profile" on purpose: a profile is what projects see about
 * you, settings are how you get in. They are reached for at different moments
 * and by different mindsets — nobody edits their headline while worried about
 * a session on a device they lost.
 *
 * Payment details deliberately stay on the profile page, next to the rest of
 * the tester's own record, rather than being split across two pages.
 */

const NOTICES: Record<string, NoticeCopy> = {
  password: {
    tone: 'success',
    message: 'Your password has been changed. Every other device has been signed out.',
  },
  session_revoked: { tone: 'success', message: 'That session has been signed out.' },
  email_prefs_on: {
    tone: 'success',
    message: 'Email notifications are on. We will email you when something needs your attention.',
  },
  email_prefs_off: {
    tone: 'success',
    message:
      'Email notifications are off. You will still see everything under the bell, and payments and account changes are still emailed.',
  },
  email_prefs_failed: {
    tone: 'error',
    message: 'That preference could not be saved. Try again in a moment.',
  },

  password_missing: { tone: 'error', message: 'Fill in your current password and the new one.' },
  password_mismatch: {
    tone: 'error',
    message: 'The two new passwords do not match. Retype them and submit again.',
  },
  password_short: { tone: 'error', message: 'Your new password must be at least 12 characters.' },
  password_reused: {
    tone: 'error',
    message: 'The new password is the same as your current one. Choose a different one.',
  },
  password_wrong: { tone: 'error', message: 'That is not your current password.' },
  password_weak: {
    tone: 'error',
    message:
      'That password was rejected. It must be 12 to 200 characters and not a commonly used string.',
  },
  password_google: {
    tone: 'error',
    message:
      'This account signs in with Google and has no password to replace. Use the reset link on the sign-in page to set one.',
  },
  password_failed: {
    tone: 'error',
    message: 'We could not change your password. Try again in a moment.',
  },

  session_missing: { tone: 'error', message: 'That session has already ended.' },
  session_forbidden: { tone: 'error', message: 'You can only end your own sessions.' },
  session_failed: {
    tone: 'error',
    message: 'We could not end that session. Try again in a moment.',
  },
}

/**
 * A readable device name from a user-agent string.
 *
 * Order is load-bearing: Edge and Opera both claim to be Chrome, and Chrome
 * claims to be Safari, so the narrower tokens are tested first. Nothing here
 * is a security decision — it is a label, and the raw string stays on the row
 * underneath so the tester can read what the server actually saw.
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
  { key: 'created', header: 'Signed in', render: (session) => formatDateTime(session.createdAt) },
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
      <form action={revokeSession} style={{ display: 'inline-flex' }}>
        <input type="hidden" name="sessionId" value={session.id} />
        <SubmitButton
          variant="secondary"
          size="sm"
          pendingLabel={session.isCurrent ? 'Signing out…' : 'Ending session…'}
        >
          {session.isCurrent ? 'Sign out here' : 'End session'}
        </SubmitButton>
      </form>
    ),
  },
]

const SECTIONS = [
  { value: 'password', label: 'Password', icon: 'lock' },
  { value: 'notifications', label: 'Notifications', icon: 'bell' },
  { value: 'sessions', label: 'Active sessions', icon: 'monitor' },
] as const

export default async function TesterSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; section?: string; edit?: string }>
}) {
  await requireRole(['TESTER'], SETTINGS_PATH)

  const params = await searchParams
  const section = resolveSection(SECTIONS, params.section)
  const edit = params.edit ?? ''
  /**
   * Two parameters carry a result here — `?error=` and `?ok=` — so the code
   * and the parameter it arrived on are resolved together. `Notice` needs the
   * parameter name in order to strip it when the message is dismissed.
   */
  const noticeParam = NOTICES[params.error ?? ''] ? 'error' : 'ok'
  const noticeCode = noticeParam === 'error' ? params.error : params.ok

  // Only the sessions tab needs this read, and a failure there must not take
  // the password form down with it.
  let sessions: readonly ActiveSession[] = []
  let sessionsFailed = false
  if (section === 'sessions') {
    try {
      sessions = await serverFetch<ActiveSession[]>('auth/sessions')
    } catch {
      sessionsFailed = true
    }
  }

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Settings' }]}
      eyebrow="Account"
      title="Settings"
      subtitle="Your password and the devices you are signed in on."
      tabs={<SectionTabs basePath={SETTINGS_PATH} tabs={SECTIONS} active={section} />}
    >
      <Notice code={noticeCode} notices={NOTICES} param={noticeParam} />

      {section === 'notifications' ? (
        <EmailNotificationsPanel returnTo={`${SETTINGS_PATH}?section=notifications`} />
      ) : null}

      {section === 'password' ? (
        <>
          <Panel
            title="Password"
            description="Changing it keeps you signed in here and signs you out on every other device."
            actions={
              <Button
                href={`${SETTINGS_PATH}?section=password&edit=password`}
                variant="primary"
                size="sm"
                iconLeft="lock"
              >
                Change password
              </Button>
            }
          >
            <p
              style={{
                margin: 0,
                color: 'var(--text-muted)',
                fontSize: 'var(--type-body-sm-size)',
              }}
            >
              Not shown here for your own protection — use Change password to set a new one.
            </p>
          </Panel>

          <Modal
            open={edit === 'password'}
            closedHref={`${SETTINGS_PATH}?section=password`}
            title="Change password"
          >
            <TrackedForm
              action={changePassword}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
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
                hint="At least 12 characters. Length is what actually matters, so a long phrase beats a short scramble."
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
              <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-1)' }}>
                <SubmitButton variant="primary" pendingLabel="Changing password…">
                  Update password
                </SubmitButton>
                <Button href={`${SETTINGS_PATH}?section=password`} variant="ghost">
                  Cancel
                </Button>
              </div>
            </TrackedForm>
          </Modal>
        </>
      ) : null}

      {section === 'sessions' ? (
        <Panel
          title="Active sessions"
          description="Every device holding a live sign-in for your account. End any you do not recognise."
          actions={
            <form action={signOutEverywhere}>
              <SubmitButton
                variant="secondary"
                size="sm"
                iconLeft="log-out"
                pendingLabel="Signing out everywhere…"
              >
                Sign out everywhere
              </SubmitButton>
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
              description="Your current sign-in should appear here. If it does not, sign out and back in."
            />
          ) : (
            <Table
              columns={SESSION_COLUMNS}
              rows={sessions}
              rowKey={(session) => session.id}
              ariaLabel="Devices where you are signed in"
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
