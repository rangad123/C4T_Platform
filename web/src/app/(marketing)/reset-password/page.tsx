import type { Metadata } from 'next'
import { AuthCard, AuthPage } from '@/components/auth/AuthCard'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { resetPasswordAction } from '@/lib/auth/actions'

/**
 * `robots` matters more here than the title.
 *
 * Every other auth page is noindex; these two were not, so a password
 * screen could be crawled and listed. Nothing here is useful in a search
 * result and a reset form least of all -- the page is only ever reached
 * from a link in a mail.
 */
export const metadata: Metadata = {
  title: 'Choose a new password',
  robots: { index: false, follow: false },
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Enter a new password to continue.',
  network: 'Could not reach the sign-in service. Check your connection and try again.',
  expired: 'This reset link is invalid, expired, or already used. Request a new one and try again.',
  password_mismatch: 'Those passwords do not match. Type it the same way twice.',
  failed: 'We could not update your password. Request a new link and try again.',
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>
}) {
  const { token = '', error } = await searchParams

  return (
    /*
      Centred and held to `--container-form`, the same as /login and
      /register. Without the ceiling the card took the full width of the
      marketing container, which stretched a single email field and its
      button across the whole viewport -- a 1,900px input for an address.
    */
    <AuthPage withLogo>
      <AuthCard raised={false}>
        <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
          Choose a new password
        </h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: 'var(--type-body-sm-size)',
            marginBottom: 'var(--space-7)',
          }}
        >
          At least 12 characters. A long phrase beats a short scramble.
        </p>

        {error && ERROR_MESSAGES[error] ? (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-3)',
              padding: 'var(--space-4) var(--space-5)',
              marginBottom: 'var(--space-6)',
              background: 'var(--status-error-bg)',
              color: 'var(--status-error-fg)',
              borderRadius: 'var(--radius-input)',
              fontSize: 'var(--type-body-sm-size)',
              lineHeight: 1.45,
            }}
          >
            <Icon name="alert-triangle" size={18} style={{ flex: 'none', marginTop: 2 }} />
            <span>{ERROR_MESSAGES[error]}</span>
          </div>
        ) : null}

        {token ? (
          <form
            action={resetPasswordAction}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
          >
            <input type="hidden" name="token" value={token} />

            <Field label="New password" htmlFor="password" required>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={200}
                required
                showPasswordToggle
              />
            </Field>

            <Field label="Confirm new password" htmlFor="confirmPassword" required>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={200}
                required
                showPasswordToggle
              />
            </Field>

            <SubmitButton
              variant="primary"
              size="lg"
              fullWidth
              iconRight="arrow-right"
              pendingLabel="Updating…"
            >
              Update password
            </SubmitButton>
          </form>
        ) : (
          <p
            role="alert"
            style={{
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            This page expects a reset link. Open the one we sent in your email.
          </p>
        )}

        <div
          style={{
            marginTop: 'var(--space-7)',
            paddingTop: 'var(--space-6)',
            borderTop: '1px solid var(--border-default)',
            fontSize: 'var(--type-body-sm-size)',
            color: 'var(--text-secondary)',
            textAlign: 'center',
          }}
        >
          Already updated?{' '}
          <a
            href="/login"
            style={{
              color: 'var(--text-brand)',
              textDecoration: 'underline',
              textUnderlineOffset: 3,
            }}
          >
            Sign in
          </a>
        </div>
      </AuthCard>
    </AuthPage>
  )
}
