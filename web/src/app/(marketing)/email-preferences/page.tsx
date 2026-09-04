import type { Metadata } from 'next'
import { AuthCard, AuthPage } from '@/components/auth/AuthCard'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { updateEmailPreferenceAction } from './actions'

/**
 * Where the "Turn off emails like this" link in a notification email lands.
 *
 * Two ways in, and they differ in one important way:
 *
 *  - the FOOTER link arrives with a token and no state. Nothing has happened
 *    yet — this page offers the button. A GET must never be the thing that
 *    unsubscribes someone, because link scanners, mail previews and corporate
 *    security proxies all fetch every URL in a message before a human sees it.
 *  - the mail client's own unsubscribe button POSTs to
 *    `/api/email/unsubscribe`, which does the work and redirects here with
 *    `state=off`. That one is a deliberate press, by definition.
 *
 * Noindex for the same reason as the password screens: it is only ever
 * reached from a link in a mail, and the URL carries a token.
 */
export const metadata: Metadata = {
  title: 'Email preferences',
  robots: { index: false, follow: false },
}

type State = 'off' | 'on' | 'invalid' | 'ask'

function parseState(value: string | undefined, token: string): State {
  if (value === 'off' || value === 'on' || value === 'invalid') return value
  return token ? 'ask' : 'invalid'
}

export default async function EmailPreferencesPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; state?: string }>
}) {
  const { token = '', state: raw } = await searchParams
  const state = parseState(raw, token)

  return (
    <AuthPage>
      <AuthCard>
        {state === 'invalid' ? (
          <Panel
            icon="alert-triangle"
            heading="That link is not valid"
            body="It may have been altered in transit, or the account it belonged to has since been closed. You can change this setting from your account settings after signing in."
          />
        ) : state === 'off' ? (
          <Panel
            icon="bell-off"
            heading="Email notifications are off"
            body="We will not email you about projects, messages or announcements. You will still see them in the app when you sign in, and we will still email you about payments and your account."
            action={{ token, enable: true, label: 'Turn emails back on' }}
          />
        ) : state === 'on' ? (
          <Panel
            icon="bell"
            heading="Email notifications are back on"
            body="We will email you when something needs your attention — a project invitation, a message, an announcement."
            action={{ token, enable: false, label: 'Turn emails off' }}
          />
        ) : (
          <Panel
            icon="bell-off"
            heading="Turn off email notifications?"
            body="You will still see everything in the app when you sign in, and we will still email you about payments and your account."
            action={{ token, enable: false, label: 'Turn emails off' }}
          />
        )}
      </AuthCard>
    </AuthPage>
  )
}

function Panel({
  icon,
  heading,
  body,
  action,
}: {
  icon: string
  heading: string
  body: string
  action?: { token: string; enable: boolean; label: string }
}) {
  return (
    <>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 40,
          height: 40,
          marginBottom: 'var(--space-5)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-accent-subtle)',
          color: 'var(--text-accent)',
        }}
      >
        <Icon name={icon} size={20} />
      </span>

      <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-4)' }}>
        {heading}
      </h1>

      <p
        style={{
          margin: 0,
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-sm-size)',
          lineHeight: 1.6,
        }}
      >
        {body}
      </p>

      {action ? (
        <form action={updateEmailPreferenceAction} style={{ marginTop: 'var(--space-6)' }}>
          <input type="hidden" name="token" value={action.token} />
          <input type="hidden" name="enable" value={action.enable ? 'true' : 'false'} />
          <SubmitButton variant="primary" size="lg" fullWidth pendingLabel="Saving…">
            {action.label}
          </SubmitButton>
        </form>
      ) : null}
    </>
  )
}
